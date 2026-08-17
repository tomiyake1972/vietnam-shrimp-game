// ShrimpX V2 — AI Management Meeting: Claude呼び出し（AMM-M0/M1）
//
// 【既存Claude client（aiExplanation/claudeClient.ts）の再利用】この機能専用の新しい
// Anthropic接続経路は作らない。トランスポート層の型（AnthropicMessagesClient・
// AnthropicToolDefinition・AnthropicMessageResponse）とタイムアウト/リトライ定数
// （EXPLANATION_CLAUDE_TIMEOUT_MS・EXPLANATION_CLAUDE_MAX_RETRIES）をそのまま
// importして使う。ドメイン層（prompt・schema・briefing）は別モジュールのまま分離する
// （実装指示§9「reuse API client/transport layer only, not prompt/template, keep
// domain layer separate」に対応）。createRealClient自体はaiExplanation側の非公開関数
// のため、同じ構築パターン（buildAnthropicClientOptions）をここでも1回だけ呼び出す形で
// 再現する（クライアント接続方法を新規に増やすわけではない）。
//
// 【三宅さんの追加指示（Claude API Capacity / Schema Stability）への対応】
// 過去のAI Explanation機能で実際に発生した「maxTokens=1200 → stop_reason=max_tokens →
// schema_mismatch → retry」という既知の障害パターン（aiExplanation/claudeClient.ts
// 199-236行目のコメント参照）を、この機能で再発させないための設計:
//   1. maxTokensは、この機能の出力上限（responses最大3件・各1-5文、proposals最大3件、
//      factsUsed等の短い配列）から見て安全な値（AI_MEETING_MAX_OUTPUT_TOKENS、
//      aiExplanation機能で実績のある4096を踏襲）を使い、固定で小さくしない。
//   2. response.stop_reason==="max_tokens"を明示的に検知し、failureCauseとして
//      MAX_TOKENS_TRUNCATIONをschema_mismatch/invalid_jsonとは別ラベルで記録する
//      （diagnostics.schemaValidationResultへ"max_tokens_truncation"として反映）。
//   3. 合計リトライは最大1回（attempt最大2回）。retry stormを起こさない。
//   4. 毎callの診断（model/inputTokens/outputTokens/stopReason/latencyMs/retryCount/
//      schemaValidationResult）を必ず返す（呼び出し側がログ・分析に使える）。

import Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicClientOptions,
  AnthropicMessageResponse,
  AnthropicMessagesClient,
  AnthropicToolDefinition,
  EXPLANATION_CLAUDE_MAX_RETRIES,
  EXPLANATION_CLAUDE_TIMEOUT_MS,
} from "../aiExplanation/claudeClient";
import { AI_MANAGEMENT_MEETING_SYSTEM_PROMPT } from "./prompt";
import { aiMeetingStructuredResponseSchema, AI_MEETING_PROPOSAL_LIMITS } from "./proposalSchema";
import { AiMeetingCallDiagnostics, AiMeetingStructuredResponse } from "./types";

export type { AnthropicMessagesClient, AnthropicMessageResponse } from "../aiExplanation/claudeClient";

const DEFAULT_AI_MEETING_MODEL = "claude-haiku-4-5-20251001";

/**
 * MVPの出力上限（responses<=3件・各短文、proposals<=3件・factsUsed<=6件等）から
 * 見て、aiExplanation機能で実績のある4096トークンを踏襲する（1200のような小さい
 * 固定値には絶対に戻さない。aiExplanation/claudeClient.ts 199-236行目の既知障害を
 * 参照）。環境変数で個別に上書き可能。
 */
const AI_MEETING_MAX_OUTPUT_TOKENS = 4096;

export interface AiMeetingModelConfig {
  readonly model: string;
  readonly maxTokens: number;
}

export function getMeetingModelConfig(): AiMeetingModelConfig {
  return {
    model: process.env.AI_MANAGEMENT_MEETING_MODEL ?? DEFAULT_AI_MEETING_MODEL,
    maxTokens: AI_MEETING_MAX_OUTPUT_TOKENS,
  };
}

export const AI_MEETING_TOOL_NAME = "submit_meeting_response";

