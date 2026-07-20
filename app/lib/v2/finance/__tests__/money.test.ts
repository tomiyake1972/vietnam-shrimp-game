// ShrimpX V2 — 財務モジュール 金額換算テスト（Phase 8A）
//
// 対応する重要テスト項目（実装指示より）:
//   1. USD/kg×HOSO換算トンの金額換算が1,000倍を含め正しい
//   18. NaN、Infinity、不正残高を拒否する（金額型の生成レベル）

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, usdPerHosoEqKg } from "../../core/units";
import { KG_PER_HOSO_EQ_TON, amountFromPlainTonsAndUsdPerKg, amountFromTonsAndUnitPrice, sumUsd, usdToMillions } from "../money";
import { FinanceValidationError, nonNegativeUsd, usd } from "../types";

test("受入確認M-1: 数量（HOSO換算トン）×単価（USD/kg）の金額換算は×1,000（kg/ton）を含め正しい", () => {
  // 2トン × $3.00/kg = 2 × 1,000kg × $3.00 = $6,000（$6ではない・$6,000,000でもない）
  assert.equal(amountFromTonsAndUnitPrice(hosoEqTons(2), usdPerHosoEqKg(3)) as number, 6000);
  // 15,450トン × $4.90/kg = $75,705,000
  assert.equal(amountFromTonsAndUnitPrice(hosoEqTons(15450), usdPerHosoEqKg(4.9)) as number, 15450 * 1000 * 4.9);
  assert.equal(KG_PER_HOSO_EQ_TON, 1000);
});

test("受入確認M-2: プレーン数量版の換算も同一の×1,000を通る", () => {
  assert.equal(amountFromPlainTonsAndUsdPerKg(2, 3) as number, 6000);
  assert.equal(amountFromPlainTonsAndUsdPerKg(0.5, 4.2) as number, 0.5 * 1000 * 4.2);
});

test("受入確認M-3: usd()はNaN・Infinityを拒否し、負数は許容する（損益・現金）", () => {
  assert.throws(() => usd(NaN), FinanceValidationError);
  assert.throws(() => usd(Infinity), FinanceValidationError);
  assert.throws(() => usd(-Infinity), FinanceValidationError);
  assert.equal(usd(-123.45) as number, -123.45);
});

test("受入確認M-4: nonNegativeUsd()は負数を許容しない残高（在庫・売掛・買掛等）で負の値を拒否する", () => {
  assert.throws(() => nonNegativeUsd(-1, "テスト残高"), FinanceValidationError);
  assert.equal(nonNegativeUsd(0, "テスト残高") as number, 0);
  assert.equal(nonNegativeUsd(100, "テスト残高") as number, 100);
});

test("受入確認M-5: usdToMillionsは表示用のみの換算で丸めない（内部値保持）", () => {
  assert.equal(usdToMillions(usd(12_345_678)), 12.345678);
});

test("受入確認M-6: sumUsdは複数金額を正確に合計する", () => {
  assert.equal(sumUsd([usd(1.5), usd(-0.5), usd(2)]) as number, 3);
});
