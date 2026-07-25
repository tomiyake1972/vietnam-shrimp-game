// ShrimpX V2 — 市場情報パネル（Phase 8C-3D） 表示用データ層テスト
//
// 検証項目:
//   1. 消費国（仕向市場）×商品の一覧が5市場×3商品すべて揃う
//   2. 表示価格が既存エンジン関数（deriveMarketReferencePrices）の出力と厳密に一致する
//      （表示用データ層が価格を再計算していないこと）
//   3. 産地国×商品のFOB価格が確定結果の保存値そのものである
//   4. 前四半期の確定marketResultがある場合、前期比 = (当期-前期)/前期 に一致する
//   5. 前四半期の確定marketResultが無い場合、PD/VAP・国内原料価格の前期比は
//      0ではなくnull（画面では「-」）になる
//   6. 前四半期が無い場合でも、HOSOは確定結果に保存済みのpriorPriceを使って前期比が出る
//   7. NaN・Infinityを画面へ出さない（前期価格0近傍でも前期比はnullに落ちる）
//   8. 同一入力で結果が再現する（決定論）

import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateMarketQuarter } from "../../../lib/v2/market/index";
import { MARKET_PARAMETERS_V1 } from "../../../lib/v2/market/parameters";
import { createRandomStream } from "../../../lib/v2/core/random";
import { unwrapUnit, usdPerHosoEqKg } from "../../../lib/v2/core/units";
import { COUNTRY_IDS, DEMAND_MARKET_IDS, MarketQuarterResult } from "../../../lib/v2/market/types";
import { deriveMarketReferencePrices } from "../../../lib/v2/market/destinationPricing";
import {
  CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS,
  DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1,
} from "../../../lib/v2/market/destinationPricingParameters";
import { baseMarketQuarterInput, scaleAllCountriesProduction } from "../../../lib/v2/market/__tests__/fixtures";
import {
  MARKET_PANEL_PRODUCTS,
  buildDestinationMarketPriceRows,
  buildDestinationPriceExplanation,
  buildMarketIndicatorRows,
  buildOriginCountryPriceRows,
} from "../marketPriceViewModel";

function marketResultFor(seed: string, productionFactor = 1): MarketQuarterResult {
  const input = scaleAllCountriesProduction(baseMarketQuarterInput(), productionFactor);
  return calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream(seed));
}

/** 当期・前期として明確に価格が違う2つの確定結果（供給量を変えて価格差を作る）。 */
function currentAndPrevious(): { readonly current: MarketQuarterResult; readonly previous: MarketQuarterResult } {
  return { current: marketResultFor("qoq-current", 0.85), previous: marketResultFor("qoq-previous", 1.15) };
}

// ---------------------------------------------------------------------
// 1・2. 消費国（仕向市場）別の一覧
// ---------------------------------------------------------------------

test("消費国別一覧: 5市場×3商品すべての価格が揃い、有限数である", () => {
  const rows = buildDestinationMarketPriceRows(marketResultFor("destination-rows"), null);
  assert.equal(rows.length, DEMAND_MARKET_IDS.length);
  assert.deepEqual(
    rows.map((r) => r.market),
    [...DEMAND_MARKET_IDS]
  );
  assert.equal(MARKET_PANEL_PRODUCTS.length, 3);
  for (const row of rows) {
    for (const product of MARKET_PANEL_PRODUCTS) {
      const cell = row[product];
      assert.ok(Number.isFinite(cell.price), `${row.market}/${product} の価格が有限数でない`);
      assert.ok(cell.price > 0);
    }
    // 同じ市場の中では HOSO < PD < VAP（プレミアムが積み上がる構造）。
    assert.ok(row.hoso.price < row.pd.price, `${row.market}: HOSO < PD が成り立たない`);
    assert.ok(row.pd.price < row.vap.price, `${row.market}: PD < VAP が成り立たない`);
  }
});

test("消費国別一覧: 表示価格が既存エンジン関数deriveMarketReferencePricesの出力と厳密に一致する（再計算していない）", () => {
  const marketResult = marketResultFor("no-recalc");
  const expected = deriveMarketReferencePrices(marketResult, CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS);
  const rows = buildDestinationMarketPriceRows(marketResult, null);
  for (const row of rows) {
    for (const product of MARKET_PANEL_PRODUCTS) {
      assert.equal(row[product].price, unwrapUnit(expected[row.market][product]), `${row.market}/${product} が一致しない`);
    }
  }
});

test("消費国別一覧: 中立係数（全1.0）を渡すと5市場すべて同じ価格になる（係数の適用経路が正しい）", () => {
  const marketResult = marketResultFor("neutral-coefficients");
  const rows = buildDestinationMarketPriceRows(marketResult, null, DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1);
  for (const product of MARKET_PANEL_PRODUCTS) {
    const prices = rows.map((r) => r[product].price);
    for (const p of prices) {
      assert.ok(Math.abs(p - prices[0]) < 1e-9, `中立係数なのに ${product} の市場間で価格が違う`);
    }
  }
});

