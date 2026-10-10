// ShrimpX V2 — UI-TRIAL-1 §4: 入力欄と参照情報の区別
//
// 【背景】予行演習の準備で「どこを入力するか／何を提出するか」が分かりにくい、
// という指摘を受けた。色（既存の AREA_TONES）だけでは色の意味を知らない人へ
// 伝わらないため、文言・見出し・配置を併用する。
//
// ここで固定する契約
//   1. 入力エリアの先頭に「今期の意思決定」と対象Turn／四半期が出る。
//      すでに進行済みの四半期（disabled）では入力の案内を出さない。
//   2. AI初期提案は「初期入力済み・まだ提出していない」と説明される。
//      項目ごとのAI由来／手動由来は推測して表示しない。
//   3. 参照値には種別（前期実績・現在の状態・参考値・自動計算値）が付く。
//   4. 参照値は入力欄として描かれない（<input> ではない）。
//   5. 入力列と読み取り専用列が混ざる表では、見出しにどちらかを文言で書く。
//
// 実際に React で描画した HTML に対して検証する（本物の fixture・本物の AI 初期下書き）。

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DecisionStudio from "../components/decisionStudio/DecisionStudio";
import WorkforcePlanningScreen from "../components/decisionStudio/WorkforcePlanningScreen";
import { AiInitialProposalNote, DecisionAreaHeading, ReferenceValue, REFERENCE_KINDS, ReferenceKind } from "../components/FieldAnnotations";
import { buildInitialDraft } from "../decisionDraft";
import { buildDecisionStudioViewModel } from "../decisionStudioViewModel";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../lib/v2/companyLab";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";

function setup() {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "ui-trial1-tone", turns: 6 });
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const ai = generateStandardAiDecision(fixture, ownState, buildPublicMarketInfo(state), state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  return { state, fixture, ownState, draft };
}

function renderStudio(disabled: boolean): string {
  const { state, fixture, ownState, draft } = setup();
  return renderToStaticMarkup(
    React.createElement(DecisionStudio, {
      fixture,
      ownState,
      draft,
      onChange: () => {},
      disabled,
      period: state.currentPeriod,
      turn: state.scenarioState.currentTurn,
      companyName: fixture.displayName,
    })
  );
}

test("UIT1-R1: 入力エリアの先頭に「今期の意思決定」と対象Turnが出る", () => {
  const html = renderStudio(false);
  assert.ok(html.includes('data-testid="decision-studio-decision-heading"'), "入力エリアの見出しが無い");
  assert.ok(html.includes("今期の意思決定"), "「今期の意思決定」の文言が無い");
  assert.ok(html.includes('data-testid="decision-area-heading-turn"'), "対象Turn／四半期の表示が無い");
  assert.ok(/Turn\s*\d+/.test(html), "Turn 番号が表示されていない");
});

test("UIT1-R2: すでに進行済みの四半期では入力の案内を出さない", () => {
  const html = renderStudio(true);
  assert.ok(!html.includes('data-testid="decision-studio-decision-heading"'), "進行済みなのに入力エリアの見出しが出ている");
  assert.ok(!html.includes('data-testid="decision-studio-ai-initial-note"'), "進行済みなのにAI初期提案の案内が出ている");
  // 進行済みであること自体は従来どおり示す。
  assert.ok(html.includes("この四半期はすでに進行済みです"), "進行済みの表示が消えている");
});

test("UIT1-R3: AI初期提案は「初期入力済み・まだ提出していない」と説明され、項目別の由来は表示しない", () => {
  const html = renderStudio(false);
  assert.ok(html.includes('data-testid="decision-studio-ai-initial-note"'), "AI初期提案の説明が無い");
  assert.ok(html.includes("AI提案を初期入力済み"), "「AI提案を初期入力済み」の文言が無い");
  assert.ok(html.includes("まだ提出していません"), "未提出であることが書かれていない");
  // 項目ごとの由来（AI由来／手動由来）を推測して出していないこと。
  assert.ok(!html.includes("AI由来</"), "項目ごとのAI由来ラベルが出ている（推測表示）");
  assert.ok(!html.includes("手動由来"), "項目ごとの手動由来ラベルが出ている（推測表示）");
});

