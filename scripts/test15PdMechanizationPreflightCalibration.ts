// ShrimpX V2 — Test15前 PD省人化投資 プリフライト校正（Phase5・診断専用スクリプト）
//
// 【本スクリプトの位置づけ（重要）】
//   これは診断専用スクリプトであり、ゲーム本体の共有デフォルトパラメータ
//   （production/parameters.ts・capex/parameters.ts等）を一切変更しない。
//   高稼働率帯を作るための需要下限（PD floor）・現金付与（診断用感応度分析の
//   みで使用）は、すべてこのスクリプト内のシナリオ構築（BAL固有の意思決定
//   上書き・診断用初期現金付与）としてのみ存在し、通常プレイの意思決定・
//   初期状態には一切影響しない（他の4社・他の会社ラボ呼び出し元は一切
//   触れていない）。
//
//   通常ゲーム条件（variant A）と診断用感応度分析（variant B、両ケースへ同一の
//   現金付与を行う）は、出力・レポートの両方で明確に区別してラベル付けする。
//
// 【方法論】
//   Test15前の前回ラウンドで、単一seed・単一floor（PD処理能力の5%）による
//   pdMechanizationOff/On比較を行い、実測PD稼働率が比較窓平均33%程度に
//   留まること（現金制約が要因）を確認した。本スクリプトはこれを体系的な
//   マッチドペア研究へ拡張する:
//     - 3つ以上のseedで、mechanization off/onのマッチドペアを構築する
//       （同一会社・同一初期状態・同一seed・同一市場条件・同一需要条件・
//       同一生産/販売方針。唯一の違いはPD省人化投資案件の有無）。
//     - 目標PD稼働率帯（実測、稼働開始後の実生産量÷実処理能力で測定。
//       希望量ベースではない）約30/50/70/90%それぞれについて、
//       稼働開始後少なくとも4四半期の比較窓を確保する。
//     - 通常ゲーム条件で目標帯に届かない場合は、A（通常ゲーム条件・実際に
//       到達できた稼働率をそのまま報告）とB（診断用感応度分析・off/on両方へ
//       同一の追加流動性を付与し、投資採算性を現金制約から切り離して観察する）
//       の両方を明示的にラベル分けして報告する。

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../app/lib/v2/companyLab/autoPolicy";
import { CompanyDecisionInput, CompanyLabState, CompanyQuarterRecord } from "../app/lib/v2/companyLab/types";
import { buildPdCoefficientOverridesByFactory } from "../app/lib/v2/companyLab/pdMechanizationState";
import { computeEffectiveFactories } from "../app/lib/v2/capex/factoryConstruction";
import { CompanyId } from "../app/lib/v2/sales/types";
import { extractCompanyFinancialResult } from "../app/v2/company-lab/play/_lib/financialViewSelectors";
import { computeEffectivePdCoefficient, PD_MECHANIZATION_PARAMETERS_V1 } from "../app/lib/v2/capex/pdMechanization";
import { CAPEX_PARAMETERS_V1 } from "../app/lib/v2/capex/parameters";
import { calculateFactoryEffectiveCapacity } from "../app/lib/v2/production/capacity";
import { effectiveEfficiencyPerHeadTons, requiredHeadcountForQuantity } from "../app/lib/v2/production/labor";
import { PRODUCTION_PARAMETERS_V1 } from "../app/lib/v2/production/parameters";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { usd } from "../app/lib/v2/finance/types";
import { FINANCE_PARAMETERS_V1 } from "../app/lib/v2/finance/parameters";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const FOCUS_COMPANY_ID = "BAL";
const DEFAULT_HORIZON_QUARTERS = 8;

export const SEEDS: readonly string[] = [
  "test15-preflight-seed-1",
  "test15-preflight-seed-2",
  "test15-preflight-seed-3",
];

export const UTILIZATION_BANDS: readonly number[] = [0.3, 0.5, 0.7, 0.9];

/**
 * 【診断用のみ】variant Bで両ケースへ同一に付与する追加流動性（BALの当期首現金へ
 * 一括加算）。通常プレイの資金繰り・借入判断とは無関係の、このスクリプトの中だけで
 * 完結する診断用の現金付与であり、ゲーム本体の初期状態生成関数（buildInitialCompanyFinanceState等）
 * は一切変更しない。off/on両ケースへ完全に同一額を、同一タイミング（turn1開始前）で
 * 付与するため、投資の有無以外の条件は依然として揃っている。
 */
const DIAGNOSTIC_CASH_GRANT_USD = 20_000_000;

// ---------------------------------------------------------------------
// 1. 診断用シナリオ構築ヘルパー（このスクリプト内だけで完結。共有デフォルトへは書き込まない）
// ---------------------------------------------------------------------

