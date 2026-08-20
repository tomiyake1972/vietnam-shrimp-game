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
import type { FactoryLifecycleStateTable } from "../../../../../lib/v2/capex/factoryLifecycle";
import {
  buildCompanyProcessingCapacityViewModel,
  CAPACITY_POOL_DESCRIPTIONS,
  CapacityPoolKey,
} from "../../../../../v2/company-lab/processingCapacityViewModel";
import { CompanyProductionPlanEntry, WorkerAssignment } from "../../../../../lib/v2/production/types";
import { RawMaterialLot } from "../../../../../lib/v2/rawMaterials/types";
import {
  buildCompanyProcessingForecast,
  CONSTRAINT_ORDER_TEXTS,
  EFFECTIVE_CAPACITY_FORMULA_TEXT,
  PRIORITY_RULE_TEXT,
  YIELD_APPLICATION_TEXT,
} from "../../../../../v2/company-lab/processingForecastViewModel";
import { buildPdMechanizationStatusByFactory, findPreviousQuarterPdUtilization, PdMechanizationState } from "../../../../../lib/v2/companyLab/pdMechanizationState";
import { PD_MECHANIZATION_PARAMETERS_V1 } from "../../../../../lib/v2/capex/pdMechanization";

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

// ---------------------------------------------------------------------
// 名目→実効の計算過程と、現在の生産計画に基づく処理見込み
//
// 【重要】以下はすべて processingForecastViewModel.buildCompanyProcessingForecast
// （内部で生産処理エンジンの純粋関数 allocateProductionPlans と
// calculateFactoryEffectiveCapacity を呼ぶ）から書き写すだけである。
// 意思決定画面もまったく同じ関数を呼ぶため、画面とExcelで値が食い違わない。
// このDTOに独自の配分計算・実効率計算を書いてはならない。
// ---------------------------------------------------------------------

