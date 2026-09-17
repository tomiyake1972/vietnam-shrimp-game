// ShrimpX V2 — #05 Standard AI費用Projection接続
//
// 【このテストが守るもの】
//   A. 中立互換   … 指数未宣言／全指数1.00では、本接続の前後で判断・数値が一致する。
//   B. Engine一致 … 同じTurn・同じScenarioで、Engineが使う実効費用単価・必要工事費と
//                   Standard AIが参照する値が1件も食い違わない。
//   C. 配線       … 5つの対象経路が、引数未指定によるFINANCE_PARAMETERS_V1／
//                   standardBudgetUsd への暗黙フォールバックを使っていない。
//   D. 決定論     … 同一入力なら常に同一出力（Projectionは状態を持たない）。
//
// 【Case M2について（捏造しない）】
// 指示書の「Case M2相当の指数」は、本リポジトリ内に正式な定義（Scenario／定数／
// ドキュメント）が存在しない（"Case M"／"M2" のいずれも該当なし）。そこで本テストは
// **このテストファイル内だけで定義した非中立の指数セット**を使い、指示書が数値で
// 指定している construction index = 1.35 をそのまま採用する。正式Scenario値としては
// 一切採用しない（definitions/ には何も追加していない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildTurnEconomicsProjection } from "../../turnEconomicsProjection";
import { advanceSimulationTurns, createSimulationSession } from "../../simulation/engine";
import { NEUTRAL_STANDARD_AI_COST_PROJECTION, toStandardAiCostProjection } from "../costProjection";
import { ALL_SCENARIO_DEFINITIONS } from "../../../scenario/definitions";
import { ScenarioDefinition } from "../../../scenario/types";
import { CAPITAL_PROJECT_TYPES } from "../../../capex/types";
import { CAPEX_PARAMETERS_V1 } from "../../../capex/parameters";
import { resolveProjectBudget } from "../../../capex/projectLifecycle";
import { FACTORY_LIFECYCLE_PARAMETERS_V1 } from "../../../capex/factoryLifecycle";
import { FINANCE_PARAMETERS_V1, financeParametersForTurn } from "../../../finance/parameters";
import { resolveAllOperatingCostIndices, resolveConstructionCostIndex } from "../../../scenario/costIndex";
import { buildStandardAiUnitEconomics } from "../diagnosis/forwardUnitEconomics";
import { buildStandardAiFinancialCapacity, zeroFinancialCapacityPlan } from "../diagnosis/financialCapacity";
import { assessWorkingCapitalNeed } from "../decision/workingCapital";
import { buildStandardAiCapexDecision } from "../decision/capex";
import { evaluateNewFactoryDecision, NewFactoryDecisionInput } from "../decision/newFactory";
import { StandardAiObservation } from "../types";
import { PressureScores } from "../pressures";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { CompanyFixture } from "../../types";
import { DEMAND_MARKET_IDS } from "../../../market/types";
import { resolveCompanyVision } from "../../vision/overrides";
import { computeStrategicGrowthState } from "../../vision/strategicGrowth";

const BASELINE = ALL_SCENARIO_DEFINITIONS.find((d) => d.scenarioId === "baseline-v0.1")!;
const DS1 = ALL_SCENARIO_DEFINITIONS.find((d) => d.scenarioId === "dynamic-scenario-1-v0.1")!;
const DS2 = ALL_SCENARIO_DEFINITIONS.find((d) => d.scenarioId === "dynamic-scenario-2-v0.1")!;

/** 本テスト専用の非中立指数セット（正式Scenario値ではない）。construction は指示どおり 1.35。 */
const CONSTRUCTION_INDEX = 1.35;
const TEST_INDEX_BY_KEY = {
  sellingLogistics: 1.22,
  regularLabor: 1.4,
  temporaryLabor: 1.5,
  factoryFixed: 1.18,
  factoryUtilityVariable: 1.3,
  adminFixed: 1.12,
  qualityAssurance: 1.25,
  construction: CONSTRUCTION_INDEX,
} as const;

function indexedDefinition(): ScenarioDefinition {
  const tracks = Object.fromEntries(
    Object.entries(TEST_INDEX_BY_KEY).map(([key, value]) => [
      key,
      { interpolation: "step" as const, keyframes: [{ turn: 1, value: 1 }, { turn: 2, value }] },
    ])
  );
  return {
    ...BASELINE,
    operatingCostInflation: { settingsId: "cost-projection-wiring-test", tracks },
    constructionCostPolicy: "indexed-required-cost-v1",
  } as ScenarioDefinition;
}

