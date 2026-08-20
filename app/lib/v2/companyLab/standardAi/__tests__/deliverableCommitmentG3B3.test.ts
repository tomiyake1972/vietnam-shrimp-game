// ShrimpX V2 — Phase SAI-GROW-3B-3 受入: Deliverable Commitment / Backlog Discipline
//
// 固定する構造:
//   Strategic Growth Opportunity ≠ Commercial Ambition ≠ Immediate Deliverable Commitment
//   志（Commercial Ambition）は変えず、今期の提出量だけを納品可能量で抑える。
//   capが効いたときは「成長機会が無い」ではなく、次に何へ投資すべきかをrouteする。

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDeliverableCommitment, DeliverableCommitmentInput } from "../decision/deliverableCommitment";
import { computeCommercialCommitment } from "../../vision/commercialCommitment";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { ProductAmount } from "../types";
import { advanceSimulationTurn, createSimulationSession } from "../../simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LEAD = SALES_PARAMETERS_V1.standardLeadTimeTurns;
const PRESENCE = STANDARD_AI_PARAMETERS_V1.minDomesticPurchaseRatioOfBase;

function amount(hoso = 0, pd = 0, vap = 0): ProductAmount {
  return { hoso, pd, vap };
}

function input(overrides: Partial<DeliverableCommitmentInput> = {}): DeliverableCommitmentInput {
  return {
    commitmentBeforeDeliverabilityTons: 20000,
    expectedConversionRatio: 0.8,
    finishedGoodsByProduct: amount(0, 0, 0),
    bindingProductionCapacityTons: 30000,
    nearTermBindingProductionCapacityTons: 30000,
    fundableRawMaterialTons: 60000,
    overdueBacklogByProduct: amount(0, 0, 0),
    healthyForwardBacklogByProduct: amount(0, 0, 0),
    rawMaterialLimitedByFunding: false,
    deliveryLeadTimeQuarters: LEAD,
    minimumMarketPresenceRatio: PRESENCE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------

test("G3B3-1: 能力十分・受注残小なら、旧Commitmentと同一（新しい抑制をしない）", () => {
  const r = computeDeliverableCommitment(input({ healthyForwardBacklogByProduct: amount(2000) }));
  assert.equal(r.applied, false);
  assert.equal(r.finalSubmissionTargetTons, 20000);
  assert.equal(r.incrementalSubmissionReductionTons, 0);
  assert.equal(r.bindingDeliverabilityConstraint, "NONE");
});

test("G3B3-2: 生産能力が足りなければ新規commitmentがcapされ、PRODUCTIONへrouteされる", () => {
  const r = computeDeliverableCommitment(
    input({ bindingProductionCapacityTons: 8000, nearTermBindingProductionCapacityTons: 8000 })
  );
  assert.equal(r.applied, true);
  assert.ok(r.finalSubmissionTargetTons < 20000);
  assert.equal(r.bindingDeliverabilityConstraint, "PRODUCTION");
});

test("G3B3-3: 原料が足りなければcapされ、RAW_MATERIALへrouteされる", () => {
  // 当期の納品能力は「資金手当て可能な原料」で頭打ちになる（§8）。
  const r = computeDeliverableCommitment(
    input({ fundableRawMaterialTons: 5000, bindingProductionCapacityTons: 30000, nearTermBindingProductionCapacityTons: 10000 })
  );
  assert.equal(r.deliverableCapacityCurrentTons, 5000, "当期納品能力は資金手当て可能原料で頭打ちになるべき");
  assert.equal(r.applied, true);
  assert.equal(r.excessBacklogTons, 0, "受注残が無いので原料が主因になるべき");
  assert.equal(r.bindingDeliverabilityConstraint, "RAW_MATERIAL");
});

test("G3B3-3b: 受注残が主因のときはBACKLOGが優先される", () => {
  const r = computeDeliverableCommitment(
    input({ fundableRawMaterialTons: 5000, healthyForwardBacklogByProduct: amount(45000), overdueBacklogByProduct: amount(10000) })
  );
  assert.equal(r.applied, true);
  assert.ok(r.excessBacklogTons > 0);
  assert.equal(r.bindingDeliverabilityConstraint, "BACKLOG");
});

test("G3B3-4: 原料不足の原因が資金ならLIQUIDITYへrouteされる", () => {
  const r = computeDeliverableCommitment(
    input({
      fundableRawMaterialTons: 3000,
      bindingProductionCapacityTons: 30000,
      nearTermBindingProductionCapacityTons: 10000,
      rawMaterialLimitedByFunding: true,
    })
  );
  assert.equal(r.applied, true);
  assert.equal(r.bindingDeliverabilityConstraint, "LIQUIDITY");
});

test("G3B3-5: 受注残が大きいほど納品余力が下がる（規模非依存＝自社能力比で判定）", () => {
  const small = computeDeliverableCommitment(input({ healthyForwardBacklogByProduct: amount(5000) }));
  const large = computeDeliverableCommitment(input({ healthyForwardBacklogByProduct: amount(60000) }));
  assert.ok(large.remainingDeliverableHeadroomTons < small.remainingDeliverableHeadroomTons);
  assert.ok(large.backlogDeliveryHorizonQuarters > small.backlogDeliveryHorizonQuarters);
  // 会社規模が10倍なら、同じ受注残の危険度は10分の1になる（固定閾値ではない）。
  const bigCompany = computeDeliverableCommitment(
    input({
      bindingProductionCapacityTons: 300000,
      nearTermBindingProductionCapacityTons: 300000,
      fundableRawMaterialTons: 600000,
      healthyForwardBacklogByProduct: amount(60000),
    })
  );
  assert.ok(bigCompany.backlogDeliveryHorizonQuarters < large.backlogDeliveryHorizonQuarters / 5);
  assert.equal(bigCompany.excessBacklogTons, 0, "大企業の同額受注残は正常水準内であるべき");
});

test("G3B3-6: Healthy Forward Backlogを即0submission扱いしない", () => {
  // リードタイム1四半期分ちょうどの将来納期backlog（＝正常な受注残）。
  const r = computeDeliverableCommitment(
    input({ healthyForwardBacklogByProduct: amount(30000 * LEAD), overdueBacklogByProduct: amount(0) })
  );
  assert.equal(r.overdueBacklogTons, 0);
  assert.equal(r.excessBacklogTons, 0, "正常水準の将来納期backlogをexcess扱いしてはいけない");
  assert.equal(r.applied, false, "健全な将来納期backlogだけで新規提出を抑えてはいけない");
});

test("G3B3-7: Overdueはhealthy forwardより強い抑制signalになる", () => {
  const backlogTons = 20000;
  const healthy = computeDeliverableCommitment(input({ healthyForwardBacklogByProduct: amount(backlogTons) }));
  const overdue = computeDeliverableCommitment(input({ overdueBacklogByProduct: amount(backlogTons) }));
  assert.equal(healthy.existingBacklogTons, overdue.existingBacklogTons, "同じ受注残総量で比較する");
  assert.ok(
    overdue.remainingDeliverableHeadroomTons < healthy.remainingDeliverableHeadroomTons,
    "同量でもoverdueの方が新規受注余力を強く減らすべき"
  );
  assert.ok(overdue.excessBacklogTons > healthy.excessBacklogTons);
});

test("G3B3-8: 過剰受注でも新規提出が0にならない（市場から退出しない）", () => {
  const r = computeDeliverableCommitment(
    input({ overdueBacklogByProduct: amount(500000), healthyForwardBacklogByProduct: amount(500000) })
  );
  assert.ok(r.finalSubmissionTargetTons > 0, "納品能力が正なら新規提出を0にしてはいけない");
  assert.ok(r.remainingDeliverableHeadroomTons >= 30000 * PRESENCE - 1e-6);
});

test("G3B3-9: conversionを二重に掛けない（cap は成約量 ÷ 期待転換率）", () => {
  const conversion = 0.5;
  const r = computeDeliverableCommitment(
    input({ expectedConversionRatio: conversion, bindingProductionCapacityTons: 10000, nearTermBindingProductionCapacityTons: 10000 })
  );
  assert.ok(Math.abs(r.deliverabilityCapTons - r.remainingDeliverableHeadroomTons / conversion) < 1e-6);
});

test("G3B3-10: Commercial Ambitionは一切変更されない（capは提出量にだけ効く）", () => {
  const commitment = computeCommercialCommitment({
    ambition: { ambitionTons: 20000 } as never,
    capacityAnchorTons: 20000,
    attainableProfitableTons: 100000,
    observedConversionRatio: 0.8,
    observedQuarters: 4,
    salesCapacityTons: null,
    backlogTons: 0,
    finishedGoodsTons: 0,
  });
  const capped = computeDeliverableCommitment(
    input({
      commitmentBeforeDeliverabilityTons: commitment.submissionTargetTons,
      expectedConversionRatio: commitment.expectedConversionRatio,
      bindingProductionCapacityTons: 5000,
      nearTermBindingProductionCapacityTons: 5000,
    })
  );
  assert.equal(capped.applied, true);
  // capはこのモジュールの戻り値であり、ambition（caps.ambitionTons）は不変。
  assert.equal(commitment.caps.ambitionTons, 20000);
  assert.ok(capped.finalSubmissionTargetTons < commitment.submissionTargetTons);
});

test("G3B3-11: 決定論（同一入力なら常に同一出力）", () => {
  const a = computeDeliverableCommitment(input({ overdueBacklogByProduct: amount(12345) }));
  const b = computeDeliverableCommitment(input({ overdueBacklogByProduct: amount(12345) }));
  assert.deepEqual(b, a);
});

test("G3B3-12: 会社IDのhardcodeが無い", () => {
  const src = readFileSync(join(__dirname, "../decision/deliverableCommitment.ts"), "utf8");
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    assert.equal(src.includes(`"${companyId}"`), false, `会社ID ${companyId} をhardcodeしてはいけない`);
  }
});

test("G3B3-13: 商品別能力を尊重する（物理ton合計だけで納品可能量を判定しない）", () => {
  // 納品可能量の基礎は binding production capacity（商品別ライン合計と共通前処理のmin）
  // であり、呼び出し側が商品別能力から算出した値をそのまま使う。
  // VAP偏重の会社（VAPライン能力が小さい）でも、その値が下がればcapが効く。
  const vapHeavy = computeDeliverableCommitment(
    input({ bindingProductionCapacityTons: 6000, nearTermBindingProductionCapacityTons: 6000 })
  );
  const balanced = computeDeliverableCommitment(input());
  assert.ok(vapHeavy.deliverableCapacityNearTermTons < balanced.deliverableCapacityNearTermTons);
  assert.ok(vapHeavy.finalSubmissionTargetTons < balanced.finalSubmissionTargetTons);
});

// ---------------------------------------------------------------------
// 統合受入（実シナリオ。値の捏造をしない）
// ---------------------------------------------------------------------

test("G3B3-14: 確定CAPEXの完成はnear-term capacityへ入り、未承認・Visionだけでは入らない", () => {
  // observation.nearTermEffectiveCapacityByProduct は capex/factoryConstruction.ts の
  // computeEffectiveFactories を納期の四半期で呼んだ結果である（ramp・完成判定は既存関数）。
  // 未承認案件は capexState.portfolio に存在しないため構造的に入らない——これを実runで確認する。
  const AT = "2026-01-01T00:00:00.000Z";
  let session = createSimulationSession({
    simulationRunId: "g3b3-nearterm",
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: AT,
  });
  let sawNearTermAboveCurrent = false;
  let anyNearTermBelowZero = false;
  for (let i = 0; i < 24; i++) {
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
      const dc = result.diagnostics?.deliverableCommitment;
      if (!dc) continue;
      if (dc.deliverableCapacityNearTermTons < 0) anyNearTermBelowZero = true;
      // 承認済み案件が納期までに完成する会社では、納期時点の能力が当期の生産能力を上回る。
      if (dc.deliverableCapacityNearTermTons > dc.deliverableCapacityCurrentTons + 1) sawNearTermAboveCurrent = true;
    }
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced);
    session = outcome.session;
  }
  assert.equal(anyNearTermBelowZero, false);
  assert.ok(sawNearTermAboveCurrent, "承認済みCAPEXの完成が納期時点の能力へ反映されていない");
});

