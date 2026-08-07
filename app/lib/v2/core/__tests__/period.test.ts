import { test } from "node:test";
import assert from "node:assert/strict";
import { period, nextPeriod, previousPeriod, toYearQuarter, parsePeriod, isValidPeriodString, INITIAL_PERIOD_V2 } from "../period";

test("初期Periodは2015Q1", () => {
  assert.equal(INITIAL_PERIOD_V2, "2015Q1");
});

// テスト12: 四半期の通常の次期計算
test("Q1の次はQ2、Q2の次はQ3、Q3の次はQ4（同一年）", () => {
  assert.equal(nextPeriod(period(2020, 1)), period(2020, 2));
  assert.equal(nextPeriod(period(2020, 2)), period(2020, 3));
  assert.equal(nextPeriod(period(2020, 3)), period(2020, 4));
});

// テスト13: 年末→翌年Q1への遷移
test("Q4の次は翌年のQ1", () => {
  assert.equal(nextPeriod(period(2020, 4)), period(2021, 1));
});

test("previousPeriod: Q1の前は前年のQ4", () => {
  assert.equal(previousPeriod(period(2021, 1)), period(2020, 4));
});

test("toYearQuarterはyear/quarterへ正しく分解する", () => {
  assert.deepEqual(toYearQuarter(period(2022, 3)), { year: 2022, quarter: 3 });
});

test("不正なquarter（0や5）は拒否される", () => {
  assert.throws(() => period(2020, 0));
  assert.throws(() => period(2020, 5));
});

test("不正な形式の文字列パースは拒否される", () => {
  assert.equal(isValidPeriodString("2020Q5"), false);
  assert.equal(isValidPeriodString("not-a-period"), false);
  assert.throws(() => parsePeriod("2020Q5"));
});

test("正しい形式の文字列はparsePeriodで受け入れられる", () => {
  assert.equal(parsePeriod("2020Q1"), period(2020, 1));
});
