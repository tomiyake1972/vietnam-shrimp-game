// ShrimpX V2 — 商品戦略プロファイル capex/investment overlayの単体テスト
//
// 検証項目:
//  1. capex overlay: PD_AUTOMATIONはpdMechanization、VAP_DIFFERENTIATIONは
//     qualityControlEquipmentを、代表的な観測フィクスチャ（sai5fCapex.test.tsと
//     同じ流儀の合成observation/pressures）で提案すること。
//  2. capex overlay: プロファイルが要求しない種別・既に保有済みの種別・
//     トリガー条件を満たさない場合は一切提案しないこと。
//  3. investment overlay: VAP_DIFFERENTIATIONのみ非ゼロのVAP R&D投資額を返し、
//     他プロファイルは含まれないこと。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStrategyProfileCapexOverlayProposals } from "../strategyProfileCapexOverlay";
import { computeStrategyProfileProductDevelopmentInvestment } from "../strategyProfileInvestmentOverlay";
import { STRATEGY_PROFILES } from "../standardAi/strategyProfile";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "../standardAi/parameters";
import { PressureScores } from "../standardAi/pressures";
import { StandardAiObservation } from "../standardAi/types";
import { PRODUCT_DEVELOPMENT_PARAMETERS_V1 } from "../productDevelopmentState";
import { DEMAND_MARKET_IDS } from "../../market/types";
import { CapitalProjectType } from "../../capex/types";

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "VAP",
    period: "2015Q3",
    turn: 3,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 5000,
    rawMaterialPipeline: 0,
    factories: [],
    totalCapacityByProduct: { hoso: 10000, pd: 8000, vap: 6000 },
    totalCommonProcessingCapacity: 22000,
    aquacultureCapacity: 4000,
    salesForceHeadcountTotal: 80,
    procurementHeadcountTotal: 12,
    lastQuarterEquipmentUtilizationRate: 0.95,
    lastQuarterLaborUtilizationRate: 0.85,
    // 【2026-08-01訂正】overlayのトリガーは会社全体集計(lastQuarterEquipmentUtilizationRate)
    // ではなく対象商品固有の稼働率（lastQuarterActualProductionByProduct[product] /
    // totalCapacityByProduct[product]）を見るようになった（strategyProfileCapexOverlay.ts
    // 参照）。既定値はpd 6000/8000=0.75・vap 4500/6000=0.75で
    // OVERLAY_PRODUCT_UTILIZATION_THRESHOLD(0.5)を上回るようにする。
    lastQuarterActualProductionByProduct: { pd: 6000, vap: 4500 },
    markets: [],
    marketPremiumByProduct: { pd: 1.0, vap: 3.0 },
    vietnamDomesticPriorPrice: 4.0,
    lastHosoPriceVn: 5.0,
    productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 } },
    cashUsd: 200_000_000, // 十分に安全な現金
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 6000,
    activeCapexProjectTargets: new Set(),
    suspendedCapexProjectIds: [],
    qualityScoreByProduct: {},
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
    ...overrides,
  } as unknown as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
  return {
    contractFulfillmentPressure: 0,
    finishedGoodsExcessRatioByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialInventoryPosition: 5000,
    cashPressure: 0,
    borrowingPressure: 0.1,
    equipmentUtilizationLastQuarter: 0.95,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.85,
    marketPriceRanking: [...DEMAND_MARKET_IDS],
    targetMinimumCashUsd: 30_000_000,
    expectedRawPriceUsdPerKg: 2.5,
    ...overrides,
  } as unknown as PressureScores;
}

const params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1;
const NO_ACTIVE_PROJECTS: ReadonlySet<CapitalProjectType> = new Set();

test("PD_AUTOMATION: 稼働率が持続的ボトルネック水準・在庫過剰なし・資金健全なら pdMechanization を提案する", () => {
  const proposals = buildStrategyProfileCapexOverlayProposals(
    STRATEGY_PROFILES.PD_AUTOMATION,
    observation(),
    pressures(),
    NO_ACTIVE_PROJECTS,
    params
  );
  assert.deepEqual(
    proposals.map((p) => p.projectType),
    ["pdMechanization"]
  );
});

test("PD_AUTOMATION: 既にpdMechanization案件を保有していれば追加提案しない", () => {
  const proposals = buildStrategyProfileCapexOverlayProposals(
    STRATEGY_PROFILES.PD_AUTOMATION,
    observation(),
    pressures(),
    new Set<CapitalProjectType>(["pdMechanization"]),
    params
  );
  assert.deepEqual(proposals, []);
});

test("PD_AUTOMATION: PD固有の前期稼働率が低い（productSustainedでない）場合は提案しない", () => {
  // 【2026-08-01訂正】以前は会社全体集計(pressures.equipmentUtilizationLastQuarter)を
  // 下げて検証していたが、overlayのトリガーはPD固有の稼働率のみを見るため、
  // observation.lastQuarterActualProductionByProduct.pdを下げて検証する
  // （pd 1000/8000=0.125 < OVERLAY_PRODUCT_UTILIZATION_THRESHOLD 0.5）。
  const proposals = buildStrategyProfileCapexOverlayProposals(
    STRATEGY_PROFILES.PD_AUTOMATION,
    observation({ lastQuarterActualProductionByProduct: { pd: 1000, vap: 4500 } }),
    pressures(),
    NO_ACTIVE_PROJECTS,
    params
  );
  assert.deepEqual(proposals, []);
});

