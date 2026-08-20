"use client";

// ShrimpX V2 — Independent Player Flow: Player Workspace（server-authoritative）
//
// 【liveSessionRegistryを必須条件にしない】ここはGMのブラウザタブ内キャッシュ
// （liveSessionRegistry）に一切依存しない。マウント時に必ずサーバー
// （/api/v2/play/session、Cookie認証）からPlayer Decision Contextを取得し直す。
// 別端末・別browser・hard reload・browser restart後でも、Cookieが生きている限り
// 同じRun/Companyへ復帰できる。
//
// 【既存Decision Studioをそのまま使う】意思決定入力は既存のDecisionStudio
// component（7 tabs）をそのまま使う。別のDecision UIは作らない。
//
// 【AI Management Meetingは今回未接続】DecisionStudioへsimulationRunId/labIdを
// 渡さない（＝AI会議トグル自体を出さない）。既存のAI会議APIはGM/admin認証のみを
// 受け付けており、Independent Playerセッションでの認証はまだ対応していない
// （#04/#05/#06への引渡事項として最終報告で明記する）。

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import DecisionStudio from "../../company-lab/components/decisionStudio/DecisionStudio";
import { CompanyDecisionDraft } from "../../company-lab/decisionDraft";
import { toScenarioNewsItems } from "../../company-lab/play/_lib/openingInfoViewModel";
import { selectScenarioNewsForTurn } from "../../management/lib/scenarioNews";
import { FinalResultsSummary } from "../../management/components/FinalResultsSummary";
import { FinalResultsCharts } from "../../management/components/FinalResultsCharts";
import { FinalDataDownloadButton } from "../../management/components/FinalDataDownloadButton";
import type { PlayerDecisionContext } from "../../../lib/v2/player/decisionContext";

const POLL_INTERVAL_MS = 4000;

type WorkspaceStatus = "JOINED" | "TURN_ACTIVE" | "EDITING" | "SUBMITTED" | "WAITING_FOR_GM" | "FINISHED" | "ERROR";

