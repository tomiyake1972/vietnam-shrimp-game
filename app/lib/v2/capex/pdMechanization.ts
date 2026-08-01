// ShrimpX V2 — PD省人化投資（機械化）の効果計算（Test15新設）
//
// 【この投資が変えるもの・変えないもの】
//   - 変えるもの: 対象Factory1件だけの「PD労働集約度係数」（production/labor.ts
//     effectiveEfficiencyPerHeadTons経由でのみ参照される、唯一の情報源）。
//   - 変えないもの: PD生産能力（Factory.pdCapacity）そのもの・HOSO/VAPの労働集約度・
//     他社・他工場のPD労働集約度。
//
// 【唯一の情報源】
//   PDの基準労働集約度係数（1.2）・フロア（HOSO=1.0）は、Task1で導入した
//   production/parameters.ts の labor.laborIntensityCoefficient を唯一の情報源とし、
//   ここで別の値として再定義しない（PD_MECHANIZATION_PARAMETERS_V1が起動時に
//   そこから読み取る）。
//
// 【実際に達成可能な最大削減率は20%ではなく16.67%（正確には1/6）】
//   フロア(1.0)を下回れないため、達成可能な削減率は
//     1 − フロア/基準係数 = 1 − 1.0/1.2 = 1/6 ≈ 16.666...%
//   である。この値はどこにもリテラルで書かず、必ずこのファイルの
//   PD_MECHANIZATION_REDUCTION_RATIO_AT_FULL_MATURITY（基準係数とフロアの比から
//   導出）を参照する。「20%」という表記は、パラメータ名・コメント・UI文言の
//   どこにも使わない。
//
// 【前四半期基準のタイミング（先読み禁止）】
//   当四半期の機械化レベルは、必ず「前四半期に確定したそのFactoryのPD稼働率」から
//   算出する（当四半期の実績を代用しない）。前四半期の値は
//   companyLab/pdMechanizationState.ts が明示的に保存・繰り越す（遡及導出しない）。

import { Product } from "../market/types";
import { PRODUCTION_PARAMETERS_V1 } from "../production/parameters";

export interface PdMechanizationParameters {
  readonly parametersVersion: string;
  /** PDの基準労働集約度係数（production/parameters.ts labor.laborIntensityCoefficient.pdをそのまま参照）。 */
  readonly baseCoefficient: number;
  /** 労働集約度係数のフロア（HOSO=1.0。production/parameters.ts labor.laborIntensityCoefficient.hosoをそのまま参照）。 */
  readonly floorCoefficient: number;
  /** 稼働開始からフル習熟（倍率1.0）に達するまでの四半期数（習熟期間）。 */
  readonly adoptionRampQuarters: number;
  /**
   * 稼働率データが無い（新規ゲーム・移行直後・PD生産実績が一度も無い工場、
   * 新設工場の初回PD生産四半期を含む）ときに使う、前四半期PD稼働率の初期値。
   * 【Test15暫定値・要校正】0.0（＝実績が無ければ機械化効果はまだ発現しない）。
   */
  readonly initialPdUtilizationRatio: number;
  /** PD稼働率算出時、分母をゼロ近傍とみなす許容誤差。 */
  readonly utilizationEpsilon: number;
}

export const PD_MECHANIZATION_PARAMETERS_V1: PdMechanizationParameters = {
  parametersVersion: "pdMechanization-v0.1",
  baseCoefficient: PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient.pd,
  floorCoefficient: PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient.hoso,
  adoptionRampQuarters: 2,
  initialPdUtilizationRatio: 0.0,
  utilizationEpsilon: 1e-6,
};

/**
 * フルランプ時（mechanizationLevel=1.0）に達成可能な最大削減率。
 * 1 − フロア/基準係数（= 1.2の場合は1 − 1.0/1.2 = 1/6 ≈ 0.16666667）。
 * 「20%」という誤った表記を避けるため、この値を唯一の情報源とし、UI文言も
 * 必ずこの値から動的にフォーマットする（formatReductionRatioAtFullMaturityLabel参照）。
 */
export function reductionRatioAtFullMaturity(params: PdMechanizationParameters = PD_MECHANIZATION_PARAMETERS_V1): number {
  if (!(params.baseCoefficient > 0)) return 0;
  return (params.baseCoefficient - params.floorCoefficient) / params.baseCoefficient;
}

/** UI・ログ表示用に「16.67%」のような文言を動的に生成する（"20%"を直接書かない）。 */
export function formatReductionRatioAtFullMaturityLabel(params: PdMechanizationParameters = PD_MECHANIZATION_PARAMETERS_V1): string {
  return `${(reductionRatioAtFullMaturity(params) * 100).toFixed(2)}%`;
}

