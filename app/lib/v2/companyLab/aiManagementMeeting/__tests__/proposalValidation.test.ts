// AMM-9: proposal-schema-validation
// AMM-10: invalid-CAPEX-rejected
// AMM-11: invalid-factory-rejected
// AMM-12: sales-proposal-respects-market-level-headcount-structure
// AMM-18: Standard-AI-proposal-references-preserved

import { test } from "node:test";
import assert from "node:assert/strict";
import { aiMeetingStructuredResponseSchema } from "../proposalSchema";
import { validateAiMeetingProposals } from "../validation";
import { AiMeetingProposal, CapexProposal, SalesProposal } from "../types";
import { CompanyFixture } from "../../types";

function minimalFixture(): CompanyFixture {
  return {
    companyId: "BAL",
    displayName: "BAL Test",
    archetype: "balanced" as never,
    description: "test fixture",
    country: "VN" as never,
    factories: [{ factoryId: "F1" } as never],
    workerBaseline: [],
    aquacultureCapacity: 0 as never,
    salesForceHeadcountTotal: 10,
    procurementHeadcountTotal: 5,
    initialRawMaterialLots: [],
    productEconomics: {} as never,
  };
}

test("AMM-9: proposal-schema-validation — 有効な構造化応答はZodを通過する", () => {
  const valid = {
    primarySpeaker: "CFO",
    responses: [
      {
        speaker: "CFO",
        text: "現金は十分にあります。",
        stance: "SUPPORT",
        proposalIds: [],
        factsUsed: ["cash.current"],
        standardAiReferences: [],
      },
    ],
    requiresCeoSummary: false,
    proposals: [],
    meetingIntent: "PROTECT_CASH",
    potentialStrategicChange: false,
  };
  const result = aiMeetingStructuredResponseSchema.safeParse(valid);
  assert.equal(result.success, true);
});

test("AMM-9b: 不正な構造化応答（responses空・不明なenum）はZodで拒否される", () => {
  const invalid = {
    primarySpeaker: "NOT_A_ROLE",
    responses: [],
    requiresCeoSummary: false,
    proposals: [],
    meetingIntent: "PROTECT_CASH",
    potentialStrategicChange: false,
  };
  const result = aiMeetingStructuredResponseSchema.safeParse(invalid);
  assert.equal(result.success, false);
});

test("AMM-10: invalid-CAPEX-rejected — 存在しないCAPEX種別はvalidation.tsで拒否される", () => {
  const fixture = minimalFixture();
  const badCapex = { id: "p1", domain: "CAPEX", rationale: "test", projectType: "not_a_real_type", targetFactoryId: "F1" } as unknown as CapexProposal;
  const results = validateAiMeetingProposals([badCapex], { fixture, currentTurn: 3, requestTurn: 3, cashUsd: 1_000_000 });
  assert.equal(results[0].valid, false);
  assert.ok(results[0].issues.some((i) => i.includes("CAPEX種別")));
});

test("AMM-11: invalid-factory-rejected — 存在しない工場IDはvalidation.tsで拒否される", () => {
  const fixture = minimalFixture();
  const badFactory: CapexProposal = { id: "p2", domain: "CAPEX", rationale: "test", projectType: "hosoLineExpansion", targetFactoryId: "NO_SUCH_FACTORY" };
  const results = validateAiMeetingProposals([badFactory], { fixture, currentTurn: 3, requestTurn: 3, cashUsd: 1_000_000 });
  assert.equal(results[0].valid, false);
  assert.ok(results[0].issues.some((i) => i.includes("工場")));
});

test("AMM-11b: 有効な工場IDのCAPEX提案は通過する", () => {
  const fixture = minimalFixture();
  const ok: CapexProposal = { id: "p3", domain: "CAPEX", rationale: "test", projectType: "pdMechanization", targetFactoryId: "F1", requestedBudgetUsd: 100_000 };
  const results = validateAiMeetingProposals([ok], { fixture, currentTurn: 3, requestTurn: 3, cashUsd: 1_000_000 });
  assert.equal(results[0].valid, true);
});

test("AMM-10b: 同一CAPEX案件の重複提案は検出される", () => {
  const fixture = minimalFixture();
  const dup1: CapexProposal = { id: "p4", domain: "CAPEX", rationale: "test", projectType: "hosoLineExpansion", targetFactoryId: "F1" };
  const dup2: CapexProposal = { id: "p5", domain: "CAPEX", rationale: "test again", projectType: "hosoLineExpansion", targetFactoryId: "F1" };
  const results = validateAiMeetingProposals([dup1, dup2], { fixture, currentTurn: 3, requestTurn: 3, cashUsd: 1_000_000 });
  assert.equal(results[0].valid, true);
  assert.equal(results[1].valid, false);
  assert.ok(results[1].issues.some((i) => i.includes("重複")));
});

test("AMM-12: sales-proposal-respects-market-level-headcount-structure — 販売提案はmarket×product単位で、salesForceHeadcountは0以上の整数", () => {
  const fixture = minimalFixture();
  const validSales: SalesProposal = { id: "s1", domain: "SALES", rationale: "test", market: "JP", product: "pd", salesForceHeadcount: 3 };
  const invalidSales: SalesProposal = { id: "s2", domain: "SALES", rationale: "test", market: "JP", product: "pd", salesForceHeadcount: -1.5 };
  const results = validateAiMeetingProposals([validSales, invalidSales], { fixture, currentTurn: 3, requestTurn: 3, cashUsd: 1_000_000 });
  assert.equal(results[0].valid, true);
  assert.equal(results[1].valid, false);
  assert.ok(results[1].issues.some((i) => i.includes("salesForceHeadcount")));
});

test("AMM-12b: proposalSchema.tsはSALES提案にmarket/productを要求する（会社全体や市場単位の粒度は許さない）", () => {
  const missingMarket = {
    primarySpeaker: "COMMERCIAL",
    responses: [{ speaker: "COMMERCIAL", text: "販売を強化します。", proposalIds: ["s1"], factsUsed: [], standardAiReferences: [] }],
    requiresCeoSummary: false,
    proposals: [{ id: "s1", domain: "SALES", rationale: "test", product: "pd", salesForceHeadcount: 3 }],
    meetingIntent: "GROW_AGGRESSIVELY",
    potentialStrategicChange: false,
  };
  const result = aiMeetingStructuredResponseSchema.safeParse(missingMarket);
  assert.equal(result.success, false);
});

test("AMM-18: Standard-AI-proposal-references-preserved — standardAiReferencesはZod検証を通過して保持される", () => {
  const withReference = {
    primarySpeaker: "COO",
    responses: [
      {
        speaker: "COO",
        text: "既存のPD省人化提案を支持します。",
        proposalIds: [],
        factsUsed: ["capacity.PD.utilization"],
        standardAiReferences: [{ reasonCode: "PD_MECH_PROPOSED", targetFactoryId: "F1", targetProduct: "pd", stance: "SUPPORT", note: "既存提案に同意" }],
      },
    ],
    requiresCeoSummary: false,
    proposals: [] as AiMeetingProposal[],
    meetingIntent: "CUSTOM",
    potentialStrategicChange: false,
  };
  const result = aiMeetingStructuredResponseSchema.safeParse(withReference);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.responses[0].standardAiReferences[0].reasonCode, "PD_MECH_PROPOSED");
    assert.equal(result.data.responses[0].standardAiReferences[0].stance, "SUPPORT");
  }
});
