// ShrimpX V2 — Vision駆動の戦略成長・新工場判断の単体テスト
//
// 検証の軸は3つ。
//   1. Vision は quota ではなく物差しである（達成できないことは異常でない）。
//   2. 未来を知らずに判断する（観測できる値だけで gate が決まる）。
//   3. **建てなかった理由が必ず残る**（見送りも記録される決定である）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyVision, resolveVisionAtTurn, referenceScaleAtTurn, COMPANY_VISION_SCHEMA_VERSION } from "../types";
import { DEFAULT_COMPANY_VISION_DOCUMENTS, defaultVisionDocumentFor } from "../defaults";
import { computeStrategicGrowthState, growthPressureAtLeast } from "../strategicGrowth";
import { evaluateNewFactoryDecision, NEW_FACTORY_STRATEGY_PARAMETERS_V1 } from "../../standardAi/decision/newFactory";
import { StandardAiObservation } from "../../standardAi/types";
import { PressureScores } from "../../standardAi/pressures";
import { CompanyFixture } from "../../types";

const fixture = { companyId: "BAL" } as unknown as CompanyFixture;

function vision(overrides: Partial<CompanyVision> = {}): CompanyVision {
  return {
    visionId: "TEST-vision",
    effectiveFromTurn: 1,
    growthAmbition: "HIGH",
    targetScaleTonsPerQuarterAtQ32: 34000,
    preferredEndState: "LARGE_INTEGRATED",
    willingnessToBuildFactories: "HIGH",
    financialRiskTolerance: "HIGH",
    desiredProductEvolution: "INTEGRATED",
    referenceGrowthPath: [
      { turn: 1, scaleTonsPerQuarter: 16000 },
      { turn: 32, scaleTonsPerQuarter: 34000 },
    ],
    longTermNarrative: "テスト用",
    emphasisProducts: ["hoso"],
    ...overrides,
  };
}

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    period: "2015Q3",
    turn: 12,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 5000,
    rawMaterialPipeline: 1000,
    rawMaterialInTransitImportQuantity: 0,
    rawMaterialGrowingAquacultureQuantity: 0,
    rawMaterialCertainInboundThisPeriod: 0,
    factories: [],
    totalCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    totalCommonProcessingCapacity: 30000,
    totalEffectiveCapacityByProduct: { hoso: 6840, pd: 5985, vap: 4275 },
    totalEffectiveCommonProcessingCapacity: 25650,
    totalEffectiveFreezingPackagingCapacity: 25650,
    aquacultureCapacity: 4000,
    salesForceHeadcountTotal: 120,
    procurementHeadcountTotal: 12,
    lastQuarterActualProductionByProduct: { hoso: 6800, pd: 5900, vap: 4200 },
    markets: [],
    marketPremiumByProduct: {},
    vietnamDomesticPriorMarket: { supply: 40000, effectiveDemand: 30000, transactedVolume: 30000, unsoldSupply: 10000 },
    productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 } },
    cashUsd: 200_000_000,
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 6000,
    receivablesDueThisPeriodUsd: 0,
    receivablesNotYetDueUsd: 0,
    payablesDueThisPeriodUsd: 0,
    payablesNotYetDueUsd: 0,
    existingLoanInterestUsdThisQuarterEstimate: 0,
    existingLoanScheduledPrincipalDueUsdThisQuarterEstimate: 0,
    factoryCount: 1,
    maxFactoriesPerCompany: 4,
    pendingNewFactoryProjectCount: 0,
    prospectiveFactoryCount: 1,
    factorySpaceTotalUnits: 125350,
    factorySpaceUsedUnits: 124350,
    factorySpaceRemainingUnits: 1000,
    activeCapexProjectTargets: new Set(),
    qualityScoreByProduct: {},
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
    ...overrides,
  } as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
  return {
    borrowingPressure: 0,
    equipmentUtilizationLastQuarter: 0.9,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.9,
    targetMinimumCashUsd: 20_000_000,
    ...overrides,
  } as PressureScores;
}

