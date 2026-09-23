// ShrimpX V2 — ENG-CROWDING-MARKDOWN-3 / Persistence v9 接続テスト
//
// 目的（指示 §3 / §4 / §11 / §12）:
//   §3  registry 不変性: 既存 salesModelId は Crowding OFF のまま。新 ID だけ P1 ON。
//   §4  policy 解決: crowdingPolicyForModelId が salesModelId から正式 P1 を返す。
//   §11 resume: save → serialize → validate → restore の後も
//       salesModelId = tiered-v200-crowding-v1 / P1 enabled / 係数完全一致。
//       （config.crowding は永続化 whitelist を通らないため、SSoT は salesModelId。
//         「save/resume 後に Crowding が OFF へ戻る」事象が無いことをここで固定する。）
//   §12 v8 後方互換: v8 payload は読めて、crowdingDiagnostics は undefined で、
//       salesModelId の従来意味が保たれ、resume して次ターンを進められる。
//
// 本ファイルはテスト専用であり、engine 側の式・係数を一切変更しない。

import test from "node:test";
import assert from "node:assert/strict";

import { baseTestConfig, runRealQuartersWithAutoPolicy } from "./testHelpers";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../snapshot";
import { validateCompanyLabPersistedState, validateCompanyLabQuarterHistoryEntry } from "../schema";
import { CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../types";
import { CompanyLabPersistedStateV1 } from "../types";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig } from "../../types";
import { CompanyId } from "../../../sales/types";
import { crowdingPolicyForModelId, SALES_MODEL_IDS } from "../../../sales/salesModels";
import {
  CROWDING_COEFFICIENTS_V200_P1,
  CROWDING_POLICY_VERSION_V1,
  CrowdingMarkdownCoefficients,
} from "../../../sales/crowding";
import { Product } from "../../../market/types";

const PRODUCTS_FOR_TEST: readonly Product[] = ["hoso", "pd", "vap"];

const NEW_MODEL_ID = "tiered-v200-crowding-v1" as const;
const OLD_TIERED_MODEL_ID = "tiered-v200-candidate-v1" as const;
const LEGACY_MODEL_ID = "legacy-waterfall-v1" as const;

// 実行する四半期数。config.turns はこれより長くしておく
// （resume 後にもう 1 四半期進められることを確かめるため。
//  turns と実行数を同じにすると Run が完了扱いになり resume 検証ができない）。
const TURNS = 2;
const CONFIG_TURNS = TURNS + 2;
const TEST_ENGINE_VERSION = "test-v2-companyLab-engine-crowding-v9";

function crowdingConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return baseTestConfig({ turns: CONFIG_TURNS, seed: "crowding-v9-resume-seed", salesModelId: NEW_MODEL_ID, ...overrides });
}

