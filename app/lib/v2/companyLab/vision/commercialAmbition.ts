// ShrimpX V2 — Commercial Ambition（Phase 6・2026-08-09新設）
//
// 【この層が生まれた理由（監査結果）】
// Phase 5 までの Standard AI は、販売希望量を
//
//     自社工場の名目能力 × salesUtilizationTarget(0.8)
//
// だけで決めていた（decision/sales.ts）。市場需要も Vision も一切参照していない。
// 実測（scripts/commercialGrowthAudit.ts、baseline 32Q）では、この式が
// 5社すべて・全32四半期で**誤差ゼロ**で成立していた：
//
//     BAL 20,000×0.8=16,000 / MASS 22,000×0.8=17,600 / JPQ 21,000×0.8=16,800
//     VAP 20,000×0.8=16,000 / CONSV 19,000×0.8=15,200
//
// JPQ・VAP・CONSV は Q5〜Q32 で希望量の変動幅が **0.0%** だった。
// さらに営業採用側も min(TargetScaleBand.max, 実効能力) で頭打ちになるため、
//
//     能力 → 販売希望 → 営業人数 → 成約 → 生産 → 稼働率 → 能力増設可否 → 能力
//
// という**閉じた循環**が成立し、会社は初期工場を構造的に卒業できなかった。
// 観測できる採算つき機会は1社あたり約82,000〜92,500t/四半期あり、提出計画は
// その 15〜17% にすぎず、しかも提出した分の 99.3〜99.9% は成約していた。
// つまり市場で負けていたのではなく、**そもそも取りにいっていなかった**。
//
// 【この層の役割】
//   Vision（志） → Commercial Ambition（今期どのくらいの規模を目指したいか）
// を作り、上の循環を断つ。
//
// 【絶対規約】
//  1. **未来の TRUE WORLD を使わない。** 入力は Vision と観測可能な値だけ。
//  2. **quota ではない。** 市場機会が弱ければ上がらない。採算が悪ければ上がらない。
//     Vision に届かないことは異常ではない。
//  3. **1四半期で倍増しない。** 現実の経営者と同じく段階的に上げる。
//  4. **「売りたい量」であって「作る量」ではない。** 生産・契約の上限は
//     既存の生産能力・営業工数・納品規律がそのまま縛る（過剰契約を作らない）。

import { CompanyVision } from "./types";
import { GrowthPressure, StrategicGrowthState, growthPressureAtLeast } from "./strategicGrowth";

const EPSILON = 1e-6;

/** Commercial Ambition を押し上げた／押しとどめた要因。 */
export type CommercialAmbitionLimiter =
  /** 志の軌道に乗っており、規模拡大を急ぐ理由がない。 */
  | "VISION_ON_TRACK"
  /** 観測できる採算つき市場機会が乏しい。 */
  | "MARKET_WEAK"
  /** 採算（期待貢献）が薄く、量を追う局面ではない。 */
  | "MARGIN_WEAK"
  /** 完成品在庫が過剰で、まず売り切るべき局面。 */
  | "INVENTORY_EXCESS"
  /** 段階的成長の上限に達した（1四半期の伸び幅の上限）。 */
  | "STEP_LIMIT"
  /** 観測できる採算つき機会そのものが上限になった。 */
  | "OPPORTUNITY_CEILING"
  /** 何も抑制しなかった。 */
  | "NONE";

export interface CommercialAmbitionParameters {
  /**
   * 1四半期に引き上げられる規模の上限比率（成長意欲別）。
   * 現実の経営者と同じく、志が大きくても一気には動かない。
   */
  readonly maxStepRatioByAmbition: Readonly<Record<CompanyVision["growthAmbition"], number>>;
  /** 成長圧力別の、段階上げの強さ（0〜1。上の上限へ掛ける）。 */
  readonly stepIntensityByPressure: Readonly<Record<GrowthPressure, number>>;
  /**
   * 観測できる採算つき機会のうち、1社が現実的に狙ってよいと考える比率。
   * 【なぜ必要か】attainableProfitableTons は「1社が取れる理論上限（各市場×商品の
   * 需要×maximumSupplierShare の総和）」であり、全市場で同時に上限まで取れると
   * 考えるのは限定合理的でない。営業網・信頼・納期の現実を踏まえた控えめな係数。
   */
  readonly realisticShareOfProfitableOpportunity: number;
  /** 完成品在庫がこの比率を超えて過剰なら、規模拡大を見送る。 */
  readonly inventoryExcessHoldRatio: number;
  /** 期待貢献がこの水準（USD/HOSO換算kg）を下回るなら、量を追わない。 */
  readonly minimumContributionUsdPerKg: number;
  /** 成長投資を検討し始める最低の成長圧力。 */
  readonly minimumPressureForExpansion: GrowthPressure;
}

