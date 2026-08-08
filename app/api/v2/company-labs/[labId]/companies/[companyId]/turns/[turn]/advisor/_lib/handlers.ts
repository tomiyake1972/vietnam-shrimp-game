// ShrimpX V2 — 相談役AI（Management Advisor AI）MVP  APIハンドラー本体
//
// 【既存経路の再利用】状態の読み込み・ExplanationContextの組み立て・turn/companyIdの
// 妥当性判定は、ai-explanation の resolveRequestContext をそのまま再利用する。
// 認証・依存関係も既存の withAiExplanationApiContext / AiExplanationApiDependencies を使う。
// 新しい状態読み込み経路・新しいRedis接続経路は作らない。
//
// 【read-only（実装指示§48）】このハンドラーはゲーム状態・draft・Standard AIの決定を
// 一切書き換えない。書き込むのは相談役AIの会話ログ（advisorConversation）だけである。

import { CompanyQuarterSummary } from "../../../../../../../../../../lib/v2/companyLab/types";
import { AiExplanationApiDependencies } from "../../ai-explanation/_lib/dependencies";
import { AiExplanationApiResult, resolveRequestContext } from "../../ai-explanation/_lib/handlers";
import { AnthropicMessagesClient } from "../../../../../../../../../../lib/v2/companyLab/aiExplanation/claudeClient";
import {
  ADVISOR_MAX_HISTORY_TURNS,
  ADVISOR_MAX_QUESTION_LENGTH,
  generateAdvisorAnswer,
  getAdvisorModelConfig,
  getAdvisorModelDisplayName,
} from "../../../../../../../../../../lib/v2/companyLab/advisorAi/advisorClient";
import {
  AdvisorCurrentViewContext,
  buildAdvisorContext,
  computeAdvisorContextHash,
} from "../../../../../../../../../../lib/v2/companyLab/advisorAi/buildAdvisorContext";
import {
  buildAdvisorLiveGameState,
  buildAdvisorStandardAiState,
  FinancialResultLike,
} from "../../../../../../../../../../lib/v2/companyLab/advisorAi/gameState/advisorGameState";
import {
  getCurrentImplementation,
  getDevelopmentRationale,
  getFormalSpecification,
} from "../../../../../../../../../../lib/v2/companyLab/advisorAi/knowledge/retrieval";
import { planRetrieval } from "../../../../../../../../../../lib/v2/companyLab/advisorAi/questionRouting";
import {
  AdvisorConversation,
  AdvisorStoredMessage,
  clearAdvisorConversation,
  createEmptyConversation,
  extractAnswerMetadata,
  loadAdvisorConversation,
  saveAdvisorConversation,
  toHistoryTurns,
} from "../../../../../../../../../../lib/v2/companyLab/advisorAi/conversationStore";

function badRequest(message: string): AiExplanationApiResult {
  return { status: 400, body: { error: { code: "INVALID_REQUEST", message } } };
}

const CURRENT_VIEW_CONTEXTS: readonly AdvisorCurrentViewContext[] = [
  "sales",
  "procurement",
  "production",
  "labor",
  "finance",
  "capex",
  "pl",
  "bs",
  "standard_ai_proposal",
  "unknown",
];

export interface AdvisorRequestBody {
  readonly question?: unknown;
  /** 【実装指示§7】今見ている画面。MVPではoptional。 */
  readonly currentViewContext?: unknown;
  /** 【品質強化Batch 1・§18】1回の送信を識別するID。二重送信の判定に使う。 */
  readonly requestId?: unknown;
}

/** requestIdの最大長。ログとRedisへ入るため、無制限の文字列を受け取らない。 */
const MAX_REQUEST_ID_LENGTH = 64;

interface ParsedAdvisorRequest {
  readonly question: string;
  readonly view: AdvisorCurrentViewContext;
  /** クライアントが送ってきたID。無ければnull（＝二重送信判定を行わない）。 */
  readonly requestId: string | null;
}

