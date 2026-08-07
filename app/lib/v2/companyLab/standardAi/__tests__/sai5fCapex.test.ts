// ShrimpX V2 — Phase SAI-5F: Standard AIの拡張設備投資判断の単体テスト
//
// 合成observation/pressuresで、(a) ext無効時は新コード・resume提案が一切出ない、
// (b) 過剰供給リトリート、(c) ライフサイクル成長エントリ、(d) suspended案件の
// resume提案、(e) 資金難時はresumeしない、の方向性を検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStandardAiCapexDecision } from "../decision/capex";
import { StandardAiObservation } from "../types";
import { PressureScores } from "../pressures";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "../parameters";
import { CompanyFixture } from "../../types";
import { DEMAND_MARKET_IDS } from "../../../market/types";

// 【監査指摘H】PD_CAPACITY_MAINTAINED の判定がPD/VAPの最低受注水準を参照するため、
// 合成fixtureにも標準ベースラインと同等の商品経済性を持たせる（CompanyFixtureの
// 必須フィールドであり、本来省略してはいけない）。
const fixture = {
  companyId: "VAP",
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
    // 【2026-08-03・Phase Aハードニング】capex.tsのボトルネック判定が
    // totalEffectiveCapacityByProduct/totalEffectiveCommonProcessingCapacityを
    // 参照するよう変更されたため、合成observationにも実効能力を追加する。
    // 本テストの意図（capex提案条件の分岐検証）はノミナル値と実効値の差の検証では
    // ないため、同値をそのまま実効能力として与える。
    totalEffectiveCapacityByProduct: { hoso: 10000, pd: 8000, vap: 6000 },
    totalEffectiveCommonProcessingCapacity: 22000,
    aquacultureCapacity: 4000,
    salesForceHeadcountTotal: 80,
    procurementHeadcountTotal: 12,
    lastQuarterEquipmentUtilizationRate: 0.9,
    lastQuarterLaborUtilizationRate: 0.85,
    lastQuarterActualProductionByProduct: {},
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
    equipmentUtilizationLastQuarter: 0.9,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.85,
    marketPriceRanking: [...DEMAND_MARKET_IDS],
    targetMinimumCashUsd: 30_000_000,
    expectedRawPriceUsdPerKg: 2.5,
    ...overrides,
  } as unknown as PressureScores;
}

const NO_SHORTFALL = { hoso: 5000, pd: 4000, vap: 3000 }; // 全商品とも能力未満

function extParams(overrides: Partial<StandardAiParameters> = {}): StandardAiParameters {
  return {
    ...STANDARD_AI_PARAMETERS_V1,
    standardAiCapexExtensionsEnabled: true,
    growthTrendResponsiveness: 0.9,
    oversupplyRetreatSensitivity: 0.5,
    ...overrides,
  };
}

const positiveVapTrend = Object.fromEntries(DEMAND_MARKET_IDS.map((m) => [m, { hoso: -0.01, pd: 0.002, vap: 0.008 }])) as never;

test("SAI-5F: 拡張無効（既定パラメータ）ではresume提案・新コードが一切出ない（後方互換）", () => {
  const obs = observation({
    suspendedCapexProjectIds: ["VAP-CAPEX-1"],
    lifecycleTrendByMarket: positiveVapTrend,
    productSupplyPressureByProduct: { pd: 1.0, vap: 3.0 },
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 10000, STANDARD_AI_PARAMETERS_V1);
  assert.equal(result.capexDecision.resumeRequests.length, 0);
  assert.equal(result.capexDecision.newProjectProposals.length, 0);
  const codes = result.diagnostics.map((d) => d.code);
  for (const c of ["CAPEX_RESUME_PROPOSED", "VAP_GROWTH_ENTRY", "LIFECYCLE_GROWTH_PURSUED", "VAP_OVERSUPPLY_RETREAT", "CAPEX_DEFERRED_OVERSUPPLY"]) {
    assert.ok(!codes.includes(c as never), `拡張無効なのに${c}が出力された`);
  }
});

test("SAI-5F: 成長エントリ — 公開VAPトレンドが正・稼働率高・財務安全なら、能力不足の顕在化前にVAPライン増設を提案する", () => {
  const obs = observation({ lifecycleTrendByMarket: positiveVapTrend });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 10000, extParams());
  assert.ok(
    result.capexDecision.newProjectProposals.some((p) => p.projectType === "vapLineExpansion"),
    "VAPライン増設が提案されていない"
  );
  assert.ok(result.diagnostics.some((d) => d.code === "VAP_GROWTH_ENTRY"));
});

test("SAI-5F: 成長エントリは応答度が低い会社ほどしきい値が高く、同じトレンドでは動かない（保守型と積極型の投資時期差）", () => {
  const weakTrend = Object.fromEntries(DEMAND_MARKET_IDS.map((m) => [m, { hoso: -0.005, pd: 0.001, vap: 0.005 }])) as never;
  const obs = observation({ lifecycleTrendByMarket: weakTrend });
  const aggressive = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 10000, extParams({ growthTrendResponsiveness: 0.9 }));
  const conservative = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 10000, extParams({ growthTrendResponsiveness: 0.2 }));
  assert.ok(aggressive.capexDecision.newProjectProposals.some((p) => p.projectType === "vapLineExpansion"), "積極型が動いていない");
  assert.ok(!conservative.capexDecision.newProjectProposals.some((p) => p.projectType === "vapLineExpansion"), "保守型まで同時に動いている");
});