test("消費国別一覧: 現行係数では市場ごとに価格差がつく（一覧化の意味がある）", () => {
  const rows = buildDestinationMarketPriceRows(marketResultFor("differentiated"), null);
  const vapPrices = rows.map((r) => r.vap.price);
  const min = Math.min(...vapPrices);
  const max = Math.max(...vapPrices);
  assert.ok(max - min > 1e-6, "VAP価格が全市場で同一になっている（係数が効いていない）");
});

// ---------------------------------------------------------------------
// 3. 産地国別のFOB価格
// ---------------------------------------------------------------------

test("産地国別一覧: 4か国×3商品が確定結果の保存値そのままである", () => {
  const marketResult = marketResultFor("origin-rows");
  const rows = buildOriginCountryPriceRows(marketResult, null);
  assert.deepEqual(
    rows.map((r) => r.country),
    [...COUNTRY_IDS]
  );
  for (const row of rows) {
    assert.equal(row.hoso.price, unwrapUnit(marketResult.hosoPrices[row.country].price));
    assert.equal(row.pd.price, unwrapUnit(marketResult.pdPremium.byCountry[row.country].finalPrice));
    assert.equal(row.vap.price, unwrapUnit(marketResult.vapPremium.byCountry[row.country].finalPrice));
  }
});

// ---------------------------------------------------------------------
// 4. 前四半期の確定結果がある場合の前期比
// ---------------------------------------------------------------------

test("前期比: 前四半期の確定結果がある場合、(当期-前期)/前期 と一致し、データ源がpreviousQuarterになる", () => {
  const { current, previous } = currentAndPrevious();
  const expectedPrevious = deriveMarketReferencePrices(previous, CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS);
  const rows = buildDestinationMarketPriceRows(current, previous);
  for (const row of rows) {
    for (const product of MARKET_PANEL_PRODUCTS) {
      const cell = row[product];
      const prior = unwrapUnit(expectedPrevious[row.market][product]);
      assert.equal(cell.source, "previousQuarter");
      assert.equal(cell.priorPrice, prior);
      assert.ok(cell.changeRatio !== null);
      assert.ok(Math.abs((cell.changeRatio as number) - (cell.price - prior) / prior) < 1e-12);
    }
  }
});

test("前期比: 産地国別も前四半期の確定結果と比較する（PD・VAPを含む）", () => {
  const { current, previous } = currentAndPrevious();
  const rows = buildOriginCountryPriceRows(current, previous);
  for (const row of rows) {
    for (const product of MARKET_PANEL_PRODUCTS) {
      assert.equal(row[product].source, "previousQuarter");
      assert.ok(row[product].changeRatio !== null, `${row.country}/${product} の前期比が出ていない`);
    }
    assert.equal(row.pd.priorPrice, unwrapUnit(previous.pdPremium.byCountry[row.country].finalPrice));
    assert.equal(row.vap.priorPrice, unwrapUnit(previous.vapPremium.byCountry[row.country].finalPrice));
  }
});

test("前期比: 基礎指標（国内原料価格・プレミアム・世界需給）が前四半期と比較される", () => {
  const { current, previous } = currentAndPrevious();
  const rows = buildMarketIndicatorRows(current, previous);
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const domestic = byKey.get("vietnamDomestic");
  assert.ok(domestic !== undefined);
  assert.equal(domestic.kind, "price");
  assert.equal(domestic.value, unwrapUnit(current.vietnamDomestic.price));
  assert.equal(domestic.priorValue, unwrapUnit(previous.vietnamDomestic.price));
  assert.equal(domestic.difference, null, "価格項目に前期差(pt)を出してはいけない");
  assert.ok(domestic.changeRatio !== null);

  const balance = byKey.get("worldSupplyDemandBalance");
  assert.ok(balance !== undefined);
  assert.equal(balance.kind, "ratio");
  assert.equal(balance.changeRatio, null, "比率項目に「比の比」を出してはいけない");
  assert.ok(balance.difference !== null);
  assert.ok(Math.abs((balance.difference as number) - (current.worldSupplyDemandBalance - previous.worldSupplyDemandBalance)) < 1e-12);
});

// ---------------------------------------------------------------------
// 5・6. 前四半期の確定結果が無い場合（初回四半期）
// ---------------------------------------------------------------------

test("前期比なし: 初回四半期ではPD・VAPの前期比が0ではなくnullになる（0で埋めない）", () => {
  const marketResult = marketResultFor("turn1");
  for (const row of buildDestinationMarketPriceRows(marketResult, null)) {
    for (const product of ["pd", "vap"] as const) {
      assert.equal(row[product].changeRatio, null, `${row.market}/${product} の前期比が0埋めされている`);
      assert.equal(row[product].priorPrice, null);
      assert.equal(row[product].source, "unavailable");
    }
  }
  for (const row of buildOriginCountryPriceRows(marketResult, null)) {
    for (const product of ["pd", "vap"] as const) {
      assert.equal(row[product].changeRatio, null, `${row.country}/${product} の前期比が0埋めされている`);
      assert.equal(row[product].source, "unavailable");
    }
  }
});

