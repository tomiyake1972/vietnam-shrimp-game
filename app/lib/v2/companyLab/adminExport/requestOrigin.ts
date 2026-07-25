// ShrimpX V2 — Company Lab 管理者画面「分析データをエクスポート」機能
// Server Component（route.tsを持たないページ）から、自分自身のExport API
// （同一デプロイの/api/v2/exports/**）を叩くためのoriginを求めるヘルパー。
// route.ts側はNextRequest.urlから直接originを取れるため、こちらはServer
// Component専用（next/headers経由）。

import { headers } from "next/headers";

/** "https://vietnam-shrimp-game-staging-git-develop-v2-tomiyake.vercel.app" のような値を返す。 */
export async function resolveRequestOriginFromHeaders(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  // Vercel環境では常にhttps。ローカル開発時のみhttpへフォールバックする判定として
  // x-forwarded-protoを見る（Vercelのエッジが設定するヘッダー。無ければhttps既定）。
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}
