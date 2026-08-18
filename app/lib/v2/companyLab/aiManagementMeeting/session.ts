// ShrimpX V2 — AI Management Meeting: state source 非依存の会議サービス
//
// 【なぜこの層があるか】AI Management Meeting は当初 Company Lab（Redis上のLab）専用
// として作られ、会議1回ぶんの処理が company-labs の API handler の中に直接書かれていた。
// Management Console の Simulation Run からも同じ会議を開けるようにするにあたり、
// 会議ロジックを2系統へコピーすると prompt・validation・会話履歴の扱いが将来ずれる。
// そこで「どこから会社状態を読んだか」だけを呼び出し側の責務として切り出し、
// 会議1回ぶんの処理はこのファイルだけが持つ。
//
//   Company Lab 経路   : PlayerScreenViewModel      → AiMeetingCompanySnapshot ─┐
//   Simulation Run 経路: StoredSimulationRun        → AiMeetingCompanySnapshot ─┴→ runAiMeetingTurn
//
// 【この移設で変えていないもの】system prompt・Claude呼び出し方針（generateMeetingResponse）・
// 役員role定義・proposal schema・validation policy・Standard AI。処理の順序も応答の
// body 形状も、company-labs handler にあった実装のまま移してある。
//
// 【ゲーム状態を一切変更しない】この層は CompanyLabState / SimulationSession /
// CompanyDecisionDraft へ書き込む経路を持たない。書き込むのは会話artifact
// （conversation.ts の Redis 名前空間）だけで、Claude呼び出しが失敗しても
// ゲーム進行は一切影響を受けない。

