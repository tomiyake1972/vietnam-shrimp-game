// ShrimpX V2 — PD省人化の比較シミュレーション（実装指示 §9）と感度分析（§10）
//
// 【この比較の要点】「必要労働の理論削減」と「PL/CFに実際に現れる効果」を**別々に**
// 報告する。理論削減は係数比から決まる固定値だが、実際の効果は
//   臨時削減／残業削減／常用減員／他商品への振り替え／同じ人手での増産
// のいずれかを実行できたときにしか現れない。
//
// ケース:
//   A HOSO中心・省人化なし
//   B PD中心・省人化なし
//   C PD中心・適時に省人化（稼働率が上がってから）
//   D PD+VAP・適時に省人化
//   E 販売見込みが無いまま省人化（＝失敗するはずのケース）
//
// 使い方:
//   npx tsx scripts/pdMechanizationComparison.ts             … 4ケース比較
//   npx tsx scripts/pdMechanizationComparison.ts --sensitivity … 係数の感度分析
//   npx tsx scripts/pdMechanizationComparison.ts --write      … CSV/JSON出力

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../app/lib/v2/companyLab/autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { Product } from "../app/lib/v2/market/types";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "../app/lib/v2/production/parameters";
import { effectiveEfficiencyPerHeadTons, requiredHeadcountForQuantity } from "../app/lib/v2/production/labor";
import { FINANCE_PARAMETERS_V1 } from "../app/lib/v2/finance/parameters";
import { CAPEX_PARAMETERS_V1 } from "../app/lib/v2/capex/parameters";
import { buildMechanizationLevelsByFactory } from "../app/lib/v2/companyLab/pdMechanizationState";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export const SEEDS = ["pd-mech-seed-1", "pd-mech-seed-2", "pd-mech-seed-3"] as const;
export const HORIZON_QUARTERS = 20;
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

export type CaseId = "A-hoso-no-mech" | "B-pd-no-mech" | "C-pd-mech" | "D-pdvap-mech" | "E-mech-no-sales";

export interface CaseProfile {
  readonly id: CaseId;
  readonly label: string;
  /** 商品別の生産優先度（小さいほど優先）。 */
  readonly productionPriority: Readonly<Record<Product, number>>;
  /** 省人化を提案するturn（nullなら行わない）。 */
  readonly mechanizationTurn: number | null;
  /** 毎四半期の営業人員追加採用数（販売見込みを作れるかどうかの差）。 */
  readonly salesHirePerQuarter: number;
  /** 販売計画の商品別倍率（HOSO中心／PD中心／PD+VAPを表現する）。 */
  readonly salesMultiplier: Readonly<Record<Product, number>>;
}

/**
 * 【ケース設計】turnそのものに意味があるのではなく、「稼働率が上がってから
 * 省人化する（C・D）」と「販売見込みが無いまま省人化する（E）」の対比が本質。
 * Cの turn8 は、この設定でPD稼働率が十分に立ち上がったあとの時期として選んだ。
 */
export const CASE_PROFILES: readonly CaseProfile[] = [
  {
    id: "A-hoso-no-mech",
    label: "A: HOSO中心・省人化なし",
    productionPriority: { hoso: 1, pd: 2, vap: 3 },
    mechanizationTurn: null,
    salesHirePerQuarter: 2,
    salesMultiplier: { hoso: 1.6, pd: 0.6, vap: 0.4 },
  },
  {
    id: "B-pd-no-mech",
    label: "B: PD中心・省人化なし",
    productionPriority: { hoso: 3, pd: 1, vap: 2 },
    mechanizationTurn: null,
    salesHirePerQuarter: 2,
    salesMultiplier: { hoso: 0.6, pd: 1.8, vap: 0.6 },
  },
  {
    id: "C-pd-mech",
    label: "C: PD中心・適時に省人化",
    productionPriority: { hoso: 3, pd: 1, vap: 2 },
    mechanizationTurn: 8,
    salesHirePerQuarter: 2,
    salesMultiplier: { hoso: 0.6, pd: 1.8, vap: 0.6 },
  },
  {
    id: "D-pdvap-mech",
    label: "D: PD+VAP・適時に省人化",
    productionPriority: { hoso: 3, pd: 1, vap: 2 },
    mechanizationTurn: 8,
    salesHirePerQuarter: 3,
    salesMultiplier: { hoso: 0.5, pd: 1.5, vap: 1.4 },
  },
  {
    id: "E-mech-no-sales",
    label: "E: 販売見込み無しで省人化",
    productionPriority: { hoso: 3, pd: 1, vap: 2 },
    mechanizationTurn: 2,
    salesHirePerQuarter: 0,
    salesMultiplier: { hoso: 0.4, pd: 0.5, vap: 0.3 },
  },
];

