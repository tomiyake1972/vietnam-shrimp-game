// ShrimpX V2 — UI-TRIAL-1 §3: 営業配員の入力単位（市場ごとに1つ）
//
// 【背景】営業人員は市場単位の意思決定なのに、画面は市場×商品の全行
// （CN/HOSO・CN/PD・CN/VAP…）に同じ営業人員の入力欄を出していた。値は
// syncMarketSalesForceHeadcount で同期されていたので壊れてはいないが、
// 同じ人数を3回見せて3回編集できる形は「何人配置したのか」を読み取りにくい。
//
// ここで固定する契約
//   1. 営業配員の入力欄は市場ごとに1つだけ（商品行には無い）。
//   2. 販売数量と価格調整は市場×商品ごとに編集できる（単位は変えない）。
//   3. 市場の総数・配員済み・未配員／超過が読み取れる。
//   4. 採用人数と配員人数が別物だと分かる。
//   5. 狭い画面で行だけ見えても、その行がどの市場かが文言で分かる。
//   6. 配員の同期は既存の共有操作（syncMarketSalesForceHeadcount）のままで、
//      提出データの形（市場×商品の全行が同じ人数を持つ）は変わらない。
//
// 実際に React で描画した HTML に対して検証する（文字列の有無だけを見る
// 静的検査ではなく、本物の fixture・本物の AI 初期下書きを渡して描画する）。
// 既存の marketPanelConsumerMarketWiring.test.ts と同じ renderToStaticMarkup 方式。

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SalesPlanningScreen, { groupSalesPlansByMarket } from "../components/decisionStudio/SalesPlanningScreen";
import { buildInitialDraft, summarizeSalesForceAllocation, summarizeSalesForceHiring, syncMarketSalesForceHeadcount, CompanyDecisionDraft } from "../decisionDraft";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../lib/v2/companyLab";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";

function setup() {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "ui-trial1-sales", turns: 6 });
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const ai = generateStandardAiDecision(fixture, ownState, buildPublicMarketInfo(state), state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  return { fixture, ownState, draft };
}

function render(draft: CompanyDecisionDraft, currentHeadcount: number): string {
  const allocation = summarizeSalesForceAllocation(draft.salesPlans, currentHeadcount);
  const hiring = summarizeSalesForceHiring(currentHeadcount, draft.salesForceHireCount ?? 0, draft.salesForceLayoffCount ?? 0);
  return renderToStaticMarkup(
    React.createElement(SalesPlanningScreen, {
      draft,
      onChange: () => {},
      disabled: false,
      currentSalesForceHeadcount: currentHeadcount,
      salesForceAllocation: allocation,
      salesForceHiring: hiring,
      salesForceHireLimit: 3,
    })
  );
}

function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function marketsOf(draft: CompanyDecisionDraft): readonly string[] {
  return Array.from(new Set(draft.salesPlans.map((p) => p.market)));
}

test("UIT1-S1: 営業配員の入力欄は市場ごとに1つだけ（商品ごとに重複しない）", () => {
  const { draft, ownState } = setup();
  const html = render(draft, ownState.salesForceHiringState.headcount);
  const markets = marketsOf(draft);
  assert.ok(markets.length >= 2, "この検証には市場が2つ以上必要");

  for (const market of markets) {
    const count = countOccurrences(html, `data-testid="sales-force-market-headcount-${market}"`);
    assert.equal(count, 1, `市場 ${market} の営業配員の入力欄が ${count} 個ある（1個であるべき）`);
  }
  // 市場の数ぶんだけ存在し、それ以上は無い。
  const totalHeadcountInputs = countOccurrences(html, 'data-testid="sales-force-market-headcount-');
  assert.equal(totalHeadcountInputs, markets.length, "営業配員の入力欄の総数が市場数と一致しない");

  // 商品行の中に営業人員の入力欄が残っていないこと（旧実装では各行にあった）。
  for (const row of draft.salesPlans) {
    assert.ok(
      !html.includes(`data-testid="sales-plan-sales-force-${row.market}-${row.product}"`),
      `商品行 ${row.market}/${row.product} に営業人員の入力欄が残っている`
    );
  }
});

test("UIT1-S2: 販売数量と価格調整は市場×商品ごとに編集できる", () => {
  const { draft, ownState } = setup();
  const html = render(draft, ownState.salesForceHiringState.headcount);
  for (const row of draft.salesPlans) {
    assert.ok(
      html.includes(`data-testid="sales-plan-desired-quantity-${row.market}-${row.product}"`),
      `販売数量の入力欄が無い: ${row.market}/${row.product}`
    );
    assert.ok(
      html.includes(`data-testid="sales-plan-price-adjustment-${row.market}-${row.product}"`),
      `価格調整の入力欄が無い: ${row.market}/${row.product}`
    );
  }
  // 入力欄の総数が 市場×商品 の行数と一致する（増減していない）。
  assert.equal(countOccurrences(html, 'data-testid="sales-plan-desired-quantity-'), draft.salesPlans.length);
  assert.equal(countOccurrences(html, 'data-testid="sales-plan-price-adjustment-'), draft.salesPlans.length);
});

