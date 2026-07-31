// ShrimpX V2 — SAI-5 監査指摘B（Blocker B）: 供給圧力の定義そのものの検証
//
// 三宅さんのご指示§2の採用条件のうち、制御された入力でしか確かめられないもの
// （方向性・中立性・二重計上の不在）をここで検証する。実運転での分布・張り付き
// （条件[1][6][8]）は scripts/sai5SupplyPressureStudy.ts が測定し、結果は
// docs/v2/design/sai5_market_evolution_design.md §2.6 に記録している。
//
// 採用した定義: completed_supply
//   pressure = (5社の提示量 + 外部選択肢が埋めた量) / 対象需要
//            = 1 + (5社の提示量 − 5社の成約量) / 対象需要
//   ＝「売りたかったのに売れ残った量が、市場需要の何％か」

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKET_EVOLUTION_PARAMETERS_V1,
  MarketEvolutionQuarterInputs,
  computeAddressableDemand,
  computeRawSupplyPressure,
  initialMarketEvolutionState,
  updateMarketEvolutionState,
} from "../marketEvolution";
import { usdPerHosoEqKg } from "../../core/units";

const REF = { pd: 0.18, vap: 0.55 } as const;
const PARAMS = MARKET_EVOLUTION_PARAMETERS_V1;

function marketResultNeutral() {
  return {
    hosoPrices: { VN: { price: usdPerHosoEqKg(5) } },
    pdPremium: { byCountry: { VN: { premium: usdPerHosoEqKg(5 * REF.pd) } } },
    vapPremium: { byCountry: { VN: { premium: usdPerHosoEqKg(5 * REF.vap) } } },
  } as never;
}

/**
 * 対象需要100・5社の成約量 contracted・提示量 offered の1市場を作る。
 * 外部選択肢は残差（対象需要 − 5社成約量）を埋める（水位法の実際の挙動と同じ）。
 */
function scenario(offered: number, contracted: number, targetDemand = 100): MarketEvolutionQuarterInputs {
  const external = Math.max(0, targetDemand - contracted);
  return {
    offeredByProduct: { pd: offered, vap: offered },
    targetDemandByProduct: { pd: targetDemand, vap: targetDemand },
    // addressable は候補(i)の分母。ここでは 5社均衡シェア90%相当を置く。
    addressableDemandByProduct: { pd: targetDemand * 0.9, vap: targetDemand * 0.9 },
    externalOptionQuantityByProduct: { pd: external, vap: external },
    marketResult: marketResultNeutral(),
    referencePremiumRatios: REF,
  };
}

function rawPressure(inputs: MarketEvolutionQuarterInputs): number {
  return computeRawSupplyPressure("vap", inputs, PARAMS, undefined).pressure;
}

// ---------------------------------------------------------------------------
// 採用条件[1] 中立性: 提示した分がすべて成約する状態で厳密に1.0
// ---------------------------------------------------------------------------

test("SAI-5B修正[1]: 提示量がすべて成約する中立状態で供給圧力は厳密に1.0", () => {
  // 5社が40提示して40成約、残り60を外部が埋める → 売れ残りゼロ → 圧力1.0
  assert.equal(rawPressure(scenario(40, 40)), 1);
  // 規模が変わっても中立は1.0のまま（スケール不変＝分子分母の母集団が一致している証拠）
  assert.equal(rawPressure(scenario(4000, 4000, 10000)), 1);
  assert.equal(rawPressure(scenario(5, 5, 10000)), 1);
});

test("SAI-5B修正[1b]: 旧定義(raw_target_demand)は同じ中立状態で1.0にならない（棄却理由の再現）", () => {
  const legacy = { ...PARAMS, supplyPressureDefinition: "raw_target_demand" as const };
  // 同じ「売れ残りゼロ」の中立状態なのに、5社の規模によって値が0.4にも0.0005にもなる
  assert.equal(computeRawSupplyPressure("vap", scenario(40, 40), legacy, undefined).pressure, 0.4);
  assert.equal(computeRawSupplyPressure("vap", scenario(5, 5, 10000), legacy, undefined).pressure, 0.0005);
});