function buildStored(
  config: CompanyLabConfig,
  runtime: ReturnType<typeof createCompanyLabRuntimeSnapshot>,
  fixtures: readonly unknown[],
  schemaVersion: number
) {
  return {
    schemaVersion,
    engineVersion: TEST_ENGINE_VERSION,
    labId: "lab-crowding-v9-001",
    playerCompanyId: "BAL",
    config,
    fixtures,
    currentState: { runtime, revision: TURNS, lastProcessedTurnId: `turn-${TURNS}` },
    draft: null,
    metadata: { createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
  } as unknown as CompanyLabPersistedStateV1;
}

/** JSON 直列化を必ず挟む（Redis 往復と同じ経路を通す）。 */
function roundTrip(stored: CompanyLabPersistedStateV1): CompanyLabPersistedStateV1 {
  return validateCompanyLabPersistedState(JSON.parse(JSON.stringify(stored)) as unknown);
}

// ---------------------------------------------------------------------
// §3 registry 不変性
// ---------------------------------------------------------------------

test("CRWD-V9-1（§3）: 既存 salesModelId は Crowding OFF のまま・新 ID だけ P1 を持つ", () => {
  assert.equal(crowdingPolicyForModelId(LEGACY_MODEL_ID), undefined);
  assert.equal(crowdingPolicyForModelId(OLD_TIERED_MODEL_ID), undefined);

  const p1 = crowdingPolicyForModelId(NEW_MODEL_ID);
  assert.ok(p1, "新 salesModelId は Crowding policy を持つ");
  assert.equal(p1.enabled, true);
  assert.equal(p1.policyVersion, CROWDING_POLICY_VERSION_V1);

  // registry に Crowding policy を持つ ID は 1 つだけ（retrofit 防止）。
  const withPolicy = SALES_MODEL_IDS.filter((id) => crowdingPolicyForModelId(id) !== undefined);
  assert.deepEqual([...withPolicy], [NEW_MODEL_ID]);
});

test("CRWD-V9-2（§4）: crowdingPolicyForModelId は P1 の係数をそのまま返す", () => {
  const p1 = crowdingPolicyForModelId(NEW_MODEL_ID);
  assert.ok(p1);
  for (const product of PRODUCTS_FOR_TEST) {
    assert.deepEqual(p1.byProduct[product], CROWDING_COEFFICIENTS_V200_P1);
    assert.equal(p1.protectedExternalShare[product], 0.2);
  }
});

// ---------------------------------------------------------------------
// §11 resume（新 salesModelId）
// ---------------------------------------------------------------------

test("CRWD-V9-3（§11）: save → persist → load → resume 後も salesModelId と P1 係数が保たれる", () => {
  const config = crowdingConfig();
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(config, TURNS);
  assert.ok(quarters.length > 0);

  const runtime = createCompanyLabRuntimeSnapshot(quarters[quarters.length - 1].stateAfter);
  const decoded = roundTrip(buildStored(config, runtime, fixtures, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION));

  // salesModelId が persistence を生き残る（config.crowding と違い whitelist を通る）。
  assert.equal(decoded.config.salesModelId, NEW_MODEL_ID);

  const resolved = crowdingPolicyForModelId(decoded.config.salesModelId!);
  assert.ok(resolved, "resume 後も Crowding policy が解決できる（OFF へ戻らない）");
  assert.equal(resolved.enabled, true);
  for (const product of PRODUCTS_FOR_TEST) {
    const c: CrowdingMarkdownCoefficients = resolved.byProduct[product];
    assert.equal(c.threshold, CROWDING_COEFFICIENTS_V200_P1.threshold);
    assert.equal(c.lambda, CROWDING_COEFFICIENTS_V200_P1.lambda);
    assert.equal(c.gamma, CROWDING_COEFFICIENTS_V200_P1.gamma);
    assert.equal(c.floor, CROWDING_COEFFICIENTS_V200_P1.floor);
    assert.equal(resolved.protectedExternalShare[product], 0.2);
  }
});

test("CRWD-V9-4（§11）: 既存 tiered-v200-candidate-v1 は resume 後も Crowding OFF", () => {
  const config = crowdingConfig({ salesModelId: OLD_TIERED_MODEL_ID });
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(config, TURNS);
  const runtime = createCompanyLabRuntimeSnapshot(quarters[quarters.length - 1].stateAfter);
  const decoded = roundTrip(buildStored(config, runtime, fixtures, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION));

  assert.equal(decoded.config.salesModelId, OLD_TIERED_MODEL_ID);
  assert.equal(crowdingPolicyForModelId(decoded.config.salesModelId!), undefined);
  for (const q of quarters) {
    assert.equal(q.record.crowdingDiagnostics, undefined);
  }
});

test("CRWD-V9-5（§11）: resume 後に次ターンを進められる（新 salesModelId）", () => {
  const config = crowdingConfig();
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(config, TURNS);
  const last = quarters[quarters.length - 1].stateAfter;
  const decoded = roundTrip(
    buildStored(config, createCompanyLabRuntimeSnapshot(last), fixtures, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION)
  );

  const restored = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, []);
  const publicInfo = buildPublicMarketInfo(restored);
  const decisions: Record<CompanyId, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    decisions[f.companyId] = generateAutoPolicyDecision(
      f,
      buildCompanyOwnState(restored, f),
      publicInfo,
      restored.currentPeriod,
      restored.scenarioState.currentTurn
    );
  }
  const next = advanceCompanyLabQuarter(restored, fixtures, decisions);
  const record = next.history[next.history.length - 1];
  assert.ok(record, "resume 後のターンが確定する");
  assert.ok(record.crowdingDiagnostics, "resume 後のターンでも Crowding 診断が出る（OFF へ戻らない）");
  assert.equal(record.crowdingDiagnostics!.enabled, true);
  assert.equal(record.crowdingDiagnostics!.policyVersion, CROWDING_POLICY_VERSION_V1);
});

// ---------------------------------------------------------------------
// §7 Crowding 診断の永続化 round-trip
// ---------------------------------------------------------------------

