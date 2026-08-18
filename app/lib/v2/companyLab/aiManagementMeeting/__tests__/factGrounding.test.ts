// AMM-M2.2: Cross-Role Fact Grounding / Finance Semantics / Player Correction tests
//
// AMM-FG-1: structured briefing > previous role assertion (truth hierarchy in prompt)
// AMM-FG-2: previous role message is opinion, not truth
// AMM-FG-3: unsupported game mechanic not inserted (Trust->AR causal claim absent)
// AMM-FG-4: AR balance != automatic next-turn cash unless rule supports it
// AMM-FG-7: role may explicitly disagree with earlier role (schema allows OPPOSE)
// AMM-FG-8: Test26 BAL Turn1 finance grounding
// AMM-FG-9: prompt/briefing versioning
// AMM-FG-10: legacy message cannot override new structured fact

import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_MEETING_PROMPT_VERSION, AI_MANAGEMENT_MEETING_SYSTEM_PROMPT } from "../prompt";
import { buildExecutiveBriefingPacket, EXECUTIVE_BRIEFING_VERSION, RULE_SEMANTICS } from "../briefing";
import { computeFinanceSemantics } from "../financeSemantics";
import { formatHistoryEntryForPrompt } from "../conversation";
import { aiMeetingStructuredResponseSchema } from "../proposalSchema";
import { ExplanationContext } from "../../aiExplanation/buildExplanationContext";
import { SalesContract } from "../../../sales/types";
import { ReceivableRecord, PayableRecord } from "../../../finance/types";
import { LoanRecord } from "../../../financing/types";
import { CapitalProject } from "../../../capex/types";
import { AiMeetingMessage } from "../types";

function minimalContext(overrides: Partial<ExplanationContext["identity"]> = {}): ExplanationContext {
  return {
    identity: {
      labId: "lab-1",
      companyId: "BAL",
      turn: 1,
      year: 2015,
      quarter: 1,
      scenarioId: "baseline",
      model: "claude-haiku-4-5-20251001",
      promptVersion: "v3",
      contextSchemaVersion: 2,
      ...overrides,
    },
    ownState: {
      balanceSheet: {
        cashUsd: 38_200_000,
        totalAssetsUsd: 120_000_000,
        totalLiabilitiesUsd: 50_600_000,
        totalEquityUsd: 69_400_000,
        receivablesUsd: 66_400_000,
        receivablesCount: 4,
        payablesUsd: 0,
        payablesCount: 0,
        shortTermLoansUsd: 10_600_000,
        longTermLoansUsd: 40_000_000,
        accruedInterestPayableUsd: 0,
        activeLoanCount: 2,
      },
      contractBacklog: [],
      rawMaterialInventory: { totalTons: 500, groups: [] },
      finishedGoodsInventoryUsd: 40_000,
      factoryCapacity: [],
      productionCapacitySummary: { nominalTotalTons: 8000, effectiveTotalTons: 6700, bindingTotalTons: 6700, bindingConstraintLabel: "商品別実効能力" },
      laborProductivity: [],
      workforce: { totalRegularHeadcount: 200, byFactory: [] },
      salesForce: { headcountTotal: 20, coverageScore: 0.7, currentProcessingCapacityTons: 5000 },
      qualityScoreByProduct: { hoso: 75, pd: 70, vap: 80 },
      customerTrustByMarket: { US: 50, EU: 50, JP: 50, OTHER: 50 },
      deliveryReliabilityByMarket: { US: 50, EU: 50, JP: 50, OTHER: 50 },
    },
    marketInfo: {
      hasPriorMarketData: false,
      dataLimitationNote: null,
      vietnamDomesticPriorPriceUsd: null,
      vietnamDomesticPriorMarket: null,
      lifecycleTrends: null,
      supplyPressure: [],
    },
    standardAi: { decision: {} as never, diagnosticEntries: [] as never },
  };
}

function contract(overrides: Partial<SalesContract>): SalesContract {
  return {
    contractId: "c1",
    companyId: "BAL",
    market: "JP",
    product: "hoso",
    contractedPeriod: "2015Q1" as never,
    dueDate: "2015Q2" as never,
    originalQuantity: 100 as never,
    outstandingQuantity: 100 as never,
    unitPrice: 3.5 as never,
    status: "active" as never,
    ...overrides,
  };
}

