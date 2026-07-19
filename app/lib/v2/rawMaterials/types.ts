// ShrimpX V2 — 国内原料・輸入・養殖・原料在庫モジュール 共通型（Phase 5）
//
// Phase1（市場・価格形成）・Phase4（販売・約定残）が確立した規約をそのまま踏襲する。
//   - 数量: HosoEqTons（HOSO換算トン）に統一
//   - 価格: UsdPerHosoEqKg（USD/HOSO換算kg）に統一
//   - 会社ID: CompanyId（Phase4 sales/types.ts の string エイリアスをそのまま再利用）
//   - 産地: CountryId（Phase1 market/types.ts、"EC"|"IN"|"ID"|"VN"）を再利用
//   - Period: PeriodV2（core/period.ts）を再利用
// 新しい産地・数量単位は一切追加しない。

import { HosoEqTons, Ratio, Score0to100, UsdPerHosoEqKg } from "../core/units";
import { PeriodV2 } from "../core/period";
import { CountryId, Product } from "../market/types";
import type { CompanyId } from "../sales/types";

export class RawMaterialsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawMaterialsValidationError";
  }
}

export type { CompanyId };

// ---------------------------------------------------------------------
// 1. 約定残からの必要原料量集計
// ---------------------------------------------------------------------

/** 会社×納期×商品区分ごとに集計した必要HOSO換算数量（意思決定支援情報。自動発注しない）。 */
export interface RawMaterialRequirementEntry {
  readonly companyId: CompanyId;
  readonly dueDate: PeriodV2;
  readonly product: Product;
  /** 対象契約（open/partiallyFulfilled）の outstandingQuantity 合計。 */
  readonly requiredQuantity: HosoEqTons;
}

// ---------------------------------------------------------------------
// 2. 国内原料買付計画（入力）
// ---------------------------------------------------------------------

/**
 * 1社あたりの当期・国内原料買付計画。
 * bidPrice（提示買付価格）は `marketPrice + priceAdjustmentUsdPerHosoEqKg` として導出する
 * （Phase4のaskPrice導出と対称。値引き調整はマイナス、値上げ調整はプラス）。
 */
export interface DomesticPurchasePlanEntry {
  readonly companyId: CompanyId;
  /** 国内買付希望量。 */
  readonly desiredQuantity: HosoEqTons;
  /** Phase3が清算した国内原料価格（VietnamDomesticResult.price）に対する提示価格の調整額。 */
  readonly priceAdjustmentUsdPerHosoEqKg: number;
  /** 配置する調達人員数（0以上の整数）。市場カバレッジと同様の逓減曲線でカバレッジへ変換する。 */
  readonly procurementHeadcount: number;
  /**
   * 【Phase 6.3（実装指示 §6）】会社の工場共通原料処理能力の合計（HOSO換算トン/四半期）。
   * 指定時は調達処理能力を工場能力連動方式（capacityFactoryLinked）で算出する。
   * 未指定時は従来の絶対値カーブ（baselineCapacityTons等）へフォールバック（後方互換）。
   */
  readonly factoryCommonProcessingCapacityTons?: number;
  /** 養殖業者との関係スコア（0〜100）。未接続時は中立値。 */
  readonly farmerRelationship?: Score0to100;
  /** 支払・引取信頼性評価（0〜100）。未接続時は中立値。 */
  readonly paymentReliability?: Score0to100;
  /** 承認済み買付枠（任意の外部入力）。未指定時はmaximumBuyerShare由来の上限を使う。 */
  readonly approvedPurchaseCap?: HosoEqTons;
}

// ---------------------------------------------------------------------
// 3. 国内供給配分（出力）
// ---------------------------------------------------------------------

export interface CompanyDomesticPurchaseAllocationEntry {
  readonly companyId: CompanyId;
  /** 提示買付価格（marketPrice + priceAdjustment）。 */
  readonly bidPrice: UsdPerHosoEqKg;
  /** 調達人員から導出した調達カバレッジ（0〜1、逓減曲線）。 */
  readonly coverageScore: number;
  /** 配分アルゴリズムで用いた合成競争力ウェイト。 */
  readonly competitivenessWeight: number;
  /** 実際に配分された買付量（0 <= allocatedQuantity <= 各種上限）。 */
  readonly allocatedQuantity: HosoEqTons;
}

/** 国内原料市場（Phase3清算結果）に対する1四半期分の配分結果。 */
export interface DomesticPurchaseAllocationResult {
  readonly period: PeriodV2;
  /** Phase3のVietnamDomesticResult.price（会社の提示価格が競う基準）。 */
  readonly marketPrice: UsdPerHosoEqKg;
  /** Phase3のVietnamDomesticResult.supply（今期配分できる供給総量）。 */
  readonly availableSupply: HosoEqTons;
  readonly companies: readonly CompanyDomesticPurchaseAllocationEntry[];
  /** どの会社にも配分されなかった残余供給。 */
  readonly unallocatedSupply: HosoEqTons;
}

