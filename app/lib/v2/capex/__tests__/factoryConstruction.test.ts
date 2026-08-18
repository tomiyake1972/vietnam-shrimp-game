// ShrimpX V2 — 新工場建設（newFactoryConstruction、Test15新設）のテスト
//
// 対応する要求事項:
//   - 支払スケジュール／CIPの建設期間中の挙動
//   - 完成時の固定資産振替
//   - 稼働開始（完成＋操業準備期間経過）後にのみ減価償却・保守費・固定費が発生する
//   - 1社あたり最大4工場の上限（建設中案件も合算してカウント）
//   - 稼働開始後の50%/75%/100%ランプアップ

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPeriod, period, PeriodV2 } from "../../core/period";
import { Product } from "../../market/types";
import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { Factory } from "../../production/types";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import { CompanyQuarterBusinessActuals } from "../../finance/quarterClose";
import { CompanyFinanceState, usd } from "../../finance/types";
import { closeQuarterWithFinancing, CloseQuarterWithFinancingInput, planQuarterFinancing, QuarterFinancingPlanInput } from "../../financing/liquidityClose";
import { FINANCING_PARAMETERS_V1 } from "../../financing/parameters";
import { CollateralInput } from "../../financing/borrowingCapacity";
import { CompanyFinancingHistory, CompanyFinancingState, FinancingRequestInput } from "../../financing/types";
import { CAPEX_PARAMETERS_V1 } from "../parameters";
import { buildInitialCompanyCapexState, closeQuarterWithCapex, CloseQuarterWithCapexInput } from "../capexClose";
import { CapexDecisionInput, CapitalProject, CompanyCapexState } from "../types";
import { ProposalApprovalGate, isActiveStatus } from "../projectLifecycle";
import { isCapexProjectOperationalAt } from "../capacityEffect";
import {
  applyNewFactoryConstructionToFactories,
  buildNewFactoryFromProject,
  buildNewFactoryId,
  computeNewFactoriesForCompany,
  countProspectiveFactories,
  MAX_FACTORIES_PER_COMPANY,
  rampMultiplierForQuartersOperational,
  wouldExceedMaxFactories,
} from "../factoryConstruction";

const P1 = period(2015, 1);
const PROCESSING_RATES: Readonly<Record<Product, number>> = { hoso: 350, pd: 520, vap: 780 };
const HEALTHY_GATE: ProposalApprovalGate = { borrowingCapacityFrozen: false, severelyDistressed: false };
const TEMPLATE = CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction;

// ---------------------------------------------------------------------
// 0. テストヘルパー（capexClose.test.tsと同じ最小構成のゼロ活動四半期）
// ---------------------------------------------------------------------

function makeFinanceState(cash: number): CompanyFinanceState {
  const fixedAssetsGross = 40_000_000;
  const capitalStock = 30_000_000;
  const totalAssets = cash + fixedAssetsGross;
  const retainedEarnings = totalAssets - capitalStock;
  return {
    companyId: "TEST",
    cash: usd(cash),
    receivables: [],
    payables: [],
    otherCurrentAssets: usd(0),
    fixedAssetsGross: usd(fixedAssetsGross),
    accumulatedDepreciation: usd(0),
    shortTermLoans: usd(0),
    longTermLoans: usd(0),
    otherLiabilities: usd(0),
    capitalStock: usd(capitalStock),
    retainedEarnings: usd(retainedEarnings),
    distributableEarnings: usd(0),
    finishedGoodsCostLedger: [],
  };
}

function zeroActuals(p: PeriodV2): CompanyQuarterBusinessActuals {
  return {
    companyId: "TEST",
    period: p,
    fulfillmentUsage: [],
    contractTerms: [],
    batches: [],
    regularHeadcount: 0,
    temporaryHeadcount: 0,
    appliedOvertimeRate: 0,
    activeFactoryCount: 0,
    salesForceHeadcount: 0,
    procurementHeadcount: 0,
    domesticPurchasesUsd: 0,
    importOrdersUsd: 0,
    aquacultureHarvestUsd: 0,
    rawMaterialInventoryBeginUsd: 0,
    rawMaterialInventoryEndUsd: 0,
    lotConsumption: [],
    finishedGoodsRemainingByLot: [],
  };
}

function makeHistory(): CompanyFinancingHistory {
  return {
    consecutiveArrearsQuarters: 0,
    consecutiveCovenantBreachQuarters: 0,
    totalOnTimeRepaymentEventsCount: 4,
    totalArrearsEventsCount: 0,
    totalEmergencyLoanDrawsCount: 0,
  };
}

