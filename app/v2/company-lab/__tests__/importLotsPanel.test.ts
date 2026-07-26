// ShrimpX V2 — Phase 8G §5 ImportLotsPanel（輸入原料の状況）の回帰テスト
//
// 実際にrawMaterials/imports.tsのcalculateLandedPrice・createImportLots・
// receiveArrivedImportsで生成した本物のRawMaterialLotをそのまま渡して描画し、
// 「既存の輸入原価・到着時期をそのまま表示するだけで、新しい係数・判定ロジックを
// 追加していないこと」を確認する（renderToStaticMarkupを使った既存の
// marketPanelConsumerMarketWiring.test.tsと同じ手法）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ImportLotsPanel from "../components/ImportLotsPanel";
import { calculateLandedPrice, createImportLots, receiveArrivedImports } from "../../../lib/v2/rawMaterials/imports";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../../../lib/v2/rawMaterials/parameters";
import { ImportOrderInput, RawMaterialLot } from "../../../lib/v2/rawMaterials/types";
import { hosoEqTons, usdPerHosoEqKg } from "../../../lib/v2/core/units";
import { period } from "../../../lib/v2/core/period";
import { CountryId } from "../../../lib/v2/market/types";
import { formatUsdPerHosoEqKg } from "../../../lib/v2/industryLab/ui/formatters";

const P1 = period(2015, 1);
const P2 = period(2015, 2);
const P3 = period(2015, 3);

const ORIGIN_PRICE: Readonly<Record<CountryId, ReturnType<typeof usdPerHosoEqKg>>> = {
  EC: usdPerHosoEqKg(4.0),
  IN: usdPerHosoEqKg(3.5),
  ID: usdPerHosoEqKg(3.8),
  VN: usdPerHosoEqKg(4.2),
};

const ORIGIN_SUPPLY: Readonly<Record<CountryId, ReturnType<typeof hosoEqTons>>> = {
  EC: hosoEqTons(10000),
  IN: hosoEqTons(8000),
  ID: hosoEqTons(6000),
  VN: hosoEqTons(0),
};

function order(overrides: Partial<ImportOrderInput> = {}): ImportOrderInput {
  return {
    companyId: "BAL",
    originCountry: "EC",
    orderedQuantity: hosoEqTons(100),
    orderedPeriod: P1,
    ...overrides,
  };
}

/** P1に発注→標準リードタイム2ターンでP3到着、という本物の輸入ロットを1件作る。 */
function buildInTransitLot(): RawMaterialLot {
  const lots = createImportLots([order()], ORIGIN_PRICE, ORIGIN_SUPPLY, RAW_MATERIALS_PARAMETERS_V1);
  return lots[0];
}

/** 到着済み（P3時点でreceiveArrivedImportsを適用済み）の輸入ロットを1件作る。 */
function buildArrivedLot(): RawMaterialLot {
  const lots = createImportLots([order()], ORIGIN_PRICE, ORIGIN_SUPPLY, RAW_MATERIALS_PARAMETERS_V1);
  const arrived = receiveArrivedImports(lots, P3);
  return arrived[0];
}

const domesticLot: RawMaterialLot = {
  lotId: "domestic-1",
  companyId: "BAL",
  source: "domestic",
  originCountry: "VN",
  inboundPeriod: P1,
  originalQuantity: hosoEqTons(50),
  remainingQuantity: hosoEqTons(50),
  unitCost: usdPerHosoEqKg(4.2),
  availableFromPeriod: P1,
  status: "available",
};

test("§1: 輸送中の輸入ロットが、原産国・数量・輸入原価・状態・到着時期とともに描画される", () => {
  const lot = buildInTransitLot();
  const html = renderToStaticMarkup(React.createElement(ImportLotsPanel, { rawMaterialLots: [lot], currentPeriod: P1 }));

  assert.ok(html.includes("エクアドル"), "原産国名（エクアドル）が描画されていること");
  assert.ok(html.includes("（EC）"), "原産国コードが描画されていること");
  assert.ok(html.includes("輸送中"), "状態「輸送中」が描画されていること");
  assert.ok(html.includes(String(P3)), "到着時期（P3）が描画されていること");

  const breakdown = calculateLandedPrice(ORIGIN_PRICE.EC, "EC", RAW_MATERIALS_PARAMETERS_V1);
  const expectedCostText = formatUsdPerHosoEqKg(breakdown.landedPrice);
  assert.ok(html.includes(expectedCostText), `輸入原価がlandedPrice（${expectedCostText}）そのままの表示であること`);
});

