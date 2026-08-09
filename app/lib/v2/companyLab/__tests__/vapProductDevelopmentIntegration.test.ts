// ShrimpX V2 — Test15新設: VAP商品開発費（vapProductDevelopmentSpendUsd）の
// companyLab統合テスト（会計計上・スコア更新・タイミング・機能フラグの回帰確認）

import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig } from "../types";
import { lookupProductDevelopmentScore } from "../productDevelopmentState";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "vapdev-seed-001", turns: 8, ...overrides };
}

function buildAutoDecisions(state: ReturnType<typeof initializeCompanyLab>["state"], fixtures: ReturnType<typeof initializeCompanyLab>["fixtures"]) {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisions[f.companyId] = generateAutoPolicyDecision(f, own, publicInfo, state.currentPeriod, 1);
  }
  return decisions;
}

/**
 * VAP商品開発投資は SG&A として費用計上される。したがって課税所得がある会社では
 * 法人税が減り、**現金の減少は投資額そのものではなく税効果を差し引いた額**になる。
 *
 *   課税所得がある場合: 現金差分 = 投資額 × (1 − incomeTaxRate)
 *   課税所得が無い場合: 現金差分 = 投資額（節税できる利益が無いため）
 *
 * これは会計として正しい挙動である。2026-08-08のTest16能力再設計までは
 * 対象会社のQ1が課税所得ゼロだったため「現金差分 = 投資額」が偶然成立していた。
 *
 * このテストが守りたいのは「投資額が唯一の情報源として、二重計上も欠落もなく
 * 1回だけ会計へ流れること」であり、税金が無い世界を人工的に作ることではない。
 * したがって税効果を織り込んだ期待式にする（incomeTaxRateは正式なfinance
 * parameterから読み、テスト内へ数値を直書きしない）。
 */
test("VAPDEV-INT-1: vapProductDevelopmentSpendUsdが唯一の情報源として1回だけ会計へ流れ、税効果を含めた現金差分が正しくなる", () => {
  const SPEND_USD = 250_000;
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;

  const decisionsBase = buildAutoDecisions(state, fixtures);
  const decisionsWithSpend: Record<string, CompanyDecisionInput> = {
    ...decisionsBase,
    [targetCompanyId]: { ...decisionsBase[targetCompanyId], vapProductDevelopmentSpendUsd: SPEND_USD },
  };

  const afterBase = advanceCompanyLabQuarter(state, fixtures, decisionsBase);
  const afterSpend = advanceCompanyLabQuarter(state, fixtures, decisionsWithSpend);

  // 【tsc修正】Usd（finance/types.ts）はcore/units.tsのBrand<T,B>とは別のブランド機構
  // （別のunique symbol）のため、unwrapUnitへは渡せない。Usdはnumberのサブタイプ
  // なので算術演算にはそのまま使える（unwrapは不要）。
  const cashBase = Number(afterBase.financeState.companies.find((c) => c.companyId === targetCompanyId)!.cash);
  const cashSpend = Number(afterSpend.financeState.companies.find((c) => c.companyId === targetCompanyId)!.cash);

  // 実際のquarter closeロジックと整合させるため、税引前利益の符号で分岐する。
  // 投資後も課税所得が残っているなら税効果が丸ごと効き、
  // 投資によって課税所得が消えるなら効き方が変わるため、両方を許容する。
  const plBase = afterBase.history[afterBase.history.length - 1].financialResults.find((f) => f.companyId === targetCompanyId)!.profitAndLoss;
  const plSpend = afterSpend.history[afterSpend.history.length - 1].financialResults.find((f) => f.companyId === targetCompanyId)!.profitAndLoss;
  const taxRate = FINANCE_PARAMETERS_V1.finance.incomeTaxRate;

  const actualCashDifference = cashBase - cashSpend;
  // 実際に減った法人税額（会計結果そのものから取る。推定しない）。
  const actualTaxSaving = Number(plBase.incomeTax) - Number(plSpend.incomeTax);
  const expectedCashDifference = SPEND_USD - actualTaxSaving;

  assert.ok(
    Math.abs(actualCashDifference - expectedCashDifference) < 1,
    `現金差分は「投資額 − 実際の節税額」と一致するはず` +
      `（現金差分=${actualCashDifference}, 投資額=${SPEND_USD}, 節税額=${actualTaxSaving}）`
  );

  // 節税額そのものも、税率と税引前利益の減少から説明できること。
  // 投資後も課税所得が残っている場合は 投資額 × 税率 がまるごと効く。
  if (Number(plSpend.profitBeforeTax) > 0) {
    assert.ok(
      Math.abs(actualTaxSaving - SPEND_USD * taxRate) < 1,
      `課税所得が残っている場合、節税額は 投資額 × ${taxRate} と一致するはず（実際=${actualTaxSaving}）`
    );
  } else if (Number(plBase.profitBeforeTax) <= 0) {
    // 投資前から赤字なら法人税は発生せず、現金は投資額そのものだけ減る。
    assert.equal(actualTaxSaving, 0, "赤字の会社では節税効果が発生しないこと");
    assert.ok(Math.abs(actualCashDifference - SPEND_USD) < 1, "赤字の会社では現金差分が投資額と一致すること");
  }

  // 【二重計上・欠落の検出】投資額を超えて現金が減っていない／減らなさすぎていないこと。
  assert.ok(actualCashDifference > 0, "投資したのに現金が減っていない（欠落）");
  assert.ok(actualCashDifference <= SPEND_USD + 1, "投資額を超えて現金が減っている（二重計上の疑い）");
});

