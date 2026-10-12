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

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import DecisionStudio from "../../company-lab/components/decisionStudio/DecisionStudio";
import { CompanyDecisionDraft, validateDecisionDraftNumbers } from "../../company-lab/decisionDraft";
import { buildDecisionSummary } from "../../company-lab/decisionSummary";
import DecisionConfirmationScreen from "../../company-lab/components/decisionStudio/DecisionConfirmationScreen";
import type { DecisionStudioScreenKey } from "../../company-lab/components/decisionStudio/DecisionStudioNavigation";
// 【PLAYER-SURFACE-1】受講者が実際に使うこの画面には Overview / Market / Inventory が
// 無く、意思決定タブしか無かった（GM コンソール側の PlayerWorkspace にしか存在せず、
// あちらは GM のブラウザタブ内キャッシュを正本にしているため受講者からは開けない）。
// 表示用の値はすべてサーバー（PlayerDecisionContext）が組み立てたものをそのまま出す。
import { PlayerCompetitorPanel, PlayerInventoryPanel, PlayerMarketPanel, PlayerOverviewPanel } from "./WorkspacePanels";
import { validateSalesForceHiringDecision } from "../../../lib/v2/companyLab/salesForceHiring";
import { toScenarioNewsItems } from "../../company-lab/play/_lib/openingInfoViewModel";
import { selectScenarioNewsForTurn } from "../../management/lib/scenarioNews";
import { FinalResultsSummary } from "../../management/components/FinalResultsSummary";
import { FinalResultsCharts } from "../../management/components/FinalResultsCharts";
import { FinalDataDownloadButton } from "../../management/components/FinalDataDownloadButton";
import type { PlayerDecisionContext } from "../../../lib/v2/player/decisionContext";
import { useVisiblePolling, type PollOutcome } from "../../lib/useVisiblePolling";

const POLL_INTERVAL_MS = 4000;

type WorkspaceTab = "overview" | "market" | "inventory" | "decision";

const TABS: readonly { readonly id: WorkspaceTab; readonly label: string }[] = [
  { id: "overview", label: "Overview（前Turnのふりかえり）" },
  { id: "market", label: "Market（市場情報）" },
  { id: "inventory", label: "Inventory（在庫）" },
  { id: "decision", label: "Decision（意思決定）" },
];

type WorkspaceStatus = "JOINED" | "TURN_ACTIVE" | "EDITING" | "SUBMITTED" | "WAITING_FOR_GM" | "FINISHED" | "ERROR";

/**
 * 【BW-1・転送量削減】いま持っている revision をサーバーへ伝える。
 * 保存物が変わっていなければ server は大きいパートを読まずに
 * { unchanged: true } だけを返す。変わっていれば従来どおり context 全体が返る。
 */
type SessionFetchResult =
  | { readonly ok: true; readonly unchanged: true; readonly persistenceRevision: number }
  | { readonly ok: true; readonly unchanged: false; readonly data: PlayerDecisionContext; readonly persistenceRevision: number }
  | { readonly ok: false; readonly status: number; readonly message: string };

