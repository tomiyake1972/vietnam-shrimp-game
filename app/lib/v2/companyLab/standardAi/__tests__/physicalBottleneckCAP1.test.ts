// ShrimpX V2 — Phase SAI-CAP-1: Physical Bottleneck Recognition & CAPEX Routing
//
// 【このPhaseが直したもの】Standard AI の物理能力認識が
//   min(商品別ライン合計, 共通前処理)
// であり、生産エンジン production/allocation.ts の段階3（冷凍・包装）が抜けていた。
// そのため MASS では真の上限 59,850t に対して 63,270t を上限と誤認し、
// Deliverability の headroom が実行可能量より 35.5% 過大になっていた
// （docs/v2/SAI_EXECUTION_BOTTLENECK_AUDIT.md / #04 DS3能力監査で一致）。
// さらに freezingPackagingExpansion が提案可能種別に無く、解消手段が存在しなかった。

import { test } from "node:test";
import assert from "node:assert/strict";
import { computePhysicalCapacity, computeBindingProductionCapacityTons } from "../bindingCapacity";
import { buildStandardAiCapexDecision, STANDARD_AI_PROPOSABLE_CAPEX_TYPES } from "../decision/capex";
import { StandardAiObservation } from "../types";
import { PressureScores } from "../pressures";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "../parameters";
import { CompanyFixture } from "../../types";
import { DEMAND_MARKET_IDS } from "../../../market/types";
import { calculateFactoryEffectiveCapacity } from "../../../production/capacity";
import { hosoEqTons, ratio } from "../../../core/units";
import { Factory } from "../../../production/types";
import { PRODUCTION_PARAMETERS_V1 } from "../../../production/parameters";

const RECOVERY = PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio;

// ---------------------------------------------------------------------
// A. Binding recognition（CAP1-1〜CAP1-6）
// ---------------------------------------------------------------------

test("CAP1-1: 冷凍・包装が最小なら bindingPhysicalPool = FREEZING_PACKAGING", () => {
  // MASS T24〜T32 の実測値そのまま（ライン 68,785 / 共通 63,270 / 冷凍包装 59,850）。
  const r = computePhysicalCapacity({
    effectiveCapacityByProduct: { hoso: 37620, pd: 18810, vap: 12355 },
    commonProcessingInputCapacityTons: 63270,
    freezingPackagingCapacityTons: 59850,
    saleableRecoveryRatioByProduct: RECOVERY,
  });
  assert.equal(r.productLineCapacityTons, 68785);
  assert.equal(r.commonProcessingSaleableCapacityTons, 63270);
  assert.equal(r.freezingPackagingCapacityTons, 59850);
  assert.equal(r.bindingPhysicalCapacityTons, 59850);
  assert.equal(r.bindingPhysicalPool, "FREEZING_PACKAGING");
  assert.equal(r.headroomByPool.FREEZING_PACKAGING, 0);
  assert.ok(r.headroomByPool.COMMON_PROCESSING > 0);
});

test("CAP1-2: 共通前処理が最小なら COMMON_PROCESSING", () => {
  const r = computePhysicalCapacity({
    effectiveCapacityByProduct: { hoso: 30000, pd: 20000, vap: 10000 },
    commonProcessingInputCapacityTons: 40000,
    freezingPackagingCapacityTons: 55000,
    saleableRecoveryRatioByProduct: RECOVERY,
  });
  assert.equal(r.bindingPhysicalCapacityTons, 40000);
  assert.equal(r.bindingPhysicalPool, "COMMON_PROCESSING");
});

test("CAP1-3: 商品別ラインが最小なら PRODUCT_LINE", () => {
  const r = computePhysicalCapacity({
    effectiveCapacityByProduct: { hoso: 10000, pd: 5000, vap: 3000 },
    commonProcessingInputCapacityTons: 40000,
    freezingPackagingCapacityTons: 35000,
    saleableRecoveryRatioByProduct: RECOVERY,
  });
  assert.equal(r.bindingPhysicalCapacityTons, 18000);
  assert.equal(r.bindingPhysicalPool, "PRODUCT_LINE");
});

test("CAP1-3b: 複数プールが同値なら TIED", () => {
  const r = computePhysicalCapacity({
    effectiveCapacityByProduct: { hoso: 20000, pd: 10000, vap: 0 },
    commonProcessingInputCapacityTons: 30000,
    freezingPackagingCapacityTons: 30000,
    saleableRecoveryRatioByProduct: RECOVERY,
  });
  assert.equal(r.bindingPhysicalCapacityTons, 30000);
  assert.equal(r.bindingPhysicalPool, "TIED");
});

