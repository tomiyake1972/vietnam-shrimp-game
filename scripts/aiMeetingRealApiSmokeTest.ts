// ShrimpX V2 — AI Management Meeting M1.1: 実Claude API Smoke Test
//
// ChatGPT #05からの指示（AI Management Meeting M1.1 — Real API Smoke Test / Sales
// Schema Final Check）§1・§2・§5対応。ANTHROPIC_API_KEYが利用可能な開発環境でのみ、
// 開発者が手動でこのスクリプトを実行する（CIには一切組み込まない。npm test/tscから
// このスクリプト自体を呼ぶことはない）。
//
// 8つの最低ケース（CFO質問・COO質問・Commercial質問・CEO/strategy質問・
// CEO summary要求・primary+secondaryが必要な投資質問・structured proposalを返す質問・
// 比較的長いPlayer message）に加え、M2.1で追加したTest26 BAL Turn1の実再現ケース
// （「前回の営業結果を教えて」）を、claude-haiku-4-5-20251001へ実際に送信し、各callで
// model/inputTokens/outputTokens/latencyMs/stopReason/retryCount/schema validation
// success-failure/primarySpeaker/secondary speaker/proposal countを記録する。
// 本文内容も開発用ログへ出す（API keyそのものは一切ログへ出さない）。
//
// ANTHROPIC_API_KEY未設定の場合は、実行せずREAL_API_SMOKE_NOT_RUNと明記した
// レポートのみを生成する（§5対応）。
//
// 使い方: ANTHROPIC_API_KEY=sk-... npx tsx scripts/aiMeetingRealApiSmokeTest.ts

import * as fs from "fs";
import * as path from "path";
import { generateMeetingResponse, getMeetingModelConfig } from "../app/lib/v2/companyLab/aiManagementMeeting/claudeClient";
import { buildMeetingUserMessage } from "../app/lib/v2/companyLab/aiManagementMeeting/prompt";
import { buildRecentHistoryForPrompt } from "../app/lib/v2/companyLab/aiManagementMeeting/conversation";
import { routePlayerMessage } from "../app/lib/v2/companyLab/aiManagementMeeting/router";
import { AiMeetingMessage } from "../app/lib/v2/companyLab/aiManagementMeeting/types";

/**
 * 実際のExecutiveBriefingPacketに近い、代表的な内容のダミーbriefing（実APIの応答品質を
 * 見るための現実的な入力）。【M2.1訂正】backlogはhealthy forward/due this turn/overdueを
 * 分離した形（backlogSemantics.ts・briefing.ts参照）へ、supplyPressureは生countではなく
 * label+humanMeaningへ更新した。
 */
function sampleBriefing() {
  return {
    common: {
      companyId: "BAL",
      turn: 6,
      year: 2016,
      quarter: 2,
      cashUsd: 1_250_000,
      bindingCapacityTons: 5200,
      bindingConstraintLabel: "共通前処理",
      backlog: { totalTons: 220, healthyForwardTons: 220, dueThisTurnTons: 0, overdueTons: 0 },
      playerDraft: { hasDraft: true, totalDesiredSalesQuantityTons: 4200, capexProposalCount: 0, financingRequestedUsd: 0 },
      standardAiReasonCodesTopN: [
        { code: "CAPEX_DEFERRED", domain: "capex", severity: "high", targetFactoryId: "F1" },
        { code: "PD_MECH_LOW_UTILIZATION", domain: "capex", severity: "medium", targetFactoryId: "F1" },
      ],
    },
    cfo: {
      totalAssetsUsd: 6_000_000,
      totalLiabilitiesUsd: 2_500_000,
      totalEquityUsd: 3_500_000,
      shortTermLoansUsd: 400_000,
      longTermLoansUsd: 900_000,
      activeLoanCount: 3,
      payablesUsd: 300_000,
      receivablesUsd: 550_000,
      receivablesScheduleByPeriod: [{ periodLabel: "2016年Q3", amountUsd: 550_000, turnsFromNow: 1 }],
      payablesScheduleByPeriod: [{ periodLabel: "2016年Q3", amountUsd: 300_000, turnsFromNow: 1 }],
      loanArrearsPrincipalUsd: 0,
      loanArrearsInterestUsd: 0,
      activeCapexRemainingCommitmentUsd: 0,
      borrowingHeadroom: { availableAdditionalCapacityUsd: 1_200_000, asOfLabel: "2016年Q1" },
      crisis: { state: "NORMAL", summary: "資金繰りは平常。" },
      previousQuarter: { cashUsd: 1_100_000, netRevenueUsd: 2_800_000, operatingProfitUsd: 210_000, periodLabel: "2016年Q1" },
    },
    coo: {
      factoryCapacityTopN: [{ factoryId: "F1", nominalTotalTons: 8000, effectiveTotalTons: 6700 }],
      nominalTotalTons: 8000,
      effectiveTotalTons: 6700,
      rawMaterialTotalTons: 950,
      totalRegularHeadcount: 240,
      qualityScoreByProduct: { hoso: 82, pd: 78, vap: 88 },
      backlogByProduct: [
        { product: "pd", totalTons: 180, overdueTons: 0 },
        { product: "hoso", totalTons: 40, overdueTons: 0 },
      ],
    },
    commercial: {
      backlog: { totalTons: 220, healthyForwardTons: 220, dueThisTurnTons: 0, overdueTons: 0 },
      backlogByMarket: [
        { market: "JP", totalTons: 180, overdueTons: 0 },
        { market: "US", totalTons: 40, overdueTons: 0 },
      ],
      backlogByProduct: [
        { product: "pd", totalTons: 180, overdueTons: 0 },
        { product: "hoso", totalTons: 40, overdueTons: 0 },
      ],
      backlogByMarketProduct: [
        { market: "JP", product: "pd", totalTons: 180, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 180, earliestDueLabel: "2016年Q3" },
        { market: "US", product: "hoso", totalTons: 40, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 40, earliestDueLabel: "2016年Q4" },
      ],
      customerTrustByMarket: { JP: 72, US: 65 },
      deliveryReliabilityByMarket: { JP: 90, US: 93 },
      salesForceHeadcountTotal: 22,
      salesForceCoverageScore: 0.68,
      lastQuarterNetRevenueUsd: 2_800_000,
      lastQuarterLabel: "2016年Q1",
      hasPriorMarketData: true,
      supplyPressureFacts: [
        { product: "pd", value: 0.02, label: "balanced", humanMeaning: "市場全体の需給はおおむね均衡" },
        { product: "vap", value: 0.15, label: "oversupply", humanMeaning: "市場全体で供給が需要を上回る方向（価格・受注獲得はしやすいが、過剰在庫リスクに注意）" },
      ],
      lifecycleTrendSummary: { growingCount: 2, shrinkingCount: 1, flatCount: 12, humanMeaning: "growing=構成比拡大傾向、shrinking=構成比縮小傾向、flat=ほぼ横ばい" },
    },
    ceo: {
      topSeverityReasonCodesTopN: [{ code: "CAPEX_DEFERRED", severity: "high" }],
      domainsInvolved: ["capex", "sales"],
    },
  };
}

