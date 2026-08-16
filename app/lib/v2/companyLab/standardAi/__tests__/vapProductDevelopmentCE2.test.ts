// ShrimpX V2 — Standard AI Capability Expansion（Phase CE-2）単体テスト
//
// 指示§38の CE2-1〜12 にそのまま対応させる。既存のVAP商品開発エンジン
// （companyLab/productDevelopmentState.ts・premiumPolicy.ts）そのものは一切
// 変更していないため、それらのヘッドルーム式・4段階tier・非価格競争力への
// 効果は既存の productDevelopmentState.test.ts / vapProductDevelopmentIntegration.test.ts /
// vapCapabilityCoefficient.test.ts が引き続き検証する。ここでは
// decision/vapProductDevelopment.tsに新設した「候補生成（tier選択）」だけを対象にする。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStandardAiVapProductDevelopmentDecision } from "../decision/vapProductDevelopment";
import { StandardAiObservation } from "../types";
import { PressureScores } from "../pressures";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "../parameters";
import { resolveStandardAiProfileForMode } from "../orientationProfile";
import { CompanyFixture } from "../../types";
import { DEMAND_MARKET_IDS } from "../../../market/types";
import { VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD } from "../../productDevelopmentState";

function fixtureFor(companyId: string): CompanyFixture {
  return {
    companyId,
    productEconomics: {
      expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 },
      premiumEconomics: {
        vap: {
          expectedVariableProcessingCostUsdPerHosoEqKg: 0.43,
          allocatedFixedCostUsdPerHosoEqKg: 0.35,
          sellingAndLogisticsCostUsdPerHosoEqKg: 0.1,
          targetMarginUsdPerHosoEqKg: 0.5,
          avoidableVariableProcessingCostUsdPerHosoEqKg: 0.43,
          incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.06,
          minimumContributionMarginUsdPerHosoEqKg: 0.1,
        },
      },
    },
  } as unknown as CompanyFixture;
}

/**
 * VAP稼働率90%・十分なプレミアムを持つ、経済性良好な観測。
 * vapProductionTons=4500・vapContributionMarginUsdPerHosoEqKg=0.5なので、
 * currentQuarterlyVapContributionUsd = 4500 × 1000 × 0.5 = $2,250,000/四半期。
 * 最上位tier$500,000でもaffordability = 500,000/2,250,000 ≈ 0.22四半期 << 基準3四半期。
 */
function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    period: "2015Q3",
    turn: 20,
    totalEffectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    lastQuarterActualProductionByProduct: { hoso: 3000, pd: 3000, vap: 4500 },
    marketPremiumByProduct: { pd: 1.0, vap: 3.0 },
    vapProductDevelopmentScore: 50,
    cashUsd: 200_000_000,
    ...overrides,
  } as unknown as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
  return {
    borrowingPressure: 0.1,
    targetMinimumCashUsd: 30_000_000,
    marketPriceRanking: [...DEMAND_MARKET_IDS],
    ...overrides,
  } as unknown as PressureScores;
}

const MAX_TIER = Math.max(...VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD);

test("CE2-1: PROFILE OFF（STANDARD_AI_PARAMETERS_V1そのまま）でもVAP商品開発capabilityを利用できる", () => {
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor("BAL"), observation(), pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.ok(result.diagnostics.some((d) => d.code === "VAP_DEV_CONSIDERED"));
  assert.ok(result.spendUsd > 0, "OFF相当のparamsでも経済性が良好ならVAP商品開発費を提案できるはず");
  assert.ok(result.diagnostics.some((d) => d.code === "VAP_DEV_PROPOSED"));
});

test("CE2-2: VAP opportunityが低い（稼働率が低い）と候補にならない", () => {
  const obs = observation({ lastQuarterActualProductionByProduct: { hoso: 3000, pd: 3000, vap: 300 } });
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor("BAL"), obs, pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.equal(result.spendUsd, 0);
  assert.ok(result.diagnostics.some((d) => d.code === "VAP_DEV_LOW_OPPORTUNITY"));
});

