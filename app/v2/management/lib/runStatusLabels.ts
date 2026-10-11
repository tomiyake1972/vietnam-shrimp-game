// ShrimpX V2 — Run の停止理由の日本語表示（唯一の対応表）
//
// 【UI-CLARITY-2 D3】実機プレイテストで、Run 欄に `waiting_for_player` という
// 内部名がそのまま出ていた。原因は、同じ対応表が4か所に個別に書かれていて、
// そのうち Run 一覧・分析画面の3か所に waiting_for_player の行が無く、
// 未知のキーとして生の値へフォールバックしていたことだった
// （Setup 画面の表にだけ「PLAYER待ち」が書かれていた）。
// 対応表をこのファイル1つへ集約し、同じ取りこぼしが起きないようにする。

/** SimulationRunSummary.stopReason の取りうる値と、プレイヤー・GMへ見せる日本語。 */
export const STOP_REASON_LABELS: Readonly<Record<string, string>> = {
  completed: "完走",
  stopped_by_user: "途中停止",
  error: "失敗",
  scenario_end: "シナリオ終端",
  running: "実行中",
  waiting_for_player: "プレイヤー入力待ち",
};

/**
 * 停止理由を日本語で返す。未知のキーでも内部名をそのまま出さず、
 * 「不明（<内部名>）」として、値が読めていないことが分かる形にする。
 */
export function formatStopReason(stopReason: string): string {
  return STOP_REASON_LABELS[stopReason] ?? `不明（${stopReason}）`;
}
