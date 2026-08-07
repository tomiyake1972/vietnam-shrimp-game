// ShrimpX V2 — Phase 7A 品質モジュール scoreUpdates.ts テスト
//
// 対応する受入条件:
//   15. 品質は悪化が速く、回復が遅い
//   17. 期限内・遅延・未履行を正しく区別する（納期スコア算出部分）
//   18. 同じ未履行数量を無制限に重複罰しない（継続超過ペナルティの上限）
//   19. 顧客信頼は悪化が速く、回復が遅い（かつ品質・納期より回復が遅い）

import { test } from "node:test";
import assert from "node:assert/strict";
import { score0to100, unwrapUnit } from "../../core/units";
import { updateCustomerTrustScore, updateDeliveryReliabilityScore, updateQualityScore, updateScoreAsymmetric } from "../scoreUpdates";
import { QUALITY_PARAMETERS_V1 } from "../parameters";

// --- 15: 品質は悪化が速く、回復が遅い ---

test("15: 品質スコアは悪化時のalphaが改善時より大きい（悪化が速く、回復は遅い）", () => {
  const params = QUALITY_PARAMETERS_V1;
  assert.ok(params.qualityScoreUpdate.alphaDown > params.qualityScoreUpdate.alphaUp);

  const previous = score0to100(80);
  const worse = score0to100(60); // 悪化方向
  const better = score0to100(95); // 改善方向

  const afterWorse = updateQualityScore(previous, worse);
  const afterBetter = updateQualityScore(previous, better);

  const dropAmount = unwrapUnit(previous) - unwrapUnit(afterWorse);
  const riseAmount = unwrapUnit(afterBetter) - unwrapUnit(previous);

  // 同じ絶対乖離幅(20 vs 15)ではないため単純比較はできないが、alphaの比率どおりに
  // 動くことを確認する: dropAmount = alphaDown * 20, riseAmount = alphaUp * 15
  assert.ok(Math.abs(dropAmount - params.qualityScoreUpdate.alphaDown * 20) < 1e-6);
  assert.ok(Math.abs(riseAmount - params.qualityScoreUpdate.alphaUp * 15) < 1e-6);

  // 同一乖離幅で比較すればalphaDown>alphaUpの効果が直接わかる。
  const symmetricWorse = updateScoreAsymmetric(score0to100(80), score0to100(70), params.qualityScoreUpdate.alphaDown, params.qualityScoreUpdate.alphaUp);
  const symmetricBetter = updateScoreAsymmetric(score0to100(80), score0to100(90), params.qualityScoreUpdate.alphaDown, params.qualityScoreUpdate.alphaUp);
  const dropSym = 80 - unwrapUnit(symmetricWorse);
  const riseSym = unwrapUnit(symmetricBetter) - 80;
  assert.ok(dropSym > riseSym, "同じ乖離幅10なら、悪化方向の移動量の方が改善方向より大きいはず");
});

test("スコアは常に[0,100]へ制限される（極端な観測値でも発散しない）", () => {
  const params = QUALITY_PARAMETERS_V1;
  const fromLow = updateScoreAsymmetric(score0to100(1), score0to100(0), params.qualityScoreUpdate.alphaDown, params.qualityScoreUpdate.alphaUp);
  const fromHigh = updateScoreAsymmetric(score0to100(99), score0to100(100), params.qualityScoreUpdate.alphaDown, params.qualityScoreUpdate.alphaUp);
  assert.ok(unwrapUnit(fromLow) >= 0 && unwrapUnit(fromLow) <= 100);
  assert.ok(unwrapUnit(fromHigh) >= 0 && unwrapUnit(fromHigh) <= 100);
});

// --- 17: 期限内・遅延・未履行を正しく区別する ---

test("17: 納期スコアはonTime/due比率をそのまま反映する（全数期限内=100・全数未履行=0）", () => {
  const previous = score0to100(50);
  const allOnTime = updateDeliveryReliabilityScore(previous, 100, 100, 0);
  const allLate = updateDeliveryReliabilityScore(previous, 100, 0, 0);
  const half = updateDeliveryReliabilityScore(previous, 100, 50, 0);

  // 全数期限内なら観測値100 → 改善方向に更新される
  assert.ok(unwrapUnit(allOnTime) > 50);
  // 全数未履行なら観測値0 → 悪化方向に更新され、半分納期内より低くなる
  assert.ok(unwrapUnit(allLate) < unwrapUnit(half));
  assert.ok(unwrapUnit(half) < unwrapUnit(allOnTime));
});

