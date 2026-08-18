// AMM-ACC-1..12（AMM-M2.3・実装指示§19）— CFO Accounting Grounding / P&L-Cash-BS Separation / Variance Analysis。
//
// 【背景】Test26 BAL Turn2で、CFOが「売上債権の現金回収の遅れが営業利益の赤字要因」と
// 説明した（会計上の誤り）。本テストは、pnlSemantics.ts / briefing.ts / prompt.ts が
// P&L・Cash Flow・Balance Sheetを構造的に分離し、Operating Profitの説明にAR回収タイミングを
// 混入させないこと、Operating ProfitとNet Incomeを区別することを確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBalanceSheetPacket,
  buildCashFlowPacket,
  buildPnlPacket,
  computePnlVariance,
  computeVolumePriceFacts,
  PnlVariance,
} from "../pnlSemantics";
import { usd, BalanceSheet, CashFlowStatement, CostOfSalesBreakdown, ProfitAndLossStatement } from "../../../finance/types";
import { AI_MANAGEMENT_MEETING_SYSTEM_PROMPT } from "../prompt";
import { buildExecutiveBriefingPacket, RULE_SEMANTICS } from "../briefing";
import { ExplanationContext } from "../../aiExplanation/buildExplanationContext";

function costOfSales(overrides: Partial<CostOfSalesBreakdown> = {}): CostOfSalesBreakdown {
  return {
    rawMaterialCost: usd(0),
    processingCost: usd(0),
    laborCost: usd(0),
    factoryFixedCost: usd(0),
    reworkCost: usd(0),
    discardLoss: usd(0),
    unabsorbedFixedManufacturingCost: usd(0),
    idleLaborCost: usd(0),
    capexMaintenanceCost: usd(0),
    ...overrides,
  } as CostOfSalesBreakdown;
}

function pnl(overrides: Partial<Omit<ProfitAndLossStatement, "costOfSales">> & { costOfSales?: Partial<CostOfSalesBreakdown> } = {}): ProfitAndLossStatement {
  const { costOfSales: costOverrides, ...rest } = overrides;
  return {
    companyId: "BAL",
    period: "2015Q2",
    grossRevenue: usd(0),
    qualitySalesDeduction: usd(0),
    netRevenue: usd(0),
    costOfSales: costOfSales(costOverrides),
    totalCostOfSales: usd(0),
    grossProfit: usd(0),
    sellingGeneralAdmin: usd(0),
    operatingProfit: usd(0),
    interestExpense: usd(0),
    profitBeforeTax: usd(0),
    incomeTax: usd(0),
    netIncome: usd(0),
    ...rest,
  } as unknown as ProfitAndLossStatement;
}

function cashFlow(overrides: Partial<CashFlowStatement> = {}): CashFlowStatement {
  return {
    companyId: "BAL",
    period: "2015Q2",
    operatingDirect: {
      receiptsFromCustomers: usd(0),
      paymentsForRawMaterials: usd(0),
      paymentsForManufacturing: usd(0),
      paymentsForSellingGeneralAdmin: usd(0),
      interestPaid: usd(0),
      incomeTaxPaid: usd(0),
    },
    operatingCashFlow: usd(0),
    investingCashFlow: usd(0),
    financingCashFlow: usd(0),
    netCashChange: usd(0),
    openingCash: usd(0),
    closingCash: usd(0),
    indirectReconciliation: undefined,
    directIndirectDifference: usd(0),
    ...overrides,
  } as unknown as CashFlowStatement;
}

function balanceSheet(overrides: Partial<BalanceSheet> = {}): BalanceSheet {
  return {
    companyId: "BAL",
    period: "2015Q2",
    cash: usd(0),
    accountsReceivable: usd(0),
    rawMaterialInventory: usd(0),
    finishedGoodsInventory: usd(0),
    otherCurrentAssets: usd(0),
    fixedAssetsNet: usd(0),
    constructionInProgress: usd(0),
    totalAssets: usd(0),
    accountsPayable: usd(0),
    shortTermLoans: usd(0),
    longTermLoans: usd(0),
    accruedInterestPayable: usd(0),
    otherLiabilities: usd(0),
    totalLiabilities: usd(0),
    capitalStock: usd(0),
    retainedEarnings: usd(0),
    totalEquity: usd(0),
    totalLiabilitiesAndEquity: usd(0),
    balanceDifference: usd(0),
    ...overrides,
  } as unknown as BalanceSheet;
}