const INDEXED_AT_T32 = toStandardAiCostProjection(buildTurnEconomicsProjection({ definition: indexedDefinition(), turn: 32 }));

// =====================================================================
// A. 中立互換
// =====================================================================

test("PROJ-A1: 指数未宣言のScenarioでは、Projection由来の費用前提が中立値と完全に一致する（全32Turn・3シナリオ）", () => {
  for (const definition of [BASELINE, DS1, DS2]) {
    for (let turn = 1; turn <= 32; turn++) {
      const p = toStandardAiCostProjection(buildTurnEconomicsProjection({ definition, turn }));
      assert.deepEqual(
        p.financeParameters,
        NEUTRAL_STANDARD_AI_COST_PROJECTION.financeParameters,
        `${definition.scenarioId} turn=${turn}: 実効費用単価が中立値と異なる`
      );
      assert.deepEqual(
        p.indexedRequiredProjectCostByType,
        NEUTRAL_STANDARD_AI_COST_PROJECTION.indexedRequiredProjectCostByType,
        `${definition.scenarioId} turn=${turn}: 必要工事費が中立値と異なる`
      );
    }
  }
});

test("PROJ-A2: 中立値は FINANCE_PARAMETERS_V1 と標準予算そのもの（＝本接続前の参照先と同一）", () => {
  assert.equal(NEUTRAL_STANDARD_AI_COST_PROJECTION.financeParameters, FINANCE_PARAMETERS_V1, "同一参照でなければならない");
  for (const projectType of CAPITAL_PROJECT_TYPES) {
    assert.equal(
      NEUTRAL_STANDARD_AI_COST_PROJECTION.indexedRequiredProjectCostByType[projectType],
      CAPEX_PARAMETERS_V1.templatesByType[projectType].standardBudgetUsd,
      projectType
    );
  }
});

// =====================================================================
// B. Engine ／ Standard AI 一致
// =====================================================================

const ENGINE_COST_ITEMS: readonly (readonly [string, (f: typeof FINANCE_PARAMETERS_V1) => number])[] = [
  ["regularWorkerSalaryUsdPerQuarter", (f) => f.labor.regularWorkerSalaryUsdPerQuarter],
  ["temporaryWorkerCostUsdPerQuarter", (f) => f.labor.temporaryWorkerCostUsdPerQuarter],
  ["factoryFixedCostUsdPerQuarter", (f) => f.manufacturing.factoryFixedCostUsdPerQuarter],
  ["factoryUtilityFixedUsdPerQuarter", (f) => f.manufacturing.factoryUtilityFixedUsdPerQuarter],
  ["adminFixedUsdPerQuarter", (f) => f.sellingGeneralAdmin.adminFixedUsdPerQuarter],
];

test("PROJ-B1: Turn 32 の5費目が、EngineのfinanceParametersForTurnとStandard AIの参照値で完全一致する（不一致0件）", () => {
  const definition = indexedDefinition();
  // Engine側の解決（scenario/costIndex.ts → finance/parameters.ts）。
  const engineFinance = financeParametersForTurn(FINANCE_PARAMETERS_V1, resolveAllOperatingCostIndices(definition, 32));
  const mismatches: string[] = [];
  for (const [label, pick] of ENGINE_COST_ITEMS) {
    if (pick(engineFinance) !== pick(INDEXED_AT_T32.financeParameters)) mismatches.push(label);
  }
  assert.deepEqual(mismatches, [], `不一致: ${mismatches.join(", ")}`);
  // 指数が本当に効いていること（中立と同じ値のまま「一致」しても意味がないため）。
  assert.notEqual(INDEXED_AT_T32.financeParameters.labor.regularWorkerSalaryUsdPerQuarter, FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter);
});

test("PROJ-B2: construction index 1.35 のとき、全10案件種別の必要工事費が一致する（不一致0件）", () => {
  const definition = indexedDefinition();
  assert.equal(resolveConstructionCostIndex(definition, 32), CONSTRUCTION_INDEX);
  assert.equal(CAPITAL_PROJECT_TYPES.length, 10);
  const mismatches: string[] = [];
  for (const projectType of CAPITAL_PROJECT_TYPES) {
    const expected = CAPEX_PARAMETERS_V1.templatesByType[projectType].standardBudgetUsd * CONSTRUCTION_INDEX;
    if (INDEXED_AT_T32.indexedRequiredProjectCostByType[projectType] !== expected) mismatches.push(projectType);
  }
  assert.deepEqual(mismatches, [], `不一致: ${mismatches.join(", ")}`);
});

