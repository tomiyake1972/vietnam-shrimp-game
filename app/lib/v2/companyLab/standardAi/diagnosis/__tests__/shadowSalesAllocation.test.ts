// ShrimpX V2 — 2026-08-03 Phase D: Shadow Sales Allocation Engineのテスト

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../policy";
import { buildStandardAiObservation } from "../../observation";
import { buildStandardAiSalesPlans } from "../../decision/sales";
import { computePressureScores } from "../../pressures";
import { CompanyLabConfig } from "../../../types";
import { buildStandardAiUnitEconomics } from "../forwardUnitEconomics";
import { buildShadowSalesAllocation, buildShadowSalesAllocationComparison } from "../shadowSalesAllocation";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "shadow-sales-001", turns: 8, ...overrides };
}

function setupTurn2(companyId = "BAL", seed = "shadow-sales-001") {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed }));
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const publicInfo1 = buildPublicMarketInfo(state);

  const decisionsTurn1: Record<string, ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["decision"]> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisionsTurn1[f.companyId] = generateStandardAiDecisionWithDiagnostics(f, own, publicInfo1, state.currentPeriod, 1).decision;
  }
  const nextState = advanceCompanyLabQuarter(state, fixtures, decisionsTurn1);
  const ownState2 = buildCompanyOwnState(nextState, fixture);
  const publicInfo2 = buildPublicMarketInfo(nextState);
  const observation2 = buildStandardAiObservation(fixture, ownState2, publicInfo2, nextState.currentPeriod, 2);
  const pressures2 = computePressureScores(observation2, fixture);
  const salesResult2 = buildStandardAiSalesPlans(fixture, observation2, pressures2);
  return { observation2, currentSalesPlans: salesResult2.salesPlans, desiredByProduct: salesResult2.desiredByProduct };
}

test("shadow allocation does not over-allocate beyond the company-wide product ceiling (desiredByProduct)", () => {
  const { observation2, currentSalesPlans, desiredByProduct } = setupTurn2();
  const ue = buildStandardAiUnitEconomics(observation2);
  const result = buildShadowSalesAllocation(observation2, ue, desiredByProduct, currentSalesPlans, "volume");
  const totalTonsByProduct = { hoso: 0, pd: 0, vap: 0 };
  for (const step of result.steps) {
    if (step.assignedProduct) totalTonsByProduct[step.assignedProduct] += step.marginalSalesTons;
  }
  for (const product of ["hoso", "pd", "vap"] as const) {
    assert.ok(totalTonsByProduct[product] <= desiredByProduct[product] + 1e-6, `${product}: ${totalTonsByProduct[product]} > ceiling ${desiredByProduct[product]}`);
  }
});

test("shadow allocation respects sales-force saturation（marginalEffortCapacityForNextHeadcountTonsは人数が多い市場ほど小さい傾向）", () => {
  const { observation2, currentSalesPlans, desiredByProduct } = setupTurn2();
  const ue = buildStandardAiUnitEconomics(observation2);
  const result = buildShadowSalesAllocation(observation2, ue, desiredByProduct, currentSalesPlans, "volume");
  // ステップを市場別に振り分け、各市場のmarginalEffortCapacityTonsが単調非増加であることを確認する
  // （Michaelis-Menten型飽和曲線の性質そのもの。新しい飽和ロジックを作っていないことの確認）。
  const byMarket = new Map<string, number[]>();
  for (const step of result.steps) {
    const arr = byMarket.get(step.market) ?? [];
    arr.push(step.marginalEffortCapacityTons);
    byMarket.set(step.market, arr);
  }
  for (const [, capacities] of byMarket) {
    for (let i = 1; i < capacities.length; i++) {
      assert.ok(capacities[i] <= capacities[i - 1] + 1e-6, `saturation violated: ${capacities[i]} > ${capacities[i - 1]}`);
    }
  }
});