// 工場 lifecycle は production/capacity.ts::calculateFactoryEffectiveCapacity が
// 唯一の判定箇所であり、このテストも同関数を通して集計する（status を自前で見ない）。
function factory(id: string, status: Factory["status"]): Factory {
  return {
    factoryId: id,
    companyId: "MASS",
    status,
    commonProcessingCapacity: hosoEqTons(22000),
    hosoCapacity: hosoEqTons(10000),
    pdCapacity: hosoEqTons(8000),
    vapCapacity: hosoEqTons(6000),
    freezingPackagingCapacity: hosoEqTons(20000),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
  } as unknown as Factory;
}

function poolsFromFactories(factories: readonly Factory[]) {
  const byProduct = { hoso: 0, pd: 0, vap: 0 };
  let common = 0;
  let freezing = 0;
  for (const f of factories) {
    const e = calculateFactoryEffectiveCapacity(f);
    byProduct.hoso += Number(e.hoso);
    byProduct.pd += Number(e.pd);
    byProduct.vap += Number(e.vap);
    common += Number(e.commonProcessing);
    freezing += Number(e.freezingPackaging);
  }
  return {
    effectiveCapacityByProduct: byProduct,
    commonProcessingInputCapacityTons: common,
    freezingPackagingCapacityTons: freezing,
    saleableRecoveryRatioByProduct: RECOVERY,
  };
}

test("CAP1-4: 複数工場のプールは工場横断で合算される", () => {
  const r = computePhysicalCapacity(poolsFromFactories([factory("F1", "active"), factory("F2", "active")]));
  assert.equal(r.productLineCapacityTons, 48000); // (10000+8000+6000) × 2
  assert.equal(r.commonProcessingInputCapacityTons, 44000);
  assert.equal(r.freezingPackagingCapacityTons, 40000);
  assert.equal(r.bindingPhysicalCapacityTons, 40000);
  assert.equal(r.bindingPhysicalPool, "FREEZING_PACKAGING");
});

test("CAP1-5: 非稼働(idle)工場は物理能力へ一切入らない", () => {
  const both = computePhysicalCapacity(poolsFromFactories([factory("F1", "active"), factory("F2", "idle")]));
  const onlyActive = computePhysicalCapacity(poolsFromFactories([factory("F1", "active")]));
  assert.deepEqual(both, onlyActive, "idle工場が能力へ算入されている");
  assert.equal(both.freezingPackagingCapacityTons, 20000);
});

test("CAP1-6: 停止(suspended)工場も物理能力へ一切入らない", () => {
  const both = computePhysicalCapacity(poolsFromFactories([factory("F1", "active"), factory("F2", "suspended")]));
  const onlyActive = computePhysicalCapacity(poolsFromFactories([factory("F1", "active")]));
  assert.deepEqual(both, onlyActive, "suspended工場が能力へ算入されている");
  // lifecycle 判定は calculateFactoryEffectiveCapacity 側にのみ存在する。
  // ENG-FAC-1 の MOTHBALLED / SOLD が導入されても、同関数が非稼働として扱う限り
  // このテストと同じ性質（物理能力へ入らない）が自動的に成立する。
});

test("CAP1-6b: 共通前処理は販売可能回収率で完成品側へ換算される", () => {
  const r = computePhysicalCapacity({
    effectiveCapacityByProduct: { hoso: 100000, pd: 0, vap: 0 },
    commonProcessingInputCapacityTons: 10000,
    freezingPackagingCapacityTons: 100000,
    saleableRecoveryRatioByProduct: { hoso: 0.8, pd: 1, vap: 1 },
  });
  assert.equal(r.commonProcessingInputCapacityTons, 10000);
  assert.equal(r.commonProcessingSaleableCapacityTons, 8000);
  assert.equal(r.bindingPhysicalCapacityTons, 8000);
  assert.equal(r.bindingPhysicalPool, "COMMON_PROCESSING");
});

test("CAP1-6c: 現行パラメータ（全商品1.0）では換算前後が一致する＝この変更単体で挙動を変えない", () => {
  const withRatio = computeBindingProductionCapacityTons(
    { hoso: 30000, pd: 20000, vap: 10000 },
    50000,
    70000,
    RECOVERY
  );
  const withoutRatio = computeBindingProductionCapacityTons({ hoso: 30000, pd: 20000, vap: 10000 }, 50000, 70000);
  assert.equal(withRatio, withoutRatio);
  assert.equal(withRatio, 50000);
});