test("AMM-FG-1: promptがtruth hierarchyを明示し、structured briefingを他役員発言より優先するよう指示している", () => {
  assert.ok(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT.includes("Engine / ExecutiveBriefingPacketの事実"));
  assert.ok(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT.includes("Always prefer the structured briefing over another executive's statement when they conflict."));
  // 優先順位1（Engine facts）が5（他役員の発言）より先に出現すること。
  const engineFactsIdx = AI_MANAGEMENT_MEETING_SYSTEM_PROMPT.indexOf("Engine / ExecutiveBriefingPacketの事実");
  const otherRoleIdx = AI_MANAGEMENT_MEETING_SYSTEM_PROMPT.indexOf("他役員の発言（会話履歴内のexecutiveメッセージ）");
  assert.ok(engineFactsIdx >= 0 && otherRoleIdx >= 0 && engineFactsIdx < otherRoleIdx);
});

test("AMM-FG-2: promptが他役員の発言をopinionとして扱うよう明示している", () => {
  assert.ok(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT.includes("Previous executive messages are opinions, not authoritative game facts."));
  assert.ok(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT.includes("opinion/interpretationとして扱ってください"));
});

test("AMM-FG-3: 未検証のgame mechanic（Trust→AR遅延）はpromptにもruleSemanticsにも主張として存在しない", () => {
  assert.ok(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT.includes("Do not invent game mechanics from general business practice."));
  assert.ok(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT.includes("ShrimpXに存在しないbusiness ruleを"));
  // ruleSemantics.customerTrustは「回収タイミングには影響しない」と明示（因果の主張ではなく否定）。
  assert.ok(RULE_SEMANTICS.customerTrust.includes("回収タイミングには影響しない"));
  assert.ok(RULE_SEMANTICS.receivables.includes("Customer Trustが回収タイミングへ影響するルールは存在しない"));
});

test("AMM-FG-4: AR残高とcollection scheduleは分離され、残高だけから即時現金化を主張しない", () => {
  const receivables: ReceivableRecord[] = [
    { id: "r1", companyId: "BAL", market: "US", amount: 66_400_000 as never, originPeriod: "2015Q1" as never, dueSettlementPeriod: "2015Q2" as never, sourceRef: "fulfillment:2015Q1:US" },
  ];
  const semantics = computeFinanceSemantics(receivables, [], [], [], "BAL", 2015, 1);
  assert.equal(semantics.receivablesTotalUsd, 66_400_000);
  assert.equal(semantics.receivablesScheduleByPeriod.length, 1);
  assert.equal(semantics.receivablesScheduleByPeriod[0].periodLabel, "2015年Q2");
  // turnsFromNow=1（来期回収）であり、「今すぐ使える現金」ではないことが構造上わかる。
  assert.equal(semantics.receivablesScheduleByPeriod[0].turnsFromNow, 1);
  assert.ok(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT.includes("cfo.receivablesScheduleByPeriod（実際の回収予定）が提供されている場合はそれに従い"));
});

test("AMM-FG-7: 応答schemaはOPPOSE stanceを許可し、他役員への明示的な反対を表現できる", () => {
  const withDisagreement = {
    primarySpeaker: "CFO",
    responses: [
      {
        speaker: "CFO",
        text: "Commercial Directorは納期遅延と述べましたが、私の契約データではoverdueは0です。",
        stance: "OPPOSE",
        proposalIds: [],
        factsUsed: ["commercial.backlog.overdueTons"],
        standardAiReferences: [],
      },
    ],
    requiresCeoSummary: false,
    proposals: [],
    meetingIntent: "CUSTOM",
    potentialStrategicChange: false,
    playerCorrectionStatus: "NOT_APPLICABLE",
  };
  const result = aiMeetingStructuredResponseSchema.safeParse(withDisagreement);
  assert.equal(result.success, true);
});

