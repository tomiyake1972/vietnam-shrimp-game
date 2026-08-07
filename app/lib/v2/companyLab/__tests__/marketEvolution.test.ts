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

/**
 * 実現プレミアムを直接指定できる最小のmarketResultダミー。
 * 【監査指摘C対応】品質プレミアム（qualityAdjustment）を明示的に持たせる。
 * 既定は0＝「品質調整なしの純粋なベースプレミアム」であり、これらのテストが
 * 意図してきた前提（実現比率＝ベース比率）と一致する。
 */
function marketResultWithPremiums(hosoPriceVn: number, pdPremium: number, vapPremium: number, qualityAdjustment = 0) {
  return {
    hosoPrices: { VN: { price: usdPerHosoEqKg(hosoPriceVn) } },
    pdPremium: { byCountry: { VN: { premium: usdPerHosoEqKg(pdPremium), qualityAdjustment: usdPerHosoEqKg(qualityAdjustment) } } },
    vapPremium: { byCountry: { VN: { premium: usdPerHosoEqKg(vapPremium), qualityAdjustment: usdPerHosoEqKg(qualityAdjustment) } } },
  } as never;
}

/**
 * 【監査指摘B対応】これらの単体テストは「供給圧力の更新則」を検証するものであり、
 * 分母のスケール（全ベトナム需要 vs 5社addressable需要）そのものは検証対象では
 * ないため、addressableDemandByProduct は既定で targetDemandByProduct と同値に
 * 置く（＝5社が需要を100%取りにいける仮想市場）。これにより既存テストの意味・
 * 期待値は変更前と完全に同一のまま保たれる。分母の定義そのものの検証は
 * supplyPressureDefinition.test.ts が担当する。
 */
