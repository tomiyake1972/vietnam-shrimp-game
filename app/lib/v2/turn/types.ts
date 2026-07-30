// ShrimpX V2 — ターン・オーケストレーター 共通型（Phase 5後続差分）
//
// Phase1（市場・価格形成）・Phase4（販売・約定残）・Phase5（国内原料・輸入・
// 養殖・原料在庫）を、決定論的な純粋関数として一貫した順序で実行するための
// アプリケーション層の境界。永続化（Redis）・API・UIには一切依存しない。
//
// 【重要】現時点でV2には本番ターン実行経路・意思決定保存スキーマ・APIルートが
// 存在しない（調査済み）。本モジュールはそれらの「代わり」ではなく、将来の
// V2 API・Redis・UIが呼び出すための土台（アプリケーション層）として新設する。
// V1のAPI・Redis・CompanyDecision型には一切接続しない。

import { RandomStream } from "../core/random";
import { PeriodV2 } from "../core/period";
import { HosoEqTons, Ratio, UsdPerHosoEqKg } from "../core/units";
import { CountryId, DemandMarketId, MarketQuarterInput, MarketQuarterResult, Product } from "../market/types";
import { MarketParameters } from "../market/parameters";
import { DestinationMarketPriceCoefficientTable } from "../market/destinationPricingParameters";
import { CompanySalesPlanEntry, SalesContract, SalesQuarterRecord } from "../sales/types";
import { SalesParameters } from "../sales/parameters";
import {
  AquacultureHarvestResult,
  AquacultureStockingPlanEntry,
  CompanyId,
  DomesticPurchaseAllocationResult,
  DomesticPurchasePlanEntry,
  ImportOrderInput,
  RawMaterialLot,
  RawMaterialRequirementEntry,
} from "../rawMaterials/types";
import { RawMaterialsParameters } from "../rawMaterials/parameters";

export class TurnOrchestratorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnOrchestratorValidationError";
  }
}

// ---------------------------------------------------------------------
// 1. 国内買付意向のソース（未提出時の扱いを明示的な判別可能型にする）
// ---------------------------------------------------------------------

/**
 * Phase1（calculateMarketQuarter）へ渡す国内買付意向のソースを明示的に選ぶ。
 * 暗黙的な推測（「plansが空配列なら…」等）はしない。
 *
 * - "phase3Fallback": Phase3（industryLab）が使用している暫定買付量
 *   （`marketInput.vietnamDomestic.domesticProcurementIntent`に既に入っている値）
 *   をそのまま使う。会社別買付計画が一切取得できない場合のモード。
 * - "companyPlans": 会社別の国内買付計画（0件を含む）から、Phase5の
 *   `aggregateDomesticPurchaseIntent`（信認上限付き）で集約した値で上書きする。
 *   計画を提出していない会社は、この配列に含まれない（＝希望量ゼロと同義）。
 *
 * 【Phase 6.3追加（実装指示 §5）】externalIntent は、プレイヤー系会社（plans）以外の
 * 外部加工業者による国内買付意向（業界集計値）。国内価格形成用の総買付意向は
 *   外部加工業者需要 + plans由来の信認済み買付意向の合計
 * となる。プレイヤー系会社だけでベトナム国全体の加工需要を置き換えないための
 * フィールドで、未指定時は従来どおり（外部需要0＝後方互換）。値の算出は
 * 呼び出し側の責務（companyLabではcalculateExternalProcessorIntentが行う）。
 */
export type DomesticPurchaseIntentSource =
  | { readonly type: "phase3Fallback" }
  | {
      readonly type: "companyPlans";
      readonly plans: readonly DomesticPurchasePlanEntry[];
      readonly externalIntent?: HosoEqTons;
    };

// ---------------------------------------------------------------------
// 2. シナリオ変数（Phase2/3のフルScenarioTurnInputは再定義しない）
// ---------------------------------------------------------------------

