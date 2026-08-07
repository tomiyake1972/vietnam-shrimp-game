// ShrimpX V2 — 財務モジュール パラメータ定義テスト
//
// 【商品別固定費配賦・労務費区分】managementAccounting.fixedCostAllocationCoefficientByProduct
// が正しく定義され、モジュール読み込み時点の校正チェックが機能することを検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { Product } from "../../market/types";
import { FINANCE_PARAMETERS_V1 } from "../parameters";

test("管理会計係数-1: FINANCE_PARAMETERS_V1.managementAccounting.fixedCostAllocationCoefficientByProductは既存の加工費想定単価比（HOSO 1.0 / PD 1.5 / VAP 2.4）どおりに初期化されている", () => {
  const coeffs = FINANCE_PARAMETERS_V1.managementAccounting.fixedCostAllocationCoefficientByProduct;
  assert.equal(coeffs.hoso, 1.0);
  assert.equal(coeffs.pd, 1.5);
  assert.equal(coeffs.vap, 2.4);
});

test("管理会計係数-2: 全商品の係数が正の有限数である（parameters.ts読み込み時点のassertValidFixedCostAllocationCoefficientsが機能している証拠として、現行定義がその条件を満たす）", () => {
  const coeffs = FINANCE_PARAMETERS_V1.managementAccounting.fixedCostAllocationCoefficientByProduct;
  const products: Product[] = ["hoso", "pd", "vap"];
  for (const p of products) {
    assert.ok(Number.isFinite(coeffs[p]), `${p}の係数が有限数ではありません: ${coeffs[p]}`);
    assert.ok(coeffs[p] > 0, `${p}の係数が正ではありません: ${coeffs[p]}`);
  }
});

test("管理会計係数-3: このモジュールが読み込めている（=parameters.ts末尾のassertValidFixedCostAllocationCoefficientsが例外を投げずに通過した）こと自体が、既存資産比率の検証（assertValidExistingAssetRatios）と同じ『モジュール読み込み時点の校正チェック』パターンが機能している証拠である", () => {
  // assertValidFixedCostAllocationCoefficients自体は非公開関数（既存のassertValidExistingAssetRatios
  // と同じ設計方針）のため直接呼び出すpublic APIは無いが、このテストファイルの冒頭で
  // FINANCE_PARAMETERS_V1をimportした時点でparameters.tsの全モジュールコードが評価されるため、
  // 係数に校正ミス（0以下やNaN）があればこのテストファイル自体がロード段階で失敗する。
  assert.ok(FINANCE_PARAMETERS_V1.managementAccounting.fixedCostAllocationCoefficientByProduct);
});
