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
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
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

export type CaseId =
  | "A-hoso-no-mech"
  | "B-pd-no-mech"
  | "C-pd-mech"
  | "D-pdvap-mech"
  | "E1-no-sales-ai-declines"
  | "E2-no-sales-forced-mech"
  | "E2c-no-sales-control"
  | "E3-produced-not-sold"
  | "E3c-produced-not-sold-control";

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
  /**
   * 【分析専用】Standard AIのゲート判断に関わらず省人化を強制投入するか。
   *
   * 【重要】強制はこの分析スクリプトの中だけで行う。ゲートの実装
   * （standardAi/decision/marketEvolutionInvestment.ts の8条件）には一切手を触れない。
   * 資金条件で却下されることも避けるため、対象会社へ分析用の現金を付与する
   * （付与額は forcedMechanizationCashGrantUsd）。
   */
  readonly forceMechanization?: boolean;
  /**
   * 【分析専用】この会社へ初期時点で付与する診断用の現金。
   * 強制投入ケースが資金条件で却下されるのを避けるために使う。
   * **対照ケースにも同額を付与しないと比較が成立しない**（現金付与そのものが
   * 支払利息・緊急借入を通じて損益へ効いてしまうため）。
   */
  readonly analysisCashGrantUsd?: number;
  /**
   * 【分析専用】生産計画を販売計画とは独立にこの倍率で拡大する。
   * 「増えた能力を実際に使って作ったが、売れなかった」状況を作るために使う
   * （省略時は1.0＝AIが出した生産計画のまま）。
   */
  readonly productionMultiplier?: number;
}

/**
 * 【分析専用】強制投入ケースで、資金条件による却下を避けるために付与する現金。
 * これは「販売見込みが無いのに省人化した場合どうなるか」を観測するための
 * 診断用の措置であり、ゲームのパラメータではない。
 */
export const FORCED_MECHANIZATION_CASH_GRANT_USD = 500_000_000;

