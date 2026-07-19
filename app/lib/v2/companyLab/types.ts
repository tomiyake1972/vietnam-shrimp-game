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
import { HosoEqTons, Ratio } from "../core/units";
import { CountryId, MarketQuarterInput, MarketQuarterResult, Product } from "../market/types";
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