test("UIT1-R4: 参照値には種別が付き、入力欄としては描かれない", () => {
  for (const kind of Object.keys(REFERENCE_KINDS) as ReferenceKind[]) {
    const html = renderToStaticMarkup(
      React.createElement(ReferenceValue, { label: "テスト項目", kind, value: 123, unit: "人", testId: "ref-under-test" })
    );
    assert.ok(html.includes(`data-reference-kind="${kind}"`), `参照種別が付いていない: ${kind}`);
    assert.ok(html.includes(REFERENCE_KINDS[kind].label), `参照種別のラベル文言が無い: ${kind}`);
    assert.ok(!html.includes("<input"), `参照値が入力欄として描かれている: ${kind}`);
    assert.ok(!html.includes("<select"), `参照値が選択欄として描かれている: ${kind}`);
  }
});

test("UIT1-R5: 参照値は値が無いとき0で埋めずに「－」を出す", () => {
  const html = renderToStaticMarkup(React.createElement(ReferenceValue, { label: "未取得の値", kind: "actual", value: null }));
  assert.ok(html.includes("－"), "値が無いときの表示が「－」になっていない");
  assert.ok(!html.includes(">0<"), "値が無いのに0を表示している");
});

test("UIT1-R6: 入力列と読み取り専用列が混ざる表では、見出しに入力か参照かを書く", () => {
  const { fixture, ownState, draft, state } = setup();
  const vm = buildDecisionStudioViewModel({ fixture, ownState, draft, period: state.currentPeriod });
  const html = renderToStaticMarkup(
    React.createElement(WorkforcePlanningScreen, { draft, onChange: () => {}, disabled: false, vm })
  );
  assert.ok(html.includes('data-testid="worker-assignment-table-head"'), "ワーカー配置の表の見出しが見つからない");
  // 入力列は「入力」と明記される。
  for (const testId of ["worker-col-headcount-change", "worker-col-temporary-headcount", "worker-col-overtime-rate"]) {
    assert.ok(html.includes(`data-testid="${testId}"`), `入力列の見出しが無い: ${testId}`);
  }
  assert.ok(html.includes('data-column-kind="input"'), "入力列であることが見出しに書かれていない");
  // 読み取り専用列は参照種別が書かれる。
  assert.ok(html.includes('data-column-kind="derived"'), "自動計算値の列が参照種別として書かれていない");
  assert.ok(html.includes('data-column-kind="current"'), "現在の状態の列が参照種別として書かれていない");
  assert.ok(html.includes('data-column-kind="reference"'), "参考値の列が参照種別として書かれていない");
});

test("UIT1-R7: 入力欄には対象（市場・商品・工場）込みの読み上げ名が付く", () => {
  const { fixture, ownState, draft, state } = setup();
  const vm = buildDecisionStudioViewModel({ fixture, ownState, draft, period: state.currentPeriod });
  const html = renderToStaticMarkup(
    React.createElement(WorkforcePlanningScreen, { draft, onChange: () => {}, disabled: false, vm })
  );
  const factoryId = draft.workerAssignments[0]?.factoryId;
  assert.ok(factoryId !== undefined, "前提: 工場が1つ以上ある");
  assert.ok(html.includes(`aria-label="${factoryId} の臨時人数（人）"`), "臨時人数の入力欄に対象（工場）込みの読み上げ名が無い");
  assert.ok(html.includes(`aria-label="${factoryId} の残業率（0〜1）"`), "残業率の入力欄に対象（工場）込みの読み上げ名が無い");
});

test("UIT1-R8: 見出しと注記は単独で描画できる（他画面でも同じ表現を使い回せる）", () => {
  const heading = renderToStaticMarkup(React.createElement(DecisionAreaHeading, { turnLabel: "Turn 9（2026-Q1）" }));
  assert.ok(heading.includes("今期の意思決定"));
  assert.ok(heading.includes("Turn 9（2026-Q1）"));
  const note = renderToStaticMarkup(React.createElement(AiInitialProposalNote, {}));
  assert.ok(note.includes("AI提案を初期入力済み"));
});
