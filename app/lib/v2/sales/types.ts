// ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール 共通型（Phase 4）
//
// 既存のPhase1（市場価格）・Phase2（シナリオ）・Phase3（業界シミュレーション）が
// 確立した規約をそのまま踏襲する。
//   - 数量: HosoEqTons（HOSO換算トン）に統一
//   - 価格: UsdPerHosoEqKg（USD/HOSO換算kg）に統一
//   - 市場ID: DemandMarketId（"CN"|"US"|"EU"|"JP"|"OTHER"、market/types.ts）を再利用
//   - 商品区分: Product（"hoso"|"pd"|"vap"、market/types.ts）を再利用
//   - Period: PeriodV2（core/period.ts）を再利用
// 新しい市場ID・商品区分・数量単位は一切追加しない。
//
// 会社ID: V2 core（app/lib/v2/core/gameSession.ts の GameSessionV2.companyIds）は
// 会社を固定enumではなく `readonly string[]` として扱っている。本モジュールも
// その規約を踏襲し、CompanyId は単なる string のエイリアスとする
// （5社という数はゲーム設定であり、型システムでは固定しない）。

import { HosoEqTons, Score0to100, UsdPerHosoEqKg } from "../core/units";
import { PeriodV2 } from "../core/period";
import { DemandMarketId, MarketQuarterInput, MarketQuarterResult, Product } from "../market/types";
import type { MarketSalesEffortAdjustment } from "./marketEffort";
import type { ProcessingAdvantageOptions } from "./marketAdapter";

export class SalesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesValidationError";
  }
}

/** V2 core（gameSession.ts）の companyIds 規約を踏襲した単純なstringエイリアス。 */
export type CompanyId = string;

// ---------------------------------------------------------------------
// 1. 販売計画・営業人員（入力）
// ---------------------------------------------------------------------

/**
 * 1社・1市場・1商品区分あたりの当期販売計画。
 * askPrice（提示価格）は `basePrice(product) + priceAdjustmentUsdPerHosoEqKg` として
 * 導出する。調整額は値引き（負）・上乗せ（正）の両方を許すため、0以上制約のある
 * UsdPerHosoEqKg ブランド型ではなくプレーンnumberで保持する（実際の提示価格
 * askPrice自体は0以上を検証した上でUsdPerHosoEqKgとして扱う）。
 */
export interface CompanySalesPlanEntry {
  readonly companyId: CompanyId;
  readonly market: DemandMarketId;
  readonly product: Product;
  /** 販売希望量。 */
  readonly desiredQuantity: HosoEqTons;
  /** Phase3基準価格に対する提示価格の調整額（USD/HOSO換算kg）。値引きは負値。 */
  readonly priceAdjustmentUsdPerHosoEqKg: number;
  /** 配置する営業人員数（0以上の整数）。 */
  readonly salesForceHeadcount: number;
  /**
   * 希望リードタイム（成約四半期から納期までのターン数、1以上）。
   * 省略時は SalesParameters.standardLeadTimeTurns（標準リードタイム、既定1＝翌四半期）を使う。
   */
  readonly desiredLeadTimeTurns?: number;
  /** 顧客関係スコア（0〜100）。未接続時は中立値（parameters.tsのNEUTRAL_SCORE）。 */
  readonly customerRelationship?: Score0to100;
  /** 品質評価（0〜100、Phase1のqualityScoreと同じ尺度）。未接続時は中立値。 */
  readonly qualityReputation?: Score0to100;
  /** 納期信頼性評価（0〜100）。未接続時は中立値。Phase7で実データに置き換える想定。 */
  readonly deliveryReliability?: Score0to100;
  /** 【SAI-5D】この市場×商品への営業基盤スコア（0〜100、companyLab/salesBase.tsの
   *  蓄積ストック。前四半期末までの値）。未接続時は中立値。ウェイト
   *  （competitivenessWeights.salesBase）が既定0のため、値の有無に関わらず
   *  既定パラメータでは成約結果へ一切影響しない。 */
  readonly salesBaseScore?: Score0to100;
  /**
   * 【Test15新設】このentryの商品がVAPのときにのみ意味を持つ、会社のVAP能力合成
   * 係数（0〜100、companyLab/premiumPolicy.tsのcalculateCompanyCapabilityCoefficient
   * 由来。VAP商品開発スコア・VAP営業基盤・品質・納期信頼性の合成）。未接続時は
   * 中立値。ウェイト（competitivenessWeights.vapCapability）が既定0のため、値の
   * 有無に関わらず既定パラメータでは成約結果へ一切影響しない。product!=="vap"の
   * entryでは、値が設定されていても寄与は構造的に常に0（allocation.ts参照）。
   */
  readonly vapCapabilityScore?: Score0to100;
  /**
   * 承認済み取引枠・供給信認枠（外部から供給される任意の個社成約上限）。
   * 将来Phase（与信・取引先管理等）から接続される想定の外部入力で、未指定時は
   * SalesParameters.maximumSupplierShareに基づく上限（targetDemand×shareの下限）を
   * そのまま使う。指定された場合は、他の上限（販売希望量・処理能力・
   * maximumSupplierShare由来の上限）と合わせて、その最小値を個社成約上限とする。
   */
  readonly approvedAllocationCap?: HosoEqTons;
  /**
   * 販売計画時点の予想原価（Phase 6.3、実装指示 §9）。設定時は成約契約へ
   * ContractCostSnapshotとして引き継がれる。
   */
  readonly costExpectation?: PlanCostExpectation;
}

