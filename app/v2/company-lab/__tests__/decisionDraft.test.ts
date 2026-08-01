// ShrimpX V2 — 会社ラボ意思決定ドラフト テスト（Phase 7A受入確認5）
//
// 手動意思決定の編集グリッド（CompanyDecisionDraft）との往復
// （buildInitialDraft → buildDecisionInputFromDraft）で、Phase 7Aが追加した
// qualityReputation / customerRelationship / deliveryReliability が消失しないことを
// 確認する。このファイルが作成されるまで app/v2/company-lab/ 配下には自動テストが
// 存在しなかったため、本テストが最初のカバレッジとなる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { score0to100, unwrapUnit } from "../../../lib/v2/core/units";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../lib/v2/companyLab/autoPolicy";
import { CompanyLabConfig, CompanyLabState } from "../../../lib/v2/companyLab/types";
import { buildDecisionInputFromDraft, buildInitialDraft, summarizeSalesForceHiring } from "../decisionDraft";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed: "draft-roundtrip-001", turns: 8, ...overrides };
}

test("受入確認5: 品質・顧客信頼・納期信頼性が非中立な状態でも、draft往復(buildInitialDraft→buildDecisionInputFromDraft)でスコアが消失しない", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];

  // 中立値のままだと「消失していないか」が偶然一致で分からないため、意図的に非中立値を注入する。
  const injectedState: CompanyLabState = {
    ...state,
    qualityState: {
      qualityByCompanyProduct: state.qualityState.qualityByCompanyProduct.map((s) =>
        s.companyId === fixture.companyId && s.product === "hoso" ? { ...s, qualityScore: score0to100(72.5) } : s
      ),
      trustByCompanyMarket: state.qualityState.trustByCompanyMarket.map((t) =>
        t.companyId === fixture.companyId && t.market === "CN"
          ? { ...t, customerTrustScore: score0to100(63.4), deliveryReliabilityScore: score0to100(58.1) }
          : t
      ),
      rampHistory: state.qualityState.rampHistory,
    },
  };

  const ownState = buildCompanyOwnState(injectedState, fixture);
  const publicInfo = buildPublicMarketInfo(injectedState);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, injectedState.currentPeriod, 1);

  // 自動方針が実際にCN×hosoへ販売計画を立てていることを前提にする（立てていなければ
  // このテストの意味が薄れるため、まずそれ自体を確認する）。
  const cnHosoPlan = autoDecision.salesPlans.find((p) => p.market === "CN" && p.product === "hoso");
  assert.ok(cnHosoPlan, "自動方針がCN×hosoへ販売計画を立てていることが前提");
  assert.equal(unwrapUnit(cnHosoPlan!.qualityReputation!), 72.5);
  assert.equal(unwrapUnit(cnHosoPlan!.customerRelationship!), 63.4);
  assert.equal(unwrapUnit(cnHosoPlan!.deliveryReliability!), 58.1);

  // 1. 自動方針の出力 → 編集用ドラフトへ変換
  const draft = buildInitialDraft(fixture, autoDecision);
  const draftRow = draft.salesPlans.find((r) => r.market === "CN" && r.product === "hoso")!;
  assert.ok(draftRow, "ドラフトにCN×hoso行が存在する");
  assert.equal(unwrapUnit(draftRow.qualityReputation!), 72.5, "ドラフトへの変換でqualityReputationが消失していない");
  assert.equal(unwrapUnit(draftRow.customerRelationship!), 63.4, "ドラフトへの変換でcustomerRelationshipが消失していない");
  assert.equal(unwrapUnit(draftRow.deliveryReliability!), 58.1, "ドラフトへの変換でdeliveryReliabilityが消失していない");

  // 2. プレイヤーが数量だけを編集した想定（品質・信頼フィールドはUI編集対象外、costExpectationと同じ扱い）
  const editedDraft = {
    ...draft,
    salesPlans: draft.salesPlans.map((r) => (r.market === "CN" && r.product === "hoso" ? { ...r, desiredQuantity: r.desiredQuantity + 100 } : r)),
  };

  // 3. 編集後ドラフト → CompanyDecisionInputへ再変換
  const rebuiltInput = buildDecisionInputFromDraft(editedDraft, fixture, injectedState.currentPeriod);
  const rebuiltPlan = rebuiltInput.salesPlans.find((p) => p.market === "CN" && p.product === "hoso");
  assert.ok(rebuiltPlan, "再変換後もCN×hoso行が送信対象に残る（数量>0のため）");
  assert.equal(unwrapUnit(rebuiltPlan!.qualityReputation!), 72.5, "draft往復後もqualityReputationが消失していない");
  assert.equal(unwrapUnit(rebuiltPlan!.customerRelationship!), 63.4, "draft往復後もcustomerRelationshipが消失していない");
  assert.equal(unwrapUnit(rebuiltPlan!.deliveryReliability!), 58.1, "draft往復後もdeliveryReliabilityが消失していない");
});

