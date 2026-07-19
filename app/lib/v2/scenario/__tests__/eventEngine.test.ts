import { test } from "node:test";
import assert from "node:assert/strict";
import { createRandomStream } from "../../core/random";
import {
  calculateEventIntensity,
  eventIntensityAtTurn,
  resolveScenarioEvents,
  composeEventEffects,
  applyComposedEffect,
  activeEventIdsAtTurn,
} from "../eventEngine";
import { testEvent } from "./fixtures";

// --- 発現強度カーブ ---

test("イベント強度: 開始前は0", () => {
  assert.equal(calculateEventIntensity(2, 3, 2, -1), 0);
});

test("イベント強度: ramp-up中は線形に立ち上がる", () => {
  assert.equal(calculateEventIntensity(4, 3, 2, 0), 0);
  assert.equal(calculateEventIntensity(4, 3, 2, 2), 0.5);
  assert.equal(calculateEventIntensity(4, 3, 2, 4), 1);
});

test("イベント強度: 継続期間中は満額(1)を維持する", () => {
  assert.equal(calculateEventIntensity(2, 5, 2, 2), 1);
  assert.equal(calculateEventIntensity(2, 5, 2, 6), 1);
});

test("イベント強度: 回復期間中は線形に0へ回復する", () => {
  assert.equal(calculateEventIntensity(0, 2, 4, 2), 1);
  assert.equal(calculateEventIntensity(0, 2, 4, 4), 0.5);
  assert.equal(calculateEventIntensity(0, 2, 4, 6), 0);
});

test("イベント強度: 完全終了後は0", () => {
  assert.equal(calculateEventIntensity(1, 2, 1, 100), 0);
});

test("eventIntensityAtTurn: resolvedStartTurnを基準にrelativeTurnを計算する", () => {
  const resolved = {
    source: testEvent(),
    resolvedStartTurn: 10,
    resolvedDurationTurns: 3,
    resolvedRampUpTurns: 1,
    resolvedRecoveryTurns: 2,
    resolvedMagnitudeScale: 1,
  };
  assert.equal(eventIntensityAtTurn(resolved, 9), 0);
  assert.equal(eventIntensityAtTurn(resolved, 11), 1);
  assert.equal(eventIntensityAtTurn(resolved, 20), 0);
});

// --- Canonical / Variation 解決 ---

test("canonicalモード: イベントは定義どおりに解決され、randomStreamを一切消費しない", () => {
  const events = [testEvent({ variationRange: { startTurnJitter: 3, magnitudeJitterRatio: 0.3 } })];
  const stream = createRandomStream("seed-x");
  const resolved = resolveScenarioEvents(events, "canonical", stream);
  assert.equal(resolved[0].resolvedStartTurn, events[0].startTurn);
  assert.equal(resolved[0].resolvedMagnitudeScale, 1);
  assert.equal(stream.getDrawCount(), 0);
});

test("variationRangeを持たないイベントは、variationモードでもrandomStreamを消費しない", () => {
  const events = [testEvent()]; // variationRangeなし
  const stream = createRandomStream("seed-x");
  const resolved = resolveScenarioEvents(events, "variation", stream);
  assert.equal(resolved[0].resolvedStartTurn, events[0].startTurn);
  assert.equal(stream.getDrawCount(), 0);
});

test("variationモード: 同じシードなら常に同じ解決結果になる（再現性）", () => {
  const events = [
    testEvent({
      variationRange: { startTurnJitter: 3, magnitudeJitterRatio: 0.3, durationJitterTurns: 1, recoveryJitterTurns: 1 },
    }),
  ];
  const resolvedA = resolveScenarioEvents(events, "variation", createRandomStream("seed-fixed"));
  const resolvedB = resolveScenarioEvents(events, "variation", createRandomStream("seed-fixed"));
  assert.deepEqual(resolvedA, resolvedB);
});

test("variationモード: 異なるシードでは許容範囲内で結果が変わりうる", () => {
  const events = [
    testEvent({
      startTurn: 10,
      variationRange: { startTurnJitter: 3, magnitudeJitterRatio: 0.3, durationJitterTurns: 1, recoveryJitterTurns: 1 },
    }),
  ];
  const seeds = ["seed-1", "seed-2", "seed-3", "seed-4", "seed-5"];
  const results = seeds.map((s) => resolveScenarioEvents(events, "variation", createRandomStream(s))[0]);

  const anyDiffers = results.some(
    (r) =>
      r.resolvedStartTurn !== results[0].resolvedStartTurn ||
      r.resolvedMagnitudeScale !== results[0].resolvedMagnitudeScale
  );
  assert.ok(anyDiffers, "複数シードのうち少なくとも1つは基準と異なる結果になるはず");

  for (const r of results) {
    assert.ok(Math.abs(r.resolvedStartTurn - 10) <= 3);
    assert.ok(r.resolvedMagnitudeScale >= 0.1 && r.resolvedMagnitudeScale <= 3.0);
  }
});