function labConfig(seed: string): CompanyLabConfig {
  return {
    scenarioId: "baseline",
    mode: "canonical",
    seed,
    turns: HORIZON_QUARTERS,
    sai5: { productLifecycle: true, supplyPremiumFeedback: true },
    marketEvolution: {
      originProcessingCapacity: true,
      tunedProductLifecycle: true,
      perProductDestinationPricing: true,
      processingAdvantageDemandCapture: true,
      productWiseCompetitiveness: true,
      salesCapability: true,
    },
  };
}

export interface QuarterRow {
  readonly caseId: CaseId;
  readonly seed: string;
  readonly companyId: CompanyId;
  readonly quarter: number;
  readonly mechanizationLevel: number;
  readonly producedHoso: number;
  readonly producedPd: number;
  readonly producedVap: number;
  readonly contractedTons: number;
  readonly finishedGoodsTons: number;
  readonly requiredLaborHoso: number;
  readonly requiredLaborPd: number;
  readonly requiredLaborVap: number;
  readonly requiredLaborTotal: number;
  readonly regularHeadcount: number;
  readonly temporaryHeadcount: number;
  readonly overtimeRate: number;
  readonly surplusRegularHeadcount: number;
  readonly laborShortfallTons: number;
  readonly regularLaborCostUsd: number;
  readonly temporaryLaborCostUsd: number;
  readonly investmentUsd: number;
  readonly operatingProfitUsd: number;
  readonly netIncomeUsd: number;
  readonly operatingCashFlowUsd: number;
  readonly cashUsd: number;
  readonly debtUsd: number;
}