/**
 * 【ケース設計】turnそのものに意味があるのではなく、「稼働率が上がってから
 * 省人化する（C・D）」と「販売見込みが無いまま省人化する（E）」の対比が本質。
 * Cの turn8 は、この設定でPD稼働率が立ち上がったあとの時期として選んだ**候補の一つ**であり、
 * 「最適な実施時期」ではない。実測では turn8〜12 が有効な実施レンジで、
 * 測定した候補の中では turn12 の累積効果が最も大きかった。最適点は将来需要・
 * 労働制約・現金余力・評価期間の取り方で移動する。
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
    // 【E1】販売見込みが無い戦略のまま、省人化を**Standard AIの判断に委ねる**ケース。
    // ゲートを一切迂回しない。実際にAIが提案しなければ投資は起きない。
    id: "E1-no-sales-ai-declines",
    label: "E1: 販売見込み無し・AI判断に委ねる",
    productionPriority: { hoso: 3, pd: 1, vap: 2 },
    mechanizationTurn: null,
    salesHirePerQuarter: 0,
    salesMultiplier: { hoso: 0.4, pd: 0.5, vap: 0.3 },
  },
  {
    // 【E2】同じ戦略で、分析目的にのみ省人化を**強制投入**するケース。
    // 強制はこの分析スクリプトの中だけで行い、ゲートの実装には手を触れない。
    // E1との差が「能力だけ上げて販売が伴わないときの悪化」を表す。
    id: "E2-no-sales-forced-mech",
    label: "E2: 販売見込み無し・省人化を強制投入",
    productionPriority: { hoso: 3, pd: 1, vap: 2 },
    mechanizationTurn: 8,
    salesHirePerQuarter: 0,
    salesMultiplier: { hoso: 0.4, pd: 0.5, vap: 0.3 },
    forceMechanization: true,
    analysisCashGrantUsd: FORCED_MECHANIZATION_CASH_GRANT_USD,
  },
  {
    // 【E2対照】E2とまったく同じ条件（同じ現金付与を含む）で、省人化だけを行わない。
    // E2 と E2対照 の差が「能力だけ上げて販売が伴わないときの悪化」そのものになる。
    id: "E2c-no-sales-control",
    label: "E2対照: 販売見込み無し・省人化なし（同額の現金付与あり）",
    productionPriority: { hoso: 3, pd: 1, vap: 2 },
    mechanizationTurn: null,
    salesHirePerQuarter: 0,
    salesMultiplier: { hoso: 0.4, pd: 0.5, vap: 0.3 },
    analysisCashGrantUsd: FORCED_MECHANIZATION_CASH_GRANT_USD,
  },
  {
    // 【E3】増えた能力を実際に使って作るが、販売は伸ばさないケース。
    // 「能力が上がったのに販売が伴わない」状況そのもの。
    id: "E3-produced-not-sold",
    label: "E3: 省人化＋能力を使って増産・販売は伸ばさない",
    productionPriority: { hoso: 3, pd: 1, vap: 2 },
    mechanizationTurn: 8,
    salesHirePerQuarter: 0,
    salesMultiplier: { hoso: 0.4, pd: 0.5, vap: 0.3 },
    forceMechanization: true,
    analysisCashGrantUsd: FORCED_MECHANIZATION_CASH_GRANT_USD,
    productionMultiplier: 2.5,
  },
  {
    // 【E3対照】E3とまったく同じ増産を行うが、省人化はしない。
    id: "E3c-produced-not-sold-control",
    label: "E3対照: 増産のみ・省人化なし（同額の現金付与あり）",
    productionPriority: { hoso: 3, pd: 1, vap: 2 },
    mechanizationTurn: null,
    salesHirePerQuarter: 0,
    salesMultiplier: { hoso: 0.4, pd: 0.5, vap: 0.3 },
    analysisCashGrantUsd: FORCED_MECHANIZATION_CASH_GRANT_USD,
    productionMultiplier: 2.5,
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
  /** Standard AI が自らこの四半期に省人化を提案したか（ケースEの解釈に使う）。 */
  readonly selfProposedMechanization: boolean;
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
  /** 残業費 = 常用人数 × 給与 × 残業率 × 残業割増係数（finance/parameters.tsの単価をそのまま使う）。 */
  readonly overtimeLaborCostUsd: number;
  readonly totalLaborCostUsd: number;
  readonly investmentUsd: number;
  readonly operatingProfitUsd: number;
  readonly netIncomeUsd: number;
  readonly operatingCashFlowUsd: number;
  readonly cashUsd: number;
  readonly debtUsd: number;
}

/**
 * 意思決定の生成方式。
 *  autoPolicy  … 常用人員の減員判断を**持たない**（省人化の効果がPLへ出ない）
 *  standardAi  … decision/labor.ts の sustainedExcess 経路で減員判断を持つ
 * この2つの比較そのものが、本ラウンドの中心的な検証項目である。
 */
export type DecisionMode = "autoPolicy" | "standardAi";

