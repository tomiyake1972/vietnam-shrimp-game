// AMM-2..7: Deterministic routing tests

import { test } from "node:test";
import assert from "node:assert/strict";
import { routePlayerMessage, shouldSuggestCeoSummary } from "../router";

test("AMM-2: CFO routing — 現金・借入に関する質問はCFOがprimary", () => {
  const r = routePlayerMessage("CFO、新工場を建てる余裕ある？現金は足りてる？");
  assert.equal(r.primary, "CFO");
});

test("AMM-3: COO routing — 工場・生産・原料に関する質問はCOOがprimary", () => {
  const r = routePlayerMessage("工場の稼働率と原料の在庫状況を教えて。");
  assert.equal(r.primary, "COO");
});

test("AMM-4: Commercial routing — 市場・価格・契約に関する質問はCommercialがprimary", () => {
  const r = routePlayerMessage("日本市場の価格と契約状況はどう？");
  assert.equal(r.primary, "COMMERCIAL");
});

test("AMM-5: CEO routing — 全体方針に関する質問、または明示的にCEO宛てのものはCEOがprimary", () => {
  const r1 = routePlayerMessage("今期何を一番気をつけるべき？");
  assert.equal(r1.primary, "CEO");
  const r2 = routePlayerMessage("CEO、全体としてどう考える？");
  assert.equal(r2.primary, "CEO");
});

test("AMM-6: secondaryは最大1名（複数領域に強くマッチしても2名以上にはならない）", () => {
  const r = routePlayerMessage("現金と工場稼働率と市場価格、全部教えて。融資も検討したい。");
  assert.ok(r.secondary === null || typeof r.secondary === "string");
  // primary/secondaryはいずれも単一の役割文字列であり、配列ではない＝構造的に最大1名を担保。
  assert.notEqual(r.primary, r.secondary);
});

test("AMM-7: CEO summaryは常には含めない（単一領域の単純な質問では既定でfalse）", () => {
  const suggestSimple = shouldSuggestCeoSummary({ hasSecondary: false, stancesConflict: false, proposalCount: 0, explicitCeoRequest: false });
  assert.equal(suggestSimple, false);

  const suggestConflict = shouldSuggestCeoSummary({ hasSecondary: true, stancesConflict: true, proposalCount: 0, explicitCeoRequest: false });
  assert.equal(suggestConflict, true);

  const suggestMultiProposal = shouldSuggestCeoSummary({ hasSecondary: false, stancesConflict: false, proposalCount: 2, explicitCeoRequest: false });
  assert.equal(suggestMultiProposal, true);

  const suggestExplicit = shouldSuggestCeoSummary({ hasSecondary: false, stancesConflict: false, proposalCount: 0, explicitCeoRequest: true });
  assert.equal(suggestExplicit, true);
});
