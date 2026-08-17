// AMM-TCB-1..20（AMM-M2.7・実装指示§39）— Turn Change Briefing / Automatic Opening
// Executive Brief。
//
// 【背景】新しいTurnに入った際、プレイヤーが何も質問しなくても「前四半期から何が
// 変わったか」をCEOが3〜5点だけ短く説明できるようにする。TurnChangeはClaudeに
// 計算させず、server-side deterministicに差分計算する（実装指示§1）。本テストは
// turnChangeBriefing.ts（差分計算・significant change選定）と、Opening Brief専用の
// schema/prompt（CEO固定・Run Memory参照・guardrail）、および構造上の分離
// （Standard AI/game stateを一切変更しない）を確認する。統合テスト（cache・
// 割り込み禁止・Claude失敗時のfallback）はaiMeetingOpeningBrief.test.tsに分離する。

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { buildInitialBriefFacts, buildTurnChangeBriefing, TurnChangeBriefingInput, TurnChangeQuarterSnapshot } from "../turnChangeBriefing";
import { CompanyQuarterSummary } from "../../types";
import { WorkerAssignment } from "../../../production/types";
import { usd, BalanceSheet, CostOfSalesBreakdown, ProfitAndLossStatement } from "../../../finance/types";
import { ratio, hosoEqTons, score0to100 } from "../../../core/units";
import { CapacityPools } from "../capacitySemantics";
import { ExecutiveBriefingPacket } from "../briefing";
import { openingBriefStructuredResponseSchema } from "../proposalSchema";
import { buildOpeningBriefUserMessage, OPENING_BRIEF_SYSTEM_PROMPT } from "../prompt";
import { buildRunAdvisoryMemorySummary } from "../runAdvisoryMemory";
import { RunAdvisoryMemoryRecord } from "../../aiManagementMeeting/types";

// --- fixture builders（既存accountingSemantics.test.ts/operationalSemantics.test.tsと同じ方針） ---

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

function summary(overrides: Partial<CompanyQuarterSummary> = {}): CompanyQuarterSummary {
  return {
    companyId: "BAL",
    period: "2015Q2",
    newContractedQuantity: hosoEqTons(0),
    newContractedAveragePrice: 0,
    fulfilledQuantity: hosoEqTons(0),
    outstandingQuantity: hosoEqTons(0),
    overdueQuantity: hosoEqTons(0),
    domesticPurchaseQuantity: hosoEqTons(0),
    domesticPurchasePrice: 0,
    importInTransitQuantity: hosoEqTons(0),
    importArrivedQuantity: hosoEqTons(0),
    aquacultureGrowingQuantity: hosoEqTons(0),
    aquacultureHarvestedQuantity: hosoEqTons(0),
    rawMaterialInventory: hosoEqTons(0),
    hosoProduced: hosoEqTons(0),
    pdProduced: hosoEqTons(0),
    vapProduced: hosoEqTons(0),
    finishedGoodsInventory: hosoEqTons(0),
    rawMaterialShortfall: hosoEqTons(0),
    equipmentShortfall: hosoEqTons(0),
    laborShortfall: hosoEqTons(0),
    equipmentUtilizationRate: ratio(0),
    laborUtilizationRate: ratio(0),
    overtimeRate: ratio(0),
    temporaryWorkerShare: ratio(0),
    qualityScoreByProduct: {},
    operationalRiskByProduct: {},
    downgradeQuantity: hosoEqTons(0),
    reworkQuantity: hosoEqTons(0),
    discardQuantity: hosoEqTons(0),
    majorIncidentCount: 0,
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
    rampWarnings: [],
    reasonCodes: [],
    ...overrides,
  } as unknown as CompanyQuarterSummary;
}

