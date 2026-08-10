// ShrimpX V2 — Phase 6C: Commercial Commitment（今期どこまで市場へ取りに行くか）
//
// 【この層が存在する理由（#05 Phase 6C §1・§5）】
// Phase 6B で、現行の市場別営業能力が「営業能力の表現」であると同時に、
// **偶然、販売提出量のリミッター**として働いていたことが判明した。営業能力の壁を
// 外した途端、Commercial Ambition がほぼそのまま提出量になり、
//   提出 24,420t → 成約 14,425t（転換率59%）→ 生産は提出量へ追随 → 在庫3倍
// という崩壊が起きた（32Q累計営業利益 −61%）。
//
// したがって、次の4つを**別々の量**として明示的に分ける。
//
//   Commercial Ambition   … 志として、どこまで売りたいか（vision/commercialAmbition.ts）
//   Commercial Commitment … 今期、実際に市場へ取りに行く量（このモジュール）
//   Contracts             … 市場が実際に応じた量（エンジンが決める）
//   Production Requirement… 実際に作る量（diagnosis/productionRequirement.ts）
//
// 【設計の要点】
//   - 単純な乗数（submitted = ambition × 1.5）は禁止（§6）。
//   - 過去の「提出 → 成約」転換率を bounded rational に学習する（§7）。
//   - ただし転換率100%を目標にはしない（§8）。市場開拓では未成約は正常であり、
//     目標転換率は 70〜90% 程度の帯とする。
//   - 完成品在庫が多いことを理由に**提出を減らさない**（§12）。
//     在庫は「生産を抑える理由」であって「売るのをやめる理由」ではない。

import { CommercialAmbition } from "./commercialAmbition";

const EPSILON = 1e-6;

/** 提出量を実際に縛った要因（1つだけ選ぶ。診断の主因表示に使う）。 */
export type CommitmentLimiter =
  | "NONE" // 志のまま取りに行けた
  | "RECENT_CONVERSION" // 直近の転換率が低く、取りに行く量を抑えた
  | "MARKET_OPPORTUNITY" // 観測できる採算つき市場機会が足りない
  | "SALES_CAPACITY" // 営業組織が捌ける案件量が足りない
  | "STRETCH_LIMIT"; // 志に対する上乗せ幅の上限に当たった

export interface CommercialCommitmentParameters {
  /**
   * 目標とする「提出 → 成約」転換率の帯（§8）。
   * 下限を下回る転換率が続けば提出を絞り、上限を上回るなら取りに行く量を増やす。
   * **100%を目標にしない**（未成約ゼロは市場開拓を止めた状態である）。
   */
  readonly targetConversionFloor: number;
  readonly targetConversionCeiling: number;
  /**
   * 志に対して提出量を上乗せできる最大倍率。
   * 転換率が極端に低く観測された場合でも、提出量が無制限に膨らまないための天井。
   */
  readonly maximumStretchOverAmbition: number;
  /** 観測転換率をこの下限で打ち切る（0付近の観測で提出量が発散するのを防ぐ）。 */
  readonly minimumUsableConversion: number;
  /**
   * 観測転換率と目標帯の中央値をどの比率で混ぜるか（0=観測を無視、1=観測のみ）。
   * bounded rationality: 直近の実績を全面的に信じ切らない。
   */
  readonly conversionLearningRate: number;
  /**
   * 観測できる採算つき市場機会のうち、1社が現実に取りに行ける比率。
   * commercialAmbition.ts の realisticShareOfProfitableOpportunity と同じ思想。
   */
  readonly realisticShareOfOpportunity: number;
  /**
   * 生産必要量の計算に使う期待転換率の下限。
   * 観測が極端に低い四半期でも、生産をゼロ近くまで落とさない（§20 の
   * 「production 0 など不自然な停止」を避ける）。
   */
  readonly productionExpectedConversionFloor: number;
}

