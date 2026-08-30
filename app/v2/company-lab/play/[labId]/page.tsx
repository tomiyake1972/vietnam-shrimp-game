// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） プレイヤー画面本体（指示§8.2）
//
// Server Component。requireStagingSession()で未認証ならログイン画面へリダイレクトし
// （§7・§11「認証環境ならリダイレクト」）、loadPlayerScreenViewModel（_lib/viewModel.ts）で
// 表示に必要な最小限のデータへ絞り込んでから、対話部分だけをClient Component
// （PlayerScreenClient）へpropsとして渡す。ラボが存在しなければnotFound()で
// 適切な404表示にする（§11「nonexistent labsは適切なNot Found表示」）。

import { notFound } from "next/navigation";
import { requireStagingSession } from "../../../../lib/companyLabUiSession";
import { resolveCompanyLabUiDependencies } from "../_lib/uiDependencies";
import { loadPlayerScreenViewModel } from "../_lib/viewModel";
import { decodeLabIdRouteParam } from "../_lib/labIdRouteParam";
import PlayerScreenClient from "./PlayerScreenClient";
import PlayerScreenLoadError from "./PlayerScreenLoadError";

interface PlayerPageProps {
  readonly params: Promise<{ readonly labId: string }>;
}

export default async function CompanyLabPlayerPage({ params }: PlayerPageProps) {
  await requireStagingSession();
  const { labId: rawLabId } = await params;
  // 【COMPANYLAB-DETAIL-LOAD-404-1】動的セグメントは percent-encoded のまま渡るため、
  // 保存済み labId へ復元してから Repository へ渡す（labIdRouteParam.ts のコメント参照）。
  const labId = decodeLabIdRouteParam(rawLabId);

  const deps = await resolveCompanyLabUiDependencies();
  const result = await loadPlayerScreenViewModel(deps, labId);

  if (result.kind === "notFound") {
    notFound();
  }

  // 【COMPANYLAB-DETAIL-LOAD-404-1】読み込み失敗は「見つかりません」と区別して表示する。
  // 画面へ出すのは分類コードだけで、例外メッセージ・stack trace は出さない
  // （原因の詳細はサーバー側 console.error にのみ記録済み）。
  if (result.kind === "error") {
    return <PlayerScreenLoadError reason={result.reason} />;
  }

  return <PlayerScreenClient viewModel={result.viewModel} />;
}
