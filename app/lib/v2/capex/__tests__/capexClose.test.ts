// ShrimpX V2 — 設備投資モジュール 四半期クローズ統合テスト（Phase 8B-2A）
//
// closeQuarterWithCapexを通した、設備投資の現金配分・finance/への三段目
// closefinancialQuarter接続の受入確認。事業活動は「ゼロ活動四半期」に固定し、
// financing/liquidityClose.test.tsと同じ方針で、設備投資・会計三表接続の
// 効果だけを切り分けて検証する。
//
// 対応する必須テスト項目: 5（資金制約）・6（会計: BS/CF/固定資産・CIP・
// 減価償却除外）・7（Phase 8B-2Bとの境界: 完成後も減価償却が始まらない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_PERIOD_V2, period } from "../../core/period";
import { Product } from "../../market/types";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import { computeExistingAssetDepreciationUsd } from "../../finance/depreciation";
import { CompanyQuarterBusinessActuals } from "../../finance/quarterClose";
import { CompanyFinanceState, usd } from "../../finance/types";
import {
  closeQuarterWithFinancing,
  CloseQuarterWithFinancingInput,
  planQuarterFinancing,
  QuarterFinancingPlanInput,
} from "../../financing/liquidityClose";
import { FINANCING_PARAMETERS_V1 } from "../../financing/parameters";
import { CollateralInput } from "../../financing/borrowingCapacity";
import { CompanyFinancingHistory, CompanyFinancingState, FinancingRequestInput } from "../../financing/types";
import { CAPEX_PARAMETERS_V1 } from "../parameters";
import { buildInitialCompanyCapexState, closeQuarterWithCapex, CloseQuarterWithCapexInput } from "../capexClose";
import { CapexDecisionInput, CompanyCapexState } from "../types";
import { ProposalApprovalGate } from "../projectLifecycle";

const P1 = period(2015, 1);
const PROCESSING_RATES: Readonly<Record<Product, number>> = { hoso: 350, pd: 520, vap: 780 };
const EPS = 1;
const HEALTHY_GATE: ProposalApprovalGate = { borrowingCapacityFrozen: false, severelyDistressed: false };

interface FinanceStateFields {
  readonly cash: number;
  readonly otherCurrentAssets: number;
  readonly fixedAssetsGross: number;
  readonly accumulatedDepreciation: number;
  readonly shortTermLoans: number;
  readonly longTermLoans: number;
  readonly otherLiabilities: number;
  readonly capitalStock: number;
}

function makeFinanceState(overrides: Partial<FinanceStateFields> = {}): CompanyFinanceState {
  const f: FinanceStateFields = {
    cash: 30_000_000,
    otherCurrentAssets: 0,
    fixedAssetsGross: 40_000_000,
    accumulatedDepreciation: 0,
    shortTermLoans: 0,
    longTermLoans: 0,
    otherLiabilities: 0,
    capitalStock: 30_000_000,
    ...overrides,
  };
  const totalAssets = f.cash + f.otherCurrentAssets + (f.fixedAssetsGross - f.accumulatedDepreciation);
  const totalLiabilities = f.shortTermLoans + f.longTermLoans + f.otherLiabilities;
  const retainedEarnings = totalAssets - totalLiabilities - f.capitalStock;
  return {
    companyId: "TEST",
    cash: usd(f.cash),
    receivables: [],
    payables: [],
    otherCurrentAssets: usd(f.otherCurrentAssets),
    fixedAssetsGross: usd(f.fixedAssetsGross),
    accumulatedDepreciation: usd(f.accumulatedDepreciation),
    shortTermLoans: usd(f.shortTermLoans),
    longTermLoans: usd(f.longTermLoans),
    otherLiabilities: usd(f.otherLiabilities),
    capitalStock: usd(f.capitalStock),
    retainedEarnings: usd(retainedEarnings),
    distributableEarnings: usd(0),
    finishedGoodsCostLedger: [],
  };
}

