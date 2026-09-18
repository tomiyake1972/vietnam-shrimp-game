// ShrimpX V2 — MANUAL-BALANCE-1 情報境界と持ち出し／取り込みのテスト
//
// 【情報境界】将来Turnへ予約した管理者設定が、それより前のTurnのStandard AIへ
// 漏れないこと。Standard AIは publicInfo.lastMarketResult（前Turnの確定結果）から
// 価格を観測するため、まだ適用されていないTurnの設定を先読みする経路は無いはずである。
// それを「設定ありRunと設定なしRunが、適用開始前のTurnまで完全一致する」ことで実測する。

import test from "node:test";
import assert from "node:assert/strict";

import { createSimulationSession, advanceSimulationTurns, applyManualBalanceScheduleToSession } from "../../simulation/engine";
import type { SimulationSession } from "../../simulation/types";
import { ManualBalanceSettings, withManualBalancePerTurnApplied } from "../overrides";
import {
  MANUAL_BALANCE_SPEC_VERSION,
  ManualBalancePortableIdentity,
  buildManualBalancePortableDocument,
  parseManualBalancePortableDocument,
} from "../portable";

const TS = "2026-01-01T00:00:00.000Z";

function settings(patch: Partial<ManualBalanceSettings> = {}): ManualBalanceSettings {
  return { dividendPayout: { kind: "unspecified" }, salesPriceIndex: undefined, rawMarketPriceIndex: undefined, ...patch };
}

function newSession(runId: string): SimulationSession {
  return createSimulationSession({
    simulationRunId: runId,
    scenarioId: "baseline",
    seed: "disclosure-seed",
    requestedTurns: 8,
    startedAt: TS,
  });
}

// ----------------------------------------------------------------- MBD-1
test("MBD-1: 将来Turnへ予約した設定は、適用開始前のTurnの結果へ一切影響しない（先読みが無い）", () => {
  // Turn6だけに大きな補正を予約する。
  const futureOnly = withManualBalancePerTurnApplied(
    undefined,
    6,
    settings({ salesPriceIndex: 50, rawMarketPriceIndex: 50 }),
    TS
  );

  const withFuture = advanceSimulationTurns({
    session: applyManualBalanceScheduleToSession(newSession("mbd-future"), futureOnly),
    turns: 5,
    timestamp: TS,
  });
  const withoutAny = advanceSimulationTurns({ session: newSession("mbd-none"), turns: 5, timestamp: TS });

  // Turn1〜5（適用開始前）の確定結果が完全に一致すること。
  // 一致しなければ、まだ開示されていない将来設定が当期の計算・AI判断へ漏れている。
  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      JSON.stringify(withFuture.state.history[index]),
      JSON.stringify(withoutAny.state.history[index]),
      `Turn${index + 1}の結果が将来設定の有無で変化している（先読みの疑い）`
    );
  }

  // 適用記録上も、Turn1〜5は手動補正なしとして残る。
  for (const record of withFuture.manualBalanceApplied ?? []) {
    assert.equal(record.appliedSourceKind, "none", `turn=${record.turn}`);
    assert.equal(record.manualSalesPriceIndex, 100, `turn=${record.turn}`);
    assert.equal(record.manualRawMarketPriceIndex, 100, `turn=${record.turn}`);
  }
});

// ----------------------------------------------------------------- MBD-2
test("MBD-2: 予約したTurnに到達すると設定が適用される", () => {
  const futureOnly = withManualBalancePerTurnApplied(undefined, 6, settings({ rawMarketPriceIndex: 50 }), TS);
  const session = advanceSimulationTurns({
    session: applyManualBalanceScheduleToSession(newSession("mbd-reach"), futureOnly),
    turns: 6,
    timestamp: TS,
  });
  const record = session.manualBalanceApplied?.[5];
  assert.ok(record !== undefined);
  assert.equal(record.turn, 6);
  assert.equal(record.manualRawMarketPriceIndex, 50);
  assert.ok(Math.abs(record.appliedRawMarketPrice - record.preManualRawMarketPrice * 0.5) < 1e-9);
});

// ----------------------------------------------------------------- MBD-3
const IDENTITY: ManualBalancePortableIdentity = {
  sourceCommit: "abc1234",
  specVersion: MANUAL_BALANCE_SPEC_VERSION,
  scenarioId: "baseline",
  seed: "seed-a",
  salesModelId: null,
};

test("MBD-3: 設定を書き出して取り込むと、同じスケジュールが復元される", () => {
  const schedule = withManualBalancePerTurnApplied(
    undefined,
    3,
    settings({ salesPriceIndex: 95, dividendPayout: { kind: "specified", payoutRatio: 0 } }),
    TS
  );
  const json = JSON.stringify(buildManualBalancePortableDocument({ schedule, identity: IDENTITY, exportedAt: TS }));

  const result = parseManualBalancePortableDocument(json, IDENTITY);
  assert.ok(result.ok, "書き出したものを取り込めない");
  assert.equal(result.identityDifferences.length, 0, "同一Runなのに差分が報告された");
  assert.equal(result.document.schedule.length, 1);
  const entry = result.document.schedule[0];
  assert.equal(entry.kind, "perTurn");
  if (entry.kind === "perTurn") {
    assert.equal(entry.settings.salesPriceIndex, 95);
    // 明示的0%がJSON往復後も明示的0%のまま（未設定へ化けない）。
    assert.deepEqual(entry.settings.dividendPayout, { kind: "specified", payoutRatio: 0 });
  }
});

// ----------------------------------------------------------------- MBD-4
test("MBD-4: 別条件のRunで作られた設定は、取り込めるが差分が必ず報告される", () => {
  const schedule = withManualBalancePerTurnApplied(undefined, 3, settings({ salesPriceIndex: 95 }), TS);
  const json = JSON.stringify(buildManualBalancePortableDocument({ schedule, identity: IDENTITY, exportedAt: TS }));

  const otherRun: ManualBalancePortableIdentity = { ...IDENTITY, seed: "seed-b", scenarioId: "dynamic-scenario-1" };
  const result = parseManualBalancePortableDocument(json, otherRun);
  assert.ok(result.ok);
  const fields = result.identityDifferences.map((d) => d.field).sort();
  assert.deepEqual(fields, ["scenarioId", "seed"], "Scenario・seedの差分が報告されていない");
});

// ----------------------------------------------------------------- MBD-5
test("MBD-5: 壊れた設定ファイルは部分的に取り込まず、全体を拒否する", () => {
  // 範囲外の指数（0.95＝単位間違い）を含むファイル。
  const broken = JSON.stringify({
    format: "shrimpx-v2-manual-balance",
    formatVersion: 1,
    exportedAt: TS,
    identity: IDENTITY,
    schedule: [
      { kind: "perTurn", turn: 2, settings: { dividendPayout: { kind: "unspecified" }, salesPriceIndex: 95 }, source: "MANUAL_OVERRIDE", recordedAt: TS },
      { kind: "perTurn", turn: 3, settings: { dividendPayout: { kind: "unspecified" }, salesPriceIndex: 0.95 }, source: "MANUAL_OVERRIDE", recordedAt: TS },
    ],
  });
  const result = parseManualBalancePortableDocument(broken, IDENTITY);
  assert.equal(result.ok, false, "範囲外の値を含むファイルが取り込まれてしまった");

  // formatが違うものも拒否する。
  assert.equal(parseManualBalancePortableDocument(JSON.stringify({ format: "other" }), IDENTITY).ok, false);
  assert.equal(parseManualBalancePortableDocument("not json", IDENTITY).ok, false);
});