/**
 * オーケストレーターが必要とする、当該ターンのシナリオ由来の外部入力のみを
 * 持つ最小限の型。Phase2/3の`ScenarioTurnInput`全体を再定義・重複実装しない
 * （呼び出し側が必要な値だけを抜き出して渡す）。
 */
export interface TurnScenarioVariables {
  /** 養殖の疾病計算（Phase5 harvestAquacultureLots）へそのまま渡す。未指定時は疾病なし（0）。 */
  readonly diseasePressure?: Ratio;
}

// ---------------------------------------------------------------------
// 3. パラメータ束（各Phaseの係数オーバーライド。既定はV1定数）
// ---------------------------------------------------------------------

export interface TurnOrchestratorParameters {
  readonly market?: MarketParameters;
  readonly sales?: SalesParameters;
  readonly rawMaterials?: RawMaterialsParameters;
  /** 【Phase 8P-0A】商品×仕向市場の参照価格係数。省略時はCURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS。 */
  readonly destinationMarketPricing?: DestinationMarketPriceCoefficientTable;
}

// ---------------------------------------------------------------------
// 4. オーケストレーター入力
// ---------------------------------------------------------------------

export interface TurnOrchestratorInput {
  /** 当該ターンのPeriod（この四半期を処理する。次ターンのPeriodは結果側で示す）。 */
  readonly currentPeriod: PeriodV2;

  /**
   * Phase1（calculateMarketQuarter）へ渡す市場入力。domesticPurchaseIntentSourceが
   * "companyPlans"の場合、この中のvietnamDomestic.domesticProcurementIntentは
   * applyDomesticPurchaseIntentOverrideで上書きされてから使われる（この入力
   * オブジェクト自体は変更しない）。
   */
  readonly marketInput: MarketQuarterInput;

  /** 当該ターンのシナリオ由来の外部入力（疾病圧力等）。省略可。 */
  readonly scenarioVariables?: TurnScenarioVariables;

  /** 会社別の販売計画（Phase4）。未提出の会社は含めない。 */
  readonly salesPlans: readonly CompanySalesPlanEntry[];

  /** 国内買付意向のソース（§1参照）。 */
  readonly domesticPurchaseIntentSource: DomesticPurchaseIntentSource;

  /** 会社別の輸入計画（Phase5）。未提出の会社は含めない（＝新規注文ゼロ）。 */
  readonly importOrders: readonly ImportOrderInput[];

  /** 会社別の養殖池入れ計画（Phase5）。未提出の会社は含めない（＝新規投入ゼロ）。 */
  readonly aquacultureStockingPlans: readonly AquacultureStockingPlanEntry[];

  /** 直前ターンまでの販売契約（Phase4の約定残）。このターンの新規契約が追加される。 */
  readonly existingContracts: readonly SalesContract[];

  /** 直前ターンまでの原料ロット在庫（Phase5）。このターンの新規ロットが追加される。 */
  readonly existingLots: readonly RawMaterialLot[];

  /**
   * 【Phase 8F-1】対象需要（targetDemand）を市場ごとへ按分する構成比の上書き。
   * sales/types.ts の SalesQuarterInput.marketWeights へそのまま渡すだけ
   * （このオーケストレーター自身は在庫・購買循環モデルの計算を行わない）。
   * market/consumerInventory.ts の deriveMarketWeightsFromDesiredPurchase が
   * 算出した値を渡す想定。省略時は sales側の既存の按分（priorPeriodConsumption
   * ベース）にフォールバックする（後方互換）。
   */
  readonly marketWeights?: Readonly<Record<DemandMarketId, number>>;

  /**
   * 【SAI-5C】市場×商品の需要構成比行列（market/productLifecycle.ts）。
   * sales/types.ts の SalesQuarterInput.marketProductMix へそのまま渡すだけ
   * （省略時はsales側の既存の世界一律商品構成比へフォールバック。後方互換）。
   */
  readonly marketProductMix?: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>;

