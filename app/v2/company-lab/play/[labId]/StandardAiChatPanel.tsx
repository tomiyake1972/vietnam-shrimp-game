// ShrimpX V2 — 「Standard AIに質問する」対話UI（Phase 1 MVP）
//
// 【視覚的な区別（実装指示§3）】上の「AIによる説明文（Claude生成）」ブロックはindigo系。
// このQ&Aブロックはemerald系＋別のバッジにして、
//   ・AIによる説明文（一方向のレポート）
//   ・Standard AIへの質問（対話）
// をプレイヤーが混同しないようにする。
//
// 【iPhone対応（実装指示§3・§24-10）】縦方向1カラム固定。入力欄はw-full、
// 送信ボタンはその下へ回り込む（横並びの固定幅を使わない）。回答本文は
// break-words / whitespace-pre-wrap で、長い数値・英単語でも横スクロールを
// 発生させない。テキストサイズは16px相当（text-base）をinputへ指定し、
// iOS Safariの自動ズームを避ける。
//
// 【この機能がしないこと】Standard AIの数値提案（DecisionEditorの初期値）へは一切
// 触らない。このコンポーネントはdraft・setDraftを受け取らず、propsとしても持たない
// （構造的に意思決定を書き換えられない）。

"use client";

import { useState } from "react";
import { StandardAiChatAnswer } from "../../../../lib/v2/companyLab/aiExplanation/chat/chatSchema";
import { askStandardAiChatAction } from "./actions";

/** 同一Turn内で保持する会話履歴の上限（サーバー側 CHAT_MAX_HISTORY_TURNS と同じ 5 往復）。 */
const MAX_HISTORY_TURNS = 5;

/** 質問文の最大長（サーバー側 CHAT_MAX_QUESTION_LENGTH と同じ）。 */
const MAX_QUESTION_LENGTH = 400;

/** クライアント側の安全策タイムアウト。サーバー側（40秒＋最大1回リトライ）の外側に置く。 */
const CHAT_CLIENT_TIMEOUT_MS = 60_000;

const CHAT_ERROR_LABELS: Readonly<Record<string, string>> = {
  network_error: "通信エラーまたはタイムアウト",
  http_error: "APIエラー",
  schema_mismatch: "応答形式の不一致",
  invalid_json: "応答形式の不一致",
  empty_response: "応答が空",
  missing_api_key: "APIキー未設定",
  unauthorized: "認証エラー",
  invalid_request: "入力内容が不正",
  context_changed: "ゲーム状態の変化",
  internal_error: "サーバー内部エラー",
};

function chatErrorLabel(category: string | undefined): string {
  if (!category) return "不明";
  return CHAT_ERROR_LABELS[category] ?? "その他";
}

interface ChatEntry {
  readonly question: string;
  readonly answer: StandardAiChatAnswer;
}

const EXAMPLE_QUESTIONS: readonly string[] = [
  "なぜこの市場に営業を多く配置しているの？",
  "なぜ営業を追加採用するの？",
  "なぜ工場を増設しないの？",
  "何が今期の最大のボトルネックなの？",
  "他にどんな選択肢があったの？",
];

export interface StandardAiChatPanelProps {
  readonly labId: string;
  readonly companyId: string;
  readonly turn: number;
}

