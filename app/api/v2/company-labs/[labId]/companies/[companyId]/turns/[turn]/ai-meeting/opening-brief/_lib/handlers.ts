// ShrimpX V2 — AI Management Meeting: Opening Executive Brief API ハンドラー（AMM-M2.7）
//
// 【役割】新しいTurnの意思決定画面に入った際、プレイヤーが何も質問しなくても
// 「前四半期から何が変わったか」をCEOが3〜5点、短く説明するためのGETエンドポイント。
// ゲーム状態（CompanyLabState・CompanyDecisionDraft）は一切変更しない。会話への
// 書き込みは、既存messages APIと同じconversation.ts（aiMeeting namespace）への
// 追記のみ（Game SSoTとは完全に別のconversation artifact）。
//
// 【キャッシュ（実装指示§22・§23）】同一turn・同一meetingIdの会話に既にOPENING_BRIEF
// メッセージが存在すれば、それをそのまま返す（Claudeを再度呼ばない）。新しいキャッシュ
// namespaceは作らず、既存conversation.tsのRedisキーをそのまま再利用する。
//
// 【割り込み禁止（実装指示§35）】会話が既にPlayerメッセージを含む場合（プレイヤーが
// 先に質問した場合）、後からOpening Briefを割り込ませない。

import { randomUUID } from "crypto";
import { toYearQuarter } from "../../../../../../../../../../../lib/v2/core/period";
import { loadPlayerScreenViewModel, PlayerScreenViewModel } from "../../../../../../../../../../../v2/company-lab/play/_lib/viewModel";
import { generateStandardAiDecisionWithDiagnostics, StandardAiQuarterDiagnostics } from "../../../../../../../../../../../lib/v2/companyLab/standardAi/policy";
import { buildExplanationContext } from "../../../../../../../../../../../lib/v2/companyLab/aiExplanation/buildExplanationContext";
import { AnthropicMessagesClient, generateOpeningBrief } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/claudeClient";
import { BorrowingHeadroomFact, buildExecutiveBriefingPacket, CrisisFact, EXECUTIVE_BRIEFING_VERSION, PlayerDraftSummary } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/briefing";
import { CompanyLabHistoryEntryNotFoundError } from "../../../../../../../../../../../lib/v2/companyLab/persistence/errors";
import { BalanceSheet, CashFlowStatement, ProfitAndLossStatement } from "../../../../../../../../../../../lib/v2/finance/types";
import { CompanyQuarterSummary } from "../../../../../../../../../../../lib/v2/companyLab/types";
import { ProductionAllocationEntry, WorkerAssignment } from "../../../../../../../../../../../lib/v2/production/types";
import { OPENING_BRIEF_PROMPT_VERSION, OPENING_BRIEF_UNAVAILABLE_REASON_JA, buildOpeningBriefUserMessage } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/prompt";
import { appendMessages, defaultMeetingId, loadConversation, newConversation, saveConversation } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/conversation";
import { AiMeetingMessage, OpeningExecutiveBrief, RunAdvisoryMemoryRecord } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/types";
import { buildCapacityPools } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/capacitySemantics";
import { buildInitialBriefFacts, buildTurnChangeBriefing, TurnChangeQuarterSnapshot } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/turnChangeBriefing";
import { buildRunAdvisoryMemorySummary, expireRunMemories, loadRunMemories } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/runAdvisoryMemory";
import { AiMeetingApiDependencies } from "../../messages/_lib/dependencies";

export type OpeningBriefApiResult = { readonly status: number; readonly body: unknown };

function notFound(message: string): OpeningBriefApiResult {
  return { status: 404, body: { error: { code: "NOT_FOUND", message } } };
}