/** BALの当期首現金へ、診断用の追加流動性を一括加算した新しいCompanyLabStateを返す（純関数、副作用なし）。 */
function applyDiagnosticCashGrant(state: CompanyLabState, companyId: string, amountUsd: number): CompanyLabState {
  if (amountUsd === 0) return state;
  return {
    ...state,
    financeState: {
      ...state.financeState,
      companies: state.financeState.companies.map((c) =>
        c.companyId === companyId ? { ...c, cash: usd((c.cash as unknown as number) + amountUsd) } : c
      ),
    },
  };
}

/**
 * 【比較Bのfloor注入と同じ趣旨・develop/v2統合Required fix A-2の教訓を踏襲】
 * PD生産計画の希望量に下限を設定し、追加調達分の原料はエンジン本体の歩留まり式
 * （saleableRecoveryRatio）で換算する（粗い1:1近似を作らない）。
 */
function applyPdDemandFloor(decision: CompanyDecisionInput, floorByFactory: ReadonlyMap<string, number>): CompanyDecisionInput {
  const touchedFactoryIds = new Set<string>();
  const updatedExisting = decision.productionPlans.map((p) => {
    if (p.product !== "pd") return p;
    const floor = floorByFactory.get(p.factoryId);
    if (floor === undefined) return p;
    touchedFactoryIds.add(p.factoryId);
    const desired = p.desiredQuantity as unknown as number;
    return desired < floor ? { ...p, desiredQuantity: floor as unknown as typeof p.desiredQuantity, priority: 1 } : p;
  });
  const insertedRows = Array.from(floorByFactory.entries())
    .filter(([factoryId]) => !touchedFactoryIds.has(factoryId))
    .map(([factoryId, floor]) => ({
      companyId: decision.companyId,
      factoryId,
      product: "pd" as const,
      desiredQuantity: floor as unknown as CompanyDecisionInput["productionPlans"][number]["desiredQuantity"],
      priority: 1,
    }));
  const totalAddedPdFloor = Array.from(floorByFactory.values()).reduce((s, v) => s + v, 0);
  const pdSaleableRecoveryRatio = PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio.pd;
  const totalAddedRawMaterialRequired = totalAddedPdFloor > 0 ? totalAddedPdFloor / pdSaleableRecoveryRatio : 0;
  const domesticPurchasePlan =
    totalAddedRawMaterialRequired > 0
      ? {
          ...decision.domesticPurchasePlan,
          desiredQuantity: ((decision.domesticPurchasePlan.desiredQuantity as unknown as number) + totalAddedRawMaterialRequired) as unknown as CompanyDecisionInput["domesticPurchasePlan"]["desiredQuantity"],
        }
      : decision.domesticPurchasePlan;
  return { ...decision, productionPlans: [...updatedExisting, ...insertedRows], domesticPurchasePlan };
}

// ---------------------------------------------------------------------
// 2. 1ケースぶんのシミュレーション（実エンジンを通す。並行計算式を作らない）
// ---------------------------------------------------------------------

export interface QuarterMetricsRow {
  readonly scenarioLabel: string;
  readonly variant: "A" | "B";
  readonly band: number;
  readonly seed: string;
  readonly companyId: string;
  readonly quarter: number;
  readonly factoryId: string;
  readonly mechanizationOn: boolean;
  readonly diagnosticCashGrantUsd: number;
  readonly pdPlannedQuantityTons: number;
  readonly pdActualQuantityTons: number;
  readonly pdCapacityTons: number;
  readonly pdUtilizationRate: number;
  readonly requiredWorkers: number;
  readonly allocatedRegularWorkers: number;
  readonly allocatedTemporaryWorkers: number;
  readonly workerShortage: number;
  readonly overtimeRate: number;
  readonly regularLaborCostUsd: number;
  readonly temporaryLaborCostUsd: number;
  readonly overtimeCostUsd: number;
  readonly mechanizationPaymentUsd: number;
  readonly maintenanceCostUsd: number;
  readonly depreciationCostUsd: number;
  readonly operatingIncomeUsd: number;
  readonly netIncomeUsd: number;
  readonly operatingCashFlowUsd: number;
  readonly investingCashFlowUsd: number;
  readonly cashUsd: number;
  readonly borrowingUsd: number;
  readonly insolvent: boolean;
}

export interface CaseRunOptions {
  readonly seed: string;
  readonly mechanizationOn: boolean;
  readonly pdFloorMultiplier: number;
  readonly horizonQuarters: number;
  readonly diagnosticCashGrantUsd: number;
  readonly variant: "A" | "B";
  readonly band: number;
  readonly scenarioLabel: string;
}

