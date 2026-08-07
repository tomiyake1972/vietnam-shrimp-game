// ShrimpX V2 — シナリオ定義用 長期トレンド組み立てヘルパー（Phase 2）
//
// 5つの代表シナリオでLongTermTrendオブジェクトを毎回手書きすると冗長になる
// ため、スコープ別（国別／市場別／全体）の組み立て関数だけを提供する。
// 数値そのものはここでは持たず、各definitions/*.tsファイル側で指定する
// （実装指示 §17「数値は設定ファイルへ集約」— 数値は definitions/*.ts と
// scenario/parameters.ts に集約し、本ファイルは組み立てロジックのみ）。

import { CountryId, DemandMarketId } from "../../market/types";
import { LongTermTrend, LongTermTrendKeyframe, ScenarioBaseVariable, TrendInterpolation } from "../types";

export function countryTrend(
  trendId: string,
  variable: ScenarioBaseVariable,
  countryId: CountryId,
  keyframes: readonly LongTermTrendKeyframe[],
  interpolation: TrendInterpolation = "linear"
): LongTermTrend {
  return { trendId, variable, scope: { kind: "country", countryId }, interpolation, keyframes };
}

export function marketTrend(
  trendId: string,
  variable: ScenarioBaseVariable,
  marketId: DemandMarketId,
  keyframes: readonly LongTermTrendKeyframe[],
  interpolation: TrendInterpolation = "linear"
): LongTermTrend {
  return { trendId, variable, scope: { kind: "market", marketId }, interpolation, keyframes };
}

export function globalTrend(
  trendId: string,
  variable: ScenarioBaseVariable,
  keyframes: readonly LongTermTrendKeyframe[],
  interpolation: TrendInterpolation = "linear"
): LongTermTrend {
  return { trendId, variable, scope: { kind: "global" }, interpolation, keyframes };
}

export function kf(turn: number, value: number): LongTermTrendKeyframe {
  return { turn, value };
}