test("§2: 到着済みの輸入ロットは「到着済み・利用可能」と表示される", () => {
  const lot = buildArrivedLot();
  assert.equal(lot.status, "available");

  const html = renderToStaticMarkup(React.createElement(ImportLotsPanel, { rawMaterialLots: [lot], currentPeriod: P3 }));
  assert.ok(html.includes("到着済み・利用可能"));
});

test("§3: 今期(currentPeriod)がちょうど到着予定四半期と一致する輸送中ロットには「今期到着予定」の注記が付く", () => {
  const lot = buildInTransitLot();
  assert.equal(String(lot.availableFromPeriod), String(P3));

  const htmlAtArrivalQuarter = renderToStaticMarkup(React.createElement(ImportLotsPanel, { rawMaterialLots: [lot], currentPeriod: P3 }));
  assert.ok(htmlAtArrivalQuarter.includes("今期到着予定"), "到着予定四半期と当期が一致する輸送中ロットには注記が付くこと");

  const htmlBeforeArrival = renderToStaticMarkup(React.createElement(ImportLotsPanel, { rawMaterialLots: [lot], currentPeriod: P1 }));
  assert.ok(!htmlBeforeArrival.includes("今期到着予定"), "到着予定より前の四半期では注記が付かないこと");
});

test("§4: source='domestic'（国内買付）のロットは表に含まれない（輸入原料の状況に混ざらない）", () => {
  const importLot = buildInTransitLot();
  const html = renderToStaticMarkup(
    React.createElement(ImportLotsPanel, { rawMaterialLots: [importLot, domesticLot], currentPeriod: P1 })
  );
  // 国内ロットの原産国VNは、輸入ロットの原産国EC行とは別物として出ないはず。
  assert.ok(!html.includes("ベトナム（VN）"), "国内買付ロット（source=domestic）が輸入原料の表に混入していないこと");
});

test("§5: 輸入ロットが1件も無い場合、エラーにならず「対象がない」旨のメッセージだけが表示される", () => {
  const html = renderToStaticMarkup(React.createElement(ImportLotsPanel, { rawMaterialLots: [domesticLot], currentPeriod: P1 }));
  assert.ok(html.includes("輸送中・到着済みの輸入原料はありません"));
});

test("§6: 消費済み・残数量ゼロの輸入ロットは表に出ない", () => {
  const consumedLot: RawMaterialLot = { ...buildArrivedLot(), remainingQuantity: hosoEqTons(0), status: "consumed" };
  const html = renderToStaticMarkup(React.createElement(ImportLotsPanel, { rawMaterialLots: [consumedLot], currentPeriod: P3 }));
  assert.ok(html.includes("輸送中・到着済みの輸入原料はありません"), "残数量ゼロ・消費済みのロットは対象外であること");
});

test("§7: 複数市場ぶんのロットを渡しても、NaN・Infinity・undefinedが出力に含まれない", () => {
  const lots = [buildInTransitLot(), buildArrivedLot(), domesticLot];
  const html = renderToStaticMarkup(React.createElement(ImportLotsPanel, { rawMaterialLots: lots, currentPeriod: P2 }));
  assert.ok(!html.includes("NaN"));
  assert.ok(!html.includes("Infinity"));
  assert.ok(!html.includes("undefined"));
});

test("§8: 同一の入力を2回描画しても完全に同じHTMLになる（再読込で変化しないことの確認）", () => {
  const lots = [buildInTransitLot(), buildArrivedLot()];
  const htmlA = renderToStaticMarkup(React.createElement(ImportLotsPanel, { rawMaterialLots: lots, currentPeriod: P2 }));
  const htmlB = renderToStaticMarkup(React.createElement(ImportLotsPanel, { rawMaterialLots: lots, currentPeriod: P2 }));
  assert.equal(htmlA, htmlB);
});

test("§9: DecisionEditor.tsxは輸入セクション内でImportLotsPanelを呼び出している（配線漏れ検知）", () => {
  const source = readFileSync(path.join(__dirname, "..", "components", "DecisionEditor.tsx"), "utf8");
  assert.ok(source.includes("<ImportLotsPanel"), "DecisionEditor.tsxがImportLotsPanelを呼び出していること");
  assert.ok(source.includes("rawMaterialLots={ownState.rawMaterialLots}"), "ownState.rawMaterialLotsがそのまま渡されていること（フィルタ済みの部分集合を渡していないこと）");
});