function snapshot(overrides: Partial<TurnChangeQuarterSnapshot> = {}): TurnChangeQuarterSnapshot {
  return {
    pnl: pnl(),
    balanceSheet: balanceSheet(),
    periodLabel: "2015年Q1",
    period: "2015Q1" as never,
    fulfilledQuantityTons: 0,
    summary: summary(),
    workerAssignments: [] as readonly WorkerAssignment[],
    productionEntries: [],
    borrowingHeadroomUsd: null,
    ...overrides,
  };
}

const CAPACITY_POOLS: CapacityPools = {
  commonProcessingTons: 25650,
  freezingPackagingTons: 25650,
  hosoTons: 6840,
  pdTons: 5985,
  vapTons: 1282.5,
  productLineSumTons: 14107.5,
  bindingTons: 14107.5,
  bindingPoolLabel: "商品別実効能力",
};

function baseInput(overrides: Partial<TurnChangeBriefingInput> = {}): TurnChangeBriefingInput {
  return {
    runId: "lab-1",
    companyId: "BAL",
    fromTurn: 1,
    toTurn: 2,
    current: snapshot({ periodLabel: "2015年Q2", period: "2015Q2" as never }),
    previous: snapshot({ periodLabel: "2015年Q1", period: "2015Q1" as never }),
    capexProjects: [],
    currentCapacityPools: CAPACITY_POOLS,
    currentSalesForceHeadcount: 15,
    ...overrides,
  };
}

test("AMM-TCB-1: Turn2 previous/current delta deterministic", () => {
  const input = baseInput({
    current: snapshot({
      periodLabel: "2015年Q2",
      pnl: pnl({ netRevenue: usd(11_000_000), operatingProfit: usd(1_500_000), grossProfit: usd(2_500_000), netIncome: usd(1_000_000) }),
      balanceSheet: balanceSheet({ cash: usd(6_000_000), accountsReceivable: usd(2_500_000), totalLiabilities: usd(4_000_000), shortTermLoans: usd(1_500_000), longTermLoans: usd(1_500_000) }),
    }),
    previous: snapshot({
      periodLabel: "2015年Q1",
      pnl: pnl({ netRevenue: usd(10_000_000), operatingProfit: usd(1_000_000), grossProfit: usd(2_000_000), netIncome: usd(800_000) }),
      balanceSheet: balanceSheet({ cash: usd(5_000_000), accountsReceivable: usd(2_000_000), totalLiabilities: usd(3_000_000), shortTermLoans: usd(1_000_000), longTermLoans: usd(1_000_000) }),
    }),
  });
  const tcb = buildTurnChangeBriefing(input);
  assert.equal(tcb.financialChanges.revenue.current, 11_000_000);
  assert.equal(tcb.financialChanges.revenue.previous, 10_000_000);
  assert.equal(tcb.financialChanges.revenue.delta, 1_000_000);
  assert.ok(Math.abs(tcb.financialChanges.revenue.deltaPercent! - 0.1) < 1e-9);
  assert.equal(tcb.financialChanges.cash.delta, 1_000_000);
  assert.equal(tcb.financialChanges.interestBearingDebt.current, 3_000_000);
  assert.equal(tcb.financialChanges.totalDebt.current, 4_000_000);
});

test("AMM-TCB-2: Turn1 initial brief fallback", () => {
  const packet = {
    common: {
      companyId: "BAL",
      turn: 1,
      cashUsd: 38_200_000,
      bindingCapacityTons: 14107.5,
      bindingConstraintLabel: "商品別実効能力",
      backlog: { totalTons: 0, overdueTons: 0 },
      standardAiReasonCodesTopN: [{ code: "X1", domain: "PRODUCTION", severity: "medium" }],
    },
    coo: { rawMaterialTotalTons: 5000 },
  } as unknown as ExecutiveBriefingPacket;
  const facts = buildInitialBriefFacts(packet);
  assert.equal(facts.turn, 1);
  assert.equal(facts.cashUsd, 38_200_000);
  assert.equal(facts.bindingCapacityTons, 14107.5);
  assert.equal(facts.rawMaterialTotalTons, 5000);
  assert.equal(facts.standardAiReasonCodesTopN.length, 1);
});

