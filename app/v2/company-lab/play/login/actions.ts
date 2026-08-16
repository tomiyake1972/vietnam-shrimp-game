// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） ログインServer Action
//
// フォーム送信で受け取った生のトークン文字列をapp/lib/companyLabUiSession.tsの
// attemptStagingLoginへそのまま渡す（本番判定・トークン比較ロジックはapp/lib/stagingAdmin.tsの
// checkStagingAdminToken一箇所のみに存在し、ここでは重複実装しない）。
//
// 失敗理由（トークン不一致・未設定・本番環境）はクライアントへ一切区別して返さない
// （?error=1という同一のクエリだけをつける）。理由を区別して返すと、攻撃者が
// 「トークンは合っているが本番環境だから弾かれた」等を推測できてしまうため。

"use server";

import { redirect } from "next/navigation";
import {
  attemptStagingLogin,
  assertSameOriginRequest,
  sanitizeReturnToPath,
  COMPANY_LAB_UI_HOME_PATH,
  COMPANY_LAB_UI_LOGIN_PATH,
} from "../../../../lib/companyLabUiSession";

export async function loginAction(formData: FormData): Promise<void> {
  const rawReturnTo = formData.get("returnTo");
  const returnTo = sanitizeReturnToPath(typeof rawReturnTo === "string" ? rawReturnTo : null);
  const errorRedirectPath = `${COMPANY_LAB_UI_LOGIN_PATH}?error=1${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`;

  const origin = await assertSameOriginRequest();
  if (!origin.ok) {
    redirect(errorRedirectPath);
  }

  const token = formData.get("token");
  const result = await attemptStagingLogin(typeof token === "string" ? token : "");
  if (!result.ok) {
    redirect(errorRedirectPath);
  }

  // 【Management Console認証Cookie整合性調査・指示§11/§17】ログイン成功後、
  // returnToがあれば元の画面（Management ConsoleのRun等）へ戻す。無ければ
  // 従来どおりCompany Lab一覧へ（Company Lab自体のログインフローと後方互換）。
  redirect(returnTo ?? COMPANY_LAB_UI_HOME_PATH);
}
