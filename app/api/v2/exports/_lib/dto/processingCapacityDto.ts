// ShrimpX V2 — Export DTO / 工場の加工能力（現時点の能力・現在追加中の能力）
//
// プレイヤーからの指摘「頂いているエクセルの中には、工場の現時点の加工能力が
// 入っていません。各加工能力と、現在追加中（つまり設備投資を意思決定して
// これから加わる能力）がわかるように出力してください」への対応。
//
// 【データ源（すべて既存の確定履歴・永続化状態に保存済み。エンジンは変更しない）】
//   当初の能力（基礎）   → CompanyLabPersistedStateV1.fixtures[].factories
//                          （ラボ作成時に確定し以後変化しない静的値）
//   稼働開始済みの増加   → postProcessingStateSnapshot.capexState を
//                          applyCapexCapacityToFactories へ与えた結果との差分
//   現在追加中の能力     → postProcessingStateSnapshot.capexState.companies[].portfolio.projects
//                          のうち、当期末時点でまだ稼働開始していない能力増加案件
//
// 【再計算しない】能力の加算規則（どの工場へ加算されるか）・稼働開始四半期の判定・
// 実効能力への稼働率適用は、いずれもエンジン本体の純粋関数
// （applyCapexCapacityToFactories / isCapexProjectOperationalAt /
// calculateFactoryEffectiveCapacity）が行う。本DTOはそれらを呼び出して得た値を
// 許可フィールドとして1つずつ書き写すだけで、独自の計算式を持たない。
// 意思決定画面と同一の processingCapacityViewModel.ts を経由するため、画面と
// Excelで値が食い違うことがない。
//
// 【禁止事項】
//   - 「当初＋増加＝現時点」の検算結果をDTOのフィールドとして持たない
//     （Excel側の数式で検算する。§「保存済み確定値を再計算しない」と同じ方針）。
//   - 値が無い箇所を0で埋めない（オプショナルは `?? null` でnullへ落とす）。
//   - 内部型（Factory・CapitalProject）をそのままspreadしない。
//
// 【スコープ隔離】会社スコープでは対象会社のfixtureと対象会社のcapexポートフォリオ
// のみを読む（buildCompanyProcessingCapacityViewModelがcompanyIdで絞り込む）。
// 他社の工場能力・投資案件は一切含まれない。

import { CompanyId } from "../../../../../lib/v2/sales/types";
import { PeriodV2 } from "../../../../../lib/v2/core/period";
import { CompanyFixture } from "../../../../../lib/v2/companyLab/types";
import { CapexState } from "../../../../../lib/v2/capex";
import {
  buildCompanyProcessingCapacityViewModel,
  CAPACITY_POOL_DESCRIPTIONS,
  CapacityPoolKey,
} from "../../../../../v2/company-lab/processingCapacityViewModel";

/** 能力プール（商品別加工能力）1つぶんの内訳。 */
export interface ExportCapacityPool {
  readonly poolKey: CapacityPoolKey;
  readonly poolLabel: string;
  /** この能力の意味（原料投入基準か完成品基準か）。プレイヤーが単位を誤読しないための説明。 */
  readonly poolDescription: string;
  /** ラボ作成時点の能力（トン/四半期・名目）。 */
  readonly baseNominalTons: number;
  /** 稼働開始済みの設備投資による増加ぶん（トン/四半期・名目）。 */
  readonly addedByOperationalCapexTons: number;
  /** 当期末時点の能力（トン/四半期・名目）。生産計画の上限判定に使われる能力の元になる値。 */
  readonly currentNominalTons: number;
  /** 当期末時点の実効能力（名目×基準稼働率×設備利用可能率、トン/四半期）。 */
  readonly currentEffectiveTons: number;
}

/** 工場1つぶんの現時点の能力。 */
export interface ExportFactoryCapacity {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  readonly status: string;
  readonly baseUtilizationRate: number;
  readonly equipmentAvailabilityRate: number;
  /** この工場が設備投資による能力増加の反映先になっているか。 */
  readonly receivesCapexCapacity: boolean;
  readonly pools: readonly ExportCapacityPool[];
}

