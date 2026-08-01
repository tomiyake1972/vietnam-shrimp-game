// ShrimpX V2 — PD専用機械化投資（省人化）の実効労務負荷係数（2026-08-01新規）
//
// 【背景】PD自動化戦略（製造業型）を成立させるため、capex/（既存の設備投資フロー）へ
// 「機械化レベル」という会社別の状態を軽量に追加し、それがPDの実効労務負荷係数
// （起点1.2、production/parameters.tsのlaborIntensityCoefficientByProduct.pd）を
// 下げる、という因果関係だけを成立させる。工場増設・PD機械化投資額そのものの
// 正式な意思決定フローは今回実装しない（別途設計レビュー予定）。
//
// 【新規の永続状態を作らない】会社別の機械化投資状態（投資水準・稼働開始時期・
// 累積習熟度）は、既存のCompanyCapexState（capex/types.ts）が保持するCapitalProjectの
// 状態遷移（completed・completedPeriod）とcapex/capacityEffect.tsの
// isCapexProjectOperationalAt/computeOperationalStartPeriod（稼働開始判定の唯一の
// 真実）から毎期再導出する。本ファイルはこれらを再実装せず、そのまま再利用する。
//
// 【mechanizationLevelの定義】
//   mechanizationLevel = rampProgress（0〜1、稼働開始からの習熟度） × 当期のPD稼働率（0〜1）
// 「低稼働なら効果が出ない」という設計要件（機械は動かしていなければ省人化効果を
// 生まない）を満たすため、投資が完成・稼働開始済みであっても、当期のPD操業度が
// 低ければ実効係数はほとんど下がらない。
//
// 【production/labor.tsの契約を壊さない】calculateLaborCapacityFromAssignedHeadcount・
// requiredHeadcountForQuantityのシグネチャは一切変更しない。呼び出し側
// （production/allocation.ts・companyLab/runner.ts）が、会社別に実効PD係数だけを
// 上書きしたProductionParametersのコピーを組み立てて渡す（buildProductionParametersWithEffectivePdIntensity
// 参照）。

import { PeriodV2, toYearQuarter } from "../core/period";
import { computeOperationalStartPeriod, isCapexProjectOperationalAt } from "../capex/capacityEffect";
import { CapitalProject } from "../capex/types";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "./parameters";

function quartersBetween(from: PeriodV2, to: PeriodV2): number {
  const a = toYearQuarter(from);
  const b = toYearQuarter(to);
  return (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter);
}

/**
 * 1件のpdMechanization案件の、period時点での習熟度（0〜1）。
 *   - 稼働開始前（isCapexProjectOperationalAtがfalse）は0。
 *   - 稼働開始四半期（t=0、「導入1四半期目」）は0（実装指示どおり、着工直後の
 *     四半期は効果ゼロとする）。
 *   - t=1..rampUpQuarters-1 は t/rampUpQuarters の線形立ち上がり。
 *   - t>=rampUpQuarters で満額（1.0）。
 * rampUpQuarters<=0（設定ミス）の場合は稼働開始と同時に満額とする。
 */
function computeProjectRampProgress(project: CapitalProject, period: PeriodV2): number {
  if (!isCapexProjectOperationalAt(project, period)) return 0;
  const effect = project.futureCapacityEffect?.laborIntensityReduction;
  if (!effect || project.completedPeriod === undefined) return 0;
  const readiness = project.futureCapacityEffect?.readinessQuartersAfterCompletion ?? 0;
  const operationalStart = computeOperationalStartPeriod(project.completedPeriod, readiness);
  const t = quartersBetween(operationalStart, period);
  if (t < 0) return 0;
  const rampUpQuarters = effect.rampUpQuarters;
  if (!(rampUpQuarters > 0)) return 1;
  if (t >= rampUpQuarters) return 1;
  return Math.max(0, Math.min(1, t / rampUpQuarters));
}

