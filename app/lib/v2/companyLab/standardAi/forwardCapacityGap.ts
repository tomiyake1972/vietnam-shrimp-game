// ShrimpX V2 — Standard AI: Forward Capacity Gap（先行能力投資型戦略の中心指標）
//
// 【この関数がすること】新工場が完成する予定ターン時点で、既存能力が
// 「その時点で必要になっていそうな生産規模」に対してどれだけ不足するかを見積もる。
// 「今」の稼働率・受注残ではなく「完成した時点」を見る（設計文書
// docs/standard_ai/STRATEGIC_POSTURE_AGGRESSIVE_EARLY_CAPACITY.md §4/§5参照）。
//
// 【限定合理性・TRUE未来を読まない】
// ここで使ってよいのは、Standard AIが既に観測できる値だけである。
//   ・Vision の参考成長軌道（会社自身の志。referenceScaleAtTurn）
//   ・Commercial Ambition（今期どれだけ売りたいかの、観測済み情報からの既存判断）
//   ・持続的な生産能力起因の未充足機会（unservedOpportunity。Gate Iが既に使う値）
// シナリオの将来イベント・TRUE需要・TRUE価格は一切引数に存在しない。
//
// 【新しい計算を作らない】
//   ・completion turn の算出は capex/parameters.ts の既存テンプレート値
//     （standardConstructionQuarters + postCompletionReadinessQuarters）を
//     使う。ここへ独自の「4」等の定数を書かない。
//   ・「今の持続可能な生産能力」は bindingCapacity.ts の
//     computeBindingProductionCapacityTons を呼ぶ側から渡してもらう
//     （このファイルでは再計算しない＝Phase 6D-1で修正したSSoT不整合を再発させない）。

import { CapexParameters } from "../../capex/parameters";
import { CompanyVision, referenceScaleAtTurn } from "../vision/types";

export interface MarketGrowthEvidence {
  /**
   * 直近の自社成約成長を示す、四半期あたりの比率。
   * Commercial Ambition（既存モジュール）の ambitionMultiplier - 1 をそのまま使う
   * （新しいtrend検出ロジックを作らない）。観測できなければnull。
   */
  readonly recentOwnContractGrowthRatio: number | null;
  /**
   * 観測可能な市場成長の裏づけ。生産能力が理由で持続的に取り切れていない
   * 機会（Gate Iが既に使うunservedOpportunity.blockedByProductionCapacityTons）を
   * 現在の実効能力に対する比率として表す。持続的な証拠が無ければnull
   * （単発の好調期を成長と誤認しない）。
   */
  readonly observedMarketGrowthRatio: number | null;
}

export interface ForwardCapacityGapInput {
  readonly turn: number;
  readonly vision: CompanyVision;
  /** 今の持続可能な生産能力（bindingCapacity.tsの計算結果をそのまま渡す）。 */
  readonly currentSustainableScaleTons: number;
  readonly marketGrowthEvidence: MarketGrowthEvidence;
  readonly capexParams: CapexParameters;
  /** Vision参考軌道の地平線（既定32、既存のreferenceScaleAtTurnと同じ既定値）。 */
  readonly horizonTurn?: number;
}

export interface ForwardCapacityGapResult {
  readonly constructionLeadTimeQuarters: number;
  readonly forecastCompletionTurn: number;
  readonly visionReferenceScaleAtCompletion: number;
  /** §5.2: 自社成長・観測市場成長のどちらも支持する場合だけ正になる（min(a,b)）。 */
  readonly observedGrowthRatioPerQuarter: number;
  readonly trendAdjustedScaleAtCompletion: number;
  readonly projectedCommercialScaleAtCompletion: number;
  readonly projectedRequiredProductionAtCompletion: number;
  readonly existingCapacityAtCompletion: number;
  readonly forwardCapacityGapTons: number;
  readonly forwardCapacityGapRatio: number;
}

