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
import { applyNewFactoryConstructionToFactories } from "./factoryConstruction";
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

/**
 * 【複数工場CAPEX Targeting修正】buildPendingSpaceReservationsと同じ判定条件で、
 * project.targetFactoryIdごとに予約を分ける版。targetFactoryId未設定の案件は
 * primaryFactoryIdへ寄せる（capacityEffect.tsのcomputeCapacityEffectByFactoryForCompanyと
 * 同じ後方互換ルール。能力の加算先とスペースの予約先を必ず一致させる）。
 */
export function buildPendingSpaceReservationsByFactory(
  projects: readonly CapitalProject[],
  period: PeriodV2,
  primaryFactoryId: string,
  spaceParams: FactorySpaceParameters = FACTORY_SPACE_PARAMETERS_V1
): ReadonlyMap<string, readonly PendingSpaceReservation[]> {
  const byFactory = new Map<string, PendingSpaceReservation[]>();
  for (const p of projects) {
    if (p.status === "cancelled" || isCapexProjectOperationalAt(p, period)) continue;
    const requiredSpaceUnits = computeApprovedProjectSpaceUnits(p, spaceParams);
    if (requiredSpaceUnits <= 0) continue;
    const factoryId = p.targetFactoryId ?? primaryFactoryId;
    const list = byFactory.get(factoryId) ?? [];
    list.push({ projectId: p.projectId, projectType: p.projectType, requiredSpaceUnits });
    byFactory.set(factoryId, list);
  }
  return byFactory;
}

/**
 * 案件が「能力増加を伴わない固定スペース案件」（品質管理設備・排水環境設備等）か。
 * 承認時スナップショット（futureCapacityEffect）に増強対象・増加量がどちらも
 * 揃っていなければ、能力プールを一切増やさない案件とみなす
 * （capacityEffect.ts の computeCapacityEffectForCompany と同じ判定条件を使い、
 * 「能力を増やすか否か」の判定ロジックを2箇所で食い違わせない）。
 */
function isFixedSpaceOnlyProject(project: CapitalProject): boolean {
  const effect = project.futureCapacityEffect;
  if (!effect || effect.targetProduct === undefined || effect.capacityIncreaseTonsPerQuarter === undefined) return true;
  return effect.capacityIncreaseTonsPerQuarter <= 0;
}

/**
 * period 時点で稼働開始済み・取消以外の「固定スペース案件」が占有している
 * スペースの合計（スペース単位）。
 *
 * 【Phase 8D監査M-1】品質管理設備・排水環境設備等は能力プールを増やさないため、
 * 稼働開始した瞬間に buildPendingSpaceReservations の対象（予約）から外れる一方、
 * computeFactoryUsedSpaceUnits（能力プール由来）にも決して現れず、占有スペースが
 * 消失してしまうバグがあった。これを防ぐため、稼働開始済みの固定スペース案件
 * ぶんを別途合算し、buildFactorySpaceState の operationalFixedSpaceUnits へ渡す。
 * 能力増設案件（isFixedSpaceOnlyProjectがfalse）はここに含めない
 * （能力プール経由で既に数えられており、含めると二重計上になる）。
 */
export function computeOperationalFixedSpaceUnits(
  projects: readonly CapitalProject[],
  period: PeriodV2,
  spaceParams: FactorySpaceParameters = FACTORY_SPACE_PARAMETERS_V1
): number {
  return projects
    .filter((p) => p.status !== "cancelled" && isCapexProjectOperationalAt(p, period) && isFixedSpaceOnlyProject(p))
    .reduce((sum, p) => sum + Math.max(0, computeApprovedProjectSpaceUnits(p, spaceParams)), 0);
}

/**
 * 【複数工場CAPEX Targeting修正】computeOperationalFixedSpaceUnitsと同じ判定条件で、
 * project.targetFactoryIdごとに合算を分ける版（未設定はprimaryFactoryIdへ寄せる）。
 */