test("UIT1-S3: 総数・配員済み・未配員／超過が読み取れる", () => {
  const { draft, ownState } = setup();
  const headcount = ownState.salesForceHiringState.headcount;
  const html = render(draft, headcount);
  assert.ok(html.includes('data-testid="sales-force-total-headcount"'), "営業人員の総数の表示が無い");
  assert.ok(html.includes('data-testid="sales-force-assigned-headcount"'), "配員済みの表示が無い");
  assert.ok(html.includes('data-testid="sales-force-unassigned-headcount"'), "未配員／超過の表示が無い");

  // 実際の数値が共有ロジックの結果と一致する（画面で別計算していない）。
  const allocation = summarizeSalesForceAllocation(draft.salesPlans, headcount);
  assert.ok(html.includes(`>${allocation.availableTotal}人<`), `総数 ${allocation.availableTotal}人 が表示されていない`);
  assert.ok(html.includes(`>${allocation.assignedTotal}人<`), `配員済み ${allocation.assignedTotal}人 が表示されていない`);
});

test("UIT1-S4: 超過しているときは超過人数と警告を出す（共有ロジックの判定をそのまま使う）", () => {
  const { draft, ownState } = setup();
  const headcount = ownState.salesForceHiringState.headcount;
  const markets = marketsOf(draft);
  // 1つの市場へ総数より多く配員して、意図的に超過させる。
  const over = syncMarketSalesForceHeadcount(draft, markets[0] as never, headcount + 5);
  const allocation = summarizeSalesForceAllocation(over.salesPlans, headcount);
  assert.ok(allocation.isOverAllocated, "前提: 超過状態になっていない");

  const html = render(over, headcount);
  assert.ok(html.includes('data-over-allocated="true"'), "超過状態が表示に反映されていない");
  assert.ok(html.includes('data-testid="sales-force-over-allocated-warning"'), "超過の警告が出ていない");
  assert.ok(html.includes(`>${allocation.overBy}人<`), `超過 ${allocation.overBy}人 が表示されていない`);

  // 超過していない状態では警告を出さない。
  const okHtml = render(draft, headcount);
  assert.ok(!okHtml.includes('data-testid="sales-force-over-allocated-warning"'), "超過していないのに警告が出ている");
});

test("UIT1-S5: 採用人数と配員人数が別物だと分かる", () => {
  const { draft, ownState } = setup();
  const html = render(draft, ownState.salesForceHiringState.headcount);
  // 配員と採用の違いを述べる注記がある。
  assert.ok(html.includes('data-testid="sales-force-assign-vs-hire-note"'), "配員と採用の区別の説明が無い");
  // 採用・減員の入力欄は市場別ではなく全社の1つずつ。
  assert.equal(countOccurrences(html, 'data-testid="sales-force-hire-count"'), 1);
  assert.equal(countOccurrences(html, 'data-testid="sales-force-layoff-count"'), 1);
  // 採用欄のラベルに「市場別ではありません」と明記されている。
  assert.ok(html.includes('data-testid="sales-force-hire-count-label-target"'), "採用欄に対象の明記が無い");
});

test("UIT1-S6: 狭い画面で行だけ見えても、その行がどの市場かが文言で分かる", () => {
  const { draft, ownState } = setup();
  const html = render(draft, ownState.salesForceHiringState.headcount);
  for (const market of marketsOf(draft)) {
    // 市場ブロックの見出しと、各商品行の市場併記の両方がある。
    assert.ok(html.includes(`data-testid="sales-plan-market-block-${market}"`), `市場ブロックが無い: ${market}`);
    assert.ok(html.includes(`（${market}）`), `商品行に市場の併記が無い: ${market}`);
  }
});

test("UIT1-S7: 配員の同期は既存の共有操作のままで、提出データの形が変わらない", () => {
  const { draft } = setup();
  const markets = marketsOf(draft);
  const target = markets[0] as never;
  const next = syncMarketSalesForceHeadcount(draft, target, 7);

  // 同じ市場の全商品行が同じ人数を持つ（engine 側の前提）。
  const sameMarketRows = next.salesPlans.filter((p) => p.market === target);
  assert.ok(sameMarketRows.length >= 2, "前提: 同一市場に複数商品の行がある");
  for (const row of sameMarketRows) assert.equal(row.salesForceHeadcount, 7, "同一市場の行で人数がずれている");
  // 他の市場は触っていない。
  for (const row of next.salesPlans.filter((p) => p.market !== target)) {
    const before = draft.salesPlans.find((p) => p.market === row.market && p.product === row.product)!;
    assert.equal(row.salesForceHeadcount, before.salesForceHeadcount, "他市場の人数が変わっている");
  }
  // 行数・市場×商品の組合せは不変（画面の組み替えで提出対象が増減しない）。
  assert.equal(next.salesPlans.length, draft.salesPlans.length);
});

test("UIT1-S8: 市場ごとのまとめ方は下書きの並び順を変えない（提出対象の取りこぼしが無い）", () => {
  const { draft } = setup();
  const groups = groupSalesPlansByMarket(draft.salesPlans);
  // 全行がどこかのグループに1回だけ現れる。
  const seen = new Set<number>();
  for (const group of groups) {
    for (const row of group.rows) {
      assert.ok(!seen.has(row.index), `行 index=${row.index} が重複している`);
      seen.add(row.index);
      const original = draft.salesPlans[row.index];
      assert.equal(original.market, group.market, "グループの市場と元の行の市場が違う");
      assert.equal(original.product, row.product, "グループの商品と元の行の商品が違う");
    }
  }
  assert.equal(seen.size, draft.salesPlans.length, "グループ化で行が抜けている");
  // 市場の数と、各市場の代表人数が元の下書きと一致する。
  assert.equal(groups.length, marketsOf(draft).length);
  for (const group of groups) {
    const first = draft.salesPlans.find((p) => p.market === group.market)!;
    assert.equal(group.salesForceHeadcount, first.salesForceHeadcount);
  }
});