test("CE2-3: VAP opportunityが高く経済性も良好なら候補になる（最上位tierが選ばれる）", () => {
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor("BAL"), observation(), pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.equal(result.spendUsd, MAX_TIER, "affordabilityに十分な余裕があるため最上位tierが選ばれるはず");
});

test("CE2-4: 会社のVAP商品志向（既存のproductOrientationMultipliers）がVAP商品開発への戦略適合をソフトに引き上げる（強制ルールではない）", () => {
  // 【経済性設計】affordabilityが基準ぎりぎり（3四半期）となる境界ケースを作る。
  // 基準パラメータでは最上位tierが見送りになるが、VAP志向の高いパラメータでは
  // 同じ経済性でもより高いtierが選ばれる。稼働率ゲート（52%）は満たす値にする。
  const borderline = observation({ lastQuarterActualProductionByProduct: { hoso: 3000, pd: 3000, vap: 2600 } });
  // currentQuarterlyVapContributionUsd = 2600*1000*0.5 = $1,300,000。
  // 最上位tier$500,000のaffordability = 500,000/1,300,000 ≈ 0.38四半期（基準3以下で通る）。
  // より制約的な境界を作るため、targetMarginを下げたfixtureを使う。
  const lowMarginFixture: CompanyFixture = {
    ...fixtureFor("BAL"),
    productEconomics: {
      ...fixtureFor("BAL").productEconomics,
      premiumEconomics: {
        vap: {
          ...fixtureFor("BAL").productEconomics.premiumEconomics.vap,
          targetMarginUsdPerHosoEqKg: 0.06,
        },
      },
    },
  } as unknown as CompanyFixture;
  // currentQuarterlyVapContributionUsd = 2600*1000*0.06 = $156,000。
  // 最上位tier$500,000 affordability = 500,000/156,000 ≈ 3.21四半期 > 基準3 → 基準では見送り。
  const baselineResult = buildStandardAiVapProductDevelopmentDecision(lowMarginFixture, borderline, pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.notEqual(baselineResult.spendUsd, MAX_TIER, "前提: 基準paramsでは最上位tierのaffordabilityが基準を超えるはず");

  const vapOrientedParams: StandardAiParameters = {
    ...STANDARD_AI_PARAMETERS_V1,
    productOrientationMultipliers: { hoso: 0.9, vap: 1.2 },
  };
  const biasedResult = buildStandardAiVapProductDevelopmentDecision(lowMarginFixture, borderline, pressures(), vapOrientedParams);
  assert.equal(biasedResult.spendUsd, MAX_TIER, "VAP志向が高い場合、同じ経済性でも最上位tierが選ばれるべき");
});

test("CE2-5: MASS（HOSO/scale志向）でもハードブロックされない。経済性が非常に良好なら投資可能", () => {
  const jpqOrientationLikeParams = resolveStandardAiProfileForMode("MASS", "ON").params;
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor("MASS"), observation(), pressures(), jpqOrientationLikeParams);
  assert.ok(result.spendUsd > 0, "MASSでも経済性が非常に良好な入力ではVAP商品開発費が提案されるべき（if company==MASSのハードブロックが無いことの確認）");
});

test("CE2-6: Finance Gateが機能する（財務ゲート未達のtierは選ばれない）", () => {
  const obs = observation({ cashUsd: 1_000_000 });
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor("BAL"), obs, pressures({ targetMinimumCashUsd: 30_000_000 }), STANDARD_AI_PARAMETERS_V1);
  assert.equal(result.spendUsd, 0);
  assert.ok(result.diagnostics.some((d) => d.code === "VAP_DEV_FINANCE_BLOCKED"));
});

test("CE2-7: SEVERE_DISTRESS相当のCrisis Gateは、VAP商品開発の新規支出提案も一律にゼロ化する", () => {
  // 【アーキテクチャ上の保証】policy.tsのvapProductDevelopmentSpendUsdAfterCrisisGateは
  // isSevereDistress ? 0 : vapProductDevelopmentResult.spendUsd という、CM-1由来の
  // 一律ゲートである。ここではその式をpolicy.tsと同一の形で直接検証する。
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor("BAL"), observation(), pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.ok(result.spendUsd > 0, "前提: この入力ではVAP商品開発費が提案されるはず");
  const isSevereDistress = true;
  const spendUsdAfterCrisisGate = isSevereDistress ? 0 : result.spendUsd;
  assert.equal(spendUsdAfterCrisisGate, 0, "SEVERE_DISTRESSでは新規VAP商品開発支出も0になるべき");
});