/**
 * 【暫定値・要校正】Phase 6B の実測から置いた初期値。
 *   - Control（現行）の転換率は実測でほぼ 100%（提出=成約）。
 *   - Case C（会社全体営業能力）では 54〜61%。
 * 目標帯 0.75〜0.90 は「市場開拓として自然な未成約」を残しつつ、
 * 在庫が積み上がらない水準として置いた。ハードコードしすぎない方針に従い、
 * すべてこの1箇所に集約する。
 */
export const COMMERCIAL_COMMITMENT_PARAMETERS_V1: CommercialCommitmentParameters = {
  targetConversionFloor: 0.75,
  targetConversionCeiling: 0.9,
  maximumStretchOverAmbition: 1.25,
  minimumUsableConversion: 0.35,
  conversionLearningRate: 0.7,
  realisticShareOfOpportunity: 0.5,
  productionExpectedConversionFloor: 0.5,
};

export interface CommercialCommitmentInput {
  /** 志（vision/commercialAmbition.ts の結果）。null なら Vision 不在。 */
  readonly ambition: CommercialAmbition | null;
  /** 供給側アンカー（自社能力 × 稼働率目標）。ambition が無い場合の基準。 */
  readonly capacityAnchorTons: number;
  /** 観測できる採算つき獲得可能需要（未来の TRUE WORLD は含まない）。 */
  readonly attainableProfitableTons: number;
  /** 直近の「提出 → 成約」転換率。観測できない場合は null。 */
  readonly observedConversionRatio: number | null;
  /** 観測に使えた四半期数（0 なら履歴なし）。 */
  readonly observedQuarters: number;
  /**
   * 営業組織が捌ける案件量（HOSO換算トン）。
   * **「必ず成約する量」ではなく「提出できる量の上限要因の一つ」**（§9）。
   * 観測できない場合は null（上限として使わない）。
   */
  readonly salesCapacityTons: number | null;
  /** 既存の未履行契約残（受注残）。 */
  readonly backlogTons: number;
  /** 完成品在庫。**提出量を減らす理由には使わない**（§12）。診断のため受け取る。 */
  readonly finishedGoodsTons: number;
  readonly params?: CommercialCommitmentParameters;
}

