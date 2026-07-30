// ShrimpX V2 — Phase SAI-5E: 市場進化（供給圧力→プレミアム・遅行需要・PD⇔VAP代替）の単体テスト

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKET_EVOLUTION_PARAMETERS_V1,
  applyProductSubstitution,
  deriveAdoptionTurnShift,
  derivePremiumRatioMultipliers,
  initialMarketEvolutionState,
  updateMarketEvolutionState,
  MarketEvolutionQuarterInputs,
} from "../marketEvolution";
import { computeMarketProductMix } from "../../market/productLifecycle";
import { DEMAND_MARKET_IDS } from "../../market/types";
import { usdPerHosoEqKg } from "../../core/units";

const REF = { pd: 0.18, vap: 0.55 } as const;

/** 実現プレミアムを直接指定できる最小のmarketResultダミー。 */
function marketResultWithPremiums(hosoPriceVn: number, pdPremium: number, vapPremium: number) {
  return {
    hosoPrices: { VN: { price: usdPerHosoEqKg(hosoPriceVn) } },
    pdPremium: { byCountry: { VN: { premium: usdPerHosoEqKg(pdPremium) } } },
    vapPremium: { byCountry: { VN: { premium: usdPerHosoEqKg(vapPremium) } } },
  } as never;
}

function inputs(overrides: Partial<MarketEvolutionQuarterInputs> = {}): MarketEvolutionQuarterInputs {
  return {
    offeredByProduct: { pd: 1000, vap: 500 },
    targetDemandByProduct: { pd: 1000, vap: 500 },
    marketResult: marketResultWithPremiums(5, 5 * REF.pd, 5 * REF.vap), // 中立（基準比率どおり）
    referencePremiumRatios: REF,
    ...overrides,
  };
}

test("SAI-5E: 需給均衡・基準プレミアムなら状態は中立のまま（倍率1・シグナル0近傍）", () => {
  let s = initialMarketEvolutionState();
  for (let q = 0; q < 8; q++) s = updateMarketEvolutionState(s, inputs());
  assert.ok(Math.abs(s.vap.premiumRatioMultiplier - 1) < 1e-9);
  assert.ok(Math.abs(s.vap.affordabilitySignalEwma) < 1e-9);
  assert.ok(Math.abs(s.vap.supplyPressureEwma - 1) < 1e-9);
});

test("SAI-5E: VAP供給圧力の持続でVAPプレミアム倍率が低下方向へ動く（方向テスト）", () => {
  let s = initialMarketEvolutionState();
  for (let q = 0; q < 6; q++) {
    s = updateMarketEvolutionState(s, inputs({ offeredByProduct: { pd: 1000, vap: 1200 }, targetDemandByProduct: { pd: 1000, vap: 500 } }));
  }
  assert.ok(s.vap.supplyPressureEwma > 1.5, `VAP供給圧力EWMA(${s.vap.supplyPressureEwma})が上昇していない`);
  assert.ok(s.vap.premiumRatioMultiplier < 1, `VAPプレミアム倍率(${s.vap.premiumRatioMultiplier})が低下していない`);
  assert.ok(Math.abs(s.pd.premiumRatioMultiplier - 1) < 1e-9, "PD側の倍率が巻き添えで動いている");
});

test("SAI-5E: 供給不足の持続でプレミアム倍率が上昇方向へ動く（PD供給不足→PDプレミアム上昇）", () => {
  let s = initialMarketEvolutionState();
  for (let q = 0; q < 6; q++) {
    s = updateMarketEvolutionState(s, inputs({ offeredByProduct: { pd: 400, vap: 500 }, targetDemandByProduct: { pd: 1000, vap: 500 } }));
  }
  assert.ok(s.pd.premiumRatioMultiplier > 1, `PDプレミアム倍率(${s.pd.premiumRatioMultiplier})が上昇していない`);
});

test("SAI-5E: プレミアム倍率の四半期変動は±12%以内・下限0.6/上限1.4を超えない（極端な入力でも）", () => {
  let s = initialMarketEvolutionState();
  let prev = 1;
  for (let q = 0; q < 30; q++) {
    s = updateMarketEvolutionState(s, inputs({ offeredByProduct: { pd: 1000, vap: 50000 }, targetDemandByProduct: { pd: 1000, vap: 100 } }));
    const now = s.vap.premiumRatioMultiplier;
    const change = Math.abs(now - prev) / prev;
    assert.ok(change <= MARKET_EVOLUTION_PARAMETERS_V1.premiumMultiplierMaxQuarterlyChange + 1e-9, `四半期変動(${change})が上限超過`);
    assert.ok(now >= MARKET_EVOLUTION_PARAMETERS_V1.premiumMultiplierFloor - 1e-12 && now <= MARKET_EVOLUTION_PARAMETERS_V1.premiumMultiplierCap + 1e-12);
    prev = now;
  }
  assert.ok(Math.abs(prev - MARKET_EVOLUTION_PARAMETERS_V1.premiumMultiplierFloor) < 1e-9, "長期の極端な過剰供給で下限へ収束していない");
});