const ROLE_ENUM = ["CEO", "CFO", "COO", "COMMERCIAL"] as const;
const STANCE_ENUM = ["SUPPORT", "CAUTION", "OPPOSE", "ALTERNATIVE", "INFORMATIONAL"] as const;
const INTENT_ENUM = ["GROW_AGGRESSIVELY", "PROTECT_CASH", "REDUCE_BACKLOG", "PRIORITIZE_JAPAN", "DEFER_CAPEX", "CUSTOM"] as const;
const PROPOSAL_DOMAIN_ENUM = ["SALES", "PRODUCTION", "PROCUREMENT", "LABOR", "FINANCE", "CAPEX", "VAP_PRODUCT_DEVELOPMENT"] as const;
const STANDARD_AI_REF_STANCE_ENUM = ["SUPPORT", "MODIFY", "OPPOSE"] as const;
const PLAYER_CORRECTION_STATUS_ENUM = ["NOT_APPLICABLE", "CONFIRMED", "UNSUPPORTED"] as const;

/**
 * 【三宅さんの追加指示§7・§13】スキーマは意図的にフラットな構造にする（proposalの
 * domain別フィールドをoneOf/discriminated unionで深くネストさせず、1つのフラットな
 * objectへ全フィールドをoptionalとして並べる）。深いネストや巨大なfree-form arrayを
 * 避けつつ、tool定義自体のinput tokenも抑える。domain別の必須フィールドの区別は
 * description文言とprompt本文、および受信後のZod discriminated union検証
 * （proposalSchema.ts）の二段構えで担保する。
 */