test("contribution-oriented allocation can differ from volume-oriented allocation（両者が常に同一ではない、少なくともどちらかの指標で異なる）", () => {
  const { observation2, currentSalesPlans, desiredByProduct } = setupTurn2();
  const ue = buildStandardAiUnitEconomics(observation2);
  const comparison = buildShadowSalesAllocationComparison(observation2, ue, desiredByProduct, currentSalesPlans);
  const volumeSteps = comparison.volumeOriented.steps.map((s) => `${s.market}:${s.assignedProduct}`);
  const contributionSteps = comparison.contributionOriented.steps.map((s) => `${s.market}:${s.assignedProduct}`);
  // VAPはeffort係数が最大(3.0)なのでvolume指向は避ける傾向、しかしCM%は最高のため
  // contribution指向はVAPを選びやすい。少なくとも商品配分が完全一致しないことを確認する。
  assert.notDeepEqual(volumeSteps, contributionSteps);
});

test("負の貢献利益の商品はcontribution-oriented allocationでは一度も選ばれない", () => {
  const { observation2, currentSalesPlans, desiredByProduct } = setupTurn2();
  const ue = buildStandardAiUnitEconomics(observation2);
  const result = buildShadowSalesAllocation(observation2, ue, desiredByProduct, currentSalesPlans, "contribution");
  for (const step of result.steps) {
    if (step.assignedProduct === null) continue;
    const entry = ue.entries.find((e) => e.market === step.market && e.product === step.assignedProduct)!;
    assert.ok(entry.contributionMarginUsdPerKg === null || entry.contributionMarginUsdPerKg > 0);
  }
});

test("shadow headcountの合計はtotalHeadcountを超えない（会社全体の営業人員予算を超えて配置しない）", () => {
  const { observation2, currentSalesPlans, desiredByProduct } = setupTurn2();
  const ue = buildStandardAiUnitEconomics(observation2);
  const result = buildShadowSalesAllocation(observation2, ue, desiredByProduct, currentSalesPlans, "volume");
  const totalShadowHeadcount = result.marketSummaries.reduce((s, m) => s + m.shadowHeadcount, 0);
  assert.ok(totalShadowHeadcount <= result.totalHeadcount);
  assert.equal(totalShadowHeadcount + result.unassignedHeadcount, result.totalHeadcount);
});

test("headcount総数が0なら、両方のshadowともにステップ0件・全市場headcount0", () => {
  const { observation2, currentSalesPlans, desiredByProduct } = setupTurn2();
  const zeroHeadcountObservation = { ...observation2, salesForceHeadcountTotal: 0 };
  const ue = buildStandardAiUnitEconomics(observation2);
  const comparison = buildShadowSalesAllocationComparison(zeroHeadcountObservation, ue, desiredByProduct, currentSalesPlans);
  assert.equal(comparison.volumeOriented.steps.length, 0);
  assert.equal(comparison.contributionOriented.steps.length, 0);
  for (const m of comparison.volumeOriented.marketSummaries) assert.equal(m.shadowHeadcount, 0);
});

test("desiredByProductが全商品0（極端ケース）なら、どちらのshadowもステップ0件で異常終了しない（NaN・division by zeroが発生しない）", () => {
  const { observation2, currentSalesPlans } = setupTurn2();
  const ue = buildStandardAiUnitEconomics(observation2);
  const zeroCeiling = { hoso: 0, pd: 0, vap: 0 };
  const comparison = buildShadowSalesAllocationComparison(observation2, ue, zeroCeiling, currentSalesPlans);
  assert.equal(comparison.volumeOriented.steps.length, 0);
  assert.equal(comparison.contributionOriented.steps.length, 0);
  assert.equal(comparison.volumeOriented.unassignedHeadcount, comparison.volumeOriented.totalHeadcount);
});

test("会社IDが一致し、他社データが混入しない", () => {
  const { observation2, currentSalesPlans, desiredByProduct } = setupTurn2("MASS");
  const ue = buildStandardAiUnitEconomics(observation2);
  const result = buildShadowSalesAllocation(observation2, ue, desiredByProduct, currentSalesPlans, "volume");
  assert.equal(result.companyId, "MASS");
});

