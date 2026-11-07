// ShrimpX V2 — 参加者画面（/v2/play/workspace）のパネルに対する 2026-11 UI監査の回帰テスト
//
//   ③ 国内原料の価格が Turn1 で "0.000 USD/kg" と出ていた
//   ④ 「原料在庫」の意味が画面ごとに違っていた
//   ⑦ 市場集中の説明が Run の設定と食い違い、見出しが Turn2 でも「開始時の市場情報」のままだった
//   ⑨ Inventory タブに期首在庫が出なかった
//
// view / snapshot は型どおりの最小フィクスチャを使う（ここで検証するのは
// 「渡された確定値をどう書くか」であって、値の作り方ではない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PlayerCompetitorPanel,
  PlayerInventoryPanel,
  PlayerMarketPanel,
  type PlayerOpeningInventory,
} from "../WorkspacePanels";
import type { PlayerMarketView } from "../../../../lib/v2/player/workspaceViews";
import type { PublicCompetitorSnapshot } from "../../../../lib/v2/companyLab/publicCompetitorSnapshot";

function marketView(overrides: Partial<PlayerMarketView> = {}): PlayerMarketView {
  return {
    observedDemandSourceQuarter: null,
    observationLagQuarters: 2,
    cells: [
      { market: "JP", product: "hoso", observedDemandTons: 1000, basePriceUsdPerKg: 7.5, basePriceSource: "GAME_START_MARKET_INFORMATION" },
      { market: "JP", product: "pd", observedDemandTons: 500, basePriceUsdPerKg: 9.1, basePriceSource: "GAME_START_MARKET_INFORMATION" },
      { market: "JP", product: "vap", observedDemandTons: 300, basePriceUsdPerKg: 11.2, basePriceSource: "GAME_START_MARKET_INFORMATION" },
    ],
    tsvRanking: [],
    tsvRankingHiddenReason: "まだ出せません。",
    vietnamDomesticPriorPrice: 0,
    sourceNote: "出所の注記。",
    ...overrides,
  } as PlayerMarketView;
}

function competitorSnapshot(overrides: Partial<PublicCompetitorSnapshot> = {}): PublicCompetitorSnapshot {
  return {
    sourceTurn: 1,
    source: "GAME_START_BACKLOG",
    cells: [
      {
        market: "JP",
        product: "hoso",
        crowding: null,
        shares: [{ companyId: "BAL", band: "medium", trend: null, exactShare: 0.2 }],
      },
    ],
    salesForce: [{ companyId: "BAL", approximateHeadcount: 20, approximateChange: null }],
    investments: [],
    factoryCounts: [],
    ...overrides,
  } as unknown as PublicCompetitorSnapshot;
}

// ---------------------------------------------------------------------- ③
test("PANEL-3a【0.000と書かない】: 前期価格が無いTurnでは未確定と書き、開始時の参考価格を併記する", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlayerMarketPanel, { view: marketView(), domesticReferencePriceUsdPerKg: 3.16 })
  );
  assert.ok(html.includes('data-testid="play-market-domestic-raw-price"'));
  assert.ok(!html.includes("0.000 USD/kg"), "価格が0であるかのような表示が残っている");
  assert.ok(html.includes("未確定"), "未確定であることが書かれていない");
  assert.ok(html.includes("3.16"), "開始時の参考価格が併記されていない");
});

test("PANEL-3b【参考価格が無ければ作らない】: 渡されないときは金額を出さずに未確定だけを書く", () => {
  const html = renderToStaticMarkup(React.createElement(PlayerMarketPanel, { view: marketView() }));
  assert.ok(html.includes("未確定"));
  assert.ok(!html.includes("3.16"));
});

test("PANEL-3c【実績があるときは従来どおり】: 前期価格が正なら金額を出す", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlayerMarketPanel, { view: marketView({ vietnamDomesticPriorPrice: 2.613 }), domesticReferencePriceUsdPerKg: 3.16 })
  );
  assert.ok(html.includes("2.613 USD/kg"));
  assert.ok(!html.includes("未確定"));
});