/**
 * 【M2.1追加】Test26 BAL Turn1の実再現ケース用briefing。overdue=0の健全なforward
 * backlog（US/EU/JP/OTHER HOSO、合計3,063.42t、すべて未到来納期）を持つturn1状態。
 * 前四半期データが存在しない（turn1のため）ことも忠実に再現する。
 */
function test26Turn1Briefing() {
  return {
    common: {
      companyId: "BAL",
      turn: 1,
      year: 2015,
      quarter: 1,
      cashUsd: 38_200_000,
      bindingCapacityTons: 6000,
      bindingConstraintLabel: "商品別実効能力",
      backlog: { totalTons: 3063.42, healthyForwardTons: 3063.42, dueThisTurnTons: 0, overdueTons: 0 },
      playerDraft: null,
      standardAiReasonCodesTopN: [],
    },
    // 【M2.2追加・実装指示§17】Test26 BAL Turn1相当（Cash≈38.2M/Debt≈50.6M/AR≈66.4M）。
    cfo: {
      totalAssetsUsd: 120_000_000,
      totalLiabilitiesUsd: 50_600_000,
      totalEquityUsd: 69_400_000,
      shortTermLoansUsd: 10_600_000,
      longTermLoansUsd: 40_000_000,
      activeLoanCount: 2,
      payablesUsd: 0,
      receivablesUsd: 66_400_000,
      // AR残高は「即時使える現金」ではなく、実際の回収予定四半期（1四半期後）を明示する。
      receivablesScheduleByPeriod: [{ periodLabel: "2015年Q2", amountUsd: 66_400_000, turnsFromNow: 1 }],
      payablesScheduleByPeriod: [],
      loanArrearsPrincipalUsd: 0,
      loanArrearsInterestUsd: 0,
      activeCapexRemainingCommitmentUsd: 0,
      borrowingHeadroom: null,
      crisis: { state: "NORMAL", summary: "資金繰りは平常。" },
      previousQuarter: null,
    },
    coo: {
      factoryCapacityTopN: [{ factoryId: "F1", nominalTotalTons: 8000, effectiveTotalTons: 6700 }],
      nominalTotalTons: 8000,
      effectiveTotalTons: 6700,
      rawMaterialTotalTons: 500,
      totalRegularHeadcount: 200,
      qualityScoreByProduct: { hoso: 75, pd: 70, vap: 80 },
      backlogByProduct: [{ product: "hoso", totalTons: 3063.42, overdueTons: 0 }],
    },
    commercial: {
      backlog: { totalTons: 3063.42, healthyForwardTons: 3063.42, dueThisTurnTons: 0, overdueTons: 0 },
      backlogByMarket: [
        { market: "US", totalTons: 1367.43, overdueTons: 0 },
        { market: "EU", totalTons: 588.3, overdueTons: 0 },
        { market: "JP", totalTons: 336.51, overdueTons: 0 },
        { market: "OTHER", totalTons: 771.18, overdueTons: 0 },
      ],
      backlogByProduct: [{ product: "hoso", totalTons: 3063.42, overdueTons: 0 }],
      backlogByMarketProduct: [
        { market: "US", product: "hoso", totalTons: 1367.43, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 1367.43, earliestDueLabel: "2015年Q2" },
        { market: "EU", product: "hoso", totalTons: 588.3, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 588.3, earliestDueLabel: "2015年Q2" },
        { market: "JP", product: "hoso", totalTons: 336.51, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 336.51, earliestDueLabel: "2015年Q2" },
        { market: "OTHER", product: "hoso", totalTons: 771.18, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 771.18, earliestDueLabel: "2015年Q2" },
      ],
      customerTrustByMarket: { US: 50, EU: 50, JP: 50, OTHER: 50 },
      deliveryReliabilityByMarket: { US: 50, EU: 50, JP: 50, OTHER: 50 },
      salesForceHeadcountTotal: 15,
      salesForceCoverageScore: 0.5,
      lastQuarterNetRevenueUsd: null,
      lastQuarterLabel: null,
      hasPriorMarketData: false,
      supplyPressureFacts: [],
      lifecycleTrendSummary: null,
    },
    ceo: { topSeverityReasonCodesTopN: [], domainsInvolved: [] },
  };
}