/** 現在追加中（意思決定済み・まだ能力へ未反映）の投資案件1件ぶん。 */
export interface ExportPendingCapacityProject {
  readonly projectId: string;
  readonly projectType: string;
  readonly projectTypeDisplayName: string;
  readonly displayStatus: string;
  readonly displayStatusLabel: string;
  readonly targetPoolKey: CapacityPoolKey | null;
  readonly targetPoolLabel: string | null;
  readonly capacityIncreaseTonsPerQuarter: number;
  readonly approvedPeriod: PeriodV2;
  readonly completionPeriod: PeriodV2 | null;
  /** completionPeriodが実績（完成済み）ではなく見込みか。 */
  readonly isCompletionEstimate: boolean;
  /** 能力へ反映される四半期。完成前は確定しないためnull。 */
  readonly operationalStartPeriod: PeriodV2 | null;
  readonly requiredConstructionQuarters: number;
  readonly elapsedConstructionQuartersWithPayment: number;
  readonly approvedBudgetUsd: number;
  readonly cumulativePaidUsd: number;
  readonly remainingScheduledPaymentUsd: number;
}

export interface ExportProcessingCapacity {
  readonly companyId: CompanyId;
  /** どの四半期時点の能力か（当期処理直後＝次期の意思決定が前提とする能力）。 */
  readonly asOfPeriod: PeriodV2;
  readonly factories: readonly ExportFactoryCapacity[];
  /** 会社合計（能力プール別）。 */
  readonly companyTotals: readonly ExportCapacityPool[];
  readonly pendingProjects: readonly ExportPendingCapacityProject[];
}

export interface BuildExportProcessingCapacityInput {
  readonly companyId: CompanyId;
  /** ラボ作成時に確定・永続化された会社fixture（工場の当初能力の唯一の出所）。 */
  readonly fixtures: readonly CompanyFixture[];
  /** 当期処理直後のcapex状態。 */
  readonly capexState: CapexState;
  /** 当期処理直後の四半期。 */
  readonly asOfPeriod: PeriodV2;
}

/**
 * 加工能力セクションを組み立てる。意思決定画面と同一の
 * buildCompanyProcessingCapacityViewModel を唯一の導出元とする
 * （画面とExcelで値が食い違わないようにするため、ここで別の導出を書かない）。
 */
export function buildExportProcessingCapacity(input: BuildExportProcessingCapacityInput): ExportProcessingCapacity {
  const baseFactories = input.fixtures.flatMap((f) => f.factories);
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: input.companyId,
    baseFactories,
    capexState: input.capexState,
    period: input.asOfPeriod,
  });
  return {
    companyId: vm.companyId,
    asOfPeriod: vm.period,
    factories: vm.factories.map((f) => ({
      factoryId: f.factoryId,
      companyId: f.companyId,
      status: f.status,
      baseUtilizationRate: f.baseUtilizationRate,
      equipmentAvailabilityRate: f.equipmentAvailabilityRate,
      receivesCapexCapacity: f.receivesCapexCapacity,
      pools: f.pools.map(toExportPool),
    })),
    companyTotals: vm.companyTotals.map(toExportPool),
    pendingProjects: vm.pendingProjects.map((p) => ({
      projectId: p.projectId,
      projectType: p.projectType,
      projectTypeDisplayName: p.projectTypeDisplayName,
      displayStatus: p.displayStatus,
      displayStatusLabel: p.displayStatusLabel,
      targetPoolKey: p.targetPoolKey ?? null,
      targetPoolLabel: p.targetPoolLabel ?? null,
      capacityIncreaseTonsPerQuarter: p.capacityIncreaseTonsPerQuarter,
      approvedPeriod: p.approvedPeriod,
      completionPeriod: p.completionPeriod ?? null,
      isCompletionEstimate: p.isCompletionEstimate,
      operationalStartPeriod: p.operationalStartPeriod ?? null,
      requiredConstructionQuarters: p.requiredConstructionQuarters,
      elapsedConstructionQuartersWithPayment: p.elapsedConstructionQuartersWithPayment,
      approvedBudgetUsd: p.approvedBudgetUsd,
      cumulativePaidUsd: p.cumulativePaidUsd,
      remainingScheduledPaymentUsd: p.remainingScheduledPaymentUsd,
    })),
  };
}

function toExportPool(pool: {
  readonly poolKey: CapacityPoolKey;
  readonly poolLabel: string;
  readonly baseNominalTons: number;
  readonly addedByOperationalCapexTons: number;
  readonly currentNominalTons: number;
  readonly currentEffectiveTons: number;
}): ExportCapacityPool {
  return {
    poolKey: pool.poolKey,
    poolLabel: pool.poolLabel,
    poolDescription: CAPACITY_POOL_DESCRIPTIONS[pool.poolKey],
    baseNominalTons: pool.baseNominalTons,
    addedByOperationalCapexTons: pool.addedByOperationalCapexTons,
    currentNominalTons: pool.currentNominalTons,
    currentEffectiveTons: pool.currentEffectiveTons,
  };
}
