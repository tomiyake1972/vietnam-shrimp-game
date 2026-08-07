// ShrimpX V2 — Phase SAI-3B-1: テスト用の最小SAI-3Aログfixture生成ヘルパー
//
// 実際のSAI-3A CLI出力と同じファイル形式（manifest.json・case-summary.csv・
// quarter-summary.csv・decision-trace.jsonl・adjustment-trace.csv・
// warnings.csv・run-summary.json）を、テストが必要とする最小構成
// （1〜2社×1〜2seed×少数quarter）で直接組み立てる。テスト実行時間を
// 抑えるため、実際にAIシミュレーションを回さず、値を直接指定する。

export interface FixtureCaseSpec {
  readonly seed: string;
  readonly companyId: string;
  readonly quarters: number;
  readonly headcount: number;
  /** paymentDefaultをtrueにするturn（1-based）。undefinedならdefaultなし。 */
  readonly defaultAtTurn?: number;
}

export interface FixtureRunSpec {
  readonly runId: string;
  readonly headcount: number;
  readonly quarters: number;
  readonly cases: readonly FixtureCaseSpec[];
  readonly schemaVersion?: string;
  /** trueの場合、quarter-summary.csvのsalesEffortUtilizationRate列を全行で
   *  空欄にする（SAI-3A側でこの値が取得できなかったケースを再現するための
   *  fixtureオプション）。欠損値が0に変換されないことのテスト用。 */
  readonly utilizationRateMissing?: boolean;
}

