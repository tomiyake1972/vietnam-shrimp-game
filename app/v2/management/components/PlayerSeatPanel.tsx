"use client";

// ShrimpX V2 — Independent Player Flow: GM Console用 PLAYER Seat状況パネル
//
// 会社ごとの参加リンク発行・再発行（旧credentialは自動失効）・失効、および
// join済み/未join・Turn提出済み/未提出をサーバー（Redis正本）から表示する。
// liveSessionRegistry（ブラウザタブ内キャッシュ）には依存しない — 別端末・別browserで
// 参加したPlayerの状態も、ここのポーリングで正しく反映される。
//
// 参加URLは発行/再発行の直後だけ画面へ表示する「reveal-once」。それ以外の一覧取得では
// サーバーは平文URLを一切返さない（joinIdはhashのみRedisに保存される設計と対称）。

import { useCallback, useEffect, useState } from "react";
import {
  issueOrRegeneratePlayerJoinLink,
  listPlayerSeats,
  revokePlayerSeat,
  type PlayerSeatStatus,
} from "../lib/playerSeats";

const POLL_INTERVAL_MS = 5000;

interface Props {
  readonly runId: string | null;
}

export function PlayerSeatPanel({ runId }: Props) {
  const [seats, setSeats] = useState<readonly PlayerSeatStatus[] | null>(null);
  const [currentTurn, setCurrentTurn] = useState<number | null>(null);
  const [gameEndedAt, setGameEndedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyCompanyId, setBusyCompanyId] = useState<string | null>(null);
  const [revealedJoinUrl, setRevealedJoinUrl] = useState<{ readonly companyId: string; readonly url: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!runId) {
      setSeats(null);
      return;
    }
    const result = await listPlayerSeats(runId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setSeats(result.data.companies);
    setCurrentTurn(result.data.currentTurn);
    setGameEndedAt(result.data.gameEndedAt);
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [runId, refresh]);

  const handleIssue = useCallback(
    async (companyId: string) => {
      if (!runId) return;
      setBusyCompanyId(companyId);
      setRevealedJoinUrl(null);
      try {
        const result = await issueOrRegeneratePlayerJoinLink(runId, companyId);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setRevealedJoinUrl({ companyId, url: result.data.joinUrl });
        await refresh();
      } finally {
        setBusyCompanyId(null);
      }
    },
    [runId, refresh]
  );

  const handleRevoke = useCallback(
    async (companyId: string) => {
      if (!runId) return;
      setBusyCompanyId(companyId);
      setRevealedJoinUrl(null);
      try {
        const result = await revokePlayerSeat(runId, companyId);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        await refresh();
      } finally {
        setBusyCompanyId(null);
      }
    },
    [runId, refresh]
  );

  if (!runId) return null;

  const playerSeats = (seats ?? []).filter((s) => s.controlMode === "PLAYER");
  const notSubmittedCount = playerSeats.filter((s) => !s.hasSubmittedThisTurn).length;

  return (
    <section className="rounded-md border border-slate-700 bg-slate-900/50 p-2.5" data-testid="player-seat-panel">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300">独立Player参加（Independent Player Flow）</h3>
      <p className="mb-2 text-[11px] leading-snug text-slate-500">
        経営モードを「自分で操作」にした会社ごとに、別端末・別browserで参加できる参加リンクを発行できます。参加者はGM Consoleとは別のセッションで意思決定を提出します。
      </p>
      {error ? (
        <p className="mb-2 text-[11px] text-rose-400" data-testid="player-seat-panel-error">
          {error}
        </p>
      ) : null}
      {gameEndedAt ? (
        <p className="mb-2 text-[11px] font-medium text-amber-300" data-testid="player-seat-panel-finished">
          このRunはGame End済みです。参加者はFinal Resultsのみ閲覧できます。
        </p>
      ) : playerSeats.length > 0 ? (
        <p
          className={`mb-2 text-[11px] font-medium ${notSubmittedCount > 0 ? "text-amber-300" : "text-emerald-400"}`}
          data-testid="player-seat-advance-eligibility"
        >
          {notSubmittedCount > 0
            ? `Turn ${currentTurn ?? "－"}：あと ${notSubmittedCount} 社の提出待ち（全社提出まで Advance はサーバー側でも拒否されます）`
            : `Turn ${currentTurn ?? "－"}：PLAYER会社は全社提出済みです`}
        </p>
      ) : null}

      <ul className="flex flex-col gap-1.5">
        {playerSeats.map((s) => (
          <li
            key={s.companyId}
            data-testid={`player-seat-row-${s.companyId}`}
            className={`flex flex-col gap-1 rounded border px-2 py-1.5 ${
              s.hasSubmittedThisTurn ? "border-emerald-700/60 bg-emerald-950/20" : "border-slate-700 bg-slate-900/40"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="text-xs font-semibold text-slate-100">{s.companyId}</span>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className={s.joined ? "text-emerald-400" : "text-slate-500"} data-testid={`player-seat-joined-${s.companyId}`}>
                  {s.joined ? "参加済み" : "未参加"}
                </span>
                <span className={s.hasSubmittedThisTurn ? "text-emerald-400" : "text-amber-300"} data-testid={`player-seat-submitted-${s.companyId}`}>
                  {s.hasSubmittedThisTurn ? `Turn ${s.lastSubmittedTurn ?? currentTurn} 提出済み` : "未提出"}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleIssue(s.companyId)}
                disabled={busyCompanyId === s.companyId}
                data-testid={`player-seat-issue-${s.companyId}`}
                className="rounded bg-sky-700 px-2.5 py-1 text-[11px] font-semibold hover:bg-sky-600 disabled:opacity-40"
              >
                {s.joinIssued ? "参加リンク再発行" : "参加リンク発行"}
              </button>
              {s.joinIssued ? (
                <button
                  type="button"
                  onClick={() => void handleRevoke(s.companyId)}
                  disabled={busyCompanyId === s.companyId}
                  data-testid={`player-seat-revoke-${s.companyId}`}
                  className="rounded border border-rose-800 px-2.5 py-1 text-[11px] font-semibold text-rose-300 hover:bg-rose-950/40 disabled:opacity-40"
                >
                  失効
                </button>
              ) : null}
            </div>
            {revealedJoinUrl && revealedJoinUrl.companyId === s.companyId ? (
              <div className="mt-1 rounded border border-sky-800/60 bg-sky-950/30 p-1.5" data-testid={`player-seat-join-url-${s.companyId}`}>
                <p className="mb-1 text-[10px] text-sky-300">この参加リンクは今だけ表示されます。参加者へ直接共有してください（再発行すると旧リンクは無効になります）。</p>
                <code className="block break-all text-[11px] text-slate-100">{revealedJoinUrl.url}</code>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {playerSeats.length === 0 ? (
        <p className="text-[11px] text-slate-500">経営モードを「自分で操作」にした会社がありません。左側のリストで切り替えてください。</p>
      ) : null}
    </section>
  );
}