export const COMMERCIAL_AMBITION_PARAMETERS_V1: CommercialAmbitionParameters = {
  maxStepRatioByAmbition: { HIGH: 0.12, MEDIUM: 0.07, LOW: 0.03 },
  stepIntensityByPressure: { LOW: 0, MODERATE: 0.5, HIGH: 0.8, URGENT: 1 },
  realisticShareOfProfitableOpportunity: 0.35,
  inventoryExcessHoldRatio: 1.5,
  minimumContributionUsdPerKg: 0.05,
  minimumPressureForExpansion: "MODERATE",
};

export interface CommercialAmbitionInput {
  readonly vision: CompanyVision | null;
  readonly strategicGrowth: StrategicGrowthState | null;
  /**
   * これまでの規模の基準（HOSO換算トン/四半期）。
   * 従来の供給側アンカー（名目能力×salesUtilizationTarget）をそのまま渡す。
   * **Commercial Ambition はこれを下回らない**（既存挙動を壊さない床）。
   */
  readonly capacityAnchorTons: number;
  /** 前四半期の実績生産量合計（観測値）。実際に回せている規模。 */
  readonly recentActualScaleTons: number;
  /** 観測できる採算つき機会（decision/sales.ts の共有計算）。 */
  readonly attainableProfitableTons: number;
  /** 採算つき機会の加重平均期待貢献。 */
  readonly weightedContributionUsdPerKg: number;
  /** 参照売価が1つも観測できていない（turn1等）。採算を断定しない。 */
  readonly priceObservationMissing: boolean;
  /** 完成品在庫の過剰比率（最大値。pressures.finishedGoodsExcessRatioByProduct 由来）。 */
  readonly maxFinishedGoodsExcessRatio: number;
  /**
   * 【Phase SAI-GROW-3A】1四半期の伸び幅上限（step limit）に掛ける倍率。
   * 未指定なら1＝**従来と完全に同一**。observable evidence（市場headroom・成約率・
   * 採算・在庫・財務・危機）が揃ったときだけ、呼び出し側（standardAi/growth）が
   * 1より大きい値を渡す。ここでevidenceの判定はしない（この層は志の計算に専念する）。
   */
  readonly stepLimitMultiplier?: number;
  readonly params?: CommercialAmbitionParameters;
}

export interface CommercialAmbition {
  /** 今期このくらいの規模を目指したい、という量（HOSO換算トン/四半期）。 */
  readonly ambitionTons: number;
  /** 引き上げ前の基準（capacityAnchor と直近実績の大きい方）。 */
  readonly baselineTons: number;
  /** Vision を理由に上乗せした量（ambition − baseline）。 */
  readonly visionPullTons: number;
  /** baseline に対する倍率。sales の希望量ベクトルへ掛ける係数そのもの。 */
  readonly ambitionMultiplier: number;
  /** 【GROW-3A】適用前の1四半期の伸び幅（maxStep × intensity）。 */
  readonly baseStepRatio: number;
  /** 【GROW-3A】実際に適用した伸び幅（baseStepRatio × stepLimitMultiplier）。 */
  readonly effectiveStepRatio: number;
  /** 現実的に狙ってよいと判断した機会量（上限として効いたか判定するための値）。 */
  readonly realisticOpportunityTons: number;
  readonly limiter: CommercialAmbitionLimiter;
  /** 拡大したか（限定合理的に「今の規模で満足しない」と判断したか）。 */
  readonly expanded: boolean;
}

/**
 * Commercial Ambition を求める（純粋関数）。
 * 未来の需要・価格・シナリオイベントは引数に存在しない。
 */
