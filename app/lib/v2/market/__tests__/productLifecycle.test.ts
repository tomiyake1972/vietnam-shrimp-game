// ShrimpX V2 — Phase SAI-5C: 市場別の商品ライフサイクルのテスト
//
// 実装指示§13A（不変条件）・§13B（方向テスト）のうちライフサイクル固有分:
// 構成比の行和=1・有限・非負・成長方向・市場間の時間差（JP→US→CN）・
// 決定論性・総需要保存を検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCT_LIFECYCLE_PARAMETERS_V1,
  adoptionShare,
  applyLifecycleDemandToMarketInput,
  assertLifecycleParametersValid,
  computeMarketProductMix,
} from "../productLifecycle";
import { DEMAND_MARKET_IDS } from "../types";
import { hosoEqTons, unwrapUnit } from "../../core/units";

test("SAI-5C: パラメータ既定値が健全性検証を通る", () => {
  assertLifecycleParametersValid(PRODUCT_LIFECYCLE_PARAMETERS_V1);
});

test("SAI-5C: 全turn(1〜40)・全市場で構成比が有限・非負・行和=1", () => {
  for (let turn = 1; turn <= 40; turn++) {
    const mix = computeMarketProductMix(turn);
    for (const market of DEMAND_MARKET_IDS) {
      const { hoso, pd, vap } = mix[market];
      for (const v of [hoso, pd, vap]) {
        assert.ok(Number.isFinite(v) && v >= 0, `turn${turn} ${market}: 非有限または負のシェア(${v})`);
      }
      assert.ok(Math.abs(hoso + pd + vap - 1) < 1e-12, `turn${turn} ${market}: 行和が1でない(${hoso + pd + vap})`);
    }
  }
});

test("SAI-5C: 開始時点はHOSOが全市場で最大シェア、VAPは非常に小さい（全市場で10%以下）、中国はHOSO中心", () => {
  const mix = computeMarketProductMix(1);
  for (const market of DEMAND_MARKET_IDS) {
    assert.ok(mix[market].hoso > mix[market].pd && mix[market].hoso > mix[market].vap, `${market}: HOSOが最大でない`);
    assert.ok(mix[market].vap <= 0.1 + 1e-12, `${market}: 開始時VAPシェア(${mix[market].vap})が大きすぎる`);
  }
  assert.ok(mix.CN.hoso > 0.8, `中国の開始時HOSOシェア(${mix.CN.hoso})がHOSO中心と言えない`);
  assert.ok(mix.JP.pd > mix.CN.pd && mix.JP.vap > mix.CN.vap, "日本の普及が中国より進んでいない");
});

test("SAI-5C: 構成比は時間とともに単調にPD/VAPへシフトする（減少しない）", () => {
  for (const market of DEMAND_MARKET_IDS) {
    let prevPd = -1;
    let prevVap = -1;
    for (let turn = 1; turn <= 40; turn++) {
      const mix = computeMarketProductMix(turn);
      assert.ok(mix[market].pd >= prevPd - 1e-12, `${market} turn${turn}: PDシェアが減少`);
      assert.ok(mix[market].vap >= prevVap - 1e-12, `${market} turn${turn}: VAPシェアが減少`);
      prevPd = mix[market].pd;
      prevVap = mix[market].vap;
    }
  }
});

/** 「成長開始」= 初期シェアからの増分が成熟増分の10%を超えた最初のturn。 */
function growthStartTurn(market: "JP" | "US" | "EU" | "CN" | "OTHER", product: "pd" | "vap"): number {
  const curve = PRODUCT_LIFECYCLE_PARAMETERS_V1.byMarket[market][product];
  const span = curve.matureShare - curve.initialShare;
  for (let turn = 1; turn <= 60; turn++) {
    const share = adoptionShare(curve, turn);
    if (share - curve.initialShare > span * 0.1) return turn;
  }
  return 61;
}

test("SAI-5C: 日本VAPは米国より早く、米国VAPは中国より早く成長開始する（方向テスト）", () => {
  const jp = growthStartTurn("JP", "vap");
  const us = growthStartTurn("US", "vap");
  const cn = growthStartTurn("CN", "vap");
  assert.ok(jp < us, `日本VAPの成長開始(${jp})が米国(${us})より早くない`);
  assert.ok(us < cn, `米国VAPの成長開始(${us})が中国(${cn})より早くない`);
});