// ---------------------------------------------------------------------
// 2. 成約配分（出力）
// ---------------------------------------------------------------------

/**
 * 【Phase 7B】competitivenessWeightの内訳（読み取り専用の説明用データ）。
 * computeCompetitivenessWeight（app/lib/v2/sales/allocation.ts）が実際に使う
 * 計算式そのものから導出する（UI側では一切再計算しない）。5つの
 * contributionの合計が必ずcompetitivenessWeightと厳密に一致する
 * （同一の計算式・同一の加算順序）。
 */
export interface CompetitivenessWeightBreakdown {
  /** 価格競争力のウェイト寄与分（w.price × 正規化した価格スコア）。 */
  readonly priceContribution: number;
  /** 営業カバレッジのウェイト寄与分。 */
  readonly coverageContribution: number;
  /** 顧客関係のウェイト寄与分。 */
  readonly relationshipContribution: number;
  /** 品質評価のウェイト寄与分。 */
  readonly qualityContribution: number;
  /** 納期信頼性のウェイト寄与分。 */
  readonly deliveryReliabilityContribution: number;
  /** 【SAI-5D】営業基盤のウェイト寄与分（既定ウェイト0のため既定では常に0）。 */
  readonly salesBaseContribution: number;
  /** 【Test15新設】VAP能力合成係数のウェイト寄与分（既定ウェイト0のため既定では
   *  常に0。かつproduct!=="vap"のentryでは常に0＝HOSO/PDには一切影響しない）。 */
  readonly vapCapabilityContribution: number;
  /** clamp前の生の価格スコア（説明用、診断目的）。 */
  readonly rawPriceScore: number;
  /** clamp後の価格スコア（この値がmaximumPriceCompetitivenessに達していれば、追加値下げの効果はない）。 */
  readonly clampedPriceScore: number;
  /** 価格競争力が上限（maximumPriceCompetitiveness）に到達しているか。 */
  readonly isPriceScoreAtCeiling: boolean;
  /** 価格競争力が下限（minimumPriceCompetitiveness）に到達しているか。 */
  readonly isPriceScoreAtFloor: boolean;
}