export function runCase(profile: CaseProfile, seed: string, params: ProductionParameters = PRODUCTION_PARAMETERS_V1): readonly QuarterRow[] {
  const config = labConfig(seed);
  const { state: initialState, fixtures } = initializeCompanyLab(config);
  let state = initialState;
  const rows: QuarterRow[] = [];

  for (let i = 0; i < HORIZON_QUARTERS; i += 1) {
    if (state.isComplete) break;
    const turn = state.scenarioState.currentTurn;
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<CompanyId, CompanyDecisionInput> = {};

    for (const fixture of fixtures) {
      const ownState = buildCompanyOwnState(state, fixture);
      let decision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, turn);

      // 商品志向（販売計画・生産優先度）。
      decision = {
        ...decision,
        salesPlans: decision.salesPlans.map((p) => ({
          ...p,
          desiredQuantity: ((p.desiredQuantity as unknown as number) * profile.salesMultiplier[p.product]) as typeof p.desiredQuantity,
        })),
        productionPlans: decision.productionPlans.map((p) => ({ ...p, priority: profile.productionPriority[p.product] })),
      };
      if (profile.salesHirePerQuarter > 0) {
        decision = { ...decision, salesForceHireCount: profile.salesHirePerQuarter };
      }
      if (profile.mechanizationTurn !== null && turn === profile.mechanizationTurn) {
        const targetFactoryId = fixture.factories[0]?.factoryId;
        if (targetFactoryId) {
          decision = {
            ...decision,
            capexDecision: {
              ...decision.capexDecision,
              newProjectProposals: [
                ...decision.capexDecision.newProjectProposals,
                { projectType: "pdMechanization" as const, targetFactoryId },
              ],
            },
          };
        }
      }
      decisions[fixture.companyId] = decision;
    }

    const levelsBefore = buildMechanizationLevelsByFactory(state.capexState, state.pdMechanizationState, state.currentPeriod);
    const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = nextState.history[nextState.history.length - 1];

    for (const fixture of fixtures) {
      const decision = decisions[fixture.companyId];
      const fin = record.financialResults.find((f) => f.companyId === fixture.companyId);
      const factoryIds = new Set(fixture.factories.map((f) => f.factoryId));
      const level = Math.max(0, ...[...factoryIds].map((id) => levelsBefore.get(id) ?? 0));

      const producedByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
      for (const batch of record.batches) {
        if (batch.companyId !== fixture.companyId) continue;
        producedByProduct[batch.product] += unwrapUnit(batch.finishedGoodsQuantity);
      }

      // 必要労働（商品別）— 正典の逆算関数をそのまま使う。
      const assignment = decision.workerAssignments.find((w) => factoryIds.has(w.factoryId));
      const attendance = assignment ? unwrapUnit(assignment.attendanceRate) : 0.95;
      const overtime = assignment ? unwrapUnit(assignment.overtimeRate) : 0;
      const requiredByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
      for (const product of PRODUCTS) {
        const skill = assignment?.skills.find((s) => s.product === product);
        const skillLevel = skill ? unwrapUnit(skill.skillLevel) : 0.8;
        const planned = decision.productionPlans
          .filter((p) => p.companyId === fixture.companyId && p.product === product)
          .reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
        requiredByProduct[product] = requiredHeadcountForQuantity(
          planned,
          effectiveEfficiencyPerHeadTons(params.labor.regularEfficiencyPerHeadTons, product, params, level),
          attendance,
          skillLevel,
          overtime,
          params
        );
      }
      const requiredTotal = PRODUCTS.reduce((s, p) => s + requiredByProduct[p], 0);
      const regularHeadcount = decision.workerAssignments
        .filter((w) => factoryIds.has(w.factoryId))
        .reduce((s, w) => s + w.regularHeadcount, 0);
      const temporaryHeadcount = decision.workerAssignments
        .filter((w) => factoryIds.has(w.factoryId))
        .reduce((s, w) => s + w.temporaryHeadcount, 0);

      const contracted = record.salesRecord.allocations
        .flatMap((a) => a.companies.filter((c) => c.companyId === fixture.companyId))
        .reduce((sum, c) => sum + unwrapUnit(c.allocatedQuantity), 0);
      const summary = record.companySummaries.find((c) => c.companyId === fixture.companyId);
      // 労働不足による生産未達は、生産配分の段階別内訳（laborLimited）から取る。
      const laborShortfall = record.productionAllocation.entries
        .filter((e) => e.companyId === fixture.companyId)
        .reduce((s, e) => s + Math.max(0, unwrapUnit(e.stages.productCapacityLimited) - unwrapUnit(e.stages.laborLimited)), 0);

      rows.push({
        caseId: profile.id,
        seed,
        companyId: fixture.companyId,
        quarter: turn,
        mechanizationLevel: level,
        producedHoso: producedByProduct.hoso,
        producedPd: producedByProduct.pd,
        producedVap: producedByProduct.vap,
        contractedTons: contracted,
        finishedGoodsTons: summary ? unwrapUnit(summary.finishedGoodsInventory) : 0,
        requiredLaborHoso: requiredByProduct.hoso,
        requiredLaborPd: requiredByProduct.pd,
        requiredLaborVap: requiredByProduct.vap,
        requiredLaborTotal: requiredTotal,
        regularHeadcount,
        temporaryHeadcount,
        overtimeRate: overtime,
        surplusRegularHeadcount: Math.max(0, regularHeadcount - requiredTotal),
        laborShortfallTons: laborShortfall,
        regularLaborCostUsd: regularHeadcount * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter,
        temporaryLaborCostUsd: temporaryHeadcount * FINANCE_PARAMETERS_V1.labor.temporaryWorkerCostUsdPerQuarter,
        investmentUsd: fin ? Math.abs((fin.cashFlow?.investingCashFlow as unknown as number) ?? 0) : 0,
        operatingProfitUsd: fin ? (fin.profitAndLoss.operatingProfit as unknown as number) : 0,
        netIncomeUsd: fin ? (fin.profitAndLoss.netIncome as unknown as number) : 0,
        operatingCashFlowUsd: fin ? ((fin.cashFlow?.operatingCashFlow as unknown as number) ?? 0) : 0,
        cashUsd: fin ? (fin.balanceSheet.cash as unknown as number) : 0,
        debtUsd: fin
          ? ((fin.balanceSheet.shortTermLoans as unknown as number) ?? 0) + ((fin.balanceSheet.longTermLoans as unknown as number) ?? 0)
          : 0,
      });
    }
    state = nextState;
  }
  return rows;
}

