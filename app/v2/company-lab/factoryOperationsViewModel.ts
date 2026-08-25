// ShrimpX V2 — Player Factory Operations（工場休止・再稼働・売却）表示専用ViewModel
//
// 新しい計算式・新しい会計式は一切持たない。既存Engineの正式なSource of Truth
// （capex/factoryLifecycle.ts・capex/factoryAssetProjection.ts・
// finance/parameters.ts）が算出済み・算出可能な値を、Player向け表示形へ
// 組み立てるだけの純粋関数群である。
//
// 【生産能力はここでは扱わない】「現在使用可能な生産能力」は既存の
// buildCompanyProcessingCapacityViewModel（processingCapacityViewModel.ts）が
// 唯一の情報源であり、decisionStudioViewModel.tsが既にvm.capacityViewModelとして
// 構築済みである。呼び出し元（InvestmentPlanningScreen.tsx）がfactoryIdで
// vm.capacityViewModel.factoriesを直接参照する（二重計算しない）。

import { nextPeriod, toYearQuarter, PeriodV2 } from "../../lib/v2/core/period";
import { unwrapUsd } from "../../lib/v2/finance/types";
import { CompanyFixture, CompanyOwnState } from "../../lib/v2/companyLab";
import { CAPEX_PARAMETERS_V1 } from "../../lib/v2/capex";
import { isActiveStatus } from "../../lib/v2/capex/projectLifecycle";
import { attributeProjectToFactoryId, computeFactoryAssetProjection } from "../../lib/v2/capex/factoryAssetProjection";
import {
  FACTORY_LIFECYCLE_PARAMETERS_V1,
  FactoryLifecycleDecisionType,
  FactoryLifecycleState,
  findCompanyFactoryLifecycleState,
  resolveFactoryLifecycleStateAt,
} from "../../lib/v2/capex/factoryLifecycle";
import { FINANCE_PARAMETERS_V1, normalCashFixedFactoryCostUsdPerQuarter } from "../../lib/v2/finance/parameters";

function quartersBetweenPeriods(from: PeriodV2, to: PeriodV2): number {
  const a = toYearQuarter(from);
  const b = toYearQuarter(to);
  return b.year * 4 + b.quarter - (a.year * 4 + a.quarter);
}

/**
 * ある将来（または過去）のPeriodが、現在Turn/現在Periodを基準にして「Turn 何」に
 * あたるかを求める。Period⇔Turnは常に1:1・同一歩調で進む既存の関係（このモジュール
 * 独自の新しいtiming規約ではない）ため、単純な四半期差分をTurn差分としてそのまま使う。
 */
export function periodToTurnNumber(currentTurn: number, currentPeriod: PeriodV2, targetPeriod: PeriodV2): number {
  return currentTurn + quartersBetweenPeriods(currentPeriod, targetPeriod);
}

export interface FactoryOperationsRow {
  readonly factoryId: string;
  readonly lifecycleStatus: FactoryLifecycleState;
  /** 既存computeFactoryAssetProjectionによる工場別帳簿価額（NBV）。 */
  readonly netBookValueUsd: number;
  /** MOTHBALLED時に発生する四半期あたりcarrying cost（既存パラメータから算出。表示専用）。 */
  readonly mothballCarryingCostUsdPerQuarter: number;
  /** SALE_PENDING時に発生する四半期あたりholding cost（同上）。 */
  readonly salePendingHoldingCostUsdPerQuarter: number;
  /** 再稼働を決定した四半期に発生する再稼働費（既存パラメータそのもの）。 */
  readonly reactivationCostUsd: number;
  /** 今売却した場合の見込代金（NBV × 既存回収率）。実際の売却完了時の値とは異なりうる（見込）。 */
  readonly estimatedSaleProceedsUsd: number;
  /** 今売却した場合の見込売却損益（見込代金 − NBV）。 */
  readonly estimatedDisposalGainLossUsd: number;
  /** 未完了のCapital Project（approved/underConstruction/suspended）を持つか。 */
  readonly hasActiveCapexProject: boolean;
  /** 現在stateから見て、UIが候補として提示してよい操作（あくまでUI側のヒント。最終判定は既存validateFactoryLifecycleDecision）。 */
  readonly availableActions: readonly FactoryLifecycleDecisionType[];
  /** SALE_PENDINGのときだけ埋まる、売却完了予定のTurn番号（既存決定ログのdecidedPeriod + 2四半期）。 */
  readonly saleCompletionTurn: number | null;
}

