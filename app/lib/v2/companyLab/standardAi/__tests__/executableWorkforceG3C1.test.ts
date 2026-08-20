// ShrimpX V2 — Phase SAI-GROW-3C.1 受入: Executable Workforce Growth / Routing Side-effect Fix
//
// GROW-3CのWORKFORCE route自体は正しいが、labor.tsへ渡すWorker floorが
// workerRequirementForAmbition（＝Commercial Ambition全量）だったため、
// Ambition > 近い将来の実行可能規模 の局面でWorkerを先行保有しすぎていた。
// Worker採用の目標だけを「Worker以外の制約の下で実行可能な規模」へboundする。
// Commercial Ambition そのものは変更しない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessGrowthRouting, GrowthRoutingInput } from "../decision/growthRouting";
import { DeliverableCommitmentState } from "../decision/deliverableCommitment";
import { LiquidityAssessment } from "../decision/liquidity";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation } from "../types";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SUSTAINED = STANDARD_AI_PARAMETERS_V1.capexSustainedUtilizationThreshold;
const AMBITION = 40000;

function mix(hoso = 0, pd = 0, vap = 0): ProductAmount {
  return { hoso, pd, vap };
}

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    regularHeadcountTotal: 100,
    salesForceHeadcountTotal: 60,
    totalEffectiveCapacityByProduct: mix(20000, 7000, 3000),
    factories: [{ skillByProduct: mix(1, 1, 1), attendanceRate: 1 }],
    ...overrides,
  } as unknown as StandardAiObservation;
}

const PRESSURES: PressureScores = {
  hadPriorQuarterUtilization: true,
  equipmentUtilizationLastQuarter: SUSTAINED,
  laborUtilizationLastQuarter: SUSTAINED,
} as unknown as PressureScores;

function deliverable(overrides: Partial<DeliverableCommitmentState> = {}): DeliverableCommitmentState {
  return {
    deliverableCapacityCurrentTons: 50000,
    deliverableCapacityNearTermTons: 50000,
    overdueBacklogTons: 0,
    bindingDeliverabilityConstraint: "NONE",
    ...overrides,
  } as unknown as DeliverableCommitmentState;
}

function liquidity(overrides: Partial<LiquidityAssessment> = {}): LiquidityAssessment {
  return { liquidityHeadroomUsd: 100e6, currentTurnFundableHeadroomUsd: 50e6, ...overrides } as unknown as LiquidityAssessment;
}