/**
 * 【M2.3追加・実装指示§20】Test26 BAL Turn2の実再現ケース用briefing。CFOが
 * 「売掛金の現金回収の遅れが営業利益の赤字要因」と誤回答した実会話を再現する。
 * §10の実データ（Turn1 grossRevenue≈$66.594M/operatingProfit≈+$6.30M、
 * Turn2 grossRevenue≈$62.938M/operatingProfit≈-$0.059M）に基づく。
 */
function test26Turn2Briefing() {
  const base = test26Turn1Briefing();
  return {
    ...base,
    common: { ...base.common, turn: 2, quarter: 2 },
    cfo: {
      ...base.cfo,
      previousQuarter: { cashUsd: 38_200_000, netRevenueUsd: 66_594_000, operatingProfitUsd: 6_300_000, periodLabel: "2015年Q1" },
      // 【M2.3追加・実装指示§3-§6】P&L/Cash Flow/Balance Sheetを構造的に分離したpacket。
      financialStatements: {
        pnl: {
          periodLabel: "2015年Q2",
          grossRevenue: 62_938_000,
          qualitySalesDeduction: 1_100_000,
          netRevenue: 61_838_000,
          rawMaterialCost: 29_780_000,
          processingCost: 10_760_000,
          laborCost: 6_460_000,
          factoryFixedCost: 5_930_000,
          reworkCost: 200_000,
          discardLoss: 190_000,
          unabsorbedFixedManufacturingCost: 0,
          idleLaborCost: 1_300_000,
          capexMaintenanceCost: 0,
          totalCostOfSales: 54_620_000,
          grossProfit: 7_218_000,
          sellingGeneralAdmin: 5_580_000,
          operatingProfit: -59_000,
          interestExpense: 1_131_000,
          profitBeforeTax: -1_190_000,
          incomeTax: 0,
          netIncome: -1_190_000,
        },
        cashFlow: {
          periodLabel: "2015年Q2",
          receiptsFromCustomers: 66_400_000,
          paymentsForRawMaterials: 29_780_000,
          paymentsForManufacturing: 24_650_000,
          paymentsForSellingGeneralAdmin: 5_580_000,
          interestPaid: 1_131_000,
          incomeTaxPaid: 0,
          operatingCashFlow: 5_259_000,
          investingCashFlow: -2_000_000,
          financingCashFlow: -1_000_000,
          netCashChange: 2_259_000,
          openingCash: 38_200_000,
          closingCash: 40_459_000,
        },
        balanceSheet: {
          periodLabel: "2015年Q2",
          cash: 40_459_000,
          accountsReceivable: 62_938_000,
          rawMaterialInventory: 5_000_000,
          finishedGoodsInventory: 3_000_000,
          accountsPayable: 4_000_000,
          shortTermLoans: 10_600_000,
          longTermLoans: 40_000_000,
          totalDebt: 50_600_000,
          totalEquity: 68_210_000,
        },
      },
      // 【M2.3追加・実装指示§9・§10】Turn1→Turn2のP&L variance（発生主義の差分のみ）。
      pnlVariance: {
        currentPeriodLabel: "2015年Q2",
        priorPeriodLabel: "2015年Q1",
        revenueDelta: -3_656_000,
        qualityDeductionDelta: 100_000,
        rawMaterialCostDelta: -220_000,
        processingCostDelta: 760_000,
        laborCostDelta: 460_000,
        factoryFixedCostDelta: 930_000,
        reworkCostDelta: 0,
        discardLossDelta: -110_000,
        idleLaborCostDelta: 300_000,
        sgaDelta: 580_000,
        operatingProfitDelta: -6_359_000,
      },
      // 【M2.3追加・実装指示§12】数量は増加したが平均実現単価が下落したことを示すfacts。
      volumePriceFacts: {
        currentPeriodLabel: "2015年Q2",
        priorPeriodLabel: "2015年Q1",
        currentVolumeTons: 14_407,
        priorVolumeTons: 12_591,
        volumeDeltaTons: 1_816,
        currentAverageRealizedPriceUsdPerTon: 62_938_000 / 14_407,
        priorAverageRealizedPriceUsdPerTon: 66_594_000 / 12_591,
      },
    },
  };
}

