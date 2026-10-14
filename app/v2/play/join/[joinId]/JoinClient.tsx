"use client";

// ShrimpX V2 — Independent Player Flow: 参加リンクclaim（Client Component）
//
// マウント時に /api/v2/play/join/{joinId}（Route Handler）へPOSTしてclaimを試みる。
// 成功したらHttpOnly Player Session Cookieが発行された状態で
// /v2/play/workspaceへ遷移する。失敗時は理由をそのまま表示する（推測させない）。
//
// 【Player Join画面とGM/Admin画面を混同しない】ここはPlayer専用の入口であり、
// staging admin loginとは完全に別の認証経路を通る（既存のstaging admin session
// Cookieには一切触れない）。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface JoinClientProps {
  readonly joinId: string;
}

type ClaimState = { readonly kind: "pending" } | { readonly kind: "error"; readonly message: string } | { readonly kind: "done" };

async function attemptClaim(joinId: string): Promise<ClaimState> {
  try {
    const response = await fetch(`/api/v2/play/join/${encodeURIComponent(joinId)}`, { method: "POST" });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body ? body.error?.message : undefined;
      return { kind: "error", message: message ?? `参加処理に失敗しました（HTTP ${response.status}）。` };
    }
    return { kind: "done" };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

export default function JoinClient({ joinId }: JoinClientProps) {
  const router = useRouter();
  const [state, setState] = useState<ClaimState>({ kind: "pending" });

  useEffect(() => {
    // 【react-hooks/set-state-in-effect】effect本体の直下でsetStateを直接呼ばない
    // （形式チェックの分岐も含めて）。play/workspace/page.tsxと同じ、setTimeout経由の
    // 間接呼び出しに揃える。
    const timer = setTimeout(() => {
      if (typeof joinId !== "string" || joinId.length < 16) {
        setState({ kind: "error", message: "参加リンクの形式が不正です。GMに正しいリンクを確認してください。" });
        return;
      }
      void attemptClaim(joinId).then((result) => {
        if (result.kind === "done") {
          router.replace("/v2/play/workspace");
          return;
        }
        setState(result);
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [joinId, router]);

  if (state.kind === "error") {
    return <ErrorScreen message={state.message} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
      <p className="text-sm text-slate-400" data-testid="play-workspace-status" data-status="JOINED">
        参加処理中…
      </p>
    </div>
  );
}

function ErrorScreen({ message }: { readonly message: string }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-rose-700/60 bg-rose-950/30 p-6">
        <h1 className="text-base font-semibold text-rose-300">参加できませんでした</h1>
        <p className="text-sm leading-relaxed text-slate-200" data-testid="join-error-message">
          {message}
        </p>
        {/* 【PLAYER-SURFACE-2】「/」へは送らない（GMコンソールへのリンクが出ているため）。 */}
        <p className="text-xs text-slate-400">GM（進行役）に、参加リンクの再発行を依頼してください。</p>
        <p className="text-xs text-slate-500">
          すでに参加済みで、同じ端末・同じブラウザを使っている場合は、ワークスペースを直接開けることがあります。
        </p>
        <Link href="/v2/play/workspace" className="inline-block text-xs text-sky-300 underline underline-offset-2" data-testid="join-open-workspace">
          ワークスペースを開いてみる
        </Link>
      </div>
    </div>
  );
}
