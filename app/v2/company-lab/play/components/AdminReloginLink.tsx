// ShrimpX V2 — PLAY画面 管理者再ログイン導線
//
// 長時間のテストプレイ中にPCスリープ・ブラウザ再起動等でstaging管理者セッション
// （companyLabUiSession.ts）が切れた場合でも、今見ている画面から直接ログインし直し、
// 成功後に同じ画面（同じクエリパラメータ込み）へ戻れるようにするだけのリンク。
//
// 新しい認証方式は作らない。既存のAdmin Login route（COMPANY_LAB_UI_LOGIN_PATH）と
// 既存のreturnTo機構（sanitizeReturnToPath、open redirect対策込み）をそのまま使う
// （このコンポーネント自身はサニタイズしない・現在URLをそのまま渡すだけ。実際の検証は
// 常にログイン画面側のsanitizeReturnToPathが行う、唯一の正）。
//
// 【ログイン済みの場合】既存のログイン画面（page.tsx）が、有効なセッションがあれば
// フォームを表示せずreturnToへ即座にredirectする既存挙動をそのまま持っている。
// そのためこのリンクは「押したら常にログイン画面へ一度遷移する」だけでよく、
// クライアント側でセッション有無を判定する新しいロジックは追加しない
// （Player Session Cookieには一切触れない・Admin Sessionの状態を読み出しもしない）。

"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { buildAdminReloginHref } from "../../../../lib/companyLabUiReturnTo";

export default function AdminReloginLink() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const href = buildAdminReloginHref(pathname, searchParams.toString());

  return (
    <Link
      href={href}
      data-testid="admin-relogin-link"
      className="rounded border border-gray-600 px-2 py-1 text-[11px] font-medium text-gray-200 hover:bg-gray-700 whitespace-nowrap"
    >
      🔐 管理者ログイン
    </Link>
  );
}