/**
 * 【M2.4追加・実装指示§10】Test26 BAL Turn4の実再現ケース用briefing。「現在の当社業績を
 * 分析して」への回答で、utilization混同・商品別equipment shortageの見落とし・
 * interest-bearing debtとtotal liabilitiesの混同等が残っていた実会話を再現する。
 * 実装指示冒頭の実データ（Cash≈$41.196M、短期借入≈$25.046M、長期借入≈$24.000M、
 * backlog=8,988.43t/overdue=0、equipmentUtilization=47.44%/laborUtilization=95.32%/
 * overtimeRate=8.21%、regularWorkers=4,140/temporaryWorkers=575、
 * endingRawMaterialInventory=0t、rawMaterialShortage=3,074.72t/
 * equipmentShortage=1,015t/laborShortage=0t）に基づく。
 */
function test26Turn4Briefing() {
  const base = test26Turn1Briefing();
  return {
    ...base,
    common: {
      ...base.common,
      turn: 4,
      quarter: 4,
      cashUsd: 41_196_000,
      backlog: { totalTons: 8988.43, healthyForwardTons: 8988.43, dueThisTurnTons: 0, overdueTons: 0 },
    },
    cfo: {
      ...base.cfo,
      totalAssetsUsd: 150_000_000,
      totalLiabilitiesUsd: 64_000_000,
      totalEquityUsd: 86_000_000,
      shortTermLoansUsd: 25_046_000,
      longTermLoansUsd: 24_000_000,
      // 【M2.4追加・実装指示§8】interestBearingDebtUsd（有利子負債のみ）とtotalLiabilitiesUsd（負債合計）を区別。
      interestBearingDebtUsd: 49_046_000,
    },
    coo: {
      ...base.coo,
      rawMaterialTotalTons: 0,
      totalRegularHeadcount: 4140,
      qualityScoreByProduct: { hoso: 76.99, pd: 77.1, vap: 77.26 },
      // 【M2.4追加・実装指示§3】equipmentUtilization/laborUtilization/overtimeRateを別KPIとして保持。
      utilization: {
        periodLabel: "2015年Q4",
        equipmentUtilizationRate: 0.4744,
        laborUtilizationRate: 0.9532,
        overtimeRate: 0.0821,
        temporaryWorkerShare: 575 / (4140 + 575),
      },
      // 【M2.4追加・実装指示§4・§5】rawMaterial/equipment/laborのshortfall優先順位＋商品別equipment shortage。
      bottleneck: {
        periodLabel: "2015年Q4",
        rawMaterialShortageTons: 3074.72,
        equipmentShortageTons: 1015,
        laborShortageTons: 0,
        primaryBottleneck: "RAW_MATERIAL",
        secondaryBottleneck: "EQUIPMENT",
        productBottlenecks: [{ product: "pd", rawMaterialShortageTons: 0, equipmentShortageTons: 1015, laborShortageTons: 0 }],
      },
      // 【M2.4追加・実装指示§6】opening/ending/in-transit/domestic purchaseを区別した在庫。
      inventory: {
        periodLabel: "2015年Q4",
        endingRawMaterialInventoryTons: 0,
        openingRawMaterialInventoryTons: 1200,
        endingFinishedGoodsInventoryTons: 2500,
        importInTransitTons: 300,
        importArrivedTons: 4500,
        domesticPurchaseTons: 6000,
      },
      // 【M2.4追加・実装指示§7】regular/temporary workerを別項目化。
      workforce: { periodLabel: "2015年Q4", regularWorkers: 4140, temporaryWorkers: 575, overtimeRate: 0.0821 },
    },
    commercial: {
      ...base.commercial,
      backlog: { totalTons: 8988.43, healthyForwardTons: 8988.43, dueThisTurnTons: 0, overdueTons: 0 },
      backlogByMarketProduct: [
        { market: "US", product: "pd", totalTons: 4000, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 4000, earliestDueLabel: "2016年Q1" },
        { market: "EU", product: "pd", totalTons: 1549.61, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 1549.61, earliestDueLabel: "2016年Q1" },
      ],
      customerTrustByMarket: { US: 56.5, EU: 56.5, JP: 56.5, OTHER: 56.5 },
    },
  };
}

/**
 * 【M2.5追加・実装指示§9・§20】Test26系の新規BAL Turn1の実再現ケース用briefing。
 * COO/CFO/Commercialが揃って、overdueTons=0のfuture backlog（US HOSO 1,443.43t・
 * OTHER HOSO 814.04t、いずれも2015Q2納期＝次四半期）を「期限オーバー」と誤って
 * 説明し、14,107.5t（商品別ライン合計）を「会社全体の実効生産能力」と呼んだ実会話を
 * 再現する。実装指示§9の実データ（ending backlog=3,625.95t/overdue=0、capacity pools
 * common=25,650t/HOSO=6,840t/PD=5,985t/VAP=1,282.5t/freezing=25,650t、
 * ending raw inventory=0t）に基づく。
 */