test("PD_AUTOMATION: PD固有の前期実績生産量が未知（turn1等）なら提案しない", () => {
  const proposals = buildStrategyProfileCapexOverlayProposals(
    STRATEGY_PROFILES.PD_AUTOMATION,
    observation({ lastQuarterActualProductionByProduct: { vap: 4500 } }),
    pressures(),
    NO_ACTIVE_PROJECTS,
    params
  );
  assert.deepEqual(proposals, []);
});

test("PD_AUTOMATION: PD完成品在庫が過剰なら提案しない", () => {
  const proposals = buildStrategyProfileCapexOverlayProposals(
    STRATEGY_PROFILES.PD_AUTOMATION,
    observation({ finishedGoodsByProduct: { hoso: 0, pd: 100_000, vap: 0 } }),
    pressures(),
    NO_ACTIVE_PROJECTS,
    params
  );
  assert.deepEqual(proposals, []);
});

test("PD_AUTOMATION: 現金が安全水準を下回れば提案しない", () => {
  const proposals = buildStrategyProfileCapexOverlayProposals(
    STRATEGY_PROFILES.PD_AUTOMATION,
    observation({ cashUsd: 1_000_000 }),
    pressures(),
    NO_ACTIVE_PROJECTS,
    params
  );
  assert.deepEqual(proposals, []);
});

test("VAP_DIFFERENTIATION: 代表的な観測条件下では qualityControlEquipment を提案する", () => {
  const proposals = buildStrategyProfileCapexOverlayProposals(
    STRATEGY_PROFILES.VAP_DIFFERENTIATION,
    observation(),
    pressures(),
    NO_ACTIVE_PROJECTS,
    params
  );
  assert.deepEqual(
    proposals.map((p) => p.projectType),
    ["qualityControlEquipment"]
  );
});

test("VAP_DIFFERENTIATION: VAP固有の前期稼働率が低い（productSustainedでない）場合は提案しない", () => {
  const proposals = buildStrategyProfileCapexOverlayProposals(
    STRATEGY_PROFILES.VAP_DIFFERENTIATION,
    observation({ lastQuarterActualProductionByProduct: { pd: 6000, vap: 1000 } }),
    pressures(),
    NO_ACTIVE_PROJECTS,
    params
  );
  assert.deepEqual(proposals, []);
});

test("VAP_DIFFERENTIATION: 既にqualityControlEquipment案件を保有していれば追加提案しない", () => {
  const proposals = buildStrategyProfileCapexOverlayProposals(
    STRATEGY_PROFILES.VAP_DIFFERENTIATION,
    observation(),
    pressures(),
    new Set<CapitalProjectType>(["qualityControlEquipment"]),
    params
  );
  assert.deepEqual(proposals, []);
});

test("BALANCED: どのcapex overlayも提案しない（トリガー条件を満たしていても）", () => {
  const proposals = buildStrategyProfileCapexOverlayProposals(STRATEGY_PROFILES.BALANCED, observation(), pressures(), NO_ACTIVE_PROJECTS, params);
  assert.deepEqual(proposals, []);
});

test("HOSO_SCALE: どのcapex overlayも提案しない（HOSO_SCALEはpdMechanization/qualityControlEquipmentのいずれも要求しない）", () => {
  const proposals = buildStrategyProfileCapexOverlayProposals(
    STRATEGY_PROFILES.HOSO_SCALE,
    observation(),
    pressures(),
    NO_ACTIVE_PROJECTS,
    params
  );
  assert.deepEqual(proposals, []);
});

// ---------------------------------------------------------------------
// investment overlay
// ---------------------------------------------------------------------

test("computeStrategyProfileProductDevelopmentInvestment: VAP_DIFFERENTIATIONが割り当てられた会社のみ非ゼロの投資額（標準予算の0.5倍）を返す", () => {
  const standardBudget = PRODUCT_DEVELOPMENT_PARAMETERS_V1.standardBudgetUsd;
  // STRATEGY_PROFILE_BY_COMPANY_IDでVAP_DIFFERENTIATIONが割り当てられている会社（"VAP"）と、
  // BALANCEDが割り当てられている会社（"BAL"）の両方を含めて検証する。
  // 【2026-08-01調整】投資額はstandardBudgetUsdそのもの（1.0倍）ではなく0.5倍へ縮小した
  // （strategyProfileInvestmentOverlay.tsのVAP_PRODUCT_DEVELOPMENT_INVESTMENT_RATIO参照）。
  const result = computeStrategyProfileProductDevelopmentInvestment(["BAL", "MASS", "JPQ", "VAP", "CONSV"], standardBudget);
  assert.equal(result.get("VAP"), standardBudget * 0.5);
  assert.equal(result.has("BAL"), false);
  assert.equal(result.has("MASS"), false);
  assert.equal(result.has("JPQ"), false);
  assert.equal(result.has("CONSV"), false);
});

test("computeStrategyProfileProductDevelopmentInvestment: 対象会社がいなければ空Mapを返す", () => {
  const result = computeStrategyProfileProductDevelopmentInvestment(["BAL", "MASS"], PRODUCT_DEVELOPMENT_PARAMETERS_V1.standardBudgetUsd);
  assert.equal(result.size, 0);
});
