// ShrimpX V2 — Independent Player Flow: 参加リンク着地ページ（Server Component・薄いラッパー）
//
// 【既存の薄いpage.tsx→Client Componentパターンを踏襲】
// app/v2/company-lab/play/[labId]/page.tsxと同じ構造: paramsをawaitして
// Client Componentへpropsとして渡すだけ。実際のclaim処理はJoinClient.tsxが
// /api/v2/play/join/{joinId}（Route Handler）へPOSTして行う。
//
// 【なぜページ内で直接claimしないか】このServer Component（RSC）と
// Route Handler（app/api/v2/play/join/[joinId]/route.ts）は、Next.jsのdev環境では
// 別々のモジュールグラフとしてコンパイルされることがあり、E2E in-memory fallback
// （V2_API_E2E_IN_MEMORY=1）のプロセス内シングルトンが正しく共有されない実測不具合が
// あった（発行側APIとclaim側で別インスタンスのPlayerRepositoryを参照し、
// 「参加リンクが無効」と誤判定される）。既存のRoute Handlerを実際に使うことで
// （どのAPI呼び出し経路でも同じモジュールグラフを通る）これを避ける。実Redis環境
// では元々問題にならない差だが、既存の/v2/play/workspaceと同じ
// 「Client Component→既存API route」という一貫した構成にもなる。

interface JoinPageProps {
  readonly params: Promise<{ readonly joinId: string }>;
}

import JoinClient from "./JoinClient";

export default async function PlayerJoinPage({ params }: JoinPageProps) {
  const { joinId } = await params;
  return <JoinClient joinId={joinId} />;
}
