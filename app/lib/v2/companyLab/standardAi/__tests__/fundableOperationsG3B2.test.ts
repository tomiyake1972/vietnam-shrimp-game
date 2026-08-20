// ShrimpX V2 — Phase SAI-GROW-3B-2 受入: Fundable Operations / Survival & Recovery
//
// 固定する構造:
//   NORMAL + 資金十分 … 現行挙動と完全に同一（新しいcapを掛けない）
//   危機              … 資金手当てできる原料量まで生産を縮退 → 調達・労務が追従
//   深刻かつ持続      … 営業組織も段階縮小できる（一時的Stressでは縮小しない）
//   資金回復          … RECOVERYへ移り、規模は再拡大できるが成長投資は再開しない
//   借りられない会社  … 借入を捏造せず、縮小で生き残る

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessFundableOperations, growthPausedForRecovery } from "../decision/fundableOperations";
import { buildStandardAiProductionPlans } from "../decision/production";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation } from "../types";
import { CompanyFixture } from "../../types";
import { StandardAiCrisisState } from "../crisisState";
import { FinancialRiskTolerance } from "../../vision/types";
import { advanceSimulationTurn, createSimulationSession } from "../../simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MILLION = 1_000_000;
const PRICE = 2.5; // USD/kg（前期国内参照価格）

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    cashUsd: 100 * MILLION,
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 5000,
    salesForceHeadcountTotal: 60,
    procurementHeadcountTotal: 10,
    receivablesDueThisPeriodUsd: 20 * MILLION,
    receivablesNotYetDueUsd: 0,
    payablesDueThisPeriodUsd: 5 * MILLION,
    payablesNotYetDueUsd: 0,
    existingLoanInterestUsdThisQuarterEstimate: 0,
    existingLoanScheduledPrincipalDueUsdThisQuarterEstimate: 0,
    lastQuarterFinancialHealthTier: "healthy",
    lastQuarterUnderwritingFrozen: false,
    lastQuarterProcurementScaleRatio: 1,
    lastQuarterImportOrdersBlocked: false,
    lastQuarterActualProductionByProduct: { hoso: 10000, pd: 3000, vap: 1000 },
    committedCapexPaymentScheduleUsd: [0, 0, 0, 0],
    vietnamDomesticPriorPrice: PRICE,
    ...overrides,
  } as unknown as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
  return {
    targetMinimumCashUsd: 10 * MILLION,
    borrowingPressure: 0,
    cashPressure: 0,
    rawMaterialInventoryPosition: 0,
    ...overrides,
  } as unknown as PressureScores;
}

function assess(
  obs: Partial<StandardAiObservation>,
  crisisState: StandardAiCrisisState,
  productionRequirementTons: number,
  pres: Partial<PressureScores> = {},
  riskTolerance: FinancialRiskTolerance | null = "MEDIUM"
) {
  return assessFundableOperations({
    observation: observation(obs),
    pressures: pressures(pres),
    params: STANDARD_AI_PARAMETERS_V1,
    crisisState,
    financialRiskTolerance: riskTolerance,
    productionRequirementTons,
  });
}

/** 「危機に入って、前四半期にも痕跡がある」会社の観測値。 */
const COLLAPSING: Partial<StandardAiObservation> = {
  cashUsd: 2 * MILLION,
  lastQuarterFinancialHealthTier: "insolvent",
  lastQuarterProcurementScaleRatio: 0,
  lastQuarterActualProductionByProduct: { hoso: 0, pd: 0, vap: 0 },
};

// ---------------------------------------------------------------------

test("G3B2-1: NORMAL + 資金十分では、production/procurement/laborに新しいcapを掛けない", () => {
  const a = assess({}, "NORMAL", 15000);
  assert.equal(a.posture, "NORMAL");
  assert.equal(a.appliesProductionCap, false);
  assert.equal(a.fundableProductionTons, 15000, "NORMALでは生産必要量をそのまま通すべき");
  assert.equal(growthPausedForRecovery(a), false, "NORMALで成長を止めてはいけない");
});

test("G3B2-2: 資金危機でfundable原料が足りなければproductionが縮退する", () => {
  const a = assess(COLLAPSING, "SEVERE_DISTRESS", 15000);
  assert.equal(a.posture, "SURVIVAL");
  assert.equal(a.appliesProductionCap, true);
  assert.ok(a.fundableProductionTons < 15000, "生産必要量より小さく縮退すべき");
  // engineと同じ式: max(0,cash) × domesticPurchaseCashAllocationRatio ÷ (価格×1000)
  // 借入は信用凍結相当（insolvent）で0になるため、現金だけで買える量になる。
  assert.equal(a.expectedBorrowingForOperationsUsd, 0, "借りられない会社に借入を捏造してはいけない");
  const expectedTons = (2 * MILLION) / (PRICE * 1000);
  assert.ok(Math.abs(a.fundableDomesticProcurementTons - expectedTons) < 1e-6);
  assert.ok(Math.abs(a.fundableProductionTons - expectedTons) < 1e-6, "在庫0なら生産上限はfundable買付量と一致すべき");
});