function test26M25Turn1Briefing() {
  return {
    common: {
      companyId: "BAL",
      turn: 1,
      year: 2015,
      quarter: 1,
      cashUsd: 38_200_000,
      bindingCapacityTons: 14107.5,
      bindingConstraintLabel: "商品別実効能力",
      backlog: { totalTons: 3625.95, healthyForwardTons: 3625.95, dueThisTurnTons: 0, overdueTons: 0, status: "FUTURE_DUE" },
      playerDraft: null,
      standardAiReasonCodesTopN: [],
    },
    cfo: {
      totalAssetsUsd: 120_000_000,
      totalLiabilitiesUsd: 50_600_000,
      totalEquityUsd: 69_400_000,
      shortTermLoansUsd: 10_600_000,
      longTermLoansUsd: 40_000_000,
      activeLoanCount: 2,
      payablesUsd: 0,
      receivablesUsd: 0,
      receivablesScheduleByPeriod: [],
      payablesScheduleByPeriod: [],
      loanArrearsPrincipalUsd: 0,
      loanArrearsInterestUsd: 0,
      activeCapexRemainingCommitmentUsd: 0,
      borrowingHeadroom: null,
      crisis: { state: "NORMAL", summary: "資金繰りは平常。" },
      previousQuarter: null,
      interestBearingDebtUsd: 50_600_000,
    },
    coo: {
      factoryCapacityTopN: [{ factoryId: "F1", nominalTotalTons: 16000, effectiveTotalTons: 14107.5 }],
      nominalTotalTons: 16000,
      effectiveTotalTons: 14107.5,
      rawMaterialTotalTons: 0,
      totalRegularHeadcount: 200,
      qualityScoreByProduct: { hoso: 75, pd: 70, vap: 80 },
      backlogByProduct: [{ product: "hoso", totalTons: 3625.95, overdueTons: 0, status: "FUTURE_DUE" }],
      // 【M2.5追加・実装指示§4・§5】14,107.5tは商品別ライン合計であり、共通前処理(25,650t)・凍結包装(25,650t)は別pool。
      capacityPools: {
        commonProcessingTons: 25650,
        freezingPackagingTons: 25650,
        hosoTons: 6840,
        pdTons: 5985,
        vapTons: 1282.5,
        productLineSumTons: 14107.5,
        bindingTons: 14107.5,
        bindingPoolLabel: "商品別実効能力",
      },
      // 【M2.5追加・実装指示§6】decision時点の現在在庫のみ（今期の調達は別事象）。
      rawMaterialAvailability: { currentOnHandTons: 0 },
    },
    commercial: {
      backlog: { totalTons: 3625.95, healthyForwardTons: 3625.95, dueThisTurnTons: 0, overdueTons: 0, status: "FUTURE_DUE" },
      backlogByMarket: [
        { market: "US", totalTons: 1443.43, overdueTons: 0, status: "FUTURE_DUE" },
        { market: "OTHER", totalTons: 814.04, overdueTons: 0, status: "FUTURE_DUE" },
        { market: "EU", totalTons: 3625.95 - 1443.43 - 814.04, overdueTons: 0, status: "FUTURE_DUE" },
      ],
      backlogByProduct: [{ product: "hoso", totalTons: 3625.95, overdueTons: 0, status: "FUTURE_DUE" }],
      backlogByMarketProduct: [
        {
          market: "US",
          product: "hoso",
          totalTons: 1443.43,
          overdueTons: 0,
          dueThisTurnTons: 0,
          healthyForwardTons: 1443.43,
          earliestDueLabel: "2015年Q2",
          status: "FUTURE_DUE",
        },
        {
          market: "OTHER",
          product: "hoso",
          totalTons: 814.04,
          overdueTons: 0,
          dueThisTurnTons: 0,
          healthyForwardTons: 814.04,
          earliestDueLabel: "2015年Q2",
          status: "FUTURE_DUE",
        },
      ],
      customerTrustByMarket: { US: 50, EU: 50, JP: 50, OTHER: 50 },
      deliveryReliabilityByMarket: { US: 50, EU: 50, JP: 50, OTHER: 50 },
      salesForceHeadcountTotal: 15,
      salesForceCoverageScore: 0.5,
      lastQuarterNetRevenueUsd: null,
      lastQuarterLabel: null,
      hasPriorMarketData: false,
      supplyPressureFacts: [],
      lifecycleTrendSummary: null,
    },
    ceo: { topSeverityReasonCodesTopN: [], domainsInvolved: [] },
  };
}

interface SmokeCase {
  readonly label: string;
  readonly playerMessage: string;
  readonly historyCount: number;
  /** 【M2.1追加】trueの場合、通常のsampleBriefing()ではなくtest26Turn1Briefing()を使う。 */
  readonly useTest26Briefing?: boolean;
  /** 【M2.3追加】trueの場合、test26Turn2Briefing()（accounting grounding再現ケース）を使う。 */
  readonly useTest26Turn2Briefing?: boolean;
  /** 【M2.4追加】trueの場合、test26Turn4Briefing()（operational KPI grounding再現ケース）を使う。 */
  readonly useTest26Turn4Briefing?: boolean;
  /** 【M2.5追加】trueの場合、test26M25Turn1Briefing()（due-date/capacity pool grounding再現ケース）を使う。 */
  readonly useTest26M25Turn1Briefing?: boolean;
}