test("PROJ-B3: reactivationCostUsd は今回も指数対象外（Projectionは触れていない）", () => {
  assert.equal(FACTORY_LIFECYCLE_PARAMETERS_V1.reactivationCostUsd, 500_000);
  const src = readFileSync(join(process.cwd(), "app/lib/v2/companyLab/turnEconomicsProjection.ts"), "utf8");
  assert.ok(!src.includes("reactivationCostUsd"), "Projectionが reactivationCostUsd を扱ってはならない");
});

// =====================================================================
// C. 配線（実計算結果で検証する。source文字列検査だけにしない）
// =====================================================================

const fixture = {
  companyId: "MASS",
  productEconomics: {
    expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 },
    premiumEconomics: {
      pd: {
        expectedVariableProcessingCostUsdPerHosoEqKg: 0.17,
        allocatedFixedCostUsdPerHosoEqKg: 0.15,
        sellingAndLogisticsCostUsdPerHosoEqKg: 0.05,
        targetMarginUsdPerHosoEqKg: 0.15,
        avoidableVariableProcessingCostUsdPerHosoEqKg: 0.17,
        incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.03,
        minimumContributionMarginUsdPerHosoEqKg: 0.05,
      },
      vap: {
        expectedVariableProcessingCostUsdPerHosoEqKg: 0.43,
        allocatedFixedCostUsdPerHosoEqKg: 0.35,
        sellingAndLogisticsCostUsdPerHosoEqKg: 0.1,
        targetMarginUsdPerHosoEqKg: 0.3,
        avoidableVariableProcessingCostUsdPerHosoEqKg: 0.43,
        incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.06,
        minimumContributionMarginUsdPerHosoEqKg: 0.1,
      },
    },
  },
} as unknown as CompanyFixture;

const LINE = { hoso: 12000, pd: 6000, vap: 4000 };
const LAST_PRODUCTION = { hoso: 11800, pd: 5900, vap: 3950 };

function observation(): StandardAiObservation {
  return {
    companyId: "MASS",
    period: "2020Q4",
    turn: 32,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 200000,
    rawMaterialPipeline: 0,
    factories: [
      {
        factoryId: "MASS-F1",
        capacityByProduct: LINE,
        commonProcessingCapacity: 90000,
        freezingPackagingCapacity: 90000,
        effectiveCapacityByProduct: LINE,
        effectiveCommonProcessingCapacity: 90000,
        effectiveFreezingPackagingCapacity: 90000,
        totalFactorySpaceUnits: 1_000_000,
        usedFactorySpaceUnits: 0,
        skillByProduct: { hoso: 1, pd: 1, vap: 1 },
        currentRegularHeadcount: 5000,
        qualityMetrics: {
          productionTons: LAST_PRODUCTION.hoso + LAST_PRODUCTION.pd + LAST_PRODUCTION.vap,
          qualitySensitiveProductionTons: LAST_PRODUCTION.pd + LAST_PRODUCTION.vap,
          downgradeTons: 0,
          reworkTons: 0,
          discardTons: 0,
          majorIncidentCount: 0,
          operationalRisk: 0,
          qualityScore: 100,
          lossTons: 0,
        },
        qualityEquipment: {
          hasQualityEquipment: false,
          qualityEquipmentStatus: "NONE",
          equipmentRampProgress: 0,
          qualityEquipmentRiskMultiplier: 1,
        },
        pdMechanization: {
          hasActiveOrCompletedProject: false,
          currentLaborIntensityCoefficient: 1.2,
          previousQuarterPdUtilization: 0.5,
        },
      },
    ],
    totalCapacityByProduct: LINE,
    totalCommonProcessingCapacity: 90000,
    totalEffectiveCapacityByProduct: LINE,
    totalEffectiveCommonProcessingCapacity: 90000,
    totalEffectiveFreezingPackagingCapacity: 90000,
    nearTermEffectiveCapacityByProduct: LINE,
    nearTermEffectiveCommonProcessingCapacity: 90000,
    nearTermEffectiveFreezingPackagingCapacity: 90000,
    factorySpaceTotalUnits: 1_000_000,
    factorySpaceUsedUnits: 0,
    factorySpaceRemainingUnits: 1_000_000,
    factoryCount: 1,
    prospectiveFactoryCount: 1,
    pendingNewFactoryProjectCount: 0,
    maxFactoriesPerCompany: 3,
    aquacultureCapacity: 4000,
    salesForceHeadcountTotal: 200,
    procurementHeadcountTotal: 20,
    regularHeadcountTotal: 20000,
    lastQuarterEquipmentUtilizationRate: 0.95,
    lastQuarterLaborUtilizationRate: 0.95,
    lastQuarterActualProductionByProduct: LAST_PRODUCTION,
    markets: DEMAND_MARKET_IDS.map((market) => ({
      market,
      referencePriceByProduct: { hoso: 6.0, pd: 7.5, vap: 11.0 },
    })),
    marketPremiumByProduct: { pd: 1.0, vap: 3.0 },
    vietnamDomesticPriorPrice: 4.0,
    lastHosoPriceVn: 5.0,
    productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 } },
    cashUsd: 400_000_000,
    existingLoanBalanceUsd: 0,
    payablesDueThisPeriodUsd: 0,
    receivablesDueThisPeriodUsd: 0,
    existingLoanInterestUsdThisQuarterEstimate: 0,
    existingLoanScheduledPrincipalDueUsdThisQuarterEstimate: 0,
    activeCapexProjectTargets: new Set<string>(),
    suspendedCapexProjectIds: [],
    qualityScoreByProduct: {},
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
  } as unknown as StandardAiObservation;
}