function zeroActuals(p = P1): CompanyQuarterBusinessActuals {
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

function makeHistory(overrides: Partial<CompanyFinancingHistory> = {}): CompanyFinancingHistory {
  return {
    consecutiveArrearsQuarters: 0,
    consecutiveCovenantBreachQuarters: 0,
    totalOnTimeRepaymentEventsCount: 4,
    totalArrearsEventsCount: 0,
    totalEmergencyLoanDrawsCount: 0,
    ...overrides,
  };
}

function makeFinancingState(): CompanyFinancingState {
  return {
    companyId: "TEST",
    loanPortfolio: { companyId: "TEST", loans: [] },
    accruedInterestPayableUsd: 0,
    history: makeHistory(),
  };
}

function makeCollateral(): CollateralInput {
  return { receivablesUsd: 0, rawMaterialAvailableUsd: 0, rawMaterialInTransitUsd: 0, finishedGoodsUsd: 0 };
}

function noRequest(): FinancingRequestInput {
  return { desiredAmountUsd: 0, desiredLoanType: "workingCapital", desiredTermQuarters: 4, desiredRepaymentMethod: "bulletAtMaturity", desiredPrepaymentUsd: 0, emergencyAcceptable: false };
}

function emptyCapexDecision(overrides: Partial<CapexDecisionInput> = {}): CapexDecisionInput {
  return { companyId: "TEST", newProjectProposals: [], cancelRequests: [], resumeRequests: [], ...overrides };
}

/** financing決算確定後の最終financeResult・financingQuarterResultを合成する（closeQuarterWithFinancingは既存・未変更のまま呼ぶ）。 */
function closeFinancingOnly(financeState: CompanyFinanceState, financingState: CompanyFinancingState, p = P1) {
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

function closeWithCapex(
  financeState: CompanyFinanceState,
  financingState: CompanyFinancingState,
  capexState: CompanyCapexState,
  decision: CapexDecisionInput,
  gate: ProposalApprovalGate = HEALTHY_GATE,
  p = P1
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
    approvalGate: gate,
  };
  return closeQuarterWithCapex(input, FINANCE_PARAMETERS_V1, CAPEX_PARAMETERS_V1, PROCESSING_RATES);
}

function assertThreeStatementIdentities(financeResult: ReturnType<typeof closeWithCapex>["financeResult"]) {
  assert.ok(Math.abs(financeResult.balanceSheet.balanceDifference as number) < EPS, `貸借差額: ${financeResult.balanceSheet.balanceDifference}`);
  assert.ok(Math.abs(financeResult.cashFlow.directIndirectDifference as number) < EPS, `直接法/間接法CFOの差: ${financeResult.cashFlow.directIndirectDifference}`);
  assert.ok(
    Math.abs((financeResult.cashFlow.closingCash as number) - ((financeResult.cashFlow.openingCash as number) + (financeResult.cashFlow.netCashChange as number))) < EPS
  );
}

// ---------------------------------------------------------------------
// 5. 資金制約（設備投資可能額 = max(0, 設備投資前現金 − 最低現金準備額)）
// ---------------------------------------------------------------------

test("受入確認CC-1: 設備投資可能額は「設備投資前現金 − 最低現金準備額」で、これを超える支払は発生しない", () => {
  const financeState = makeFinanceState({ cash: CAPEX_PARAMETERS_V1.minimumCashReserveUsd + 1_000_000 });
  const capexState = buildInitialCompanyCapexState("TEST");
  const financingState = makeFinancingState();
  const decision = emptyCapexDecision({ newProjectProposals: [{ projectType: "qualityControlEquipment" }] }); // 標準予算1.2M > 利用可能想定額1.0M付近

  // 期待値は「設備投資前現金 − 最低現金準備額」の定義そのものから導く。
  // 注: 事業活動をゼロ（zeroActuals）にしても、固定管理費（sellingGeneralAdmin.
  // adminFixedUsdPerQuarter、既存Phase 8Aの固定費）は稼働実績に関わらず毎期
  // 現金で発生するため、設備投資前現金は必ずしも期初現金と一致しない
  // （「ゼロ活動四半期」は事業活動由来の変動を排除する意図であり、既存の固定費
  // 構造そのものは対象外。本テストはその実際の確定額を基準に検証する）。
  const financingOutput = closeFinancingOnly(financeState, financingState);
  const expectedPreCapexCash = financingOutput.financeResult.balanceSheet.cash as number;
  const expectedCashAvailable = Math.max(0, expectedPreCapexCash - CAPEX_PARAMETERS_V1.minimumCashReserveUsd);

  const output = closeWithCapex(financeState, financingState, capexState, decision);
  assert.ok(Math.abs(output.capexQuarterResult.cashAvailableForCapexUsd - expectedCashAvailable) < EPS);
  assert.ok(output.capexQuarterResult.totalPaidThisQuarterUsd <= expectedCashAvailable + CAPEX_PARAMETERS_V1.epsilonUsd);
});

test("受入確認CC-2: 現金が最低現金準備額を下回る場合、設備投資可能額は0で、既存案件の支払もすべて見送られる（suspended/approvedのまま）", () => {
  const financeState = makeFinanceState({ cash: CAPEX_PARAMETERS_V1.minimumCashReserveUsd - 500_000 });
  const capexState = buildInitialCompanyCapexState("TEST");
  const decision = emptyCapexDecision({ newProjectProposals: [{ projectType: "qualityControlEquipment" }] });
  const output = closeWithCapex(financeState, makeFinancingState(), capexState, decision);
  assert.equal(output.capexQuarterResult.cashAvailableForCapexUsd, 0);
  assert.equal(output.capexQuarterResult.totalPaidThisQuarterUsd, 0);
  const project = output.nextCapexState.portfolio.projects[0];
  assert.equal(project.status, "approved");
  assert.equal(project.cumulativePaidUsd, 0);
});

// ---------------------------------------------------------------------
// 6. 会計（BS/CF/固定資産・CIP・減価償却除外）
// ---------------------------------------------------------------------

test("受入確認CC-3: 設備投資の現金支払は投資CF（investingCashFlow）のマイナスとして反映され、貸借・CF恒等式が成立する", () => {
  const financeState = makeFinanceState({ cash: 30_000_000 });
  const capexState = buildInitialCompanyCapexState("TEST");
  const decision = emptyCapexDecision({ newProjectProposals: [{ projectType: "qualityControlEquipment" }] });
  const output = closeWithCapex(financeState, makeFinancingState(), capexState, decision);
  assertThreeStatementIdentities(output.financeResult);
  assert.ok(output.capexQuarterResult.totalPaidThisQuarterUsd > 0, "初回分割払いが成功しているはず");
  assert.ok(Math.abs((output.financeResult.cashFlow.investingCashFlow as number) - -output.capexQuarterResult.totalPaidThisQuarterUsd) < EPS);
});

test("受入確認CC-4: 建設中（未完成）の案件の支払額はconstructionInProgressへ積み上がり、fixedAssetsGrossは変化しない", () => {
  const financeState = makeFinanceState({ cash: 30_000_000 });
  const capexState = buildInitialCompanyCapexState("TEST");
  const decision = emptyCapexDecision({ newProjectProposals: [{ projectType: "vapLineExpansion" }] }); // 4段階、1回では完成しない
  const output = closeWithCapex(financeState, makeFinancingState(), capexState, decision);
  assert.ok((output.financeResult.balanceSheet.constructionInProgress as number) > 0);
  assert.equal(output.nextFinanceState.fixedAssetsGross as number, financeState.fixedAssetsGross as number);
  assertThreeStatementIdentities(output.financeResult);
});

test("受入確認CC-5: 案件が完成すると、その全累計支払額がfixedAssetsGrossへ振替わり、constructionInProgressから消える", () => {
  const financeState = makeFinanceState({ cash: 30_000_000 });
  let capexState = buildInitialCompanyCapexState("TEST");
  const financingState = makeFinancingState();
  let decision = emptyCapexDecision({ newProjectProposals: [{ projectType: "coldStorageExpansion" }] }); // 2段階
  let finance = financeState;
  let p = P1;

  const first = closeWithCapex(finance, financingState, capexState, decision, HEALTHY_GATE, p);
  assert.ok((first.financeResult.balanceSheet.constructionInProgress as number) > 0);
  finance = first.nextFinanceState;
  capexState = first.nextCapexState;
  p = period(2015, 2);
  decision = emptyCapexDecision(); // 2回目以降は新規提案なし（既存案件が自動的に次の分割払いを試行する）

  const second = closeWithCapex(finance, financingState, capexState, decision, HEALTHY_GATE, p);
  const project = second.nextCapexState.portfolio.projects[0];
  assert.equal(project.status, "completed");
  assert.equal(second.capexQuarterResult.completedProjectsTransferUsd, project.capitalizedAmountUsd);
  assert.ok(Math.abs((second.financeResult.balanceSheet.constructionInProgress as number) - 0) < EPS);
  assert.ok(
    Math.abs((second.nextFinanceState.fixedAssetsGross as number) - ((finance.fixedAssetsGross as number) + (project.capitalizedAmountUsd as number))) < EPS
  );
  assertThreeStatementIdentities(second.financeResult);
});

test("受入確認CC-6: 完成直後の四半期でも、新規完成分は減価償却の対象にならない（レガシー資産分のみ減価償却される）", () => {
  const financeState = makeFinanceState({ cash: 30_000_000, fixedAssetsGross: 40_000_000 });
  let capexState = buildInitialCompanyCapexState("TEST");
  const financingState = makeFinancingState();
  let decision = emptyCapexDecision({ newProjectProposals: [{ projectType: "coldStorageExpansion" }] });
  let finance = financeState;
  let p = P1;

  const first = closeWithCapex(finance, financingState, capexState, decision, HEALTHY_GATE, p);
  finance = first.nextFinanceState;
  capexState = first.nextCapexState;
  p = period(2015, 2);
  decision = emptyCapexDecision();
  const second = closeWithCapex(finance, financingState, capexState, decision, HEALTHY_GATE, p); // 完成する四半期
  const completedProject = second.nextCapexState.portfolio.projects[0];
  assert.equal(completedProject.status, "completed");
  finance = second.nextFinanceState;
  capexState = second.nextCapexState;
  p = period(2015, 3);
  decision = emptyCapexDecision();

  // 完成の翌四半期（新規完成設備の減価償却が未開始であることを確認する四半期）。
  const third = closeWithCapex(finance, financingState, capexState, decision, HEALTHY_GATE, p);
  const legacyGross = (financeState.fixedAssetsGross as number) - (financeState.accumulatedDepreciation as number);
  // 【Phase 8B-2C】既存資産2区分（建物35%/機械65%）を、それぞれの推定残存耐用年数
  // （80四半期/32四半期）で定額償却した合計。
  const expectedDepreciation = computeExistingAssetDepreciationUsd(
    financeState.fixedAssetsGross as number,
    INITIAL_PERIOD_V2,
    p,
    FINANCE_PARAMETERS_V1
  ).totalUsd;
  const actualDepreciation = (third.financeResult.manufacturingCost.depreciationCost as number);
  // 既存資産分（当初のfixedAssetsGross、capex完成分を含まない）だけに既存資産の
  // 減価償却方式が適用される（新規completed資産はまだ稼働開始前で0）。
  assert.ok(Math.abs(actualDepreciation - Math.min(expectedDepreciation, legacyGross)) < EPS, `減価償却費 ${actualDepreciation} が期待値と不一致`);
  assertThreeStatementIdentities(third.financeResult);
});

// ---------------------------------------------------------------------
// 後方互換性（設備投資活動ゼロ時、Phase 8B-1経路との数値完全一致）
// ---------------------------------------------------------------------

test("受入確認CC-9: 設備投資案件が0件・新規提案も0件の場合、closeQuarterWithCapexの結果はPhase 8B-1のcloseQuarterWithFinancing単独実行の結果とPL/BS/CF全項目で完全一致する（三段クローズの後方互換性）", () => {
  const financeState = makeFinanceState({ cash: 30_000_000, fixedAssetsGross: 40_000_000, accumulatedDepreciation: 2_000_000 });
  const financingState = makeFinancingState();
  const emptyCapexState = buildInitialCompanyCapexState("TEST");
  const decision = emptyCapexDecision(); // 新規提案・取消・再開いずれも0件

  // 比較A: Phase 8B-1の既存経路（closeQuarterWithFinancing単独実行）。
  const pathA = closeFinancingOnly(financeState, financingState);

  // 比較B: Phase 8B-2Aのcapex統合経路（既存案件0件・新規提案0件・設備投資支払0・完成振替0）。
  const pathB = closeWithCapex(financeState, financingState, emptyCapexState, decision);

  // 設備投資活動が完全にゼロならPL/BS/CF・次期financeState全項目が厳密に一致する
  // （深い構造比較。個別フィールドの選び漏れが無いことを保証する）。
  assert.deepEqual(pathB.financeResult, pathA.financeResult, "financeResult(PL/BS/CF全項目)がPhase 8B-1単独経路と一致しない");
  assert.deepEqual(pathB.nextFinanceState, pathA.nextFinanceState, "nextFinanceStateがPhase 8B-1単独経路と一致しない（二重処理の疑い）");

  // 個別に明示確認（売掛金回収・買掛金支払・利息・元本返済・税金・減価償却・
  // 利益剰余金ロールフォワードのいずれも二重処理されていないことの直接検証）。
  assert.equal(pathB.financeResult.balanceSheet.cash as number, pathA.financeResult.balanceSheet.cash as number);
  assert.equal(pathB.financeResult.balanceSheet.accountsReceivable as number, pathA.financeResult.balanceSheet.accountsReceivable as number);
  assert.equal(pathB.financeResult.balanceSheet.accountsPayable as number, pathA.financeResult.balanceSheet.accountsPayable as number);
  assert.equal(pathB.financeResult.balanceSheet.rawMaterialInventory as number, pathA.financeResult.balanceSheet.rawMaterialInventory as number);
  assert.equal(pathB.financeResult.balanceSheet.finishedGoodsInventory as number, pathA.financeResult.balanceSheet.finishedGoodsInventory as number);
  assert.equal(pathB.financeResult.balanceSheet.fixedAssetsNet as number, pathA.financeResult.balanceSheet.fixedAssetsNet as number);
  assert.equal(pathB.financeResult.balanceSheet.constructionInProgress as number, 0);
  assert.equal(pathA.financeResult.balanceSheet.constructionInProgress as number, 0);
  assert.equal(pathB.financeResult.balanceSheet.shortTermLoans as number, pathA.financeResult.balanceSheet.shortTermLoans as number);
  assert.equal(pathB.financeResult.balanceSheet.longTermLoans as number, pathA.financeResult.balanceSheet.longTermLoans as number);
  assert.equal(pathB.financeResult.balanceSheet.accruedInterestPayable as number, pathA.financeResult.balanceSheet.accruedInterestPayable as number);
  assert.equal(pathB.financeResult.balanceSheet.retainedEarnings as number, pathA.financeResult.balanceSheet.retainedEarnings as number);
  assert.equal(pathB.financeResult.profitAndLoss.interestExpense as number, pathA.financeResult.profitAndLoss.interestExpense as number);
  assert.equal(pathB.financeResult.profitAndLoss.incomeTax as number, pathA.financeResult.profitAndLoss.incomeTax as number);
  assert.equal(pathB.financeResult.profitAndLoss.netIncome as number, pathA.financeResult.profitAndLoss.netIncome as number);
  assert.equal(pathB.financeResult.manufacturingCost.depreciationCost as number, pathA.financeResult.manufacturingCost.depreciationCost as number);
  assert.equal(pathB.financeResult.cashFlow.operatingCashFlow as number, pathA.financeResult.cashFlow.operatingCashFlow as number);
  assert.equal(pathB.financeResult.cashFlow.investingCashFlow as number, pathA.financeResult.cashFlow.investingCashFlow as number);
  assert.equal(pathB.financeResult.cashFlow.investingCashFlow as number, 0, "設備投資活動ゼロならCFIは0のはず");
  assert.equal(pathB.financeResult.cashFlow.financingCashFlow as number, pathA.financeResult.cashFlow.financingCashFlow as number);
  assert.equal(pathB.financeResult.cashFlow.closingCash as number, pathA.financeResult.cashFlow.closingCash as number);

  // capexQuarterResult自体も活動ゼロを明示する。
  assert.equal(pathB.capexQuarterResult.totalPaidThisQuarterUsd, 0);
  assert.equal(pathB.capexQuarterResult.completedProjectsTransferUsd, 0);
  assert.equal(pathB.capexQuarterResult.endingConstructionInProgressUsd, 0);
  assert.deepEqual(pathB.capexQuarterResult.rejectedProposals, []);
  assert.deepEqual(pathB.capexQuarterResult.events, []);

  assertThreeStatementIdentities(pathB.financeResult);
});

// ---------------------------------------------------------------------
// 複数案件（優先順位・提案上限の統合確認）
// ---------------------------------------------------------------------

test("受入確認CC-7: 同一四半期に複数の新規提案があっても、承認上限を超えた提案はrejectedProposalsへ理由つきで記録される", () => {
  const financeState = makeFinanceState({ cash: 100_000_000 });
  const capexState = buildInitialCompanyCapexState("TEST");
  const cap = CAPEX_PARAMETERS_V1.maxConcurrentActiveProjectsPerCompany;
  const proposals = Array.from({ length: cap + 2 }, () => ({ projectType: "qualityControlEquipment" as const }));
  const decision = emptyCapexDecision({ newProjectProposals: proposals });
  const output = closeWithCapex(financeState, makeFinancingState(), capexState, decision);
  const activeProjects = output.nextCapexState.portfolio.projects.filter((p) => p.status !== "cancelled");
  assert.ok(activeProjects.length <= cap, `承認された案件数 ${activeProjects.length} が上限 ${cap} を超えている`);
  assert.equal(output.capexQuarterResult.rejectedProposals.length, proposals.length - cap);
});

test("受入確認CC-8: 会社の資金繰り状態が重大な悪化（severelyDistressed）の場合、新規提案は全件拒否されるが既存の支払処理には影響しない", () => {
  const financeState = makeFinanceState({ cash: 30_000_000 });
  const capexState = buildInitialCompanyCapexState("TEST");
  const decision = emptyCapexDecision({ newProjectProposals: [{ projectType: "qualityControlEquipment" }] });
  const output = closeWithCapex(financeState, makeFinancingState(), capexState, decision, { borrowingCapacityFrozen: false, severelyDistressed: true });
  assert.equal(output.capexQuarterResult.rejectedProposals.length, 1);
  assert.equal(output.nextCapexState.portfolio.projects.length, 0);
  assert.equal(output.capexQuarterResult.totalPaidThisQuarterUsd, 0);
  assertThreeStatementIdentities(output.financeResult);
});

// ---------------------------------------------------------------------
// Phase 8B-2B: 稼働開始後の減価償却・固定保守費（closeQuarterWithCapexを通した統合確認）
// ---------------------------------------------------------------------
//
// CC-6の続き（coldStorageExpansion、標準予算$2.5M・2段階・readiness=1）を、
// 稼働開始四半期（2015Q4 = completedPeriod 2015Q2の翌期2015Q3 + readiness1）まで
// 進め、新規capex資産の減価償却・固定保守費が実際にfinance/へ接続されることを
// closeQuarterWithCapexの実行結果（CapexQuarterResult診断フィールド、finance
// 三表）の両方で確認する。

test("受入確認CC-10: 稼働開始四半期（operationalStartPeriod）に達すると、新規completed資産の定額法減価償却費・固定保守費が発生し、CapexQuarterResultにも反映される", () => {
  const financeState = makeFinanceState({ cash: 30_000_000, fixedAssetsGross: 40_000_000 });
  let capexState = buildInitialCompanyCapexState("TEST");
  const financingState = makeFinancingState();
  let decision = emptyCapexDecision({ newProjectProposals: [{ projectType: "coldStorageExpansion" }] });
  let finance = financeState;
  let p = P1; // 2015Q1: 提案・承認・初回支払

  const q1 = closeWithCapex(finance, financingState, capexState, decision, HEALTHY_GATE, p);
  finance = q1.nextFinanceState;
  capexState = q1.nextCapexState;
  p = period(2015, 2);
  decision = emptyCapexDecision();

  const q2 = closeWithCapex(finance, financingState, capexState, decision, HEALTHY_GATE, p); // 完成（completedPeriod=2015Q2）
  const completedProject = q2.nextCapexState.portfolio.projects[0];
  assert.equal(completedProject.status, "completed");
  assert.equal(completedProject.completedPeriod, period(2015, 2));
  const capitalizedAmountUsd = completedProject.capitalizedAmountUsd as number;
  assert.ok(Math.abs(capitalizedAmountUsd - 2_500_000) < EPS);
  finance = q2.nextFinanceState;
  capexState = q2.nextCapexState;
  p = period(2015, 3);
  decision = emptyCapexDecision();

  const q3 = closeWithCapex(finance, financingState, capexState, decision, HEALTHY_GATE, p); // まだ稼働開始前（readiness=1）
  assert.equal(q3.capexQuarterResult.capexAssetsDepreciationUsd, 0);
  assert.equal(q3.capexQuarterResult.capexMaintenanceCostUsd, 0);
  finance = q3.nextFinanceState;
  capexState = q3.nextCapexState;
  p = period(2015, 4);
  decision = emptyCapexDecision();

  const q4 = closeWithCapex(finance, financingState, capexState, decision, HEALTHY_GATE, p); // 稼働開始四半期
  const template = CAPEX_PARAMETERS_V1.templatesByType.coldStorageExpansion;
  const { building, machinery } = CAPEX_PARAMETERS_V1.componentUsefulLifeQuarters;
  // 【Phase 8B-2C】建物40%・機械60%（coldStorageExpansion）を、それぞれの
  // コンポーネント別耐用年数（建物100四半期・機械40四半期）で定額償却した合計。
  const expectedBuildingDepreciation = (capitalizedAmountUsd * template.buildingRatio) / building;
  const expectedMachineryDepreciation = (capitalizedAmountUsd * template.machineryRatio) / machinery;
  const expectedDepreciation = expectedBuildingDepreciation + expectedMachineryDepreciation;
  const expectedMaintenance = capitalizedAmountUsd * template.maintenanceRatePerQuarter;
  assert.ok(Math.abs(q4.capexQuarterResult.capexAssetsDepreciationUsd - expectedDepreciation) < EPS);
  assert.ok(Math.abs(q4.capexQuarterResult.capexAssetsBuildingDepreciationUsd - expectedBuildingDepreciation) < EPS);
  assert.ok(Math.abs(q4.capexQuarterResult.capexAssetsMachineryDepreciationUsd - expectedMachineryDepreciation) < EPS);
  assert.ok(Math.abs(q4.capexQuarterResult.capexMaintenanceCostUsd - expectedMaintenance) < EPS);
  // finance/の合算減価償却費（既存資産2区分＋新規capex）にも反映されている。
  const legacyGross = (financeState.fixedAssetsGross as number) - (financeState.accumulatedDepreciation as number);
  const existingAssetDepreciation = Math.min(
    computeExistingAssetDepreciationUsd(financeState.fixedAssetsGross as number, INITIAL_PERIOD_V2, p, FINANCE_PARAMETERS_V1).totalUsd,
    legacyGross
  );
  const actualCombinedDepreciation = q4.financeResult.manufacturingCost.depreciationCost as number;
  assert.ok(
    Math.abs(actualCombinedDepreciation - (existingAssetDepreciation + expectedDepreciation)) < EPS,
    `合算減価償却費 ${actualCombinedDepreciation} が 既存資産${existingAssetDepreciation}+新規${expectedDepreciation} と一致しない`
  );
  // 固定保守費はcostOfSales.capexMaintenanceCostとして独立計上される。
  assert.ok(Math.abs((q4.financeResult.profitAndLoss.costOfSales.capexMaintenanceCost as number) - expectedMaintenance) < EPS);
  assertThreeStatementIdentities(q4.financeResult);
});

test("受入確認CC-11: 建設中・停止中の案件は稼働開始効果を一切持たない（vapLineExpansion、4段階で1回目は資金不足によりsuspended）", () => {
  const financeState = makeFinanceState({ cash: 2_000_000 }); // 最低現金準備額を大きく下回るため支払は一切発生しない
  const capexState = buildInitialCompanyCapexState("TEST");
  const decision = emptyCapexDecision({ newProjectProposals: [{ projectType: "vapLineExpansion" }] });
  const output = closeWithCapex(financeState, makeFinancingState(), capexState, decision);
  const project = output.nextCapexState.portfolio.projects[0];
  assert.equal(project.status, "approved"); // 初回支払すら成功していないため着工前のまま
  assert.equal(output.capexQuarterResult.capexAssetsDepreciationUsd, 0);
  assert.equal(output.capexQuarterResult.capexMaintenanceCostUsd, 0);
});
