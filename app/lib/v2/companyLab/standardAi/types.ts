// ShrimpX V2 — 標準AI（SAI-1）共通型定義
//
// 【標準AIとは何か・何でないか】
// ここでいう「標準AI」は、強い経営AIでも、会社ごとに個性を持つ競合AIでもない。
// 5社の意思決定入力を毎四半期自動生成し、同一条件・固定シードで8〜32四半期を
// 繰り返し実行できる、ゲームバランス検証用の「標準テストプレイヤー」である。
//
// ../autoPolicy.ts（暫定自動方針）との違い: autoPolicy.ts は
// ARCHETYPE_PROFILES によって会社ごとに異なる閾値・優先順位・価格戦略（個性）を
// 持たせている。標準AIはこれを行わない。5社すべてが同じ StandardAiConfig・
// 同じ判断原則・同じ情報範囲で動く。会社間の違いは、会社の実データ
// （CompanyFixture・CompanyOwnState。工場能力・ワーカー数・原料在庫・契約・
// 商品経済性など）だけに由来し、AI側が会社IDやarchetypeで分岐することはない。
//
// 【参照してよい情報】standardAi/observation.ts が構築する StandardAiObservation
// のみ。これは CompanyFixture（自社の静的設定）・CompanyOwnState（自社の前期末
// 状態）・PublicMarketInfo（前期の公開市場結果）から組み立てられ、他社の非公開
// 計画・将来のシナリオ・当期の市場結果は一切含まない（CompanyDecisionProvider型の
// シグネチャ上、そもそも受け取れない）。

import { CompanyId } from "../../sales/types";
import { Product } from "../../market/types";
import { CompanyDecisionInput } from "../types";
import { PeriodV2 } from "../../core/period";

// ---------------------------------------------------------------------
// 1. 判断理由・診断情報
// ---------------------------------------------------------------------

/**
 * 標準AIの判断理由コード。将来の圧力値方式・経営会議AIへ接続できるよう、
 * 「何が」「どちらの方向に」判断を動かしたかが分かる粒度にする。
 * このコード一覧はここに追加していく想定（既存コードを変更せず拡張可能）。
 */
export type StandardAiReasonCode =
  // --- 販売・生産 ---
  | "SALES_STABLE_NO_CHANGE" // 正常時：前四半期から大きく動かさない標準運転
  | "SALES_REDUCED_FINISHED_GOODS_EXCESS" // 完成品在庫過剰のため販売希望を抑制
  | "SALES_REDUCED_LOW_MARGIN" // 市場プレミアムが最低受注水準未満／に近く受注を抑制
  | "PRODUCTION_REDUCED_FINISHED_GOODS_EXCESS" // 完成品在庫過剰のため生産希望を抑制
  | "PRODUCTION_PRIORITIZED_CONTRACT_FULFILLMENT" // 期日超過契約があるため当該商品の生産優先順位を引き上げ
  // --- 原料調達 ---
  | "PROCUREMENT_STABLE_NO_CHANGE" // 正常時：構成比に沿った標準調達
  | "PROCUREMENT_INCREASED_RAW_MATERIAL_SHORTAGE" // 来期の原料不足見込みのため調達を積み増し（上限あり）
  | "PROCUREMENT_REDUCED_CASH_SHORTAGE" // 現金不足のため調達量を抑制
  // --- 労務 ---
  | "LABOR_STABLE_NO_CHANGE" // 正常時：常用人数を維持、残業・臨時は基準値
  | "LABOR_OVERTIME_INCREASED_SHORTAGE" // 労働稼働率が高いため残業を引き上げ
  | "LABOR_TEMPORARY_INCREASED_SHORTAGE" // 残業が上限に達しているため臨時ワーカーを増員
  // --- 財務 ---
  | "FINANCING_NONE_CASH_SUFFICIENT" // 現金水準十分のため借入なし
  | "FINANCING_MINIMUM_BORROW_CASH_SHORTAGE" // 最低現金水準を下回るため必要最小限を借入
  | "FINANCING_VOLUNTARY_PREPAYMENT" // 現金余剰のため任意期限前返済
  // --- 設備投資 ---
  | "CAPEX_DEFERRED_STANDARD_POLICY"; // SAI-1では原則として投資しない

