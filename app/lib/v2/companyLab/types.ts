// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 共通型
//
// Phase1〜6の既存モジュール（market/scenario/sales/rawMaterials/production/turn）を
// そのまま再利用し、UI・API・生成AIから独立した純粋なドメインモジュールとして、
// 5社が契約→原料確保→生産→納品という会社経営の中核サイクルを1四半期ずつ
// 決定論的に進められるようにする。新しい数量単位・会社ID型・商品区分は
// 一切追加しない（既存Phaseの型をそのまま再利用する）。
//
// 本モジュールが定義する「会社」（COMPANY_FIXTURES）は、ゲーム内の本番会社設定
// ではなく、統合テスト・GM確認用のフィクスチャである（§ fixtures.ts 冒頭コメント参照）。
// 同様に、autoPolicy.ts が生成する意思決定は Phase 9 で実装予定のAI会社ロジックでは
// なく、統合テストのために交換可能な決定論的ルールベース生成器である。

import { PeriodV2 } from "../core/period";
import { HosoEqTons, Ratio, Score0to100 } from "../core/units";
import { CountryId, DemandMarketId, MarketQuarterInput, MarketQuarterResult, Product } from "../market/types";
import { ScenarioMode, ScenarioState } from "../scenario/types";
import { CompanyId, CompanySalesPlanEntry, SalesContract, SalesQuarterRecord } from "../sales/types";
import {
  AquacultureStockingPlanEntry,
  DomesticPurchaseAllocationResult,
  DomesticPurchasePlanEntry,
  ImportOrderInput,
  RawMaterialLot,
  RawMaterialRequirementEntry,
} from "../rawMaterials/types";
import {
  CompanyLoadMetrics,
  CompanyProductionPlanEntry,
  ContractFulfillmentPlan,
  Factory,
  FactoryLoadMetrics,
  FinishedGoodsLot,
  ProductionAllocationResult,
  ProductionBatch,
  ProductionState,
  WorkerAssignment,
} from "../production/types";
import { TurnOrchestratorDebugInfo } from "../turn/types";
import { BatchQualityAdjustment, MarketDeliveryObservation, QualityReliabilityState } from "../quality/types";
import { CompanyFinancialQuarterResult, FinanceState } from "../finance/types";

export class CompanyLabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyLabError";
  }
}

// ---------------------------------------------------------------------
// 1. 会社フィクスチャ（テスト専用。本番会社設定ではない）
// ---------------------------------------------------------------------

export type CompanyArchetype = "balanced" | "massMarket" | "japanQuality" | "vapSpecialist" | "conservative";

/**
 * 【Phase 6.3（実装指示 §9）】1社・1商品（PD/VAP）の受注判断プレミアム構成
 * （すべてUSD/HOSO換算kg、HOSO基準価格に対するプレミアムとしての水準）。
 * Phase 8の正式原価計算が未実装のため、会社・商品別の暫定予想加工費として
 * フィクスチャから与える（将来、実原価計算へ交換可能な構造）。
 *
 *   targetPremium = expectedVariableProcessingCost + allocatedFixedCost
 *                 + sellingAndLogisticsCost + targetMargin
 *   minimumAcceptablePremium = avoidableVariableProcessingCost
 *                 + incrementalSellingAndLogisticsCost + minimumContributionMargin
 */
export interface CompanyPremiumEconomics {
  readonly expectedVariableProcessingCostUsdPerHosoEqKg: number;
  readonly allocatedFixedCostUsdPerHosoEqKg: number;
  readonly sellingAndLogisticsCostUsdPerHosoEqKg: number;
  readonly targetMarginUsdPerHosoEqKg: number;
  readonly avoidableVariableProcessingCostUsdPerHosoEqKg: number;
  readonly incrementalSellingAndLogisticsCostUsdPerHosoEqKg: number;
  readonly minimumContributionMarginUsdPerHosoEqKg: number;
}

/**
 * 【Phase 6.3】会社別の商品経済性（テスト用フィクスチャの一部）。
 * expectedProcessingCostUsdPerHosoEqKgは契約時予想原価スナップショット・診断用の
 * 絶対額（変動費＋固定費配賦＋販売物流費の合計目安）。premiumEconomicsは
 * PD/VAPの受注判断プレミアム構成（商品仕様別に交換可能。VAPの最低受注水準は
 * 原則PDより高い）。
 */
