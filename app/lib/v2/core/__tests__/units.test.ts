import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hosoEqTons,
  usdPerHosoEqKg,
  usdM,
  ratio,
  score0to100,
  unwrapUnit,
  roundUsdM,
} from "../units";

// テスト9: 正常な単位生成
test("正常値でHosoEqTons/UsdPerHosoEqKg/UsdM/Ratio/Score0to100を生成できる", () => {
  assert.equal(unwrapUnit(hosoEqTons(12.5)), 12.5);
  assert.equal(unwrapUnit(usdPerHosoEqKg(3.2)), 3.2);
  assert.equal(unwrapUnit(usdM(-5)), -5); // UsdMは損失/債務超過を許容し下限なし
  assert.equal(unwrapUnit(ratio(0.5)), 0.5);
  assert.equal(unwrapUnit(score0to100(80)), 80);
});

// テスト10: 負数量・NaN・Infinityの拒否
test("HosoEqTons: 負数量は拒否される", () => {
  assert.throws(() => hosoEqTons(-1));
});

test("HosoEqTons/UsdPerHosoEqKg: NaNは拒否される", () => {
  assert.throws(() => hosoEqTons(NaN));
  assert.throws(() => usdPerHosoEqKg(NaN));
});

test("HosoEqTons/UsdM/Ratio/Score0to100: Infinityは拒否される", () => {
  assert.throws(() => hosoEqTons(Infinity));
  assert.throws(() => usdM(Infinity));
  assert.throws(() => ratio(Infinity));
  assert.throws(() => score0to100(-Infinity));
});

test("UsdPerHosoEqKg: 負の価格は拒否される", () => {
  assert.throws(() => usdPerHosoEqKg(-0.01));
});

// テスト11: ratio>1, score>100 の範囲検証
test("Ratioが1を超える場合は拒否される", () => {
  assert.throws(() => ratio(1.01));
});

test("Ratioが0未満の場合は拒否される", () => {
  assert.throws(() => ratio(-0.01));
});

test("Score0to100が100を超える場合は拒否される", () => {
  assert.throws(() => score0to100(100.5));
});

test("Score0to100が0未満の場合は拒否される", () => {
  assert.throws(() => score0to100(-1));
});

test("境界値ちょうど（Ratio=1, Score=0/100）は許可される", () => {
  assert.doesNotThrow(() => ratio(1));
  assert.doesNotThrow(() => ratio(0));
  assert.doesNotThrow(() => score0to100(0));
  assert.doesNotThrow(() => score0to100(100));
});

test("roundUsdMは小数点2桁に丸める", () => {
  assert.equal(roundUsdM(2.345), 2.35);
  assert.equal(roundUsdM(-2.345), -2.35);
});
