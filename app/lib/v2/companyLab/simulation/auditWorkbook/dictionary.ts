// ShrimpX V2 — Standard AI 32Q Audit Workbook: 17_DATA_DICTIONARY
//
// 【実装指示§24・§25・§30】AIが列の意味・単位・出所を推測せずに読めるようにする。
// source は「その値がどのオブジェクトから転記されたか」であり、Excel側の再計算では
// ないことを示す。semanticNotes には、AIが誤読しやすい区別（backlog != overdue 等）を書く。

export interface DataDictionaryEntry {
  readonly sheetName: string;
  readonly fieldName: string;
  readonly dataType: "string" | "number" | "boolean-string" | "enum";
  readonly unit: string;
  readonly description: string;
  readonly source: string;
  readonly nullable: "true" | "false";
  readonly semanticNotes: string;
}

const e = (
  sheetName: string,
  fieldName: string,
  dataType: DataDictionaryEntry["dataType"],
  unit: string,
  description: string,
  source: string,
  nullable: "true" | "false" = "true",
  semanticNotes = ""
): DataDictionaryEntry => ({ sheetName, fieldName, dataType, unit, description, source, nullable, semanticNotes });

/** 全シート共通のキー列（同じ意味を何度も書かないための共通定義）。 */
const KEY_FIELDS: readonly DataDictionaryEntry[] = [
  e("(all sheets)", "companyId", "enum", "-", "Company identifier. One of BAL / MASS / JPQ / VAP / CONSV.", "CompanyFixture.companyId", "false"),
  e("(all sheets)", "turn", "number", "Turn", "Turn number. One Turn = one quarter.", "CompanyQuarterRecord.turn", "false"),
  e("(all sheets)", "period", "string", "-", 'Calendar quarter label, e.g. "2015Q3".', "CompanyQuarterRecord.period", "false", "Turn 1 is not necessarily Q1 of a year; use this field, do not derive quarter from turn."),
];