test("前期比なし: 初回四半期でも産地国HOSOは確定結果に保存済みのpriorPriceから前期比が出る", () => {
  const marketResult = marketResultFor("turn1-hoso");
  for (const row of buildOriginCountryPriceRows(marketResult, null)) {
    const storedPrior = unwrapUnit(marketResult.hosoPrices[row.country].priorPrice);
    assert.equal(row.hoso.source, "storedPriorPrice");
    assert.equal(row.hoso.priorPrice, storedPrior);
    assert.ok(row.hoso.changeRatio !== null);
    // 確定結果に保存されているchangeRatioと一致する（独自に別の式で出していない）。
    assert.ok(Math.abs((row.hoso.changeRatio as number) - marketResult.hosoPrices[row.country].changeRatio) < 1e-9);
  }
});

test("前期比なし: 初回四半期の消費国別HOSOは、保存済みVN前期価格×同じ市場係数から出る（VNのchangeRatioと一致する）", () => {
  const marketResult = marketResultFor("turn1-destination-hoso");
  const rows = buildDestinationMarketPriceRows(marketResult, null);
  const vnStoredChangeRatio = marketResult.hosoPrices.VN.changeRatio;
  for (const row of rows) {
    assert.equal(row.hoso.source, "storedPriorPrice");
    assert.ok(row.hoso.changeRatio !== null);
    // baseValueCoefficientは四半期によらない固定値なので、係数は前期比では打ち消える。
    assert.ok(
      Math.abs((row.hoso.changeRatio as number) - vnStoredChangeRatio) < 1e-9,
      `${row.market}: 消費国別HOSOの前期比がVNの保存済みchangeRatioと一致しない`
    );
  }
});

test("前期比なし: 初回四半期では基礎指標の前期欄・前期比欄がすべてnullになる", () => {
  const rows = buildMarketIndicatorRows(marketResultFor("turn1-indicators"), null);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.priorValue, null, `${row.key} の前期値が0埋めされている`);
    assert.equal(row.changeRatio, null);
    assert.equal(row.difference, null);
    assert.equal(row.source, "unavailable");
    assert.ok(Number.isFinite(row.value), `${row.key} の当期値が有限数でない`);
  }
});

// ---------------------------------------------------------------------
// 7. NaN・Infinityを画面へ出さない
// ---------------------------------------------------------------------

test("異常値: 前期価格が0の場合でも前期比はnullになり、Infinity・NaNを出さない", () => {
  const marketResult = marketResultFor("zero-prior");
  const zeroPrior: MarketQuarterResult = {
    ...marketResult,
    hosoPrices: {
      ...marketResult.hosoPrices,
      VN: { ...marketResult.hosoPrices.VN, priorPrice: usdPerHosoEqKg(0) },
      EC: { ...marketResult.hosoPrices.EC, priorPrice: usdPerHosoEqKg(0) },
    },
  };
  const destinationRows = buildDestinationMarketPriceRows(zeroPrior, null);
  for (const row of destinationRows) {
    assert.equal(row.hoso.changeRatio, null, `${row.market}: 前期価格0でInfinityが出ている`);
  }
  const ecRow = buildOriginCountryPriceRows(zeroPrior, null).find((r) => r.country === "EC");
  assert.ok(ecRow !== undefined);
  assert.equal(ecRow.hoso.changeRatio, null);

  // 全セルにNaN・Infinityが混入していないことをまとめて確認する。
  for (const row of destinationRows) {
    for (const product of MARKET_PANEL_PRODUCTS) {
      const cell = row[product];
      assert.ok(Number.isFinite(cell.price));
      assert.ok(cell.changeRatio === null || Number.isFinite(cell.changeRatio));
      assert.ok(cell.priorPrice === null || Number.isFinite(cell.priorPrice));
    }
  }
});

// ---------------------------------------------------------------------
// 8. 決定論・価格分解の説明
// ---------------------------------------------------------------------

test("決定論: 同一の確定結果から同じ一覧・同じ前期比が再現する", () => {
  const { current, previous } = currentAndPrevious();
  assert.deepEqual(buildDestinationMarketPriceRows(current, previous), buildDestinationMarketPriceRows(current, previous));
  assert.deepEqual(buildOriginCountryPriceRows(current, previous), buildOriginCountryPriceRows(current, previous));
  assert.deepEqual(buildMarketIndicatorRows(current, previous), buildMarketIndicatorRows(current, previous));
});

test("価格分解の説明: HOSO基礎価値＋PD加工プレミアム＋VAP追加プレミアムが、VNのVAP基準価格に一致する", () => {
  const marketResult = marketResultFor("explanation");
  const e = buildDestinationPriceExplanation(marketResult);
  assert.equal(e.hosoBasePrice, unwrapUnit(marketResult.hosoPrices.VN.price));
  const rebuiltVap = e.hosoBasePrice + e.pdProcessingPremium + e.vapIncrementalPremium;
  assert.ok(Math.abs(rebuiltVap - unwrapUnit(marketResult.vapPremium.byCountry.VN.finalPrice)) < 1e-9);
});