/** 既定は「Worker以外はすべて志を支えている」＝WORKFORCEがbindingな状態。 */
function routing(overrides: Partial<GrowthRoutingInput> = {}) {
  return assessGrowthRouting({
    observation: observation(),
    pressures: PRESSURES,
    params: STANDARD_AI_PARAMETERS_V1,
    commercialAmbitionTons: AMBITION,
    desiredMixByProduct: mix(20000, 7000, 3000),
    deliverable: deliverable(),
    liquidity: liquidity(),
    fundableRawMaterialTons: 100000,
    rawMaterialLimitedByFunding: false,
    nearTermBindingProductionCapacityTons: 50000,
    salesCapacityTons: 100000,
    currentPeriodProductionRequirementTons: AMBITION,
    recentActualScaleTons: AMBITION,
    survivalPosture: "NORMAL",
    deliverabilityCapApplied: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------

test("G3C1-1: Ambitionが大きくても他constraintが小さければ、Ambition全量分のWorkerを採用しない", () => {
  // 商業的に実行可能なのは10,000tだけ（backlogも新規成約見込みも小さい）。
  const bounded = routing({ currentPeriodProductionRequirementTons: 10000, recentActualScaleTons: 8000 });
  const unbounded = routing();
  assert.equal(bounded.route, "WORKFORCE");
  assert.equal(bounded.workerExpansionTargetTons, 10000, "実行可能規模までにboundされるべき");
  assert.ok(
    bounded.workerRequirementForExecutableTarget < unbounded.workerRequirementForAmbition,
    "志全量分の人数を要求してはいけない"
  );
  // 志ベースの値は診断として残る（Ambition自体は変えない）。
  assert.equal(bounded.workerRequirementForAmbition, unbounded.workerRequirementForAmbition);
});

test("G3C1-2: WorkerのみbindingならWorkerは増員する（routeを実質無効化しない）", () => {
  const r = routing();
  assert.equal(r.route, "WORKFORCE");
  assert.equal(r.actionTaken, true);
  assert.equal(r.workerExpansionTargetTons, AMBITION, "他制約が志を支えているなら志まで採用してよい");
  assert.ok(r.workerGapForExecutableTarget > 0);
  assert.equal(r.workerRequirementForExecutableTarget, r.workerRequirementForAmbition);
});

test("G3C1-3: Production capacityがbindingならWorkerを過剰採用しない", () => {
  const r = routing({ nearTermBindingProductionCapacityTons: 12000 });
  assert.ok(r.workerExpansionTargetTons <= 12000 + 1e-6);
  assert.ok(r.workerRequirementForExecutableTarget < r.workerRequirementForAmbition);
});

test("G3C1-4: Raw materialがbindingならWorkerを過剰採用しない", () => {
  const r = routing({ fundableRawMaterialTons: 9000 });
  assert.ok(r.workerExpansionTargetTons <= 9000 + 1e-6);
  assert.ok(r.workerRequirementForExecutableTarget < r.workerRequirementForAmbition);
});

test("G3C1-5: LiquidityがbindingならWorker増員へrouteしない", () => {
  const r = routing({ liquidity: liquidity({ currentTurnFundableHeadroomUsd: -1 }) });
  assert.equal(r.route, "LIQUIDITY");
  assert.notEqual(r.route, "WORKFORCE");
});

test("G3C1-6: 商業的に実行可能な需要がAmbitionを下回るなら、その実行可能量までにboundされる", () => {
  const r = routing({ currentPeriodProductionRequirementTons: 15000, recentActualScaleTons: 12000 });
  assert.equal(r.workerExpansionTargetTons, 15000);
  // 直近実績を下回らない（需要の谷で人員目標が落ち込まない）。
  const trough = routing({ currentPeriodProductionRequirementTons: 3000, recentActualScaleTons: 12000 });
  assert.equal(trough.workerExpansionTargetTons, 12000, "直近実績が下限として効くべき");
});

test("G3C1-7: 現在Worker能力をboundへ入れない（Worker不足なのに増やせない循環を作らない）", () => {
  // 現有Workerが極端に少なくても、実行可能規模はWorker以外の制約だけで決まる。
  const few = routing({ observation: observation({ regularHeadcountTotal: 1 }) });
  const many = routing({ observation: observation({ regularHeadcountTotal: 100000 }) });
  assert.equal(few.workerExpansionTargetTons, many.workerExpansionTargetTons, "現在Worker数がexecutable targetを動かしてはいけない");
  assert.ok(few.workerGapForExecutableTarget > many.workerGapForExecutableTarget);
});

test("G3C1-8: VAP偏重mixはHOSOより多くのWorkerを必要とする既存特性を維持する", () => {
  const hoso = routing({ desiredMixByProduct: mix(30000, 0, 0), commercialAmbitionTons: 30000, currentPeriodProductionRequirementTons: 30000, recentActualScaleTons: 30000 });
  const vap = routing({ desiredMixByProduct: mix(0, 0, 30000), commercialAmbitionTons: 30000, currentPeriodProductionRequirementTons: 30000, recentActualScaleTons: 30000 });
  assert.equal(hoso.workerExpansionTargetTons, vap.workerExpansionTargetTons, "実行可能規模自体は同じ");
  assert.ok(
    vap.workerRequirementForExecutableTarget > hoso.workerRequirementForExecutableTarget * 2,
    "VAPの労働集約度3.0が実行可能規模ベースの必要人数にも効くべき"
  );
});

test("G3C1-9: Commercial Ambitionそのものは変更しない（この層は読むだけ）", () => {
  const r = routing({ currentPeriodProductionRequirementTons: 5000, recentActualScaleTons: 5000 });
  // Ambitionベースの値は不変のまま診断に残る。
  assert.equal(r.workerRequirementForAmbition, routing().workerRequirementForAmbition);
  assert.ok(r.workerExpansionTargetTons < AMBITION);
  const src = readFileSync(join(__dirname, "../decision/growthRouting.ts"), "utf8");
  assert.equal(
    /commercialAmbitionTons\s*=[^=]/.test(src.replace(/readonly commercialAmbitionTons/g, "")),
    false,
    "commercialAmbitionTonsへ代入してはいけない"
  );
});

test("G3C1-10: 会社IDのhardcodeが無い", () => {
  const src = readFileSync(join(__dirname, "../decision/growthRouting.ts"), "utf8");
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    assert.equal(src.includes(`"${companyId}"`), false, `会社ID ${companyId} をhardcodeしてはいけない`);
  }
});

test("G3C1-11: 決定論（同一入力なら常に同一出力）", () => {
  assert.deepEqual(routing({ currentPeriodProductionRequirementTons: 12345 }), routing({ currentPeriodProductionRequirementTons: 12345 }));
});

test("G3C1-12: labor.tsへ渡すfloorは実行可能規模ベースの人数である（志ベースではない）", () => {
  const src = readFileSync(join(__dirname, "../policy.ts"), "utf8");
  assert.ok(
    src.includes("growthRouting.workerRequirementForExecutableTarget"),
    "labor.tsへ workerRequirementForExecutableTarget を渡していない"
  );
  assert.equal(
    src.includes("buildStandardAiWorkerAssignments(\n      fixture,\n      observation,\n      pressures,\n      productionResult.productionPlans,\n      params,\n      growthRouting.workerRequirementForAmbition"),
    false,
    "志ベースの人数をlabor floorへ渡してはいけない"
  );
});
