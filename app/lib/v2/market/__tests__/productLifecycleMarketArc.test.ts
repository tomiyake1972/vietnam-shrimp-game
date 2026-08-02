// ShrimpX V2 — 市場別商品ライフサイクルの「物語の弧」検証（加工品市場進化 §b）
//
// PLA-1〜PLA-6。実装指示§3の市場別記述を、**パラメータ値の見た目ではなく
// 実際のエンジン出力**（computeMarketProductMix の32四半期分）と突き合わせる。
//
//   JP:    安定的に大きいPD ＋ 人手不足・厨房コストを背景としたVAP成長
//   US:    まずPDが伸び、その後VAPが強く伸びる（時間差があること）
//   EU:    PD/VAPへ移行する（品質・トレーサビリティによる選別は価格・成約側の論点）
//   CN:    HOSO中心の期間が最も長い
//   OTHER: 平均的な後発

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeMarketProductMix,
  ProductLifecycleParameters,
  PRODUCT_LIFECYCLE_PARAMETERS_MARKET_EVOLUTION_V1,
  PRODUCT_LIFECYCLE_PARAMETERS_V1,
} from "../productLifecycle";
import { DEMAND_MARKET_IDS, DemandMarketId } from "../types";

const TUNED = PRODUCT_LIFECYCLE_PARAMETERS_MARKET_EVOLUTION_V1;
const HORIZON = 32;

/** 市場×商品の構成比が最も大きく伸びたturn（加速のピーク）。 */
function peakGrowthTurn(market: DemandMarketId, product: "pd" | "vap", params: ProductLifecycleParameters): number {
  let bestDelta = -Infinity;
  let bestTurn = 1;
  for (let turn = 2; turn <= HORIZON; turn += 1) {
    const delta = computeMarketProductMix(turn, params)[market][product] - computeMarketProductMix(turn - 1, params)[market][product];
    if (delta > bestDelta) {
      bestDelta = delta;
      bestTurn = turn;
    }
  }
  return bestTurn;
}

function shareAt(turn: number, market: DemandMarketId, product: "hoso" | "pd" | "vap", params: ProductLifecycleParameters): number {
  return computeMarketProductMix(turn, params)[market][product];
}

test("PLA-1: 【調整の目的】US市場はPDが先に、VAPが後から加速する（V1では両者が重なっていた）", () => {
  // V1（調整前）の実測: PD・VAPともに最大伸長が turn12 で完全に重なっていた。
  assert.equal(peakGrowthTurn("US", "pd", PRODUCT_LIFECYCLE_PARAMETERS_V1), 12);
  assert.equal(peakGrowthTurn("US", "vap", PRODUCT_LIFECYCLE_PARAMETERS_V1), 12);

  // 調整後: PDが先（turn10）、VAPが後（turn16）。
  const pdPeak = peakGrowthTurn("US", "pd", TUNED);
  const vapPeak = peakGrowthTurn("US", "vap", TUNED);
  assert.equal(pdPeak, 10);
  assert.equal(vapPeak, 16);
  assert.ok(vapPeak - pdPeak >= 4, `USはPD加速からVAP加速まで4四半期以上の時間差があるべき（実測 ${vapPeak - pdPeak}）`);
});

test("PLA-2: 調整はUS市場のみで、他の4市場はV1と完全に一致する", () => {
  for (const market of DEMAND_MARKET_IDS) {
    if (market === "US") continue;
    for (let turn = 1; turn <= HORIZON; turn += 1) {
      const v1: Readonly<Record<'hoso' | 'pd' | 'vap', number>> = computeMarketProductMix(turn, PRODUCT_LIFECYCLE_PARAMETERS_V1)[market];
      const tuned: Readonly<Record<'hoso' | 'pd' | 'vap', number>> = computeMarketProductMix(turn, TUNED)[market];
      assert.deepEqual(tuned, v1, `${market} turn=${turn}: 調整対象外の市場が変化している`);
    }
  }
  // USも到達点（成熟構成比）は変わらない。変えたのは加速の時期だけ。
  assert.equal(shareAt(HORIZON, "US", "pd", TUNED), shareAt(HORIZON, "US", "pd", PRODUCT_LIFECYCLE_PARAMETERS_V1));
  assert.equal(shareAt(HORIZON, "US", "vap", TUNED), shareAt(HORIZON, "US", "vap", PRODUCT_LIFECYCLE_PARAMETERS_V1));
});