test("SAI-5E: 割安の持続はシグナルを2〜4四半期の遅行で高め、高価格へ戻ると徐々に低下する", () => {
  let s = initialMarketEvolutionState();
  const cheap = marketResultWithPremiums(5, 5 * REF.pd, 5 * REF.vap * 0.7); // VAPが基準比の70%
  s = updateMarketEvolutionState(s, inputs({ marketResult: cheap }));
  const after1 = s.vap.affordabilitySignalEwma;
  assert.ok(after1 > 0 && after1 < 0.3 * 0.5, `1四半期でシグナル(${after1})が跳ね上がりすぎ（遅行になっていない）`);
  for (let q = 0; q < 3; q++) s = updateMarketEvolutionState(s, inputs({ marketResult: cheap }));
  const sustained = s.vap.affordabilitySignalEwma;
  assert.ok(sustained > after1 * 1.5, "割安の持続でシグナルが蓄積されていない");
  // 高価格へ戻る
  for (let q = 0; q < 2; q++) s = updateMarketEvolutionState(s, inputs());
  assert.ok(s.vap.affordabilitySignalEwma < sustained && s.vap.affordabilitySignalEwma > 0, "高価格復帰後に徐々に低下していない（即時ゼロ化もNG）");
  // 普及前倒しシフトへの変換
  const shift = deriveAdoptionTurnShift(s);
  assert.ok(shift.vap > 0 && Number.isFinite(shift.vap));
});

test("SAI-5E: PD⇔VAP代替 — VAP価格がPDへ近づくとPD需要の一部（最大10%）がVAPへ移動し、行和=1を維持する", () => {
  const mix = computeMarketProductMix(8);
  // VAPプレミアムが基準比の半分（大幅にPDへ接近）
  const prior = marketResultWithPremiums(5, 5 * REF.pd, 5 * REF.vap * 0.5);
  const { mix: shifted, substitutionShareShift } = applyProductSubstitution(mix, prior, REF);
  assert.ok(substitutionShareShift > 0 && substitutionShareShift <= MARKET_EVOLUTION_PARAMETERS_V1.substitutionMaxShare + 1e-12);
  for (const m of DEMAND_MARKET_IDS) {
    assert.ok(shifted[m].vap > mix[m].vap, `${m}: VAPシェアが増えていない`);
    assert.ok(shifted[m].pd < mix[m].pd, `${m}: PDシェアが減っていない（総需要の二重計上）`);
    assert.ok(Math.abs(shifted[m].hoso + shifted[m].pd + shifted[m].vap - 1) < 1e-12, `${m}: 行和が1でない`);
    assert.equal(shifted[m].hoso, mix[m].hoso, `${m}: HOSOが動いている（HOSO⇔VAP直接代替は0の設計）`);
  }
});

test("SAI-5E: 代替は基準比近傍（±10%以内）では発動しない（常時発動の防止）", () => {
  const mix = computeMarketProductMix(8);
  const nearRef = marketResultWithPremiums(5, 5 * REF.pd, 5 * REF.vap * 0.95);
  const { substitutionShareShift } = applyProductSubstitution(mix, nearRef, REF);
  assert.equal(substitutionShareShift, 0);
});

test("SAI-5E: VAPが相対的に高い場合は逆方向（VAP→PD）へ移動する", () => {
  const mix = computeMarketProductMix(8);
  const expensive = marketResultWithPremiums(5, 5 * REF.pd, 5 * REF.vap * 1.5);
  const { mix: shifted, substitutionShareShift } = applyProductSubstitution(mix, expensive, REF);
  assert.ok(substitutionShareShift < 0);
  for (const m of DEMAND_MARKET_IDS) {
    assert.ok(shifted[m].pd > mix[m].pd && shifted[m].vap < mix[m].vap, `${m}: VAP→PDの移動になっていない`);
  }
});

test("SAI-5E: 同一入力なら常に同一の状態（決定論）・全数値が有限", () => {
  const in1 = inputs({ offeredByProduct: { pd: 1234.5, vap: 678.9 } });
  const a = updateMarketEvolutionState(undefined, in1);
  const b = updateMarketEvolutionState(undefined, in1);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  for (const p of ["pd", "vap"] as const) {
    for (const v of Object.values(a[p])) assert.ok(Number.isFinite(v));
  }
  assert.deepEqual(derivePremiumRatioMultipliers(undefined), { pd: 1, vap: 1 });
});
