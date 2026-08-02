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
import { ConsumerMarketCarryStateTable, ConsumerMarketQuarterRecord } from "../market/consumerInventory";
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
import { CompanyFinanceState, CompanyFinancialQuarterResult, FinanceState } from "../finance/types";
import { CompanyFinancingState, FinancingRequestInput, FinancingState, FinancingQuarterResult } from "../financing/types";
import { CapexDecisionInput, CapexQuarterResult, CapexState, CompanyCapexState } from "../capex/types";
// 【Phase 8D-4】型のみの参照（workforce.ts 側も CompanyFixture を型としてのみ参照するため、実行時の循環参照は発生しない）。
import type { CompanyWorkforceState, WorkforceState } from "./workforce";
// 【営業人員の追加採用・forward-port】型のみの参照（salesForceHiring.ts 側も
// CompanyFixture を型としてのみ参照するため、実行時の循環参照は発生しない）。
import type { CompanySalesForceHiringState, SalesForceHiringState } from "./salesForceHiring";
import type { SalesBaseState } from "./salesBase";
import type { PdMechanizationState } from "./pdMechanizationState";
import type { ProductDevelopmentState } from "./productDevelopmentState";
import type { MarketEvolutionState, Sai5MarketEvolutionRecord, SupplyPressureDefinition } from "./marketEvolution";

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
  /**
   * 【Phase 8B-1】当期の資金調達希望（希望借入額・種別・期間・返済方式・
   * 任意期限前返済額・緊急融資利用可否）。当期開始時点の情報だけで決めること
   * （runner.tsのplanQuarterFinancingが、当期の市場・生産実績が確定する前に
   * この希望を銀行審査へ渡す）。
   */
  readonly financingRequest: FinancingRequestInput;
  /**
   * 【Phase 8B-2A】当期の設備投資に関する意思決定（新規案件提案・取消・再開の
   * 希望）。financingRequestと同様、当期開始時点の情報だけで決めること。
   * 5社自動方針（autoPolicy.ts）は常に空（新規提案なし）を返す（実装指示§11。
   * 統合テスト・意思決定編集からの上書きは可能）。
   */
  readonly capexDecision: CapexDecisionInput;
  /**
   * 【営業人員の追加採用・forward-port】当期の営業人員の新規採用人数（0以上の
   * 整数。増分のみ、減員・離職は対象外）。当期採用した人数は当期の配分可能
   * 人数には加算されず（salesForceHiring.ts参照）、四半期確定時に採用が成立し、
   * 次の四半期の開始時点から配分可能人数へ加算される。
   *
   * この機能の導入前に確定した既存の永続化済み履歴にはこのフィールドが存在
   * しないため、後方互換のためoptionalとする（consumerMarketRecords等、既存の
   * 後発フィールドと同じ扱い。省略時は0として扱う＝旧保存データでは採用予定
   * 0人）。
   */
  readonly salesForceHireCount?: number;
  /**
   * 【営業人員の減員・forward-port続き】当期の営業人員の減員人数（0以上の
   * 整数）。減員対象者は当期中は営業戦力・通常給与に含まれたまま
   * （salesForceHiring.ts参照）で、次の四半期の開始時点から配分可能人数が
   * 減る。減員を決定した当期に、1人あたり四半期給与2四半期分の退職金を
   * 一度だけ費用・支出計上する（finance/quarterClose.ts参照）。
   *
   * salesForceHireCountと同一四半期に両方>0を入力することはできない
   * （runner.ts advanceCompanyLabQuarterが受理時に検証・エラー化する）。
   *
   * この機能の導入前に確定した既存の永続化済み履歴にはこのフィールドが存在
   * しないため、後方互換のためoptionalとする（省略時は0として扱う＝
   * 旧保存データでは減員予定0人）。
   */
  readonly salesForceLayoffCount?: number;
  /**
   * 【Test15新設】当期のVAP商品開発費。companyLab/productDevelopmentState.tsの
   * VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD（$0/$100,000/$250,000/$500,000）の
   * いずれか（自由入力ではない4段階選択。isValidVapProductDevelopmentSpendTier
   * 参照）。全額が当期SG&Aへ費用化され、同額が当期キャッシュフローの支出となる
   * （資産計上・減価償却なし。finance/quarterClose.ts参照）。同じ値がVAP商品開発
   * スコアの更新（companyLab/productDevelopmentState.ts）にも使われる、唯一の
   * 情報源（companyLab/runner.ts参照）。省略時は0（後方互換、既存の意思決定
   * 構築箇所を壊さない）。
   */
  readonly vapProductDevelopmentSpendUsd?: number;
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
  /**
   * 【Phase 8B-1】前期末までの自社財務状態・資金繰り状態（現金・借入残高・
   * 信用履歴等）。自動方針の資金調達希望（financingRequest）はこれだけを参照する
   * （当期の市場・生産実績は一切参照しない＝銀行と同じ「未来を知らない」制約）。
   */
  readonly financeState: CompanyFinanceState;
  readonly financingState: CompanyFinancingState;
  /** 【Phase 8B-2A】前期末までの自社設備投資状態（案件ポートフォリオ）。 */
  readonly capexState: CompanyCapexState;
  /**
   * 【Phase 8D-4】前期末までの自社Worker総人数（工場別）。
   * 意思決定画面はこれを出発点として増減差分を入力する。
   */
  readonly workforceState: CompanyWorkforceState;
  /**
   * 【営業人員の追加採用・forward-port】前期末までの自社営業人員総数（当期に
   * 配分可能な人数）。意思決定画面はこれを「現在の営業人員」「当期に配分可能」
   * の出発点として表示し、新規採用人数の入力は0から始まる（増分のみ。
   * workforceStateの増減差分方式とは異なり、採用は当期の配分可能人数へは
   * 加算されない）。
   */
  readonly salesForceHiringState: CompanySalesForceHiringState;
  /**
   * 【SAI-5D】前四半期末までの自社の営業基盤（市場×商品、0〜100）。
   * config.sai5.salesBaseAccumulation有効時のみ設定される。存在しない
   * キーは中立値（50）とみなす（quality/trustと同じ「前期末値のみを当期の
   * 成約に使う」規約に従う）。
   */
  readonly salesBaseByMarketProduct?: Readonly<Partial<Record<DemandMarketId, Readonly<Partial<Record<Product, Score0to100>>>>>>;
  /**
   * 【監査指摘G】当期の成約配分で実際に使われる営業基盤の競争力ウェイト。
   * 機能OFF・旧state（＝営業基盤が成約へ一切影響しない）のとき 0。
   * 判断側が「営業基盤の優位が実際に効く局面かどうか」を、思い込みではなく
   * エンジンの実値で確認できるようにするために公開する。
   */
  readonly salesBaseCompetitivenessWeight?: number;
  /**
   * 【Test15新設】前四半期末までの自社工場ごとのPD稼働率（pdMechanizationState.ts
   * findPreviousQuarterPdUtilizationと同じ値。エントリが無い工場は既定値
   * （PD_MECHANIZATION_PARAMETERS_V1.initialPdUtilizationRatio）とみなす）。
   * UI側がPD省人化投資の状況（現在の稼働率・想定される機械化効果）を表示する
   * ために公開する。常に存在する（機能フラグに依存しない常時ゲームルール）。
   * 【配列形状の理由】factoryIdをオブジェクトキーとして持つRecordにすると、
   * 「識別情報（factoryId）以外が全社完全に同一」という既存の統合テスト
   * （standardAi/autoplay/__tests__/heterogeneousProfiles.test.ts の
   * stripIdentifiers）がfactoryIdを含む動的キー名までは正規化できず誤検知する
   * ため、workforceState.factoriesと同じ「配列＋factoryIdフィールド」形状にする。
   */
  readonly pdUtilizationByFactory: readonly { readonly factoryId: string; readonly previousQuarterPdUtilization: number }[];
  /**
   * 【Test15新設】前四半期末までの自社VAP商品開発スコア（0〜100、中立50）。
   * productDevelopmentState.ts lookupProductDevelopmentScoreと同じ値。
   * 常に存在する（機能フラグに依存しない常時ゲームルール）。
   */
  readonly vapProductDevelopmentScore: number;
  /**
   * 【Test15・develop/v2統合（Required fix 2）】当四半期時点で実際に入力・生産の
   * 対象にできる、この会社の「実効Factory[]」（既存工場への能力加算＋稼働開始済み
   * newFactoryConstruction案件による新設Factoryの両方を反映済み）。
   *
   * 【唯一の計算箇所】必ず capex/factoryConstruction.ts の computeEffectiveFactories
   * を経由する（companyLab/runner.ts の advanceCompanyLabQuarter が生産エンジンへ
   * 渡すFactory[]と、この buildCompanyOwnState が意思決定側へ渡すFactory[]が
   * 別々に計算されて食い違う、という統合前の欠落（fixture.factoriesを直接読んで
   * いたためUIから新設Factoryへ入力できなかった問題）を構造的に防ぐ）。
   *
   * fixture.factories（作成時点の静的な初期工場一覧）を意思決定側で直接読む
   * 代わりに、常にこちらを使うこと。新設Factoryは稼働開始（完成＋操業準備期間
   * 経過）するまでこの配列に一切現れない。稼働開始した瞬間、ワーカー配置・
   * 生産計画・PD省人化投資対象の各入力行はゼロ人・ゼロ生産の状態からこの配列へ
   * 現れる（ワーカー・営業人員・需要が自動的に積み増されることはない）。
   */
  readonly effectiveFactories: readonly Factory[];
}

