// ShrimpX V2 — Management Console: シナリオNewsの取得（Testplay 用の最小実装）
//
// 【この層がやること】シナリオ定義を解決し、そのターンに公開してよい News を
// 既存の情報公開エンジン（scenario/informationEngine.ts）から取り出して返すだけ。
//
// 【この層がやらないこと】
//  - News 本文・見出しを作らない（シナリオ定義が唯一の情報源）。
//  - 公開可否の判定を再実装しない（getAvailableInformation に委ねる）。
//  - ターン番号やシナリオIDでの分岐で内容を変えない。
//
// 【なぜ Console 側に置くか】scenario/ から industryLab/cli/scenarioAliases を
// 参照すると依存が循環するため、シナリオID解決を行うこの薄い層は Console 側に置く。
// Player 画面の改装作業と衝突しないよう、player 配下のファイルには一切依存しない。

import { getAvailableInformation } from "../../../lib/v2/scenario/informationEngine";
import { resolveScenarioDefinition } from "../../../lib/v2/industryLab/cli/scenarioAliases";
import { InformationRelease } from "../../../lib/v2/scenario/types";

/**
 * Console が News を表示する対象ターン。
 *
 * 実行中のセッションがある場合は、シナリオが今いるターン（＝プレイヤーが
 * その四半期の意思決定をする前に読むターン）。保存済み実行を眺めているだけの
 * 場合は、最後に完了したターン（それ以上先の情報は持っていないため）。
 *
 * どちらの場合も、実際に返る News は getAvailableInformation が
 * availableFromTurn <= turn で絞るため、未来の記事は構造的に出ない。
 */
export function resolveNewsTurn(input: {
  readonly scenarioCurrentTurn: number | null;
  readonly completedTurns: number;
}): number {
  const fromSession = input.scenarioCurrentTurn;
  if (fromSession !== null && Number.isInteger(fromSession) && fromSession >= 1) return fromSession;
  return Math.max(1, input.completedTurns);
}

export interface ScenarioNewsFeed {
  /** シナリオ定義が見つからなかった場合は true（既存シナリオの挙動を壊さないため例外にしない）。 */
  readonly scenarioNotFound: boolean;
  /** このターンに公開してよい記事（新しい順）。 */
  readonly releases: readonly InformationRelease[];
  /** 実際に使ったターン番号。 */
  readonly turn: number;
}

/**
 * 指定シナリオ・指定ターンで公開してよい News を返す。
 *
 * 情報レベルは "standard"（噂＋公開情報まで）。gm 専用情報・ゲーム終了後の真実は
 * 情報公開エンジンが構造的に除外する。News を持たないシナリオでは空配列を返す。
 */
export function selectScenarioNewsForTurn(scenarioId: string, turn: number): ScenarioNewsFeed {
  const definition = resolveScenarioDefinition(scenarioId);
  if (!definition) return { scenarioNotFound: true, releases: [], turn };

  const clampedTurn = Math.min(Math.max(1, turn), definition.durationTurns);
  const available = getAvailableInformation(definition.informationReleases, clampedTurn, "standard");

  // 新しい記事を上に。同じターンなら確報を先に、それでも同じなら ID 順で安定させる。
  const releases = [...available].sort(
    (a, b) =>
      b.availableFromTurn - a.availableFromTurn ||
      Number(a.isRumor) - Number(b.isRumor) ||
      a.informationId.localeCompare(b.informationId)
  );
  return { scenarioNotFound: false, releases, turn: clampedTurn };
}
