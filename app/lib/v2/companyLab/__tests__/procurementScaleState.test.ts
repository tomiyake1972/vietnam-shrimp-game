// ShrimpX V2 — 調達規模効果（procurementScaleState.ts）の単体テスト
//
// 検証項目:
//  1. 単発の大量買付より、4四半期継続買付の方が最終的な割引率が高い
//     （単四半期の大量買付だけでは最大効果を得られない）
//  2. 割引率が上限（maxDiscountRatio）を超えない
//  3. 数量が増えるほど割引率の増分が逓減する（2倍の数量で2倍の割引にはならない）
//  4. 購入を止めると関係スコアが減衰する
//  5. チャネル別（domestic/imported/aquaculture）に独立して計算される

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROCUREMENT_SCALE_PARAMETERS_V1,
  ProcurementScaleState,
  calculateVolumeDiscountRatio,
  emptyProcurementScaleState,
  lookupProcurementChannelScale,
  updateProcurementScaleState,
} from "../procurementScaleState";

const COMPANIES = ["A", "B"];

function volumesMap(entries: readonly [string, Partial<Record<"domestic" | "imported" | "aquaculture", number>>][]) {
  const m = new Map<string, { domestic: number; imported: number; aquaculture: number }>();
  for (const [companyId, v] of entries) {
    m.set(companyId, { domestic: v.domestic ?? 0, imported: v.imported ?? 0, aquaculture: v.aquaculture ?? 0 });
  }
  return m;
}

function advanceQuarters(
  quarterVolumes: readonly (ReadonlyMap<string, { domestic: number; imported: number; aquaculture: number }>)[]
): ProcurementScaleState {
  let state: ProcurementScaleState | undefined = emptyProcurementScaleState();
  for (const v of quarterVolumes) {
    state = updateProcurementScaleState(state, COMPANIES, v, PROCUREMENT_SCALE_PARAMETERS_V1);
  }
  return state!;
}

test("単発の大量買付より4四半期継続買付の方が最終的な割引率が高い", () => {
  const X = 800; // domesticのscaleUnitTonsと同水準の量

  // 単発: Q1にXを一括で買い、Q2〜Q4は0（合計は継続ケースの1/4）
  const single = advanceQuarters([
    volumesMap([["A", { domestic: X }]]),
    volumesMap([["A", {}]]),
    volumesMap([["A", {}]]),
    volumesMap([["A", {}]]),
  ]);

  // 継続: 4四半期連続でXずつ買う
  const sustained = advanceQuarters([
    volumesMap([["A", { domestic: X }]]),
    volumesMap([["A", { domestic: X }]]),
    volumesMap([["A", { domestic: X }]]),
    volumesMap([["A", { domestic: X }]]),
  ]);

  const singleVolume = lookupProcurementChannelScale(single, "A", "domestic").trailingVolumeHosoEqTons;
  const sustainedVolume = lookupProcurementChannelScale(sustained, "A", "domestic").trailingVolumeHosoEqTons;

  const p = PROCUREMENT_SCALE_PARAMETERS_V1;
  const singleDiscount = calculateVolumeDiscountRatio(singleVolume, p.maxDiscountRatioByChannel.domestic, p.scaleUnitTonsByChannel.domestic);
  const sustainedDiscount = calculateVolumeDiscountRatio(sustainedVolume, p.maxDiscountRatioByChannel.domestic, p.scaleUnitTonsByChannel.domestic);

  assert.ok(sustainedDiscount > singleDiscount, `sustained(${sustainedDiscount}) should exceed single(${singleDiscount})`);
});

test("割引率は上限（maxDiscountRatio）を超えない", () => {
  const p = PROCUREMENT_SCALE_PARAMETERS_V1;
  const huge = 10_000_000;
  const ratio = calculateVolumeDiscountRatio(huge, p.maxDiscountRatioByChannel.domestic, p.scaleUnitTonsByChannel.domestic);
  assert.ok(ratio <= p.maxDiscountRatioByChannel.domestic + 1e-9);

  // 何十四半期買い続けても状態経由の値も上限を超えない
  const many = Array.from({ length: 40 }, () => volumesMap([["A", { domestic: 100_000 }]]));
  const state = advanceQuarters(many);
  const volume = lookupProcurementChannelScale(state, "A", "domestic").trailingVolumeHosoEqTons;
  const finalRatio = calculateVolumeDiscountRatio(volume, p.maxDiscountRatioByChannel.domestic, p.scaleUnitTonsByChannel.domestic);
  assert.ok(finalRatio <= p.maxDiscountRatioByChannel.domestic + 1e-9);
});

