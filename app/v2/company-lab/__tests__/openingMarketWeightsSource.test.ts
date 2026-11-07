// ShrimpX V2 — INFO タブ「成約競争力の需要ウェイト」が Run の実効値を示すこと
//
// 【直した問題（2026-11）】この表は SALES_PARAMETERS_V1（既定定数）を直接読んでおり、
// Run の販売モデルに関係なく常に同じ値を表示していた:
//   price 35% / coverage 25% / relationship 15% / quality 15% /
//   deliveryReliability 10% / salesBase 0% / vapCapability 0%、
//   外部選択肢 0.35、1社の最大成約シェア 35%
// 三層顧客価格モデルの Run でも vapCapability 0% と出るため、
// 「VAPに投資しても効かない」と誤読された（実際には差別化評価として効く）。

import { strict as assert } from "node:assert";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildOpeningMarketInfo } from "../play/_lib/openingInfoViewModel";
import { OpeningMarketInfoPanel } from "../components/OpeningInfoPanels";
import { buildCompanyOwnState, initializeCompanyLab } from "../../../lib/v2/companyLab";
import { SALES_PARAMETERS_V1 } from "../../../lib/v2/sales/parameters";
import type { CompanyLabConfig } from "../../../lib/v2/companyLab/types";

function factsFor(overrides: Partial<CompanyLabConfig>) {
  const config = { scenarioId: "baseline", mode: "canonical", seed: "weights-source", turns: 4, ...overrides } as CompanyLabConfig;
  const { state, fixtures } = initializeCompanyLab(config);
  const ownState = buildCompanyOwnState(state, fixtures[0]);
  assert.ok(ownState.salesModelFacts);
  return ownState.salesModelFacts;
}

function render(facts: ReturnType<typeof factsFor> | undefined): string {
  const info = buildOpeningMarketInfo(0, undefined, undefined, facts);
  return renderToStaticMarkup(React.createElement(OpeningMarketInfoPanel, { info, referencePrice: null }));
}

test("WEIGHTS-1【既定定数を素のまま出さない】: Run の実効パラメータを渡すと、その値が表示される", () => {
  const facts = factsFor({});
  const info = buildOpeningMarketInfo(0, undefined, undefined, facts);
  assert.equal(info.salesModelSource, "RUN_EFFECTIVE_PARAMETERS");
  assert.deepEqual(info.competitivenessWeights, { ...facts.competitivenessWeights });
  assert.equal(info.maximumSupplierShare, facts.maximumSupplierShare);
  assert.equal(info.externalOptionWeight, facts.externalOptionWeight);
});

test("WEIGHTS-2【既定の従来モデルは vapCapability 0% ではない】: 実測 0.08 がそのまま出る", () => {
  const facts = factsFor({});
  assert.equal(facts.marketAllocationMode, "legacyWaterfall");
  assert.ok(facts.vapCapabilityCompetitivenessWeight > 0, "既定の従来モデルでVAP能力ウェイトが0になっている");
  const html = render(facts);
  assert.ok(html.includes('data-testid="opening-market-weight-vapCapability"'), "VAP能力ウェイトの行が無い");
  // 既定定数（0%）をそのまま出していないこと。
  assert.ok(!html.includes(">0.0%<"), "ウェイトに 0.0% がそのまま出ている（既定定数を読んでいる疑い）");
});

test("WEIGHTS-3【三層顧客価格モデルでは使われない表を出さない】: 層ごとの感応度を表示する", () => {
  const facts = factsFor({ salesModelId: "tiered-v200-crowding-v1" });
  assert.equal(facts.marketAllocationMode, "tieredSimultaneousAllocation");
  assert.ok(facts.customerTiers !== undefined && facts.customerTiers.length === 3);
  const html = render(facts);
  assert.ok(html.includes('data-testid="opening-market-tier-table"'), "層ごとの表が出ていない");
  assert.ok(html.includes("価格重視層") && html.includes("標準層") && html.includes("プレミアム層"), "層の名前が出ていない");
  assert.ok(html.includes('data-testid="opening-market-weights-not-used"'), "旧モデルのウェイトが使われないことの注記が無い");
  assert.ok(!html.includes('data-testid="opening-market-weight-vapCapability"'), "使われないウェイト表をまだ出している");
  assert.ok(html.includes("差別化(VAP)"), "VAPがどの列で効くかが出ていない");
});

test("WEIGHTS-4【旧モデルでは従来の表のまま】: 従来市場モデルでは層の表を出さない", () => {
  const html = render(factsFor({ salesModelId: "legacy-waterfall-v1" }));
  assert.ok(!html.includes('data-testid="opening-market-tier-table"'));
  assert.ok(html.includes('data-testid="opening-market-weight-price"'));
});

test("WEIGHTS-5【実効値を渡せないときは断定しない】: 既定定数を使ったことを画面に明記する", () => {
  const info = buildOpeningMarketInfo(0);
  assert.equal(info.salesModelSource, "DEFAULT_PARAMETERS");
  assert.deepEqual(info.competitivenessWeights, { ...SALES_PARAMETERS_V1.competitivenessWeights });
  const html = render(undefined);
  assert.ok(html.includes("既定の設定値です"), "既定値であることが書かれていない");
  assert.ok(!html.includes("この Run が当期実際に使っている値です"));
});

test("WEIGHTS-6【英語の識別子を並べない】: ウェイトの項目名が日本語になっている", () => {
  const html = render(factsFor({ salesModelId: "legacy-waterfall-v1" }));
  assert.ok(html.includes("営業基盤（蓄積）"), "salesBase の日本語名が誤字のまま、または出ていない");
  assert.ok(html.includes("営業カバレッジ"), "coverage の日本語名が出ていない");
  assert.ok(html.includes("納期信頼性"), "deliveryReliability の日本語名が出ていない");
  assert.ok(html.includes("VAP能力"), "vapCapability の日本語名が出ていない");
});
