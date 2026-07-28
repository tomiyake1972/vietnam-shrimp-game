// ShrimpX V2 — Phase SAI-1.5: マージ前受入修正（定量分析・原因分解レポート）
//
// 【本ファイルの位置づけ】三宅さんの指示（2026-07-28「Phase SAI-1 マージ前補完：
// 定量分析・原因分解レポート」）に基づき、SAI-1標準AIの5社完走結果を
// 「シナリオ・外部環境」「会社固有の初期条件」「ゲームルール・パラメータ」
// 「標準AIの圧力判定と意思決定」の4要因に分解して可視化・比較するための
// レポート専用モジュール群の型定義。ゲームエンジン本体（market/finance/
// financing/production等）へは一切依存を追加せず、既存の公開型を読み取るだけ。
// ゲームバランス自体は変更しない（本モジュールは分析・出力のみ）。

import { PeriodV2 } from "../../../core/period";
import { CompanyId } from "../../../sales/types";
import { DemandMarketId, Product } from "../../../market/types";
import { PressureScores } from "../pressures";
import { StandardAiDiagnosticEntry } from "../reasonCodes";

/** 数量・金額の単位を明示するための注記（レポート出力側の列見出し・凡例に使う）。 */
export type ReportUnit =
  | "HosoEqTons" // HOSO換算トン
  | "Tons" // 製品実トン（現行データではHOSO換算のみのためほぼ使わない）
  | "Usd"
  | "UsdPerHosoEqKg"
  | "Ratio0to1" // 比率（0〜1）
  | "Percent" // ％表示（Ratio0to1×100）
  | "Score0to100"
  | "Count"
  | "Quarters";

/** 「現行データでは取得不能」を明示するためのプレースホルダ値。 */
export const NOT_AVAILABLE = "現行データでは取得不能" as const;

/** 1社・1四半期ぶんの、KPI・希望値・実行値をまとめたフラットなレポート行。 */
export interface CompanyQuarterReportRow {
  readonly runLabel: string; // どの実行（例: "standardAi-8q-seed001"）に属するか
  readonly companyId: CompanyId;
  readonly turn: number;
  readonly period: PeriodV2;

  // --- 操業: 調達 ---
  readonly domesticPurchaseDesiredTons?: number; // 希望値（decisions.domesticPurchasePlan）
  readonly domesticPurchaseActualTons: number; // 実行値（companySummaries.domesticPurchaseQuantity）
  readonly domesticPurchasePriceUsdPerKg: number;
  readonly importOrderDesiredTons?: number;
  readonly importArrivedTons: number;
  readonly aquacultureHarvestedTons: number;
  readonly rawMaterialInventoryTons: number;
  readonly rawMaterialInventoryMonths: number | typeof NOT_AVAILABLE;

  // --- 操業: 生産 ---
  readonly productionDesiredTonsByProduct: Readonly<Record<Product, number | undefined>>; // decisions.productionPlans
  readonly productionActualTonsByProduct: Readonly<Record<Product, number>>; // companySummaries.{hoso,pd,vap}Produced
  readonly finishedGoodsInventoryTonsByProduct: Readonly<Record<Product, number>>;
  readonly finishedGoodsInventoryMonthsByProduct: Readonly<Record<Product, number>>;

  // --- 操業: 労働 ---
  readonly regularHeadcount: number;
  readonly temporaryHeadcountShareActual: number; // Ratio
  readonly overtimeRateActual: number; // Ratio
  readonly laborUtilizationRateActual: number; // Ratio（前期実績。engine側の定義に既知の限界あり。§注記参照）
  readonly equipmentUtilizationRateActual: number; // Ratio

  // --- 販売 ---
  readonly grossRevenueUsd: number;
  readonly netRevenueUsd: number;
  readonly averageSellingPriceUsdPerKgByProduct: Readonly<Record<Product, number | typeof NOT_AVAILABLE>>;
  readonly salesQuantityByMarket: Readonly<Partial<Record<DemandMarketId, number>>>;
  readonly salesQuantityByProduct: Readonly<Record<Product, number>>;
  readonly outstandingContractTons: number;
  readonly overdueContractTons: number;
  readonly contractFulfillmentRate: number | typeof NOT_AVAILABLE; // fulfilled/(fulfilled+outstanding)近似
  readonly marketShareByMarket: Readonly<Partial<Record<DemandMarketId, number>>>; // 当該市場×商品の配分アルゴリズム内シェア（実測、5社+外部オプション比）

  // --- 原価・収益 ---
  readonly domesticRawMaterialCostUsd: number;
  readonly importedRawMaterialCostUsd: number;
  readonly aquacultureRawMaterialCostUsd: number;
  readonly grossProfitUsd: number;
  readonly grossProfitMarginRatio: number;
  readonly operatingProfitUsd: number;
  readonly operatingProfitMarginRatio: number;
  readonly netIncomeUsd: number;
  readonly contributionMarginByProduct: Readonly<Record<Product, number | typeof NOT_AVAILABLE>>;

