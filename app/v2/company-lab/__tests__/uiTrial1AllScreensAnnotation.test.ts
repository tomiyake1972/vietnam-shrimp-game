// ShrimpX V2 — UI-TRIAL-1 §1（限定仕上げ）: 入力／参照の区別を全入力画面へ
//
// 当初の指示は Decision Studio 全体の統一だった。SALES と WORKER は先に対応済みで、
// 残る PRODUCTION・PROCUREMENT・INVESTMENT・FINANCE をここで点検する。
//
// ここで固定する契約（4画面すべてについて）
//   1. 入力欄には、対象（市場／商品／工場／全社）込みの読み上げ名が付く。
//   2. 入力列と読み取り専用列が混ざる表では、見出しにどちらかを文言で書く。
//   3. 読み取り専用のまとまりには参照種別（前期実績・現在の状態・参考値・自動計算値）が付く。
//   4. 参照値は入力欄として描かれない。
//
// 実際に React で描画した HTML に対して検証する（本物の fixture・本物の AI 初期下書き）。

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProductionPlanningScreen from "../components/decisionStudio/ProductionPlanningScreen";
import InvestmentPlanningScreen from "../components/decisionStudio/InvestmentPlanningScreen";
import FinancePlanningScreen from "../components/decisionStudio/FinancePlanningScreen";
import ProcurementPlanningSection from "../components/procurement/ProcurementPlanningSection";
import { buildInitialDraft } from "../decisionDraft";
import { buildDecisionStudioViewModel } from "../decisionStudioViewModel";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../lib/v2/companyLab";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";
import { computeBacklogSemantics } from "../../../lib/v2/companyLab/aiManagementMeeting/backlogSemantics";
import { toYearQuarter } from "../../../lib/v2/core/period";

function setup() {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "ui-trial1-screens", turns: 6 });
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const ai = generateStandardAiDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  const vm = buildDecisionStudioViewModel({ fixture, ownState, draft, period: state.currentPeriod });
  return { state, fixture, ownState, publicInfo, draft, vm };
}

function renderProduction(): string {
  const { state, ownState, draft, vm } = setup();
  const yq = toYearQuarter(state.currentPeriod);
  const backlogSemantics = computeBacklogSemantics(ownState.contracts, ownState.companyId, yq.year, yq.quarter);
  return renderToStaticMarkup(
    React.createElement(ProductionPlanningScreen, { draft, onChange: () => {}, disabled: false, vm, backlogSemantics })
  );
}

function renderProcurement(): string {
  const { state, fixture, ownState, publicInfo, draft } = setup();
  return renderToStaticMarkup(
    React.createElement(ProcurementPlanningSection, {
      fixture,
      ownState,
      draft,
      onChange: () => {},
      disabled: false,
      period: state.currentPeriod,
      publicInfo,
      turn: state.scenarioState.currentTurn,
    })
  );
}

function renderInvestment(): string {
  const { fixture, ownState, draft, vm } = setup();
  return renderToStaticMarkup(
    React.createElement(InvestmentPlanningScreen, { fixture, ownState, draft, onChange: () => {}, disabled: false, vm })
  );
}

function renderFinance(): string {
  const { draft, vm } = setup();
  return renderToStaticMarkup(React.createElement(FinancePlanningScreen, { draft, onChange: () => {}, disabled: false, vm }));
}

const SCREENS: readonly { readonly name: string; readonly render: () => string }[] = [
  { name: "PRODUCTION", render: renderProduction },
  { name: "PROCUREMENT", render: renderProcurement },
  { name: "INVESTMENT", render: renderInvestment },
  { name: "FINANCE", render: renderFinance },
];

test("UIT1-A1: 4画面すべてで、参照のまとまりに種別ラベルが付く", () => {
  for (const screen of SCREENS) {
    const html = screen.render();
    assert.ok(
      html.includes("data-reference-kind="),
      `${screen.name}: 参照種別のラベルが1つも無い（読むだけの情報が入力欄と区別されていない）`
    );
  }
});

test("UIT1-A2: 入力列と読み取り専用列が混ざる表は、見出しに入力か参照かを書く", () => {
  // PRODUCTION: 商品別能力(参照) と 生産希望量/優先度(入力) が同じ行に並ぶ。
  const production = renderProduction();
  assert.ok(production.includes('data-testid="production-plan-table-head"'), "PRODUCTION: 生産計画の表の見出しが無い");
  assert.ok(production.includes('data-testid="production-col-desired-quantity"'), "PRODUCTION: 生産希望量の列見出しが無い");
  assert.ok(production.includes('data-testid="production-col-priority"'), "PRODUCTION: 優先度の列見出しが無い");
  assert.ok(production.includes('data-column-kind="input"'), "PRODUCTION: 入力列である旨が書かれていない");
  assert.ok(production.includes('data-column-kind="current"'), "PRODUCTION: 商品別能力が参照列として書かれていない");

  // PROCUREMENT（輸入）: Origin Price(参照) と 発注量/リードタイム(入力) が同じ行。
  const procurement = renderProcurement();
  assert.ok(procurement.includes('data-testid="import-order-table-head"'), "PROCUREMENT: 輸入の表の見出しが無い");
  assert.ok(procurement.includes('data-testid="import-col-ordered-quantity"'), "PROCUREMENT: 発注量の列見出しが無い");
  assert.ok(procurement.includes('data-testid="import-col-lead-time"'), "PROCUREMENT: リードタイムの列見出しが無い");
  assert.ok(procurement.includes('data-testid="import-col-origin-price"'), "PROCUREMENT: 原産国価格の列見出しが無い");

  // INVESTMENT: PD省人化の工場別の表はすべて読むだけ。
  const investment = renderInvestment();
  assert.ok(investment.includes('data-testid="pd-mechanization-table-head"'), "INVESTMENT: PD省人化の表の見出しが無い");
  assert.ok(investment.includes('data-testid="investment-col-pd-utilization"'), "INVESTMENT: 前四半期PD稼働率の列見出しが無い");

  // FINANCE: 既存借入の表はすべて読むだけ（入力欄と並ぶため明示する）。
  const finance = renderFinance();
  assert.ok(finance.includes('data-testid="finance-col-loan-id"'), "FINANCE: 既存借入の列見出しが無い");
});