// ---------------------------------------------------------------------
// B. CAPEX routing（CAP1-7〜CAP1-15）
// ---------------------------------------------------------------------

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

/**
 * 合成 observation。プール構成（line / common / freezing）だけを引数で動かし、
 * それ以外（現金・前期稼働・在庫）は「投資条件が揃っている」状態に固定する。
 */
function observation(opts: {
  line: { hoso: number; pd: number; vap: number };
  common: number;
  freezing: number;
  lastProduction: { hoso: number; pd: number; vap: number };
  activeTargets?: Set<string>;
}): StandardAiObservation {
  const factoryCount = 1;
  return {
    companyId: "MASS",
    period: "2020Q4",
    turn: 24,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 200000,
    rawMaterialPipeline: 0,
    factories: Array.from({ length: factoryCount }, (_, i) => ({
      factoryId: `MASS-F${i + 1}`,
      capacityByProduct: opts.line,
      commonProcessingCapacity: opts.common,
      freezingPackagingCapacity: opts.freezing,
      effectiveCapacityByProduct: opts.line,
      effectiveCommonProcessingCapacity: opts.common,
      effectiveFreezingPackagingCapacity: opts.freezing,
      totalFactorySpaceUnits: 1_000_000,
      usedFactorySpaceUnits: 0,
      skillByProduct: { hoso: 1, pd: 1, vap: 1 },
      currentRegularHeadcount: 5000,
      qualityMetrics: {
        productionTons: opts.lastProduction.hoso + opts.lastProduction.pd + opts.lastProduction.vap,
        qualitySensitiveProductionTons: opts.lastProduction.pd + opts.lastProduction.vap,
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
    })),
    totalCapacityByProduct: opts.line,
    totalCommonProcessingCapacity: opts.common,
    totalEffectiveCapacityByProduct: opts.line,
    totalEffectiveCommonProcessingCapacity: opts.common,
    totalEffectiveFreezingPackagingCapacity: opts.freezing,
    factorySpaceTotalUnits: 1_000_000,
    factorySpaceUsedUnits: 0,
    factorySpaceRemainingUnits: 1_000_000,
    factoryCount,
    prospectiveFactoryCount: factoryCount,
    aquacultureCapacity: 4000,
    salesForceHeadcountTotal: 200,
    procurementHeadcountTotal: 20,
    lastQuarterEquipmentUtilizationRate: 0.95,
    lastQuarterLaborUtilizationRate: 0.95,
    lastQuarterActualProductionByProduct: opts.lastProduction,
    markets: [],
    marketPremiumByProduct: { pd: 1.0, vap: 3.0 },
    vietnamDomesticPriorPrice: 4.0,
    lastHosoPriceVn: 5.0,
    productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 } },
    cashUsd: 400_000_000,
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 20000,
    activeCapexProjectTargets: opts.activeTargets ?? new Set(),
    suspendedCapexProjectIds: [],
    qualityScoreByProduct: {},
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
  } as unknown as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
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
    ...overrides,
  } as unknown as PressureScores;
}

/** MASS 実測に近い「冷凍・包装が binding」な状態。 */
const FREEZING_BOUND = {
  line: { hoso: 37620, pd: 18810, vap: 12355 },
  common: 63270,
  freezing: 59850,
  lastProduction: { hoso: 30270, pd: 14633, vap: 8731 },
};
/** 冷凍・包装が潤沢で、共通前処理が binding な状態。 */
const COMMON_BOUND = {
  line: { hoso: 37620, pd: 18810, vap: 12355 },
  common: 50000,
  freezing: 90000,
  lastProduction: { hoso: 26000, pd: 13000, vap: 8000 },
};
/** 共有プールが潤沢で、商品別ラインが binding な状態。 */
const LINE_BOUND = {
  line: { hoso: 12000, pd: 6000, vap: 4000 },
  common: 90000,
  freezing: 90000,
  lastProduction: { hoso: 11800, pd: 5900, vap: 3950 },
};

/** 需要はいずれのプールも大きく超えており、能力不足であることが明白な状態。 */
const HEAVY_DEMAND = { hoso: 80000, pd: 40000, vap: 25000 };
const HEAVY_RAW = 200000;

function decide(obs: StandardAiObservation, params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1) {
  return buildStandardAiCapexDecision(fixture, obs, pressures(), HEAVY_DEMAND, HEAVY_RAW, params);
}
const proposedTypes = (r: ReturnType<typeof decide>) => r.capexDecision.newProjectProposals.map((p) => p.projectType);

