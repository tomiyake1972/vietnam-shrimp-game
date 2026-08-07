// ShrimpX V2 — Test15前 VAP商品開発投資プリフライト校正（Phase7）の回帰テスト。
// scripts/test15VapProductDevelopmentPreflightCalibration.tsの主要ロジックが
// 実エンジンを正しく通し、共有デフォルトパラメータへ一切書き込まないことを確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEEDS,
  SPEND_LEVELS_USD,
  runCase,
  runFullStudy,
  toCsv,
  findFirstQuarterOutperformingBaseline,
} from "../../../../../scripts/test15VapProductDevelopmentPreflightCalibration";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import { CAPEX_PARAMETERS_V1 } from "../../capex/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import { PRODUCT_DEVELOPMENT_PARAMETERS_V1 } from "../../companyLab/productDevelopmentState";
import { VAP_CAPABILITY_WEIGHTS_V1 } from "../../companyLab/premiumPolicy";

test("VDC-1（spend=0ケース）: VAP商品開発スコアは中立値50から動かない（減衰式のとおり、投資しなければ中立へ留まる）", () => {
  const rows = runCase({ seed: SEEDS[0], spendLevelUsd: 0, horizonQuarters: 8 });
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(Math.abs(r.vapDevScore - PRODUCT_DEVELOPMENT_PARAMETERS_V1.neutralScore) < 1e-9, `spend=0なのにスコアが中立値から動いている（${r.vapDevScore}）`);
    assert.equal(r.vapProductDevelopmentSpendUsd, 0);
    assert.equal(r.cumulativeSpendUsd, 0);
  }
});

test("VDC-2（spend>0ケース）: スコアは四半期を追うごとに単調増加し、増分（ヘッドルーム効果）は徐々に縮小する", () => {
  const rows = runCase({ seed: SEEDS[0], spendLevelUsd: 500_000, horizonQuarters: 12 });
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].vapDevScore >= rows[i - 1].vapDevScore - 1e-9, `turn${i + 1}: スコアが前四半期より下がっている（単調増加のはず）`);
  }
  // ヘッドルーム式（score += gainCoefficient×investmentRatio×(1-score/100)）により、
  // スコアが中立50から上昇するほど、同じspendでの増分は縮小するはず。
  const increases = rows.map((r) => r.vapDevScoreIncrease).filter((v) => v > 0);
  assert.ok(increases.length >= 3, "増分を比較するのに十分な四半期数がない");
  assert.ok(increases[0] > increases[increases.length - 1], `ヘッドルーム効果により増分が縮小するはずが、初回増分(${increases[0]})が最終増分(${increases[increases.length - 1]})以下になっている`);
});

test("VDC-3（累計spend）: cumulativeSpendUsdは各四半期のspendLevelUsdの単純累積と一致する", () => {
  const rows = runCase({ seed: SEEDS[0], spendLevelUsd: 250_000, horizonQuarters: 6 });
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].cumulativeSpendUsd, 250_000 * (i + 1));
  }
});

test("VDC-4（VAP能力合成係数の重み反映）: spend=500,000ケースのvapCapabilityScoreは、spend=0ケースより最終四半期で高い（productDevelopmentの寄与が実際に反映されている）", () => {
  const rowsHigh = runCase({ seed: SEEDS[0], spendLevelUsd: 500_000, horizonQuarters: 8 });
  const rowsZero = runCase({ seed: SEEDS[0], spendLevelUsd: 0, horizonQuarters: 8 });
  const finalHigh = rowsHigh[rowsHigh.length - 1];
  const finalZero = rowsZero[rowsZero.length - 1];
  assert.ok(finalHigh.vapCapabilityScore > finalZero.vapCapabilityScore, "VAP開発投資してもvapCapabilityScoreが上がっていない（重み付け合成が機能していない可能性）");
});

