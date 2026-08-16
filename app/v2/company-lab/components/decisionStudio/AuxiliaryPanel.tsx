"use client";

// ShrimpX V2 — Decision Studio: AuxiliaryPanel（AI Management Meeting UI）
//
// 【役割分担の厳守】ここはUI層のみ。AI prompt・role定義・Standard AI logic・
// APIのビジネスロジックは一切持たない。既存backend（AMM-M0/M1/M1.1、
// app/api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-meeting/messages）
// をそのまま呼び、返ってきた構造化応答（役員別発言・提案・診断情報）を表示する
// だけの薄いクライアントである。
//
// 【ゲーム状態を変更しない】このcomponentはCompanyDecisionDraftへ一切書き込まない。
// 提案（validatedProposals）は表示するだけで、自動適用はしない（M1スコープの
// 既存契約どおり）。Claude呼び出しが失敗しても、この画面は「利用できません」と
// 表示するだけで、ゲームのdraft/state・他タブの入力には一切影響しない。
//
// 【将来のAuxiliaryPanel拡張】ここはDecisionStudioの右側パネルの現時点の唯一の
// 中身（AI Management Meeting）。将来ここへ他のパネルが追加されても、
// MainDecisionArea側のレイアウト・draft共有方式には影響しない。

import { useEffect, useRef, useState } from "react";
import { AREA_TONES } from "../panelStyles";

type ExecutiveRole = "CEO" | "CFO" | "COO" | "COMMERCIAL";
type MessageSpeaker = "PLAYER" | ExecutiveRole;

interface AiMeetingMessage {
  readonly id: string;
  readonly speaker: MessageSpeaker;
  readonly text: string;
  readonly turn: number;
  readonly stance?: string;
  readonly proposalIds: readonly string[];
  readonly factsUsed: readonly string[];
}

interface ValidatedAiMeetingProposal {
  readonly proposal: { readonly id: string; readonly domain: string; readonly rationale: string; readonly [key: string]: unknown };
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly financiallyRisky: boolean;
}

interface AiMeetingCallDiagnostics {
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly stopReason: string | null;
  readonly latencyMs: number;
  readonly retryCount: number;
  readonly schemaValidationResult: string;
}

interface PostAiMeetingResponseBody {
  readonly meetingId: string;
  readonly messages: readonly AiMeetingMessage[];
  readonly validatedProposals: readonly ValidatedAiMeetingProposal[];
  readonly meetingIntent: string | null;
  readonly potentialStrategicChange: boolean;
  readonly potentialStrategicChangeNote?: string | null;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly diagnostics: AiMeetingCallDiagnostics;
}

interface GetAiMeetingResponseBody {
  readonly meetingId: string;
  readonly messages: readonly AiMeetingMessage[];
  readonly lastValidatedProposals: readonly ValidatedAiMeetingProposal[];
}

const ROLE_LABEL: Readonly<Record<MessageSpeaker, string>> = {
  PLAYER: "あなた（プレイヤー）",
  CEO: "CEO",
  CFO: "CFO",
  COO: "COO",
  COMMERCIAL: "Commercial Director",
};

const ROLE_BADGE_CLASS: Readonly<Record<MessageSpeaker, string>> = {
  PLAYER: "bg-sky-900/70 text-sky-200 border border-sky-700/70",
  CEO: "bg-purple-900/60 text-purple-200 border border-purple-700/60",
  CFO: "bg-emerald-900/60 text-emerald-200 border border-emerald-700/60",
  COO: "bg-amber-900/60 text-amber-200 border border-amber-700/60",
  COMMERCIAL: "bg-teal-900/60 text-teal-200 border border-teal-700/60",
};

const STANCE_LABEL: Readonly<Record<string, string>> = {
  SUPPORT: "賛成",
  CAUTION: "留意",
  OPPOSE: "反対",
  ALTERNATIVE: "代替案",
  INFORMATIONAL: "情報提供",
};

interface AuxiliaryPanelProps {
  readonly labId: string;
  readonly companyId: string;
  readonly turn?: number;
  readonly onClose: () => void;
}