const SMOKE_CASES: readonly SmokeCase[] = [
  { label: "1. CFO質問", playerMessage: "今期、この投資をして資金繰りは大丈夫？", historyCount: 0 },
  { label: "2. COO質問", playerMessage: "PDラインだけ増やせば足りる？", historyCount: 0 },
  { label: "3. Commercial質問", playerMessage: "日本向け販売をもっと増やしたい。どう思う？", historyCount: 0 },
  { label: "4. CEO/strategy質問", playerMessage: "もっと攻めたい。", historyCount: 0 },
  { label: "5. CEO summary要求", playerMessage: "CFOとCOOとCommercialそれぞれの意見を踏まえて、結論として何をやるべき？", historyCount: 3 },
  { label: "6. primary+secondaryが必要な投資質問", playerMessage: "PDラインの増設投資をしたいが、現金は足りているか、工場の稼働率的にも意味があるか教えて。", historyCount: 0 },
  {
    label: "7. structured proposalを返す質問",
    playerMessage: "具体的にどんな投資・販売の提案があるか、numberを含めて提案してほしい。",
    historyCount: 2,
  },
  {
    label: "8. 比較的長いPlayer message",
    playerMessage:
      "今期の状況を踏まえて、来期以降の方針について相談したい。日本向けのPD商品のbacklogが超過気味で気になっている一方、" +
      "現金残高は前四半期より改善している。工場の稼働率も高めだと思うが、追加投資をすべきか、それとも営業体制を強化して" +
      "既存の生産能力の中で売り方を変えるべきか、財務・生産・営業それぞれの立場から総合的に助言してほしい。",
    historyCount: 0,
  },
  {
    // 【M2.1追加・§9対応】Test26 BAL Turn1で実際に誤回答（healthy forward backlogを
    // 「納期遅延」「Trustを蝕んでいる」と誤説明、3,063tを「3,600t超」と誤って述べ、
    // supplyPressureCount=2から「市場は供給に余裕」と自由解釈）が発生した、実際の
    // プレイヤー発言そのものでの再現テスト。期待する回答の方向性は、売上実績・受注実績・
    // forward backlog・overdue=0・次期納期への準備を区別し、「納期遅延」「Trustを
    // 蝕んでいる」を根拠なしに言わないこと。
    label: "9A. Test26 BAL Turn1再現（backlog grounding）",
    playerMessage: "前回の営業結果を教えて",
    historyCount: 0,
    useTest26Briefing: true,
  },
  {
    // 【M2.2追加・実装指示§17・§22B対応】CFOのfinance grounding（false overdue・
    // unsupported Trust→AR delayを含まないこと）を確認する。
    label: "9B. Test26 BAL Turn1再現（investment affordability）",
    playerMessage: "財務的にはどうでしょう。各種投資をする余裕はあるでしょうか。",
    historyCount: 0,
    useTest26Briefing: true,
  },
  {
    // 【M2.2追加・実装指示§22C対応】AR残高($66.4M)を「2Qに入金される＝今すぐ使える」と
    // 誤認させようとするプレイヤー発言。CFOはreceivablesScheduleByPeriod（実際の回収予定）
    // に基づき、現金そのものではないことを区別できるかを確認する。
    label: "9C. Test26 BAL Turn1再現（AR = 使える現金か）",
    playerMessage: "CFOさん、売掛債権は2Qに入金されるから使えるお金ではないの？",
    historyCount: 0,
    useTest26Briefing: true,
  },
  {
    // 【M2.2追加・実装指示§22D対応】プレイヤーによる明示的な訂正。playerCorrectionStatus=
    // CONFIRMEDとなるべきケース（BriefingPacket上overdueTons=0で裏付けられる）。
    label: "9D. Test26 BAL Turn1再現（player correction）",
    playerMessage: "受注残は納期遅延ではないです。",
    historyCount: 0,
    useTest26Briefing: true,
  },
  {
    // 【M2.3追加・実装指示§20】Test26 BAL Turn2で実際に誤回答（AR回収遅延がOperating Profit
    // 赤字の原因、と会計上誤って説明）した、実際のプレイヤー発言そのものでの再現テスト。
    // 期待する回答の方向性: Operating Profit≈-$0.06M（前期+$6.3Mから急激に悪化）、
    // 売上は約$3.7M減少、加工費・労務費・工場固定費・SG&Aは増加、販売数量自体は増加、
    // 市場価格の下落が主因、AR回収はOperating Profitの原因ではない、というP&L事実に基づく説明。
    label: "9E. Test26 BAL Turn2再現（P&L/Cash/BS混同なしの営業赤字説明）",
    playerMessage: "2Qが営業赤字ですか？理由は？",
    historyCount: 0,
    useTest26Turn2Briefing: true,
  },
  {
    // 【M2.4追加・実装指示§10・§20】Test26 BAL Turn4で実際に問題が残った、実際の
    // プレイヤー発言そのものでの再現テスト。期待する回答の方向性: 「工場全体が能力上限」
    // と言わない（equipmentUtilization 47.44% != laborUtilization 95.32%）、PD equipment
    // shortage(1,015t)を局所的制約として区別、primary bottleneckはraw material、
    // labor shortageによるlost productionは無いと明示、backlog 8,988tはoverdue=0の
    // forward backlogであり現在の納期遅延ではない、US PD4,000/EU PD1,550は次期納期の
    // obligationとして述べる、有利子負債($49.0M)と負債合計($64M)を混同しない。
    label: "9F. Test26 BAL Turn4再現（operational KPI grounding・wide question）",
    playerMessage: "現在の当社業績を分析して",
    historyCount: 0,
    useTest26Turn4Briefing: true,
  },
  {
    // 【M2.5追加・実装指示§9・§20】Test26系の新規BAL Turn1で実際に問題が残った、
    // 実際のプレイヤー発言そのものでの再現テスト。期待する回答の方向性:
    // overdueTons=0のため「期限オーバー」「納期遅延」等の禁止語彙を一切使わない、
    // US HOSO 1,443.43t/OTHER HOSO 814.04tを次四半期の履行義務（FUTURE_DUE）として
    // 説明する、14,107.5t（商品別ライン合計）を「会社全体の実効生産能力」と呼ばず、
    // common preprocessing(25,650t)・freezing/packing(25,650t)という別poolの存在を
    // 明示する、現在在庫0tと今期調達可能性を分離する、future backlogの存在だけで
    // CAPEXを必要と断定しない。
    label: "9G. Test26 BAL Turn1再現（due-date grounding・capacity pool semantics）",
    playerMessage: "現状を分析してください",
    historyCount: 0,
    useTest26M25Turn1Briefing: true,
  },
];

