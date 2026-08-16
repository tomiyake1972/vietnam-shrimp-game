// ShrimpX V2 — AI Management Meeting API ハンドラー本体（MVP）
//
// フレームワーク非依存の純粋な非同期関数（既存ai-explanation/_lib/handlers.tsと同じ設計方針）。
// 【対応範囲の限定】ai-explanationと同じ理由（loadPlayerScreenViewModelがプレイヤー会社1社・
// 現在turnぶんの状態しか返さない）で、companyId・turnはプレイヤー会社・現在turnと一致する
// 場合のみ対応する。
//
// 【ゲーム状態を一切変更しない】このハンドラーはCompanyDecisionDraftやCompanyLabStateへの
// 書き込みを一切行わない（読み取り専用の入力からClaude応答を生成し、会話artifactへのみ
// 書き込む）。Claude呼び出しが失敗しても、Standard AIのdraft・ゲームセッションは
// 一切影響を受けない（実装指示§53「Claude failure must never stop the game」に対応）。

import { randomUUID } from "crypto";
import { loadPlayerScreenViewModel, PlayerScreenViewModel } from "../../../../../../../../../../../v2/company-lab/play/_lib/viewModel";
import { generateStandardAiDecisionWithDiagnostics, StandardAiQuarterDiagnostics } from "../../../../../../../../../../../lib/v2/companyLab/standardAi/policy";
import { buildExplanationContext } from "../../../../../../../../../../../lib/v2/companyLab/aiExplanation/buildExplanationContext";
import { AnthropicMessagesClient, generateMeetingResponse } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/claudeClient";
import { buildExecutiveBriefingPacket, PlayerDraftSummary } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/briefing";
import { routePlayerMessage } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/router";
import { buildMeetingUserMessage } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/prompt";
import {
  appendMessages,
  buildRecentHistoryForPrompt,
  defaultMeetingId,
  loadConversation,
  newConversation,
  saveConversation,
} from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/conversation";
import { validateAiMeetingProposals } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/validation";
import { AiMeetingMessage, ExecutiveRole } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/types";
import { AiMeetingApiDependencies } from "./dependencies";

export type AiMeetingApiResult = { readonly status: number; readonly body: unknown };

function notFound(message: string): AiMeetingApiResult {
  return { status: 404, body: { error: { code: "NOT_FOUND", message } } };
}

function badRequest(message: string): AiMeetingApiResult {
  return { status: 400, body: { error: { code: "INVALID_REQUEST", message } } };
}

export interface PostAiMeetingRequestBody {
  readonly meetingId?: string;
  readonly playerMessage: string;
  /** 【M1スコープ】現在の編集中draftのスナップショット参照用（サーバー側での自動適用はしない）。 */
  readonly currentPlayerDraft?: unknown;
}

function buildPlayerDraftSummary(viewModel: PlayerScreenViewModel): PlayerDraftSummary | null {
  const draft = viewModel.draft;
  if (!draft) return { hasDraft: false, totalDesiredSalesQuantityTons: 0, capexProposalCount: 0, financingRequestedUsd: 0 };
  return {
    hasDraft: true,
    totalDesiredSalesQuantityTons: draft.salesPlans.reduce((sum, p) => sum + p.desiredQuantity, 0),
    capexProposalCount: draft.capexDecision.newProjectProposals.length,
    financingRequestedUsd: draft.financingRequest.desiredAmountUsd,
  };
}

/**
 * POST: プレイヤー発言を受け取り、Executive Briefing Packetを組み立て、Claudeを1回
 * 呼び出して構造化応答（primary/secondary発言・CEO summary・提案）を返す。
 * 提案はvalidation.tsを通過した後にのみ「validated」としてUIへ返す（M1では
 * 自動適用しない。UIへ返すだけ）。
 *
 * anthropicClient はテスト用のモック注入口（省略時はclaudeClient.tsが
 * ANTHROPIC_API_KEYから実クライアントを組み立てる）。
 */