// ---------------------------------------------------------------------------
// 採用条件[2][3] 方向性: 5社の提示量だけを増やすと上昇・減らすと低下
// ---------------------------------------------------------------------------

test("SAI-5B修正[2]: 5社の提示量だけを増やすと供給圧力が上昇する", () => {
  // 成約量は市場が吸収できる40で頭打ち。提示だけを増やす。
  const p40 = rawPressure(scenario(40, 40));
  const p60 = rawPressure(scenario(60, 40));
  const p90 = rawPressure(scenario(90, 40));
  assert.ok(p60 > p40, `提示60(${p60}) > 提示40(${p40}) になっていない`);
  assert.ok(p90 > p60, `提示90(${p90}) > 提示60(${p60}) になっていない`);
  assert.equal(p60, 1.2); // 1 + (60-40)/100
  assert.equal(p90, 1.5);
});

test("SAI-5B修正[3]: 5社の提示量だけを減らすと供給圧力が低下し、中立1.0へ戻る", () => {
  const high = rawPressure(scenario(90, 40));
  const mid = rawPressure(scenario(60, 40));
  const neutral = rawPressure(scenario(40, 40));
  assert.ok(high > mid && mid > neutral, `供給を減らしたのに圧力が下がらない（${high} → ${mid} → ${neutral}）`);
  assert.equal(neutral, 1);
});

// ---------------------------------------------------------------------------
// 採用条件[4][5] 圧力↑→翌期プレミアム↓ / 圧力↓→プレミアム回復
// ---------------------------------------------------------------------------

test("SAI-5B修正[4]: 供給圧力の上昇が翌期のプレミアム倍率を低下させる", () => {
  let s = initialMarketEvolutionState();
  const before = s.vap.premiumRatioMultiplier;
  for (let q = 0; q < 6; q++) s = updateMarketEvolutionState(s, scenario(90, 40), PARAMS);
  assert.ok(s.vap.supplyPressureEwma > 1.2, `供給圧力EWMA(${s.vap.supplyPressureEwma})が上がっていない`);
  assert.ok(s.vap.premiumRatioMultiplier < before, `プレミアム倍率(${s.vap.premiumRatioMultiplier})が低下していない`);
});

test("SAI-5B修正[5]: 供給過剰が解消するとプレミアム倍率が回復する", () => {
  let s = initialMarketEvolutionState();
  for (let q = 0; q < 6; q++) s = updateMarketEvolutionState(s, scenario(90, 40), PARAMS);
  const trough = s.vap.premiumRatioMultiplier;
  for (let q = 0; q < 6; q++) s = updateMarketEvolutionState(s, scenario(40, 40), PARAMS);
  assert.ok(s.vap.premiumRatioMultiplier > trough, `過剰解消後の倍率(${s.vap.premiumRatioMultiplier})が底(${trough})から回復していない`);
  assert.ok(s.vap.premiumRatioMultiplier <= 1 + 1e-9, "回復が中立1.0を超えている（外部選択肢が完全弾力的な本モデルでは供給不足は起こり得ない）");
});

// ---------------------------------------------------------------------------
// 採用条件[6] 季節変動だけでは上下限へ張り付かない
// ---------------------------------------------------------------------------

