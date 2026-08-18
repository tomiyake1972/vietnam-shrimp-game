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
import { AnthropicMessagesClient, generateMeetingResponse, generateOpeningBrief } from "./claudeClient";
import {
  BorrowingHeadroomFact,
  buildExecutiveBriefingPacket,
  BriefingBuildInput,
  CrisisFact,
  EXECUTIVE_BRIEFING_VERSION,
  PlayerDraftSummary,
  PreviousQuarterDelta,
} from "./briefing";
import { buildCapacityPools } from "./capacitySemantics";
import { buildInitialBriefFacts, buildTurnChangeBriefing, TurnChangeQuarterSnapshot } from "./turnChangeBriefing";
import { AiMeetingNewsItem } from "./scenarioNews";
import { routePlayerMessage } from "./router";
import { buildMeetingUserMessage, buildOpeningBriefUserMessage, OPENING_BRIEF_PROMPT_VERSION, OPENING_BRIEF_UNAVAILABLE_REASON_JA } from "./prompt";
import { appendMessages, buildRecentHistoryForPrompt, defaultMeetingId, loadConversation, newConversation, saveConversation } from "./conversation";
import { validateAiMeetingProposals } from "./validation";
import { AiMeetingMessage, ExecutiveRole, OpeningExecutiveBrief, RunAdvisoryMemoryRecord } from "./types";
import { findOverdueWordingViolations } from "./dueWordingGuard";
import {
  applyCandidate,
  buildRunAdvisoryMemorySummary,
  confirmMemoryCandidate,
  expireRunMemories,
  loadRunMemories,
  saveRunMemories,
} from "./runAdvisoryMemory";

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
  /**
   * 【M2.7配線】Opening Executive Brief の Turn Change Briefing（前々期→前期の差分）
   * 組み立てに使う、確定済み四半期スナップショット2件。runAiMeetingTurn（通常の会議）
   * では使わないため任意。呼び出し側が既に financialHistory / operationalHistory を
   * 作るために持っている値をそのまま渡すだけで、新しい取得経路は増やさない。
   */
  readonly reportingPeriodSnapshot?: TurnChangeQuarterSnapshot | null;
  readonly priorPeriodSnapshot?: TurnChangeQuarterSnapshot | null;
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

  // 【M2.6配線・Fast Track統合】Run Advisory Memoryの読み込み。company-labs handler.tsと
  // 同じ共通関数（loadRunMemories / expireRunMemories / buildRunAdvisoryMemorySummary）を
  // そのまま使う（新しいbusiness logicは作らない）。名前空間キーはcontextIdであり、
  // Simulation Run経路では simulationRunContextId() が付ける "simrun:<runId>" になるため、
  // 別Runのmemoryが混ざることは構造的に起きない。読み込み失敗時もAI Meetingそのものは
  // 停止せず、memoryなしで会話継続する（Game stateは絶対に変更しない設計と同じ耐障害方針）。
  const memoryNow = new Date().toISOString();
  let runMemories: readonly RunAdvisoryMemoryRecord[] = [];
  try {
    const loaded = await loadRunMemories(redisClient, contextId, companyId);
    runMemories = expireRunMemories(loaded, snapshot.currentTurn, memoryNow);
  } catch (e) {
    console.error(`${logPrefix} Run Advisory Memoryの読み込みに失敗（memoryなしで継続します）:`, e instanceof Error ? e.message : String(e));
    runMemories = [];
  }
  const runAdvisoryMemorySummary = buildRunAdvisoryMemorySummary(runMemories);

  const userMessage = buildMeetingUserMessage({
    briefing,
    standardAiDecisionSummary: { decision: snapshot.diagnostics.decision, topReasonCodes: snapshot.diagnostics.entries.slice(0, 8).map((e) => e.code) },
    recentHistory: recent.map((m) => ({ speaker: m.speaker, text: m.text })),
    compactSummary,
    playerMessage,
    routingHint: routing,
    meetingIntentHint: conversation.lastMeetingIntent,
    confirmedCorrections: conversation.confirmedCorrections.map((c) => c.note),
    // 【M2.5配線】通常のcallではnull。overdue語彙違反検知時のみ、下でrepair呼び出しに使う。
    repairNote: null,
    runAdvisoryMemory: runAdvisoryMemorySummary,
  });

  let generated = await generateMeetingResponse(userMessage, anthropicClient, { labId: contextId, companyId, turn });

  // 【M2.5配線・Fast Track統合】overdueがほぼ0なのに応答へ遅延語彙が出た場合、
  // 最大1回だけ同一入力＋repair指示で再呼び出しする（company-labs handler.tsと同一手順・
  // 同一共通関数 findOverdueWordingViolations を使用。新しい判定ロジックは作らない）。
  let semanticGuardResult: "not_applicable" | "ok" | "repaired" | "violation_after_repair" = "not_applicable";
  if (generated.ok) {
    const violations = findOverdueWordingViolations(
      generated.response.responses.map((r) => r.text),
      briefing.common.backlog.overdueTons
    );
    semanticGuardResult = violations.length === 0 ? "ok" : "violation_after_repair";
    if (violations.length > 0) {
      console.log(`${logPrefix} overdue語彙違反を検知 violations=${violations.join(",")} repairを1回試行します`);
      const repairUserMessage = buildMeetingUserMessage({
        briefing,
        standardAiDecisionSummary: { decision: snapshot.diagnostics.decision, topReasonCodes: snapshot.diagnostics.entries.slice(0, 8).map((e) => e.code) },
        recentHistory: recent.map((m) => ({ speaker: m.speaker, text: m.text })),
        compactSummary,
        playerMessage,
        routingHint: routing,
        meetingIntentHint: conversation.lastMeetingIntent,
        confirmedCorrections: conversation.confirmedCorrections.map((c) => c.note),
        repairNote:
          `直前の回答に、納期遅延を示す表現（${violations.join("・")}）が含まれていました。` +
          "しかし現在のoverdue（納期超過）は0トンです。未出荷の受注残は将来納期であり、遅延ではありません。表現を訂正して回答し直してください。",
        runAdvisoryMemory: runAdvisoryMemorySummary,
      });
      const repaired = await generateMeetingResponse(repairUserMessage, anthropicClient, { labId: contextId, companyId, turn });
      if (repaired.ok) {
        const remainingViolations = findOverdueWordingViolations(
          repaired.response.responses.map((r) => r.text),
          briefing.common.backlog.overdueTons
        );
        generated = repaired;
        semanticGuardResult = remainingViolations.length === 0 ? "repaired" : "violation_after_repair";
      } else {
        // repair呼び出し自体が失敗した場合は、元のgenerated（違反を含む）をそのまま使う
        semanticGuardResult = "violation_after_repair";
      }
    }
  }

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

  // 【M2.6配線・Fast Track統合】memoryCandidatesのserver-side validation・confirmation・
  // 永続化。AIに保存可否を最終決定させない。company-labs handler.tsと同一の共通関数
  // （confirmMemoryCandidate / applyCandidate / saveRunMemories）をそのまま使う。
  // Redis書き込み失敗時もAI Meeting応答そのものは既に確定しているため、ここでの失敗は
  // 握りつぶしログのみ残す（Game stateは絶対に変更しない設計と同じ耐障害方針）。
  if (response.memoryCandidates.length > 0) {
    let updatedMemories = runMemories;
    for (const candidate of response.memoryCandidates) {
      const confirmation = confirmMemoryCandidate(candidate, { backlogStatus: briefing.common.backlog.status });
      const applied = applyCandidate(
        candidate,
        confirmation.finalType,
        confirmation.verificationStatus,
        { runId: contextId, companyId, currentTurn: snapshot.currentTurn, sourceMessageId: playerMsg.id, existingRecords: updatedMemories },
        memoryNow
      );
      updatedMemories = applied.records;
      if (applied.skippedReason) {
        console.log(`${logPrefix} memory候補を保存しませんでした reason=${applied.skippedReason} topic=${candidate.topic} type=${candidate.type}`);
      }
    }
    if (updatedMemories !== runMemories) {
      try {
        await saveRunMemories(redisClient, contextId, companyId, updatedMemories);
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
      // 【M2.6配線】応答の根拠として使ったmemoryのid（factsUsedとは分離）。
      memoryUsedIds: response.memoryUsedIds,
      available: true,
      diagnostics: { ...generated.diagnostics, semanticGuardResult },
    },
  };
}

