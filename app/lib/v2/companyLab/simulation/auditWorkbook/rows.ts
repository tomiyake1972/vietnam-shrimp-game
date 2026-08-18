// ShrimpX V2 — Standard AI 32Q Audit Workbook: 保存済みRunからの行の組み立て
//
// 【転記のみ・再計算しない（実装指示§2・§40）】本ファイルは Engine / stored run data /
// Standard AI diagnostics / financial results が既に確定させた値を取り出して並べ替える
// だけである。ゲームの計算式・Standard AIの判断ロジック・TSVの評価式は一切ここに無い。
// 評価値（Company Value / Dividend Value / TSV）は既存の evaluation service
// （evaluation/evaluationSemantics.ts、唯一のsource of truth）をそのまま呼ぶ。
//
// 【どこから取るか（重要）】保存済みRunは、容量のため
// `resumePayload.state.history` と `resumePayload.aiTurnTraces` を **直近
// ROLLING_RESUME_HISTORY_WINDOW ターンぶんだけ** へ間引いて保存する
// （persistence/resume.ts）。したがって32Q全ターンを網羅できるのは
//   - stored.dataset          … long-format の確定事実表（全ターン）
//   - stored.packCapture      … 会社×ターンの期首/期末・投資案件・Vision・商業成長（全ターン）
//   - resumePayload の非間引きフィールド（capacityByTurn / salesHeadcountByTurn）
// の3系統である。full CompanyQuarterRecord が要る項目（詳細P&L・契約明細・
// 生産配分の内訳等）は、直近ウィンドウぶん、または Management Console が
// live session を渡した場合のみ埋まる。埋まらないセルは空欄にし、理由を
// meta.missingDataNotes と 00_README へ必ず残す（捏造しない）。

import { StoredSimulationRun } from "../persistence/types";
import { CompanyDecisionInput, CompanyQuarterRecord } from "../../types";
import { CompanyId } from "../../../sales/types";
import { DemandMarketId, Product } from "../../../market/types";
import { CompanyMetricKey } from "../analytics/types";
import { computeAllCompaniesEvaluationSnapshot, computeCompanyEvaluationSnapshot, rankCompaniesByTotalShareholderValue } from "../../evaluation/evaluationSemantics";
import { resolveEvaluationHistory } from "../../evaluation/evaluationHistory";
import { MANAGEMENT_PROFILE_BY_COMPANY_ID, MANAGEMENT_PROFILES } from "../../standardAi/managementProfile";
import { COMPANY_ORIENTATION_BY_COMPANY_ID } from "../../standardAi/orientationProfile";
import { STANDARD_AI_PARAMETERS_V1 } from "../../standardAi/parameters";
import {
  AuditBacklogRow,
  AuditCapexRow,
  AuditCompanyProfileRow,
  AuditCompanySummaryRow,
  AuditDecisionRow,
  AuditDiagnosticRow,
  AuditDividendRow,
  AuditEventRow,
  AuditFactoryCapacityRow,
  AuditFinalResultRow,
  AuditFinanceRow,
  AuditMarketRow,
  AuditProcurementRow,
  AuditProductionRow,
  AuditProfileVisionRow,
  AuditRunSummaryRow,
  AuditSalesRow,
  AuditTurnKpiRow,
  AuditWorkforceRow,
  BacklogDueStatus,
  StandardAiAuditWorkbookData,
  num,
} from "./types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function periodLabel(year: number | null, quarter: number | null): string {
  return year !== null && quarter !== null ? `${year}Q${quarter}` : "";
}

function periodOrdinalFromLabel(label: string): number | null {
  const m = /^(\d{4})Q([1-4])$/.exec(label);
  return m ? Number(m[1]) * 4 + Number(m[2]) : null;
}

export interface BuildAuditRowsInput {
  readonly stored: StoredSimulationRun;
  readonly generatedAt: string;
  /** 出力対象の最終Turn（省略時はdatasetの最大Turn）。 */
  readonly asOfTurn?: number;
  /**
   * 【任意】Management Console が保持している live session の確定履歴。
   * 保存済みRunの history は直近数ターンへ間引かれているため、live session から
   * 出力する場合はこれを渡すと全ターンの詳細シートが埋まる。渡さない場合も
   * export は失敗せず、埋まらないセルが空欄になるだけ。
   */
  readonly liveHistory?: readonly CompanyQuarterRecord[];
}

