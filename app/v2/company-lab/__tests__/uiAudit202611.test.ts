// ShrimpX V2 — 2026-11 個別プレイヤー画面のUI監査指摘に対する回帰テスト
//
// 実際に React で描画した HTML に対して検証する（本物の fixture・本物のAI初期下書き）。
// 対象は表示だけであり、ゲーム計算・提出データの意味は変えていない。
//
// 指摘番号は利用者から受け取った一覧に合わせる:
//   ① 販売の上限が画面に出ない
//   ② 解雇費用（退職金）が出てこない
//   ③ 国内原料の価格表示がバラバラ
//   ⑤ 損益計算書の原料費の参考欄が合わない（ラベルが「買付」になっていた）
//   ⑥ VAP商品開発費の行き先 ／ 効き方の説明
//   ⑧ 開発者向けの文言がプレイヤーに見えている
//   ⑨ 細かい点（配当$0の理由・借入余力$0の理由・養殖の換算根拠・誤字）

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SalesPlanningScreen from "../components/decisionStudio/SalesPlanningScreen";
import FinancePlanningScreen from "../components/decisionStudio/FinancePlanningScreen";
import ProcurementPlanningSection from "../components/procurement/ProcurementPlanningSection";
import OpeningCompanyStatePanel from "../components/OpeningCompanyStatePanel";
import { buildInitialDraft, summarizeSalesForceAllocation, summarizeSalesForceHiring } from "../decisionDraft";
import { buildDecisionStudioViewModel } from "../decisionStudioViewModel";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../lib/v2/companyLab";
import { computeMaxSalesHiresPerQuarter } from "../../../lib/v2/companyLab/salesForceHiring";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";
import { computeBacklogSemantics } from "../../../lib/v2/companyLab/aiManagementMeeting/backlogSemantics";
import { toYearQuarter } from "../../../lib/v2/core/period";
import { unwrapUnit } from "../../../lib/v2/core/units";
import type { Product } from "../../../lib/v2/market/types";
import type { CompanyDecisionDraft } from "../decisionDraft";

function setup(companyId = "BAL") {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "ui-audit-2026-11", turns: 6 });
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const ai = generateStandardAiDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  const vm = buildDecisionStudioViewModel({ fixture, ownState, draft, period: state.currentPeriod });
  const yq = toYearQuarter(state.currentPeriod);
  const backlogSemantics = computeBacklogSemantics(ownState.contracts, ownState.companyId, yq.year, yq.quarter);
  const effectiveCapacityByProduct: Partial<Record<Product, number>> = Object.fromEntries(
    vm.processingForecast.companyRateTable.rows
      .filter((row): row is typeof row & { poolKey: Product } => row.poolKey === "hoso" || row.poolKey === "pd" || row.poolKey === "vap")
      .map((row) => [row.poolKey, row.effectiveTons])
  );
  const finishedGoodsTonsByProduct = ownState.finishedGoodsLots.reduce<Partial<Record<Product, number>>>((acc, lot) => {
    if (lot.status !== "available") return acc;
    acc[lot.product] = (acc[lot.product] ?? 0) + unwrapUnit(lot.remainingQuantity);
    return acc;
  }, {});
  return { state, fixture, ownState, publicInfo, draft, vm, backlogSemantics, effectiveCapacityByProduct, finishedGoodsTonsByProduct };
}

function renderSales(draftOverride?: Partial<CompanyDecisionDraft>): string {
  const s = setup();
  const draft = { ...s.draft, ...draftOverride };
  return renderToStaticMarkup(
    React.createElement(SalesPlanningScreen, {
      draft,
      onChange: () => {},
      disabled: false,
      currentSalesForceHeadcount: s.ownState.salesForceHiringState.headcount,
      salesForceAllocation: summarizeSalesForceAllocation(draft.salesPlans, s.ownState.salesForceHiringState.headcount),
      salesForceHiring: summarizeSalesForceHiring(
        s.ownState.salesForceHiringState.headcount,
        draft.salesForceHireCount ?? 0,
        draft.salesForceLayoffCount ?? 0
      ),
      salesForceHireLimit: computeMaxSalesHiresPerQuarter(s.ownState.salesForceHiringState.headcount),
      backlogSemantics: s.backlogSemantics,
      effectiveCapacityByProduct: s.effectiveCapacityByProduct,
      finishedGoodsTonsByProduct: s.finishedGoodsTonsByProduct,
    })
  );
}