/** 新工場テンプレートから、建設リードタイム（着工〜稼働可能）を四半期数で読む。定数を書き写さない。 */
export function newFactoryConstructionLeadTimeQuarters(capexParams: CapexParameters): number {
  const template = capexParams.templatesByType.newFactoryConstruction;
  return template.standardConstructionQuarters + template.postCompletionReadinessQuarters;
}

/**
 * Forward Capacity Gap を計算する（純粋関数）。
 * 「工場完成時点で必要になっていそうな規模」を、Vision参考軌道と観測済み成長根拠の
 * 2つの独立した推定の**小さい方**として求める（片方だけの楽観に依らない）。
 */
export function computeForwardCapacityGap(input: ForwardCapacityGapInput): ForwardCapacityGapResult {
  const horizonTurn = input.horizonTurn ?? 32;
  const constructionLeadTimeQuarters = newFactoryConstructionLeadTimeQuarters(input.capexParams);
  const forecastCompletionTurn = input.turn + constructionLeadTimeQuarters;

  const visionReferenceScaleAtCompletion = referenceScaleAtTurn(
    input.vision,
    forecastCompletionTurn,
    input.currentSustainableScaleTons,
    horizonTurn
  );

  // 【Phase G・§3/§27修正】どちらか一方しか観測できない場合に「観測できていない
  // 方」を0とみなしてmin()を取ると、observedMarketGrowthRatioがたまたま
  // 観測できていないだけで、実際に強い自社成長根拠（recentOwnContractGrowthRatio）
  // まで一律ゼロに潰れてしまう。これは「楽観的なVisionだけで先行投資を正当化
  // しない」（設計文書§5.2）という趣旨とは別の、観測欠落による過小評価であり、
  // Phase Fでstrategic routeが一度も発火しなかった直接原因の1つだった
  // （observedMarketGrowthRatioの計算がreactive Gate Hと同じ「持続的稼働率」
  // 条件に紐づいていたため、reactiveが動くタイミングとしか一致しなかった）。
  //
  // 修正: 両方が観測できているときだけ「小さい方」で慎重に見る（支持の要件は
  // そのまま維持）。片方しか観測できていないときは、観測できている方をそのまま
  // 使う（無いものを0と決めつけない）。両方とも観測できなければ0。
  const ownGrowth = input.marketGrowthEvidence.recentOwnContractGrowthRatio;
  const marketGrowth = input.marketGrowthEvidence.observedMarketGrowthRatio;
  const observedGrowthRatioPerQuarter = Math.max(
    0,
    ownGrowth !== null && marketGrowth !== null
      ? Math.min(ownGrowth, marketGrowth)
      : (ownGrowth ?? marketGrowth ?? 0)
  );
  const trendAdjustedScaleAtCompletion =
    input.currentSustainableScaleTons * Math.pow(1 + observedGrowthRatioPerQuarter, constructionLeadTimeQuarters);

  const projectedCommercialScaleAtCompletion = Math.min(visionReferenceScaleAtCompletion, trendAdjustedScaleAtCompletion);
  const projectedRequiredProductionAtCompletion = projectedCommercialScaleAtCompletion;
  const existingCapacityAtCompletion = input.currentSustainableScaleTons;
  const forwardCapacityGapTons = Math.max(0, projectedRequiredProductionAtCompletion - existingCapacityAtCompletion);
  const forwardCapacityGapRatio = existingCapacityAtCompletion > 0 ? forwardCapacityGapTons / existingCapacityAtCompletion : 0;

  return {
    constructionLeadTimeQuarters,
    forecastCompletionTurn,
    visionReferenceScaleAtCompletion,
    observedGrowthRatioPerQuarter,
    trendAdjustedScaleAtCompletion,
    projectedCommercialScaleAtCompletion,
    projectedRequiredProductionAtCompletion,
    existingCapacityAtCompletion,
    forwardCapacityGapTons,
    forwardCapacityGapRatio,
  };
}