/**
 * 1社ぶんの投資案件ポートフォリオから、period時点のPD機械化「習熟度」（0〜1）を
 * 算出する（稼働率とはまだ掛け合わせていない）。同一会社が複数のpdMechanization
 * 案件を持つ場合は、最も進捗した案件の習熟度を採用する（効果を単純加算・重複
 * 計上しない、意図的な単純化）。稼働中の案件が無ければ0。
 */
export function computePdMechanizationRampProgress(projects: readonly CapitalProject[], period: PeriodV2): number {
  let best = 0;
  for (const project of projects) {
    if (project.projectType !== "pdMechanization") continue;
    const progress = computeProjectRampProgress(project, period);
    if (progress > best) best = progress;
  }
  return best;
}

/**
 * ある会社が保有するpdMechanization案件のうち、period時点で稼働開始済み
 * （isCapexProjectOperationalAt）のものが1件でもあれば、そのlaborIntensityReduction
 * メタデータ（maxReductionRatio・floorCoefficient）を返す（承認時スナップショットは
 * 案件ごとに独立だが、同一テンプレートから生成されるため通常は同一値。複数案件が
 * 異なる値を持つ場合はcomputePdMechanizationRampProgressと同じ「最も進捗した案件」を
 * 優先する）。1件も無ければundefined。
 */
export function findActivePdMechanizationEffect(
  projects: readonly CapitalProject[],
  period: PeriodV2
): { readonly maxReductionRatio: number; readonly floorCoefficient: number } | undefined {
  let bestProgress = -1;
  let bestEffect: { readonly maxReductionRatio: number; readonly floorCoefficient: number } | undefined;
  for (const project of projects) {
    if (project.projectType !== "pdMechanization") continue;
    if (!isCapexProjectOperationalAt(project, period)) continue;
    const effect = project.futureCapacityEffect?.laborIntensityReduction;
    if (!effect) continue;
    const progress = computeProjectRampProgress(project, period);
    if (progress > bestProgress) {
      bestProgress = progress;
      bestEffect = { maxReductionRatio: effect.maxReductionRatio, floorCoefficient: effect.floorCoefficient };
    }
  }
  return bestEffect;
}

/**
 * 習熟度（rampProgress、0〜1）と当期のPD稼働率（equipmentUtilizationRate等、0〜1）から
 * mechanizationLevel（0〜1）を算出する。「低稼働なら効果が出ない」という設計要件を
 * 満たす唯一の乗算箇所。
 */
export function computePdMechanizationLevel(rampProgress: number, currentQuarterPdUtilizationRate: number): number {
  const safeProgress = Number.isFinite(rampProgress) ? Math.max(0, Math.min(1, rampProgress)) : 0;
  const safeUtilization = Number.isFinite(currentQuarterPdUtilizationRate) ? Math.max(0, Math.min(1, currentQuarterPdUtilizationRate)) : 0;
  return safeProgress * safeUtilization;
}

/**
 * PDの実効労務負荷係数を算出する（実装指示のシグネチャどおり）。
 *   effective = max(floorCoefficient, baseCoefficient * (1 - maxReductionRatio * mechanizationLevel))
 * mechanizationLevel=0（投資直後・未稼働・稼働率0のいずれか）ならbaseCoefficientのまま。
 */
export function calculateEffectivePdLaborIntensity(
  baseCoefficient: number,
  mechanizationLevel: number,
  maxReductionRatio: number,
  floorCoefficient: number
): number {
  const safeLevel = Number.isFinite(mechanizationLevel) ? Math.max(0, Math.min(1, mechanizationLevel)) : 0;
  const safeMaxReduction = Number.isFinite(maxReductionRatio) ? Math.max(0, Math.min(1, maxReductionRatio)) : 0;
  const reduced = baseCoefficient * (1 - safeMaxReduction * safeLevel);
  return Math.max(floorCoefficient, reduced);
}

