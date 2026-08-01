// ShrimpX V2 — VAP商品開発投資の蓄積状態（productDevelopmentState.ts）の単体テスト
//
// 検証項目:
//  1. 標準投資額を継続投入すると蓄積すること
//  2. 投資を止めると中立値へ減衰すること
//  3. 上限100を超えないこと

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCT_DEVELOPMENT_PARAMETERS_V1,
  ProductDevelopmentState,
  emptyProductDevelopmentState,
  lookupProductDevelopmentScore,
  updateProductDevelopmentState,
} from "../productDevelopmentState";

const COMPANIES = ["A", "B"];
const STANDARD_BUDGET = PRODUCT_DEVELOPMENT_PARAMETERS_V1.standardBudgetUsd;

function investmentMap(entries: readonly [string, number][]): Map<string, number> {
  return new Map(entries);
}

function advanceQuarters(quarterInvestments: readonly (ReadonlyMap<string, number>)[]): ProductDevelopmentState {
  let state: ProductDevelopmentState | undefined = emptyProductDevelopmentState();
  for (const investment of quarterInvestments) {
    state = updateProductDevelopmentState(state, COMPANIES, investment, STANDARD_BUDGET, PRODUCT_DEVELOPMENT_PARAMETERS_V1);
  }
  return state!;
}

test("標準投資額を継続投入すると蓄積すること", () => {
  const after4Quarters = advanceQuarters([
    investmentMap([["A", STANDARD_BUDGET]]),
    investmentMap([["A", STANDARD_BUDGET]]),
    investmentMap([["A", STANDARD_BUDGET]]),
    investmentMap([["A", STANDARD_BUDGET]]),
  ]);
  const scoreA = lookupProductDevelopmentScore(after4Quarters, "A");
  const scoreB = lookupProductDevelopmentScore(after4Quarters, "B");
  assert.ok(scoreA > PRODUCT_DEVELOPMENT_PARAMETERS_V1.neutralScore, `継続投資した会社のスコアは中立値を超えるはず（実際: ${scoreA}）`);
  assert.strictEqual(scoreB, PRODUCT_DEVELOPMENT_PARAMETERS_V1.neutralScore, "無投資の会社は中立値のまま");

  // より多くの四半期投資を続けるとさらに伸びる（単調増加）。
  const after8Quarters = advanceQuarters(
    Array.from({ length: 8 }, () => investmentMap([["A", STANDARD_BUDGET]]))
  );
  const scoreA8 = lookupProductDevelopmentScore(after8Quarters, "A");
  assert.ok(scoreA8 > scoreA, "投資四半期数が増えるほどスコアはさらに伸びる");
});

test("投資を止めると中立値へ減衰すること", () => {
  // まず4四半期投資して中立値を超えさせる。
  const afterInvestment = advanceQuarters([
    investmentMap([["A", STANDARD_BUDGET]]),
    investmentMap([["A", STANDARD_BUDGET]]),
    investmentMap([["A", STANDARD_BUDGET]]),
    investmentMap([["A", STANDARD_BUDGET]]),
  ]);
  const scoreAfterInvestment = lookupProductDevelopmentScore(afterInvestment, "A");
  assert.ok(scoreAfterInvestment > PRODUCT_DEVELOPMENT_PARAMETERS_V1.neutralScore);

  // その後、投資を止める（0を継続）。
  let state: ProductDevelopmentState | undefined = afterInvestment;
  const scores: number[] = [scoreAfterInvestment];
  for (let i = 0; i < 5; i++) {
    state = updateProductDevelopmentState(state, COMPANIES, investmentMap([]), STANDARD_BUDGET, PRODUCT_DEVELOPMENT_PARAMETERS_V1);
    scores.push(lookupProductDevelopmentScore(state, "A"));
  }

  // 単調に中立値へ近づく（毎四半期、直前より中立値との差が縮む）。
  for (let i = 1; i < scores.length; i++) {
    const prevGap = Math.abs(scores[i - 1] - PRODUCT_DEVELOPMENT_PARAMETERS_V1.neutralScore);
    const gap = Math.abs(scores[i] - PRODUCT_DEVELOPMENT_PARAMETERS_V1.neutralScore);
    assert.ok(gap < prevGap, `四半期${i}: 中立値への乖離は単調に縮小するはず（前: ${prevGap}, 今: ${gap}）`);
  }
  // 1四半期でゼロ（中立値ちょうど）にはならない。
  assert.ok(scores[1] > PRODUCT_DEVELOPMENT_PARAMETERS_V1.neutralScore, "放置1四半期で即座に中立値へ戻らない（緩やかな減衰）");
});

test("上限100を超えないこと", () => {
  // 20四半期、標準投資額の2倍（investmentRatioCap上限）を継続投入し続けても100を超えない。
  const quarters = Array.from({ length: 40 }, () => investmentMap([["A", STANDARD_BUDGET * 5]]));
  const finalState = advanceQuarters(quarters);
  const score = lookupProductDevelopmentScore(finalState, "A");
  assert.ok(score <= 100, `スコアは100を超えないはず（実際: ${score}）`);
  assert.ok(score >= 95, `十分な期間・投資であれば上限付近に到達するはず（実際: ${score}）`);
});

test("純粋関数であること（同じ入力なら同じ出力、入力を変更しない）", () => {
  const prev = advanceQuarters([investmentMap([["A", STANDARD_BUDGET]])]);
  const snapshotEntries = JSON.stringify(prev.entries);
  const investments = investmentMap([["A", STANDARD_BUDGET]]);
  const result1 = updateProductDevelopmentState(prev, COMPANIES, investments, STANDARD_BUDGET, PRODUCT_DEVELOPMENT_PARAMETERS_V1);
  const result2 = updateProductDevelopmentState(prev, COMPANIES, investments, STANDARD_BUDGET, PRODUCT_DEVELOPMENT_PARAMETERS_V1);
  assert.deepStrictEqual(result1, result2, "同じ入力からは同じ結果");
  assert.strictEqual(JSON.stringify(prev.entries), snapshotEntries, "入力状態は変更されない");
});