import { randomUUID } from "crypto";
import { PeriodV2 } from "../../core/period";
import { CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../types";
import { StandardAiQuarterDiagnostics } from "../standardAi/policy";
import { CompanyLabRedisClient } from "../../redis/companyLabTypes";
import { buildExplanationContext } from "../aiExplanation/buildExplanationContext";
import { AnthropicMessagesClient, generateMeetingResponse } from "./claudeClient";
import { BorrowingHeadroomFact, buildExecutiveBriefingPacket, BriefingBuildInput, CrisisFact, PlayerDraftSummary, PreviousQuarterDelta } from "./briefing";
import { AiMeetingNewsItem } from "./scenarioNews";
import { routePlayerMessage } from "./router";
import { buildMeetingUserMessage } from "./prompt";
import { appendMessages, buildRecentHistoryForPrompt, defaultMeetingId, loadConversation, newConversation, saveConversation } from "./conversation";
import { validateAiMeetingProposals } from "./validation";
import { AiMeetingMessage, ExecutiveRole } from "./types";
import { buildRunAdvisoryMemorySummary } from "./runAdvisoryMemory";

export interface AiMeetingApiResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * 会議1回に必要な「今の会社の姿」。呼び出し側がどこから読んだかはここでは問わない。
 *
 * contextId は会話の名前空間であり、ゲーム状態のIDではない。Company Lab 経路では
 * labId をそのまま、Simulation Run 経路では simulationRunContextId() が付ける
 * 接頭辞付きの文字列を渡す（両者が同じキーへ衝突しないようにするため）。
 */
export interface AiMeetingCompanySnapshot {
  readonly contextId: string;
  readonly companyId: string;
  /** この会社状態が指しているターン。requestedTurn と一致しない要求は 404 にする。 */
  readonly currentTurn: number;
  readonly scenarioId: string;
  readonly period: PeriodV2;
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly publicInfo: PublicMarketInfo;
  readonly diagnostics: StandardAiQuarterDiagnostics;
  readonly previousQuarter: PreviousQuarterDelta | null;
  readonly playerDraft: PlayerDraftSummary | null;
  readonly scenarioNews: readonly AiMeetingNewsItem[];
  /**
   * 【M2.1〜M2.4追加分をSimulation Run経路へも配線】company-labs handler.tsが
   * 直接組み立てているのと同じ生データ（既存ownState.contracts/financeState/
   * financingState/capexStateをそのまま渡すだけ。新しい計算式は作らない）。
   * BriefingBuildInputの該当フィールドをindexed accessでそのまま再利用し、
   * 型定義を2箇所に複製しない。
   */
  readonly contracts: BriefingBuildInput["contracts"];
  readonly receivables: BriefingBuildInput["receivables"];
  readonly payables: BriefingBuildInput["payables"];
  readonly loans: BriefingBuildInput["loans"];
  readonly capexProjects: BriefingBuildInput["capexProjects"];
  readonly borrowingHeadroom: BorrowingHeadroomFact | null;
  readonly crisis: CrisisFact | null;
  readonly financialHistory: BriefingBuildInput["financialHistory"];
  readonly operationalHistory: BriefingBuildInput["operationalHistory"];
}

export interface RunAiMeetingTurnInput {
  readonly redisClient: CompanyLabRedisClient;
  readonly snapshot: AiMeetingCompanySnapshot;
  /** URLで要求されたターン。snapshot.currentTurn と一致しない場合は 404。 */
  readonly requestedTurn: number;
  readonly playerMessage: string;
  readonly meetingId?: string;
  /** テスト用のモック注入口（省略時は claudeClient.ts が ANTHROPIC_API_KEY から組み立てる）。 */
  readonly anthropicClient?: AnthropicMessagesClient;
}

function notFound(message: string): AiMeetingApiResult {
  return { status: 404, body: { error: { code: "NOT_FOUND", message } } };
}

function badRequest(message: string): AiMeetingApiResult {
  return { status: 400, body: { error: { code: "INVALID_REQUEST", message } } };
}

/**
 * Simulation Run 用の会話名前空間ID。
 *
 * Company Lab の labId は英数字・ハイフンのみ（company-labs/_lib/validation.ts の
 * validateLabId）なので、":" を含むこの文字列が実在の labId と衝突することはない。
 */
export function simulationRunContextId(simulationRunId: string): string {
  return `simrun:${simulationRunId}`;
}

/**
 * 会議1回ぶん（プレイヤー発言 → Executive Briefing Packet 組み立て → Claude 1回 →
 * 構造化応答＋validation済み提案）を実行する。
 *
 * 例外を投げず、必ず {status, body} を返す。Claude 呼び出しが失敗として確定した場合も
 * HTTP 200 ＋ available:false で返す（missing_api_key を含む。UI が「送信済みだが応答が
 * 得られなかった」ことを表示できるようにするため。500 にはしない）。
 */
export async function runAiMeetingTurn(input: RunAiMeetingTurnInput): Promise<AiMeetingApiResult> {
  const { redisClient, snapshot, requestedTurn, playerMessage, anthropicClient } = input;
  const { contextId, companyId } = snapshot;
  const logPrefix = `[ai-meeting runAiMeetingTurn] context=${contextId} company=${companyId} turn=${requestedTurn}`;
  console.log(`${logPrefix} 開始`);

  if (typeof playerMessage !== "string" || playerMessage.trim().length === 0) {
    return badRequest("playerMessage は必須です（空文字列不可）。");
  }
  if (!Number.isInteger(requestedTurn) || requestedTurn < 1) {
    return badRequest("turn は1以上の整数である必要があります。");
  }
  if (requestedTurn !== snapshot.currentTurn) {
    return notFound(`現在のturnは${snapshot.currentTurn}です。turn ${requestedTurn}のAI Management Meetingは対象外です。`);
  }
  const turn = requestedTurn;

  const context = buildExplanationContext({
    labId: contextId,
    companyId,
    turn: snapshot.currentTurn,
    period: snapshot.period,
    scenarioId: snapshot.scenarioId,
    fixture: snapshot.fixture,
    ownState: snapshot.ownState,
    publicInfo: snapshot.publicInfo,
    diagnostics: snapshot.diagnostics,
  });

  const briefing = buildExecutiveBriefingPacket({
    context,
    previousQuarter: snapshot.previousQuarter,
    playerDraft: snapshot.playerDraft,
    scenarioNews: snapshot.scenarioNews,
    contracts: snapshot.contracts,
    receivables: snapshot.receivables,
    payables: snapshot.payables,
    loans: snapshot.loans,
    capexProjects: snapshot.capexProjects,
    borrowingHeadroom: snapshot.borrowingHeadroom,
    crisis: snapshot.crisis,
    financialHistory: snapshot.financialHistory,
    operationalHistory: snapshot.operationalHistory,
  });

  const meetingId = input.meetingId ?? defaultMeetingId(contextId, companyId, turn);
  let conversation = (await loadConversation(redisClient, contextId, companyId, meetingId)) ?? newConversation(contextId, companyId, turn, meetingId);

  const routing = routePlayerMessage(playerMessage);
  const { recent, compactSummary } = buildRecentHistoryForPrompt(conversation.messages);

  // 【M2.6未配線】Run Advisory Memoryの永続化（Redis保存・読込）はSimulation Run経路へは
  // まだ配線していない（company-labs handler.tsのみ対応）。空のmemoryとして扱うことで
  // 機能を止めず、捏造もしない（実際には0件のRunとして正しく振る舞う）。
  const userMessage = buildMeetingUserMessage({
    briefing,
    standardAiDecisionSummary: { decision: snapshot.diagnostics.decision, topReasonCodes: snapshot.diagnostics.entries.slice(0, 8).map((e) => e.code) },
    recentHistory: recent.map((m) => ({ speaker: m.speaker, text: m.text })),
    compactSummary,
    playerMessage,
    routingHint: routing,
    meetingIntentHint: conversation.lastMeetingIntent,
    confirmedCorrections: conversation.confirmedCorrections.map((c) => c.note),
    repairNote: null,
    runAdvisoryMemory: buildRunAdvisoryMemorySummary([]),
  });

  const generated = await generateMeetingResponse(userMessage, anthropicClient, { labId: contextId, companyId, turn });

  const playerMsg: AiMeetingMessage = {
    id: randomUUID(),
    speaker: "PLAYER",
    text: playerMessage,
    turn,
    proposalIds: [],
    factsUsed: [],
  };

  if (!generated.ok) {
    console.log(`${logPrefix} Claude呼び出し失敗 category=${generated.errorCategory}`);
    conversation = appendMessages(conversation, [playerMsg], {});
    try {
      await saveConversation(redisClient, conversation);
    } catch (e) {
      console.error(`${logPrefix} 会話保存に失敗（フォールバック応答はそのまま返します）:`, e instanceof Error ? e.message : String(e));
    }
    return {
      status: 200,
      body: {
        meetingId,
        messages: [playerMsg],
        validatedProposals: [],
        meetingIntent: conversation.lastMeetingIntent,
        potentialStrategicChange: false,
        available: false,
        unavailableReason: "AI Management Meetingは現在利用できません。しばらくしてから再度お試しください。",
        diagnostics: generated.diagnostics,
      },
    };
  }

  const response = generated.response;
  const validated = validateAiMeetingProposals(response.proposals, {
    fixture: snapshot.fixture,
    currentTurn: snapshot.currentTurn,
    requestTurn: turn,
    cashUsd: context.ownState.balanceSheet.cashUsd,
  });

  const execMessages: AiMeetingMessage[] = response.responses.map((r) => ({
    id: randomUUID(),
    speaker: r.speaker as ExecutiveRole,
    text: r.text,
    turn,
    stance: r.stance,
    proposalIds: r.proposalIds,
    factsUsed: r.factsUsed,
  }));

  conversation = appendMessages(conversation, [playerMsg, ...execMessages], {
    meetingIntent: response.meetingIntent,
    validatedProposals: validated,
  });

  try {
    await saveConversation(redisClient, conversation);
  } catch (e) {
    console.error(`${logPrefix} 会話保存に失敗（応答はそのまま返します）:`, e instanceof Error ? e.message : String(e));
  }

  console.log(`${logPrefix} 完了 primarySpeaker=${response.primarySpeaker} responses=${response.responses.length} proposals=${response.proposals.length}`);
  return {
    status: 200,
    body: {
      meetingId,
      messages: [playerMsg, ...execMessages],
      validatedProposals: validated,
      meetingIntent: response.meetingIntent,
      potentialStrategicChange: response.potentialStrategicChange,
      potentialStrategicChangeNote: response.potentialStrategicChangeNote ?? null,
      available: true,
      diagnostics: generated.diagnostics,
    },
  };
}

/** GET: 読み取り専用。既存の会話状態（meetingId指定）を返す。副作用なし。 */
export async function loadAiMeetingConversation(
  redisClient: CompanyLabRedisClient,
  contextId: string,
  companyId: string,
  meetingIdParam: string
): Promise<AiMeetingApiResult> {
  const conversation = await loadConversation(redisClient, contextId, companyId, meetingIdParam);
  if (!conversation) {
    return notFound(`会話 "${meetingIdParam}" は見つかりません。`);
  }
  return { status: 200, body: conversation };
}