export function runMatchedPairCase(options: CaseRunOptions): readonly QuarterMetricsRow[] {
  const config = { scenarioId: "baseline" as const, mode: "canonical" as const, seed: options.seed, turns: options.horizonQuarters };
  const { state: initialState, fixtures } = initializeCompanyLab(config);
  const focusFixture = fixtures.find((f) => f.companyId === FOCUS_COMPANY_ID)!;
  const targetFactoryId = focusFixture.factories[0].factoryId;
  const pdCapacityBaselineTons = focusFixture.factories[0].pdCapacity as unknown as number;
  const pdDemandFloor = new Map<string, number>([[targetFactoryId, pdCapacityBaselineTons * options.pdFloorMultiplier]]);

  let state: CompanyLabState = applyDiagnosticCashGrant(initialState, FOCUS_COMPANY_ID, options.diagnosticCashGrantUsd);
  const rows: QuarterMetricsRow[] = [];

  for (let turn = 0; turn < options.horizonQuarters; turn++) {
    if (state.isComplete) break;
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<CompanyId, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      const ownState = buildCompanyOwnState(state, f);
      let decision = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
      if (f.companyId === FOCUS_COMPANY_ID) {
        if (turn === 0 && options.mechanizationOn) {
          decision = {
            ...decision,
            capexDecision: {
              ...decision.capexDecision,
              newProjectProposals: [
                ...decision.capexDecision.newProjectProposals,
                { projectType: "pdMechanization" as const, targetFactoryId },
              ],
            },
          };
        }
        const suspendedProjectIds = ownState.capexState.portfolio.projects.filter((p) => p.status === "suspended").map((p) => p.projectId);
        if (suspendedProjectIds.length > 0) {
          decision = {
            ...decision,
            capexDecision: { ...decision.capexDecision, resumeRequests: suspendedProjectIds.map((projectId) => ({ projectId })) },
          };
        }
        decision = applyPdDemandFloor(decision, pdDemandFloor);
      }
      decisions[f.companyId] = decision;
    }

    const balDecisionForQuarter = decisions[FOCUS_COMPANY_ID];
    const baseFactoriesForQuarter = fixtures.flatMap((f) => f.factories);
    const effectiveFactoriesForQuarter = computeEffectiveFactories(baseFactoriesForQuarter, state.capexState, state.currentPeriod);
    const pdCoefficientOverrideByFactoryIdForQuarter = buildPdCoefficientOverridesByFactory(state.capexState, state.pdMechanizationState, state.currentPeriod);

    const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record: CompanyQuarterRecord = nextState.history[nextState.history.length - 1];
    const financial = extractCompanyFinancialResult(record, FOCUS_COMPANY_ID);
    const capexResult = record.capexResults.find((c) => c.companyId === FOCUS_COMPANY_ID) ?? null;

    const targetFactoryEffective = effectiveFactoriesForQuarter.find((f) => f.factoryId === targetFactoryId);
    const pdCapacityTons = targetFactoryEffective ? unwrapUnit(calculateFactoryEffectiveCapacity(targetFactoryEffective).pd) : 0;
    const pdEntry = record.productionAllocation.entries.find((e) => e.factoryId === targetFactoryId && e.product === "pd");
    const pdPlannedQuantityTons = pdEntry ? unwrapUnit(pdEntry.desiredQuantity) : 0;
    const pdActualQuantityTons = record.batches
      .filter((b) => b.factoryId === targetFactoryId && b.product === "pd")
      .reduce((sum, b) => sum + unwrapUnit(b.finishedGoodsQuantity), 0);
    const pdUtilizationRate = nextState.pdMechanizationState?.entries.find((e) => e.factoryId === targetFactoryId)?.previousQuarterPdUtilization ?? 0;

    const workerAssignment = balDecisionForQuarter.workerAssignments.find((w) => w.factoryId === targetFactoryId);
    const skillEntry = workerAssignment?.skills.find((s) => s.product === "pd");
    const skillLevel = skillEntry ? unwrapUnit(skillEntry.skillLevel) : 0;
    const coefficientOverride = pdCoefficientOverrideByFactoryIdForQuarter.get(targetFactoryId);
    const effectiveEfficiencyPerHead = effectiveEfficiencyPerHeadTons(PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons, "pd", PRODUCTION_PARAMETERS_V1, coefficientOverride);
    const requiredWorkers =
      workerAssignment && pdPlannedQuantityTons > 0
        ? requiredHeadcountForQuantity(
            pdPlannedQuantityTons,
            effectiveEfficiencyPerHead,
            unwrapUnit(workerAssignment.attendanceRate),
            skillLevel,
            unwrapUnit(workerAssignment.overtimeRate)
          )
        : 0;
    const allocatedRegularWorkers = pdEntry ? pdEntry.labor.assignedRegularHeadcount : 0;
    const allocatedTemporaryWorkers = pdEntry ? pdEntry.labor.assignedTemporaryHeadcount : 0;

    rows.push({
      scenarioLabel: options.scenarioLabel,
      variant: options.variant,
      band: options.band,
      seed: options.seed,
      companyId: FOCUS_COMPANY_ID,
      quarter: record.turn,
      factoryId: targetFactoryId,
      mechanizationOn: options.mechanizationOn,
      diagnosticCashGrantUsd: options.diagnosticCashGrantUsd,
      pdPlannedQuantityTons,
      pdActualQuantityTons,
      pdCapacityTons,
      pdUtilizationRate,
      requiredWorkers,
      allocatedRegularWorkers,
      allocatedTemporaryWorkers,
      workerShortage: Math.max(0, requiredWorkers - (allocatedRegularWorkers + allocatedTemporaryWorkers)),
      overtimeRate: pdEntry ? unwrapUnit(pdEntry.labor.appliedOvertimeRate) : 0,
      regularLaborCostUsd: financial ? (financial.manufacturingCost.regularLaborCost as unknown as number) : 0,
      temporaryLaborCostUsd: financial ? (financial.manufacturingCost.temporaryWorkerCost as unknown as number) : 0,
      overtimeCostUsd: financial ? (financial.manufacturingCost.overtimeCost as unknown as number) : 0,
      mechanizationPaymentUsd: capexResult ? capexResult.totalPaidThisQuarterUsd : 0,
      maintenanceCostUsd: capexResult ? capexResult.capexMaintenanceCostUsd : 0,
      depreciationCostUsd: capexResult ? capexResult.capexAssetsDepreciationUsd : 0,
      operatingIncomeUsd: financial ? (financial.profitAndLoss.operatingProfit as unknown as number) : 0,
      netIncomeUsd: financial ? (financial.profitAndLoss.netIncome as unknown as number) : 0,
      operatingCashFlowUsd: financial ? (financial.cashFlow.operatingCashFlow as unknown as number) : 0,
      investingCashFlowUsd: financial ? (financial.cashFlow.investingCashFlow as unknown as number) : 0,
      cashUsd: financial ? (financial.balanceSheet.cash as unknown as number) : 0,
      borrowingUsd: financial
        ? (financial.balanceSheet.shortTermLoans as unknown as number) + (financial.balanceSheet.longTermLoans as unknown as number)
        : 0,
      insolvent: financial ? financial.negativeEquity || financial.cashShortfall : false,
    });
    state = nextState;
  }

  return rows;
}