export interface CaseSummary {
  readonly caseId: CaseId;
  readonly seed: string;
  readonly producedPd: number;
  readonly contractedTons: number;
  readonly finalFinishedGoodsTons: number;
  /** 【理論効果】機械化により削減された必要労働（人・四半期の合計）。 */
  readonly theoreticalLaborSavedHeadQuarters: number;
  /** 【理論効果】それを常用給与で金額換算した額（実際に減員できた場合の上限）。 */
  readonly theoreticalLaborSavingUsd: number;
  /** 【実効果】臨時人件費の削減額（機械化なしケース比ではなく、自ケース内の推移から）。 */
  readonly temporaryLaborCostUsd: number;
  readonly regularLaborCostUsd: number;
  /** 常用の余剰人員（人・四半期）。ここが大きいほど理論効果が実現していない。 */
  readonly surplusRegularHeadQuarters: number;
  readonly investmentUsd: number;
  readonly cumulativeNetIncomeUsd: number;
  readonly cumulativeOperatingCashFlowUsd: number;
  readonly finalCashUsd: number;
  readonly finalDebtUsd: number;
}

export function summarize(rows: readonly QuarterRow[], params: ProductionParameters = PRODUCTION_PARAMETERS_V1): CaseSummary {
  const sum = (pick: (r: QuarterRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
  const lastQuarter = Math.max(...rows.map((r) => r.quarter));
  const lastRows = rows.filter((r) => r.quarter === lastQuarter);

  // 理論削減: 各四半期の必要労働について「機械化していなかった場合」との差。
  const basePd = params.labor.laborIntensityCoefficient.pd;
  const basePdMech = params.labor.mechanizedLaborIntensityCoefficient.pd;
  const baseVap = params.labor.laborIntensityCoefficient.vap;
  const baseVapMech = params.labor.mechanizedLaborIntensityCoefficient.vap;
  let theoreticalSaved = 0;
  for (const r of rows) {
    if (r.mechanizationLevel <= 0) continue;
    const pdCoefNow = basePd - (basePd - basePdMech) * r.mechanizationLevel;
    const vapCoefNow = baseVap - (baseVap - baseVapMech) * r.mechanizationLevel;
    // 現在の必要労働は係数 pdCoefNow のもの。未機械化なら basePd/baseVap 相当になる。
    theoreticalSaved += r.requiredLaborPd * (basePd / pdCoefNow - 1) + r.requiredLaborVap * (baseVap / vapCoefNow - 1);
  }

  return {
    caseId: rows[0].caseId,
    seed: rows[0].seed,
    producedPd: sum((r) => r.producedPd),
    contractedTons: sum((r) => r.contractedTons),
    finalFinishedGoodsTons: lastRows.reduce((s, r) => s + r.finishedGoodsTons, 0),
    theoreticalLaborSavedHeadQuarters: theoreticalSaved,
    theoreticalLaborSavingUsd: theoreticalSaved * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter,
    temporaryLaborCostUsd: sum((r) => r.temporaryLaborCostUsd),
    regularLaborCostUsd: sum((r) => r.regularLaborCostUsd),
    surplusRegularHeadQuarters: sum((r) => r.surplusRegularHeadcount),
    investmentUsd: sum((r) => r.investmentUsd),
    cumulativeNetIncomeUsd: sum((r) => r.netIncomeUsd),
    cumulativeOperatingCashFlowUsd: sum((r) => r.operatingCashFlowUsd),
    finalCashUsd: lastRows.reduce((s, r) => s + r.cashUsd, 0),
    finalDebtUsd: lastRows.reduce((s, r) => s + r.debtUsd, 0),
  };
}

/** 感度分析用の係数セット（コードを編集せずに差し替えられること＝実装指示§10）。 */
export const SENSITIVITY_VARIANTS: readonly {
  readonly id: string;
  readonly label: string;
  readonly base: Readonly<Record<Product, number>>;
  readonly mechanized: Readonly<Record<Product, number>>;
}[] = [
  { id: "legacy", label: "旧実装相当", base: { hoso: 1.0, pd: 1.2, vap: 3.0 }, mechanized: { hoso: 1.0, pd: 1.0, vap: 3.0 } },
  { id: "conservative", label: "保守", base: { hoso: 1.0, pd: 1.6, vap: 3.0 }, mechanized: { hoso: 1.0, pd: 1.2, vap: 2.7 } },
  { id: "main", label: "本設定", base: { hoso: 1.0, pd: 1.8, vap: 3.0 }, mechanized: { hoso: 1.0, pd: 1.2, vap: 2.6 } },
  { id: "strong", label: "強", base: { hoso: 1.0, pd: 2.0, vap: 3.2 }, mechanized: { hoso: 1.0, pd: 1.2, vap: 2.6 } },
];

export function paramsFor(variantId: string): ProductionParameters {
  const v = SENSITIVITY_VARIANTS.find((x) => x.id === variantId)!;
  return {
    ...PRODUCTION_PARAMETERS_V1,
    labor: { ...PRODUCTION_PARAMETERS_V1.labor, laborIntensityCoefficient: v.base, mechanizedLaborIntensityCoefficient: v.mechanized },
  };
}

/**
 * 【理論回収期間】需要・営業・原料・稼働率がすべて十分な理想条件での回収四半期数。
 * 実際のシミュレーション結果ではなく、係数と単価だけから決まる上限効果で計算する
 * （実装指示の目安 4〜8四半期に対する評価のため）。
 */
export function theoreticalPaybackQuarters(pdRelatedRegularHeadcount: number, variantId = "main"): number {
  const p = paramsFor(variantId);
  const reduction = 1 - p.labor.mechanizedLaborIntensityCoefficient.pd / p.labor.laborIntensityCoefficient.pd;
  const savingPerQuarter = pdRelatedRegularHeadcount * reduction * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter;
  if (!(savingPerQuarter > 0)) return Infinity;
  return CAPEX_PARAMETERS_V1.templatesByType.pdMechanization.standardBudgetUsd / savingPerQuarter;
}

const CSV_COLUMNS: readonly (keyof QuarterRow)[] = [
  "caseId", "seed", "companyId", "quarter", "mechanizationLevel",
  "producedHoso", "producedPd", "producedVap", "contractedTons", "finishedGoodsTons",
  "requiredLaborHoso", "requiredLaborPd", "requiredLaborVap", "requiredLaborTotal",
  "regularHeadcount", "temporaryHeadcount", "overtimeRate", "surplusRegularHeadcount", "laborShortfallTons",
  "regularLaborCostUsd", "temporaryLaborCostUsd", "investmentUsd",
  "operatingProfitUsd", "netIncomeUsd", "operatingCashFlowUsd", "cashUsd", "debtUsd",
];

export function toCsv(rows: readonly QuarterRow[]): string {
  return `${CSV_COLUMNS.join(",")}\n${rows.map((r) => CSV_COLUMNS.map((c) => String(r[c])).join(",")).join("\n")}\n`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

if (process.argv[1] && process.argv[1].endsWith("pdMechanizationComparison.ts")) {
  if (process.argv.includes("--sensitivity")) {
    console.log("=== 感度分析: 係数設定ごとの理論効果（コード編集なしで差し替え）===");
    console.log("設定         | PD係数(前→後) | PD削減率 | 同一労働の増産倍率 | VAP削減率 | 理論回収(PD要員1000人) | 理論回収(2000人)");
    console.log("-------------|---------------|----------|--------------------|-----------|------------------------|------------------");
    for (const v of SENSITIVITY_VARIANTS) {
      const pdReduction = 1 - v.mechanized.pd / v.base.pd;
      const outputMultiple = v.base.pd / v.mechanized.pd;
      const vapReduction = 1 - v.mechanized.vap / v.base.vap;
      console.log(
        `${v.label.padEnd(12)} | ${String(v.base.pd).padStart(5)} → ${String(v.mechanized.pd).padEnd(5)} | ` +
          `${(pdReduction * 100).toFixed(1).padStart(7)}% | ${outputMultiple.toFixed(3).padStart(18)} | ` +
          `${(vapReduction * 100).toFixed(1).padStart(8)}% | ${theoreticalPaybackQuarters(1000, v.id).toFixed(1).padStart(22)} | ${theoreticalPaybackQuarters(2000, v.id).toFixed(1).padStart(16)}`
      );
    }
    console.log(`\n投資額: ${fmt(CAPEX_PARAMETERS_V1.templatesByType.pdMechanization.standardBudgetUsd)} USD（変更していない）`);
    console.log(`常用給与: ${fmt(FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter)} USD/人・四半期（変更していない）`);
  } else {
    const allRows: QuarterRow[] = [];
    const summaries: CaseSummary[] = [];
    for (const profile of CASE_PROFILES) {
      for (const seed of SEEDS) {
        const rows = runCase(profile, seed);
        allRows.push(...rows);
        summaries.push(summarize(rows));
      }
    }

    console.log(`=== PD省人化 5ケース比較（baseline・${HORIZON_QUARTERS}四半期・5社・${SEEDS.length}シード平均）===\n`);
    console.log("ケース              | PD生産(t)  | 契約(t)    | 期末在庫(t) | 投資額        | 累積純利益       | 期末現金");
    console.log("--------------------|------------|------------|-------------|---------------|------------------|----------------");
    for (const profile of CASE_PROFILES) {
      const subset = summaries.filter((s) => s.caseId === profile.id);
      const avg = (pick: (s: CaseSummary) => number) => subset.reduce((sum, s) => sum + pick(s), 0) / subset.length;
      console.log(
        `${profile.id.padEnd(19)} | ${fmt(avg((s) => s.producedPd)).padStart(10)} | ${fmt(avg((s) => s.contractedTons)).padStart(10)} | ` +
          `${fmt(avg((s) => s.finalFinishedGoodsTons)).padStart(11)} | ${fmt(avg((s) => s.investmentUsd)).padStart(13)} | ` +
          `${fmt(avg((s) => s.cumulativeNetIncomeUsd)).padStart(16)} | ${fmt(avg((s) => s.finalCashUsd)).padStart(14)}`
      );
    }

    console.log("\n=== 【理論効果】と【PL/CFに実際に現れた効果】の分離 ===");
    console.log("ケース              | 理論削減労働(人Q) | 理論削減額(USD) | 常用余剰(人Q) | 臨時人件費(USD) | 常用人件費(USD) | 実現した効果の見立て");
    console.log("--------------------|-------------------|-----------------|---------------|-----------------|-----------------|----------------------");
    for (const profile of CASE_PROFILES) {
      const subset = summaries.filter((s) => s.caseId === profile.id);
      const avg = (pick: (s: CaseSummary) => number) => subset.reduce((sum, s) => sum + pick(s), 0) / subset.length;
      const theoretical = avg((s) => s.theoreticalLaborSavingUsd);
      const surplus = avg((s) => s.surplusRegularHeadQuarters);
      const verdict =
        theoretical <= 0
          ? "機械化なし"
          : surplus > 0
          ? "余剰人員として滞留（PLには現れない）"
          : "減員・臨時削減として現れた";
      console.log(
        `${profile.id.padEnd(19)} | ${fmt(avg((s) => s.theoreticalLaborSavedHeadQuarters)).padStart(17)} | ${fmt(theoretical).padStart(15)} | ` +
          `${fmt(surplus).padStart(13)} | ${fmt(avg((s) => s.temporaryLaborCostUsd)).padStart(15)} | ${fmt(avg((s) => s.regularLaborCostUsd)).padStart(15)} | ${verdict}`
      );
    }

    const byId = (id: CaseId) => {
      const subset = summaries.filter((s) => s.caseId === id);
      return subset.reduce((sum, s) => sum + s.cumulativeNetIncomeUsd, 0) / subset.length;
    };
    console.log("\n=== ケース間の差（累積純利益、シード平均）===");
    console.log(`C（PD中心・適時省人化） − B（PD中心・省人化なし） = ${fmt(byId("C-pd-mech") - byId("B-pd-no-mech"))}`);
    console.log(`D（PD+VAP・適時省人化） − B                       = ${fmt(byId("D-pdvap-mech") - byId("B-pd-no-mech"))}`);
    console.log(`E（販売見込み無しで省人化） − B                    = ${fmt(byId("E-mech-no-sales") - byId("B-pd-no-mech"))}`);
    console.log(`B（PD中心） − A（HOSO中心）                        = ${fmt(byId("B-pd-no-mech") - byId("A-hoso-no-mech"))}`);

    if (process.argv.includes("--write")) {
      const outDir = join(process.cwd(), "artifacts", "pd-mechanization");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "pd-mechanization-comparison.csv"), toCsv(allRows), "utf8");
      writeFileSync(join(outDir, "pd-mechanization-summary.json"), JSON.stringify({ summaries, caseProfiles: CASE_PROFILES }, null, 2), "utf8");
      console.log(`\n出力: ${outDir}`);
    }
  }
}
