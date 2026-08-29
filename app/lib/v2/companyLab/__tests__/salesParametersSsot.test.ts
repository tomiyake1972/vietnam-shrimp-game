// ShrimpX V2 — ENG-SALES-PARAM-SSOT-2 SalesParameters 解決の単一情報源（実装指示§6〜§8）
//
// 【固定する不変条件】1つの Turn について
//   salesParametersFor(config) が解決した SalesParameters
//     ＝ turnInput.parameters.sales
//     ＝ Sales Engine（allocateMarketProduct）が実際に使った SalesParameters
// であること。
//
// 【修正前の欠陥】companyLab/runner.ts は sai5.salesBaseAccumulation が真のときだけ
// parameters.sales を渡しており、偽のときは turn/runner.ts が SALES_PARAMETERS_V1 へ
// フォールバックしていた。そのため baseline / DS2（sai5未指定）では
// 「vapProductDevelopmentCompetitiveness は明示 false 以外は既定ON」という正式仕様に
// 反して vapCapability ウェイト 0.08 が成約配分へ効いていなかった。
//
// 【期待値を独自計算しない】Engine が実際に使ったウェイトは、記録された
// competitivenessBreakdown（エンジン自身の出力）から逆算して同定する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState } from "../types";
import { unwrapUnit } from "../../core/units";
import {
  SALES_PARAMETERS_V1,
  SALES_PARAMETERS_SAI5_SALES_BASE_V1,
  SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1,
  SALES_PARAMETERS_TEST15_VAP_CAPABILITY_AND_SALES_BASE_V1,
  SalesParameters,
} from "../../sales/parameters";

const EPS = 1e-9;

/** 1四半期だけ進め、対象 market×product の配分結果を返す。 */
function runOneQuarter(overrides: Partial<CompanyLabConfig>, product: "hoso" | "pd" | "vap" = "vap") {
  const config = { scenarioId: "baseline", mode: "canonical", seed: "ssot-test", turns: 2, ...overrides } as CompanyLabConfig;
  const init = initializeCompanyLab(config);
  let state: CompanyLabState = init.state;
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of init.fixtures) {
    decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, 1);
  }
  state = advanceCompanyLabQuarter(state, init.fixtures, decisions);
  const record = state.history[state.history.length - 1];
  const alloc = record.salesRecord.allocations.find((a) => a.product === product && a.companies.length > 0);
  assert.ok(alloc, `market×product=${product} の配分が見つからない`);
  return { alloc: alloc!, record, fixtures: init.fixtures };
}

/**
 * Engine が実際に使った competitivenessWeights を、記録された内訳から逆算する。
 * contribution = weight × score なので、score が既知の項目から weight を割り出す。
 */
function engineWeightsFrom(alloc: ReturnType<typeof runOneQuarter>["alloc"]) {
  const e = alloc.companies[0];
  const b = e.competitivenessBreakdown;
  return {
    coverage: e.coverageScore > EPS ? b.coverageContribution / e.coverageScore : NaN,
    salesBaseContribution: b.salesBaseContribution,
    vapCapabilityContribution: b.vapCapabilityContribution,
    priceContribution: b.priceContribution,
  };
}

/** 期待 variant の coverage ウェイトと一致するか。 */
function assertEngineUsed(alloc: ReturnType<typeof runOneQuarter>["alloc"], expected: SalesParameters, label: string) {
  const w = engineWeightsFrom(alloc);
  assert.ok(
    Math.abs(w.coverage - expected.competitivenessWeights.coverage) < 1e-6,
    `${label}: Engine の coverage ウェイトが ${w.coverage}（期待 ${expected.competitivenessWeights.coverage} = ${expected.parametersVersion}）`
  );
}

// =====================================================================
// §6 variant matrix
// =====================================================================

test("SSOT-1: sai5 未指定 → TEST15_VAP_CAPABILITY_V1 が Engine まで届く（既定ON仕様）", () => {
  const { alloc } = runOneQuarter({});
  assertEngineUsed(alloc, SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1, "sai5未指定");
});

test("SSOT-2: vapProductDevelopmentCompetitiveness=false → V1", () => {
  const { alloc } = runOneQuarter({ sai5: { vapProductDevelopmentCompetitiveness: false } } as Partial<CompanyLabConfig>);
  assertEngineUsed(alloc, SALES_PARAMETERS_V1, "vap=false");
});

test("SSOT-3: vapProductDevelopmentCompetitiveness=true のみ → TEST15_VAP_CAPABILITY_V1", () => {
  const { alloc } = runOneQuarter({ sai5: { vapProductDevelopmentCompetitiveness: true } } as Partial<CompanyLabConfig>);
  assertEngineUsed(alloc, SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1, "vap=true");
});

test("SSOT-4: salesBase=true + vap=false → SAI5_SALES_BASE_V1", () => {
  const { alloc } = runOneQuarter({
    sai5: { salesBaseAccumulation: true, vapProductDevelopmentCompetitiveness: false },
  } as Partial<CompanyLabConfig>);
  assertEngineUsed(alloc, SALES_PARAMETERS_SAI5_SALES_BASE_V1, "salesBase only");
});

