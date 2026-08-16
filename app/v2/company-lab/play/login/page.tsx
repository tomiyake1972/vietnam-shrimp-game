// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） ログイン画面
//
// STAGING_ADMIN_TOKEN自体はこのServer Componentのレンダリング結果（HTML）にも、
// クライアントJSにも一切含まれない。フォームのaction先（loginAction）はサーバー側の
// Server Actionであり、送信されたトークンはサーバー側でのみ検証される（ブラウザは
// 検証結果（成功/失敗）しか受け取らない）。

import { redirect } from "next/navigation";
import { hasValidStagingSession, sanitizeReturnToPath, COMPANY_LAB_UI_HOME_PATH } from "../../../../lib/companyLabUiSession";
import { loginAction } from "./actions";
import PlayLabBanner from "../components/PlayLabBanner";

interface LoginPageProps {
  readonly searchParams: Promise<{ readonly error?: string; readonly returnTo?: string }>;
}

export default async function CompanyLabLoginPage({ searchParams }: LoginPageProps) {
  const { error, returnTo: rawReturnTo } = await searchParams;
  // 【Management Console認証Cookie整合性調査・指示§10/§17】
  // すでに有効なセッションがある場合、旧実装は常にCompany Labの一覧（ラボ新規作成
  // 画面）へ飛ばしていた。Management ConsoleからreturnTo付きでここへ来たユーザーは
  // 「再ログインしたつもり」でCompany Lab作成画面へ迷い込んでいた（今回の不具合の
  // 直接の症状）。returnToがあれば、有効なセッションの場合もそちらへ戻す。
  const returnTo = sanitizeReturnToPath(rawReturnTo);
  if (await hasValidStagingSession()) {
    redirect(returnTo ?? COMPANY_LAB_UI_HOME_PATH);
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-5">
        <PlayLabBanner />
        <div className="bg-gray-800 rounded-2xl p-6 space-y-4">
          <h1 className="text-base font-semibold">staging 管理ログイン</h1>
          <p className="text-xs text-gray-400">
            スタッフ用の管理トークンを入力してください。本番環境ではこの画面は利用できません。
            {/* 【Management Console認証Cookie整合性調査・指示§18】このログインは
                Management Console（32Q Simulation Run）を含む、staging管理操作
                全体で共通のトークン・セッションを発行する。Company Labを新規作成する
                必要はない。 */}
            {returnTo ? " ログイン後、元の画面へ自動的に戻ります。" : null}
          </p>
          {error && (
            <div className="bg-red-950/50 border border-red-700/60 rounded-lg px-3 py-2 text-xs text-red-200">
              認証に失敗しました。トークンを確認して再度お試しください。
            </div>
          )}
          <form action={loginAction} className="space-y-3">
            {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
            <div>
              <label htmlFor="token" className="block text-xs text-gray-400 mb-1">
                管理トークン
              </label>
              <input
                id="token"
                type="password"
                name="token"
                required
                autoComplete="off"
                className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
              />
            </div>
            <button type="submit" className="w-full bg-teal-600 hover:bg-teal-500 text-white font-semibold rounded-lg px-4 py-2 text-sm">
              ログイン
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