export function computeOperationalFixedSpaceUnitsByFactory(
  projects: readonly CapitalProject[],
  period: PeriodV2,
  primaryFactoryId: string,
  spaceParams: FactorySpaceParameters = FACTORY_SPACE_PARAMETERS_V1
): ReadonlyMap<string, number> {
  const byFactory = new Map<string, number>();
  for (const p of projects) {
    if (p.status === "cancelled" || !isCapexProjectOperationalAt(p, period) || !isFixedSpaceOnlyProject(p)) continue;
    const amount = Math.max(0, computeApprovedProjectSpaceUnits(p, spaceParams));
    if (amount <= 0) continue;
    const factoryId = p.targetFactoryId ?? primaryFactoryId;
    byFactory.set(factoryId, (byFactory.get(factoryId) ?? 0) + amount);
  }
  return byFactory;
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
 * 【複数工場CAPEX Targeting修正】CapitalProject.targetFactoryIdが設定されて
 * いれば、スペースの予約・稼働中固定スペースもその対象Factoryへ計上する
 * （能力の加算先と必ず一致させる。capacityEffect.tsのcomputeCapacityEffectByFactoryForCompanyと
 * 同じ後方互換ルール：targetFactoryId未設定の案件は主工場（factories先頭）へ寄せる）。
 *
 * 【新設Factoryのスペース追跡】以前はbaseFactories（fixture.factories、静的）に
 * 存在しないFactoryは工場スペース状態の対象外だった（稼働開始済みnewFactoryConstruction
 * による新設Factory自身のスペースが一切追跡されない、既知の制約として文書化
 * されていた）。この関数では稼働開始済み新設FactoryをapplyNewFactoryConstructionToFactoriesで
 * 合成してbaseへ含めることで、新設Factory自身のスペースも他のFactoryと同じ規則で
 * 追跡できるようにする（新設Factoryの「基礎値」はテンプレートの初期スペース。
 * その後のFactory-specific CAPEXによる増設は、他のFactoryと同じ予約・固定スペースの
 * 仕組みで積み上がる）。
 */
export function buildCompanyFactorySpaceState(input: BuildCompanyFactorySpaceStateInput): CompanyFactorySpaceState {
  const spaceParams = input.spaceParams ?? FACTORY_SPACE_PARAMETERS_V1;
  const baseWithNewFactories = applyNewFactoryConstructionToFactories(input.baseFactories, input.capexState, input.period);
  const base = baseWithNewFactories.filter((f) => f.companyId === input.companyId);
  const currentById = new Map(input.currentFactories.filter((f) => f.companyId === input.companyId).map((f) => [f.factoryId, f]));

  const companyCapex = input.capexState.companies.find((c) => c.companyId === input.companyId);
  const primaryFactoryId = base.length > 0 ? base[0].factoryId : undefined;
  const reservationsByFactory =
    companyCapex && primaryFactoryId !== undefined
      ? buildPendingSpaceReservationsByFactory(companyCapex.portfolio.projects, input.period, primaryFactoryId, spaceParams)
      : new Map<string, readonly PendingSpaceReservation[]>();
  // 【Phase 8D監査M-1】稼働開始済みの固定スペース案件（品質管理設備・排水環境設備等）は
  // 予約(reservations)からは外れるが能力プールにも現れないため、別途合算してその対象
  // Factoryのusedbyoperationalspaceunitsへ計上する（予約と同じFactoryへ寄せる規則で一致させる）。
  const operationalFixedSpaceUnitsByFactory =
    companyCapex && primaryFactoryId !== undefined
      ? computeOperationalFixedSpaceUnitsByFactory(companyCapex.portfolio.projects, input.period, primaryFactoryId, spaceParams)
      : new Map<string, number>();

  const factoryStates = base.map((baseFactory) =>
    buildFactorySpaceState({
      baseFactory,
      currentFactory: currentById.get(baseFactory.factoryId) ?? baseFactory,
      pendingReservations: reservationsByFactory.get(baseFactory.factoryId) ?? [],
      operationalFixedSpaceUnits: operationalFixedSpaceUnitsByFactory.get(baseFactory.factoryId) ?? 0,
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

/** 会社のスペース状態から、当四半期の新規承認に使える枠を作る（全工場合計）。 */
export function buildFactorySpaceApprovalBudget(state: CompanyFactorySpaceState): FactorySpaceApprovalBudget {
  return {
    totalSpaceUnits: state.totalSpaceUnits,
    remainingSpaceUnits: Math.max(0, state.totalSpaceUnits - state.usedAfterPendingSpaceUnits),
  };
}

/**
 * 【複数工場CAPEX Targeting修正・§10】Factory-specific CAPEXの新規承認は、
 * 会社全体のスペース合算ではなく、その提案が対象とするFactory自身の残りスペースで
 * 判定しなければならない（F1が不足していてもF2に余裕があれば、F2向け投資は
 * 承認できるべき）。会社ごとの1個の枠ではなく、Factoryごとの枠のMapを返す。
 */
export function buildFactorySpaceApprovalBudgetByFactory(state: CompanyFactorySpaceState): ReadonlyMap<string, FactorySpaceApprovalBudget> {
  const byFactory = new Map<string, FactorySpaceApprovalBudget>();
  for (const f of state.factories) {
    byFactory.set(f.factoryId, {
      totalSpaceUnits: f.totalSpaceUnits,
      remainingSpaceUnits: Math.max(0, f.totalSpaceUnits - f.usedAfterPendingSpaceUnits),
    });
  }
  return byFactory;
}