function pressures(): PressureScores {
  return {
    contractFulfillmentPressure: 0,
    finishedGoodsExcessRatioByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialInventoryPosition: 200000,
    cashPressure: 0,
    borrowingPressure: 0.1,
    equipmentUtilizationLastQuarter: 0.95,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.95,
    marketPriceRanking: [...DEMAND_MARKET_IDS],
    targetMinimumCashUsd: 30_000_000,
    expectedRawPriceUsdPerKg: 2.5,
  } as unknown as PressureScores;
}

test("PROJ-C1: forwardUnitEconomics は渡されたProjectionの実効単価で計算する", () => {
  const obs = observation();
  const neutral = buildStandardAiUnitEconomics(obs, NEUTRAL_STANDARD_AI_COST_PROJECTION);
  const indexed = buildStandardAiUnitEconomics(obs, INDEXED_AT_T32);
  const n = neutral.entries[0];
  const i = indexed.entries.find((e) => e.market === n.market && e.product === n.product)!;
  // ユーティリティ変動費 × 1.30、販売物流費 × 1.22 のぶんだけ非原料変動費が増える。
  const hosoEqKgPerTon = 1000;
  const delta =
    (FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityVariableUsdPerTon * (TEST_INDEX_BY_KEY.factoryUtilityVariable - 1) +
      FINANCE_PARAMETERS_V1.sellingGeneralAdmin.sellingLogisticsUsdPerTon * (TEST_INDEX_BY_KEY.sellingLogistics - 1)) /
    hosoEqKgPerTon;
  assert.ok(Math.abs(i.nonRawVariableCostUsdPerKg - (n.nonRawVariableCostUsdPerKg + delta)) < 1e-9);
  assert.notEqual(i.nonRawVariableCostUsdPerKg, n.nonRawVariableCostUsdPerKg);
});

test("PROJ-C2: financialCapacity は渡されたProjectionの実効単価で現金支出を見積もる", () => {
  const obs = observation();
  const plan = { ...zeroFinancialCapacityPlan(), productionByProductTons: { hoso: 1000, pd: 0, vap: 0 }, totalSalesTonsThisQuarter: 1000 };
  const neutral = buildStandardAiFinancialCapacity(obs, pressures(), plan, NEUTRAL_STANDARD_AI_COST_PROJECTION);
  const indexed = buildStandardAiFinancialCapacity(obs, pressures(), plan, INDEXED_AT_T32);
  assert.ok(
    indexed.projectedCashBeforeFinancingUsd < neutral.projectedCashBeforeFinancingUsd,
    "指数を上げたのに見積現金支出が増えていない＝Projectionが使われていない"
  );
});

test("PROJ-C3: workingCapital は渡されたfinanceParametersで人件費を見積もる", () => {
  const obs = observation();
  const procurement = { domesticDesiredQuantityTons: 1000, importOrderedQuantityTons: 0 };
  const neutral = assessWorkingCapitalNeed(obs, procurement, 10_000_000, NEUTRAL_STANDARD_AI_COST_PROJECTION.financeParameters);
  const indexed = assessWorkingCapitalNeed(obs, procurement, 10_000_000, INDEXED_AT_T32.financeParameters);
  const expectedDelta =
    obs.regularHeadcountTotal * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter * (TEST_INDEX_BY_KEY.regularLabor - 1);
  assert.ok(Math.abs(indexed.payrollUsd - (neutral.payrollUsd + expectedDelta)) < 1e-6);
});