test("AMM-TCB-3: positive→negative Operating Profitはsignificant（sign reversal・HIGH・WORSENED）", () => {
  const input = baseInput({
    current: snapshot({ pnl: pnl({ operatingProfit: usd(-100_000), netRevenue: usd(3_000_000) }) }),
    previous: snapshot({ pnl: pnl({ operatingProfit: usd(2_000_000), netRevenue: usd(3_500_000) }) }),
  });
  const tcb = buildTurnChangeBriefing(input);
  const candidate = tcb.significantChanges.find((c) => c.id === "finance.operatingProfit.signReversal");
  assert.ok(candidate, "sign reversal candidateが存在するはず");
  assert.equal(candidate?.direction, "WORSENED");
  assert.equal(candidate?.significanceScore, 3);
});

test("AMM-TCB-4: healthy backlog増加はoverdueとして扱われない（domain=OPPORTUNITY）", () => {
  const input = baseInput({
    current: snapshot({ summary: summary({ outstandingQuantity: hosoEqTons(8000), overdueQuantity: hosoEqTons(0) }) }),
    previous: snapshot({ summary: summary({ outstandingQuantity: hosoEqTons(3000), overdueQuantity: hosoEqTons(0) }) }),
  });
  const tcb = buildTurnChangeBriefing(input);
  assert.equal(tcb.commercialChanges.healthyForwardBacklog.delta, 5000);
  assert.equal(tcb.commercialChanges.overdueBacklog.delta, 0);
  const overdueCandidate = tcb.significantChanges.find((c) => c.id.startsWith("commercial.overdue"));
  assert.equal(overdueCandidate, undefined, "overdueが0のままなら overdue候補は生成されないはず");
  const healthyCandidate = tcb.significantChanges.find((c) => c.id === "commercial.healthyForwardBacklog.delta");
  assert.ok(healthyCandidate);
  assert.equal(healthyCandidate?.domain, "OPPORTUNITY");
});

test("AMM-TCB-5: overdue増加はHIGHとして優先される", () => {
  const input = baseInput({
    current: snapshot({ summary: summary({ outstandingQuantity: hosoEqTons(4500), overdueQuantity: hosoEqTons(500) }) }),
    previous: snapshot({ summary: summary({ outstandingQuantity: hosoEqTons(4000), overdueQuantity: hosoEqTons(0) }) }),
  });
  const tcb = buildTurnChangeBriefing(input);
  const candidate = tcb.significantChanges.find((c) => c.id === "commercial.overdue.new");
  assert.ok(candidate, "新規overdue candidateが存在するはず");
  assert.equal(candidate?.significanceScore, 3);
  assert.equal(candidate?.direction, "WORSENED");
  assert.ok(tcb.riskChanges.some((c) => c.id === "commercial.overdue.new"));
});

test("AMM-TCB-6: volume up / revenue downが表現される", () => {
  const input = baseInput({
    current: snapshot({ pnl: pnl({ netRevenue: usd(3_000_000) }), fulfilledQuantityTons: 1200, summary: summary({ fulfilledQuantity: hosoEqTons(1200) }) }),
    previous: snapshot({ pnl: pnl({ netRevenue: usd(3_700_000) }), fulfilledQuantityTons: 1000, summary: summary({ fulfilledQuantity: hosoEqTons(1000) }) }),
  });
  const tcb = buildTurnChangeBriefing(input);
  const candidate = tcb.significantChanges.find((c) => c.id === "commercial.volumeUpRevenueDown");
  assert.ok(candidate, "volume up/revenue down candidateが存在するはず");
  assert.equal(candidate?.domain, "RISK");
  assert.ok(!/receivable|cash collection|売掛金|回収/i.test(candidate!.factSummary), "cash collectionを原因にしてはいけない");
});

