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

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import DecisionEditor from "../../components/DecisionEditor";
import OpeningCompanyStatePanel from "../../components/OpeningCompanyStatePanel";
import AiMarketInfoPanel from "../../components/AiMarketInfoPanel";
import CollapsibleSection from "../../components/CollapsibleSection";
import { DepreciableAssetsPanel, OpeningBalanceSheetPanel, OpeningMarketInfoPanel } from "../../components/OpeningInfoPanels";
import MarketPanel from "../../components/MarketPanel";
import ResultsPanel from "../../components/ResultsPanel";
import FinancialResultsSection from "../../components/financial/FinancialResultsSection";
import PlayLabBanner from "../components/PlayLabBanner";
import { CompanyDecisionDraft, summarizeSalesForceAllocation, summarizeSalesForceHiring } from "../../decisionDraft";
import { PlayerScreenViewModel } from "../_lib/viewModel";
import { StandardAiManagementReport } from "../../../../lib/v2/companyLab/aiExplanation/reportSchema";
import { fetchAiExplanationAction, processQuarterAction, saveDraftAction, submitDraftAction, withdrawDraftAction } from "./actions";

/** fetchAiExplanationActionの読み込み状態（このコンポーネントのローカル表示状態専用。サーバー側の正とは無関係）。 */
type AiExplanationLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "success"; readonly report: StandardAiManagementReport }
  | { readonly kind: "failure" };

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

  // 【Standard AI経営説明レポート（MVP）】isEditing && aiProposalDiagnosticsがある場合のみ、
  // マウント時にServer Action（fetchAiExplanationAction）でClaudeが生成した経営説明を取得する。
  // このServer Actionはブラウザから見えない秘密（ANTHROPIC_API_KEY・STAGING_ADMIN_TOKEN）を
  // 一切外部へ渡さず、既存のhandlePostAiExplanation（キャッシュ済みならClaudeを呼び直さない）
  // をサーバー側でそのまま呼ぶだけ。失敗しても意思決定画面自体は必ず正常に表示され続ける
  // （failure状態でも詳細な判断ログ・DecisionEditor・提出ボタン等は通常どおり描画する）。
  //
  // 【クライアント側の安全策（2026-08-01・本番Preview手動観察テストで発見された
  // 無限ローディングの事後対応）】サーバー側（claudeClient.ts・reportCache.ts・
  // actions.ts）にタイムアウト・try/catchを追加済みだが、Server Actionの呼び出し
  // 自体が何らかの理由でPromiseとして解決も棄却もされない可能性を完全には排除
  // できないため、ここでもPromise.raceによるクライアント側タイムアウトを設け、
  // 「経営説明を生成しています…」の無限ループを二重に防ぐ（実装指示§「API失敗が
  // 意思決定画面を絶対にブロックしない」の趣旨を、ローディング表示自体にも適用する）。
  //
  // 【2026-08-02・三宅さんの実機確認で発見（経緯）】この値が20秒だったため、
  // サーバー側のexplicitなtimeout（claudeClient.tsのEXPLANATION_CLAUDE_TIMEOUT_MS
  // ＝25秒）や、schema_mismatch時の1回リトライ（実測で最大約36秒かかったケースを
  // Vercelランタイムログで確認）よりも先にこのクライアント側タイムアウトが発火し、
  // サーバー側では最終的に成功していたにもかかわらず、画面には「失敗しました」と
  // 表示されてしまう事例が実機で発生した。三宅さんの明示指示により、今回は
  // 「時間がかかること自体は問題にしない。ただし止まっているのか動いているのかが
  // 分かるよう、経過秒数を表示してほしい」という方針へ変更する。そのため
  // この安全策タイムアウト自体は、サーバー側の理論上の最大値（1回目25秒＋
  // schema_mismatch時のリトライでもう1回25秒＝最大50秒程度）に十分な余裕を
  // 持たせた60秒へ引き上げ、「動いている」ことを伝える経過秒数表示（下記
  // aiExplanationElapsedSeconds）と併用する。60秒を超えてもなお応答が無い場合のみ、
  // 本当にハングしているとみなしfailure扱いにする（この安全策自体の目的は維持する）。
  const AI_EXPLANATION_CLIENT_TIMEOUT_MS = 60_000;
  const [aiExplanationState, setAiExplanationState] = useState<AiExplanationLoadState>({ kind: "loading" });
  // 【2026-08-02・経過秒数表示】「生成に時間がかかっても構わないが、止まっているのか
  // 動いているのかが分からないと不安」という三宅さんのご要望に対応し、loading中は
  // 1秒ごとに経過秒数だけをカウントアップ表示する（正確な残り時間の予測はできない
  // ため、目安へのカウントダウンではなく単純な経過時間のカウントアップとする）。
  const [aiExplanationElapsedSeconds, setAiExplanationElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!isEditing || !viewModel.aiProposalDiagnostics) return;
    // 【初期状態について】aiExplanationStateの初期値は既にuseState({kind:"loading"})。
    // このコンポーネント自体がturn・revision・phase等が変わるたびに新しいkeyでremountされる
    // 設計（PlayerScreenClient本体のresetKey参照）のため、このeffect内で改めて
    // setState(loading)を呼ぶ必要はない（呼ぶと「effect内での同期的setState」という
    // 不要なレンダーカスケードをlintが指摘するため、意図的に呼ばない）。
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const tickStartedAt = Date.now();
    const tickIntervalId: ReturnType<typeof setInterval> = setInterval(() => {
      if (cancelled) return;
      setAiExplanationElapsedSeconds(Math.floor((Date.now() - tickStartedAt) / 1000));
    }, 1000);

    const timeoutPromise = new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timeoutId = setTimeout(() => resolve({ kind: "timeout" }), AI_EXPLANATION_CLIENT_TIMEOUT_MS);
    });
    const actionPromise = fetchAiExplanationAction(viewModel.labId, viewModel.playerCompanyId, viewModel.currentTurn).then((result) => ({
      kind: "resolved" as const,
      result,
    }));

    Promise.race([actionPromise, timeoutPromise])
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.kind === "timeout") {
          // サーバー側からの応答が一定時間内（60秒）に届かなかった（何らかの理由で
          // 本当にハングしている）。意思決定画面自体は既に正常に表示され続けているため、
          // この説明文ブロックだけをfailure扱いにする。
          setAiExplanationState({ kind: "failure" });
          return;
        }
        const { result } = outcome;
        setAiExplanationState(result.ok && result.report ? { kind: "success", report: result.report } : { kind: "failure" });
      })
      .catch(() => {
        if (cancelled) return;
        setAiExplanationState({ kind: "failure" });
      });

    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      clearInterval(tickIntervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, viewModel.labId, viewModel.playerCompanyId, viewModel.currentTurn, Boolean(viewModel.aiProposalDiagnostics)]);

  // 【Phase 8G】営業人員の配分合計チェック。draft.salesPlansが存在する（=完了済みでない）
  // ときだけ意味を持つ。validateSalesForceHeadcountBudget（エンジン側）と同じ
  // 「全社合計」判定をここで先読みし、提出前に警告・提出ボタンの無効化に使う
  // （入力欄自体は無効化しない — 上限超過中も編集は必ず可能）。
  // 【営業人員の追加採用・forward-port】配分可能人数は静的なfixtureの基準値
  // ではなく、前期末までに確定した会社状態（ownState.salesForceHiringState.
  // headcount）を使う（DecisionEditor.tsxと同じ理由。増員後は翌四半期以降
  // こちらが増える）。
  const salesForceAllocation = draft
    ? summarizeSalesForceAllocation(draft.salesPlans, viewModel.ownState.salesForceHiringState.headcount)
    : null;

  // 【営業人員の増員・減員の同時入力禁止・forward-port続き】draft.salesForceHireCount・
  // salesForceLayoffCountが両方>0の場合、runner.ts側で必ずエラーになるため、
  // クライアント側でも提出ボタンを無効化する（クライアント側のdisabledだけに
  // 頼らない方針＝上のsalesForceAllocationと同じ二重防御。指示§10）。
  const salesForceHiring = draft
    ? summarizeSalesForceHiring(viewModel.ownState.salesForceHiringState.headcount, draft.salesForceHireCount ?? 0, draft.salesForceLayoffCount ?? 0)
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

        {/* 【Test15】期初情報。情報量が多いため3パネルとも既定で閉じ、意思決定フォームを
            画面下へ押し下げないようにする（プレイヤーからの「できるだけ折りたたんでほしい」
            という要望に合わせ、既存の期初セクションも既定で閉じる方針へ揃えた）。 */}
        {!isCompleted && (
          <>
            <OpeningBalanceSheetPanel bs={viewModel.openingInfo.balanceSheet} turn={viewModel.openingInfo.turn} />
            <DepreciableAssetsPanel assets={viewModel.openingInfo.depreciableAssets} />
            <OpeningMarketInfoPanel info={viewModel.openingInfo.marketInfo} />
          </>
        )}

        {!isCompleted && (
          <CollapsibleSection
            title={`自社の状態（turn ${viewModel.currentTurn} 開始時点）`}
            tone="info"
            defaultOpen={false}
            testId="opening-company-state-section"
          >
            <OpeningCompanyStatePanel ownState={viewModel.ownState} fixture={viewModel.fixture} turn={viewModel.currentTurn} />
          </CollapsibleSection>
        )}

        {!isCompleted && (
          <CollapsibleSection
            title="AIが見ている市場情報（Standard AIの判断入力そのまま）"
            tone="info"
            defaultOpen={false}
            testId="ai-market-info-section"
          >
            <AiMarketInfoPanel
              publicInfo={viewModel.publicInfo}
              previousMarketResult={viewModel.previousQuarterMarket?.marketResult ?? null}
              previousPeriodLabel={viewModel.previousQuarterMarket?.period ?? null}
            />
          </CollapsibleSection>
        )}

        {isCompleted && (
          <div className="bg-gray-800 rounded-2xl p-8 text-center space-y-2">
            <div className="text-lg font-semibold">このラボは完了しました</div>
            <p className="text-sm text-gray-400">全{viewModel.totalTurns}四半期の処理が完了しています。これ以上の操作はできません。</p>
          </div>
        )}

        {isEditing && viewModel.aiProposalDiagnostics && (
          <CollapsibleSection
            title={`Standard AIの提案（turn ${viewModel.currentTurn}・実行前プレビュー）`}
            tone="info"
            defaultOpen={false}
            testId="ai-proposal-diagnostics-section"
          >
            <p className="text-xs text-gray-400 mb-2">
              下の「意思決定編集」欄には、Standard
              AIが同じ入力（自社状態・公開市場情報）から算出した提案が初期値として入っています。このまま「この内容で提出する」を押せばAI提案どおりに実行され、内容を編集してから提出することもできます。（提出後・下書き保存後は表示されません）
            </p>

            {/* 【視覚的な区別（実装指示§10）】(a) ゲームエンジンが確定した事実＝上のOpeningCompanyStatePanel/
                AiMarketInfoPanel等（tone="info"、灰色）、(b) Standard AI自身の評価＝下の詳細な判断ログ
                （既存のseverity色分けをそのまま維持）、(c) Claude生成の説明文＝以下のindigo系の
                背景・バッジをつけたブロック、の3つをプレイヤーが混同しないようにする。 */}
            <div className="rounded-lg border border-indigo-700/50 bg-indigo-950/30 p-3 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] rounded px-1.5 py-0.5 bg-indigo-900/70 text-indigo-200 border border-indigo-700/70">
                  AIによる説明文（Claude生成）
                </span>
              </div>
              <p className="text-[11px] text-indigo-200/80">
                以下はStandard
                AIの提案をClaude
                APIが日本語で解説したものです。提案の数値自体はStandard
                AIが算出したもので、Claudeはそれを変更していません。
              </p>

              {aiExplanationState.kind === "loading" && (
                <p className="text-xs text-indigo-200/70">経営説明を生成しています…（経過 {aiExplanationElapsedSeconds}秒）</p>
              )}

              {aiExplanationState.kind === "failure" && (
                <p className="text-xs text-amber-300">経営説明の生成に失敗しました（詳細な判断ログは下記でご確認いただけます）。</p>
              )}

              {aiExplanationState.kind === "success" && (
                <div className="space-y-4">
                  {/* ① 今期の基本方針 */}
                  <div>
                    <h4 className="text-xs font-semibold text-indigo-100 mb-1">① 今期の基本方針</h4>
                    <p className="text-sm text-gray-100">{aiExplanationState.report.headline}</p>
                  </div>

                  {/* ② 経営サマリー */}
                  <div>
                    <h4 className="text-xs font-semibold text-indigo-100 mb-1">② 経営サマリー</h4>
                    <p className="text-xs text-gray-200 whitespace-pre-wrap">{aiExplanationState.report.executiveSummary}</p>
                  </div>

                  {/* ③④ 分野別の重要提案・主要な数値根拠 */}
                  <div>
                    <h4 className="text-xs font-semibold text-indigo-100 mb-1">③ 分野別の重要提案</h4>
                    {aiExplanationState.report.recommendations.length === 0 ? (
                      <p className="text-xs text-gray-500">今期は特筆すべき重要提案はありません。</p>
                    ) : (
                      <ul className="space-y-2">
                        {aiExplanationState.report.recommendations.map((rec, idx) => (
                          <li key={`${rec.area}-${idx}`} className="rounded border border-gray-700/60 bg-gray-900/40 p-2">
                            <div className="text-[10px] text-gray-500">{rec.area}</div>
                            <div className="text-xs font-semibold text-gray-100">{rec.title}</div>
                            <div className="text-xs text-gray-300 mt-0.5">{rec.action}</div>
                            {rec.reasons.length > 0 && (
                              <ul className="mt-1.5 space-y-0.5">
                                {rec.reasons.map((reason, reasonIdx) => (
                                  <li key={`${reason.label}-${reasonIdx}`} className="text-[11px] text-gray-400">
                                    <span className="text-gray-500">{reason.label}:</span> {reason.value}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* ⑤ 重要なリスク */}
                  <div>
                    <h4 className="text-xs font-semibold text-indigo-100 mb-1">⑤ 重要なリスク</h4>
                    {aiExplanationState.report.keyRisks.length === 0 ? (
                      <p className="text-xs text-gray-500">今期は特筆すべきリスクはありません。</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {aiExplanationState.report.keyRisks.map((risk, idx) => (
                          <li
                            key={`${risk.title}-${idx}`}
                            className={
                              "rounded border p-2 text-xs " +
                              (risk.severity === "high"
                                ? "border-rose-700/60 bg-rose-950/30 text-rose-200"
                                : risk.severity === "medium"
                                  ? "border-amber-700/60 bg-amber-950/30 text-amber-200"
                                  : "border-gray-700/60 bg-gray-900/40 text-gray-300")
                            }
                          >
                            <div className="font-semibold">{risk.title}</div>
                            <div className="mt-0.5 opacity-90">{risk.description}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* ⑥ プレイヤーが検討すべき論点 */}
                  <div>
                    <h4 className="text-xs font-semibold text-indigo-100 mb-1">⑥ プレイヤーが検討すべき論点</h4>
                    {aiExplanationState.report.questionsForPlayer.length === 0 ? (
                      <p className="text-xs text-gray-500">今期は特に論点はありません。</p>
                    ) : (
                      <ul className="list-disc list-inside text-xs text-gray-300 space-y-0.5">
                        {aiExplanationState.report.questionsForPlayer.map((question, idx) => (
                          <li key={idx}>{question}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* ⑦ データ上の制約・不明点 */}
                  <div>
                    <h4 className="text-xs font-semibold text-indigo-100 mb-1">⑦ データ上の制約・不明点</h4>
                    {aiExplanationState.report.dataLimitations.length === 0 ? (
                      <p className="text-xs text-gray-500">今期は特筆すべきデータ上の制約はありません。</p>
                    ) : (
                      <ul className="list-disc list-inside text-xs text-gray-400 space-y-0.5">
                        {aiExplanationState.report.dataLimitations.map((limitation, idx) => (
                          <li key={idx}>{limitation}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* ⑧ 詳細な判断ログ — 既存の内容をそのまま維持し、折りたたみへ移動しただけ（削除・改変なし）。 */}
            <CollapsibleSection
              title="⑧ 詳細な判断ログ（Standard AI自身の理由コード・閾値）"
              tone="info"
              defaultOpen={false}
              testId="ai-proposal-diagnostics-entries-section"
            >
              <p className="text-xs text-gray-400 mb-2">
                以下はAIがその提案に至った判断理由そのもの（理由コード・鍵となる入力値・閾値）です。上のClaude生成の説明文とは異なり、
                Standard AIエンジン自身が出力した値です。
              </p>
              {viewModel.aiProposalDiagnostics.entries.length === 0 ? (
                <p className="text-xs text-gray-500">この四半期は特筆すべき判断理由（警告・閾値超過等）がありません。</p>
              ) : (
                <ul className="text-xs text-gray-300 space-y-1.5">
                  {viewModel.aiProposalDiagnostics.entries.map((entry, idx) => (
                    <li key={`${entry.code}-${idx}`} className="border-b border-gray-700/40 pb-1.5 last:border-b-0">
                      <span
                        className={
                          entry.severity === "critical"
                            ? "text-rose-300"
                            : entry.severity === "warning"
                              ? "text-amber-300"
                              : "text-gray-400"
                        }
                      >
                        [{entry.domain}/{entry.code}]
                      </span>{" "}
                      {entry.message}
                      {entry.decisionSummary ? ` → ${entry.decisionSummary}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </CollapsibleSection>
          </CollapsibleSection>
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
                {salesForceHiring?.hasMutualExclusionConflict && (
                  <div className="bg-rose-950/50 border border-rose-700/60 text-rose-200 rounded-lg px-3 py-2 text-xs">
                    営業人員の採用（{salesForceHiring.plannedHireCount}人）と減員（{salesForceHiring.plannedLayoffCount}人）を同一四半期に
                    同時入力することはできません。「営業人員の追加採用・減員」欄でいずれか一方を0にしてください。この状態では提出できません。
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
                    disabled={busy || Boolean(salesForceAllocation?.isOverAllocated) || Boolean(salesForceHiring?.hasMutualExclusionConflict)}
                    title={
                      salesForceAllocation?.isOverAllocated
                        ? "営業人員の配分合計が実在人数を超えているため提出できません。"
                        : salesForceHiring?.hasMutualExclusionConflict
                          ? "営業人員の採用と減員を同時に入力しているため提出できません。"
                          : undefined
                    }
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
            <ExcelDownloadButtons
              labId={viewModel.labId}
              turn={viewModel.lastQuarterResult.turn}
              companyId={viewModel.playerCompanyId}
            />
            <CollapsibleSection title="市場情報" tone="info" defaultOpen={false} testId="market-section">
              <MarketPanel
                marketResult={viewModel.lastQuarterResult.marketResult}
                globalReasonCodes={viewModel.lastQuarterResult.globalReasonCodes}
                previousMarketResult={viewModel.previousQuarterMarket?.marketResult ?? null}
                previousPeriodLabel={viewModel.previousQuarterMarket?.period ?? null}
                consumerMarketRecords={viewModel.lastQuarterResult.consumerMarketRecords}
              />
            </CollapsibleSection>
            {viewModel.lastQuarterResult.playerSummary && (
              <CollapsibleSection title="自社の四半期結果" tone="info" defaultOpen={false} testId="player-results-section">
                <ResultsPanel summary={viewModel.lastQuarterResult.playerSummary} displayName={viewModel.playerDisplayName} />
              </CollapsibleSection>
            )}
            <CollapsibleSection title="財務結果" tone="info" defaultOpen={false} testId="financial-results-section">
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

/**
 * 【Test15】Excelダウンロードボタン（Company Lab / Test15画面限定）。
 *
 * 既存の管理者Export UI（/v2/company-lab/play/export/[labId]）と同じく、素の
 * <a href download> でサーバー側のダウンロードrouteを開くだけにする。JSでBlobを
 * 組み立てないため、iPad Safariでもタップだけで保存でき、認証（staging署名Cookie）も
 * ブラウザ標準のCookie送出にそのまま乗る。Excelの生成・トークンの読み取りは
 * すべてサーバー側（route.ts → companyLabAdminExportSource → Excel builder）で行われ、
 * このコンポーネントは秘密情報に一切触れない。
 */
function ExcelDownloadButtons({
  labId,
  turn,
  companyId,
}: {
  readonly labId: string;
  readonly turn: number;
  readonly companyId: string;
}) {
  const base = `/api/v2/admin/export-download/${encodeURIComponent(labId)}/${encodeURIComponent(String(turn))}`;
  return (
    <div className="bg-gray-800 rounded-2xl p-3 sm:p-4 space-y-2" data-testid="excel-download-buttons">
      <div className="flex flex-col sm:flex-row gap-2">
        <a
          href={`${base}?mode=excel-company&companyId=${encodeURIComponent(companyId)}`}
          download
          className="flex-1 bg-teal-700/80 hover:bg-teal-600 rounded-lg px-4 py-3 text-sm font-semibold text-white text-center"
        >
          📊 自社データブック
        </a>
        <a
          href={`${base}?mode=excel-industry`}
          download
          className="flex-1 bg-indigo-700/80 hover:bg-indigo-600 rounded-lg px-4 py-3 text-sm font-semibold text-white text-center"
        >
          🌐 業界比較ブック
        </a>
      </div>
      <p className="text-[11px] text-gray-400">
        Turn1〜現在Turnの履歴を含むExcelです。業界比較ブックには全5社の非公開の意思決定が含まれるため、プレイヤーへ配布しないでください。
      </p>
    </div>
  );
}

export default function PlayerScreenClient({ viewModel }: PlayerScreenClientProps) {
  // 【指示§11】サーバー側の状態が実際に変わった時だけ、編集中ローカルstateを
  // 新しいviewModelの値でリセットする（keyでstateをリセットするReactの定石）。
  const resetKey = `${viewModel.labId}:${viewModel.currentTurn}:${viewModel.revision}:${viewModel.phase}:${viewModel.draftUpdatedAt ?? ""}`;
  return <PlayerScreenClientInner key={resetKey} viewModel={viewModel} />;
}
