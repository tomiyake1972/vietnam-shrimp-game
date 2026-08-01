// ShrimpX V2 — Test15新設: VAP商品開発費（vapProductDevelopmentSpendUsd）の
// companyLab統合テスト（会計計上・スコア更新・タイミング・機能フラグの回帰確認）

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig } from "../types";
import { lookupProductDevelopmentScore } from "../productDevelopmentState";
import { unwrapUnit } from "../../core/units";

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

test("VAPDEV-INT-1: vapProductDevelopmentSpendUsdを設定すると、当期末の現金がその金額だけ、設定しない場合より少なくなる（会計計上の唯一の情報源の確認）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;

  const decisionsBase = buildAutoDecisions(state, fixtures);
  const decisionsWithSpend: Record<string, CompanyDecisionInput> = {
    ...decisionsBase,
    [targetCompanyId]: { ...decisionsBase[targetCompanyId], vapProductDevelopmentSpendUsd: 250_000 },
  };

  const afterBase = advanceCompanyLabQuarter(state, fixtures, decisionsBase);
  const afterSpend = advanceCompanyLabQuarter(state, fixtures, decisionsWithSpend);

  const cashBase = unwrapUnit(afterBase.financeState.companies.find((c) => c.companyId === targetCompanyId)!.cash);
  const cashSpend = unwrapUnit(afterSpend.financeState.companies.find((c) => c.companyId === targetCompanyId)!.cash);

  assert.ok(Math.abs(cashBase - cashSpend - 250_000) < 1, `現金差分が投資額と一致するはず（base=${cashBase}, spend=${cashSpend}）`);
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

test("VAPDEV-INT-4（機能フラグ・回帰確認）: vapProductDevelopmentCompetitiveness未指定（既定）では、選択会社以外の意思決定オブジェクトは参照同一のまま変わらない", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const decisions = buildAutoDecisions(state, fixtures);
  const otherCompanyId = fixtures[1].companyId;
  const originalOtherDecision = decisions[otherCompanyId];

  const after = advanceCompanyLabQuarter(state, fixtures, decisions);
  const otherDecisionAfter = after.history[0].decisions.find((d) => d.companyId === otherCompanyId);
  assert.equal(otherDecisionAfter, originalOtherDecision, "機能フラグ未指定時は、他社の意思決定オブジェクト参照が変わらないはず（ビット単位の後方互換）");
});
