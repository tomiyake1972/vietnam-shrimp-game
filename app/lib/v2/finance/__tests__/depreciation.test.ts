// ShrimpX V2 — 財務モジュール 既存固定資産の減価償却 単体テスト（Phase 8B-2C）
//
// finance/depreciation.tsのcomputeExistingAssetDepreciationUsdを、quarterClose.ts
// を経由せず直接検証する。実装指示§11の必須テスト項目のうち「既存資産」区分を
// ここでまとめて行う（新規capex資産の分はcapex/__tests__/depreciation.test.ts、
// 三表統合レベルの検証はquarterClose.test.ts・capexClose.test.tsが別途担う）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPeriod, period, INITIAL_PERIOD_V2 } from "../../core/period";
import { FINANCE_PARAMETERS_V1 } from "../parameters";
import { computeExistingAssetDepreciationUsd } from "../depreciation";

const EPS = 1e-6;

test("EX-1: ゲーム開始時点帳簿価額を建物35%・機械65%へ分ける", () => {
  const openingGross = 40_000_000;
  const result = computeExistingAssetDepreciationUsd(openingGross, INITIAL_PERIOD_V2, INITIAL_PERIOD_V2, FINANCE_PARAMETERS_V1);
  // ゲーム開始四半期そのもの（1四半期目）の値から、配分基準額を逆算して確認する。
  const buildingOpening = openingGross * FINANCE_PARAMETERS_V1.finance.existingAssetDepreciation.buildingOpeningRatio;
  const machineryOpening = openingGross * FINANCE_PARAMETERS_V1.finance.existingAssetDepreciation.machineryOpeningRatio;
  assert.ok(Math.abs(buildingOpening - 14_000_000) < EPS);
  assert.ok(Math.abs(machineryOpening - 26_000_000) < EPS);
  assert.ok(Math.abs(result.buildingUsd - buildingOpening / 80) < EPS);
  assert.ok(Math.abs(result.machineryUsd - machineryOpening / 32) < EPS);
});

test("EX-2: 建物は80四半期（20年）にわたり定額で償却され、その後は0", () => {
  const openingGross = 40_000_000;
  const buildingOpening = openingGross * 0.35;
  const expectedPerQuarter = buildingOpening / 80;

  // ゲーム開始からちょうど80四半期目（elapsedQuarters=80）はまだ発生する。
  const at80 = computeExistingAssetDepreciationUsd(openingGross, INITIAL_PERIOD_V2, period(2034, 4), FINANCE_PARAMETERS_V1);
  assert.ok(Math.abs(at80.buildingUsd - expectedPerQuarter) < EPS, "80四半期目はまだ建物分が発生するはず");

  // 81四半期目（2035Q1）は0。
  const at81 = computeExistingAssetDepreciationUsd(openingGross, INITIAL_PERIOD_V2, period(2035, 1), FINANCE_PARAMETERS_V1);
  assert.equal(at81.buildingUsd, 0, "80四半期超過後は建物分が0のはず");
});

test("EX-3: 機械は32四半期（8年）にわたり定額で償却され、その後は0", () => {
  const openingGross = 40_000_000;
  const machineryOpening = openingGross * 0.65;
  const expectedPerQuarter = machineryOpening / 32;

  // ゲーム開始からちょうど32四半期目（2022Q4、elapsedQuarters=32）はまだ発生する。
  const at32 = computeExistingAssetDepreciationUsd(openingGross, INITIAL_PERIOD_V2, period(2022, 4), FINANCE_PARAMETERS_V1);
  assert.ok(Math.abs(at32.machineryUsd - expectedPerQuarter) < EPS, "32四半期目はまだ機械分が発生するはず");

  // 33四半期目（2023Q1）は0。
  const at33 = computeExistingAssetDepreciationUsd(openingGross, INITIAL_PERIOD_V2, period(2023, 1), FINANCE_PARAMETERS_V1);
  assert.equal(at33.machineryUsd, 0, "32四半期超過後は機械分が0のはず");
});

test("EX-4: 32四半期経過後（機械の耐用年数終了後）は建物分だけが残る（実装指示の必須検証項目）", () => {
  const openingGross = 40_000_000;
  const buildingOpening = openingGross * 0.35;
  const expectedBuildingPerQuarter = buildingOpening / 80;

  const at33 = computeExistingAssetDepreciationUsd(openingGross, INITIAL_PERIOD_V2, period(2023, 1), FINANCE_PARAMETERS_V1);
  assert.equal(at33.machineryUsd, 0);
  assert.ok(Math.abs(at33.buildingUsd - expectedBuildingPerQuarter) < EPS, "機械の償却終了後も建物分は継続するはず");
  assert.ok(Math.abs(at33.totalUsd - expectedBuildingPerQuarter) < EPS);
});

test("EX-5: 80四半期経過後（建物の耐用年数も終了後）は合計が0になる", () => {
  const openingGross = 40_000_000;
  const at81 = computeExistingAssetDepreciationUsd(openingGross, INITIAL_PERIOD_V2, period(2035, 1), FINANCE_PARAMETERS_V1);
  assert.equal(at81.buildingUsd, 0);
  assert.equal(at81.machineryUsd, 0);
  assert.equal(at81.totalUsd, 0);
});

test("EX-6: 各コンポーネントの累計減価償却は、配分額（帳簿価額×ratio）を厳密に超えない", () => {
  const openingGross = 40_000_000;
  const buildingOpening = openingGross * 0.35;
  const machineryOpening = openingGross * 0.65;

  let buildingTotal = 0;
  let machineryTotal = 0;
  // 建物の耐用年数（80四半期）ぶんを直接列挙して集計する（機械はそのうち最初の32四半期のみ発生）。
  let p = INITIAL_PERIOD_V2;
  for (let i = 0; i < 80; i++) {
    const r = computeExistingAssetDepreciationUsd(openingGross, INITIAL_PERIOD_V2, p, FINANCE_PARAMETERS_V1);
    buildingTotal += r.buildingUsd;
    machineryTotal += r.machineryUsd;
    p = nextPeriod(p);
  }
  assert.ok(Math.abs(buildingTotal - buildingOpening) < EPS, `建物累計 ${buildingTotal} が配分額 ${buildingOpening} と一致しない`);
  assert.ok(Math.abs(machineryTotal - machineryOpening) < EPS, `機械累計 ${machineryTotal} が配分額 ${machineryOpening} と一致しない`);
  assert.ok(buildingTotal <= buildingOpening + EPS);
  assert.ok(machineryTotal <= machineryOpening + EPS);
});

test("EX-7（回帰防止）: 従来の一律2.5%/四半期という定率計算は残っていない（FinanceParameters.finance.depreciationRatePerQuarterは廃止済み）", () => {
  assert.equal("depreciationRatePerQuarter" in FINANCE_PARAMETERS_V1.finance, false);
  assert.ok("existingAssetDepreciation" in FINANCE_PARAMETERS_V1.finance);
});

test("EX-8: buildingOpeningRatio + machineryOpeningRatio が厳密に1（浮動小数点誤差を許容）", () => {
  const cfg = FINANCE_PARAMETERS_V1.finance.existingAssetDepreciation;
  assert.ok(Math.abs(cfg.buildingOpeningRatio + cfg.machineryOpeningRatio - 1) < 1e-9);
});