// ---------------------------------------------------------------- ① 販売の上限
test("AUDIT-1a【上限を入力欄より前に出す】: SALES画面に供給上限の表が出ており、入力欄より前にある", () => {
  const html = renderSales();
  assert.ok(html.includes('data-testid="sales-supply-ceiling"'), "供給上限パネルが出ていない");
  const ceilingAt = html.indexOf('data-testid="sales-supply-ceiling"');
  const marketBlocksAt = html.indexOf('data-testid="sales-plan-market-blocks"');
  const totalsAt = html.indexOf('data-testid="sales-plan-totals"');
  assert.ok(ceilingAt >= 0 && marketBlocksAt >= 0 && totalsAt >= 0, "比較対象が見つからない");
  assert.ok(ceilingAt < marketBlocksAt, "供給上限が市場ごとの入力欄より後ろに出ている");
  assert.ok(ceilingAt < totalsAt, "供給上限が合計表より後ろに出ている（従来と同じ埋もれ方）");
});

test("AUDIT-1b【3つの数字を並べる】: 完成品在庫・実効加工能力・受注残・販売計画の列がすべて出る", () => {
  const html = renderSales();
  for (const product of ["hoso", "pd", "vap"]) {
    assert.ok(html.includes(`data-testid="sales-supply-ceiling-finished-${product}"`), `完成品在庫の列が無い: ${product}`);
    assert.ok(html.includes(`data-testid="sales-supply-ceiling-capacity-${product}"`), `実効加工能力の列が無い: ${product}`);
    assert.ok(html.includes(`data-testid="sales-supply-ceiling-backlog-${product}"`), `受注残の列が無い: ${product}`);
    assert.ok(html.includes(`data-testid="sales-supply-ceiling-available-${product}"`), `新規販売に回せる量の列が無い: ${product}`);
    assert.ok(html.includes(`data-testid="sales-supply-ceiling-planned-${product}"`), `販売計画の列が無い: ${product}`);
  }
});

test("AUDIT-1c【超過は警告する】: 実効加工能力を大きく超える販売計画では上限超過の警告が出る", () => {
  const s = setup();
  const overDraft = {
    ...s.draft,
    salesPlans: s.draft.salesPlans.map((row) => ({ ...row, desiredQuantity: row.desiredQuantity + 100000 })),
  };
  const html = renderSales(overDraft);
  assert.ok(html.includes('data-testid="sales-supply-ceiling-over-warning"'), "上限超過の警告が出ていない");
});

// ---------------------------------------------------------------- ② 退職金
test("AUDIT-2a【減員前から単価を出す】: 減員数0でも退職金の単価と四半期給与が画面に出る", () => {
  const html = renderSales({ salesForceLayoffCount: 0 });
  assert.ok(html.includes('data-testid="sales-force-severance-unit-cost"'), "退職金の単価が出ていない");
  assert.ok(html.includes('data-testid="sales-force-quarterly-salary"'), "四半期給与が出ていない");
  assert.ok(html.includes('data-testid="sales-force-layoff-cost-note"'), "減員が無料でないことの注記が出ていない");
});

test("AUDIT-2b【単価はエンジンのパラメータと一致する】: 1人あたり$16,000（四半期給与$8,000×2）", () => {
  const preview = summarizeSalesForceHiring(10, 0, 0);
  assert.equal(preview.quarterlySalaryUsdPerPerson, 8_000);
  assert.equal(preview.severanceQuarters, 2);
  assert.equal(preview.severanceUnitCostUsd, 16_000);
  const html = renderSales({ salesForceLayoffCount: 0 });
  assert.ok(html.includes("$16,000"), "退職金の単価の実額が画面に出ていない");
});

test("AUDIT-2c【減員を入れたら総額も出る】: 3人減員で$48,000が出る", () => {
  const html = renderSales({ salesForceLayoffCount: 3 });
  assert.ok(html.includes('data-testid="sales-force-hiring-severance-cost"'));
  assert.ok(html.includes("$48,000"), "減員3人ぶんの退職金総額が出ていない");
});

// ------------------------------------------------- ③ 国内原料価格（PROCUREMENT）
function renderProcurement(withPublicInfo: boolean, openingReferencePrice?: number): string {
  const s = setup();
  return renderToStaticMarkup(
    React.createElement(ProcurementPlanningSection, {
      fixture: s.fixture,
      ownState: s.ownState,
      draft: s.draft,
      onChange: () => {},
      disabled: false,
      period: s.state.currentPeriod,
      ...(withPublicInfo ? { publicInfo: s.publicInfo } : {}),
      turn: 1,
      ...(openingReferencePrice === undefined ? {} : { domesticOpeningReferencePriceUsdPerHosoEqKg: openingReferencePrice }),
    })
  );
}

test("AUDIT-3a【未確定は未確定と書く】: 前期清算価格が無いとき、理由と開始時の参考価格を示す", () => {
  const html = renderProcurement(true, 3.16);
  assert.ok(html.includes('data-testid="pricing-domestic-unavailable"'), "未確定の案内が出ていない");
  assert.ok(html.includes("前四半期の国内原料清算価格がまだありません"), "未確定の理由が書かれていない");
  assert.ok(html.includes('data-testid="pricing-domestic-opening-reference"'), "開始時の参考価格への案内が出ていない");
  assert.ok(html.includes("3.16"), "開始時の参考価格の実額が出ていない");
});