test("G3B2-3: 生産計画がfundable量へ縮退し、必要原料（＝調達計画の基礎）も追従する", () => {
  const requirement: ProductAmount = { hoso: 12000, pd: 2000, vap: 1000 };
  const obs = observation({
    factories: [
      {
        factoryId: "BAL-F1",
        capacityByProduct: { hoso: 20000, pd: 6700, vap: 1750 },
        effectiveCapacityByProduct: { hoso: 20000, pd: 6700, vap: 1750 },
        skillByProduct: { hoso: 1, pd: 1, vap: 1 },
        attendanceRate: 0.95,
        currentRegularHeadcount: 5000,
      },
    ],
    totalCapacityByProduct: { hoso: 20000, pd: 6700, vap: 1750 },
    totalEffectiveCommonProcessingCapacity: 30000,
    totalEffectiveFreezingPackagingCapacity: 30000,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
  } as unknown as Partial<StandardAiObservation>);
  const pres = pressures({ finishedGoodsExcessRatioByProduct: { hoso: 1, pd: 1, vap: 1 } } as Partial<PressureScores>);
  const fixture = { companyId: "BAL" } as unknown as CompanyFixture;

  const uncapped = buildStandardAiProductionPlans(fixture, obs, pres, requirement);
  const uncappedTotal = uncapped.productionPlans.reduce((s, p) => s + Number(p.desiredQuantity), 0);

  const capped = buildStandardAiProductionPlans(fixture, obs, pres, requirement, 6000);
  const cappedTotal = capped.productionPlans.reduce((s, p) => s + Number(p.desiredQuantity), 0);

  assert.ok(cappedTotal < uncappedTotal, "capを渡すと生産計画が縮退すべき");
  assert.ok(cappedTotal <= 6000 + 1, "縮退後の生産計画はfundable原料量以下であるべき");
  assert.ok(
    capped.diagnostics.some((d) => d.code === "PRODUCTION_REDUCED_BY_LIQUIDITY"),
    "縮退の理由codeが立つべき"
  );
  // 調達計画の基礎（requiredRawMaterial）は生産計画の合計そのものなので自動追従する。
  assert.ok(
    Number(Object.values(capped.neededByProduct).reduce((s: number, v) => s + Number(v), 0)) <= 6000 + 1,
    "必要原料量も縮退後の水準へ追従すべき"
  );
});

test("G3B2-4: NORMAL時はcapを渡さない限り生産計画がbit-identicalである（成長会社を抑制しない）", () => {
  const requirement: ProductAmount = { hoso: 12000, pd: 2000, vap: 1000 };
  const obs = observation({
    factories: [
      {
        factoryId: "BAL-F1",
        capacityByProduct: { hoso: 20000, pd: 6700, vap: 1750 },
        effectiveCapacityByProduct: { hoso: 20000, pd: 6700, vap: 1750 },
        skillByProduct: { hoso: 1, pd: 1, vap: 1 },
        attendanceRate: 0.95,
        currentRegularHeadcount: 5000,
      },
    ],
    totalCapacityByProduct: { hoso: 20000, pd: 6700, vap: 1750 },
    totalEffectiveCommonProcessingCapacity: 30000,
    totalEffectiveFreezingPackagingCapacity: 30000,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
  } as unknown as Partial<StandardAiObservation>);
  const pres = pressures({ finishedGoodsExcessRatioByProduct: { hoso: 1, pd: 1, vap: 1 } } as Partial<PressureScores>);
  const fixture = { companyId: "BAL" } as unknown as CompanyFixture;

  const a = buildStandardAiProductionPlans(fixture, obs, pres, requirement);
  const b = buildStandardAiProductionPlans(fixture, obs, pres, requirement, undefined);
  assert.deepEqual(b.productionPlans, a.productionPlans);
  assert.deepEqual(b.neededByProduct, a.neededByProduct);
  assert.equal(
    b.diagnostics.some((d) => d.code === "PRODUCTION_REDUCED_BY_LIQUIDITY"),
    false
  );
});

