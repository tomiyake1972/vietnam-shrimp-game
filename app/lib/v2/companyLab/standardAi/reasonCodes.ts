// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 理由コード
//
// 各意思決定には、人間向けの日本語説明文に加えて、構造化された理由コードを
// 付与する（対象ドメイン・重大度・鍵となる事前値・発火した閾値・結果の意思決定・
// 簡潔な説明をセットで保持する）。これは今回のUI実装の対象ではないが、将来の
// 圧力値フレームワーク・AI取締役会機能・プレイヤー向け説明・テスト結果分析で
// 再利用できるよう、意図的に汎用的な構造にしてある。

export type StandardAiDomain = "procurement" | "sales" | "production" | "labor" | "finance" | "capex";

export type StandardAiSeverity = "info" | "warning" | "critical";

/**
 * 理由コード一覧。例示（実装指示）のコードをそのまま採用し、SAI-1の各ドメイン
 * 判断に必要な残りのコードを、同じ命名規則（対象_状態）で追加した。
 */
export type StandardAiReasonCode =
  // --- 契約履行・生産・販売共通 ---
  | "CONTRACT_FULFILLMENT_PRIORITY" // 未履行契約の履行を優先
  | "FINISHED_GOODS_EXCESS" // 完成品在庫過剰
  | "CAPACITY_CONSTRAINT" // 設備・原料・労働能力による制約
  // --- 原料調達 ---
  | "RAW_MATERIAL_SHORTAGE" // 原料不足
  | "PROCUREMENT_INCREASED_FOR_SHORTAGE" // 原料不足のため調達量を増加
  | "PROCUREMENT_REDUCED_FOR_EXCESS" // 原料在庫過剰のため調達量を抑制
  | "PROCUREMENT_CASH_CONSTRAINED" // 資金制約により調達を必要最小限に抑制
  // --- 販売 ---
  | "PRICE_REDUCTION_FOR_EXCESS_STOCK" // 完成品在庫過剰のため値引き
  | "SALES_REDUCED_FOR_SUPPLY_LIMIT" // 供給余力不足のため販売希望量を抑制
  | "LOW_ORDER_BOOK_PREMIUM_FLOOR" // 市場プレミアムが最低受注水準未満のため販売提案を停止
  // --- 販売（SAI-2追加作業: 市場別営業配置・商品別営業工数） ---
  | "SALES_HEADCOUNT_INSUFFICIENT_TOTAL" // 実在する営業人員総数が全市場の必要工数に対し不足
  | "VAP_MIX_INCREASES_SALES_EFFORT_NEED" // VAP比率上昇により当該市場の必要営業工数が増加
  // --- 労働 ---
  | "WORKER_CAPACITY_SHORTAGE" // ワーカー能力不足
  | "OVERTIME_TEMP_FOR_TRANSIENT_SHORTAGE" // 一時的な不足に対する残業・臨時ワーカー対応
  | "HIRING_FOR_SUSTAINED_SHORTAGE" // 持続的な不足に対する正社員採用
  | "HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS" // 持続的な過剰人員の縮小
  // --- 資金繰り ---
  | "CASH_BUFFER_SHORTAGE" // 最低現金水準を下回る見込みのため借入
  | "DEBT_REPAYMENT_SURPLUS" // 現金余剰のため任意期限前返済
  | "FUNDING_OUTLOOK_BORROWING_REQUESTED" // 【SAI-6 Phase 1A】資金見通しに基づく必要借入額の算出（診断用、常時記録）
  // --- 設備投資 ---
  | "CAPEX_DEFERRED" // 設備投資を見送り（既定の正常な結果）
  | "CAPEX_PROPOSED" // 持続的なボトルネック解消のため設備投資を提案
  // --- 【SAI-5】市場・商品志向／ライフサイクル／営業基盤／供給圧力 ---
  | "MARKET_ORIENTATION_APPLIED" // 市場志向倍率による市場間の再配分を適用
  | "PRODUCT_ORIENTATION_APPLIED" // 商品志向倍率による商品別目標数量の補正を適用
  | "LIFECYCLE_GROWTH_PURSUED" // 公開ライフサイクルトレンドの成長を捉えるため販売・投資を前傾
  | "SALES_BASE_ADVANTAGE" // 蓄積した営業基盤の優位を販売計画に反映
  | "SUPPLY_PRESSURE_RETREAT" // 公開供給圧力の高止まりを受けて販売・投資を抑制
  | "CAPEX_DEFERRED_OVERSUPPLY" // 供給過剰シグナルにより設備投資を見送り
  | "CAPEX_RESUME_PROPOSED" // 資金回復により中断中の設備投資案件の再開を提案
  | "VAP_GROWTH_ENTRY" // VAP需要の成長局面を捉えるためVAP能力・販売へ参入
  | "VAP_OVERSUPPLY_RETREAT" // VAP供給過剰局面のためVAP拡大を抑制
  | "PD_CAPACITY_MAINTAINED"; // PD能力の維持を選択（VAP転換へ追随しない）

