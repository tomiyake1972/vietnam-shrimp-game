// ShrimpX V2 — AI Management Meeting API ハンドラー本体（Company Lab 経路）
//
// フレームワーク非依存の純粋な非同期関数（既存ai-explanation/_lib/handlers.tsと同じ設計方針）。
// 【対応範囲の限定】ai-explanationと同じ理由（loadPlayerScreenViewModelがプレイヤー会社1社・
// 現在turnぶんの状態しか返さない）で、companyId・turnはプレイヤー会社・現在turnと一致する
// 場合のみ対応する。
//
// 【会議ロジックはここに持たない】Executive Briefing Packetの組み立て・Claude呼び出し・
// 会話履歴の更新・提案のvalidationは aiManagementMeeting/session.ts の runAiMeetingTurn が
// 一手に持つ。このファイルの責務は「Company Lab（Redis上のLab）から会社状態を読み、
// AiMeetingCompanySnapshot へ詰め替える」ことだけ。Management Console の Simulation Run
// 経路（simulation-runs/.../ai-meeting）も同じ runAiMeetingTurn を呼ぶため、会議ロジックが
// 2系統へ分岐することはない。
//
// 【ゲーム状態を一切変更しない】このハンドラーはCompanyDecisionDraftやCompanyLabStateへの
// 書き込みを一切行わない（読み取り専用の入力からClaude応答を生成し、会話artifactへのみ
// 書き込む）。Claude呼び出しが失敗しても、Standard AIのdraft・ゲームセッションは
// 一切影響を受けない（実装指示§53「Claude failure must never stop the game」に対応）。

import { loadPlayerScreenViewModel, PlayerScreenViewModel } from "../../../../../../../../../../../v2/company-lab/play/_lib/viewModel";
import { generateStandardAiDecisionWithDiagnostics, StandardAiQuarterDiagnostics } from "../../../../../../../../../../../lib/v2/companyLab/standardAi/policy";
import { AnthropicMessagesClient } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/claudeClient";
import { PlayerDraftSummary } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/briefing";
import { buildAiMeetingScenarioNews } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/scenarioNews";
import {
  AiMeetingApiResult,
  AiMeetingCompanySnapshot,
  loadAiMeetingConversation,
  runAiMeetingTurn,
} from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/session";
import { resolveScenarioDefinition } from "../../../../../../../../../../../lib/v2/industryLab/cli/scenarioAliases";
import { AiMeetingApiDependencies } from "./dependencies";

export type { AiMeetingApiResult } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/session";

function notFound(message: string): AiMeetingApiResult {
  return { status: 404, body: { error: { code: "NOT_FOUND", message } } };
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
 * POST: プレイヤー発言を受け取り、Company Lab の現在状態から会議1回ぶんを実行する。
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
  const loaded = await loadPlayerScreenViewModel(deps, labId);
  if (loaded.kind === "notFound") {
    return notFound(`会社ラボ "${labId}" が見つかりません。`);
  }
  const viewModel = loaded.viewModel;

  if (viewModel.playerCompanyId !== companyId) {
    return notFound(`会社 "${companyId}" は、この会社ラボのAI Management Meetingの対象外です（プレイヤー会社のみ対応）。`);
  }

  const diagnostics: StandardAiQuarterDiagnostics =
    viewModel.aiProposalDiagnostics ??
    generateStandardAiDecisionWithDiagnostics(viewModel.fixture, viewModel.ownState, viewModel.publicInfo, viewModel.period, viewModel.currentTurn).diagnostics;

  const previousFinancialResult = viewModel.previousQuarterFinancials?.financialResult ?? null;

  const snapshot: AiMeetingCompanySnapshot = {
    contextId: viewModel.labId,
    companyId: viewModel.playerCompanyId,
    currentTurn: viewModel.currentTurn,
    scenarioId: viewModel.scenarioId,
    period: viewModel.period,
    fixture: viewModel.fixture,
    ownState: viewModel.ownState,
    publicInfo: viewModel.publicInfo,
    diagnostics,
    previousQuarter: previousFinancialResult
      ? {
          cashUsd: Number(previousFinancialResult.balanceSheet.cash),
          netRevenueUsd: Number(previousFinancialResult.profitAndLoss.netRevenue),
          operatingProfitUsd: Number(previousFinancialResult.profitAndLoss.operatingProfit),
        }
      : null,
    playerDraft: buildPlayerDraftSummary(viewModel),
    // Player画面（openingInfo.scenarioNews）と同じ getAvailableInformation を通すため、
    // 人間プレイヤーとAI役員が読めるNewsの集合は構造的に一致する。
    scenarioNews: buildAiMeetingScenarioNews(resolveScenarioDefinition(viewModel.scenarioId), viewModel.currentTurn),
  };

  return runAiMeetingTurn({
    redisClient: deps.redisClient,
    snapshot,
    requestedTurn: Number(turnParam),
    playerMessage: body.playerMessage,
    meetingId: body.meetingId,
    anthropicClient,
  });
}

/** GET: 読み取り専用。既存の会話状態（meetingId指定）を返す。副作用なし。 */
export async function handleGetAiMeetingConversation(
  deps: AiMeetingApiDependencies,
  labId: string,
  companyId: string,
  meetingIdParam: string
): Promise<AiMeetingApiResult> {
  return loadAiMeetingConversation(deps.redisClient, labId, companyId, meetingIdParam);
}
