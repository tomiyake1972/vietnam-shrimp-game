// ShrimpX V2 — Strategy Profile Calibration（Phase SP-Q2）Persistence テスト
//
// 指示§3の SPQ2-PERSIST-1〜5 にそのまま対応させる。
//
// 【修正した不具合】restoreSessionFromResumePayload が SimulationSession の
// トップレベル config を run.scenarioId/seed/requestedTurns だけから再構築しており、
// visionOverrides・standardAiProfileMode が黙って失われていた（resume.ts参照）。
// engine.ts の意思決定ループは session.state.config 側だけを読むため実際のゲーム
// 挙動への影響は無かったが、session.config は applyVisionOverrideToSession 等の
// 書き込み系関数が参照する設計であり、resume直後にトップレベルconfigだけが古い
// ままなのは不整合だった。resumePayload.state.config（trimStateForResumeが
// 変更しないフィールド）を単一の情報源として両方のconfigを揃うよう修正した。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurns, applyVisionOverrideToSession, createSimulationSession } from "../engine";
import { buildResumePayload, restoreSessionFromResumePayload } from "../persistence/resume";
import { CompanyControlMode } from "../types";
import { CompanyDecisionInput } from "../../types";
import { DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE } from "../../standardAi/orientationProfile";

const AT = "2026-01-01T00:00:00.000Z";
const EMPTY_CONTROL_MODES: Readonly<Record<string, CompanyControlMode>> = {};
const EMPTY_DECISIONS: Readonly<Record<string, CompanyDecisionInput>> = {};

function runTurns(simulationRunId: string, turnsToRun: number, standardAiProfileMode?: "OFF" | "ON") {
  const session = createSimulationSession({
    simulationRunId,
    scenarioId: "baseline",
    seed: "spq2-persist-test",
    requestedTurns: 32,
    startedAt: AT,
    standardAiProfileMode,
  });
  return advanceSimulationTurns({ session, turns: turnsToRun, timestamp: AT });
}

/** Redisへの保存・読み込みと同じ「JSON往復」を模す（redisRepository.tsはスキーマ検証なしでJSON.stringify/parseするだけ）。 */
function roundTripThroughJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

test("SPQ2-PERSIST-1: standardAiProfileMode=ONで保存したRunは、resume後もONのまま（トップレベルconfig・state.config両方）", () => {
  const session = runTurns("spq2-persist-1", 3, "ON");
  assert.equal(session.state.config.standardAiProfileMode, "ON");
  const payload = roundTripThroughJson(buildResumePayload(session, EMPTY_CONTROL_MODES, EMPTY_DECISIONS));
  const restored = restoreSessionFromResumePayload(session.run, payload);
  assert.equal(restored.state.config.standardAiProfileMode, "ON", "state.config側はONのまま");
  assert.equal(restored.config.standardAiProfileMode, "ON", "トップレベルconfig側もONであるべき（以前はここが失われていた）");
});

test("SPQ2-PERSIST-2: standardAiProfileMode=OFFで保存したRunは、resume後もOFFのまま", () => {
  const session = runTurns("spq2-persist-2", 3, "OFF");
  const payload = roundTripThroughJson(buildResumePayload(session, EMPTY_CONTROL_MODES, EMPTY_DECISIONS));
  const restored = restoreSessionFromResumePayload(session.run, payload);
  assert.equal(restored.state.config.standardAiProfileMode, "OFF");
  assert.equal(restored.config.standardAiProfileMode, "OFF");
});