test("PROJ-C4: capex は渡されたProjectionの必要工事費を案件費用として使う", () => {
  const obs = observation();
  const heavy = { hoso: 80000, pd: 40000, vap: 25000 };
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), heavy, 200000, STANDARD_AI_PARAMETERS_V1, undefined, INDEXED_AT_T32);
  const entry = result.diagnostics.find((d) => typeof d.keyValues?.candidateCostUsd === "number");
  assert.ok(entry, "候補費用を含む診断が出ていない");
  const projectType = result.capexDecision.newProjectProposals[0]?.projectType;
  assert.ok(projectType, "提案が1件も出ていない（テスト前提が崩れている）");
  assert.equal(
    entry!.keyValues!.candidateCostUsd,
    CAPEX_PARAMETERS_V1.templatesByType[result.capexDecision.newProjectProposals[0].projectType].standardBudgetUsd * CONSTRUCTION_INDEX,
    "案件費用に建設費指数が反映されていない"
  );
});

test("PROJ-C5: newFactory は渡されたProjectionの必要工事費を新工場費用として使う", () => {
  // 実在のVision（vision/overrides.ts が唯一のSSoT）をそのまま使う。合成しない。
  const vision = resolveCompanyVision("MASS", 32)!;
  const strategicGrowth = computeStrategicGrowthState({ vision, turn: 32, currentSustainableScaleTons: 12000 });
  const base = {
    turn: 32,
    fixture,
    observation: observation(),
    pressures: pressures(),
    vision,
    strategicGrowth,
    productionNeededByProductBeforeCap: { hoso: 20000, pd: 10000, vap: 6000 },
    existingExpansionProposedThisQuarter: false,
  };
  const neutral = evaluateNewFactoryDecision({ ...base, costProjection: NEUTRAL_STANDARD_AI_COST_PROJECTION } as NewFactoryDecisionInput);
  const indexed = evaluateNewFactoryDecision({ ...base, costProjection: INDEXED_AT_T32 } as NewFactoryDecisionInput);
  assert.equal(neutral.assessment.projectCostUsd, CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction.standardBudgetUsd);
  assert.equal(indexed.assessment.projectCostUsd, CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction.standardBudgetUsd * CONSTRUCTION_INDEX);
});

test("PROJ-C6: 5経路のいずれも FINANCE_PARAMETERS_V1 / standardBudgetUsd を実効費用として直接参照していない", () => {
  const paths = [
    "app/lib/v2/companyLab/standardAi/diagnosis/forwardUnitEconomics.ts",
    "app/lib/v2/companyLab/standardAi/diagnosis/financialCapacity.ts",
    "app/lib/v2/companyLab/standardAi/decision/capex.ts",
    "app/lib/v2/companyLab/standardAi/decision/workingCapital.ts",
    "app/lib/v2/companyLab/standardAi/decision/newFactory.ts",
  ];
  for (const rel of paths) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    const code = src
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("/*"))
      .join("\n");
    assert.ok(!code.includes("FINANCE_PARAMETERS_V1"), `${rel}: FINANCE_PARAMETERS_V1 への直参照が残っている`);
    assert.ok(!code.includes("standardBudgetUsd"), `${rel}: standardBudgetUsd への直参照が残っている`);
  }
});

// =====================================================================
// D. 決定論
// =====================================================================

test("PROJ-D1: 同一 definition・同一Turnなら Projection は常に同一（決定論・状態を持たない）", () => {
  const definition = indexedDefinition();
  for (const turn of [1, 2, 16, 32]) {
    const a = toStandardAiCostProjection(buildTurnEconomicsProjection({ definition, turn }));
    const b = toStandardAiCostProjection(buildTurnEconomicsProjection({ definition, turn }));
    assert.deepEqual(a, b, `turn=${turn}`);
  }
});