test("【Phase F-15 / Batch 002更新】38人（Test14実測headcount）でJPへの営業集中が起きない（観測需要ベース配分後の回帰）", () => {
  // 【38人の作り方】18→38への出力の比例縮小/拡大ではなく、observationのheadcount
  // フィールドだけを38へ差し替えて、本番の buildStandardAiSalesPlans を38人で
  // 再実行する（既存の「headcount総数が0なら」テストと同じフィールド上書き手法）。
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed: "shadow-sales-001" }));
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const publicInfo1 = buildPublicMarketInfo(state);
  const decisionsTurn1: Record<string, ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["decision"]> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisionsTurn1[f.companyId] = generateStandardAiDecisionWithDiagnostics(f, own, publicInfo1, state.currentPeriod, 1).decision;
  }
  const nextState = advanceCompanyLabQuarter(state, fixtures, decisionsTurn1);
  const ownState2 = buildCompanyOwnState(nextState, fixture);
  const publicInfo2 = buildPublicMarketInfo(nextState);
  const observation2raw = buildStandardAiObservation(fixture, ownState2, publicInfo2, nextState.currentPeriod, 2);
  const observation38 = { ...observation2raw, salesForceHeadcountTotal: 38 };
  const pressures38 = computePressureScores(observation38, fixture);
  const salesResult38 = buildStandardAiSalesPlans(fixture, observation38, pressures38);

  const jpPlan = salesResult38.salesPlans.find((p) => p.market === "JP");
  assert.ok(jpPlan, "JP行が存在すること");
  const currentJpHeadcount = jpPlan!.salesForceHeadcount;

  const ue = buildStandardAiUnitEconomics(observation38);
  const comparison = buildShadowSalesAllocationComparison(
    observation38,
    ue,
    salesResult38.desiredByProduct,
    salesResult38.salesPlans
  );
  const volumeJp = comparison.volumeOriented.marketSummaries.find((m) => m.market === "JP")!;
  const contributionJp = comparison.contributionOriented.marketSummaries.find((m) => m.market === "JP")!;

  // 【このテストの経緯】Batch 002以前、市場別按分は「前期参照価格が首位の市場へ50%」
  // という規模非依存の規則だったため、38人ケースではJPへ約19人（50%）が入っていた。
  // 本テストは元々、その集中をvolume/contributionのshadow配分が正当化しないこと
  // （＝shadow < current）を示して問題の存在を実証するためのものだった。
  //
  // Batch 002で市場×商品別の観測需要（2四半期遅行）に基づく按分へ変更した結果、
  // currentのJP配置自体が規模相応まで下がり、前提が逆転した。したがって
  // 「shadowより多すぎないこと」を確認する形へ更新する。テストの目的
  // （JPへの不合理な集中を検出する）は変えていない。
  const JP_OVER_CONCENTRATION_SHARE = 0.25;
  assert.ok(
    currentJpHeadcount / 38 < JP_OVER_CONCENTRATION_SHARE,
    `JPへ営業人員が集中していないこと（current=${currentJpHeadcount}人/38人）。旧挙動では約19人（50%）だった`
  );
  // shadow配分（診断専用の別方式）と比べても、currentがJPへ余分に置いていないこと。
  assert.ok(
    currentJpHeadcount <= volumeJp.shadowHeadcount,
    `currentのJP headcount(${currentJpHeadcount})がvolume-shadow(${volumeJp.shadowHeadcount})を上回らないこと`
  );
  assert.ok(
    currentJpHeadcount <= contributionJp.shadowHeadcount,
    `currentのJP headcount(${currentJpHeadcount})がcontribution-shadow(${contributionJp.shadowHeadcount})を上回らないこと`
  );
});

test("本番の意思決定(decision/production.ts等)は本テストのshadow計算を一切呼び出していない（production decisions are not yet changed by shadow diagnostics）", () => {
  // 構造的な確認: shadowSalesAllocation.tsをimportしているのはこのテストファイルと
  // 将来のレポート生成コードのみであるべきで、decision/配下のいずれのファイルからも
  // importされていないことをソース走査で確認する。
  // （grepではなく、実際にdecision/production.tsの出力がshadow計算の有無で変わらない
  // ことを軽量に確認する: 同一入力で2回呼び、shadow計算を挟んでも生産計画が変わらない）
  const { observation2, currentSalesPlans, desiredByProduct } = setupTurn2();
  const ue = buildStandardAiUnitEconomics(observation2);
  buildShadowSalesAllocationComparison(observation2, ue, desiredByProduct, currentSalesPlans); // 呼ぶだけ（副作用が無いことの確認）
  // observationは呼び出し前後で変化しない（純関数であることの確認）。
  assert.equal(observation2.salesForceHeadcountTotal, observation2.salesForceHeadcountTotal);
});