test("VDC-5（共有デフォルトパラメータの不変性）: 診断用シナリオ構築（4段階のVAP商品開発費入力）を経ても、PRODUCTION_PARAMETERS_V1・CAPEX_PARAMETERS_V1・FINANCE_PARAMETERS_V1・PRODUCT_DEVELOPMENT_PARAMETERS_V1・VAP_CAPABILITY_WEIGHTS_V1は一切変更されない", () => {
  const productionSnapshot = JSON.stringify(PRODUCTION_PARAMETERS_V1);
  const capexSnapshot = JSON.stringify(CAPEX_PARAMETERS_V1);
  const financeSnapshot = JSON.stringify(FINANCE_PARAMETERS_V1);
  const productDevelopmentSnapshot = JSON.stringify(PRODUCT_DEVELOPMENT_PARAMETERS_V1);
  const vapWeightsSnapshot = JSON.stringify(VAP_CAPABILITY_WEIGHTS_V1);

  runCase({ seed: SEEDS[0], spendLevelUsd: 500_000, horizonQuarters: 6 });

  assert.equal(JSON.stringify(PRODUCTION_PARAMETERS_V1), productionSnapshot, "PRODUCTION_PARAMETERS_V1が診断スクリプト実行後に変化した");
  assert.equal(JSON.stringify(CAPEX_PARAMETERS_V1), capexSnapshot, "CAPEX_PARAMETERS_V1が診断スクリプト実行後に変化した");
  assert.equal(JSON.stringify(FINANCE_PARAMETERS_V1), financeSnapshot, "FINANCE_PARAMETERS_V1が診断スクリプト実行後に変化した");
  assert.equal(JSON.stringify(PRODUCT_DEVELOPMENT_PARAMETERS_V1), productDevelopmentSnapshot, "PRODUCT_DEVELOPMENT_PARAMETERS_V1が診断スクリプト実行後に変化した");
  assert.equal(JSON.stringify(VAP_CAPABILITY_WEIGHTS_V1), vapWeightsSnapshot, "VAP_CAPABILITY_WEIGHTS_V1が診断スクリプト実行後に変化した");
});

test("VDC-6（CSV出力）: toCsvはヘッダー1行＋各行1レコードを出力する", () => {
  const rows = runCase({ seed: SEEDS[0], spendLevelUsd: 0, horizonQuarters: 4 });
  const csv = toCsv(rows);
  const lines = csv.split("\n");
  assert.equal(lines.length, rows.length + 1);
  assert.ok(lines[0].startsWith("seed,spendLevelUsd,companyId"));
});

test("VDC-7（findFirstQuarterOutperformingBaseline）: 常に同一の成約量系列であればnullを返す（ダミー入力での境界確認）", () => {
  const rows = runCase({ seed: SEEDS[0], spendLevelUsd: 500_000, horizonQuarters: 6 });
  const baseline = runCase({ seed: SEEDS[0], spendLevelUsd: 0, horizonQuarters: 6 });
  // 実測（4節参照）ではVAP成約量はspendに関わらず不変であるため、baselineを上回る
  // 四半期は存在しないはず（この境界事実そのものを回帰確認する）。
  const result = findFirstQuarterOutperformingBaseline(rows, baseline);
  assert.equal(result, null, "実測上は成約量がspendに反応しないはずが、baselineを上回る四半期が検出された（挙動が変化した可能性）");
});

test("VDC-8（runFullStudy統合実行）: 3seed×4段階ぶんの結果が揃う", { timeout: 120_000 }, () => {
  const results = runFullStudy();
  assert.equal(results.length, SEEDS.length);
  for (const r of results) {
    assert.equal(r.rowsByLevel.size, SPEND_LEVELS_USD.length);
    for (const level of SPEND_LEVELS_USD) {
      const rows = r.rowsByLevel.get(level);
      assert.ok(rows && rows.length > 0, `${r.seed}/spend=${level}: 結果が空`);
    }
  }
});