export const AI_MEETING_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    primarySpeaker: { type: "string", enum: ROLE_ENUM, description: "主担当のExecutive。" },
    responses: {
      type: "array",
      minItems: 1,
      maxItems: AI_MEETING_PROPOSAL_LIMITS.maxResponses,
      description: `発言の配列。最大${AI_MEETING_PROPOSAL_LIMITS.maxResponses}件（primary必須＋secondary最大1件＋CEO summary）。各発言は簡潔に（主担当2-5文、secondary1-4文、CEO summary2-4文）。`,
      items: {
        type: "object",
        properties: {
          speaker: { type: "string", enum: ROLE_ENUM },
          text: { type: "string", description: "この発言の本文（簡潔に）。" },
          stance: { type: "string", enum: STANCE_ENUM },
          proposalIds: { type: "array", items: { type: "string" }, maxItems: AI_MEETING_PROPOSAL_LIMITS.maxProposals },
          factsUsed: {
            type: "array",
            items: { type: "string" },
            maxItems: AI_MEETING_PROPOSAL_LIMITS.maxFactsUsedPerResponse,
            description: '使用したExecutiveBriefingPacketの事実キー（例: "cash.current"）。',
          },
          standardAiReferences: {
            type: "array",
            maxItems: AI_MEETING_PROPOSAL_LIMITS.maxStandardAiReferencesPerResponse,
            items: {
              type: "object",
              properties: {
                reasonCode: { type: "string" },
                targetFactoryId: { type: "string" },
                targetProduct: { type: "string", enum: ["hoso", "pd", "vap"] },
                stance: { type: "string", enum: STANDARD_AI_REF_STANCE_ENUM },
                note: { type: "string" },
              },
              required: ["reasonCode", "stance", "note"],
            },
          },
        },
        required: ["speaker", "text", "proposalIds", "factsUsed", "standardAiReferences"],
      },
    },
    requiresCeoSummary: { type: "boolean" },
    proposals: {
      type: "array",
      maxItems: AI_MEETING_PROPOSAL_LIMITS.maxProposals,
      description:
        "具体的な差分提案（無ければ空配列）。domainごとに使うフィールドが異なる（下記参照）。" +
        "【重要】domain=SALESは、営業人員(salesForceHeadcount)が市場単位で共有される一方、" +
        "販売数量(desiredQuantityTons)・価格調整(priceAdjustmentUsdPerHosoEqKg)は" +
        "market×product単位という非対称な粒度である。そのためscopeで区別すること: " +
        "scope=MARKET_PRODUCTはmarket・productが必須でsalesForceHeadcountは含めない。" +
        "scope=MARKETはmarketとsalesForceHeadcountのみでproductは含めない" +
        "（「日本向けPDに営業を3人追加」のような商品単位の営業人員配置は実在しない。" +
        "営業人員を増やす提案は必ずscope=MARKETで、市場全体に対して行うこと）。",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          domain: { type: "string", enum: PROPOSAL_DOMAIN_ENUM },
          rationale: { type: "string" },
          scope: {
            type: "string",
            enum: ["MARKET_PRODUCT", "MARKET"],
            description: "domain=SALESのみ必須。MARKET_PRODUCT=販売数量/価格（market×product単位）、MARKET=営業人員（market単位）。",
          },
          // SALES: market必須（両scope共通）。product/factoryはPRODUCTIONとも共用。
          market: { type: "string", enum: ["CN", "US", "EU", "JP", "OTHER"], description: "domain=SALESのみ必須（両scope共通）。" },
          product: { type: "string", enum: ["hoso", "pd", "vap"], description: "domain=SALES(scope=MARKET_PRODUCTのみ)/PRODUCTIONで必須。scope=MARKETでは指定しないこと。" },
          desiredQuantityTons: { type: "number", description: "domain=SALES(scope=MARKET_PRODUCT)/PRODUCTIONで使用。" },
          priceAdjustmentUsdPerHosoEqKg: { type: "number", description: "domain=SALES(scope=MARKET_PRODUCT)で使用。" },
          salesForceHeadcount: { type: "number", description: "domain=SALES(scope=MARKETのみ)で使用。市場全体の営業人員数（商品別ではない）。" },
          factoryId: { type: "string", description: "domain=PRODUCTION/LABORのみ必須。" },
          priority: { type: "number" },
          channel: { type: "string", enum: ["DOMESTIC", "IMPORT"], description: "domain=PROCUREMENTのみ必須。" },
          originCountry: { type: "string" },
          procurementHeadcount: { type: "number" },
          regularHeadcountDelta: { type: "number" },
          temporaryHeadcountDelta: { type: "number" },
          overtimeRate: { type: "number" },
          desiredAmountUsd: { type: "number" },
          desiredTermQuarters: { type: "number" },
          desiredPrepaymentUsd: { type: "number" },
          projectType: {
            type: "string",
            enum: [
              "hosoLineExpansion",
              "pdLineExpansion",
              "vapLineExpansion",
              "coldStorageExpansion",
              "qualityControlEquipment",
              "environmentalEquipment",
              "commonProcessingExpansion",
              "freezingPackagingExpansion",
              "newFactoryConstruction",
              "pdMechanization",
            ],
            description: "domain=CAPEXのみ必須。実在するCAPEX種別のみ。",
          },
          requestedBudgetUsd: { type: "number" },
          targetFactoryId: { type: "string" },
          spendTierUsd: { type: "number", description: "domain=VAP_PRODUCT_DEVELOPMENTのみ必須。" },
        },
        required: ["id", "domain", "rationale"],
      },
    },
    meetingIntent: { type: "string", enum: INTENT_ENUM },
    potentialStrategicChange: { type: "boolean" },
    potentialStrategicChangeNote: { type: "string" },
    playerCorrectionStatus: {
      type: "string",
      enum: PLAYER_CORRECTION_STATUS_ENUM,
      description:
        "プレイヤーの今回の発言がゲーム事実に関する主張・訂正を含む場合、それがExecutiveBriefingPacketと" +
        "整合すればCONFIRMED、根拠が無ければUNSUPPORTED、事実主張ではない場合はNOT_APPLICABLE。",
    },
    playerCorrectionNote: { type: "string" },
  },
  required: ["primarySpeaker", "responses", "requiresCeoSummary", "proposals", "meetingIntent", "potentialStrategicChange", "playerCorrectionStatus"],
} as const;

export type GenerateMeetingResponseErrorCategory = "missing_api_key" | "http_error" | "invalid_json" | "schema_mismatch" | "empty_response" | "network_error";

