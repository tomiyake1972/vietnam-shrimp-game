// ShrimpX V2 — AI Analysis Pack: 03_Analysis.xlsx
//
// Excel は AI 用というより「人間＋ChatGPT の定量確認用」。
//
// 【構造】Analysis sheet（読みやすい形）＋ Raw sheet（long-format）に分ける。
// 32Q を横に何百列も並べる構造にはしない。Raw は
//   simulationRunId / turn / company / market / product / metric / value / unit
// の列を持ち、将来の追加指標もそのまま行として足せる。
//
// 【既存ライブラリを使う】ExcelJS は既にこのプロジェクトの依存関係にある
// （新しい依存を増やさない）。

import ExcelJS from "exceljs";
import { COMPANY_METRIC_LABELS, COMPANY_METRIC_UNITS, SimulationAnalyticsDataset } from "../analytics/types";
import { AiAnalysisPackContext } from "./types";

function addRows(sheet: ExcelJS.Worksheet, header: readonly string[], rows: readonly (readonly (string | number | null)[])[]): void {
  sheet.addRow([...header]);
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow([...row]);
  sheet.columns.forEach((column) => {
    column.width = Math.min(28, Math.max(10, String(column.values?.[1] ?? "").length + 4));
  });
}

/** long-format の1行。 */
interface RawRow {
  readonly turn: number;
  readonly company: string;
  readonly market: string;
  readonly product: string;
  readonly metric: string;
  readonly value: number | null;
  readonly unit: string;
}

const RAW_HEADER = ["simulationRunId", "turn", "company", "market", "product", "metric", "value", "unit"] as const;

function rawRowsToArrays(runId: string, rows: readonly RawRow[]): readonly (readonly (string | number | null)[])[] {
  return rows.map((r) => [runId, r.turn, r.company, r.market, r.product, r.metric, r.value, r.unit]);
}

