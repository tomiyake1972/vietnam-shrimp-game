"use client";

// ShrimpX V2 — SEAT-UI: 参加管理（独立PLAYER）を画面上部の1箇所にまとめる
//
// 【なぜ作ったか】2026-10-17 の実機確認で、GM が参加リンクへたどり着けなかった。
// 原因は3つに分かれていた。
//   A. 保存の不具合（SEAT-1 / 7ffdd3f で解消）
//      会社を「自分で操作」にしても run.companyControlModes が保存されず、
//      Turn を進めるまで参加枠に現れなかった。
//   B. 反映の遅さ
//      旧パネルは「どの会社がPLAYERか」をサーバーの参加枠（5秒間隔のポーリング）
//      からしか知らず、切替直後は空のままで「機能が無い」ように見えた。
//      → このパネルは経営モードを親の state から直接読む。クリックした瞬間に
//        その行が参加対象になり、発行ボタンが出る。サーバーの参加枠は
//        「参加済み / 提出済み / 発行済み」の付加情報としてだけ使う。
//   C. 配置と文言
//      参加枠パネルは右カラムの3番目にあり、スマホ幅では本体カラム
//      （チャート・Market Summary・TSV・Vision・Balance・AI Pack・5社サマリー）の
//      あとに積まれるため、長くスクロールしないと到達しない。
//      空状態の文言も「左側のリストで切り替えてください」だったが、実際の
//      経営モードUIは同じ右カラムのすぐ上にあり、案内と配置が食い違っていた。
//      → このパネルを本体の最上部・全幅に置き、ここだけで
//        「人の操作にする → リンクを発行・コピー → 参加状況を見る」が完結するようにした。
//
// 【GM代理入力と参加者の入口を分ける】同じ行に2つの導線が並ぶため、見出しと
// ボタン文言で用途を言い切る。
//   参加者に渡す   … 参加リンク（会社ごとに違う。これ自体が資格情報）
//   GMが代わりに入力 … この会社を操作（GM自身のタブで開く代理入力）
//
// 参加URLは発行直後の1回だけ表示される（サーバーは平文を保存しない）。
// このパネルも、その1回を確実にコピーさせることを優先している。

import { useCallback, useRef, useState } from "react";
import {
  issueOrRegeneratePlayerJoinLink,
  listPlayerSeats,
  revokePlayerSeat,
  type PlayerSeatListKnownState,
  type PlayerSeatStatus,
} from "../lib/playerSeats";
import { useVisiblePolling, type PollOutcome } from "../../lib/useVisiblePolling";
import { CompanyControlMode } from "../../../lib/v2/companyLab/simulation/types";
import { CompanyFixture } from "../../../lib/v2/companyLab/types";

const POLL_INTERVAL_MS = 5000;

interface Props {
  readonly runId: string | null;
  readonly fixtures: readonly CompanyFixture[];
  readonly controlModes: Readonly<Record<string, CompanyControlMode>>;
  /** 保存まで行い、サーバー保存が成立したかどうかを返す。 */
  readonly onChangeMode: (companyId: string, mode: CompanyControlMode) => Promise<boolean>;
  /** GM代理入力（この会社をGM自身のタブで操作する）。 */
  readonly onOperate: (companyId: string) => void;
  readonly disabled: boolean;
}

type CopyState = { readonly companyId: string; readonly ok: boolean } | null;
type SaveState = "saving" | "saved" | "failed";