/**
 * 【M2.7配線・Fast Track統合】Opening Executive Brief を1回ぶん生成する。
 *
 * company-labs 経路の handleGetOpeningBrief と同じ手順・同じ共通関数
 * （buildTurnChangeBriefing / buildInitialBriefFacts / buildOpeningBriefUserMessage /
 * generateOpeningBrief）をそのまま使う。違いは「会社状態をどこから読んだか」だけで、
 * それは呼び出し側が AiMeetingCompanySnapshot として渡す責務（runAiMeetingTurn と同じ設計）。
 *
 * - cache（§22・§23）: 同一turnの会話に既にOPENING_BRIEFがあればClaudeを呼ばずに返す。
 * - 割り込み禁止（§35）: 会話が既にメッセージを含む場合は生成しない。
 * - ゲーム状態は一切変更しない（書き込みは conversation artifact のみ）。
 */
export async function runOpeningBrief(input: {
  readonly redisClient: CompanyLabRedisClient;
  readonly snapshot: AiMeetingCompanySnapshot;
  readonly requestedTurn: number;
  readonly anthropicClient?: AnthropicMessagesClient;
}): Promise<AiMeetingApiResult> {
  const { redisClient, snapshot, requestedTurn, anthropicClient } = input;
  const { contextId, companyId } = snapshot;
  const logPrefix = `[ai-meeting runOpeningBrief] context=${contextId} company=${companyId} turn=${requestedTurn}`;
  console.log(`${logPrefix} 開始`);

  if (!Number.isInteger(requestedTurn) || requestedTurn < 1) {
    return badRequest("turn は1以上の整数である必要があります。");
  }
  if (requestedTurn !== snapshot.currentTurn) {
    return notFound(`現在のturnは${snapshot.currentTurn}です。turn ${requestedTurn}のOpening Briefは対象外です。`);
  }
  const turn = requestedTurn;

  const meetingId = defaultMeetingId(contextId, companyId, turn);
  let conversation = (await loadConversation(redisClient, contextId, companyId, meetingId)) ?? newConversation(contextId, companyId, turn, meetingId);

  const existingOpeningBriefMessage = conversation.messages.find((m) => m.messageType === "OPENING_BRIEF");
  if (existingOpeningBriefMessage) {
    console.log(`${logPrefix} 既存のOpening Briefをキャッシュから返却`);
    return { status: 200, body: { available: true, cached: true, meetingId, message: existingOpeningBriefMessage } };
  }
  if (conversation.messages.length > 0) {
    console.log(`${logPrefix} 会話は既にPlayerメッセージを含むため、Opening Briefは生成しない`);
    return {
      status: 200,
      body: { available: false, cached: false, meetingId, unavailableReason: "この会話は既にプレイヤーの発言を含むため、Opening Briefは後から割り込みません。" },
    };
  }

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

  const reportingPeriodSnapshot = snapshot.reportingPeriodSnapshot ?? null;
  const priorPeriodSnapshot = snapshot.priorPeriodSnapshot ?? null;
  const turnChangeBriefing =
    reportingPeriodSnapshot && priorPeriodSnapshot
      ? buildTurnChangeBriefing({
          runId: contextId,
          companyId,
          fromTurn: snapshot.currentTurn - 2,
          toTurn: snapshot.currentTurn - 1,
          current: reportingPeriodSnapshot,
          previous: priorPeriodSnapshot,
          capexProjects: snapshot.capexProjects,
          currentCapacityPools: buildCapacityPools(
            context.ownState.factoryCapacity,
            context.ownState.productionCapacitySummary.bindingTotalTons,
            context.ownState.productionCapacitySummary.bindingConstraintLabel
          ),
          currentSalesForceHeadcount: context.ownState.salesForce.headcountTotal,
        })
      : null;
  const initialBriefFacts = turnChangeBriefing ? null : buildInitialBriefFacts(briefing);

  const memoryNow = new Date().toISOString();
  let runMemories: readonly RunAdvisoryMemoryRecord[] = [];
  try {
    const loadedMemories = await loadRunMemories(redisClient, contextId, companyId);
    runMemories = expireRunMemories(loadedMemories, snapshot.currentTurn, memoryNow);
  } catch (e) {
    console.error(`${logPrefix} Run Advisory Memoryの読み込みに失敗（memoryなしで継続します）:`, e instanceof Error ? e.message : String(e));
    runMemories = [];
  }

  const userMessage = buildOpeningBriefUserMessage({
    turnChangeBriefing,
    initialBriefFacts,
    standardAiDecisionSummary: { decision: snapshot.diagnostics.decision, topReasonCodes: snapshot.diagnostics.entries.slice(0, 8).map((e) => e.code) },
    runAdvisoryMemory: buildRunAdvisoryMemorySummary(runMemories),
  });

  const generated = await generateOpeningBrief(userMessage, anthropicClient, { labId: contextId, companyId, turn });
  if (!generated.ok) {
    console.log(`${logPrefix} Claude呼び出し失敗 category=${generated.errorCategory}`);
    return {
      status: 200,
      body: {
        available: false,
        cached: false,
        meetingId,
        // 【Opening Brief Japanese Output Enforcement】fallback文言はprompt.tsの
        // 共有定数（company-labs経路と同一）を使う（AMM-LANG-5）。
        unavailableReason: OPENING_BRIEF_UNAVAILABLE_REASON_JA,
        diagnostics: generated.diagnostics,
      },
    };
  }

  const response = generated.response;
  const factsUsed = Array.from(new Set(response.keyChanges.flatMap((k) => k.factsUsed)));
  const openingBrief: OpeningExecutiveBrief = {
    turn,
    speaker: "CEO",
    summary: response.summary,
    keyChanges: response.keyChanges,
    suggestedFollowUps: response.suggestedFollowUps,
    factsUsed,
    memoryUsedIds: response.memoryUsedIds,
    generatedAt: new Date().toISOString(),
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
    await saveConversation(redisClient, conversation);
  } catch (e) {
    console.error(`${logPrefix} 会話保存に失敗（応答はそのまま返します）:`, e instanceof Error ? e.message : String(e));
  }

  console.log(`${logPrefix} 完了 keyChanges=${response.keyChanges.length} suggestedFollowUps=${response.suggestedFollowUps.length}`);
  return { status: 200, body: { available: true, cached: false, meetingId, openingBrief, diagnostics: generated.diagnostics } };
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