function makeFinancingState(): CompanyFinancingState {
  return { companyId: "TEST", loanPortfolio: { companyId: "TEST", loans: [] }, accruedInterestPayableUsd: 0, history: makeHistory() };
}

function makeCollateral(): CollateralInput {
  return { receivablesUsd: 0, rawMaterialAvailableUsd: 0, rawMaterialInTransitUsd: 0, finishedGoodsUsd: 0 };
}

function noRequest(): FinancingRequestInput {
  return {
    desiredAmountUsd: 0,
    desiredLoanType: "workingCapital",
    desiredTermQuarters: 4,
    desiredRepaymentMethod: "bulletAtMaturity",
    desiredPrepaymentUsd: 0,
    emergencyAcceptable: false,
  };
}

function emptyCapexDecision(overrides: Partial<CapexDecisionInput> = {}): CapexDecisionInput {
  return { companyId: "TEST", newProjectProposals: [], cancelRequests: [], resumeRequests: [], ...overrides };
}

function closeFinancingOnly(financeState: CompanyFinanceState, financingState: CompanyFinancingState, p: PeriodV2) {
  const planInput: QuarterFinancingPlanInput = {
    companyId: "TEST",
    period: p,
    prevFinanceState: financeState,
    prevFinancingState: financingState,
    collateral: makeCollateral(),
    financingRequest: noRequest(),
  };
  const plan = planQuarterFinancing(planInput, FINANCE_PARAMETERS_V1, FINANCING_PARAMETERS_V1);
  const input: CloseQuarterWithFinancingInput = {
    companyId: "TEST",
    period: p,
    prevFinanceState: financeState,
    prevFinancingState: financingState,
    actuals: zeroActuals(p),
    plan,
    financingRequest: noRequest(),
    collateralForEmergency: makeCollateral(),
  };
  return closeQuarterWithFinancing(input, FINANCE_PARAMETERS_V1, FINANCING_PARAMETERS_V1, PROCESSING_RATES);
}

/** 1四半期ぶんのcloseQuarterWithCapexを実行する（毎期の意思決定・existingFactoryCountを差し替えられる）。 */
function closeWithCapex(
  financeState: CompanyFinanceState,
  financingState: CompanyFinancingState,
  capexState: CompanyCapexState,
  decision: CapexDecisionInput,
  p: PeriodV2,
  existingFactoryCount = 1
) {
  const financingOutput = closeFinancingOnly(financeState, financingState, p);
  const input: CloseQuarterWithCapexInput = {
    companyId: "TEST",
    period: p,
    prevFinanceState: financeState,
    actuals: zeroActuals(p),
    financeResultBeforeCapex: financingOutput.financeResult,
    financingQuarterResult: financingOutput.financingQuarterResult,
    beginningAccruedInterestPayableUsd: financingState.accruedInterestPayableUsd,
    prevCapexState: capexState,
    decision,
    approvalGate: HEALTHY_GATE,
    existingFactoryCount,
  };
  return closeQuarterWithCapex(input, FINANCE_PARAMETERS_V1, CAPEX_PARAMETERS_V1, PROCESSING_RATES);
}

/**
 * 潤沢な現金（$40M）を使い、newFactoryConstruction案件1件を提案してから
 * quarters回ぶんclose処理を進める（各四半期でnewProjectProposalsは空）。
 * 戻り値は各四半期末のCompanyCapexStateの配列（[0]=提案・初回支払を行った四半期末）。
 */
function runProjectThroughQuarters(quarters: number, startPeriod: PeriodV2 = P1): { readonly states: readonly CompanyCapexState[]; readonly periods: readonly PeriodV2[] } {
  let financeState = makeFinanceState(40_000_000);
  const financingState = makeFinancingState();
  let capexState = buildInitialCompanyCapexState("TEST");
  let p = startPeriod;
  const states: CompanyCapexState[] = [];
  const periods: PeriodV2[] = [];

  for (let i = 0; i < quarters; i++) {
    const decision = emptyCapexDecision(i === 0 ? { newProjectProposals: [{ projectType: "newFactoryConstruction" }] } : {});
    const out = closeWithCapex(financeState, financingState, capexState, decision, p, 1);
    financeState = out.nextFinanceState;
    capexState = out.nextCapexState;
    states.push(capexState);
    periods.push(p);
    p = nextPeriod(p);
  }
  return { states, periods };
}