  /**
   * 決定論的乱数のシード（Phase1のHOSO価格ショック等に使う）。同じseed・同じ
   * currentPeriod・同じ他入力からは常に同じ結果になる（内部でMath.random()・
   * Date.now()等は一切使わない）。
   */
  readonly seed: string;

  /** 各Phaseの係数オーバーライド。省略時はそれぞれのV1既定値を使う。 */
  readonly parameters?: TurnOrchestratorParameters;
}

// ---------------------------------------------------------------------
// 5. 監査・デバッグ用の中間集計値
// ---------------------------------------------------------------------

export interface TurnOrchestratorDebugInfo {
  /** 会社別の有効買付意向（信認上限適用後。"phase3Fallback"時は空配列）。 */
  readonly companyEffectivePurchaseIntents: readonly { readonly companyId: CompanyId; readonly effectiveIntent: HosoEqTons }[];
  /** 全社の有効買付意向の合計（"phase3Fallback"時は算出しない＝undefined）。 */
  readonly aggregatedPurchaseIntent?: HosoEqTons;
  /** 外部加工業者の国内買付意向（Phase 6.3。externalIntent未指定時はundefined）。 */
  readonly externalProcessorIntent?: HosoEqTons;
  /** プレイヤー系会社が配分対象にできる国内原料量（取引成立量のうち会社意向比例分。Phase 6.3）。 */
  readonly companyAvailableDomesticSupply?: HosoEqTons;
  /** override前のMarketQuarterInput.vietnamDomestic.domesticProcurementIntent。 */
  readonly domesticProcurementIntentBeforeOverride: HosoEqTons;
  /** override後（Phase1へ実際に渡した値）のdomesticProcurementIntent。 */
  readonly domesticProcurementIntentAfterOverride: HosoEqTons;
  /** Phase1が清算した国内原料価格。 */
  readonly domesticMarketPrice: UsdPerHosoEqKg;
  /** Phase1が清算した国内原料供給量。 */
  readonly domesticMarketSupply: HosoEqTons;
  /** 会社別の国内買付配分量。 */
  readonly companyDomesticAllocations: readonly { readonly companyId: CompanyId; readonly allocatedQuantity: HosoEqTons }[];
}

// ---------------------------------------------------------------------
// 6. 次ターンへ引き継ぐ保留状態
// ---------------------------------------------------------------------

/**
 * 次ターンのTurnOrchestratorInput.currentPeriod / existingContracts / existingLots
 * へそのまま渡せる形の、最小限の保留状態。呼び出し側（将来のRedis永続化層）が
 * 実際に何をどう保存するかは本Phaseの対象外（本モジュールは値を返すだけ）。
 */
export interface TurnOrchestratorPendingState {
  readonly nextPeriod: PeriodV2;
  readonly contracts: readonly SalesContract[];
  readonly lots: readonly RawMaterialLot[];
}

// ---------------------------------------------------------------------
// 7. オーケストレーター結果
// ---------------------------------------------------------------------

export interface TurnOrchestratorResult {
  readonly period: PeriodV2;

  readonly marketResult: MarketQuarterResult;

  readonly salesRecord: SalesQuarterRecord;
  readonly contracts: readonly SalesContract[];

  readonly rawMaterialRequirements: readonly RawMaterialRequirementEntry[];
  readonly domesticAllocation: DomesticPurchaseAllocationResult;
  readonly lots: readonly RawMaterialLot[];
  readonly newImportLots: readonly RawMaterialLot[];
  readonly arrivedImportLots: readonly RawMaterialLot[];
  readonly newGrowingLots: readonly RawMaterialLot[];
  readonly harvestedLots: readonly RawMaterialLot[];
  readonly expiredLots: readonly RawMaterialLot[];
  readonly aquacultureHarvestResults: readonly AquacultureHarvestResult[];

  readonly pendingState: TurnOrchestratorPendingState;

  readonly debug: TurnOrchestratorDebugInfo;
}

export type { RandomStream, CountryId };