export interface CommercialCommitmentState {
  /** 今期、市場へ取りに行く量（＝提出量の上限）。 */
  readonly submissionTargetTons: number;
  /** 志に対する比率（1.0 なら志のまま、1.25 なら25%上乗せ）。 */
  readonly stretchOverAmbition: number;
  /**
   * 今期の判断に使った期待転換率。観測と目標帯を混ぜた値。
   * 生産必要量の計算にも同じ値を使う（提出量と生産量で別の前提を持たない）。
   */
  readonly expectedConversionRatio: number;
  /** 生産必要量に使う期待転換率（下限で打ち切った値）。 */
  readonly productionExpectedConversionRatio: number;
  /** 上のうち、実際に提出量を縛った要因。 */
  readonly limiter: CommitmentLimiter;
  /** 各上限の内訳（説明可能性のためすべて残す）。 */
  readonly caps: {
    readonly ambitionTons: number;
    readonly conversionAdjustedTons: number;
    readonly stretchLimitTons: number;
    readonly opportunityTons: number | null;
    readonly salesCapacityTons: number | null;
  };
  /** 過剰提出リスク（期待成約が志を大きく下回る状態が続いているか）。 */
  readonly overSubmissionRisk: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 今期の Commercial Commitment（提出目標量）を決める。
 *
 * 【計算の流れ】
 *   1. 志（ambition）を出発点にする。志が無ければ供給側アンカーを使う。
 *   2. 期待転換率を求める。
 *      観測が無い → 目標帯の上限（＝ほぼ提出どおり成約する前提。現行 Control 相当）
 *      観測がある → 観測値と目標帯中央値を conversionLearningRate で混ぜ、
 *                   minimumUsableConversion で下から打ち切る。
 *   3. 「志を成約するために必要な提出量」= 志 ÷ 期待転換率。
 *      ただし志に対する上乗せは maximumStretchOverAmbition が天井。
 *   4. 観測できる市場機会・営業能力で上から抑える。
 *   5. 完成品在庫では**下げない**（§12）。
 */
export function computeCommercialCommitment(input: CommercialCommitmentInput): CommercialCommitmentState {
  const params = input.params ?? COMMERCIAL_COMMITMENT_PARAMETERS_V1;

  const ambitionTons = Math.max(0, input.ambition?.ambitionTons ?? input.capacityAnchorTons);
  const targetMid = (params.targetConversionFloor + params.targetConversionCeiling) / 2;

  // --- 期待転換率（bounded rational な学習） ---
  let expectedConversionRatio: number;
  if (input.observedConversionRatio === null || input.observedQuarters === 0) {
    // 履歴が無い（ゲーム開始直後）。取りに行く量を根拠なく膨らませない。
    expectedConversionRatio = params.targetConversionCeiling;
  } else {
    const observed = clamp(input.observedConversionRatio, params.minimumUsableConversion, 1);
    expectedConversionRatio = observed * params.conversionLearningRate + targetMid * (1 - params.conversionLearningRate);
    expectedConversionRatio = clamp(expectedConversionRatio, params.minimumUsableConversion, 1);
  }

  // --- 志を成約するために必要な提出量 ---
  const conversionAdjustedTons = expectedConversionRatio > EPSILON ? ambitionTons / expectedConversionRatio : ambitionTons;
  const stretchLimitTons = ambitionTons * params.maximumStretchOverAmbition;

  // --- 観測できる市場機会 ---
  const opportunityTons =
    input.attainableProfitableTons > EPSILON ? input.attainableProfitableTons * params.realisticShareOfOpportunity : null;

  // --- 上限の合成（どれが効いたかを記録する） ---
  let submissionTargetTons = conversionAdjustedTons;
  let limiter: CommitmentLimiter = expectedConversionRatio < params.targetConversionCeiling - EPSILON ? "RECENT_CONVERSION" : "NONE";

  if (submissionTargetTons > stretchLimitTons + EPSILON) {
    submissionTargetTons = stretchLimitTons;
    limiter = "STRETCH_LIMIT";
  }
  // 市場機会は「志＋受注残」を下回るときだけ効く（既存契約の履行分まで否定しない）。
  if (opportunityTons !== null && opportunityTons < submissionTargetTons - EPSILON) {
    submissionTargetTons = opportunityTons;
    limiter = "MARKET_OPPORTUNITY";
  }
  if (input.salesCapacityTons !== null && input.salesCapacityTons < submissionTargetTons - EPSILON) {
    submissionTargetTons = input.salesCapacityTons;
    limiter = "SALES_CAPACITY";
  }

  submissionTargetTons = Math.max(0, submissionTargetTons);

  // --- 生産に使う期待転換率 ---
  // 【提出量の判断とは別の値を使う理由】
  // 提出量は「目標転換率 75〜90% を狙って取りに行く」ための量であり、目標帯へ
  // 引き寄せた混合値を使う。一方、生産量は「実際に何トン成約しそうか」という
  // 予測であって目標ではない。ここで目標帯へ引き寄せると、転換率が実際には
  // ほぼ100%の会社（現行 Control）でも生産を5%ほど過小に見積もってしまう。
  // したがって生産側は**観測値そのもの**を下限で打ち切って使う。
  // 観測が無い（ゲーム開始直後）場合は 1.0（＝従来と完全に同一の挙動）。
  const productionExpectedConversionRatio =
    input.observedConversionRatio === null || input.observedQuarters === 0
      ? 1
      : clamp(input.observedConversionRatio, params.productionExpectedConversionFloor, 1);

  return {
    submissionTargetTons,
    stretchOverAmbition: ambitionTons > EPSILON ? submissionTargetTons / ambitionTons : 1,
    expectedConversionRatio,
    productionExpectedConversionRatio,
    limiter,
    caps: {
      ambitionTons,
      conversionAdjustedTons,
      stretchLimitTons,
      opportunityTons,
      salesCapacityTons: input.salesCapacityTons,
    },
    overSubmissionRisk:
      input.observedConversionRatio !== null &&
      input.observedQuarters >= 2 &&
      input.observedConversionRatio < params.targetConversionFloor,
  };
}