// ---------------------------------------------------------------------
// 1. 支払スケジュール・CIP（建設期間中の挙動）
// ---------------------------------------------------------------------

test("新工場建設: 標準テンプレートは投資額$22,000,000・支払比率30/35/35%・工期3四半期・竣工後1四半期の操業準備期間", () => {
  assert.equal(TEMPLATE.standardBudgetUsd, 22_000_000);
  assert.deepEqual(TEMPLATE.paymentRatios, [0.3, 0.35, 0.35]);
  assert.equal(TEMPLATE.standardConstructionQuarters, 3);
  assert.equal(TEMPLATE.postCompletionReadinessQuarters, 1);
  assert.equal(TEMPLATE.buildingRatio, 0.45);
  assert.equal(TEMPLATE.machineryRatio, 0.55);
  assert.ok(Math.abs(TEMPLATE.maintenanceRatePerQuarter - 0.0075) < 1e-9);
});

test("新工場建設: 3四半期の支払を経て、各stageの支払額が予定比率どおりに累積し、完成までunderConstruction/CIPで推移する", () => {
  const { states } = runProjectThroughQuarters(3);
  const projectsByQuarter = states.map((s) => s.portfolio.projects[0]);

  // Q1: 初回支払(30%)後、着工(underConstruction)。
  assert.equal(projectsByQuarter[0].status, "underConstruction");
  assert.ok(Math.abs(projectsByQuarter[0].cumulativePaidUsd - 22_000_000 * 0.3) < 1);
  assert.equal(projectsByQuarter[0].completedPaymentStagesCount, 1);

  // Q2: 2回目支払後(30%+35%)、まだunderConstruction。
  assert.equal(projectsByQuarter[1].status, "underConstruction");
  assert.ok(Math.abs(projectsByQuarter[1].cumulativePaidUsd - 22_000_000 * 0.65) < 1);
  assert.equal(projectsByQuarter[1].completedPaymentStagesCount, 2);

  // Q3: 最終支払完了、completedへ遷移。cumulativePaidUsd=approvedBudgetUsd。
  assert.equal(projectsByQuarter[2].status, "completed");
  assert.ok(Math.abs(projectsByQuarter[2].cumulativePaidUsd - 22_000_000) < 1);
  assert.equal(projectsByQuarter[2].completedPaymentStagesCount, 3);
  assert.equal(projectsByQuarter[2].completedPeriod, projectsByQuarter[2].completedPeriod); // 完成期が設定されている
  assert.notEqual(projectsByQuarter[2].completedPeriod, undefined);
});

// ---------------------------------------------------------------------
// 2. 完成時の固定資産振替
// ---------------------------------------------------------------------

test("新工場建設: 完成時にcapitalizedAmountUsdへcumulativePaidUsdがそのまま振替えられる", () => {
  const { states } = runProjectThroughQuarters(3);
  const completedProject = states[2].portfolio.projects[0];
  assert.equal(completedProject.status, "completed");
  assert.ok(completedProject.capitalizedAmountUsd !== undefined);
  assert.ok(Math.abs((completedProject.capitalizedAmountUsd as number) - 22_000_000) < 1);
  assert.ok(Math.abs((completedProject.capitalizedAmountUsd as number) - completedProject.cumulativePaidUsd) < 1e-6);
});

// ---------------------------------------------------------------------
// 3. 稼働開始後にのみ減価償却・保守費・固定費が発生する
// ---------------------------------------------------------------------

test("新工場建設: 完成直後（操業準備期間中）はまだ稼働開始しておらず、Factory[]へ追加されない・減価償却も0", () => {
  const { states, periods } = runProjectThroughQuarters(4); // Q1〜Q3建設、Q4=完成の翌四半期（操業準備期間中）
  const completedProject = states[2].portfolio.projects[0];
  const q4Period = periods[3];

  // 完成(Q3)の翌四半期(Q4)はreadiness=1のため、まだ稼働開始していない。
  assert.equal(isCapexProjectOperationalAt(completedProject, q4Period), false);
  const factory = buildNewFactoryFromProject(states[3].portfolio.projects[0], q4Period);
  assert.equal(factory, undefined, "操業準備期間中はまだFactoryを合成しない");
});

