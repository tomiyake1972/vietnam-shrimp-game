// ShrimpX V2 — Standard AI Investment Portfolio Calibration（Phase PC-1新設）
//
// 【指示§7・§36】FA-1で未実装だったfirst50PctUtilizationTurn/
// first70PctUtilizationTurnを、benchmark analytics側だけで実装する
// （production behavior・既存SSoTは一切変更しない）。
//
// 入力は呼び出し側が既に持っている稼働率の時系列（FA-1のfactoryActivation.ts
// ・diagnoseFactoryActivationが返すutilization、またはAnalysis Packの
// PackStrategy.factoryActivation[].utilizationをそのまま並べたもの）であり、
// 新しい稼働率の定義・計算式は増やさない。

const EPSILON = 1e-9;

export interface UtilizationSamplePoint {
  readonly turn: number;
  /** その四半期に観測が無かった場合（工場がまだ存在しない等）はnull。 */
  readonly utilization: number | null;
}

export interface UtilizationMilestones {
  readonly first50PctUtilizationTurn: number | null;
  readonly first70PctUtilizationTurn: number | null;
}

export interface UtilizationMilestoneThresholds {
  readonly p50: number;
  readonly p70: number;
}

export const DEFAULT_UTILIZATION_MILESTONE_THRESHOLDS: UtilizationMilestoneThresholds = { p50: 0.5, p70: 0.7 };

/**
 * 稼働率の時系列（工場1件ぶん、順不同で渡してよい）から、閾値へ最初に到達した
 * ターンを検出する（一度到達すれば以後下回っても値は保持＝「初回到達」の記録。
 * 持続性は問わない）。到達しなければnull。
 */
export function computeUtilizationMilestones(
  series: readonly UtilizationSamplePoint[],
  thresholds: UtilizationMilestoneThresholds = DEFAULT_UTILIZATION_MILESTONE_THRESHOLDS
): UtilizationMilestones {
  const sorted = [...series].sort((a, b) => a.turn - b.turn);
  let first50PctUtilizationTurn: number | null = null;
  let first70PctUtilizationTurn: number | null = null;
  for (const point of sorted) {
    if (point.utilization === null || !Number.isFinite(point.utilization)) continue;
    if (first50PctUtilizationTurn === null && point.utilization >= thresholds.p50 - EPSILON) {
      first50PctUtilizationTurn = point.turn;
    }
    if (first70PctUtilizationTurn === null && point.utilization >= thresholds.p70 - EPSILON) {
      first70PctUtilizationTurn = point.turn;
    }
  }
  return { first50PctUtilizationTurn, first70PctUtilizationTurn };
}