// --- 18: 同じ未履行数量を無制限に重複罰しない ---

test("18: 継続納期超過ペナルティはcontinuingOverduePenaltyCapで上限が付く（無制限の重複加算にならない）", () => {
  const params = QUALITY_PARAMETERS_V1;
  const previous = score0to100(50);
  // dueQuantity=100・onTime=100（当期分は完璧）だが、継続超過が非常に大きい場合でも
  // ペナルティはcontinuingOverduePenaltyCapで頭打ちになる。
  const smallContinuing = updateDeliveryReliabilityScore(previous, 100, 100, 5, params);
  const hugeContinuing = updateDeliveryReliabilityScore(previous, 100, 100, 100000, params);
  const cappedContinuing = updateDeliveryReliabilityScore(previous, 100, 100, 100000000, params);
  // 継続超過が大きいほど下がるが、hugeとcappedの差はゼロ（両方ともcap到達）。
  assert.ok(unwrapUnit(hugeContinuing) <= unwrapUnit(smallContinuing));
  assert.equal(unwrapUnit(hugeContinuing), unwrapUnit(cappedContinuing));
});

test("18b: dueQuantity=0の場合は納期スコア関数自体は100扱いになる（呼び出し側のスキップ判定と組み合わせて使う）", () => {
  const previous = score0to100(30);
  const result = updateDeliveryReliabilityScore(previous, 0, 0, 0);
  // observedOnTimeScoreRaw = 100 (dueQuantity<=0の場合のフォールバック) なので改善方向。
  // ただしこの関数自体は「更新すべきか」を判断しない。呼び出し側(stateUpdate.ts)が
  // dueQuantity>0を更新のトリガー条件として使う（別テストで確認）。
  assert.ok(unwrapUnit(result) >= unwrapUnit(previous));
});

// --- 19: 顧客信頼は悪化が速く、回復が遅い（かつ品質・納期より回復が遅い） ---

test("19: 顧客信頼スコアは悪化時のalphaが改善時より大きい（悪化が速く、回復は遅い）", () => {
  const params = QUALITY_PARAMETERS_V1;
  assert.ok(params.customerTrustUpdate.alphaDown > params.customerTrustUpdate.alphaUp);

  const previous = score0to100(60);
  const worseUpdate = updateCustomerTrustScore(previous, score0to100(30), score0to100(30), 0, params);
  const betterUpdate = updateCustomerTrustScore(previous, score0to100(90), score0to100(90), 0, params);
  assert.ok(unwrapUnit(worseUpdate) < unwrapUnit(previous));
  assert.ok(unwrapUnit(betterUpdate) > unwrapUnit(previous));
});

test("19b: 顧客信頼は品質・納期信頼性よりも悪化・回復のいずれも遅い（alphaが小さい）", () => {
  const params = QUALITY_PARAMETERS_V1;
  assert.ok(params.customerTrustUpdate.alphaDown < params.qualityScoreUpdate.alphaDown);
  assert.ok(params.customerTrustUpdate.alphaDown < params.deliveryReliabilityUpdate.alphaDown);
  assert.ok(params.customerTrustUpdate.alphaUp <= params.qualityScoreUpdate.alphaUp);
  assert.ok(params.customerTrustUpdate.alphaUp <= params.deliveryReliabilityUpdate.alphaUp);
});

test("19c: 顧客信頼は品質・納期の加重合成(customerExperienceScore)で決まり、重大事故ペナルティでさらに下がる", () => {
  const params = QUALITY_PARAMETERS_V1;
  const previous = score0to100(70);
  const withoutIncident = updateCustomerTrustScore(previous, score0to100(80), score0to100(80), 0, params);
  const withIncident = updateCustomerTrustScore(previous, score0to100(80), score0to100(80), 25, params);
  assert.ok(unwrapUnit(withIncident) < unwrapUnit(withoutIncident));
});
