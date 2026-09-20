// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1: TurnEconomicsProjection と Engine内部診断

import test from "node:test";
import assert from "node:assert/strict";

import { buildTurnEconomicsProjection } from "../turnEconomicsProjection";
import { buildConstructionCostDiagnostics, buildCostFoundationDiagnostics } from "../costFoundationDiagnostics";
import { ALL_SCENARIO_DEFINITIONS } from "../../scenario/definitions";
import { OPERATING_COST_INDEX_KEYS } from "../../scenario/costIndex";
import { ScenarioDefinition } from "../../scenario/types";
import { FINANCE_PARAMETERS_V1, financeParametersForTurn } from "../../finance/parameters";
import { CAPEX_PARAMETERS_V1 } from "../../capex/parameters";
import { CAPITAL_PROJECT_TYPES } from "../../capex/types";
import { LEGACY_CONSTRUCTION_COST_POLICY, resolveProjectBudget } from "../../capex/projectLifecycle";

const BASE = ALL_SCENARIO_DEFINITIONS.find((d) => d.scenarioId === "baseline-v0.1")!;

function withInflation(factor: number): ScenarioDefinition {
  return {
    ...BASE,
    operatingCostInflation: {
      settingsId: "proj-test",
      tracks: {
        sellingLogistics: { interpolation: "step", keyframes: [{ turn: 1, value: 1 }, { turn: 10, value: factor }] },
        factoryFixed: { interpolation: "step", keyframes: [{ turn: 1, value: 1 }, { turn: 10, value: factor }] },
        construction: { interpolation: "step", keyframes: [{ turn: 1, value: 1 }, { turn: 10, value: factor }] },
      },
    },
    constructionCostPolicy: "indexed-required-cost-v1",
  };
}

test("PROJ-1: 未宣言シナリオでは全指数1.00・financeParametersはbaseと同一参照", () => {
  const p = buildTurnEconomicsProjection({ definition: BASE, turn: 24 });
  for (const key of OPERATING_COST_INDEX_KEYS) assert.equal(p.operatingCostIndices[key], 1, key);
  assert.equal(p.rawPriceCaptureIndex, 1);
  assert.equal(p.constructionCostIndex, 1);
  assert.equal(p.constructionCostPolicy, "legacy-requested-cost");
  assert.equal(p.financeParameters, FINANCE_PARAMETERS_V1);
});

test("PROJ-2: projectionの実効費用単価はEngineが使う値と一致する", () => {
  const d = withInflation(1.4);
  const p = buildTurnEconomicsProjection({ definition: d, turn: 20 });
  // Engine（companyLab/runner.ts）と同じ合成関数を通した値と一致すること。
  const expected = financeParametersForTurn(FINANCE_PARAMETERS_V1, p.operatingCostIndices);
  assert.deepEqual(p.financeParameters, expected);
  assert.equal(p.financeParameters.sellingGeneralAdmin.sellingLogisticsUsdPerTon, 100 * 1.4);
  assert.equal(p.financeParameters.manufacturing.factoryFixedCostUsdPerQuarter, 1_200_000 * 1.4);
  // unitEconomics も同じ実効単価を返す（別式を持たない）。
  for (const product of ["hoso", "pd", "vap"] as const) {
    assert.equal(p.unitEconomics[product].sellingLogisticsUsdPerTon, p.financeParameters.sellingGeneralAdmin.sellingLogisticsUsdPerTon);
    assert.equal(p.unitEconomics[product].reworkCostUsdPerTon, p.financeParameters.manufacturing.reworkCostUsdPerTon);
  }
});

test("PROJ-3: indexedRequiredProjectCostByType がEngineの承認額計算と一致する", () => {
  const d = withInflation(1.4);
  const p = buildTurnEconomicsProjection({ definition: d, turn: 20 });
  for (const projectType of CAPITAL_PROJECT_TYPES) {
    const template = CAPEX_PARAMETERS_V1.templatesByType[projectType];
    const engineSide = resolveProjectBudget(template, undefined, {
      policy: "indexed-required-cost-v1",
      constructionCostIndex: p.constructionCostIndex,
    });
    assert.equal(p.indexedRequiredProjectCostByType[projectType], engineSide.approvedBudgetUsd, projectType);
  }
});

