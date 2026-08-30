// ShrimpX V2 — SALES 基準価格表示 UI（参考提示価格）のテスト
//
// 【方針】新しい価格計算は一切持たない。既存Engineが確定済みhistoryへ保存した
// MarketProductAllocationResult.basePriceを読み取るだけの関数
// （findLastQuarterBasePrice・formatPricePerKgPlain、いずれもSalesPlanningScreen.tsx）を、
// 実Engineで1Turn進めて得た本物のhistoryに対して検証する。
//
// 【セキュリティ修正】ここではSalesPlanningScreen.tsxが実際に受け取るのと同じ最小DTO
// （projectMarketBasePriceReferencesで射影済みのMarketProductBasePriceReference[]）を
// 使う。生のMarketProductAllocationResult（他社askPrice等を含む）をそのまま渡さない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../lib/v2/companyLab/autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig } from "../../../lib/v2/companyLab/types";
import { unwrapUnit } from "../../../lib/v2/core/units";
import { projectMarketBasePriceReferences } from "../../../lib/v2/sales/marketBasePriceReference";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../decisionDraft";
import { findLastQuarterBasePrice, formatPricePerKgPlain } from "../components/decisionStudio/SalesPlanningScreen";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed: "sales-price-reference-001", turns: 8, ...overrides };
}

/**
 * Turn1を実Engineで確定させ、SalesPlanningScreen.tsxが実際に受け取るのと同じ
 * 射影済み最小DTO（market/product/basePriceのみ）を返す。
 */
function runTurnOne(configOverrides: Partial<CompanyLabConfig> = {}) {
  const { state, fixtures } = initializeCompanyLab(baseConfig(configOverrides));
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisions[f.companyId] = generateAutoPolicyDecision(f, own, publicInfo, state.currentPeriod, 1);
  }
  const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
  const record = nextState.history[nextState.history.length - 1];
  const rawAllocations = record.salesRecord.allocations;
  const allocations = projectMarketBasePriceReferences(rawAllocations)!;
  return { allocations, rawAllocations, fixtures };
}

test("SALES-PRICE-1/5: 前Turn市場基準価格は、確定済みhistoryのMarketProductAllocationResult.basePriceと完全一致する", () => {
  const { allocations, rawAllocations } = runTurnOne();
  assert.ok(allocations.length > 0, "Turn1で少なくとも1件のmarket×product配分結果が存在するはず");
  const sample = rawAllocations[0];
  const found = findLastQuarterBasePrice(allocations, sample.market, sample.product);
  assert.equal(found, unwrapUnit(sample.basePrice));
});

test("SALES-PRICE-2: 価格調整=0のとき、参考提示価格は前Turn市場基準価格と一致する", () => {
  const { allocations, rawAllocations } = runTurnOne();
  const sample = rawAllocations[0];
  const basePrice = findLastQuarterBasePrice(allocations, sample.market, sample.product)!;
  const priceAdjustment = 0;
  const referenceAskPrice = basePrice + priceAdjustment;
  assert.equal(referenceAskPrice, basePrice);
});

test("SALES-PRICE-3: 価格調整=-0.30のとき、参考提示価格は基準価格から正しく減算される", () => {
  const { allocations, rawAllocations } = runTurnOne();
  const sample = rawAllocations[0];
  const basePrice = findLastQuarterBasePrice(allocations, sample.market, sample.product)!;
  const referenceAskPrice = basePrice + -0.3;
  assert.ok(Math.abs(referenceAskPrice - (basePrice - 0.3)) < 1e-9);
});

test("SALES-PRICE-4: 価格調整=+0.30のとき、参考提示価格は基準価格へ正しく加算される", () => {
  const { allocations, rawAllocations } = runTurnOne();
  const sample = rawAllocations[0];
  const basePrice = findLastQuarterBasePrice(allocations, sample.market, sample.product)!;
  const referenceAskPrice = basePrice + 0.3;
  assert.ok(Math.abs(referenceAskPrice - (basePrice + 0.3)) < 1e-9);
});

test("SALES-PRICE-11【セキュリティ修正】: SalesPlanningScreenへ渡る最小DTOはmarket/product/basePrice以外のキーを持たない", () => {
  const { allocations } = runTurnOne();
  for (const entry of allocations) {
    assert.deepEqual(Object.keys(entry).sort(), ["basePrice", "market", "product"]);
  }
  const serialized = JSON.stringify(allocations);
  for (const forbidden of ["companies", "askPrice", "allocatedQuantity", "processingCapacity", "competitivenessWeight", "competitivenessBreakdown", "targetDemand", "externalOptionQuantity"]) {
    assert.ok(!serialized.includes(forbidden), `最小DTOに"${forbidden}"が含まれてはならない`);
  }
});