// ---------------------------------------------------------------------
// 4. 輸入原料
// ---------------------------------------------------------------------

/** 1件の輸入注文（入力）。 */
export interface ImportOrderInput {
  readonly companyId: CompanyId;
  readonly originCountry: CountryId;
  readonly orderedQuantity: HosoEqTons;
  readonly orderedPeriod: PeriodV2;
  /** 発注から到着までのターン数（1以上）。省略時は標準リードタイム。 */
  readonly leadTimeTurns?: number;
  /** 最大許容着地価格（この価格を超える場合は注文を拒否する、任意の注文条件）。 */
  readonly maxLandedPriceUsdPerHosoEqKg?: UsdPerHosoEqKg;
}

/**
 * 輸入着地価格の内訳。原産国別調整額はマイナス（値引き相当）もあり得るため、
 * 内訳の各加算項はブランド型（0以上制約）ではなくプレーンnumberで保持する
 * （Phase4のpriceAdjustmentUsdPerHosoEqKgと同じ理由）。最終的なlandedPriceのみ
 * 0以上を検証したUsdPerHosoEqKgとする。
 */
export interface ImportLandedPriceBreakdown {
  readonly originPrice: UsdPerHosoEqKg;
  readonly freightUsdPerHosoEqKg: number;
  readonly dutyAndTaxUsdPerHosoEqKg: number;
  readonly insuranceAndHandlingUsdPerHosoEqKg: number;
  readonly originCountryAdjustmentUsdPerHosoEqKg: number;
  readonly landedPrice: UsdPerHosoEqKg;
}

// ---------------------------------------------------------------------
// 5. 養殖
// ---------------------------------------------------------------------

/** 1社・1池入れぶんの養殖計画（入力）。 */
export interface AquacultureStockingPlanEntry {
  readonly companyId: CompanyId;
  /** 会社別養殖能力（この池入れが超えてはならない上限）。 */
  readonly aquacultureCapacity: HosoEqTons;
  /** 池入れ予定生産量（養殖強度による補正前のベース量）。 */
  readonly plannedStockingQuantity: HosoEqTons;
  /** 養殖強度（0〜1）。高いほど予定生産量が増えるが、疾病への脆弱性も増す。 */
  readonly aquacultureIntensity: Ratio;
  /** バイオセキュリティ水準（0〜1）。高いほど疾病損失を緩和する。 */
  readonly bioSecurityLevel: Ratio;
  readonly stockingPeriod: PeriodV2;
  /** 予定収穫四半期。省略時は池入れの翌四半期（標準）。 */
  readonly harvestPeriod?: PeriodV2;
}

/** 養殖収穫の計算結果。 */
export interface AquacultureHarvestResult {
  readonly companyId: CompanyId;
  readonly stockingPeriod: PeriodV2;
  readonly harvestPeriod: PeriodV2;
  readonly plannedStockingQuantity: HosoEqTons;
  /** 養殖強度による補正後、疾病影響前の予定生産量。 */
  readonly expectedProduction: HosoEqTons;
  /** 収穫時点の疾病圧力（Phase2/3シナリオからの外部入力、または0）。 */
  readonly diseasePressure: Ratio;
  /** 疾病・バイオセキュリティを反映した生残率。 */
  readonly survivalRatio: Ratio;
  /** 実際の収穫量（= expectedProduction × survivalRatio）。 */
  readonly actualHarvestQuantity: HosoEqTons;
  readonly unitCost: UsdPerHosoEqKg;
}

// ---------------------------------------------------------------------
// 6. 原料在庫（ロット）
// ---------------------------------------------------------------------

export type RawMaterialSource = "domestic" | "import" | "aquaculture";

export type RawMaterialLotStatus =
  | "available" // 使用可能在庫
  | "inTransitImport" // 輸送中輸入原料
  | "growingAquaculture" // 養殖中
  | "consumed" // 消費済み（remainingQuantity=0）
  | "expired"; // 期限切れ・廃棄

/** 原料1ロット。国内買付・輸入・自社養殖のいずれから調達したかを問わず同じ形で管理する。 */
export interface RawMaterialLot {
  readonly lotId: string;
  readonly companyId: CompanyId;
  readonly source: RawMaterialSource;
  /** 国内買付・自社養殖は "VN"、輸入は発注時の原産国。 */
  readonly originCountry: CountryId;
  /** 入庫（購入・発注／池入れ）四半期。 */
  readonly inboundPeriod: PeriodV2;
  /** ロット生成時点の当初数量（消費・廃棄によらず不変の記録）。 */
  readonly originalQuantity: HosoEqTons;
  /** 残数量（FIFO消費・期限切れにより減少する）。 */
  readonly remainingQuantity: HosoEqTons;
  /** 単位取得原価。 */
  readonly unitCost: UsdPerHosoEqKg;
  /** 使用可能になる四半期（輸送中・養殖中の場合は到着・収穫予定四半期）。 */
  readonly availableFromPeriod: PeriodV2;
  /** 使用期限（任意）。この四半期を過ぎると期限切れとして扱う。 */
  readonly expiryPeriod?: PeriodV2;
  readonly status: RawMaterialLotStatus;