/**
 * サーバー側 conversation.ts の defaultMeetingId と同じ命名規約
 * （`${labId}:${companyId}:turn${turn}`）をクライアント側でも使い、ページ再読み込み後に
 * GETで同じ会話を復元できるようにする。ID文字列の組み立てのみで、判断ロジックは
 * 一切含まない（backendのdefaultMeetingIdをそのまま複製しているだけの単純な規約）。
 */
function buildMeetingId(labId: string, companyId: string, turn: number): string {
  return `${labId}:${companyId}:turn${turn}`;
}

function apiUrl(labId: string, companyId: string, turn: number): string {
  return `/api/v2/company-labs/${encodeURIComponent(labId)}/companies/${encodeURIComponent(companyId)}/turns/${turn}/ai-meeting/messages`;
}

export default function AuxiliaryPanel({ labId, companyId, turn, onClose }: AuxiliaryPanelProps) {
  const tone = AREA_TONES.info;
  const [messages, setMessages] = useState<readonly AiMeetingMessage[]>([]);
  const [validatedProposals, setValidatedProposals] = useState<readonly ValidatedAiMeetingProposal[]>([]);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [playerInput, setPlayerInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [lastDiagnostics, setLastDiagnostics] = useState<AiMeetingCallDiagnostics | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  // ページ再読み込み・タブ再訪時に、同じturnの既存会話をGETで復元する。
  // 会話が存在しない（初回）場合は404が返るが、これは正常系（空の会話から開始）として扱う。
  useEffect(() => {
    if (turn === undefined) return;
    let cancelled = false;
    const restoreMeetingId = buildMeetingId(labId, companyId, turn);
    (async () => {
      try {
        const res = await fetch(`${apiUrl(labId, companyId, turn)}?meetingId=${encodeURIComponent(restoreMeetingId)}`, { method: "GET" });
        if (cancelled) return;
        if (res.status === 404) {
          setMeetingId(restoreMeetingId);
          return;
        }
        if (!res.ok) {
          setLoadError(`会話の復元に失敗しました（HTTP ${res.status}）。新しい会話として続行できます。`);
          setMeetingId(restoreMeetingId);
          return;
        }
        const body = (await res.json()) as GetAiMeetingResponseBody;
        setMessages(body.messages);
        setValidatedProposals(body.lastValidatedProposals);
        setMeetingId(body.meetingId);
      } catch {
        if (!cancelled) {
          setLoadError("会話の復元中にネットワークエラーが発生しました。新しい会話として続行できます。");
          setMeetingId(restoreMeetingId);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [labId, companyId, turn]);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const canSend = turn !== undefined && playerInput.trim().length > 0 && !sending;

  const handleSend = async () => {
    if (turn === undefined || playerInput.trim().length === 0) return;
    const text = playerInput.trim();
    setPlayerInput("");
    setSending(true);
    setLoadError(null);
    setUnavailableReason(null);
    try {
      const res = await fetch(apiUrl(labId, companyId, turn), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId: meetingId ?? undefined, playerMessage: text }),
      });
      if (!res.ok) {
        setLoadError(`送信に失敗しました（HTTP ${res.status}）。ゲームの状態には影響ありません。`);
        return;
      }
      const body = (await res.json()) as PostAiMeetingResponseBody;
      setMeetingId(body.meetingId);
      setMessages((prev) => [...prev, ...body.messages]);
      setLastDiagnostics(body.diagnostics);
      if (!body.available) {
        setUnavailableReason(body.unavailableReason ?? "AI Management Meetingは現在利用できません。");
      } else {
        setValidatedProposals(body.validatedProposals);
      }
    } catch {
      setLoadError("送信中にネットワークエラーが発生しました。ゲームの状態には影響ありません。もう一度お試しください。");
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className={`w-full sm:w-96 shrink-0 flex flex-col rounded-lg ${tone.section} max-h-[85vh]`}
      data-testid="ai-meeting-auxiliary-panel"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700/60">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>AI Management Meeting</span>
        <button type="button" onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-200 text-xs" data-testid="ai-meeting-close">
          閉じる ✕
        </button>
      </div>

      {turn === undefined ? (
        <p className="p-3 text-xs text-gray-500">turnが未確定のため、AI Management Meetingを開始できません。</p>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2" data-testid="ai-meeting-message-list">
            {messages.length === 0 && !sending && (
              <p className="text-xs text-gray-500">経営陣（CEO/CFO/COO/Commercial Director）に相談したいことを下から送信してください。</p>
            )}
            {messages.map((m) => (
              <div key={m.id} className="rounded border border-gray-700/60 bg-gray-900/40 px-2.5 py-2" data-testid={`ai-meeting-message-${m.speaker}`}>
                <div className="mb-1 flex items-center gap-1.5">
                  <span className={`text-[10px] rounded px-1.5 py-0.5 ${ROLE_BADGE_CLASS[m.speaker]}`}>{ROLE_LABEL[m.speaker]}</span>
                  {m.stance && <span className="text-[10px] text-gray-400">{STANCE_LABEL[m.stance] ?? m.stance}</span>}
                </div>
                <p className="text-xs text-gray-200 whitespace-pre-wrap">{m.text}</p>
              </div>
            ))}
            <div ref={scrollAnchorRef} />
          </div>

          {unavailableReason && (
            <div className="mx-3 mb-2 rounded border border-amber-700/60 bg-amber-950/40 px-2.5 py-1.5 text-[11px] text-amber-200" data-testid="ai-meeting-unavailable">
              {unavailableReason}
            </div>
          )}
          {loadError && (
            <div className="mx-3 mb-2 rounded border border-rose-700/60 bg-rose-950/40 px-2.5 py-1.5 text-[11px] text-rose-200" data-testid="ai-meeting-error">
              {loadError}
            </div>
          )}

          {validatedProposals.length > 0 && (
            <div className="mx-3 mb-2 rounded border border-sky-700/60 bg-sky-950/20 px-2.5 py-1.5 space-y-1" data-testid="ai-meeting-proposals">
              <div className="text-[11px] font-semibold text-sky-200">提案（参考情報。自動適用はされません。各タブで手動反映してください）</div>
              {validatedProposals.map((vp) => (
                <div key={vp.proposal.id} className="text-[11px] text-gray-300">
                  <span className={vp.valid ? "text-sky-200" : "text-rose-300"}>[{vp.proposal.domain}]</span> {vp.proposal.rationale}
                  {vp.financiallyRisky && <span className="ml-1 text-amber-300">（財務リスクあり）</span>}
                  {!vp.valid && vp.issues.length > 0 && <span className="ml-1 text-rose-300">（{vp.issues.join(" / ")}）</span>}
                </div>
              ))}
            </div>
          )}

          <div className="px-3 py-2 border-t border-gray-700/60 space-y-1.5">
            <textarea
              value={playerInput}
              onChange={(e) => setPlayerInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              disabled={sending}
              placeholder="経営陣への相談内容を入力（Enterで送信・Shift+Enterで改行）"
              rows={2}
              data-testid="ai-meeting-input"
              className="w-full bg-sky-900/70 border border-sky-500/70 rounded px-2 py-1 text-xs text-sky-50 placeholder:text-sky-300/50 focus:outline-none focus:border-sky-300 disabled:opacity-50"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!canSend}
                data-testid="ai-meeting-send"
                className="text-[11px] px-3 py-1.5 rounded bg-sky-900/70 border border-sky-500/70 text-sky-50 hover:bg-sky-800/70 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sending ? "送信中…" : "送信"}
              </button>
              <button
                type="button"
                onClick={() => setShowDiagnostics((v) => !v)}
                className="ml-auto text-[10px] text-gray-500 hover:text-gray-300"
                data-testid="ai-meeting-toggle-diagnostics"
              >
                {showDiagnostics ? "診断情報を隠す" : "診断情報"}
              </button>
            </div>
            {showDiagnostics && lastDiagnostics && (
              <div className="text-[10px] text-gray-500 bg-gray-950/40 border border-gray-700/50 rounded px-2 py-1" data-testid="ai-meeting-diagnostics">
                model={lastDiagnostics.model} / input={lastDiagnostics.inputTokens ?? "－"} / output={lastDiagnostics.outputTokens ?? "－"} / latency=
                {lastDiagnostics.latencyMs}ms / stopReason={lastDiagnostics.stopReason ?? "－"} / retry={lastDiagnostics.retryCount} / schema=
                {lastDiagnostics.schemaValidationResult}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