// ---------------------------------------------------------------------
// 3. floor倍率の校正（グリッドサーチ、offケースで探索。実測稼働率＝実生産÷実能力）
// ---------------------------------------------------------------------

const CANDIDATE_FLOOR_MULTIPLIERS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];

/**
 * 稼働開始（ターン4想定）後の固定4四半期窓（[windowStartQuarter, windowStartQuarter+3]）に
 * おける実測PD稼働率の単純平均。窓の外（崩壊後の四半期を含む）は平均に含めない
 * （固定窓にすることで、後続四半期の原料枯渇による崩壊が校正探索を歪めるのを防ぐ）。
 */
function averageUtilizationInWindow(rows: readonly QuarterMetricsRow[], windowStartQuarter: number): number {
  const windowEndQuarter = windowStartQuarter + 3;
  const windowRows = rows.filter((r) => r.quarter >= windowStartQuarter && r.quarter <= windowEndQuarter);
  if (windowRows.length === 0) return 0;
  return windowRows.reduce((sum, r) => sum + r.pdUtilizationRate, 0) / windowRows.length;
}

export interface CalibrationResult {
  readonly floorMultiplier: number;
  readonly achievedUtilization: number;
  readonly windowQuarterCount: number;
}

/**
 * offケース（capex支払競合が無いため、floorが実際にどこまで生産へ反映されるかの
 * 純粋な上限を測れる）でグリッドサーチし、windowStartQuarter以降の実測PD稼働率が
 * targetBandに最も近いfloor倍率を選ぶ。
 */
function calibrateFloorMultiplier(
  seed: string,
  targetBand: number,
  horizonQuarters: number,
  windowStartQuarter: number,
  diagnosticCashGrantUsd: number
): CalibrationResult {
  let best: CalibrationResult = { floorMultiplier: CANDIDATE_FLOOR_MULTIPLIERS[0], achievedUtilization: 0, windowQuarterCount: 0 };
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const multiplier of CANDIDATE_FLOOR_MULTIPLIERS) {
    const rows = runMatchedPairCase({
      seed,
      mechanizationOn: false,
      pdFloorMultiplier: multiplier,
      horizonQuarters,
      diagnosticCashGrantUsd,
      variant: diagnosticCashGrantUsd > 0 ? "B" : "A",
      band: targetBand,
      scenarioLabel: "calibration-probe",
    });
    const windowRows = rows.filter((r) => r.quarter >= windowStartQuarter && r.quarter <= windowStartQuarter + 3);
    const achieved = averageUtilizationInWindow(rows, windowStartQuarter);
    const diff = Math.abs(achieved - targetBand);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { floorMultiplier: multiplier, achievedUtilization: achieved, windowQuarterCount: windowRows.length };
    }
  }
  return best;
}