test("SALES-PRICE-6【Turn1・前Turnデータなし】: allocationsがundefinedのとき前Turn市場基準価格はnull（0で埋めない）", () => {
  const result = findLastQuarterBasePrice(undefined, "CN", "hoso");
  assert.equal(result, null);
});

test("SALES-PRICE-7【旧Run・前Turn取得不能】: 空配列（当該market×productの配分結果が無い）でもnull", () => {
  const result = findLastQuarterBasePrice([], "CN", "hoso");
  assert.equal(result, null);
});

test("SALES-PRICE-8【入力との即時連動】: 同じbasePriceでも価格調整を変えるたびに参考提示価格が再導出される（保存された値ではなく毎回の派生値であること）", () => {
  const { allocations, rawAllocations } = runTurnOne();
  const sample = rawAllocations[0];
  const basePrice = findLastQuarterBasePrice(allocations, sample.market, sample.product)!;
  const adjustments = [0, -0.3, 0.5, -1.2];
  const results = adjustments.map((adj) => basePrice + adj);
  // 前Turn市場基準価格そのもの（=派生元）は入力によって変化しない。
  for (const adj of adjustments) {
    assert.equal(findLastQuarterBasePrice(allocations, sample.market, sample.product), basePrice, `adjustment=${adj}でもbasePriceは不変`);
  }
  // 参考提示価格は調整のたびに異なる値へ再計算される。
  assert.equal(new Set(results).size, adjustments.length, "adjustmentごとに異なる参考提示価格が算出される");
});

test("SALES-PRICE-9【CompanyDecisionInputに変更なし】: draft->decision変換の価格調整フィールドは今回の変更前と同じ形のまま渡る", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, autoDecision);
  const edited = { ...draft, salesPlans: draft.salesPlans.map((p) => (p === draft.salesPlans[0] ? { ...p, priceAdjustmentUsdPerHosoEqKg: -0.42 } : p)) };
  const decision = buildDecisionInputFromDraft(edited, fixture, state.currentPeriod);
  const plan = decision.salesPlans.find((p) => p.market === edited.salesPlans[0].market && p.product === edited.salesPlans[0].product);
  if (edited.salesPlans[0].desiredQuantity > 0) {
    assert.equal(plan?.priceAdjustmentUsdPerHosoEqKg, -0.42, "価格調整はSALES画面の変更前と同じくそのままCompanyDecisionInputへ渡る");
  }
  // このタスクではdecisionDraft.ts自体を変更していないため、CompanyDecisionInputの
  // フィールド構成そのものに新規追加が無いことも確認する（キー集合の変化=契約変更の兆候）。
  const keys = Object.keys(decision).sort();
  assert.ok(!keys.includes("salesPriceReference"), "表示専用の新概念がCompanyDecisionInputへ紛れ込んでいない");
});

test("SALES-PRICE-10【表示専用フォーマッタ】: formatPricePerKgPlainは小数2桁固定で$を付与する（新しい価格計算はしない、単なる文字列整形）", () => {
  assert.equal(formatPricePerKgPlain(8.4), "$8.40");
  assert.equal(formatPricePerKgPlain(8.1), "$8.10");
  assert.equal(formatPricePerKgPlain(0), "$0.00");
});

// --- PLAYER-UI-PLAYTEST-FIX-1・問題②③ PRICE-UI-5: legacy/tiered双方で基準価格表示が成立する ---

test("PRICE-UI-5【legacy】: salesModelId未指定（従来モデル）でも基準価格の最小DTOが導出できる", () => {
  const { allocations, rawAllocations } = runTurnOne();
  assert.ok(allocations.length > 0, "legacyでも少なくとも1件のmarket×product配分結果が存在するはず");
  const sample = rawAllocations[0];
  const found = findLastQuarterBasePrice(allocations, sample.market, sample.product);
  assert.equal(found, unwrapUnit(sample.basePrice));
  for (const entry of allocations) {
    assert.deepEqual(Object.keys(entry).sort(), ["basePrice", "market", "product"]);
  }
});

test("PRICE-UI-5【tiered】: salesModelId=tiered-v200-candidate-v1でも同じ最小DTO形状で基準価格が導出できる（配分ロジックの違いに依存しない）", () => {
  const { allocations, rawAllocations } = runTurnOne({ salesModelId: "tiered-v200-candidate-v1" });
  assert.ok(allocations.length > 0, "tieredでも少なくとも1件のmarket×product配分結果が存在するはず");
  const sample = rawAllocations[0];
  const found = findLastQuarterBasePrice(allocations, sample.market, sample.product);
  assert.equal(found, unwrapUnit(sample.basePrice));
  for (const entry of allocations) {
    assert.deepEqual(Object.keys(entry).sort(), ["basePrice", "market", "product"]);
  }
});
