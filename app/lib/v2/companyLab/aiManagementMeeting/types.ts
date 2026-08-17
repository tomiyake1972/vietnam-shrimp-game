// ShrimpX V2 — AI Management Meeting (AMM-M0/M1) 共通型定義
//
// 【三層分離の原則】この機能はEngine Calculation（決定論的なゲームエンジン）・
// Standard AI（既存の自動意思決定ロジック）とは完全に独立した第三層である。
// この機能はStandard AIの判断ロジック・パラメータを一切変更・置換しない。Claudeの
// 出力はここに定義された構造化スキーマを通してのみ表現され、ゲーム状態を直接
// 変更する経路は存在しない（提案はvalidation.tsを通過した後、UIへ返すだけ。
// M1スコープでは自動適用しない）。
//
// 【永続化しないderived object】AiMeetingExecutiveBriefingPacket・ルーティング結果は
// いずれも既存のPlayerScreenViewModel等から都度導出する純粋なderived objectであり、
// 新しいpersistent SSoTではない。会話メッセージ自体（conversation.ts）だけが、
// ゲーム状態SSoTとは明確に分離された別名前空間で永続化される「conversation artifact」。

import { CapitalProjectType } from "../../capex/types";
import { CompanyId } from "../../sales/types";
import { DemandMarketId, Product } from "../../market/types";

export const AI_MEETING_EXECUTIVE_ROLES = ["CEO", "CFO", "COO", "COMMERCIAL"] as const;
export type ExecutiveRole = (typeof AI_MEETING_EXECUTIVE_ROLES)[number];

export type MessageSpeaker = "PLAYER" | ExecutiveRole;

/** Claude応答内で許可するメッセージ種別はPLAYER/CEO/CFO/COO/COMMERCIALのみ（システムメッセージは非公開）。 */
export const AI_MEETING_MESSAGE_SPEAKERS: readonly MessageSpeaker[] = ["PLAYER", ...AI_MEETING_EXECUTIVE_ROLES];

export const AI_MEETING_STANCES = ["SUPPORT", "CAUTION", "OPPOSE", "ALTERNATIVE", "INFORMATIONAL"] as const;
export type AiMeetingStance = (typeof AI_MEETING_STANCES)[number];

export const AI_MEETING_INTENTS = [
  "GROW_AGGRESSIVELY",
  "PROTECT_CASH",
  "REDUCE_BACKLOG",
  "PRIORITIZE_JAPAN",
  "DEFER_CAPEX",
  "CUSTOM",
] as const;
/** プレイヤーの当該ミーティング・当該turn限りの意図。Vision/Profileへの自動反映は一切しない。 */
export type AiMeetingIntent = (typeof AI_MEETING_INTENTS)[number];

export const AI_MEETING_PROPOSAL_DOMAINS = [
  "SALES",
  "PRODUCTION",
  "PROCUREMENT",
  "LABOR",
  "FINANCE",
  "CAPEX",
  "VAP_PRODUCT_DEVELOPMENT",
] as const;
export type AiMeetingProposalDomain = (typeof AI_MEETING_PROPOSAL_DOMAINS)[number];

/** Standard AI自身の提案に対する、Executiveの立場（既存提案IDへの参照＋賛否）。 */
export const STANDARD_AI_REFERENCE_STANCES = ["SUPPORT", "MODIFY", "OPPOSE"] as const;
export type StandardAiReferenceStance = (typeof STANDARD_AI_REFERENCE_STANCES)[number];

/**
 * Executiveが既存Standard AI提案（診断reasonCode由来）へ言及する際の参照。
 * 診断エントリ自体にIDが無いため、reasonCode＋対象（factoryId/product等、任意）で
 * 「どの既存提案を指しているか」をベストエフォートに特定する（新しいID体系は作らない）。
 */
export interface StandardAiProposalReference {
  readonly reasonCode: string;
  readonly targetFactoryId?: string;
  readonly targetProduct?: Product;
  readonly stance: StandardAiReferenceStance;
  readonly note: string;
}

interface AiMeetingProposalBase {
  readonly id: string;
  readonly domain: AiMeetingProposalDomain;
  /** この提案の簡潔な根拠（factsUsed同様、ExecutiveBriefingPacketの実在する事実に基づくこと）。 */
  readonly rationale: string;
}