test("AMM-ACC-1: PnlVarianceにAR（売掛金）関連フィールドが一切存在しない（AR回収遅れをOperating Profitの原因として構造上表現できない）", () => {
  const current = pnl();
  const prior = pnl();
  const variance: PnlVariance = computePnlVariance(current, prior, "2015Q2", "2015Q1");
  const keys = Object.keys(variance);
  assert.ok(!keys.some((k) => /receivable/i.test(k)), `PnlVarianceにAR関連キーが存在してはいけない: ${keys.join(",")}`);
  // system promptにも、AR回収タイミングでOperating Profitを説明することを明示的に禁止する文言がある。
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /売掛金の現金回収が遅れたのでOperating Profitが赤字になった[\s\S]*会計上誤り/);
});

test("AMM-ACC-2/3: financialStatements packetはpnl/cashFlow/balanceSheetが構造的に分離され、フィールドが重複しない", () => {
  const pnlPacket = buildPnlPacket(pnl({ netRevenue: usd(100), operatingProfit: usd(10) }), "2015Q2");
  const cfPacket = buildCashFlowPacket(cashFlow({ operatingCashFlow: usd(5) }), "2015Q2");
  const bsPacket = buildBalanceSheetPacket(balanceSheet({ cash: usd(50), accountsReceivable: usd(70) }), "2015Q2");

  const pnlKeys = new Set(Object.keys(pnlPacket));
  const cfKeys = new Set(Object.keys(cfPacket));
  const bsKeys = new Set(Object.keys(bsPacket));

  // periodLabel以外に共通キーが無いこと（P&L / Cash Flow / Balance Sheetが構造上別物であること）を確認する。
  for (const k of pnlKeys) {
    if (k === "periodLabel") continue;
    assert.ok(!cfKeys.has(k), `pnlPacketとcashFlowPacketが同名フィールドを持ってはいけない: ${k}`);
    assert.ok(!bsKeys.has(k), `pnlPacketとbalanceSheetPacketが同名フィールドを持ってはいけない: ${k}`);
  }
  assert.equal(pnlPacket.operatingProfit, 10);
  assert.equal(cfPacket.operatingCashFlow, 5);
  assert.equal(bsPacket.accountsReceivable, 70);
});

test("AMM-ACC-4: Operating ProfitはInterest Expenseを含まない（profitBeforeTax = operatingProfit - interestExpenseの構造）", () => {
  const p = pnl({ operatingProfit: usd(-0.059), interestExpense: usd(1.131), profitBeforeTax: usd(-1.19) });
  const packet = buildPnlPacket(p, "2015Q2");
  assert.ok(Math.abs(packet.operatingProfit - -0.059) < 1e-9);
  assert.ok(Math.abs(packet.profitBeforeTax - (packet.operatingProfit - packet.interestExpense)) < 1e-6);
});

test("AMM-ACC-5: Net IncomeはInterest Expenseの影響を受ける（Operating Profitとは別指標として保持される）", () => {
  const p = pnl({ operatingProfit: usd(-0.059), interestExpense: usd(1.131), profitBeforeTax: usd(-1.19), incomeTax: usd(0), netIncome: usd(-1.19) });
  const packet = buildPnlPacket(p, "2015Q2");
  assert.ok(Math.abs(packet.netIncome - -1.19) < 1e-6);
  assert.notEqual(packet.netIncome, packet.operatingProfit);
});

test("AMM-ACC-6: Cash FlowのフィールドはP&Lの費用科目と別の用語（payments*）で保持され、混同できない", () => {
  const cfPacket = buildCashFlowPacket(cashFlow({ operatingDirect: { paymentsForRawMaterials: usd(9), paymentsForManufacturing: usd(1), paymentsForSellingGeneralAdmin: usd(1), receiptsFromCustomers: usd(20), interestPaid: usd(0), incomeTaxPaid: usd(0) } } as unknown as Partial<CashFlowStatement>), "2015Q2");
  assert.equal(cfPacket.paymentsForRawMaterials, 9);
  assert.ok(!("rawMaterialCost" in cfPacket), "cashFlowPacketにP&Lの費用科目名（rawMaterialCost等）が紛れ込んではいけない");
});