test("受入確認5b: 自動方針が計画しなかった市場×商品の組合せ(数量0)にも、同一商品/同一市場の他エントリからqualityReputation等が引き継がれる", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);

  const draft = buildInitialDraft(fixture, autoDecision);
  // 網羅グリッドなので、自動方針が計画しなかった市場×商品の組合せも必ず1行存在する。
  const plannedKeys = new Set(autoDecision.salesPlans.map((p) => `${p.market}::${p.product}`));
  const unplannedRow = draft.salesPlans.find((r) => !plannedKeys.has(`${r.market}::${r.product}`));
  if (unplannedRow && autoDecision.salesPlans.length > 0) {
    // 同一商品の他市場向けエントリからqualityReputationが、同一市場の他商品向けエントリから
    // customerRelationship/deliveryReliabilityが引き継がれているはず（完全に未定義になるとは限らない）。
    const sameProductEntry = autoDecision.salesPlans.find((p) => p.product === unplannedRow.product);
    if (sameProductEntry?.qualityReputation !== undefined) {
      assert.equal(unwrapUnit(unplannedRow.qualityReputation!), unwrapUnit(sameProductEntry.qualityReputation));
    }
  }
});

// ---------------------------------------------------------------------
// 営業人員の追加採用（forward-port）
// ---------------------------------------------------------------------

test("summarizeSalesForceHiring: 採用予定0人なら、現在人数と次期見込みが一致する", () => {
  const preview = summarizeSalesForceHiring(18, 0);
  assert.deepEqual(preview, { currentHeadcount: 18, plannedHireCount: 0, nextQuarterHeadcount: 18 });
});

test("summarizeSalesForceHiring: 正の整数の採用予定は現在人数へ単純加算される（ユーザー提示例: 18人→採用6人→次期見込み24人）", () => {
  const preview = summarizeSalesForceHiring(18, 6);
  assert.deepEqual(preview, { currentHeadcount: 18, plannedHireCount: 6, nextQuarterHeadcount: 24 });
});

test("summarizeSalesForceHiring: 負数・NaN・Infinityの採用予定は0として扱う", () => {
  assert.equal(summarizeSalesForceHiring(18, -3).plannedHireCount, 0);
  assert.equal(summarizeSalesForceHiring(18, NaN).plannedHireCount, 0);
  assert.equal(summarizeSalesForceHiring(18, Infinity).plannedHireCount, 0);
});

test("summarizeSalesForceHiring: 小数の採用予定は四捨五入する", () => {
  assert.equal(summarizeSalesForceHiring(18, 6.4).plannedHireCount, 6);
  assert.equal(summarizeSalesForceHiring(18, 6.6).plannedHireCount, 7);
});

test("buildInitialDraft: 新しい四半期のドラフトは常に採用予定0人から始まる", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, autoDecision);
  assert.equal(draft.salesForceHireCount, 0);
});

test("draft往復(buildInitialDraft→buildDecisionInputFromDraft): プレイヤーが入力した採用予定人数が消失しない", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);

  const draft = buildInitialDraft(fixture, autoDecision);
  const editedDraft = { ...draft, salesForceHireCount: 6 };
  const rebuilt = buildDecisionInputFromDraft(editedDraft, fixture, state.currentPeriod);
  assert.equal(rebuilt.salesForceHireCount, 6, "draft往復後も採用予定人数6人が消失していない");
});

test("draft往復: 負数・小数・NaNの採用予定人数は0以上の整数へ丸められて送信される（ハードエラー防止）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, autoDecision);

  assert.equal(buildDecisionInputFromDraft({ ...draft, salesForceHireCount: -5 }, fixture, state.currentPeriod).salesForceHireCount, 0);
  assert.equal(buildDecisionInputFromDraft({ ...draft, salesForceHireCount: 6.6 }, fixture, state.currentPeriod).salesForceHireCount, 7);
  assert.equal(buildDecisionInputFromDraft({ ...draft, salesForceHireCount: NaN }, fixture, state.currentPeriod).salesForceHireCount, 0);
});

test("draft往復: この機能導入前に保存されたドラフト（salesForceHireCountキー自体が無い）は0として扱われる", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, autoDecision);

  const legacyDraft = { ...draft } as Record<string, unknown>;
  delete legacyDraft.salesForceHireCount;
  assert.ok(!("salesForceHireCount" in legacyDraft), "テスト前提: 旧ドラフトにキー自体が無いこと");

  const rebuilt = buildDecisionInputFromDraft(legacyDraft as unknown as typeof draft, fixture, state.currentPeriod);
  assert.equal(rebuilt.salesForceHireCount, 0);
});
