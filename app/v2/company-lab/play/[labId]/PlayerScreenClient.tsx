// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） プレイヤー画面のClient Component
//
// draftの編集状態だけをこのコンポーネントのuseStateで持つ（サーバー側の永続状態こそが
// 正であり、このuseStateはあくまで「編集中の一時的な値」。指示§11「React local stateに
// 依存しない」はサーバー再読み込み後の復元経路（page.tsx→viewModel.ts→ここへ初期値として
// 渡す）で満たす）。
//
// 【二重送信防止】保存・提出・処理の各ボタンはuseTransitionのisPendingで押下中は
// disabledにする（クライアント側の見た目の保護）。ただし本当の安全性はサーバー側
// （Application Service層のturnId/lock/revision/冪等判定）に依存しており、
// クライアント側のdisabledだけに頼らない（指示§10）。
//
// 【状態同期】保存・提出・処理いずれかが成功すると、Server Action内のrevalidatePathで
// このルートのRSCペイロードが再取得され、かつrouter.refresh()でも明示的に再取得する。
// 親のpage.tsx（Server Component）が新しいviewModelを算出し、このコンポーネントへ新しい
// propsとして渡す。keyにturn・revision・phase・draftUpdatedAtを含めることで、
// サーバー側の状態が実際に変わったタイミングだけコンポーネントを再マウントし、
// 新しいviewModel.draftを唯一の初期値として使う（ローカル編集中の値との食い違いを防ぐ、
// Reactの「keyでstateをリセットする」定石パターン）。

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import DecisionEditor from "../../components/DecisionEditor";
import CollapsibleSection from "../../components/CollapsibleSection";
import MarketPanel from "../../components/MarketPanel";
import ResultsPanel from "../../components/ResultsPanel";
import FinancialResultsSection from "../../components/financial/FinancialResultsSection";
import PlayLabBanner from "../components/PlayLabBanner";
import { CompanyDecisionDraft, summarizeSalesForceAllocation } from "../../decisionDraft";
import { PlayerScreenViewModel } from "../_lib/viewModel";
import { processQuarterAction, saveDraftAction, submitDraftAction, withdrawDraftAction } from "./actions";

interface PlayerScreenClientProps {
  readonly viewModel: PlayerScreenViewModel;
}