/** 自動方針が参照してよい公開市場情報（前四半期の実際の市場結果。当期分はまだ未確定で参照不可）。 */
export interface PublicMarketInfo {
  readonly lastMarketResult?: MarketQuarterResult;
  readonly vietnamDomesticPriorPrice: number;
  /**
   * 【SAI-5C】市場別の商品ライフサイクル公開トレンド（config.sai5.productLifecycle
   * 有効時のみ設定）。**前四半期までに実際に適用された構成比**とその四半期差分
   * （＝公開の市場調査に相当する情報）であり、当期の実現需要そのものは含まない
   * （既存の「前四半期の結果のみ公開」という情報境界を維持する）。turn1では
   * undefined（前期が存在しないため。lastMarketResultと同じ規約）。
   */
  readonly productLifecycleOutlook?: ProductLifecycleOutlook;
  /**
   * 【SAI-5E】前四半期末までの商品別供給圧力（5社提示量÷対象需要のEWMA。
   * config.sai5有効時のみ）。市場全体の需給比という公開の業界統計に相当し、
   * 個社の非公開計画は含まない。1.0=需給均衡、>1=供給過剰の持続。
   */
  readonly productSupplyPressureOutlook?: Readonly<Record<"pd" | "vap", number>>;
}

/** 【SAI-5C】前四半期までのライフサイクル構成比と四半期トレンド（公開情報）。 */
export interface ProductLifecycleOutlook {
  /** 前四半期に適用された市場×商品の需要構成比（各市場の行和=1）。 */
  readonly sharesByMarket: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>;
  /** 前四半期の構成比 − 前々四半期の構成比（四半期あたりの変化量。turn2では0）。 */
  readonly quarterlyTrendByMarket: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>;
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
  | "AQUACULTURE_HARVEST_ON_TRACK" // 養殖収穫が計画どおり
  | "SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY"; // 市場別営業工数換算能力の不足により販売計画が縮小された

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
  /**
   * 【Phase 8B-1】当期の会社別資金繰り結果（信用スコア・借入限度額・銀行審査・
   * 財務制限条項・調達制約・緊急融資・延滞・財務状態分類）。financing/liquidityClose.ts
   * が生成する（financeモジュールと同様、実績の再計算は一切行わない）。
   */
  readonly financingResults: readonly FinancingQuarterResult[];
  /**
   * 【Phase 8B-2A】当期の会社別設備投資結果（提案評価・取消/再開・分割払い・
   * 完成振替・建設中勘定）。capex/capexClose.tsが生成する（finance/financingと
   * 同様、実績の再計算は一切行わない）。
   */
  readonly capexResults: readonly CapexQuarterResult[];
  /**
   * 【Phase 8F-1】当期の市場別・消費国在庫・購買循環モデルの確定記録
   * （market/consumerInventory.ts の settleConsumerMarketQuarter の出力を
   * そのまま保存するだけ。監査・テスト・診断表示用。財務・成約等の既存計算を
   * 再実装しない）。Phase 8F-1より前に確定した既存の永続化済み履歴には
   * このフィールドが存在しないため、後方互換のためoptionalとする
   * （SalesContract.costSnapshot等、既存の後発フィールドと同じ扱い）。
   */
  readonly consumerMarketRecords?: readonly ConsumerMarketQuarterRecord[];
  /**
   * 【SAI-5E】市場進化の因果ログ（適用プレミアム倍率・普及前倒し・PD⇔VAP代替・
   * 供給圧力・適用構成比行列）。SAI-5機能フラグ有効時のみ設定されるoptional
   * （既存の永続化済み履歴・SAI-3Bパーサーへの影響なし）。
   */
  readonly sai5MarketEvolution?: Sai5MarketEvolutionRecord;
}