export default function StandardAiChatPanel({ labId, companyId, turn }: StandardAiChatPanelProps) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [entries, setEntries] = useState<readonly ChatEntry[]>([]);
  const [pending, setPending] = useState(false);
  const [errorCategory, setErrorCategory] = useState<string | null>(null);
  // 【Context固定（実装指示§10）】最初の回答で受け取ったcontextHashを保持し、
  // 以降の質問では毎回サーバーへ送って一致を確認させる。
  const [contextHash, setContextHash] = useState<string | null>(null);

  async function submitQuestion(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    setErrorCategory(null);

    const history = entries.slice(-MAX_HISTORY_TURNS).map((e) => ({ question: e.question, answerConclusion: e.answer.conclusion }));

    const timeoutPromise = new Promise<{ readonly kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), CHAT_CLIENT_TIMEOUT_MS)
    );
    const actionPromise = askStandardAiChatAction(labId, companyId, turn, trimmed, history, contextHash).then((result) => ({
      kind: "resolved" as const,
      result,
    }));

    try {
      const outcome = await Promise.race([actionPromise, timeoutPromise]);
      if (outcome.kind === "timeout") {
        setErrorCategory("network_error");
        return;
      }
      const { result } = outcome;
      if (result.ok && result.answer) {
        setEntries((prev) => [...prev, { question: trimmed, answer: result.answer! }].slice(-MAX_HISTORY_TURNS));
        if (result.contextHash) setContextHash(result.contextHash);
        setQuestion("");
        return;
      }
      setErrorCategory(result.errorCategory ?? "unknown");
    } catch {
      setErrorCategory("internal_error");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-lg border border-emerald-700/50 bg-emerald-950/20 p-3 space-y-3" data-testid="standard-ai-chat-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] rounded px-1.5 py-0.5 bg-emerald-900/70 text-emerald-200 border border-emerald-700/70">
          Standard AIへの質問（対話）
        </span>
      </div>
      <p className="text-[11px] text-emerald-200/80">
        上の「AIによる説明文」とは別の機能です。ここでは、このturnのStandard
        AIの判断について質問できます。回答はStandard
        AI自身の判断ログ（理由コード・閾値・診断）に基づきます。数値提案は変更されません。
      </p>

      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full sm:w-auto rounded border border-emerald-600/70 bg-emerald-900/40 px-3 py-2 text-xs text-emerald-100 hover:bg-emerald-900/70"
          data-testid="standard-ai-chat-open"
        >
          Standard AIに質問する
        </button>
      )}

      {open && (
        <div className="space-y-3">
          {/* 会話履歴（縦積み。iPhone幅でも横スクロールしない） */}
          {entries.length > 0 && (
            <ul className="space-y-2" data-testid="standard-ai-chat-entries">
              {entries.map((entry, idx) => (
                <li key={idx} className="space-y-1.5">
                  <div className="rounded border border-gray-700/60 bg-gray-900/50 p-2">
                    <div className="text-[10px] text-gray-500">あなたの質問</div>
                    <p className="text-xs text-gray-100 break-words whitespace-pre-wrap">{entry.question}</p>
                  </div>
                  <div className="rounded border border-emerald-800/60 bg-emerald-950/40 p-2 space-y-1.5">
                    <div className="text-[10px] text-emerald-400">Standard AI判断の説明</div>
                    <div>
                      <div className="text-[10px] text-emerald-300/70">結論</div>
                      <p className="text-xs text-gray-100 break-words whitespace-pre-wrap">{entry.answer.conclusion}</p>
                    </div>
                    {entry.answer.evidence.length > 0 && (
                      <div>
                        <div className="text-[10px] text-emerald-300/70">根拠</div>
                        <ul className="space-y-0.5">
                          {entry.answer.evidence.map((ev, evIdx) => (
                            <li key={evIdx} className="text-[11px] text-gray-300 break-words">
                              <span className="text-gray-500">{ev.label}:</span> {ev.value}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {entry.answer.supplement && (
                      <div>
                        <div className="text-[10px] text-emerald-300/70">補足</div>
                        <p className="text-[11px] text-gray-300 break-words whitespace-pre-wrap">{entry.answer.supplement}</p>
                      </div>
                    )}
                    {entry.answer.limitations.length > 0 && (
                      <div>
                        <div className="text-[10px] text-amber-300/80">根拠の限界</div>
                        <ul className="list-disc list-inside text-[11px] text-amber-200/80 space-y-0.5">
                          {entry.answer.limitations.map((lim, limIdx) => (
                            <li key={limIdx} className="break-words">
                              {lim}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {entry.answer.relatedReasonCodes.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5" data-testid="standard-ai-chat-reason-codes">
                        {entry.answer.relatedReasonCodes.map((code) => (
                          <span key={code} className="text-[10px] rounded px-1 py-0.5 bg-gray-800/80 text-gray-400 border border-gray-700/70 break-all">
                            {code}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {pending && (
            <p className="text-xs text-emerald-200/70" data-testid="standard-ai-chat-loading">
              回答を生成しています…
            </p>
          )}

          {errorCategory !== null && (
            <div className="space-y-1" data-testid="standard-ai-chat-failure">
              <p className="text-xs text-amber-300">回答生成に失敗しました。</p>
              <p className="text-[11px] text-amber-300/80" data-testid="standard-ai-chat-error-category">
                原因: {chatErrorLabel(errorCategory)}
              </p>
              <p className="text-[11px] text-gray-400">
                Standard AIの数値提案は影響を受けていません。もう一度質問し直すか、画面を再読み込みしてください。
              </p>
            </div>
          )}

          {/* 質問入力（縦型。iPhone幅でも横スクロールしない） */}
          <div className="space-y-2">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value.slice(0, MAX_QUESTION_LENGTH))}
              rows={3}
              maxLength={MAX_QUESTION_LENGTH}
              placeholder="例: なぜ営業を追加採用するの？"
              disabled={pending}
              className="w-full rounded border border-gray-600 bg-gray-900 px-2 py-2 text-base text-gray-100 placeholder:text-gray-600 disabled:opacity-60"
              data-testid="standard-ai-chat-input"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] text-gray-500">
                {question.length} / {MAX_QUESTION_LENGTH}文字（このturnの判断についてのみ回答します）
              </span>
              <button
                type="button"
                onClick={() => void submitQuestion(question)}
                disabled={pending || question.trim().length === 0}
                className="w-full sm:w-auto rounded border border-emerald-600/70 bg-emerald-900/50 px-3 py-2 text-xs text-emerald-100 hover:bg-emerald-900/80 disabled:opacity-50"
                data-testid="standard-ai-chat-submit"
              >
                質問する
              </button>
            </div>
          </div>

          {/* 質問例（タップで入力欄へ入る。iPhoneでの入力負担を減らす） */}
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLE_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuestion(q)}
                disabled={pending}
                className="text-[10px] rounded px-1.5 py-1 bg-gray-800/70 text-gray-300 border border-gray-700/70 hover:bg-gray-700/70 disabled:opacity-50 break-words text-left"
              >
                {q}
              </button>
            ))}
          </div>

          <p className="text-[10px] text-gray-500">
            この機能はStandard
            AIの当該turn判断の説明のみに回答します。「営業を5人にしたら？」のような仮定の再計算、将来需要の予測、他社の非公開情報には回答できません。
          </p>
        </div>
      )}
    </div>
  );
}