export interface CompanyProductEconomics {
  readonly expectedProcessingCostUsdPerHosoEqKg: Readonly<Record<Product, number>>;
  readonly premiumEconomics: Readonly<Record<"pd" | "vap", CompanyPremiumEconomics>>;
}

/** 1社ぶんのテスト用フィクスチャ（工場・ワーカー基準・養殖能力・初期原料在庫等）。 */
export interface CompanyFixture {
  readonly companyId: CompanyId;
  readonly displayName: string;
  readonly archetype: CompanyArchetype;
  /** GM向け説明（画面・CLIに表示する）。本番会社設定ではないことを明記する文言を含む。 */
  readonly description: string;
  readonly country: CountryId;
  readonly factories: readonly Factory[];
  /** 工場ごとの常用ワーカー基準人数・技能水準（temporaryHeadcount・overtimeRateは毎期の意思決定側で決める）。 */
  readonly workerBaseline: readonly Pick<WorkerAssignment, "factoryId" | "companyId" | "regularHeadcount" | "skills" | "attendanceRate">[];
  readonly aquacultureCapacity: HosoEqTons;
  readonly salesForceHeadcountTotal: number;
  readonly procurementHeadcountTotal: number;
  readonly initialRawMaterialLots: readonly RawMaterialLot[];
  /** 【Phase 6.3】会社別の商品経済性（受注判断・契約時予想原価スナップショット用）。 */
  readonly productEconomics: CompanyProductEconomics;
}

// ---------------------------------------------------------------------
// 2. 会社の当期意思決定（自動方針またはプレイヤー入力が生成する）
// ---------------------------------------------------------------------

/** 1社・1四半期ぶんの意思決定一式。 */
export interface CompanyDecisionInput {
  readonly companyId: CompanyId;
  readonly salesPlans: readonly CompanySalesPlanEntry[];
  readonly domesticPurchasePlan: DomesticPurchasePlanEntry;
  readonly importOrders: readonly ImportOrderInput[];
  readonly aquacultureStockingPlans: readonly AquacultureStockingPlanEntry[];
  readonly productionPlans: readonly CompanyProductionPlanEntry[];
  /** 工場ごとのワーカー配置（常用人数はworkerBaselineを踏襲し、臨時人数・残業率のみ意思決定で変える想定だが、
   * 検証のため全フィールドをこの意思決定側で確定させる）。 */
  readonly workerAssignments: readonly WorkerAssignment[];
}

// ---------------------------------------------------------------------
// 3. 自動方針への入力（公開情報＋自社状態のみ。他社非公開計画・将来シナリオは一切含まない）
// ---------------------------------------------------------------------

/** 自動方針（autoPolicy.ts）が参照してよい、当該会社ぶんの状態（自社のみ）。 */
export interface CompanyOwnState {
  readonly companyId: CompanyId;
  readonly contracts: readonly SalesContract[];
  readonly rawMaterialLots: readonly RawMaterialLot[];
  readonly finishedGoodsLots: readonly FinishedGoodsLot[];
  readonly lastQuarterFactoryLoadMetrics: readonly FactoryLoadMetrics[];
  readonly lastQuarterActualProductionByProduct: Readonly<Partial<Record<Product, number>>>;
  /**
   * 【Phase 7A】前四半期末までの自社の商品別品質スコア（会社×商品）。
   * 当四半期の販売計画がsales/types.tsのCompanySalesPlanEntry.qualityReputationへ
   * 接続する（今期の品質結果を今期の成約へ遡及適用しないため、常に「前四半期末
   * まで」の値を渡す）。
   */
  readonly qualityScoreByProduct: Readonly<Partial<Record<Product, Score0to100>>>;
  /** 【Phase 7A】前四半期末までの自社の市場別顧客信頼（customerRelationshipへ接続）。 */
  readonly customerTrustByMarket: Readonly<Partial<Record<DemandMarketId, Score0to100>>>;
  /** 【Phase 7A】前四半期末までの自社の市場別納期信頼性（deliveryReliabilityへ接続）。 */
  readonly deliveryReliabilityByMarket: Readonly<Partial<Record<DemandMarketId, Score0to100>>>;
}

/** 自動方針が参照してよい公開市場情報（前四半期の実際の市場結果。当期分はまだ未確定で参照不可）。 */
export interface PublicMarketInfo {
  readonly lastMarketResult?: MarketQuarterResult;
  readonly vietnamDomesticPriorPrice: number;
}