function badRequest(message: string): OpeningBriefApiResult {
  return { status: 400, body: { error: { code: "INVALID_REQUEST", message } } };
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
 * GET: labId(run)×companyId×turnのOpening Executive Briefを返す。
 * anthropicClient はテスト用のモック注入口（省略時はclaudeClient.tsが
 * ANTHROPIC_API_KEYから実クライアントを組み立てる）。
 */
export async function handleGetOpeningBrief(
  deps: AiMeetingApiDependencies,
  labId: string,
  companyId: string,
  turnParam: string,
  anthropicClient?: AnthropicMessagesClient
): Promise<OpeningBriefApiResult> {
  const logPrefix = `[ai-meeting openingBrief] lab=${labId} company=${companyId} turn=${turnParam}`;
  console.log(`${logPrefix} 開始`);

  const loaded = await loadPlayerScreenViewModel(deps, labId);
  if (loaded.kind === "notFound") {
    return notFound(`会社ラボ "${labId}" が見つかりません。`);
  }
  if (loaded.kind === "error") {
    // 【COMPANYLAB-DETAIL-LOAD-404-1】読み込み失敗を 404 と混同しない。
    // 内部詳細は応答へ含めない（サーバー側 console.error にのみ記録済み）。
    return {
      status: 500,
      body: { error: { code: "COMPANY_LAB_LOAD_FAILED", message: `会社ラボ "${labId}" の読み込みに失敗しました（分類: ${loaded.reason}）。` } },
    };
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
    return notFound(`この会社ラボの現在のturnは${viewModel.currentTurn}です。turn ${turn}のOpening Briefは対象外です。`);
  }

  const meetingId = defaultMeetingId(labId, companyId, turn);
  let conversation = (await loadConversation(deps.redisClient, labId, companyId, meetingId)) ?? newConversation(labId, companyId, turn, meetingId);

  // 【実装指示§35】既にOpening Briefが会話へ記録済みなら、それをそのまま返す（cache・§22・§23）。
  const existingOpeningBriefMessage = conversation.messages.find((m) => m.messageType === "OPENING_BRIEF");
  if (existingOpeningBriefMessage) {
    console.log(`${logPrefix} 既存のOpening Briefをキャッシュから返却`);
    return { status: 200, body: { available: true, cached: true, meetingId, message: existingOpeningBriefMessage } };
  }

  // 【実装指示§35】既にPlayerが先に質問している場合、後からOpening Briefを割り込ませない。
  if (conversation.messages.length > 0) {
    console.log(`${logPrefix} 会話は既にPlayerメッセージを含むため、Opening Briefは生成しない`);
    return { status: 200, body: { available: false, cached: false, meetingId, unavailableReason: "この会話は既にプレイヤーの発言を含むため、Opening Briefは後から割り込みません。" } };
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
        periodLabel: (() => {
          const period = viewModel.previousQuarterFinancials?.period;
          if (!period) return null;
          const yq = toYearQuarter(period as never);
          return `${yq.year}年Q${yq.quarter}`;
        })(),
      }
    : null;

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

  // 【M2.3/M2.4と同じ既存パターンを再利用】直近2四半期ぶんの実績取得（新しい永続化経路は追加しない）。
  async function loadQuarterSnapshot(targetTurn: number): Promise<
    | (TurnChangeQuarterSnapshot & {
        readonly pnl: ProfitAndLossStatement;
        readonly cashFlow: CashFlowStatement;
        readonly balanceSheet: BalanceSheet;
        readonly summary: CompanyQuarterSummary;
        readonly workerAssignments: readonly WorkerAssignment[];
        readonly productionEntries: readonly ProductionAllocationEntry[];
      })
    | null
  > {
    if (targetTurn < 1) return null;
    try {
      const entry = await deps.repository.loadHistoryEntry(labId, targetTurn);
      const financialResult = entry.record.financialResults.find((f) => f.companyId === companyId);
      const summary = entry.record.companySummaries.find((s) => s.companyId === companyId);
      if (!financialResult || !summary) return null;
      const yq = toYearQuarter(entry.period as never);
      const decision = entry.record.decisions.find((d) => d.companyId === companyId);
      const financingResult = entry.record.financingResults.find((f) => f.companyId === companyId);
      return {
        pnl: financialResult.profitAndLoss,
        cashFlow: financialResult.cashFlow,
        balanceSheet: financialResult.balanceSheet,
        periodLabel: `${yq.year}年Q${yq.quarter}`,
        period: entry.period,
        fulfilledQuantityTons: Number(summary.fulfilledQuantity),
        summary,
        workerAssignments: decision?.workerAssignments ?? [],
        productionEntries: entry.record.productionAllocation.entries.filter((e) => e.companyId === companyId),
        borrowingHeadroomUsd: financingResult ? financingResult.borrowingCapacity.availableAdditionalCapacityUsd : null,
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
    contracts: viewModel.ownState.contracts,
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

  // 【実装指示§2・§25】前々turnも確定済み（turn>=3）ならTurnChangeBriefing（差分）、
  // そうでなければInitial Brief（現在位置のみ、turn1・turn2）。
  const turnChangeBriefing =
    reportingPeriodSnapshot && priorPeriodSnapshot
      ? buildTurnChangeBriefing({
          runId: labId,
          companyId,
          fromTurn: viewModel.currentTurn - 2,
          toTurn: viewModel.currentTurn - 1,
          current: reportingPeriodSnapshot,
          previous: priorPeriodSnapshot,
          capexProjects: viewModel.ownState.capexState.portfolio.projects,
          currentCapacityPools: buildCapacityPools(
            context.ownState.factoryCapacity,
            context.ownState.productionCapacitySummary.bindingTotalTons,
            context.ownState.productionCapacitySummary.bindingConstraintLabel
          ),
          currentSalesForceHeadcount: context.ownState.salesForce.headcountTotal,
        })
      : null;
  const initialBriefFacts = turnChangeBriefing ? null : buildInitialBriefFacts(briefing);

  // 【M2.6と同じ既存パターンを再利用】Run Advisory Memoryの読み込み。
  const memoryNow = new Date().toISOString();
  let runMemories: readonly RunAdvisoryMemoryRecord[] = [];
  try {
    const loadedMemories = await loadRunMemories(deps.redisClient, labId, companyId);
    runMemories = expireRunMemories(loadedMemories, viewModel.currentTurn, memoryNow);
  } catch (e) {
    console.error(`${logPrefix} Run Advisory Memoryの読み込みに失敗（memoryなしで継続します）:`, e instanceof Error ? e.message : String(e));
    runMemories = [];
  }
  const runAdvisoryMemorySummary = buildRunAdvisoryMemorySummary(runMemories);

  const userMessage = buildOpeningBriefUserMessage({
    turnChangeBriefing,
    initialBriefFacts,
    standardAiDecisionSummary: { decision: diagnostics.decision, topReasonCodes: diagnostics.entries.slice(0, 8).map((e) => e.code) },
    runAdvisoryMemory: runAdvisoryMemorySummary,
  });

  const generated = await generateOpeningBrief(userMessage, anthropicClient, { labId, companyId, turn });

  if (!generated.ok) {
    // 【実装指示§38・AMM-TCB-16】Claude呼び出し失敗時も例外を投げず、ゲーム状態・会話ともに変更しない。
    console.log(`${logPrefix} Claude呼び出し失敗 category=${generated.errorCategory}`);
    return {
      status: 200,
      body: {
        available: false,
        cached: false,
        meetingId,
        // 【Opening Brief Japanese Output Enforcement】fallback文言はprompt.tsの
        // 共有定数（simulation-runs経路と同一）を使う（AMM-LANG-5）。
        unavailableReason: OPENING_BRIEF_UNAVAILABLE_REASON_JA,
        diagnostics: generated.diagnostics,
      },
    };
  }

  const response = generated.response;
  const factsUsed = Array.from(new Set(response.keyChanges.flatMap((k) => k.factsUsed)));
  const generatedAt = new Date().toISOString();
  const openingBrief: OpeningExecutiveBrief = {
    turn,
    speaker: "CEO",
    summary: response.summary,
    keyChanges: response.keyChanges,
    suggestedFollowUps: response.suggestedFollowUps,
    factsUsed,
    memoryUsedIds: response.memoryUsedIds,
    generatedAt,
    promptVersion: OPENING_BRIEF_PROMPT_VERSION,
    briefingVersion: EXECUTIVE_BRIEFING_VERSION,
    turnChangeBriefingVersion: turnChangeBriefing?.turnChangeBriefingVersion ?? null,
  };

  const openingBriefMessage: AiMeetingMessage = {
    id: randomUUID(),
    speaker: "CEO",
    text: response.summary,
    turn,
    proposalIds: [],
    factsUsed,
    promptVersion: OPENING_BRIEF_PROMPT_VERSION,
    messageType: "OPENING_BRIEF",
  };

  conversation = appendMessages(conversation, [openingBriefMessage], {});
  try {
    await saveConversation(deps.redisClient, conversation);
  } catch (e) {
    console.error(`${logPrefix} 会話保存に失敗（応答はそのまま返します）:`, e instanceof Error ? e.message : String(e));
  }

  console.log(`${logPrefix} 完了 keyChanges=${response.keyChanges.length} suggestedFollowUps=${response.suggestedFollowUps.length}`);
  return {
    status: 200,
    body: { available: true, cached: false, meetingId, openingBrief, diagnostics: generated.diagnostics },
  };
}
