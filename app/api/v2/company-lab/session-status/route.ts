// ShrimpX V2 — Management Console認証Cookie整合性調査（指示§13/§14） session診断endpoint
//
// staging限定の軽量な診断用endpoint。「今このブラウザのCookieで、
// /api/v2/simulation-runs 等の管理操作系APIが認証を通るか」だけを、
// 秘密情報を一切含まずに確認できるようにする（過剰実装しない・状態は持たない）。
// 認証判定はhasValidStagingSession（app/lib/companyLabUiSession.ts）を
// そのまま使う＝withSimulationRunApiContextと同じSSoT。

import { NextResponse } from "next/server";
import { hasValidStagingSession } from "../../../../lib/companyLabUiSession";
import { isProduction } from "../../../../lib/env";

export async function GET(): Promise<NextResponse> {
  if (isProduction) {
    return NextResponse.json({ error: { code: "NOT_AVAILABLE", message: "この診断は本番環境では利用できません。" } }, { status: 404 });
  }
  const authenticated = await hasValidStagingSession();
  return NextResponse.json({ authenticated });
}