test("AMM-ACC-7: turn-over-turn P&L varianceの計算が正しい（各科目の単純差分）", () => {
  const prior = pnl({
    netRevenue: usd(66.594),
    qualitySalesDeduction: usd(1.0),
    operatingProfit: usd(6.30),
    sellingGeneralAdmin: usd(5.0),
    costOfSales: { rawMaterialCost: usd(30), processingCost: usd(10), laborCost: usd(6), factoryFixedCost: usd(5), reworkCost: usd(0.2), discardLoss: usd(0.3), idleLaborCost: usd(1.0) },
  });
  const current = pnl({
    netRevenue: usd(62.938),
    qualitySalesDeduction: usd(1.1),
    operatingProfit: usd(-0.059),
    sellingGeneralAdmin: usd(5.58),
    costOfSales: { rawMaterialCost: usd(29.78), processingCost: usd(10.76), laborCost: usd(6.46), factoryFixedCost: usd(5.93), reworkCost: usd(0.2), discardLoss: usd(0.19), idleLaborCost: usd(1.30) },
  });
  const v = computePnlVariance(current, prior, "2015Q2", "2015Q1");
  assert.ok(Math.abs(v.revenueDelta - (62.938 - 66.594)) < 1e-9);
  assert.ok(Math.abs(v.rawMaterialCostDelta - (29.78 - 30)) < 1e-9);
  assert.ok(Math.abs(v.processingCostDelta - (10.76 - 10)) < 1e-9);
  assert.ok(Math.abs(v.laborCostDelta - (6.46 - 6)) < 1e-9);
  assert.ok(Math.abs(v.factoryFixedCostDelta - (5.93 - 5)) < 1e-9);
  assert.ok(Math.abs(v.idleLaborCostDelta - (1.30 - 1.0)) < 1e-9);
  assert.ok(Math.abs(v.sgaDelta - (5.58 - 5.0)) < 1e-9);
  assert.ok(Math.abs(v.discardLossDelta - (0.19 - 0.3)) < 1e-9);
  assert.ok(Math.abs(v.operatingProfitDelta - (-0.059 - 6.30)) < 1e-9);
});

test("AMM-ACC-8: Test26 BAL Turn1→Turn2 実データfixture — Operating Profitが約+$6.30Mから約-$0.059Mへ悪化（約-$6.36M）", () => {
  const turn1 = pnl({
    netRevenue: usd(66.594),
    operatingProfit: usd(6.30),
  });
  const turn2 = pnl({
    netRevenue: usd(62.938),
    operatingProfit: usd(-0.059),
  });
  const v = computePnlVariance(turn2, turn1, "2015Q2", "2015Q1");
  assert.ok(Math.abs(v.revenueDelta - -3.656) < 0.01, `revenueDelta約-3.66Mのはずが${v.revenueDelta}`);
  assert.ok(Math.abs(v.operatingProfitDelta - -6.359) < 0.01, `operatingProfitDelta約-6.36Mのはずが${v.operatingProfitDelta}`);
  assert.ok(v.operatingProfitDelta < -6, "Operating Profitの悪化幅は$6M超のはず");
});

test("AMM-ACC-9: 数量増・売上減が正しく表現される（平均実現価格の下落として観測できる）", () => {
  const facts = computeVolumePriceFacts(14_407, 62_938_000, 12_591, 66_594_000, "2015Q2", "2015Q1");
  assert.ok(facts.volumeDeltaTons > 0, "数量は増加しているはず");
  assert.ok(facts.currentAverageRealizedPriceUsdPerTon !== null && facts.priorAverageRealizedPriceUsdPerTon !== null);
  assert.ok(
    (facts.currentAverageRealizedPriceUsdPerTon as number) < (facts.priorAverageRealizedPriceUsdPerTon as number),
    "数量が増えたにもかかわらず平均実現単価は下落しているはず（市場価格下落の裏付け）"
  );
});

test("AMM-ACC-10: 売掛金残高（BS）はP&L varianceの入力に一切使われない（次期revenueとして扱われない）", () => {
  const prior = pnl({ netRevenue: usd(10) });
  const current = pnl({ netRevenue: usd(8) });
  const v = computePnlVariance(current, prior, "2015Q2", "2015Q1");
  // computePnlVarianceのシグネチャ自体がProfitAndLossStatementのみを受け取り、
  // BalanceSheet（accountsReceivable）を受け取らない（構造的に混入不可能）ことを確認する。
  assert.equal(computePnlVariance.length, 4);
  assert.ok(Math.abs(v.revenueDelta - -2) < 1e-9);
});

test("AMM-ACC-11: RuleSemanticsにP&L/Cash Flow/Balance Sheet混同を防ぐ会計用語定義が存在する", () => {
  assert.ok(/Operating Profit|発生主義/.test(RULE_SEMANTICS.operatingProfit ?? ""), "operatingProfitのRuleSemanticsが必要");
  assert.ok(/回収タイミング|Cash/.test(RULE_SEMANTICS.accountsReceivable ?? ""), "accountsReceivableのRuleSemanticsが必要");
  assert.ok(/Operating Profit|営業利益/.test(RULE_SEMANTICS.operatingCashFlow ?? ""), "operatingCashFlowのRuleSemanticsが必要");
  assert.ok(/Operating Profit|営業利益/.test(RULE_SEMANTICS.interestExpense ?? ""), "interestExpenseのRuleSemanticsが必要");
  // promptにも、同一meeting内で会計カテゴリ誤りを繰り返さないための訂正メモリ運用が明記されている。
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /会計カテゴリの誤り/);
});

