// ShrimpX V2 — 会社ラボ API decisionsProvider配線テスト（Phase 8C-3A §7）

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyId } from "../../../../../lib/v2/sales/types";
import { CompanyLabConfig } from "../../../../../lib/v2/companyLab/types";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../../../lib/v2/companyLab/autoPolicy";
import { generateStandardAiDecision } from "../../../../../lib/v2/companyLab/standardAi/policy";
import { COMPANY_LAB_COMPANY_IDS } from "../../../../../lib/v2/companyLab/fixtures";
import { buildInitialDraft } from "../../../../../v2/company-lab/decisionDraft";
import { buildApiDecisionsProvider } from "../decisionsProvider";
import { CompanyLabQuarterProcessingError } from "../../../../../lib/v2/companyLab/persistence/errors";

const PLAYER_COMPANY_ID = "BAL" as CompanyId;

function config(): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "decisions-provider-test-001", turns: 4 };
}

test("buildApiDecisionsProvider: プレイヤー会社は提出済みdraftから、AI会社はStandard AIから意思決定を組み立てる", () => {
  const { state, fixtures } = initializeCompanyLab(config());
  const publicInfo = buildPublicMarketInfo(state);
  const playerFixture = fixtures.find((f) => f.companyId === PLAYER_COMPANY_ID);
  assert.ok(playerFixture, "テストフィクスチャにプレイヤー会社BALが存在しません");
  const playerOwnState = buildCompanyOwnState(state, playerFixture!);
  const autoDecisionForPlayer = generateAutoPolicyDecision(playerFixture!, playerOwnState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(playerFixture!, autoDecisionForPlayer);

  const provider = buildApiDecisionsProvider("lab-decisions-test");
  const decisions = provider({
    restoredState: state,
    fixtures,
    publicInfo,
    period: state.currentPeriod,
    turn: 1,
    playerCompanyId: PLAYER_COMPANY_ID,
    submittedDraftBody: draft,
  });

  // 全社ぶんの意思決定が揃っている
  for (const id of COMPANY_LAB_COMPANY_IDS) {
    assert.ok(decisions[id], `会社 ${id} の意思決定が組み立てられていません`);
  }
  // プレイヤー会社の意思決定はdraft由来（companyIdが一致）
  assert.equal(decisions[PLAYER_COMPANY_ID].companyId, PLAYER_COMPANY_ID);

  // AI会社（プレイヤー以外）の意思決定は、同じ入力からgenerateStandardAiDecisionを
  // 直接呼んだ場合と完全に一致する（同一入力・同一ロジックであれば決定論的に同じ結果になる）。
  for (const fixture of fixtures) {
    if (fixture.companyId === PLAYER_COMPANY_ID) continue;
    const ownState = buildCompanyOwnState(state, fixture);
    const expected = generateStandardAiDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(decisions[fixture.companyId])), JSON.parse(JSON.stringify(expected)));
  }
});

test("buildApiDecisionsProvider: 形の壊れたdraft（companyId不一致・必須配列欠落）はCompanyLabQuarterProcessingErrorになる", () => {
  const { state, fixtures } = initializeCompanyLab(config());
  const publicInfo = buildPublicMarketInfo(state);
  const provider = buildApiDecisionsProvider("lab-decisions-broken");

  assert.throws(
    () =>
      provider({
        restoredState: state,
        fixtures,
        publicInfo,
        period: state.currentPeriod,
        turn: 1,
        playerCompanyId: PLAYER_COMPANY_ID,
        submittedDraftBody: { companyId: "WRONG_ID", salesPlans: [] },
      }),
    CompanyLabQuarterProcessingError
  );

  assert.throws(
    () =>
      provider({
        restoredState: state,
        fixtures,
        publicInfo,
        period: state.currentPeriod,
        turn: 1,
        playerCompanyId: PLAYER_COMPANY_ID,
        submittedDraftBody: { companyId: PLAYER_COMPANY_ID }, // salesPlans等が全部欠落
      }),
    CompanyLabQuarterProcessingError
  );

  assert.throws(
    () =>
      provider({
        restoredState: state,
        fixtures,
        publicInfo,
        period: state.currentPeriod,
        turn: 1,
        playerCompanyId: PLAYER_COMPANY_ID,
        submittedDraftBody: null,
      }),
    CompanyLabQuarterProcessingError
  );
});