export function runCase(
  profile: CaseProfile,
  seed: string,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1,
  decisionMode: DecisionMode = "autoPolicy"
): readonly QuarterRow[] {
  const config = labConfig(seed);
  const { state: initialState, fixtures } = initializeCompanyLab(config);
  // 【分析専用】強制投入ケースでは、資金条件による却下で「投資が起きなかった」
  // 状態になってしまうと比較そのものが成立しないため、診断用の現金を付与する。
  const grant = profile.analysisCashGrantUsd ?? 0;
  let state = grant > 0
    ? {
        ...initialState,
        financeState: {
          ...initialState.financeState,
          companies: initialState.financeState.companies.map((c) => ({
            ...c,
            cash: ((c.cash as unknown as number) + grant) as typeof c.cash,
          })),
        },
      }
    : initialState;
  const rows: QuarterRow[] = [];
  const selfProposedMechanizationTurns = new Set<string>();

  for (let i = 0; i < HORIZON_QUARTERS; i += 1) {
    if (state.isComplete) break;
    const turn = state.scenarioState.currentTurn;
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<CompanyId, CompanyDecisionInput> = {};

    for (const fixture of fixtures) {
      const ownState = buildCompanyOwnState(state, fixture);
      let decision =
        decisionMode === "standardAi"
          ? generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, turn).decision
          : generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, turn);
      // 【重要】Standard AI が自ら省人化を提案した四半期を記録する（ケースEが
      // 「ゲートを通ったのか、強制的に押し込んだのか」を報告で区別するため）。
      if (decisionMode === "standardAi" && decision.capexDecision.newProjectProposals.some((p) => p.projectType === "pdMechanization")) {
        selfProposedMechanizationTurns.add(`${fixture.companyId}@${turn}`);
      }

      // 商品志向（販売計画・生産優先度）。
      decision = {
        ...decision,
        salesPlans: decision.salesPlans.map((p) => ({
          ...p,
          desiredQuantity: ((p.desiredQuantity as unknown as number) * profile.salesMultiplier[p.product]) as typeof p.desiredQuantity,
        })),
        productionPlans: decision.productionPlans.map((p) => ({
          ...p,
          priority: profile.productionPriority[p.product],
          ...(profile.productionMultiplier && profile.productionMultiplier !== 1
            ? { desiredQuantity: ((p.desiredQuantity as unknown as number) * profile.productionMultiplier) as typeof p.desiredQuantity }
            : {}),
        })),
      };
      if (profile.salesHirePerQuarter > 0) {
        decision = { ...decision, salesForceHireCount: profile.salesHirePerQuarter };
      }
      if (profile.mechanizationTurn !== null && turn === profile.mechanizationTurn) {
        const targetFactoryId = fixture.factories[0]?.factoryId;
        const alreadyProposed = decision.capexDecision.newProjectProposals.some((p) => p.projectType === "pdMechanization");
        if (targetFactoryId && !alreadyProposed) {
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
        selfProposedMechanization: selfProposedMechanizationTurns.has(`${fixture.companyId}@${turn}`),
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
        overtimeLaborCostUsd:
          regularHeadcount * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter * overtime * FINANCE_PARAMETERS_V1.labor.overtimePremiumFactor,
        totalLaborCostUsd:
          regularHeadcount * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter +
          temporaryHeadcount * FINANCE_PARAMETERS_V1.labor.temporaryWorkerCostUsdPerQuarter +
          regularHeadcount * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter * overtime * FINANCE_PARAMETERS_V1.labor.overtimePremiumFactor,
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
  readonly overtimeLaborCostUsd: number;
  readonly totalLaborCostUsd: number;
  /** 常用の余剰人員（人・四半期）。ここが大きいほど理論効果が実現していない。 */
  readonly surplusRegularHeadQuarters: number;
  /** 期末の常用人員（減員が実際に起きたかを見る）。 */
  readonly finalRegularHeadcount: number;
  /** Standard AI が自ら省人化を提案した会社×四半期の件数。 */
  readonly selfProposedMechanizationCount: number;
  /**
   * 投資キャッシュアウトの合計。**PD省人化以外のcapex（工場増設等）も含む**ので、
   * 「省人化投資が起きたか」の判定にこの値を使ってはならない（E3対照では省人化を
   * していないのに 22,000,000 が立つ）。省人化の実行有無は maxMechanizationLevel で見る。
   */
  readonly investmentUsd: number;
  /** 期間中に到達した機械化レベルの最大値（0=一度も省人化していない）。 */
  readonly maxMechanizationLevel: number;
  /** 最終四半期の機械化レベル（会社合計ではなく最大値）。 */
  readonly finalMechanizationLevel: number;
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
    overtimeLaborCostUsd: sum((r) => r.overtimeLaborCostUsd),
    totalLaborCostUsd: sum((r) => r.totalLaborCostUsd),
    surplusRegularHeadQuarters: sum((r) => r.surplusRegularHeadcount),
    finalRegularHeadcount: lastRows.reduce((s, r) => s + r.regularHeadcount, 0),
    selfProposedMechanizationCount: rows.filter((r) => r.selfProposedMechanization).length,
    investmentUsd: sum((r) => r.investmentUsd),
    maxMechanizationLevel: rows.reduce((m, r) => Math.max(m, r.mechanizationLevel), 0),
    finalMechanizationLevel: lastRows.reduce((m, r) => Math.max(m, r.mechanizationLevel), 0),
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
  "caseId", "seed", "companyId", "quarter", "mechanizationLevel", "selfProposedMechanization",
  "producedHoso", "producedPd", "producedVap", "contractedTons", "finishedGoodsTons",
  "requiredLaborHoso", "requiredLaborPd", "requiredLaborVap", "requiredLaborTotal",
  "regularHeadcount", "temporaryHeadcount", "overtimeRate", "surplusRegularHeadcount", "laborShortfallTons",
  "regularLaborCostUsd", "temporaryLaborCostUsd", "overtimeLaborCostUsd", "totalLaborCostUsd", "investmentUsd",
  "operatingProfitUsd", "netIncomeUsd", "operatingCashFlowUsd", "cashUsd", "debtUsd",
];

export function toCsv(rows: readonly QuarterRow[]): string {
  return `${CSV_COLUMNS.join(",")}\n${rows.map((r) => CSV_COLUMNS.map((c) => String(r[c])).join(",")).join("\n")}\n`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * 【本ラウンドの中心】Standard AI（減員判断あり）で5ケースを走らせ、
 * 理論削減額のうち**実際にPLへ現れた額**を、機械化なしケースとの人件費差として測る。
 */
export function runStandardAiComparison(): {
  readonly summaries: readonly CaseSummary[];
  readonly rows: readonly QuarterRow[];
} {
  const rows: QuarterRow[] = [];
  const summaries: CaseSummary[] = [];
  for (const profile of CASE_PROFILES) {
    for (const seed of SEEDS) {
      const caseRows = runCase(profile, seed, PRODUCTION_PARAMETERS_V1, "standardAi");
      rows.push(...caseRows);
      summaries.push(summarize(caseRows));
    }
  }
  return { summaries, rows };
}

/**
 * 【有利局面 vs 回収期間の実証（§b）】
 *
 * 市場進化により、PDプレミアム比率は序盤〜中盤に高原を作り、他産地の加工参入で
 * turn16前後から圧縮に入る（docs/v2/design/processed_market_evolution_audit.md §a）。
 * そこで同じPD中心プロファイルに対して、省人化の実施時期だけを変えて比較する。
 *
 *   early … turn4  : 圧縮が始まる前。回収に使える有利局面が十分に長い。
 *   late  … turn16 : 圧縮が始まったあと。回収前に有利局面が終わる。
 *
 * 「有利局面中の収益性」と「有利局面後の収益性」を別々に集計して報告する。
 */
export const FAVORABLE_WINDOW_END_TURN = 16;

export function runWindowComparison(): readonly {
  readonly timing: string;
  readonly mechanizationTurn: number | null;
  readonly duringWindowNetIncomeUsd: number;
  readonly afterWindowNetIncomeUsd: number;
  readonly cumulativeNetIncomeUsd: number;
  readonly investmentUsd: number;
  readonly realizedLaborSavingUsd: number;
  readonly finalCashUsd: number;
}[] {
  const baseProfile = CASE_PROFILES.find((p) => p.id === "B-pd-no-mech")!;
  // 有利局面（〜turn16）に対する実施時期を掃引する。turn4は「早すぎる」
  // （PD稼働率がまだ立ち上がっておらず機械化レベルが上がらない）、
  // turn16は「遅すぎる」（回収に使える四半期が残っていない）ことを見るため。
  const variants: { timing: string; turn: number | null }[] = [
    { timing: "none", turn: null },
    { timing: "t4-tooEarly", turn: 4 },
    { timing: "t8-effective", turn: 8 },
    { timing: "t12-lateish", turn: 12 },
    { timing: "t16-tooLate", turn: 16 },
  ];
  const baselineLaborBySeed = new Map<string, number>();
  const out: {
    timing: string;
    mechanizationTurn: number | null;
    duringWindowNetIncomeUsd: number;
    afterWindowNetIncomeUsd: number;
    cumulativeNetIncomeUsd: number;
    investmentUsd: number;
    realizedLaborSavingUsd: number;
    finalCashUsd: number;
  }[] = [];

  for (const v of variants) {
    let during = 0;
    let after = 0;
    let cumulative = 0;
    let investment = 0;
    let labor = 0;
    let finalCash = 0;
    for (const seed of SEEDS) {
      const rows = runCase({ ...baseProfile, id: "C-pd-mech", mechanizationTurn: v.turn }, seed, PRODUCTION_PARAMETERS_V1, "standardAi");
      const lastQuarter = Math.max(...rows.map((r) => r.quarter));
      during += rows.filter((r) => r.quarter <= FAVORABLE_WINDOW_END_TURN).reduce((s, r) => s + r.netIncomeUsd, 0);
      after += rows.filter((r) => r.quarter > FAVORABLE_WINDOW_END_TURN).reduce((s, r) => s + r.netIncomeUsd, 0);
      cumulative += rows.reduce((s, r) => s + r.netIncomeUsd, 0);
      investment += rows.reduce((s, r) => s + r.investmentUsd, 0);
      const totalLabor = rows.reduce((s, r) => s + r.totalLaborCostUsd, 0);
      labor += totalLabor;
      if (v.timing === "none") baselineLaborBySeed.set(seed, totalLabor);
      finalCash += rows.filter((r) => r.quarter === lastQuarter).reduce((s, r) => s + r.cashUsd, 0);
    }
    const n = SEEDS.length;
    const baselineLabor = Array.from(baselineLaborBySeed.values()).reduce((a, b) => a + b, 0);
    out.push({
      timing: v.timing,
      mechanizationTurn: v.turn,
      duringWindowNetIncomeUsd: during / n,
      afterWindowNetIncomeUsd: after / n,
      cumulativeNetIncomeUsd: cumulative / n,
      investmentUsd: investment / n,
      realizedLaborSavingUsd: v.timing === "none" ? 0 : (baselineLabor - labor) / n,
      finalCashUsd: finalCash / n,
    });
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("pdMechanizationComparison.ts")) {
  if (process.argv.includes("--window")) {
    console.log(`=== 有利局面 vs 回収期間（Standard AI・${HORIZON_QUARTERS}四半期・5社・${SEEDS.length}シード平均）===`);
    console.log(`有利局面の終わり = turn${FAVORABLE_WINDOW_END_TURN}（他産地のPD加工参入によりPDプレミアム比率が圧縮に入る時期）\n`);
    console.log("実施時期    | 省人化turn | 有利局面中の純利益 | 有利局面後の純利益 | 累積純利益       | 投資額      | 実現人件費削減 | 期末現金");
    console.log("------------|------------|--------------------|--------------------|------------------|-------------|----------------|---------------");
    for (const r of runWindowComparison()) {
      console.log(
        `${r.timing.padEnd(11)} | ${String(r.mechanizationTurn ?? "－").padStart(10)} | ${fmt(r.duringWindowNetIncomeUsd).padStart(18)} | ` +
          `${fmt(r.afterWindowNetIncomeUsd).padStart(18)} | ${fmt(r.cumulativeNetIncomeUsd).padStart(16)} | ${fmt(r.investmentUsd).padStart(11)} | ` +
          `${fmt(r.realizedLaborSavingUsd).padStart(14)} | ${fmt(r.finalCashUsd).padStart(13)}`
      );
    }
  } else if (process.argv.includes("--standard-ai")) {
    const { summaries, rows } = runStandardAiComparison();
    const avgOf = (id: CaseId, pick: (s: CaseSummary) => number) => {
      const subset = summaries.filter((s) => s.caseId === id);
      return subset.reduce((sum, s) => sum + pick(s), 0) / subset.length;
    };

    console.log(`=== Standard AI（減員判断あり）による5ケース比較（${HORIZON_QUARTERS}四半期・5社・${SEEDS.length}シード平均）===\n`);
    console.log("ケース              | PD生産(t)  | 契約(t)    | 期末在庫(t) | 投資額        | 累積純利益       | 期末現金");
    console.log("--------------------|------------|------------|-------------|---------------|------------------|----------------");
    for (const p of CASE_PROFILES) {
      console.log(
        `${p.id.padEnd(19)} | ${fmt(avgOf(p.id, (s) => s.producedPd)).padStart(10)} | ${fmt(avgOf(p.id, (s) => s.contractedTons)).padStart(10)} | ` +
          `${fmt(avgOf(p.id, (s) => s.finalFinishedGoodsTons)).padStart(11)} | ${fmt(avgOf(p.id, (s) => s.investmentUsd)).padStart(13)} | ` +
          `${fmt(avgOf(p.id, (s) => s.cumulativeNetIncomeUsd)).padStart(16)} | ${fmt(avgOf(p.id, (s) => s.finalCashUsd)).padStart(14)}`
      );
    }

    // 【三宅さん指示A-1】強制投入ケースは「投資が実際に起きたこと」を非ゼロで確認する。
    // 資金条件で却下されて投資額0のまま比較していたら、その比較は成立しない。
    console.log("\n=== 省人化が実際に起きたかの確認（機械化レベル）===");
    console.log("【注】投資キャッシュアウトには工場増設等の他のcapexも混ざるため、判定には機械化レベルを使う。");
    console.log("ケース                         | 最大機械化Lv | 期末機械化Lv | 総投資CF(USD) | 強制投入 | 判定");
    console.log("-------------------------------|--------------|--------------|---------------|----------|------");
    for (const p of CASE_PROFILES) {
      const maxLv = avgOf(p.id, (s) => s.maxMechanizationLevel);
      const finLv = avgOf(p.id, (s) => s.finalMechanizationLevel);
      const inv = avgOf(p.id, (s) => s.investmentUsd);
      // 【注】C・Dもスクリプトが省人化提案を注入している（AIの自発提案ではない）。
      // 違いは「AIが受け入れられる状況で注入したか（C・D）」と
      // 「販売見込みが無い状況へ分析目的で強制したか（E2・E3）」であり、
      // どちらもゲート実装そのものには手を触れていない。
      const injected = p.mechanizationTurn !== null;
      const verdict = injected
        ? maxLv > 0
          ? p.forceMechanization
            ? "○ 強制投入が成立"
            : "○ スクリプト注入が成立"
          : "× 投入されていない（比較不成立）"
        : maxLv > 0
          ? "！ 想定外（注入なしで機械化）"
          : "省人化なし";
      console.log(
        `${p.id.padEnd(30)} | ${maxLv.toFixed(3).padStart(12)} | ${finLv.toFixed(3).padStart(12)} | ${fmt(inv).padStart(13)} | ` +
          `${(p.forceMechanization ? "はい" : "いいえ").padStart(8)} | ${verdict}`
      );
      // 【三宅さん指示A-1】強制投入ケースは投資が実際に起きたことを非ゼロで確認する。
      // 資金条件で却下されて省人化していないまま比較していたら、その比較は成立しない。
      if (injected && !(maxLv > 0)) {
        throw new Error(`注入ケース ${p.id} で省人化が実行されていない（機械化レベル0）。現金付与額または投入turnを見直す必要がある。`);
      }
      if (!injected && maxLv > 0) {
        throw new Error(`省人化なしのはずの ${p.id} で機械化レベルが立っている（${maxLv}）。対照が汚染されている。`);
      }
    }

    console.log("\n=== 【理論効果】と【実際にPLへ現れた効果】の分離 ===");
    console.log("基準は B（PD中心・省人化なし）。人件費の差＝実際に現れた削減額。");
    console.log("ケース              | 理論削減額(USD) | 常用人件費差(USD) | 臨時人件費差(USD) | 残業費差(USD) | 人件費合計差(USD) | 実現率 | 期末常用人員");
    console.log("--------------------|-----------------|-------------------|-------------------|---------------|-------------------|--------|-------------");
    const baseRegular = avgOf("B-pd-no-mech", (s) => s.regularLaborCostUsd);
    const baseTemp = avgOf("B-pd-no-mech", (s) => s.temporaryLaborCostUsd);
    const baseOt = avgOf("B-pd-no-mech", (s) => s.overtimeLaborCostUsd);
    const baseTotal = avgOf("B-pd-no-mech", (s) => s.totalLaborCostUsd);
    for (const p of CASE_PROFILES) {
      const theoretical = avgOf(p.id, (s) => s.theoreticalLaborSavingUsd);
      const dRegular = baseRegular - avgOf(p.id, (s) => s.regularLaborCostUsd);
      const dTemp = baseTemp - avgOf(p.id, (s) => s.temporaryLaborCostUsd);
      const dOt = baseOt - avgOf(p.id, (s) => s.overtimeLaborCostUsd);
      const dTotal = baseTotal - avgOf(p.id, (s) => s.totalLaborCostUsd);
      const realizationRate = theoretical > 0 ? `${((dTotal / theoretical) * 100).toFixed(0)}%` : "－";
      console.log(
        `${p.id.padEnd(19)} | ${fmt(theoretical).padStart(15)} | ${fmt(dRegular).padStart(17)} | ${fmt(dTemp).padStart(17)} | ` +
          `${fmt(dOt).padStart(13)} | ${fmt(dTotal).padStart(17)} | ${realizationRate.padStart(6)} | ${fmt(avgOf(p.id, (s) => s.finalRegularHeadcount)).padStart(11)}`
      );
    }

    console.log("\n=== ケース間の差（累積純利益、シード平均）===");
    const ni = (id: CaseId) => avgOf(id, (s) => s.cumulativeNetIncomeUsd);
    console.log(`C（PD中心・適時省人化） − B（PD中心・省人化なし） = ${fmt(ni("C-pd-mech") - ni("B-pd-no-mech"))}`);
    console.log(`D（PD+VAP・適時省人化） − B                       = ${fmt(ni("D-pdvap-mech") - ni("B-pd-no-mech"))}`);
    console.log(`E1（販売見込み無し・AI判断） − B                  = ${fmt(ni("E1-no-sales-ai-declines") - ni("B-pd-no-mech"))}`);
    console.log(`E2（省人化を強制投入） − E2対照（同条件・省人化なし） = ${fmt(ni("E2-no-sales-forced-mech") - ni("E2c-no-sales-control"))}`);
    console.log(`E3（増産して売れない） − B（PD中心・省人化なし）      = ${fmt(ni("E3-produced-not-sold") - ni("B-pd-no-mech"))}`);
    console.log(`E3（増産して売れない） − E3対照（同増産・省人化なし） = ${fmt(ni("E3-produced-not-sold") - ni("E3c-produced-not-sold-control"))}`);
    console.log(`B（PD中心） − A（HOSO中心）                        = ${fmt(ni("B-pd-no-mech") - ni("A-hoso-no-mech"))}`);

    console.log("\n=== 実現回収期間（人件費合計差ベース） ===");
    for (const p of CASE_PROFILES) {
      if (p.mechanizationTurn === null) continue;
      const investment = avgOf(p.id, (s) => s.investmentUsd);
      const dTotal = baseTotal - avgOf(p.id, (s) => s.totalLaborCostUsd);
      const quartersWithEffect = HORIZON_QUARTERS - p.mechanizationTurn;
      const perQuarter = quartersWithEffect > 0 ? dTotal / quartersWithEffect : 0;
      const payback = perQuarter > 0 ? investment / perQuarter : Infinity;
      console.log(
        `${p.id.padEnd(19)}: 投資${fmt(investment)} / 実現削減${fmt(perQuarter)}per四半期 → 実現回収 ` +
          (Number.isFinite(payback) ? `${payback.toFixed(1)}四半期` : "回収不能（削減が現れていない）")
      );
    }

    console.log("\n=== Standard AI が自ら省人化を提案した件数（会社×四半期）===");
    for (const p of CASE_PROFILES) {
      console.log(`${p.id.padEnd(19)}: ${avgOf(p.id, (s) => s.selfProposedMechanizationCount).toFixed(1)} 件`);
    }
    if (process.argv.includes("--write")) {
      const outDir = join(process.cwd(), "artifacts", "pd-mechanization");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "pd-mechanization-standard-ai.csv"), toCsv(rows), "utf8");
      writeFileSync(join(outDir, "pd-mechanization-standard-ai-summary.json"), JSON.stringify({ summaries }, null, 2), "utf8");
      console.log(`\n出力: ${outDir}`);
    }
  } else if (process.argv.includes("--sensitivity")) {
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
    console.log(`E1（販売見込み無し・AI判断） − B                  = ${fmt(byId("E1-no-sales-ai-declines") - byId("B-pd-no-mech"))}`);
    console.log(`E2（省人化を強制投入） − E2対照（同条件・省人化なし） = ${fmt(byId("E2-no-sales-forced-mech") - byId("E2c-no-sales-control"))}`);
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
