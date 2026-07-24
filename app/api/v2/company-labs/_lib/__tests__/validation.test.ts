// ShrimpX V2 — 会社ラボ API 入力検証テスト（Phase 8C-3A）

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_HISTORY_LIMIT,
  validateCreateLabRequestBody,
  validateHistoryQuery,
  validateLabId,
  validateProcessQuarterRequestBody,
  validateSaveDraftRequestBody,
  validateTurnParam,
} from "../validation";

test("validateLabId: 妥当なlabIdはokを返す", () => {
  const result = validateLabId("lab-abc123");
  assert.equal(result.ok, true);
});

test("validateLabId: 空文字・非文字列・':'を含む・長すぎる場合はいずれも拒否する", () => {
  assert.equal(validateLabId("").ok, false);
  assert.equal(validateLabId(123).ok, false);
  assert.equal(validateLabId(undefined).ok, false);
  assert.equal(validateLabId("lab:with:colon").ok, false);
  assert.equal(validateLabId("x".repeat(300)).ok, false);
});

test("validateCreateLabRequestBody: 最小限の妥当な入力を受理する（labId省略可）", () => {
  const result = validateCreateLabRequestBody({ scenarioId: "baseline", mode: "canonical", seed: "seed-1", turns: 4 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.labId, undefined);
    assert.equal(result.value.scenarioId, "baseline");
    assert.equal(result.value.turns, 4);
  }
});

test("validateCreateLabRequestBody: labIdを指定した場合はそのまま受理する", () => {
  const result = validateCreateLabRequestBody({ labId: "my-lab", scenarioId: "baseline", mode: "canonical", seed: "seed-1", turns: 4 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.labId, "my-lab");
});

test("validateCreateLabRequestBody: 不正なmode・turns・scenarioId・非オブジェクトはいずれも拒否する", () => {
  assert.equal(validateCreateLabRequestBody(null).ok, false);
  assert.equal(validateCreateLabRequestBody("not-an-object").ok, false);
  assert.equal(validateCreateLabRequestBody({ scenarioId: "", mode: "canonical", seed: "s", turns: 1 }).ok, false);
  assert.equal(validateCreateLabRequestBody({ scenarioId: "baseline", mode: "invalid-mode", seed: "s", turns: 1 }).ok, false);
  assert.equal(validateCreateLabRequestBody({ scenarioId: "baseline", mode: "canonical", seed: "", turns: 1 }).ok, false);
  assert.equal(validateCreateLabRequestBody({ scenarioId: "baseline", mode: "canonical", seed: "s", turns: 0 }).ok, false);
  assert.equal(validateCreateLabRequestBody({ scenarioId: "baseline", mode: "canonical", seed: "s", turns: 1.5 }).ok, false);
  assert.equal(validateCreateLabRequestBody({ scenarioId: "baseline", mode: "canonical", seed: "s", turns: "4" }).ok, false);
});

test("validateSaveDraftRequestBody: draftフィールドが必須", () => {
  assert.equal(validateSaveDraftRequestBody({}).ok, false);
  assert.equal(validateSaveDraftRequestBody(null).ok, false);
  const result = validateSaveDraftRequestBody({ draft: { note: "x" } });
  assert.equal(result.ok, true);
});

test("validateSaveDraftRequestBody: turnIdを指定した場合は文字列であることを要求する", () => {
  assert.equal(validateSaveDraftRequestBody({ draft: {}, turnId: "" }).ok, false);
  assert.equal(validateSaveDraftRequestBody({ draft: {}, turnId: 123 }).ok, false);
  const result = validateSaveDraftRequestBody({ draft: {}, turnId: "turn-1" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.turnId, "turn-1");
});

test("validateSaveDraftRequestBody: 過大なdraftは拒否する", () => {
  const huge = { data: "x".repeat(2 * 1024 * 1024) };
  const result = validateSaveDraftRequestBody({ draft: huge });
  assert.equal(result.ok, false);
});

test("validateProcessQuarterRequestBody: 空・未定義ボディはturnIdなしとして受理する", () => {
  assert.deepEqual(validateProcessQuarterRequestBody(undefined), { ok: true, value: {} });
  assert.deepEqual(validateProcessQuarterRequestBody(null), { ok: true, value: {} });
  assert.deepEqual(validateProcessQuarterRequestBody({}), { ok: true, value: {} });
});

test("validateProcessQuarterRequestBody: turnIdを指定した場合は文字列を要求する", () => {
  assert.equal(validateProcessQuarterRequestBody({ turnId: "" }).ok, false);
  assert.equal(validateProcessQuarterRequestBody({ turnId: 1 }).ok, false);
  const result = validateProcessQuarterRequestBody({ turnId: "turn-2" });
  assert.equal(result.ok, true);
});

test("validateHistoryQuery: 未指定時はdefault limitを使い、afterTurnはundefined", () => {
  const result = validateHistoryQuery(new URLSearchParams());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.afterTurn, undefined);
    assert.ok(result.value.limit >= 1);
  }
});

test("validateHistoryQuery: afterTurn・limitを指定した場合はその値を使う", () => {
  const result = validateHistoryQuery(new URLSearchParams("afterTurn=3&limit=5"));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.afterTurn, 3);
    assert.equal(result.value.limit, 5);
  }
});

test("validateHistoryQuery: limitがMAX_HISTORY_LIMITを超える場合は拒否する", () => {
  const result = validateHistoryQuery(new URLSearchParams(`limit=${MAX_HISTORY_LIMIT + 1}`));
  assert.equal(result.ok, false);
});

test("validateHistoryQuery: 不正なafterTurn・limitは拒否する", () => {
  assert.equal(validateHistoryQuery(new URLSearchParams("afterTurn=-1")).ok, false);
  assert.equal(validateHistoryQuery(new URLSearchParams("afterTurn=abc")).ok, false);
  assert.equal(validateHistoryQuery(new URLSearchParams("limit=0")).ok, false);
  assert.equal(validateHistoryQuery(new URLSearchParams("limit=abc")).ok, false);
});

test("validateTurnParam: 正の整数文字列のみ受理する", () => {
  assert.equal(validateTurnParam("1").ok, true);
  assert.equal(validateTurnParam("0").ok, false);
  assert.equal(validateTurnParam("-1").ok, false);
  assert.equal(validateTurnParam("abc").ok, false);
  assert.equal(validateTurnParam("1.5").ok, false);
});