/** 1社・1市場・1商品区分の成約配分結果（内訳付き）。 */
export interface CompanyAllocationEntry {
  readonly companyId: CompanyId;
  /** 提示価格（basePrice + priceAdjustment）。 */
  readonly askPrice: UsdPerHosoEqKg;
  /** 営業人員から導出した市場カバレッジ（0〜1、逓減曲線）。 */
  readonly coverageScore: number;
  /** 営業人員・処理能力から導出した処理上限。 */
  readonly processingCapacity: HosoEqTons;
  /** 配分アルゴリズムで用いた合成競争力ウェイト。 */
  readonly competitivenessWeight: number;
  /**
   * 【Phase 7B】competitivenessWeightの内訳（読み取り専用、説明用）。
   * 【SAI-5 監査指摘A】すべてのcontribution（salesBaseContributionを含む6項目）の
   * 合計が必ずcompetitivenessWeightと一致する。合計処理はallocation.tsの
   * sumCompetitivenessContributionsへ一本化されている。
   */
  readonly competitivenessBreakdown: CompetitivenessWeightBreakdown;
  /** 成約量（0 <= allocatedQuantity <= min(desiredQuantity, processingCapacity)）。 */
  readonly allocatedQuantity: HosoEqTons;
}

/** 1市場×1商品区分ぶんの成約配分結果全体。 */
export interface MarketProductAllocationResult {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly period: PeriodV2;
  readonly basePrice: UsdPerHosoEqKg;
  /** このmarket×productの対象需要（Phase3市場結果からのアダプター導出値）。 */
  readonly targetDemand: HosoEqTons;
  readonly companies: readonly CompanyAllocationEntry[];
  /** 5社以外（他産地供給者・非購入）に流れた需要。 */
  readonly externalOptionQuantity: HosoEqTons;
}

// ---------------------------------------------------------------------
// 3. 契約・約定残
// ---------------------------------------------------------------------

export type ContractStatus =
  | "open" // 未履行
  | "partiallyFulfilled" // 一部履行
  | "fulfilled" // 完了
  | "overdue" // 納期超過
  | "cancelled"; // キャンセル

/**
 * 【Phase 6.3（実装指示 §9）】販売計画時点の予想原価（契約スナップショットの元）。
 * 販売時点の予想原料価格・予想加工費で受注可否を判断し、契約後に実際の原料価格・
 * 残業・加工費等が上昇しても契約単価を自動改定しないための記録。すべて
 * USD/HOSO換算kg。
 */
export interface PlanCostExpectation {
  /** 契約時予想原料価格。 */
  readonly expectedRawMaterialPriceUsdPerHosoEqKg: number;
  /** 契約時予想加工費。 */
  readonly expectedProcessingCostUsdPerHosoEqKg: number;
  /** 最低受注価格（これ未満では受注しない判断基準）。 */
  readonly minimumAcceptablePriceUsdPerHosoEqKg: number;
}

/**
 * 【Phase 6.3（実装指示 §9）】契約に保持する契約時スナップショット。
 * Phase 8で実績原価と突き合わせて検証できるよう、成約単価確定時の
 * 予想貢献利益（unitPrice − 予想原料価格 − 予想加工費）も保持する。
 */
export interface ContractCostSnapshot extends PlanCostExpectation {
  /** 契約時予想貢献利益（USD/HOSO換算kg）。 */
  readonly expectedContributionMarginUsdPerHosoEqKg: number;
}

export interface SalesContract {
  readonly contractId: string;
  readonly companyId: CompanyId;
  readonly market: DemandMarketId;
  readonly product: Product;
  /** 成約四半期。 */
  readonly contractedPeriod: PeriodV2;
  /** 納期。 */
  readonly dueDate: PeriodV2;
  /** 当初契約数量。 */
  readonly originalQuantity: HosoEqTons;
  /** 未履行数量（0 <= outstandingQuantity <= originalQuantity）。 */
  readonly outstandingQuantity: HosoEqTons;
  /** 成約単価（= 成約時点のaskPrice）。 */
  readonly unitPrice: UsdPerHosoEqKg;
  readonly status: ContractStatus;
  /**
   * 契約時予想原価スナップショット（Phase 6.3、実装指示 §9）。販売計画が
   * costExpectationを持つ場合のみ設定される（後方互換のためオプショナル）。
   */
  readonly costSnapshot?: ContractCostSnapshot;
}