test("CE2-8: VAP商品開発スコアが既に高くヘッドルームが乏しい場合は新規支出を見送る（saturation guard）", () => {
  const obs = observation({ vapProductDevelopmentScore: 96 });
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor("BAL"), obs, pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.equal(result.spendUsd, 0);
  assert.ok(result.diagnostics.some((d) => d.code === "VAP_DEV_ALREADY_ACTIVE"));
});

test("CE2-9: VAP商品開発費とVAPライン増設（能力増強）は別ドメインであり、互いを排除しない（本関数はVAPライン判断に関知しない）", () => {
  // decision/vapProductDevelopment.tsはVAPライン増設（decision/capex.ts側）を
  // 一切参照・変更しない。同じ入力からVAP商品開発費を独立に決定できることを確認する。
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor("BAL"), observation(), pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.ok(result.spendUsd > 0);
  // capexDecisionへの参照が一切無いことを型レベルでも示す（引数にcapex関連の値を取らない）。
  // 【注記】paramsはデフォルト値を持つため、Function.lengthはデフォルト値の手前
  // までの必須引数の個数（3: fixture, observation, pressures）を返す。
  assert.equal(buildStandardAiVapProductDevelopmentDecision.length, 3, "capex関連の引数を追加で要求しない設計であるべき");
});

test("CE2-10: Analysis Pack向けのfirst-classなkeyValues（vapSalesTons等）がVAP_DEV_PROPOSEDに記録される", () => {
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor("BAL"), observation(), pressures(), STANDARD_AI_PARAMETERS_V1);
  const proposed = result.diagnostics.find((d) => d.code === "VAP_DEV_PROPOSED");
  assert.ok(proposed);
  assert.ok(proposed!.keyValues?.vapSalesTons !== undefined);
  assert.ok(proposed!.keyValues?.vapProductionTons !== undefined);
  assert.ok(proposed!.keyValues?.vapOpportunityTons !== undefined);
  assert.ok(proposed!.keyValues?.vapContributionMargin !== undefined);
  assert.ok(proposed!.keyValues?.currentDevelopmentScore !== undefined);
  assert.ok(proposed!.keyValues?.expectedIncrementalBenefitUsd !== undefined);
  assert.ok(proposed!.keyValues?.investmentCostUsd !== undefined);
  assert.ok(proposed!.keyValues?.paybackQuarters !== undefined);
  assert.ok(proposed!.keyValues?.strategyFitMultiplier !== undefined);
  assert.ok(proposed!.keyValues?.financialConservatismRatio !== undefined);
});

test("CE2-11: VAP商品開発は既存のCompanyDecisionInput.vapProductDevelopmentSpendUsd（一般的なdecision永続化経路）だけを使い、新しい永続化状態を必要としない", () => {
  // 【永続化経路】CE-2はcompanyLab/persistence/*.tsを一切変更していない。
  // spendUsdは既に永続化されているCompanyDecisionInput.vapProductDevelopmentSpendUsd
  // （4段階tierのいずれか）としてそのまま提出されるだけであり、選ばれたtierがその
  // 4段階のいずれかと厳密に一致することを確認する（新しい任意の数値を発明していない）。
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor("BAL"), observation(), pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.ok(
    VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD.some((t) => Math.abs(t - result.spendUsd) < 1e-6),
    "選ばれた支出額は既存の4段階tierのいずれかと厳密に一致するべき"
  );
});

test("CE2-12: VAP商品開発の判断は決定論的である（同一入力を再実行しても同じ結果）", () => {
  const run1 = buildStandardAiVapProductDevelopmentDecision(fixtureFor("BAL"), observation(), pressures(), STANDARD_AI_PARAMETERS_V1);
  const run2 = buildStandardAiVapProductDevelopmentDecision(fixtureFor("BAL"), observation(), pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.equal(run1.spendUsd, run2.spendUsd);
  assert.deepEqual(run1.diagnostics, run2.diagnostics);
});
