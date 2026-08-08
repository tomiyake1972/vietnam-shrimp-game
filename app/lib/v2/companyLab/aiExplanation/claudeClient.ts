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
// システムプロンプト文字列（v1）は一切変更しない（spec §3で一字一句固定と規定されて
// いたため）。tool定義は`system`とは独立した別のリクエストパラメータ（`tools`/
// `tool_choice`）として追加するだけである。
//
// 【2026-08-02・25秒問題対応・出力量削減】三宅さんの明示指示に基づき、出力トークン量を
// 削減するための最小修正を行う。system promptをv2へ切替（簡潔さ・件数目安の指示を追加。
// systemPrompt.ts参照）、tool定義のJSON SchemaへmaxItems・description（件数目安・
// 簡潔さの指示）を追加、EXPLANATION_MAX_OUTPUT_TOKENSを縮小する。timeout=25000・
// maxRetries=0・model=claude-haiku-4-5-20251001はいずれも変更しない（今回の比較の
// ため固定）。reportSchema.tsのZod検証には件数上限を追加しない（理由はreportSchema.ts
// のEXPLANATION_OUTPUT_LIMITSのコメント参照。目安をわずかに超えただけでschema_mismatch
// による2回目呼び出し＝遅延倍増を招かないため）。

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V3 } from "./systemPrompt";
import { EXPLANATION_OUTPUT_LIMITS, StandardAiManagementReport, standardAiManagementReportSchema } from "./reportSchema";
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
 *
 * 【2026-08-02・25秒問題対応・出力量削減】各配列にmaxItems、各フィールドに
 * descriptionを追加した。これらはAnthropicのtool-use機構に対する「お願い」であり
 * ハードな検証ではない（Zod側では意図的に強制しない。reportSchema.tsの
 * EXPLANATION_OUTPUT_LIMITSのコメント参照）が、Claudeへ出力量を絞るよう明示的に
 * 伝えることで、実際の生成トークン量を減らし、25秒timeout内に収まりやすくすることを
 * 狙っている。件数の数値はEXPLANATION_OUTPUT_LIMITS（reportSchema.ts）を単一の定義元
 * とし、systemPrompt.tsのV2文言とここで同じ値を参照することで、schemaのmaxItemsと
 * promptの件数指示が常にずれないようにしている。
 */