export type GenerateMeetingResponseResult =
  | { readonly ok: true; readonly response: AiMeetingStructuredResponse; readonly diagnostics: AiMeetingCallDiagnostics }
  | { readonly ok: false; readonly errorCategory: GenerateMeetingResponseErrorCategory; readonly detail?: string; readonly diagnostics: AiMeetingCallDiagnostics };

function buildClientOptions(apiKey: string): AnthropicClientOptions {
  // 【既存定数の再利用】EXPLANATION_CLAUDE_TIMEOUT_MS(40秒)・EXPLANATION_CLAUDE_MAX_RETRIES(0)を
  // そのまま踏襲する（新しいtimeout/retryポリシーを個別に発明しない）。
  return { apiKey, timeout: EXPLANATION_CLAUDE_TIMEOUT_MS, maxRetries: EXPLANATION_CLAUDE_MAX_RETRIES };
}

function createRealMeetingClient(apiKey: string): AnthropicMessagesClient {
  return new Anthropic(buildClientOptions(apiKey)) as unknown as AnthropicMessagesClient;
}

function findToolUseInput(response: AnthropicMessageResponse): unknown | undefined {
  const block = response.content.find((b) => b.type === "tool_use");
  return block?.input;
}

interface AttemptResult {
  readonly diagnostics: AiMeetingCallDiagnostics;
  readonly ok: boolean;
  readonly response?: AiMeetingStructuredResponse;
  readonly errorCategory?: GenerateMeetingResponseErrorCategory;
  readonly detail?: string;
}

async function attemptOnce(
  client: AnthropicMessagesClient,
  config: AiMeetingModelConfig,
  userMessage: string,
  attemptNumber: number,
  logPrefix: string
): Promise<AttemptResult> {
  const startedAt = Date.now();
  const toolDef: AnthropicToolDefinition = {
    name: AI_MEETING_TOOL_NAME,
    description: "AI Management Meetingの構造化応答（primary/secondary発言・CEO summary要否・提案・意図）を提出する。",
    input_schema: AI_MEETING_TOOL_INPUT_SCHEMA,
  };

  let response: AnthropicMessageResponse;
  try {
    response = await client.messages.create(
      {
        model: config.model,
        max_tokens: config.maxTokens,
        system: AI_MANAGEMENT_MEETING_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        tools: [toolDef],
        tool_choice: { type: "tool", name: AI_MEETING_TOOL_NAME },
      },
      { timeout: EXPLANATION_CLAUDE_TIMEOUT_MS }
    );
  } catch (e) {
    const status = typeof e === "object" && e !== null && "status" in e ? (e as { status?: unknown }).status : undefined;
    const detail = e instanceof Error ? e.message : String(e);
    const errorCategory: GenerateMeetingResponseErrorCategory = typeof status === "number" ? "http_error" : "network_error";
    const latencyMs = Date.now() - startedAt;
    console.error(`${logPrefix} attempt${attemptNumber} 失敗 category=${errorCategory} latencyMs=${latencyMs} detail=${detail}`);
    return {
      ok: false,
      errorCategory,
      detail,
      diagnostics: {
        model: config.model,
        inputTokens: null,
        outputTokens: null,
        stopReason: null,
        latencyMs,
        retryCount: attemptNumber - 1,
        schemaValidationResult: errorCategory,
      },
    };
  }

  const latencyMs = Date.now() - startedAt;
  const stopReason = response.stop_reason ?? null;
  const truncated = stopReason === "max_tokens";
  const inputTokens = response.usage?.input_tokens ?? null;
  const outputTokens = response.usage?.output_tokens ?? null;

  const toolInput = findToolUseInput(response);
  if (toolInput === undefined) {
    // 【max_tokensとschema_mismatchの区別】tool_useブロックが無いのが打ち切りによるものか、
    // 単にtool呼び出しをしなかったのかをstopReasonで明示的に区別してログへ出す。
    const category: GenerateMeetingResponseErrorCategory = "invalid_json";
    console.error(
      `${logPrefix} attempt${attemptNumber} tool_useブロックなし stopReason=${stopReason ?? "(なし)"} truncated=${truncated} ` +
        `inputTokens=${inputTokens ?? "(不明)"} outputTokens=${outputTokens ?? "(不明)"} latencyMs=${latencyMs}`
    );
    return {
      ok: false,
      errorCategory: category,
      diagnostics: {
        model: config.model,
        inputTokens,
        outputTokens,
        stopReason,
        latencyMs,
        retryCount: attemptNumber - 1,
        schemaValidationResult: truncated ? "max_tokens_truncation" : "empty_response",
      },
    };
  }

  const validated = aiMeetingStructuredResponseSchema.safeParse(toolInput);
  if (!validated.success) {
    console.error(
      `${logPrefix} attempt${attemptNumber} スキーマ不一致 stopReason=${stopReason ?? "(なし)"} truncated=${truncated} ` +
        `inputTokens=${inputTokens ?? "(不明)"} outputTokens=${outputTokens ?? "(不明)"} latencyMs=${latencyMs} issues=${validated.error.issues.length}件`
    );
    return {
      ok: false,
      errorCategory: "schema_mismatch",
      detail: validated.error.message,
      diagnostics: {
        model: config.model,
        inputTokens,
        outputTokens,
        stopReason,
        latencyMs,
        retryCount: attemptNumber - 1,
        // 【区別の要点】truncated=trueならmax_tokens起因、falseなら純粋なmodelのスキーマ逸脱。
        schemaValidationResult: truncated ? "max_tokens_truncation" : "schema_mismatch",
      },
    };
  }

  console.log(
    `${logPrefix} attempt${attemptNumber} 成功 stopReason=${stopReason ?? "(なし)"} inputTokens=${inputTokens ?? "(不明)"} ` +
      `outputTokens=${outputTokens ?? "(不明)"} latencyMs=${latencyMs}`
  );
  return {
    ok: true,
    response: validated.data as AiMeetingStructuredResponse,
    diagnostics: {
      model: config.model,
      inputTokens,
      outputTokens,
      stopReason,
      latencyMs,
      retryCount: attemptNumber - 1,
      schemaValidationResult: "ok",
    },
  };
}