test("PROJ-4: legacy policyでは必要工事費 = standardBudgetUsd", () => {
  const p = buildTurnEconomicsProjection({ definition: BASE, turn: 24 });
  for (const projectType of CAPITAL_PROJECT_TYPES) {
    assert.equal(
      p.indexedRequiredProjectCostByType[projectType],
      CAPEX_PARAMETERS_V1.templatesByType[projectType].standardBudgetUsd,
      projectType
    );
  }
});

test("PROJ-5: marketResultを渡さない将来Turnでは確定値を返さない", () => {
  const p = buildTurnEconomicsProjection({ definition: BASE, turn: 30 });
  assert.equal(p.currentBasePriceByMarketProduct.isEstimate, false);
  assert.equal(p.currentBasePriceByMarketProduct.value, undefined);
  assert.equal(p.currentRawMaterialPrice.isEstimate, false);
  assert.equal(p.currentRawMaterialPrice.value, undefined);
});

test("PROJ-6: parametersVersion に指数設定と建設費方式が現れる", () => {
  const none = buildTurnEconomicsProjection({ definition: BASE, turn: 1 }).parametersVersion;
  assert.ok(none.includes("finance=finance-v0.1"));
  assert.ok(none.includes("operatingCostInflation=none"));
  assert.ok(none.includes("constructionCostPolicy=legacy-requested-cost"));

  const withSettings = buildTurnEconomicsProjection({ definition: withInflation(1.2), turn: 20 }).parametersVersion;
  assert.ok(withSettings.includes("operatingCostInflation=proj-test"));
  assert.ok(withSettings.includes("constructionCostPolicy=indexed-required-cost-v1"));
});

test("DIAG-1: Engine内部診断が指数と実効単価を返す（marketResultなしでも取得できる）", () => {
  const d = withInflation(1.4);
  const diag = buildCostFoundationDiagnostics(d, 20);
  assert.equal(diag.turn, 20);
  assert.equal(diag.operatingCostIndices.sellingLogistics, 1.4);
  assert.equal(diag.effectiveFinanceParameters.sellingGeneralAdmin.sellingLogisticsUsdPerTon, 140);
  assert.equal(diag.rawMarket, undefined, "市場結果が無ければ原料市場の診断は捏造しない");
});

test("DIAG-2: 建設費診断がEngineの承認額と同じ関数を通している", () => {
  const legacy = buildConstructionCostDiagnostics("commonProcessingExpansion", undefined, LEGACY_CONSTRUCTION_COST_POLICY);
  const standard = CAPEX_PARAMETERS_V1.templatesByType.commonProcessingExpansion.standardBudgetUsd;
  assert.equal(legacy.policy, "legacy-requested-cost");
  assert.equal(legacy.approvedBudgetUsd, standard);
  assert.equal(legacy.indexedRequiredProjectCostUsd, standard);

  const idx = buildConstructionCostDiagnostics("commonProcessingExpansion", standard, {
    policy: "indexed-required-cost-v1",
    constructionCostIndex: 1.4,
  });
  assert.equal(idx.indexedRequiredProjectCostUsd, standard * 1.4);
  assert.equal(idx.requestedBudgetUsd, standard);
  assert.equal(idx.insufficientRequest, true);
  assert.equal(idx.approvedBudgetUsd, undefined);
});

test("DIAG-3: 診断構造は永続stateへ入らない（純関数であり、同じ入力で常に同じ値）", () => {
  const a = buildCostFoundationDiagnostics(BASE, 12);
  const b = buildCostFoundationDiagnostics(BASE, 12);
  assert.deepEqual(a, b);
});
