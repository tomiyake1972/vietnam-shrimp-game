// ShrimpX V2 — Decision Studio: 画面横断で共有する派生値（能力・処理見込み・投資計画等）
//
// 【この層がやること】旧DecisionEditor.tsxが1つのcomponent内で計算していた
// 派生値（buildCompanyProcessingCapacityViewModel・buildCompanyProcessingForecast・
// buildCompanyInvestmentPlanningViewModel・CAPEX候補・借入情報等）を、そのまま
// 同じ呼び出し順・同じ引数でここへ集約するだけの純粋関数。新しい計算式は
// 一切追加しない（既存の関数呼び出しをファイル間で再配置しただけ）。
//
// 【なぜ画面ごとに分けて計算しないか】buildCompanyInvestmentPlanningViewModel等は
// 計算コストのある1回の呼び出しで、Production（processingForecast・warnings・
// coldStorage）・Worker（workforceRows）・Investment（factorySpace・
// investmentCards）の3画面すべてが同じ結果を参照する。画面ごとに個別に
// 呼び出すと同じ計算を3重に行い、かつ将来ロジックが変わったときに画面間で
// 結果がずれる危険がある。DecisionStudio.tsxが1回だけ計算し、各画面へ
// 必要なsliceをpropsで渡す。

import { PeriodV2 } from "../../lib/v2/core/period";
import { unwrapUnit } from "../../lib/v2/core/units";
import { CompanyFixture, CompanyOwnState } from "../../lib/v2/companyLab";
import { CAPEX_PARAMETERS_V1, CapexProjectQuarterEvent } from "../../lib/v2/capex";
import { countProspectiveFactories } from "../../lib/v2/capex/factoryConstruction";
import { PD_MECHANIZATION_PARAMETERS_V1 } from "../../lib/v2/capex/pdMechanization";
import { buildPdMechanizationStatusByFactory } from "../../lib/v2/companyLab/pdMechanizationState";
import { CompanyFinancialQuarterResult } from "../../lib/v2/finance/types";
import { buildCompanyProcessingCapacityViewModel } from "./processingCapacityViewModel";
import { buildCompanyProcessingForecast } from "./processingForecastViewModel";
import { buildCompanyInvestmentPlanningViewModel } from "./investmentPlanningViewModel";
import { buildAllCapexCandidateViewModels, buildCapexPortfolioViewModel } from "./capexViewModel";
import { isNewFactoryConstructionBlockedByCap, newFactoryConstructionCapBlockedReason } from "./capexDraftActions";
import { buildDecisionInputFromDraft, CompanyDecisionDraft, summarizeSalesForceAllocation, summarizeSalesForceHiring } from "./decisionDraft";
import { computeMaxSalesHiresPerQuarter } from "../../lib/v2/companyLab/salesForceHiring";

export interface BuildDecisionStudioViewModelInput {
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly draft: CompanyDecisionDraft;
  readonly period: PeriodV2;
  readonly lastQuarterCapexEvents?: readonly CapexProjectQuarterEvent[];
  readonly lastQuarterFinancialResult?: CompanyFinancialQuarterResult | null;
}

/**
 * 旧DecisionEditor.tsxのrender本体冒頭にあった一連の派生値計算を、そのまま
 * 1つの純粋関数として切り出したもの。返り値の各fieldは元のローカル変数名と
 * 対応する（呼び出し側の意図を追いやすくするため）。
 */