test("CAP1-7: 冷凍・包装が binding なら freezingPackagingExpansion が候補に出る", () => {
  const types = proposedTypes(decide(observation(FREEZING_BOUND)));
  assert.ok(types.includes("freezingPackagingExpansion"), `提案: ${types.join(", ") || "(なし)"}`);
});

test("CAP1-8: 共通前処理が binding なら commonProcessingExpansion が候補に出る", () => {
  const types = proposedTypes(decide(observation(COMMON_BOUND)));
  assert.ok(types.includes("commonProcessingExpansion"), `提案: ${types.join(", ") || "(なし)"}`);
});

test("CAP1-9: 商品別ラインが binding なら該当ライン増設が候補に出る", () => {
  const types = proposedTypes(decide(observation(LINE_BOUND)));
  assert.ok(
    types.some((t) => t === "hosoLineExpansion" || t === "pdLineExpansion" || t === "vapLineExpansion"),
    `提案: ${types.join(", ") || "(なし)"}`
  );
});

test("CAP1-10: 冷凍・包装 binding のとき、ライン増設だけを提案して終わらない", () => {
  const types = proposedTypes(decide(observation(FREEZING_BOUND)));
  const lineOnly = types.length > 0 && types.every((t) => t.endsWith("LineExpansion"));
  assert.ok(!lineOnly, `ライン増設のみが提案された: ${types.join(", ")}`);
  // 共有プールが binding のとき、納品可能量を1トンも増やさないライン増設は出さない。
  assert.ok(!types.includes("hosoLineExpansion"), "冷凍・包装がbindingなのにHOSOライン増設が出た");
});

test("CAP1-11: 共通前処理 binding のとき、ライン増設だけを提案して終わらない", () => {
  const types = proposedTypes(decide(observation(COMMON_BOUND)));
  const lineOnly = types.length > 0 && types.every((t) => t.endsWith("LineExpansion"));
  assert.ok(!lineOnly, `ライン増設のみが提案された: ${types.join(", ")}`);
  assert.ok(!types.includes("hosoLineExpansion"), "共通前処理がbindingなのにHOSOライン増設が出た");
});

test("CAP1-12: 現金が不足していれば冷凍・包装増設も提案しない（liquidity gate維持）", () => {
  const poor = observation({ ...FREEZING_BOUND }) as unknown as Record<string, unknown>;
  poor.cashUsd = 1_000_000;
  const types = proposedTypes(decide(poor as unknown as StandardAiObservation));
  assert.ok(!types.includes("freezingPackagingExpansion"), `資金難なのに提案された: ${types.join(", ")}`);
});

test("CAP1-13: 前期実績が無いturnでは持続性が成立せず提案しない（Survival/立ち上がり抑制維持）", () => {
  const r = buildStandardAiCapexDecision(
    fixture,
    observation(FREEZING_BOUND),
    pressures({ hadPriorQuarterUtilization: false } as Partial<PressureScores>),
    HEAVY_DEMAND,
    HEAVY_RAW,
    STANDARD_AI_PARAMETERS_V1
  );
  const types = r.capexDecision.newProjectProposals.map((p) => p.projectType);
  assert.ok(!types.includes("freezingPackagingExpansion"), `前期実績が無いのに提案された: ${types.join(", ")}`);
});

test("CAP1-14: 会社ID・シナリオIDによる分岐がソースに存在しない", () => {
  // routing は物理プールの大小関係のみで決まる。会社名を条件に使っていないことを、
  // 同一プール構成へ別会社IDを与えても結論が変わらないことで確認する。
  const asMass = proposedTypes(decide(observation(FREEZING_BOUND)));
  const otherFixture = { ...fixture, companyId: "CONSV" } as unknown as CompanyFixture;
  const obs = observation(FREEZING_BOUND) as unknown as Record<string, unknown>;
  obs.companyId = "CONSV";
  const asConsv = buildStandardAiCapexDecision(
    otherFixture,
    obs as unknown as StandardAiObservation,
    pressures(),
    HEAVY_DEMAND,
    HEAVY_RAW,
    STANDARD_AI_PARAMETERS_V1
  ).capexDecision.newProjectProposals.map((p) => p.projectType);
  assert.deepEqual(asConsv, asMass);
});

test("CAP1-15: 同一入力なら同一提案（決定論）", () => {
  const a = proposedTypes(decide(observation(FREEZING_BOUND)));
  const b = proposedTypes(decide(observation(FREEZING_BOUND)));
  assert.deepEqual(b, a);
});