test("G3B2-5: 一時的なLIQUIDITY_STRESSだけでは営業組織を縮小しない", () => {
  const transient = assess(
    { cashUsd: 5 * MILLION, lastQuarterFinancialHealthTier: "stressed", lastQuarterProcurementScaleRatio: 0.8 },
    "LIQUIDITY_STRESS",
    15000
  );
  assert.equal(transient.posture, "SURVIVAL", "危機自体は認識する");
  assert.equal(transient.sustainedDistress, false, "単発の悪化を持続的distressとみなしてはいけない");
  assert.equal(transient.allowsSalesForceReduction, false, "一時的Stressで営業力を毀損してはいけない");
  assert.equal(transient.appliesProductionCap, false, "単発のStressでハードな生産capを掛けてはいけない");
});

test("G3B2-6: 深刻かつ持続するdistressでは営業組織の段階縮小を許す", () => {
  const severe = assess(COLLAPSING, "SEVERE_DISTRESS", 15000);
  assert.equal(severe.sustainedDistress, true);
  assert.equal(severe.allowsSalesForceReduction, true);
  // SEVERE_DISTRESSでもsustainedでなければ営業は縮小しない（Workerより慎重）。
  const severeButFresh = assess(
    { cashUsd: 2 * MILLION, lastQuarterFinancialHealthTier: "insolvent", lastQuarterProcurementScaleRatio: 0.9 },
    "SEVERE_DISTRESS",
    15000
  );
  assert.equal(severeButFresh.sustainedDistress, false);
  assert.equal(severeButFresh.allowsSalesForceReduction, false);
});

test("G3B2-7: underwritingFrozenでは借入を資金に数えず、縮小で生き残る", () => {
  const frozen = assess({ ...COLLAPSING, lastQuarterUnderwritingFrozen: true }, "SEVERE_DISTRESS", 15000);
  assert.equal(frozen.expectedBorrowingForOperationsUsd, 0);
  assert.equal(frozen.posture, "SURVIVAL");
  assert.equal(frozen.appliesProductionCap, true, "借りられないなら規模を縮めて生き残るべき");
});

test("G3B2-8: 借りられる健全な会社では、当期の借入見込みがfundable調達へ算入される", () => {
  const noBorrow = assess({ cashUsd: 20 * MILLION, lastQuarterUnderwritingFrozen: true }, "NORMAL", 15000);
  const canBorrow = assess({ cashUsd: 20 * MILLION }, "NORMAL", 15000, {}, "HIGH");
  assert.equal(noBorrow.expectedBorrowingForOperationsUsd, 0);
  assert.ok(canBorrow.expectedBorrowingForOperationsUsd > 0);
  assert.ok(
    canBorrow.fundableDomesticProcurementTons > noBorrow.fundableDomesticProcurementTons,
    "借入見込みのぶんだけ資金手当て可能な調達量が増えるべき"
  );
});

test("G3B2-9: 資金が戻ればRECOVERYへ移り、規模は回復できるが成長投資は再開しない", () => {
  // 危機は抜けた（crisisState=NORMAL）が、前四半期には痕跡がある。
  const recovering = assess(
    {
      cashUsd: 80 * MILLION,
      lastQuarterFinancialHealthTier: "healthy",
      lastQuarterProcurementScaleRatio: 0,
      lastQuarterActualProductionByProduct: { hoso: 0, pd: 0, vap: 0 },
    },
    "NORMAL",
    15000
  );
  assert.equal(recovering.posture, "RECOVERY");
  assert.equal(recovering.appliesProductionCap, false, "RECOVERYでは規模の再拡大を妨げない");
  assert.equal(recovering.fundableProductionTons, 15000, "生産必要量まで戻せるべき");
  assert.equal(growthPausedForRecovery(recovering), true, "1Turn戻っただけで成長全開へ戻さない");
});

test("G3B2-10: 痕跡が消えればNORMALへ戻り、成長が再開できる（bounded recovery）", () => {
  const restored = assess(
    { cashUsd: 80 * MILLION, lastQuarterProcurementScaleRatio: 1, lastQuarterActualProductionByProduct: { hoso: 12000 } },
    "NORMAL",
    15000
  );
  assert.equal(restored.posture, "NORMAL");
  assert.equal(growthPausedForRecovery(restored), false);
});

test("G3B2-11: 会社IDのhardcodeが無く、profile（financialRiskTolerance）だけで差が出る", () => {
  const src = readFileSync(join(__dirname, "../decision/fundableOperations.ts"), "utf8");
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    assert.equal(src.includes(`"${companyId}"`), false, `会社ID ${companyId} をhardcodeしてはいけない`);
  }
  // profileによる差（借入を成長・操業原資に数えるか）は出る。
  const high = assess({ cashUsd: 20 * MILLION }, "NORMAL", 15000, {}, "HIGH");
  const low = assess({ cashUsd: 20 * MILLION }, "NORMAL", 15000, {}, "LOW");
  assert.ok(high.expectedBorrowingForOperationsUsd > low.expectedBorrowingForOperationsUsd);
  assert.equal(low.expectedBorrowingForOperationsUsd, 0, "LOWは借入を操業原資に数えない");
});