async function fetchSessionContext(): Promise<{ ok: true; data: PlayerDecisionContext } | { ok: false; status: number; message: string }> {
  try {
    const response = await fetch("/api/v2/play/session", { cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body ? body.error?.message : undefined;
      return { ok: false, status: response.status, message: message ?? `HTTP ${response.status}` };
    }
    return { ok: true, data: body as PlayerDecisionContext };
  } catch (e) {
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
  }
}

const STATUS_LABELS: Readonly<Record<WorkspaceStatus, string>> = {
  JOINED: "参加処理中…",
  TURN_ACTIVE: "意思決定を入力できます",
  EDITING: "入力中（まだ提出していません）",
  SUBMITTED: "提出しました",
  WAITING_FOR_GM: "提出済み — GMのTurn進行を待っています",
  FINISHED: "ゲーム終了",
  ERROR: "エラー",
};

export default function PlayerWorkspacePage() {
  const [context, setContext] = useState<PlayerDecisionContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CompanyDecisionDraft | null>(null);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justSubmitted, setJustSubmitted] = useState(false);
  const seededTurnRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const result = await fetchSessionContext();
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    setContext(result.data);
    // 新しいTurnへ進んだ、または初回取得時だけdraftを作り直す（編集中の内容を
    // ポーリングのたびに上書きしない）。
    if (!result.data.gameEndedAt && seededTurnRef.current !== result.data.turn) {
      seededTurnRef.current = result.data.turn;
      setDraft(result.data.draftSeed);
      setTouched(false);
      setJustSubmitted(false);
    }
  }, []);

  useEffect(() => {
    // 【react-hooks/set-state-in-effect】effect本体の直下でrefresh()（setStateへ繋がる）を
    // 直接呼ばない。setIntervalの定期呼び出しと同じ「タイマー経由の間接呼び出し」に揃え、
    // 初回取得もsetTimeout(…, 0)でスケジュールする。
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);

  const handleSubmit = useCallback(async () => {
    if (!context || !draft) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await fetch("/api/v2/play/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turn: context.turn, draft }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setSubmitError(body?.error?.message ?? `提出に失敗しました（HTTP ${response.status}）。`);
        return;
      }
      setJustSubmitted(true);
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }, [context, draft, refresh]);

  if (error) {
    return (
      <ErrorScreen
        message={error}
        detail="このセッションは無効です。GMに新しい参加リンクの発行を依頼するか、既に発行済みのリンクを再度開いてください。"
      />
    );
  }
  if (!context) {
    return <LoadingScreen />;
  }

  if (context.gameEndedAt) {
    return <FinishedScreen context={context} />;
  }

  if (!context.isPlayerControlled) {
    return (
      <ErrorScreen
        message="この会社は現在 GM の操作対象（Standard AI）です。"
        detail="GMがこの会社をPLAYER操作へ戻すまでお待ちください。ページはこのまま開いたままで構いません（自動的に切り替わります）。"
      />
    );
  }

  const status: WorkspaceStatus = context.hasSubmittedThisTurn ? (justSubmitted ? "SUBMITTED" : "WAITING_FOR_GM") : touched ? "EDITING" : "TURN_ACTIVE";
  const scenarioNews = toScenarioNewsItems(selectScenarioNewsForTurn(context.scenarioId, context.turn).releases);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-700 bg-slate-900/95 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-base font-bold tracking-tight" data-testid="play-workspace-heading">
              {context.companyDisplayName}（{context.companyId}） — Player
            </h1>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Turn {context.turn} / Scenario {context.scenarioId} / Run ID {context.simulationRunId}
            </p>
          </div>
          <span
            className={`rounded px-2 py-1 text-[11px] font-medium ${
              status === "TURN_ACTIVE" || status === "EDITING" ? "bg-amber-900/60 text-amber-300" : "bg-emerald-900/60 text-emerald-300"
            }`}
            data-testid="play-workspace-status"
            data-status={status}
          >
            {STATUS_LABELS[status]}
          </span>
        </div>
      </header>

      <div className="p-3">
        <div className="mx-auto max-w-5xl">
          {status !== "SUBMITTED" && status !== "WAITING_FOR_GM" ? (
            <div className="mb-2 flex flex-wrap justify-end gap-1.5">
              {submitError ? (
                <p className="mr-auto text-xs text-rose-400" data-testid="play-submit-error">
                  {submitError}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={submitting || !draft}
                data-testid="play-submit-decision"
                className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-semibold hover:bg-emerald-600 disabled:opacity-40"
              >
                {submitting ? "提出中…" : "この内容で意思決定を提出"}
              </button>
            </div>
          ) : (
            <div className="mb-2 rounded-lg border border-emerald-800/60 bg-emerald-950/20 p-3 text-sm text-emerald-200" data-testid="play-waiting-for-gm">
              Turn {context.turn} の意思決定を提出しました。GMが全社の提出を確認してTurnを進めると、自動的に次のTurnへ切り替わります
              （このページを開いたままお待ちください）。
            </div>
          )}

          {draft ? (
            <DecisionStudio
              fixture={context.fixture}
              ownState={context.ownState}
              draft={draft}
              onChange={(next) => {
                setDraft(next);
                setTouched(true);
              }}
              disabled={status === "SUBMITTED" || status === "WAITING_FOR_GM"}
              period={context.period}
              turn={context.turn}
              lastQuarterCapexEvents={context.lastQuarterCapexEvents}
              lastQuarterRejectedCapexProposals={context.lastQuarterRejectedCapexProposals}
              lastQuarterFinancialResult={context.lastQuarterFinancialResult}
              publicInfo={context.publicInfo}
              scenarioNews={scenarioNews}
              companyName={context.companyDisplayName}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FinishedScreen({ context }: { readonly context: PlayerDecisionContext }) {
  const finishedView = context.finishedView;
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-700 bg-slate-900/95 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-base font-bold tracking-tight" data-testid="play-workspace-heading">
            {context.companyDisplayName}（{context.companyId}） — Final Results
          </h1>
          <span className="rounded bg-amber-900/60 px-2 py-1 text-[11px] font-semibold text-amber-300" data-testid="play-workspace-status" data-status="FINISHED">
            ゲーム終了済み（FINISHED）
          </span>
        </div>
      </header>
      <div className="mx-auto max-w-4xl space-y-3 p-3">
        {context.finalEvaluationSnapshot ? (
          <FinalResultsSummary
            snapshot={context.finalEvaluationSnapshot}
            fixtures={finishedView?.session.fixtures ?? [context.fixture]}
            ownCompanyId={context.companyId}
            gameEndTurn={context.gameEndTurn ?? context.turn}
            finishedAt={context.gameEndedAt ?? "－"}
            testIdPrefix="play-final-results"
          />
        ) : null}
        {finishedView ? (
          <>
            <FinalResultsCharts
              dataset={finishedView.dataset}
              history={finishedView.evaluationHistory}
              fixtures={finishedView.session.fixtures}
              gameEndTurn={context.gameEndTurn ?? context.turn}
              highlightKey={context.companyId}
            />
            <FinalDataDownloadButton run={finishedView.session.run} fixtures={finishedView.session.fixtures} session={finishedView.session} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
      <p className="text-sm text-slate-400" data-testid="play-workspace-status" data-status="JOINED">
        参加処理中…
      </p>
    </div>
  );
}

function ErrorScreen({ message, detail }: { readonly message: string; readonly detail: string }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-rose-700/60 bg-rose-950/30 p-6">
        <h1 className="text-base font-semibold text-rose-300" data-testid="play-workspace-status" data-status="ERROR">
          {message}
        </h1>
        <p className="text-sm leading-relaxed text-slate-200">{detail}</p>
        <Link href="/" className="inline-block text-xs text-sky-300 underline underline-offset-2">
          トップへ戻る
        </Link>
      </div>
    </div>
  );
}