test("SAI-5B修正[6]: 需要が季節変動するだけ（売れ残りなし）では倍率が動かない", () => {
  let s = initialMarketEvolutionState();
  // 需要が 70 ⇄ 130 と振れ、5社は毎期その40%を提示して全量成約する
  for (let q = 0; q < 32; q++) {
    const demand = q % 2 === 0 ? 70 : 130;
    const offered = demand * 0.4;
    s = updateMarketEvolutionState(s, scenario(offered, offered, demand), PARAMS);
  }
  assert.ok(Math.abs(s.vap.premiumRatioMultiplier - 1) < 1e-9, `季節変動だけで倍率が${s.vap.premiumRatioMultiplier}へ動いた`);
  assert.ok(s.vap.premiumRatioMultiplier > PARAMS.premiumMultiplierFloor + 1e-9, "床に張り付いた");
  assert.ok(s.vap.premiumRatioMultiplier < PARAMS.premiumMultiplierCap - 1e-9, "天井に張り付いた");
});

// ---------------------------------------------------------------------------
// 採用条件[7] 外部選択肢との二重計上がない
// ---------------------------------------------------------------------------

test("SAI-5B修正[7]: 外部選択肢の数量は供給圧力に1度だけ現れる（残差恒等式の確認）", () => {
  // pressure = (offered + external)/demand と 1 + (offered - contracted)/demand が
  // 常に一致する＝外部数量は「市場全体の供給量を数える」1つの役割でのみ使われている。
  for (const [offered, contracted, demand] of [
    [40, 40, 100],
    [90, 40, 100],
    [10, 10, 100],
    [5000, 3000, 8000],
  ] as const) {
    const viaExternal = rawPressure(scenario(offered, contracted, demand));
    const viaResidual = 1 + (offered - contracted) / demand;
    assert.ok(Math.abs(viaExternal - viaResidual) < 1e-12, `恒等式が破れた（${viaExternal} vs ${viaResidual}）`);
  }
});

// ---------------------------------------------------------------------------
// 採用条件[8] 会社別の隠れた補正・当てはめ定数がない
// ---------------------------------------------------------------------------

test("SAI-5B修正[8]: 供給圧力は市場×商品の集計量だけで決まり、会社別の補正項を持たない", () => {
  // 同じ合計提示量・同じ合計成約量なら、それが1社由来でも5社由来でも結果は同一。
  // （computeRawSupplyPressureの入力に会社IDが存在しないことの動作上の確認）
  const a = rawPressure(scenario(90, 40));
  const b = rawPressure(scenario(30 + 30 + 30, 10 + 10 + 20));
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// 棄却した候補(i)の分母ヘルパー（設計書§2.6の再現用に残している）
// ---------------------------------------------------------------------------

test("SAI-5B修正: computeAddressableDemand は水位法の均衡シェアを返す（候補(i)の分母）", () => {
  // 5社の競争力合計3.15、外部0.35 → 5社の均衡シェアは3.15/3.5 = 0.9
  assert.ok(Math.abs(computeAddressableDemand(1000, 3.15, 0.35) - 900) < 1e-9);
  // 外部選択肢の重みが5社合計と等しければ均衡シェアは50%
  assert.ok(Math.abs(computeAddressableDemand(1000, 0.35, 0.35) - 500) < 1e-9);
  // 需要ゼロ・重みゼロは0（発散しない）
  assert.equal(computeAddressableDemand(0, 3.15, 0.35), 0);
  assert.equal(computeAddressableDemand(1000, 0, 0), 0);
});

test("SAI-5B修正: 候補(i)addressable_demandが棄却された理由の再現（5社が需要規模に対して小さい）", () => {
  // 実測では5社の均衡シェアは約90%（外部の重み0.35 vs 5社合計約3.1）だが、
  // 5社は能力上そこまで提示できないため、分母をaddressableにしても中立1.0には
  // 全く届かない（実測中央値: PD 0.309 / VAP 0.551）。
  const candidateI = { ...PARAMS, supplyPressureDefinition: "addressable_demand" as const };
  const p = computeRawSupplyPressure("vap", scenario(40, 40), candidateI, undefined).pressure;
  assert.ok(Math.abs(p - 40 / 90) < 1e-12, `候補(i)は中立状態でも${p}にしかならない`);
  assert.ok(p < 0.5, "候補(i)が中立状態で1.0付近に来ていない（＝棄却理由）");
});