/**
 * baseParamsのlaborIntensityCoefficientByProduct.pdだけをeffectivePdCoefficientへ
 * 差し替えた新しいProductionParametersを返す（hoso/vapその他は一切変更しない）。
 * production/labor.tsのcalculateLaborCapacityFromAssignedHeadcount・
 * requiredHeadcountForQuantityへ、会社別に組み立てたこのコピーを渡すことで、
 * 2関数のシグネチャを変更せずに会社別の実効係数を反映する。
 */
export function buildProductionParametersWithEffectivePdIntensity(
  baseParams: ProductionParameters,
  effectivePdCoefficient: number
): ProductionParameters {
  return {
    ...baseParams,
    labor: {
      ...baseParams.labor,
      laborIntensityCoefficientByProduct: {
        ...baseParams.labor.laborIntensityCoefficientByProduct,
        pd: effectivePdCoefficient,
      },
    },
  };
}

/**
 * 会社1社ぶんの、当期のPD機械化状態一式から、実効PD労務負荷係数を反映した
 * ProductionParametersのコピーを直接組み立てる便利関数（呼び出し側の定型処理を
 * まとめたもの。個々の計算ステップは上記の各関数を個別に呼んでも同じ結果になる）。
 * pdMechanization案件が存在しない・未稼働の会社ではbaseParamsをそのまま返す
 * （オブジェクト参照そのものが同一になるため、変化が無いことを呼び出し側が
 * 安価に検知できる）。
 */
export function buildCompanyProductionParametersForPdMechanization(
  baseParams: ProductionParameters,
  projects: readonly CapitalProject[],
  period: PeriodV2,
  currentQuarterPdUtilizationRate: number
): ProductionParameters {
  const rampProgress = computePdMechanizationRampProgress(projects, period);
  if (rampProgress <= 0) return baseParams;
  const effect = findActivePdMechanizationEffect(projects, period);
  if (!effect) return baseParams;
  const mechanizationLevel = computePdMechanizationLevel(rampProgress, currentQuarterPdUtilizationRate);
  if (mechanizationLevel <= 0) return baseParams;
  const baseCoefficient = baseParams.labor.laborIntensityCoefficientByProduct.pd;
  const effectiveCoefficient = calculateEffectivePdLaborIntensity(baseCoefficient, mechanizationLevel, effect.maxReductionRatio, effect.floorCoefficient);
  if (effectiveCoefficient === baseCoefficient) return baseParams;
  return buildProductionParametersWithEffectivePdIntensity(baseParams, effectiveCoefficient);
}

// ---------------------------------------------------------------------
// 副次効果（小さく、上限付き）: PD歩留まり・規格外率・品質事故率への小さな改善
// ---------------------------------------------------------------------

/**
 * 【小さく、上限付き】機械化レベルに応じた、quality/batchAdjustment.tsの
 * baselineQualityOverride（会社×商品別の基準操業品質、Score0to100、既定85）への
 * 加点。主効果（Worker削減＝実効労務負荷係数の低減）よりも小さいことを意図した
 * 上限（MAX_QUALITY_BONUS_POINTS=3点、既定baseline=85に対し3.5%強に相当する
 * 程度の小さな改善幅）を設ける。mechanizationLevel=0（投資直後・未稼働・低稼働）
 * では加点0。
 */
const MAX_QUALITY_BONUS_POINTS = 3;

export function computePdMechanizationQualityBonus(mechanizationLevel: number): number {
  const safeLevel = Number.isFinite(mechanizationLevel) ? Math.max(0, Math.min(1, mechanizationLevel)) : 0;
  return MAX_QUALITY_BONUS_POINTS * safeLevel;
}

/** テスト・デフォルト呼び出し用に、production/parameters.tsのデフォルトを再エクスポートしておく（利便性のみ）。 */
export const DEFAULT_PRODUCTION_PARAMETERS_FOR_PD_MECHANIZATION: ProductionParameters = PRODUCTION_PARAMETERS_V1;
