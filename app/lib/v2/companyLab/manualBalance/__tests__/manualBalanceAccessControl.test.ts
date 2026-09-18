// ShrimpX V2 — MANUAL-BALANCE-1 設定変更の権限テスト
//
// 【この機能が新しい認証面を作っていないこと】手動バランス調整の設定は、
// 新しいAPIルートを追加せずに、既存の Simulation Run 保存経路
// （POST /api/v2/simulation-runs → withSimulationRunApiContext）へ相乗りする。
// 設定は resumePayload.state.config.manualBalanceOverrides として運ばれるため、
// Run本体の保存と同じ認証ゲートを必ず通る。
//
// したがってここで確認するのは次の2点である。
//   (1) そのゲート（checkStagingAdminToken）が、トークン無し・誤トークンを拒否すること
//   (2) 設定が本当に resumePayload の中に入っていること
//       （別の非認証経路で保存されていないこと）

import test from "node:test";
import assert from "node:assert/strict";

import { checkStagingAdminToken } from "../../../../stagingAdmin";
import { createSimulationSession, applyManualBalanceScheduleToSession } from "../../simulation/engine";
import { buildResumePayload } from "../../simulation/persistence/resume";
import { withManualBalanceContinuingApplied } from "../overrides";

const ORIGINAL_TOKEN = process.env.STAGING_ADMIN_TOKEN;

test("MBA-1: 管理トークンが無い／誤っている場合は設定変更の認証が通らない", () => {
  process.env.STAGING_ADMIN_TOKEN = "correct-token-for-test";
  try {
    assert.equal(checkStagingAdminToken(undefined).ok, false, "トークン無しが通ってしまう");
    assert.equal(checkStagingAdminToken(null).ok, false, "null が通ってしまう");
    assert.equal(checkStagingAdminToken("").ok, false, "空文字が通ってしまう");
    assert.equal(checkStagingAdminToken("wrong-token").ok, false, "誤トークンが通ってしまう");
    assert.equal(checkStagingAdminToken(undefined).status, 403);

    // 正しいトークンのときだけ通る。
    assert.equal(checkStagingAdminToken("correct-token-for-test").ok, true, "正しいトークンが拒否された");
  } finally {
    if (ORIGINAL_TOKEN === undefined) delete process.env.STAGING_ADMIN_TOKEN;
    else process.env.STAGING_ADMIN_TOKEN = ORIGINAL_TOKEN;
  }
});

test("MBA-2: 手動バランス設定は resumePayload の中に入り、認証済みのRun保存経路を通る", () => {
  const session = applyManualBalanceScheduleToSession(
    createSimulationSession({
      simulationRunId: "mba-2",
      scenarioId: "baseline",
      seed: "mba-seed",
      requestedTurns: 4,
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
    withManualBalanceContinuingApplied(
      undefined,
      1,
      { dividendPayout: { kind: "unspecified" }, salesPriceIndex: 95, rawMarketPriceIndex: undefined },
      "2026-01-01T00:00:00.000Z"
    )
  );

  const payload = buildResumePayload(session, {}, {});
  // 設定が resumePayload.state.config に含まれる＝Run保存APIのゲートを通る。
  assert.ok(
    payload.state.config.manualBalanceOverrides !== undefined,
    "設定が resumePayload に含まれていない（別経路で保存されている疑い）"
  );
  assert.equal(payload.state.config.manualBalanceOverrides?.length, 1);
});