test("AMM-FG-8: Test26 BAL Turn1 finance grounding（Cash≈38.2M/Debt≈50.6M/AR≈66.4M/Backlog≈3063t/Overdue=0）", () => {
  const context = minimalContext();
  const contracts = [
    contract({ market: "US", product: "hoso", outstandingQuantity: 1367.43 as never, dueDate: "2015Q2" as never }),
    contract({ market: "EU", product: "hoso", outstandingQuantity: 588.3 as never, dueDate: "2015Q2" as never }),
    contract({ market: "JP", product: "hoso", outstandingQuantity: 336.51 as never, dueDate: "2015Q2" as never }),
    contract({ market: "OTHER", product: "hoso", outstandingQuantity: 771.18 as never, dueDate: "2015Q2" as never }),
  ];
  const receivables: ReceivableRecord[] = [
    { id: "r1", companyId: "BAL", market: "US", amount: 66_400_000 as never, originPeriod: "2015Q1" as never, dueSettlementPeriod: "2015Q2" as never, sourceRef: "fulfillment:2015Q1:US" },
  ];
  const loans: LoanRecord[] = [
    {
      loanId: "l1",
      companyId: "BAL",
      loanType: "termLoan" as never,
      originalPrincipalUsd: 50_600_000,
      currentPrincipalUsd: 50_600_000,
      originationPeriod: "2014Q1" as never,
      maturityPeriod: "2020Q1" as never,
      annualInterestRate: 0.08,
      creditSpreadAnnual: 0.03,
      repaymentMethod: "bulletAtMaturity" as never,
      equalPrincipalInstallmentUsd: 0,
      arrearsPrincipalUsd: 0,
      arrearsInterestUsd: 0,
      status: "active" as never,
      isEmergency: false,
    },
  ];
  const payables: PayableRecord[] = [];
  const capexProjects: CapitalProject[] = [];

  const packet = buildExecutiveBriefingPacket({
    context,
    previousQuarter: null,
    playerDraft: null,
    contracts,
    receivables,
    payables,
    loans,
    capexProjects,
    borrowingHeadroom: null,
    crisis: null,
    financialHistory: { reportingPeriod: null, priorPeriod: null },
    operationalHistory: { reportingPeriod: null, priorPeriod: null },
  });

  assert.ok(Math.abs(packet.common.backlog.totalTons - 3063.42) < 1e-6);
  assert.equal(packet.common.backlog.overdueTons, 0);
  assert.equal(packet.cfo.receivablesUsd, 66_400_000);
  assert.equal(packet.cfo.receivablesScheduleByPeriod[0].periodLabel, "2015年Q2");
  assert.equal(packet.cfo.loanArrearsPrincipalUsd, 0);
  assert.equal(packet.cfo.loanArrearsInterestUsd, 0);
  // false overdue / unsupported payment delayの根拠となるfieldが存在しないことを確認。
  assert.equal((packet.cfo as unknown as Record<string, unknown>).receivablesDelayedByTrust, undefined);
});

test("AMM-FG-9: prompt/briefing versionが更新され、識別可能になっている", () => {
  // 【M2.8】Game Knowledge Registryの注入・Truth Hierarchyの8段化・
  // 「実績値をルール値として提示しない」原則の追加によりsystem promptが変わったため v7→v8。
  // このテストの目的は「promptを変えたらversionも上げる」ことの固定であり、
  // 特定の historical version を保存することではない（過去Phaseでも同様に更新されている）。
  assert.equal(AI_MEETING_PROMPT_VERSION, "v8");
  assert.equal(EXECUTIVE_BRIEFING_VERSION, "v6");
  const context = minimalContext();
  const packet = buildExecutiveBriefingPacket({
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
    financialHistory: { reportingPeriod: null, priorPeriod: null },
    operationalHistory: { reportingPeriod: null, priorPeriod: null },
  });
  assert.equal(packet.common.briefingVersion, EXECUTIVE_BRIEFING_VERSION);
});

test("AMM-FG-10: legacy prompt versionのメッセージにはtag、現在versionには無い", () => {
  const legacyMsg: AiMeetingMessage = { id: "m1", speaker: "CFO", text: "3,600t overdueです。", turn: 1, proposalIds: [], factsUsed: [], promptVersion: "v1" };
  const currentMsg: AiMeetingMessage = { id: "m2", speaker: "CFO", text: "overdueは0です。", turn: 2, proposalIds: [], factsUsed: [], promptVersion: AI_MEETING_PROMPT_VERSION };
  const playerMsg: AiMeetingMessage = { id: "m3", speaker: "PLAYER", text: "確認したい。", turn: 2, proposalIds: [], factsUsed: [] };

  const legacyFormatted = formatHistoryEntryForPrompt(legacyMsg, AI_MEETING_PROMPT_VERSION);
  const currentFormatted = formatHistoryEntryForPrompt(currentMsg, AI_MEETING_PROMPT_VERSION);
  const playerFormatted = formatHistoryEntryForPrompt(playerMsg, AI_MEETING_PROMPT_VERSION);

  assert.ok(legacyFormatted.text.startsWith("[legacy v1"));
  assert.ok(legacyFormatted.text.includes("優先しない"));
  assert.equal(currentFormatted.text, currentMsg.text);
  assert.equal(playerFormatted.text, playerMsg.text);
});
