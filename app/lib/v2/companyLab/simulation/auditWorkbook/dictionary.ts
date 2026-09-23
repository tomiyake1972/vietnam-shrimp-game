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
  // Dividends are settled ANNUALLY: at each Q4 close, the engine takes the sum of the
  // fiscal year's Q1..Q4 net income, multiplies it by the payout ratio in force at Q4,
  // subtracts what was already paid during that year, and pays the remainder within
  // min(cash, distributableEarnings). The quarter-based base used before is gone.
  e("14_DIVIDEND_DETAIL", "isAnnualEvaluationPeriod", "boolean-string", "-", "TRUE when the quarter is Q4, the only quarter a dividend is settled.", "period quarter", "false"),
  e("14_DIVIDEND_DETAIL", "netIncomeUsd", "number", "Usd", "Net income of the latest confirmed quarter (turn-1). Context only.", "financialResults.profitAndLoss.netIncome of turn-1", "true", "NOT the dividend base any more. The base is annualNetIncomeUsd (Q1..Q4 of the fiscal year)."),
  e("14_DIVIDEND_DETAIL", "distributableEarningsAfterUsd", "number", "Usd", "Distributable earnings remaining after the turn-start dividend.", "dividendResults.distributableEarningsAfterUsd", "true", "This stock acts as a CAP on the dividend, not as its base."),
  e("14_DIVIDEND_DETAIL", "referencePayoutRatioFromCurrentParams", "number", "Ratio", "basePayoutRatio x (1 + profileBiasRatio), computed from the CURRENT parameters.", "StandardAiParameters / ManagementProfile", "true", "REFERENCE ONLY. Never read this as the ratio a past run actually used: a manual override would have replaced it. Use appliedPayoutRatio instead."),
  e("14_DIVIDEND_DETAIL", "appliedDividendUsd", "number", "Usd", "Total dividend the engine actually paid in that quarter (turn-start dividend + year-end settlement).", "dividendResults.appliedDividendUsd", "true", "Blank for runs recorded before dividends existed; 0 means an evaluated-but-skipped dividend."),
  e("14_DIVIDEND_DETAIL", "dividendTargetYear", "number", "-", "Fiscal year the year-end settlement covers.", "dividendResults.annualSettlement.dividendTargetYear", "true", "Blank on Q1..Q3 rows, on years with no settlement, and on runs recorded before annual settlement existed."),
  e("14_DIVIDEND_DETAIL", "annualNetIncomeUsd", "number", "Usd", "Signed sum of Q1..Q4 net income for that fiscal year. THIS IS THE DIVIDEND BASE.", "dividendResults.annualSettlement.annualNetIncomeUsd", "true", "Loss-making quarters are included with their sign; profitable quarters are not cherry-picked."),
  e("14_DIVIDEND_DETAIL", "appliedPayoutRatio", "number", "Ratio", "The payout ratio the engine actually used for this settlement.", "dividendResults.annualSettlement.appliedPayoutRatio", "true", "Recorded at run time. Do not recompute it from current parameters."),
  e("14_DIVIDEND_DETAIL", "payoutRatioSource", "enum", "-", "MANUAL_OVERRIDE (set by an operator in the Management Console) or STANDARD_AI (effective AI ratio).", "dividendResults.annualSettlement.payoutRatioSource", "true", "A player-specified dividend AMOUNT is not a ratio and never appears here."),
  e("14_DIVIDEND_DETAIL", "annualDividendTargetUsd", "number", "Usd", "max(0, annualNetIncomeUsd) x appliedPayoutRatio.", "dividendResults.annualSettlement.annualDividendTargetUsd", "true", "0 when the fiscal year's net income is <= 0."),
  e("14_DIVIDEND_DETAIL", "paidDividendEarlierInYearUsd", "number", "Usd", "Dividends actually paid earlier in the same fiscal year, including player-specified amounts.", "dividendResults.annualSettlement.paidDividendEarlierInYearUsd", "true", "Actual payments only; never inferred from settings."),
  e("14_DIVIDEND_DETAIL", "yearEndAdditionalTargetUsd", "number", "Usd", "max(0, annualDividendTargetUsd - paidDividendEarlierInYearUsd).", "dividendResults.annualSettlement.yearEndAdditionalTargetUsd", "true", "Never negative: dividends already paid are not clawed back."),
  e("14_DIVIDEND_DETAIL", "annualSettlementAppliedDividendUsd", "number", "Usd", "min(yearEndAdditionalTargetUsd, maxDividendUsd) - what the year-end settlement actually paid.", "dividendResults.annualSettlement.appliedDividendUsd", "true", "Target and actual are kept as separate columns on purpose."),
  e("14_DIVIDEND_DETAIL", "annualDividendShortfallUsd", "number", "Usd", "yearEndAdditionalTargetUsd minus what was actually paid.", "dividendResults.annualSettlement.annualDividendShortfallUsd", "true", "0 when the target was met."),
  e("14_DIVIDEND_DETAIL", "shortfallReason", "enum", "-", "CASH_LIMIT / DISTRIBUTABLE_EARNINGS_LIMIT / POLICY_GATE / SETTLEMENT_UNAVAILABLE.", "dividendResults.annualSettlement.shortfallReason", "true", "Blank when there was no shortfall."),
  e("14_DIVIDEND_DETAIL", "settlementUnavailableReason", "string", "-", "Why no settlement ran, e.g. the fiscal year's Q1..Q4 are not all confirmed.", "dividendResults.annualSettlementUnavailableReason", "true", "A missing quarter is never filled in with 0; the settlement is skipped and this reason is recorded."),

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

  // 20 / 20b — 市場集中による価格下落（ENG-CROWDING-MARKDOWN）
  e("20_CROWDING_DETAIL", "dueDate", "string", "-", 'Delivery quarter of the bucket, e.g. "2016Q2".', "CompanyQuarterRecord.crowdingDiagnostics.buckets[].dueDate", "false", "A bucket is Turn x market x product x dueDate. Crowding is computed independently per dueDate and never averaged across dueDates."),
  e("20_CROWDING_DETAIL", "policyVersion", "string", "-", "Version identifier of the crowding markdown policy that produced these numbers.", "CompanyQuarterRecord.crowdingDiagnostics.policyVersion", "false"),
  e("20_CROWDING_DETAIL", "crowdingEnabled", "boolean-string", "-", "TRUE if the markdown was active for this turn.", "CompanyQuarterRecord.crowdingDiagnostics.enabled", "false", "FALSE means the multiplier is identically 1 and the clearing price equals the structural price."),
  e("20_CROWDING_DETAIL", "preCrowdingStructuralPriceUsdPerKg", "number", "UsdPerKg", "Structural market price before the crowding markdown.", "crowdingDiagnostics.buckets[].preCrowdingStructuralPrice", "true"),
  e("20_CROWDING_DETAIL", "postCrowdingClearingPriceUsdPerKg", "number", "UsdPerKg", "Clearing price after the markdown, used as the base price of NEW contracts in this bucket.", "crowdingDiagnostics.buckets[].postCrowdingClearingPrice", "true", "Existing contracts are never repriced. This affects only contracts created in this turn."),
  e("20_CROWDING_DETAIL", "crowdingMultiplier", "number", "-", "Markdown factor applied to the structural price.", "crowdingDiagnostics.buckets[].crowdingMultiplier", "true", "postCrowdingClearingPrice = preCrowdingStructuralPrice x crowdingMultiplier. It is bounded below by floorRatio."),
  e("20_CROWDING_DETAIL", "crowdingRatio", "number", "-", "crowdingLoad divided by the contestable demand of the bucket.", "crowdingDiagnostics.buckets[].crowdingRatio", "true", "Not a market share. It can exceed 1, which is what triggers the markdown once it passes thresholdRatio."),
  e("20_CROWDING_DETAIL", "crowdingLoadHosoEqTons", "number", "HosoEqTons", "Credible offers plus existing commitments competing for this bucket.", "crowdingDiagnostics.buckets[].crowdingLoad", "true", "Built from credible (physically backed) offers, not from what companies wished to offer."),
  e("20_CROWDING_DETAIL", "forwardDemandProxyHosoEqTons", "number", "HosoEqTons", "Structural demand carried forward to the bucket dueDate.", "crowdingDiagnostics.buckets[].forwardDemandProxy", "true", "A proxy: it holds current-turn structural demand flat and does not read unpublished future scenario events."),
  e("20_CROWDING_DETAIL", "protectedExternalShareRatio", "number", "-", "Share of forward demand assumed unavailable to these companies.", "crowdingDiagnostics.buckets[].protectedExternalShare", "true"),
  e("20_CROWDING_DETAIL", "protectedExternalDemandHosoEqTons", "number", "HosoEqTons", "Part of forwardDemandProxy assumed to be served outside these companies.", "crowdingDiagnostics.buckets[].protectedExternalDemand", "true"),
  e("20_CROWDING_DETAIL", "grossCompanyAddressableDemandHosoEqTons", "number", "HosoEqTons", "Contestable demand = forwardDemandProxy x (1 - protectedExternalShareRatio).", "crowdingDiagnostics.buckets[].grossCompanyAddressableDemand", "true"),
  e("20_CROWDING_DETAIL", "existingCommittedOutstandingHosoEqTons", "number", "HosoEqTons", "Outstanding quantity of contracts already committed to this exact bucket.", "crowdingDiagnostics.buckets[].existingCommittedOutstanding", "true", "Already-committed volume consumes contestable demand; it is not re-priced by the markdown."),
  e("20_CROWDING_DETAIL", "residualContestableDemandHosoEqTons", "number", "HosoEqTons", "Contestable demand left after existing commitments.", "crowdingDiagnostics.buckets[].residualContestableDemand", "true"),
  e("20_CROWDING_DETAIL", "totalDesiredOffersHosoEqTons", "number", "HosoEqTons", "What the companies wanted to offer into this bucket.", "crowdingDiagnostics.buckets[].totalDesiredOffers", "true", "Desired is not credible. Only credible offers move the price; see 20b for the per-company split."),
  e("20_CROWDING_DETAIL", "totalCredibleOffersHosoEqTons", "number", "HosoEqTons", "How much of the desired offers was backed by physical available-to-promise.", "crowdingDiagnostics.buckets[].totalCredibleOffers", "true"),
  e("20_CROWDING_DETAIL", "thresholdRatio", "number", "-", "crowdingRatio below this value leaves the price untouched.", "crowdingDiagnostics.buckets[].threshold", "true"),
  e("20_CROWDING_DETAIL", "lambda", "number", "-", "Steepness coefficient of the markdown curve.", "crowdingDiagnostics.buckets[].lambda", "true"),
  e("20_CROWDING_DETAIL", "gamma", "number", "-", "Curvature exponent of the markdown curve.", "crowdingDiagnostics.buckets[].gamma", "true"),
  e("20_CROWDING_DETAIL", "floorRatio", "number", "-", "Lower bound of crowdingMultiplier.", "crowdingDiagnostics.buckets[].floor", "true", "The markdown can never push the price below preCrowdingStructuralPrice x floorRatio."),
  e("20_CROWDING_DETAIL", "physicalAtpMethod", "string", "-", "Identifier of the method used to derive each company physical available-to-promise.", "crowdingDiagnostics.buckets[].physicalAtpMethod", "false"),
  e("20_CROWDING_DETAIL", "forwardDemandProxyMethod", "string", "-", "Identifier of the method used to derive forwardDemandProxy.", "crowdingDiagnostics.buckets[].forwardDemandProxyMethod", "false"),
  e("20b_CROWDING_COMPANY_OFFERS", "desiredOfferHosoEqTons", "number", "HosoEqTons", "What this company wanted to offer into the bucket, after sales effort.", "crowdingDiagnostics.buckets[].companyOffers[].desiredOffer", "true"),
  e("20b_CROWDING_COMPANY_OFFERS", "credibleOfferHosoEqTons", "number", "HosoEqTons", "How much of that was backed by physical available-to-promise.", "crowdingDiagnostics.buckets[].companyOffers[].credibleOffer", "true", "Declaring a larger desired offer without the physical supply to back it does not increase this value, and therefore cannot move the market price."),
  e("20b_CROWDING_COMPANY_OFFERS", "bindingReason", "enum", "-", "Which constraint limited credibleOffer for this company and bucket.", "crowdingDiagnostics.buckets[].companyOffers[].bindingReason", "false", "Management/Admin only. Per-company credible offers are never exposed to a Player."),
];
