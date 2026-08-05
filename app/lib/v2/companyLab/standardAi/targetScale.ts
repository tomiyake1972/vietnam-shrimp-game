// ShrimpX V2 — Standard AI Target Scale Band（2026-08-05新設）
//
// 【三宅さんご指示・設計思想】「8期先の市場を精密予測する」のではなく、
// 「8期程度先にどんな会社になりたいか」を大まかなレンジ（Target Scale Band）として
// 持たせる。単一値ではなく min/preferred/max の帯（三宅さんご指示§4「だいたい
// 16,000〜20,000t程度の会社を目指す」という経営感覚）で表現する。
//
// 【市場予測をしないことの明示】ここでは8期先の市場シェア・数量を精密予測しない
// （三宅さんご指示§6）。GROWING/STABLE/WEAKENINGという大まかな方向性のみを
// 補助情報として算出し、Target Scale自体を大きく動かす主要因にはしない。
//
// 【算定方法】三宅さんご指示§5により、現時点のcompany size・実効生産能力・
// 資金体力・成長姿勢から算定する（未来市場の精密予測は使わない）。

import { CompanyFixture } from "../types";
import { StandardAiParameters } from "./parameters";
import { StandardAiObservation, sumProductAmount } from "./types";
import { StrategicIntent } from "./strategicIntent";

export interface TargetScaleBand {
  readonly quarterlySalesTons: {
    readonly min: number;
    readonly preferred: number;
    readonly max: number;
  };
}

export type MarketOpportunityDirection = "GROWING" | "STABLE" | "WEAKENING";

export interface TargetScaleResult {
  readonly targetScaleBand: TargetScaleBand;
  /** Target Scale算定の基準となった「現在の持続可能規模」（トン/四半期）。 */
  readonly currentSustainableScaleTons: number;
  /**
   * 市場機会の大まかな方向性（補助情報のみ。三宅さんご指示§6により、これを理由に
   * Target Scaleを大きく変えることはしない。lifecycleTrendByMarketが未接続
   * （SAI-5C機能OFF時等）の場合はundefined＝断定しない）。
   */
  readonly marketOpportunityDirection?: MarketOpportunityDirection;
}

const MARKET_DIRECTION_TREND_THRESHOLD = 0.004; // capexGrowthEntryTrendPerQuarterThresholdと同じ既存の基準を再利用（新しい閾値を発明しない）。

/**
 * Target Scale Bandを算定する（純粋関数）。
 *
 * 【三宅さんご指示§5への対応】
 *   - current company size / current effective production capacity: fixture.factories
 *     （能力）とobservation.lastQuarterActualProductionByProduct（直近実績）から。
 *   - under-construction capacity: observation.activeCapexProjectTargetsの有無のみを
 *     参照する（正確なトン数・完成タイミングは今回のTarget Scale算定には使わず、
 *     targetCapability.ts側の4Q capacity projectionで別途扱う。ここで数量を
 *     捏造しない）。
 *   - current financial strength: targetScale.ts自体では直接使わず、
 *     targetCapability.tsのFinanceable Scale診断で分離して扱う（三宅さんご指示§17
 *     「Strategic Target Scale vs Currently Financeable Scale」の分離方針）。
 *   - company growth posture: strategicIntent.growthPostureから
 *     targetScaleGrowthBandMultiplierByPostureを適用。
 *   - current market opportunityの大まかな方向: 補助情報としてのみ算出（主要因にしない）。
 */
export function computeTargetScaleBand(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  strategicIntent: StrategicIntent,
  params: StandardAiParameters
): TargetScaleResult {
  // 「現在の持続可能規模」= 直近実績と現在の実効生産能力の加重平均。
  // 実績だけだとturn1（実績ゼロ）や一時的な落ち込みに引きずられ、能力だけだと
  // 実際に売れている量を無視するため、両者を混合する（targetScaleCapacityWeightInBaseline）。
  const lastQuarterActualTons =
    (observation.lastQuarterActualProductionByProduct.hoso ?? 0) +
    (observation.lastQuarterActualProductionByProduct.pd ?? 0) +
    (observation.lastQuarterActualProductionByProduct.vap ?? 0);
  const effectiveCapacityTons = sumProductAmount(observation.totalEffectiveCapacityByProduct);

  const capacityWeight = params.targetScaleCapacityWeightInBaseline;
  // turn1等、直近実績が存在しない場合は能力側へ全面的に寄せる（実績ゼロに
  // 引きずられて規模目標がゼロになることを避ける。捏造ではなく、単純な
  // フォールバックであることを明示）。
  const currentSustainableScaleTons =
    lastQuarterActualTons > 0 ? lastQuarterActualTons * (1 - capacityWeight) + effectiveCapacityTons * capacityWeight : effectiveCapacityTons;

  const bandMultiplier = params.targetScaleGrowthBandMultiplierByPosture[strategicIntent.growthPosture];
  const quarterlySalesTons = {
    min: currentSustainableScaleTons * bandMultiplier.min,
    preferred: currentSustainableScaleTons * bandMultiplier.preferred,
    max: currentSustainableScaleTons * bandMultiplier.max,
  };

  // 市場機会の大まかな方向性（補助情報のみ）。公開ライフサイクルトレンドの
  // 市場×商品全体の単純平均符号から判定する。lifecycleTrendByMarketが
  // 未接続（SAI-5C機能OFF、またはturn1）の場合は断定せずundefined。
  let marketOpportunityDirection: MarketOpportunityDirection | undefined;
  if (observation.lifecycleTrendByMarket) {
    const trends: number[] = [];
    for (const byProduct of Object.values(observation.lifecycleTrendByMarket)) {
      for (const v of Object.values(byProduct)) trends.push(v);
    }
    if (trends.length > 0) {
      const avg = trends.reduce((s, v) => s + v, 0) / trends.length;
      if (avg > MARKET_DIRECTION_TREND_THRESHOLD) marketOpportunityDirection = "GROWING";
      else if (avg < -MARKET_DIRECTION_TREND_THRESHOLD) marketOpportunityDirection = "WEAKENING";
      else marketOpportunityDirection = "STABLE";
    }
  }

  return {
    targetScaleBand: { quarterlySalesTons },
    currentSustainableScaleTons,
    marketOpportunityDirection,
  };
}
