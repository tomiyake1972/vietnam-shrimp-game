import { test } from "node:test";
import assert from "node:assert/strict";
import { interpolateTrendValue, assertSortedKeyframes } from "../interpolation";
import { testTrend } from "./fixtures";

test("linear補間: 2キーフレーム間の中間turnで線形補間される", () => {
  const trend = testTrend({
    interpolation: "linear",
    keyframes: [
      { turn: 1, value: 100 },
      { turn: 11, value: 200 },
    ],
  });
  assert.equal(interpolateTrendValue(trend, 6), 150);
  assert.equal(interpolateTrendValue(trend, 1), 100);
  assert.equal(interpolateTrendValue(trend, 11), 200);
});

test("step補間: キーフレーム間は直前の値を維持し、段差ではなく瞬間だけ切り替わる", () => {
  const trend = testTrend({
    interpolation: "step",
    keyframes: [
      { turn: 1, value: 100 },
      { turn: 10, value: 200 },
      { turn: 20, value: 300 },
    ],
  });
  assert.equal(interpolateTrendValue(trend, 5), 100);
  assert.equal(interpolateTrendValue(trend, 9), 100);
  assert.equal(interpolateTrendValue(trend, 10), 200);
  assert.equal(interpolateTrendValue(trend, 15), 200);
});

test("範囲外turnは最初／最後のキーフレーム値を保持する（外挿しない）", () => {
  const trend = testTrend({
    keyframes: [
      { turn: 5, value: 100 },
      { turn: 15, value: 200 },
    ],
  });
  assert.equal(interpolateTrendValue(trend, 1), 100);
  assert.equal(interpolateTrendValue(trend, 999), 200);
});

test("assertSortedKeyframes: キーフレームが2点未満なら例外", () => {
  assert.throws(() => assertSortedKeyframes([{ turn: 1, value: 1 }], "label"));
});

test("assertSortedKeyframes: turnが昇順でない（重複含む）場合は例外", () => {
  assert.throws(() =>
    assertSortedKeyframes(
      [
        { turn: 1, value: 1 },
        { turn: 1, value: 2 },
      ],
      "label"
    )
  );
  assert.throws(() =>
    assertSortedKeyframes(
      [
        { turn: 10, value: 1 },
        { turn: 5, value: 2 },
      ],
      "label"
    )
  );
});
