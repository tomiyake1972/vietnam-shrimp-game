// ShrimpX V2 — UI-CLARITY-1 A-8: ゲーム開始時点（Turn1）の市場×商品参照価格
//
// 検査する内容は3つに分かれる。
//   (1) 開始時点の表そのもの（15セルが揃うか、engineの式どおりの大小関係になるか）
//   (2) その表が「実在する初期契約の単価」を再現しているか（＝数値を発明していないことの検査）
//   (3) プレイヤー画面とStandard AIが同じ値を見るか（情報境界）
//
// 【この表の値を変えたとき】(2)の許容幅を緩めて通すのではなく、
// initialContracts.ts と突き合わせて導出をやり直すこと。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildGameStartMarketReferencePrice,
  gameStartPriceDecomposition,
  GAME_START_HOSO_BASE_PRICE_USD_PER_KG,
  GAME_START_PD_PROCESSING_PREMIUM_USD_PER_KG,
  GAME_START_VAP_INCREMENTAL_PREMIUM_USD_PER_KG,
} from "../gameStartReferencePrice";
import { computeMarketReferencePrice } from "../destinationPricing";
import {
  CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS,
  DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1,
} from "../destinationPricingParameters";
import { DEMAND_MARKET_IDS, type DemandMarketId, type Product } from "../types";
import { unwrapUnit } from "../../core/units";
import { generateInitialContracts } from "../../companyLab/initialContracts";
import { parsePeriod } from "../../core/period";
import { referencePricesByMarketProduct } from "../../companyLab/standardAi/observation";
import { resolveMarketBasePriceReferences, projectMarketBasePriceReferences } from "../../sales/marketBasePriceReference";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/**
 * 実在の初期契約（companyLab/initialContracts.ts）から、市場×商品の数量加重平均単価を
 * 求める（契約が無いセルはundefined）。公開APIの generateInitialContracts を通して読む。
 */
const INITIAL_CONTRACTS = generateInitialContracts(parsePeriod("2015Q1"));

function initialContractWeightedPrice(market: DemandMarketId, product: Product): number | undefined {
  let quantity = 0;
  let value = 0;
  for (const c of INITIAL_CONTRACTS) {
    if (c.market !== market || c.product !== product) continue;
    const tons = unwrapUnit(c.originalQuantity);
    quantity += tons;
    value += tons * unwrapUnit(c.unitPrice);
  }
  return quantity > 0 ? value / quantity : undefined;
}

test("A8-1: 5市場×3商品の15セルすべてに正の有限な参照価格が入る", () => {
  const table = buildGameStartMarketReferencePrice();
  let cells = 0;
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const price = table.byMarketProduct[market][product];
      assert.ok(Number.isFinite(price) && price > 0, `${market}/${product} が不正: ${price}`);
      cells += 1;
    }
  }
  assert.equal(cells, 15);
  assert.equal(table.source, "GAME_START_MARKET_INFORMATION");
});

test("A8-2: 各市場で HOSO < PD < VAP になる（engineの積み上げ構造どおり）", () => {
  const table = buildGameStartMarketReferencePrice();
  for (const market of DEMAND_MARKET_IDS) {
    const { hoso, pd, vap } = table.byMarketProduct[market];
    assert.ok(hoso < pd, `${market}: hoso ${hoso} < pd ${pd} であるべき`);
    assert.ok(pd < vap, `${market}: pd ${pd} < vap ${vap} であるべき`);
  }
});

test("A8-3: 開始時点の表は、実在する初期契約の数量加重単価を5%以内で再現する", () => {
  const table = buildGameStartMarketReferencePrice();
  let compared = 0;
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const actual = initialContractWeightedPrice(market, product);
      if (actual === undefined) continue; // 初期契約が無いセル（6セル）は突き合わせ対象外
      const derived = table.byMarketProduct[market][product];
      const deviation = Math.abs(derived - actual) / actual;
      assert.ok(
        deviation <= 0.05,
        `${market}/${product}: 導出 ${derived.toFixed(3)} と実契約 ${actual.toFixed(3)} の乖離 ${(deviation * 100).toFixed(1)}% が5%を超えた`
      );
      compared += 1;
    }
  }
  // 初期契約が存在するセルは9セル（CN/HOSO, US/HOSO, US/PD, EU/HOSO, EU/PD, EU/VAP, JP/PD, JP/VAP, OTHER/HOSO）
  assert.equal(compared, 9, "突き合わせ対象セル数が変わった（initialContracts.tsの変更を確認する）");
});