test("VAPDEV-INT-2: vapProductDevelopmentSpendUsdを設定した会社だけ、次期のVAP商品開発スコアが中立値50から上昇する（他社は変化しない）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;
  const otherCompanyId = fixtures[1].companyId;

  const decisionsBase = buildAutoDecisions(state, fixtures);
  const decisions: Record<string, CompanyDecisionInput> = {
    ...decisionsBase,
    [targetCompanyId]: { ...decisionsBase[targetCompanyId], vapProductDevelopmentSpendUsd: 500_000 },
  };

  const after = advanceCompanyLabQuarter(state, fixtures, decisions);
  const targetScore = lookupProductDevelopmentScore(after.productDevelopmentState, targetCompanyId);
  const otherScore = lookupProductDevelopmentScore(after.productDevelopmentState, otherCompanyId);

  assert.ok(targetScore > 50, `投資した会社のスコアは中立値50を上回るはず（実際: ${targetScore}）`);
  assert.ok(Math.abs(otherScore - 50) < 1e-6, `投資していない会社のスコアは中立値50のままのはず（実際: ${otherScore}）`);
});

test("VAPDEV-INT-3（タイミング）: 当期のvapProductDevelopmentSpendUsdは当期のVAP能力へは反映されず、次期のスコアにのみ反映される（前四半期末までの値のみを読む規約）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;
  const decisionsQ1 = buildAutoDecisions(state, fixtures);
  const decisionsQ1WithSpend: Record<string, CompanyDecisionInput> = {
    ...decisionsQ1,
    [targetCompanyId]: { ...decisionsQ1[targetCompanyId], vapProductDevelopmentSpendUsd: 500_000 },
  };

  const afterQ1 = advanceCompanyLabQuarter(state, fixtures, decisionsQ1WithSpend);
  // Q1終了直後の状態には、Q1のspendを反映した「次期用」のスコアが入っている
  // （＝Q1の意思決定・成約時点ではまだ中立値50だったはず、という直接検証は
  // 内部関数境界の外からは難しいため、次期の状態が確かに前期投資を反映して
  // いること＝繰り越しが機能していることを確認する）。
  const scoreAfterQ1 = lookupProductDevelopmentScore(afterQ1.productDevelopmentState, targetCompanyId);
  assert.ok(scoreAfterQ1 > 50);

  // Q2でspendなしなら、Q1で積み上げたスコアから中立値へ向けて減衰するはず
  // （Q1投資の効果がQ2以降にも繰り越されており、単発で消えないことの確認）。
  const decisionsQ2 = buildAutoDecisions(afterQ1, fixtures);
  const afterQ2 = advanceCompanyLabQuarter(afterQ1, fixtures, decisionsQ2);
  const scoreAfterQ2 = lookupProductDevelopmentScore(afterQ2.productDevelopmentState, targetCompanyId);
  assert.ok(scoreAfterQ2 < scoreAfterQ1, "Q2にspend無しなら中立値へ向けて減衰するはず");
  assert.ok(scoreAfterQ2 > 50, "Q1の投資効果が完全には消えていないはず（減衰は緩やか）");
});

test("VAPDEV-INT-4（既定ONの確認・コーディネーター指示による修正）: vapProductDevelopmentCompetitiveness未指定（既定）では、VAP販売計画を持つ全社の意思決定へ正典のvapCapabilityScoreが実際に付与される", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const decisions = buildAutoDecisions(state, fixtures);

  const after = advanceCompanyLabQuarter(state, fixtures, decisions);
  let sawVapPlan = false;
  for (const d of after.history[0].decisions) {
    for (const plan of d.salesPlans) {
      if (plan.product !== "vap") continue;
      sawVapPlan = true;
      assert.notEqual(plan.vapCapabilityScore, undefined, `${d.companyId}のVAP計画にはvapCapabilityScoreが既定で付与されるはず`);
    }
  }
  assert.ok(sawVapPlan, "このシナリオ設定にVAP販売計画が1件も無く、テストの前提が崩れている");
});

test("VAPDEV-INT-5（明示OFF確認）: vapProductDevelopmentCompetitiveness=falseを明示指定すると、他社の意思決定オブジェクトは参照同一のまま変わらない（無効化できることの確認）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ sai5: { vapProductDevelopmentCompetitiveness: false } }));
  const decisions = buildAutoDecisions(state, fixtures);
  const otherCompanyId = fixtures[1].companyId;
  const originalOtherDecision = decisions[otherCompanyId];

  const after = advanceCompanyLabQuarter(state, fixtures, decisions);
  const otherDecisionAfter = after.history[0].decisions.find((d) => d.companyId === otherCompanyId);
  assert.equal(otherDecisionAfter, originalOtherDecision, "明示的にfalseを指定すれば、他社の意思決定オブジェクト参照が変わらないはず");
});