test("SSOT-5: salesBase=true + vap 既定ON → TEST15_VAP_CAPABILITY_AND_SALES_BASE_V1", () => {
  const { alloc } = runOneQuarter({ sai5: { salesBaseAccumulation: true } } as Partial<CompanyLabConfig>);
  assertEngineUsed(alloc, SALES_PARAMETERS_TEST15_VAP_CAPABILITY_AND_SALES_BASE_V1, "salesBase+vap");
});

test("SSOT-6: salesParamsOverride のみ → override が Engine まで届く（最優先）", () => {
  // 既存 variant を override として使い、parametersVersion と weights の両方が届くことを見る。
  const override: SalesParameters = {
    ...SALES_PARAMETERS_V1,
    parametersVersion: "ssot-test-override",
    competitivenessWeights: { ...SALES_PARAMETERS_V1.competitivenessWeights, coverage: 0.19, price: 0.41 },
  };
  const { alloc } = runOneQuarter({ salesParamsOverride: override });
  const w = engineWeightsFrom(alloc);
  assert.ok(Math.abs(w.coverage - 0.19) < 1e-6, `override の coverage が届いていない: ${w.coverage}`);
  // price も届いていること（priceContribution = 0.41 × clamp/1.6）。
  const e = alloc.companies[0];
  const ratio = e.competitivenessBreakdown.clampedPriceScore / SALES_PARAMETERS_V1.maximumPriceCompetitiveness;
  assert.ok(Math.abs(e.competitivenessBreakdown.priceContribution - 0.41 * ratio) < 1e-6, "override の price が届いていない");
});

test("SSOT-7: salesParamsOverride + salesBase → override が最優先", () => {
  const override: SalesParameters = {
    ...SALES_PARAMETERS_V1,
    parametersVersion: "ssot-test-override-2",
    competitivenessWeights: { ...SALES_PARAMETERS_V1.competitivenessWeights, coverage: 0.11 },
  };
  const { alloc } = runOneQuarter({ salesParamsOverride: override, sai5: { salesBaseAccumulation: true } } as Partial<CompanyLabConfig>);
  const w = engineWeightsFrom(alloc);
  assert.ok(Math.abs(w.coverage - 0.11) < 1e-6, `override より sai5 が優先されている: ${w.coverage}`);
});

// =====================================================================
// §7 Test15 VAP capability が実際に効くこと
// =====================================================================

test("SSOT-8: baseline（sai5未指定）で VAP entry に vapCapability 寄与が実際に発生する", () => {
  const { alloc } = runOneQuarter({}, "vap");
  for (const c of alloc.companies) {
    const b = c.competitivenessBreakdown;
    assert.ok(b.vapCapabilityContribution > 0, `${c.companyId}: VAP なのに vapCapability 寄与が 0`);
    // 寄与 = 0.08 × score/100 なので、weight 0.08 で割り戻すと 0〜1 のスコアになる。
    const score = b.vapCapabilityContribution / SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1.competitivenessWeights.vapCapability;
    assert.ok(score > 0 && score <= 1, `${c.companyId}: 逆算スコアが範囲外 ${score}`);
  }
});

test("SSOT-9: HOSO / PD には vapCapability が構造的に寄与しない", () => {
  for (const product of ["hoso", "pd"] as const) {
    const { alloc } = runOneQuarter({}, product);
    for (const c of alloc.companies) {
      assert.equal(c.competitivenessBreakdown.vapCapabilityContribution, 0, `${product}/${c.companyId} に vapCapability 寄与がある`);
    }
  }
});

test("SSOT-10: 内訳の合計が competitivenessWeight と一致する（どの variant でも）", () => {
  for (const cfg of [{}, { sai5: { salesBaseAccumulation: true } }, { sai5: { vapProductDevelopmentCompetitiveness: false } }]) {
    const { alloc } = runOneQuarter(cfg as Partial<CompanyLabConfig>);
    for (const c of alloc.companies) {
      const b = c.competitivenessBreakdown;
      const sum =
        b.priceContribution +
        b.coverageContribution +
        b.relationshipContribution +
        b.qualityContribution +
        b.deliveryReliabilityContribution +
        b.salesBaseContribution +
        b.vapCapabilityContribution;
      assert.ok(Math.abs(sum - c.competitivenessWeight) < 1e-9, `内訳合計と weight が不一致: ${sum} vs ${c.competitivenessWeight}`);
    }
  }
});

// =====================================================================
// 需要保存（伝播修正で壊れていないこと）
// =====================================================================

test("SSOT-11: どの variant でも 5社成約 + 外部 = 対象需要（需要保存）", () => {
  for (const cfg of [{}, { sai5: { salesBaseAccumulation: true } }, { sai5: { vapProductDevelopmentCompetitiveness: false } }]) {
    const { record } = runOneQuarter(cfg as Partial<CompanyLabConfig>);
    for (const a of record.salesRecord.allocations) {
      const total = a.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0) + unwrapUnit(a.externalOptionQuantity);
      assert.ok(Math.abs(total - unwrapUnit(a.targetDemand)) < 1, `${a.market}:${a.product} 需要保存が崩れている`);
    }
  }
});

test("SSOT-12: 決定的（同じ config・同じ seed から同じ配分）", () => {
  const a = runOneQuarter({});
  const b = runOneQuarter({});
  assert.deepEqual(b.alloc, a.alloc);
});