/**
 * 稼働開始からの経過四半期数（0始まり。稼働開始四半期そのものが0）から、
 * 習熟進捗（0〜1）を求める。adoptionRampQuarters（習熟期間）で1.0に到達する
 * 線形ランプ（Test15暫定値・要校正）。
 */
export function computeAdoptionRampProgress(quartersSinceActivation: number, params: PdMechanizationParameters = PD_MECHANIZATION_PARAMETERS_V1): number {
  if (!Number.isFinite(quartersSinceActivation) || quartersSinceActivation <= 0) return 0;
  if (!(params.adoptionRampQuarters > 0)) return 1;
  return Math.max(0, Math.min(1, quartersSinceActivation / params.adoptionRampQuarters));
}

/**
 * 機械化レベル = 習熟進捗 × 前四半期のそのFactoryのPD稼働率。
 * 【重要】previousQuarterPdUtilizationは必ず「前四半期に確定した値」を渡すこと
 * （呼び出し側の責務。本関数自体はタイミングを一切検証しない純粋計算）。
 */
export function computeMechanizationLevel(adoptionRampProgress: number, previousQuarterPdUtilization: number): number {
  const safeRamp = Number.isFinite(adoptionRampProgress) ? Math.max(0, Math.min(1, adoptionRampProgress)) : 0;
  const safeUtilization = Number.isFinite(previousQuarterPdUtilization) ? Math.max(0, Math.min(1, previousQuarterPdUtilization)) : 0;
  return Math.max(0, Math.min(1, safeRamp * safeUtilization));
}

/**
 * 機械化レベルから、そのFactoryのPD実効労働集約度係数を求める。
 *   実効係数 = 基準係数 − (基準係数 − フロア) × 機械化レベル
 * mechanizationLevel=1.0のときは減算経路を使わず、フロア値をそのまま返す
 * （基準係数−(基準係数−フロア)の浮動小数点演算による微小な下振れを構造的に防ぐ。
 * 「フロアをわずかに下回る」という既知のバグを再発させないための実装上の配慮）。
 * mechanizationLevel<=0のときは基準係数（機械化効果なし）をそのまま返す。
 * 念のため、いずれの経路でもMath.maxでフロアを下回らないことを最終防御する。
 */
export function computeEffectivePdCoefficient(mechanizationLevel: number, params: PdMechanizationParameters = PD_MECHANIZATION_PARAMETERS_V1): number {
  const level = Number.isFinite(mechanizationLevel) ? Math.max(0, Math.min(1, mechanizationLevel)) : 0;
  if (level <= 0) return params.baseCoefficient;
  if (level >= 1) return params.floorCoefficient;
  const reduced = params.baseCoefficient - (params.baseCoefficient - params.floorCoefficient) * level;
  return Math.max(params.floorCoefficient, reduced);
}

/**
 * 1工場・1四半期ぶんのPD稼働率 = そのFactoryのPD finishedGoodsQuantity（完成品・
 * 販売可能ベース、production/batches.tsのProductionBatch.finishedGoodsQuantity）
 * ÷ そのFactoryのPD実効能力（production/capacity.tsのFactoryEffectiveCapacity.pd。
 * capacity.tsのコメントどおり「完成品HOSO換算量」の上限であり、原料投入側の量では
 * ない）。分子・分母のいずれも「歩留まり適用後（post-yield）の完成品HOSO換算量」で
 * 揃っており、原料投入量（pre-yield）を分子に使う取り違えを構造的に防ぐ
 * （呼び出し側はProductionBatch.rawMaterialConsumedTotalではなく必ず
 * finishedGoodsQuantityを渡すこと）。
 * 分母がepsilon以下、または不正値のときは0を返す（クリップ[0,1]）。
 */
export function computeFactoryPdUtilization(
  pdFinishedGoodsQuantity: number,
  pdEffectiveCapacity: number,
  params: PdMechanizationParameters = PD_MECHANIZATION_PARAMETERS_V1
): number {
  if (!(pdEffectiveCapacity > params.utilizationEpsilon)) return 0;
  const numerator = Number.isFinite(pdFinishedGoodsQuantity) && pdFinishedGoodsQuantity > 0 ? pdFinishedGoodsQuantity : 0;
  return Math.max(0, Math.min(1, numerator / pdEffectiveCapacity));
}

/** pdMechanization案件が唯一対象とする商品（PD以外には一切効果を及ぼさない）。 */
export const PD_MECHANIZATION_TARGET_PRODUCT: Extract<Product, "pd"> = "pd";