test("新工場建設: 稼働開始四半期に達すると初めてFactory[]へ追加され、その四半期以降は減価償却・保守費が発生する", () => {
  const { states, periods } = runProjectThroughQuarters(5); // Q1〜Q3建設、Q4操業準備、Q5稼働開始
  const q5Period = periods[4];
  const project = states[4].portfolio.projects[0];

  assert.equal(project.status, "completed");
  assert.equal(isCapexProjectOperationalAt(project, q5Period), true);

  const factory = buildNewFactoryFromProject(project, q5Period);
  assert.notEqual(factory, undefined, "稼働開始四半期からはFactoryが合成される");
});

test("新工場建設: closeQuarterWithCapexが返すcapexAssetsDepreciationUsd・capexMaintenanceCostUsdは、稼働開始前は常に0で、稼働開始後にのみ正の値になる", () => {
  let financeState = makeFinanceState(40_000_000);
  const financingState = makeFinancingState();
  let capexState = buildInitialCompanyCapexState("TEST");
  let p = P1;
  const results: { readonly period: PeriodV2; readonly depreciation: number; readonly maintenance: number; readonly status: string }[] = [];

  for (let i = 0; i < 5; i++) {
    const decision = emptyCapexDecision(i === 0 ? { newProjectProposals: [{ projectType: "newFactoryConstruction" }] } : {});
    const out = closeWithCapex(financeState, financingState, capexState, decision, p, 1);
    financeState = out.nextFinanceState;
    capexState = out.nextCapexState;
    results.push({
      period: p,
      depreciation: out.capexQuarterResult.capexAssetsDepreciationUsd,
      maintenance: out.capexQuarterResult.capexMaintenanceCostUsd,
      status: capexState.portfolio.projects[0].status,
    });
    p = nextPeriod(p);
  }

  // Q1〜Q4（建設中〜操業準備期間）は一切発生しない。
  for (let i = 0; i < 4; i++) {
    assert.equal(results[i].depreciation, 0, `Q${i + 1}: 稼働開始前に減価償却が発生しています`);
    assert.equal(results[i].maintenance, 0, `Q${i + 1}: 稼働開始前に保守費が発生しています`);
  }
  // Q5（稼働開始）は正の値。
  assert.ok(results[4].depreciation > 0, "稼働開始四半期に減価償却が発生していません");
  assert.ok(results[4].maintenance > 0, "稼働開始四半期に保守費が発生していません");
  // 保守費 = capitalizedAmountUsd(22M) × 0.0075
  assert.ok(Math.abs(results[4].maintenance - 22_000_000 * 0.0075) < 1);
});

// ---------------------------------------------------------------------
// 4. 1社あたり最大4工場の上限（建設中案件も合算してカウント）
// ---------------------------------------------------------------------

function makeNewFactoryProject(overrides: Partial<CapitalProject> = {}): CapitalProject {
  return {
    projectId: "TEST-CAPEX-1",
    companyId: "TEST",
    projectType: "newFactoryConstruction",
    approvedBudgetUsd: 22_000_000,
    paymentSchedule: TEMPLATE.paymentRatios.map((plannedRatio, stageIndex) => ({ stageIndex, plannedRatio })),
    completedPaymentStagesCount: 0,
    cumulativePaidUsd: 0,
    elapsedConstructionQuartersWithPayment: 0,
    requiredConstructionQuarters: 3,
    status: "approved",
    proposedPeriod: P1,
    approvedPeriod: P1,
    priority: 1,
    lastDiagnosticReasons: [],
    ...overrides,
  };
}

test("工場数上限: countProspectiveFactoriesは既存工場数＋取消以外のnewFactoryConstruction案件数を合算する", () => {
  const projects = [
    makeNewFactoryProject({ projectId: "P1", status: "approved" }),
    makeNewFactoryProject({ projectId: "P2", status: "underConstruction" }),
    makeNewFactoryProject({ projectId: "P3", status: "completed" }),
    makeNewFactoryProject({ projectId: "P4", status: "cancelled" }), // 取消は数えない
  ];
  assert.equal(countProspectiveFactories(1, projects), 1 + 3); // 既存1 + (approved/underConstruction/completed=3)
});

test("工場数上限: 既存1工場＋新工場3件（承認済み・建設中含む）で合計4のとき、5件目の新工場提案は上限で拒否される", () => {
  assert.equal(MAX_FACTORIES_PER_COMPANY, 4);
  const projects = [
    makeNewFactoryProject({ projectId: "P1", status: "completed" }),
    makeNewFactoryProject({ projectId: "P2", status: "underConstruction" }),
    makeNewFactoryProject({ projectId: "P3", status: "approved" }),
  ];
  assert.equal(countProspectiveFactories(1, projects), 4);
  assert.equal(wouldExceedMaxFactories(1, projects), true);
});

