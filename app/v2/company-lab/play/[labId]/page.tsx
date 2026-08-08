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

/**
 * 【Server Actionのタイムアウト（品質強化Batch 1・§1）】
 * 相談役AIのUIは fetch ではなく Server Action（askAdvisorAction）を呼ぶ。
 * Server Actionは「そのページのFunction」の中で実行されるため、
 * /api/.../advisor 側に maxDuration を設定しても、この経路には効かない。
 * したがってこのページにも同じ値を設定する必要がある。
 *
 * 【副作用の範囲】この設定はこのページのFunctionのタイムアウト上限を延ばすだけで、
 * 通常のページ表示・他のServer Actionの実行時間を長くするものではない
 * （上限であって待ち時間ではない）。
 *
 * 値の根拠は app/lib/v2/companyLab/advisorAi/advisorClient.ts の
 * ADVISOR_FUNCTION_MAX_DURATION_SECONDS のコメントを参照。
 * route segment configはビルド時に静的解析されるため、必ずリテラルで書く。
 */
export const maxDuration = 240;

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