test("PROJ-D2: 同一入力なら 5経路の出力も常に同一", () => {
  const obs = observation();
  const plan = { ...zeroFinancialCapacityPlan(), productionByProductTons: { hoso: 1000, pd: 0, vap: 0 }, totalSalesTonsThisQuarter: 1000 };
  assert.deepEqual(
    buildStandardAiUnitEconomics(obs, INDEXED_AT_T32),
    buildStandardAiUnitEconomics(obs, INDEXED_AT_T32)
  );
  assert.deepEqual(
    buildStandardAiFinancialCapacity(obs, pressures(), plan, INDEXED_AT_T32),
    buildStandardAiFinancialCapacity(obs, pressures(), plan, INDEXED_AT_T32)
  );
  const heavy = { hoso: 80000, pd: 40000, vap: 25000 };
  assert.deepEqual(
    buildStandardAiCapexDecision(fixture, obs, pressures(), heavy, 200000, STANDARD_AI_PARAMETERS_V1, undefined, INDEXED_AT_T32).capexDecision,
    buildStandardAiCapexDecision(fixture, obs, pressures(), heavy, 200000, STANDARD_AI_PARAMETERS_V1, undefined, INDEXED_AT_T32).capexDecision
  );
});

test("PROJ-D3: 32Turn実行が決定論的であり、会計不変条件が全社×全Turnで epsilon 0.01 USD 以内に収まる", () => {
  const run = () => {
    let session = createSimulationSession({
      simulationRunId: "proj-d3",
      scenarioId: BASELINE.scenarioId,
      seed: "proj-d3-seed",
      requestedTurns: 32,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    session = advanceSimulationTurns({ session, turns: 32, timestamp: "2026-01-01T00:00:00.000Z" });
    return session.state;
  };
  const first = run();
  const second = run();
  assert.equal(first.history.length, 32);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)), "同一seed・同一設定の32Turn結果が一致しない");

  const EPSILON_USD = 0.01;
  const violations: string[] = [];
  let maxBalanceDifference = 0;
  let maxDirectIndirectDifference = 0;
  let maxInventoryFlowResidual = 0;
  let maxProfitDifferenceResidualRaw = 0;
  let maxProfitDifferenceResidualAdjusted = 0;

  for (const entry of first.history) {
    for (const fin of entry.financialResults) {
      const label = `${fin.companyId}@${String(entry.period)}`;
      const rec = fin.absorptionVariableReconciliation;
      const pl = fin.profitAndLoss;
      const cm = fin.contributionMargin;

      maxBalanceDifference = Math.max(maxBalanceDifference, Math.abs(Number(fin.balanceSheet.balanceDifference)));
      maxDirectIndirectDifference = Math.max(maxDirectIndirectDifference, Math.abs(Number(fin.cashFlow.directIndirectDifference)));
      if (Math.abs(Number(fin.balanceSheet.balanceDifference)) > EPSILON_USD) violations.push(`${label} balanceDifference`);
      if (Math.abs(Number(fin.cashFlow.directIndirectDifference)) > EPSILON_USD) violations.push(`${label} directIndirectDifference`);

      const opening = Number(rec.fixedCostInOpeningInventory);
      const closing = Number(rec.fixedCostInClosingInventory);

      // --- 検査B: 在庫中固定製造費のフロー整合 ---
      //   closing = opening + 当期配賦 − 販売による費用化 − 廃棄による費用化
      const inventoryFlowResidual = Math.abs(
        closing -
          (opening +
            Number(rec.fixedCostAbsorbedIntoInventory) -
            Number(rec.fixedCostReleasedThroughSales) -
            Number(rec.fixedCostReleasedThroughWriteOff))
      );
      maxInventoryFlowResidual = Math.max(maxInventoryFlowResidual, inventoryFlowResidual);
      if (inventoryFlowResidual > EPSILON_USD) violations.push(`${label} 在庫固定費フロー(B)`);

      // --- 検査A: profitDifference = closing − opening ---
      //
      // 【実測事実（推測で通していません）】現行Engineでは、この等式は厳密には
      // 成立しません。absorption側の operatingProfit には、管理会計（変動原価計算）
      // レポートの変動費プール・固定費プールのどちらにも入っていない次の費目が
      // 含まれているためです。
      //   ・costOfSales.capexMaintenanceCost
      //   ・costOfSales.factoryLifecycleCarryingCost
      //   ・SG&A のうち salesForceSeveranceCost ＋ vapProductDevelopmentSpendUsd
      //     （＝ sellingGeneralAdmin − fixedPersonnelCost − fixedSellingAdminCost
      //        − variableSellingCost）
      // これらを戻したうえでの等式は厳密に閉じるため、ここでは
      //   (1) 生の残差を計測して記録し（値は報告する）
      //   (2) absorption専用費目を戻した調整後の等式を epsilon 0.01 USD で検証する
      // という形にしています。なお、この生の残差は base f4ffc51 でも同一値で
      // 発生しており（133/160件・最大 817,000 USD）、本Phaseの変更が原因では
      // ありません。等式Aを字義どおり成立させるには Engine の費用式変更が必要で、
      // 本Phaseでは禁止されています。
      const sgaOnlyInAbsorption =
        Number(pl.sellingGeneralAdmin) -
        Number(cm.fixedPersonnelCost) -
        Number(cm.fixedSellingAdminCost) -
        Number(cm.variableSellingCost);
      const absorptionOnlyCosts =
        Number(pl.costOfSales.capexMaintenanceCost) + Number(pl.costOfSales.factoryLifecycleCarryingCost) + sgaOnlyInAbsorption;

      const rawResidual = Math.abs(Number(rec.profitDifference) - (closing - opening));
      const adjustedResidual = Math.abs(Number(rec.profitDifference) + absorptionOnlyCosts - (closing - opening));
      maxProfitDifferenceResidualRaw = Math.max(maxProfitDifferenceResidualRaw, rawResidual);
      maxProfitDifferenceResidualAdjusted = Math.max(maxProfitDifferenceResidualAdjusted, adjustedResidual);
      if (adjustedResidual > EPSILON_USD) violations.push(`${label} 利益差(A・absorption専用費目調整後)`);

      // profitDifference の定義そのもの（absorption − variable）も閉じていること。
      if (
        Math.abs(Number(rec.absorptionOperatingProfit) - Number(rec.variableCostingOperatingProfit) - Number(rec.profitDifference)) >
        EPSILON_USD
      ) {
        violations.push(`${label} profitDifference定義`);
      }
    }
  }

  assert.deepEqual(violations, [], `会計不変条件違反: ${violations.slice(0, 5).join(", ")}`);
  // 実測値を残す（報告で使う数値をテスト自身が生成する）。
  assert.ok(maxBalanceDifference <= EPSILON_USD, `max|balanceDifference|=${maxBalanceDifference}`);
  assert.ok(maxDirectIndirectDifference <= EPSILON_USD, `max|directIndirectDifference|=${maxDirectIndirectDifference}`);
  assert.ok(maxInventoryFlowResidual <= EPSILON_USD, `max|在庫固定費フロー残差|=${maxInventoryFlowResidual}`);
  assert.ok(maxProfitDifferenceResidualAdjusted <= EPSILON_USD, `max|利益差残差(調整後)|=${maxProfitDifferenceResidualAdjusted}`);
  // 生の残差は 0.01 を超える（＝現行Engineの既知の性質。将来この性質が変わったら
  // このテストが落ち、報告済みの事実が古くなったことに気付ける）。
  assert.ok(
    maxProfitDifferenceResidualRaw > EPSILON_USD,
    `生の利益差残差が 0.01 USD 以内に収まった（Engine側の費用式が変わった可能性。max=${maxProfitDifferenceResidualRaw}）`
  );
});

