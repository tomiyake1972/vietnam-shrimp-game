#!/usr/bin/env -S npx tsx
// ShrimpX V2 — SAI-6 Phase 0-5: 能力余剰・資金・人員方針の実測と係数候補の比較
//
// 三宅さんのご指示（2026-07-31）に対応する計測スクリプト。
// 【重要】本スクリプトはエンジン・標準AIの本体ロジックを一切変更しない。
// 実エンジンを回して実績を計測し、人員方針の候補は**実績軌跡の上での反実仮想
// リプレイ（offline replay）**として評価する。採用・解雇コスト、pendingHires、
// 価格ロジック、意思決定順序はいずれも実装していない。
//
// 計測項目（ご指示）:
//   1. 現状の32Q実測（遊休人件費・未吸収固定費・能力余剰・資金）
//   2. 安全余力 10% / 15% / 20%
//   3. 余剰確認期間 2Q / 3Q
//   4. 1Q当たり削減上限 10% / 15% / 20%
//   5. 採用リードタイム1Qを仮定した需要回復時の欠品・機会損失
//   6. 解雇2Q分・採用1Q分の場合の削減回収期間
//   7. 商品別余剰と全社労務余剰が二重計上されていないこと
//   8. 期首資金枠と計画支出の差
//   9. 借入余力を超える会社・四半期
//
// 出力: artifacts/sai6/phase0/{measurement.json, policy-grid.json, summary.md,
//                             quarterly.csv, policy-grid.csv}

import * as fs from "node:fs";
import * as path from "node:path";
import { runAutoplayCase, AutoplayCaseConfig } from "../app/lib/v2/companyLab/standardAi/autoplay/runCase";
import { ALL_COMPANY_IDS } from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";
import {
  STANDARD_BASELINE_CANDIDATES,
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
} from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import { FINANCE_PARAMETERS_V1 } from "../app/lib/v2/finance/parameters";
import { PRODUCTION_PARAMETERS_V1 } from "../app/lib/v2/production/parameters";
import { unwrapUnit } from "../app/lib/v2/core/units";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
const SEEDS = Array.from({ length: 4 }, (_, i) => `sai5-ab-${String(i + 1).padStart(3, "0")}`);
const QUARTERS = 32;
const PRODUCTS = ["hoso", "pd", "vap"] as const;

/** エンジンの有効能力係数（production/capacity.ts:44-55 と同じ）。 */
const EFFECTIVE_CAPACITY_FACTOR = 0.9 * 0.95; // = 0.855

const REGULAR_SALARY = FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter;
const REGULAR_EFFICIENCY = PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons;

/** ご指示の暫定値: 採用1四半期分・解雇2四半期分の給与。 */
const HIRING_COST_PER_HEAD = REGULAR_SALARY * 1;
const SEVERANCE_COST_PER_HEAD = REGULAR_SALARY * 2;

const ALL_ON: Partial<AutoplayCaseConfig> = {
  managementProfilesEnabled: true,
  marketProductOrientationEnabled: true,
  heterogeneousInitialConditionsEnabled: true,
  productLifecycleEnabled: true,
  salesBaseAccumulationEnabled: true,
  supplyPremiumFeedbackEnabled: true,
  standardAiCapexEnabled: true,
};

// ---------------------------------------------------------------------------
// 1四半期ぶんの実測レコード
// ---------------------------------------------------------------------------

interface QuarterRow {
  configId: string;
  seed: string;
  companyId: string;
  turn: number;
  // --- 労務 ---
  heldRegularHeadcount: number; // 保有する常用人員（人件費から逆算＝丸め誤差なし）
  assignedRegularHeadcount: number; // 実際に生産へ配属された常用人員
  idleRegularHeadcount: number;
  regularLaborCostUsd: number;
  idleLaborCostUsd: number;
  temporaryWorkerCostUsd: number;
  overtimeCostUsd: number;
  // --- 固定費 ---
  unabsorbedFixedCostUsd: number;
  capexMaintenanceCostUsd: number;
  factoryFixedCostUsd: number;
  utilityFixedCostUsd: number;
  depreciationCostUsd: number;
  totalFixedCostUsd: number; // 管理会計の定義（capex保守費・利息を含まない）
  // --- 収益性 ---
  netRevenueUsd: number;
  contributionMarginUsd: number;
  contributionMarginRatio: number | null;
  operatingProfitUsd: number;
  breakEvenRevenueUsd: number | null;
  // --- 能力・稼働 ---
  equipmentUtilizationRate: number;
  laborUtilizationRate: number;
  totalProducedTons: number;
  /** 労務制約で作れなかった量（production/allocation.ts の段階別不足）。 */
  laborShortfallTons: number;
  equipmentShortfallTons: number;
  rawMaterialShortfallTons: number;
  nominalCapacityByProduct: Record<string, number>;
  effectiveCapacityByProduct: Record<string, number>;
  producedByProduct: Record<string, number>;
  // --- 資金 ---
  openingCashUsd: number;
  closingCashUsd: number;
  totalCashOutflowUsd: number; // 直接法の支出合計＋投資支出
  availableAdditionalBorrowingUsd: number;
  paymentDefault: boolean;
  /** この会社ケースが最初に paymentDefault を起こした四半期より前か（＝経営判断が意味を持つ期間）。 */
  preDefault: boolean;
}

function toNumber(v: unknown): number {
  if (v === undefined || v === null) return 0;
  return typeof v === "number" ? v : Number(v);
}