test("AMM-ACC-12: CFO briefingのfinancialStatements/pnlVariance/volumePriceFactsは同一入力から決定的に導出される", () => {
  const context = minimalContext();
  const financialHistory = {
    reportingPeriod: {
      pnl: pnl({ netRevenue: usd(62.938), operatingProfit: usd(-0.059) }),
      cashFlow: cashFlow(),
      balanceSheet: balanceSheet(),
      periodLabel: "2015年Q2",
      fulfilledQuantityTons: 14_407,
    },
    priorPeriod: {
      pnl: pnl({ netRevenue: usd(66.594), operatingProfit: usd(6.30) }),
      periodLabel: "2015年Q1",
      fulfilledQuantityTons: 12_591,
    },
  };
  const buildInput = {
    context,
    previousQuarter: null,
    playerDraft: null,
    contracts: [],
    receivables: [],
    payables: [],
    loans: [],
    capexProjects: [],
    borrowingHeadroom: null,
    crisis: null,
    financialHistory,
    operationalHistory: { reportingPeriod: null, priorPeriod: null },
  };
  const a = buildExecutiveBriefingPacket(buildInput);
  const b = buildExecutiveBriefingPacket(buildInput);
  assert.deepEqual(a.cfo.financialStatements, b.cfo.financialStatements);
  assert.deepEqual(a.cfo.pnlVariance, b.cfo.pnlVariance);
  assert.deepEqual(a.cfo.volumePriceFacts, b.cfo.volumePriceFacts);
  assert.ok(a.cfo.financialStatements !== null);
  assert.ok(a.cfo.pnlVariance !== null);
  assert.equal(a.cfo.financialStatements?.pnl.operatingProfit, -0.059);
  assert.ok((a.cfo.pnlVariance?.operatingProfitDelta ?? 0) < -6);
});

function minimalContext(): ExplanationContext {
  return {
    identity: {
      labId: "lab-1",
      companyId: "BAL",
      turn: 3,
      year: 2015,
      quarter: 2,
      scenarioId: "baseline",
      model: "claude-haiku-4-5-20251001",
      promptVersion: "v4",
      contextSchemaVersion: 2,
    },
    ownState: {
      balanceSheet: {
        cashUsd: 500_000,
        totalAssetsUsd: 2_000_000,
        totalLiabilitiesUsd: 800_000,
        totalEquityUsd: 1_200_000,
        receivablesUsd: 100_000,
        receivablesCount: 3,
        payablesUsd: 50_000,
        payablesCount: 2,
        shortTermLoansUsd: 200_000,
        longTermLoansUsd: 300_000,
        accruedInterestPayableUsd: 1_000,
        activeLoanCount: 2,
      },
      contractBacklog: [
        { market: "JP", product: "pd", outstandingTons: 120, contractCount: 4, nearestDueDateLabel: "2015Q4" },
        { market: "US", product: "hoso", outstandingTons: 40, contractCount: 1, nearestDueDateLabel: "2015Q3" },
      ],
      rawMaterialInventory: { totalTons: 300, groups: [{ availableFromLabel: "現在利用可能", quantityTons: 300, lotCount: 2 }] },
      finishedGoodsInventoryUsd: 40_000,
      factoryCapacity: [
        {
          factoryId: "F1",
          nominal: { hoso: 5000, pd: 2000, vap: 1000, commonProcessing: 8000, freezingPackaging: 8000 },
          effective: { hoso: 4000, pd: 1800, vap: 900, commonProcessing: 7000, freezingPackaging: 7000 },
        },
      ],
      productionCapacitySummary: { nominalTotalTons: 8000, effectiveTotalTons: 6700, bindingTotalTons: 6700, bindingConstraintLabel: "商品別実効能力" },
      laborProductivity: [{ factoryId: "F1", product: "hoso", tonsPerRegularWorker: 10 }],
      workforce: { totalRegularHeadcount: 200, byFactory: [{ factoryId: "F1", regularHeadcount: 200 }] },
      salesForce: { headcountTotal: 20, coverageScore: 0.7, currentProcessingCapacityTons: 5000 },
      qualityScoreByProduct: { hoso: 80, pd: 75, vap: 90 },
      customerTrustByMarket: { JP: 70, US: 60 },
      deliveryReliabilityByMarket: { JP: 95, US: 88 },
    },
    marketInfo: {
      hasPriorMarketData: true,
      dataLimitationNote: null,
      vietnamDomesticPriorPriceUsd: 5.2,
      vietnamDomesticPriorMarket: { supplyTons: 1000, effectiveDemandTons: 900, transactedVolumeTons: 850, unsoldSupplyTons: 150 },
      lifecycleTrends: [],
      supplyPressure: [],
    },
    standardAi: {
      decision: {} as never,
      diagnosticEntries: [],
    },
  } as unknown as ExplanationContext;
}