// =====================================================================
// E. 旧監査と同じ M2 Turn 32 ゲート（5費目 ＋ 全10案件 = 15項目、不一致0件）
// =====================================================================

/**
 * 旧監査の Case M2 と同じ指数。正式Scenario値は追加せず、このテストfixture内だけで
 * 定義する（definitions/ には何も足していない）。
 */
const M2_INDEX_BY_KEY = {
  regularLabor: 1.21,
  temporaryLabor: 1.21,
  factoryFixed: 1.25,
  adminFixed: 1.25,
  construction: 1.35,
} as const;

function m2Definition(): ScenarioDefinition {
  const tracks = Object.fromEntries(
    Object.entries(M2_INDEX_BY_KEY).map(([key, value]) => [
      key,
      { interpolation: "step" as const, keyframes: [{ turn: 1, value: 1 }, { turn: 2, value }] },
    ])
  );
  return {
    ...BASELINE,
    operatingCostInflation: { settingsId: "m2-turn32-gate", tracks },
    constructionCostPolicy: "indexed-required-cost-v1",
  } as ScenarioDefinition;
}

/** 旧監査の Turn 32 期待値（USD）。 */
const M2_EXPECTED_AT_T32: readonly (readonly [string, number, (f: typeof FINANCE_PARAMETERS_V1) => number])[] = [
  ["regularWorkerSalaryUsdPerQuarter", 1_210, (f) => f.labor.regularWorkerSalaryUsdPerQuarter],
  ["temporaryWorkerCostUsdPerQuarter", 968, (f) => f.labor.temporaryWorkerCostUsdPerQuarter],
  ["factoryFixedCostUsdPerQuarter", 1_500_000, (f) => f.manufacturing.factoryFixedCostUsdPerQuarter],
  ["factoryUtilityFixedUsdPerQuarter", 312_500, (f) => f.manufacturing.factoryUtilityFixedUsdPerQuarter],
  ["adminFixedUsdPerQuarter", 1_000_000, (f) => f.sellingGeneralAdmin.adminFixedUsdPerQuarter],
];