export async function handlePostAiMeetingMessage(
  deps: AiMeetingApiDependencies,
  labId: string,
  companyId: string,
  turnParam: string,
  body: PostAiMeetingRequestBody,
  anthropicClient?: AnthropicMessagesClient
): Promise<AiMeetingApiResult> {
  const logPrefix = `[ai-meeting handlePost] lab=${labId} company=${companyId} turn=${turnParam}`;
  console.log(`${logPrefix} 開始`);

  if (typeof body.playerMessage !== "string" || body.playerMessage.trim().length === 0) {
    return badRequest("playerMessage は必須です（空文字列不可）。");
  }

  const loaded = await loadPlayerScreenViewModel(deps, labId);
  if (loaded.kind === "notFound") {
    return notFound(`会社ラボ "${labId}" が見つかりません。`);
  }
  const viewModel = loaded.viewModel;

  if (viewModel.playerCompanyId !== companyId) {
    return notFound(`会社 "${companyId}" は、この会社ラボのAI Management Meetingの対象外です（プレイヤー会社のみ対応）。`);
  }

  const turn = Number(turnParam);
  if (!Number.isInteger(turn) || turn < 1) {
    return badRequest("turn は1以上の整数である必要があります。");
  }
  if (turn !== viewModel.currentTurn) {
    return notFound(`この会社ラボの現在のturnは${viewModel.currentTurn}です。turn ${turn}のAI Management Meetingは対象外です。`);
  }

  const diagnostics: StandardAiQuarterDiagnostics =
    viewModel.aiProposalDiagnostics ??
    generateStandardAiDecisionWithDiagnostics(viewModel.fixture, viewModel.ownState, viewModel.publicInfo, viewModel.period, viewModel.currentTurn).diagnostics;

  const context = buildExplanationContext({
    labId: viewModel.labId,
    companyId: viewModel.playerCompanyId,
    turn: viewModel.currentTurn,
    period: viewModel.period,
    scenarioId: viewModel.scenarioId,
    fixture: viewModel.fixture,
    ownState: viewModel.ownState,
    publicInfo: viewModel.publicInfo,
    diagnostics,
  });

  const previousFinancialResult = viewModel.previousQuarterFinancials?.financialResult ?? null;
  const previousQuarter = previousFinancialResult
    ? {
        cashUsd: Number(previousFinancialResult.balanceSheet.cash),
        netRevenueUsd: Number(previousFinancialResult.profitAndLoss.netRevenue),
        operatingProfitUsd: Number(previousFinancialResult.profitAndLoss.operatingProfit),
      }
    : null;

  const briefing = buildExecutiveBriefingPacket({
    context,
    previousQuarter,
    playerDraft: buildPlayerDraftSummary(viewModel),
  });

  const meetingId = body.meetingId ?? defaultMeetingId(labId, companyId, turn);
  let conversation = (await loadConversation(deps.redisClient, labId, companyId, meetingId)) ?? newConversation(labId, companyId, turn, meetingId);

  const routing = routePlayerMessage(body.playerMessage);
  const { recent, compactSummary } = buildRecentHistoryForPrompt(conversation.messages);

  const userMessage = buildMeetingUserMessage({
    briefing,
    standardAiDecisionSummary: { decision: diagnostics.decision, topReasonCodes: diagnostics.entries.slice(0, 8).map((e) => e.code) },
    recentHistory: recent.map((m) => ({ speaker: m.speaker, text: m.text })),
    compactSummary,
    playerMessage: body.playerMessage,
    routingHint: routing,
    meetingIntentHint: conversation.lastMeetingIntent,
  });

  const generated = await generateMeetingResponse(userMessage, anthropicClient, { labId, companyId, turn });

  const playerMsg: AiMeetingMessage = {
    id: randomUUID(),
    speaker: "PLAYER",
    text: body.playerMessage,
    turn,
    proposalIds: [],
    factsUsed: [],
  };

  if (!generated.ok) {
    // 【フォールバック】Claude呼び出しが失敗として確定した場合でも、この関数は例外を
    // 投げず、必ず構造化された失敗応答を返す。プレイヤー発言だけは会話履歴へ残す
    // （UIが「送信済みだが応答は得られなかった」ことを表示できるようにするため）。
    console.log(`${logPrefix} Claude呼び出し失敗 category=${generated.errorCategory}`);
    conversation = appendMessages(conversation, [playerMsg], {});
    try {
      await saveConversation(deps.redisClient, conversation);
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
    fixture: viewModel.fixture,
    currentTurn: viewModel.currentTurn,
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
    await saveConversation(deps.redisClient, conversation);
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
export async function handleGetAiMeetingConversation(deps: AiMeetingApiDependencies, labId: string, companyId: string, meetingIdParam: string): Promise<AiMeetingApiResult> {
  const conversation = await loadConversation(deps.redisClient, labId, companyId, meetingIdParam);
  if (!conversation) {
    return notFound(`会話 "${meetingIdParam}" は見つかりません。`);
  }
  return { status: 200, body: conversation };
}