test("A8-4: 市場係数の方向性（§13の表）が表に現れる — VAPはJPが最高・CNが最低", () => {
  const table = buildGameStartMarketReferencePrice();
  const vapByMarket = DEMAND_MARKET_IDS.map((m) => ({ market: m, price: table.byMarketProduct[m].vap }));
  const sorted = [...vapByMarket].sort((a, b) => b.price - a.price);
  assert.equal(sorted[0].market, "JP");
  assert.equal(sorted[sorted.length - 1].market, "CN");
});

test("A8-5: 表はengineのcomputeMarketReferencePriceの出力そのもの（独自計算をしていない）", () => {
  const table = buildGameStartMarketReferencePrice();
  const decomposition = gameStartPriceDecomposition();
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const expected = unwrapUnit(
        computeMarketReferencePrice(decomposition, market, product, CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS)
          .marketReferencePrice
      );
      assert.equal(table.byMarketProduct[market][product], expected, `${market}/${product}`);
    }
  }
  assert.equal(unwrapUnit(decomposition.hosoBasePrice), GAME_START_HOSO_BASE_PRICE_USD_PER_KG);
  assert.equal(unwrapUnit(decomposition.pdProcessingPremium), GAME_START_PD_PROCESSING_PREMIUM_USD_PER_KG);
  assert.equal(unwrapUnit(decomposition.vapIncrementalPremium), GAME_START_VAP_INCREMENTAL_PREMIUM_USD_PER_KG);
});

test("A8-6: 中立係数を渡せば全市場で同一価格になる（係数の適用箇所が正しい）", () => {
  const table = buildGameStartMarketReferencePrice(DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1);
  for (const product of PRODUCTS) {
    const prices = DEMAND_MARKET_IDS.map((m) => table.byMarketProduct[m][product]);
    for (const price of prices) assert.equal(price, prices[0], `${product} は中立係数では市場差が出ないべき`);
  }
  assert.equal(
    table.byMarketProduct.CN.hoso,
    GAME_START_HOSO_BASE_PRICE_USD_PER_KG,
    "中立係数のHOSOは基礎価値そのもの"
  );
});

test("A8-7: 前四半期が無いとき、販売計画画面の基準価格は開始時点の表になる", () => {
  const references = resolveMarketBasePriceReferences(undefined);
  assert.ok(references !== undefined);
  assert.equal(references!.length, 15);
  const table = buildGameStartMarketReferencePrice();
  for (const ref of references!) {
    assert.equal(ref.source, "GAME_START_MARKET_INFORMATION");
    assert.equal(unwrapUnit(ref.basePrice), table.byMarketProduct[ref.market][ref.product]);
  }
  // 空配列（配分結果が1件も無い）でも同じ扱いにする
  assert.equal(resolveMarketBasePriceReferences([])!.length, 15);
});

test("A8-8: 前四半期の確定結果があるときは従来どおり、その値をそのまま射影する", () => {
  const allocations = [
    { market: "CN" as DemandMarketId, product: "hoso" as Product, basePrice: 9.99 },
  ] as unknown as Parameters<typeof projectMarketBasePriceReferences>[0];
  const references = resolveMarketBasePriceReferences(allocations);
  assert.equal(references!.length, 1);
  assert.equal(unwrapUnit(references![0].basePrice), 9.99);
  assert.equal(references![0].source, "LAST_QUARTER_MARKET_RESULT");
});

test("A8-9: 情報境界 — Turn1のStandard AIが見る参照価格は、プレイヤー画面と完全に同一である", () => {
  const aiView = referencePricesByMarketProduct(undefined);
  assert.ok(aiView !== undefined, "Turn1でもStandard AIは参照価格を持つ");
  const playerView = resolveMarketBasePriceReferences(undefined)!;
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const player = playerView.find((r) => r.market === market && r.product === product)!;
      assert.equal(aiView![market]![product], unwrapUnit(player.basePrice), `${market}/${product}`);
    }
  }
});
