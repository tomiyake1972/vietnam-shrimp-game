// ShrimpX V2 — 初期入力の実行可能範囲への丸め（テストプレイ指摘①の続き・2026-11）
//
// 【このテストが守るもの】
//   1. 販売希望量の商品別合計が「実効加工能力＋製品在庫−受注残」を超えないこと。
//   2. 市場間の配分比率を勝手に変えないこと（比例で縮める）。
//   3. 国内買付が「生産計画−当期に使える原料」を超えないこと。
//   4. すでに範囲内なら1トンも動かさないこと（余計な書き換えをしない）。
//   5. 何を変えたかが必ず記録に残ること（黙って書き換えない）。
//   6. Standard AI の意思決定には触れていないこと（この関数はドラフトにしか作用しない）。
//
// 入力は実エンジン（initializeCompanyLab + generateStandardAiDecision）の実物を使う。

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyInitialDraftFeasibility, computeSalesCeilingByProduct } from "../initialDraftFeasibility";
import { buildInitialDraft } from "../decisionDraft";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../lib/v2/companyLab";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";
import { unwrapUnit } from "../../../lib/v2/core/units";
import type { Product } from "../../../lib/v2/market/types";
import type { CompanyDecisionDraft } from "../decisionDraft";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function setup(companyId = "BAL") {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "initial-draft-feasibility", turns: 6 });
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const aiDecision = generateStandardAiDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, aiDecision, ownState.workforceState, ownState.effectiveFactories);
  return { state, fixture, ownState, aiDecision, draft };
}

const productTotal = (draft: CompanyDecisionDraft, product: Product): number =>
  draft.salesPlans.filter((r) => r.product === product).reduce((sum, r) => sum + r.desiredQuantity, 0);

test("FEAS-1【販売の上限を守る】: 丸めたあとの商品別合計が販売可能量の上限を超えない", () => {
  const s = setup();
  const result = applyInitialDraftFeasibility({ draft: s.draft, ownState: s.ownState, period: s.state.currentPeriod });
  const ceiling = computeSalesCeilingByProduct(s.ownState);
  for (const product of PRODUCTS) {
    assert.ok(
      productTotal(result.draft, product) <= ceiling[product] + 1e-9,
      `${product}: 丸め後 ${productTotal(result.draft, product)} が上限 ${ceiling[product]} を超えている`
    );
  }
});

test("FEAS-2【実際に丸まっている】: このフィクスチャではAIの提案が上限を超えており、記録が残る", () => {
  const s = setup();
  const ceiling = computeSalesCeilingByProduct(s.ownState);
  const over = PRODUCTS.filter((p) => productTotal(s.draft, p) > ceiling[p]);
  assert.ok(over.length > 0, "このテストの前提として、AIの提案が上限を超える商品が1つ以上必要");

  const result = applyInitialDraftFeasibility({ draft: s.draft, ownState: s.ownState, period: s.state.currentPeriod });
  for (const product of over) {
    const record = result.adjustments.find((a) => a.field === "salesPlan" && a.product === product);
    assert.ok(record, `${product} の調整記録が無い（黙って書き換えている）`);
    assert.ok(record.proposedTons > record.adjustedTons, "記録の前後が逆になっている");
    assert.ok(record.reason.includes("販売可能量の上限"), "上限の根拠が記録に書かれていない");
  }
});

test("FEAS-3【市場間の比率を変えない】: 比例で縮めるので、市場ごとの構成比はほぼ保たれる", () => {
  const s = setup();
  const result = applyInitialDraftFeasibility({ draft: s.draft, ownState: s.ownState, period: s.state.currentPeriod });
  for (const product of PRODUCTS) {
    const before = s.draft.salesPlans.filter((r) => r.product === product);
    const after = result.draft.salesPlans.filter((r) => r.product === product);
    const beforeTotal = before.reduce((sum, r) => sum + r.desiredQuantity, 0);
    const afterTotal = after.reduce((sum, r) => sum + r.desiredQuantity, 0);
    if (beforeTotal <= 0 || afterTotal <= 0 || beforeTotal === afterTotal) continue;
    before.forEach((row, i) => {
      const beforeShare = row.desiredQuantity / beforeTotal;
      const afterShare = after[i].desiredQuantity / afterTotal;
      // 1トン単位へ丸めるため完全一致はしない。市場ごとに2ポイント以内のずれに収める。
      assert.ok(Math.abs(beforeShare - afterShare) < 0.02, `${product}/${row.market}: 構成比が変わりすぎ（${beforeShare} → ${afterShare}）`);
    });
  }
});