export interface FactoryOperationsViewModel {
  readonly rows: readonly FactoryOperationsRow[];
  /** 検証コンテキスト用（validateFactoryLifecycleDecisionと同じ定義のownedFactoryIds）。 */
  readonly ownedFactoryIds: readonly string[];
}

export function buildFactoryOperationsViewModel(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  period: PeriodV2,
  currentTurn: number
): FactoryOperationsViewModel {
  const companyLifecycle = findCompanyFactoryLifecycleState(ownState.factoryLifecycleState, fixture.companyId);
  const decisions = companyLifecycle?.decisions ?? [];

  const projects = ownState.capexState.portfolio.projects;
  const primaryFactoryId = fixture.factories[0]?.factoryId;
  const activeProjectFactoryIds = new Set(
    projects
      .filter((p) => isActiveStatus(p.status))
      .map((p) => attributeProjectToFactoryId(p, primaryFactoryId))
      .filter((id): id is string => id !== undefined)
  );

  const normalCost = normalCashFixedFactoryCostUsdPerQuarter(FINANCE_PARAMETERS_V1);
  const params = FACTORY_LIFECYCLE_PARAMETERS_V1;

  const bookValueByFactoryId = computeFactoryAssetProjection({
    baselineFactories: fixture.factories,
    projects,
    lifecycleDecisions: decisions,
    period,
    companyFixedAssetsGrossUsd: unwrapUsd(ownState.financeState.fixedAssetsGross),
    companyAccumulatedDepreciationUsd: unwrapUsd(ownState.financeState.accumulatedDepreciation),
    financeParams: FINANCE_PARAMETERS_V1,
    capexParams: CAPEX_PARAMETERS_V1,
  });

  // 【ownedFactoryIds】ownState.effectiveFactoriesは既にlifecycle適用済み・SOLD除外済みの
  // Factory[]（capex/factoryConstruction.ts computeEffectiveFactoriesの結果）であり、
  // これがそのまま「通常の操作一覧に出すべき工場」（実装指示§7・SOLD除外）と一致する。
  const ownedFactoryIds = ownState.effectiveFactories.map((f) => f.factoryId);

  const rows: FactoryOperationsRow[] = ownedFactoryIds.map((factoryId) => {
    const lifecycleStatus = resolveFactoryLifecycleStateAt(decisions, factoryId, period);
    const netBookValueUsd = bookValueByFactoryId.get(factoryId)?.netBookValueUsd ?? 0;
    const hasActiveCapexProject = activeProjectFactoryIds.has(factoryId);
    const estimatedSaleProceedsUsd = netBookValueUsd * params.saleProceedsRecoveryRate;

    // 【最低1工場ルールのUIヒント】厳密な最終判定はvalidateFactoryLifecycleDecisionのみ
    // （同一Turnに複数売却を出した場合の順序依存等はここでは再現しない）。ここでは
    // 「現在保有している工場が2以上あるか」という単純な必要条件だけを候補の事前非表示に使う。
    const canSell = !hasActiveCapexProject && ownedFactoryIds.length > 1;

    const availableActions: FactoryLifecycleDecisionType[] =
      lifecycleStatus === "OPERATING"
        ? canSell
          ? ["MOTHBALL_FACTORY", "SELL_FACTORY"]
          : ["MOTHBALL_FACTORY"]
        : lifecycleStatus === "MOTHBALLED"
          ? ["REACTIVATE_FACTORY"]
          : [];

    let saleCompletionTurn: number | null = null;
    if (lifecycleStatus === "SALE_PENDING") {
      const saleDecision = decisions.find((d) => d.factoryId === factoryId && d.type === "SELL_FACTORY");
      if (saleDecision) {
        const completionPeriod = nextPeriod(nextPeriod(saleDecision.decidedPeriod));
        saleCompletionTurn = periodToTurnNumber(currentTurn, period, completionPeriod);
      }
    }

    return {
      factoryId,
      lifecycleStatus,
      netBookValueUsd,
      mothballCarryingCostUsdPerQuarter: normalCost * params.mothballCarryingCostRatio,
      salePendingHoldingCostUsdPerQuarter: normalCost * params.salePendingHoldingCostRatio,
      reactivationCostUsd: params.reactivationCostUsd,
      estimatedSaleProceedsUsd,
      estimatedDisposalGainLossUsd: estimatedSaleProceedsUsd - netBookValueUsd,
      hasActiveCapexProject,
      availableActions,
      saleCompletionTurn,
    };
  });

  return { rows, ownedFactoryIds };
}