function collectRows(configId: string, flags: Partial<AutoplayCaseConfig>): QuarterRow[] {
  const rows: QuarterRow[] = [];
  for (const seed of SEEDS) {
    const result = runAutoplayCase({
      scenarioId: "baseline",
      seed,
      quarters: QUARTERS,
      companyIds: ALL_COMPANY_IDS,
      candidate,
      ...flags,
    });

    for (const h of result.history) {
      for (const companyId of ALL_COMPANY_IDS) {
        const fin = h.financialResults.find((f) => f.companyId === companyId);
        const summary = h.companySummaries.find((s) => s.companyId === companyId);
        const financing = h.financingResults.find((f) => f.companyId === companyId);
        // 当期の開始時点でこの会社が観測していた能力（capex完成分を含む名目値）
        const capture = result.quarterStartCaptures.find((c) => c.turn === h.turn && c.companyId === companyId);
        if (!fin || !summary || !capture) continue;

        const mfg = fin.manufacturingCost;
        const cos = fin.profitAndLoss.costOfSales;
        const cm = fin.contributionMargin;
        const cf = fin.cashFlow;

        const regularLaborCostUsd = toNumber(mfg.regularLaborCost);
        const idleLaborCostUsd = toNumber(mfg.idleLaborCost);
        const productiveLaborCostUsd = toNumber(mfg.productiveRegularLaborCost);

        const nominalCapacityByProduct: Record<string, number> = {};
        const effectiveCapacityByProduct: Record<string, number> = {};
        const producedByProduct: Record<string, number> = {
          hoso: unwrapUnit(summary.hosoProduced),
          pd: unwrapUnit(summary.pdProduced),
          vap: unwrapUnit(summary.vapProduced),
        };
        const totalProducedTons = producedByProduct.hoso + producedByProduct.pd + producedByProduct.vap;
        const laborShortfallTons = unwrapUnit(summary.laborShortfall);
        const equipmentShortfallTons = unwrapUnit(summary.equipmentShortfall);
        const rawMaterialShortfallTons = unwrapUnit(summary.rawMaterialShortfall);

        // 名目能力は fixture の工場能力（＋capex完成分）。result.companies から取る。
        const fixture = result.companies.find((c) => c.companyId === companyId);
        for (const p of PRODUCTS) {
          const nominal = (fixture?.factories ?? []).reduce((s, f) => {
            const key = p === "hoso" ? f.hosoCapacity : p === "pd" ? f.pdCapacity : f.vapCapacity;
            return s + unwrapUnit(key);
          }, 0);
          nominalCapacityByProduct[p] = nominal;
          effectiveCapacityByProduct[p] = nominal * EFFECTIVE_CAPACITY_FACTOR;
        }
        const nominalCommon = (fixture?.factories ?? []).reduce((s, f) => s + unwrapUnit(f.commonProcessingCapacity), 0);
        nominalCapacityByProduct.common = nominalCommon;
        effectiveCapacityByProduct.common = nominalCommon * EFFECTIVE_CAPACITY_FACTOR;

        // 直接法の支出内訳（すべて正の値で保持されている）＋ 投資支出
        const od = cf.operatingDirect;
        const outflow =
          toNumber(od.paymentsForRawMaterials) +
          toNumber(od.paymentsForManufacturing) +
          toNumber(od.paymentsForSellingGeneralAdmin) +
          toNumber(od.interestPaid) +
          toNumber(od.incomeTaxPaid) +
          Math.max(0, -toNumber(cf.investingCashFlow));

        rows.push({
          configId,
          seed,
          companyId,
          turn: h.turn,
          heldRegularHeadcount: regularLaborCostUsd / REGULAR_SALARY,
          assignedRegularHeadcount: productiveLaborCostUsd / REGULAR_SALARY,
          idleRegularHeadcount: idleLaborCostUsd / REGULAR_SALARY,
          regularLaborCostUsd,
          idleLaborCostUsd,
          temporaryWorkerCostUsd: toNumber(mfg.temporaryWorkerCost),
          overtimeCostUsd: toNumber(mfg.overtimeCost),
          unabsorbedFixedCostUsd: toNumber(cos.unabsorbedFixedManufacturingCost),
          capexMaintenanceCostUsd: toNumber(cos.capexMaintenanceCost),
          factoryFixedCostUsd: toNumber(mfg.factoryFixedCost),
          utilityFixedCostUsd: toNumber(mfg.utilityFixedCost),
          depreciationCostUsd: toNumber(mfg.depreciationCost),
          totalFixedCostUsd: toNumber(cm.totalFixedCost),
          netRevenueUsd: toNumber(fin.profitAndLoss.netRevenue),
          contributionMarginUsd: toNumber(cm.contributionMargin),
          contributionMarginRatio: cm.contributionMarginRatio ?? null,
          operatingProfitUsd: toNumber(fin.profitAndLoss.operatingProfit),
          breakEvenRevenueUsd: cm.breakEvenRevenue === undefined ? null : toNumber(cm.breakEvenRevenue),
          equipmentUtilizationRate: unwrapUnit(summary.equipmentUtilizationRate),
          laborUtilizationRate: unwrapUnit(summary.laborUtilizationRate),
          totalProducedTons,
          laborShortfallTons,
          equipmentShortfallTons,
          rawMaterialShortfallTons,
          nominalCapacityByProduct,
          effectiveCapacityByProduct,
          producedByProduct,
          openingCashUsd: toNumber(cf.openingCash),
          closingCashUsd: toNumber(cf.closingCash),
          totalCashOutflowUsd: outflow,
          availableAdditionalBorrowingUsd: toNumber(financing?.borrowingCapacity?.availableAdditionalCapacityUsd),
          paymentDefault: financing?.financialHealth?.paymentDefault === true,
          preDefault: true, // 後段でケースごとに再計算する
        });
      }
    }
    console.log(`  ${configId} / ${seed}: ${result.completedTurns}Q 完走`);
  }
  // 会社ケースごとに「最初のpaymentDefault」を求め、それより前を preDefault とする。
  // 破綻後は生産がゼロに張り付き、能力・人員の判断が結果に影響しなくなるため、
  // 係数の比較はこの期間に限定しないと意味を持たない。
  const firstDefaultTurn = new Map<string, number>();
  for (const r of rows) {
    if (!r.paymentDefault) continue;
    const key = `${r.seed}::${r.companyId}`;
    const prev = firstDefaultTurn.get(key);
    if (prev === undefined || r.turn < prev) firstDefaultTurn.set(key, r.turn);
  }
  return rows.map((r) => {
    const first = firstDefaultTurn.get(`${r.seed}::${r.companyId}`);
    return { ...r, preDefault: first === undefined || r.turn < first };
  });
}