test("PLA-3: JP市場はPDが大きいまま安定し、VAPが3倍規模へ伸びる", () => {
  const pdStart = shareAt(1, "JP", "pd", TUNED);
  const pdEnd = shareAt(HORIZON, "JP", "pd", TUNED);
  const vapStart = shareAt(1, "JP", "vap", TUNED);
  const vapEnd = shareAt(HORIZON, "JP", "vap", TUNED);

  // 開始時点でJPのPD構成比は全市場中で最大（＝既にPDが定着している市場）。
  for (const market of DEMAND_MARKET_IDS) {
    if (market === "JP") continue;
    assert.ok(pdStart >= shareAt(1, market, "pd", TUNED), `turn1: JPのPD構成比が ${market} 以上であるべき`);
  }
  // PDは「安定」＝伸び幅が小さい。VAPは「成長」＝3倍規模。
  assert.ok(pdEnd - pdStart <= 0.08, `JPのPDは安定的（伸び幅0.08pt以下。実測 ${pdEnd - pdStart}）`);
  assert.ok(vapEnd / vapStart >= 3 - 1e-9, `JPのVAPは3倍以上に伸びる（実測 ${vapEnd / vapStart}倍）`);
  assert.ok(vapEnd - vapStart > pdEnd - pdStart, "JPではVAPの伸び幅がPDの伸び幅を上回る");
});

test("PLA-4: CN市場はHOSO中心の期間が最も長く、PD/VAPの加速が最も遅い", () => {
  // 全turnでCNのHOSO構成比が最大であり続ける。
  for (let turn = 1; turn <= HORIZON; turn += 1) {
    for (const market of DEMAND_MARKET_IDS) {
      if (market === "CN") continue;
      assert.ok(
        shareAt(turn, "CN", "hoso", TUNED) >= shareAt(turn, market, "hoso", TUNED) - 1e-12,
        `turn=${turn}: CNのHOSO構成比が ${market} 以上であるべき`
      );
    }
  }
  // PD/VAPの加速ピークが全市場中で最も遅い。
  for (const product of ["pd", "vap"] as const) {
    const cnPeak = peakGrowthTurn("CN", product, TUNED);
    for (const market of DEMAND_MARKET_IDS) {
      if (market === "CN") continue;
      assert.ok(
        cnPeak >= peakGrowthTurn(market, product, TUNED),
        `${product}: CNの加速ピーク(${cnPeak})が ${market}(${peakGrowthTurn(market, product, TUNED)}) 以降であるべき`
      );
    }
  }
  // CN内でもVAPはPDより遅れる。
  assert.ok(peakGrowthTurn("CN", "vap", TUNED) > peakGrowthTurn("CN", "pd", TUNED), "CNではVAP加速がPD加速より遅い");
});

test("PLA-5: EU市場はPD/VAPへ実際に移行する（HOSOが縮小し、VAPが3倍以上へ）", () => {
  const hosoStart = shareAt(1, "EU", "hoso", TUNED);
  const hosoEnd = shareAt(HORIZON, "EU", "hoso", TUNED);
  const vapStart = shareAt(1, "EU", "vap", TUNED);
  const vapEnd = shareAt(HORIZON, "EU", "vap", TUNED);

  assert.ok(hosoEnd < hosoStart, `EUのHOSO構成比は縮小する（${hosoStart} → ${hosoEnd}）`);
  assert.ok(vapEnd / vapStart >= 3, `EUのVAPは3倍以上に伸びる（実測 ${vapEnd / vapStart}倍）`);
  assert.ok(shareAt(HORIZON, "EU", "pd", TUNED) > shareAt(1, "EU", "pd", TUNED), "EUのPD構成比も拡大する");
});

test("PLA-6: 全市場・全turnで行和=1が保たれ、HOSOが消滅しない", () => {
  for (let turn = 1; turn <= HORIZON; turn += 1) {
    const mix = computeMarketProductMix(turn, TUNED);
    for (const market of DEMAND_MARKET_IDS) {
      const sum = mix[market].hoso + mix[market].pd + mix[market].vap;
      assert.ok(Math.abs(sum - 1) < 1e-9, `turn=${turn} ${market}: 行和が1でない（${sum}）`);
      assert.ok(mix[market].hoso >= 0.25, `turn=${turn} ${market}: HOSO構成比が過小（${mix[market].hoso}）`);
    }
  }
});
