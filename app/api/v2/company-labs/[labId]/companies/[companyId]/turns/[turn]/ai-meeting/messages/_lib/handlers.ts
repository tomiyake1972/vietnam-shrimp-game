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
import { toYearQuarter } from "../../../../../../../../../../../lib/v2/core/period";
import { loadPlayerScreenViewModel, PlayerScreenViewModel } from "../../../../../../../../../../../v2/company-lab/play/_lib/viewModel";
import { generateStandardAiDecisionWithDiagnostics, StandardAiQuarterDiagnostics } from "../../../../../../../../../../../lib/v2/companyLab/standardAi/policy";
import { buildExplanationContext } from "../../../../../../../../../../../lib/v2/companyLab/aiExplanation/buildExplanationContext";
import { AnthropicMessagesClient, generateMeetingResponse } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/claudeClient";
import { BorrowingHeadroomFact, buildExecutiveBriefingPacket, CrisisFact, PlayerDraftSummary } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/briefing";
import { CompanyLabHistoryEntryNotFoundError } from "../../../../../../../../../../../lib/v2/companyLab/persistence/errors";
import { BalanceSheet, CashFlowStatement, ProfitAndLossStatement } from "../../../../../../../../../../../lib/v2/finance/types";
import { CompanyQuarterSummary } from "../../../../../../../../../../../lib/v2/companyLab/types";
import { ProductionAllocationEntry, WorkerAssignment } from "../../../../../../../../../../../lib/v2/production/types";
import { routePlayerMessage } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/router";
import { AI_MEETING_PROMPT_VERSION, buildMeetingUserMessage } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/prompt";
import {
  appendMessages,
  buildRecentHistoryForPrompt,
  defaultMeetingId,
  formatHistoryEntryForPrompt,
  loadConversation,
  newConversation,
  saveConversation,
} from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/conversation";
import { validateAiMeetingProposals } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/validation";
import { AiMeetingCallDiagnostics, AiMeetingMessage, ExecutiveRole, PlayerCorrectionRecord, RunAdvisoryMemoryRecord } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/types";
import { findOverdueWordingViolations } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/dueWordingGuard";
import {
  applyCandidate,
  buildRunAdvisoryMemorySummary,
  confirmMemoryCandidate,
  expireRunMemories,
  loadRunMemories,
  saveRunMemories,
} from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/runAdvisoryMemory";
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
        // 【M2.1追加】この数値がどのturn/四半期のものかを明示する（誤って「今期の実績」と
        // 取り違えないようにする。previousQuarterFinancials.periodは既存のPlayerScreenViewModel
        // が既に持つ値をそのまま整形するだけで、新しい期間表現は作らない）。
        periodLabel: (() => {
          const period = viewModel.previousQuarterFinancials?.period;
          if (!period) return null;
          const yq = toYearQuarter(period as never);
          return `${yq.year}年Q${yq.quarter}`;
        })(),
      }
    : null;

  // 【M2.2追加】CFO Finance Briefing監査（実装指示§4）対応。既存BorrowingCapacityResult
  // （前四半期の銀行underwriting結果）・既存Standard AI crisis判定をそのまま転記するだけで、
  // 新しい財務計算・危機判定ロジックは一切作らない。
  const lastBorrowingCapacity = viewModel.ownState.lastFinancingResult?.borrowingCapacity ?? null;
  const borrowingHeadroom: BorrowingHeadroomFact | null = lastBorrowingCapacity
    ? {
        availableAdditionalCapacityUsd: lastBorrowingCapacity.availableAdditionalCapacityUsd,
        asOfLabel: (() => {
          const yq = toYearQuarter(lastBorrowingCapacity.period);
          return `${yq.year}年Q${yq.quarter}`;
        })(),
      }
    : null;
  const crisis: CrisisFact | null = diagnostics.crisis ? { state: diagnostics.crisis.state, summary: diagnostics.crisis.summary } : null;

  // 【M2.3追加・実装指示§3-§10】P&L/Cash Flow/Balance Sheet分離・variance分析のための
  // 直近2四半期ぶんの実績取得。reportingPeriod=直近の確定四半期（currentTurn-1）、
  // priorPeriod=そのvariance比較対象（currentTurn-2）。既存repository.loadHistoryEntry
  // をそのまま使うだけで、新しい永続化経路・新しい会計計算は一切追加しない。
  // turn1・turn2等で該当履歴が存在しない場合はCompanyLabHistoryEntryNotFoundErrorを
  // 捕捉してnullとする（捏造しない）。
  // 【M2.4追加・実装指示§3-§8】Operational KPI Semantic Grounding / Forward Obligation
  // Riskのための同一四半期スナップショットへ、companySummaries・workerAssignments
  // （decisions）・productionAllocation.entriesを追加で含める（同じrepository呼び出し
  // 結果を再利用するだけで、新しい永続化読込経路は追加しない）。
  async function loadQuarterSnapshot(targetTurn: number): Promise<{
    readonly pnl: ProfitAndLossStatement;
    readonly cashFlow: CashFlowStatement;
    readonly balanceSheet: BalanceSheet;
    readonly periodLabel: string;
    readonly fulfilledQuantityTons: number;
    readonly summary: CompanyQuarterSummary;
    readonly workerAssignments: readonly WorkerAssignment[];
    readonly productionEntries: readonly ProductionAllocationEntry[];
  } | null> {
    if (targetTurn < 1) return null;
    try {
      const entry = await deps.repository.loadHistoryEntry(labId, targetTurn);
      const financialResult = entry.record.financialResults.find((f) => f.companyId === companyId);
      const summary = entry.record.companySummaries.find((s) => s.companyId === companyId);
      if (!financialResult || !summary) return null;
      const yq = toYearQuarter(entry.period as never);
      const decision = entry.record.decisions.find((d) => d.companyId === companyId);
      return {
        pnl: financialResult.profitAndLoss,
        cashFlow: financialResult.cashFlow,
        balanceSheet: financialResult.balanceSheet,
        periodLabel: `${yq.year}年Q${yq.quarter}`,
        fulfilledQuantityTons: Number(summary.fulfilledQuantity),
        summary,
        workerAssignments: decision?.workerAssignments ?? [],
        productionEntries: entry.record.productionAllocation.entries.filter((e) => e.companyId === companyId),
      };
    } catch (e) {
      if (e instanceof CompanyLabHistoryEntryNotFoundError) return null;
      throw e;
    }
  }

  const reportingPeriodSnapshot = await loadQuarterSnapshot(viewModel.currentTurn - 1);
  const priorPeriodSnapshot = await loadQuarterSnapshot(viewModel.currentTurn - 2);

  const briefing = buildExecutiveBriefingPacket({
    context,
    previousQuarter,
    playerDraft: buildPlayerDraftSummary(viewModel),
    // 【M2.1追加】Healthy Forward/Due This Turn/Overdueの分離に必要な生contracts
    // （既存ownState.contractsをそのまま渡すだけ。新しい状態読み込み経路ではない）。
    contracts: viewModel.ownState.contracts,
    // 【M2.2追加】AR/AP schedule・融資延滞・CAPEXコミット残高分離に必要な生finance state
    // （既存ownState.financeState/financingStateをそのまま渡すだけ）。
    receivables: viewModel.ownState.financeState.receivables,
    payables: viewModel.ownState.financeState.payables,
    loans: viewModel.ownState.financingState.loanPortfolio.loans,
    capexProjects: viewModel.ownState.capexState.portfolio.projects,
    borrowingHeadroom,
    crisis,
    financialHistory: {
      reportingPeriod: reportingPeriodSnapshot,
      priorPeriod: priorPeriodSnapshot ? { pnl: priorPeriodSnapshot.pnl, periodLabel: priorPeriodSnapshot.periodLabel, fulfilledQuantityTons: priorPeriodSnapshot.fulfilledQuantityTons } : null,
    },
    operationalHistory: {
      reportingPeriod: reportingPeriodSnapshot
        ? {
            summary: reportingPeriodSnapshot.summary,
            workerAssignments: reportingPeriodSnapshot.workerAssignments,
            productionEntries: reportingPeriodSnapshot.productionEntries,
            periodLabel: reportingPeriodSnapshot.periodLabel,
          }
        : null,
      priorPeriod: priorPeriodSnapshot ? { summary: priorPeriodSnapshot.summary } : null,
    },
  });

  const meetingId = body.meetingId ?? defaultMeetingId(labId, companyId, turn);
  let conversation = (await loadConversation(deps.redisClient, labId, companyId, meetingId)) ?? newConversation(labId, companyId, turn, meetingId);

  const routing = routePlayerMessage(body.playerMessage);
  const { recent, compactSummary } = buildRecentHistoryForPrompt(conversation.messages);

  // 【M2.6追加・実装指示§6・§37・§38】Run Advisory Memoryの読み込み。既存save/resumeへ
  // 影響させない別Redis namespace。読み込み失敗時もAI Meetingそのものは停止せず、
  // memoryなしで会話継続する（Game stateは絶対に変更しない設計と同じ耐障害方針）。
  const memoryNow = new Date().toISOString();
  let runMemories: readonly RunAdvisoryMemoryRecord[] = [];
  try {
    const loaded = await loadRunMemories(deps.redisClient, labId, companyId);
    runMemories = expireRunMemories(loaded, viewModel.currentTurn, memoryNow);
  } catch (e) {
    console.error(`${logPrefix} Run Advisory Memoryの読み込みに失敗（memoryなしで継続します）:`, e instanceof Error ? e.message : String(e));
    runMemories = [];
  }
  const runAdvisoryMemorySummary = buildRunAdvisoryMemorySummary(runMemories);

  const userMessage = buildMeetingUserMessage({
    briefing,
    standardAiDecisionSummary: { decision: diagnostics.decision, topReasonCodes: diagnostics.entries.slice(0, 8).map((e) => e.code) },
    // 【M2.2追加】旧prompt versionの下で生成されたexecutiveメッセージにはlegacy警告を付与する
    // （実装指示§21。formatHistoryEntryForPromptはtextへ短いタグを前置するだけで、新しい
    // 構造化フィールドは増やさない）。
    recentHistory: recent.map((m) => formatHistoryEntryForPrompt(m, AI_MEETING_PROMPT_VERSION)),
    compactSummary,
    playerMessage: body.playerMessage,
    routingHint: routing,
    meetingIntentHint: conversation.lastMeetingIntent,
    // 【M2.2追加】同一meeting内で既にCONFIRMED済みのプレイヤー訂正（correction memory）。
    // 以後のresponse生成で同じ誤りを繰り返さないための明示的なメモリ（実装指示§9）。
    confirmedCorrections: conversation.confirmedCorrections.map((c) => c.note),
    // 【M2.5追加・実装指示§11】通常のcallではnull。overdue語彙違反検知時のみ、下でrepair呼び出しに使う。
    repairNote: null,
    // 【M2.6追加・実装指示§19】Run Advisory Memory Summary（role-relevant top N件、compact）。
    runAdvisoryMemory: runAdvisoryMemorySummary,
  });

  let generated = await generateMeetingResponse(userMessage, anthropicClient, { labId, companyId, turn });
  let semanticGuardResult: AiMeetingCallDiagnostics["semanticGuardResult"] = briefing.common.backlog.overdueTons > 1e-6 ? "not_applicable" : "ok";

  // 【M2.5追加・実装指示§2・§11】overdueTons=0なのに応答テキストへoverdue関連の
  // 禁止語彙が出た場合、最大1回だけ同一入力＋repair指示で再呼び出しする
  // （schema_mismatch由来のretryとは別レイヤー。既存のclaudeClient.ts内リトライ
  // ポリシーは変更しない）。
  if (generated.ok && briefing.common.backlog.overdueTons <= 1e-6) {
    const violations = findOverdueWordingViolations(
      generated.response.responses.map((r) => r.text),
      briefing.common.backlog.overdueTons
    );
    if (violations.length > 0) {
      console.log(`${logPrefix} overdue語彙違反を検知 violations=${violations.join(",")} repairを1回試行します`);
      const repairUserMessage = buildMeetingUserMessage({
        briefing,
        standardAiDecisionSummary: { decision: diagnostics.decision, topReasonCodes: diagnostics.entries.slice(0, 8).map((e) => e.code) },
        recentHistory: recent.map((m) => formatHistoryEntryForPrompt(m, AI_MEETING_PROMPT_VERSION)),
        compactSummary,
        playerMessage: body.playerMessage,
        routingHint: routing,
        meetingIntentHint: conversation.lastMeetingIntent,
        confirmedCorrections: conversation.confirmedCorrections.map((c) => c.note),
        repairNote:
          `直前の応答で禁止語彙（${violations.join("、")}）が検出されました。overdueTonsは0です。` +
          "backlogの各statusフィールド（OVERDUE/DUE_THIS_TURN/FUTURE_DUE/MIXED）と一致する語彙のみを使って、同じ質問に発言し直してください。",
        runAdvisoryMemory: runAdvisoryMemorySummary,
      });
      const repaired = await generateMeetingResponse(repairUserMessage, anthropicClient, { labId, companyId, turn });
      if (repaired.ok) {
        const remainingViolations = findOverdueWordingViolations(
          repaired.response.responses.map((r) => r.text),
          briefing.common.backlog.overdueTons
        );
        generated = repaired;
        semanticGuardResult = remainingViolations.length === 0 ? "repaired" : "violation_after_repair";
      } else {
        // repair呼び出し自体が失敗した場合は、元のgenerated（違反を含む）をそのまま使う
        // （新しい応答が得られない以上、無い袖は振れない。診断へ違反が残った旨を記録する）。
        semanticGuardResult = "violation_after_repair";
      }
    }
  }

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
        diagnostics: { ...generated.diagnostics, semanticGuardResult },
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
    promptVersion: AI_MEETING_PROMPT_VERSION,
  }));

  // 【M2.2追加・correction memory】playerCorrectionStatus="CONFIRMED"の場合のみ、
  // このturn限りの会話artifactへ記録する（Game SSoTには入れない。実装指示§8・§9）。
  const newConfirmedCorrection: PlayerCorrectionRecord | undefined =
    response.playerCorrectionStatus === "CONFIRMED"
      ? {
          id: randomUUID(),
          claimText: body.playerMessage,
          note: response.playerCorrectionNote ?? body.playerMessage,
          turn,
        }
      : undefined;

  conversation = appendMessages(conversation, [playerMsg, ...execMessages], {
    meetingIntent: response.meetingIntent,
    validatedProposals: validated,
    newConfirmedCorrection,
  });

  try {
    await saveConversation(deps.redisClient, conversation);
  } catch (e) {
    console.error(`${logPrefix} 会話保存に失敗（応答はそのまま返します）:`, e instanceof Error ? e.message : String(e));
  }

  // 【M2.6追加・実装指示§4・§14・§15・§30・§38】memoryCandidatesのserver-side
  // validation・confirmation・永続化。AIに保存可否を最終決定させない。Redis書き込み
  // 失敗時もAI Meeting応答そのものは既に確定しているため、ここでの失敗は握りつぶし、
  // ログのみ残す（Game stateは絶対に変更しない設計と同じ耐障害方針）。
  if (response.memoryCandidates.length > 0) {
    let updatedMemories = runMemories;
    for (const candidate of response.memoryCandidates) {
      const confirmation = confirmMemoryCandidate(candidate, { backlogStatus: briefing.common.backlog.status });
      const applied = applyCandidate(
        candidate,
        confirmation.finalType,
        confirmation.verificationStatus,
        { runId: labId, companyId, currentTurn: viewModel.currentTurn, sourceMessageId: playerMsg.id, existingRecords: updatedMemories },
        memoryNow
      );
      updatedMemories = applied.records;
      if (applied.skippedReason) {
        console.log(`${logPrefix} memory候補を保存しませんでした reason=${applied.skippedReason} topic=${candidate.topic} type=${candidate.type}`);
      }
    }
    if (updatedMemories !== runMemories) {
      try {
        await saveRunMemories(deps.redisClient, labId, companyId, updatedMemories);
      } catch (e) {
        console.error(`${logPrefix} Run Advisory Memoryの保存に失敗（応答はそのまま返します）:`, e instanceof Error ? e.message : String(e));
      }
    }
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
      playerCorrectionStatus: response.playerCorrectionStatus,
      playerCorrectionNote: response.playerCorrectionNote ?? null,
      // 【M2.6追加・実装指示§28】応答の根拠として使ったmemoryのid（factsUsedとは分離）。
      memoryUsedIds: response.memoryUsedIds,
      available: true,
      diagnostics: { ...generated.diagnostics, semanticGuardResult },
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
