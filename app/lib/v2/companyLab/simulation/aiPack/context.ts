// ShrimpX V2 — AI Analysis Pack: AI Context JSON の組み立て
//
// 【生成AIを一切呼ばない】この関数は完全に決定論的な記録出力である。
// 分析は、出来上がった Pack を人間が ChatGPT / Claude へ渡した後に行う。
//
// 【再計算しない】値はすべて、保存済み Simulation Run（確定実績から作った
// analytics dataset と、実行中に拾った pack capture）から取り出すだけ。
// Analysis 画面の AI Trace と同じ記録を読むため、画面と Pack が食い違わない。
//
// 【捏造しない】存在しないものは availability で明示する。

import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../../market/types";
import { CAPITAL_PROJECT_TYPES } from "../../../capex/types";
import { STANDARD_AI_PROPOSABLE_CAPEX_TYPES } from "../../standardAi/decision/capex";
import { SimulationAnalyticsDataset } from "../analytics/types";
import { StoredSimulationRun } from "../persistence/types";
import { buildMajorChanges } from "./changeLog";
import {
  AI_ANALYSIS_PACK_SCHEMA_VERSION,
  AiAnalysisPackContext,
  PackCompanyStateSnapshot,
  PackStrategy,
  PackCompanySummary,
  PackCompanyTurn,
  PackDataAvailabilityNote,
  PackProductEconomics,
  PackSourceType,
  PackTraceItem,
} from "./types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

const EMPTY_STATE: PackCompanyStateSnapshot = {
  cashUsd: null,
  debtUsd: null,
  equityUsd: null,
  salesHeadcount: null,
  rawMaterialInventoryTons: null,
  finishedGoodsInventoryTons: null,
  backlogTons: null,
  factoryCount: null,
  capacityTonsByProduct: { hoso: null, pd: null, vap: null },
  commonProcessingCapacityTons: null,
  factorySpaceTotalUnits: null,
  factorySpaceUsedUnits: null,
  factorySpaceRemainingUnits: null,
};

/** Vision 導入より前に保存された Simulation Run 用（架空の Vision を作らない）。 */
const EMPTY_STRATEGY: PackStrategy = {
  vision: null,
  visionTargetScaleAtCurrentTurn: null,
  currentSustainableScaleTons: null,
  strategicScaleGapTons: null,
  strategicScaleGapRatio: null,
  growthPressure: null,
  newFactory: null,
  availability: "NOT_RECORDED",
};

/** ChatGPT / Claude へ「このPackの読み方」を伝える定型文（生成文ではない）。 */
export const PACK_READING_GUIDE: readonly string[] = [
  "This package contains one complete recorded simulation run of ShrimpX, a quarterly shrimp-processing management simulation (5 AI-operated companies, up to 32 quarters = 8 years).",
  "Analyze ONLY the information recorded in this package. Do not assume missing information.",
  "Keep these layers strictly separate: (1) trueWorld = what actually happened, (2) standardAiObservable = what the Standard AI could actually see (market demand is lagged by 2 quarters), (3) diagnosis = how the AI interpreted it, (4) wanted = what it wanted to do before constraints, (5) constraints = what stopped it, (6) decision = what it actually submitted, (7) execution + financialResult = what happened as a result, (8) endingState.",
  "A decision that looks wrong with hindsight may have been reasonable given standardAiObservable at that turn. Judge decisions against the observable layer, not the true world.",
  "Fields with a null value mean the value was not recorded; see dataAvailability for concepts that do not exist in the engine at all.",
  "Only completed turns are included. If the run stopped early, later quarters are absent — they are NOT zero.",
  "standardAiProposableCapexTypes lists the ONLY capital project types this Standard AI can ever propose. Types present in gameCapexTypes but absent there are structurally never proposed by the AI.",
  "companies[].turns[].strategy holds the company Vision (given from OUTSIDE by the human owner — the AI never invents growth targets), the reference growth path, the gap between that path and the company's current sustainable scale, the resulting growth pressure, and the full gate-by-gate record of the new-factory decision. Quarters where no factory was proposed still carry the reasons; 'did not build' is a recorded decision, not missing data.",
  "A Vision is an aspiration, not a quota. Failing to reach targetScaleTonsPerQuarterAtQ32 is not a bug and must not be reported as one.",
  "If run.isPartialRun is true, later quarters were never simulated. Treat the run as truncated, never as an 8-year outcome.",
];