/** 実効率を構成する補正要因（コード上に実在する2つだけ）。 */
export interface ExportCapacityRateFactor {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

/** 「名目能力 → 実効能力」1行ぶん。 */
export interface ExportCapacityEffectiveRateRow {
  readonly poolKey: CapacityPoolKey;
  readonly poolLabel: string;
  readonly nominalTons: number;
  /** 名目が0のときはnull（0で埋めない）。 */
  readonly effectiveRate: number | null;
  readonly effectiveTons: number;
  readonly factors: readonly ExportCapacityRateFactor[];
  readonly factorsProduct: number | null;
  readonly correctionNote: string;
}

export interface ExportCapacityEffectiveRateTable {
  /** 会社合計の場合はnull。 */
  readonly factoryId: string | null;
  readonly rows: readonly ExportCapacityEffectiveRateRow[];
}

/** 商品1行ぶんの処理見込み。 */
export interface ExportProcessingForecastRow {
  readonly factoryId: string;
  readonly product: string;
  readonly priority: number;
  readonly desiredTons: number;
  readonly productNominalCapacityTons: number;
  readonly productEffectiveCapacityTons: number;
  readonly forecastProcessedTons: number;
  readonly forecastUnprocessedTons: number;
  /** 制約となった能力（主因が先頭）。制約なしなら空配列。 */
  readonly constraintLabels: readonly string[];
  readonly primaryConstraintLabel: string | null;
  readonly constraintSummary: string;
  /** 主因・補足要因を区別した具体的な不足の説明文（エンジンの返した順序どおり）。 */
  readonly constraintSentences: readonly string[];
  readonly priorityNote: string | null;
}

export interface ExportProcessingForecast {
  /** 確定結果ではないことを明示する見出し。 */
  readonly headingText: string;
  /** 常にtrue。 */
  readonly isForecast: true;
  readonly effectiveCapacityFormulaText: string;
  readonly priorityRuleText: string;
  readonly constraintOrderTexts: readonly string[];
  readonly yieldApplicationText: string;
  readonly companyRateTable: ExportCapacityEffectiveRateTable;
  readonly factoryRateTables: readonly ExportCapacityEffectiveRateTable[];
  /** 現在の生産計画（希望量・優先度）と、そこから導いた処理見込み。 */
  readonly rows: readonly ExportProcessingForecastRow[];
  readonly availableRawMaterialTons: number;
  readonly caveatTexts: readonly string[];
}

/**
 * 【Test15新設】1工場ぶんのPD省人化投資の状況。稼働開始済みの投資案件が無い工場は
 * mechanizationLevel/effectivePdCoefficientがnull（0で埋めない。「投資自体が無い」
 * ことと「投資があるが効果0」を区別するため）。
 * 【注記】「削減される常用Worker人数」は、他の生産変数（生産量・優先度等）を固定した
 * 単一の数値として一意に定まらないため、実効係数・削減率という実測可能な値だけを
 * 出力する（それらしい人数を作らない）。
 */
export interface ExportFactoryPdMechanizationStatus {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  /** 前四半期末までのPD稼働率（[0,1]）。投資有無に関わらず常に実測値。 */
  readonly previousQuarterPdUtilization: number;
  /** 稼働中のpdMechanization案件ID（無ければnull）。 */
  readonly activeProjectId: string | null;
  readonly mechanizationLevel: number | null;
  readonly effectivePdCoefficient: number | null;
  readonly basePdCoefficient: number;
  /** 実効係数が基準からどれだけ下がったか（0〜1）。稼働中案件が無ければnull。 */
  readonly reductionRatio: number | null;
}

export interface ExportProcessingCapacity {
  readonly companyId: CompanyId;
  /** どの四半期時点の能力か（当期処理直後＝次期の意思決定が前提とする能力）。 */
  readonly asOfPeriod: PeriodV2;
  readonly factories: readonly ExportFactoryCapacity[];
  /** 会社合計（能力プール別）。 */
  readonly companyTotals: readonly ExportCapacityPool[];
  readonly pendingProjects: readonly ExportPendingCapacityProject[];
  /** 名目→実効の計算過程と、現在の生産計画に基づく処理見込み。 */
  readonly forecast: ExportProcessingForecast;
  /** 【Test15新設】工場別のPD省人化投資状況。 */
  readonly pdMechanizationByFactory: readonly ExportFactoryPdMechanizationStatus[];
}

export interface BuildExportProcessingCapacityInput {
  readonly companyId: CompanyId;
  /** ラボ作成時に確定・永続化された会社fixture（工場の当初能力の唯一の出所）。 */
  readonly fixtures: readonly CompanyFixture[];
  /** 当期処理直後のcapex状態。 */
  readonly capexState: CapexState;
  /** 当期処理直後の四半期。 */
  readonly asOfPeriod: PeriodV2;
  /**
   * この会社の生産計画（当期の提出意思決定）。処理見込みの入力。
   * 【スコープ隔離】呼び出し元は必ず「対象会社ぶんだけ」を渡す。
   * 未指定なら見込み行は空になる（0で埋めない）。
   */
  readonly productionPlans?: readonly CompanyProductionPlanEntry[];
  readonly workerAssignments?: readonly WorkerAssignment[];
  /** 見込み計算に使う原料ロット（対象会社ぶん）。 */
  readonly rawMaterialLots?: readonly RawMaterialLot[];
  /** 【Test15新設】当期処理直後のPD省人化状態（未指定なら空配列扱い＝全工場が初期値）。 */
  readonly pdMechanizationState?: PdMechanizationState;
  /**
   * 【ENG-FAC-1 export consistency】当期処理直後のFactory lifecycle決定ログ。
   * CompanyLabRuntimeSnapshot.factoryLifecycleState をそのまま渡すこと
   * （履歴エントリのpostProcessingStateSnapshotが既に保持している。schema追加は不要）。
   *
   * 未指定・この機能導入前に保存されたRun（キー自体が存在しない）ではundefinedとなり、
   * lifecycleを一切適用しない＝従来と完全に同一のExport内容になる。
   * Export専用のMOTHBALLED / SOLD判定はここにも下流にも持たない。
   */
  readonly factoryLifecycleState?: FactoryLifecycleStateTable;
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
    factoryLifecycleState: input.factoryLifecycleState,
  });
  // 画面（DecisionEditor）とまったく同じ純粋関数を呼ぶ。ここで別計算をしない。
  const forecastVm = buildCompanyProcessingForecast({
    companyId: input.companyId,
    baseFactories,
    capexState: input.capexState,
    period: input.asOfPeriod,
    factoryLifecycleState: input.factoryLifecycleState,
    productionPlans: input.productionPlans ?? [],
    workerAssignments: input.workerAssignments ?? [],
    rawMaterialLots: input.rawMaterialLots ?? [],
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
    forecast: {
      headingText: forecastVm.headingText,
      isForecast: true,
      effectiveCapacityFormulaText: EFFECTIVE_CAPACITY_FORMULA_TEXT,
      priorityRuleText: PRIORITY_RULE_TEXT,
      constraintOrderTexts: CONSTRAINT_ORDER_TEXTS,
      yieldApplicationText: YIELD_APPLICATION_TEXT,
      companyRateTable: toExportRateTable(forecastVm.companyRateTable),
      factoryRateTables: forecastVm.factoryRateTables.map(toExportRateTable),
      rows: forecastVm.rows.map((row) => ({
        factoryId: row.factoryId,
        product: row.product,
        priority: row.priority,
        desiredTons: row.desiredTons,
        productNominalCapacityTons: row.productNominalCapacityTons,
        productEffectiveCapacityTons: row.productEffectiveCapacityTons,
        forecastProcessedTons: row.forecastProcessedTons,
        forecastUnprocessedTons: row.forecastUnprocessedTons,
        constraintLabels: row.constraints.map((c) => c.label),
        primaryConstraintLabel: row.primaryConstraint?.label ?? null,
        constraintSummary: row.constraintSummary,
        constraintSentences: row.constraints.map((c) => c.sentence),
        priorityNote: row.priorityNote ?? null,
      })),
      availableRawMaterialTons: forecastVm.availableRawMaterialTons,
      caveatTexts: forecastVm.caveatTexts,
    },
    pdMechanizationByFactory: buildExportPdMechanizationByFactory(input),
  };
}

