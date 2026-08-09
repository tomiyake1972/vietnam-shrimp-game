// ShrimpX V2 — Strategic Growth Layer（Vision と現実の距離を測る層）
//
// 【この層が答える問い】
//   「この会社は、自分の志に対して今どこにいるのか。焦るべきか、待つべきか。」
//
// 【絶対規約】
//  1. **未来の TRUE WORLD を一切使わない。** 入力は Standard AI が実際に観測できる
//     値（現在の実効能力・前期の実績生産・観測需要）と、外から与えられた Vision だけ。
//     将来の需要・価格・シナリオイベントは引数として受け取れない形にしてある。
//  2. **限定合理性。** ここは「8年後を正しく予測するAI」ではない。
//     「志に対して足りていないという焦り（growth pressure）」を段階として表すだけ。
//  3. **Vision は quota ではない。** gap があること自体は異常ではない。
//     gap は投資検討の入口を開くだけで、財務・市場・労働の各ゲートを免除しない。

import { CompanyVision, GrowthAmbition, referenceScaleAtTurn } from "./types";

/** 志に対する遅れの強さ。段階であり、連続スコアではない（不透明な単一スコアを作らない）。 */
export type GrowthPressure = "LOW" | "MODERATE" | "HIGH" | "URGENT";

export const GROWTH_PRESSURE_ORDER: readonly GrowthPressure[] = ["LOW", "MODERATE", "HIGH", "URGENT"];

export function growthPressureAtLeast(actual: GrowthPressure, minimum: GrowthPressure): boolean {
  return GROWTH_PRESSURE_ORDER.indexOf(actual) >= GROWTH_PRESSURE_ORDER.indexOf(minimum);
}

export interface StrategicGrowthParameters {
  /** ambition 調整後の gap 比率が、この値以下なら LOW（＝志どおり進んでいる）。 */
  readonly moderateThreshold: number;
  readonly highThreshold: number;
  readonly urgentThreshold: number;
  /**
   * 成長意欲による gap の感じ方の係数。
   * 同じ 20% の遅れでも、HIGH ambition の会社は強く焦り、LOW ambition の会社は焦らない。
   * 「未来予測の精度」ではなく「経営者の性格」を表す係数である。
   */
  readonly ambitionSensitivity: Readonly<Record<GrowthAmbition, number>>;
}

export const STRATEGIC_GROWTH_PARAMETERS_V1: StrategicGrowthParameters = {
  moderateThreshold: 0.05,
  highThreshold: 0.18,
  urgentThreshold: 0.35,
  ambitionSensitivity: { HIGH: 1.2, MEDIUM: 1.0, LOW: 0.7 },
};

export interface StrategicGrowthState {
  readonly visionId: string;
  /** 今ターンで Vision が参照する規模（REFERENCE PATH 上の点。目標義務ではない）。 */
  readonly visionTargetScaleAtCurrentTurn: number;
  readonly visionTargetScaleAtQ32: number;
  /** 現在の持続可能規模（Standard AI の既存 targetScale.ts の算定値をそのまま使う）。 */
  readonly currentSustainableScaleTons: number;
  /** 参照規模 − 現在の持続可能規模。負なら志より先行している。 */
  readonly strategicScaleGapTons: number;
  /** gap ÷ 参照規模。参照規模が 0 以下なら 0（0除算で無限大の焦りを作らない）。 */
  readonly strategicScaleGapRatio: number;
  /** 成長意欲で調整した gap 比率（growthPressure の判定に使った値）。 */
  readonly ambitionAdjustedGapRatio: number;
  readonly growthPressure: GrowthPressure;
  /** 志の軌道に乗っているか（growthPressure === "LOW"）。 */
  readonly onTrack: boolean;
}

export interface StrategicGrowthInput {
  readonly vision: CompanyVision;
  readonly turn: number;
  /** targetScale.ts の computeTargetScaleBand が返す currentSustainableScaleTons。 */
  readonly currentSustainableScaleTons: number;
  /**
   * referenceGrowthPath が空のときだけ使う開始規模。
   * 既定 Vision は全社 waypoint を持つため通常は使われない。
   */
  readonly startingScaleTonsPerQuarter?: number;
  readonly horizonTurn?: number;
  readonly params?: StrategicGrowthParameters;
}

/**
 * Vision と現在地から strategic scale gap と growth pressure を求める（純粋関数）。
 * 未来の TRUE WORLD は引数に存在しない。
 */
export function computeStrategicGrowthState(input: StrategicGrowthInput): StrategicGrowthState {
  const params = input.params ?? STRATEGIC_GROWTH_PARAMETERS_V1;
  const horizonTurn = input.horizonTurn ?? 32;
  const reference = referenceScaleAtTurn(
    input.vision,
    input.turn,
    input.startingScaleTonsPerQuarter ?? input.currentSustainableScaleTons,
    horizonTurn
  );
  const current = input.currentSustainableScaleTons;
  const gapTons = reference - current;
  const gapRatio = reference > 0 ? gapTons / reference : 0;
  const sensitivity = params.ambitionSensitivity[input.vision.growthAmbition];
  const adjusted = gapRatio * sensitivity;

  const growthPressure: GrowthPressure =
    adjusted > params.urgentThreshold
      ? "URGENT"
      : adjusted > params.highThreshold
        ? "HIGH"
        : adjusted > params.moderateThreshold
          ? "MODERATE"
          : "LOW";

  return {
    visionId: input.vision.visionId,
    visionTargetScaleAtCurrentTurn: reference,
    visionTargetScaleAtQ32: input.vision.targetScaleTonsPerQuarterAtQ32,
    currentSustainableScaleTons: current,
    strategicScaleGapTons: gapTons,
    strategicScaleGapRatio: gapRatio,
    ambitionAdjustedGapRatio: adjusted,
    growthPressure,
    onTrack: growthPressure === "LOW",
  };
}