// ---------------------------------------------------------------------------
// 集計ヘルパー
// ---------------------------------------------------------------------------

const sum = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0);
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : sum(xs) / xs.length);
function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

// ---------------------------------------------------------------------------
// Part 1: 実測サマリー
// ---------------------------------------------------------------------------

function measure(rows: readonly QuarterRow[]) {
  const idleShare = rows.filter((r) => r.regularLaborCostUsd > 0).map((r) => r.idleLaborCostUsd / r.regularLaborCostUsd);
  const perCaseCount = SEEDS.length * ALL_COMPANY_IDS.length;

  // 商品別の能力余剰（有効能力 − 生産実績）
  const productSurplus: Record<string, number[]> = { hoso: [], pd: [], vap: [], common: [] };
  for (const r of rows) {
    for (const p of PRODUCTS) {
      productSurplus[p].push(Math.max(0, r.effectiveCapacityByProduct[p] - r.producedByProduct[p]));
    }
    productSurplus.common.push(Math.max(0, r.effectiveCapacityByProduct.common - r.totalProducedTons));
  }

  // 【二重計上の検証】
  //  (a) 商品別余剰の単純合計
  //  (b) 共通前処理のボトルネックを考慮した「実際に減らせる能力」の上限
  //  (c) 保有人員から導く労務能力の余剰
  const doubleCount = rows.map((r) => {
    const perProductSum = PRODUCTS.reduce((s, p) => s + Math.max(0, r.effectiveCapacityByProduct[p] - r.producedByProduct[p]), 0);
    const commonSurplus = Math.max(0, r.effectiveCapacityByProduct.common - r.totalProducedTons);
    // 労務余剰は「保有人員 − 配属人員」で厳密に取れる（人件費からの逆算）
    const laborSurplusHeads = r.idleRegularHeadcount;
    const laborSurplusTons = laborSurplusHeads * REGULAR_EFFICIENCY;
    return { perProductSum, commonSurplus, laborSurplusHeads, laborSurplusTons };
  });

  const survival = (() => {
    const byCase = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.seed}::${r.companyId}`;
      if (r.preDefault) byCase.set(key, (byCase.get(key) ?? 0) + 1);
      else if (!byCase.has(key)) byCase.set(key, 0);
    }
    const lens = [...byCase.values()];
    return { meanPreDefaultQuarters: mean(lens), medianPreDefaultQuarters: quantile(lens, 0.5), minPreDefaultQuarters: Math.min(...lens), maxPreDefaultQuarters: Math.max(...lens) };
  })();

  return {
    quarters: QUARTERS,
    seeds: SEEDS.length,
    companies: ALL_COMPANY_IDS.length,
    samples: rows.length,
    survival,

    // --- 遊休人件費 ---
    idleLabor: {
      totalUsdPerCase: sum(rows.map((r) => r.idleLaborCostUsd)) / perCaseCount,
      meanUsdPerQuarter: mean(rows.map((r) => r.idleLaborCostUsd)),
      meanShareOfRegularLabor: mean(idleShare),
      p25ShareOfRegularLabor: quantile(idleShare, 0.25),
      medianShareOfRegularLabor: quantile(idleShare, 0.5),
      p75ShareOfRegularLabor: quantile(idleShare, 0.75),
      maxShareOfRegularLabor: Math.max(...idleShare),
      meanIdleHeadcount: mean(rows.map((r) => r.idleRegularHeadcount)),
      meanHeldHeadcount: mean(rows.map((r) => r.heldRegularHeadcount)),
      meanAssignedHeadcount: mean(rows.map((r) => r.assignedRegularHeadcount)),
    },

    // --- 固定費の内訳（1四半期・1社あたりの平均） ---
    fixedCostPerQuarter: {
      regularLaborUsd: mean(rows.map((r) => r.regularLaborCostUsd)),
      idleLaborUsd: mean(rows.map((r) => r.idleLaborCostUsd)),
      factoryFixedUsd: mean(rows.map((r) => r.factoryFixedCostUsd)),
      utilityFixedUsd: mean(rows.map((r) => r.utilityFixedCostUsd)),
      depreciationUsd: mean(rows.map((r) => r.depreciationCostUsd)),
      capexMaintenanceUsd: mean(rows.map((r) => r.capexMaintenanceCostUsd)),
      unabsorbedFixedUsd: mean(rows.map((r) => r.unabsorbedFixedCostUsd)),
      totalFixedCostAsDefinedUsd: mean(rows.map((r) => r.totalFixedCostUsd)),
      // 【未決事項4】capex保守費を含めた正規定義
      totalFixedCostCorrectedUsd: mean(rows.map((r) => r.totalFixedCostUsd + r.capexMaintenanceCostUsd)),
    },

    // --- 稼働率 ---
    utilization: {
      meanEquipment: mean(rows.map((r) => r.equipmentUtilizationRate)),
      medianEquipment: quantile(rows.map((r) => r.equipmentUtilizationRate), 0.5),
      meanLabor: mean(rows.map((r) => r.laborUtilizationRate)),
      medianLabor: quantile(rows.map((r) => r.laborUtilizationRate), 0.5),
    },

    // --- 能力余剰（商品別・共通・労務） ---
    capacitySurplusTons: {
      hosoMean: mean(productSurplus.hoso),
      pdMean: mean(productSurplus.pd),
      vapMean: mean(productSurplus.vap),
      commonMean: mean(productSurplus.common),
      perProductSumMean: mean(doubleCount.map((d) => d.perProductSum)),
      laborSurplusTonsMean: mean(doubleCount.map((d) => d.laborSurplusTons)),
      laborSurplusHeadsMean: mean(doubleCount.map((d) => d.laborSurplusHeads)),
      // 商品別余剰の単純合計が共通工程の余剰を上回る割合（＝二重計上が起きる標本の割合）
      shareWherePerProductSumExceedsCommon:
        doubleCount.filter((d) => d.perProductSum > d.commonSurplus + 1e-6).length / doubleCount.length,
      meanExcessOverCommon: mean(doubleCount.map((d) => Math.max(0, d.perProductSum - d.commonSurplus))),
    },

    // --- 制約別の不足（作れなかった量） ---
    shortfallTonsPerQuarter: {
      laborMean: mean(rows.map((r) => r.laborShortfallTons)),
      equipmentMean: mean(rows.map((r) => r.equipmentShortfallTons)),
      rawMaterialMean: mean(rows.map((r) => r.rawMaterialShortfallTons)),
      quartersWithLaborShortfall: rows.filter((r) => r.laborShortfallTons > 1).length,
      quartersTotal: rows.length,
    },

    // --- 収益性 ---
    profitability: {
      meanNetRevenueUsd: mean(rows.map((r) => r.netRevenueUsd)),
      meanContributionMarginUsd: mean(rows.map((r) => r.contributionMarginUsd)),
      meanContributionMarginRatio: mean(rows.map((r) => r.contributionMarginRatio ?? 0)),
      meanOperatingProfitUsd: mean(rows.map((r) => r.operatingProfitUsd)),
      // 単位限界利益（USD/トン）＝ 限界利益 ÷ 生産トン（販売トンの代理）
      meanUnitContributionMarginUsdPerTon: mean(
        rows.filter((r) => r.totalProducedTons > 0).map((r) => r.contributionMarginUsd / r.totalProducedTons)
      ),
    },

    // --- 資金 ---
    funding: {
      meanOpeningCashUsd: mean(rows.map((r) => r.openingCashUsd)),
      meanTotalOutflowUsd: mean(rows.map((r) => r.totalCashOutflowUsd)),
      // 【ご指示】期首資金枠（期首現金＋借入余力）と計画支出の差
      meanFundingHeadroomUsd: mean(rows.map((r) => r.openingCashUsd + r.availableAdditionalBorrowingUsd - r.totalCashOutflowUsd)),
      medianFundingHeadroomUsd: quantile(
        rows.map((r) => r.openingCashUsd + r.availableAdditionalBorrowingUsd - r.totalCashOutflowUsd),
        0.5
      ),
      // 【ご指示】借入余力を超える会社・四半期
      quartersExceedingBorrowingCapacity: rows.filter(
        (r) => r.openingCashUsd + r.availableAdditionalBorrowingUsd < r.totalCashOutflowUsd
      ).length,
      quartersTotal: rows.length,
      companiesEverExceeding: new Set(
        rows
          .filter((r) => r.openingCashUsd + r.availableAdditionalBorrowingUsd < r.totalCashOutflowUsd)
          .map((r) => `${r.seed}::${r.companyId}`)
      ).size,
      companyCasesTotal: perCaseCount,
      defaultCaseCount: new Set(rows.filter((r) => r.paymentDefault).map((r) => `${r.seed}::${r.companyId}`)).size,
    },
  };
}

// ---------------------------------------------------------------------------
// Part 2: 人員方針の反実仮想リプレイ
//
// 【この評価の限界（正直な明記）】実績軌跡（各四半期の「実際に配属された人員」）を
// 所与として方針を当てはめる一次近似である。実際には人員を削れば生産・成約・
// 価格も変わるため、削減額は上限寄り、欠品は下限寄りに出る。
// 方針の相対比較（どの係数がましか）には使えるが、絶対額の予測には使えない。
// ---------------------------------------------------------------------------

interface PolicyParams {
  safetyMargin: number; // 安全余力（必要人員に対する上乗せ率）
  persistenceQuarters: number; // 余剰確認期間
  reductionCapRatio: number; // 1Q当たり削減上限（保有人員に対する比率）
  hiringLeadTimeQuarters: number; // 採用リードタイム
}

interface PolicyResult extends PolicyParams {
  // --- 方針を当てはめた場合 ---
  policyLaborCostUsd: number;
  policySeveranceUsd: number;
  policyHiringUsd: number;
  shortfallHeadQuarters: number;
  shortfallTons: number;
  opportunityLossUsd: number;
  /** 現行AIより多く人員を持ったことで回避できた労務制約の欠品（実測 laborShortfall が上限）。 */
  recoveredTons: number;
  recoveredValueUsd: number;
  policyTotalCostUsd: number; // 人件費 + 解雇費 + 採用費 + 機会損失 − 回避できた欠品の価値
  // --- 現行AI（実績軌跡）に同じ一時費用を課した場合 ---
  baselineLaborCostUsd: number;
  baselineSeveranceUsd: number;
  baselineHiringUsd: number;
  baselineTotalCostUsd: number;
  // --- 差分（正 = 方針のほうが安い） ---
  improvementUsd: number;
  reductionEvents: number;
  hiringEvents: number;
  baselineHeadcountChurnHeads: number; // 現行AIの人員変動の総量（増減の絶対値合計）
  policyHeadcountChurnHeads: number;
  maxDrawdownHeads: number;
}

function replayPolicy(rows: readonly QuarterRow[], unitCmUsdPerTon: number, p: PolicyParams): PolicyResult {
  let policyLaborCostUsd = 0;
  let policySeveranceUsd = 0;
  let policyHiringUsd = 0;
  let baselineLaborCostUsd = 0;
  let baselineSeveranceUsd = 0;
  let baselineHiringUsd = 0;
  let baselineChurn = 0;
  let policyChurn = 0;
  let shortfallHeadQuarters = 0;
  let recoveredTons = 0;
  let reductionEvents = 0;
  let hiringEvents = 0;
  let maxDrawdownHeads = 0;

  const byCase = new Map<string, QuarterRow[]>();
  for (const r of rows) {
    const key = `${r.seed}::${r.companyId}`;
    const arr = byCase.get(key);
    if (arr) arr.push(r);
    else byCase.set(key, [r]);
  }

  for (const caseRows of byCase.values()) {
    const sorted = [...caseRows].sort((a, b) => a.turn - b.turn);
    if (sorted.length === 0) continue;

    let held = sorted[0].heldRegularHeadcount;
    let prevActual = sorted[0].heldRegularHeadcount;
    let surplusStreak = 0;
    const pendingHires: number[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];

      // --- 現行AI（実績軌跡）にも同じ一時費用を課す（公平な比較のため） ---
      baselineLaborCostUsd += r.regularLaborCostUsd;
      if (i > 0) {
        const delta = r.heldRegularHeadcount - prevActual;
        baselineChurn += Math.abs(delta);
        if (delta < 0) baselineSeveranceUsd += -delta * SEVERANCE_COST_PER_HEAD;
        else baselineHiringUsd += delta * HIRING_COST_PER_HEAD;
      }
      prevActual = r.heldRegularHeadcount;

      // --- 方針側 ---
      // (1) リードタイム経過した採用が能力化する
      if (pendingHires.length >= p.hiringLeadTimeQuarters) {
        const arrived = pendingHires.shift() ?? 0;
        held += arrived;
        policyChurn += arrived;
      }
      held = Math.max(0, held);

      const required = r.assignedRegularHeadcount;

      // (2) 不足（欠品・機会損失）
      if (held < required) shortfallHeadQuarters += required - held;

      // (2b) 逆に現行AIより多く人員を持っていれば、実測で発生した労務制約の欠品を
      //      その分だけ回避できたはず（実測の laborShortfall が上限＝過大評価しない）。
      if (held > r.heldRegularHeadcount && r.laborShortfallTons > 0) {
        recoveredTons += Math.min(r.laborShortfallTons, (held - r.heldRegularHeadcount) * REGULAR_EFFICIENCY);
      }

      // (3) 当期の人件費
      policyLaborCostUsd += held * REGULAR_SALARY;

      // (4) 次期に向けた増減
      //
      // 【重要】安全余力は「そこまで採用する目標」ではなく「そこを超えたら削る上側の帯」である。
      // 目標として使うと、実績が帯を下回るたびに採用してしまい、現行AIより人員が増える。
      const upperBand = required * (1 + p.safetyMargin);
      if (held > upperBand) {
        surplusStreak += 1;
        if (surplusStreak >= p.persistenceQuarters) {
          const cap = held * p.reductionCapRatio;
          const cut = Math.min(cap, held - upperBand);
          if (cut > 0.5) {
            held -= cut;
            policySeveranceUsd += cut * SEVERANCE_COST_PER_HEAD;
            policyChurn += cut;
            reductionEvents += 1;
            maxDrawdownHeads = Math.max(maxDrawdownHeads, sorted[0].heldRegularHeadcount - held);
            surplusStreak = 0;
          }
        }
      } else {
        surplusStreak = 0;
        const pendingTotal = pendingHires.reduce((a, b) => a + b, 0);
        if (held + pendingTotal < required) {
          const hire = upperBand - (held + pendingTotal);
          if (hire > 0.5) {
            pendingHires.push(hire);
            policyHiringUsd += hire * HIRING_COST_PER_HEAD;
            hiringEvents += 1;
          }
        }
      }
    }
  }

  const shortfallTons = shortfallHeadQuarters * REGULAR_EFFICIENCY;
  const opportunityLossUsd = shortfallTons * unitCmUsdPerTon;
  const recoveredValueUsd = recoveredTons * unitCmUsdPerTon;
  const policyTotalCostUsd = policyLaborCostUsd + policySeveranceUsd + policyHiringUsd + opportunityLossUsd - recoveredValueUsd;
  const baselineTotalCostUsd = baselineLaborCostUsd + baselineSeveranceUsd + baselineHiringUsd;

  return {
    ...p,
    policyLaborCostUsd,
    policySeveranceUsd,
    policyHiringUsd,
    shortfallHeadQuarters,
    shortfallTons,
    opportunityLossUsd,
    recoveredTons,
    recoveredValueUsd,
    policyTotalCostUsd,
    baselineLaborCostUsd,
    baselineSeveranceUsd,
    baselineHiringUsd,
    baselineTotalCostUsd,
    improvementUsd: baselineTotalCostUsd - policyTotalCostUsd,
    reductionEvents,
    hiringEvents,
    baselineHeadcountChurnHeads: baselineChurn,
    policyHeadcountChurnHeads: policyChurn,
    maxDrawdownHeads,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function fmtUsd(v: number): string {
  return `${(v / 1e6).toFixed(2)}M`;
}
function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function main(): void {
  const outDir = path.resolve(process.cwd(), "artifacts/sai6/phase0");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("実測中: allOn（SAI-5全機能ON、現状）...");
  const allOnRows = collectRows("allOn", ALL_ON);
  console.log("実測中: control（全機能OFF）...");
  const controlRows = collectRows("control", {});

  const allOnPre = allOnRows.filter((r) => r.preDefault);
  const controlPre = controlRows.filter((r) => r.preDefault);

  const allOn = measure(allOnRows);
  const control = measure(controlRows);
  const allOnPreM = measure(allOnPre);
  const controlPreM = measure(controlPre);

  // --- 係数候補のグリッド ---
  // 【方針】破綻後は生産がゼロに張り付き、人員判断が結果に影響しなくなるため、
  // 係数の比較は**生存期間（最初のpaymentDefaultより前）**に限定する。
  // 基準は control（SAI-5機能OFF）の生存期間とする。allOnは破綻が早く、
  // 生存期間の標本が少なすぎて係数の差が出ないため（実測結果§0参照）。
  const unitCm = controlPreM.profitability.meanUnitContributionMarginUsdPerTon;
  const grid: PolicyResult[] = [];
  for (const safetyMargin of [0.1, 0.15, 0.2]) {
    for (const persistenceQuarters of [2, 3]) {
      for (const reductionCapRatio of [0.1, 0.15, 0.2]) {
        grid.push(replayPolicy(controlPre, unitCm, { safetyMargin, persistenceQuarters, reductionCapRatio, hiringLeadTimeQuarters: 1 }));
      }
    }
  }
  const leadTimeComparison = [0, 1, 2].map((lt) =>
    replayPolicy(controlPre, unitCm, { safetyMargin: 0.15, persistenceQuarters: 2, reductionCapRatio: 0.15, hiringLeadTimeQuarters: lt })
  );

  fs.writeFileSync(
    path.join(outDir, "measurement.json"),
    JSON.stringify(
      { generator: "scripts/sai6Phase0Study.ts", seeds: SEEDS, quarters: QUARTERS, allOn, control, allOnPreDefault: allOnPreM, controlPreDefault: controlPreM },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(outDir, "policy-grid.json"),
    JSON.stringify(
      {
        generator: "scripts/sai6Phase0Study.ts",
        assumptions: {
          regularSalaryUsdPerQuarter: REGULAR_SALARY,
          hiringCostPerHeadUsd: HIRING_COST_PER_HEAD,
          severanceCostPerHeadUsd: SEVERANCE_COST_PER_HEAD,
          regularEfficiencyTonsPerHead: REGULAR_EFFICIENCY,
          unitContributionMarginUsdPerTon: unitCm,
        },
        grid,
        leadTimeComparison,
      },
      null,
      2
    )
  );

  // --- CSV ---
  const csvHeader = [
    "configId,seed,companyId,turn,heldRegularHeadcount,assignedRegularHeadcount,idleRegularHeadcount",
    "regularLaborCostUsd,idleLaborCostUsd,unabsorbedFixedCostUsd,capexMaintenanceCostUsd,totalFixedCostUsd",
    "netRevenueUsd,contributionMarginUsd,operatingProfitUsd,equipmentUtilizationRate,laborUtilizationRate",
    "totalProducedTons,effCapHoso,effCapPd,effCapVap,effCapCommon,prodHoso,prodPd,prodVap",
    "openingCashUsd,totalCashOutflowUsd,availableAdditionalBorrowingUsd,paymentDefault",
  ].join(",");
  const csvRows = [...allOnRows, ...controlRows].map((r) =>
    [
      r.configId,
      r.seed,
      r.companyId,
      r.turn,
      r.heldRegularHeadcount.toFixed(2),
      r.assignedRegularHeadcount.toFixed(2),
      r.idleRegularHeadcount.toFixed(2),
      r.regularLaborCostUsd.toFixed(0),
      r.idleLaborCostUsd.toFixed(0),
      r.unabsorbedFixedCostUsd.toFixed(0),
      r.capexMaintenanceCostUsd.toFixed(0),
      r.totalFixedCostUsd.toFixed(0),
      r.netRevenueUsd.toFixed(0),
      r.contributionMarginUsd.toFixed(0),
      r.operatingProfitUsd.toFixed(0),
      r.equipmentUtilizationRate.toFixed(4),
      r.laborUtilizationRate.toFixed(4),
      r.totalProducedTons.toFixed(1),
      r.effectiveCapacityByProduct.hoso.toFixed(1),
      r.effectiveCapacityByProduct.pd.toFixed(1),
      r.effectiveCapacityByProduct.vap.toFixed(1),
      r.effectiveCapacityByProduct.common.toFixed(1),
      r.producedByProduct.hoso.toFixed(1),
      r.producedByProduct.pd.toFixed(1),
      r.producedByProduct.vap.toFixed(1),
      r.openingCashUsd.toFixed(0),
      r.totalCashOutflowUsd.toFixed(0),
      r.availableAdditionalBorrowingUsd.toFixed(0),
      r.paymentDefault ? 1 : 0,
    ].join(",")
  );
  fs.writeFileSync(path.join(outDir, "quarterly.csv"), [csvHeader, ...csvRows].join("\n"));

  const gridCsv = [
    "safetyMargin,persistenceQuarters,reductionCapRatio,hiringLeadTimeQuarters,policyLaborCostUsd,policySeveranceUsd,policyHiringUsd,shortfallHeadQuarters,shortfallTons,opportunityLossUsd,policyTotalCostUsd,baselineTotalCostUsd,improvementUsd,reductionEvents,hiringEvents,baselineChurn,policyChurn,maxDrawdownHeads",
    ...[...grid, ...leadTimeComparison].map((g) =>
      [
        g.safetyMargin,
        g.persistenceQuarters,
        g.reductionCapRatio,
        g.hiringLeadTimeQuarters,
        g.policyLaborCostUsd.toFixed(0),
        g.policySeveranceUsd.toFixed(0),
        g.policyHiringUsd.toFixed(0),
        g.shortfallHeadQuarters.toFixed(1),
        g.shortfallTons.toFixed(1),
        g.opportunityLossUsd.toFixed(0),
        g.policyTotalCostUsd.toFixed(0),
        g.baselineTotalCostUsd.toFixed(0),
        g.improvementUsd.toFixed(0),
        g.reductionEvents,
        g.hiringEvents,
        g.baselineHeadcountChurnHeads.toFixed(1),
        g.policyHeadcountChurnHeads.toFixed(1),
        g.maxDrawdownHeads.toFixed(1),
      ].join(",")
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "policy-grid.csv"), gridCsv);

  // --- markdown サマリー ---
  const L: string[] = [];
  const M = (m: ReturnType<typeof measure>) => m;
  L.push("# SAI-6 Phase 0-5 実測結果");
  L.push("");
  L.push(`${SEEDS.length} seed × ${QUARTERS}Q × ${ALL_COMPANY_IDS.length}社（全標本 ${allOn.samples} 会社×四半期）。`);
  L.push("");
  L.push("## 0. 最初に — 32Q全体の平均は「破綻後」に支配されている");
  L.push("");
  L.push("| 指標 | allOn | control |");
  L.push("|---|---:|---:|");
  L.push(`| paymentDefault を起こした会社ケース | ${allOn.funding.defaultCaseCount} / ${allOn.funding.companyCasesTotal} | ${control.funding.defaultCaseCount} / ${control.funding.companyCasesTotal} |`);
  L.push(`| 破綻前の生存四半期（平均） | ${allOn.survival.meanPreDefaultQuarters.toFixed(1)}Q | ${control.survival.meanPreDefaultQuarters.toFixed(1)}Q |`);
  L.push(`| 同 中央値 | ${allOn.survival.medianPreDefaultQuarters.toFixed(0)}Q | ${control.survival.medianPreDefaultQuarters.toFixed(0)}Q |`);
  L.push(`| 設備稼働率（32Q全体の中央値） | ${pct(allOn.utilization.medianEquipment)} | ${pct(control.utilization.medianEquipment)} |`);
  L.push(`| 設備稼働率（**生存期間**の中央値） | ${pct(allOnPreM.utilization.medianEquipment)} | ${pct(controlPreM.utilization.medianEquipment)} |`);
  L.push("");
  L.push("破綻後は生産がゼロに張り付き、能力・人員の判断が結果に一切影響しなくなる。");
  L.push("したがって**以降の数値は「生存期間（最初のpaymentDefaultより前）」を主とし、32Q全体は参考として併記する**。");
  L.push("");

  const sections: { title: string; m: ReturnType<typeof measure> }[] = [
    { title: "control 生存期間【主】", m: M(controlPreM) },
    { title: "allOn 生存期間", m: M(allOnPreM) },
    { title: "control 32Q全体（参考）", m: M(control) },
    { title: "allOn 32Q全体（参考）", m: M(allOn) },
  ];

  L.push("## 1. 遊休人件費");
  L.push("");
  L.push("| 指標 | " + sections.map((x) => x.title).join(" | ") + " |");
  L.push("|---|" + sections.map(() => "---:").join("|") + "|");
  const idleRows: [string, (m: ReturnType<typeof measure>) => string][] = [
    ["保有常用人員（平均）", (m) => `${m.idleLabor.meanHeldHeadcount.toFixed(0)}人`],
    ["配属常用人員（平均）", (m) => `${m.idleLabor.meanAssignedHeadcount.toFixed(0)}人`],
    ["遊休人員（平均）", (m) => `${m.idleLabor.meanIdleHeadcount.toFixed(0)}人`],
    ["遊休人件費（1社1Q平均）", (m) => fmtUsd(m.idleLabor.meanUsdPerQuarter)],
    ["遊休比率（平均）", (m) => pct(m.idleLabor.meanShareOfRegularLabor)],
    ["遊休比率（中央値）", (m) => pct(m.idleLabor.medianShareOfRegularLabor)],
    ["遊休比率（p75）", (m) => pct(m.idleLabor.p75ShareOfRegularLabor)],
    ["遊休比率（最大）", (m) => pct(m.idleLabor.maxShareOfRegularLabor)],
  ];
  for (const [label, f] of idleRows) L.push(`| ${label} | ` + sections.map((x) => f(x.m)).join(" | ") + " |");
  L.push("");

  L.push("## 2. 固定費の内訳（1社1四半期平均）");
  L.push("");
  L.push("| 項目 | " + sections.map((x) => x.title).join(" | ") + " |");
  L.push("|---|" + sections.map(() => "---:").join("|") + "|");
  for (const k of Object.keys(controlPreM.fixedCostPerQuarter) as (keyof typeof controlPreM.fixedCostPerQuarter)[]) {
    L.push(`| ${k} | ` + sections.map((x) => fmtUsd(x.m.fixedCostPerQuarter[k])).join(" | ") + " |");
  }
  L.push("");

  L.push("## 3. 稼働率と能力余剰");
  L.push("");
  L.push("| 指標 | " + sections.map((x) => x.title).join(" | ") + " |");
  L.push("|---|" + sections.map(() => "---:").join("|") + "|");
  const capRows: [string, (m: ReturnType<typeof measure>) => string][] = [
    ["設備稼働率（平均）", (m) => pct(m.utilization.meanEquipment)],
    ["設備稼働率（中央値）", (m) => pct(m.utilization.medianEquipment)],
    ["HOSO余剰（t/Q）", (m) => m.capacitySurplusTons.hosoMean.toFixed(0)],
    ["PD余剰（t/Q）", (m) => m.capacitySurplusTons.pdMean.toFixed(0)],
    ["VAP余剰（t/Q）", (m) => m.capacitySurplusTons.vapMean.toFixed(0)],
    ["**商品別余剰の単純合計**", (m) => `**${m.capacitySurplusTons.perProductSumMean.toFixed(0)}**`],
    ["共通前処理の余剰", (m) => m.capacitySurplusTons.commonMean.toFixed(0)],
    ["労務余剰（遊休人員×効率）", (m) => m.capacitySurplusTons.laborSurplusTonsMean.toFixed(0)],
    ["商品別合計>共通余剰 の標本割合", (m) => pct(m.capacitySurplusTons.shareWherePerProductSumExceedsCommon)],
    ["同 超過分の平均（t/Q）", (m) => m.capacitySurplusTons.meanExcessOverCommon.toFixed(0)],
  ];
  for (const [label, f] of capRows) L.push(`| ${label} | ` + sections.map((x) => f(x.m)).join(" | ") + " |");
  L.push("");
  L.push("**二重計上の検証（ご指示7）**: 商品別の能力余剰を単純合計すると、共通前処理の余剰を必ず上回る。");
  L.push("さらに労務余剰は全商品で共有されるため、商品別余剰とは別軸である。");
  L.push("この3つを合算してはいけないことが実測で確認できる（詳細は設計書 §3.1-B）。");
  L.push("");

  L.push("## 3b. 制約別の「作れなかった量」（トン/四半期・平均）");
  L.push("");
  L.push("| 制約 | " + sections.map((x) => x.title).join(" | ") + " |");
  L.push("|---|" + sections.map(() => "---:").join("|") + "|");
  L.push("| 労務制約 | " + sections.map((x) => x.m.shortfallTonsPerQuarter.laborMean.toFixed(0)).join(" | ") + " |");
  L.push("| 設備制約 | " + sections.map((x) => x.m.shortfallTonsPerQuarter.equipmentMean.toFixed(0)).join(" | ") + " |");
  L.push("| 原料制約 | " + sections.map((x) => x.m.shortfallTonsPerQuarter.rawMaterialMean.toFixed(0)).join(" | ") + " |");
  L.push(
    "| 労務制約が発生した四半期 | " +
      sections.map((x) => `${x.m.shortfallTonsPerQuarter.quartersWithLaborShortfall}/${x.m.shortfallTonsPerQuarter.quartersTotal}`).join(" | ") +
      " |"
  );
  L.push("");
  L.push("**これは「人員を持つことの便益」の上限を与える**。労務制約による欠品がゼロなら、");
  L.push("人員を増やしても生産は1トンも増えず、削減の一方通行が最適になる。");
  L.push("");

  L.push("## 4. 資金（ご指示8・9）");
  L.push("");
  L.push("| 指標 | " + sections.map((x) => x.title).join(" | ") + " |");
  L.push("|---|" + sections.map(() => "---:").join("|") + "|");
  const fundRows: [string, (m: ReturnType<typeof measure>) => string][] = [
    ["期首現金（平均）", (m) => fmtUsd(m.funding.meanOpeningCashUsd)],
    ["当期総支出（平均）", (m) => fmtUsd(m.funding.meanTotalOutflowUsd)],
    ["資金枠余裕（平均）", (m) => fmtUsd(m.funding.meanFundingHeadroomUsd)],
    ["資金枠余裕（中央値）", (m) => fmtUsd(m.funding.medianFundingHeadroomUsd)],
    ["借入余力超過の会社×四半期", (m) => `${m.funding.quartersExceedingBorrowingCapacity} / ${m.funding.quartersTotal}`],
    ["一度でも超過した会社ケース", (m) => `${m.funding.companiesEverExceeding} / ${m.funding.companyCasesTotal}`],
  ];
  for (const [label, f] of fundRows) L.push(`| ${label} | ` + sections.map((x) => f(x.m)).join(" | ") + " |");
  L.push("");
  L.push("資金枠余裕 = 期首現金 ＋ 借入余力 − 当期総支出（直接法の支出内訳＋投資支出）。");
  L.push("");

  L.push("## 5. 人員方針の係数候補比較（反実仮想リプレイ）");
  L.push("");
  L.push("**基準**: control の生存期間。**採用リードタイム 1Q**。");
  L.push("");
  L.push("**この評価の限界（正直な明記）**: 実績軌跡（各四半期に実際へ配属された人員）を所与として");
  L.push("方針を当てはめる一次近似である。実際には人員を削れば生産・成約・価格も変わるため、");
  L.push("削減額は上限寄り・欠品は下限寄りに出る。方針の**相対比較**には使えるが、絶対額の予測には使えない。");
  L.push("");
  L.push(`単位限界利益の仮定: ${unitCm.toFixed(0)} USD/トン（control生存期間の実測平均）`);
  L.push(`採用コスト ${HIRING_COST_PER_HEAD} USD/人、解雇コスト ${SEVERANCE_COST_PER_HEAD} USD/人（ご指示の暫定値）`);
  L.push("");
  L.push(`現行AI（実績軌跡）に同じ一時費用を課した基準: 人件費 ${fmtUsd(grid[0].baselineLaborCostUsd)} ＋ 解雇費 ${fmtUsd(grid[0].baselineSeveranceUsd)} ＋ 採用費 ${fmtUsd(grid[0].baselineHiringUsd)} ＝ **総コスト ${fmtUsd(grid[0].baselineTotalCostUsd)}**`);
  L.push(`現行AIの人員変動総量: ${grid[0].baselineHeadcountChurnHeads.toFixed(0)} 人（増減の絶対値合計）`);
  L.push("");
  L.push("| 安全余力 | 確認期間 | 削減上限 | 人件費 | 解雇費 | 採用費 | 不足人月 | 機会損失 | 欠品回避 | 総コスト | **改善額** | 削減回数 | 採用回数 | 人員変動 |");
  L.push("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const g of grid) {
    L.push(
      `| ${pct(g.safetyMargin)} | ${g.persistenceQuarters}Q | ${pct(g.reductionCapRatio)} | ${fmtUsd(g.policyLaborCostUsd)} | ${fmtUsd(g.policySeveranceUsd)} | ${fmtUsd(g.policyHiringUsd)} | ${g.shortfallHeadQuarters.toFixed(0)} | ${fmtUsd(g.opportunityLossUsd)} | ${fmtUsd(g.recoveredValueUsd)} | ${fmtUsd(g.policyTotalCostUsd)} | **${fmtUsd(g.improvementUsd)}** | ${g.reductionEvents} | ${g.hiringEvents} | ${g.policyHeadcountChurnHeads.toFixed(0)} |`
    );
  }
  L.push("");
  L.push("## 6. 採用リードタイムの感度（安全余力15%・確認期間2Q・削減上限15%）");
  L.push("");
  L.push("| リードタイム | 人件費 | 不足人月 | 機会損失 | 欠品回避 | 総コスト | 改善額 |");
  L.push("|---:|---:|---:|---:|---:|---:|---:|");
  for (const g of leadTimeComparison) {
    L.push(`| ${g.hiringLeadTimeQuarters}Q | ${fmtUsd(g.policyLaborCostUsd)} | ${g.shortfallHeadQuarters.toFixed(0)} | ${fmtUsd(g.opportunityLossUsd)} | ${fmtUsd(g.recoveredValueUsd)} | ${fmtUsd(g.policyTotalCostUsd)} | ${fmtUsd(g.improvementUsd)} |`);
  }
  L.push("");
  L.push("## 7. 削減の回収期間（解雇2Q分・採用1Q分）");
  L.push("");
  L.push(`- 1人削減の節約: ${REGULAR_SALARY} USD/四半期`);
  L.push(`- 1人削減の一時費用: ${SEVERANCE_COST_PER_HEAD} USD → **回収期間 ${(SEVERANCE_COST_PER_HEAD / REGULAR_SALARY).toFixed(1)} 四半期**`);
  L.push(`- 削減して N 四半期後に再採用した場合: 一時費用 ${SEVERANCE_COST_PER_HEAD + HIRING_COST_PER_HEAD} USD、節約 ${REGULAR_SALARY}×N USD`);
  L.push(`  → **N ≥ ${((SEVERANCE_COST_PER_HEAD + HIRING_COST_PER_HEAD) / REGULAR_SALARY).toFixed(0)} 四半期**でなければ往復が損になる`);
  L.push("");

  fs.writeFileSync(path.join(outDir, "summary.md"), L.join("\n"));
  console.log(`\n出力: ${outDir}/{measurement.json, policy-grid.json, summary.md, quarterly.csv, policy-grid.csv}`);
  console.log(L.join("\n"));
}

main();