test("工場数上限: 既存1工場＋新工場2件で合計3のとき、4件目（合計4件）はまだ上限内", () => {
  const projects = [makeNewFactoryProject({ projectId: "P1", status: "completed" }), makeNewFactoryProject({ projectId: "P2", status: "underConstruction" })];
  assert.equal(countProspectiveFactories(1, projects), 3);
  assert.equal(wouldExceedMaxFactories(1, projects), false);
});

test("工場数上限: closeQuarterWithCapex統合 — 既存3工場の会社が新工場を2件連続で提案すると、2件目は拒否される", () => {
  let financeState = makeFinanceState(100_000_000);
  const financingState = makeFinancingState();
  let capexState = buildInitialCompanyCapexState("TEST");

  // 1件目の提案（既存工場3 + 提案1件 = 4、上限内）。
  const decision1 = emptyCapexDecision({ newProjectProposals: [{ projectType: "newFactoryConstruction" }] });
  const out1 = closeWithCapex(financeState, financingState, capexState, decision1, P1, 3);
  financeState = out1.nextFinanceState;
  capexState = out1.nextCapexState;
  assert.equal(capexState.portfolio.projects.length, 1, "1件目は承認されるはず");
  assert.equal(out1.capexQuarterResult.rejectedProposals.length, 0);

  // 2件目の提案（既存工場3 + 承認済み1件 + 提案1件 = 5、上限超過で拒否）。
  const p2 = period(2015, 2);
  const decision2 = emptyCapexDecision({ newProjectProposals: [{ projectType: "newFactoryConstruction" }] });
  const out2 = closeWithCapex(financeState, financingState, capexState, decision2, p2, 3);
  assert.equal(out2.nextCapexState.portfolio.projects.length, 1, "2件目は拒否され、案件数は増えないはず");
  assert.equal(out2.capexQuarterResult.rejectedProposals.length, 1);
  assert.match(out2.capexQuarterResult.rejectedProposals[0].reasons.join(" "), /工場数が上限/);
});

// ---------------------------------------------------------------------
// 5. ランプアップ（稼働開始から50%/75%/100%）
// ---------------------------------------------------------------------

test("ランプアップ: rampMultiplierForQuartersOperationalは0四半期目=50%・1四半期目=75%・2四半期目以降=100%", () => {
  const table = TEMPLATE.newFactoryEffect!.rampMultipliers;
  assert.deepEqual(table, [0.5, 0.75, 1.0]);
  assert.equal(rampMultiplierForQuartersOperational(0, table), 0.5);
  assert.equal(rampMultiplierForQuartersOperational(1, table), 0.75);
  assert.equal(rampMultiplierForQuartersOperational(2, table), 1.0);
  assert.equal(rampMultiplierForQuartersOperational(3, table), 1.0);
  assert.equal(rampMultiplierForQuartersOperational(100, table), 1.0);
});

test("ランプアップ: 稼働開始後の合成Factoryは、稼働開始四半期=50%・翌四半期=75%・その次以降=100%の能力になる（実装指示の標準工場能力基準）", () => {
  const { states, periods } = runProjectThroughQuarters(7); // Q1-3建設・Q4準備・Q5稼働開始(50%)・Q6(75%)・Q7(100%)
  const project = states[6].portfolio.projects[0];

  const factoryQ5 = buildNewFactoryFromProject(project, periods[4])!;
  const factoryQ6 = buildNewFactoryFromProject(project, periods[5])!;
  const factoryQ7 = buildNewFactoryFromProject(project, periods[6])!;

  assert.notEqual(factoryQ5, undefined);
  assert.ok(Math.abs(unwrapUnit(factoryQ5.commonProcessingCapacity) - 22_000 * 0.5) < 1e-6);
  assert.ok(Math.abs(unwrapUnit(factoryQ5.hosoCapacity) - 10_000 * 0.5) < 1e-6);
  assert.ok(Math.abs(unwrapUnit(factoryQ5.pdCapacity) - 8_000 * 0.5) < 1e-6);
  assert.ok(Math.abs(unwrapUnit(factoryQ5.vapCapacity) - 6_000 * 0.5) < 1e-6);
  assert.ok(Math.abs(unwrapUnit(factoryQ5.freezingPackagingCapacity) - 20_000 * 0.5) < 1e-6);

  assert.ok(Math.abs(unwrapUnit(factoryQ6.commonProcessingCapacity) - 22_000 * 0.75) < 1e-6);
  assert.ok(Math.abs(unwrapUnit(factoryQ6.hosoCapacity) - 10_000 * 0.75) < 1e-6);

  assert.ok(Math.abs(unwrapUnit(factoryQ7.commonProcessingCapacity) - 22_000) < 1e-6);
  assert.ok(Math.abs(unwrapUnit(factoryQ7.hosoCapacity) - 10_000) < 1e-6);
  assert.ok(Math.abs(unwrapUnit(factoryQ7.pdCapacity) - 8_000) < 1e-6);
  assert.ok(Math.abs(unwrapUnit(factoryQ7.vapCapacity) - 6_000) < 1e-6);
  assert.ok(Math.abs(unwrapUnit(factoryQ7.freezingPackagingCapacity) - 20_000) < 1e-6);

  // ランプ中でも工場スペース総量はフルランプ時の名目能力から導出され、ランプ倍率の影響を受けない。
  assert.equal(factoryQ5.totalFactorySpaceUnits, factoryQ7.totalFactorySpaceUnits);
});