export const AUDIT_DATA_DICTIONARY: readonly DataDictionaryEntry[] = [
  ...KEY_FIELDS,

  // 01_RUN_SUMMARY / 02_COMPANY_SUMMARY
  e("01_RUN_SUMMARY", "status", "enum", "-", "COMPLETE if the game was officially ended or all requested turns ran; otherwise PARTIAL.", "SimulationRun.gameEndedAt / requestedTurns", "false"),
  e("01_RUN_SUMMARY", "asOfTurn", "number", "Turn", "Last turn included in every sheet of this workbook.", "SimulationRun / CompanyQuarterRecord", "false"),
  e("02_COMPANY_SUMMARY", "cumulativeRevenueUsd", "number", "Usd", "Sum of net revenue over turns 1..asOfTurn.", "evaluationSemantics.computeCompanyKpiSnapshot", "true"),
  e("02_COMPANY_SUMMARY", "averageOperatingMarginRatio", "number", "Ratio", "cumulativeOperatingProfitUsd / cumulativeRevenueUsd.", "evaluationSemantics.computeCompanyKpiSnapshot", "true", "Blank when cumulative revenue is 0."),
  e("02_COMPANY_SUMMARY", "distressTurnCount", "number", "Turn", 'Number of turns where financialHealth.primary was not "healthy".', "FinancingQuarterResult.financialHealth.primary", "true"),
  e("02_COMPANY_SUMMARY", "revenueGrowthRatio", "number", "Ratio", "(last recorded turn revenue - first recorded turn revenue) / |first|.", "evaluationSemantics.computeCompanyKpiSnapshot", "true", "Provisional definition, not an official Awards metric."),

  // 03_TURN_KPI
  e("03_TURN_KPI", "revenueUsd", "number", "Usd", "Net revenue of this quarter.", "financialResults.profitAndLoss.netRevenue", "true"),
  e("03_TURN_KPI", "operatingProfitUsd", "number", "Usd", "Operating profit of this quarter (accrual P&L).", "financialResults.profitAndLoss.operatingProfit", "true", "Accrual measure. Do NOT explain it with cash flow or AR collection timing."),
  e("03_TURN_KPI", "interestBearingDebtUsd", "number", "Usd", "shortTermLoans + longTermLoans.", "financialResults.balanceSheet", "true", "NOT the same as totalLiabilitiesUsd, which also includes payables and accrued interest."),
  e("03_TURN_KPI", "totalLiabilitiesUsd", "number", "Usd", "All liabilities including payables and accrued interest.", "financialResults.balanceSheet.totalLiabilities", "true", "NOT the same as interest-bearing debt."),
  e("03_TURN_KPI", "totalBacklogHosoEqTons", "number", "HosoEqTons", "Outstanding contracted quantity at the end of this quarter.", "companySummaries.outstandingQuantity", "true", "Backlog is NOT overdue. Compare with overdueBacklogHosoEqTons."),
  e("03_TURN_KPI", "overdueBacklogHosoEqTons", "number", "HosoEqTons", "Portion of backlog whose due date has already passed.", "companySummaries.overdueQuantity", "true", "Only this column means late delivery."),
  e("03_TURN_KPI", "healthyForwardBacklogHosoEqTons", "number", "HosoEqTons", "totalBacklog - overdueBacklog (never negative).", "companySummaries", "true", "Healthy forward obligations. An increase here is not a delivery problem."),
  e("03_TURN_KPI", "equipmentUtilizationRatio", "number", "Ratio", "Actual production / effective equipment capacity.", "companySummaries.equipmentUtilizationRate", "true", "Different metric from laborUtilizationRatio. Never merge them into one 'plant is full' statement."),
  e("03_TURN_KPI", "laborUtilizationRatio", "number", "Ratio", "Actual production / effective labor capacity.", "companySummaries.laborUtilizationRate", "true", "Different metric from equipmentUtilizationRatio."),
  e("03_TURN_KPI", "companyValueUsd", "number", "Usd", "Current Company Value = enterpriseValue + cash - debt at this turn.", "evaluationSemantics.computeCompanyEvaluationSnapshot", "true", "Recomputed for every turn from stored history by the existing evaluation service; the valuation formula was not modified for this export."),
  e("03_TURN_KPI", "dividendValueUsd", "number", "Usd", "Dividends actually paid, compounded at 15%/year up to this turn.", "evaluationSemantics.computeCurrentDividendValueUsd", "true"),
  e("03_TURN_KPI", "totalShareholderValueUsd", "number", "Usd", "TSV = dividendValueUsd + companyValueUsd.", "evaluationSemantics (tsv-dcf-v1)", "true", "Blank when enterprise value cannot be computed (no confirmed cash flow yet)."),
  e("03_TURN_KPI", "decisionOwner", "enum", "-", "STANDARD_AI or PLAYER: who actually produced this quarter's decision.", "SimulationPackCapture.decisionOwner / SimulationRun.companyControlModes", "true"),

  // 04_STANDARD_AI_DECISIONS
  e("04_STANDARD_AI_DECISIONS", "proposedValue", "number", "see proposedUnit", "The value the decision maker submitted to the engine for this turn.", "CompanyQuarterRecord.decisions (CompanyDecisionInput)", "true", "For STANDARD_AI companies this is the Standard AI proposal. It is stored separately from actualAppliedValue so human-vs-AI comparison stays possible."),
  e("04_STANDARD_AI_DECISIONS", "actualAppliedValue", "number", "see actualAppliedUnit", "What the engine actually realised for that decision.", "companySummaries / capexResults / dividendResults / financingResults", "true", "For quantities this is an outcome (e.g. contracted tons), not a re-statement of the proposal."),
  e("04_STANDARD_AI_DECISIONS", "wasApplied", "boolean-string", "-", 'TRUE / FALSE / blank.', "derived comparison of proposed vs actual", "true", "Blank means the comparison is not meaningful for that decision type (e.g. imports arrive with a lead time)."),
  e("04_STANDARD_AI_DECISIONS", "wasModified", "boolean-string", "-", "TRUE when actual differs from proposed.", "derived comparison of proposed vs actual", "true", ""),
  e("04_STANDARD_AI_DECISIONS", "profileInfluence", "string", "-", "Management profile that biased this company's Standard AI parameters.", "managementProfile.MANAGEMENT_PROFILE_BY_COMPANY_ID", "true"),
  e("04_STANDARD_AI_DECISIONS", "visionInfluence", "string", "-", "Growth pressure derived from the company's Vision at that turn.", "SimulationPackCapture.strategy.growthPressure", "true"),
  e("04_STANDARD_AI_DECISIONS", "crisisInfluence", "string", "-", "CRISIS_SIGNAL_PRESENT when a CRISIS_* reason code fired that turn.", "Standard AI turn trace reason codes", "true"),

  // 05_DECISION_DIAGNOSTICS
  e("05_DECISION_DIAGNOSTICS", "source", "enum", "-", "STANDARD_AI_TRACE (AI's own reasoning) or ENGINE_RESULT (what the engine reported).", "SimulationAiTurnTrace / companySummaries.reasonCodes", "false", "Keep facts, diagnostics and interpretation apart: STANDARD_AI_TRACE rows are the AI's diagnosis, not ground truth."),
  e("05_DECISION_DIAGNOSTICS", "stage", "enum", "-", "OBSERVED / DIAGNOSED / WANTED / CONSTRAINED / DECIDED / RESULT.", "SimulationAiTurnTrace", "false", "The six-stage Standard AI reasoning trace."),
  e("05_DECISION_DIAGNOSTICS", "reasonCode", "string", "-", "Standard AI or engine reason code, e.g. DIVIDEND_SKIPPED_CAPEX_PLANNED.", "StandardAiDiagnosticEntry.code via trace label", "true", "Blank on rows that carry an observed value rather than a reason code."),
  e("05_DECISION_DIAGNOSTICS", "severity", "enum", "-", "info / warning / critical.", "StandardAiDiagnosticEntry.severity", "true"),
  e("05_DECISION_DIAGNOSTICS", "observedValue", "number", "see unit", "The numeric value the AI held at that stage.", "SimulationAiTurnTrace item value", "true", "thresholdValue / gateName / candidateValue are NOT persisted per run; see 00_README limitations."),

  // 06_SALES_DETAIL
  e("06_SALES_DETAIL", "desiredSalesBeforeEffortHosoEqTons", "number", "HosoEqTons", "Wanted sales volume before the sales-force effort constraint.", "SimulationAiTurnTrace.salesWish", "true"),
  e("06_SALES_DETAIL", "proposedSalesHosoEqTons", "number", "HosoEqTons", "Sales plan actually submitted to the market.", "CompanyDecisionInput.salesPlans.desiredQuantity", "true"),
  e("06_SALES_DETAIL", "actualContractsHosoEqTons", "number", "HosoEqTons", "Quantity the market actually contracted.", "salesRecord.allocations.companies.allocatedQuantity", "true"),
  e("06_SALES_DETAIL", "offeredPriceAdjustmentUsdPerKg", "number", "UsdPerKg", "Price adjustment offered against the market base price (discount is negative).", "CompanyDecisionInput.salesPlans.priceAdjustmentUsdPerHosoEqKg", "true", "This is a delta, not an absolute price. Absolute base price is marketBasePriceUsdPerKg."),
  e("06_SALES_DETAIL", "realizedPriceUsdPerKg", "number", "UsdPerKg", "Quantity-weighted average unit price of contracts signed this quarter.", "salesRecord.newContracts.unitPrice", "true"),

  // 07 / 08 / 09
  e("07_PRODUCTION_DETAIL", "shortfallReasons", "string", "-", "Pipe-separated production shortfall reasons.", "productionAllocation.entries.shortfallReasons", "true"),
  e("07_PRODUCTION_DETAIL", "rawMaterialLimitedHosoEqTons", "number", "HosoEqTons", "Intermediate cap after the raw-material constraint stage.", "productionAllocation.entries.stages", "true", "The stages columns are cumulative caps in engine order, not additive losses."),
  e("08_PROCUREMENT_DETAIL", "source", "enum", "-", "DOMESTIC / IMPORT / AQUACULTURE.", "CompanyDecisionInput / domesticAllocation / companySummaries", "false"),
  e("08_PROCUREMENT_DETAIL", "actualHosoEqTons", "number", "HosoEqTons", "Quantity actually received this quarter from that source.", "domesticAllocation.companies.allocatedQuantity / companySummaries", "true", "For IMPORT this is arrivals, which correspond to orders placed in an earlier turn (lead time)."),
  e("09_WORKFORCE_DETAIL", "companyIdleLaborCostUsd", "number", "Usd", "Company-level idle labor cost of the quarter (repeated on every factory row).", "financialResults.profitAndLoss.costOfSales.idleLaborCost", "true", "Company-level value, not per factory. Do not sum across factory rows."),

  // 10_CAPEX_DETAIL
  e("10_CAPEX_DETAIL", "projectType", "enum", "-", "Capital project type enum exactly as the engine stores it (newFactoryConstruction / hosoLineExpansion / pdLineExpansion / vapLineExpansion / pdMechanization / qualityControlEquipment / commonProcessingExpansion / freezingPackagingExpansion / coldStorageExpansion / environmentalEquipment).", "CapitalProject.projectType", "false"),
  e("10_CAPEX_DETAIL", "completionTurn", "number", "Turn", "First turn at which this project was observed with status=completed.", "SimulationPackCapture.capitalProjects", "true", "Blank when the project never completed within asOfTurn."),
  e("10_CAPEX_DETAIL", "targetFactoryId", "string", "-", "Factory this project targets.", "CapitalProject.targetFactoryId", "true", "Blank for projects that are not factory-scoped."),

  // 11_FINANCE_DETAIL
  e("11_FINANCE_DETAIL", "operatingCashFlowUsd", "number", "Usd", "Operating cash flow (direct method).", "financialResults.cashFlow.operatingCashFlow", "true", "Cash measure. Never use it to explain operatingProfitUsd, which is accrual."),
  e("11_FINANCE_DETAIL", "idleLaborCostUsd", "number", "Usd", "Salary of regular workers not assigned to production, expensed in the quarter.", "financialResults.profitAndLoss.costOfSales.idleLaborCost", "true"),

  // 12_BACKLOG_DETAIL
  e("12_BACKLOG_DETAIL", "dueStatus", "enum", "-", "OVERDUE / DUE_THIS_TURN / FUTURE_DUE.", "SalesContract.dueDate compared with asOfPeriod", "false", "Only dueStatus=OVERDUE means a late delivery. FUTURE_DUE is a healthy forward obligation."),
  e("12_BACKLOG_DETAIL", "outstandingHosoEqTons", "number", "HosoEqTons", "Outstanding contractual quantity in this group.", "SalesContract.outstandingQuantity", "false", "Not equivalent to overdue unless dueStatus=OVERDUE."),
  e("12_BACKLOG_DETAIL", "asOfTurn", "number", "Turn", "The single turn this snapshot describes.", "export parameter", "false", "This sheet is a snapshot at asOfTurn only; per-turn backlog totals are in 03_TURN_KPI."),

  // 13_MARKET_DETAIL
  e("13_MARKET_DETAIL", "scope", "enum", "-", "COUNTRY_HOSO_PRICE / WORLD / VIETNAM_DOMESTIC_RAW / PRODUCT_PREMIUM / CONSUMER_MARKET.", "MarketQuarterResult / ConsumerMarketQuarterRecord", "false", "Rows of different scope are not comparable; filter by scope first."),
  e("13_MARKET_DETAIL", "priceUsdPerKg", "number", "UsdPerKg", "Price for that scope. For PRODUCT_PREMIUM this is a premium, not an absolute price.", "MarketQuarterResult", "true"),

  // 14_DIVIDEND_DETAIL
  e("14_DIVIDEND_DETAIL", "isAnnualEvaluationPeriod", "boolean-string", "-", "TRUE when the quarter is Q4, the only quarter Standard AI evaluates a dividend (DIV-4).", "period quarter", "false"),
  e("14_DIVIDEND_DETAIL", "netIncomeUsd", "number", "Usd", "Net income of the latest confirmed quarter, which is the base of the Standard AI dividend.", "financialResults.profitAndLoss.netIncome of turn-1", "true", "DIV-4 pays a share of this flow. It does NOT pay a share of accumulated distributableEarnings."),
  e("14_DIVIDEND_DETAIL", "distributableEarningsAfterUsd", "number", "Usd", "Distributable earnings remaining after the dividend.", "dividendResults.distributableEarningsAfterUsd", "true", "This stock acts as a CAP on the dividend, not as its base."),
  e("14_DIVIDEND_DETAIL", "effectivePayoutRatio", "number", "Ratio", "basePayoutRatio x (1 + profileBiasRatio).", "StandardAiParameters / ManagementProfile", "true", "This is the current parameter value, not necessarily the value in force when a legacy run was executed."),
  e("14_DIVIDEND_DETAIL", "appliedDividendUsd", "number", "Usd", "Dividend the engine actually paid.", "dividendResults.appliedDividendUsd", "true", "Blank for runs recorded before dividends existed; 0 means an evaluated-but-skipped dividend."),

  // 15 / 16
  e("15_FACTORY_CAPACITY", "factorySource", "enum", "-", "INITIAL_FIXTURE or BUILT_DURING_RUN.", "CompanyFixture.factories", "false", "Capacity columns are blank for BUILT_DURING_RUN factories: per-turn factory capacity is not persisted, only company-level effective capacity is."),
  e("15_FACTORY_CAPACITY", "companyEffectiveHosoCapacityHosoEqTons", "number", "HosoEqTons", "Company-level effective HOSO capacity of that turn.", "SimulationResumePayload.capacityByTurn", "true", "Product-line capacity. Not the same as companyEffectiveCommonCapacity, which is the shared pre-processing bottleneck."),
  e("16_FINAL_RESULTS", "rank", "number", "-", "1 = highest TSV.", "evaluationSemantics.rankCompaniesByTotalShareholderValue", "true"),
  e("16_FINAL_RESULTS", "finalSnapshotSource", "string", "-", "How the values in this sheet were obtained.", "evaluationSemantics", "false", "RECOMPUTED_FROM_HISTORY means the existing evaluation service was re-run over stored history; no new formula was introduced."),

  // 18 / 19
  e("18_EVENT_LOG", "eventCategory", "enum", "-", "CAPEX / DIVIDEND / FINANCIAL_HEALTH / GLOBAL_REASON.", "capexResults / dividendResults / financingResults / globalReasonCodes", "false"),
  e("19_AI_PROFILE_VISION", "growthPressure", "enum", "-", "LOW / MODERATE / HIGH / URGENT at that turn.", "SimulationPackCapture.strategy.growthPressure", "true"),
  e("19_AI_PROFILE_VISION", "commercialAmbitionTons", "number", "HosoEqTons", "How much the company wanted to sell, from its Vision.", "SimulationPackCapture.commercialGrowth", "true", "Ambition != commitment != submitted != contracted != delivered. All five are separate columns."),
  e("19_AI_PROFILE_VISION", "newFactoryReasonCodes", "string", "-", "Pipe-separated reason codes for the new-factory decision, including reasons for NOT building.", "SimulationPackCapture.strategy.newFactory.reasonCodes", "true", "Deciding not to build is a normal management outcome, not a failure."),
];
