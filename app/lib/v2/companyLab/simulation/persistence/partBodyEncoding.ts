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

/**
 * 【COMP-2】サーバーが1リクエストぶんの本文として受け付ける、展開後の最大バイト数。
 *
 * 【この上限が何を縛るか・縛らないか】
 * 縛るのは「展開後の本文のバイト数」だけである。サーバーがこのリクエストを
 * 処理するあいだの総メモリ使用量が 8 MiB 以内になることは保証しない。
 * JSON.parse が作るオブジェクトは同じ内容でも文字列より大きくなり、
 * 展開中の中間バッファもこの数値には含まれない。ここで防ぎたいのは、
 * 小さな圧縮本文から無制限に大きな本文を組み立てさせられることである。
 *
 * 【通信サイズ上限（4 MiB）とは別の数値である理由】
 * クライアント側の 4 MiB は「実際にネットワークへ出るバイト数」＝圧縮後にかかる
 * 上限で、プラットフォームの request body 上限に当てるためのもの。こちらは
 * 展開後の本文バイト数にかかる上限であり、守る対象が違う。
 * 圧縮は 8〜13% まで縮むため、4 MiB の圧縮本文は理屈の上では数十 MB へ展開できる。
 * 上限が無ければ、その展開を最後まで実行させられてしまう。
 *
 * 【8 MiB の根拠（実測）】scripts/int1/measureDecompressedBodyCeiling.ts で、
 * 5社PLAYER・32Turn・salesModelId=tiered-v200-crowding-v1 の条件で全6シナリオを
 * 通し、サーバーが受け取る展開後 request body の最大を測った。
 *   baseline 3,946,258 / dynamic-scenario-1 3,747,812 / dynamic-scenario-2 3,874,464 /
 *   ecuador-early-expansion 3,964,428 / global-demand-boom 3,988,940 /
 *   global-disease-crisis 3,959,343（いずれも dataset パート・バイト）
 *   全シナリオ最大 3,988,940 B = 3.804 MiB
 *   外枠（value 以外のフィールド合計）は最大 172 B
 * 正常な最大 3.804 MiB に対して 8 MiB は約 2.10 倍で、これは正常データに対して
 * 持たせた余裕の倍率である（圧縮の増幅率を 2 倍に抑えるという意味ではない。
 * 増幅率は本文の中身で決まり、上限で頭打ちになるのは展開後のバイト数だけである）。
 * シナリオ差・バランス調整・将来のフィールド追加ぶんを吸収できる幅として選んだ。
 * Turn 数は MANAGEMENT_CONSOLE_STANDARD_TURNS = 32 で固定、会社数も5社で固定の
 * ため、正常データがこれ以上伸びるのはコード変更があったときだけである。
 * 1Turnあたりのデータが増えたら、この定数を実測し直して決め直すこと。
 */
export const SIMULATION_RUN_MAX_DECOMPRESSED_BODY_BYTES = 8 * 1024 * 1024;

/** 本文が上限を超えたときのエラーコード（レスポンスの error.code に入る）。 */
export const SIMULATION_RUN_REQUEST_BODY_TOO_LARGE = "REQUEST_BODY_TOO_LARGE";

/** 本文が壊れている・JSON として読めないときのエラーコード。 */
export const SIMULATION_RUN_INVALID_REQUEST_BODY = "INVALID_REQUEST_BODY";