function parseQuestion(
  body: unknown
): { readonly ok: true; readonly value: ParsedAdvisorRequest } | { readonly ok: false; readonly result: AiExplanationApiResult } {
  if (body === null || typeof body !== "object") return { ok: false, result: badRequest("リクエストボディが不正です。") };
  const b = body as AdvisorRequestBody;
  if (typeof b.question !== "string") return { ok: false, result: badRequest("question は文字列である必要があります。") };
  const question = b.question.trim();
  if (question.length === 0) return { ok: false, result: badRequest("質問を入力してください。") };
  if (question.length > ADVISOR_MAX_QUESTION_LENGTH) {
    return { ok: false, result: badRequest(`質問は${ADVISOR_MAX_QUESTION_LENGTH}文字以内で入力してください。`) };
  }
  const view = CURRENT_VIEW_CONTEXTS.find((v) => v === b.currentViewContext) ?? "unknown";
  const rawRequestId = typeof b.requestId === "string" ? b.requestId.trim() : "";
  const requestId = rawRequestId.length > 0 && rawRequestId.length <= MAX_REQUEST_ID_LENGTH ? rawRequestId : null;
  return { ok: true, value: { question, view, requestId } };
}

/**
 * 【二重送信の合流（品質強化Batch 1・§18）】
 * 同一プロセス内で同じrequestIdの処理が走っている間は、2つ目以降の呼び出しを
 * 同じPromiseへ合流させる。ボタン連打・ネットワーク再送で同じ質問がClaudeへ
 * 2回投げられるのを防ぐ。
 *
 * 【限界の明示（推測で「防げます」と書かない）】Vercelのserverless関数は
 * インスタンスが複数ありうるため、この仕組みだけでは全ての重複は防げない。
 * インスタンスをまたぐ場合は、保存済み会話のlastSucceededRequestIdによる
 * 判定（下のhandlePostAdvisor冒頭）が効く。両者の併用でも「同時・別インスタンス」の
 * 重複だけは通りうる。これは既知の残課題として記録しておく。
 */
const inFlightAdvisorRequests = new Map<string, Promise<AiExplanationApiResult>>();

/** 完了済みの成功回答を、保存済み会話からそのまま組み立て直す（Claudeを呼ばない）。 */
function replayStoredAnswer(conversation: AdvisorConversation): AiExplanationApiResult | null {
  const last = conversation.messages[conversation.messages.length - 1];
  if (!last || last.role !== "advisor" || !last.answer) return null;
  return {
    status: 200,
    body: {
      result: "success",
      answer: last.answer,
      conversationId: conversation.conversationId,
      category: last.category,
      contextHash: last.contextHash,
      model: last.model,
      generatedAt: last.timestamp,
      /** 同じrequestIdの再送だったため、保存済みの回答を返したことの明示。 */
      deduplicated: true,
    },
  };
}

/**
 * 前四半期の確定記録から、他社サマリー（Owner Modeのみ）を取り出す。
 * 【新しい状態読み込み経路を作らない】既存のrepository.loadLatestHistoryEntry を使うだけ。
 * 取得に失敗した場合はnullとし、値を捏造しない。
 */