export const EXPLANATION_REPORT_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "1文のみ。簡潔な見出し。" },
    executiveSummary: { type: "string", description: "2〜4文程度の短い経営要約。診断JSONの逐語的な言い換えではなく要点のみ。" },
    recommendations: {
      type: "array",
      maxItems: EXPLANATION_OUTPUT_LIMITS.maxRecommendations,
      description: `最大${EXPLANATION_OUTPUT_LIMITS.maxRecommendations}件。主要な打ち手のみに絞る。`,
      items: {
        type: "object",
        properties: {
          area: { type: "string" },
          title: { type: "string" },
          action: { type: "string" },
          reasons: {
            type: "array",
            maxItems: EXPLANATION_OUTPUT_LIMITS.maxReasonsPerRecommendation,
            description: `最大${EXPLANATION_OUTPUT_LIMITS.maxReasonsPerRecommendation}件。各reasonは短文で。`,
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
      maxItems: EXPLANATION_OUTPUT_LIMITS.maxKeyRisks,
      description: `最大${EXPLANATION_OUTPUT_LIMITS.maxKeyRisks}件。重要リスクのみに絞る。`,
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
    questionsForPlayer: {
      type: "array",
      maxItems: EXPLANATION_OUTPUT_LIMITS.maxQuestionsForPlayer,
      description:
        `最大${EXPLANATION_OUTPUT_LIMITS.maxQuestionsForPlayer}件。各要素は必ずプレーンな文字列（string）そのものにすること。` +
        `{"question": "..."}のようなオブジェクトにしてはならない。質問文そのものを1つの文字列として書くこと。`,
      items: {
        type: "string",
        description: "質問文そのもの（プレーンな文字列。オブジェクトではない）。",
      },
    },
    dataLimitations: {
      type: "array",
      maxItems: EXPLANATION_OUTPUT_LIMITS.maxDataLimitations,
      description:
        `最大${EXPLANATION_OUTPUT_LIMITS.maxDataLimitations}件。各要素は必ずプレーンな文字列（string）そのものにすること。` +
        `{"limitation": "..."}のようなオブジェクトにしてはならない。制約の説明文そのものを1つの文字列として書くこと。`,
      items: {
        type: "string",
        description: "データの限界・前提の説明文そのもの（プレーンな文字列。オブジェクトではない）。",
      },
    },
  },
  required: ["headline", "executiveSummary", "recommendations", "keyRisks", "questionsForPlayer", "dataLimitations"],
} as const;

/**
 * Claude呼び出し1回あたりの明示的なタイムアウト（ミリ秒）。SDKの既定（10分）は
 * 長すぎるため、クライアント構築時・各呼び出し時の両方でこの値を指定する。
 *
 * 【2026-08-08・25秒→40秒へ延長（Test15 turn4のnetwork_error実測に基づく）】
 * Vercelランタイムログで、Test15/BAL/turn4の実失敗を2件確認した。
 *   - 04:06:19 の成功応答2回は latencyMs=19,686 / 18,922（＝正常時でも約19秒）
 *   - 04:09:42 は elapsedMs=25,003 でtimeoutし category=network_error
 * 正常時19秒に対して25秒では余裕が5〜6秒しかなく、わずかな遅延で即timeoutする
 * 水準だった。40秒であれば正常時に対して倍以上の余裕があり、かつ
 * 呼び出し元（PlayerScreenClient.tsxのAI_EXPLANATION_CLIENT_TIMEOUT_MS=60秒）の
 * 内側に確実に収まる（schema_mismatchで2回試行しても40×2=80秒になり得るが、
 * その場合はクライアント側60秒が先に発火してfailure表示になるだけで、
 * 画面が固まることはない）。
 */
export const EXPLANATION_CLAUDE_TIMEOUT_MS = 40_000;

/**
 * 【2026-08-02・76秒問題の修正】Anthropic SDK（@anthropic-ai/sdk）は既定で
 * maxRetries=2（＝タイムアウト等のリトライ可能なエラーで、SDK内部が最大2回・
 * 合計3回まで自動的に再試行する）。EXPLANATION_CLAUDE_TIMEOUT_MS（25秒）と
 * この既定のmaxRetries=2が組み合わさると、SDK内部だけで最大 3×25秒＝75秒
 * （＋バックオフ）を消費してから、ようやく呼び出し側のcatchへ例外が届く。
 * 三宅さんの実機Preview確認（2026-08-02）で、2回とも失敗までの所要時間が
 * ほぼ同一（76,305ms・76,289ms）だったことをVercelランタイムログで確認し、
 * 3×25秒+バックオフという計算とほぼ一致することから、この既定retryが実際の
 * ユーザー待ち時間を意図せず3倍化させていたと判断した。
 *
 * 【今回の対応方針（三宅さんの明示指示）】まずSDK側の自動retryを完全に無効化し
 * （maxRetries: 0）、EXPLANATION_CLAUDE_TIMEOUT_MS（25秒）がそのままユーザーの
 * 実待ち時間として機能する状態を作る。アプリ側で別途retry方針を設計するまでは、
 * SDKへ暗黙のretryを一切任せない。timeout値自体（25秒が短すぎるかどうか）の
 * 見直しは、この変更後の実測を見てから別途判断する（今回はtimeout値は変更しない）。
 */
export const EXPLANATION_CLAUDE_MAX_RETRIES = 0;

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

// 【2026-08-01・maxTokens不足によるschema_mismatchの確定と修正（経緯・履歴）】三宅さんの
// 実機Preview確認（Test14/BAL/turn1）で、schema_mismatchが起きたattempt1・attempt2の
// 両方でAnthropic応答のstop_reasonが"max_tokens"、usage.output_tokensがちょうど
// maxTokens設定値(1200)と一致していることをVercelランタイムログで確認した
// （headline・executiveSummaryの2フィールドを書いた時点で1200トークンを使い切り、
// recommendations/keyRisks/questionsForPlayer/dataLimitationsの4つの配列
// フィールドが丸ごと出力されずに応答が打ち切られていた）。この経緯があるため、
// 今回（25秒問題対応）も1200へは戻さない（三宅さんの明示指示）。
//
// 【2026-08-02・25秒問題対応・出力量削減】4096は「打ち切られない」ことを優先して
// 大きめに設定した値だが、出力側の生成完了待ち（非streaming）が25秒timeoutを
// 超える一因になっていると考えられるため、出力量そのものを絞る対応（システム
// プロンプトv2・tool定義のmaxItems/description）と併せて、maxTokensも縮小する。
// 選定理由: 新しい件数目安（recommendations最大3件×reasons最大2件、keyRisks最大3件、
// questionsForPlayer最大2件、dataLimitations最大2件、headline1文、executiveSummary
// 2〜4文）で実際に必要な日本語出力量を概算すると、本文相当のテキストで概ね
// 1,300文字前後（JSON構造のオーバーヘッドを含めても実トークン数はおおよそ
// 1,300〜1,800程度と想定）に収まる見込みであり、2,000であれば十分な余裕を持ちつつ
// 4,096の半分以下に絞れる。三宅さんの指示範囲（1,600〜2,200）の中で、上記の想定
// 生成量に対して余裕を持たせつつも4,096より大幅に小さい2,000を選んだ。
//
// 【2026-08-08・2000→4096へ戻す（Test15 turn4のmax_tokens到達を実測で確認）】
// 上記の「25秒問題対応」で4096→2000へ縮小した結果、Turn4で打ち切りが再発した。
// Vercelランタイムログの実測（Test15/BAL/turn4, 04:06:19 attempt1）:
//   stopReason=max_tokens outputTokens=2000 maxTokens=2000
//   shape={"headline","executiveSummary","recommendations(3)","keyRisks(3)",
//          "questionsForPlayer(2)"}   ← 最後のdataLimitationsが丸ごと欠落
//   issues=[{"path":"dataLimitations","code":"invalid_type","expected":"array"}]
// 出力トークンが上限にちょうど張り付いており、tool schemaの最後のフィールドを
// 書く前に停止していた。2026-08-01にmaxTokens=1200で起きたのと同一の症状であり、
// そのとき4096へ引き上げて解消した実績がある。3000等の中間値ではなく、実績のある
// 4096へ戻す（#05の明示指示）。timeoutは同時に40秒へ延ばしているため、
// 「出力量を絞って25秒に収める」という縮小の動機自体が不要になっている。
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

/**
 * 実Anthropicクライアントへ渡すコンストラクタオプション。テストで
 * timeout/maxRetriesの値がずれていないことを直接検証できるよう、
 * クライアント生成本体（createRealClient）から分離してexportする。
 */
export interface AnthropicClientOptions {
  readonly apiKey: string;
  readonly timeout: number;
  readonly maxRetries: number;
}

export function buildAnthropicClientOptions(apiKey: string): AnthropicClientOptions {
  return { apiKey, timeout: EXPLANATION_CLAUDE_TIMEOUT_MS, maxRetries: EXPLANATION_CLAUDE_MAX_RETRIES };
}

function createRealClient(apiKey: string): AnthropicMessagesClient {
  // 【タイムアウト対応】クライアント構築時にも既定タイムアウトを短縮しておく
  // （呼び出し側のper-request timeoutと二重に設定しておくことで、どちらか片方の
  // 指定漏れがあっても10分ハングへ戻らないようにする多重防御）。
  // 【2026-08-02・76秒問題の修正】maxRetries: 0を明示し、SDK既定のmaxRetries=2による
  // 暗黙の自動retry（timeout×3倍化の原因）を無効化する（EXPLANATION_CLAUDE_MAX_RETRIES
  // のコメント参照）。
  return new Anthropic(buildAnthropicClientOptions(apiKey)) as unknown as AnthropicMessagesClient;
}

/** content配列から、tool_choiceで強制したtool呼び出しのtool_useブロックを探す。 */
function findToolUseInput(response: AnthropicMessageResponse): unknown | undefined {
  const block = response.content.find((b) => b.type === "tool_use");
  return block?.input;
}

/**
 * 【2026-08-05・questionsForPlayer/dataLimitations schema_mismatch対策】
 * Vercel実ログ（2026-08-02T11:24:23〜2026-08-04T15:36:43、複数回再発）で確認した
 * 実際の不一致は「questionsForPlayer/dataLimitationsの各要素がstringではなく
 * オブジェクトになっている」という一貫したパターンだった。input_schemaで
 * `items: {type: "string"}`と明示していても、モデルが（recommendations/keyRisksが
 * オブジェクト配列であることに引き寄せられて）同様にオブジェクトを返すことがある
 * ため、安全なnormalization（recoverable mismatchとして、追加のAPI呼び出しなしで
 * その場で修復する）を、Zod検証の前に1回だけ適用する。
 *
 * 【捏造しない】オブジェクトから文字列を抽出する際、一般的なキー名
 * （question/text/label/value/content/limitation/description等）を優先して探すが、
 * 見つからない場合はJSON.stringifyでその要素の内容をそのまま文字列化する
 * （情報を欠落させない。空文字列や決め打ちの代替テキストへ差し替えない）。
 * 文字列側の要素は変更しない。配列以外の型（そもそも配列でない等）は変更せず、
 * 後続のZod検証にそのまま委ねる（この関数はrecoverableな要素レベルの型不一致
 * だけを対象とし、構造そのものの誤りを隠さない）。
 */
const STRING_ARRAY_FIELDS_TO_NORMALIZE = ["questionsForPlayer", "dataLimitations"] as const;
const STRING_EXTRACTION_KEY_CANDIDATES = ["question", "text", "label", "value", "content", "limitation", "description", "message"] as const;

function coerceArrayItemToString(item: unknown): string {
  if (typeof item === "string") return item;
  if (item !== null && typeof item === "object") {
    for (const key of STRING_EXTRACTION_KEY_CANDIDATES) {
      const value = (item as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  // 抽出できる文字列フィールドが無い場合は、内容を欠落させないためJSON文字列化する。
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

/**
 * 【2026-08-08新設】スキーマ上arrayであるトップレベルfieldの一覧。
 * 下の「JSON配列文字列をparseしてarrayへ戻す」救済の対象を、この4つに限定する。
 */
const ARRAY_FIELDS = ["recommendations", "keyRisks", "questionsForPlayer", "dataLimitations"] as const;

/**
 * 【2026-08-08新設】値がstringで、かつその中身がJSON配列として正しくparseできる場合
 * だけarrayへ戻す。それ以外は一切触らない。
 *
 * 【この救済が対象とする実際の失敗】Vercelランタイムログ（Test15/BAL/turn4,
 * 04:06:19 attempt2）で、stopReason=tool_use（＝打ち切りではなく正常完了）
 * outputTokens=1747 にもかかわらず
 *   shape={... "recommendations":"string" ...}
 *   issues=[{"path":"recommendations","code":"invalid_type","expected":"array"}]
 * となり、Claudeが配列そのものをJSON文字列として返していた。
 *
 * 【意図的にやらないこと（#05の明示指示）】
 *   - 単なる文字列を勝手に1要素の配列にしない（内容を捏造しないため）
 *   - JSONとしてparseできない文字列を黙って修正しない
 *   - parse結果が配列でない場合（オブジェクト・数値等）は採用しない
 *   - Zod検証そのものは一切緩めない（救済後の値を通常どおり検証する）
 * parse不能ならこの関数は何もせず、従来どおりZodのschema_mismatchになる。
 */
function tryParseJsonArrayString(value: unknown): readonly unknown[] | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // 「[」で始まらないものはJSON配列ではないので、parseを試みるまでもない
  // （通常の説明文をparseして偶然通ってしまう事故を避ける）。
  if (!trimmed.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeExplanationToolInput(toolInput: unknown): unknown {
  if (toolInput === null || typeof toolInput !== "object") return toolInput;
  const record = toolInput as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...record };

  // (a) 【2026-08-08新設】array fieldがJSON配列文字列で来た場合だけarrayへ戻す。
  //     要素の中身には触れない（この後の(b)と、最終的なZod検証に委ねる）。
  for (const field of ARRAY_FIELDS) {
    const parsed = tryParseJsonArrayString(next[field]);
    if (parsed === undefined) continue;
    next[field] = [...parsed];
    changed = true;
  }

  // (b) 【既存】questionsForPlayer/dataLimitationsの要素がstringでない場合にstring化する。
  //     (a)でarrayへ戻した直後の値に対しても適用されるよう、(a)の後に実行する。
  for (const field of STRING_ARRAY_FIELDS_TO_NORMALIZE) {
    const value = next[field];
    if (!Array.isArray(value)) continue;
    const needsNormalization = value.some((v) => typeof v !== "string");
    if (!needsNormalization) continue;
    next[field] = value.map(coerceArrayItemToString);
    changed = true;
  }

  return changed ? next : toolInput;
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
  /** 【2026-08-08】失敗時にも同定情報を残すためのメタ（本文・秘密情報は含まない）。 */
  readonly contextHash: string;
  readonly promptVersion: string;
  readonly contextSchemaVersion: number;
}

/**
 * 【2026-08-08新設】1回の試行の観測値を、成功・失敗いずれの経路でも同じ形で
 * ログへ出すための共通部分。実測できた値と推定値を混同しないため、
 * SDKのusageから取れた値だけを inputTokens/outputTokens として出し、
 * 取れない場合は "(不明)" と書く（0で埋めない）。
 */
function formatAttemptLogFields(
  logTag: AttemptLogTag,
  config: ExplanationModelConfig,
  fields: {
    readonly elapsedMs: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly stopReason?: string | null;
    readonly errorCategory?: string;
    readonly failureCause?: string;
    readonly estimatedInputTokens?: number;
  }
): string {
  const parts = [
    `attempt=${logTag.attempt}`,
    `lab=${logTag.labId}`,
    `company=${logTag.companyId}`,
    `turn=${logTag.turn}`,
    `model=${config.model}`,
    `maxTokens=${config.maxTokens}`,
    `timeoutMs=${EXPLANATION_CLAUDE_TIMEOUT_MS}`,
    `elapsedMs=${fields.elapsedMs}`,
    `inputTokens=${fields.inputTokens ?? "(不明)"}`,
    `outputTokens=${fields.outputTokens ?? "(不明)"}`,
    `stopReason=${fields.stopReason ?? "(なし)"}`,
    `promptVersion=${logTag.promptVersion}`,
    `contextSchemaVersion=${logTag.contextSchemaVersion}`,
    `contextHash=${logTag.contextHash}`,
  ];
  if (fields.errorCategory !== undefined) parts.push(`errorCategory=${fields.errorCategory}`);
  if (fields.failureCause !== undefined) parts.push(`failureCause=${fields.failureCause}`);
  // 【実測値と推定値を混同しない】SDKのusageが取れなかった場合のみ、別fieldとして
  // 推定値を出す（inputTokensとして出さない）。
  if (fields.estimatedInputTokens !== undefined) parts.push(`estimatedInputTokens=${fields.estimatedInputTokens}`);
  return parts.join(" ");
}

/**
 * 【2026-08-08新設】usageが取得できなかった失敗（timeout・HTTPエラー等）でも
 * 入力規模を事後に把握できるようにするための推定値。実測値ではないことが
 * 分かるよう、必ず estimatedInputTokens という別fieldで記録する。
 * 日本語混在JSONは概ね1トークン≒2.8文字であるという経験則のみを使う。
 */
const ESTIMATED_CHARS_PER_TOKEN = 2.8;
export function estimateContextInputTokens(context: ExplanationContext): number {
  try {
    return Math.round(JSON.stringify(context).length / ESTIMATED_CHARS_PER_TOKEN);
  } catch {
    return -1;
  }
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
        system: STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V3,
        messages: [{ role: "user", content: JSON.stringify(context) }],
        // 【構造化出力対応】tool定義とtool_choiceを別パラメータとして追加し、
        // 応答をこのtool呼び出しに強制する。
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
    // 【2026-08-08】この経路ではAnthropicのusageが取得できない（応答自体が無い）。
    // inputTokensは"(不明)"のままにし、推定値は estimatedInputTokens として別に出す。
    console.error(
      `[claudeClient] 試行失敗 ` +
        formatAttemptLogFields(logTag, config, {
          elapsedMs: Date.now() - startedAt,
          errorCategory,
          failureCause: errorCategory === "network_error" ? "TIMEOUT_OR_NETWORK" : `HTTP_${String(status)}`,
          estimatedInputTokens: estimateContextInputTokens(context),
        })
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
      `[claudeClient] tool_useブロックが見つかりません ` +
        formatAttemptLogFields(logTag, config, {
          elapsedMs: latencyMs,
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          stopReason: response.stop_reason,
          errorCategory: "invalid_json",
          failureCause: response.stop_reason === "max_tokens" ? "MAX_TOKENS_TRUNCATION" : "NO_TOOL_USE_BLOCK",
        })
    );
    return { kind: "failure", errorCategory: "invalid_json" };
  }

  // 【2026-08-05・recoverable mismatchのその場修復】questionsForPlayer/dataLimitationsの
  // 要素がstringでなくオブジェクトで返ってきた場合、追加のAPI呼び出し（2回目のattempt）
  // をせずにこの場でstringへ正規化する。既知の再発パターン（8/2〜8/4に複数回発生した
  // 実ログ）にのみ対応する狭い修復であり、他のフィールド・構造上の不一致は一切隠さず
  // 通常のZod検証（下記）へそのまま委ねる。
  const normalizedToolInput = normalizeExplanationToolInput(toolInput);
  if (normalizedToolInput !== toolInput) {
    console.log(
      `[claudeClient] attempt ${logTag.attempt} questionsForPlayer/dataLimitationsの要素をstringへ正規化（recoverable mismatch、再API呼び出しなし） ` +
        `lab=${logTag.labId} company=${logTag.companyId} turn=${logTag.turn}`
    );
  }

  // 【多重防御】tool_choiceで強制したtool呼び出しはinput_schemaに沿った形であるはずだが、
  // スキーマ宣言側の取りこぼし・SDKの将来的な仕様変化等に備え、reportSchema.tsの
  // Zod検証は引き続き必ず通す（「tool-useはshape的に保証するが、独自のZodチェックも
  // 多重防御として維持する」という方針）。正規化後の値を検証する（正規化されなかった
  // 場合はtoolInputそのものと同一のため、挙動は変わらない）。
  const validated = standardAiManagementReportSchema.safeParse(normalizedToolInput);
  if (!validated.success) {
    // 【診断強化】本文（headline/executiveSummary等の実際の文章）は出さず、
    // トップレベルの型形状とZodのissues（path/code/expected/received等の構造情報のみ）
    // だけをログへ出す。これで次回の実失敗時、Vercelランタイムログから実際に
    // どのfield・どんな型/enum不一致だったかを推測ではなく確認できるようにする。
    // 【2026-08-08・truncation由来の明示】stop_reason=max_tokens かつ出力が上限に
    // 張り付いている場合、errorCategoryは既存方針どおりschema_mismatchのまま
    // （retry方針を変えない）だが、failureCause=MAX_TOKENS_TRUNCATION をログへ出し、
    // 「モデルが型を間違えた」のか「単に途中で切れた」のかをログだけで区別できるようにする。
    const outputTokens = response.usage?.output_tokens;
    const truncated = response.stop_reason === "max_tokens";
    console.error(
      `[claudeClient] スキーマ不一致 ` +
        formatAttemptLogFields(logTag, config, {
          elapsedMs: latencyMs,
          inputTokens: response.usage?.input_tokens,
          outputTokens,
          stopReason: response.stop_reason,
          errorCategory: "schema_mismatch",
          failureCause: truncated ? "MAX_TOKENS_TRUNCATION" : "MODEL_SCHEMA_DEVIATION",
        }) +
        ` shape=${summarizeTopLevelShapeForLog(toolInput)} issues=${summarizeZodIssuesForLog(validated.error)}`
    );
    return { kind: "failure", errorCategory: "schema_mismatch", detail: validated.error.message };
  }

  // 【2026-08-02・25秒問題対応・観測性強化】成功時にもelapsedMs(=latencyMs)と
  // outputTokensをログへ出す（API key・prompt本文は含めない）。出力量削減
  // （システムプロンプトv2・tool定義のmaxItems・maxTokens縮小）が実際に成功時の
  // 所要時間・出力トークン数を減らせているかを、Vercelランタイムログから
  // 直接確認できるようにするため。
  console.log(
    `[claudeClient] 成功 ` +
      formatAttemptLogFields(logTag, config, {
        elapsedMs: latencyMs,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        stopReason: response.stop_reason,
      })
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
  client?: AnthropicMessagesClient,
  /**
   * 【2026-08-08】失敗ログから「どの入力に対する失敗か」を一意に辿るための識別子。
   * 呼び出し元（handlers.ts）が既にキャッシュキー生成のために算出済みの値をそのまま
   * 渡す（このモジュールがキャッシュ層へ依存しないようにするため、ここでは再計算しない）。
   * 省略時は "(未指定)" とし、ログの他の項目には影響させない。
   */
  contextHash?: string
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
  const logBase = {
    labId: context.identity.labId,
    companyId: context.identity.companyId,
    turn: context.identity.turn,
    // 【2026-08-08】失敗ログからも「どの入力に対する失敗か」を一意に辿れるようにする。
    contextHash: contextHash ?? "(未指定)",
    promptVersion: context.identity.promptVersion,
    contextSchemaVersion: context.identity.contextSchemaVersion,
  };

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