export function buildStandardAiAuditWorkbookData(input: BuildAuditRowsInput): StandardAiAuditWorkbookData {
  const { stored, generatedAt } = input;
  const run = stored.run;
  const missingDataNotes: string[] = [];

  const dataset = stored.dataset;
  const packTurns = stored.packCapture?.companyTurns ?? [];
  const worldTurns = stored.packCapture?.worldTurns ?? [];
  const resume = stored.resumePayload;
  const savedHistory: readonly CompanyQuarterRecord[] = resume?.state?.history ?? [];
  // live history があればそちらを優先し、無ければ保存済み（間引き済み）を使う。
  const history: readonly CompanyQuarterRecord[] = (input.liveHistory?.length ?? 0) > 0 ? (input.liveHistory as readonly CompanyQuarterRecord[]) : savedHistory;
  // 【評価履歴】Final Results と同じ唯一の入口を使う。evaluationHistory（全Turnの
  // 軽量射影。resume時に間引かれない）があればそれを、無い場合は state.history を使う。
  // これにより保存済みRunからのexportでもTurn1〜のTSVが埋まる（旧Runは従来どおり
  // 記録のあるTurnだけ）。TSVの式そのものはここでも一切持たない。
  const evaluationHistory = resolveEvaluationHistory({
    evaluationHistory: resume?.evaluationHistory,
    stateHistory: history,
  });
  const aiTurnTraces = resume?.aiTurnTraces ?? [];
  const capacityByTurn = resume?.capacityByTurn ?? [];
  const salesHeadcountByTurn = resume?.salesHeadcountByTurn ?? [];
  const fixtures = resume?.fixtures ?? [];

  const datasetTurns = [...dataset.turns].sort((a, b) => a - b);
  const maxDatasetTurn = datasetTurns.length > 0 ? datasetTurns[datasetTurns.length - 1] : 0;
  const requestedAsOf = input.asOfTurn ?? run.gameEndTurn ?? maxDatasetTurn;
  const asOfTurn = Math.max(0, Math.min(requestedAsOf > 0 ? requestedAsOf : maxDatasetTurn, maxDatasetTurn));
  const turns = datasetTurns.filter((t) => t <= asOfTurn);

  const companyIds: readonly string[] = dataset.companies.map((c) => c.companyId);
  const displayNameById = new Map(dataset.companies.map((c) => [c.companyId, c.displayName]));
  const fixtureById = new Map(fixtures.map((f) => [f.companyId as string, f]));

  const status: "COMPLETE" | "PARTIAL" = run.gameEndedAt != null || (run.requestedTurns > 0 && asOfTurn >= run.requestedTurns) ? "COMPLETE" : "PARTIAL";

  // ---- インデックス ----
  const metricIndex = new Map<string, number | null>();
  for (const fact of dataset.companyMetrics) metricIndex.set(`${fact.companyId}#${fact.turn}#${fact.metric}`, fact.value);
  const metric = (companyId: string, turn: number, key: CompanyMetricKey): number | null => metricIndex.get(`${companyId}#${turn}#${key}`) ?? null;

  const worldByTurn = new Map(worldTurns.map((w) => [w.turn, w]));
  const packByCompanyTurn = new Map(packTurns.map((p) => [`${p.companyId}#${p.turn}`, p]));
  const historyByTurn = new Map(history.map((r) => [r.turn, r]));
  const traceByCompanyTurn = new Map(aiTurnTraces.map((t) => [`${t.companyId}#${t.turn}`, t]));
  const capacityByCompanyTurn = new Map(capacityByTurn.map((c) => [`${c.companyId}#${c.turn}`, c]));
  const salesHeadcountByCompanyTurn = new Map(salesHeadcountByTurn.map((s) => [`${s.companyId}#${s.turn}`, s.headcount]));
  const bottleneckByCompanyTurn = new Map(dataset.bottlenecks.map((b) => [`${b.companyId}#${b.turn}`, b]));
  const fixedCost = (companyId: string, turn: number, component: string): number | null =>
    dataset.fixedCosts.find((f) => f.turn === turn && f.companyId === companyId && f.component === component)?.value ?? null;

  const periodOf = (turn: number): string => {
    const world = worldByTurn.get(turn);
    if (world) return periodLabel(world.year, world.quarter);
    const record = historyByTurn.get(turn);
    return record ? String(record.period) : "";
  };
  const quarterOf = (turn: number): number | null => {
    const world = worldByTurn.get(turn);
    if (world) return world.quarter;
    const label = periodOf(turn);
    const m = /^\d{4}Q([1-4])$/.exec(label);
    return m ? Number(m[1]) : null;
  };

  // ---- 欠損の申告（実装指示§29・§35） ----
  const evaluationTurnsForNotes = new Set(evaluationHistory.map((r) => r.turn));
  const historyTurns = new Set(history.map((r) => r.turn));
  const missingHistoryTurns = turns.filter((t) => !historyTurns.has(t));
  if (packTurns.length === 0) {
    missingDataNotes.push("packCapture is unavailable for this run (legacy save). 10_CAPEX_DETAIL, 19_AI_PROFILE_VISION and decisionOwner columns are empty.");
  }
  if (missingHistoryTurns.length > 0) {
    missingDataNotes.push(
      `Full per-turn engine records (CompanyQuarterRecord) are available for turns [${[...historyTurns].sort((a, b) => a - b).join(",")}] only. ` +
        `Saved runs keep a rolling window of the last few turns (persistence/resume.ts ROLLING_RESUME_HISTORY_WINDOW) to bound save size. ` +
        `Consequently 06_SALES_DETAIL / 07_PRODUCTION_DETAIL / 09_WORKFORCE_DETAIL detail columns, 11_FINANCE_DETAIL line items, and per-turn shareholder-value columns ` +
        `(companyValueUsd / dividendValueUsd / totalShareholderValueUsd in 03_TURN_KPI) are blank for turns [${missingHistoryTurns.join(",")}]. ` +
        `All-turn coverage is preserved in 03_TURN_KPI core KPIs, 04_STANDARD_AI_DECISIONS, 05_DECISION_DIAGNOSTICS, 19_AI_PROFILE_VISION and 13_MARKET_DETAIL, which read the analytics dataset and pack capture instead.`
    );
    if (turns.every((t) => evaluationTurnsForNotes.has(t))) {
      missingDataNotes.push(
        "Shareholder value columns (companyValueUsd / dividendValueUsd / totalShareholderValueUsd) ARE available for every turn: they are computed from the compact all-turn evaluationHistory, which is not trimmed. Only the detailed statement columns above are limited to the retained window."
      );
    } else {
      missingDataNotes.push(
        "Shareholder value columns are limited to the same retained window because this run predates the all-turn evaluationHistory projection. The valuation engine itself was NOT modified for this export."
      );
    }
  }
  if (aiTurnTraces.length === 0) {
    missingDataNotes.push("Standard AI six-stage traces are unavailable for this run; 05_DECISION_DIAGNOSTICS falls back to the analytics dataset aiTrace facts where present.");
  }

  // ---------------- 01_RUN_SUMMARY ----------------
  const runSummary: AuditRunSummaryRow[] = [
    { field: "simulationRunId", value: run.simulationRunId },
    { field: "scenarioId", value: run.scenarioId },
    { field: "scenarioVersion", value: run.scenarioVersion },
    { field: "seed", value: run.seed },
    { field: "status", value: status },
    { field: "asOfTurn", value: asOfTurn },
    { field: "requestedTurns", value: run.requestedTurns },
    { field: "completedTurns", value: run.completedTurns },
    { field: "gameEndTurn", value: run.gameEndTurn ?? null },
    { field: "gameEndedAt", value: run.gameEndedAt ?? null },
    { field: "startedAt", value: run.startedAt },
    { field: "completedAt", value: run.completedAt },
    { field: "stopReason", value: run.stopReason },
    { field: "runName", value: run.runName ?? null },
    { field: "gameParameterVersion", value: run.gameParameterVersion },
    { field: "standardAiVersion", value: run.standardAiVersion },
    { field: "strategyProfileVersion", value: run.strategyProfileVersion },
    { field: "analyticsSchemaVersion", value: dataset.schemaVersion },
    { field: "generatedAt", value: generatedAt },
    { field: "companyCount", value: companyIds.length },
    { field: "turnsInWorkbook", value: turns.length },
    { field: "fullEngineRecordTurns", value: [...historyTurns].sort((a, b) => a - b).join(",") },
    { field: "standardAiDividendBasePayoutRatio", value: STANDARD_AI_PARAMETERS_V1.dividendBasePayoutRatio },
  ];

  const companyProfiles: AuditCompanyProfileRow[] = companyIds.map((companyId) => {
    const fixture = fixtureById.get(companyId);
    const lastPack = packTurns.filter((p) => p.companyId === companyId && p.turn <= asOfTurn).sort((a, b) => b.turn - a.turn)[0];
    const vision = lastPack?.strategy?.vision ?? null;
    return {
      companyId,
      displayName: displayNameById.get(companyId) ?? fixture?.displayName ?? "",
      archetype: fixture?.archetype ?? "",
      country: fixture?.country ?? "",
      managementProfileId: MANAGEMENT_PROFILE_BY_COMPANY_ID[companyId as CompanyId] ?? null,
      orientationProfileId: COMPANY_ORIENTATION_BY_COMPANY_ID[companyId as CompanyId] ?? null,
      decisionOwner: run.companyControlModes?.[companyId] ?? lastPack?.decisionOwner ?? null,
      visionId: vision?.visionId ?? null,
      visionGrowthAmbition: vision?.growthAmbition ?? null,
      visionTargetScaleTonsPerQuarterAtQ32: vision ? num(vision.targetScaleTonsPerQuarterAtQ32) : null,
      visionStrategicPosture: vision?.strategicPosture ?? null,
      visionSource: vision?.source ?? null,
      standardAiProfileMode: (resume?.state?.config as { readonly standardAiProfileMode?: string } | undefined)?.standardAiProfileMode ?? null,
    };
  });

  // ---------------- 逐次シート ----------------
  const turnKpi: AuditTurnKpiRow[] = [];
  const finance: AuditFinanceRow[] = [];
  const sales: AuditSalesRow[] = [];
  const production: AuditProductionRow[] = [];
  const procurement: AuditProcurementRow[] = [];
  const workforce: AuditWorkforceRow[] = [];
  const dividend: AuditDividendRow[] = [];
  const factoryCapacity: AuditFactoryCapacityRow[] = [];
  const decisions: AuditDecisionRow[] = [];
  const diagnostics: AuditDiagnosticRow[] = [];
  const market: AuditMarketRow[] = [];
  const events: AuditEventRow[] = [];
  const profileVision: AuditProfileVisionRow[] = [];

  // 評価スナップショット（historyがあるTurnのみ算出できる）。
  const evaluationTurns = new Set(evaluationHistory.map((r) => r.turn));
  const evaluationByCompanyTurn = new Map<string, ReturnType<typeof computeCompanyEvaluationSnapshot>>();
  for (const turn of turns) {
    if (!evaluationTurns.has(turn)) continue;
    for (const companyId of companyIds) {
      evaluationByCompanyTurn.set(`${companyId}#${turn}`, computeCompanyEvaluationSnapshot(evaluationHistory as never, companyId as CompanyId, turn));
    }
  }

  // ---- 13_MARKET_DETAIL / 18_EVENT_LOG（世界側） ----
  for (const turn of turns) {
    const period = periodOf(turn);
    const world = worldByTurn.get(turn);
    if (world) {
      for (const mp of world.trueWorld.marketProducts) {
        market.push({
          turn,
          period,
          scope: "DEMAND_MARKET_TRUE",
          key: mp.market,
          product: mp.product,
          priceUsdPerKg: num((mp as unknown as { priceUsdPerKg?: unknown }).priceUsdPerKg),
          priorPriceUsdPerKg: null,
          priceChangeRatio: null,
          demandHosoEqTons: num((mp as unknown as { demandTons?: unknown }).demandTons),
          supplyHosoEqTons: num((mp as unknown as { supplyTons?: unknown }).supplyTons),
          utilizationRatio: null,
          shockApplied: null,
          localPressure: null,
          worldPressure: null,
          consumerEndingInventoryHosoEqTons: num((mp as unknown as { consumerInventoryTons?: unknown }).consumerInventoryTons),
          consumerInventoryCoverageMonths: num((mp as unknown as { inventoryCoverageMonths?: unknown }).inventoryCoverageMonths),
          marketPhase: String((mp as unknown as { marketPhase?: unknown }).marketPhase ?? ""),
        });
      }
      const vn = world.trueWorld.vietnamDomesticRawMaterial;
      market.push({
        turn,
        period,
        scope: "VIETNAM_DOMESTIC_RAW",
        key: "VN",
        product: "hoso",
        priceUsdPerKg: vn.priceUsdPerKg,
        priorPriceUsdPerKg: world.standardAiObservable.vietnamDomesticPriorPriceUsdPerKg,
        priceChangeRatio: null,
        demandHosoEqTons: vn.effectiveDemandTons,
        supplyHosoEqTons: vn.supplyTons,
        utilizationRatio: null,
        shockApplied: null,
        localPressure: null,
        worldPressure: null,
        consumerEndingInventoryHosoEqTons: null,
        consumerInventoryCoverageMonths: null,
        marketPhase: "",
      });
      for (const country of world.trueWorld.producerCountries) {
        market.push({
          turn,
          period,
          scope: "PRODUCER_COUNTRY",
          key: String((country as unknown as { country?: unknown }).country ?? ""),
          product: "hoso",
          priceUsdPerKg: num((country as unknown as { hosoFobPriceUsdPerKg?: unknown }).hosoFobPriceUsdPerKg),
          priorPriceUsdPerKg: null,
          priceChangeRatio: null,
          demandHosoEqTons: num((country as unknown as { allocatedDemandTons?: unknown }).allocatedDemandTons),
          supplyHosoEqTons: num((country as unknown as { exportableSupplyTons?: unknown }).exportableSupplyTons),
          utilizationRatio: num((country as unknown as { utilizationRatio?: unknown }).utilizationRatio),
          shockApplied: null,
          localPressure: null,
          worldPressure: null,
          consumerEndingInventoryHosoEqTons: null,
          consumerInventoryCoverageMonths: null,
          marketPhase: "",
        });
      }
      for (const event of world.scenarioEvents) {
        events.push({
          turn,
          period,
          companyId: "",
          eventCategory: "SCENARIO_EVENT",
          eventCode: event.eventId,
          detail: `${event.title} (startTurn=${event.startTurn}, durationTurns=${event.durationTurns}, magnitudeScale=${event.magnitudeScale})`,
          valueUsd: null,
        });
      }
    }
    const record = historyByTurn.get(turn);
    for (const reason of record?.globalReasonCodes ?? []) {
      events.push({ turn, period, companyId: reason.companyId ?? "", eventCategory: "GLOBAL_REASON", eventCode: reason.code, detail: reason.message, valueUsd: null });
    }
  }

  // ---- 会社×ターン ----
  for (const turn of turns) {
    const period = periodOf(turn);
    const quarter = quarterOf(turn);
    const record = historyByTurn.get(turn);
    const previousRecord = historyByTurn.get(turn - 1);

    for (const companyId of companyIds) {
      const pack = packByCompanyTurn.get(`${companyId}#${turn}`);
      const trace = traceByCompanyTurn.get(`${companyId}#${turn}`);
      const evaluation = evaluationByCompanyTurn.get(`${companyId}#${turn}`);
      const summary = record?.companySummaries.find((s) => s.companyId === companyId);
      const fin = record?.financialResults.find((f) => f.companyId === companyId);
      const financing = record?.financingResults.find((f) => f.companyId === companyId);
      const capex = record?.capexResults.find((c) => c.companyId === companyId);
      const dividendResult = record?.dividendResults?.find((d) => d.companyId === companyId);
      const decision: CompanyDecisionInput | undefined = record?.decisions.find((d) => d.companyId === companyId);
      const decisionOwner = pack?.decisionOwner ?? run.companyControlModes?.[companyId] ?? null;
      const bottleneck = bottleneckByCompanyTurn.get(`${companyId}#${turn}`);
      const managementProfileId = MANAGEMENT_PROFILE_BY_COMPANY_ID[companyId as CompanyId] ?? null;

      const revenue = metric(companyId, turn, "revenue");
      const operatingProfit = metric(companyId, turn, "operatingProfit");
      const outstanding = metric(companyId, turn, "outstandingQuantity");
      const overdue = summary ? num(summary.overdueQuantity) : null;
      const produced = PRODUCTS.map((p) => metric(companyId, turn, `${p}Produced` as CompanyMetricKey));
      const productionVolume = produced.every((v) => v === null) ? null : produced.reduce((s: number, v) => s + (v ?? 0), 0);

      // ---- 03_TURN_KPI（全ターン。dataset＋packCaptureが主源） ----
      turnKpi.push({
        simulationRunId: run.simulationRunId,
        scenarioId: run.scenarioId,
        companyId,
        turn,
        period,
        decisionOwner,
        revenueUsd: revenue,
        grossProfitUsd: fin ? num(fin.profitAndLoss.grossProfit) : null,
        operatingProfitUsd: operatingProfit,
        operatingMarginRatio: revenue !== null && revenue !== 0 && operatingProfit !== null ? operatingProfit / revenue : null,
        netIncomeUsd: metric(companyId, turn, "netIncome"),
        cashUsd: metric(companyId, turn, "cash"),
        accountsReceivableUsd: fin ? num(fin.balanceSheet.accountsReceivable) : null,
        accountsPayableUsd: fin ? num(fin.balanceSheet.accountsPayable) : null,
        shortTermDebtUsd: fin ? num(fin.balanceSheet.shortTermLoans) : null,
        longTermDebtUsd: fin ? num(fin.balanceSheet.longTermLoans) : null,
        interestBearingDebtUsd: metric(companyId, turn, "debt"),
        totalLiabilitiesUsd: fin ? num(fin.balanceSheet.totalLiabilities) : null,
        equityUsd: pack?.endingState.equityUsd ?? null,
        deliveredVolumeHosoEqTons: metric(companyId, turn, "fulfilledQuantity"),
        newOrdersHosoEqTons: metric(companyId, turn, "newContractedQuantity"),
        totalBacklogHosoEqTons: outstanding,
        overdueBacklogHosoEqTons: overdue,
        healthyForwardBacklogHosoEqTons: outstanding !== null && overdue !== null ? Math.max(0, outstanding - overdue) : null,
        productionVolumeHosoEqTons: productionVolume,
        hosoProducedHosoEqTons: produced[0],
        pdProducedHosoEqTons: produced[1],
        vapProducedHosoEqTons: produced[2],
        finishedGoodsInventoryHosoEqTons: metric(companyId, turn, "finishedGoodsInventory"),
        rawMaterialInventoryHosoEqTons: metric(companyId, turn, "rawMaterialInventory"),
        rawMaterialShortageHosoEqTons: metric(companyId, turn, "rawMaterialShortfall"),
        equipmentShortageHosoEqTons: metric(companyId, turn, "equipmentShortfall"),
        laborShortageHosoEqTons: metric(companyId, turn, "laborShortfall"),
        equipmentUtilizationRatio: metric(companyId, turn, "equipmentUtilizationRate"),
        laborUtilizationRatio: metric(companyId, turn, "laborUtilizationRate"),
        overtimeRatio: metric(companyId, turn, "overtimeRate"),
        regularWorkersHeadcount: pack?.salesOrganization ? null : null,
        temporaryWorkersHeadcount: dataset.hiringTrace.find((h) => h.turn === turn && h.companyId === companyId)?.totalTemporaryWorkers ?? null,
        salesForceHeadcount: metric(companyId, turn, "salesHeadcount") ?? salesHeadcountByCompanyTurn.get(`${companyId}#${turn}`) ?? null,
        averageCustomerTrustScore: null,
        averageQualityScore: null,
        onTimeDeliveryRatePercent: summary?.onTimeDeliveryRate ?? null,
        financialHealthPrimary: financing?.financialHealth.primary ?? null,
        dividendPaidUsd: dividendResult ? num(dividendResult.appliedDividendUsd) : null,
        companyValueUsd: evaluation?.currentCompanyValue.currentCompanyValueUsd ?? null,
        dividendValueUsd: evaluation?.currentDividendValueUsd ?? null,
        totalShareholderValueUsd: evaluation?.totalShareholderValueUsd ?? null,
      });

      // ---- 11_FINANCE_DETAIL（全ターン。詳細内訳はhistoryがある場合のみ） ----
      finance.push({
        companyId,
        turn,
        period,
        grossRevenueUsd: fin ? num(fin.profitAndLoss.grossRevenue) : null,
        netRevenueUsd: revenue,
        rawMaterialCostUsd: fin ? num(fin.profitAndLoss.costOfSales.rawMaterialCost) : null,
        processingCostUsd: fin ? num(fin.profitAndLoss.costOfSales.processingCost) : null,
        laborCostUsd: fin ? num(fin.profitAndLoss.costOfSales.laborCost) : fixedCost(companyId, turn, "regularLaborCost"),
        factoryFixedCostUsd: fin ? num(fin.profitAndLoss.costOfSales.factoryFixedCost) : fixedCost(companyId, turn, "factoryFixedCost"),
        idleLaborCostUsd: fin ? num(fin.profitAndLoss.costOfSales.idleLaborCost) : null,
        unabsorbedFixedManufacturingCostUsd: fin ? num(fin.profitAndLoss.costOfSales.unabsorbedFixedManufacturingCost) : null,
        reworkCostUsd: fin ? num(fin.profitAndLoss.costOfSales.reworkCost) : null,
        discardLossUsd: fin ? num(fin.profitAndLoss.costOfSales.discardLoss) : null,
        totalCostOfSalesUsd: fin ? num(fin.profitAndLoss.totalCostOfSales) : null,
        grossProfitUsd: fin ? num(fin.profitAndLoss.grossProfit) : null,
        sellingGeneralAdminUsd: fin ? num(fin.profitAndLoss.sellingGeneralAdmin) : fixedCost(companyId, turn, "fixedSellingAdminCost"),
        operatingProfitUsd: operatingProfit,
        interestExpenseUsd: fin ? num(fin.profitAndLoss.interestExpense) : null,
        profitBeforeTaxUsd: fin ? num(fin.profitAndLoss.profitBeforeTax) : null,
        incomeTaxUsd: fin ? num(fin.profitAndLoss.incomeTax) : null,
        netIncomeUsd: metric(companyId, turn, "netIncome"),
        cashUsd: metric(companyId, turn, "cash"),
        accountsReceivableUsd: fin ? num(fin.balanceSheet.accountsReceivable) : null,
        rawMaterialInventoryUsd: fin ? num(fin.balanceSheet.rawMaterialInventory) : null,
        finishedGoodsInventoryUsd: fin ? num(fin.balanceSheet.finishedGoodsInventory) : null,
        fixedAssetsNetUsd: fin ? num(fin.balanceSheet.fixedAssetsNet) : null,
        constructionInProgressUsd: fin ? num(fin.balanceSheet.constructionInProgress) : null,
        totalAssetsUsd: fin ? num(fin.balanceSheet.totalAssets) : null,
        accountsPayableUsd: fin ? num(fin.balanceSheet.accountsPayable) : null,
        shortTermLoansUsd: fin ? num(fin.balanceSheet.shortTermLoans) : null,
        longTermLoansUsd: fin ? num(fin.balanceSheet.longTermLoans) : null,
        totalLiabilitiesUsd: fin ? num(fin.balanceSheet.totalLiabilities) : null,
        equityUsd: pack?.endingState.equityUsd ?? null,
        operatingCashFlowUsd: fin ? num(fin.cashFlow.operatingCashFlow) : null,
        investingCashFlowUsd: fin ? num(fin.cashFlow.investingCashFlow) : null,
        financingCashFlowUsd: fin ? num(fin.cashFlow.financingCashFlow) : null,
        netCashChangeUsd: fin ? num(fin.cashFlow.netCashChange) : null,
        financialHealthPrimary: financing?.financialHealth.primary ?? null,
        creditScore: null,
      });

      // ---- 06_SALES_DETAIL（全ターン。dataset.salesTrace が主源） ----
      for (const st of dataset.salesTrace.filter((s) => s.turn === turn && s.companyId === companyId)) {
        const plan = decision?.salesPlans.find((p) => p.market === st.market && p.product === st.product);
        const contracts = (record?.salesRecord?.newContracts ?? []).filter((c) => c.companyId === companyId && c.market === st.market && c.product === st.product);
        const contractedTons = contracts.reduce((s, c) => s + (num(c.originalQuantity) ?? 0), 0);
        const contractedValue = contracts.reduce((s, c) => s + (num(c.originalQuantity) ?? 0) * (num(c.unitPrice) ?? 0), 0);
        const allocation = record?.salesRecord?.allocations.find((a) => a.market === st.market && a.product === st.product);
        sales.push({
          companyId,
          turn,
          period,
          market: st.market,
          product: st.product,
          desiredSalesBeforeEffortHosoEqTons: st.wishedQuantity,
          proposedSalesHosoEqTons: st.plannedQuantity,
          actualContractsHosoEqTons: st.contractedQuantity,
          offeredPriceAdjustmentUsdPerKg: plan ? num(plan.priceAdjustmentUsdPerHosoEqKg) : null,
          realizedPriceUsdPerKg: contractedTons > 0 ? contractedValue / contractedTons : null,
          marketBasePriceUsdPerKg: allocation ? num(allocation.basePrice) : null,
          targetDemandHosoEqTons: allocation ? num(allocation.targetDemand) : null,
          salesForceAllocationHeadcount: dataset.salesAllocation.find((a) => a.turn === turn && a.companyId === companyId && a.market === st.market)?.headcount ?? null,
          customerTrustScore: num((summary?.customerTrustByMarket as Readonly<Record<string, number>> | undefined)?.[st.market]),
          qualityScore: num((summary?.qualityScoreByProduct as Readonly<Record<string, number>> | undefined)?.[st.product]),
          newContractCount: record ? contracts.length : null,
        });
      }

      // ---- 07_PRODUCTION_DETAIL（historyがあるTurnのみ工場×商品の内訳が取れる） ----
      for (const entry of record?.productionAllocation?.entries ?? []) {
        if (entry.companyId !== companyId) continue;
        production.push({
          companyId,
          turn,
          period,
          factoryId: entry.factoryId,
          product: entry.product,
          productionPriority: num(entry.priority),
          plannedProductionHosoEqTons: num(entry.desiredQuantity),
          actualProductionHosoEqTons: num(entry.allocatedQuantity),
          shortfallHosoEqTons: num(entry.shortfallQuantity),
          shortfallReasons: entry.shortfallReasons.join("|"),
          requiredRawMaterialHosoEqTons: num(entry.requiredRawMaterialQuantity),
          rawMaterialLimitedHosoEqTons: num(entry.stages.rawMaterialLimited),
          commonCapacityLimitedHosoEqTons: num(entry.stages.commonCapacityLimited),
          freezingPackagingLimitedHosoEqTons: num(entry.stages.freezingPackagingLimited),
          productCapacityLimitedHosoEqTons: num(entry.stages.productCapacityLimited),
          laborLimitedHosoEqTons: num(entry.stages.laborLimited),
          assignedRegularHeadcount: num(entry.labor.assignedRegularHeadcount),
          assignedTemporaryHeadcount: num(entry.labor.assignedTemporaryHeadcount),
          appliedOvertimeRatio: num(entry.labor.appliedOvertimeRate),
        });
      }
      // 工場別内訳が無いTurnでも、商品別の計画/実績/不足は全ターン残す。
      if (!record) {
        for (const product of PRODUCTS) {
          production.push({
            companyId,
            turn,
            period,
            factoryId: "",
            product,
            productionPriority: null,
            plannedProductionHosoEqTons: null,
            actualProductionHosoEqTons: metric(companyId, turn, `${product}Produced` as CompanyMetricKey),
            shortfallHosoEqTons: null,
            shortfallReasons: "",
            requiredRawMaterialHosoEqTons: null,
            rawMaterialLimitedHosoEqTons: null,
            commonCapacityLimitedHosoEqTons: null,
            freezingPackagingLimitedHosoEqTons: null,
            productCapacityLimitedHosoEqTons: null,
            laborLimitedHosoEqTons: null,
            assignedRegularHeadcount: null,
            assignedTemporaryHeadcount: null,
            appliedOvertimeRatio: null,
          });
        }
      }

      // ---- 08_PROCUREMENT_DETAIL（全ターン。国内買付量はdatasetにある） ----
      const domesticEntry = record?.domesticAllocation?.companies.find((c) => c.companyId === companyId);
      procurement.push({
        companyId,
        turn,
        period,
        source: "DOMESTIC",
        originCountry: "VN",
        plannedHosoEqTons: pack?.commercialGrowth ? null : null,
        actualHosoEqTons: metric(companyId, turn, "domesticPurchaseQuantity"),
        priceUsdPerKg: domesticEntry ? num(domesticEntry.bidPrice) : summary ? num(summary.domesticPurchasePrice) : null,
        marketPriceUsdPerKg: worldByTurn.get(turn)?.trueWorld.vietnamDomesticRawMaterial.priceUsdPerKg ?? null,
        arrivalPeriod: period,
        inTransitHosoEqTons: null,
        rawMaterialEndingInventoryHosoEqTons: metric(companyId, turn, "rawMaterialInventory"),
        coverageScore: domesticEntry ? num(domesticEntry.coverageScore) : null,
        competitivenessWeight: domesticEntry ? num(domesticEntry.competitivenessWeight) : null,
      });
      procurement.push({
        companyId,
        turn,
        period,
        source: "IMPORT",
        originCountry: "",
        plannedHosoEqTons: decision ? decision.importOrders.reduce((s, o) => s + (num(o.orderedQuantity) ?? 0), 0) : null,
        actualHosoEqTons: summary ? num(summary.importArrivedQuantity) : null,
        priceUsdPerKg: null,
        marketPriceUsdPerKg: null,
        arrivalPeriod: "",
        inTransitHosoEqTons: summary ? num(summary.importInTransitQuantity) : null,
        rawMaterialEndingInventoryHosoEqTons: metric(companyId, turn, "rawMaterialInventory"),
        coverageScore: null,
        competitivenessWeight: null,
      });
      procurement.push({
        companyId,
        turn,
        period,
        source: "AQUACULTURE",
        originCountry: "VN",
        plannedHosoEqTons: decision?.aquacultureStockingPlans?.[0] ? num(decision.aquacultureStockingPlans[0].plannedStockingQuantity) : null,
        actualHosoEqTons: summary ? num(summary.aquacultureHarvestedQuantity) : null,
        priceUsdPerKg: null,
        marketPriceUsdPerKg: null,
        arrivalPeriod: "",
        inTransitHosoEqTons: summary ? num(summary.aquacultureGrowingQuantity) : null,
        rawMaterialEndingInventoryHosoEqTons: metric(companyId, turn, "rawMaterialInventory"),
        coverageScore: null,
        competitivenessWeight: null,
      });

      // ---- 09_WORKFORCE_DETAIL / 15_FACTORY_CAPACITY ----
      const hiring = dataset.hiringTrace.find((h) => h.turn === turn && h.companyId === companyId);
      const capacitySnapshot = capacityByCompanyTurn.get(`${companyId}#${turn}`);
      const factoryLoads = record?.factoryLoadMetrics.filter((m) => m.companyId === companyId) ?? [];
      if (factoryLoads.length > 0) {
        for (const load of factoryLoads) {
          const assignment = decision?.workerAssignments.find((w) => w.factoryId === load.factoryId);
          workforce.push({
            companyId,
            turn,
            period,
            factoryId: load.factoryId,
            regularWorkersHeadcount: assignment ? num(assignment.regularHeadcount) : null,
            temporaryWorkersHeadcount: assignment ? num(assignment.temporaryHeadcount) : null,
            overtimeRatio: num(load.overtimeRate),
            attendanceRatio: assignment ? num(assignment.attendanceRate) : null,
            equipmentUtilizationRatio: num(load.equipmentUtilizationRate),
            laborUtilizationRatio: num(load.laborUtilizationRate),
            temporaryWorkerShareRatio: num(load.temporaryWorkerShare),
            productionShortfallRatio: num(load.productionShortfallRate),
            companyLaborCostUsd: fin ? num(fin.profitAndLoss.costOfSales.laborCost) : fixedCost(companyId, turn, "regularLaborCost"),
            companyIdleLaborCostUsd: fin ? num(fin.profitAndLoss.costOfSales.idleLaborCost) : null,
            companySalesForceHireCount: hiring?.salesForceHireCount ?? null,
            companySalesForceLayoffCount: hiring?.salesForceLayoffCount ?? null,
          });
        }
      } else {
        workforce.push({
          companyId,
          turn,
          period,
          factoryId: "",
          regularWorkersHeadcount: null,
          temporaryWorkersHeadcount: hiring?.totalTemporaryWorkers ?? null,
          overtimeRatio: metric(companyId, turn, "overtimeRate"),
          attendanceRatio: null,
          equipmentUtilizationRatio: metric(companyId, turn, "equipmentUtilizationRate"),
          laborUtilizationRatio: metric(companyId, turn, "laborUtilizationRate"),
          temporaryWorkerShareRatio: null,
          productionShortfallRatio: null,
          companyLaborCostUsd: fixedCost(companyId, turn, "regularLaborCost"),
          companyIdleLaborCostUsd: null,
          companySalesForceHireCount: hiring?.salesForceHireCount ?? null,
          companySalesForceLayoffCount: hiring?.salesForceLayoffCount ?? null,
        });
      }

      const fixtureFactories = fixtureById.get(companyId)?.factories ?? [];
      const factoryIds = factoryLoads.length > 0 ? factoryLoads.map((l) => l.factoryId) : fixtureFactories.map((f) => f.factoryId);
      for (const factoryId of factoryIds) {
        const load = factoryLoads.find((l) => l.factoryId === factoryId);
        const fixtureFactory = fixtureFactories.find((f) => f.factoryId === factoryId);
        factoryCapacity.push({
          companyId,
          turn,
          period,
          factoryId,
          factoryStatus: fixtureFactory ? String(fixtureFactory.status) : "",
          factorySource: fixtureFactory ? "INITIAL_FIXTURE" : "BUILT_DURING_RUN",
          commonProcessingCapacityHosoEqTons: fixtureFactory ? num(fixtureFactory.commonProcessingCapacity) : null,
          freezingPackagingCapacityHosoEqTons: fixtureFactory ? num(fixtureFactory.freezingPackagingCapacity) : null,
          hosoCapacityHosoEqTons: fixtureFactory ? num(fixtureFactory.hosoCapacity) : null,
          pdCapacityHosoEqTons: fixtureFactory ? num(fixtureFactory.pdCapacity) : null,
          vapCapacityHosoEqTons: fixtureFactory ? num(fixtureFactory.vapCapacity) : null,
          equipmentUtilizationRatio: load ? num(load.equipmentUtilizationRate) : null,
          laborUtilizationRatio: load ? num(load.laborUtilizationRate) : null,
          companyEffectiveHosoCapacityHosoEqTons: capacitySnapshot ? num(capacitySnapshot.hoso) : metric(companyId, turn, "hosoCapacity"),
          companyEffectivePdCapacityHosoEqTons: capacitySnapshot ? num(capacitySnapshot.pd) : metric(companyId, turn, "pdCapacity"),
          companyEffectiveVapCapacityHosoEqTons: capacitySnapshot ? num(capacitySnapshot.vap) : metric(companyId, turn, "vapCapacity"),
          companyEffectiveCommonCapacityHosoEqTons: capacitySnapshot ? num(capacitySnapshot.commonProcessing) : metric(companyId, turn, "commonCapacity"),
        });
      }

      // ---- 14_DIVIDEND_DETAIL（全ターン） ----
      const previousFin = previousRecord?.financialResults.find((f) => f.companyId === companyId);
      const profileBias = managementProfileId ? MANAGEMENT_PROFILES[managementProfileId].dividendPropensityRatio : null;
      const dividendReasonCodes = (trace?.constrained ?? []).map((i) => i.label).filter((l) => l.includes("DIVIDEND_")).join("|");
      dividend.push({
        companyId,
        turn,
        period,
        isAnnualEvaluationPeriod: quarter === null ? "" : quarter === 4 ? "TRUE" : "FALSE",
        financialHealthPrimary: previousRecord?.financingResults.find((f) => f.companyId === companyId)?.financialHealth.primary ?? null,
        newCapexProposalCount: decision?.capexDecision?.newProjectProposals?.length ?? (pack ? pack.capitalProjects.filter((p) => p.status === "proposed").length : null),
        netIncomeSourcePeriod: turn - 1 >= 1 ? periodOf(turn - 1) : "",
        netIncomeUsd: previousFin ? num(previousFin.profitAndLoss.netIncome) : metric(companyId, turn - 1, "netIncome"),
        distributableEarningsAfterUsd: dividendResult ? num(dividendResult.distributableEarningsAfterUsd) : null,
        basePayoutRatio: STANDARD_AI_PARAMETERS_V1.dividendBasePayoutRatio,
        profileBiasRatio: profileBias,
        effectivePayoutRatio: profileBias === null ? null : STANDARD_AI_PARAMETERS_V1.dividendBasePayoutRatio * (1 + profileBias),
        maxDividendUsd: dividendResult ? num(dividendResult.maxDividendUsd) : null,
        requestedDividendUsd: dividendResult ? num(dividendResult.requestedDividendUsd) : decision ? num(decision.dividendDecision?.dividendAmountUsd) ?? 0 : null,
        appliedDividendUsd: dividendResult ? num(dividendResult.appliedDividendUsd) : null,
        rejected: dividendResult ? (dividendResult.rejected ? "TRUE" : "FALSE") : "",
        rejectionReason: dividendResult?.rejectionReason ?? "",
        cumulativeDividendUsd: dividendResult ? num(dividendResult.cumulativeDividendUsd) : null,
        diagnosticReasonCodes: dividendReasonCodes,
      });

      // ---- 04_STANDARD_AI_DECISIONS（全ターン。packCaptureのcommercialGrowth/salesOrganizationが主源） ----
      const crisisInfluence = (trace?.constrained ?? []).some((i) => i.label.includes("CRISIS_")) ? "CRISIS_SIGNAL_PRESENT" : "";
      const visionInfluence = pack?.strategy?.growthPressure ?? "";
      const profileInfluence = managementProfileId ?? "";
      const pushDecision = (row: Omit<AuditDecisionRow, "companyId" | "turn" | "period" | "decisionOwner">) => decisions.push({ companyId, turn, period, decisionOwner, ...row });
      const compare = (proposed: number | null, actual: number | null): { wasApplied: string; wasModified: string } => {
        if (proposed === null || actual === null) return { wasApplied: "", wasModified: "" };
        const same = Math.abs(proposed - actual) <= Math.max(1e-6, Math.abs(proposed) * 1e-9);
        return { wasApplied: actual > 0 || proposed === 0 ? "TRUE" : "FALSE", wasModified: same ? "FALSE" : "TRUE" };
      };

      const submitted = pack?.commercialGrowth?.submittedSalesTons ?? null;
      const contracted = pack?.commercialGrowth?.contractedSalesTons ?? metric(companyId, turn, "newContractedQuantity");
      pushDecision({
        decisionDomain: "SALES",
        decisionType: "TOTAL_SALES_PLAN",
        market: "",
        product: "",
        factoryId: "",
        proposedValue: submitted,
        proposedUnit: "HosoEqTons",
        actualAppliedValue: contracted,
        actualAppliedUnit: "HosoEqTons",
        ...compare(submitted, contracted),
        reasonCode: pack?.commercialGrowth?.commitmentLimiter ?? "",
        primaryReason: pack?.commercialGrowth?.primaryGrowthConstraint ?? "",
        profileInfluence,
        visionInfluence,
        crisisInfluence,
      });
      for (const st of dataset.salesTrace.filter((s) => s.turn === turn && s.companyId === companyId)) {
        pushDecision({
          decisionDomain: "SALES",
          decisionType: "SALES_PLAN_BY_MARKET_PRODUCT",
          market: st.market,
          product: st.product,
          factoryId: "",
          proposedValue: st.plannedQuantity,
          proposedUnit: "HosoEqTons",
          actualAppliedValue: st.contractedQuantity,
          actualAppliedUnit: "HosoEqTons",
          ...compare(st.plannedQuantity, st.contractedQuantity),
          reasonCode: "",
          primaryReason: "",
          profileInfluence,
          visionInfluence,
          crisisInfluence,
        });
      }
      for (const product of PRODUCTS) {
        const proposedProduction = decision ? decision.productionPlans.filter((p) => p.product === product).reduce((s, p) => s + (num(p.desiredQuantity) ?? 0), 0) : null;
        pushDecision({
          decisionDomain: "PRODUCTION",
          decisionType: "PRODUCTION_PLAN",
          market: "",
          product,
          factoryId: "",
          proposedValue: proposedProduction,
          proposedUnit: "HosoEqTons",
          actualAppliedValue: metric(companyId, turn, `${product}Produced` as CompanyMetricKey),
          actualAppliedUnit: "HosoEqTons",
          ...compare(proposedProduction, metric(companyId, turn, `${product}Produced` as CompanyMetricKey)),
          reasonCode: bottleneck ? bottleneck.primary : "",
          primaryReason: "",
          profileInfluence,
          visionInfluence,
          crisisInfluence,
        });
      }
      pushDecision({
        decisionDomain: "PROCUREMENT",
        decisionType: "DOMESTIC_PURCHASE",
        market: "",
        product: "",
        factoryId: "",
        proposedValue: decision ? num(decision.domesticPurchasePlan?.desiredQuantity) : null,
        proposedUnit: "HosoEqTons",
        actualAppliedValue: metric(companyId, turn, "domesticPurchaseQuantity"),
        actualAppliedUnit: "HosoEqTons",
        ...compare(decision ? num(decision.domesticPurchasePlan?.desiredQuantity) : null, metric(companyId, turn, "domesticPurchaseQuantity")),
        reasonCode: "",
        primaryReason: "",
        profileInfluence,
        visionInfluence,
        crisisInfluence,
      });
      pushDecision({
        decisionDomain: "WORKFORCE",
        decisionType: "SALES_FORCE_HIRE",
        market: "",
        product: "",
        factoryId: "",
        proposedValue: pack?.salesOrganization?.actualTargetHeadcount ?? hiring?.salesForceHireCount ?? null,
        proposedUnit: "Headcount",
        actualAppliedValue: hiring?.salesForceHireCount ?? null,
        actualAppliedUnit: "Headcount",
        wasApplied: "",
        wasModified: "",
        reasonCode: pack?.salesOrganization?.constraintReason ?? "",
        primaryReason: "",
        profileInfluence,
        visionInfluence,
        crisisInfluence,
      });
      pushDecision({
        decisionDomain: "FINANCE",
        decisionType: "BORROWING_REQUEST",
        market: "",
        product: "",
        factoryId: "",
        proposedValue: decision ? num(decision.financingRequest?.desiredAmountUsd) ?? 0 : null,
        proposedUnit: "Usd",
        actualAppliedValue: metric(companyId, turn, "debt"),
        actualAppliedUnit: "Usd",
        wasApplied: "",
        wasModified: "",
        reasonCode: "",
        primaryReason: "ACTUAL_COLUMN_IS_ENDING_DEBT_BALANCE_NOT_NEW_BORROWING",
        profileInfluence,
        visionInfluence,
        crisisInfluence,
      });
      for (const investment of dataset.investmentTrace.filter((i) => i.turn === turn && i.companyId === companyId)) {
        pushDecision({
          decisionDomain: "CAPEX",
          decisionType: investment.projectType,
          market: "",
          product: "",
          factoryId: "",
          proposedValue: investment.budgetUsd,
          proposedUnit: "Usd",
          actualAppliedValue: investment.status === "cancelled" ? 0 : investment.budgetUsd,
          actualAppliedUnit: "Usd",
          wasApplied: investment.status === "cancelled" ? "FALSE" : "TRUE",
          wasModified: investment.status === "cancelled" ? "TRUE" : "FALSE",
          reasonCode: investment.status,
          primaryReason: investment.note ?? pack?.strategy?.newFactory?.status ?? "",
          profileInfluence,
          visionInfluence,
          crisisInfluence,
        });
      }
      const proposedDividend = decision ? num(decision.dividendDecision?.dividendAmountUsd) ?? 0 : null;
      const appliedDividend = dividendResult ? num(dividendResult.appliedDividendUsd) : null;
      pushDecision({
        decisionDomain: "DIVIDEND",
        decisionType: "DIVIDEND",
        market: "",
        product: "",
        factoryId: "",
        proposedValue: proposedDividend,
        proposedUnit: "Usd",
        actualAppliedValue: appliedDividend,
        actualAppliedUnit: "Usd",
        ...compare(proposedDividend, appliedDividend),
        reasonCode: dividendReasonCodes,
        primaryReason: dividendResult?.rejectionReason ?? "",
        profileInfluence,
        visionInfluence,
        crisisInfluence,
      });
      if (decision) {
        pushDecision({
          decisionDomain: "VAP_PRODUCT_DEVELOPMENT",
          decisionType: "VAP_DEVELOPMENT_SPEND",
          market: "",
          product: "vap",
          factoryId: "",
          proposedValue: num(decision.vapProductDevelopmentSpendUsd) ?? 0,
          proposedUnit: "Usd",
          actualAppliedValue: num(decision.vapProductDevelopmentSpendUsd) ?? 0,
          actualAppliedUnit: "Usd",
          wasApplied: "TRUE",
          wasModified: "FALSE",
          reasonCode: "",
          primaryReason: "",
          profileInfluence,
          visionInfluence,
          crisisInfluence,
        });
      }

      // ---- 05_DECISION_DIAGNOSTICS（全ターン。dataset.aiTrace が主源） ----
      for (const fact of dataset.aiTrace.filter((f) => f.turn === turn && f.companyId === companyId)) {
        for (const item of fact.items) {
          const codeMatch = /^\[(info|warning|critical)\]\s+(.+)$/.exec(item.label);
          diagnostics.push({
            companyId,
            turn,
            period,
            source: fact.stage === "RESULT" ? "ENGINE_RESULT" : "STANDARD_AI_TRACE",
            stage: fact.stage,
            domain: "",
            reasonCode: codeMatch ? codeMatch[2] : "",
            severity: codeMatch ? codeMatch[1] : "",
            label: codeMatch ? "" : item.label,
            observedValue: item.value ?? null,
            unit: item.unit ?? "",
            message: item.text ?? "",
          });
        }
      }

      // ---- 19_AI_PROFILE_VISION ----
      if (pack) {
        profileVision.push({
          companyId,
          turn,
          period,
          managementProfileId,
          orientationProfileId: COMPANY_ORIENTATION_BY_COMPANY_ID[companyId as CompanyId] ?? null,
          visionId: pack.strategy?.vision?.visionId ?? null,
          visionSource: pack.strategy?.vision?.source ?? null,
          visionStrategicPosture: pack.strategy?.vision?.strategicPosture ?? null,
          visionTargetScaleAtCurrentTurnTons: pack.strategy?.visionTargetScaleAtCurrentTurn ?? null,
          currentSustainableScaleTons: pack.strategy?.currentSustainableScaleTons ?? null,
          strategicScaleGapTons: pack.strategy?.strategicScaleGapTons ?? null,
          strategicScaleGapRatio: pack.strategy?.strategicScaleGapRatio ?? null,
          growthPressure: pack.strategy?.growthPressure ?? null,
          newFactoryStatus: pack.strategy?.newFactory?.status ?? null,
          newFactoryReasonCodes: (pack.strategy?.newFactory?.reasonCodes ?? []).join("|"),
          commercialAmbitionTons: pack.commercialGrowth?.commercialAmbitionTons ?? null,
          commercialCommitmentTons: pack.commercialGrowth?.commercialCommitmentTons ?? null,
          submittedSalesTons: pack.commercialGrowth?.submittedSalesTons ?? null,
          contractedSalesTons: pack.commercialGrowth?.contractedSalesTons ?? null,
          deliveredSalesTons: pack.commercialGrowth?.deliveredSalesTons ?? null,
          primaryGrowthConstraint: pack.commercialGrowth?.primaryGrowthConstraint ?? null,
          commitmentLimiter: pack.commercialGrowth?.commitmentLimiter ?? null,
          salesForceCurrentHeadcount: pack.salesOrganization?.currentHeadcount ?? null,
          salesForceRequiredHeadcount: pack.salesOrganization?.requiredHeadcount ?? null,
          salesForceConstraintReason: pack.salesOrganization?.constraintReason ?? null,
        });
      }

      // ---- 18_EVENT_LOG（会社側） ----
      for (const investment of dataset.investmentTrace.filter((i) => i.turn === turn && i.companyId === companyId)) {
        events.push({ turn, period, companyId, eventCategory: "CAPEX", eventCode: `${investment.projectType}:${investment.status}`, detail: `${investment.projectId} ${investment.note ?? ""}`.trim(), valueUsd: investment.budgetUsd });
      }
      for (const event of capex?.events ?? []) {
        if (event.statusBefore === event.statusAfter && event.paymentSucceededUsd === 0) continue;
        events.push({ turn, period, companyId, eventCategory: "CAPEX_PAYMENT", eventCode: `${event.projectType}:${event.statusBefore}->${event.statusAfter}`, detail: `${event.projectId} ${event.reasons.join("|")}`, valueUsd: num(event.paymentSucceededUsd) });
      }
      if (dividendResult && (num(dividendResult.appliedDividendUsd) ?? 0) > 0) {
        events.push({ turn, period, companyId, eventCategory: "DIVIDEND", eventCode: "DIVIDEND_PAID", detail: "", valueUsd: num(dividendResult.appliedDividendUsd) });
      }
      if (financing && financing.financialHealth.primary !== "healthy") {
        events.push({ turn, period, companyId, eventCategory: "FINANCIAL_HEALTH", eventCode: financing.financialHealth.primary, detail: "", valueUsd: null });
      }
    }
  }

  // ---------------- 10_CAPEX_DETAIL ----------------
  const capexByProject = new Map<string, AuditCapexRow>();
  for (const pack of packTurns.filter((p) => p.turn <= asOfTurn).sort((a, b) => a.turn - b.turn)) {
    for (const project of pack.capitalProjects) {
      const key = `${pack.companyId}#${project.projectId}`;
      const existing = capexByProject.get(key);
      capexByProject.set(key, {
        companyId: pack.companyId,
        projectId: project.projectId,
        projectType: project.projectType,
        targetFactoryId: project.targetFactoryId ?? "",
        status: project.status,
        firstSeenTurn: existing?.firstSeenTurn ?? pack.turn,
        proposalTurn: existing?.proposalTurn ?? (project.status === "proposed" ? pack.turn : null),
        approvalTurn: existing?.approvalTurn ?? (project.status === "approved" ? pack.turn : null),
        constructionStartTurn: existing?.constructionStartTurn ?? (project.status === "underConstruction" ? pack.turn : null),
        completionTurn: existing?.completionTurn ?? (project.status === "completed" ? pack.turn : null),
        approvedBudgetUsd: project.approvedBudgetUsd,
        cumulativePaidUsd: project.cumulativePaidUsd,
        requiredConstructionQuarters: project.requiredConstructionQuarters,
        elapsedConstructionQuartersWithPayment: project.elapsedConstructionQuartersWithPayment,
        completedYear: project.completedYear,
        completedQuarter: project.completedQuarter,
        standardAiReasonCodes:
          existing?.standardAiReasonCodes ||
          dataset.investmentTrace.find((i) => i.companyId === pack.companyId && i.projectId === project.projectId && i.note)?.note ||
          "",
      });
    }
  }
  const capexRows: AuditCapexRow[] = [...capexByProject.values()].sort((a, b) =>
    a.companyId === b.companyId ? (a.firstSeenTurn ?? 0) - (b.firstSeenTurn ?? 0) : a.companyId.localeCompare(b.companyId)
  );
  if (capexRows.length === 0) {
    for (const investment of dataset.investmentTrace.filter((i) => i.turn <= asOfTurn)) {
      const key = `${investment.companyId}#${investment.projectId}`;
      if (capexByProject.has(key)) continue;
      capexByProject.set(key, {
        companyId: investment.companyId,
        projectId: investment.projectId,
        projectType: investment.projectType,
        targetFactoryId: "",
        status: investment.status,
        firstSeenTurn: investment.turn,
        proposalTurn: null,
        approvalTurn: null,
        constructionStartTurn: null,
        completionTurn: investment.status === "completed" ? investment.turn : null,
        approvedBudgetUsd: investment.budgetUsd,
        cumulativePaidUsd: null,
        requiredConstructionQuarters: null,
        elapsedConstructionQuartersWithPayment: null,
        completedYear: null,
        completedQuarter: null,
        standardAiReasonCodes: investment.note ?? "",
      });
    }
    capexRows.push(...[...capexByProject.values()]);
  }

  // ---------------- 12_BACKLOG_DETAIL ----------------
  const backlog: AuditBacklogRow[] = [];
  const asOfPeriod = periodOf(asOfTurn);
  const asOfOrdinal = periodOrdinalFromLabel(asOfPeriod);
  const contracts = resume?.state?.contracts ?? [];
  if (contracts.length === 0) {
    missingDataNotes.push("No outstanding sales contracts were available in the saved state; 12_BACKLOG_DETAIL is empty. Per-turn backlog and overdue totals remain available in 03_TURN_KPI.");
  }
  const backlogGroups = new Map<string, { outstanding: number; count: number; earliest: string; latest: string; valueSum: number }>();
  for (const contract of contracts) {
    const outstanding = num(contract.outstandingQuantity) ?? 0;
    if (outstanding <= 0) continue;
    const due = String(contract.dueDate);
    const dueOrdinal = periodOrdinalFromLabel(due);
    const dueStatus: BacklogDueStatus =
      asOfOrdinal === null || dueOrdinal === null ? "FUTURE_DUE" : dueOrdinal < asOfOrdinal ? "OVERDUE" : dueOrdinal === asOfOrdinal ? "DUE_THIS_TURN" : "FUTURE_DUE";
    const key = `${contract.companyId}#${contract.market}#${contract.product}#${dueStatus}`;
    const prior = backlogGroups.get(key);
    backlogGroups.set(key, {
      outstanding: (prior?.outstanding ?? 0) + outstanding,
      count: (prior?.count ?? 0) + 1,
      earliest: prior === undefined || (periodOrdinalFromLabel(due) ?? 0) < (periodOrdinalFromLabel(prior.earliest) ?? 0) ? due : prior.earliest,
      latest: prior === undefined || (periodOrdinalFromLabel(due) ?? 0) > (periodOrdinalFromLabel(prior.latest) ?? 0) ? due : prior.latest,
      valueSum: (prior?.valueSum ?? 0) + outstanding * (num(contract.unitPrice) ?? 0),
    });
  }
  for (const [key, group] of backlogGroups) {
    const [companyId, marketKey, productKey, dueStatus] = key.split("#");
    backlog.push({
      companyId,
      asOfTurn,
      asOfPeriod,
      market: marketKey as DemandMarketId,
      product: productKey as Product,
      dueStatus: dueStatus as BacklogDueStatus,
      outstandingHosoEqTons: group.outstanding,
      contractCount: group.count,
      earliestDuePeriod: group.earliest,
      latestDuePeriod: group.latest,
      averageUnitPriceUsdPerKg: group.outstanding > 0 ? group.valueSum / group.outstanding : null,
    });
  }

  // ---------------- 02_COMPANY_SUMMARY / 16_FINAL_RESULTS ----------------
  const finalSnapshots = computeAllCompaniesEvaluationSnapshot(evaluationHistory as never, companyIds as readonly CompanyId[], asOfTurn);
  const ranked = rankCompaniesByTotalShareholderValue(finalSnapshots);
  const rankByCompany = new Map(ranked.map((s, index) => [s.companyId as string, index + 1]));

  const sumMetric = (companyId: string, key: CompanyMetricKey): number | null => {
    let total: number | null = null;
    for (const turn of turns) {
      const value = metric(companyId, turn, key);
      if (value === null) continue;
      total = (total ?? 0) + value;
    }
    return total;
  };

  const companySummary: AuditCompanySummaryRow[] = companyIds.map((companyId) => {
    const snapshot = finalSnapshots.find((s) => s.companyId === companyId);
    const lastTurn = turns[turns.length - 1];
    const lastPack = packTurns.filter((p) => p.companyId === companyId && p.turn <= asOfTurn).sort((a, b) => b.turn - a.turn)[0];
    const profile = companyProfiles.find((p) => p.companyId === companyId);
    const cumulativeRevenue = sumMetric(companyId, "revenue");
    const cumulativeOperatingProfit = sumMetric(companyId, "operatingProfit");
    return {
      companyId,
      displayName: displayNameById.get(companyId) ?? "",
      asOfTurn,
      // dataset は全ターンを持つため、KPIの累計はこちらを正とする（evaluation service は
      // 間引かれた history しか見られないTurnがあるため過小になりうる）。
      cumulativeRevenueUsd: cumulativeRevenue,
      cumulativeOperatingProfitUsd: cumulativeOperatingProfit,
      averageOperatingMarginRatio: cumulativeRevenue !== null && cumulativeRevenue !== 0 && cumulativeOperatingProfit !== null ? cumulativeOperatingProfit / cumulativeRevenue : null,
      cumulativeSalesVolumeHosoEqTons: sumMetric(companyId, "fulfilledQuantity"),
      endingCashUsd: lastTurn === undefined ? null : metric(companyId, lastTurn, "cash"),
      endingDebtUsd: lastTurn === undefined ? null : metric(companyId, lastTurn, "debt"),
      endingEquityUsd: lastPack?.endingState.equityUsd ?? null,
      distressTurnCount: snapshot?.kpis.distressTurnCount ?? null,
      cumulativeDividendUsd: snapshot?.kpis.cumulativeDividendUsd ?? null,
      revenueGrowthRatio: snapshot?.kpis.revenueGrowthRatio ?? null,
      profitGrowthRatio: snapshot?.kpis.profitGrowthRatio ?? null,
      currentCompanyValueUsd: snapshot?.currentCompanyValue.currentCompanyValueUsd ?? null,
      currentDividendValueUsd: snapshot?.currentDividendValueUsd ?? null,
      totalShareholderValueUsd: snapshot?.totalShareholderValueUsd ?? null,
      factoryCount: lastPack?.endingState.factoryCount ?? null,
      finalRegularWorkers: null,
      finalSalesForceHeadcount: lastPack?.endingState.salesHeadcount ?? (lastTurn === undefined ? null : metric(companyId, lastTurn, "salesHeadcount")),
      finalBacklogHosoEqTons: lastPack?.endingState.backlogTons ?? (lastTurn === undefined ? null : metric(companyId, lastTurn, "outstandingQuantity")),
      finalOverdueHosoEqTons: null,
      visionId: profile?.visionId ?? null,
      visionStrategicPosture: profile?.visionStrategicPosture ?? null,
      managementProfileId: profile?.managementProfileId ?? null,
    };
  });

  const finalResults: AuditFinalResultRow[] = finalSnapshots.map((snapshot) => ({
    rank: rankByCompany.get(snapshot.companyId as string) ?? null,
    companyId: snapshot.companyId as string,
    displayName: displayNameById.get(snapshot.companyId as string) ?? "",
    asOfTurn: snapshot.asOfTurn,
    totalShareholderValueUsd: snapshot.totalShareholderValueUsd,
    currentCompanyValueUsd: snapshot.currentCompanyValue.currentCompanyValueUsd,
    currentDividendValueUsd: snapshot.currentDividendValueUsd,
    enterpriseValueUsd: snapshot.currentCompanyValue.enterpriseValueUsd,
    normalizedQuarterlyCashFlowUsd: snapshot.currentCompanyValue.normalizedQuarterlyCashFlowUsd,
    cashUsd: snapshot.currentCompanyValue.cashUsd,
    debtUsd: snapshot.currentCompanyValue.debtUsd,
    cumulativeRevenueUsd: snapshot.kpis.cumulativeRevenueUsd,
    cumulativeOperatingProfitUsd: snapshot.kpis.cumulativeOperatingProfitUsd,
    cumulativeSalesVolumeHosoEqTons: snapshot.kpis.cumulativeSalesVolumeHosoEqTons,
    averageOperatingMarginRatio: snapshot.kpis.averageOperatingMarginRatio,
    revenueGrowthRatio: snapshot.kpis.revenueGrowthRatio,
    profitGrowthRatio: snapshot.kpis.profitGrowthRatio,
    distressTurnCount: snapshot.kpis.distressTurnCount,
    cumulativeDividendUsd: snapshot.kpis.cumulativeDividendUsd,
    shareholderValueModelVersion: snapshot.shareholderValueModelVersion,
    finalSnapshotSource: turns.every((t) => evaluationTurnsForNotes.has(t))
      ? "RECOMPUTED_FROM_ALL_TURN_EVALUATION_HISTORY"
      : "RECOMPUTED_FROM_PARTIAL_HISTORY (this run predates the all-turn evaluationHistory projection; use 02_COMPANY_SUMMARY for all-turn cumulative KPIs)",
  }));

  return {
    meta: {
      simulationRunId: run.simulationRunId,
      scenarioId: run.scenarioId,
      seed: run.seed,
      status,
      asOfTurn,
      requestedTurns: run.requestedTurns,
      completedTurns: run.completedTurns,
      gameEndTurn: run.gameEndTurn ?? null,
      generatedAt,
      companyIds,
      missingDataNotes,
    },
    runSummary,
    companyProfiles,
    companySummary,
    turnKpi,
    decisions,
    diagnostics,
    sales,
    production,
    procurement,
    workforce,
    capex: capexRows,
    finance,
    backlog,
    market,
    dividend,
    factoryCapacity,
    finalResults,
    events,
    profileVision,
  };
}
