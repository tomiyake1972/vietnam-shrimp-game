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
import PlayerScreenClient from "./PlayerScreenClient";

interface PlayerPageProps {
  readonly params: Promise<{ readonly labId: string }>;
}

export default async function CompanyLabPlayerPage({ params }: PlayerPageProps) {
  await requireStagingSession();
  const { labId } = await params;

  const deps = await resolveCompanyLabUiDependencies();
  const result = await loadPlayerScreenViewModel(deps, labId);

  if (result.kind === "notFound") {
    notFound();
  }

  return <PlayerScreenClient viewModel={result.viewModel} />;
}