test("AMM-TCB-7: equipment/labor utilizationは分離される（一括しない）", () => {
  const input = baseInput({
    current: snapshot({ summary: summary({ equipmentUtilizationRate: ratio(0.4744), laborUtilizationRate: ratio(0.9532) }) }),
    previous: snapshot({ summary: summary({ equipmentUtilizationRate: ratio(0.9), laborUtilizationRate: ratio(0.5) }) }),
  });
  const tcb = buildTurnChangeBriefing(input);
  assert.ok(Math.abs(tcb.operationalChanges.equipmentUtilization.delta - (0.4744 - 0.9)) < 1e-6);
  assert.ok(Math.abs(tcb.operationalChanges.laborUtilization.delta - (0.9532 - 0.5)) < 1e-6);
  assert.notEqual(tcb.operationalChanges.equipmentUtilization.delta, tcb.operationalChanges.laborUtilization.delta);
});

test("AMM-TCB-8: bottleneck変化が検出される", () => {
  const input = baseInput({
    current: snapshot({ summary: summary({ equipmentShortfall: hosoEqTons(800), rawMaterialShortfall: hosoEqTons(0), laborShortfall: hosoEqTons(0) }) }),
    previous: snapshot({ summary: summary({ rawMaterialShortfall: hosoEqTons(500), equipmentShortfall: hosoEqTons(0), laborShortfall: hosoEqTons(0) }) }),
  });
  const tcb = buildTurnChangeBriefing(input);
  assert.equal(tcb.operationalChanges.bottleneckChange.previous, "RAW_MATERIAL");
  assert.equal(tcb.operationalChanges.bottleneckChange.current, "EQUIPMENT");
  assert.equal(tcb.operationalChanges.bottleneckChange.changed, true);
  const candidate = tcb.significantChanges.find((c) => c.id === "operations.bottleneck.changed");
  assert.ok(candidate);
  assert.equal(candidate?.significanceScore, 3);
});

test("AMM-TCB-9: significantChangesは最大8件（Top N cap）", () => {
  const input = baseInput({
    current: snapshot({
      pnl: pnl({ operatingProfit: usd(-500_000), netRevenue: usd(2_000_000), grossProfit: usd(100_000) }),
      balanceSheet: balanceSheet({ cash: usd(1_000_000), shortTermLoans: usd(500_000) }),
      summary: summary({
        outstandingQuantity: hosoEqTons(6000),
        overdueQuantity: hosoEqTons(600),
        fulfilledQuantity: hosoEqTons(1500),
        equipmentShortfall: hosoEqTons(900),
        customerTrustByMarket: { US: score0to100(40), EU: score0to100(40) },
      }),
      fulfilledQuantityTons: 1500,
    }),
    previous: snapshot({
      pnl: pnl({ operatingProfit: usd(3_000_000), netRevenue: usd(4_000_000), grossProfit: usd(1_500_000) }),
      balanceSheet: balanceSheet({ cash: usd(3_000_000), shortTermLoans: usd(200_000) }),
      summary: summary({
        outstandingQuantity: hosoEqTons(3000),
        overdueQuantity: hosoEqTons(0),
        fulfilledQuantity: hosoEqTons(1000),
        rawMaterialShortfall: hosoEqTons(400),
        customerTrustByMarket: { US: score0to100(70), EU: score0to100(70) },
      }),
      fulfilledQuantityTons: 1000,
    }),
    capexProjects: [
      { projectId: "p1", companyId: "BAL", projectType: "hosoLineExpansion", status: "completed", completedPeriod: "2015Q2" } as never,
    ],
  });
  const tcb = buildTurnChangeBriefing(input);
  assert.ok(tcb.significantChanges.length <= 8, `significantChangesは最大8件のはず（実際: ${tcb.significantChanges.length}）`);
  for (let i = 1; i < tcb.significantChanges.length; i++) {
    assert.ok(tcb.significantChanges[i - 1].significanceScore >= tcb.significantChanges[i].significanceScore, "score降順であるはず");
  }
});