// --- 効果の合成 ---

test("multiplicative効果: 複数イベントが重複すると倍率を掛け合わせる（単純合算にはしない）", () => {
  const eventA = {
    source: testEvent({
      eventId: "a",
      targetCountries: ["VN"],
      effects: [{ variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: 0.9 }],
    }),
    resolvedStartTurn: 1,
    resolvedDurationTurns: 10,
    resolvedRampUpTurns: 0,
    resolvedRecoveryTurns: 0,
    resolvedMagnitudeScale: 1,
  } as const;
  const eventB = {
    source: testEvent({
      eventId: "b",
      targetCountries: ["VN"],
      effects: [{ variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: 0.9 }],
    }),
    resolvedStartTurn: 1,
    resolvedDurationTurns: 10,
    resolvedRampUpTurns: 0,
    resolvedRecoveryTurns: 0,
    resolvedMagnitudeScale: 1,
  } as const;

  const composed = composeEventEffects([eventA, eventB], 5);
  const effect = composed.get("AQUACULTURE_COST:VN");
  assert.ok(effect);
  // 0.9 * 0.9 = 0.81（単純合算なら 1 + (-0.1) + (-0.1) = 0.8 になるはずだが、そうならない）
  assert.ok(Math.abs(effect!.multiplicativeFactor - 0.81) < 1e-9);
  assert.notEqual(effect!.multiplicativeFactor, 0.8);
});

test("additivePoint効果: 複数イベントが重複するとポイント差分を合算する", () => {
  const mk = (id: string, magnitude: number) => ({
    source: testEvent({
      eventId: id,
      targetCountries: ["VN"],
      effects: [{ variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude }],
    }),
    resolvedStartTurn: 1,
    resolvedDurationTurns: 10,
    resolvedRampUpTurns: 0,
    resolvedRecoveryTurns: 0,
    resolvedMagnitudeScale: 1,
  });
  const composed = composeEventEffects([mk("a", -0.18), mk("b", -0.05)], 5);
  const effect = composed.get("SURVIVAL_RATE:VN");
  assert.ok(effect);
  assert.ok(Math.abs(effect!.additivePointDelta - -0.23) < 1e-9);
});

test("applyComposedEffect: 最終値は変数の定義域へclampされる", () => {
  const composed = new Map([
    [
      "SURVIVAL_RATE:VN",
      {
        variable: "SURVIVAL_RATE" as const,
        targetId: "VN" as const,
        multiplicativeFactor: 1,
        additivePointDelta: -0.9,
        contributingEventIds: ["a"],
      },
    ],
  ]);
  const result = applyComposedEffect(0.5, "SURVIVAL_RATE", composed.get("SURVIVAL_RATE:VN"));
  assert.equal(result, 0); // 0.5 - 0.9 = -0.4 -> clamp to 0（Ratio下限）
});

test("強度0（未発生・完全終了）のイベントは合成に寄与しない", () => {
  const future = {
    source: testEvent({ startTurn: 100, targetCountries: ["VN"] }),
    resolvedStartTurn: 100,
    resolvedDurationTurns: 3,
    resolvedRampUpTurns: 0,
    resolvedRecoveryTurns: 0,
    resolvedMagnitudeScale: 1,
  };
  const composed = composeEventEffects([future], 1);
  assert.equal(composed.size, 0);
});

test("activeEventIdsAtTurn: 強度が0超のイベントIDのみを返す", () => {
  const active = {
    source: testEvent({ eventId: "active-1", startTurn: 1 }),
    resolvedStartTurn: 1,
    resolvedDurationTurns: 5,
    resolvedRampUpTurns: 0,
    resolvedRecoveryTurns: 0,
    resolvedMagnitudeScale: 1,
  };
  const inactive = {
    source: testEvent({ eventId: "inactive-1", startTurn: 50 }),
    resolvedStartTurn: 50,
    resolvedDurationTurns: 5,
    resolvedRampUpTurns: 0,
    resolvedRecoveryTurns: 0,
    resolvedMagnitudeScale: 1,
  };
  const ids = activeEventIdsAtTurn([active, inactive], 3);
  assert.deepEqual(ids, ["active-1"]);
});