test("AUDIT-3b【参考価格が無ければ作らない】: 開始時の参考価格が渡されないときは金額を出さない", () => {
  const html = renderProcurement(true);
  assert.ok(html.includes('data-testid="pricing-domestic-unavailable"'));
  assert.ok(!html.includes('data-testid="pricing-domestic-opening-reference"'), "渡されていない参考価格を画面が作っている");
});

// ------------------------------------------------------------------ ④ 原料在庫
test("AUDIT-4a【原料在庫の意味を書き分ける】: INFOの合計は「使用可能＋輸送中・養殖中」と明記し、内訳も出す", () => {
  const s = setup();
  const html = renderToStaticMarkup(
    React.createElement(OpeningCompanyStatePanel, { ownState: s.ownState, fixture: s.fixture, turn: 1 })
  );
  assert.ok(html.includes("原料在庫 合計（使用可能＋輸送中・養殖中）"), "合計の意味が書かれていない");
  assert.ok(html.includes("うち 今期使用可能"), "使用可能分の内訳が出ていない");
  assert.ok(html.includes("うち 輸送中・養殖中（今期使えない）"), "輸送中・養殖中の内訳が出ていない");
  assert.ok(!html.includes("原料在庫（合計）"), "古い曖昧なラベルが残っている");
});

// ------------------------------------------------------- ⑨ FINANCE 画面の理由
function renderFinance(turn: number): string {
  const s = setup();
  return renderToStaticMarkup(
    React.createElement(FinancePlanningScreen, { draft: s.draft, onChange: () => {}, disabled: false, vm: s.vm, turn })
  );
}

test("AUDIT-9a【配当$0の理由】: Turn1で配当可能額が$0のとき、分配可能利益が理由として出る", () => {
  const s = setup();
  assert.equal(s.vm.maxDividendUsd, 0, "このテストの前提としてTurn1の配当可能額は$0であること");
  const html = renderFinance(1);
  assert.ok(html.includes('data-testid="dividend-zero-reason"'), "配当$0の理由が出ていない");
  assert.ok(html.includes('data-testid="dividend-info-distributable-earnings"'), "分配可能利益の行が出ていない");
  assert.ok(html.includes("最初の四半期はまだ利益が1四半期も確定していない"), "Turn1固有の説明が出ていない");
});

test("AUDIT-9b【借入余力の内訳】: 前四半期の審査記録が無いTurnでは推測値を出さない", () => {
  const html = renderFinance(1);
  assert.ok(html.includes('data-testid="borrowing-capacity-guide-unavailable"'), "記録が無い旨の案内が出ていない");
  assert.ok(!html.includes('data-testid="borrowing-capacity-gross-limit"'), "記録が無いのに総枠の数値を出している");
});

test("AUDIT-9c【誤字】: 「今Turン」が残っていない", () => {
  const html = renderFinance(1);
  assert.ok(!html.includes("今Turン"), "誤字「今Turン」が残っている");
  assert.ok(html.includes("今Turnの"), "正しい表記が出ていない");
});

test("AUDIT-9d【養殖の換算根拠】: 池入れ量×(1＋歩留まり上限×養殖強度)の式が画面に出る", () => {
  const html = renderProcurement(true, 3.16);
  assert.ok(html.includes('data-testid="aquaculture-expected-formula"'), "換算の式が出ていない");
  assert.ok(html.includes("期待生産量の求め方"), "式の見出しが出ていない");
});

// --------------------------------------------- ⑧ 開発者向けの文言が出ていない
test("AUDIT-8【プレイヤー画面にソースの場所・変数名を出さない】", () => {
  const htmls = [renderSales(), renderFinance(1), renderProcurement(true, 3.16)];
  const s = setup();
  htmls.push(renderToStaticMarkup(React.createElement(OpeningCompanyStatePanel, { ownState: s.ownState, fixture: s.fixture, turn: 1 })));
  const forbidden = [
    "parameters.ts",
    "quarterClose.ts",
    "allocation.ts",
    "projectLifecycle.ts",
    "bankUnderwriting.ts",
    "liquidityClose.ts",
    "pdMechanization.ts",
    "app/lib/v2/",
    "ContributionMarginReport",
    "activeFactoryCount",
    "totalFactorySpaceUnits",
    "研修では",
  ];
  for (const html of htmls) {
    for (const needle of forbidden) {
      assert.ok(!html.includes(needle), `プレイヤーに見える文言に開発者向けの記述が残っている: ${needle}`);
    }
  }
});
