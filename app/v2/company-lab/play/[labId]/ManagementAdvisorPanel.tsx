// ShrimpX V2 — 相談役AI（Management Advisor AI）MVP  UI
//
// 【既存2機能との視覚的な分離（実装指示§49）】
//   AIによる説明文（indigo・提案カード内）  … 一方向のレポート
//   Standard AIに質問する（emerald・提案カード内） … Standard AIはなぜそうしたか
//   相談役AI（このファイル・sky系・画面右下固定） … あなたならどう考える？ ゲーム設計はなぜ？
// 相談役AIだけは提案カードの中ではなく画面に固定され、どの画面を見ていても使える。
//
// 【PC / tablet（§4）】画面右下の固定ボタン →右側からパネルを展開。
//   幅は clamp(320px, 32vw, 420px)。完全固定pxに依存しない。
//   パネルは画面右端に寄せ、ゲーム画面は左側にそのまま見える（完全には隠さない）。
//   ゲーム画面をスクロールしてもパネルは固定（position: fixed）。
//
// 【Mobile / iPhone（§5）】右sidebarを縮めず、画面下から開くbottom sheet。
//   高さ 80vh（拡大時 95vh）。上部に背景のゲーム画面が見える。
//   入力欄は下部固定、safe-area対応、text-base（iOS自動ズーム回避）。
//   キーボード表示時に入力欄が隠れないよう、パネル高さの基準に dvh を使う
//   （dvhはキーボード表示で縮むため、100vh固定のように画面外へ押し出されない）。

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AdvisorAnswer, AdvisorSectionType } from "../../../../lib/v2/companyLab/advisorAi/advisorSchema";
import { askAdvisorAction, clearAdvisorConversationAction, loadAdvisorConversationAction } from "./actions";

const MAX_QUESTION_LENGTH = 1_000;

/**
 * クライアント側の安全策タイムアウト（品質強化Batch 1・§1）。
 * サーバー側は 1試行120秒／全体予算150秒で必ず打ち切る。それより十分長く、
 * かつ Vercel Function の maxDuration(240秒) より短い値にする。
 * 値の根拠は advisorClient.ts の ADVISOR_CLIENT_TIMEOUT_MS のコメントを参照。
 */
const ADVISOR_CLIENT_TIMEOUT_MS = 180_000;

/**
 * 【正直な進捗表示（§19）】相談役AIは最大で2分以上かかることがある。
 * 「考えています…」だけだと固まったように見えるため、経過秒数を出す。
 *
 * 【fake progressの禁止】サーバーの内部工程（財務の分析中・市場の分析中など）を、
 * 実際には取得していないのに進行中であるかのように表示しない。
 * クライアントが本当に知っているのは「送信した」「何秒経った」だけである。
 * したがって表示するのもそれだけにする（この規約は回帰テストで機械的に検査している）。
 */
function elapsedHintText(elapsedSeconds: number): string {
  if (elapsedSeconds < 20) return "相談役AIへ質問を送信しました。";
  if (elapsedSeconds < 60) return "回答を生成しています。長めの質問では1〜2分かかることがあります。";
  return "まだ生成中です。応答が無い場合は最大3分で自動的に打ち切ります。";
}

/** 1回の送信を識別するID。二重送信の判定にサーバー側で使う。 */
function newRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const ADVISOR_ERROR_LABELS: Readonly<Record<string, string>> = {
  network_error: "通信エラーまたはタイムアウト",
  http_error: "APIエラー",
  schema_mismatch: "応答形式の不一致",
  invalid_json: "応答形式の不一致",
  empty_response: "応答が空",
  missing_api_key: "APIキー未設定",
  unauthorized: "認証エラー",
  invalid_request: "入力内容が不正",
  internal_error: "サーバー内部エラー",
};

function advisorErrorLabel(category: string | undefined): string {
  if (!category) return "不明";
  return ADVISOR_ERROR_LABELS[category] ?? "その他";
}