  // --- status="growingAquaculture" のロットが収穫時（harvestAquacultureLots）に
  // 生残率を再計算するために保持する、池入れ計画由来の情報。他sourceのロットでは
  // 未設定。四半期をまたいでも参照できるよう、外部のマップではなくロット自体へ
  // 保持する（RawMaterialsStateに別途pending一覧を持たせる設計を避けるため）。
  readonly pendingAquacultureIntensity?: Ratio;
  readonly pendingBioSecurityLevel?: Ratio;
  readonly pendingPlannedStockingQuantity?: HosoEqTons;
}

// ---------------------------------------------------------------------
// 7. 在庫消費（Phase6向けインターフェース）
// ---------------------------------------------------------------------

/** Phase6から渡される外部消費指示（会社単位、FIFOで消費する）。 */
export interface RawMaterialConsumptionInstruction {
  readonly companyId: CompanyId;
  readonly quantity: HosoEqTons;
}

// ---------------------------------------------------------------------
// 8. 四半期ランナー
// ---------------------------------------------------------------------

export interface RawMaterialsQuarterInput {
  readonly domesticPurchasePlans: readonly DomesticPurchasePlanEntry[];
  readonly importOrders: readonly ImportOrderInput[];
  readonly aquacultureStockingPlans: readonly AquacultureStockingPlanEntry[];
  /** Phase3のベトナム国内原料市場清算結果（当期分。呼び出し側がPhase1/3から取得して渡す）。 */
  readonly vietnamDomesticPrice: UsdPerHosoEqKg;
  /**
   * プレイヤー系会社の配分原資となる国内原料量。
   * 【Phase 6.3】外部加工業者需要の導入により、国内市場全体の供給量そのものではなく
   * 「当期の実際の取引成立量のうち会社側意向に比例する分」を渡す想定
   * （turn/runner.tsのcompanyAvailableDomesticSupply参照）。
   */
  readonly vietnamDomesticSupply: HosoEqTons;
  /**
   * 1社あたりの最大買付シェア（maximumBuyerShare）の基準供給量（Phase 6.3）。
   * 未指定時はvietnamDomesticSupplyを基準とする（後方互換）。外部需要導入後は
   * 国内市場全体の供給量を渡し、シェア上限の意味（市場全体に対する買い占め防止）を
   * 維持する。
   */
  readonly shareCapReferenceSupply?: HosoEqTons;
  /** Phase1の国別HOSO FOB価格（輸入着地価格の起点）。 */
  readonly originHosoFobPrice: Readonly<Record<CountryId, UsdPerHosoEqKg>>;
  /** Phase1の国別exportableSupply（輸入上限算出の起点）。 */
  readonly originExportableSupply: Readonly<Record<CountryId, HosoEqTons>>;
  /** 当期のベトナム疾病圧力（Phase2/3シナリオからの外部入力）。未指定時は0（疾病なし）。 */
  readonly diseasePressure?: Ratio;
}

export interface RawMaterialsQuarterRecord {
  readonly period: PeriodV2;
  readonly requirements: readonly RawMaterialRequirementEntry[];
  readonly domesticAllocation: DomesticPurchaseAllocationResult;
  readonly newImportLots: readonly RawMaterialLot[];
  readonly arrivedImportLots: readonly RawMaterialLot[];
  readonly newGrowingLots: readonly RawMaterialLot[];
  readonly harvestedLots: readonly RawMaterialLot[];
  /**
   * 当四半期に収穫処理（harvestAquacultureLots）が対象とした収穫の内訳
   * （疾病圧力・生残率等、ロット化後には失われる情報を保持する）。
   * ターン・オーケストレーター（app/lib/v2/turn/）がTurnOrchestratorResult.
   * aquacultureHarvestResultsをそのまま転記できるよう、Phase5自身の記録として
   * ここに追加する（Phase5開発中の自モジュール内での加筆であり、Phase1-4や
   * GameSessionV2プレースホルダ型には影響しない）。
   */
  readonly harvestResults: readonly AquacultureHarvestResult[];
  readonly expiredLots: readonly RawMaterialLot[];
}

export interface RawMaterialsState {
  readonly currentPeriod: PeriodV2;
  readonly lots: readonly RawMaterialLot[];
  readonly history: readonly RawMaterialsQuarterRecord[];
}