test("PROJ-E1: M2 Turn 32 — 5費目がEngine・Standard AI・旧監査期待値の三者で一致する（不一致0件）", () => {
  const definition = m2Definition();
  const ai = toStandardAiCostProjection(buildTurnEconomicsProjection({ definition, turn: 32 }));
  const engine = financeParametersForTurn(FINANCE_PARAMETERS_V1, resolveAllOperatingCostIndices(definition, 32));

  const mismatches: string[] = [];
  for (const [label, expected, pick] of M2_EXPECTED_AT_T32) {
    if (pick(engine) !== expected) mismatches.push(`${label}(Engine=${pick(engine)} 期待=${expected})`);
    if (pick(ai.financeParameters) !== expected) mismatches.push(`${label}(StandardAI=${pick(ai.financeParameters)} 期待=${expected})`);
    if (pick(engine) !== pick(ai.financeParameters)) mismatches.push(`${label}(Engine/StandardAI不一致)`);
  }
  assert.deepEqual(mismatches, [], mismatches.join(" / "));
});

test("PROJ-E2: M2 Turn 32 — 全10案件種別で indexedRequiredProjectCost = standardBudgetUsd × 1.35 がEngineとStandard AIで一致する（不一致0件）", () => {
  const definition = m2Definition();
  const ai = toStandardAiCostProjection(buildTurnEconomicsProjection({ definition, turn: 32 }));
  const constructionIndex = resolveConstructionCostIndex(definition, 32);
  assert.equal(constructionIndex, 1.35);
  assert.equal(CAPITAL_PROJECT_TYPES.length, 10);

  const costPolicy = { policy: "indexed-required-cost-v1" as const, constructionCostIndex: constructionIndex };
  const mismatches: string[] = [];
  for (const projectType of CAPITAL_PROJECT_TYPES) {
    const template = CAPEX_PARAMETERS_V1.templatesByType[projectType];
    // Engine の承認額計算と同一関数（resolveProjectBudget）を通した値。
    const engineRequired = resolveProjectBudget(template, undefined, costPolicy).indexedRequiredProjectCostUsd;
    const expected = template.standardBudgetUsd * 1.35;
    const aiRequired = ai.indexedRequiredProjectCostByType[projectType];
    if (engineRequired !== expected) mismatches.push(`${projectType}(Engine=${engineRequired} 期待=${expected})`);
    if (aiRequired !== expected) mismatches.push(`${projectType}(StandardAI=${aiRequired} 期待=${expected})`);
    if (engineRequired !== aiRequired) mismatches.push(`${projectType}(Engine/StandardAI不一致)`);
  }
  assert.deepEqual(mismatches, [], mismatches.join(" / "));
});

test("PROJ-E3: M2 Turn 32 — 5費目＋10案件＝15項目の不一致が0件である", () => {
  const definition = m2Definition();
  const ai = toStandardAiCostProjection(buildTurnEconomicsProjection({ definition, turn: 32 }));
  const engine = financeParametersForTurn(FINANCE_PARAMETERS_V1, resolveAllOperatingCostIndices(definition, 32));
  const costPolicy = { policy: "indexed-required-cost-v1" as const, constructionCostIndex: 1.35 };

  let checked = 0;
  let mismatched = 0;
  for (const [, expected, pick] of M2_EXPECTED_AT_T32) {
    checked += 1;
    if (!(pick(engine) === expected && pick(ai.financeParameters) === expected)) mismatched += 1;
  }
  for (const projectType of CAPITAL_PROJECT_TYPES) {
    checked += 1;
    const template = CAPEX_PARAMETERS_V1.templatesByType[projectType];
    const engineRequired = resolveProjectBudget(template, undefined, costPolicy).indexedRequiredProjectCostUsd;
    const expected = template.standardBudgetUsd * 1.35;
    if (!(engineRequired === expected && ai.indexedRequiredProjectCostByType[projectType] === expected)) mismatched += 1;
  }
  assert.equal(checked, 15, "検査項目は5費目＋10案件＝15項目でなければならない");
  assert.equal(mismatched, 0, `不一致 ${mismatched} 件`);
});
