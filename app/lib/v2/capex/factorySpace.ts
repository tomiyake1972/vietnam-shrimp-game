// ShrimpX V2 — 設備投資と工場スペースの接続（Phase 8D-3新設）
//
// production/factorySpace.ts（スペースの係数・計算式・状態）と capex/（投資案件の
// ライフサイクル）をつなぐ層。依存の向きは capex → production の一方向であり、
// production/factorySpace.ts は capex/ を一切 import しない（循環参照を作らない）。
//
// 【禁止事項】
//   - 「稼働開始済みか否か」の判定を独自に書かない。必ず
//     capacityEffect.ts の isCapexProjectOperationalAt を呼ぶ。
//   - スペース係数をここへ持たない。唯一の情報源は
//     production/factorySpace.ts の FACTORY_SPACE_PARAMETERS_V1 である。
//   - 案件のスペース所要量を、承認済み案件と候補とで別々の式にしない
//     （どちらも computeProjectRequiredSpaceUnits を通す）。

import { PeriodV2 } from "../core/period";
import { CompanyId } from "../sales/types";
import { Factory } from "../production/types";
import {
  aggregateCompanyFactorySpaceState,
  buildFactorySpaceState,
  CompanyFactorySpaceState,
  computeProjectRequiredSpaceUnits,
  FACTORY_SPACE_PARAMETERS_V1,
  FactorySpaceParameters,
  PendingSpaceReservation,
  SpaceConsumingPoolKey,
} from "../production/factorySpace";
import { isCapexProjectOperationalAt } from "./capacityEffect";
import { CapexParameters, CAPEX_PARAMETERS_V1 } from "./parameters";
import { CapexState, CapitalProject, CapitalProjectType } from "./types";

/**
 * 承認済み案件1件のスペース所要量。増強対象・増加量は**承認時スナップショット**
 * （CapitalProject.futureCapacityEffect）を唯一の情報源とする（テンプレートを後から
 * 校正しても、承認済み案件の所要量は変わらない。既存の能力効果と同じ扱い）。
 */
export function computeApprovedProjectSpaceUnits(
  project: CapitalProject,
  spaceParams: FactorySpaceParameters = FACTORY_SPACE_PARAMETERS_V1
): number {
  return computeProjectRequiredSpaceUnits(
    {
      projectType: project.projectType,
      targetPool: project.futureCapacityEffect?.targetProduct as SpaceConsumingPoolKey | undefined,
      capacityIncreaseTons: project.futureCapacityEffect?.capacityIncreaseTonsPerQuarter,
    },
    spaceParams
  );
}

/**
 * まだ承認されていない候補1件のスペース所要量（テンプレート由来）。
 * 画面の投資カードと、承認時のスペース判定の両方がこの関数を使う
 * （「カードでは足りると表示されたのに承認されない」という食い違いを防ぐ）。
 */
export function computeCandidateProjectSpaceUnits(
  projectType: CapitalProjectType,
  capexParams: CapexParameters = CAPEX_PARAMETERS_V1,
  spaceParams: FactorySpaceParameters = FACTORY_SPACE_PARAMETERS_V1
): number {
  const template = capexParams.templatesByType[projectType];
  return computeProjectRequiredSpaceUnits(
    {
      projectType,
      targetPool: template.futureCapacityEffect.targetProduct as SpaceConsumingPoolKey | undefined,
      capacityIncreaseTons: template.futureCapacityEffect.capacityIncreaseTonsPerQuarter,
    },
    spaceParams
  );
}

/**
 * period 時点で「まだ稼働開始していない（＝スペースを予約している）」案件の一覧。
 * 取消済みは対象外。稼働開始済みの案件は、すでに当期Factoryの能力へ反映されており
 * 稼働中使用量として数えられるため、ここには現れない（二重計上の防止）。
 */
export function buildPendingSpaceReservations(
  projects: readonly CapitalProject[],
  period: PeriodV2,
  spaceParams: FactorySpaceParameters = FACTORY_SPACE_PARAMETERS_V1
): readonly PendingSpaceReservation[] {
  return projects
    .filter((p) => p.status !== "cancelled" && !isCapexProjectOperationalAt(p, period))
    .map((p) => ({
      projectId: p.projectId,
      projectType: p.projectType,
      requiredSpaceUnits: computeApprovedProjectSpaceUnits(p, spaceParams),
    }))
    .filter((r) => r.requiredSpaceUnits > 0);
}

export interface BuildCompanyFactorySpaceStateInput {
  readonly companyId: CompanyId;
  /** 基礎Factory（CompanyFixture.factories。capex加算前）。 */
  readonly baseFactories: readonly Factory[];
  /** 当期の実効Factory（applyCapexCapacityToFactories 適用後）。 */
  readonly currentFactories: readonly Factory[];
  readonly capexState: CapexState;
  readonly period: PeriodV2;
  readonly spaceParams?: FactorySpaceParameters;
}

/**
 * 1社ぶんの工場スペース状態を組み立てる。
 *
 * 【複数工場の扱い】CapitalProject は factoryId を持たない（capex/capacityEffect.ts の
 * applyCapexCapacityToFactories が「その会社の最初の工場（主工場）へまとめて加算する」
 * という規則を持つ）。したがってスペースの予約も同じ主工場へ寄せる。
 * 能力の加算先とスペースの予約先を必ず一致させるため、主工場の決め方
 * （factories の先頭）を capacityEffect.ts と同じ規則にしている。
 */
export function buildCompanyFactorySpaceState(input: BuildCompanyFactorySpaceStateInput): CompanyFactorySpaceState {
  const spaceParams = input.spaceParams ?? FACTORY_SPACE_PARAMETERS_V1;
  const base = input.baseFactories.filter((f) => f.companyId === input.companyId);
  const currentById = new Map(input.currentFactories.filter((f) => f.companyId === input.companyId).map((f) => [f.factoryId, f]));

  const companyCapex = input.capexState.companies.find((c) => c.companyId === input.companyId);
  const reservations = companyCapex ? buildPendingSpaceReservations(companyCapex.portfolio.projects, input.period, spaceParams) : [];
  const primaryFactoryId = base.length > 0 ? base[0].factoryId : undefined;

  const factoryStates = base.map((baseFactory) =>
    buildFactorySpaceState({
      baseFactory,
      currentFactory: currentById.get(baseFactory.factoryId) ?? baseFactory,
      pendingReservations: baseFactory.factoryId === primaryFactoryId ? reservations : [],
      params: spaceParams,
    })
  );

  return aggregateCompanyFactorySpaceState(input.companyId, factoryStates, spaceParams);
}

/**
 * 新規提案の承認可否を判定するためのスペース枠。capexClose.ts が
 * 1四半期ぶんの提案を順に評価する間、承認するたびに remainingSpaceUnits を
 * 減らしていくことで、同じ四半期に複数の案件を提案した場合の重複承認を防ぐ。
 */
export interface FactorySpaceApprovalBudget {
  readonly totalSpaceUnits: number;
  readonly remainingSpaceUnits: number;
}

/** 会社のスペース状態から、当四半期の新規承認に使える枠を作る。 */
export function buildFactorySpaceApprovalBudget(state: CompanyFactorySpaceState): FactorySpaceApprovalBudget {
  return {
    totalSpaceUnits: state.totalSpaceUnits,
    remainingSpaceUnits: Math.max(0, state.totalSpaceUnits - state.usedAfterPendingSpaceUnits),
  };
}