/**
 * 【SAI-5】市場進化モデルの機能フラグ。未指定（またはすべてfalse）なら
 * 各挿入点で既存コードパスをそのまま通り、従来挙動とビット単位で一致する
 * （§13EのA/B比較は、このフラグの組み合わせで表現する）。
 */
export interface Sai5FeatureFlags {
  /** 市場別の商品ライフサイクル需要（market/productLifecycle.ts）。 */
  readonly productLifecycle?: boolean;
  /** 会社×市場×商品の営業基盤蓄積（companyLab/salesBase.ts）。 */
  readonly salesBaseAccumulation?: boolean;
  /** 5社供給圧力→翌期PD/VAPプレミアムのフィードバック。 */
  readonly supplyPremiumFeedback?: boolean;
  /**
   * 【監査指摘B・定義比較用】供給圧力の定義。未指定＝採用済みの既定
   * （MARKET_EVOLUTION_PARAMETERS_V1.supplyPressureDefinition）。
   * 定義候補の実測比較（scripts/sai5SupplyPressureStudy.ts）以外では指定しない。
   */
  readonly supplyPressureDefinition?: SupplyPressureDefinition;
  /**
   * 【Test15新設】VAP能力合成係数（companyLab/premiumPolicy.tsの
   * calculateCompanyCapabilityCoefficient）を成約競争力へ接続する
   * （sales/allocation.tsのvapCapabilityウェイト）。未指定・falseなら既存の
   * salesBaseAccumulationと同じく「ビット単位で既存挙動と一致」する
   * （ウェイト0・販売計画へvapCapabilityScoreを一切付けない）。
   */
  readonly vapProductDevelopmentCompetitiveness?: boolean;
}

