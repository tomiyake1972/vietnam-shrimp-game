// ShrimpX V2 — SAI-3A 標準初期条件の再選定グリッド探索（Phase A-4）
//
// 【背景】PDの機械化前労働集約度係数を 1.2 → 1.8 へ見直した結果、同じPD生産量に
// 1.5倍の人手が必要になり、既存の選定済み候補 "moderate-pressure" では
// 12シード・8四半期で**全社が支払不能**に至るようになった。これは旧係数を前提に
// キャリブレーションされていたことの帰結であり、標準初期条件側を再選定する必要がある。
//
// 【重要・本スクリプトの位置づけ】
//  - **生産係数は一切変更しない**（PD 1.8 等は確定値として扱う）。
//  - 動かすのは初期条件のみ（初期常用ワーカー・初期現金・借入枠・初期契約残）。
//  - **候補を採用しない。** 比較表を出すだけであり、選定はオーナーの判断。
//    どの候補も `SELECTED_STANDARD_BASELINE_CANDIDATE_ID` へは反映しない。
//
// 【狙う環境】全社が安全になることではなく、**moderate pressure**である。
//  - 一部のシード・会社は行き詰まる
//  - 全シードで機械的に全社破綻はしない
//  - 販売・生産・労務・資金の判断差が結果に現れる
//  - 初期条件が潤沢すぎない
//
// 【実行してわかったこと（2026-08-02 実測。数値は本スクリプトの出力そのもの）】
//  1. 支配軸は常用人員ではなく**初期現金**だった。常用人員だけを増やすと結果は
//     単調に悪化する（P0→P1→P2で累積営業利益 -31.6M→-44.7M→-54.0M）。人手を
//     増やしても原料が買えないので生産は増えず、常用人件費だけが固定費として増える。
//  2. 生産未達の内訳を分けると、**原料起因が支配的**で労働起因は小さい
//     （P0: 原料94,871t / 労働4,031t / 設備828t）。しかも原料未達は初期現金と
//     単調に相関する（常用1.5倍固定で 20M→94,871t, 35M→61,318t, 42M→54,799t,
//     48M→43,273t, 54M→37,019t, 60M→27,156t）。機序は runner.ts の
//     computeProcurementConstraint で、資金制約 scaleRatio が国内買付・自社養殖の
//     数量をそのまま縮小するため。つまり**原料未達は資金制約の下流症状**であり、
//     初期在庫を独立軸として追加する必要はないと判断した（三宅さん指示の
//     「必要な場合のみ、理由を明記して」に対する回答）。
//  3. 破綻は 35M〜60M の間に崖がある。42M/48M でも全社破綻100%、54M で初めて
//     moderate（R3）、60M で安全側（P5）。
//  4. **副産物として発見した構造的な問題（本Phaseでは修正しない）**:
//     どのグリッド点でも「通常借入回数 = 0.00」だった。AIは毎四半期のように
//     資金調達を申し込んでいる（調達申込回数 6〜8回／8Q）のに、通常審査を通った
//     借入が一度も実行されず、実際の資金流入は**すべて緊急融資**である。
//     資金繰り判断の設計意図（financing.ts）が実質的に働いていない可能性が高い。
//     初期条件の再選定とは独立の問題なので、ここでは報告のみとする。
//
// 【限界（正直に）】本テストは5社を同一の初期条件へ複製する構造（SAI-2/3A基準テスト）
// なので、5社は設計上まったく同じである。したがって「会社間の判断差が結果に現れる」
// ことは初期条件のグリッドだけでは達成できない。ここで達成できるのは
// **moderate pressure な環境（一部のシードで一部の会社だけが行き詰まる）**までであり、
// 会社間の差別化には SAI-5B の perCompanyOverrides や経営プロファイルの併用が要る。
//
// 使い方: npx tsx scripts/sai3aBaselineGridSearch.ts [--write]

