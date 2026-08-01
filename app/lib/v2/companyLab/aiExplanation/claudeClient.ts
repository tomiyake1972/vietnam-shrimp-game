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
//
// 【構造化出力（2026-08-01・本番Preview手動観察テストで発見された invalid_json の
// 事後対応）】従来はプレーンテキスト応答に対して素朴にJSON.parseしていたが、Claudeが
// マークダウンのコードフェンス（```json ... ```）や前置きの文章を含めて返すことがあり、
// 初回・リトライの両方が同じ理由（invalid_json）で系統的に失敗する事例が実際に発生した
// （2回目の同一リトライでは直らない＝一時的な問題ではない）。対策として、プレーン
// テキスト応答をパースする方式をやめ、単一のtool定義（input_schemaがreportSchema.tsの
// Zodスキーマと同じ形）を渡し、tool_choiceでその呼び出しを強制する。Claudeの応答は
// 自由形式のテキストではなく、tool_use contentブロックのinput（SDKが既にJSONとして
// パース済みのオブジェクト）になるため、マークダウン装飾・前置き文章の混入自体が
// 構造的に発生しなくなる。なお、tool定義のinput_schema自体に取りこぼしがあった場合の
// 保険として、reportSchema.tsのZod検証は従来どおり維持する（多重防御。指示「tool-use
// guarantees valid JSON shape-wise per the schema you declare, but keep our own runtime
// Zod check as defense in depth」）。
//
// システムプロンプト文字列自体（STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V1）は一切変更
// しない（spec §3で一字一句固定と規定されているため）。tool定義は`system`とは独立した
// 別のリクエストパラメータ（`tools`/`tool_choice`）として追加するだけである。

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V1 } from "./systemPrompt";
import { StandardAiManagementReport, standardAiManagementReportSchema } from "./reportSchema";
import { ExplanationContext } from "./buildExplanationContext";

/**
 * Claudeにレポートを提出させるための唯一のtool名。tool_choiceでこの名前を強制指定する。
 */
export const EXPLANATION_REPORT_TOOL_NAME = "submit_management_report";

/**
 * reportSchema.tsのstandardAiManagementReportSchema（Zod）と同じ形のJSON Schema。
 * 【重複について】Zodスキーマから自動生成する仕組み（zod-to-json-schema等）は
 * 新規依存追加のコストに見合わないと判断し、この機能専用の小さな固定スキーマとして
 * 手書きする。reportSchema.ts側の形を変更した場合は、このJSON Schemaも合わせて
 * 更新すること（reportSchema.test.tsのテストが両者の食い違いを検出する）。
 */
const EXPLANATION_REPORT_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    executiveSummary: { type: "string" },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          area: { type: "string" },
          title: { type: "string" },
          action: { type: "string" },
          reasons: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                value: { type: "string" },
              },
              required: ["label", "value"],
            },
          },
        },
        required: ["area", "title", "action", "reasons"],
      },
    },
    keyRisks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["low", "medium", "high"] },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["severity", "title", "description"],
      },
    },
    questionsForPlayer: { type: "array", items: { type: "string" } },
    dataLimitations: { type: "array", items: { type: "string" } },
  },
  required: ["headline", "executiveSummary", "recommendations", "keyRisks", "questionsForPlayer", "dataLimitations"],
} as const;

/**
 * Claude呼び出し1回あたりの明示的なタイムアウト（ミリ秒）。SDKの既定（10分）は
 * 長すぎるため、クライアント構築時・各呼び出し時の両方でこの値を指定する。
 */
export const EXPLANATION_CLAUDE_TIMEOUT_MS = 25_000;

export interface ExplanationModelConfig {
  readonly model: string;
  readonly maxTokens: number;
}

// 【2026-08-01・三宅さんのご指示によりコスト最適化】経営説明はあくまで既存の
// Standard AI決定・診断ログを日本語へ言い換えるだけの用途（新しい判断・数値の
// 創作は禁止、出力もJSON tool_use経由で厳格にスキーマ検証される）であり、
// 高度な推論能力を必要としない。そのため既定モデルをSonnet系からHaiku系へ
// 変更し、1レポートあたりのトークン単価を抑える。品質に問題が出た場合は
// 環境変数STANDARD_AI_EXPLANATION_MODELで個別に上書きできる（コード変更不要）。
//
// 【2026-08-01・モデルID訂正】前回のclaude-haiku-4-6は実在しないモデルIDで、
// Anthropic ConsoleのHaiku 4.5カードから正確なAPI用モデルID文字列
// （claude-haiku-4-5-20251001）を確認・訂正した（三宅さんがConsole画面で確認）。
const DEFAULT_EXPLANATION_MODEL = "claude-haiku-4-5-20251001";

