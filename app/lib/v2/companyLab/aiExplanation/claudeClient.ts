// ShrimpX V2 — Standard AI経営説明レポート機能 Anthropic APIラッパー（MVP）
//
// 【安全境界】このモジュールはClaudeに意思決定権限を一切与えない。渡すのは
// buildExplanationContext.tsが組み立てたALLOWLIST済みのExplanationContext
// （JSON文字列としてユーザーメッセージへそのまま入れるだけ）であり、システム
// プロンプトは固定文字列（systemPrompt.ts）のみを使う。応答は必ず
// reportSchema.tsのZodスキーマで検証してから呼び出し側へ返す。
//
// 【モデル名の一元管理】このファイルの getExplanationModelConfig() が、この機能に
// おけるモデル名のハードコードの唯一の場所である。他のファイルはモデル名を
// 直接書かず、必ずこの関数を経由すること。
//
// 【APIキーの扱い】process.env.ANTHROPIC_API_KEYが未設定・空文字の場合は例外を
// 投げず missing_api_key を返す。キーの値そのものは、ログ・戻り値・エラー詳細
// のいずれにも一切含めない。
//
// 【タイムアウト（2026-08-01・本番Preview手動観察テストで発生した無限ローディングの
// 事後対応）】Anthropic SDKの既定タイムアウトは10分と非常に長く、Vercelの
// サーバーレス関数・ブラウザの実用的な待ち時間を大きく超える。ネットワーク経路が
// 詰まった場合に「エラーにすらならず無言で長時間ハングする」ことを防ぐため、
// クライアント生成時・各呼び出し時の両方に明示的なタイムアウトを設定する
// （SDKのRequestOptions.timeout / signal機能を使う。指示: 「Anthropic SDKのtimeout
// オプションまたはAbortController経由で明示的なタイムアウトを追加する」）。

import Anthropic from "@anthropic-ai/sdk";
import { STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V1 } from "./systemPrompt";
import { StandardAiManagementReport, standardAiManagementReportSchema } from "./reportSchema";
import { ExplanationContext } from "./buildExplanationContext";

/**
 * Claude呼び出し1回あたりの明示的なタイムアウト（ミリ秒）。SDKの既定（10分）は
 * 長すぎるため、クライアント構築時・各呼び出し時の両方でこの値を指定する。
 */
export const EXPLANATION_CLAUDE_TIMEOUT_MS = 25_000;

export interface ExplanationModelConfig {
  readonly model: string;
  readonly maxTokens: number;
}

const DEFAULT_EXPLANATION_MODEL = "claude-sonnet-4-6";

/**
 * このAI経営説明機能で使うモデル名・最大トークン数の唯一の定義箇所。
 * 環境変数 STANDARD_AI_EXPLANATION_MODEL で上書き可能（未指定時は既定モデル）。
 */
export function getExplanationModelConfig(): ExplanationModelConfig {
  return {
    model: process.env.STANDARD_AI_EXPLANATION_MODEL ?? DEFAULT_EXPLANATION_MODEL,
    maxTokens: 1200,
  };
}

export type GenerateManagementReportErrorCategory =
  | "missing_api_key"
  | "http_error"
  | "invalid_json"
  | "schema_mismatch"
  | "empty_response"
  | "network_error";

export interface GenerateManagementReportUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly model: string;
}

export type GenerateManagementReportResult =
  | { readonly ok: true; readonly report: StandardAiManagementReport; readonly usage: GenerateManagementReportUsage }
  | { readonly ok: false; readonly errorCategory: GenerateManagementReportErrorCategory; readonly detail?: string };

/**
 * Anthropic Messages APIを実際に叩くクライアントの最小インターフェース。
 * テストではこれをモックする（実SDKクライアントをnewせずに済むようにするため、
 * generateManagementReportへ注入可能にしてある）。
 */
export interface AnthropicMessagesClient {
  messages: {
    create(
      params: {
        model: string;
        max_tokens: number;
        system: string;
        messages: readonly { role: "user"; content: string }[];
      },
      // 【タイムアウト対応】第2引数はSDKのRequestOptions相当（timeout/signal等）。
      // テスト用モックはこの引数を無視して構わない（関数型の構造的部分型では、
      // 実装側の受け取りパラメータ数が呼び出し側より少なくても代入可能なため）。
      options?: { readonly timeout?: number; readonly signal?: AbortSignal }
    ): Promise<AnthropicMessageResponse>;
  };
}