// 【Phase SAI-5B】createSimulationSessionの既定が "ON" になったため、
// 「mode未記録のRun」はもうこの関数からは作れない。実際のlegacy Run（SAI-5B以前に
// 保存され、configにstandardAiProfileMode自体が無いRun）と同じ形を、保存済みJSONから
// フィールドを削って再現する。resume時にONを捏造して既存Runの挙動を書き換えないことが
// この項目の趣旨であり、そこは変わっていない。
test("SPQ2-PERSIST-3: standardAiProfileModeが記録されていないlegacy Runは、resume後もOFF相当（undefined）のまま", () => {
  const session = runTurns("spq2-persist-3", 3, "ON");
  const payload = roundTripThroughJson(buildResumePayload(session, EMPTY_CONTROL_MODES, EMPTY_DECISIONS));
  // legacy Run相当へ加工する（保存時点でこのフィールドが存在しなかったRun）。
  delete (payload.state.config as { standardAiProfileMode?: unknown }).standardAiProfileMode;
  assert.equal(payload.state.config.standardAiProfileMode, undefined, "前提: legacy相当のpayloadにはmodeが無い");

  const restored = restoreSessionFromResumePayload(session.run, payload);
  assert.equal(restored.state.config.standardAiProfileMode, undefined, "legacy Runはresume後もundefined（=OFF相当）のままであるべき。捏造しない");
  assert.equal(restored.config.standardAiProfileMode, undefined);
});

test("SPQ2-PERSIST-3b: 新規Runはmode未指定でも既定でONがconfigへ書き込まれ、resume後も保持される", () => {
  const session = runTurns("spq2-persist-3b", 2 /* standardAiProfileMode省略 */);
  assert.equal(
    session.state.config.standardAiProfileMode,
    DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE,
    "SAI-5B以降、新規Runの既定はDEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE"
  );
  const payload = roundTripThroughJson(buildResumePayload(session, EMPTY_CONTROL_MODES, EMPTY_DECISIONS));
  const restored = restoreSessionFromResumePayload(session.run, payload);
  assert.equal(restored.state.config.standardAiProfileMode, DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE);
  assert.equal(restored.config.standardAiProfileMode, DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE);
});

test("SPQ2-PERSIST-4: standardAiProfileModeはvisionOverridesと共存できる（両方が同時にresume後も保持される）", () => {
  let session = runTurns("spq2-persist-4", 2, "ON");
  session = applyVisionOverrideToSession(session, "MASS", {
    effectiveFromTurn: session.state.scenarioState.currentTurn + 1,
    targetScaleTonsPerQuarterAtQ32: 90000,
    source: "MANUAL_OVERRIDE",
  });
  assert.equal(session.state.config.standardAiProfileMode, "ON", "前提: visionOverride適用後もstandardAiProfileModeは維持される");
  assert.ok(session.state.config.visionOverrides?.MASS, "前提: MASSのvisionOverrideが設定されている");

  const payload = roundTripThroughJson(buildResumePayload(session, EMPTY_CONTROL_MODES, EMPTY_DECISIONS));
  const restored = restoreSessionFromResumePayload(session.run, payload);

  assert.equal(restored.state.config.standardAiProfileMode, "ON", "resume後もstandardAiProfileModeはONのまま");
  assert.equal(restored.config.standardAiProfileMode, "ON");
  assert.deepEqual(restored.state.config.visionOverrides, session.state.config.visionOverrides, "resume後もvisionOverridesは変わらず維持される");
  assert.deepEqual(restored.config.visionOverrides, session.state.config.visionOverrides, "トップレベルconfig側のvisionOverridesも一致するべき");
});

test("SPQ2-PERSIST-5: この修正は既存のresumePayload構造（他フィールド）を一切壊さない", () => {
  const session = runTurns("spq2-persist-5", 4, "ON");
  const controlModes: Readonly<Record<string, CompanyControlMode>> = { BAL: "PLAYER" };
  const payload = roundTripThroughJson(buildResumePayload(session, controlModes, EMPTY_DECISIONS));
  const restored = restoreSessionFromResumePayload(session.run, payload);

  // compaction対象外のフィールドは往復で一致するはず（既存SAVE-1と同じ確認範囲）。
  assert.equal(restored.state.currentPeriod, session.state.currentPeriod);
  assert.equal(restored.state.scenarioState.currentTurn, session.state.scenarioState.currentTurn);
  assert.deepEqual(restored.fixtures, session.fixtures);
  assert.equal(restored.state.config.scenarioId, session.state.config.scenarioId);
  assert.equal(restored.state.config.seed, session.state.config.seed);
  assert.equal(restored.state.config.turns, session.state.config.turns);
  assert.equal(restored.config.scenarioId, session.run.scenarioId);
  assert.equal(restored.config.turns, session.run.requestedTurns);
});
