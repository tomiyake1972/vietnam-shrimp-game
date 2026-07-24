// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） ログイン画面
//
// STAGING_ADMIN_TOKEN自体はこのServer Componentのレンダリング結果（HTML）にも、
// クライアントJSにも一切含まれない。フォームのaction先（loginAction）はサーバー側の
// Server Actionであり、送信されたトークンはサーバー側でのみ検証される（ブラウザは
// 検証結果（成功/失敗）しか受け取らない）。

import { redirect } from "next/navigation";
import { hasValidStagingSession, COMPANY_LAB_UI_HOME_PATH } from "../../../../lib/companyLabUiSession";
import { loginAction } from "./actions";
import LabBanner from "../../components/LabBanner";

interface LoginPageProps {
  readonly searchParams: Promise<{ readonly error?: string }>;
}

export default async function CompanyLabLoginPage({ searchParams }: LoginPageProps) {
  if (await hasValidStagingSession()) {
    redirect(COMPANY_LAB_UI_HOME_PATH);
  }
  const { error } = await searchParams;

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-5">
        <LabBanner />
        <div className="bg-gray-800 rounded-2xl p-6 space-y-4">
          <h1 className="text-base font-semibold">Company Lab ログイン</h1>
          <p className="text-xs text-gray-400">
            スタッフ用の管理トークンを入力してください。本番環境ではこの画面は利用できません。
          </p>
          {error && (
            <div className="bg-red-950/50 border border-red-700/60 rounded-lg px-3 py-2 text-xs text-red-200">
              認証に失敗しました。トークンを確認して再度お試しください。
            </div>
          )}
          <form action={loginAction} className="space-y-3">
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