function PlayerScreenClientInner({ viewModel }: PlayerScreenClientProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<CompanyDecisionDraft | null>(viewModel.draft);
  const [savePending, startSaveTransition] = useTransition();
  const [submitPending, startSubmitTransition] = useTransition();
  const [processPending, startProcessTransition] = useTransition();
  const [withdrawPending, startWithdrawTransition] = useTransition();
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [processMessage, setProcessMessage] = useState<string | null>(null);
  const [withdrawMessage, setWithdrawMessage] = useState<string | null>(null);
  const [confirmingProcess, setConfirmingProcess] = useState(false);

  const isEditing = viewModel.phase === "editing";
  const isSubmitted = viewModel.phase === "submitted";
  const isCompleted = viewModel.phase === "completed";
  const busy = savePending || submitPending || processPending || withdrawPending;

  // 【Phase 8G】営業人員の配分合計チェック。draft.salesPlansが存在する（=完了済みでない）
  // ときだけ意味を持つ。validateSalesForceHeadcountBudget（エンジン側）と同じ
  // 「全社合計」判定をここで先読みし、提出前に警告・提出ボタンの無効化に使う
  // （入力欄自体は無効化しない — 上限超過中も編集は必ず可能）。
  // 【Phase 8G §2】配分可能人数は静的なfixtureの基準値ではなく、前期末までに
  // 確定した会社状態（ownState.salesForceHiringState.headcount）を使う
  // （DecisionEditor.tsxと同じ理由。増員後は翌四半期以降こちらが増える）。
  const salesForceAllocation = draft
    ? summarizeSalesForceAllocation(draft.salesPlans, viewModel.ownState.salesForceHiringState.headcount)
    : null;

  function handleWithdrawSubmission() {
    setWithdrawMessage(null);
    startWithdrawTransition(async () => {
      const result = await withdrawDraftAction(viewModel.labId);
      setWithdrawMessage(result.ok ? "提出を取り消しました。入力を編集して再提出できます。" : `取り消しできませんでした: ${result.message ?? ""}`);
      router.refresh();
    });
  }

  function handleSaveDraft() {
    if (!draft) return;
    setSaveMessage(null);
    startSaveTransition(async () => {
      const result = await saveDraftAction(viewModel.labId, draft);
      setSaveMessage(result.ok ? "下書きを保存しました。" : `保存できませんでした: ${result.message ?? ""}`);
      router.refresh();
    });
  }

  function handleSubmitDraft() {
    if (!draft) return;
    setSubmitMessage(null);
    startSubmitTransition(async () => {
      const saveResult = await saveDraftAction(viewModel.labId, draft);
      if (!saveResult.ok) {
        setSubmitMessage(`提出前の保存に失敗しました: ${saveResult.message ?? ""}`);
        router.refresh();
        return;
      }
      const result = await submitDraftAction(viewModel.labId);
      setSubmitMessage(result.ok ? "提出しました。四半期処理を実行できます。" : `提出できませんでした: ${result.message ?? ""}`);
      router.refresh();
    });
  }

  function handleProcessQuarter() {
    setProcessMessage(null);
    startProcessTransition(async () => {
      const result = await processQuarterAction(viewModel.labId);
      setConfirmingProcess(false);
      if (result.ok) {
        setProcessMessage(
          result.quarterStatus === "alreadyProcessed"
            ? "この四半期はすでに処理済みでした（再送信を検知したため、重複しては処理していません）。"
            : "四半期処理が完了しました。次のturnへ進めます。"
        );
      } else {
        setProcessMessage(`四半期処理に失敗しました: ${result.message ?? ""}`);
      }
      router.refresh();
    });
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 pb-16">
      <PlayLabBanner />
      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-5 space-y-5">
        <div className="bg-gray-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-base font-semibold">{viewModel.labId}</div>
            <div className="text-xs text-gray-400 mt-0.5">
              プレイヤー会社: {viewModel.playerCompanyId}（{viewModel.playerDisplayName}） / turn {viewModel.currentTurn} / {viewModel.totalTurns} /
              revision {viewModel.revision}
            </div>
          </div>
          <div className="text-xs">
            {isCompleted && <span className="bg-gray-600 text-gray-100 rounded-full px-3 py-1">完了</span>}
            {isSubmitted && <span className="bg-amber-700 text-amber-100 rounded-full px-3 py-1">提出済み・処理待ち</span>}
            {isEditing && <span className="bg-teal-700 text-teal-100 rounded-full px-3 py-1">入力中</span>}
          </div>
        </div>

        {isCompleted && (
          <div className="bg-gray-800 rounded-2xl p-8 text-center space-y-2">
            <div className="text-lg font-semibold">このラボは完了しました</div>
            <p className="text-sm text-gray-400">全{viewModel.totalTurns}四半期の処理が完了しています。これ以上の操作はできません。</p>
          </div>
        )}

        {!isCompleted && draft && (
          <div className="bg-gray-800 rounded-2xl p-4 sm:p-5">
            <h2 className="text-base font-semibold mb-3">意思決定編集（turn {viewModel.currentTurn}）</h2>
            <DecisionEditor
              fixture={viewModel.fixture}
              ownState={viewModel.ownState}
              draft={draft}
              onChange={setDraft}
              disabled={!isEditing || busy}
              period={viewModel.period}
              lastQuarterCapexEvents={viewModel.lastQuarterCapexEvents}
              lastQuarterRejectedCapexProposals={viewModel.lastQuarterRejectedCapexProposals}
              lastQuarterFinancialResult={viewModel.lastQuarterResult?.financialResult ?? null}
            />

            {isEditing && (
              <div className="mt-4 space-y-2">
                {salesForceAllocation?.isOverAllocated && (
                  <div className="bg-rose-950/50 border border-rose-700/60 text-rose-200 rounded-lg px-3 py-2 text-xs">
                    営業人員の配分合計が実在人数を{salesForceAllocation.overBy}人超えています（配分済み {salesForceAllocation.assignedTotal}
                    人 / 配分可能 {salesForceAllocation.availableTotal}人）。現在の人員数に収まるように再編集してください。この状態では提出できません。
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={handleSaveDraft}
                    disabled={busy}
                    className="bg-gray-600 hover:bg-gray-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2 text-sm"
                  >
                    {savePending ? "保存中…" : "下書きを保存"}
                  </button>
                  <button
                    onClick={handleSubmitDraft}
                    disabled={busy || Boolean(salesForceAllocation?.isOverAllocated)}
                    title={salesForceAllocation?.isOverAllocated ? "営業人員の配分合計が実在人数を超えているため提出できません。" : undefined}
                    className="bg-teal-600 hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2 text-sm"
                  >
                    {submitPending ? "提出中…" : "この内容で提出する"}
                  </button>
                  {saveMessage && <span className="text-xs text-gray-300">{saveMessage}</span>}
                  {submitMessage && <span className="text-xs text-gray-300">{submitMessage}</span>}
                </div>
              </div>
            )}
          </div>
        )}

        {isSubmitted && (
          <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-3">
            <h2 className="text-base font-semibold">四半期処理</h2>
            <p className="text-sm text-gray-400">
              turn {viewModel.currentTurn} の意思決定を提出済みです。処理を実行すると、この四半期の結果が確定し、次のturnへ進みます。
            </p>
            {!confirmingProcess ? (
              <button
                onClick={() => setConfirmingProcess(true)}
                disabled={busy}
                className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-semibold rounded-lg px-4 py-2 text-sm"
              >
                四半期を処理する
              </button>
            ) : (
              <div className="bg-amber-950/40 border border-amber-700/50 rounded-lg p-3 space-y-2">
                <p className="text-sm text-amber-100">本当にturn {viewModel.currentTurn}の四半期処理を実行しますか？この操作は取り消せません。</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleProcessQuarter}
                    disabled={busy}
                    className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-semibold rounded-lg px-4 py-2 text-sm"
                  >
                    {processPending ? "処理中…" : "はい、処理する"}
                  </button>
                  <button
                    onClick={() => setConfirmingProcess(false)}
                    disabled={busy}
                    className="bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white font-semibold rounded-lg px-4 py-2 text-sm"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}
            {processMessage && <div className="text-xs text-gray-300">{processMessage}</div>}

            {/* 【Phase 8G】提出取り消し。四半期処理が失敗した場合（例：営業人員の配分合計が
                実在人数を超えているエラー）でも、ここから入力へ戻って再提出できる。
                処理失敗直後に限らず、提出済みの間は常に使えるようにしてある
                （提出内容を見直したくなった場合にも同じ経路で戻れるようにするため）。 */}
            <div className="border-t border-gray-700/60 pt-3">
              <p className="text-xs text-gray-500 mb-2">
                入力内容を見直したい場合や、処理が失敗した場合は、提出を取り消して編集に戻ることができます（提出内容はそのまま残ります）。
              </p>
              <button
                onClick={handleWithdrawSubmission}
                disabled={busy}
                className="bg-gray-600 hover:bg-gray-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2 text-sm"
              >
                {withdrawPending ? "取り消し中…" : "編集に戻す（提出を取り消す）"}
              </button>
              {withdrawMessage && <div className="text-xs text-gray-300 mt-1">{withdrawMessage}</div>}
            </div>
          </div>
        )}

        {viewModel.lastQuarterResult && (
          <div className="space-y-5">
            <h2 className="text-base font-semibold">直近の四半期結果（turn {viewModel.lastQuarterResult.turn}）</h2>
            <CollapsibleSection title="市場情報" tone="info" testId="market-section">
              <MarketPanel
                marketResult={viewModel.lastQuarterResult.marketResult}
                globalReasonCodes={viewModel.lastQuarterResult.globalReasonCodes}
                previousMarketResult={viewModel.previousQuarterMarket?.marketResult ?? null}
                previousPeriodLabel={viewModel.previousQuarterMarket?.period ?? null}
                consumerMarketRecords={viewModel.lastQuarterResult.consumerMarketRecords}
              />
            </CollapsibleSection>
            {viewModel.lastQuarterResult.playerSummary && (
              <CollapsibleSection title="自社の四半期結果" tone="info" testId="player-results-section">
                <ResultsPanel summary={viewModel.lastQuarterResult.playerSummary} displayName={viewModel.playerDisplayName} />
              </CollapsibleSection>
            )}
            <CollapsibleSection title="財務結果" tone="info" testId="financial-results-section">
            <FinancialResultsSection
              displayName={viewModel.playerDisplayName}
              companyId={viewModel.playerCompanyId}
              currentTurn={viewModel.lastQuarterResult.turn}
              currentPeriod={viewModel.lastQuarterResult.period}
              financialResult={viewModel.lastQuarterResult.financialResult}
              financingResult={viewModel.lastQuarterResult.financingResult}
              capexResult={viewModel.lastQuarterResult.capexResult}
              ownFinancingState={viewModel.ownState.financingState}
              previousTurn={viewModel.previousQuarterFinancials?.turn ?? null}
              previousPeriod={viewModel.previousQuarterFinancials?.period ?? null}
              previousFinancialResult={viewModel.previousQuarterFinancials?.financialResult ?? null}
              previousFinancingResult={viewModel.previousQuarterFinancials?.financingResult ?? null}
              previousCapexResult={viewModel.previousQuarterFinancials?.capexResult ?? null}
            />
            </CollapsibleSection>
          </div>
        )}

        {viewModel.recentHistory.length > 0 && (
          <CollapsibleSection
            title={`履歴（直近${viewModel.recentHistory.length}件）`}
            tone="info"
            defaultOpen={false}
            testId="history-section"
          >
            <ul className="text-xs text-gray-400 space-y-1">
              {viewModel.recentHistory.map((h) => (
                <li key={h.turnId}>
                  turn {h.turn}（{h.period}） — {new Date(h.processedAt).toLocaleString("ja-JP")}
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        )}

        <div className="text-[11px] text-gray-500">
          <Link href="/v2/company-lab/play" className="underline text-teal-400">
            ラボ一覧へ戻る
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function PlayerScreenClient({ viewModel }: PlayerScreenClientProps) {
  // 【指示§11】サーバー側の状態が実際に変わった時だけ、編集中ローカルstateを
  // 新しいviewModelの値でリセットする（keyでstateをリセットするReactの定石）。
  const resetKey = `${viewModel.labId}:${viewModel.currentTurn}:${viewModel.revision}:${viewModel.phase}:${viewModel.draftUpdatedAt ?? ""}`;
  return <PlayerScreenClientInner key={resetKey} viewModel={viewModel} />;
}