/**
 * 【加工品市場進化】PD/VAPを中長期戦略の中心に据える市場構造の機能フラグ。
 *
 * 【なぜ sai5 とは別グループなのか（コーディネーター判断1、オーナー上書き可）】
 * Test15の既存環境・保存データを壊さないことが上位制約であり、SAI-5の既定値は
 * 一切変更しない。加工品市場進化は「新しいラボ（Test16環境）が明示的に
 * opt-inする」性質のもので、SAI-5の各フラグとは有効化の単位も時期も異なるため、
 * 独立したグループとして持つ。未指定（＝既存の全ラボ）なら各挿入点で従来の
 * コードパスをそのまま通り、挙動はビット単位で一致する。
 */
export interface MarketEvolutionFeatureFlags {
  /**
   * 産地別PD/VAP加工能力の時間発展（market/processingCapacityEvolution.ts）。
   * 有効時、各国の加工能力が「生産量×固定比率(0.30/0.10)」から
   * 「生産量×参入時期つきS字カーブ比率」へ置き換わり、他産地のPD加工参入が
   * 世界稼働率経由でプレーンPDプレミアムを後半に圧縮する。
   */
  readonly originProcessingCapacity?: boolean;
  /**
   * 商品別の仕向市場価格係数の時間発展
   * （market/consumerInventory.ts deriveNextQuarterDestinationPriceCoefficients）。
   * 有効時、HOSO基礎価値／PDプレミアム／VAPプレミアムの各係数が**別々に**
   * 動く（無効時は従来どおり3係数へ同一倍率を掛ける）。
   */
  readonly perProductDestinationPricing?: boolean;
  /**
   * ベトナムの加工優位を「獲得需要の商品構成」へ反映する
   * （sales/marketAdapter.ts deriveVietnamDemandByProduct）。
   * 有効時、原料供給シェアと加工品供給シェアが分離され、加工能力が大きい産地が
   * PD/VAP需要をより多く獲得する。
   */
  readonly processingAdvantageDemandCapture?: boolean;
  /**
   * 商品ライフサイクルの調整済みパラメータ表を使う
   * （market/productLifecycle.ts PRODUCT_LIFECYCLE_PARAMETERS_MARKET_EVOLUTION_V1）。
   * sai5.productLifecycle が有効なときにのみ意味を持つ（どの表を使うかの選択であり、
   * ライフサイクル機能そのものの有効化ではない）。未指定なら従来のV1表。
   */
  readonly tunedProductLifecycle?: boolean;
  /**
   * 商品別の成約競争力ウェイトプロファイル
   * （sales/parameters.ts SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1）を使う。
   * 有効時、HOSO/PDは価格ウェイトが高くコモディティ的に、VAPは関係性・品質・
   * VAP能力が主因となり会社間の実現価格ばらつきが大きくなる。
   */
  readonly productWiseCompetitiveness?: boolean;
}