  // --- 財務 ---
  readonly cashUsd: number;
  readonly accountsReceivableUsd: number;
  readonly accountsPayableUsd: number;
  readonly shortTermLoansUsd: number;
  readonly longTermLoansUsd: number;
  readonly emergencyLoanUsd: number;
  readonly totalEquityUsd: number;
  readonly operatingCashFlowUsd: number;
  readonly financialHealthPrimary: string;
  readonly paymentDefault: boolean;
  readonly covenantBreach: boolean;
  readonly procurementScaleRatio: number | typeof NOT_AVAILABLE; // 資金制約による操業縮小率の元値（1=制約なし）

  // --- 品質・競争力 ---
  readonly qualityScoreByProduct: Readonly<Record<Product, number | undefined>>;
  readonly customerTrustByMarket: Readonly<Partial<Record<DemandMarketId, number>>>;
  readonly deliveryReliabilityByMarket: Readonly<Partial<Record<DemandMarketId, number>>>;
  readonly onTimeDeliveryRate: number | undefined;
  readonly downgradeQuantityTons: number;
  readonly reworkQuantityTons: number;
  readonly discardQuantityTons: number;
  readonly majorIncidentCount: number;

  // --- 標準AI: 圧力・意思決定理由（standardAi実行のみ。autoPolicy実行では undefined） ---
  readonly pressures?: PressureScores;
  readonly firedReasonCodes?: readonly StandardAiDiagnosticEntry[];
  readonly financingDesiredAmountUsd?: number;
  readonly financingDesiredPrepaymentUsd?: number;
  readonly capexProposalCount?: number;
}

/** 1四半期ぶんの、シナリオ・外部環境スナップショット（会社非依存＝業界共通）。 */
export interface ScenarioQuarterRow {
  readonly runLabel: string;
  readonly turn: number;
  readonly period: PeriodV2;
  readonly scenarioId: string;
  readonly mode: string;
  /** 固定シナリオ（canonical=イベントは決定論的スケジュール、乱数消費なし）か、
   *  seedに応じた変動（variation=開始・持続・規模がseed由来でジッターする）かの区分。 */
  readonly eventTiming: "fixed_schedule" | "seed_jittered";
  readonly worldDemandIndexApprox: number; // 業界需要指数の近似値（marketInput.demandMarketsから算出）
  readonly economicIndexByMarket: Readonly<Record<DemandMarketId, number>>;
  readonly priorPeriodConsumptionByMarket: Readonly<Record<DemandMarketId, number>>;
  readonly aquacultureCostIndexByCountry: Readonly<Record<string, number>>;
  readonly countryProductionByCountry: Readonly<Record<string, number>>;
  readonly countryQualityScoreByCountry: Readonly<Record<string, number>>;
  readonly countryReliabilityScoreByCountry: Readonly<Record<string, number>>;
  readonly vietnamDomesticRawSupplyTons: number;
  readonly vietnamDomesticProcurementIntentTons: number;
  readonly priceDriverCodes: readonly string[]; // marketResultの理由コード（何が価格を動かしたか）
  /** 未実装のカテゴリ（自然災害・疫病を独立事象として・為替等）は空配列ではなく
   *  明示的に「未実装」注記を別途 report/generate.ts のnotesに出す。 */
}

/** 会社別の初期条件比較1行（属性1件）。 */
export interface InitialConditionRow {
  readonly attribute: string;
  readonly unit: ReportUnit | string;
  readonly valueByCompany: Readonly<Record<CompanyId, number | string>>;
  readonly note: string; // この初期差がどの圧力・意思決定に影響し得るか
}

/** 会社間格差の原因分解テスト結果1本ぶん。 */
export interface DecompositionRunSummary {
  readonly testId: "A" | "B" | "C" | "D";
  readonly testLabel: string;
  readonly seed: string;
  readonly turns: number;
  readonly finalByCompany: Readonly<
    Record<
      CompanyId,
      {
        readonly finalCashUsd: number;
        readonly finalEquityUsd: number;
        readonly cumulativeRevenueUsd: number;
        readonly cumulativeOperatingProfitUsd: number;
        readonly outstandingContractTons: number;
        readonly paymentDefaultQuarter: number | null; // 初めてpaymentDefaultになったturn（無ければnull）
      }
    >
  >;
}

/** 複数seedにわたる分布集計（1指標×1会社）。 */
export interface MultiSeedDistributionEntry {
  readonly companyId: CompanyId;
  readonly metric: string;
  readonly seedCount: number;
  readonly values: readonly number[];
  readonly mean: number;
  readonly stdev: number;
  readonly min: number;
  readonly max: number;
}

export interface MultiSeedSummary {
  readonly testId: "A" | "D";
  readonly seeds: readonly string[];
  readonly turns: number;
  readonly paymentDefaultRateByCompany: Readonly<Record<CompanyId, number>>; // 0〜1
  readonly distributions: readonly MultiSeedDistributionEntry[];
}