// ---------------------------------------------------------------------
// 4. 会社ごとの当期結果表示情報（画面・CLI向け集計）
// ---------------------------------------------------------------------

export type CompanyReasonCode =
  | "LOW_PRICE_WON_SHARE" // 安値提示により成約増
  | "SALES_FORCE_SHORTAGE" // 営業能力不足
  | "DOMESTIC_COMPETITION_INTENSE" // 国内買付競争激化
  | "RAW_MATERIAL_SHORTAGE" // 原料不足
  | "IMPORT_IN_TRANSIT" // 輸入到着待ち
  | "EQUIPMENT_CAPACITY_SHORTAGE" // 設備能力不足
  | "LABOR_SHORTAGE" // ワーカー不足
  | "OVERTIME_CAP_REACHED" // 残業上限到達
  | "VAP_SUPPLY_INCREASE_LOWERS_PREMIUM" // VAP供給増加によるプレミアム低下
  | "PD_SUPPLY_INCREASE_LOWERS_PREMIUM" // PD供給増加によるプレミアム低下
  | "OVER_CONTRACTED_OVERDUE" // 契約過多による納期超過
  | "DISEASE_HARVEST_LOSS" // 疾病による養殖収穫減
  | "AQUACULTURE_HARVEST_ON_TRACK"; // 養殖収穫が計画どおり

/** 1件の理由コード（対象会社・簡潔な理由文つき）。 */
export interface CompanyReasonEntry {
  readonly code: CompanyReasonCode;
  readonly companyId: CompanyId;
  readonly message: string;
}

/** 1社・1四半期ぶんの結果サマリー（画面・CLI表示用に事前集計）。 */
export interface CompanyQuarterSummary {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;

  readonly newContractedQuantity: HosoEqTons;
  readonly newContractedAveragePrice: number;
  readonly fulfilledQuantity: HosoEqTons;
  readonly outstandingQuantity: HosoEqTons;
  readonly overdueQuantity: HosoEqTons;

  readonly domesticPurchaseQuantity: HosoEqTons;
  readonly domesticPurchasePrice: number;
  readonly importInTransitQuantity: HosoEqTons;
  readonly importArrivedQuantity: HosoEqTons;
  readonly aquacultureGrowingQuantity: HosoEqTons;
  readonly aquacultureHarvestedQuantity: HosoEqTons;
  readonly rawMaterialInventory: HosoEqTons;

  readonly hosoProduced: HosoEqTons;
  readonly pdProduced: HosoEqTons;
  readonly vapProduced: HosoEqTons;
  readonly finishedGoodsInventory: HosoEqTons;

  readonly rawMaterialShortfall: HosoEqTons;
  readonly equipmentShortfall: HosoEqTons;
  readonly laborShortfall: HosoEqTons;

  readonly equipmentUtilizationRate: Ratio;
  readonly laborUtilizationRate: Ratio;
  readonly overtimeRate: Ratio;
  readonly temporaryWorkerShare: Ratio;

  // --- 【Phase 7A】品質・顧客信頼・納期信頼性（会社ラボへの接続範囲） ---
  /** 当期末時点（更新後）の商品別品質スコア。 */
  readonly qualityScoreByProduct: Readonly<Partial<Record<Product, Score0to100>>>;
  /** 当期の会社×工場×商品ぶんの操業リスク（商品別、複数工場ある場合は数量加重平均）。 */
  readonly operationalRiskByProduct: Readonly<Partial<Record<Product, number>>>;
  readonly downgradeQuantity: HosoEqTons;
  readonly reworkQuantity: HosoEqTons;
  readonly discardQuantity: HosoEqTons;
  /** 当期発生した重大品質事故の件数（会社×工場×商品単位）。 */
  readonly majorIncidentCount: number;
  /** 当期dueQuantity>0だった市場だけの、数量加重平均納期遵守率（0〜100、評価対象がなければundefined）。 */
  readonly onTimeDeliveryRate?: number;
  /** 当期末時点（更新後）の市場別顧客信頼。 */
  readonly customerTrustByMarket: Readonly<Partial<Record<DemandMarketId, Score0to100>>>;
  /** 当期末時点（更新後）の市場別納期信頼性。 */
  readonly deliveryReliabilityByMarket: Readonly<Partial<Record<DemandMarketId, Score0to100>>>;
  /** 無理な増産の警告（productionRampStressが高水準の会社×工場×商品）。 */
  readonly rampWarnings: readonly { readonly factoryId: string; readonly product: Product; readonly productionRampStress: number }[];