test("SAI-5F: 過剰供給リトリート — 公開供給圧力が高止まりしているVAPは、成長トレンドがあっても投資を見送る", () => {
  const obs = observation({
    lifecycleTrendByMarket: positiveVapTrend,
    productSupplyPressureByProduct: { pd: 1.0, vap: 2.5 },
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 10000, extParams());
  assert.ok(!result.capexDecision.newProjectProposals.some((p) => p.projectType === "vapLineExpansion"), "過剰供給下でVAP投資している");
  assert.ok(result.diagnostics.some((d) => d.code === "VAP_OVERSUPPLY_RETREAT"));
});

test("SAI-5F: 過剰供給リトリートの感度 — 追随型（低感度）は同じ圧力でもまだ投資し、慎重型（高感度）は見送る", () => {
  const obs = observation({
    lifecycleTrendByMarket: positiveVapTrend,
    productSupplyPressureByProduct: { pd: 1.0, vap: 1.3 },
  });
  // 高感度(0.9): しきい値 1.15+(1-0.9)*0.3=1.18 < 1.3 → 見送り
  const cautious = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 10000, extParams({ oversupplyRetreatSensitivity: 0.9 }));
  // 低感度(0.1): しきい値 1.15+0.27=1.42 > 1.3 → まだ投資
  const follower = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 10000, extParams({ oversupplyRetreatSensitivity: 0.1 }));
  assert.ok(!cautious.capexDecision.newProjectProposals.some((p) => p.projectType === "vapLineExpansion"));
  assert.ok(follower.capexDecision.newProjectProposals.some((p) => p.projectType === "vapLineExpansion"));
});

test("SAI-5F: resume提案 — 現金が安全水準を回復した場合のみ、中断中案件の再開を提案する", () => {
  const suspended = { suspendedCapexProjectIds: ["VAP-CAPEX-1", "VAP-CAPEX-2"] };
  const rich = buildStandardAiCapexDecision(fixture, observation(suspended), pressures(), NO_SHORTFALL, 10000, extParams());
  assert.equal(rich.capexDecision.resumeRequests.length, 2);
  assert.deepEqual(
    rich.capexDecision.resumeRequests.map((r) => r.projectId),
    ["VAP-CAPEX-1", "VAP-CAPEX-2"]
  );
  assert.ok(rich.diagnostics.some((d) => d.code === "CAPEX_RESUME_PROPOSED"));

  // 資金難（現金 < 目標バッファ×1.75）ならresumeしない（安全ガード優先）
  const poor = buildStandardAiCapexDecision(
    fixture,
    observation({ ...suspended, cashUsd: 40_000_000 }),
    pressures(),
    NO_SHORTFALL,
    10000,
    extParams()
  );
  assert.equal(poor.capexDecision.resumeRequests.length, 0);
});