/**
 * AI Management MeetingのClaude呼び出し本体。
 *
 * リトライ方針（三宅さんの追加指示§4・§5）: invalid_json/schema_mismatch/
 * empty_response（max_tokens truncation由来を含む）のいずれかで最初の試行が
 * 失敗した場合、同一入力でちょうど1回だけ再試行する（合計最大2回のAPI呼び出し、
 * retry storm禁止）。http_error/network_errorは再試行しない
 * （aiExplanation/claudeClient.tsと同じ方針）。
 */
export async function generateMeetingResponse(
  userMessage: string,
  client?: AnthropicMessagesClient,
  logContext?: { readonly labId: string; readonly companyId: string; readonly turn: number }
): Promise<GenerateMeetingResponseResult> {
  const logPrefix = `[aiManagementMeeting/claudeClient] lab=${logContext?.labId ?? "?"} company=${logContext?.companyId ?? "?"} turn=${logContext?.turn ?? "?"}`;

  let resolvedClient = client;
  if (!resolvedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.trim().length === 0) {
      console.error(`${logPrefix} ANTHROPIC_API_KEY未設定`);
      return {
        ok: false,
        errorCategory: "missing_api_key",
        diagnostics: {
          model: getMeetingModelConfig().model,
          inputTokens: null,
          outputTokens: null,
          stopReason: null,
          latencyMs: 0,
          retryCount: 0,
          schemaValidationResult: "missing_api_key",
        },
      };
    }
    resolvedClient = createRealMeetingClient(apiKey);
  }

  const config = getMeetingModelConfig();
  const first = await attemptOnce(resolvedClient, config, userMessage, 1, logPrefix);
  if (first.ok) return { ok: true, response: first.response!, diagnostics: first.diagnostics };
  if (first.errorCategory === "http_error" || first.errorCategory === "network_error") {
    return { ok: false, errorCategory: first.errorCategory, detail: first.detail, diagnostics: first.diagnostics };
  }

  const second = await attemptOnce(resolvedClient, config, userMessage, 2, logPrefix);
  if (second.ok) return { ok: true, response: second.response!, diagnostics: second.diagnostics };
  return { ok: false, errorCategory: second.errorCategory!, detail: second.detail, diagnostics: second.diagnostics };
}