/** sectionのtypeを利用者向けの短いラベルへ。事実とAI推論の区別を画面上でも見せる。 */
const SECTION_LABELS: Readonly<Record<AdvisorSectionType, string>> = {
  FACT: "事実",
  STANDARD_AI_VIEW: "Standard AIの見解",
  ADVISOR_INFERENCE: "相談役の見解",
  DEVELOPMENT_RATIONALE: "開発記録",
  UNCERTAINTY: "不確実",
};

const SECTION_TONES: Readonly<Record<AdvisorSectionType, string>> = {
  FACT: "bg-gray-800/80 text-gray-300 border-gray-700",
  STANDARD_AI_VIEW: "bg-emerald-950/60 text-emerald-300 border-emerald-800",
  ADVISOR_INFERENCE: "bg-sky-950/60 text-sky-300 border-sky-800",
  DEVELOPMENT_RATIONALE: "bg-violet-950/60 text-violet-300 border-violet-800",
  UNCERTAINTY: "bg-amber-950/60 text-amber-300 border-amber-800",
};

const EXAMPLE_QUESTIONS: readonly string[] = [
  "この会社の最大の問題は？",
  "Standard AIの提案をどう思う？",
  "今期のPLをどう見る？",
  "このゲームは何を学ぶためのもの？",
  "なぜこの部分は簡略化されているの？",
  "このゲーム環境で変なところは？",
];

interface AdvisorEntry {
  readonly question: string;
  readonly answer: AdvisorAnswer | null;
  /** その発言時点のturn（現在turnと区別して表示する。実装指示§33）。 */
  readonly turn: number;
}

export interface ManagementAdvisorPanelProps {
  readonly labId: string;
  readonly companyId: string;
  readonly turn: number;
}