/** 1件の判断理由（対象会社・任意で対象商品／工場・簡潔な理由文つき）。 */
export interface StandardAiReasonEntry {
  readonly code: StandardAiReasonCode;
  readonly companyId: CompanyId;
  readonly product?: Product;
  readonly factoryId?: string;
  readonly message: string;
}

/** 1社・1四半期ぶんの標準AI診断情報（最終意思決定とは独立に、後から追跡できる）。 */
export interface StandardAiDecisionDiagnostics {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly turn: number;
  readonly reasons: readonly StandardAiReasonEntry[];
}

/** computeStandardAiDecision の戻り値（意思決定＋診断情報のペア）。 */
export interface StandardAiDecisionResult {
  readonly decision: CompanyDecisionInput;
  readonly diagnostics: StandardAiDecisionDiagnostics;
}

// ---------------------------------------------------------------------
// 2. 設定・閾値（5社共通。会社IDによる分岐は一切行わない）
// ---------------------------------------------------------------------

/** 標準AIの設定・閾値一式。5社すべてが同じインスタンスを参照する。 */
export interface StandardAiConfig {
  // --- 販売・生産 ---
  /** 潜在販売希望量 = 会社の商品別能力合計 × この比率（0〜1、全商品共通）。 */
  readonly productionTargetRatio: number;
  /** 完成品在庫が「潜在販売希望量 × この四半期数」を超えたら過剰とみなす。 */
  readonly finishedGoodsExcessQuarters: number;
  /** 完成品在庫過剰時の最大抑制率（0〜1。1なら理論上ゼロまで抑制しうる）。 */
  readonly finishedGoodsExcessMaxDamping: number;

  // --- 原料調達 ---
  /** 調達構成比（国内買付・輸入・自社養殖。合計はおおむね1.0）。5社共通の単一値。 */
  readonly sourcingMix: { readonly domestic: number; readonly import: number; readonly aquaculture: number };
  /** 期末原料在庫の目標（次期必要量に対する四半期数）。 */
  readonly rawInventoryTargetQuarters: number;
  /** 在庫補正の減衰係数（目標在庫との乖離のうち1四半期で埋めにいく比率）。 */
  readonly inventoryCorrectionDamping: number;
  /** 国内買付需要の下限（構成比ベース需要に対する比率）。 */
  readonly minDomesticPurchaseRatioOfMix: number;
  /** 来期の原料不足見込み時に積み増せる最大割合（基礎需要に対する追加割合、上限）。 */
  readonly rawMaterialShortageMaxBoostRatio: number;
  /** 養殖の期待収穫比率（池入れ量→収穫量の目安）。 */
  readonly expectedAquacultureHarvestRatio: number;

  // --- 労務 ---
  /** 前期労働稼働率がこの値以上なら「不足」とみなす。 */
  readonly laborShortageUtilizationThreshold: number;
  /** 正常時の基準残業率（低い既定値。前期から大きく動かさない）。 */
  readonly baseOvertimeRate: number;
  /** 残業率の上限。 */
  readonly maxOvertimeRate: number;
  /** 不足時に残業率を1段階引き上げる幅。 */
  readonly overtimeStepUp: number;
  /** 正常時の基準臨時ワーカー比率（常用人数に対する比率）。 */
  readonly baseTemporaryWorkerRatio: number;
  /** 臨時ワーカー比率の上限。 */
  readonly maxTemporaryWorkerRatio: number;
  /** 不足時（かつ残業が上限付近）に臨時ワーカー比率を1段階引き上げる幅。 */
  readonly temporaryWorkerStepUp: number;

  // --- 財務 ---
  /** この現金水準を下回ったら、その差額を必要最小限として借り入れる。 */
  readonly targetMinimumCashUsd: number;
  /** この現金水準を上回り、かつ既存借入があれば、超過分を任意期限前返済する。 */
  readonly voluntaryPrepaymentThresholdCashUsd: number;
  readonly desiredTermQuarters: number;
  readonly emergencyAcceptable: boolean;
  /** 現金不足時、調達希望量に掛ける最小の抑制率（0〜1。0.5なら最大で半分まで抑制）。 */
  readonly minProcurementThrottleRatio: number;
}