/** 全ゲートを通す既定入力（各テストは1項目だけ崩して、その理由コードを確認する）。 */
function passingInput(overrides: Record<string, unknown> = {}) {
  const v = vision();
  const growth = computeStrategicGrowthState({ vision: v, turn: 20, currentSustainableScaleTons: 10_000 });
  return {
    turn: 20,
    fixture,
    observation: observation(),
    pressures: pressures(),
    vision: v,
    strategicGrowth: growth,
    productionNeededByProductBeforeCap: { hoso: 7000, pd: 6000, vap: 4500 },
    existingExpansionProposedThisQuarter: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// 1. Vision スキーマ・既定値
// ---------------------------------------------------------------------

test("VISION-1: 5社すべてに既定 Vision があり、turn 1 から有効である", () => {
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    const doc = defaultVisionDocumentFor(companyId);
    assert.ok(doc, `${companyId} の Vision が無い`);
    assert.equal(doc.schemaVersion, COMPANY_VISION_SCHEMA_VERSION);
    const v = resolveVisionAtTurn(doc, 1);
    assert.ok(v, `${companyId} の turn1 Vision が解決できない`);
    assert.equal(v.effectiveFromTurn, 1);
  }
  assert.equal(DEFAULT_COMPANY_VISION_DOCUMENTS.size, 5);
});

test("VISION-2: 未知の会社には架空の Vision を作らない", () => {
  assert.equal(defaultVisionDocumentFor("UNKNOWN_CO"), null);
});

test("VISION-3: 既定 Vision の合計は、5社が獲得対象にできる需要の総量を超えない", () => {
  // 実測: Q32 の TRUE 需要 266,642t/四半期（scripts/visionBaselineCalibration.ts）。
  // 全社が同時に達成しても算術的に成立しうる水準に収まっていること。
  //
  // 【Management Console Vision Calibration・2026-08】MASSを40,000→80,000へ
  // 引き上げたため合計は148,000→188,000へ増える（他4社は不変）。それでも
  // Q32 TRUE需要（266,642t）は超えていない。
  const total = [...DEFAULT_COMPANY_VISION_DOCUMENTS.values()].reduce(
    (s, d) => s + d.visions[0].targetScaleTonsPerQuarterAtQ32,
    0
  );
  // 【SAI-VISION-1・2026-08】BAL 34,000→60,000 / JPQ 30,000→50,000 /
  // CONSV 27,000→45,000 の正式採用により合計は 188,000 → 252,000 になる。
  // 【要注意・Stop Condition として #05 へ報告済み】252,000 は Q32 TRUE需要
  // 266,642t の **94.5%** であり、defaults.ts 冒頭の校正方針
  // （「5社が世界の対ベトナム需要を100%取り切る」水準は避ける）が想定していた
  // 55% 前後を大きく上回る。本 assert は依然として成立するが、
  // 余裕は 14,642t（5.5%）しか残っていない。
  assert.equal(total, 252_000);
  assert.ok(total < 266_642, "既定 Vision の合計が、5社が獲得対象にできる需要を超えている");
});

test("VISION-4: 参考成長軌道は waypoint 間を線形補間し、範囲外はクランプする", () => {
  const v = vision({
    referenceGrowthPath: [
      { turn: 1, scaleTonsPerQuarter: 10000 },
      { turn: 11, scaleTonsPerQuarter: 20000 },
    ],
  });
  assert.equal(referenceScaleAtTurn(v, 1, 0), 10000);
  assert.equal(referenceScaleAtTurn(v, 6, 0), 15000);
  assert.equal(referenceScaleAtTurn(v, 11, 0), 20000);
  assert.equal(referenceScaleAtTurn(v, 30, 0), 20000, "末尾を超えたら末尾値にクランプする");
  assert.equal(referenceScaleAtTurn(v, 0, 0), 10000, "先頭より前は先頭値にクランプする");
});

test("VISION-5: 履歴のうち、そのターン以前に有効化された最新の Vision を選ぶ（未来の Vision は使わない）", () => {
  const doc = {
    schemaVersion: COMPANY_VISION_SCHEMA_VERSION,
    companyId: "BAL",
    visions: [vision({ visionId: "v1", effectiveFromTurn: 1 }), vision({ visionId: "v2", effectiveFromTurn: 11 })],
  };
  assert.equal(resolveVisionAtTurn(doc, 10)?.visionId, "v1");
  assert.equal(resolveVisionAtTurn(doc, 11)?.visionId, "v2");
  assert.equal(resolveVisionAtTurn(doc, 32)?.visionId, "v2");
});

// ---------------------------------------------------------------------
// 2. Strategic Growth Layer
// ---------------------------------------------------------------------

test("GROWTH-1: 志より先行していれば gap は負になり、成長圧力は LOW になる", () => {
  const s = computeStrategicGrowthState({ vision: vision(), turn: 1, currentSustainableScaleTons: 17100 });
  assert.ok(s.strategicScaleGapTons < 0);
  assert.equal(s.growthPressure, "LOW");
  assert.equal(s.onTrack, true);
});

test("GROWTH-2: 同じ gap でも、成長意欲が低い会社は焦りが小さい", () => {
  const high = computeStrategicGrowthState({ vision: vision({ growthAmbition: "HIGH" }), turn: 16, currentSustainableScaleTons: 17000 });
  const low = computeStrategicGrowthState({ vision: vision({ growthAmbition: "LOW" }), turn: 16, currentSustainableScaleTons: 17000 });
  assert.equal(high.strategicScaleGapTons, low.strategicScaleGapTons, "gap そのものは Vision の目標が同じなら同じ");
  assert.ok(high.ambitionAdjustedGapRatio > low.ambitionAdjustedGapRatio);
  assert.ok(growthPressureAtLeast(high.growthPressure, low.growthPressure));
});

test("GROWTH-3: 参照規模が 0 でも 0 除算で無限大の焦りを作らない", () => {
  const s = computeStrategicGrowthState({
    vision: vision({ referenceGrowthPath: [{ turn: 1, scaleTonsPerQuarter: 0 }] }),
    turn: 5,
    currentSustainableScaleTons: 100,
  });
  assert.equal(s.strategicScaleGapRatio, 0);
  assert.equal(s.growthPressure, "LOW");
});

// ---------------------------------------------------------------------
// 3. 新工場の判断 —— 見送りの理由が必ず残る
// ---------------------------------------------------------------------

test("NEWFAC-1: Vision が無い会社では判断そのものを行わない", () => {
  const r = evaluateNewFactoryDecision({ ...passingInput(), vision: null, strategicGrowth: null });
  assert.equal(r.assessment.status, "NOT_CONSIDERED");
  assert.deepEqual([...r.assessment.reasonCodes], ["NEW_FACTORY_NOT_NEEDED"]);
  assert.equal(r.proposals.length, 0);
});

test("NEWFAC-2: 志の軌道に乗っていれば候補にすら上げない", () => {
  const v = vision();
  const r = evaluateNewFactoryDecision({
    ...passingInput(),
    strategicGrowth: computeStrategicGrowthState({ vision: v, turn: 2, currentSustainableScaleTons: 20000 }),
  });
  assert.equal(r.assessment.status, "NOT_CONSIDERED");
  assert.ok(r.assessment.reasonCodes.includes("VISION_ON_TRACK"));
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_NOT_NEEDED"));
});

test("NEWFAC-3: 工場建設に消極的な会社は、同じ遅れでも監視にとどまる", () => {
  const shy = vision({ willingnessToBuildFactories: "LOW", growthAmbition: "MEDIUM" });
  const growth = computeStrategicGrowthState({ vision: shy, turn: 20, currentSustainableScaleTons: 20_000 });
  assert.equal(growth.growthPressure, "HIGH");
  const r = evaluateNewFactoryDecision({ ...passingInput(), vision: shy, strategicGrowth: growth });
  assert.equal(r.assessment.status, "MONITORING");
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_MONITORING"));
  assert.equal(r.proposals.length, 0);
});

test("NEWFAC-4: 既存工場に増設余地があり、志との差も大きくなければ既存増設を優先する", () => {
  const v = vision();
  const r = evaluateNewFactoryDecision({
    ...passingInput(),
    observation: observation({ factorySpaceRemainingUnits: 16000 }),
    // gap 比率を overlapGapRatio(0.3) 未満に保つ
    strategicGrowth: computeStrategicGrowthState({ vision: v, turn: 20, currentSustainableScaleTons: 20_000 }),
  });
  assert.equal(r.assessment.status, "DEFERRED");
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_DEFERRED_EXISTING_SPACE"));
  assert.equal(r.proposals.length, 0);
});

test("NEWFAC-5: 志との差が十分に大きければ、既存増設余地があっても検討を併走させる", () => {
  const v = vision();
  const growth = computeStrategicGrowthState({ vision: v, turn: 32, currentSustainableScaleTons: 10_000 });
  assert.ok(growth.strategicScaleGapRatio > NEW_FACTORY_STRATEGY_PARAMETERS_V1.overlapGapRatio);
  const r = evaluateNewFactoryDecision({ ...passingInput(), observation: observation({ factorySpaceRemainingUnits: 16000 }), strategicGrowth: growth });
  assert.ok(!r.assessment.reasonCodes.includes("NEW_FACTORY_DEFERRED_EXISTING_SPACE"));
});

test("NEWFAC-6: 既存能力が遊んでいれば、志との差があっても建てない", () => {
  const r = evaluateNewFactoryDecision({
    ...passingInput(),
    observation: observation({ lastQuarterActualProductionByProduct: { hoso: 3000, pd: 2000, vap: 1000 } }),
  });
  assert.equal(r.assessment.status, "DEFERRED");
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_DEFERRED_MARKET"));
});

test("NEWFAC-7: 当期の需要の裏づけが足りなければ建てない", () => {
  const r = evaluateNewFactoryDecision({
    ...passingInput(),
    productionNeededByProductBeforeCap: { hoso: 3000, pd: 2000, vap: 1000 },
  });
  assert.equal(r.assessment.status, "DEFERRED");
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_DEFERRED_MARKET"));
});

test("NEWFAC-8: 前期の国内原料市場に売れ残りが無ければ、原料を理由に見送る", () => {
  const r = evaluateNewFactoryDecision({
    ...passingInput(),
    observation: observation({
      vietnamDomesticPriorMarket: { supply: 30000, effectiveDemand: 40000, transactedVolume: 30000, unsoldSupply: 0 },
    }),
  });
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_DEFERRED_RAW"));
});

test("NEWFAC-9: 前期の市場結果が観測できない場合、原料を理由に否定も肯定もしない", () => {
  const r = evaluateNewFactoryDecision({ ...passingInput(), observation: observation({ vietnamDomesticPriorMarket: undefined }) });
  assert.ok(!r.assessment.reasonCodes.includes("NEW_FACTORY_DEFERRED_RAW"));
  const rawGate = r.assessment.gates.find((g) => g.gate === "RAW_MATERIAL_SUPPORT");
  assert.equal(rawGate?.passed, true);
  assert.equal(rawGate?.keyValues.priorMarketObserved, 0, "観測できなかったことが記録に残る");
});

test("NEWFAC-10: 労働が逼迫していれば見送る", () => {
  const r = evaluateNewFactoryDecision({ ...passingInput(), pressures: pressures({ laborUtilizationLastQuarter: 1.4 }) });
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_DEFERRED_LABOR"));
});

test("NEWFAC-11: 「現金 > 投資額」だけでは通さない（財務リスク許容度で必要現金が変わる）", () => {
  // 投資額 22M を上回る 25M の現金を持っていても、最低現金バッファ＋余裕を満たさない。
  const cash = { cashUsd: 25_000_000 };
  const risky = evaluateNewFactoryDecision({ ...passingInput(), observation: observation(cash) });
  assert.ok(risky.assessment.reasonCodes.includes("NEW_FACTORY_DEFERRED_FINANCE"));
  const financeGate = risky.assessment.gates.find((g) => g.gate === "FINANCIAL_FEASIBILITY");
  assert.ok((financeGate?.keyValues.requiredCashUsd ?? 0) > risky.assessment.projectCostUsd);

  // 同じ現金でも、リスク許容度が低い会社の方が必要現金は大きい。
  const conservative = evaluateNewFactoryDecision({
    ...passingInput(),
    vision: vision({ financialRiskTolerance: "LOW" }),
    observation: observation(cash),
  });
  const conservativeGate = conservative.assessment.gates.find((g) => g.gate === "FINANCIAL_FEASIBILITY");
  assert.ok((conservativeGate?.keyValues.requiredCashUsd ?? 0) > (financeGate?.keyValues.requiredCashUsd ?? 0));
});

test("NEWFAC-12: 借入水準が余力を失っていれば、現金が足りていても見送る", () => {
  const r = evaluateNewFactoryDecision({ ...passingInput(), pressures: pressures({ borrowingPressure: 1 }) });
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_DEFERRED_FINANCE"));
});

test("NEWFAC-13: すでに新工場を建設中なら追加提案しない", () => {
  const r = evaluateNewFactoryDecision({
    ...passingInput(),
    observation: observation({ pendingNewFactoryProjectCount: 1, prospectiveFactoryCount: 2 }),
  });
  assert.equal(r.assessment.status, "APPROVED");
  assert.equal(r.proposals.length, 0);
});

test("NEWFAC-14: 工場数の上限に達していれば建てられない（factoryCount を決め打ちしない）", () => {
  const r = evaluateNewFactoryDecision({
    ...passingInput(),
    observation: observation({ factoryCount: 4, prospectiveFactoryCount: 4 }),
  });
  assert.equal(r.assessment.status, "DEFERRED");
  const limitGate = r.assessment.gates.find((g) => g.gate === "FACTORY_LIMIT");
  assert.equal(limitGate?.passed, false);
  assert.equal(limitGate?.keyValues.maxFactoriesPerCompany, 4);
});

test("NEWFAC-15: すべての条件を満たしたときだけ提案し、判断根拠が全ゲートぶん残る", () => {
  const r = evaluateNewFactoryDecision(passingInput());
  assert.equal(r.assessment.status, "READY_TO_BUILD");
  assert.deepEqual([...r.proposals], [{ projectType: "newFactoryConstruction" }]);
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_PROPOSED"));
  // 通ったゲートも残っている（「なぜ通ったか」も説明できる）。
  assert.ok(r.assessment.gates.every((g) => g.passed));
  assert.ok(r.assessment.gates.length >= 9, `ゲートの記録が少なすぎる: ${r.assessment.gates.length}`);
  // 単一の不透明なスコアではなく、ゲートごとに値と閾値が残っている。
  const utilization = r.assessment.gates.find((g) => g.gate === "EXISTING_CAPACITY_IN_USE");
  assert.ok(utilization?.keyValues.minimumUtilizationForNewFactory !== undefined);
  assert.ok(utilization?.keyValues.bindingEffectiveCapacityTons !== undefined);
});

test("NEWFAC-16: 稼働率の分母は「商品別ライン合計と共通前処理の小さい方」である", () => {
  // 共通前処理 25,650 を分母にすると 0.67 程度が上限になり、閾値へ到達しえない。
  const r = evaluateNewFactoryDecision(passingInput());
  const gate = r.assessment.gates.find((g) => g.gate === "EXISTING_CAPACITY_IN_USE");
  assert.equal(gate?.keyValues.bindingEffectiveCapacityTons, 6840 + 5985 + 4275);
});

// ---------------------------------------------------------------------
// 【Phase 6D】describeNewFactoryBlocker（表示専用 SSoT・logging semantic bug の修正）
// ---------------------------------------------------------------------

test("P6D-1: MONITORING は失敗ゲートが無くても「全ゲート通過」ではなく提案圧力未達と表示される", async () => {
  const { describeNewFactoryBlocker } = await import("../../standardAi/decision/newFactory");
  // MONITORING の実記録どおり: A/B/C の3ゲートすべて passed=true。
  const monitoring = {
    status: "MONITORING",
    gates: [
      { gate: "VISION_PRESENT", passed: true },
      { gate: "VISION_GROWTH_GAP", passed: true },
      { gate: "GROWTH_PRESSURE", passed: true },
    ],
  };
  assert.equal(describeNewFactoryBlocker(monitoring), "GROWTH_PRESSURE_BELOW_PROPOSAL");

  // 失敗ゲートがあるならそのゲート名（従来どおり）。
  const deferred = {
    status: "DEFERRED",
    gates: [
      { gate: "VISION_PRESENT", passed: true },
      { gate: "EXISTING_EXPANSION_FIRST", passed: false },
    ],
  };
  assert.equal(describeNewFactoryBlocker(deferred), "EXISTING_EXPANSION_FIRST");

  // READY_TO_BUILD は本当に全ゲート通過 → null（表示側が「全ゲート通過・提案」を出す）。
  const ready = { status: "READY_TO_BUILD", gates: [{ gate: "VISION_PRESENT", passed: true }] };
  assert.equal(describeNewFactoryBlocker(ready), null);
});