async function fetchSessionContext(knownRevision: number | null): Promise<SessionFetchResult> {
  try {
    const query = knownRevision !== null ? `?knownRevision=${encodeURIComponent(String(knownRevision))}` : "";
    const response = await fetch(`/api/v2/play/session${query}`, { cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body ? body.error?.message : undefined;
      return { ok: false, status: response.status, message: message ?? `HTTP ${response.status}` };
    }
    const payload = body as (PlayerDecisionContext & { readonly unchanged?: boolean; readonly persistenceRevision?: number }) | null;
    const revision = typeof payload?.persistenceRevision === "number" ? payload.persistenceRevision : 0;
    if (payload?.unchanged === true) return { ok: true, unchanged: true, persistenceRevision: revision };
    return { ok: true, unchanged: false, data: payload as PlayerDecisionContext, persistenceRevision: revision };
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
  /**
   * 【UI-TRIAL-1 §5】入力 →「意思決定を確認」→ 最終確認 →「この内容で提出」。
   * phase は画面の表示状態だけを持ち、サーバーへの提出は confirm 画面のボタンだけが行う。
   */
  const [phase, setPhase] = useState<"input" | "confirm">("input");
  const [activeScreen, setActiveScreen] = useState<DecisionStudioScreenKey>("info");
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  /** 確認画面へ入った時点のTurn。確認中にTurnが進んだら古い内容を提出させない。 */
  const [confirmedAtTurn, setConfirmedAtTurn] = useState<number | null>(null);
  const seededTurnRef = useRef<number | null>(null);
  /** 【BW-1】いま手元にある保存物の revision。これをサーバーへ伝えて差分だけ受け取る。 */
  const knownRevisionRef = useRef<number | null>(null);

  const refresh = useCallback(async (): Promise<PollOutcome> => {
    const result = await fetchSessionContext(knownRevisionRef.current);
    if (!result.ok) {
      setError(result.message);
      // 認証切れは自動取得を止める（叩き続けない）。
      return result.status === 401 || result.status === 403 ? "unauthorized" : "error";
    }
    knownRevisionRef.current = result.persistenceRevision;
    if (result.unchanged) {
      setError(null);
      return "ok";
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
    return "ok";
  }, []);

  useVisiblePolling({ intervalMs: POLL_INTERVAL_MS, enabled: true, poll: refresh });

  /**
   * 【UI-TRIAL-1 §6】確認へ進む前と最終提出時に、同じ共通検証を通す。
   * 検証関数は Console内PLAYER（PlayerWorkspace）と server（/api/v2/play/submit）と
   * 同一のものを使う（経路によって厳しさが変わらないようにする）。
   */
  const collectValidationErrors = useCallback(
    (target: CompanyDecisionDraft | null): readonly string[] => {
      if (!target || !context) return [];
      return [
        ...validateDecisionDraftNumbers(target),
        ...validateSalesForceHiringDecision({
          hireCount: target.salesForceHireCount,
          layoffCount: target.salesForceLayoffCount,
          currentActiveHeadcount: context.ownState.salesForceHiringState.headcount,
        }),
      ];
    },
    [context]
  );

  const handleGoToConfirm = useCallback(() => {
    if (!context || !draft) return;
    const errors = collectValidationErrors(draft);
    if (errors.length > 0) {
      // 入力欄のある画面に留めて、項目名と理由を示す（入力は保持する）。
      setSubmitError(`入力に無効な値があるため確認へ進めません（値は保存していません）。${errors.slice(0, 5).join(" / ")}`);
      return;
    }
    setSubmitError(null);
    setConfirmedAtTurn(context.turn);
    setPhase("confirm");
  }, [context, draft, collectValidationErrors]);

  const handleEditFromConfirm = useCallback((screen: DecisionStudioScreenKey) => {
    // 入力内容（draft）には触れない。表示する画面だけを戻す。
    setActiveScreen(screen);
    setPhase("input");
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!context || !draft) return;
    /**
     * 【INT-1 §3（最終監査後）】空欄・不正値を送る前にこの画面で止める。
     *
     * 下書きは下の fetch で JSON.stringify を通るため、入力欄の空欄（NaN）は
     * null になって届く。server 側の検証はその null も拒否するよう直したが、
     * ここで先に止めれば JSON 変換を経ずに同じ項目名を即座に示せる。
     * 検証関数は Console内PLAYER（PlayerWorkspace.handleConfirm）と
     * server（/api/v2/play/submit）と同一のものを使い、経路によって
     * 厳しさが変わらないようにする（UIへ別実装しない）。
     */
    const draftErrors = validateDecisionDraftNumbers(draft);
    if (draftErrors.length > 0) {
      setSubmitError(`入力に無効な値があるため提出できません（値は保存していません）。${draftErrors.slice(0, 5).join(" / ")}`);
      return;
    }
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
      setPhase("input");
      setConfirmedAtTurn(null);
      knownRevisionRef.current = null; // 提出で保存物が変わる。次回は必ず取り直す。
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

      {/* 【PLAYER-SURFACE-1】確認画面を開いている間はタブを出さない
          （提出直前に別タブへ移動して確認内容を見失うのを防ぐ）。 */}
      {phase === "input" ? (
        <nav className="flex flex-wrap gap-1 border-b border-slate-800 bg-slate-900/60 px-3 py-1.5" data-testid="play-workspace-tabs">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                data-testid={`play-workspace-tab-${t.id}`}
                aria-current={active ? "page" : undefined}
                className={`rounded px-2.5 py-1 text-xs ${active ? "bg-slate-700 font-semibold text-slate-100" : "text-slate-400 hover:bg-slate-800"}`}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
      ) : null}

      <div className="p-3">
        <div className="mx-auto max-w-5xl">
          {/* 【PLAYER-SURFACE-1】提出済みの案内はタブに関係なく必ず出す。
              タブの内側に置くと、Overview を見ている受講者に提出状態が伝わらない。 */}
          {status === "SUBMITTED" || status === "WAITING_FOR_GM" ? (
            <div className="mb-2 rounded-lg border border-emerald-800/60 bg-emerald-950/20 p-3 text-sm text-emerald-200" data-testid="play-waiting-for-gm">
              Turn {context.turn} の意思決定を提出しました。GMが全社の提出を確認してTurnを進めると、自動的に次のTurnへ切り替わります
              （このページを開いたままお待ちください）。
            </div>
          ) : null}

          {phase === "input" && tab === "overview" ? <PlayerOverviewPanel review={context.lastTurnReview} /> : null}
          {phase === "input" && tab === "market" ? (
            <div className="space-y-3">
              <PlayerMarketPanel view={context.marketView} />
              <PlayerCompetitorPanel snapshot={context.competitorSnapshot} />
            </div>
          ) : null}
          {phase === "input" && tab === "inventory" ? <PlayerInventoryPanel view={context.inventoryView} /> : null}

          {phase === "confirm" || tab === "decision" ? (
          <>
          {status !== "SUBMITTED" && status !== "WAITING_FOR_GM" && phase === "input" ? (
            /* 【UI-TRIAL-1 §5】提出は最終確認画面のボタンだけが行う。
                ここでは確認画面へ進むだけで、サーバーへは何も送らない。 */
            <div className="mb-2 flex flex-wrap justify-end gap-1.5">
              {submitError ? (
                <p className="mr-auto text-xs text-rose-400" data-testid="play-submit-error">
                  {submitError}
                </p>
              ) : null}
              <button
                type="button"
                onClick={handleGoToConfirm}
                disabled={!draft}
                data-testid="play-review-decision"
                className="rounded bg-sky-700 px-4 py-1.5 text-sm font-semibold hover:bg-sky-600 disabled:opacity-40"
              >
                意思決定を確認
              </button>
            </div>
          ) : null}

          {/* 【配当Decision UI接続】lastQuarterDividendResult は GM代理の
              PlayerWorkspace.tsx と同一のpropであり、Independent Player側の
              Decision StudioでもFINANCEタブの配当UI（累積配当・前Turnの却下
              理由）が同じ表示になる。値はserver側のPlayerDecisionContextが
              既に提供しているものをそのまま渡すだけで、ここに新しい配当計算・
              推奨額・将来キャッシュ予測などは一切持たない（配当SSoTは
              app/lib/v2/finance/dividend.ts のまま）。 */}
          {draft && phase === "confirm" ? (
            <DecisionConfirmationScreen
              summary={buildDecisionSummary({ draft, annualDividendGuidance: context.annualDividendGuidance })}
              companyName={context.companyDisplayName}
              companyId={context.companyId}
              turnLabel={`Turn ${context.turn}（${context.period}）`}
              copy={{
                heading: "提出内容の最終確認",
                commitLabel: "この内容で提出",
                committingLabel: "提出中…",
                description:
                  "下の一覧が、いまから提出する意思決定のすべてです。分野ごとの「修正する」で入力画面へ戻れます（入力内容はそのまま残ります）。",
              }}
              validationErrors={collectValidationErrors(draft)}
              onEdit={handleEditFromConfirm}
              onBack={() => setPhase("input")}
              onCommit={() => void handleSubmit()}
              committing={submitting}
              commitError={submitError}
              staleNotice={
                confirmedAtTurn !== null && confirmedAtTurn !== context.turn
                  ? `確認中にTurnが進みました（確認したのは Turn ${confirmedAtTurn}、現在は Turn ${context.turn}）。古い内容は提出できません。「入力へ戻る」から入力を見直して、もう一度確認してください。`
                  : context.hasSubmittedThisTurn
                    ? "このTurnの意思決定はすでに提出済みです。二重に提出することはできません。"
                    : null
              }
            />
          ) : null}

          {draft && phase === "input" ? (
            <DecisionStudio
              activeScreen={activeScreen}
              onActiveScreenChange={setActiveScreen}
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
              costProjection={context.costProjection}
              lastQuarterCapexEvents={context.lastQuarterCapexEvents}
              lastQuarterRejectedCapexProposals={context.lastQuarterRejectedCapexProposals}
              lastQuarterFinancialResult={context.lastQuarterFinancialResult}
              lastQuarterFinancingResult={context.lastQuarterFinancingResult}
              lastQuarterDividendResult={context.lastQuarterDividendResult}
              annualDividendGuidance={context.annualDividendGuidance}
              lastQuarterSalesAllocations={context.lastQuarterSalesAllocations}
              publicInfo={context.publicInfo}
              scenarioNews={scenarioNews}
              companyName={context.companyDisplayName}
            />
          ) : null}
          </>
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
