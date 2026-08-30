// ShrimpX V2 — COMPANYLAB-DETAIL-LOAD-404-1 動的ルートパラメータ labId の正規化
//
// 【不具合】Next.js（App Router）の動的セグメントは、この経路では **percent-encoded の
// まま** ページへ渡る。実測（Next.js 16.2.10・ブラウザE2E）:
//   保存済み labId : "e2e detail ascii space"
//   一覧のリンク    : /v2/company-lab/play/e2e%20detail%20ascii%20space
//   params.labId   : "e2e%20detail%20ascii%20space"   ← デコードされない
// 画面側はこの値をそのまま Repository へ渡し、Redis キーへ埋め込んでいたため、
// GET が null を返し CompanyLabNotFoundError → 「ラボが見つかりません」になっていた。
//
// 一覧が正常だったのは、一覧が **ZSET のメンバー（保存時の生の labId）** を読んでおり、
// URL を経由しないため。つまり「Redis に無い」のではなく「URL 経由の labId だけが
// 別物になっていた」。空白・日本語など encodeURIComponent が変換する文字を含む labId
// でのみ再現し、"Test12" のような変換不要の labId では再現しない。
//
// 【なぜ decodeURIComponent が正しい逆変換か】この画面のリンク・リダイレクトは
// すべて encodeURIComponent(labId) で生成されている
// （play/page.tsx の「再開」リンク、play/new/actions.ts の作成後リダイレクト）。
// したがって復元は decodeURIComponent が唯一の対応する逆変換であり、
// labId に含まれる "%" も encodeURIComponent が "%25" にするため正しく往復する。

/**
 * 動的ルートの labId パラメータを、保存されている labId へ復元する。
 *
 * 不正な percent-encoding（例: "100%" のように単独の "%" を含む手書きURL）で
 * decodeURIComponent が URIError を投げる場合は、受け取った値をそのまま返す
 * （ここで例外を投げると画面全体が落ちるため。存在しない labId として
 *   通常の Not Found 表示へ進む）。
 */
export function decodeLabIdRouteParam(rawParam: string): string {
  try {
    return decodeURIComponent(rawParam);
  } catch {
    return rawParam;
  }
}
