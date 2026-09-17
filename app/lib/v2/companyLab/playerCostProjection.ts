// ShrimpX V2 — 管理会計是正・Player費用表示接続
//
// Player画面の表示計算（Pre-Financing Liquidity の人件費見積）へ渡す費用前提を、
// **そのRunが保持しているシナリオ定義のスナップショット**から組み立てる。
//
// 【コード側のScenario registryを引かない】registry から再取得すると、
// 保存済みRunが作られた時点の定義ではなく現在のコードの定義を見てしまう。
// 指数の正本はあくまで state.scenarioState.definition である。
//
// 【将来を開示しない】戻り値 StandardAiCostProjection は
//   - 当Turnの実効 financeParameters
//   - 当Turnの案件別必要工事費
// だけを持ち、指数そのもの・将来Turnの曲線・将来費用値を一切含まない。
// Player画面はこの2つ以外を受け取らない。

import { CompanyLabState } from "./types";
import { buildTurnEconomicsProjection } from "./turnEconomicsProjection";
import { StandardAiCostProjection, toStandardAiCostProjection } from "./standardAi/costProjection";

/**
 * Runのstateと当Turnから、Player表示用の費用前提を作る。
 * 指数未宣言のシナリオでは中立値（全指数1.00）と同値になり、
 * 本変更前の表示とビット単位で一致する。
 */
export function buildPlayerCostProjection(state: CompanyLabState, turn: number): StandardAiCostProjection {
  return toStandardAiCostProjection(
    buildTurnEconomicsProjection({ definition: state.scenarioState.definition, turn })
  );
}
