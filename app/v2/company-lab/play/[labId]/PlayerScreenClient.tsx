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
import MarketPanel from "../../components/MarketPanel";
import ResultsPanel from "../../components/ResultsPanel";
import LabBanner from "../../components/LabBanner";
import { CompanyDecisionDraft } from "../../decisionDraft";
import { PlayerScreenViewModel } from "../_lib/viewModel";
import { processQuarterAction, saveDraftAction, submitDraftAction } from "./actions";

interface PlayerScreenClientProps {
  readonly viewModel: PlayerScreenViewModel;
}

function PlayerScreenClientInner({ viewModel }: PlayerScreenClientProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<CompanyDecisionDraft | null>(viewModel.draft);
  const [savePending, startSaveTransition] = useTransition();
  const [submitPending, startSubmitTransition] = useTransition();
  const [processPending, startProcessTransition] = useTransition();
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [processMessage, setProcessMessage] = useState<string | null>(null);
  const [confirmingProcess, setConfirmingProcess] = useState(false);

  const isEditing = viewModel.phase === "editing";
  const isSubmitted = viewModel.phase === "submitted";
  const isCompleted = viewModel.phase === "completed";
  const busy = savePending || submitPending || processPending;

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
      <LabBanner />
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
            />

            {isEditing && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  onClick={handleSaveDraft}
                  disabled={busy}
                  className="bg-gray-600 hover:bg-gray-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2 text-sm"
                >
                  {savePending ? "保存中…" : "下書きを保存"}
                </button>
                <button
                  onClick={handleSubmitDraft}
                  disabled={busy}
                  className="bg-teal-600 hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2 text-sm"
                >
                  {submitPending ? "提出中…" : "この内容で提出する"}
                </button>
                {saveMessage && <span className="text-xs text-gray-300">{saveMessage}</span>}
                {submitMessage && <span className="text-xs text-gray-300">{submitMessage}</span>}
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
          </div>
        )}

        {viewModel.lastQuarterResult && (
          <div className="space-y-5">
            <h2 className="text-base font-semibold">直近の四半期結果（turn {viewModel.lastQuarterResult.turn}）</h2>
            <MarketPanel marketResult={viewModel.lastQuarterResult.marketResult} globalReasonCodes={viewModel.lastQuarterResult.globalReasonCodes} />
            {viewModel.lastQuarterResult.playerSummary && (
              <ResultsPanel summary={viewModel.lastQuarterResult.playerSummary} displayName={viewModel.playerDisplayName} />
            )}
          </div>
        )}

        {viewModel.recentHistory.length > 0 && (
          <div className="bg-gray-800 rounded-2xl p-4 sm:p-5">
            <h2 className="text-base font-semibold mb-3">履歴（直近{viewModel.recentHistory.length}件）</h2>
            <ul className="text-xs text-gray-400 space-y-1">
              {viewModel.recentHistory.map((h) => (
                <li key={h.turnId}>
                  turn {h.turn}（{h.period}） — {new Date(h.processedAt).toLocaleString("ja-JP")}
                </li>
              ))}
            </ul>
          </div>
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