import { PeriodV2 } from "../app/lib/v2/core/period";
import { CompanyFixture, CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import {
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
  STANDARD_BASELINE_CANDIDATES,
  StandardBaselineCandidate,
} from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import { ALL_COMPANY_IDS, initializeUnifiedCompanyLabFromTemplate, runFromInit } from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";
import { generateStandardAiDecision } from "../app/lib/v2/companyLab/standardAi/policy";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { unwrapUsd } from "../app/lib/v2/finance/types";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const SEEDS = Array.from({ length: 12 }, (_, i) => `sai3a-grid-${String(i + 1).padStart(3, "0")}`);
const TURNS = 8;

const BASE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

/** グリッドの1点。初期条件のうち動かす軸だけを持つ。 */
export interface GridPoint {
  readonly id: string;
  /** 初期常用ワーカーの倍率（PD係数が1.5倍になったぶんを吸収する主軸）。 */
  readonly regularHeadcountMultiplier: number;
  /** 初期現金（USD）。 */
  readonly cashUsd: number;
  /** 初期短期借入（USD）。 */
  readonly shortTermLoansUsd: number;
  /** 初期長期借入（USD）。 */
  readonly longTermLoansUsd: number;
}

/**
 * 探索軸の選び方の根拠:
 *  - regularHeadcountMultiplier が主軸。PDの必要人員が1.5倍になったので、
 *    同じ操業規模を回すには常用ワーカーがそれに見合って必要になる。ここを
 *    動かさずに現金だけ増やしても「人手が足りず作れないまま資金が減る」だけになる。
 *  - cash / 借入枠 は資金繰り判断（financing.ts）が働く余地を決める副軸。
 *  - 初期契約残は候補2から引き継いだ値をそのまま使う（在庫・受注構成は
 *    今回は動かさない。動かす必要が出た場合は理由を明記して追加する）。
 */
export const GRID: readonly GridPoint[] = [
  { id: "P0-current", regularHeadcountMultiplier: 1.0, cashUsd: 20_000_000, shortTermLoansUsd: 24_000_000, longTermLoansUsd: 33_000_000 },
  { id: "P1-head1.3", regularHeadcountMultiplier: 1.3, cashUsd: 20_000_000, shortTermLoansUsd: 24_000_000, longTermLoansUsd: 33_000_000 },
  { id: "P2-head1.5", regularHeadcountMultiplier: 1.5, cashUsd: 20_000_000, shortTermLoansUsd: 24_000_000, longTermLoansUsd: 33_000_000 },
  { id: "P3-head1.5+cash", regularHeadcountMultiplier: 1.5, cashUsd: 35_000_000, shortTermLoansUsd: 30_000_000, longTermLoansUsd: 40_000_000 },
  { id: "P4-head1.8+cash", regularHeadcountMultiplier: 1.8, cashUsd: 35_000_000, shortTermLoansUsd: 30_000_000, longTermLoansUsd: 40_000_000 },
  { id: "P5-head1.5+cash++", regularHeadcountMultiplier: 1.5, cashUsd: 60_000_000, shortTermLoansUsd: 40_000_000, longTermLoansUsd: 55_000_000 },
  { id: "P6-head1.8+cash++", regularHeadcountMultiplier: 1.8, cashUsd: 60_000_000, shortTermLoansUsd: 40_000_000, longTermLoansUsd: 55_000_000 },
  { id: "P7-head2.0+cash++", regularHeadcountMultiplier: 2.0, cashUsd: 60_000_000, shortTermLoansUsd: 40_000_000, longTermLoansUsd: 55_000_000 },
  // --- 第2段（第1段の結果を受けた絞り込み） ---
  // 第1段で判明したこと: 支配軸は常用人員ではなく**初期現金**だった。
  // 35M（P3/P4）は全社破綻100%、60M（P5）は破綻0%と、35M〜60Mの間で崖がある。
  // moderate pressure（＝一部だけ行き詰まる）はこの区間にしか存在しないので、
  // 常用倍率1.5/1.8を固定して現金だけ 42M / 48M / 54M で刻む。
  { id: "R1-h1.5-cash42", regularHeadcountMultiplier: 1.5, cashUsd: 42_000_000, shortTermLoansUsd: 36_000_000, longTermLoansUsd: 48_000_000 },
  { id: "R2-h1.5-cash48", regularHeadcountMultiplier: 1.5, cashUsd: 48_000_000, shortTermLoansUsd: 36_000_000, longTermLoansUsd: 48_000_000 },
  { id: "R3-h1.5-cash54", regularHeadcountMultiplier: 1.5, cashUsd: 54_000_000, shortTermLoansUsd: 36_000_000, longTermLoansUsd: 48_000_000 },
  { id: "R4-h1.8-cash42", regularHeadcountMultiplier: 1.8, cashUsd: 42_000_000, shortTermLoansUsd: 36_000_000, longTermLoansUsd: 48_000_000 },
  { id: "R5-h1.8-cash48", regularHeadcountMultiplier: 1.8, cashUsd: 48_000_000, shortTermLoansUsd: 36_000_000, longTermLoansUsd: 48_000_000 },
  { id: "R6-h1.8-cash54", regularHeadcountMultiplier: 1.8, cashUsd: 54_000_000, shortTermLoansUsd: 36_000_000, longTermLoansUsd: 48_000_000 },
];

function candidateFor(point: GridPoint): StandardBaselineCandidate {
  return {
    ...BASE,
    id: `grid-${point.id}`,
    label: `グリッド探索 ${point.id}`,
    rationale: "SAI-3A再選定のグリッド探索用。採用候補ではない。",
    buildFixtureTemplate: (startPeriod: PeriodV2): CompanyFixture => {
      const base = BASE.buildFixtureTemplate(startPeriod);
      return {
        ...base,
        workerBaseline: base.workerBaseline.map((w) => ({
          ...w,
          regularHeadcount: Math.round(w.regularHeadcount * point.regularHeadcountMultiplier),
        })),
      };
    },
    financeFixtureTemplate: {
      ...BASE.financeFixtureTemplate,
      cash: point.cashUsd,
      shortTermLoans: point.shortTermLoansUsd,
      longTermLoans: point.longTermLoansUsd,
    },
  };
}

export interface GridResult {
  readonly id: GridPoint["id"];
  /** 12シード×5社のうち、支払不能に至った割合（0〜1）。 */
  readonly paymentDefaultRate: number;
  /** 全社が支払不能になったシードの割合。1.0なら「全滅一辺倒」で不適。 */
  readonly allCompaniesDefaultSeedRate: number;
  /** 1社も支払不能にならなかったシードの割合。1.0なら「安全すぎ」で不適。 */
  readonly noCompanyDefaultSeedRate: number;
  /** 支払不能に至った会社の平均到達四半期（早いほど厳しい）。 */
  readonly meanQuartersToDefault: number | null;
  readonly meanFinalCashUsd: number;
  readonly meanFinalEquityUsd: number;
  readonly meanCumulativeOperatingProfitUsd: number;
  readonly meanOutstandingContractTons: number;
  /** 会社間のばらつき（期末現金の標準偏差）。判断差が結果に現れているかの代理指標。 */
  readonly finalCashStdDevUsd: number;
  // --- 三宅さん指定の追加指標（history から直接集計） ---
  /** 累積当期純利益の平均（USD／社）。 */
  readonly meanCumulativeNetIncomeUsd: number;
  /** 期末の借入残高（短期＋長期）平均。 */
  readonly meanFinalDebtUsd: number;
  /** 累積の労働起因の生産未達（HOSO換算トン／社）。 */
  readonly meanLaborShortfallTons: number;
  /** 累積の生産未達合計（原料＋設備＋労働、HOSO換算トン／社）。 */
  readonly meanProductionShortfallTons: number;
  /** 期末の製品在庫（HOSO換算トン／社）。 */
  readonly meanFinishedGoodsInventoryTons: number;
  /** 累積の契約未達（期日超過＝overdueQuantity、HOSO換算トン／社）。 */
  readonly meanOverdueContractTons: number;
  /** 追加借入が実行された四半期の回数（loanDrawUsd>0）平均／社。 */
  readonly meanBorrowingEventCount: number;
  /** うち通常審査を通った借入（underwriting.approvedAmountUsd>0）の回数平均／社。 */
  readonly meanNormalLoanEventCount: number;
  /** 緊急融資が発動した四半期の回数の平均／社。 */
  readonly meanEmergencyLoanEventCount: number;
  /** AIが資金調達を申し込んだ四半期の回数の平均／社（requestedAmountUsd>0）。 */
  readonly meanFinancingRequestCount: number;
  /** 累積の原料起因の生産未達（HOSO換算トン／社）。 */
  readonly meanRawMaterialShortfallTons: number;
  /** 累積の設備起因の生産未達（HOSO換算トン／社）。 */
  readonly meanEquipmentShortfallTons: number;
}

interface PerCompanyMetrics {
  readonly finalCashUsd: number;
  readonly finalEquityUsd: number;
  readonly cumulativeOperatingProfitUsd: number;
  readonly cumulativeNetIncomeUsd: number;
  readonly outstandingContractTons: number;
  readonly paymentDefaultQuarter: number | null;
  readonly finalDebtUsd: number;
  readonly laborShortfallTons: number;
  readonly productionShortfallTons: number;
  readonly finishedGoodsInventoryTons: number;
  readonly overdueContractTons: number;
  readonly borrowingEventCount: number;
  readonly normalLoanEventCount: number;
  readonly emergencyLoanEventCount: number;
  readonly financingRequestCount: number;
  readonly rawMaterialShortfallTons: number;
  readonly equipmentShortfallTons: number;
}

function stdDev(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

/**
 * 1シードぶんの実行。`runStandardBaselineTest` と同じ初期化・同じ decisionProvider を
 * 使うが、history をそのまま集計して三宅さん指定の追加指標（労働未達・生産未達・
 * 製品在庫・契約未達・追加借入回数）まで取る。ゲーム側は一切変更していない。
 */
function runSeed(candidate: StandardBaselineCandidate, seed: string): Record<CompanyId, PerCompanyMetrics> {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns: TURNS };
  const initResult = initializeUnifiedCompanyLabFromTemplate(
    config,
    candidate.buildFixtureTemplate,
    candidate.financeFixtureTemplate,
    candidate.contractDefs,
    ALL_COMPANY_IDS
  );
  const result = runFromInit(initResult, generateStandardAiDecision);

  const out: Record<string, PerCompanyMetrics> = {};
  for (const companyId of ALL_COMPANY_IDS) {
    let cumulativeOperatingProfit = 0;
    let cumulativeNetIncome = 0;
    let laborShortfall = 0;
    let productionShortfall = 0;
    let overdue = 0;
    let borrowingEvents = 0;
    let normalLoanEvents = 0;
    let emergencyEvents = 0;
    let financingRequests = 0;
    let rawMaterialShortfall = 0;
    let equipmentShortfall = 0;
    let paymentDefaultQuarter: number | null = null;
    let finalCash = 0;
    let finalEquity = 0;
    let finalDebt = 0;
    let outstanding = 0;
    let finishedGoods = 0;

    for (const record of result.history) {
      const fin = record.financialResults.find((f) => f.companyId === companyId);
      const fcg = record.financingResults.find((f) => f.companyId === companyId);
      const summary = record.companySummaries.find((s) => s.companyId === companyId);
      if (!fin || !fcg || !summary) continue;
      cumulativeOperatingProfit += unwrapUsd(fin.profitAndLoss.operatingProfit);
      cumulativeNetIncome += unwrapUsd(fin.profitAndLoss.netIncome);
      laborShortfall += unwrapUnit(summary.laborShortfall);
      rawMaterialShortfall += unwrapUnit(summary.rawMaterialShortfall);
      equipmentShortfall += unwrapUnit(summary.equipmentShortfall);
      productionShortfall +=
        unwrapUnit(summary.laborShortfall) + unwrapUnit(summary.equipmentShortfall) + unwrapUnit(summary.rawMaterialShortfall);
      overdue += unwrapUnit(summary.overdueQuantity);
      if (fcg.loanDrawUsd > 0) borrowingEvents += 1;
      if (fcg.underwriting.approvedAmountUsd > 0) normalLoanEvents += 1;
      if (fcg.underwriting.requestedAmountUsd > 0) financingRequests += 1;
      if (fcg.emergencyLoan) emergencyEvents += 1;
      if (paymentDefaultQuarter === null && fcg.financialHealth.paymentDefault) paymentDefaultQuarter = record.turn;
      if (record.turn === TURNS) {
        finalCash = unwrapUsd(fin.balanceSheet.cash);
        finalEquity = unwrapUsd(fin.balanceSheet.totalEquity);
        finalDebt = fcg.endingShortTermLoansUsd + fcg.endingLongTermLoansUsd;
        outstanding = unwrapUnit(summary.outstandingQuantity);
        finishedGoods = unwrapUnit(summary.finishedGoodsInventory);
      }
    }

    out[companyId] = {
      finalCashUsd: finalCash,
      finalEquityUsd: finalEquity,
      cumulativeOperatingProfitUsd: cumulativeOperatingProfit,
      cumulativeNetIncomeUsd: cumulativeNetIncome,
      outstandingContractTons: outstanding,
      paymentDefaultQuarter,
      finalDebtUsd: finalDebt,
      laborShortfallTons: laborShortfall,
      productionShortfallTons: productionShortfall,
      finishedGoodsInventoryTons: finishedGoods,
      overdueContractTons: overdue,
      borrowingEventCount: borrowingEvents,
      normalLoanEventCount: normalLoanEvents,
      emergencyLoanEventCount: emergencyEvents,
      financingRequestCount: financingRequests,
      rawMaterialShortfallTons: rawMaterialShortfall,
      equipmentShortfallTons: equipmentShortfall,
    };
  }
  return out as Record<CompanyId, PerCompanyMetrics>;
}

export function evaluate(point: GridPoint): GridResult {
  const candidate = candidateFor(point);

  let defaults = 0;
  let total = 0;
  let allDefaultSeeds = 0;
  let noDefaultSeeds = 0;
  const quartersToDefault: number[] = [];
  const rows: PerCompanyMetrics[] = [];

  for (const seed of SEEDS) {
    const perCompany = runSeed(candidate, seed);
    let seedDefaults = 0;
    for (const companyId of ALL_COMPANY_IDS) {
      const f = perCompany[companyId];
      total += 1;
      if (f.paymentDefaultQuarter !== null) {
        defaults += 1;
        seedDefaults += 1;
        quartersToDefault.push(f.paymentDefaultQuarter);
      }
      rows.push(f);
    }
    if (seedDefaults === ALL_COMPANY_IDS.length) allDefaultSeeds += 1;
    if (seedDefaults === 0) noDefaultSeeds += 1;
  }

  const mean = (v: readonly number[]) => (v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  const meanOf = (pick: (m: PerCompanyMetrics) => number) => mean(rows.map(pick));
  return {
    id: point.id,
    paymentDefaultRate: total > 0 ? defaults / total : 0,
    allCompaniesDefaultSeedRate: allDefaultSeeds / SEEDS.length,
    noCompanyDefaultSeedRate: noDefaultSeeds / SEEDS.length,
    meanQuartersToDefault: quartersToDefault.length > 0 ? mean(quartersToDefault) : null,
    meanFinalCashUsd: meanOf((m) => m.finalCashUsd),
    meanFinalEquityUsd: meanOf((m) => m.finalEquityUsd),
    meanCumulativeOperatingProfitUsd: meanOf((m) => m.cumulativeOperatingProfitUsd),
    meanOutstandingContractTons: meanOf((m) => m.outstandingContractTons),
    finalCashStdDevUsd: stdDev(rows.map((m) => m.finalCashUsd)),
    meanCumulativeNetIncomeUsd: meanOf((m) => m.cumulativeNetIncomeUsd),
    meanFinalDebtUsd: meanOf((m) => m.finalDebtUsd),
    meanLaborShortfallTons: meanOf((m) => m.laborShortfallTons),
    meanProductionShortfallTons: meanOf((m) => m.productionShortfallTons),
    meanFinishedGoodsInventoryTons: meanOf((m) => m.finishedGoodsInventoryTons),
    meanOverdueContractTons: meanOf((m) => m.overdueContractTons),
    meanBorrowingEventCount: meanOf((m) => m.borrowingEventCount),
    meanNormalLoanEventCount: meanOf((m) => m.normalLoanEventCount),
    meanEmergencyLoanEventCount: meanOf((m) => m.emergencyLoanEventCount),
    meanFinancingRequestCount: meanOf((m) => m.financingRequestCount),
    meanRawMaterialShortfallTons: meanOf((m) => m.rawMaterialShortfallTons),
    meanEquipmentShortfallTons: meanOf((m) => m.equipmentShortfallTons),
  };
}

/** moderate候補のシード別内訳（何社が行き詰まったか）。「一部だけ行き詰まる」かの確認用。 */
export function seedBreakdown(point: GridPoint): readonly { readonly seed: string; readonly defaultedCompanies: number }[] {
  const candidate = candidateFor(point);
  return SEEDS.map((seed) => {
    const perCompany = runSeed(candidate, seed);
    const defaultedCompanies = ALL_COMPANY_IDS.filter((c) => perCompany[c].paymentDefaultQuarter !== null).length;
    return { seed, defaultedCompanies };
  });
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

if (process.argv[1] && process.argv[1].endsWith("sai3aBaselineGridSearch.ts")) {
  console.log(`=== SAI-3A 標準初期条件の再選定グリッド探索（${SEEDS.length}シード × ${TURNS}四半期 × 5社）===`);
  console.log("【重要】生産係数は変更していない。動かしたのは初期条件のみ。候補は採用しない（選定はオーナー判断）。\n");
  console.log("候補              | 常用倍率 | 初期現金    | 短期借入   | 長期借入   | 支払不能率 | 全社破綻seed | 無破綻seed | 平均破綻Q | 平均期末現金   | 期末現金の社間σ");
  console.log("------------------|----------|-------------|------------|------------|------------|--------------|------------|-----------|----------------|------------------");
  const results: GridResult[] = [];
  for (const point of GRID) {
    const r = evaluate(point);
    results.push(r);
    console.log(
      `${point.id.padEnd(17)} | ${point.regularHeadcountMultiplier.toFixed(1).padStart(8)} | ${fmt(point.cashUsd).padStart(11)} | ` +
        `${fmt(point.shortTermLoansUsd).padStart(10)} | ${fmt(point.longTermLoansUsd).padStart(10)} | ${pct(r.paymentDefaultRate).padStart(10)} | ` +
        `${pct(r.allCompaniesDefaultSeedRate).padStart(12)} | ${pct(r.noCompanyDefaultSeedRate).padStart(10)} | ` +
        `${(r.meanQuartersToDefault ?? 0).toFixed(1).padStart(9)} | ${fmt(r.meanFinalCashUsd).padStart(14)} | ${fmt(r.finalCashStdDevUsd).padStart(16)}`
    );
  }

  console.log("\n=== 追加指標1（財務） ===");
  console.log("候補              | 平均期末純資産   | 累積営業利益     | 累積当期純利益   | 期末借入残高   | 調達申込回数 | 通常借入回数 | 緊急融資回数");
  console.log("------------------|------------------|------------------|------------------|----------------|--------------|--------------|-------------");
  for (const r of results) {
    console.log(
      `${r.id.padEnd(17)} | ${fmt(r.meanFinalEquityUsd).padStart(16)} | ${fmt(r.meanCumulativeOperatingProfitUsd).padStart(16)} | ` +
        `${fmt(r.meanCumulativeNetIncomeUsd).padStart(16)} | ${fmt(r.meanFinalDebtUsd).padStart(14)} | ` +
        `${r.meanFinancingRequestCount.toFixed(2).padStart(12)} | ${r.meanNormalLoanEventCount.toFixed(2).padStart(12)} | ${r.meanEmergencyLoanEventCount.toFixed(2).padStart(12)}`
    );
  }

  console.log("\n=== 追加指標2（操業・単位はHOSO換算トン／社、未達は8Qの累計） ===");
  console.log("候補              | 労働未達(t) | 原料未達(t) | 設備未達(t) | 生産未達計(t) | 期末製品在庫(t) | 期末受注残(t) | 契約遅延累計(t)");
  console.log("------------------|-------------|-------------|-------------|---------------|-----------------|---------------|----------------");
  for (const r of results) {
    console.log(
      `${r.id.padEnd(17)} | ${fmt(r.meanLaborShortfallTons).padStart(11)} | ${fmt(r.meanRawMaterialShortfallTons).padStart(11)} | ` +
        `${fmt(r.meanEquipmentShortfallTons).padStart(11)} | ${fmt(r.meanProductionShortfallTons).padStart(13)} | ` +
        `${fmt(r.meanFinishedGoodsInventoryTons).padStart(15)} | ${fmt(r.meanOutstandingContractTons).padStart(13)} | ${fmt(r.meanOverdueContractTons).padStart(14)}`
    );
  }

  console.log("\n=== moderate pressure の判定（全社破綻seed率 < 100% かつ 無破綻seed率 < 100%）===");
  for (const r of results) {
    const moderate = r.allCompaniesDefaultSeedRate < 1 && r.noCompanyDefaultSeedRate < 1;
    console.log(`${r.id.padEnd(17)}: ${moderate ? "○ 判断差が現れうる" : r.allCompaniesDefaultSeedRate >= 1 ? "× 全滅一辺倒" : "× 安全すぎ"}`);
  }

  const moderateIds = results.filter((r) => r.allCompaniesDefaultSeedRate < 1 && r.noCompanyDefaultSeedRate < 1).map((r) => r.id);
  const breakdowns: Record<string, readonly { readonly seed: string; readonly defaultedCompanies: number }[]> = {};
  if (moderateIds.length > 0) {
    console.log("\n=== moderate候補のシード別内訳（5社中の支払不能社数）===");
    for (const id of moderateIds) {
      const point = GRID.find((p) => p.id === id)!;
      const bd = seedBreakdown(point);
      breakdowns[id] = bd;
      console.log(`${id.padEnd(17)}: ${bd.map((b) => b.defaultedCompanies).join(" ")}   （seed順、0=無傷 5=全社破綻）`);
    }
  }

  console.log("\n【本スクリプトはいずれの候補も採用しない。SELECTED_STANDARD_BASELINE_CANDIDATE_ID は変更していない。選定はオーナー判断。】");

  if (process.argv.includes("--write")) {
    const outDir = join(process.cwd(), "artifacts", "sai3a-baseline");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "sai3a-grid-search.json"),
      JSON.stringify({ grid: GRID, results, breakdowns, seeds: SEEDS, turns: TURNS, adopted: false }, null, 2),
      "utf8"
    );
    console.log(`\n出力: ${outDir}`);
  }
}