test("数量が増えるほど割引率の増分が逓減する（2倍の数量で2倍の割引にはならない）", () => {
  const p = PROCUREMENT_SCALE_PARAMETERS_V1;
  const unit = p.scaleUnitTonsByChannel.domestic;
  const max = p.maxDiscountRatioByChannel.domestic;

  const d1 = calculateVolumeDiscountRatio(unit, max, unit);
  const d2 = calculateVolumeDiscountRatio(unit * 2, max, unit);
  assert.ok(d2 < d1 * 2, `doubling volume should not double the discount ratio: d1=${d1}, d2=${d2}`);

  // 増分逓減: [0,unit]の増分 > [unit,2*unit]の増分
  const d0 = calculateVolumeDiscountRatio(0, max, unit);
  const firstIncrement = d1 - d0;
  const secondIncrement = d2 - d1;
  assert.ok(secondIncrement < firstIncrement, `marginal discount should diminish: first=${firstIncrement}, second=${secondIncrement}`);
});

test("購入を止めると関係スコアが減衰する", () => {
  const p = PROCUREMENT_SCALE_PARAMETERS_V1;

  // 継続購入で関係スコアを中立値より上げる
  const active = advanceQuarters([
    volumesMap([["A", { domestic: 500 }]]),
    volumesMap([["A", { domestic: 500 }]]),
    volumesMap([["A", { domestic: 500 }]]),
  ]);
  const scoreAfterActive = lookupProcurementChannelScale(active, "A", "domestic").relationshipScore;
  assert.ok(scoreAfterActive > p.relationshipNeutralScore, "継続購入で関係スコアは中立値より高くなるはず");

  // その後、購入を止める
  const idleState = updateProcurementScaleState(active, COMPANIES, volumesMap([["A", {}]]), p);
  const scoreAfterIdle = lookupProcurementChannelScale(idleState, "A", "domestic").relationshipScore;
  assert.ok(scoreAfterIdle < scoreAfterActive, `idle后のスコア(${scoreAfterIdle})は購入継続時(${scoreAfterActive})より低いはず`);
});

test("チャネル別（domestic/imported/aquaculture）に独立して計算される", () => {
  const state = advanceQuarters([
    volumesMap([["A", { domestic: 1000 }]]),
    volumesMap([["A", { domestic: 1000 }]]),
    volumesMap([["A", { domestic: 1000 }]]),
    volumesMap([["A", { domestic: 1000 }]]),
  ]);

  const domestic = lookupProcurementChannelScale(state, "A", "domestic");
  const imported = lookupProcurementChannelScale(state, "A", "imported");
  const aquaculture = lookupProcurementChannelScale(state, "A", "aquaculture");

  assert.ok(domestic.trailingVolumeHosoEqTons > 0, "domesticチャネルのみ購入したので規模が積み上がっているはず");
  assert.equal(imported.trailingVolumeHosoEqTons, 0, "importedチャネルは購入していないので0のまま");
  assert.equal(aquaculture.trailingVolumeHosoEqTons, 0, "aquacultureチャネルは購入していないので0のまま");

  const p = PROCUREMENT_SCALE_PARAMETERS_V1;
  assert.equal(imported.relationshipScore, p.relationshipNeutralScore, "未活動チャネルの関係スコアは中立値のまま");
  assert.equal(aquaculture.relationshipScore, p.relationshipNeutralScore, "未活動チャネルの関係スコアは中立値のまま");
  assert.ok(domestic.relationshipScore > p.relationshipNeutralScore, "activeなチャネルの関係スコアは中立値より高いはず");

  // 会社Bはどのチャネルでも一切購入していない: 全チャネル初期値のまま
  const bDomestic = lookupProcurementChannelScale(state, "B", "domestic");
  assert.equal(bDomestic.trailingVolumeHosoEqTons, 0);
  assert.equal(bDomestic.relationshipScore, p.relationshipNeutralScore);
});