test("AMM-TCB-12: significantChangesの各候補はfactsUsedを持つ（根拠が空でない）", () => {
  const input = baseInput({
    current: snapshot({ pnl: pnl({ operatingProfit: usd(-1) }) }),
    previous: snapshot({ pnl: pnl({ operatingProfit: usd(1) }) }),
  });
  const tcb = buildTurnChangeBriefing(input);
  assert.ok(tcb.significantChanges.length > 0);
  for (const c of tcb.significantChanges) {
    assert.ok(c.factsUsed.length > 0, `candidate ${c.id} はfactsUsedを持つはず`);
    assert.ok(c.factsUsed.every((f) => /^[a-zA-Z]+\./.test(f)), `factsUsedは"domain.field"形式のはず: ${c.factsUsed.join(",")}`);
  }
});

test("AMM-TCB-10: Opening BriefはCEO固定（他のspeakerはschema違反）", () => {
  const valid = openingBriefStructuredResponseSchema.safeParse({
    speaker: "CEO",
    summary: "今期は増収でしたが利益率が悪化しました。",
    keyChanges: [],
    suggestedFollowUps: [],
  });
  assert.equal(valid.success, true);

  const invalid = openingBriefStructuredResponseSchema.safeParse({
    speaker: "CFO",
    summary: "現金は十分です。",
    keyChanges: [],
    suggestedFollowUps: [],
  });
  assert.equal(invalid.success, false, "speaker=CFOはOpening Briefのschemaでは許可されないはず");
});

test("AMM-TCB-11: CFO/COO/Commercialが自動で続けて話さないことがpromptで明示されている", () => {
  assert.match(OPENING_BRIEF_SYSTEM_PROMPT, /speakerは必ずCEO固定です/);
  assert.match(OPENING_BRIEF_SYSTEM_PROMPT, /CFO\/COO\/Commercialの[\s\S]*発言を代わりに生成しないでください/);
});