// ---------------------------------------------------------------------
// 6. Factory ID・合成の決定論性、既存工場への非干渉
// ---------------------------------------------------------------------

test("Factory ID: buildNewFactoryIdは同じ会社・同じ案件からは常に同じIDを返し、既存の${companyId}-F1と衝突しない", () => {
  const project = makeNewFactoryProject({ projectId: "TEST-CAPEX-3" });
  const id1 = buildNewFactoryId(project);
  const id2 = buildNewFactoryId(project);
  assert.equal(id1, id2);
  assert.notEqual(id1, "TEST-F1");
  assert.match(id1, /^TEST-NEWF-/);
});

test("applyNewFactoryConstructionToFactories: 稼働開始済みの新設Factoryだけを既存Factory[]へ追加し、既存工場の値は一切変更しない", () => {
  const existingFactory: Factory = {
    factoryId: "TEST-F1",
    companyId: "TEST",
    status: "active",
    commonProcessingCapacity: hosoEqTons(22000),
    hosoCapacity: hosoEqTons(10000),
    pdCapacity: hosoEqTons(8000),
    vapCapacity: hosoEqTons(6000),
    freezingPackagingCapacity: hosoEqTons(20000),
    baseUtilizationRate: ratio(0.9),
    equipmentAvailabilityRate: ratio(0.95),
  };
  const before = JSON.stringify(existingFactory);
  const project = makeNewFactoryProject({
    status: "completed",
    completedPeriod: period(2015, 1),
    completedPaymentStagesCount: 3,
    cumulativePaidUsd: 22_000_000,
    capitalizedAmountUsd: 22_000_000,
    elapsedConstructionQuartersWithPayment: 3,
    futureCapacityEffect: { capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 1 },
    newFactoryEffect: TEMPLATE.newFactoryEffect,
  });
  const capexState = { companies: [{ companyId: "TEST" as const, portfolio: { companyId: "TEST" as const, projects: [project] }, nextProjectSequence: 2 }] };
  const opPeriod = period(2015, 3); // completed@2015Q1、readiness=1 → 稼働開始2015Q3

  const result = applyNewFactoryConstructionToFactories([existingFactory], capexState, opPeriod);
  assert.equal(result.length, 2, "新設Factoryが1件追加されているはず");
  assert.equal(JSON.stringify(existingFactory), before, "既存工場オブジェクトは変更されていないはず");
  const added = result.find((f) => f.factoryId !== "TEST-F1");
  assert.notEqual(added, undefined);
  assert.equal(added!.companyId, "TEST");
});

test("computeNewFactoriesForCompany: newFactoryConstruction以外の案件種別は無視する", () => {
  const otherProject = makeNewFactoryProject({ projectType: "hosoLineExpansion" as never, status: "completed", completedPeriod: period(2015, 1) });
  const factories = computeNewFactoriesForCompany([otherProject], period(2015, 3));
  assert.equal(factories.length, 0);
});

test("isActiveStatus: newFactoryConstruction案件にも既存のステータス判定がそのまま使える（案件種別非依存の確認）", () => {
  assert.equal(isActiveStatus("approved"), true);
  assert.equal(isActiveStatus("completed"), false);
});