export default function ManagementAdvisorPanel({ labId, companyId, turn }: ManagementAdvisorPanelProps) {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [question, setQuestion] = useState("");
  const [entries, setEntries] = useState<readonly AdvisorEntry[]>([]);
  const [pending, setPending] = useState(false);
  /** 生成中の経過秒数（実測のみ。推定進捗率は出さない）。 */
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorCategory, setErrorCategory] = useState<string | null>(null);
  const [lastFailedQuestion, setLastFailedQuestion] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [restored, setRestored] = useState(false);
  /** 【実装指示§15】Game Owner Mode向けに、現在使われているモデルの表示名を小さく出す。
   *  モデル名はUIへハードコードせず、必ずサーバーから受け取った値を表示する（§13）。 */
  const [modelDisplayName, setModelDisplayName] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 【会話の復元（§34）】パネルを開いたとき、保存済み会話をサーバーから読み直す。
  // リロード後も close→reopen 後も同じ経路で復元される。
  useEffect(() => {
    if (!open || restored) return;
    let cancelled = false;
    void loadAdvisorConversationAction(labId, companyId, turn).then((result) => {
      if (cancelled) return;
      setRestored(true);
      if (result.modelDisplayName) setModelDisplayName(result.modelDisplayName);
      const messages = result.conversation?.messages ?? [];
      const rebuilt: AdvisorEntry[] = [];
      let pendingQuestion: { message: string; turn: number } | null = null;
      for (const m of messages) {
        if (m.role === "user") {
          pendingQuestion = { message: m.message, turn: m.turn };
          continue;
        }
        if (pendingQuestion !== null) {
          rebuilt.push({ question: pendingQuestion.message, answer: m.answer ?? null, turn: pendingQuestion.turn });
          pendingQuestion = null;
        }
      }
      setEntries(rebuilt);
    });
    return () => {
      cancelled = true;
    };
  }, [open, restored, labId, companyId, turn]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, pending]);

  // 経過秒数の計測。pendingでない間はタイマーを動かさない。
  // （0へのリセットは送信開始時に行う。effect内でsetStateを直接呼ばない。）
  useEffect(() => {
    if (!pending) return;
    const startedAt = Date.now();
    const id = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [pending]);

  const submitQuestion = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || pending) return;
      setPending(true);
      setElapsedSeconds(0);
      setErrorCategory(null);

      const timeoutPromise = new Promise<{ readonly kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), ADVISOR_CLIENT_TIMEOUT_MS)
      );
      // 【二重送信防止（§18）】1回の送信につき1つのIDを発行する。
      // 「同じ質問を再送する」でここを通ると新しいIDになるため、再送は必ず本当に実行される
      // （失敗をキャッシュして同じ失敗を返し続けることは無い。§20）。
      const requestId = newRequestId();
      const actionPromise = askAdvisorAction(labId, companyId, turn, trimmed, undefined, requestId).then((result) => ({
        kind: "resolved" as const,
        result,
      }));

      try {
        const outcome = await Promise.race([actionPromise, timeoutPromise]);
        if (outcome.kind === "timeout") {
          setErrorCategory("network_error");
          setLastFailedQuestion(trimmed);
          return;
        }
        const { result } = outcome;
        if (result.ok && result.answer) {
          setEntries((prev) => [...prev, { question: trimmed, answer: result.answer!, turn }]);
          setQuestion("");
          setLastFailedQuestion(null);
          return;
        }
        setErrorCategory(result.errorCategory ?? "unknown");
        setLastFailedQuestion(trimmed);
      } catch {
        setErrorCategory("internal_error");
        setLastFailedQuestion(trimmed);
      } finally {
        setPending(false);
      }
    },
    [labId, companyId, turn, pending]
  );

  async function handleClear() {
    setConfirmingClear(false);
    const result = await clearAdvisorConversationAction(labId, companyId, turn);
    if (result.ok) {
      setEntries([]);
      setErrorCategory(null);
      setLastFailedQuestion(null);
    }
  }

  // ---- 起動ボタン（閉じている、または最小化されている状態） ----
  if (!open || minimized) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setMinimized(false);
        }}
        className="fixed bottom-4 right-4 z-40 rounded-full border border-sky-600/70 bg-sky-900/90 px-4 py-3 text-sm text-sky-100 shadow-lg backdrop-blur hover:bg-sky-800 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        data-testid="advisor-open-button"
      >
        相談役AI
      </button>
    );
  }

  return (
    <div
      // PCでは右端のサイドパネル、モバイルでは下からのbottom sheet。
      // どちらの場合も inset-x-0 / sm:inset-x-auto で切り替え、幅は clamp で可変にする。
      className={
        "fixed z-40 flex flex-col border border-sky-800/70 bg-gray-950/97 shadow-2xl backdrop-blur " +
        "inset-x-0 bottom-0 rounded-t-2xl " +
        (expanded ? "h-[95dvh]" : "h-[80dvh]") +
        " sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-0 sm:h-auto sm:rounded-t-none sm:rounded-l-2xl " +
        "sm:w-[clamp(320px,32vw,420px)] sm:max-w-[92vw]"
      }
      data-testid="advisor-panel"
    >
      {/* ヘッダー（§6） */}
      <div className="flex items-start justify-between gap-2 border-b border-sky-900/70 px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-sky-100">相談役AI</div>
          <div className="text-[11px] text-sky-300/80 break-words" data-testid="advisor-header-context">
            {companyId} / Turn {turn}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <span className="inline-block rounded border border-amber-700/70 bg-amber-950/50 px-1 py-0.5 text-[10px] text-amber-300" data-testid="advisor-owner-mode-badge">
              Game Owner Mode
            </span>
            {modelDisplayName !== null && (
              <span className="inline-block rounded border border-gray-700/70 bg-gray-800/70 px-1 py-0.5 text-[10px] text-gray-400" data-testid="advisor-model-name">
                {modelDisplayName}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800 sm:hidden"
            data-testid="advisor-expand"
          >
            {expanded ? "縮小" : "拡大"}
          </button>
          <button
            type="button"
            onClick={() => setMinimized(true)}
            className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
            data-testid="advisor-minimize"
          >
            最小化
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
            data-testid="advisor-close"
          >
            閉じる
          </button>
        </div>
      </div>

      {/* 会話本文 */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3" data-testid="advisor-messages">
        <p className="text-[11px] text-sky-200/70">
          ゲーム画面を見ながら相談できます。会社の経営だけでなく、Standard
          AIの判断への批判、ゲーム環境の妥当性、このゲームがなぜこう設計されているのか（開発背景）も聞けます。
          相談役AIは読み取り専用で、意思決定やゲーム状態を変更しません。
        </p>

        {entries.length === 0 && !pending && (
          <div className="flex flex-wrap gap-1.5" data-testid="advisor-example-questions">
            {EXAMPLE_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuestion(q)}
                className="rounded border border-gray-700/70 bg-gray-800/70 px-1.5 py-1 text-left text-[11px] text-gray-300 break-words hover:bg-gray-700/70"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {entries.map((entry, idx) => (
          <div key={idx} className="space-y-1.5">
            <div className="rounded border border-gray-700/60 bg-gray-900/60 p-2">
              <div className="text-[10px] text-gray-500">
                あなた{entry.turn !== turn ? `（Turn ${entry.turn} 時点の質問）` : ""}
              </div>
              <p className="whitespace-pre-wrap break-words text-xs text-gray-100">{entry.question}</p>
            </div>
            <div className="rounded border border-sky-800/60 bg-sky-950/40 p-2">
              <div className="text-[10px] text-sky-400">相談役AI</div>
              {entry.answer === null ? (
                <p className="text-xs text-gray-500">（この回答は保存されていません）</p>
              ) : (
                <div className="space-y-2">
                  <p className="whitespace-pre-wrap break-words text-xs text-gray-100">{entry.answer.answer}</p>

                  {entry.answer.sections.length > 0 && (
                    <details className="rounded border border-gray-800/80 bg-gray-900/40 p-1.5">
                      <summary className="cursor-pointer text-[10px] text-gray-400">根拠の内訳（事実 / 見解 / 開発記録の区別）</summary>
                      <ul className="mt-1.5 space-y-1.5">
                        {entry.answer.sections.map((section, sIdx) => (
                          <li key={sIdx} className="space-y-0.5">
                            <span className={"inline-block rounded border px-1 py-0.5 text-[9px] " + SECTION_TONES[section.type]}>
                              {SECTION_LABELS[section.type]}
                            </span>
                            <p className="whitespace-pre-wrap break-words text-[11px] text-gray-300">{section.text}</p>
                            {section.sources.length > 0 && (
                              <p className="text-[10px] text-gray-500 break-all" data-testid="advisor-source-ref">
                                出所:{" "}
                                {section.sources
                                  .map((s) => `${s.path ?? s.title ?? "(不明)"}${s.authority ? `（${s.authority}）` : ""}`)
                                  .join(" / ")}
                              </p>
                            )}
                            {/* 【数値の根拠（§14・§15）】相談役AIが申告した参照フィールド。
                                サーバー側でパスの厳密照合はしていないため「検証済み」とは書かない。 */}
                            {(section.evidenceRefs?.length ?? 0) > 0 && (
                              <p className="text-[10px] text-gray-500 break-all" data-testid="advisor-evidence-ref">
                                数値の参照元（相談役AIの申告）: {section.evidenceRefs.join(" / ")}
                              </p>
                            )}
                            {section.sourceTypes.length > 0 && (
                              <p className="text-[10px] text-gray-600 break-all">{section.sourceTypes.join(", ")}</p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {entry.answer.relatedReasonCodes.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {entry.answer.relatedReasonCodes.map((code) => (
                        <span key={code} className="rounded border border-gray-700/70 bg-gray-800/80 px-1 py-0.5 text-[10px] text-gray-400 break-all">
                          {code}
                        </span>
                      ))}
                    </div>
                  )}

                  {entry.answer.suggestedFollowUps.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {entry.answer.suggestedFollowUps.map((f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setQuestion(f)}
                          className="rounded border border-sky-800/70 bg-sky-950/50 px-1.5 py-0.5 text-left text-[10px] text-sky-300 break-words hover:bg-sky-900/60"
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {pending && (
          <div className="space-y-0.5" data-testid="advisor-loading">
            <p className="text-xs text-sky-200/70">相談役AIが考えています…（経過 {elapsedSeconds} 秒）</p>
            <p className="text-[10px] text-gray-500" data-testid="advisor-progress-hint">
              {elapsedHintText(elapsedSeconds)}
            </p>
          </div>
        )}

        {errorCategory !== null && (
          <div className="space-y-1 rounded border border-amber-800/60 bg-amber-950/30 p-2" data-testid="advisor-failure">
            <p className="text-xs text-amber-300">回答生成に失敗しました。</p>
            <p className="text-[11px] text-amber-300/80" data-testid="advisor-error-category">
              原因: {advisorErrorLabel(errorCategory)}
            </p>
            <p className="text-[11px] text-gray-400">ゲームの状態・Standard AIの提案は影響を受けていません。</p>
            {lastFailedQuestion !== null && (
              <button
                type="button"
                onClick={() => void submitQuestion(lastFailedQuestion)}
                disabled={pending}
                className="rounded border border-amber-700/70 bg-amber-900/40 px-2 py-1 text-[11px] text-amber-100 hover:bg-amber-900/70 disabled:opacity-50"
                data-testid="advisor-retry"
              >
                同じ質問を再送する
              </button>
            )}
          </div>
        )}
      </div>

      {/* 入力欄（下部固定・safe-area対応） */}
      <div className="border-t border-sky-900/70 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {confirmingClear ? (
          <div className="mb-2 space-y-1.5 rounded border border-rose-800/60 bg-rose-950/30 p-2" data-testid="advisor-clear-confirm">
            <p className="text-[11px] text-rose-200">この会話をすべて消去します。元に戻せません。よろしいですか？</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => void handleClear()}
                className="rounded border border-rose-700/70 bg-rose-900/50 px-2 py-1 text-[11px] text-rose-100 hover:bg-rose-900/80"
                data-testid="advisor-clear-confirm-yes"
              >
                消去する
              </button>
              <button
                type="button"
                onClick={() => setConfirmingClear(false)}
                className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
              >
                やめる
              </button>
            </div>
          </div>
        ) : (
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5">
            <span className="text-[10px] text-gray-500">
              {question.length} / {MAX_QUESTION_LENGTH}文字
            </span>
            <button
              type="button"
              onClick={() => setConfirmingClear(true)}
              disabled={pending || entries.length === 0}
              className="rounded border border-gray-700 px-2 py-1 text-[10px] text-gray-400 hover:bg-gray-800 disabled:opacity-40"
              data-testid="advisor-clear"
            >
              会話を消去
            </button>
          </div>
        )}

        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value.slice(0, MAX_QUESTION_LENGTH))}
          rows={2}
          maxLength={MAX_QUESTION_LENGTH}
          placeholder="例: この会社の最大の問題は？"
          disabled={pending}
          className="w-full rounded border border-gray-600 bg-gray-900 px-2 py-2 text-base text-gray-100 placeholder:text-gray-600 disabled:opacity-60"
          data-testid="advisor-input"
        />
        <button
          type="button"
          onClick={() => void submitQuestion(question)}
          disabled={pending || question.trim().length === 0}
          className="mt-1.5 w-full rounded border border-sky-600/70 bg-sky-900/50 px-3 py-2 text-xs text-sky-100 hover:bg-sky-900/80 disabled:opacity-50"
          data-testid="advisor-submit"
        >
          相談する
        </button>
      </div>
    </div>
  );
}