export const STANDARD_AI_REASON_CODES: readonly StandardAiReasonCode[] = [
  "CONTRACT_FULFILLMENT_PRIORITY",
  "FINISHED_GOODS_EXCESS",
  "CAPACITY_CONSTRAINT",
  "RAW_MATERIAL_SHORTAGE",
  "PROCUREMENT_INCREASED_FOR_SHORTAGE",
  "PROCUREMENT_REDUCED_FOR_EXCESS",
  "PROCUREMENT_CASH_CONSTRAINED",
  "PRICE_REDUCTION_FOR_EXCESS_STOCK",
  "SALES_REDUCED_FOR_SUPPLY_LIMIT",
  "LOW_ORDER_BOOK_PREMIUM_FLOOR",
  "SALES_HEADCOUNT_INSUFFICIENT_TOTAL",
  "VAP_MIX_INCREASES_SALES_EFFORT_NEED",
  "WORKER_CAPACITY_SHORTAGE",
  "OVERTIME_TEMP_FOR_TRANSIENT_SHORTAGE",
  "HIRING_FOR_SUSTAINED_SHORTAGE",
  "HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS",
  "CASH_BUFFER_SHORTAGE",
  "DEBT_REPAYMENT_SURPLUS",
  "FUNDING_OUTLOOK_BORROWING_REQUESTED",
  "CAPEX_DEFERRED",
  "CAPEX_PROPOSED",
  "MARKET_ORIENTATION_APPLIED",
  "PRODUCT_ORIENTATION_APPLIED",
  "LIFECYCLE_GROWTH_PURSUED",
  "SALES_BASE_ADVANTAGE",
  "SUPPLY_PRESSURE_RETREAT",
  "CAPEX_DEFERRED_OVERSUPPLY",
  "CAPEX_RESUME_PROPOSED",
  "VAP_GROWTH_ENTRY",
  "VAP_OVERSUPPLY_RETREAT",
  "PD_CAPACITY_MAINTAINED",
];

/** 1件の意思決定理由（診断用。会社ラボの既存CompanyReasonEntryとは独立した、SAI-1専用の詳細版）。 */
export interface StandardAiDiagnosticEntry {
  readonly code: StandardAiReasonCode;
  readonly domain: StandardAiDomain;
  readonly companyId: string;
  readonly severity: StandardAiSeverity;
  /** この判断の鍵となる事前値（診断・監査用。単位はkeyValueUnitsを参照）。 */
  readonly keyValues?: Readonly<Record<string, number>>;
  /** 発火した閾値（該当する場合）。 */
  readonly threshold?: number;
  /** 結果として生成された意思決定の簡潔な要約（例: "VAP生産を+120トン増"）。 */
  readonly decisionSummary?: string;
  /** 人間向けの簡潔な日本語説明。 */
  readonly message: string;
}