// ---------------------------------------------------------------------
// 4. 履行実績（Phase 6から渡される想定の入力）
// ---------------------------------------------------------------------

/** 契約IDを明示して履行数量を適用する指示。 */
export interface ExplicitFulfillmentInstruction {
  readonly kind: "explicit";
  readonly contractId: string;
  readonly quantity: HosoEqTons;
}

/** 会社×市場×商品を指定し、古い契約から順（FIFO）に履行数量を適用する指示。 */
export interface FifoFulfillmentInstruction {
  readonly kind: "fifo";
  readonly companyId: CompanyId;
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly quantity: HosoEqTons;
}

export type FulfillmentInstruction = ExplicitFulfillmentInstruction | FifoFulfillmentInstruction;

// ---------------------------------------------------------------------
// 5. 四半期ランナー
// ---------------------------------------------------------------------

/** advanceSalesQuarter への当期入力。 */
export interface SalesQuarterInput {
  readonly plans: readonly CompanySalesPlanEntry[];
  /** Phase3市場計算モジュールの当期結果（価格の入力アダプターとして使うのみ）。 */
  readonly marketResult: MarketQuarterResult;
  /**
   * Phase3市場計算モジュールの当期入力（市場別 priorPeriodConsumption を、対象需要を
   * 市場ごとへ按分する相対ウェイトとして読むだけに使う。需要成長式の再計算はしない）。
   */
  readonly marketInput: MarketQuarterInput;
  /**
   * 【Phase 8F-1】対象需要（targetDemand）を市場ごとへ按分する構成比の上書き。
   * market/consumerInventory.ts の deriveMarketWeightsFromDesiredPurchase が
   * 算出した「希望購買量ベースの市場別ウェイト」を渡す想定。省略時は
   * deriveTargetDemand が既存の priorPeriodConsumption ベースの按分へ
   * フォールバックする（後方互換）。
   */
  readonly marketWeights?: Readonly<Record<DemandMarketId, number>>;
  /**
   * 【SAI-5C】市場×商品の需要構成比行列（market/productLifecycle.ts の
   * computeMarketProductMix）。deriveTargetDemand へそのまま渡すだけ
   * （省略時は既存の世界一律商品構成比へフォールバックする。後方互換）。
   */
  readonly marketProductMix?: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>;
  /**
   * 【加工品市場進化 §d】ベトナムの加工優位を対象需要の商品構成へ反映する設定。
   * deriveTargetDemand へそのまま渡すだけ（省略時は従来の世界平均構成比按分）。
   */
  readonly processingAdvantage?: ProcessingAdvantageOptions;
}

/** 1四半期分の成約計算・契約生成の記録。 */
export interface SalesQuarterRecord {
  readonly period: PeriodV2;
  readonly allocations: readonly MarketProductAllocationResult[];
  readonly newContracts: readonly SalesContract[];
  /**
   * 【SAI-2追加作業: 市場別営業配置・商品別営業工数】会社×市場ごとの営業工数換算
   * 能力制約により、当期の販売計画（desiredQuantity）が実際に比例縮小された場合の
   * 記録（sales/marketEffort.ts の applyMarketSalesEffortCapacity）。縮小が
   * 発生しなかった会社×市場は含まれない（空配列＝当期は誰も制約に達しなかった）。
   */
  readonly salesEffortAdjustments: readonly MarketSalesEffortAdjustment[];
}

export interface SalesState {
  /** 次にadvanceSalesQuarterを呼んだ際に処理される四半期。 */
  readonly currentPeriod: PeriodV2;
  /** これまでに生成された全契約（最新の状態）。 */
  readonly contracts: readonly SalesContract[];
  readonly history: readonly SalesQuarterRecord[];
}