/**
 * 【M1.1・Sales proposal schema最終監査での訂正】ShrimpXの実際のデータ構造
 * （app/lib/v2/sales/types.ts の CompanySalesPlanEntry、および
 * app/lib/v2/sales/salesForce.ts の validateSalesForceHeadcountBudget）を
 * 監査した結果、営業人員(salesForceHeadcount)は「市場単位で共有」される
 * （同一market内の全product行が同一のsalesForceHeadcountを持たなければならず、
 * 違反すると入力エラーになる）一方、販売数量(desiredQuantity)・価格調整
 * (priceAdjustmentUsdPerHosoEqKg)はmarket×product単位で独立に決まる、という
 * 非対称な粒度であることが判明した。当初のSalesProposal（1つのproposal内に
 * market・product・salesForceHeadcountを同居させる設計）は、この非対称性を
 * 表現できず、「Japan PDにsalespersonを3人追加」のような、実際には存在しない
 * 粒度（商品単位の営業人員）の提案が構造上作れてしまっていた。
 * scopeで2種類に分離することで、この種の無効な提案がスキーマレベルで
 * 生成・validation通過できないようにする。
 */
export interface SalesQuantityProposal extends AiMeetingProposalBase {
  readonly domain: "SALES";
  readonly scope: "MARKET_PRODUCT";
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly desiredQuantityTons?: number;
  readonly priceAdjustmentUsdPerHosoEqKg?: number;
}

export interface SalesForceProposal extends AiMeetingProposalBase {
  readonly domain: "SALES";
  readonly scope: "MARKET";
  readonly market: DemandMarketId;
  readonly salesForceHeadcount: number;
}

export type SalesProposal = SalesQuantityProposal | SalesForceProposal;

export interface ProductionProposal extends AiMeetingProposalBase {
  readonly domain: "PRODUCTION";
  readonly factoryId: string;
  readonly product: Product;
  readonly desiredQuantityTons?: number;
  readonly priority?: number;
}

export interface ProcurementProposal extends AiMeetingProposalBase {
  readonly domain: "PROCUREMENT";
  readonly channel: "DOMESTIC" | "IMPORT";
  readonly desiredQuantityTons?: number;
  readonly originCountry?: string;
  readonly priceAdjustmentUsdPerHosoEqKg?: number;
  readonly procurementHeadcount?: number;
}

export interface LaborProposal extends AiMeetingProposalBase {
  readonly domain: "LABOR";
  readonly factoryId: string;
  readonly regularHeadcountDelta?: number;
  readonly temporaryHeadcountDelta?: number;
  readonly overtimeRate?: number;
}

export interface FinanceProposal extends AiMeetingProposalBase {
  readonly domain: "FINANCE";
  readonly desiredAmountUsd?: number;
  readonly desiredTermQuarters?: number;
  readonly desiredPrepaymentUsd?: number;
}

export interface CapexProposal extends AiMeetingProposalBase {
  readonly domain: "CAPEX";
  readonly projectType: CapitalProjectType;
  readonly requestedBudgetUsd?: number;
  readonly targetFactoryId?: string;
}

export interface VapProductDevelopmentProposal extends AiMeetingProposalBase {
  readonly domain: "VAP_PRODUCT_DEVELOPMENT";
  readonly spendTierUsd: number;
}

export type AiMeetingProposal =
  | SalesProposal
  | ProductionProposal
  | ProcurementProposal
  | LaborProposal
  | FinanceProposal
  | CapexProposal
  | VapProductDevelopmentProposal;

/** validation.ts通過後の提案。UIへはこの形でのみ渡す（M1では自動適用しない。UIへ返すだけ）。 */
export interface ValidatedAiMeetingProposal {
  readonly proposal: AiMeetingProposal;
  readonly valid: boolean;
  /** valid=falseの理由、またはvalid=trueでも財務リスクが高い旨の注記（financiallyRisky）。 */
  readonly issues: readonly string[];
  readonly financiallyRisky: boolean;
}

export interface AiMeetingResponseEntry {
  readonly speaker: ExecutiveRole;
  readonly text: string;
  readonly stance?: AiMeetingStance;
  readonly proposalIds: readonly string[];
  /** ExecutiveBriefingPacketのどのfactキーを使ったか（例: "cash.current", "capacity.PD.utilization"）。捏造防止。 */
  readonly factsUsed: readonly string[];
  readonly standardAiReferences: readonly StandardAiProposalReference[];
}

