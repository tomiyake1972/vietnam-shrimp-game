// ShrimpX V2 — COMPANYLAB-DETAIL-LOAD-404-1 ラボ読み込み失敗時の表示
//
// 【なぜ not-found.tsx と分けるか】以前は loadPlayerScreenViewModel が
// あらゆる repository 例外を kind:"notFound" へ潰しており、schema / decode /
// version / environment 由来の内部エラーが「ラボが見つかりません」という 404 表示の
// 裏に完全に隠れていた。実 Redis 環境で「一覧には出るのに詳細だけ Not Found」と
// なったとき、原因の切り分けが構造的に不可能だった。
//
// 【画面へ出さないもの】例外メッセージ・stack trace・Redis key・環境変数などの内部情報は
// 一切表示しない。表示するのは分類コードと一般的な案内のみで、詳細は
// サーバー側 console.error（Vercel runtime log）にだけ記録する。

import Link from "next/link";
import PlayLabBanner from "../components/PlayLabBanner";
import type { PlayerScreenLoadErrorReason } from "../_lib/viewModel";

/** 分類コード → 管理者向けの一般的な説明（内部情報は含めない）。 */
const REASON_DESCRIPTIONS: Readonly<Record<PlayerScreenLoadErrorReason, string>> = {
  persistedStateInvalid: "保存されているラボのデータ形式を読み取れませんでした（保存形式の不整合）。",
  repositoryUnavailable: "保存先（Redis）へのアクセスに失敗しました。接続設定または一時的な障害の可能性があります。",
  playerFixtureMissing: "保存データ内のプレイヤー会社と会社一覧が対応していません（データ整合性の問題）。",
  unexpected: "想定していない理由でラボを読み込めませんでした。",
};

export default function PlayerScreenLoadError({ reason }: { readonly reason: PlayerScreenLoadErrorReason }) {
  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 pb-16">
      <PlayLabBanner />
      <div className="max-w-2xl mx-auto px-4 py-16 text-center space-y-4">
        <div className="text-lg font-semibold">ラボを読み込めませんでした</div>
        <p className="text-sm text-gray-400">{REASON_DESCRIPTIONS[reason]}</p>
        <p className="text-xs text-gray-500">
          このラボは存在しますが、表示に必要なデータを読み込めていません（分類コード: <span className="font-mono">{reason}</span>）。
          サーバーログに詳細が記録されています。
        </p>
        <Link href="/v2/company-lab/play" className="inline-block text-teal-400 underline text-sm">
          ラボ一覧へ戻る
        </Link>
      </div>
    </div>
  );
}