test("CRWD-V9-6（§7）: Crowding 診断が history entry の JSON round-trip を数値一致で生き残る", () => {
  const config = crowdingConfig();
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(config, TURNS);
  const quarter = quarters[0];
  assert.ok(quarter.record.crowdingDiagnostics, "Crowding ON の Run では診断が記録される");

  const entry = {
    turnId: "turn-1",
    turn: quarter.record.turn,
    period: quarter.record.period,
    engineVersion: TEST_ENGINE_VERSION,
    schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
    preProcessingStateSnapshot: createCompanyLabRuntimeSnapshot(quarter.stateBefore),
    postProcessingStateSnapshot: createCompanyLabRuntimeSnapshot(quarter.stateAfter),
    playerSubmission: quarter.decisionsByCompanyId[fixtures[0].companyId],
    otherCompaniesDecisions: fixtures.slice(1).map((f) => quarter.decisionsByCompanyId[f.companyId]),
    record: quarter.record,
    processedAt: "2026-09-01T00:00:00.000Z",
  };

  const decoded = validateCompanyLabQuarterHistoryEntry(JSON.parse(JSON.stringify(entry)) as unknown, "$");
  const before = quarter.record.crowdingDiagnostics!;
  const after = decoded.record.crowdingDiagnostics;
  assert.ok(after, "round-trip 後も診断が存在する");
  assert.equal(after.diagnosticsVersion, before.diagnosticsVersion);
  assert.equal(after.policyVersion, before.policyVersion);
  assert.equal(after.enabled, before.enabled);
  assert.equal(after.buckets.length, before.buckets.length);
  assert.deepEqual(after.buckets, before.buckets);
});

// ---------------------------------------------------------------------
// §12 v8 後方互換
// ---------------------------------------------------------------------

test("CRWD-V9-7（§12）: v8 payload は読めて・診断 undefined・salesModelId の意味が保たれ・resume できる", () => {
  const config = crowdingConfig({ salesModelId: OLD_TIERED_MODEL_ID });
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(config, TURNS);
  const last = quarters[quarters.length - 1].stateAfter;

  // v8 時点で保存されたものを模す（schemaVersion=8、crowdingDiagnostics キー自体が無い）。
  const v8 = JSON.parse(
    JSON.stringify(buildStored(config, createCompanyLabRuntimeSnapshot(last), fixtures, 8))
  ) as Record<string, unknown>;
  assert.equal(v8.schemaVersion, 8);

  const decoded = validateCompanyLabPersistedState(v8);
  assert.equal(decoded.schemaVersion, 8, "v8 payload が v9 コードで読める");
  assert.equal(decoded.config.salesModelId, OLD_TIERED_MODEL_ID, "salesModelId の従来意味が保たれる");
  assert.equal(crowdingPolicyForModelId(decoded.config.salesModelId!), undefined);

  const restored = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, []);
  const publicInfo = buildPublicMarketInfo(restored);
  const decisions: Record<CompanyId, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    decisions[f.companyId] = generateAutoPolicyDecision(
      f,
      buildCompanyOwnState(restored, f),
      publicInfo,
      restored.currentPeriod,
      restored.scenarioState.currentTurn
    );
  }
  const next = advanceCompanyLabQuarter(restored, fixtures, decisions);
  const record = next.history[next.history.length - 1];
  assert.ok(record, "v8 payload から resume して次ターンを進められる");
  assert.equal(record.crowdingDiagnostics, undefined, "v8 由来の Run は Crowding 診断を持たない");
});

test("CRWD-V9-8（§12）: v8 の history entry（crowdingDiagnostics キー無し）を読んでも例外にならない", () => {
  const config = crowdingConfig({ salesModelId: OLD_TIERED_MODEL_ID });
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(config, TURNS);
  const quarter = quarters[0];
  const entry = {
    turnId: "turn-1",
    turn: quarter.record.turn,
    period: quarter.record.period,
    engineVersion: TEST_ENGINE_VERSION,
    schemaVersion: 8,
    preProcessingStateSnapshot: createCompanyLabRuntimeSnapshot(quarter.stateBefore),
    postProcessingStateSnapshot: createCompanyLabRuntimeSnapshot(quarter.stateAfter),
    playerSubmission: quarter.decisionsByCompanyId[fixtures[0].companyId],
    otherCompaniesDecisions: fixtures.slice(1).map((f) => quarter.decisionsByCompanyId[f.companyId]),
    record: quarter.record,
    processedAt: "2026-09-01T00:00:00.000Z",
  };
  const raw = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
  assert.equal(
    Object.prototype.hasOwnProperty.call(raw.record as object, "crowdingDiagnostics"),
    false,
    "v8 相当の record には crowdingDiagnostics キー自体が無い"
  );
  const decoded = validateCompanyLabQuarterHistoryEntry(raw, "$");
  assert.equal(decoded.record.crowdingDiagnostics, undefined);
});