/**
 * 【Test15新設】工場別PD省人化投資状況。buildPdMechanizationStatusByFactory
 * （companyLab/pdMechanizationState.ts）をそのまま呼び、独自の再計算をしない。
 * 対象会社の工場だけへ絞り込む（他社の投資案件は一切含めない＝スコープ隔離）。
 */
function buildExportPdMechanizationByFactory(input: BuildExportProcessingCapacityInput): readonly ExportFactoryPdMechanizationStatus[] {
  const baseFactories = input.fixtures.flatMap((f) => f.factories).filter((f) => f.companyId === input.companyId);
  const statusByFactory = buildPdMechanizationStatusByFactory(input.capexState, input.pdMechanizationState, input.asOfPeriod);
  const companyProjects = input.capexState.companies.find((c) => c.companyId === input.companyId)?.portfolio.projects ?? [];
  return baseFactories
    .map((f) => {
      const status = statusByFactory.get(f.factoryId);
      const activeProject = companyProjects.find(
        (p) => p.projectType === "pdMechanization" && p.targetFactoryId === f.factoryId && p.status !== "cancelled",
      );
      return {
        factoryId: f.factoryId,
        companyId: f.companyId,
        previousQuarterPdUtilization: findPreviousQuarterPdUtilization(input.pdMechanizationState, f.factoryId),
        activeProjectId: activeProject?.projectId ?? null,
        mechanizationLevel: status?.mechanizationLevel ?? null,
        effectivePdCoefficient: status?.effectivePdCoefficient ?? null,
        basePdCoefficient: PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient,
        reductionRatio: status ? 1 - status.effectivePdCoefficient / PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient : null,
      };
    })
    .sort((a, b) => a.factoryId.localeCompare(b.factoryId));
}

function toExportRateTable(table: {
  readonly factoryId: string | null;
  readonly rows: readonly {
    readonly poolKey: CapacityPoolKey;
    readonly poolLabel: string;
    readonly nominalTons: number;
    readonly effectiveRate: number | undefined;
    readonly effectiveTons: number;
    readonly factors: readonly { readonly key: string; readonly label: string; readonly value: number }[];
    readonly factorsProduct: number | undefined;
    readonly correctionNote: string;
  }[];
}): ExportCapacityEffectiveRateTable {
  return {
    factoryId: table.factoryId,
    rows: table.rows.map((row) => ({
      poolKey: row.poolKey,
      poolLabel: row.poolLabel,
      nominalTons: row.nominalTons,
      effectiveRate: row.effectiveRate ?? null,
      effectiveTons: row.effectiveTons,
      factors: row.factors.map((f) => ({ key: f.key, label: f.label, value: f.value })),
      factorsProduct: row.factorsProduct ?? null,
      correctionNote: row.correctionNote,
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
