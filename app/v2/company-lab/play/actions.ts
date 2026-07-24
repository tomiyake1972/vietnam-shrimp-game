// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） ラボ一覧画面のServer Action
//
// ログアウトのみ。ステートレスセッション設計（app/lib/companyLabUiSession.ts）のため、
// Cookieを削除するだけで他に消すべきサーバー側状態は無い。

"use server";

import { redirect } from "next/navigation";
import { clearStagingSession, assertSameOriginRequest, COMPANY_LAB_UI_LOGIN_PATH } from "../../../lib/companyLabUiSession";

export async function logoutAction(): Promise<void> {
  const origin = await assertSameOriginRequest();
  if (origin.ok) {
    await clearStagingSession();
  }
  redirect(COMPANY_LAB_UI_LOGIN_PATH);
}
