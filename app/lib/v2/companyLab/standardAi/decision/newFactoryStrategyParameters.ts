// ShrimpX V2 — 新工場判断の戦略パラメータ（Phase SAI-GROW-3B-1でモジュール分離）
//
// 【なぜ分離したか】decision/liquidity.ts（Liquidity SSoT）が
// upfrontCoverageRatioByRiskTolerance を「借入をどこまで成長原資として数えてよいか」の
// 既存パラメータとして再利用する。newFactory.ts は liquidity.ts を import するため、
// 定数だけを独立モジュールへ出して循環参照を避ける（値・意味は一切変更していない）。

import { CompanyVision } from "../../vision/types";
import { GrowthPressure } from "../../vision/strategicGrowth";

export interface NewFactoryStrategyParameters {
  /**
   * 工場を建てることへの前向きさ別の、検討開始・提案に必要な growth pressure。
   * LOW の会社でも「絶対に建てない」ではなく「よほどのことがない限り建てない」。
   */
  readonly monitoringPressureByWillingness: Readonly<Record<CompanyVision["willingnessToBuildFactories"], GrowthPressure>>;
  readonly proposalPressureByWillingness: Readonly<Record<CompanyVision["willingnessToBuildFactories"], GrowthPressure>>;
  /**
   * 既存工場のスペース残がこの単位数を上回る間は、原則として既存増設を先に使う。
   * ただし下の overlapGapRatio を超える大きな gap では併走を許す
   * （志が桁違いに大きいとき、既存増設だけを待つのは合理的でない）。
   */
  readonly existingSpaceSufficientUnits: number;
  /** この gap 比率を超えたら、既存増設余地があっても新工場の検討を併走させる。 */
  readonly overlapGapRatio: number;
  /** 既存能力がこの稼働率に達していないうちは、能力を増やしても意味がない。 */
  readonly minimumUtilizationForNewFactory: number;
  /** 当期の生産必要量が既存実効能力のこの比率を超えていること（需要の裏づけ）。 */
  readonly minimumDemandPullRatio: number;
  /** 労働稼働率がこれを超えていると、新工場を回す人員の確保に無理があると見る。 */
  readonly laborStrainCeiling: number;
  /** 財務リスク許容度別の、総投資額に対して手元で用意しておきたい比率。 */
  readonly upfrontCoverageRatioByRiskTolerance: Readonly<Record<CompanyVision["financialRiskTolerance"], number>>;
}

export const NEW_FACTORY_STRATEGY_PARAMETERS_V1: NewFactoryStrategyParameters = {
  monitoringPressureByWillingness: { HIGH: "MODERATE", MEDIUM: "MODERATE", LOW: "HIGH" },
  proposalPressureByWillingness: { HIGH: "HIGH", MEDIUM: "HIGH", LOW: "URGENT" },
  existingSpaceSufficientUnits: 3_000,
  overlapGapRatio: 0.3,
  minimumUtilizationForNewFactory: 0.75,
  minimumDemandPullRatio: 0.95,
  laborStrainCeiling: 1.15,
  upfrontCoverageRatioByRiskTolerance: { HIGH: 0.6, MEDIUM: 0.85, LOW: 1.1 },
};