// 【2026-08-01・maxTokens不足によるschema_mismatchの確定と修正】三宅さんの実機
// Preview確認（Test14/BAL/turn1）で、schema_mismatchが起きたattempt1・attempt2の
// 両方でAnthropic応答のstop_reasonが"max_tokens"、usage.output_tokensがちょうど
// maxTokens設定値(1200)と一致していることをVercelランタイムログで確認した
// （headline・executiveSummaryの2フィールドを書いた時点で1200トークンを使い切り、
// recommendations/keyRisks/questionsForPlayer/dataLimitationsの4つの配列
// フィールドが丸ごと出力されずに応答が打ち切られていた）。推測ではなく実データで
// 「maxTokens不足による打ち切りが原因」と確定したため、既存レポート（8項目構成、
// recommendationsが複数件・reasonsを含む等）を最後まで出力しきれる余裕を持った
// 値へ引き上げる。claude-haiku-4-5-20251001の最大出力トークン数には十分収まる値。
const EXPLANATION_MAX_OUTPUT_TOKENS = 4096;

/**
 * このAI経営説明機能で使うモデル名・最大トークン数の唯一の定義箇所。
 * 環境変数 STANDARD_AI_EXPLANATION_MODEL で上書き可能（未指定時は既定モデル）。
 */
export function getExplanationModelConfig(): ExplanationModelConfig {
  return {
    model: process.env.STANDARD_AI_EXPLANATION_MODEL ?? DEFAULT_EXPLANATION_MODEL,
    maxTokens: EXPLANATION_MAX_OUTPUT_TOKENS,
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

/** tool_useを強制するためのtool定義（Anthropic Messages APIのTool型の最小部分集合）。 */
export interface AnthropicToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

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
        // 【構造化出力対応】単一のtool定義＋tool_choiceで、応答を必ずそのtool呼び出し
        // （＝input_schemaに沿ったオブジェクト）に強制する。
        tools?: readonly AnthropicToolDefinition[];
        tool_choice?: { readonly type: "tool"; readonly name: string };
      },
      // 【タイムアウト対応】第2引数はSDKのRequestOptions相当（timeout/signal等）。
      // テスト用モックはこの引数を無視して構わない（関数型の構造的部分型では、
      // 実装側の受け取りパラメータ数が呼び出し側より少なくても代入可能なため）。
      options?: { readonly timeout?: number; readonly signal?: AbortSignal }
    ): Promise<AnthropicMessageResponse>;
  };
}

export interface AnthropicMessageResponse {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
    /** type === "tool_use" のときだけ設定される。SDKが既にJSONとしてパース済みのオブジェクト。 */
    readonly input?: unknown;
  }[];
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  /**
   * 【2026-08-01・schema_mismatch原因確定のための追加】"max_tokens"ならmax_tokens設定値に
   * 達して応答が途中で打ち切られたことを意味する。実際のPreview環境で、headline/
   * executiveSummaryの2フィールドだけが埋まり、残り4つの配列フィールドが丸ごと欠落する
   * schema_mismatchが再現したため、「max_tokens不足による打ち切りが原因か」を推測でなく
   * この値で確定させる。
   */
  readonly stop_reason?: string | null;
}

function createRealClient(apiKey: string): AnthropicMessagesClient {
  // 【タイムアウト対応】クライアント構築時にも既定タイムアウトを短縮しておく
  // （呼び出し側のper-request timeoutと二重に設定しておくことで、どちらか片方の
  // 指定漏れがあっても10分ハングへ戻らないようにする多重防御）。
  return new Anthropic({ apiKey, timeout: EXPLANATION_CLAUDE_TIMEOUT_MS }) as unknown as AnthropicMessagesClient;
}

/** content配列から、tool_choiceで強制したtool呼び出しのtool_useブロックを探す。 */
function findToolUseInput(response: AnthropicMessageResponse): unknown | undefined {
  const block = response.content.find((b) => b.type === "tool_use");
  return block?.input;
}

/**
 * 【2026-08-01・schema_mismatch診断強化】これまでschema_mismatch発生時、Vercelログには
 * 「スキーマ不一致」というタグしか出ておらず、実際にどのfield・pathで何が起きたのかが
 * ログから一切分からなかった（validated.error.messageはGenerateManagementReportResultの
 * detailとして呼び出し元へ返ってはいたが、どこにもconsole.errorされていなかった）。
 * これではVercelランタイムログだけを見ても実データに基づく原因特定ができないため、
 * ZodErrorのissues配列から、安全に出せる情報（path・code・期待される型/enum・実際に
 * 受け取った型やenum値など、ゲームの本文・数値そのものではない構造情報）だけを
 * 抜き出してログへ出す。recommendations[3].reasons等の本文（headline/executiveSummary等の
 * 実際の文章）は一切ログに含めない。
 */
