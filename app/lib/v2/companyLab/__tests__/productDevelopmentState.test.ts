// ShrimpX V2 — Test15新設: VAP商品開発費のスコア状態テスト
//
// 対応する要求事項:
//   - vapProductDevelopmentSpendUsdは$0/$100,000/$250,000/$500,000の4段階のみ
//   - score更新式（投資比率×gainCoefficient、投資比率cap、spend=0は必ず減衰）
//   - floor/cap
//   - タイミング（前四半期末までの値のみを読む）は呼び出し側の責務だが、
//     本モジュール自体が「前期スコア＋当期spend→次期スコア」の純関数であることを検証

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialProductDevelopmentState,
  isValidVapProductDevelopmentSpendTier,
  lookupProductDevelopmentScore,
  PRODUCT_DEVELOPMENT_PARAMETERS_V1,
  ProductDevelopmentState,
  updateProductDevelopmentState,
  VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD,
} from "../productDevelopmentState";

test("PDS-1: 許容される投資額は$0/$100,000/$250,000/$500,000の4段階のみ", () => {
  assert.deepEqual(VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD, [0, 100_000, 250_000, 500_000]);
  for (const tier of VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD) {
    assert.equal(isValidVapProductDevelopmentSpendTier(tier), true, `tier=${tier}`);
  }
  for (const invalid of [50_000, 150_000, 999, -100_000, 1_000_000]) {
    assert.equal(isValidVapProductDevelopmentSpendTier(invalid), false, `invalid=${invalid}`);
  }
});

test("PDS-2: 初期状態は空で、どの会社も中立値50を返す", () => {
  const state = buildInitialProductDevelopmentState();
  assert.equal(state.entries.length, 0);
  assert.equal(lookupProductDevelopmentScore(state, "C1"), 50);
  assert.equal(PRODUCT_DEVELOPMENT_PARAMETERS_V1.neutralScore, 50);
});

test("PDS-3: 標準投資額($250,000)を投資すると、ちょうどgainCoefficient(4.0)点だけスコアが上昇する", () => {
  const spend = new Map([["C1", 250_000]]);
  const next = updateProductDevelopmentState(undefined, spend, ["C1"]);
  const score = lookupProductDevelopmentScore(next, "C1");
  assert.ok(Math.abs(score - (50 + 4.0)) < 1e-9, `実際: ${score}`);
});

test("PDS-4: 最上位枠($500,000)は標準投資額の2倍＝investmentRatioCap(2.0)にちょうど一致し、上昇量は2×gainCoefficient=8.0点", () => {
  const spend = new Map([["C1", 500_000]]);
  const next = updateProductDevelopmentState(undefined, spend, ["C1"]);
  const score = lookupProductDevelopmentScore(next, "C1");
  assert.ok(Math.abs(score - (50 + 8.0)) < 1e-9, `実際: ${score}`);
});

test("PDS-5: $100,000投資は、標準投資額$250,000に対する比率(0.4)だけスコアが上昇する（1.6点）", () => {
  const spend = new Map([["C1", 100_000]]);
  const next = updateProductDevelopmentState(undefined, spend, ["C1"]);
  const score = lookupProductDevelopmentScore(next, "C1");
  assert.ok(Math.abs(score - (50 + 4.0 * 0.4)) < 1e-9, `実際: ${score}`);
});

test("PDS-6: spend=0の四半期は、投資量に関わらず必ず中立値へ向けた減衰が適用される（スキップされない）", () => {
  const spendUp = new Map([["C1", 500_000]]);
  let state = updateProductDevelopmentState(undefined, spendUp, ["C1"]);
  let score = lookupProductDevelopmentScore(state, "C1");
  assert.ok(score > 50);

  const spendZero = new Map<string, number>(); // C1は今期投資なし
  state = updateProductDevelopmentState(state, spendZero, ["C1"]);
  const decayedScore = lookupProductDevelopmentScore(state, "C1");
  const expected = 50 + (score - 50) * (1 - 0.06);
  assert.ok(Math.abs(decayedScore - expected) < 1e-9, `実際: ${decayedScore}, 期待: ${expected}`);
  assert.ok(decayedScore < score, "spend=0の四半期はスコアが中立値へ向けて必ず減衰するはず");
});

test("PDS-7: floor/capにclampされる（連続投資を続けても100を超えない）", () => {
  let state: ProductDevelopmentState | undefined = undefined;
  const spend = new Map([["C1", 500_000]]);
  for (let i = 0; i < 30; i++) {
    state = updateProductDevelopmentState(state, spend, ["C1"]);
  }
  const score = lookupProductDevelopmentScore(state, "C1");
  assert.ok(score <= 100 + 1e-9, `実際: ${score}`);
});

test("PDS-8: 会社ごとに独立して更新される（他社への波及なし）", () => {
  const spend = new Map([
    ["A", 500_000],
    ["B", 0],
  ]);
  const next = updateProductDevelopmentState(undefined, spend, ["A", "B"]);
  const scoreA = lookupProductDevelopmentScore(next, "A");
  const scoreB = lookupProductDevelopmentScore(next, "B");
  assert.ok(scoreA > 50, `A: ${scoreA}`);
  assert.equal(scoreB, 50, `B（spend=0・元々中立）はそのまま50のはず: ${scoreB}`);
});

test("PDS-9（タイミング）: updateProductDevelopmentStateは前期状態(prev)＋当期spendのみから次期状態を導出する純関数であり、当期spendが次期の初期値扱いにはならない（前期スコアを踏まえて増分される）", () => {
  const spendQ1 = new Map([["C1", 500_000]]);
  const stateAfterQ1 = updateProductDevelopmentState(undefined, spendQ1, ["C1"]);
  const scoreAfterQ1 = lookupProductDevelopmentScore(stateAfterQ1, "C1");

  const spendQ2 = new Map([["C1", 250_000]]);
  const stateAfterQ2 = updateProductDevelopmentState(stateAfterQ1, spendQ2, ["C1"]);
  const scoreAfterQ2 = lookupProductDevelopmentScore(stateAfterQ2, "C1");

  assert.ok(Math.abs(scoreAfterQ2 - (scoreAfterQ1 + 4.0)) < 1e-9, `Q2は前期スコア(${scoreAfterQ1})に4.0を加えた値になるはず（実際: ${scoreAfterQ2}）`);
});