test("SAI-5C: 中国はHOSO中心期間が相対的に長い（HOSOシェア0.7以上を維持する期間が全市場で最長）", () => {
  const hosoDominantUntil = (market: (typeof DEMAND_MARKET_IDS)[number]): number => {
    let last = 0;
    for (let turn = 1; turn <= 40; turn++) {
      if (computeMarketProductMix(turn)[market].hoso >= 0.7) last = turn;
    }
    return last;
  };
  const cn = hosoDominantUntil("CN");
  for (const market of DEMAND_MARKET_IDS.filter((m) => m !== "CN")) {
    assert.ok(cn >= hosoDominantUntil(market), `中国のHOSO中心期間(${cn})が${market}(${hosoDominantUntil(market)})より短い`);
  }
});

test("SAI-5C: 同じturn・同じパラメータなら常に同一の行列（決定論・乱数不使用）", () => {
  for (const turn of [1, 8, 16, 32]) {
    assert.equal(JSON.stringify(computeMarketProductMix(turn)), JSON.stringify(computeMarketProductMix(turn)));
  }
});

test("SAI-5C: adoptionTurnShift（普及前倒し）は±maxAdoptionTurnShiftへclampされ、シェアを成熟上限より上へ押し上げない", () => {
  const curve = PRODUCT_LIFECYCLE_PARAMETERS_V1.byMarket.JP.vap;
  const maxShift = PRODUCT_LIFECYCLE_PARAMETERS_V1.maxAdoptionTurnShift;
  const shifted = adoptionShare(curve, 8, 100); // 過大なシフト指定
  const atMax = adoptionShare(curve, 8 + maxShift, 0);
  assert.ok(Math.abs(shifted - atMax) < 1e-12, "シフトがclampされていない");
  for (let turn = 1; turn <= 40; turn++) {
    assert.ok(adoptionShare(curve, turn, maxShift) <= curve.matureShare + 1e-12);
  }
});

test("SAI-5C: applyLifecycleDemandToMarketInputは世界PD/VAP需要だけを置き換え、市場全体消費・他フィールドを変更しない（総需要の二重計上なし）", () => {
  // 最小限のダミー入力（demandMarketsの消費のみ本物らしい値）
  const consumption = { CN: 90000, US: 80000, EU: 70000, JP: 60000, OTHER: 50000 } as const;
  const demandMarkets = Object.fromEntries(
    DEMAND_MARKET_IDS.map((m) => [m, { priorPeriodConsumption: hosoEqTons(consumption[m]), economicIndex: 1, populationGrowthRate: 0 }])
  ) as never;
  const input = {
    period: "2015Q1",
    priorHosoFobPrice: {},
    countries: {},
    demandMarkets,
    vietnamDomestic: {},
    pdVapDemand: { pdDemand: hosoEqTons(98000), vapDemand: hosoEqTons(42000) },
  } as never;

  const mix = computeMarketProductMix(1);
  const out = applyLifecycleDemandToMarketInput(input, mix) as never as {
    pdVapDemand: { pdDemand: number; vapDemand: number };
    demandMarkets: typeof demandMarkets;
  };

  // 期待値: Σ 市場消費 × 市場別シェア
  let expectedPd = 0;
  let expectedVap = 0;
  for (const m of DEMAND_MARKET_IDS) {
    expectedPd += consumption[m] * mix[m].pd;
    expectedVap += consumption[m] * mix[m].vap;
  }
  assert.ok(Math.abs(unwrapUnit(out.pdVapDemand.pdDemand as never) - expectedPd) < 1e-9);
  assert.ok(Math.abs(unwrapUnit(out.pdVapDemand.vapDemand as never) - expectedVap) < 1e-9);
  // 市場全体消費は不変
  assert.equal(out.demandMarkets, demandMarkets);
  // 開始時点の世界VAP需要は従来固定シェア(0.12×総消費=42000)より小さい（=VAPは非常に小さい市場）
  assert.ok(unwrapUnit(out.pdVapDemand.vapDemand as never) < 42000 * 0.6);
});