export function PlayerParticipationPanel({ runId, fixtures, controlModes, onChangeMode, onOperate, disabled }: Props) {
  const [seats, setSeats] = useState<readonly PlayerSeatStatus[] | null>(null);
  const [currentTurn, setCurrentTurn] = useState<number | null>(null);
  const [gameEndedAt, setGameEndedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyCompanyId, setBusyCompanyId] = useState<string | null>(null);
  const [revealedJoinUrl, setRevealedJoinUrl] = useState<{ readonly companyId: string; readonly url: string } | null>(null);
  const [copied, setCopied] = useState<CopyState>(null);
  /**
   * 【保存状態】会社ごとに「保存中 / 保存成功 / 保存失敗」を持つ。
   * 失敗したものを参加対象として確定したように見せないために使う。
   */
  const [saveState, setSaveState] = useState<Readonly<Record<string, SaveState>>>({});
  const [open, setOpen] = useState(true);

  const knownRef = useRef<PlayerSeatListKnownState | null>(null);

  const refresh = useCallback(async (): Promise<PollOutcome> => {
    if (!runId) {
      setSeats(null);
      knownRef.current = null;
      return "ok";
    }
    const result = await listPlayerSeats(runId, knownRef.current);
    if (!result.ok) {
      setError(result.error);
      return /HTTP (401|403)/.test(result.error) ? "unauthorized" : "error";
    }
    setError(null);
    const data = result.data;
    if (data.unchanged) {
      knownRef.current = {
        persistenceRevision: data.persistenceRevision,
        seatsVersion: data.seatsVersion,
        companyIds: knownRef.current?.companyIds ?? [],
      };
      return "ok";
    }
    const companies = data.companies ?? [];
    setSeats(companies);
    setCurrentTurn(data.currentTurn ?? null);
    setGameEndedAt(data.gameEndedAt ?? null);
    knownRef.current = {
      persistenceRevision: data.persistenceRevision,
      seatsVersion: data.seatsVersion,
      companyIds: companies.map((c) => c.companyId),
    };
    return "ok";
  }, [runId]);

  useVisiblePolling({ intervalMs: POLL_INTERVAL_MS, enabled: runId !== null, poll: refresh });

  const handleIssue = useCallback(
    async (companyId: string) => {
      if (!runId) return;
      setBusyCompanyId(companyId);
      setCopied(null);
      try {
        const result = await issueOrRegeneratePlayerJoinLink(runId, companyId);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setError(null);
        setRevealedJoinUrl({ companyId, url: result.data.joinUrl });
        knownRef.current = null;
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
      try {
        const result = await revokePlayerSeat(runId, companyId);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setError(null);
        setRevealedJoinUrl((prev) => (prev?.companyId === companyId ? null : prev));
        knownRef.current = null;
        await refresh();
      } finally {
        setBusyCompanyId(null);
      }
    },
    [runId, refresh]
  );

  /**
   * 表示は1回だけなので、コピーは確実に成否を出す。
   * clipboard API が使えない環境（古いブラウザ・非セキュアコンテキスト）でも
   * 黙って失敗せず、URL は画面に出たままにして手動コピーへ倒す。
   */
  const handleCopy = useCallback(async (companyId: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied({ companyId, ok: true });
    } catch {
      setCopied({ companyId, ok: false });
    }
  }, []);

  /**
   * 経営モードを変更し、サーバー保存の成否まで見届ける。
   * 成功したら参加枠を取り直して、サーバー側が PLAYER と認識したことを
   * 確認してから発行ボタンを有効にする（楽観的に有効化しない）。
   */
  const handleSetMode = useCallback(
    async (companyId: string, mode: CompanyControlMode) => {
      setSaveState((prev) => ({ ...prev, [companyId]: "saving" }));
      setCopied(null);
      const ok = await onChangeMode(companyId, mode);
      setSaveState((prev) => ({ ...prev, [companyId]: ok ? "saved" : "failed" }));
      if (ok) {
        knownRef.current = null;
        await refresh();
      }
    },
    [onChangeMode, refresh]
  );

  if (!runId || fixtures.length === 0) return null;

  const seatById = new Map((seats ?? []).map((s) => [s.companyId, s]));
  const playerCompanies = fixtures.filter((f) => (controlModes[f.companyId] ?? "STANDARD_AI") === "PLAYER");
  const joinedCount = playerCompanies.filter((f) => seatById.get(f.companyId)?.joined).length;
  const submittedCount = playerCompanies.filter((f) => seatById.get(f.companyId)?.hasSubmittedThisTurn).length;
  const notSubmitted = playerCompanies.length - submittedCount;

  return (
    <section
      className="rounded-lg border border-sky-800/70 bg-sky-950/20 p-3"
      data-testid="player-participation-panel"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="text-sm font-semibold text-sky-100">参加管理（受講者の参加リンク）</h2>
        <span className="text-[11px] text-slate-300" data-testid="participation-summary">
          自分で操作 {playerCompanies.length}社 ／ 参加済み {joinedCount}社 ／ Turn
          {currentTurn ?? "－"} 提出済み {submittedCount}社
        </span>
        {playerCompanies.length > 0 ? (
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
              notSubmitted > 0 ? "bg-amber-900/60 text-amber-200" : "bg-emerald-900/60 text-emerald-200"
            }`}
            data-testid="participation-advance-state"
          >
            {notSubmitted > 0 ? `あと ${notSubmitted}社の提出待ち` : "全社提出済み"}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          data-testid="participation-toggle"
          className="ml-auto rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
        >
          {open ? "閉じる" : "開く"}
        </button>
      </div>

      {open ? (
        <>
          <p className="mt-2 text-[11px] leading-snug text-slate-400">
            受講者に渡すのは、会社ごとの<strong className="text-sky-200">参加リンク</strong>だけです。
            このGM画面のURLは配らないでください。リンクは発行した直後の1回だけ表示されます。
          </p>
          {gameEndedAt ? (
            <p className="mt-2 text-[11px] font-medium text-amber-300" data-testid="participation-finished">
              このRunはGame End済みです。参加者はFinal Resultsのみ閲覧できます。
            </p>
          ) : null}
          {error ? (
            <p className="mt-2 text-[11px] text-rose-400" data-testid="participation-error">
              {error}
            </p>
          ) : null}

          <ul className="mt-2 flex flex-col gap-2">
            {fixtures.map((f) => {
              /**
               * isPlayer        … GMがこの画面で選んだ状態（ローカル）
               * confirmedPlayer … サーバーが PLAYER と認識している状態
               * 参加リンクの発行は confirmedPlayer のときだけ許す。保存に失敗した
               * ものを、参加対象として確定したように見せないため。
               */
              const mode: CompanyControlMode = controlModes[f.companyId] ?? "STANDARD_AI";
              const isPlayer = mode === "PLAYER";
              const seat = seatById.get(f.companyId);
              const confirmedPlayer = seat?.controlMode === "PLAYER";
              const save = saveState[f.companyId];
              const busy = busyCompanyId === f.companyId;
              const revealed = revealedJoinUrl?.companyId === f.companyId ? revealedJoinUrl.url : null;
              return (
                <li
                  key={f.companyId}
                  data-testid={`participation-row-${f.companyId}`}
                  className={`rounded border px-2.5 py-2 ${
                    isPlayer ? "border-sky-800/60 bg-slate-900/60" : "border-slate-700 bg-slate-900/30"
                  }`}
                >
                  {/* 1行目: 会社と状態 */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-xs font-semibold text-slate-100">{f.companyId}</span>
                    <span className="text-[11px] text-slate-400">{f.displayName}</span>
                    {save === "saving" ? (
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-300" data-testid={`participation-save-${f.companyId}`}>
                        サーバーへ保存中…
                      </span>
                    ) : save === "failed" ? (
                      <span
                        className="rounded bg-rose-950/60 px-1.5 py-0.5 text-[11px] font-semibold text-rose-300"
                        data-testid={`participation-save-${f.companyId}`}
                      >
                        保存失敗（サーバー未反映）
                      </span>
                    ) : save === "saved" ? (
                      <span
                        className="rounded bg-emerald-950/60 px-1.5 py-0.5 text-[11px] text-emerald-300"
                        data-testid={`participation-save-${f.companyId}`}
                      >
                        保存済み
                      </span>
                    ) : null}
                    {isPlayer && confirmedPlayer ? (
                      <>
                        <span
                          className={`text-[11px] ${seat?.joined ? "text-emerald-400" : "text-slate-500"}`}
                          data-testid={`participation-joined-${f.companyId}`}
                        >
                          {seat?.joined ? "参加済み" : "未参加"}
                        </span>
                        <span
                          className={`text-[11px] ${seat?.hasSubmittedThisTurn ? "text-emerald-400" : "text-amber-300"}`}
                          data-testid={`participation-submitted-${f.companyId}`}
                        >
                          {seat?.hasSubmittedThisTurn ? "提出済み" : "未提出"}
                        </span>
                      </>
                    ) : isPlayer ? (
                      <span className="text-[11px] text-slate-500" data-testid={`participation-pending-${f.companyId}`}>
                        サーバー反映待ち
                      </span>
                    ) : (
                      <>
                        <span className="text-[11px] text-slate-500" data-testid={`participation-mode-${f.companyId}`}>
                          Standard AI（自動）
                        </span>
                        {/* 【SEAT-UI 追加確認②】Standard AI へ戻しても、そのTurnに既に確定済みの
                            提出が残っていれば、engine はそちらを採用する（advanceSimulationTurn は
                            経営モードではなく「確定済み意思決定があるか」で採用を決める）。
                            切替は次のTurnから効く、という既存仕様どおりの挙動だが、行の表示が
                            「Standard AI（自動）」だけだと、このTurnがAIで回ると誤解される。
                            実際に採用される側を明示する。 */}
                        {seat?.hasSubmittedThisTurn ? (
                          <span
                            className="rounded bg-amber-950/50 px-1.5 py-0.5 text-[11px] text-amber-300"
                            data-testid={`participation-ai-with-submission-${f.companyId}`}
                          >
                            このTurnは提出済みの入力で進みます（AIになるのは次のTurnから）
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>

                  {/* 2行目: 操作。スマホでも縦に積んで全部見えるようにする */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {isPlayer ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleIssue(f.companyId)}
                          disabled={busy || disabled || !confirmedPlayer}
                          data-testid={`participation-issue-${f.companyId}`}
                          className="rounded bg-sky-700 px-2.5 py-1 text-[11px] font-semibold hover:bg-sky-600 disabled:opacity-40"
                        >
                          {seat?.joinIssued ? "参加リンクを再発行" : "参加リンクを発行"}
                        </button>
                        {seat?.joinIssued ? (
                          <button
                            type="button"
                            onClick={() => void handleRevoke(f.companyId)}
                            disabled={busy || disabled}
                            data-testid={`participation-revoke-${f.companyId}`}
                            className="rounded border border-rose-800 px-2.5 py-1 text-[11px] font-semibold text-rose-300 hover:bg-rose-950/40 disabled:opacity-40"
                          >
                            失効
                          </button>
                        ) : null}
                        <span className="mx-1 hidden text-slate-700 sm:inline">|</span>
                        <button
                          type="button"
                          onClick={() => onOperate(f.companyId)}
                          disabled={disabled}
                          data-testid={`participation-operate-${f.companyId}`}
                          className="rounded border border-slate-600 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                        >
                          GMが代わりに入力
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSetMode(f.companyId, "STANDARD_AI")}
                          disabled={disabled || save === "saving"}
                          data-testid={`participation-to-ai-${f.companyId}`}
                          className="rounded border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400 hover:bg-slate-800 disabled:opacity-40"
                        >
                          Standard AI に戻す
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleSetMode(f.companyId, "PLAYER")}
                        disabled={disabled || save === "saving"}
                        data-testid={`participation-to-player-${f.companyId}`}
                        className="rounded bg-sky-700 px-2.5 py-1 text-[11px] font-semibold hover:bg-sky-600 disabled:opacity-40"
                      >
                        受講者に操作してもらう
                      </button>
                    )}
                  </div>

                  {/* 3行目: 発行直後だけ出る参加リンク */}
                  {revealed ? (
                    <div
                      className="mt-1.5 rounded border border-sky-700/60 bg-sky-950/40 p-2"
                      data-testid={`participation-join-url-${f.companyId}`}
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-semibold text-sky-200">
                          {f.companyId} の参加リンク（いま1回だけ表示しています）
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleCopy(f.companyId, revealed)}
                          data-testid={`participation-copy-${f.companyId}`}
                          className="rounded bg-sky-700 px-2 py-0.5 text-[11px] font-semibold hover:bg-sky-600"
                        >
                          コピー
                        </button>
                        {copied?.companyId === f.companyId ? (
                          <span
                            className={`text-[10px] ${copied.ok ? "text-emerald-300" : "text-amber-300"}`}
                            data-testid={`participation-copy-result-${f.companyId}`}
                          >
                            {copied.ok ? "コピーしました" : "コピーできませんでした。下のURLを手動で選択してください"}
                          </span>
                        ) : null}
                      </div>
                      <code className="block break-all text-[11px] text-slate-100">{revealed}</code>
                      <p className="mt-1 text-[10px] text-slate-400">
                        この会社の受講者にだけ渡してください。再発行すると、いま出ているリンクは無効になります。
                      </p>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {playerCompanies.length === 0 ? (
            <p className="mt-2 text-[11px] text-slate-400" data-testid="participation-empty">
              いまは5社とも Standard AI（自動）です。受講者に操作してもらう会社の
              「受講者に操作してもらう」を押すと、参加リンクを発行できるようになります。
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