  readonly reasonCodes: readonly CompanyReasonEntry[];
}

// ---------------------------------------------------------------------
// 5. 四半期記録・状態・結果
// ---------------------------------------------------------------------

export interface CompanyQuarterRecord {
  readonly turn: number;
  readonly period: PeriodV2;
  readonly decisions: readonly CompanyDecisionInput[];
  readonly marketInput: MarketQuarterInput;
  readonly marketResult: MarketQuarterResult;
  readonly salesRecord: SalesQuarterRecord;
  readonly rawMaterialRequirements: readonly RawMaterialRequirementEntry[];
  readonly domesticAllocation: DomesticPurchaseAllocationResult;
  readonly productionAllocation: ProductionAllocationResult;
  readonly batches: readonly ProductionBatch[];
  readonly newFinishedGoodsLots: readonly FinishedGoodsLot[];
  readonly fulfillmentPlan: ContractFulfillmentPlan;
  readonly companyLoadMetrics: readonly CompanyLoadMetrics[];
  readonly factoryLoadMetrics: readonly FactoryLoadMetrics[];
  readonly companySummaries: readonly CompanyQuarterSummary[];
  readonly globalReasonCodes: readonly CompanyReasonEntry[];
  readonly turnDebug: TurnOrchestratorDebugInfo;
  /** 【Phase 7A】当期の生産バッチ品質調整結果（監査・テスト・CLI表示用）。 */
  readonly qualityAdjustments: readonly BatchQualityAdjustment[];
  /** 【Phase 7A】当期の品質・信頼・納期信頼性・増産履歴の更新後状態。 */
  readonly qualityStateAfter: QualityReliabilityState;
  /**
   * 【Phase 7B】当期の会社×市場別の納期観測（quality/deliveryObservation.tsが
   * 既に算出済みの値をそのまま保存するだけ。監査・会社ラボダッシュボードの
   * 市場別納期遵守率表示用。新たな計算は一切行わない）。
   */
  readonly deliveryObservations: readonly MarketDeliveryObservation[];
  /**
   * 【Phase 8A】当期の会社別財務結果（PL/BS/CF/原価内訳/品質損失/コスト記録/
   * 管理会計）。既存Phaseの実績データから finance/quarterClose.ts が生成する
   * （財務側で販売量・生産量・廃棄量・価格を再計算しない）。
   */
  readonly financialResults: readonly CompanyFinancialQuarterResult[];
}

export interface CompanyLabConfig {
  readonly scenarioId: string;
  readonly mode: ScenarioMode;
  readonly seed: string;
  readonly turns: number;
}

export interface CompanyLabState {
  readonly config: CompanyLabConfig;
  readonly currentPeriod: PeriodV2;
  readonly scenarioState: ScenarioState;
  readonly contracts: readonly SalesContract[];
  readonly rawMaterialLots: readonly RawMaterialLot[];
  readonly productionState: ProductionState;
  /** 会社×商品の前四半期実績生産量（今期のPD/VAP供給シグナルのactualQuantityに使う）。 */
  readonly lastQuarterActualProduction: Readonly<Record<CompanyId, Readonly<Partial<Record<Product, number>>>>>;
  /** 【Phase 7A】品質・顧客信頼・納期信頼性・増産履歴（ターンをまたいで保持）。 */
  readonly qualityState: QualityReliabilityState;
  /** 【Phase 8A】会社別の財務状態（現金・売掛/買掛・借入・固定資産・完成品原価台帳等。ターンをまたいで保持）。 */
  readonly financeState: FinanceState;
  readonly history: readonly CompanyQuarterRecord[];
  readonly isComplete: boolean;
}

export interface CompanyLabResult {
  readonly config: CompanyLabConfig;
  readonly companies: readonly CompanyFixture[];
  readonly history: readonly CompanyQuarterRecord[];
}

/** 1四半期分の意思決定を会社ごとに生成する関数の型（自動方針・プレイヤー入力編集のいずれもこの形に合わせる）。 */
export type CompanyDecisionProvider = (
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number
) => CompanyDecisionInput;