async function loadCompetitorSummaries(
  deps: AiExplanationApiDependencies,
  labId: string
): Promise<readonly CompanyQuarterSummary[] | null> {
  try {
    const entry = await deps.repository.loadLatestHistoryEntry(labId);
    return entry?.record.companySummaries ?? null;
  } catch (e) {
    console.error(`[advisor] 他社サマリーの取得に失敗しました（含めずに続行） lab=${labId}:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * POST: 相談役AIへ1件の質問を投げ、回答を得る。
 * 失敗しても例外を投げず、必ず構造化された結果を返す（Explanation層と同じ方針）。
 */
export async function handlePostAdvisor(
  deps: AiExplanationApiDependencies,
  labId: string,
  companyId: string,
  turnParam: string,
  body: unknown,
  now: string,
  anthropicClient?: AnthropicMessagesClient
): Promise<AiExplanationApiResult> {
  const parsed = parseQuestion(body);
  if (!parsed.ok) return parsed.result;
  const { requestId } = parsed.value;

  if (requestId === null) {
    return runAdvisorRequest(deps, labId, companyId, turnParam, parsed.value, now, anthropicClient);
  }

  const key = `${labId}:${companyId}:${requestId}`;
  const existing = inFlightAdvisorRequests.get(key);
  if (existing) {
    console.log(`[advisor handlePost] 同一requestIdの処理中に合流しました lab=${labId} requestId=${requestId}`);
    return existing;
  }
  const promise = runAdvisorRequest(deps, labId, companyId, turnParam, parsed.value, now, anthropicClient).finally(() => {
    inFlightAdvisorRequests.delete(key);
  });
  inFlightAdvisorRequests.set(key, promise);
  return promise;
}

async function runAdvisorRequest(
  deps: AiExplanationApiDependencies,
  labId: string,
  companyId: string,
  turnParam: string,
  parsed: ParsedAdvisorRequest,
  now: string,
  anthropicClient?: AnthropicMessagesClient
): Promise<AiExplanationApiResult> {
  const logPrefix = `[advisor handlePost] lab=${labId} company=${companyId} turn=${turnParam}`;

  const resolved = await resolveRequestContext(deps, labId, companyId, turnParam);
  if (resolved.kind === "error") {
    console.log(`${logPrefix} resolveRequestContextでエラー応答 status=${resolved.result.status}`);
    return resolved.result;
  }
  const { viewModel, diagnostics, context: observed } = resolved.value;

  // 【実装指示§39】質問の分類から、必要な情報層だけを決める（毎回全部を詰め込まない）。
  const plan = planRetrieval(parsed.question, { ownerMode: true });

  const competitorSummaries = plan.includeCompetitorAndInternal ? await loadCompetitorSummaries(deps, labId) : null;

  const liveGameState = buildAdvisorLiveGameState({
    observed,
    currentFinancials: (viewModel.lastQuarterResult?.financialResult ?? null) as FinancialResultLike | null,
    previousFinancials: (viewModel.previousQuarterFinancials?.financialResult ?? null) as FinancialResultLike | null,
    recentHistory: viewModel.recentHistory.map((h) => ({
      turn: h.turn,
      period: h.period,
      summary: `turn ${h.turn}（${h.period}）処理済み`,
    })),
    competitorSummaries,
    playerCompanyId: viewModel.playerCompanyId,
    include: {
      financials: plan.includeFinancialStatements,
      history: true,
      competitors: plan.includeCompetitorAndInternal,
    },
  });

  const standardAiState = buildAdvisorStandardAiState(observed, diagnostics);

  // 【実装指示§16】開発文書全文をpromptへ入れず、質問に応じた抜粋だけを取得する。
  const formalSpecification = plan.includeFormalSpecification ? getFormalSpecification(plan.documentQuery, { limit: 5 }) : null;
  // 【品質強化Batch 1・§9】sourcePolicyが最上位に置く「現行実装」を実際に引く。
  const currentImplementation = plan.includeCurrentImplementation ? getCurrentImplementation(plan.documentQuery) : null;
  const developmentKnowledge = plan.includeDevelopmentKnowledge
    ? getDevelopmentRationale(plan.documentQuery, { limit: 6, includeHistorical: plan.includeHistoricalDocuments })
    : null;

  const context = buildAdvisorContext({
    labId: viewModel.labId,
    companyId: viewModel.playerCompanyId,
    turn: viewModel.currentTurn,
    year: observed.identity.year,
    quarter: observed.identity.quarter,
    scenarioId: viewModel.scenarioId,
    currentViewContext: parsed.view,
    liveGameState,
    standardAiState,
    formalSpecification,
    currentImplementation,
    developmentKnowledge,
    retrievalPlan: plan,
  });
  const contextHash = computeAdvisorContextHash(context);

  // 会話履歴の読み込み（失敗しても新規会話として続行する）。
  const existing = await loadAdvisorConversation(deps.redisClient, labId, companyId);
  const conversation: AdvisorConversation = existing ?? createEmptyConversation(labId, companyId, viewModel.currentTurn, now);

  // 【二重送信（§18）】直前に成功した同じrequestIdなら、Claudeを呼ばずに保存済み回答を返す。
  // 失敗したrequestIdは記録していないため、再送ボタンは常に本当に再実行される（§20）。
  if (parsed.requestId !== null && conversation.lastSucceededRequestId === parsed.requestId) {
    const replayed = replayStoredAnswer(conversation);
    if (replayed !== null) {
      console.log(`${logPrefix} 同一requestIdの再送のため保存済み回答を返しました requestId=${parsed.requestId}`);
      return replayed;
    }
  }

  const history = toHistoryTurns(conversation, ADVISOR_MAX_HISTORY_TURNS);

  // questionIdはログ追跡専用の識別子。クライアントのrequestIdがあればそれを使い、
  // 無ければcontextHashの先頭から作る（質問文そのものはログへ残さない）。
  const questionId = parsed.requestId ?? `ctx-${contextHash.slice(0, 12)}`;

  const generated = await generateAdvisorAnswer(
    { context, question: parsed.question, history, contextHash, questionId },
    anthropicClient
  );

  const userMessage: AdvisorStoredMessage = {
    role: "user",
    message: parsed.question,
    turn: viewModel.currentTurn,
    timestamp: now,
  };

  if (!generated.ok) {
    console.log(`${logPrefix} 失敗として応答 category=${generated.errorCategory}`);
    // 失敗も分析対象として残す（どんな質問で失敗したかを後から見られるようにする）。
    await saveAdvisorConversation(deps.redisClient, {
      ...conversation,
      updatedAt: now,
      messages: [
        ...conversation.messages,
        userMessage,
        {
          role: "advisor",
          message: "",
          turn: viewModel.currentTurn,
          timestamp: now,
          category: plan.category,
          contextHash,
          model: getAdvisorModelConfig().model,
          errorCategory: generated.errorCategory,
        },
      ],
    });
    return {
      status: 200,
      body: { result: "failure", errorCategory: generated.errorCategory, conversationId: conversation.conversationId },
    };
  }

  const meta = extractAnswerMetadata(generated.answer);
  const advisorMessage: AdvisorStoredMessage = {
    role: "advisor",
    message: generated.answer.answer,
    turn: viewModel.currentTurn,
    timestamp: now,
    category: plan.category,
    sourceTypesUsed: meta.sourceTypesUsed,
    sourceDocuments: meta.sourceDocuments,
    relatedReasonCodes: generated.answer.relatedReasonCodes,
    contextHash,
    model: generated.usage.model,
    answer: generated.answer,
  };

  const updated: AdvisorConversation = {
    ...conversation,
    updatedAt: now,
    messages: [...conversation.messages, userMessage, advisorMessage],
    // 成功したときだけIDを記録する（失敗はキャッシュしない。§20）。
    ...(parsed.requestId !== null ? { lastSucceededRequestId: parsed.requestId } : {}),
  };
  await saveAdvisorConversation(deps.redisClient, updated);

  console.log(
    `${logPrefix} 成功 questionId=${questionId} category=${plan.category} retryCount=${generated.retryCount} ` +
      `stripped=${generated.strippedFabricatedReferences === true} ` +
      `fabricatedReasonCodes=${generated.grounding.fabricatedReasonCodes.length} ` +
      `sourceDocs=${meta.sourceDocuments.length} reasonCodes=${generated.answer.relatedReasonCodes.length}`
  );

  return {
    status: 200,
    body: {
      result: "success",
      answer: generated.answer,
      conversationId: updated.conversationId,
      category: plan.category,
      contextHash,
      model: generated.usage.model,
      generatedAt: now,
    },
  };
}

/** GET: 保存済みの会話を返す（リロード・close→reopenでの復元用。副作用なし）。 */
export async function handleGetAdvisorConversation(
  deps: AiExplanationApiDependencies,
  labId: string,
  companyId: string,
  turnParam: string
): Promise<AiExplanationApiResult> {
  const resolved = await resolveRequestContext(deps, labId, companyId, turnParam);
  if (resolved.kind === "error") return resolved.result;

  const conversation = await loadAdvisorConversation(deps.redisClient, labId, companyId);
  return {
    status: 200,
    body: {
      result: "success",
      conversation: conversation ?? null,
      currentTurn: resolved.value.viewModel.currentTurn,
      companyId: resolved.value.viewModel.playerCompanyId,
      // 【実装指示§15】現在使われているモデルを確認できるようにする。
      // model identifier全文ではなく人間向けの表示名を返す。
      modelDisplayName: getAdvisorModelDisplayName(),
    },
  };
}

/** DELETE: 会話を消す（実装指示§36）。確認UIはクライアント側の責務。 */
export async function handleDeleteAdvisorConversation(
  deps: AiExplanationApiDependencies,
  labId: string,
  companyId: string,
  turnParam: string,
  now: string
): Promise<AiExplanationApiResult> {
  const resolved = await resolveRequestContext(deps, labId, companyId, turnParam);
  if (resolved.kind === "error") return resolved.result;

  const fresh = await clearAdvisorConversation(deps.redisClient, labId, companyId, resolved.value.viewModel.currentTurn, now);
  return { status: 200, body: { result: "success", conversation: fresh } };
}