function csvLine(values: readonly (string | number | boolean)[]): string {
  return values
    .map((v) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

export function buildFixtureRunFiles(spec: FixtureRunSpec): Record<string, string> {
  const companyIds = Array.from(new Set(spec.cases.map((c) => c.companyId))).sort();
  const seeds = Array.from(new Set(spec.cases.map((c) => c.seed))).sort();

  const manifest = {
    schemaVersion: spec.schemaVersion ?? "1.0.0",
    appCommitId: "test-commit",
    executedAtIso: "2026-01-01T00:00:00.000Z",
    runId: spec.runId,
    scenarioId: "baseline",
    standardBaselineId: "moderate-pressure",
    seeds,
    quarters: spec.quarters,
    companyIds,
    aiPolicyVersion: "STANDARD_AI_PARAMETERS_V1",
    salesForceHeadcountTotal: spec.headcount,
    keyParameters: { salesForceHeadcountOverrideSpecified: true },
    outputFormats: ["json", "csv"],
  };

  const caseSummaryHeader = [
    "seed",
    "companyId",
    "completedTurns",
    "requestedTurns",
    "completed",
    "cumulativeRevenueUsd",
    "cumulativeGrossProfitUsd",
    "cumulativeOperatingProfitUsd",
    "cumulativeSalesForceCostUsd",
    "finalCashUsd",
    "finalLoansUsd",
    "finalAvailableAdditionalCapacityUsd",
    "paymentDefaultEverByRequestedTurns",
    "paymentDefaultFirstTurn",
    "underwritingFrozenEverByRequestedTurns",
    "underwritingFrozenFirstTurn",
    "topReasonCodes",
    "warningCount",
  ];
  const caseSummaryRows = spec.cases.map((c) => {
    const revenue = 1_000_000 * spec.quarters;
    const grossProfit = revenue * 0.2;
    const operatingProfit = revenue * 0.1;
    return csvLine([
      c.seed,
      c.companyId,
      spec.quarters,
      spec.quarters,
      true,
      revenue,
      grossProfit,
      operatingProfit,
      50000,
      c.defaultAtTurn !== undefined ? -100000 : 500000,
      2_000_000,
      c.defaultAtTurn !== undefined ? 0 : 1_000_000,
      c.defaultAtTurn !== undefined,
      c.defaultAtTurn ?? "",
      false,
      "",
      "RAW_MATERIAL_SHORTAGE|SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY",
      2 * spec.quarters,
    ]);
  });

  const quarterSummaryHeader = [
    "seed",
    "companyId",
    "turn",
    "period",
    "startCashUsd",
    "startShortTermLoansUsd",
    "startLongTermLoansUsd",
    "startAvailableAdditionalCapacityUsd",
    "startCreditTier",
    "startCreditScore0to100",
    "startFinancialHealthTier",
    "startPaymentDefault",
    "startUnderwritingFrozen",
    "startRawMaterialInventoryHosoEqTons",
    "startFinishedGoodsInventoryHosoEqTons",
    "startSalesForceHeadcountTotal",
    "startSalesEffortCapacityHosoEqTonsReference",
    "netRevenueUsd",
    "grossProfitUsd",
    "operatingProfitUsd",
    "netIncomeUsd",
    "closingCashUsd",
    "endingShortTermLoansUsd",
    "endingLongTermLoansUsd",
    "endingAvailableAdditionalCapacityUsd",
    "salesEffortCapacityHosoEqTonsActual",
    "salesEffortUsedHosoEqTons",
    "salesEffortUtilizationRate",
    "salesReductionFromEffortConstraintHosoEqTons",
    "rawMaterialInventoryHosoEqTons",
    "finishedGoodsInventoryHosoEqTons",
    "discardQuantityHosoEqTons",
    // --- SAI-3B-2で追加 ---
    "operatingCashFlowUsd",
    "investingCashFlowUsd",
    "financingCashFlowUsd",
    "downgradeQuantityHosoEqTons",
    "newContractedQuantityHosoEqTons",
    "fulfilledQuantityHosoEqTons",
    "outstandingQuantityHosoEqTons",
    "overdueQuantityHosoEqTons",
    "productionQuantityHosoEqTons_hoso",
    "productionQuantityHosoEqTons_pd",
    "productionQuantityHosoEqTons_vap",
    "salesQuantityHosoEqTons_hoso",
    "salesQuantityHosoEqTons_pd",
    "salesQuantityHosoEqTons_vap",
    "customerTrustAtEnd_CN",
    "customerTrustAtEnd_US",
    "customerTrustAtEnd_EU",
    "customerTrustAtEnd_JP",
    "customerTrustAtEnd_OTHER",
    "qualityScoreAtEnd_hoso",
    "qualityScoreAtEnd_pd",
    "qualityScoreAtEnd_vap",
    "deliveryReliabilityAtEnd_CN",
    "deliveryReliabilityAtEnd_US",
    "deliveryReliabilityAtEnd_EU",
    "deliveryReliabilityAtEnd_JP",
    "deliveryReliabilityAtEnd_OTHER",
    "paymentDefault",
    "paymentDefaultNewlyTriggered",
    "underwritingFrozen",
    "underwritingFrozenNewlyTriggered",
    "warningCount",
  ];

  const marketAllocationTraceHeader = [
    "seed",
    "turn",
    "period",
    "market",
    "product",
    "companyId",
    "targetDemandHosoEqTons",
    "externalOptionQuantityHosoEqTons",
    "askPriceUsdPerHosoEqKg",
    "basePriceUsdPerHosoEqKg",
    "allocatedQuantityHosoEqTons",
    "coverageScore",
    "competitivenessWeight",
  ];

  const quarterSummaryRows: string[] = [];
  const decisionTraceLines: string[] = [];
  const adjustmentTraceRows: string[] = [];
  const warningsRows: string[] = [];
  const marketAllocationTraceRows: string[] = [];

  for (const c of spec.cases) {
    let cash = 20_000_000;
    for (let turn = 1; turn <= spec.quarters; turn++) {
      const period = `2015Q${((turn - 1) % 4) + 1}`;
      const isDefaultTurn = c.defaultAtTurn === turn;
      const startCash = cash;
      cash = isDefaultTurn ? -50000 : cash + 500000;
      const capacity = 4400 + c.headcount * 40;
      const used = capacity * 0.99;

      quarterSummaryRows.push(
        csvLine([
          c.seed,
          c.companyId,
          turn,
          period,
          startCash,
          24_000_000,
          33_000_000,
          0,
          "healthy",
          75,
          "healthy",
          isDefaultTurn,
          false,
          3200,
          0,
          c.headcount,
          4466.67,
          1_000_000,
          200_000,
          100_000,
          100_000,
          cash,
          24_000_000,
          31_000_000,
          0,
          capacity,
          used,
          spec.utilizationRateMissing ? "" : used / capacity,
          200,
          3000,
          50,
          // --- SAI-3B-2で追加 ---
          300000,
          -50000,
          -20000,
          10,
          4200,
          4000,
          200,
          isDefaultTurn ? 50 : 0,
          2000,
          1000,
          500,
          1900,
          950,
          480,
          55,
          "",
          "",
          "",
          "",
          82,
          80,
          78,
          60,
          "",
          "",
          "",
          "",
          0,
          isDefaultTurn,
          isDefaultTurn,
          false,
          false,
          2,
        ])
      );

      marketAllocationTraceRows.push(
        csvLine([c.seed, turn, period, "CN", "hoso", c.companyId, 2100, 200, 4.5, 4.2, 1900, 72, 1.1]),
        csvLine([c.seed, turn, period, "CN", "pd", c.companyId, 1050, 100, 5.1, 4.8, 950, 70, 1.05]),
        csvLine([c.seed, turn, period, "CN", "vap", c.companyId, 520, 40, 6.3, 6.0, 480, 68, 1.0])
      );

      const desiredHoso = 4400;
      const finalHoso = 1200;
      decisionTraceLines.push(
        JSON.stringify({
          seed: c.seed,
          companyId: c.companyId,
          turn,
          period,
          startState: {
            companyId: c.companyId,
            turn,
            period,
            cashUsd: startCash,
            accountsReceivableUsd: 45_000_000,
            accountsPayableUsd: 0,
            shortTermLoansUsd: 24_000_000,
            longTermLoansUsd: 33_000_000,
            availableAdditionalCapacityUsd: 0,
            creditTier: "unscored",
            creditScore0to100: null,
            financialHealthTier: "healthy",
            paymentDefault: false,
            underwritingFrozen: false,
            consecutiveArrearsQuarters: 0,
            rawMaterialInventoryHosoEqTons: 3200,
            finishedGoodsInventoryHosoEqTons: 0,
            totalFactoryCapacityHosoEqTons: 21400,
            regularWorkerCount: 6300,
            salesForceHeadcountTotal: c.headcount,
            salesEffortCapacityHosoEqTons: 4466.67,
            qualityScoreByProduct: { hoso: 85, pd: 85, vap: 85 },
            customerTrustByMarket: { CN: 50 },
            deliveryReliabilityByMarket: { CN: 50 },
            pressures: {},
            changeFromPreviousQuarter: null,
          },
          decision: {
            companyId: c.companyId,
            turn,
            period,
            wish: {
              domesticPurchaseDesiredQuantity: 13000,
              importOrdersDesiredQuantity: 3000,
              aquacultureStockingDesiredQuantity: 8000,
              productionDesiredQuantityByProduct: { hoso: 9000, pd: 6000, vap: 4000 },
              workerRegularHeadcountTotal: 6300,
              workerTemporaryHeadcountTotal: 0,
              workerOvertimeRateAvg: 0,
              financingRequestDesiredAmountUsd: 10000000,
              financingRequestDesiredPrepaymentUsd: 0,
              capexNewProposalCount: 0,
              capexCancelCount: 0,
              capexResumeCount: 0,
            },
            final: {
              domesticPurchaseFinalQuantity: 4800,
              importOrdersBlocked: false,
              importOrdersFinalQuantity: 3000,
              aquacultureStockingFinalQuantity: 3000,
            },
          },
          salesQuantityTrace: [
            { companyId: c.companyId, turn, market: "CN", product: "hoso", desiredQuantityBeforeEffortConstraint: desiredHoso, salesForceHeadcount: c.headcount, finalPlannedQuantity: finalHoso, engineEffortScaleFactor: 1 },
          ],
        })
      );

      adjustmentTraceRows.push(
        csvLine([c.seed, c.companyId, turn, period, "sales_effort_capacity", "standardAi", "SALES_HEADCOUNT_INSUFFICIENT_TOTAL", "warning", "sales", "", "", "", "", "msg", "", "salesForceHeadcountTotal"])
      );
      adjustmentTraceRows.push(
        csvLine([c.seed, c.companyId, turn, period, "sales_effort_capacity", "companyLab", "SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY", "info", "sales", "CN", desiredHoso, finalHoso, finalHoso - desiredHoso, "msg", "", "scaleFactor"])
      );

      warningsRows.push(csvLine([c.seed, c.companyId, turn, period, "RAW_MATERIAL_SHORTAGE", "companyLab", "info", "msg"]));
      warningsRows.push(csvLine([c.seed, c.companyId, turn, period, "SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY", "companyLab", "info", "msg"]));
      if (isDefaultTurn) {
        warningsRows.push(csvLine([c.seed, c.companyId, turn, period, "CASH_BUFFER_SHORTAGE", "standardAi", "critical", "msg"]));
      }
    }
  }

  const runSummary = {
    runSummary: {
      runId: spec.runId,
      totalCases: spec.cases.length,
      completedCases: spec.cases.length,
      errorCases: 0,
      paymentDefaultRate: spec.cases.filter((c) => c.defaultAtTurn !== undefined).length / spec.cases.length,
      underwritingFrozenRate: 0,
      averageCumulativeRevenueUsd: 1_000_000 * spec.quarters,
      averageCumulativeGrossProfitUsd: 200_000 * spec.quarters,
      averageCumulativeOperatingProfitUsd: 100_000 * spec.quarters,
      averageFinalCashUsd: 500_000,
      topReasonCodeCounts: [{ code: "RAW_MATERIAL_SHORTAGE", count: spec.cases.length }],
      totalWarningCount: spec.cases.length * spec.quarters * 2,
    },
    errors: [] as unknown[],
  };

  return {
    "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
    "case-summary.csv": [csvLine(caseSummaryHeader), ...caseSummaryRows].join("\n") + "\n",
    "quarter-summary.csv": [csvLine(quarterSummaryHeader), ...quarterSummaryRows].join("\n") + "\n",
    "decision-trace.jsonl": decisionTraceLines.join("\n") + "\n",
    "adjustment-trace.csv": [
      csvLine(["seed", "companyId", "turn", "period", "category", "source", "code", "severity", "affectedDecision", "affectedMarketOrProduct", "before", "after", "delta", "message", "threshold", "relevantMetric"]),
      ...adjustmentTraceRows,
    ].join("\n") + "\n",
    "warnings.csv": [csvLine(["seed", "companyId", "turn", "period", "code", "source", "severity", "message"]), ...warningsRows].join("\n") + "\n",
    "market-allocation-trace.csv": [csvLine(marketAllocationTraceHeader), ...marketAllocationTraceRows].join("\n") + "\n",
    "run-summary.json": JSON.stringify(runSummary, null, 2) + "\n",
  };
}