// ---------------------------------------------------------------------
// 4. 全体オーケストレーション
// ---------------------------------------------------------------------

export interface BandResult {
  readonly seed: string;
  readonly band: number;
  readonly variant: "A" | "B";
  readonly floorMultiplier: number;
  readonly diagnosticCashGrantUsd: number;
  readonly achievedAvgUtilizationOff: number;
  readonly achievedAvgUtilizationOn: number;
  readonly windowStartQuarter: number;
  readonly windowQuarterCount: number;
  readonly rowsOff: readonly QuarterMetricsRow[];
  readonly rowsOn: readonly QuarterMetricsRow[];
}

const WINDOW_START_QUARTER = 4; // 稼働開始想定（提案からおおむね4四半期目）の四半期から4四半期分の固定窓

export function runFullStudy(): readonly BandResult[] {
  const results: BandResult[] = [];
  for (const seed of SEEDS) {
    for (const band of UTILIZATION_BANDS) {
      // --- variant A: 通常ゲーム条件（診断用現金付与なし） ---
      const calibA = calibrateFloorMultiplier(seed, band, DEFAULT_HORIZON_QUARTERS, WINDOW_START_QUARTER, 0);
      const rowsOffA = runMatchedPairCase({
        seed,
        mechanizationOn: false,
        pdFloorMultiplier: calibA.floorMultiplier,
        horizonQuarters: DEFAULT_HORIZON_QUARTERS,
        diagnosticCashGrantUsd: 0,
        variant: "A",
        band,
        scenarioLabel: `A-band${Math.round(band * 100)}-off`,
      });
      const rowsOnA = runMatchedPairCase({
        seed,
        mechanizationOn: true,
        pdFloorMultiplier: calibA.floorMultiplier,
        horizonQuarters: DEFAULT_HORIZON_QUARTERS,
        diagnosticCashGrantUsd: 0,
        variant: "A",
        band,
        scenarioLabel: `A-band${Math.round(band * 100)}-on`,
      });
      results.push({
        seed,
        band,
        variant: "A",
        floorMultiplier: calibA.floorMultiplier,
        diagnosticCashGrantUsd: 0,
        achievedAvgUtilizationOff: averageUtilizationInWindow(rowsOffA, WINDOW_START_QUARTER),
        achievedAvgUtilizationOn: averageUtilizationInWindow(rowsOnA, WINDOW_START_QUARTER),
        windowStartQuarter: WINDOW_START_QUARTER,
        windowQuarterCount: rowsOffA.filter((r) => r.quarter >= WINDOW_START_QUARTER && r.quarter <= WINDOW_START_QUARTER + 3).length,
        rowsOff: rowsOffA,
        rowsOn: rowsOnA,
      });

      // --- variant B: 診断用感応度分析（off/on両方へ同一の追加流動性を付与） ---
      const calibB = calibrateFloorMultiplier(seed, band, DEFAULT_HORIZON_QUARTERS, WINDOW_START_QUARTER, DIAGNOSTIC_CASH_GRANT_USD);
      const rowsOffB = runMatchedPairCase({
        seed,
        mechanizationOn: false,
        pdFloorMultiplier: calibB.floorMultiplier,
        horizonQuarters: DEFAULT_HORIZON_QUARTERS,
        diagnosticCashGrantUsd: DIAGNOSTIC_CASH_GRANT_USD,
        variant: "B",
        band,
        scenarioLabel: `B-band${Math.round(band * 100)}-off`,
      });
      const rowsOnB = runMatchedPairCase({
        seed,
        mechanizationOn: true,
        pdFloorMultiplier: calibB.floorMultiplier,
        horizonQuarters: DEFAULT_HORIZON_QUARTERS,
        diagnosticCashGrantUsd: DIAGNOSTIC_CASH_GRANT_USD,
        variant: "B",
        band,
        scenarioLabel: `B-band${Math.round(band * 100)}-on`,
      });
      results.push({
        seed,
        band,
        variant: "B",
        floorMultiplier: calibB.floorMultiplier,
        diagnosticCashGrantUsd: DIAGNOSTIC_CASH_GRANT_USD,
        achievedAvgUtilizationOff: averageUtilizationInWindow(rowsOffB, WINDOW_START_QUARTER),
        achievedAvgUtilizationOn: averageUtilizationInWindow(rowsOnB, WINDOW_START_QUARTER),
        windowStartQuarter: WINDOW_START_QUARTER,
        windowQuarterCount: rowsOffB.filter((r) => r.quarter >= WINDOW_START_QUARTER && r.quarter <= WINDOW_START_QUARTER + 3).length,
        rowsOff: rowsOffB,
        rowsOn: rowsOnB,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------
// 5. break-even分析（実際のコード係数から導出。シミュレーション出力ではなく
//    parameters.ts/pdMechanization.ts/capex/parameters.tsの値そのものを使う）
// ---------------------------------------------------------------------

export interface BreakEvenAnalysis {
  readonly standardBudgetUsd: number;
  readonly quarterlyMaintenanceUsd: number;
  readonly quarterlyDepreciationUsd: number;
  readonly quarterlyMaintenancePlusDepreciationUsd: number;
  readonly baseCoefficient: number;
  readonly floorCoefficient: number;
  readonly maxReductionRatioAtFullMaturity: number;
  readonly regularEfficiencyPerHeadTons: number;
  readonly regularWorkerSalaryUsdPerQuarter: number;
  readonly overtimePremiumFactor: number;
  /** 保守費のみ（現金コスト）を回収するのに必要な、機械化による節約Worker換算人数（=保守費÷賃金）。 */
  readonly headsNeededToOffsetMaintenanceCashOnly: number;
  /** 保守費＋減価償却費（会計コスト）を回収するのに必要な、節約Worker換算人数。 */
  readonly headsNeededToOffsetMaintenancePlusDepreciation: number;
  /** 上記をPD省人化の最大削減率(16.67%)で逆算した、必要なPD配置Worker数（フル習熟・100%稼働時）。 */
  readonly pdHeadcountNeededAtFullMaturityForMaintenanceCashOnly: number;
  readonly pdHeadcountNeededAtFullMaturityForFullAccountingCost: number;
}

/**
 * PD省人化投資の会計・現金ベースの損益分岐点を、シミュレーションではなく
 * capex/pdMechanization.ts・capex/parameters.ts・production/parameters.ts・
 * finance/parameters.tsの実際の係数から算出する（推定・仮定の賃金値は使わず、
 * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarterをそのまま使う）。
 *
 * 【重要な構造的事実（コード読解で確認）】finance/quarterClose.tsの
 * regularLaborCostは「会社全体のregularHeadcount×1人あたり四半期給与」であり、
 * 稼働率・配属状況に一切依存しない（未配属・遊休でも同額発生する。
 * feature/v2-idle-labor-costのidleLaborCostはこの総額を按分するだけで、
 * 総額そのものは変えない）。したがって、PD省人化投資が実際にP&Lを改善する
 * 経路は次の2つに限られる:
 *   (a) 残業費の削減（同じ生産量をより少ない残業で賄えるようになる）。
 *   (b) 常用Workerを実際に削減（レイオフ）した場合の賃金総額そのものの減少。
 * 「必要人数が減ったのに人員を減らさない」場合、遊休化するだけで賃金は
 * 一切減らない（idleLaborCostとして可視化されるだけ）。
 */
export function computeBreakEvenAnalysis(): BreakEvenAnalysis {
  const template = CAPEX_PARAMETERS_V1.templatesByType.pdMechanization;
  const standardBudgetUsd = template.standardBudgetUsd;
  const quarterlyMaintenanceUsd = standardBudgetUsd * template.maintenanceRatePerQuarter;
  const quarterlyDepreciationUsd =
    (standardBudgetUsd * template.buildingRatio) / CAPEX_PARAMETERS_V1.componentUsefulLifeQuarters.building +
    (standardBudgetUsd * template.machineryRatio) / CAPEX_PARAMETERS_V1.componentUsefulLifeQuarters.machinery;
  const quarterlyMaintenancePlusDepreciationUsd = quarterlyMaintenanceUsd + quarterlyDepreciationUsd;

  const regularWorkerSalaryUsdPerQuarter = FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter;
  const overtimePremiumFactor = FINANCE_PARAMETERS_V1.labor.overtimePremiumFactor;
  // 残業費削減で回収する場合の等価コスト（overtimeCost = 労務相当量×賃金×割増率のため、
  // 1人相当ぶんの残業削減の価値 = 賃金×割増率）。
  const overtimeEquivalentValuePerHeadUsd = regularWorkerSalaryUsdPerQuarter * overtimePremiumFactor;
  const headsNeededToOffsetMaintenanceCashOnly = quarterlyMaintenanceUsd / overtimeEquivalentValuePerHeadUsd;
  const headsNeededToOffsetMaintenancePlusDepreciation = quarterlyMaintenancePlusDepreciationUsd / overtimeEquivalentValuePerHeadUsd;

  const maxReductionRatioAtFullMaturity = 1 - PD_MECHANIZATION_PARAMETERS_V1.floorCoefficient / PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient;
  const pdHeadcountNeededAtFullMaturityForMaintenanceCashOnly = headsNeededToOffsetMaintenanceCashOnly / maxReductionRatioAtFullMaturity;
  const pdHeadcountNeededAtFullMaturityForFullAccountingCost = headsNeededToOffsetMaintenancePlusDepreciation / maxReductionRatioAtFullMaturity;

  return {
    standardBudgetUsd,
    quarterlyMaintenanceUsd,
    quarterlyDepreciationUsd,
    quarterlyMaintenancePlusDepreciationUsd,
    baseCoefficient: PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient,
    floorCoefficient: PD_MECHANIZATION_PARAMETERS_V1.floorCoefficient,
    maxReductionRatioAtFullMaturity,
    regularEfficiencyPerHeadTons: PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons,
    regularWorkerSalaryUsdPerQuarter,
    overtimePremiumFactor,
    headsNeededToOffsetMaintenanceCashOnly,
    headsNeededToOffsetMaintenancePlusDepreciation,
    pdHeadcountNeededAtFullMaturityForMaintenanceCashOnly,
    pdHeadcountNeededAtFullMaturityForFullAccountingCost,
  };
}

/**
 * ある四半期のPD生産量（HOSO換算トン）に対し、機械化前後で必要な常用Worker数が
 * どれだけ変わるかを、production/labor.tsのrequiredHeadcountForQuantity・
 * effectiveEfficiencyPerHeadTons・capex/pdMechanization.tsのcomputeEffectivePdCoefficient
 * そのもので算出する（新しい計算式を作らない）。
 */
export function computeWorkerReductionForQuantity(
  pdQuantityTons: number,
  attendanceRate: number,
  skillLevel: number,
  overtimeRate: number,
  mechanizationLevel: number
): { readonly requiredBefore: number; readonly requiredAtLevel: number; readonly reduction: number } {
  const efficiencyBefore = effectiveEfficiencyPerHeadTons(PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons, "pd", PRODUCTION_PARAMETERS_V1);
  const effectiveCoefficientAtLevel = computeEffectivePdCoefficient(mechanizationLevel);
  const efficiencyAtLevel = effectiveEfficiencyPerHeadTons(PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons, "pd", PRODUCTION_PARAMETERS_V1, effectiveCoefficientAtLevel);
  const requiredBefore = requiredHeadcountForQuantity(pdQuantityTons, efficiencyBefore, attendanceRate, skillLevel, overtimeRate);
  const requiredAtLevel = requiredHeadcountForQuantity(pdQuantityTons, efficiencyAtLevel, attendanceRate, skillLevel, overtimeRate);
  return { requiredBefore, requiredAtLevel, reduction: Math.max(0, requiredBefore - requiredAtLevel) };
}

// ---------------------------------------------------------------------
// 6. CSV/JSON出力
// ---------------------------------------------------------------------

const CSV_COLUMNS: readonly (keyof QuarterMetricsRow)[] = [
  "scenarioLabel",
  "variant",
  "band",
  "seed",
  "companyId",
  "quarter",
  "factoryId",
  "mechanizationOn",
  "diagnosticCashGrantUsd",
  "pdPlannedQuantityTons",
  "pdActualQuantityTons",
  "pdCapacityTons",
  "pdUtilizationRate",
  "requiredWorkers",
  "allocatedRegularWorkers",
  "allocatedTemporaryWorkers",
  "workerShortage",
  "overtimeRate",
  "regularLaborCostUsd",
  "temporaryLaborCostUsd",
  "overtimeCostUsd",
  "mechanizationPaymentUsd",
  "maintenanceCostUsd",
  "depreciationCostUsd",
  "operatingIncomeUsd",
  "netIncomeUsd",
  "operatingCashFlowUsd",
  "investingCashFlowUsd",
  "cashUsd",
  "borrowingUsd",
  "insolvent",
];

export function toCsv(rows: readonly QuarterMetricsRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((r) => CSV_COLUMNS.map((c) => String(r[c])).join(","));
  return [header, ...lines].join("\n");
}

export function writeStudyOutputs(results: readonly BandResult[], outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  const allRows: QuarterMetricsRow[] = results.flatMap((r) => [...r.rowsOff, ...r.rowsOn]);
  writeFileSync(join(outDir, "test15-pd-mechanization-preflight.csv"), toCsv(allRows), "utf8");
  writeFileSync(
    join(outDir, "test15-pd-mechanization-preflight.json"),
    JSON.stringify(
      {
        seeds: SEEDS,
        bands: UTILIZATION_BANDS,
        diagnosticCashGrantUsd: DIAGNOSTIC_CASH_GRANT_USD,
        results: results.map((r) => ({
          seed: r.seed,
          band: r.band,
          variant: r.variant,
          floorMultiplier: r.floorMultiplier,
          diagnosticCashGrantUsd: r.diagnosticCashGrantUsd,
          achievedAvgUtilizationOff: r.achievedAvgUtilizationOff,
          achievedAvgUtilizationOn: r.achievedAvgUtilizationOn,
          windowStartQuarter: r.windowStartQuarter,
          windowQuarterCount: r.windowQuarterCount,
        })),
      },
      null,
      2
    ),
    "utf8"
  );
}

// ---------------------------------------------------------------------
// 7. CLIエントリポイント
// ---------------------------------------------------------------------

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function printStudySummary(results: readonly BandResult[]): void {
  console.log("\n=== Test15前 PD省人化投資プリフライト校正（マッチドペア研究） ===\n");
  for (const r of results) {
    const label = r.variant === "A" ? "A(通常ゲーム条件)" : "B(診断用感応度分析・現金付与" + fmtUsd(r.diagnosticCashGrantUsd) + ")";
    const finalOff = r.rowsOff[r.rowsOff.length - 1];
    const finalOn = r.rowsOn[r.rowsOn.length - 1];
    console.log(
      `seed=${r.seed} band=${Math.round(r.band * 100)}% ${label} floor倍率=${r.floorMultiplier.toFixed(2)} ` +
        `窓平均稼働率(off/on)=${(r.achievedAvgUtilizationOff * 100).toFixed(1)}%/${(r.achievedAvgUtilizationOn * 100).toFixed(1)}% ` +
        `窓四半期数=${r.windowQuarterCount} 最終純利益(off/on)=${fmtUsd(finalOff?.netIncomeUsd ?? 0)}/${fmtUsd(finalOn?.netIncomeUsd ?? 0)} ` +
        `最終現金(off/on)=${fmtUsd(finalOff?.cashUsd ?? 0)}/${fmtUsd(finalOn?.cashUsd ?? 0)} ` +
        `On側insolvent=${finalOn?.insolvent ?? false}`
    );
  }

  const be = computeBreakEvenAnalysis();
  console.log("\n=== break-even分析（実際のコード係数から導出。シミュレーション出力ではない） ===\n");
  console.log(`標準予算: ${fmtUsd(be.standardBudgetUsd)}`);
  console.log(`四半期保守費（現金コスト）: ${fmtUsd(be.quarterlyMaintenanceUsd)} / 四半期減価償却費（非現金）: ${fmtUsd(be.quarterlyDepreciationUsd)}`);
  console.log(`四半期会計コスト合計（保守費+減価償却費）: ${fmtUsd(be.quarterlyMaintenancePlusDepreciationUsd)}`);
  console.log(`常用Worker賃金: ${fmtUsd(be.regularWorkerSalaryUsdPerQuarter)}/四半期・人 / 残業割増係数: ${be.overtimePremiumFactor}`);
  console.log(`基準係数: ${be.baseCoefficient} / フロア係数: ${be.floorCoefficient} / 完全習熟(100%稼働・フルランプ)時の最大削減率: ${(be.maxReductionRatioAtFullMaturity * 100).toFixed(2)}%`);
  console.log(`残業削減のみで保守費(現金)を回収するのに必要な削減人数相当: ${be.headsNeededToOffsetMaintenanceCashOnly.toFixed(1)}人`);
  console.log(`残業削減のみで保守費+減価償却費(会計コスト全体)を回収するのに必要な削減人数相当: ${be.headsNeededToOffsetMaintenancePlusDepreciation.toFixed(1)}人`);
  console.log(`→ 完全習熟(100%稼働)時の最大削減率で逆算した、保守費のみ回収に必要なPD配置人数: ${be.pdHeadcountNeededAtFullMaturityForMaintenanceCashOnly.toFixed(1)}人`);
  console.log(`→ 完全習熟(100%稼働)時の最大削減率で逆算した、会計コスト全体回収に必要なPD配置人数: ${be.pdHeadcountNeededAtFullMaturityForFullAccountingCost.toFixed(1)}人`);
}

if (require.main === module) {
  const results = runFullStudy();
  printStudySummary(results);
  const outDir = join(__dirname, "..", "artifacts", "test15", "preflight-calibration");
  writeStudyOutputs(results, outDir);
  console.log(`\nCSV/JSON出力: ${outDir}/test15-pd-mechanization-preflight.csv / .json`);
}
