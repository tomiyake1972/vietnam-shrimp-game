// ShrimpX V2 — 2026-11 テストプレイ指摘のうち、表示側で直したものの回帰テスト
//
// ③ 生産計画の数字がタブ間で食い違って見える問題
//    PROCUREMENT の「Planned Production 計画生産量」は制約適用**前**の計画値、
//    PRODUCTION の凍結・包装の数字は制約適用**後**の処理見込みで、別の指標である。
//    見出しが「現在の処理計画」だったため同じものに見えていた。
//    → 見出しを「現在の処理見込み（制約適用後）」に変え、両者の違いを注記した。
//
// 実際に React で描画した HTML に対して検証する（本物の fixture・本物のAI初期下書き）。

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProductionPlanningScreen from "../components/decisionStudio/ProductionPlanningScreen";
import { buildInitialDraft } from "../decisionDraft";
import { buildDecisionStudioViewModel } from "../decisionStudioViewModel";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../lib/v2/companyLab";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";
import { computeBacklogSemantics } from "../../../lib/v2/companyLab/aiManagementMeeting/backlogSemantics";
import { toYearQuarter } from "../../../lib/v2/core/period";

function renderProduction(): string {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "testplay-display-fixes", turns: 6 });
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const ai = generateStandardAiDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  const vm = buildDecisionStudioViewModel({ fixture, ownState, draft, period: state.currentPeriod });
  const yq = toYearQuarter(state.currentPeriod);
  const backlogSemantics = computeBacklogSemantics(ownState.contracts, ownState.companyId, yq.year, yq.quarter);
  return renderToStaticMarkup(React.createElement(ProductionPlanningScreen, { draft, onChange: () => {}, disabled: false, vm, backlogSemantics }));
}

test("DISPLAY-3a【計画値と見込み値を取り違えない】: 凍結・包装の列見出しが「処理見込み（制約適用後）」になっている", () => {
  const html = renderProduction();
  assert.ok(html.includes("現在の処理見込み（制約適用後）"), "新しい見出しが出ていない");
  assert.ok(!html.includes(">現在の処理計画<"), "古い見出し「現在の処理計画」が残っている（計画生産量と誤解される）");
});

test("DISPLAY-3b【違いを本文で説明する】: 計画生産量との違いを述べた注記が出ている", () => {
  const html = renderProduction();
  assert.ok(html.includes('data-testid="cold-storage-forecast-note"'), "注記が出ていない");
  assert.ok(html.includes("Planned Production 計画生産量"), "注記が PROCUREMENT 側の項目名に言及していない");
  assert.ok(html.includes("制約を適用する前の計画値"), "注記が「制約適用前/後」の違いを説明していない");
});

test("DISPLAY-3c【使用率の分母を明示する】: 処理能力使用率の見出しに分母が書いてある", () => {
  const html = renderProduction();
  assert.ok(html.includes("処理能力使用率（見込み÷実効能力）"), "使用率の分母が見出しに書かれていない");
});