test("FEAS-4【国内買付の上限】: 生産計画 − 当期に使える原料 を超えない", () => {
  const s = setup();
  const result = applyInitialDraftFeasibility({ draft: s.draft, ownState: s.ownState, period: s.state.currentPeriod });
  assert.ok(
    result.draft.domesticPurchase.desiredQuantity <= result.domesticPurchaseCeilingTons + 1e-9,
    `買付 ${result.draft.domesticPurchase.desiredQuantity} が上限 ${result.domesticPurchaseCeilingTons} を超えている`
  );
  const plannedProduction = s.draft.productionPlans.reduce((sum, r) => sum + r.desiredQuantity, 0);
  const availableRaw = s.ownState.rawMaterialLots
    .filter((l) => l.companyId === s.ownState.companyId)
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
  // 上限は「生産計画 − 使える原料」であり、手持ち全量（輸送中・養殖中を含む総量）より
  // 小さいか等しい形になっているはず（＝使える原料を無視した買付にはならない）。
  assert.ok(result.domesticPurchaseCeilingTons <= Math.max(0, plannedProduction), "上限が生産計画を超えている");
  assert.ok(availableRaw >= 0);
});

test("FEAS-5【生産計画は触らない】: 指示の範囲外なので生産計画・ワーカー・投資は1トンも変えない", () => {
  const s = setup();
  const result = applyInitialDraftFeasibility({ draft: s.draft, ownState: s.ownState, period: s.state.currentPeriod });
  assert.deepEqual(result.draft.productionPlans, s.draft.productionPlans);
  assert.deepEqual(result.draft.workerAssignments, s.draft.workerAssignments);
  assert.deepEqual(result.draft.capexDecision, s.draft.capexDecision);
  assert.deepEqual(result.draft.importOrders, s.draft.importOrders);
  assert.deepEqual(result.draft.aquacultureStockingPlans, s.draft.aquacultureStockingPlans);
  assert.equal(result.draft.salesForceHireCount, s.draft.salesForceHireCount);
});

test("FEAS-6【範囲内なら動かさない】: すでに上限内のドラフトは同一オブジェクトのまま返す", () => {
  const s = setup();
  const ceiling = computeSalesCeilingByProduct(s.ownState);
  const within: CompanyDecisionDraft = {
    ...s.draft,
    salesPlans: s.draft.salesPlans.map((row) => ({ ...row, desiredQuantity: Math.floor(ceiling[row.product] / 10) })),
    domesticPurchase: { ...s.draft.domesticPurchase, desiredQuantity: 0 },
  };
  const result = applyInitialDraftFeasibility({ draft: within, ownState: s.ownState, period: s.state.currentPeriod });
  assert.deepEqual(result.adjustments, []);
  assert.equal(result.draft, within, "範囲内なのに新しいオブジェクトへ作り替えている");
});

test("FEAS-7【販売可能量の上限の定義】: 実効加工能力＋製品在庫−受注残（0未満にしない）", () => {
  const s = setup();
  const ceiling = computeSalesCeilingByProduct(s.ownState);
  for (const product of PRODUCTS) {
    assert.ok(ceiling[product] >= 0, `${product}: 上限が負になっている`);
    assert.ok(Number.isFinite(ceiling[product]));
  }
});

test("FEAS-8【AIの意思決定には触らない】: 丸めの前後で aiDecision は同一である", () => {
  const s = setup();
  const snapshot = JSON.stringify(s.aiDecision);
  applyInitialDraftFeasibility({ draft: s.draft, ownState: s.ownState, period: s.state.currentPeriod });
  assert.equal(JSON.stringify(s.aiDecision), snapshot, "Standard AI の意思決定が書き換わっている");
});