export async function buildAnalysisWorkbook(context: AiAnalysisPackContext, dataset: SimulationAnalyticsDataset): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ShrimpX AI Analysis Pack";
  const runId = context.run.simulationRunId;
  const turns = dataset.turns;
  const companyIds = dataset.companies.map((c) => c.companyId);

  // ---------------- 00_Run_Summary ----------------
  const summary = workbook.addWorksheet("00_Run_Summary");
  addRows(
    summary,
    ["field", "value"],
    [
      ["simulationRunId", context.run.simulationRunId],
      ["scenarioId", context.run.scenarioId],
      ["scenarioVersion", context.run.scenarioVersion],
      ["seed", context.run.seed],
      ["completedTurns", context.run.completedTurns],
      ["requestedTurns", context.run.requestedTurns],
      ["stopReason", context.run.stopReason],
      ["gameParameterVersion", context.run.gameParameterVersion],
      ["standardAiVersion", context.run.standardAiVersion],
      ["packSchemaVersion", context.schemaVersion],
      ["exportedAt", context.run.exportedAt],
      ["standardAiProposableCapexTypes", context.standardAiProposableCapexTypes.join(", ")],
      ["gameCapexTypes", context.gameCapexTypes.join(", ")],
    ]
  );

  const companySummary = workbook.addWorksheet("00b_Company_Summary");
  addRows(
    companySummary,
    ["company", "name", "cumulativeRevenueUsd", "cumulativeOperatingProfitUsd", "cumulativeNetIncomeUsd", "startCashUsd", "endCashUsd", "startDebtUsd", "endDebtUsd", "startEquityUsd", "endEquityUsd", "startSalesHeadcount", "endSalesHeadcount", "negativeOperatingProfitQuarters", "finalBottleneck"],
    context.companySummaries.map((c) => [
      c.companyId,
      c.displayName,
      c.cumulativeRevenueUsd,
      c.cumulativeOperatingProfitUsd,
      c.cumulativeNetIncomeUsd,
      c.startingCashUsd,
      c.endingCashUsd,
      c.startingDebtUsd,
      c.endingDebtUsd,
      c.startingEquityUsd,
      c.endingEquityUsd,
      c.startingSalesHeadcount,
      c.endingSalesHeadcount,
      c.operatingProfitNegativeQuarters,
      c.finalPrimaryBottleneck,
    ])
  );

  // ---------------- 01_Company_Quarterly ----------------
  const quarterly = workbook.addWorksheet("01_Company_Quarterly");
  const quarterlyMetrics = ["revenue", "operatingProfit", "netIncome", "cash", "debt", "salesHeadcount", "hosoProduced", "pdProduced", "vapProduced", "equipmentUtilizationRate"] as const;
  addRows(
    quarterly,
    ["turn", "company", ...quarterlyMetrics],
    turns.flatMap((turn) =>
      companyIds.map((companyId) => [
        turn,
        companyId,
        ...quarterlyMetrics.map((m) => dataset.companyMetrics.find((f) => f.turn === turn && f.companyId === companyId && f.metric === m)?.value ?? null),
      ])
    )
  );

  // ---------------- 02 / 03 市場 ----------------
  const demand = workbook.addWorksheet("02_Market_Product_Demand");
  addRows(
    demand,
    ["turn", "market", "product", "visibility", "demandTons", "sourceTurn"],
    dataset.marketMetrics.filter((f) => f.metric === "demandQuantity").map((f) => [f.turn, f.market, f.product, f.visibility, f.value, f.sourceTurn])
  );

  const price = workbook.addWorksheet("03_Market_Product_Price");
  addRows(
    price,
    ["turn", "market", "product", "priceUsdPerKg"],
    dataset.marketMetrics.filter((f) => f.metric === "price").map((f) => [f.turn, f.market, f.product, f.value])
  );

  // ---------------- 04_Product_Economics ----------------
  const economics = workbook.addWorksheet("04_Product_Economics");
  addRows(
    economics,
    ["turn", "company", "product", "productionTons", "salesTons", "netRevenueUsd", "variableCostUsd", "contributionUsd", "contributionMarginRatio", "directFixedCostUsd"],
    Object.values(context.companies).flatMap((c) =>
      c.turns.flatMap((t) =>
        t.financialResult.productEconomics.map((p) => [
          t.turn,
          c.companyId,
          p.product,
          p.productionTons,
          p.salesTons,
          p.netRevenueUsd,
          p.variableCostUsd,
          p.contributionUsd,
          p.contributionMarginRatio,
          p.directFixedCostUsd,
        ])
      )
    )
  );

  // ---------------- 05 / 06 営業 ----------------
  const headcount = workbook.addWorksheet("05_Sales_Headcount");
  addRows(
    headcount,
    ["turn", "company", "salesHeadcount", "hireCount", "layoffCount", "temporaryWorkers"],
    dataset.hiringTrace.map((h) => [h.turn, h.companyId, h.endingSalesHeadcount, h.salesForceHireCount, h.salesForceLayoffCount, h.totalTemporaryWorkers])
  );

  const allocation = workbook.addWorksheet("06_Sales_Allocation");
  addRows(
    allocation,
    ["turn", "company", "market", "headcount"],
    dataset.salesAllocation.map((a) => [a.turn, a.companyId, a.market, a.headcount])
  );

  // ---------------- 07_Contracts_Sales ----------------
  const contracts = workbook.addWorksheet("07_Contracts_Sales");
  addRows(
    contracts,
    ["turn", "company", "market", "product", "wishedTons", "plannedTons", "contractedTons"],
    dataset.salesTrace.map((s) => [s.turn, s.companyId, s.market, s.product, s.wishedQuantity, s.plannedQuantity, s.contractedQuantity])
  );

  // ---------------- 10 / 11 工場 ----------------
  const capacity = workbook.addWorksheet("10_Factory_Capacity");
  addRows(
    capacity,
    ["turn", "company", "factoryCount", "hosoCapacityTons", "pdCapacityTons", "vapCapacityTons", "commonProcessingCapacityTons"],
    Object.values(context.companies).flatMap((c) =>
      c.turns.map((t) => [
        t.turn,
        c.companyId,
        t.endingState.factoryCount,
        t.endingState.capacityTonsByProduct.hoso,
        t.endingState.capacityTonsByProduct.pd,
        t.endingState.capacityTonsByProduct.vap,
        t.endingState.commonProcessingCapacityTons,
      ])
    )
  );

  const space = workbook.addWorksheet("11_Factory_Space");
  addRows(
    space,
    ["turn", "company", "spaceTotalUnits", "spaceUsedUnits", "spaceRemainingUnits"],
    Object.values(context.companies).flatMap((c) =>
      c.turns.map((t) => [t.turn, c.companyId, t.endingState.factorySpaceTotalUnits, t.endingState.factorySpaceUsedUnits, t.endingState.factorySpaceRemainingUnits])
    )
  );

  // ---------------- 12_Inventory_Backlog ----------------
  const inventory = workbook.addWorksheet("12_Inventory_Backlog");
  addRows(
    inventory,
    ["turn", "company", "rawMaterialInventoryTons", "finishedGoodsInventoryTons", "backlogTons"],
    Object.values(context.companies).flatMap((c) =>
      c.turns.map((t) => [t.turn, c.companyId, t.endingState.rawMaterialInventoryTons, t.endingState.finishedGoodsInventoryTons, t.endingState.backlogTons])
    )
  );

  // ---------------- 13_Fixed_Cost ----------------
  const fixedCost = workbook.addWorksheet("13_Fixed_Cost");
  addRows(
    fixedCost,
    ["turn", "company", "component", "valueUsd"],
    dataset.fixedCosts.map((f) => [f.turn, f.companyId, f.component, f.value])
  );

  // ---------------- 14_Investment ----------------
  const investment = workbook.addWorksheet("14_Investment");
  addRows(
    investment,
    ["turn", "company", "projectId", "projectType", "status", "amountUsd", "reason"],
    dataset.investmentTrace.map((i) => [i.turn, i.companyId, i.projectId, i.projectType, i.status, i.budgetUsd, i.note])
  );

  const projects = workbook.addWorksheet("14b_Capital_Projects");
  addRows(
    projects,
    ["turn", "company", "projectId", "projectType", "status", "approvedBudgetUsd", "cumulativePaidUsd", "requiredQuarters", "elapsedQuarters"],
    Object.values(context.companies).flatMap((c) =>
      c.turns.flatMap((t) =>
        t.capitalProjects.map((p) => [
          t.turn,
          c.companyId,
          p.projectId,
          p.projectType,
          p.status,
          p.approvedBudgetUsd,
          p.cumulativePaidUsd,
          p.requiredConstructionQuarters,
          p.elapsedConstructionQuartersWithPayment,
        ])
      )
    )
  );

  // ---------------- 15_PL ----------------
  const pl = workbook.addWorksheet("15_PL");
  addRows(
    pl,
    ["turn", "company", "netRevenueUsd", "operatingProfitUsd", "operatingMarginRatio", "netIncomeUsd", "contributionMarginUsd", "contributionMarginRatio", "totalFixedCostUsd"],
    Object.values(context.companies).flatMap((c) =>
      c.turns.map((t) => [
        t.turn,
        c.companyId,
        t.financialResult.netRevenueUsd,
        t.financialResult.operatingProfitUsd,
        t.financialResult.operatingMarginRatio,
        t.financialResult.netIncomeUsd,
        t.financialResult.contributionMarginUsd,
        t.financialResult.contributionMarginRatio,
        t.financialResult.totalFixedCostUsd,
      ])
    )
  );

  // ---------------- 16_BS ----------------
  const bs = workbook.addWorksheet("16_BS");
  addRows(
    bs,
    ["turn", "company", "beginningCashUsd", "endingCashUsd", "beginningDebtUsd", "endingDebtUsd", "beginningEquityUsd", "endingEquityUsd"],
    Object.values(context.companies).flatMap((c) =>
      c.turns.map((t) => [
        t.turn,
        c.companyId,
        t.beginningState.cashUsd,
        t.endingState.cashUsd,
        t.beginningState.debtUsd,
        t.endingState.debtUsd,
        t.beginningState.equityUsd,
        t.endingState.equityUsd,
      ])
    )
  );

  // ---------------- 18_Bottleneck ----------------
  const bottleneck = workbook.addWorksheet("18_Bottleneck");
  addRows(
    bottleneck,
    ["turn", "company", "primaryBottleneck", "rawMaterialShortfallTons", "equipmentShortfallTons", "laborShortfallTons"],
    dataset.bottlenecks.map((b) => [b.turn, b.companyId, b.primary, b.rawMaterialShortfall, b.equipmentShortfall, b.laborShortfall])
  );

  // ---------------- 19_AI_Decision ----------------
  const aiDecision = workbook.addWorksheet("19_AI_Decision");
  addRows(
    aiDecision,
    ["turn", "company", "salesHireCount", "salesLayoffCount", "domesticPurchaseDesiredTons", "importOrderCount", "financingRequestUsd", "capexProposals", "vapDevelopmentSpendUsd"],
    Object.values(context.companies).flatMap((c) =>
      c.turns.map((t) => [
        t.turn,
        c.companyId,
        t.decision.salesHireCount,
        t.decision.salesLayoffCount,
        t.decision.domesticPurchaseDesiredTons,
        t.decision.importOrderCount,
        t.decision.financingRequestUsd,
        t.decision.capexProposals.join(", "),
        t.decision.vapProductDevelopmentSpendUsd,
      ])
    )
  );

  // ---------------- 20_AI_Diagnostics ----------------
  const diagnostics = workbook.addWorksheet("20_AI_Diagnostics");
  addRows(
    diagnostics,
    ["turn", "company", "primaryConstraint", "secondaryConstraint", "commercialBottleneck", "reasonCode", "severity", "message"],
    Object.values(context.companies).flatMap((c) =>
      c.turns.flatMap((t) =>
        t.diagnosis.reasonCodes.length === 0
          ? [[t.turn, c.companyId, t.diagnosis.primaryConstraint, t.diagnosis.secondaryConstraint, t.diagnosis.commercialBottleneck, null, null, null]]
          : t.diagnosis.reasonCodes.map((r) => [
              t.turn,
              c.companyId,
              t.diagnosis.primaryConstraint,
              t.diagnosis.secondaryConstraint,
              t.diagnosis.commercialBottleneck,
              r.code,
              r.severity,
              r.message,
            ])
      )
    )
  );

  // ---------------- 22_Scenario_Events ----------------
  const scenario = workbook.addWorksheet("22_Scenario_Events");
  addRows(
    scenario,
    ["turn", "eventId", "eventType", "startTurn", "durationTurns", "magnitudeScale"],
    context.world.turns.flatMap((w) => w.scenarioEvents.map((e) => [w.turn, e.eventId, e.title, e.startTurn, e.durationTurns, e.magnitudeScale]))
  );

  // ---------------- 23_Major_Changes ----------------
  const changes = workbook.addWorksheet("23_Major_Changes");
  addRows(
    changes,
    ["turn", "scope", "metric", "from", "to", "changeType"],
    context.majorChanges.map((c) => [c.turn, c.scope, c.metric, c.from, c.to, c.changeType])
  );

  // ---------------- 90 / 91 / 92 Raw（long-format） ----------------
  const rawCompany = workbook.addWorksheet("90_Raw_Company");
  addRows(
    rawCompany,
    RAW_HEADER,
    rawRowsToArrays(
      runId,
      dataset.companyMetrics.map((f) => ({
        turn: f.turn,
        company: f.companyId,
        market: "",
        product: "",
        metric: f.metric,
        value: f.value,
        unit: COMPANY_METRIC_UNITS[f.metric] ?? "",
      }))
    )
  );

  const rawMarket = workbook.addWorksheet("91_Raw_Market");
  addRows(
    rawMarket,
    [...RAW_HEADER, "visibility", "sourceTurn"],
    dataset.marketMetrics.map((f) => [
      runId,
      f.turn,
      "",
      f.market,
      f.product,
      f.metric,
      f.value,
      f.metric === "price" ? "USD/kg" : "t",
      f.visibility,
      f.sourceTurn,
    ])
  );

  const rawProducer = workbook.addWorksheet("91b_Raw_Producer_Country");
  addRows(
    rawProducer,
    ["simulationRunId", "turn", "country", "metric", "value"],
    dataset.producerCountryMetrics.map((f) => [runId, f.turn, f.country, f.metric, f.value])
  );

  const rawAi = workbook.addWorksheet("92_Raw_AI");
  addRows(
    rawAi,
    ["simulationRunId", "turn", "company", "stage", "label", "value", "unit", "text"],
    dataset.aiTrace.flatMap((f) => f.items.map((i) => [runId, f.turn, f.companyId, f.stage, i.label, i.value ?? null, i.unit ?? "", i.text ?? ""]))
  );

  const metricDictionary = workbook.addWorksheet("99_Metric_Labels");
  addRows(
    metricDictionary,
    ["metric", "japanese", "unit"],
    Object.keys(COMPANY_METRIC_LABELS).map((k) => [k, COMPANY_METRIC_LABELS[k as keyof typeof COMPANY_METRIC_LABELS], COMPANY_METRIC_UNITS[k as keyof typeof COMPANY_METRIC_UNITS]])
  );

  return (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
}