test("AMM-TCB-13: Run Advisory MemoryがOpening Briefのuser messageへ正しく含まれる", () => {
  const record: RunAdvisoryMemoryRecord = {
    id: "mem-1",
    runId: "lab-1",
    companyId: "BAL",
    createdTurn: 1,
    updatedTurn: 1,
    scope: "RUN",
    type: "PLAYER_PREFERENCE",
    topic: "CASH_FLOOR",
    statement: "Cashは最低30M維持を希望。",
    normalizedValue: 30_000_000,
    verificationStatus: "NOT_VERIFIABLE",
    sourceMessageId: "msg-1",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const summaryObj = buildRunAdvisoryMemorySummary([record]);
  const message = buildOpeningBriefUserMessage({
    turnChangeBriefing: null,
    initialBriefFacts: { turn: 1 },
    standardAiDecisionSummary: { topReasonCodes: [] },
    runAdvisoryMemory: summaryObj,
  });
  const parsed = JSON.parse(message) as { runAdvisoryMemory: { playerPreferences: readonly { statement: string }[] } };
  assert.equal(parsed.runAdvisoryMemory.playerPreferences.length, 1);
  assert.equal(parsed.runAdvisoryMemory.playerPreferences[0].statement, "Cashは最低30M維持を希望。");
});

test("AMM-TCB-17: turnChangeBriefing.tsはStandard AI・game state SSoTを一切import/変更しない（構造上の分離）", () => {
  const source = fs.readFileSync(path.join(__dirname, "../turnChangeBriefing.ts"), "utf8");
  const importLines = source.split("\n").filter((l) => /^import /.test(l));
  assert.ok(
    importLines.every((l) => !/standardAi/i.test(l)),
    `turnChangeBriefing.tsはStandard AIモジュールを一切importしてはいけない: ${importLines.filter((l) => /standardAi/i.test(l)).join(" / ")}`
  );
  assert.ok(!/CompanyLabState|CompanyDecisionDraft|companyLabStateRepository/i.test(source), "turnChangeBriefing.tsはgame state SSoTの型・保存関数を一切importしてはいけない");
});

test("AMM-TCB-18: Test26 accounting regression — 数量増・売上減・営業黒字→赤字を、現金回収を原因にせず表現する", () => {
  const input = baseInput({
    current: snapshot({ pnl: pnl({ operatingProfit: usd(-60_000), netRevenue: usd(29_600_000) }), fulfilledQuantityTons: 1100, summary: summary({ fulfilledQuantity: hosoEqTons(1100) }) }),
    previous: snapshot({ pnl: pnl({ operatingProfit: usd(6_300_000), netRevenue: usd(33_300_000) }), fulfilledQuantityTons: 950, summary: summary({ fulfilledQuantity: hosoEqTons(950) }) }),
  });
  const tcb = buildTurnChangeBriefing(input);
  const opCandidate = tcb.significantChanges.find((c) => c.id === "finance.operatingProfit.signReversal");
  assert.ok(opCandidate, "Operating Profitのsign reversalが検出されるはず");
  assert.ok(tcb.commercialChanges.volumePriceFacts.volumeDeltaTons > 0, "販売数量は増加しているはず");
  assert.ok(tcb.financialChanges.revenue.delta < 0, "売上は減少しているはず");
  for (const c of tcb.significantChanges) {
    assert.ok(!/receivable|cash collection|売掛金|回収/i.test(c.factSummary), `候補 ${c.id} が現金回収を原因にしてはいけない: ${c.factSummary}`);
  }
});

test("AMM-TCB-19: Test26 backlog regression — overdue=0のbacklog増加はforward obligation増加として扱われる", () => {
  const input = baseInput({
    current: snapshot({ summary: summary({ outstandingQuantity: hosoEqTons(8988), overdueQuantity: hosoEqTons(0) }) }),
    previous: snapshot({ summary: summary({ outstandingQuantity: hosoEqTons(3625.95), overdueQuantity: hosoEqTons(0) }) }),
  });
  const tcb = buildTurnChangeBriefing(input);
  assert.equal(tcb.commercialChanges.overdueBacklog.current, 0);
  assert.ok(!tcb.significantChanges.some((c) => c.id.startsWith("commercial.overdue")), "overdue=0のままなのでoverdue候補が生成されてはいけない");
  const healthyCandidate = tcb.significantChanges.find((c) => c.id === "commercial.healthyForwardBacklog.delta");
  assert.ok(healthyCandidate);
  assert.notEqual(healthyCandidate?.domain, "RISK", "healthy forward増加はRISKではない");
});

test("AMM-TCB-20: Test26 operational regression — equipment低・labor高を分離し、raw material > equipmentならprimary bottleneckはraw material", () => {
  const input = baseInput({
    current: snapshot({
      summary: summary({
        equipmentUtilizationRate: ratio(0.4744),
        laborUtilizationRate: ratio(0.9532),
        rawMaterialShortfall: hosoEqTons(1500),
        equipmentShortfall: hosoEqTons(1015),
        laborShortfall: hosoEqTons(0),
      }),
    }),
    previous: snapshot({ summary: summary({ equipmentUtilizationRate: ratio(0.6), laborUtilizationRate: ratio(0.6) }) }),
  });
  const tcb = buildTurnChangeBriefing(input);
  assert.notEqual(tcb.operationalChanges.equipmentUtilization.current, tcb.operationalChanges.laborUtilization.current, "equipment/labor utilizationは別指標のまま保持されるはず");
  assert.equal(tcb.operationalChanges.bottleneckChange.current, "RAW_MATERIAL", "raw material shortage(1500) > equipment shortage(1015)なのでprimaryはRAW_MATERIALのはず");
});