test("SAI-5F: 成長エントリは既に同一ターゲットの案件が進行中なら提案しない（二重提案の防止）", () => {
  const obs = observation({
    lifecycleTrendByMarket: positiveVapTrend,
    activeCapexProjectTargets: new Set(["vap"]),
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 10000, extParams());
  assert.ok(!result.capexDecision.newProjectProposals.some((p) => p.projectType === "vapLineExpansion"), "進行中でも二重提案している");
});

// ---------------------------------------------------------------------
// 【監査指摘H】PD_CAPACITY_MAINTAINED — 実際の判断への接続
//
// 以前は3箇所（reasonCodes.ts / reasonTaxonomy.ts / reasonCodeCatalog.ts）で
// 定義されているだけで、どこからも発火しない「実体のない判断」だった。
// 5条件をすべて実データから確認したときだけ発火することを、条件ごとに検証する。
// ---------------------------------------------------------------------

/** PD_CAPACITY_MAINTAINEDが発火する基準条件（VAP過熱・PD稼働中・PD自力採算）。 */
const PD_MAINTAINED_BASE = {
  // VAP: 供給圧力が抑制しきい値(1.14)を超えて過熱 → 過剰供給リトリートで増設せず
  productSupplyPressureByProduct: { pd: 1.0, vap: 2.0 },
  // VAPには成長トレンドもある（追随の誘因が実在する）
  lifecycleTrendByMarket: positiveVapTrend,
  // PDプレミアムは最低受注水準（約0.25）を上回る
  marketPremiumByProduct: { pd: 0.9, vap: 2.5 },
} as const;

/** PD稼働率がしきい値(0.5)を十分に超える生産必要量。 */
const PD_IN_USE = { hoso: 5000, pd: 6000, vap: 3000 }; // pd能力8000に対し0.75

test("SAI-5H: VAPが過熱していてPDが稼働中・自力採算なら、PD_CAPACITY_MAINTAINEDが発火する", () => {
  const result = buildStandardAiCapexDecision(fixture, observation(PD_MAINTAINED_BASE), pressures(), PD_IN_USE, 10000, extParams());
  const entry = result.diagnostics.find((d) => d.code === "PD_CAPACITY_MAINTAINED");
  assert.ok(entry, "PD_CAPACITY_MAINTAINEDが発火していない");
  // VAPへは実際に追随していない（＝判断と記録が一致している）
  assert.ok(!result.capexDecision.newProjectProposals.some((p) => p.projectType === "vapLineExpansion"), "VAP増設を提案しているのに『追随せず』と記録している");
  assert.ok(result.diagnostics.some((d) => d.code === "VAP_OVERSUPPLY_RETREAT"), "VAP側の見送り判断が記録されていない");
  assert.ok((entry!.keyValues?.vapSupplyPressureEwma ?? 0) > (entry!.keyValues?.supplyPressureRetreatThreshold ?? Infinity));
});

test("SAI-5H: VAPが過熱していなければ発火しない（過熱局面に限った判断であること）", () => {
  const result = buildStandardAiCapexDecision(
    fixture,
    observation({ ...PD_MAINTAINED_BASE, productSupplyPressureByProduct: { pd: 1.0, vap: 1.0 } }),
    pressures(),
    PD_IN_USE,
    10000,
    extParams()
  );
  assert.ok(!result.diagnostics.some((d) => d.code === "PD_CAPACITY_MAINTAINED"), "VAPが過熱していないのに発火した");
});

test("SAI-5H: PD能力が遊んでいれば発火しない（維持する価値のある稼働があること）", () => {
  const idlePd = { hoso: 5000, pd: 800, vap: 3000 }; // pd能力8000に対し0.1
  const result = buildStandardAiCapexDecision(fixture, observation(PD_MAINTAINED_BASE), pressures(), idlePd, 10000, extParams());
  assert.ok(!result.diagnostics.some((d) => d.code === "PD_CAPACITY_MAINTAINED"), "PD能力が遊んでいるのに『維持を選択』と記録された");
});

test("SAI-5H: PDプレミアムが最低受注水準を下回れば発火しない（自力採算が取れていること）", () => {
  const result = buildStandardAiCapexDecision(
    fixture,
    observation({ ...PD_MAINTAINED_BASE, marketPremiumByProduct: { pd: 0.1, vap: 2.5 } }),
    pressures(),
    PD_IN_USE,
    10000,
    extParams()
  );
  assert.ok(!result.diagnostics.some((d) => d.code === "PD_CAPACITY_MAINTAINED"), "PDが最低受注水準を割っているのに『維持を選択』と記録された");
});

test("SAI-5H: 実際にVAP増設を提案した四半期には発火しない（追随したのに『追随せず』と記録しない）", () => {
  // VAPは過熱していないが成長トレンドはある → VAP_GROWTH_ENTRYで増設を提案する局面
  const result = buildStandardAiCapexDecision(
    fixture,
    observation({ ...PD_MAINTAINED_BASE, productSupplyPressureByProduct: { pd: 1.0, vap: 1.0 } }),
    pressures(),
    NO_SHORTFALL,
    10000,
    extParams()
  );
  assert.ok(result.capexDecision.newProjectProposals.some((p) => p.projectType === "vapLineExpansion"), "テスト前提: VAP増設が提案されていない");
  assert.ok(!result.diagnostics.some((d) => d.code === "PD_CAPACITY_MAINTAINED"), "VAP増設に追随したのにPD維持が記録された");
});

test("SAI-5H: 拡張機能が無効なら発火しない（後方互換）", () => {
  const result = buildStandardAiCapexDecision(fixture, observation(PD_MAINTAINED_BASE), pressures(), PD_IN_USE, 10000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(!result.diagnostics.some((d) => d.code === "PD_CAPACITY_MAINTAINED"));
});

test("SAI-5H: PD側の供給圧力が見送りしきい値を超えればCAPEX_DEFERRED_OVERSUPPLYも発火する（代表シナリオでは到達しない経路の健全性確認）", () => {
  // 【正直な報告】4seed×32Qの実測ではPD供給圧力EWMAの上限が1.048で、見送り
  // しきい値1.20へ到達しないため、この経路は代表シナリオでは発火しない。
  // 発火させるために本体の条件を緩めることはせず、専用fixtureで経路の健全性のみ確認する。
  const pdShortfall = { hoso: 5000, pd: 12000, vap: 3000 }; // pd能力8000を超える＝ボトルネック
  const result = buildStandardAiCapexDecision(
    fixture,
    observation({ productSupplyPressureByProduct: { pd: 2.0, vap: 1.0 }, lifecycleTrendByMarket: positiveVapTrend }),
    pressures(),
    pdShortfall,
    10000,
    extParams()
  );
  assert.ok(result.diagnostics.some((d) => d.code === "CAPEX_DEFERRED_OVERSUPPLY"), "PD供給過剰による投資見送りが記録されていない");
  assert.ok(!result.capexDecision.newProjectProposals.some((p) => p.projectType === "pdLineExpansion"), "供給過剰なのにPD増設を提案している");
});