test("UIT1-A3: 入力欄には対象込みの読み上げ名が付く（4画面）", () => {
  const { draft } = setup();

  const production = renderProduction();
  const pRow = draft.productionPlans[0];
  assert.ok(
    production.includes(`aria-label="${pRow.factoryId} ${pRow.product} の生産希望量（t）"`),
    "PRODUCTION: 生産希望量に対象込みの読み上げ名が無い"
  );
  assert.ok(
    production.includes(`aria-label="${pRow.factoryId} ${pRow.product} の生産の優先度（小さいほど優先）"`),
    "PRODUCTION: 優先度に対象込みの読み上げ名が無い"
  );

  const procurement = renderProcurement();
  assert.ok(procurement.includes('aria-label="国内買付の希望量（t）"'), "PROCUREMENT: 国内買付量の読み上げ名が無い");
  assert.ok(procurement.includes('aria-label="国内買付の調達人員（人）"'), "PROCUREMENT: 調達人員の読み上げ名が無い");
  assert.ok(procurement.includes('aria-label="自社養殖の池入れ予定量（t）"'), "PROCUREMENT: 養殖投入量の読み上げ名が無い");
  assert.ok(procurement.includes('aria-label="自社養殖のバイオセキュリティ水準（0〜1）"'), "PROCUREMENT: 防疫水準の読み上げ名が無い");
  const importRow = draft.importOrders[0];
  if (importRow !== undefined) {
    assert.ok(
      procurement.includes(`aria-label="${importRow.originCountry} からの輸入発注量（t）"`),
      "PROCUREMENT: 輸入発注量の読み上げ名が無い"
    );
  }

  const finance = renderFinance();
  assert.ok(finance.includes('aria-label="追加希望借入額（USD・全社）"'), "FINANCE: 借入希望額の読み上げ名が無い");
  assert.ok(finance.includes('aria-label="当四半期の配当額（USD・あなたの指示）"'), "FINANCE: 配当額の読み上げ名が無い");
});

test("UIT1-A4: 入力欄の見出しに項目名・単位・対象が書かれている（4画面）", () => {
  const procurement = renderProcurement();
  // InputFieldLabel は対象を独立したバッジで出す。
  assert.ok(procurement.includes("買付希望量"), "PROCUREMENT: 項目名が無い");
  assert.ok(procurement.includes("（t）"), "PROCUREMENT: 単位が無い");
  assert.ok(procurement.includes(">国内<"), "PROCUREMENT: 対象（国内）が無い");
  assert.ok(procurement.includes(">自社養殖<"), "PROCUREMENT: 対象（自社養殖）が無い");

  const finance = renderFinance();
  assert.ok(finance.includes("追加希望借入額"), "FINANCE: 項目名が無い");
  assert.ok(finance.includes(">全社・当四半期<"), "FINANCE: 対象が無い");
  // 借入・配当が「申請」であることを入力欄のそばで説明している。
  assert.ok(finance.includes("実行額ではありません"), "FINANCE: 申請であることの説明が無い");

  const investment = renderInvestment();
  assert.ok(investment.includes("VAP商品開発費"), "INVESTMENT: 項目名が無い");
  assert.ok(investment.includes(">PD省人化投資<"), "INVESTMENT: PD省人化の対象の明記が無い");
});

test("UIT1-A5: 参照種別のラベルが入力欄として描かれていない（4画面）", () => {
  for (const screen of SCREENS) {
    const html = screen.render();
    // data-reference-kind を持つ要素が input/select を内包していないこと。
    const matches = html.match(/<span[^>]*data-reference-kind="[a-z]+"[^>]*>[\s\S]*?<\/span>/g) ?? [];
    assert.ok(matches.length > 0, `${screen.name}: 参照種別の要素が見つからない`);
    for (const fragment of matches) {
      assert.ok(!fragment.includes("<input"), `${screen.name}: 参照種別の中に入力欄がある`);
      assert.ok(!fragment.includes("<select"), `${screen.name}: 参照種別の中に選択欄がある`);
    }
  }
});