test("G3B2-12: 決定論（同一入力なら常に同一出力）", () => {
  const a = assess(COLLAPSING, "SEVERE_DISTRESS", 15000);
  const b = assess(COLLAPSING, "SEVERE_DISTRESS", 15000);
  assert.deepEqual(b, a);
});

test("G3B2-13: 参照価格が未知（Turn1等）ならcapを掛けない（0t扱いで生産を止めない）", () => {
  const turn1 = assess({ ...COLLAPSING, vietnamDomesticPriorPrice: undefined }, "SEVERE_DISTRESS", 15000);
  assert.equal(turn1.appliesProductionCap, false);
  assert.equal(turn1.fundableProductionTons, 15000);
});

// ---------------------------------------------------------------------
// 統合受入: 実在するcollapse fixture（DS1 seed ds1-benchmark の MASS）を使う。
// Scenario値・state値は一切捏造せず、既存シナリオで実際に起きる崩壊をそのまま使う。
// ---------------------------------------------------------------------

test("G3B2-14: 持続するSEVERE_DISTRESSでWorkerと営業が段階的に縮小し、固定費が落ちる（DS1 MASS実測）", () => {
  const AT = "2026-01-01T00:00:00.000Z";

  let session = createSimulationSession({
    simulationRunId: "g3b2-survival",
    scenarioId: "dynamic-scenario-1",
    seed: "ds1-benchmark",
    requestedTurns: 32,
    startedAt: AT,
  });

  const workerSeries: number[] = [];
  const postures: string[] = [];
  let sawSurvival = false;
  let totalSalesLayoff = 0;
  let maxSingleQuarterSalesLayoff = 0;

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
    const posture = result.diagnostics?.fundableOperations?.posture ?? "NORMAL";
    postures.push(posture);
    if (posture === "SURVIVAL") sawSurvival = true;
    workerSeries.push(
      result.decision.workerAssignments.reduce((s: number, w: { regularHeadcount: number }) => s + w.regularHeadcount, 0)
    );
    const layoff = result.decision.salesForceLayoffCount ?? 0;
    totalSalesLayoff += layoff;
    maxSingleQuarterSalesLayoff = Math.max(maxSingleQuarterSalesLayoff, layoff);

    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced);
    session = outcome.session;
  }

  assert.ok(sawSurvival, "崩壊するMASSでSurvival Modeが発火していない");
  // Workerが「生産0でも永久に固定」されない。
  const peakWorker = Math.max(...workerSeries);
  const finalWorker = workerSeries[workerSeries.length - 1];
  assert.ok(peakWorker >= 5000, `この受入の前提（初期に5,000人規模）が崩れている（実測 ${peakWorker}）`);
  assert.ok(finalWorker < peakWorker * 0.2, `Worker固定費が落ちていない（${peakWorker}人 → ${finalWorker}人）`);
  // 一気に全員解雇していない（既存のregularHeadcountAdjustmentDampingの範囲）。
  for (let i = 1; i < workerSeries.length; i++) {
    const prev = workerSeries[i - 1];
    if (prev <= 0) continue;
    const dropRatio = (prev - workerSeries[i]) / prev;
    assert.ok(dropRatio <= 0.75, `1四半期で${(dropRatio * 100).toFixed(1)}%減らしており、段階的縮小になっていない`);
  }
  // 営業は縮小するが、1四半期に一括では削らない（Recovery不能にしない）。
  assert.ok(totalSalesLayoff > 0, "深刻かつ持続する危機でも営業組織が一切縮小していない");
  assert.ok(maxSingleQuarterSalesLayoff <= 30, `1四半期の営業減員が${maxSingleQuarterSalesLayoff}人と過大である`);
});

test("G3B2-15: 健全な成長会社ではSurvival Modeがほとんど発火しない（DS1 BAL実測）", () => {
  const AT = "2026-01-01T00:00:00.000Z";

  let session = createSimulationSession({
    simulationRunId: "g3b2-normal",
    scenarioId: "dynamic-scenario-1",
    seed: "ds1-benchmark",
    requestedTurns: 32,
    startedAt: AT,
  });

  let cappedQuarters = 0;
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
    if (result.diagnostics?.fundableOperations?.appliesProductionCap) cappedQuarters += 1;
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced);
    session = outcome.session;
  }
  assert.equal(cappedQuarters, 0, "健全な成長会社に資金による生産capが掛かってはいけない");
});
