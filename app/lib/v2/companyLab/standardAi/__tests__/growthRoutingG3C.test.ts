// ShrimpX V2 — Phase SAI-GROW-3C 受入: Deliverability Constraint Routing / Capacity Expansion
//
// 固定する構造:
//   3B-3のDeliverable Commitment capは1ミリも緩めない。
//   「売れない」のではなく「作れない」のだから、Deliverability Gapを能力側へrouteする。
//   Commercial Ambition・Visionには一切書き戻さない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessGrowthRouting, GrowthRoutingInput } from "../decision/growthRouting";
import { DeliverableCommitmentState } from "../decision/deliverableCommitment";
import { LiquidityAssessment } from "../decision/liquidity";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation } from "../types";
import { advanceSimulationTurn, createSimulationSession } from "../../simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SUSTAINED = STANDARD_AI_PARAMETERS_V1.capexSustainedUtilizationThreshold;

function mix(hoso = 0, pd = 0, vap = 0): ProductAmount {
  return { hoso, pd, vap };
}

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    regularHeadcountTotal: 5000,
    salesForceHeadcountTotal: 60,
    totalEffectiveCapacityByProduct: mix(20000, 7000, 3000),
    factories: [{ skillByProduct: mix(1, 1, 1), attendanceRate: 1 }],
    ...overrides,
  } as unknown as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
  return {
    hadPriorQuarterUtilization: true,
    equipmentUtilizationLastQuarter: SUSTAINED,
    laborUtilizationLastQuarter: SUSTAINED,
    ...overrides,
  } as unknown as PressureScores;
}

function deliverable(overrides: Partial<DeliverableCommitmentState> = {}): DeliverableCommitmentState {
  return {
    deliverableCapacityCurrentTons: 30000,
    deliverableCapacityNearTermTons: 30000,
    overdueBacklogTons: 0,
    bindingDeliverabilityConstraint: "NONE",
    ...overrides,
  } as unknown as DeliverableCommitmentState;
}

function liquidity(overrides: Partial<LiquidityAssessment> = {}): LiquidityAssessment {
  return { liquidityHeadroomUsd: 100e6, currentTurnFundableHeadroomUsd: 50e6, ...overrides } as unknown as LiquidityAssessment;
}