// ---------------------------------------------------------------------
// C. 追加（CAP1-16〜CAP1-20）
// ---------------------------------------------------------------------

test("CAP1-16: 候補ごとの incrementalDeliverableCapacity が診断に残り、binding外は0になる", () => {
  const r = decide(observation(FREEZING_BOUND));
  const entries = r.diagnostics.filter((d) => d.keyValues && "incrementalDeliverableCapacityTons" in (d.keyValues ?? {}));
  assert.ok(entries.length > 0, "routing診断が1件も出ていない");
  const freezingEntry = entries.find((d) => Number(d.keyValues!.candidateNominalCapacityAdded) === 800);
  assert.ok(freezingEntry, "冷凍・包装候補の診断が無い");
  assert.ok(Number(freezingEntry!.keyValues!.incrementalDeliverableCapacityTons) > 0);
  assert.equal(Number(freezingEntry!.keyValues!.bindingPoolIsFreezingPackaging), 1);
});

test("CAP1-17: 共有プール解消後は binding が次のプールへ移る", () => {
  // 冷凍・包装を common 超まで増やすと、次に効くのは common になる。
  const before = computePhysicalCapacity({
    effectiveCapacityByProduct: FREEZING_BOUND.line,
    commonProcessingInputCapacityTons: FREEZING_BOUND.common,
    freezingPackagingCapacityTons: FREEZING_BOUND.freezing,
    saleableRecoveryRatioByProduct: RECOVERY,
  });
  assert.equal(before.bindingPhysicalPool, "FREEZING_PACKAGING");
  const after = computePhysicalCapacity({
    effectiveCapacityByProduct: FREEZING_BOUND.line,
    commonProcessingInputCapacityTons: FREEZING_BOUND.common,
    freezingPackagingCapacityTons: 70000,
    saleableRecoveryRatioByProduct: RECOVERY,
  });
  assert.equal(after.bindingPhysicalPool, "COMMON_PROCESSING");
  assert.ok(after.bindingPhysicalCapacityTons > before.bindingPhysicalCapacityTons);
});

test("CAP1-18: binding でないプールの増設は納品可能量を1トンも増やさない", () => {
  const base = {
    effectiveCapacityByProduct: FREEZING_BOUND.line,
    commonProcessingInputCapacityTons: FREEZING_BOUND.common,
    freezingPackagingCapacityTons: FREEZING_BOUND.freezing,
    saleableRecoveryRatioByProduct: RECOVERY,
  };
  const before = computePhysicalCapacity(base).bindingPhysicalCapacityTons;
  // HOSOライン +4,000（名目）を足しても binding は冷凍・包装のまま。
  const afterLine = computePhysicalCapacity({
    ...base,
    effectiveCapacityByProduct: { ...FREEZING_BOUND.line, hoso: FREEZING_BOUND.line.hoso + 4000 },
  }).bindingPhysicalCapacityTons;
  assert.equal(afterLine - before, 0);
  // 冷凍・包装 +800 は素直に +800。
  const afterFreezing = computePhysicalCapacity({ ...base, freezingPackagingCapacityTons: FREEZING_BOUND.freezing + 800 })
    .bindingPhysicalCapacityTons;
  assert.equal(afterFreezing - before, 800);
});

test("CAP1-19: ライン binding のとき、単位の大きいHOSOへ機械的に寄せない（商品別条件は維持）", () => {
  // VAPだけが逼迫し、HOSO/PDには余裕がある構成。
  const types = proposedTypes(
    decide(
      observation({
        line: { hoso: 60000, pd: 40000, vap: 3000 },
        common: 200000,
        freezing: 200000,
        lastProduction: { hoso: 100, pd: 100, vap: 2950 },
      })
    )
  );
  assert.ok(!types.includes("hosoLineExpansion"), `逼迫していないHOSOが提案された: ${types.join(", ")}`);
});

test("CAP1-20: 提案可能種別に freezingPackagingExpansion が入り、coldStorageExpansion は入らない", () => {
  assert.ok(STANDARD_AI_PROPOSABLE_CAPEX_TYPES.includes("freezingPackagingExpansion"));
  assert.ok(!STANDARD_AI_PROPOSABLE_CAPEX_TYPES.includes("coldStorageExpansion"));
  assert.ok(!STANDARD_AI_PROPOSABLE_CAPEX_TYPES.includes("environmentalEquipment"));
});