export function buildDecisionStudioViewModel(input: BuildDecisionStudioViewModelInput) {
  const { fixture, ownState, draft, period, lastQuarterCapexEvents, lastQuarterFinancialResult } = input;

  const currentSalesForceHeadcount = ownState.salesForceHiringState.headcount;
  const salesForceAllocation = summarizeSalesForceAllocation(draft.salesPlans, currentSalesForceHeadcount);
  const salesForceHiring = summarizeSalesForceHiring(currentSalesForceHeadcount, draft.salesForceHireCount ?? 0, draft.salesForceLayoffCount ?? 0);
  const salesForceHireLimit = computeMaxSalesHiresPerQuarter(salesForceHiring.currentHeadcount);

  const rawMaterialInventory = ownState.rawMaterialLots
    .filter((l) => l.status === "available")
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
  const outstandingBacklog = ownState.contracts
    .filter((c) => c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue")
    .reduce((sum, c) => sum + unwrapUnit(c.outstandingQuantity), 0);

  const capacityViewModel = buildCompanyProcessingCapacityViewModel({
    companyId: fixture.companyId,
    baseFactories: fixture.factories,
    capexState: { companies: [ownState.capexState] },
    period,
    // 【ENG-FAC-1 read-path consistency】Engine・Standard AIと同じlifecycle stateを渡し、
    // 休止・売却済み工場の能力を画面へ表示しない（表示値の正本を1本にする）。
    factoryLifecycleState: ownState.factoryLifecycleState,
    params: CAPEX_PARAMETERS_V1,
  });
  const pendingCapacityTotalTons = Object.values(capacityViewModel.pendingTotalsByPool).reduce((sum, n) => sum + n, 0);

  const decisionInputForForecast = buildDecisionInputFromDraft(draft, fixture, period);

  const processingForecast = buildCompanyProcessingForecast({
    companyId: fixture.companyId,
    baseFactories: fixture.factories,
    capexState: { companies: [ownState.capexState] },
    period,
    factoryLifecycleState: ownState.factoryLifecycleState,
    productionPlans: decisionInputForForecast.productionPlans,
    workerAssignments: decisionInputForForecast.workerAssignments,
    rawMaterialLots: ownState.rawMaterialLots,
  });

  const planning = buildCompanyInvestmentPlanningViewModel({
    companyId: fixture.companyId,
    baseFactories: fixture.factories,
    capexState: { companies: [ownState.capexState] },
    period,
    factoryLifecycleState: ownState.factoryLifecycleState,
    productionPlans: decisionInputForForecast.productionPlans,
    workerAssignments: decisionInputForForecast.workerAssignments,
    workforceState: ownState.workforceState,
    rawMaterialLots: ownState.rawMaterialLots,
    finishedGoodsLots: ownState.finishedGoodsLots,
    lastQuarterFinancialResult,
    capexParams: CAPEX_PARAMETERS_V1,
  });

  const freezingPackagingPool = capacityViewModel.companyTotals.find((p) => p.poolKey === "freezingPackaging");
  const plannedFreezingProcessingTons = planning.forecast.rows.reduce((sum, r) => sum + r.forecastProcessedTons, 0);
  const coldStorageTemplate = CAPEX_PARAMETERS_V1.templatesByType.coldStorageExpansion;
  const coldStorageTonsPerProject = coldStorageTemplate.futureCapacityEffect.capacityIncreaseTonsPerQuarter ?? 0;
  const coldStorageInvestmentUsdPerTon = coldStorageTonsPerProject > 0 ? coldStorageTemplate.standardBudgetUsd / coldStorageTonsPerProject : undefined;

  const capexCandidates = buildAllCapexCandidateViewModels(period, CAPEX_PARAMETERS_V1);
  const lastQuarterCapexEventsByProjectId = new Map((lastQuarterCapexEvents ?? []).map((e) => [e.projectId, e]));
  const capexPortfolioRows = buildCapexPortfolioViewModel(ownState.capexState.portfolio.projects, CAPEX_PARAMETERS_V1, period, lastQuarterCapexEventsByProjectId);
  const capexCandidateBudgetByType = (projectType: (typeof capexCandidates)[number]["projectType"], requestedBudgetUsd: number | undefined) =>
    requestedBudgetUsd ?? CAPEX_PARAMETERS_V1.templatesByType[projectType].standardBudgetUsd;
  const capexDraftThisQuarterPaymentUsd = draft.capexDecision.newProjectProposals.reduce((sum, p) => {
    const template = CAPEX_PARAMETERS_V1.templatesByType[p.projectType];
    const budget = capexCandidateBudgetByType(p.projectType, p.requestedBudgetUsd);
    return sum + budget * (template.paymentRatios[0] ?? 0);
  }, 0);
  const currentCashUsd = ownState.financeState.cash as number;

  const existingLoans = ownState.financingState.loanPortfolio.loans.filter((l) => l.status !== "closed");
  const existingLoanBalanceUsd = existingLoans.reduce((sum, l) => sum + l.currentPrincipalUsd, 0);
  const accruedInterestPayableUsd = ownState.financingState.accruedInterestPayableUsd;

  const newFactoryConstructionBlocked = isNewFactoryConstructionBlockedByCap(draft, fixture.factories.length, ownState.capexState.portfolio.projects);
  const newFactoryConstructionDraftPendingCount = draft.capexDecision.newProjectProposals.filter((p) => p.projectType === "newFactoryConstruction").length;
  const investmentCardExtraBlockedReason = (projectType: (typeof capexCandidates)[number]["projectType"]): string | undefined => {
    if (projectType !== "newFactoryConstruction") return undefined;
    return newFactoryConstructionBlocked
      ? newFactoryConstructionCapBlockedReason(fixture.factories.length, ownState.capexState.portfolio.projects, newFactoryConstructionDraftPendingCount)
      : undefined;
  };
  const prospectiveFactoryCount = countProspectiveFactories(fixture.factories.length, ownState.capexState.portfolio.projects) + newFactoryConstructionDraftPendingCount;

  const ownPdMechanizationStateForStatus = {
    entries: ownState.pdUtilizationByFactory.map((e) => ({
      factoryId: e.factoryId,
      companyId: fixture.companyId,
      previousQuarterPdUtilization: e.previousQuarterPdUtilization,
    })),
  };
  const pdMechanizationStatusByFactory = buildPdMechanizationStatusByFactory(
    { companies: [ownState.capexState] },
    ownPdMechanizationStateForStatus,
    period,
    PD_MECHANIZATION_PARAMETERS_V1
  );

  return {
    currentSalesForceHeadcount,
    salesForceAllocation,
    salesForceHiring,
    salesForceHireLimit,
    rawMaterialInventory,
    outstandingBacklog,
    capacityViewModel,
    pendingCapacityTotalTons,
    decisionInputForForecast,
    processingForecast,
    planning,
    freezingPackagingPool,
    plannedFreezingProcessingTons,
    coldStorageInvestmentUsdPerTon,
    capexCandidates,
    capexPortfolioRows,
    capexCandidateBudgetByType,
    capexDraftThisQuarterPaymentUsd,
    currentCashUsd,
    existingLoans,
    existingLoanBalanceUsd,
    accruedInterestPayableUsd,
    newFactoryConstructionBlocked,
    newFactoryConstructionDraftPendingCount,
    investmentCardExtraBlockedReason,
    prospectiveFactoryCount,
    pdMechanizationStatusByFactory,
  };
}

export type DecisionStudioViewModel = ReturnType<typeof buildDecisionStudioViewModel>;