function dummyHistory(count: number): AiMeetingMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `hist-${i}`,
    speaker: i % 2 === 0 ? "PLAYER" : "CFO",
    text: i % 2 === 0 ? "以前の質問の一例です。" : "以前の回答の一例です。現金は問題ありません。",
    turn: 6,
    proposalIds: [],
    factsUsed: [],
  }));
}

interface CaseResult {
  readonly label: string;
  readonly playerMessagePreview: string;
  readonly ok: boolean;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
  readonly stopReason: string | null;
  readonly retryCount: number;
  readonly schemaValidationResult: string;
  readonly primarySpeaker: string | null;
  readonly secondarySpeaker: string | null;
  readonly responseCount: number;
  readonly proposalCount: number;
  readonly errorCategory?: string;
}

async function runCase(scenario: SmokeCase): Promise<CaseResult> {
  const briefing = scenario.useTest26M25Turn1Briefing
    ? test26M25Turn1Briefing()
    : scenario.useTest26Turn4Briefing
      ? test26Turn4Briefing()
      : scenario.useTest26Turn2Briefing
        ? test26Turn2Briefing()
        : scenario.useTest26Briefing
          ? test26Turn1Briefing()
          : sampleBriefing();
  const history = dummyHistory(scenario.historyCount);
  const { recent, compactSummary } = buildRecentHistoryForPrompt(history);
  const routing = routePlayerMessage(scenario.playerMessage);
  const userMessage = buildMeetingUserMessage({
    briefing,
    standardAiDecisionSummary: { topReasonCodes: briefing.common.standardAiReasonCodesTopN.map((r) => r.code) },
    recentHistory: recent.map((m) => ({ speaker: m.speaker, text: m.text })),
    compactSummary,
    playerMessage: scenario.playerMessage,
    routingHint: routing,
    meetingIntentHint: null,
    confirmedCorrections: [],
    repairNote: null,
  });

  const result = await generateMeetingResponse(userMessage, undefined, { labId: "smoke", companyId: "BAL", turn: 6 });

  if (!result.ok) {
    return {
      label: scenario.label,
      playerMessagePreview: scenario.playerMessage.slice(0, 40),
      ok: false,
      model: result.diagnostics.model,
      inputTokens: result.diagnostics.inputTokens,
      outputTokens: result.diagnostics.outputTokens,
      latencyMs: result.diagnostics.latencyMs,
      stopReason: result.diagnostics.stopReason,
      retryCount: result.diagnostics.retryCount,
      schemaValidationResult: result.diagnostics.schemaValidationResult,
      primarySpeaker: null,
      secondarySpeaker: null,
      responseCount: 0,
      proposalCount: 0,
      errorCategory: result.errorCategory,
    };
  }

  const response = result.response;
  console.log(`\n=== ${scenario.label} ===`);
  console.log(`player: ${scenario.playerMessage}`);
  for (const r of response.responses) {
    console.log(`  [${r.speaker}${r.stance ? `/${r.stance}` : ""}] ${r.text}`);
    if (r.factsUsed.length > 0) console.log(`    factsUsed: ${r.factsUsed.join(", ")}`);
  }
  if (response.proposals.length > 0) {
    console.log(`  proposals: ${response.proposals.map((p) => `${p.domain}(${p.id})`).join(", ")}`);
  }

  const secondary = response.responses.find((r) => r.speaker !== response.primarySpeaker && r.speaker !== "CEO") ?? null;

  return {
    label: scenario.label,
    playerMessagePreview: scenario.playerMessage.slice(0, 40),
    ok: true,
    model: result.diagnostics.model,
    inputTokens: result.diagnostics.inputTokens,
    outputTokens: result.diagnostics.outputTokens,
    latencyMs: result.diagnostics.latencyMs,
    stopReason: result.diagnostics.stopReason,
    retryCount: result.diagnostics.retryCount,
    schemaValidationResult: result.diagnostics.schemaValidationResult,
    primarySpeaker: response.primarySpeaker,
    secondarySpeaker: secondary?.speaker ?? null,
    responseCount: response.responses.length,
    proposalCount: response.proposals.length,
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function main() {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "ai_meeting_real_api_smoke_test.md");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    const lines = [
      "# AI Management Meeting — 実Claude API Smoke Test",
      "",
      "## REAL_API_SMOKE_NOT_RUN",
      "",
      "ANTHROPIC_API_KEYが本セッションの環境に設定されていないため、実APIでのsmoke testは実施していない。",
      "",
      "## 実施手順（開発者がAPI keyを利用できる環境で手動実行する場合）",
      "",
      "```",
      "ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/aiMeetingRealApiSmokeTest.ts",
      "```",
      "",
      "- CIには一切組み込まない（このスクリプトは`npm test`からは呼ばれない）。",
      "- 8つの最低ケース（CFO質問・COO質問・Commercial質問・CEO/strategy質問・CEO summary要求・",
      "  primary+secondaryが必要な投資質問・structured proposalを返す質問・比較的長いPlayer message）に加え、",
      "  Test26 BAL Turn1の実再現ケース（「前回の営業結果を教えて」、overdue=0のhealthy forward",
      "  backlogのみを持つturn1状態、M2.2でinvestment affordability/AR認識/player correctionの3ケースを追加）を",
      "  含む計12ケースを順に実行し、各callのmodel/inputTokens/outputTokens/latencyMs/stopReason/retryCount/",
      "  schemaValidationResult/primarySpeaker/secondarySpeaker/proposalCountを本ファイルへ出力する。",
      "- 実行後は、本文内容（開発用ログにのみ出力。API keyはログへ出さない）を人手で確認し、",
      "  役員らしさ・役割の混在有無・数値の捏造有無・Standard AIへの反論可否・回答の簡潔さ・",
      "  factsUsedの妥当性・日本語の自然さを評価する（本スクリプトは自動評価しない）。",
      "",
    ];
    fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
    console.log("REAL_API_SMOKE_NOT_RUN");
    console.log(`Wrote ${outPath}`);
    return;
  }

  const config = getMeetingModelConfig();
  const results: CaseResult[] = [];
  for (const scenario of SMOKE_CASES) {
    const result = await runCase(scenario);
    results.push(result);
  }

  const lines: string[] = [];
  lines.push("# AI Management Meeting — 実Claude API Smoke Test");
  lines.push("");
  lines.push(`実行日時: ${new Date().toISOString()} / モデル: ${config.model} / 実行件数: ${results.length}`);
  lines.push("");
  lines.push("## 各callの計測結果");
  lines.push("");
  lines.push("| ケース | ok | inputTokens | outputTokens | latencyMs | stopReason | retryCount | schemaResult | primary | secondary | responses | proposals |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      `| ${r.label} | ${r.ok} | ${r.inputTokens ?? "-"} | ${r.outputTokens ?? "-"} | ${r.latencyMs} | ${r.stopReason ?? "-"} | ${r.retryCount} | ${r.schemaValidationResult} | ${r.primarySpeaker ?? "-"} | ${r.secondarySpeaker ?? "-"} | ${r.responseCount} | ${r.proposalCount} |`
    );
  }
  lines.push("");

  const okResults = results.filter((r) => r.ok);
  const successRate = results.length > 0 ? (okResults.length / results.length) * 100 : 0;
  const inputTokenValues = okResults.map((r) => r.inputTokens ?? 0).filter((v) => v > 0);
  const outputTokenValues = okResults.map((r) => r.outputTokens ?? 0).filter((v) => v > 0);
  const latencyValues = results.map((r) => r.latencyMs);
  const truncated = results.some((r) => r.schemaValidationResult === "max_tokens_truncation");
  const totalRetries = results.reduce((sum, r) => sum + r.retryCount, 0);

  lines.push("## サマリ");
  lines.push("");
  lines.push(`- schema success rate: ${successRate.toFixed(1)}% (${okResults.length}/${results.length})`);
  lines.push(`- retry合計: ${totalRetries}`);
  lines.push(`- truncation observed: ${truncated ? "yes" : "no"}`);
  lines.push(`- inputTokens: avg=${Math.round(mean(inputTokenValues))} max=${inputTokenValues.length > 0 ? Math.max(...inputTokenValues) : "-"}`);
  lines.push(`- outputTokens: avg=${Math.round(mean(outputTokenValues))} max=${outputTokenValues.length > 0 ? Math.max(...outputTokenValues) : "-"}`);
  lines.push(`- latencyMs: avg=${Math.round(mean(latencyValues))} max=${latencyValues.length > 0 ? Math.max(...latencyValues) : "-"}`);
  lines.push("");
  lines.push("本文内容（役員らしさ・役割混在有無・数値捏造有無・反論可否・簡潔さ・factsUsed妥当性・日本語の自然さ）は、");
  lines.push("このMarkdownには含めない（開発用コンソールログにのみ出力。API keyや機微な経営数値の永続化を避けるため）。");
  lines.push("実行した開発者が、コンソール出力を目視で確認して評価すること。");
  lines.push("");

  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
