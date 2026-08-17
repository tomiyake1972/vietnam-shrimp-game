// ShrimpX V2 — Phase SAI-5B: Company Lab 経路での CompanyOrientationProfile 有効化テスト
//
// Simulation Run 側（simulation/engine.ts）の検証は
// app/lib/v2/companyLab/standardAi/__tests__/orientationActivationSAI5B.test.ts にある。
// こちらは「Company Lab でも同じ会社別プロファイルが適用される」ことを固定する。
//
// 【Lab作成時にconfigへ書き込む理由】保存済みLabのconfigを読む側で既定値を補うと、
// SAI-5B以前に作られたLabの挙動まで遡って変わってしまう。作成時に明示的に書き込み、
// 読む側は「未記録＝OFF」という契約のままにすることで、既存Labを壊さない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryCompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { validateCompanyLabPersistedState } from "../../../../../lib/v2/companyLab/persistence/schema";
import { createCompanyLabQuarterFlowService } from "../../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../../../lib/v2/companyLab/autoPolicy";
import { generateStandardAiDecisionWithDiagnostics } from "../../../../../lib/v2/companyLab/standardAi/policy";
import {
  DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE,
  resolveStandardAiProfileForMode,
} from "../../../../../lib/v2/companyLab/standardAi/orientationProfile";
import { CompanyLabConfig } from "../../../../../lib/v2/companyLab/types";
import { CompanyId } from "../../../../../lib/v2/sales/types";
import { buildInitialDraft } from "../../../../../v2/company-lab/decisionDraft";
import { CompanyLabApiDependencies } from "../dependencies";
import { handleCreateLab } from "../handlers";
import { buildApiDecisionsProvider } from "../decisionsProvider";
import { unwrapUnit } from "../../../../../lib/v2/core/units";

const NOW = "2026-01-01T00:00:00.000Z";
const PLAYER_COMPANY_ID = "BAL" as CompanyId;

function makeDeps(): CompanyLabApiDependencies {
  const repository = createInMemoryCompanyLabStateRepository();
  return { repository, service: createCompanyLabQuarterFlowService({ repository }) };
}

test("SAI5B-LAB-1: 新規Lab作成時にstandardAiProfileModeがconfigへ書き込まれる（既定=ON）", async () => {
  const deps = makeDeps();
  const labId = "sai5b-lab-1";
  const result = await handleCreateLab(
    deps,
    { labId, scenarioId: "baseline", mode: "canonical", seed: "sai5b-lab-seed", turns: 4, playerCompanyId: PLAYER_COMPANY_ID },
    NOW
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));

  const stored = await deps.repository.loadCurrentState(labId);
  assert.equal(stored.config.standardAiProfileMode, DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE);

  // 【Redis往復で落ちないこと】persistence/schema.tsのvalidateCompanyLabConfigは
  // 許可リスト方式でconfigを組み直すため、ここに追加し忘れると保存→読み込みで
  // 黙ってOFFへ戻る（sai5フラグで実際に起きた不具合と同じ形）。
  const roundTripped = validateCompanyLabPersistedState(JSON.parse(JSON.stringify(stored)));
  assert.equal(
    roundTripped.config.standardAiProfileMode,
    DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE,
    "保存済みJSONを読み直してもstandardAiProfileModeが保持されるべき"
  );
});

/** 指定modeのLab configで、AI4社の意思決定（販売計画の商品・市場構成）を取り出す。 */
function aiSalesMix(standardAiProfileMode: "OFF" | "ON" | undefined) {
  const config: CompanyLabConfig = {
    scenarioId: "baseline",
    mode: "canonical",
    seed: "sai5b-lab-mix-seed",
    turns: 4,
    standardAiProfileMode,
  };
  const { state, fixtures } = initializeCompanyLab(config);
  const publicInfo = buildPublicMarketInfo(state);
  const playerFixture = fixtures.find((f) => f.companyId === PLAYER_COMPANY_ID)!;
  const draft = buildInitialDraft(
    playerFixture,
    generateAutoPolicyDecision(playerFixture, buildCompanyOwnState(state, playerFixture), publicInfo, state.currentPeriod, 1)
  );
  const decisions = buildApiDecisionsProvider("sai5b-lab-mix")({
    restoredState: state,
    fixtures,
    publicInfo,
    period: state.currentPeriod,
    turn: 1,
    playerCompanyId: PLAYER_COMPANY_ID,
    submittedDraftBody: draft,
  });
  return { state, fixtures, publicInfo, decisions };
}

test("SAI5B-LAB-2: Company LabのAI会社にも、engine.tsと同じ会社別paramsが適用される", () => {
  const { state, fixtures, publicInfo, decisions } = aiSalesMix("ON");
  for (const fixture of fixtures) {
    if (fixture.companyId === PLAYER_COMPANY_ID) continue;
    const expected = generateStandardAiDecisionWithDiagnostics(
      fixture,
      buildCompanyOwnState(state, fixture),
      publicInfo,
      state.currentPeriod,
      1,
      resolveStandardAiProfileForMode(fixture.companyId, "ON").params
    ).decision;
    assert.deepEqual(
      JSON.parse(JSON.stringify(decisions[fixture.companyId])),
      JSON.parse(JSON.stringify(expected)),
      `${fixture.companyId}の意思決定が会社別params経由になっていない`
    );
  }
});

test("SAI5B-LAB-3: mode=ONのLabでは、AI会社の販売計画がOFFのときと実際に変わる（配線が効いている）", () => {
  const on = aiSalesMix("ON");
  const off = aiSalesMix("OFF");
  const hosoShare = (r: ReturnType<typeof aiSalesMix>, companyId: string) => {
    const plans = r.decisions[companyId as CompanyId].salesPlans;
    const total = plans.reduce((a, p) => a + unwrapUnit(p.desiredQuantity), 0);
    const hoso = plans.filter((p) => p.product === "hoso").reduce((a, p) => a + unwrapUnit(p.desiredQuantity), 0);
    return total <= 0 ? 0 : (hoso / total) * 100;
  };
  // MASS（chinaVolume・HOSO1.20）はONの方がHOSO比率が高くなる。
  assert.ok(hosoShare(on, "MASS") > hosoShare(off, "MASS"), `MASSのHOSO比率 ON=${hosoShare(on, "MASS")} OFF=${hosoShare(off, "MASS")}`);
  // JPQ（japanQuality・HOSO0.85）はONの方がHOSO比率が低くなる。
  assert.ok(hosoShare(on, "JPQ") < hosoShare(off, "JPQ"), `JPQのHOSO比率 ON=${hosoShare(on, "JPQ")} OFF=${hosoShare(off, "JPQ")}`);
});

test("SAI5B-LAB-4: mode未記録のlegacy Labは従来どおり会社差ゼロのまま（既存Labを壊さない）", () => {
  const { state, fixtures, publicInfo, decisions } = aiSalesMix(undefined);
  for (const fixture of fixtures) {
    if (fixture.companyId === PLAYER_COMPANY_ID) continue;
    const expected = generateStandardAiDecisionWithDiagnostics(
      fixture,
      buildCompanyOwnState(state, fixture),
      publicInfo,
      state.currentPeriod,
      1
      // params未指定＝SAI-5B以前と完全に同じ経路
    ).decision;
    assert.deepEqual(JSON.parse(JSON.stringify(decisions[fixture.companyId])), JSON.parse(JSON.stringify(expected)), `${fixture.companyId}`);
  }
});