test("G3B3-15: Crisis GateとDeliverability capを二重適用しない（危機時はCrisis優先）", () => {
  const AT = "2026-01-01T00:00:00.000Z";
  let session = createSimulationSession({
    simulationRunId: "g3b3-crisis",
    scenarioId: "dynamic-scenario-1",
    seed: "ds1-benchmark",
    requestedTurns: 32,
    startedAt: AT,
  });
  let checked = 0;
  for (let i = 0; i < 20; i++) {
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
    const crisisState = result.diagnostics?.crisis?.state;
    const limiter = result.diagnostics?.commercialCommitment?.limiter;
    if (crisisState && crisisState !== "NORMAL") {
      checked += 1;
      assert.notEqual(limiter, "DELIVERABILITY", "危機時にDeliverability capを重ねてはいけない（Crisis Gate優先）");
    }
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced);
    session = outcome.session;
  }
  assert.ok(checked > 0, "この受入の前提（危機に入る四半期が存在する）が崩れている");
});

test("G3B3-16: 健全な成長会社（baseline BAL）でCommercial Ambitionが縮まない", () => {
  const AT = "2026-01-01T00:00:00.000Z";
  let session = createSimulationSession({
    simulationRunId: "g3b3-ambition",
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: AT,
  });
  const ambitions: number[] = [];
  for (let i = 0; i < 16; i++) {
    const fixture = session.fixtures.find((f: { companyId: string }) => f.companyId === "BAL")!;
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
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced);
    session = outcome.session;
  }
  assert.ok(ambitions[ambitions.length - 1] >= ambitions[0] * 0.95, `志が縮んでいる（${ambitions[0]} → ${ambitions[ambitions.length - 1]}）`);
});