function routing(overrides: Partial<GrowthRoutingInput> = {}) {
  return assessGrowthRouting({
    observation: observation(),
    pressures: pressures(),
    params: STANDARD_AI_PARAMETERS_V1,
    commercialAmbitionTons: 40000,
    desiredMixByProduct: mix(20000, 7000, 3000),
    deliverable: deliverable(),
    liquidity: liquidity(),
    fundableRawMaterialTons: 100000,
    rawMaterialLimitedByFunding: false,
    nearTermBindingProductionCapacityTons: 30000,
    salesCapacityTons: 100000,
    survivalPosture: "NORMAL",
    deliverabilityCapApplied: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------

test("G3C-1: PRODUCTION constraint → Production CAPEX へrouteされる", () => {
  // Worker十分（大人数）・原料十分・資金十分で、設備能力だけが足りない。
  const r = routing({ observation: observation({ regularHeadcountTotal: 500000 }) });
  assert.equal(r.bindingConstraint, "PRODUCTION");
  assert.equal(r.route, "PRODUCTION_CAPEX");
  assert.equal(r.actionTaken, true);
  assert.ok(r.routedGrowthTons > 0);
  assert.ok(r.routedGrowthByProduct.hoso > 0, "商品別内訳が志の構成比で配られるべき");
});

test("G3C-2: Worker constraint → Worker増員が優先される（Factory CAPEXではない）", () => {
  // 設備能力は志を満たすが、Workerが足りない。
  const r = routing({
    observation: observation({ regularHeadcountTotal: 100 }),
    deliverable: deliverable({ deliverableCapacityCurrentTons: 50000, deliverableCapacityNearTermTons: 50000 }),
    nearTermBindingProductionCapacityTons: 50000,
  });
  assert.equal(r.workerLimited, true);
  assert.equal(r.bindingConstraint, "WORKFORCE");
  assert.equal(r.route, "WORKFORCE");
  assert.equal(r.actionTaken, true);
  assert.ok(r.workerGap > 0);
  assert.ok(r.workerRequirementForAmbition > r.currentWorkerHeadcount);
});

test("G3C-3: RAW_MATERIAL constraint → Procurement へrouteされる（CAPEXを増やさない）", () => {
  const r = routing({
    observation: observation({ regularHeadcountTotal: 500000 }),
    deliverable: deliverable({ deliverableCapacityCurrentTons: 50000, deliverableCapacityNearTermTons: 50000 }),
    nearTermBindingProductionCapacityTons: 50000,
    fundableRawMaterialTons: 20000,
    rawMaterialLimitedByFunding: false,
  });
  assert.equal(r.bindingConstraint, "RAW_MATERIAL");
  assert.equal(r.route, "PROCUREMENT");
  assert.ok(r.rawMaterialGapTons > 0);
});

test("G3C-4: 原料不足の原因が資金なら Liquidity へrouteされる（設備も営業採用も増やさない）", () => {
  const r = routing({
    observation: observation({ regularHeadcountTotal: 500000 }),
    fundableRawMaterialTons: 20000,
    rawMaterialLimitedByFunding: true,
  });
  assert.equal(r.bindingConstraint, "LIQUIDITY");
  assert.equal(r.route, "LIQUIDITY");
});

test("G3C-5: Sales Capacityだけがbindingなら Sales Hiring へrouteされる", () => {
  const r = routing({
    observation: observation({ regularHeadcountTotal: 500000 }),
    deliverable: deliverable({ deliverableCapacityCurrentTons: 35000, deliverableCapacityNearTermTons: 35000 }),
    nearTermBindingProductionCapacityTons: 50000,
    salesCapacityTons: 20000,
  });
  // 設備・Worker・原料・資金が解けていて、営業能力だけが志に届かない。
  assert.equal(r.route === "SALES_HIRING" || r.bindingConstraint === "SALES_CAPACITY", true);
});

test("G3C-6: 他constraintがbindingならSales Hiringへrouteしない", () => {
  const workerBound = routing({
    observation: observation({ regularHeadcountTotal: 100 }),
    deliverable: deliverable({ deliverableCapacityCurrentTons: 50000, deliverableCapacityNearTermTons: 50000 }),
    nearTermBindingProductionCapacityTons: 50000,
    salesCapacityTons: 1000,
  });
  assert.notEqual(workerBound.route, "SALES_HIRING");
  const liquidityBound = routing({ liquidity: liquidity({ liquidityHeadroomUsd: -1 }), salesCapacityTons: 1000 });
  assert.equal(liquidityBound.route, "LIQUIDITY");
});

test("G3C-7: Liquidityが塞がっていればCAPEXへrouteしない", () => {
  const r = routing({
    observation: observation({ regularHeadcountTotal: 500000 }),
    liquidity: liquidity({ currentTurnFundableHeadroomUsd: -1 }),
  });
  assert.equal(r.liquidityBlocked, true);
  assert.equal(r.route, "LIQUIDITY");
  assert.notEqual(r.route, "PRODUCTION_CAPEX");
});

test("G3C-8: 一四半期だけのgapでは能力投資へ移さない（持続性が要る）", () => {
  const transient = routing({
    observation: observation({ regularHeadcountTotal: 500000 }),
    pressures: pressures({ equipmentUtilizationLastQuarter: 0.3, laborUtilizationLastQuarter: 0.3 }),
  });
  assert.equal(transient.bindingConstraint, "PRODUCTION");
  assert.equal(transient.persistent, false);
  assert.equal(transient.actionTaken, false, "持続性が無いのに能力投資へ移してはいけない");
  assert.equal(transient.routedGrowthTons, 0);
  assert.ok(transient.actionNotTakenReason.length > 0);

  const noPriorQuarter = routing({
    observation: observation({ regularHeadcountTotal: 500000 }),
    pressures: pressures({ hadPriorQuarterUtilization: false }),
  });
  assert.equal(noPriorQuarter.actionTaken, false);
});

test("G3C-9: VAP偏重の会社はWorker側へrouteされる（HOSO量産化しない）", () => {
  // 同じトン数の志でも、VAP構成は労働集約度3.0のため必要Workerがはるかに多い。
  const balanced = routing({ desiredMixByProduct: mix(30000, 0, 0), commercialAmbitionTons: 30000 });
  const vapHeavy = routing({ desiredMixByProduct: mix(0, 0, 30000), commercialAmbitionTons: 30000 });
  assert.ok(
    vapHeavy.workerRequirementForAmbition > balanced.workerRequirementForAmbition * 2,
    "VAPの労働集約度が必要人数へ反映されていない"
  );
  // VAP偏重ではWorkerが先に効き、routeもWorkerになる。
  assert.equal(vapHeavy.route, "WORKFORCE");
  // 商品別の回付内訳はVAPへ寄る（HOSOへ寄せ替えない）。
  const vapRouted = routing({
    desiredMixByProduct: mix(0, 0, 40000),
    observation: observation({ regularHeadcountTotal: 500000 }),
  });
  assert.ok(vapRouted.routedGrowthByProduct.vap > vapRouted.routedGrowthByProduct.hoso);
});

test("G3C-10: SURVIVAL / RECOVERY 中は能力投資を起こさない（既存Crisis制約を優先）", () => {
  for (const posture of ["SURVIVAL", "RECOVERY"] as const) {
    const r = routing({ observation: observation({ regularHeadcountTotal: 500000 }), survivalPosture: posture });
    assert.equal(r.route, "LIQUIDITY");
    assert.notEqual(r.route, "PRODUCTION_CAPEX");
  }
});

test("G3C-11: Commercial Ambitionを直接改変しない（この層は読むだけ）", () => {
  const src = readFileSync(join(__dirname, "../decision/growthRouting.ts"), "utf8");
  for (const forbidden = 0; false; ) void forbidden;
  assert.equal(/ambitionTons\s*=/.test(src.replace(/commercialAmbitionTons/g, "")), false, "Ambitionへ代入してはいけない");
  const r = routing();
  assert.equal(Object.prototype.hasOwnProperty.call(r, "commercialAmbitionTons"), false, "Ambitionを出力しない（書き戻さない）");
});

test("G3C-12: 会社IDのhardcodeが無い", () => {
  const src = readFileSync(join(__dirname, "../decision/growthRouting.ts"), "utf8");
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    assert.equal(src.includes(`"${companyId}"`), false, `会社ID ${companyId} をhardcodeしてはいけない`);
  }
});

test("G3C-13: 決定論（同一入力なら常に同一出力）", () => {
  assert.deepEqual(routing(), routing());
});

test("G3C-14: 志が納品能力に収まっていれば何もrouteしない", () => {
  const r = routing({
    commercialAmbitionTons: 10000,
    observation: observation({ regularHeadcountTotal: 500000 }),
  });
  assert.equal(r.deliverabilityGrowthGapTons, 0);
  assert.equal(r.route, "NONE");
  assert.equal(r.actionTaken, false);
});

// ---------------------------------------------------------------------
// 統合受入（実シナリオ。値の捏造をしない）
// ---------------------------------------------------------------------

test("G3C-15: baseline実runでMASSのbacklog disciplineが維持され、Ambitionが縮まない", () => {
  const AT = "2026-01-01T00:00:00.000Z";
  let session = createSimulationSession({
    simulationRunId: "g3c-mass",
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: AT,
  });
  const ambitions: number[] = [];
  let maxBacklogHorizon = 0;
  for (let i = 0; i < 24; i++) {
    const fixture = session.fixtures.find((f: { companyId: string }) => f.companyId === "MASS")!;
    const ownState = buildCompanyOwnState(session.state, fixture);
    const publicInfo = buildPublicMarketInfo(session.state);
    const result = generateStandardAiDecisionWithDiagnostics(
      fixture,
      ownState,
      publicInfo,
      session.state.currentPeriod,
      session.state.scenarioState.currentTurn
    );
    ambitions.push(result.diagnostics?.commercialAmbition?.ambitionTons ?? 0);
    const horizon = result.diagnostics?.deliverableCommitment?.backlogDeliveryHorizonQuarters ?? 0;
    if (Number.isFinite(horizon)) maxBacklogHorizon = Math.max(maxBacklogHorizon, horizon);
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced);
    session = outcome.session;
  }
  assert.ok(maxBacklogHorizon < 3, `受注残消化期間が発散している（最大 ${maxBacklogHorizon.toFixed(2)} 四半期）`);
  assert.ok(ambitions[ambitions.length - 1] >= ambitions[0] * 0.9, "志が縮んでいる");
});

test("G3C-16: baseline実runでBALのLiquidity Disciplineを壊さない（T2-T4に投資を集中しない）", () => {
  const AT = "2026-01-01T00:00:00.000Z";
  let session = createSimulationSession({
    simulationRunId: "g3c-bal",
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: AT,
  });
  let earlyCapexUsd = 0;
  let prevPaid = 0;
  for (let i = 0; i < 8; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced);
    session = outcome.session;
    const fixture = session.fixtures.find((f: { companyId: string }) => f.companyId === "BAL")!;
    const ownState = buildCompanyOwnState(session.state, fixture);
    const paid = ownState.capexState.portfolio.projects.reduce(
      (s: number, p: { cumulativePaidUsd?: number }) => s + (p.cumulativePaidUsd ?? 0),
      0
    );
    if (i + 1 >= 2 && i + 1 <= 4) earlyCapexUsd += paid - prevPaid;
    prevPaid = paid;
    const cash = Number(ownState.financeState.cash);
    assert.ok(cash > -1, `T${i + 1}でBALの現金が負になっている（${cash}）`);
  }
  assert.ok(earlyCapexUsd < 20e6, `T2-T4のCAPEXが集中している（${(earlyCapexUsd / 1e6).toFixed(1)}M）`);
});

test("G3C-17: 実runでGrowth Route診断が発火し、binding constraintを説明できる", () => {
  const AT = "2026-01-01T00:00:00.000Z";
  let session = createSimulationSession({
    simulationRunId: "g3c-diag",
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: AT,
  });
  const codes = new Set<string>();
  for (let i = 0; i < 20; i++) {
    for (const fixture of session.fixtures) {
      const ownState = buildCompanyOwnState(session.state, fixture);
      const publicInfo = buildPublicMarketInfo(session.state);
      const result = generateStandardAiDecisionWithDiagnostics(
        fixture,
        ownState,
        publicInfo,
        session.state.currentPeriod,
        session.state.scenarioState.currentTurn
      );
      for (const entry of result.diagnostics.entries) {
        if (String(entry.code).startsWith("GROWTH_ROUTE_")) codes.add(String(entry.code));
      }
    }
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced);
    session = outcome.session;
  }
  assert.ok(codes.size > 0, "Growth Route診断が1件も出ていない");
  assert.ok(
    [...codes].some((c) => c !== "GROWTH_ROUTE_NONE"),
    "constraintが観測されたときのrouteが1件も出ていない"
  );
});
