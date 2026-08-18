// ShrimpX V2 — Shared Game Knowledge Registry: schema（Phase M2.8・実装指示§4）
//
// 【このレイヤーの位置づけ（実装指示§26）】ShrimpX固有のゲームルール知識を、
// AI Management Meeting専用ではなく **pure domain layer** として持つ。将来
// ChatSense Analysis Agent / AI Analysis Context / Standard AI Audit Workbook の
// documentationからも同じ知識を再利用できるよう、companyLab配下ではなく
// app/lib/v2/gameKnowledge/ に置き、React・Redis・Anthropic SDKへ一切依存しない。
//
// 【3層（実装指示§1）】
//   A. CODE / PARAMETER FACTS      … 実装・parameterから取得する、変わり得る数値
//   B. FORMAL GAME RULES           … engine semanticsとして安定しているルール・定義
//   C. PLAYER-FACING EXPLANATION   … Manual相当の自然言語説明
// 本ファイルの KnowledgeEntry は B と C を保持し、A は dynamicValues として
// 実行時に現在のparameterから注入する（実装指示§5。数値を説明文へhardcodeしない）。

/** 知識のドメイン。role filtering（実装指示§27）とretrieval（§28）のキーになる。 */
export type KnowledgeDomain =
  | "SALES"
  | "LABOR"
  | "PRODUCTION"
  | "CAPACITY"
  | "PROCUREMENT"
  | "CONTRACT"
  | "FINANCE"
  | "CAPEX"
  | "QUALITY_TRUST"
  | "STANDARD_AI";

/** 実装指示§4のruleType。 */
export type KnowledgeRuleType = "DEFINITION" | "FORMULA" | "TIMING" | "CONSTRAINT" | "INTERPRETATION" | "EXAMPLE";

/** 実装指示§4のsourceType。CODE/PARAMETERはA層、FORMAL_SPEC/MANUALはB/C層。 */
export type KnowledgeSourceType = "CODE" | "PARAMETER" | "FORMAL_SPEC" | "MANUAL" | "DERIVED";

/** AI Meetingのrole。実装指示§27のrole relevance filteringに使う。 */
export type KnowledgeRole = "CEO" | "CFO" | "COO" | "COMMERCIAL";

/**
 * 実行時にsummary/explanationへ差し込む動的値のプレースホルダ名。
 * 説明文中では `{{name}}` と書き、resolveDynamicValues が現在のparameterで置換する。
 * 解決できなかったプレースホルダは、値を捏造せず `(値を取得できませんでした)` になる。
 */
export type DynamicValueKey = string;

export interface KnowledgeEntry {
  /** 例: "SALES.SALESPERSON_CAPACITY"。domainを接頭辞にした安定ID（変更しない）。 */
  readonly id: string;
  readonly domain: KnowledgeDomain;
  readonly title: string;
  /** 1〜2文。retrieval結果の一覧・token節約時はこれだけを注入することがある。 */
  readonly summary: string;
  /** 本文。`{{key}}` で動的値を参照してよい（実装指示§5）。 */
  readonly explanation: string;
  readonly ruleType: KnowledgeRuleType;
  readonly sourceType: KnowledgeSourceType;
  /** 実装指示§32。値の出所（ファイルパス・docパス・manual section）。 */
  readonly sourceReference: string;
  readonly appliesToRoles: readonly KnowledgeRole[];
  /** retrieval用のキーワード（日本語・英語の両方を入れる。実装指示§28）。 */
  readonly keywords: readonly string[];
  /** explanation中で使う動的値のキー一覧（未宣言のプレースホルダは解決しない）。 */
  readonly dynamicValues?: readonly DynamicValueKey[];
  /** AIが誤読しやすい点への警告（実装指示§16のcapacity warning等）。 */
  readonly semanticWarnings?: readonly string[];
  readonly version: string;
}

/** 解決済み（動的値を差し込んだ後）の知識項目。プロンプトへはこの形で注入する。 */
export interface ResolvedKnowledgeEntry extends Omit<KnowledgeEntry, "explanation"> {
  readonly explanation: string;
  /** 実際に差し込んだ動的値（監査用。どの数値が現在値として使われたか分かる）。 */
  readonly resolvedValues: Readonly<Record<string, string>>;
}

/** 実装指示§25。Manual更新時にstale knowledgeを検出できるようにする。 */
export interface KnowledgeRegistryVersion {
  readonly knowledgeVersion: string;
  /** 転記元Manualの版。GitHub正式Manualが未整備の間は "NOT_TRACKED"。 */
  readonly manualVersion: string;
  /** 動的値の取得元パラメータ群の版（sales/production/finance/rawMaterialsの各版を連結）。 */
  readonly parameterVersion: string;
}

/** 実装指示§29の質問意図分類。 */
export type QuestionIntent = "GAME_RULE" | "CURRENT_STATE" | "STRATEGY" | "MIXED";

export interface KnowledgeRetrievalResult {
  readonly intent: QuestionIntent;
  readonly entries: readonly ResolvedKnowledgeEntry[];
  /** マッチしたが Top N の枠から漏れた件数（token予算の透明性のため）。 */
  readonly truncatedCount: number;
}
