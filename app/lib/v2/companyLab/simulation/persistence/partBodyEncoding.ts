// ShrimpX V2 — COMP-1: 保存リクエスト本文の圧縮（送り方だけの変更）
//
// 【位置づけ】REUSE-1（変わっていないパートを送り直さない）に続く、送信量削減の
// 2つめ。REUSE-1 は「同じ内容を送り直さない」ことしかできず、Turn を進めた直後の
// 保存は dataset / resume / pack のすべてが変わるため必ず全量送信になる。
// 実測で、32Q の Turn完了保存だけで 167.49 MB（dynamic-scenario-2・全社AI）。
// ここはどうしても送らなければならないので、送る量そのものを小さくする。
//
// 【保存形式は変えない】変えるのは request body の載せ方だけである。Redis 上の
// 正規キー（:dataset:{revision} 等）には従来どおり完全な JSON を置く。既存Runの
// 読み出し経路・migration は不要。サーバーはヘッダが無ければ素の JSON として
// 受け付けるため、古いクライアントからの保存もそのまま通る。

/**
 * gzip 圧縮された request body であることを示すヘッダ。
 *
 * 【標準の Content-Encoding を使わない理由】Content-Encoding は本来レスポンス向けの
 * ネゴシエーションで使われ、request body に付けた場合の扱いは経路（プロキシ・
 * プラットフォーム）によって異なる。途中で勝手に展開される／拒否されるといった
 * 挙動差を避けるため、このアプリ専用のヘッダで明示する。
 */
export const SIMULATION_RUN_BODY_ENCODING_HEADER = "x-shrimpx-body-encoding";

/** 上記ヘッダに入る唯一の値。これ以外が来たら素の JSON として扱う。 */
export const SIMULATION_RUN_BODY_ENCODING_GZIP = "gzip";

/** ヘッダ値が gzip 指定かどうか（前後の空白・大文字小文字を吸収する）。 */
export function isGzipBodyEncoding(headerValue: string | null | undefined): boolean {
  return (headerValue ?? "").trim().toLowerCase() === SIMULATION_RUN_BODY_ENCODING_GZIP;
}