// ---------------------------------------------------------------------- ⑦
test("PANEL-7a【需要と基準価格の出所を分ける】: 需要の出所と基準価格の出所が別のバッジになる", () => {
  const html = renderToStaticMarkup(React.createElement(PlayerMarketPanel, { view: marketView() }));
  assert.ok(html.includes('data-testid="play-market-source-badge"'));
  assert.ok(html.includes('data-testid="play-market-price-source-badge"'), "基準価格の出所バッジが無い");
  assert.ok(html.includes("需要: 開始時の市場情報"), "需要の出所であることが書かれていない");
  assert.ok(html.includes("基準価格: 開始時の市場情報"));
});

test("PANEL-7b【Turn2で基準価格は前Turn実績になる】: 需要が未観測でも価格の出所は別に書かれる", () => {
  const view = marketView({
    observedDemandSourceQuarter: null,
    cells: marketView().cells.map((c) => ({ ...c, basePriceSource: "LAST_QUARTER_MARKET_RESULT" })),
  });
  const html = renderToStaticMarkup(React.createElement(PlayerMarketPanel, { view }));
  assert.ok(html.includes("需要: 開始時の市場情報"), "需要側はまだ開始時情報のまま");
  assert.ok(html.includes("基準価格: 前 Turn の市場実績"), "価格側が前Turn実績だと書かれていない");
});

test("PANEL-7c【モデルの事実で説明する】: Crowdingが有効なRunで「働かない」と書かない", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlayerCompetitorPanel, { snapshot: competitorSnapshot(), crowdingPriceMarkdownActive: true })
  );
  assert.ok(!html.includes("価格下落が働きません"), "有効なRunで「働かない」と書いている");
  assert.ok(html.includes("価格下落が働きますが"), "有効だがデータがまだ無い旨が書かれていない");
});

test("PANEL-7d【無効なRunでは従来どおり】: Crowdingが無効なRunでは働かないと書く", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlayerCompetitorPanel, { snapshot: competitorSnapshot(), crowdingPriceMarkdownActive: false })
  );
  assert.ok(html.includes("価格下落は働きません"));
});

test("PANEL-7e【設定が分からないときは断定しない】: 渡されないときはデータの有無だけを書く", () => {
  const html = renderToStaticMarkup(React.createElement(PlayerCompetitorPanel, { snapshot: competitorSnapshot() }));
  assert.ok(!html.includes("価格下落は働きません"), "設定を知らないのにモデルの性質を断定している");
  assert.ok(html.includes("混雑度の記録がこの Turn には無い"), "記録が無いことだけを書く形になっていない");
});

// ------------------------------------------------------------------- ④ / ⑨
const opening: PlayerOpeningInventory = {
  finishedGoodsTons: 766,
  rawMaterialAvailableTons: 3000,
  rawMaterialPendingTons: 4316,
  backlogTons: 1200,
};

test("PANEL-9a【Turn1でも期首在庫を出す】: 確定実績が無いときに期首の原料・完成品・受注残を出す", () => {
  const html = renderToStaticMarkup(React.createElement(PlayerInventoryPanel, { view: null, opening }));
  assert.ok(html.includes('data-testid="play-inventory-opening"'), "期首在庫の枠が出ていない");
  assert.ok(html.includes("3,000"), "期首の使用可能な原料が出ていない");
  assert.ok(html.includes("4,316"), "輸送中・養殖中の原料が出ていない");
  assert.ok(html.includes("766"), "期首の完成品在庫が出ていない");
});

test("PANEL-9b【期首在庫が無ければ従来どおり】: opening が渡されないときは枠を出さない", () => {
  const html = renderToStaticMarkup(React.createElement(PlayerInventoryPanel, { view: null }));
  assert.ok(!html.includes('data-testid="play-inventory-opening"'));
  assert.ok(html.includes("まだ確定した四半期が無い"), "理由が書かれていない");
});

test("PANEL-4a【原料在庫の意味を書き分ける】: 実績側は「使用可能分のみ」と明記する", () => {
  const view = {
    newContractedTons: 0,
    fulfilledTons: 0,
    backlogTons: 0,
    previousBacklogTons: null,
    overdueTons: 0,
    overdueIsSignificant: false,
    finishedGoodsInventoryTons: 100,
    rawMaterialInventoryTons: 0,
    equipmentUtilizationRate: 0.5,
    laborUtilizationRate: 0.5,
  };
  const html = renderToStaticMarkup(React.createElement(PlayerInventoryPanel, { view }));
  assert.ok(html.includes("原料在庫（使用可能分のみ）"), "使用可能分だけであることが書かれていない");
});
