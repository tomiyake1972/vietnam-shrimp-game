// ShrimpX V2 — ENG-SALES-MODEL-PERSIST-2 §11 salesParametersFor の解決優先順位
//
// 優先順位: salesParamsOverride > salesModelId > sai5 由来の legacy variant。
// legacy ID を明示しても SALES_PARAMETERS_V1 へ固定せず、現行の variant 解決を使う。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState } from "../types";
import {
  SALES_PARAMETERS_V1,
  SALES_PARAMETERS_SAI5_SALES_BASE_V1,
  SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1,
  SALES_PARAMETERS_TEST15_VAP_CAPABILITY_AND_SALES_BASE_V1,
  SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1,
  SALES_PARAMETERS_TIERED_FIXTURE_V0,
  SalesParameters,
} from "../../sales/parameters";

/** Engine が使った SalesParameters を配分結果から判別する（tiered は Σweight ≤ 1）。 */
function isTieredRun(overrides: Partial<CompanyLabConfig>): boolean {
  const config = { scenarioId: "baseline", mode: "canonical", seed: "smid", turns: 2, ...overrides } as CompanyLabConfig;
  const init = initializeCompanyLab(config);
  let state: CompanyLabState = init.state;
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of init.fixtures) {
    decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, 1);
  }
  state = advanceCompanyLabQuarter(state, init.fixtures, decisions);
  const record = state.history[state.history.length - 1];
  return record.salesRecord.allocations.every((a) => a.companies.reduce((s, c) => s + c.competitivenessWeight, 0) <= 1 + 1e-9);
}

/** 記録された competitivenessBreakdown から、Engine が使ったウェイトを逆算する。 */
function engineWeights(overrides: Partial<CompanyLabConfig>) {
  const config = { scenarioId: "baseline", mode: "canonical", seed: "smid", turns: 2, ...overrides } as CompanyLabConfig;
  const init = initializeCompanyLab(config);
  let state: CompanyLabState = init.state;
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of init.fixtures) {
    decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, 1);
  }
  state = advanceCompanyLabQuarter(state, init.fixtures, decisions);
  const record = state.history[state.history.length - 1];
  const alloc = record.salesRecord.allocations.find((a) => a.product === "vap" && a.companies.length > 0)!;
  const key = JSON.stringify(
    record.salesRecord.allocations.map((a) => a.companies.map((c) => [c.companyId, c.competitivenessWeight, c.competitivenessBreakdown]))
  );
  return { alloc, key };
}

const expectSameAs = (a: Partial<CompanyLabConfig>, b: Partial<CompanyLabConfig>, label: string) =>
  assert.equal(engineWeights(a).key, engineWeights(b).key, label);
const expectDifferentFrom = (a: Partial<CompanyLabConfig>, b: Partial<CompanyLabConfig>, label: string) =>
  assert.notEqual(engineWeights(a).key, engineWeights(b).key, label);

// =====================================================================

test("SMID-RESOLVE-A: salesModelId 未指定・sai5 なし → 現行 TEST15_VAP_CAPABILITY_V1（挙動不変）", () => {
  assert.equal(isTieredRun({}), false);
  // 明示 legacy と完全一致することで、既定が legacy variant 解決であることを固定する。
  expectSameAs({}, { salesModelId: "legacy-waterfall-v1" }, "既定と明示 legacy が一致しない");
});

test("SMID-RESOLVE-B: salesModelId 未指定・salesBaseAccumulation=true → 現行どおり", () => {
  const withSalesBase = { sai5: { salesBaseAccumulation: true } } as Partial<CompanyLabConfig>;
  assert.equal(isTieredRun(withSalesBase), false);
  // sai5 の有無で解決が変わる（＝legacy variant 解決が生きている）。
  expectDifferentFrom({}, withSalesBase, "salesBaseAccumulation が legacy variant へ効いていない");
});

test("SMID-RESOLVE-C: legacy-waterfall-v1 明示 + salesBase=true → B と同じ（V1 固定に落とさない）", () => {
  const b = { sai5: { salesBaseAccumulation: true } } as Partial<CompanyLabConfig>;
  const c = { salesModelId: "legacy-waterfall-v1", sai5: { salesBaseAccumulation: true } } as Partial<CompanyLabConfig>;
  expectSameAs(b, c, "明示 legacy が sai5 を無視して固定値へ落ちている");
  // SALES_PARAMETERS_V1 へ固定していたら、sai5 なしの既定と同じになってしまうはず。
  expectDifferentFrom(c, { salesModelId: "legacy-waterfall-v1" }, "明示 legacy が SALES_PARAMETERS_V1 固定になっている");
});

test("SMID-RESOLVE-D: tiered-v200-candidate-v1 → tiered 経路へ入る", () => {
  assert.equal(isTieredRun({ salesModelId: "tiered-v200-candidate-v1" } as Partial<CompanyLabConfig>), true);
  expectDifferentFrom({}, { salesModelId: "tiered-v200-candidate-v1" } as Partial<CompanyLabConfig>, "tiered ID で配分が変わらない");
});

test("SMID-RESOLVE-E: tiered ID + salesBaseAccumulation=true でも tiered を維持（legacy へ戻らない）", () => {
  const tieredWithFlag = { salesModelId: "tiered-v200-candidate-v1", sai5: { salesBaseAccumulation: true } } as Partial<CompanyLabConfig>;
  assert.equal(isTieredRun(tieredWithFlag), true);
  expectDifferentFrom(tieredWithFlag, { sai5: { salesBaseAccumulation: true } } as Partial<CompanyLabConfig>, "tiered ID が sai5 で legacy へ戻っている");
});

test("SMID-RESOLVE-F: salesParamsOverride + tiered ID → override が最優先", () => {
  const both = {
    salesModelId: "tiered-v200-candidate-v1",
    salesParamsOverride: SALES_PARAMETERS_TIERED_FIXTURE_V0,
  } as Partial<CompanyLabConfig>;
  // fixture V0 と candidate V1 は demandShare も qualitySensitivity も異なるため、
  // override が効いていれば candidate 単独とは違う結果になる。
  expectDifferentFrom(both, { salesModelId: "tiered-v200-candidate-v1" } as Partial<CompanyLabConfig>, "override が tiered ID に負けている");
  expectSameAs(both, { salesParamsOverride: SALES_PARAMETERS_TIERED_FIXTURE_V0 } as Partial<CompanyLabConfig>, "override 単独と一致しない");
});

test("SMID-RESOLVE-G: 本番 variant 4種は tiered mode を持たない（registry 経由でのみ tiered になる）", () => {
  const legacyVariants: SalesParameters[] = [
    SALES_PARAMETERS_V1,
    SALES_PARAMETERS_SAI5_SALES_BASE_V1,
    SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1,
    SALES_PARAMETERS_TEST15_VAP_CAPABILITY_AND_SALES_BASE_V1,
  ];
  for (const p of legacyVariants) assert.equal(p.marketAllocationMode, undefined);
  assert.equal(SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1.marketAllocationMode, "tieredSimultaneousAllocation");
});