export interface CompanyLabConfig {
  readonly scenarioId: string;
  readonly mode: ScenarioMode;
  readonly seed: string;
  readonly turns: number;
  /** 【SAI-5】市場進化モデルの機能フラグ（optional。未指定=全OFF=従来挙動）。 */
  readonly sai5?: Sai5FeatureFlags;
  /** 【加工品市場進化】PD/VAP市場構造の機能フラグ（optional。未指定=全OFF=従来挙動）。 */
  readonly marketEvolution?: MarketEvolutionFeatureFlags;
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
  /** 【SAI-5D】会社×市場×商品の営業基盤ストック（config.sai5.salesBaseAccumulation
   *  有効時のみ更新・保持。無効時はundefinedのまま＝既存スナップショットと同一）。 */
  readonly salesBaseState?: SalesBaseState;
  /** 【SAI-5E】市場進化carry state（供給圧力EWMA・プレミアム倍率・割安シグナル。
   *  config.sai5.productLifecycle/supplyPremiumFeedback有効時のみ保持）。 */
  readonly marketEvolutionState?: MarketEvolutionState;
  /**
   * 【Test15新設】Factory単位のPD稼働率（PD省人化投資の効果算出に使う、前四半期末
   * までの値）。省略時は全Factoryがcapex/pdMechanization.ts
   * initialPdUtilizationRatio扱い（後方互換：Phase Test15以前に作成されたラボにも
   * この状態は存在しない）。
   */
  readonly pdMechanizationState?: PdMechanizationState;
  /**
   * 【Test15新設】会社単位のVAP商品開発スコア（前四半期末までの値、companyLab/
   * productDevelopmentState.ts）。省略時は全会社が中立値50扱い（後方互換）。
   */
  readonly productDevelopmentState?: ProductDevelopmentState;
  /** 【Phase 8A】会社別の財務状態（現金・売掛/買掛・借入・固定資産・完成品原価台帳等。ターンをまたいで保持）。 */
  readonly financeState: FinanceState;
  /** 【Phase 8B-1】会社別の資金繰り状態（融資ポートフォリオ・未払利息・信用/延滞履歴。ターンをまたいで保持）。 */
  readonly financingState: FinancingState;
  /** 【Phase 8B-2A】会社別の設備投資状態（案件ポートフォリオ。ターンをまたいで保持）。 */
  readonly capexState: CapexState;
  /**
   * 【Phase 8D-4】会社別・工場別のWorker総人数（ターンをまたいで保持）。
   * Phase 8D以前は人員規模がどこにも保持されず、毎四半期fixtureの初期値へ戻っていた。
   * 意思決定では増減差分を入力し、ここには「変更後の総人数」を保存する。
   */
  readonly workforceState: WorkforceState;
  /**
   * 【Phase 8F-1】市場別（CN/US/EU/JP/OTHER）の消費国在庫・購買循環モデルの
   * carry state（期首在庫・前期消費実績・価格履歴。ターンをまたいで保持）。
   * 市場価格形成（globalDemand.ts・hosoPricing.ts）は一切変更せず、この状態は
   * sales/marketAdapter.ts の市場別按分ウェイトと、次四半期の仕向市場価格係数
   * （destinationMarketPricing）の算出だけに使う。
   */
  readonly consumerMarketState: ConsumerMarketCarryStateTable;
  /**
   * 【営業人員の追加採用・forward-port】会社別の営業人員総数（ターンをまたいで
   * 保持）。fixture.salesForceHeadcountTotalは静的な基準値のままとし、実際に
   * 当期配分可能な人数はこの状態が持つ。意思決定の新規採用人数は当期はここへ
   * 加算されず、四半期確定時にderiveNextSalesForceHiringStateが次期の状態へ
   * 加算する（salesForceHiring.ts参照）。
   */
  readonly salesForceHiringState: SalesForceHiringState;
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