function inputs(overrides: Partial<MarketEvolutionQuarterInputs> = {}): MarketEvolutionQuarterInputs {
  const targetDemandByProduct = overrides.targetDemandByProduct ?? { pd: 1000, vap: 500 };
  return {
    offeredByProduct: { pd: 1000, vap: 500 },
    targetDemandByProduct,
    addressableDemandByProduct: targetDemandByProduct,
    externalOptionQuantityByProduct: { pd: 0, vap: 0 },
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

// ---------------------------------------------------------------------
// 代表シナリオ（§13C-4/5相当のモジュールレベル検証）
// ---------------------------------------------------------------------

test("SAI-5E: VAP-demand-recovery — 過剰供給後に需要が加速すると倍率は回復方向、供給がさらに増え続ければ回復しない", () => {
  // フェーズ1: 過剰供給（需要500に対し提示1200）を6四半期 → 倍率低下
  let recovered = initialMarketEvolutionState();
  for (let q = 0; q < 6; q++) {
    recovered = updateMarketEvolutionState(recovered, inputs({ offeredByProduct: { pd: 1000, vap: 1200 }, targetDemandByProduct: { pd: 1000, vap: 500 } }));
  }
  const depressed = recovered.vap.premiumRatioMultiplier;
  assert.ok(depressed < 0.9);

  // フェーズ2a: 需要が急成長（500→1500）・供給は1200のまま → 圧力<1 → 倍率回復方向
  let caseRecovery = recovered;
  for (let q = 0; q < 6; q++) {
    caseRecovery = updateMarketEvolutionState(caseRecovery, inputs({ offeredByProduct: { pd: 1000, vap: 1200 }, targetDemandByProduct: { pd: 1000, vap: 1500 } }));
  }
  assert.ok(caseRecovery.vap.premiumRatioMultiplier > depressed, "需要回復後に倍率が回復方向へ動いていない");

  // フェーズ2b: 需要成長(500→1500)と同時に供給がそれ以上に増える（1200→3600、
  // 圧力2.4のまま） → 需要が増えても回復しない
  let caseOversupply = recovered;
  for (let q = 0; q < 6; q++) {
    caseOversupply = updateMarketEvolutionState(caseOversupply, inputs({ offeredByProduct: { pd: 1000, vap: 3600 }, targetDemandByProduct: { pd: 1000, vap: 1500 } }));
  }
  assert.ok(
    caseOversupply.vap.premiumRatioMultiplier <= depressed + 1e-9,
    `供給がそれ以上に増えるケースで倍率(${caseOversupply.vap.premiumRatioMultiplier})が回復してしまっている`
  );
  assert.ok(
    caseRecovery.vap.premiumRatioMultiplier > caseOversupply.vap.premiumRatioMultiplier,
    "需要回復ケースと供給継続増加ケースの差が出ていない"
  );
});

test("SAI-5E: HOSO-affordability-cycle相当 — 割安持続→数四半期遅れて普及シフト増→価格正常化で徐々に減衰（PD/VAPの構成比チャネル）", () => {
  // 注: HOSO安値→市場全体需要の増加は既存のconsumerInventory弾力性が担うため
  // 本モジュールでは扱わない（設計メモ§2.4。二重計上防止）。ここではPD/VAPの
  // 割安→普及前倒し→需給が締まる、の遅行循環を検証する。
  let s = initialMarketEvolutionState();
  const cheapVap = marketResultWithPremiums(5, 5 * REF.pd, 5 * REF.vap * 0.6);
  const shifts: number[] = [];
  for (let q = 0; q < 6; q++) {
    s = updateMarketEvolutionState(s, inputs({ marketResult: cheapVap }));
    shifts.push(deriveAdoptionTurnShift(s).vap);
  }
  // 遅行的に単調増加（1四半期で飽和しない）
  for (let i = 1; i < shifts.length; i++) assert.ok(shifts[i] > shifts[i - 1]);
  assert.ok(shifts[0] < shifts[5] * 0.5, "初回で一気に跳ねている（遅行になっていない）");
  // 価格正常化 → 徐々に減衰（即時ゼロ化しない）
  for (let q = 0; q < 2; q++) s = updateMarketEvolutionState(s, inputs());
  const afterNormalization = deriveAdoptionTurnShift(s).vap;
  assert.ok(afterNormalization < shifts[5] && afterNormalization > 0);
});

// ---------------------------------------------------------------------------
// 【監査指摘C】実現プレミアム比率と参照プレミアム比率の定義そろえ
// ---------------------------------------------------------------------------

test("SAI-5C修正: 品質プレミアムは割安シグナルに影響しない（定義そろえ後の定数バイアス除去）", () => {
  // 同じベースプレミアム水準で、品質プレミアムだけが乗っている市場結果。
  // 修正前は品質プレミアム分だけ実現側が高く出て、割安シグナルが恒常的に
  // マイナス（＝普及を遅らせ続ける）方向へ偏っていた。
  const hoso = 5;
  const qualityAdj = 0.3; // USD/kg の品質プレミアム
  const withQuality = marketResultWithPremiums(hoso, hoso * REF.pd + qualityAdj, hoso * REF.vap + qualityAdj, qualityAdj);
  const withoutQuality = marketResultWithPremiums(hoso, hoso * REF.pd, hoso * REF.vap, 0);

  let a = initialMarketEvolutionState();
  let b = initialMarketEvolutionState();
  for (let q = 0; q < 6; q++) {
    a = updateMarketEvolutionState(a, inputs({ marketResult: withQuality }));
    b = updateMarketEvolutionState(b, inputs({ marketResult: withoutQuality }));
  }
  assert.ok(Math.abs(a.vap.affordabilitySignalEwma - b.vap.affordabilitySignalEwma) < 1e-12, "品質プレミアムの有無で割安シグナルが変わっている");
  assert.ok(Math.abs(a.vap.affordabilitySignalEwma) < 1e-12, `基準どおりの価格なのにシグナル(${a.vap.affordabilitySignalEwma})が0でない`);
  assert.ok(Math.abs(a.pd.affordabilitySignalEwma) < 1e-12);
});

test("SAI-5C修正: 品質プレミアムはPD⇔VAP代替の判定にも影響しない", () => {
  const mix = computeMarketProductMix(8);
  const hoso = 5;
  const qualityAdj = 0.3;
  // ベース比率としてはVAPが基準の50%（＝代替が発動する水準）。品質プレミアムは
  // PD・VAPに同額で乗る（productPremium.tsの構成と同じ）。
  const withQuality = marketResultWithPremiums(hoso, hoso * REF.pd + qualityAdj, hoso * REF.vap * 0.5 + qualityAdj, qualityAdj);
  const withoutQuality = marketResultWithPremiums(hoso, hoso * REF.pd, hoso * REF.vap * 0.5, 0);
  const a = applyProductSubstitution(mix, withQuality, REF);
  const b = applyProductSubstitution(mix, withoutQuality, REF);
  assert.equal(a.substitutionShareShift, b.substitutionShareShift, "品質プレミアムの有無で代替の移動量が変わっている");
  assert.ok(a.substitutionShareShift > 0);
});

test("SAI-5C修正: 供給倍率によるプレミアム低下は割安シグナルに反映される（設計§2.4の意図した経路）", () => {
  // 稼働率倍率・供給倍率の効果は意図的に残す（供給増→価格低下→普及加速）。
  const hoso = 5;
  const cheapBase = marketResultWithPremiums(hoso, hoso * REF.pd, hoso * REF.vap * 0.7, 0.3);
  let s = initialMarketEvolutionState();
  for (let q = 0; q < 4; q++) s = updateMarketEvolutionState(s, inputs({ marketResult: cheapBase }));
  assert.ok(s.vap.affordabilitySignalEwma > 0, "ベースプレミアムの低下が割安シグナルへ反映されていない");
  assert.ok(deriveAdoptionTurnShift(s).vap > 0, "割安シグナルが普及前倒しへ変換されていない");
});