/**
 * 【M2.2追加】プレイヤーが今回の発言でゲーム事実に関する主張・訂正を行ったかどうかの
 * 判定。「Player発言も常にgame truthへ自動昇格させない」（実装指示§8）を担保するため、
 * ExecutiveBriefingPacketと整合する場合のみCONFIRMEDとし、根拠が無い場合はUNSUPPORTED
 * として保留する（役員は無条件に事実認定しない）。
 */
export const PLAYER_CORRECTION_STATUSES = ["NOT_APPLICABLE", "CONFIRMED", "UNSUPPORTED"] as const;
export type PlayerCorrectionStatus = (typeof PLAYER_CORRECTION_STATUSES)[number];

/** Claudeへの単一構造化呼び出し（Option B）が返す応答形状。 */
export interface AiMeetingStructuredResponse {
  readonly primarySpeaker: ExecutiveRole;
  /** primary（必須1件）＋secondary（最大1件）＋CEO summary（該当時のみ）。最大3件。 */
  readonly responses: readonly AiMeetingResponseEntry[];
  readonly requiresCeoSummary: boolean;
  readonly proposals: readonly AiMeetingProposal[];
  readonly meetingIntent: AiMeetingIntent;
  readonly potentialStrategicChange: boolean;
  readonly potentialStrategicChangeNote?: string;
  /** 【M2.2追加】プレイヤーの今回の発言に事実主張・訂正が含まれるかどうかの判定。 */
  readonly playerCorrectionStatus: PlayerCorrectionStatus;
  readonly playerCorrectionNote?: string;
}

/**
 * 【M2.2追加】CONFIRMED（BriefingPacketと整合する）と判定されたプレイヤー訂正の記録。
 * 会話artifact（conversation.ts）内にのみ保持する「derived/meeting artifact」であり、
 * Game SSoTには一切書き込まない（実装指示§9「Game SSoTには入れない」）。同一meeting内で
 * 既に確認済みの訂正を、以後のresponse生成で再び間違えないためのメモリとして使う。
 */
export interface PlayerCorrectionRecord {
  readonly id: string;
  readonly claimText: string;
  readonly note: string;
  readonly turn: number;
}

export interface AiMeetingMessage {
  readonly id: string;
  readonly speaker: MessageSpeaker;
  readonly text: string;
  readonly turn: number;
  readonly stance?: AiMeetingStance;
  readonly proposalIds: readonly string[];
  readonly factsUsed: readonly string[];
  /**
   * 【M2.2追加】このメッセージがどのprompt versionの下で生成されたか（PLAYERメッセージには
   * 設定しない）。AI_MEETING_PROMPT_VERSIONと異なる場合、旧versionの下で生成された
   * factual assertionを新しいstructured briefingより優先しない（実装指示§21）。
   */
  readonly promptVersion?: string;
}

export interface AiMeetingConversationState {
  readonly meetingId: string;
  readonly labId: string;
  readonly companyId: CompanyId;
  readonly turn: number;
  readonly messages: readonly AiMeetingMessage[];
  readonly lastMeetingIntent: AiMeetingIntent | null;
  readonly lastValidatedProposals: readonly ValidatedAiMeetingProposal[];
  /** 直近履歴のみ再送するための、6-10件を超えた古いメッセージの簡潔な要約（任意）。 */
  readonly compactSummary: string | null;
  /** 【M2.2追加】同一meeting内でCONFIRMED済みのプレイヤー訂正（correction memory）。Game SSoTには入れない。 */
  readonly confirmedCorrections: readonly PlayerCorrectionRecord[];
}

/** Claude呼び出し1回ぶんの計測・診断（要求§14）。secretは含めない。 */
export interface AiMeetingCallDiagnostics {
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly stopReason: string | null;
  readonly latencyMs: number;
  readonly retryCount: number;
  readonly schemaValidationResult: "ok" | "schema_mismatch" | "max_tokens_truncation" | "empty_response" | "http_error" | "network_error" | "missing_api_key";
  /**
   * 【M2.5追加・実装指示§11】overdue関連の禁止語彙guard（dueWordingGuard.ts）の結果。
   * "not_applicable"=overdueTons>0のため判定対象外。"ok"=違反なし。"repaired"=違反を
   * 検知し1回のrepair呼び出しで解消。"violation_after_repair"=repair後も違反が残った
   * （それ以上は再試行しない。呼び出し側はrepair後の応答をそのまま返す）。
   */
  readonly semanticGuardResult?: "not_applicable" | "ok" | "repaired" | "violation_after_repair";
}
