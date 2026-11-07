// ShrimpX V2 — CompanyOwnState.salesModelFacts（テストプレイ指摘⑥⑦・2026-11）
//
// 【このテストが守るもの】
//   画面が「VAP商品開発費はこのRunで効くのか」「市場集中による価格下落は働くのか」を
//   説明するために読む値が、エンジンが当期実際に使う設定と一致していること。
//   画面側は salesBaseCompetitivenessWeight と同じ規約でこの値だけを根拠にするため、
//   ここがずれると誤った説明がそのまま受講者に出る。
//
// 【エンジンの挙動は変えていない】salesModelFacts は転記だけであり、
//   既存の販売モデル解決（salesParametersFor / crowdingPolicyForModelId）には触れていない。

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildCompanyOwnState, initializeCompanyLab } from "../index";
import type { CompanyLabConfig } from "../types";

function factsFor(overrides: Partial<CompanyLabConfig>) {
  const config = {
    scenarioId: "baseline",
    mode: "canonical",
    seed: "sales-model-facts",
    turns: 4,
    ...overrides,
  } as CompanyLabConfig;
  const { state, fixtures } = initializeCompanyLab(config);
  const ownState = buildCompanyOwnState(state, fixtures[0]);
  assert.ok(ownState.salesModelFacts, "salesModelFacts が公開されていない");
  return ownState.salesModelFacts;
}

test("FACTS-1【従来市場モデル】: legacy では配分方式が legacyWaterfall で、Crowding は無効", () => {
  const facts = factsFor({ salesModelId: "legacy-waterfall-v1" });
  assert.equal(facts.marketAllocationMode, "legacyWaterfall");
  assert.equal(facts.crowdingPriceMarkdownActive, false);
});

test("FACTS-2【三層顧客価格モデル】: tiered では配分方式が tieredSimultaneousAllocation になる", () => {
  const facts = factsFor({ salesModelId: "tiered-v200-candidate-v1" });
  assert.equal(facts.marketAllocationMode, "tieredSimultaneousAllocation");
  assert.equal(facts.crowdingPriceMarkdownActive, false, "candidate-v1 は Crowding を持たない");
});

test("FACTS-3【市場集中価格下落あり】: crowding-v1 では Crowding が有効と分かる", () => {
  const facts = factsFor({ salesModelId: "tiered-v200-crowding-v1" });
  assert.equal(facts.marketAllocationMode, "tieredSimultaneousAllocation");
  assert.equal(facts.crowdingPriceMarkdownActive, true);
});

test("FACTS-4【VAP能力ウェイト】: 既定ではどちらのモデルでも正の値が公開される（実測値をそのまま出す）", () => {
  // 【実測メモ・2026-11】三層顧客価格モデルの SalesParameters は
  // SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1 を展開して作られているため、
  // competitivenessWeights.vapCapability は 0 ではなく 0.08 である。
  // ただし tiered 配分は competitivenessWeights を使わず、VAP商品開発スコアは
  // 「差別化」評価として別経路で効く。画面はこの2経路を取り違えないよう、
  // marketAllocationMode を先に見てから文言を選ぶ（InvestmentPlanningScreen 参照）。
  const tiered = factsFor({ salesModelId: "tiered-v200-crowding-v1" });
  assert.ok(tiered.vapCapabilityCompetitivenessWeight > 0);

  // salesModelId 未指定（この機能より前に作られたRun）は legacy variant 解決へ落ち、
  // vapProductDevelopmentCompetitiveness が既定ONのためウェイトは正になる。
  const legacyDefault = factsFor({});
  assert.equal(legacyDefault.marketAllocationMode, "legacyWaterfall");
  assert.ok(legacyDefault.vapCapabilityCompetitivenessWeight > 0, "既定の従来モデルでVAP能力ウェイトが0になっている");
});

test("FACTS-5【明示的なOFF】: VAP能力を明示的に切ったRunではウェイトが0になる", () => {
  const off = factsFor({ sai5: { vapProductDevelopmentCompetitiveness: false } } as Partial<CompanyLabConfig>);
  assert.equal(off.vapCapabilityCompetitivenessWeight, 0);
});