export interface AnthropicMessageResponse {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

function createRealClient(apiKey: string): AnthropicMessagesClient {
  // 【タイムアウト対応】クライアント構築時にも既定タイムアウトを短縮しておく
  // （呼び出し側のper-request timeoutと二重に設定しておくことで、どちらか片方の
  // 指定漏れがあっても10分ハングへ戻らないようにする多重防御）。
  return new Anthropic({ apiKey, timeout: EXPLANATION_CLAUDE_TIMEOUT_MS }) as unknown as AnthropicMessagesClient;
}

function extractResponseText(response: AnthropicMessageResponse): string {
  return response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

interface SingleAttemptResult {
  readonly kind: "success"; readonly report: StandardAiManagementReport; readonly usage: GenerateManagementReportUsage;
}
interface SingleAttemptFailure {
  readonly kind: "failure"; readonly errorCategory: GenerateManagementReportErrorCategory; readonly detail?: string;
}

/** ログの識別用（labId/companyId/turn程度。秘密情報・本文は一切含めない）。 */
interface AttemptLogTag {
  readonly labId: string;
  readonly companyId: string;
  readonly turn: number;
  readonly attempt: 1 | 2;
}

async function attemptOnce(
  client: AnthropicMessagesClient,
  context: ExplanationContext,
  config: ExplanationModelConfig,
  logTag: AttemptLogTag
): Promise<SingleAttemptResult | SingleAttemptFailure> {
  const startedAt = Date.now();
  console.log(
    `[claudeClient] attempt ${logTag.attempt} 開始 lab=${logTag.labId} company=${logTag.companyId} turn=${logTag.turn} model=${config.model} timeoutMs=${EXPLANATION_CLAUDE_TIMEOUT_MS}`
  );
  let response: AnthropicMessageResponse;
  try {
    response = await client.messages.create(
      {
        model: config.model,
        max_tokens: config.maxTokens,
        system: STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V1,
        messages: [{ role: "user", content: JSON.stringify(context) }],
      },
      // 【タイムアウト対応】per-request指定（クライアント構築時の既定値と二重防御）。
      { timeout: EXPLANATION_CLAUDE_TIMEOUT_MS }
    );
  } catch (e) {
    // Anthropic SDKはHTTPエラーとネットワークエラー（タイムアウトを含む）で別クラスを
    // 投げる。ここではAPIキー等の機微情報が例外メッセージに含まれないことを前提に、
    // 大まかに分類するのみとし、詳細メッセージも「キーを含みうる生ヘッダー」は含めない
    // （SDKの例外メッセージ自体がヘッダー内容を含まないことを前提にしている）。
    const status = typeof e === "object" && e !== null && "status" in e ? (e as { status?: unknown }).status : undefined;
    const detail = e instanceof Error ? e.message : String(e);
    const errorCategory: GenerateManagementReportErrorCategory = typeof status === "number" ? "http_error" : "network_error";
    console.error(
      `[claudeClient] attempt ${logTag.attempt} 失敗 lab=${logTag.labId} company=${logTag.companyId} turn=${logTag.turn} category=${errorCategory} elapsedMs=${Date.now() - startedAt}`
    );
    return { kind: "failure", errorCategory, detail };
  }

  const latencyMs = Date.now() - startedAt;
  console.log(
    `[claudeClient] attempt ${logTag.attempt} 応答受信 lab=${logTag.labId} company=${logTag.companyId} turn=${logTag.turn} latencyMs=${latencyMs}`
  );
  const text = extractResponseText(response);
  if (!text || text.trim().length === 0) {
    console.error(`[claudeClient] attempt ${logTag.attempt} 空応答 lab=${logTag.labId} company=${logTag.companyId} turn=${logTag.turn}`);
    return { kind: "failure", errorCategory: "empty_response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error(`[claudeClient] attempt ${logTag.attempt} JSON解析失敗 lab=${logTag.labId} company=${logTag.companyId} turn=${logTag.turn}`);
    return { kind: "failure", errorCategory: "invalid_json", detail: e instanceof Error ? e.message : String(e) };
  }

  const validated = standardAiManagementReportSchema.safeParse(parsed);
  if (!validated.success) {
    console.error(`[claudeClient] attempt ${logTag.attempt} スキーマ不一致 lab=${logTag.labId} company=${logTag.companyId} turn=${logTag.turn}`);
    return { kind: "failure", errorCategory: "schema_mismatch", detail: validated.error.message };
  }

  console.log(
    `[claudeClient] attempt ${logTag.attempt} 成功 lab=${logTag.labId} company=${logTag.companyId} turn=${logTag.turn} inputTokens=${response.usage?.input_tokens ?? 0} outputTokens=${response.usage?.output_tokens ?? 0}`
  );
  return {
    kind: "success",
    report: validated.data,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      latencyMs,
      model: config.model,
    },
  };
}

/**
 * Standard AIの診断・提案から、経営者向け説明レポートを生成する。
 *
 * リトライ方針: JSONパース失敗・スキーマ不一致・空応答のいずれかで最初の試行が
 * 失敗した場合、同一の入力でちょうど1回だけ再試行する（合計最大2回のAPI呼び出し）。
 * http_error・network_error（＝APIそのものに到達できない/拒否された場合）は
 * 再試行せず、その場で失敗として返す。
 *
 * @param client 省略時は実際のAnthropic SDKクライアントを ANTHROPIC_API_KEY で生成する。
 *   テストではモックを注入すること。
 */
export async function generateManagementReport(
  context: ExplanationContext,
  client?: AnthropicMessagesClient
): Promise<GenerateManagementReportResult> {
  let resolvedClient = client;
  if (!resolvedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.trim().length === 0) {
      console.error(
        `[claudeClient] ANTHROPIC_API_KEY未設定 lab=${context.identity.labId} company=${context.identity.companyId} turn=${context.identity.turn}`
      );
      return { ok: false, errorCategory: "missing_api_key" };
    }
    resolvedClient = createRealClient(apiKey);
  }

  const config = getExplanationModelConfig();
  const logBase = { labId: context.identity.labId, companyId: context.identity.companyId, turn: context.identity.turn };

  const first = await attemptOnce(resolvedClient, context, config, { ...logBase, attempt: 1 });
  if (first.kind === "success") {
    return { ok: true, report: first.report, usage: first.usage };
  }
  if (first.errorCategory === "http_error" || first.errorCategory === "network_error") {
    return { ok: false, errorCategory: first.errorCategory, detail: first.detail };
  }

  // invalid_json / schema_mismatch / empty_response のみ、ちょうど1回だけ再試行する。
  const second = await attemptOnce(resolvedClient, context, config, { ...logBase, attempt: 2 });
  if (second.kind === "success") {
    return { ok: true, report: second.report, usage: second.usage };
  }
  return { ok: false, errorCategory: second.errorCategory, detail: second.detail };
}