function metricValue(dataset: SimulationAnalyticsDataset, turn: number, companyId: string, metric: string): number | null {
  return dataset.companyMetrics.find((f) => f.turn === turn && f.companyId === companyId && f.metric === metric)?.value ?? null;
}

function traceItems(dataset: SimulationAnalyticsDataset, turn: number, companyId: string, stage: string): readonly PackTraceItem[] {
  const fact = dataset.aiTrace.find((f) => f.turn === turn && f.companyId === companyId && f.stage === stage);
  return fact ? fact.items : [];
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || Math.abs(denominator) < 1e-9) return null;
  return numerator / denominator;
}

function productRecord<T>(build: (product: Product) => T): Readonly<Record<Product, T>> {
  return { hoso: build("hoso"), pd: build("pd"), vap: build("vap") };
}

// ---------------------------------------------------------------------
// 会社×ターン
// ---------------------------------------------------------------------

function buildCompanyTurn(stored: StoredSimulationRun, companyId: string, turn: number): PackCompanyTurn {
  const dataset = stored.dataset;
  const capture = stored.packCapture?.companyTurns.find((c) => c.turn === turn && c.companyId === companyId);

  // --- 診断 ---
  const bottleneck = dataset.bottlenecks.find((b) => b.turn === turn && b.companyId === companyId) ?? null;
  const diagnosedItems = traceItems(dataset, turn, companyId, "DIAGNOSED");
  const primary = diagnosedItems.find((i) => i.label === "主要制約")?.text ?? null;
  const secondary = diagnosedItems.find((i) => i.label === "第2の制約")?.text ?? null;
  const constrainedItems = traceItems(dataset, turn, companyId, "CONSTRAINED");

  // 理由コードは Standard AI が付けた形をそのまま保つ（要約・言い換えをしない）。
  const reasonCodes = constrainedItems
    .filter((i) => i.value === undefined && i.text !== undefined && /^\[/.test(i.label))
    .map((i) => {
      const match = /^\[(.+?)\]\s*(.+)$/.exec(i.label);
      return {
        code: match ? match[2] : i.label,
        domain: "standardAi",
        severity: match ? match[1] : "info",
        message: i.text as string,
      };
    });

  // --- 販売（希望 → 計画 → 成約） ---
  const salesRows = dataset.salesTrace.filter((s) => s.turn === turn && s.companyId === companyId);

  // --- 営業配置 ---
  const allocation = dataset.salesAllocation
    .filter((a) => a.turn === turn && a.companyId === companyId)
    .map((a) => ({ market: a.market, headcount: a.headcount }));

  // --- 意思決定（DECIDED トレース＝実際に提出した値） ---
  const decided = traceItems(dataset, turn, companyId, "DECIDED");
  const decidedValue = (label: string) => decided.find((i) => i.label === label)?.value ?? null;

  // --- 実行結果 ---
  const hiring = dataset.hiringTrace.find((h) => h.turn === turn && h.companyId === companyId) ?? null;
  const investments = dataset.investmentTrace.filter((i) => i.turn === turn && i.companyId === companyId);

  // --- 財務 ---
  const netRevenue = metricValue(dataset, turn, companyId, "revenue");
  const operatingProfit = metricValue(dataset, turn, companyId, "operatingProfit");
  const fixedCost = (component: string) =>
    dataset.fixedCosts.find((f) => f.turn === turn && f.companyId === companyId && f.component === component)?.value ?? null;

  const productEconomics: PackProductEconomics[] = PRODUCTS.map((product) => {
    const contribution = dataset.contribution.find((c) => c.turn === turn && c.companyId === companyId && c.product === product);
    const salesTons = salesRows.filter((s) => s.product === product).reduce((sum, s) => sum + (s.contractedQuantity ?? 0), 0);
    return {
      product,
      productionTons: metricValue(dataset, turn, companyId, `${product}Produced`),
      salesTons: salesRows.some((s) => s.product === product) ? salesTons : null,
      netRevenueUsd: contribution?.netRevenue ?? null,
      variableCostUsd: contribution?.variableCost ?? null,
      contributionUsd: contribution?.contributionMargin ?? null,
      contributionMarginRatio: contribution?.contributionMarginRatio ?? null,
      directFixedCostUsd: contribution?.directFixedCost ?? null,
    };
  });

  const contributionTotal = productEconomics.reduce<number | null>(
    (sum, p) => (p.contributionUsd === null ? sum : (sum ?? 0) + p.contributionUsd),
    null
  );

  return {
    turn,
    beginningState: capture?.beginningState ?? EMPTY_STATE,
    observed: { items: traceItems(dataset, turn, companyId, "OBSERVED") },
    diagnosis: {
      primaryConstraint: primary,
      secondaryConstraint: secondary,
      commercialBottleneck: bottleneck ? bottleneck.primary : null,
      shortfallTons: {
        rawMaterial: bottleneck ? bottleneck.rawMaterialShortfall : null,
        equipment: bottleneck ? bottleneck.equipmentShortfall : null,
        labor: bottleneck ? bottleneck.laborShortfall : null,
      },
      ratios: diagnosedItems.filter((i) => i.value !== undefined),
      reasonCodes,
    },
    wanted: {
      items: traceItems(dataset, turn, companyId, "WANTED"),
      desiredSalesByMarketProduct: salesRows.map((s) => ({
        market: s.market,
        product: s.product,
        desiredTonsBeforeEffortConstraint: s.wishedQuantity,
      })),
    },
    constraints: {
      items: constrainedItems.filter((i) => i.value !== undefined),
      actionConstraintCodes: reasonCodes.map((r) => r.code),
    },
    decision: {
      salesHireCount: hiring ? hiring.salesForceHireCount : 0,
      salesLayoffCount: hiring ? hiring.salesForceLayoffCount : 0,
      salesAllocationByMarket: allocation,
      salesPlanByMarketProduct: salesRows.map((s) => ({
        market: s.market,
        product: s.product,
        desiredTons: s.plannedQuantity,
        // 提示価格調整は意思決定の詳細であり dataset に持たせていない（NOT_RECORDED）。
        priceAdjustmentUsdPerKg: null,
      })),
      productionPlanTonsByProduct: productRecord(() => null),
      domesticPurchaseDesiredTons: decidedValue("国内買付希望量"),
      importOrderCount: decidedValue("輸入発注件数") ?? 0,
      workerRegularHeadcount: null,
      workerTemporaryHeadcount: hiring ? hiring.totalTemporaryWorkers : null,
      financingRequestUsd: decidedValue("借入希望額"),
      capexProposals: investments.filter((i) => i.status !== "rejected").map((i) => i.projectType),
      vapProductDevelopmentSpendUsd: decidedValue("VAP商品開発費"),
    },
    execution: {
      producedTonsByProduct: productRecord((product) => metricValue(dataset, turn, companyId, `${product}Produced`)),
      newContractedTons: metricValue(dataset, turn, companyId, "newContractedQuantity"),
      deliveredTons: metricValue(dataset, turn, companyId, "fulfilledQuantity"),
      outstandingTons: metricValue(dataset, turn, companyId, "outstandingQuantity"),
      domesticPurchasedTons: metricValue(dataset, turn, companyId, "domesticPurchaseQuantity"),
      equipmentUtilizationRate: metricValue(dataset, turn, companyId, "equipmentUtilizationRate"),
      laborUtilizationRate: metricValue(dataset, turn, companyId, "laborUtilizationRate"),
      overtimeRate: metricValue(dataset, turn, companyId, "overtimeRate"),
      contractedTonsByMarketProduct: salesRows.map((s) => ({ market: s.market, product: s.product, contractedTons: s.contractedQuantity })),
      capexEvents: investments
        .filter((i) => i.status !== "rejected")
        .map((i) => ({
          projectId: i.projectId,
          projectType: i.projectType,
          statusBefore: i.status.split(" → ")[0] ?? i.status,
          statusAfter: i.status.split(" → ")[1] ?? i.status,
          paidUsd: i.budgetUsd,
          reasons: i.note ? i.note.split(" / ") : [],
        })),
      capexRejectedProposals: investments
        .filter((i) => i.status === "rejected")
        .map((i) => ({ projectType: i.projectType, requestedBudgetUsd: i.budgetUsd, reasons: i.note ? i.note.split(" / ") : [] })),
    },
    financialResult: {
      netRevenueUsd: netRevenue,
      costOfSalesUsd: null,
      grossProfitUsd: null,
      grossMarginRatio: null,
      sellingGeneralAdminUsd: null,
      operatingProfitUsd: operatingProfit,
      operatingMarginRatio: ratio(operatingProfit, netRevenue),
      interestExpenseUsd: null,
      incomeTaxUsd: null,
      netIncomeUsd: metricValue(dataset, turn, companyId, "netIncome"),
      contributionMarginUsd: contributionTotal,
      contributionMarginRatio: ratio(contributionTotal, netRevenue),
      totalFixedCostUsd: fixedCost("totalFixedCost"),
      fixedManufacturingCostUsd: fixedCost("fixedManufacturingCost"),
      fixedPersonnelCostUsd: fixedCost("fixedPersonnelCost"),
      fixedSellingAdminCostUsd: fixedCost("fixedSellingAdminCost"),
      operatingCashFlowUsd: null,
      investingCashFlowUsd: null,
      financingCashFlowUsd: null,
      borrowingCapacityUsd: null,
      approvedLoanUsd: null,
      deniedLoanUsd: null,
      financialHealth: null,
      productEconomics,
    },
    endingState: capture?.endingState ?? EMPTY_STATE,
    capitalProjects: capture?.capitalProjects ?? [],
    // 【捏造しない】Vision 導入より前に保存された Simulation Run には strategy が無い。
    // その場合は空の Vision を作らず、availability で「記録されていない」ことを示す。
    strategy: capture?.strategy ?? EMPTY_STRATEGY,
  };
}

// ---------------------------------------------------------------------
// 会社サマリー（開始 → 終了）
// ---------------------------------------------------------------------

function buildCompanySummary(stored: StoredSimulationRun, companyId: string, displayName: string, turns: readonly PackCompanyTurn[]): PackCompanySummary {
  const dataset = stored.dataset;
  const first = turns[0];
  const last = turns[turns.length - 1];
  const sum = (metric: string) =>
    dataset.companyMetrics.filter((f) => f.companyId === companyId && f.metric === metric).reduce<number | null>((acc, f) => (f.value === null ? acc : (acc ?? 0) + f.value), null);

  const majorInvestments = turns.flatMap((t) =>
    t.execution.capexEvents
      .filter((e) => e.statusAfter !== e.statusBefore)
      .map((e) => ({ turn: t.turn, projectType: e.projectType, event: `${e.statusBefore} → ${e.statusAfter}` }))
  );

  const negativeQuarters = turns.filter((t) => (t.financialResult.operatingProfitUsd ?? 0) < 0).length;

  return {
    companyId,
    displayName,
    archetype: null,
    startingRevenueUsd: first?.financialResult.netRevenueUsd ?? null,
    endingRevenueUsd: last?.financialResult.netRevenueUsd ?? null,
    cumulativeRevenueUsd: sum("revenue"),
    startingOperatingProfitUsd: first?.financialResult.operatingProfitUsd ?? null,
    endingOperatingProfitUsd: last?.financialResult.operatingProfitUsd ?? null,
    cumulativeOperatingProfitUsd: sum("operatingProfit"),
    cumulativeNetIncomeUsd: sum("netIncome"),
    startingCashUsd: first?.beginningState.cashUsd ?? null,
    endingCashUsd: last?.endingState.cashUsd ?? null,
    startingDebtUsd: first?.beginningState.debtUsd ?? null,
    endingDebtUsd: last?.endingState.debtUsd ?? null,
    startingEquityUsd: first?.beginningState.equityUsd ?? null,
    endingEquityUsd: last?.endingState.equityUsd ?? null,
    startingSalesHeadcount: first?.beginningState.salesHeadcount ?? null,
    endingSalesHeadcount: last?.endingState.salesHeadcount ?? null,
    startingCapacityTonsByProduct: first?.beginningState.capacityTonsByProduct ?? { hoso: null, pd: null, vap: null },
    endingCapacityTonsByProduct: last?.endingState.capacityTonsByProduct ?? { hoso: null, pd: null, vap: null },
    majorInvestments,
    finalPrimaryBottleneck: last?.diagnosis.commercialBottleneck ?? null,
    operatingProfitNegativeQuarters: negativeQuarters,
  };
}

// ---------------------------------------------------------------------
// Pack 全体
// ---------------------------------------------------------------------

export interface BuildPackContextInput {
  readonly stored: StoredSimulationRun;
  /** metadata（ゲーム判断には使わない）。 */
  readonly exportedAt: string;
  /** 判明しない場合は "UNKNOWN" を渡す（捏造しない）。 */
  readonly sourceBranch?: string;
  readonly sourceCommit?: string;
}

const SOURCE_MAP: Readonly<Record<string, PackSourceType>> = {
  "run": "SIMULATION_RUN_METADATA",
  "world.turns[].trueWorld.marketProducts": "COMPANY_QUARTER_RECORD",
  "world.turns[].trueWorld.producerCountries": "MARKET_QUARTER_RESULT",
  "world.turns[].standardAiObservable": "COMPANY_QUARTER_RECORD",
  "world.turns[].scenarioEvents": "SCENARIO_STATE",
  "companies[].turns[].beginningState": "COMPANY_QUARTER_RECORD",
  "companies[].turns[].endingState": "COMPANY_QUARTER_RECORD",
  "companies[].turns[].observed": "STANDARD_AI_DIAGNOSTICS",
  "companies[].turns[].diagnosis": "STANDARD_AI_DIAGNOSTICS",
  "companies[].turns[].wanted": "STANDARD_AI_DIAGNOSTICS",
  "companies[].turns[].constraints": "STANDARD_AI_DIAGNOSTICS",
  "companies[].turns[].decision": "COMPANY_QUARTER_RECORD",
  "companies[].turns[].execution": "COMPANY_QUARTER_RECORD",
  "companies[].turns[].financialResult": "FINANCE_QUARTER_CLOSE",
  "companies[].turns[].capitalProjects": "CAPEX_QUARTER_CLOSE",
  "companies[].turns[].strategy.vision": "COMPANY_FIXTURE",
  "companies[].turns[].strategy.newFactory": "STANDARD_AI_DIAGNOSTICS",
  "majorChanges": "DERIVED_FROM_RECORDED_VALUES",
};

function buildAvailabilityNotes(stored: StoredSimulationRun): readonly PackDataAvailabilityNote[] {
  const hasCapture = stored.packCapture !== undefined;
  return [
    {
      field: "world.turns[].marketCountrySupplyShare",
      availability: "NOT_AVAILABLE",
      reason:
        "The engine has no market × producer-country supply matrix. Markets only record targetDemand (the demand Vietnamese suppliers could compete for) and producer countries only record global exportable supply / allocated demand. No share was invented.",
    },
    {
      field: "companies[].turns[].candidateActions",
      availability: "NOT_RECORDED",
      reason:
        "The engine does not store an explicit list of evaluated-but-rejected capital project candidates. However, Standard AI reason codes (CAPEX_PROPOSED / CAPEX_DEFERRED / CAPEX_DEFERRED_OVERSUPPLY) with their keyValues gate flags are recorded in diagnosis.reasonCodes and can be used to see which capacity types were evaluated and which gate failed.",
    },
    {
      field: "companies[].turns[].decision.productionPlanTonsByProduct",
      availability: "NOT_RECORDED",
      reason: "Per-factory production plan quantities are not carried into the analytics dataset. Actual produced tons are available in execution.producedTonsByProduct.",
    },
    {
      field: "companies[].turns[].decision.salesPlanByMarketProduct[].priceAdjustmentUsdPerKg",
      availability: "NOT_RECORDED",
      reason: "Price adjustment per sales plan entry is not carried into the analytics dataset.",
    },
    {
      field: "companies[].turns[].financialResult.costOfSalesUsd / grossProfitUsd / cashFlow / borrowingCapacity",
      availability: "NOT_RECORDED",
      reason: "These exist in the engine's finance records but are not carried into the analytics dataset used by this export. Revenue, operating profit, net income, contribution and fixed cost are available.",
    },
    {
      field: "companies[].turns[].beginningState / endingState",
      availability: hasCapture ? "AVAILABLE" : "NOT_RECORDED",
      reason: hasCapture
        ? "Captured during the run from the CompanyLabState before and after each quarter."
        : "This run was saved before per-turn state capture existed (schemaVersion 1). Re-run the simulation to obtain beginning/ending states.",
    },
    {
      field: "standardAiProposableCapexTypes",
      availability: "AVAILABLE",
      reason: "Read from the Standard AI capex decision module itself (source of truth), not inferred from this run's data.",
    },
  ];
}

export function buildAiAnalysisPackContext(input: BuildPackContextInput): AiAnalysisPackContext {
  const { stored } = input;
  const dataset = stored.dataset;
  const turns = dataset.turns;

  const companies: Record<string, { companyId: string; displayName: string; turns: readonly PackCompanyTurn[] }> = {};
  const summaries: PackCompanySummary[] = [];

  for (const company of dataset.companies) {
    const companyTurns = turns.map((turn) => buildCompanyTurn(stored, company.companyId, turn));
    companies[company.companyId] = { companyId: company.companyId, displayName: company.displayName, turns: companyTurns };
    summaries.push(buildCompanySummary(stored, company.companyId, company.displayName, companyTurns));
  }

  const worldTurns = (stored.packCapture?.worldTurns ?? []).filter((w) => turns.includes(w.turn));

  return {
    schemaVersion: AI_ANALYSIS_PACK_SCHEMA_VERSION,
    readingGuide: PACK_READING_GUIDE,
    run: {
      simulationRunId: stored.run.simulationRunId,
      scenarioId: stored.run.scenarioId,
      scenarioVersion: stored.run.scenarioVersion,
      seed: stored.run.seed,
      gameParameterVersion: stored.run.gameParameterVersion,
      standardAiVersion: stored.run.standardAiVersion,
      strategyProfileVersion: stored.run.strategyProfileVersion,
      startingTurn: stored.run.startingTurn,
      completedTurns: stored.run.completedTurns,
      requestedTurns: stored.run.requestedTurns,
      startedAt: stored.run.startedAt,
      completedAt: stored.run.completedAt,
      stopReason: stored.run.stopReason,
      isPartialRun: stored.run.completedTurns < stored.run.requestedTurns,
      runCompletenessLabel:
        stored.run.completedTurns < stored.run.requestedTurns
          ? `PARTIAL RUN — ${stored.run.completedTurns} / ${stored.run.requestedTurns} quarters`
          : `COMPLETE RUN — ${stored.run.completedTurns} / ${stored.run.requestedTurns} quarters`,
      exportedAt: input.exportedAt,
      sourceBranch: input.sourceBranch ?? "UNKNOWN",
      sourceCommit: input.sourceCommit ?? "UNKNOWN",
    },
    companySummaries: summaries,
    world: { turns: worldTurns },
    companies,
    majorChanges: buildMajorChanges(dataset, worldTurns, companies),
    standardAiProposableCapexTypes: STANDARD_AI_PROPOSABLE_CAPEX_TYPES,
    gameCapexTypes: CAPITAL_PROJECT_TYPES,
    dataAvailability: buildAvailabilityNotes(stored),
    sourceMap: SOURCE_MAP,
  };
}

/** 市場一覧（Excel などが使う）。 */
export const PACK_MARKETS: readonly DemandMarketId[] = DEMAND_MARKET_IDS;
export const PACK_PRODUCTS: readonly Product[] = PRODUCTS;