function summarizeZodIssuesForLog(error: z.ZodError): string {
  // 【zodのメジャーバージョン差異への耐性】issueの追加プロパティ名（expected/values/
  // minimum/maximum/keys等）はzodのバージョンによって異なり（例: v3のinvalid_enum_value
  // ＋optionsがv4ではinvalid_value＋valuesに変わっている）、型定義もcodeごとの判別
  // ユニオンで厳密である。そのためcode別にプロパティ名を決め打ちせず、既知のキー名だけを
  // Record<string, unknown>として緩く読み取る（存在しないキーはundefinedのまま無視）。
  // 値が文字列の場合は40文字までに切り詰め、万一将来のzodバージョンでissueオブジェクトに
  // Claudeの生成文そのものが含まれるようになった場合でも本文が丸ごと漏れないようにする。
  const KNOWN_KEYS = ["expected", "received", "values", "options", "keys", "minimum", "maximum", "origin"] as const;
  const issues = error.issues.slice(0, 10).map((issue) => {
    const raw = issue as unknown as Record<string, unknown>;
    const base: Record<string, unknown> = {
      path: issue.path.join(".") || "(root)",
      code: issue.code,
    };
    for (const key of KNOWN_KEYS) {
      const value = raw[key];
      if (value === undefined) continue;
      base[key] = typeof value === "string" && value.length > 40 ? `${value.slice(0, 40)}…` : value;
    }
    return base;
  });
  return JSON.stringify(issues);
}

/**
 * トップレベルのキー集合と値の型（本文そのものではない）だけを安全にログへ出すための
 * 要約。toolInputがオブジェクトでない場合はその旨だけを返す。
 */
function summarizeTopLevelShapeForLog(toolInput: unknown): string {
  if (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return JSON.stringify({ topLevelType: Array.isArray(toolInput) ? "array" : typeof toolInput });
  }
  const shape: Record<string, string> = {};
  for (const [key, value] of Object.entries(toolInput as Record<string, unknown>)) {
    shape[key] = Array.isArray(value) ? `array(${value.length})` : typeof value;
  }
  return JSON.stringify(shape);
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
        // 【構造化出力対応】システムプロンプト文字列自体は変更せず、tool定義と
        // tool_choiceだけを別パラメータとして追加し、応答をこのtool呼び出しに強制する。
        tools: [
          {
            name: EXPLANATION_REPORT_TOOL_NAME,
            description: "Standard AIの提案・診断情報を経営者向けに説明したレポートを提出する。",
            input_schema: EXPLANATION_REPORT_TOOL_INPUT_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: EXPLANATION_REPORT_TOOL_NAME },
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

  // 【構造化出力対応】tool_choiceで強制しているため、応答は自由形式のテキストではなく
  // tool_use contentブロックのinput（SDKが既にJSONとしてパース済みのオブジェクト）に
  // なるはずである。マークダウンのコードフェンス・前置き文章の混入によるJSON.parse失敗
  // （2026-08-01の手動観察テストで実際に発生した systematic な invalid_json）が
  // 構造的に起こらなくなる。
  const toolInput = findToolUseInput(response);
  if (toolInput === undefined) {
    // tool_choiceで強制したにもかかわらずtool_useブロックが無い（応答が空、またはテキスト
    // のみを返してきた等）。「JSONとしてすら解釈できる形で返ってこなかった」ことを
    // 引き続きinvalid_jsonとして分類する（呼び出し元の既存のリトライ・エラー分類方針を
    // 変えないため）。
    console.error(
      `[claudeClient] attempt ${logTag.attempt} tool_useブロックが見つかりません lab=${logTag.labId} company=${logTag.companyId} turn=${logTag.turn}`
    );
    return { kind: "failure", errorCategory: "invalid_json" };
  }

  // 【多重防御】tool_choiceで強制したtool呼び出しはinput_schemaに沿った形であるはずだが、
  // スキーマ宣言側の取りこぼし・SDKの将来的な仕様変化等に備え、reportSchema.tsの
  // Zod検証は引き続き必ず通す（「tool-useはshape的に保証するが、独自のZodチェックも
  // 多重防御として維持する」という方針）。
  const validated = standardAiManagementReportSchema.safeParse(toolInput);
  if (!validated.success) {
    // 【診断強化】本文（headline/executiveSummary等の実際の文章）は出さず、
    // トップレベルの型形状とZodのissues（path/code/expected/received等の構造情報のみ）
    // だけをログへ出す。これで次回の実失敗時、Vercelランタイムログから実際に
    // どのfield・どんな型/enum不一致だったかを推測ではなく確認できるようにする。
    console.error(
      `[claudeClient] attempt ${logTag.attempt} スキーマ不一致 lab=${logTag.labId} company=${logTag.companyId} turn=${logTag.turn} ` +
        `stopReason=${response.stop_reason ?? "(なし)"} outputTokens=${response.usage?.output_tokens ?? "(不明)"} maxTokens=${config.maxTokens} ` +
        `shape=${summarizeTopLevelShapeForLog(toolInput)} issues=${summarizeZodIssuesForLog(validated.error)}`
    );
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
 * リトライ方針: tool_useブロック欠落（invalid_json）・スキーマ不一致（schema_mismatch）・
 * 空応答（empty_response、tool_use強制下では通常発生しないが型としては維持）のいずれかで
 * 最初の試行が失敗した場合、同一の入力でちょうど1回だけ再試行する（合計最大2回のAPI呼び出し）。
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