export function computeCommercialAmbition(input: CommercialAmbitionInput): CommercialAmbition {
  const params = input.params ?? COMMERCIAL_AMBITION_PARAMETERS_V1;

  // 基準は「供給側アンカー」と「直近で実際に回せていた規模」の大きい方。
  // 直近実績だけを基準にすると、一度落ち込んだ会社が二度と戻れなくなる。
  const baselineTons = Math.max(input.capacityAnchorTons, input.recentActualScaleTons);
  const hold = (limiter: CommercialAmbitionLimiter): CommercialAmbition => ({
    ambitionTons: baselineTons,
    baselineTons,
    visionPullTons: 0,
    ambitionMultiplier: 1,
    baseStepRatio: 0,
    effectiveStepRatio: 0,
    realisticOpportunityTons: input.attainableProfitableTons * params.realisticShareOfProfitableOpportunity,
    limiter,
    expanded: false,
  });

  // --- Vision が無ければ、従来どおりの供給側アンカーのまま（挙動を変えない） ---
  if (!input.vision || !input.strategicGrowth) return hold("VISION_ON_TRACK");

  // --- 志の軌道に乗っているなら拡大しない（VAP のような会社を無理に伸ばさない） ---
  if (!growthPressureAtLeast(input.strategicGrowth.growthPressure, params.minimumPressureForExpansion)) {
    return hold("VISION_ON_TRACK");
  }

  // --- 在庫が過剰なら、まず売り切る（作った物が余っているのに規模を語らない） ---
  if (input.maxFinishedGoodsExcessRatio > params.inventoryExcessHoldRatio) return hold("INVENTORY_EXCESS");

  // --- 市場機会が観測できないなら拡大しない（捏造しない） ---
  const realisticOpportunityTons = input.attainableProfitableTons * params.realisticShareOfProfitableOpportunity;
  if (input.priceObservationMissing || input.attainableProfitableTons <= EPSILON) return hold("MARKET_WEAK");
  if (realisticOpportunityTons <= baselineTons + EPSILON) return hold("MARKET_WEAK");

  // --- 採算が薄いなら量を追わない ---
  if (input.weightedContributionUsdPerKg < params.minimumContributionUsdPerKg) return hold("MARGIN_WEAK");

  // --- ここまで来て初めて、志を理由に規模を引き上げる ---
  const maxStep = params.maxStepRatioByAmbition[input.vision.growthAmbition];
  const intensity = params.stepIntensityByPressure[input.strategicGrowth.growthPressure];
  const baseStepRatio = maxStep * intensity;
  // 【GROW-3A】step limitは削除しない。observable evidenceが揃ったときだけ、
  // 呼び出し側が渡す倍率（既定1＝従来と完全同一）で連続的に拡大する。
  const stepLimitMultiplier = Math.max(1, input.stepLimitMultiplier ?? 1);
  const stepRatio = baseStepRatio * stepLimitMultiplier;
  const stepped = baselineTons * (1 + stepRatio);

  // 志の参考規模を超えて背伸びしない（Vision は上限でもある）。
  const visionCeiling = Math.max(baselineTons, input.strategicGrowth.visionTargetScaleAtCurrentTurn);
  // 観測できる採算つき機会も超えない。
  const ambitionTons = Math.min(stepped, visionCeiling, realisticOpportunityTons);

  const limiter: CommercialAmbitionLimiter =
    ambitionTons <= baselineTons + EPSILON
      ? "MARKET_WEAK"
      : ambitionTons >= stepped - EPSILON
        ? "STEP_LIMIT"
        : ambitionTons >= realisticOpportunityTons - EPSILON
          ? "OPPORTUNITY_CEILING"
          : "NONE";

  return {
    ambitionTons,
    baselineTons,
    visionPullTons: Math.max(0, ambitionTons - baselineTons),
    ambitionMultiplier: baselineTons > EPSILON ? ambitionTons / baselineTons : 1,
    baseStepRatio,
    effectiveStepRatio: stepRatio,
    realisticOpportunityTons,
    limiter,
    expanded: ambitionTons > baselineTons + EPSILON,
  };
}
