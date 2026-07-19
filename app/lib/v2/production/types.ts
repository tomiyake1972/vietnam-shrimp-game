// ShrimpX V2 — 工場・ワーカー・HOSO/PD/VAP生産・完成品在庫・契約履行モジュール
// 共通型（Phase 6）
//
// Phase1（市場・価格形成）・Phase4（販売・約定残）・Phase5（原料在庫）が確立した
// 規約をそのまま踏襲する。
//   - 数量: HosoEqTons（HOSO換算トン）に統一。工場能力・労働能力・完成品数量も
//     すべて「HOSO換算トンでの完成品換算量」という同一基盤の上に統一する
//     （§「単位についての設計判断」参照。新しい数量単位は追加しない）。
//   - 価格: UsdPerHosoEqKg（USD/HOSO換算kg）を原料単価に、UsdM（USD百万）を
//     金額集計（原料取得原価・基準加工費）に使う。
//   - 会社ID: CompanyId（Phase4 sales/types.ts の string エイリアス）を再利用。
//   - 商品区分: Product（"hoso"|"pd"|"vap"、market/types.ts）を再利用。
//   - 産地: CountryId（market/types.ts）を再利用。
//   - Period: PeriodV2（core/period.ts）を再利用。
// 新しい会社ID・商品区分・産地・Period型は一切追加しない。
//
// 単位についての設計判断（暫定・要校正）:
//   工場の各能力プール（共通原料処理能力・HOSO/PD/VAP加工能力・冷凍包装能力）は
//   すべて「その四半期に生産できる完成品のHOSO換算トン」を単位とする
//   （原料消費トンではない）。原料と完成品はいずれもHosoEqTonsという同じ基盤を
//   共有しているため、歩留まり（yieldRatio）は「原料消費量→完成品数量」の
//   変換で一度だけ適用し、能力側の単位換算では歩留まりを二度適用しない
//   （§5「歩留まりと数量保存」参照）。これは仕様が明記していない箇所への
//   実装判断であり、Phase8以降の校正フェーズで見直す余地がある。

import { HosoEqTons, Ratio, UsdM, UsdPerHosoEqKg } from "../core/units";
import { PeriodV2 } from "../core/period";
import { CountryId, Product } from "../market/types";
import type { CompanyId } from "../sales/types";
import type { RawMaterialSource } from "../rawMaterials/types";

export class ProductionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionValidationError";
  }
}

export type { CompanyId };

// ---------------------------------------------------------------------
// 1. 工場・設備能力
// ---------------------------------------------------------------------

export type FactoryStatus = "active" | "idle" | "suspended";

/**
 * 1工場。設備増設・工場建設・減価償却はPhase8の対象であり、本Phaseでは
 * 外部から与えられた能力値をそのまま使う（外部入力＝ProductionQuarterInput.factories）。
 */
export interface Factory {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  readonly status: FactoryStatus;
  /** 四半期の共通原料処理能力（全商品が共有して消費する。HOSO換算トン、完成品換算量ベース）。 */
  readonly commonProcessingCapacity: HosoEqTons;
  /** HOSO専用加工能力。 */
  readonly hosoCapacity: HosoEqTons;
  /** PD専用加工能力。 */
  readonly pdCapacity: HosoEqTons;
  /** VAP専用加工能力。 */
  readonly vapCapacity: HosoEqTons;
  /** 冷凍・包装能力（全商品が共有して消費する）。 */
  readonly freezingPackagingCapacity: HosoEqTons;
  /** 基準稼働率（0〜1）。計画上の標準操業度。 */
  readonly baseUtilizationRate: Ratio;
  /** 設備利用可能率（0〜1）。故障・保全等による可用性。 */
  readonly equipmentAvailabilityRate: Ratio;
}

/** 能力プールごとの、稼働率・設備利用可能率を反映した有効能力（HosoEqTons）。 */
export interface FactoryEffectiveCapacity {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  readonly commonProcessing: HosoEqTons;
  readonly hoso: HosoEqTons;
  readonly pd: HosoEqTons;
  readonly vap: HosoEqTons;
  readonly freezingPackaging: HosoEqTons;
}

// ---------------------------------------------------------------------
// 2. ワーカー・労働能力
// ---------------------------------------------------------------------

/** 将来のPhase（採用・退職・教育）を見越した状態フィールド。本Phaseでは"active"のみ使用する。 */
export type WorkerLifecycleStatus = "active" | "hiring" | "retiring" | "training";

/** 商品（または将来の工程）別の技能水準。 */
export interface WorkerSkillEntry {
  readonly product: Product;
  /** 技能水準（0〜1）。1が熟練、0は未経験相当。 */
  readonly skillLevel: Ratio;
}

/**
 * 1工場・1会社ぶんのワーカー配置。正社員・常用ワーカーと臨時ワーカーを区別する
 * （臨時ワーカーは即時利用できるが、常用ワーカーより生産効率を低くする）。
 */
export interface WorkerAssignment {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  /** 正社員・常用ワーカーの配置人数。 */
  readonly regularHeadcount: number;
  /** 臨時ワーカーの配置人数（即時利用可能）。 */
  readonly temporaryHeadcount: number;
  /** 商品別の技能水準（対象外の商品はスキルなし＝0として扱う）。 */
  readonly skills: readonly WorkerSkillEntry[];
  /** 残業率（0以上。ParametersのovertimeRateCapで上限を設ける）。 */
  readonly overtimeRate: Ratio;
  /** 欠勤・稼働可能率（0〜1、1が全員出勤）。 */
  readonly attendanceRate: Ratio;
  /** 将来の採用・退職・教育中の状態を表せる拡張フィールド。省略時は"active"。 */
  readonly lifecycleStatus?: WorkerLifecycleStatus;
}

/**
 * 1つの生産計画に対して、工場共通のワーカープール（WorkerAssignment）から
 * 実際に配分された常用・臨時ワーカー人数と、そこから算出した有効労働能力
 * （HosoEqTons、完成品換算量ベース）。
 *
 * 【Phase 6.1修正】常用・臨時ワーカーは、工場全体で有限の共有プールとして
 * 扱う。同じ人数を複数商品へ重複して割り当てることはできず、1工場内の
 * 商品別配分（assignedRegularHeadcount・assignedTemporaryHeadcountの合計）は
 * WorkerAssignment.regularHeadcount / .temporaryHeadcountをそれぞれ超えない
 * （常用・臨時は別々に数量保存する。allocateWorkersToPlans参照）。
 */
export interface WorkerAllocationEntry {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  readonly product: Product;
  /** この生産計画へ実際に配分された常用ワーカー人数（工場の共有プールから配分。他計画と重複しない）。 */
  readonly assignedRegularHeadcount: number;
  /** この生産計画へ実際に配分された臨時ワーカー人数。 */
  readonly assignedTemporaryHeadcount: number;
  /** 適用後の残業率（overtimeRateCapで上限クリップ後の値）。 */
  readonly appliedOvertimeRate: Ratio;
  /** 配分された人数（assignedRegularHeadcount・assignedTemporaryHeadcount）から算出した有効労働能力。 */
  readonly laborCapacity: HosoEqTons;
}

/** 1工場ぶんの配分後・未配置ワーカー人数（優先順位配分後、資源不足等で余った人数）。 */
export interface FactoryWorkerAllocationSummary {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  readonly unassignedRegularHeadcount: number;
  readonly unassignedTemporaryHeadcount: number;
}

// ---------------------------------------------------------------------
// 3. 生産計画（入力）
// ---------------------------------------------------------------------

/** 使用可能な原料ロット条件（省略時はFIFO・全ロット対象）。 */
export interface RawMaterialLotSelector {
  readonly source?: RawMaterialSource;
  readonly originCountry?: CountryId;
}

/** 1社・1工場・1商品区分の当期生産計画。 */
export interface CompanyProductionPlanEntry {
  readonly companyId: CompanyId;
  readonly factoryId: string;
  readonly product: Product;
  /** 生産希望量（完成品換算量、HosoEqTons）。 */
  readonly desiredQuantity: HosoEqTons;
  /** 生産優先順位。小さいほど優先度が高い。同順位は決定論的な比例配分で解決する。 */
  readonly priority: number;
  /**
   * 当該生産計画に適用する残業率。省略時は対応するWorkerAssignment.overtimeRateを使う
   * （1工場内で商品ごとに異なる残業方針を取りたい場合の上書き）。
   */
  readonly overtimeRateOverride?: Ratio;
  /** 使用可能な原料ロット条件。省略時はFIFO（全ロット対象）。 */
  readonly rawMaterialLotSelector?: RawMaterialLotSelector;
  /** 最大許容原料消費量（この量を超えて原料を消費しない）。省略時は歩留まりから逆算した必要量がそのまま上限になる。 */
  readonly maxRawMaterialConsumption?: HosoEqTons;
}

// ---------------------------------------------------------------------
// 4. 生産可能量・制約配分（出力）
// ---------------------------------------------------------------------

export type ProductionShortfallReason =
  | "rawMaterialShortage" // 原料不足
  | "commonCapacityShortage" // 共通設備不足
  | "productCapacityShortage" // 商品別設備不足
  | "laborShortage" // ワーカー不足
  | "packagingCapacityShortage"; // 包装・冷凍能力不足

/** 1つの生産計画に対する制約配分の結果。 */
export interface ProductionAllocationEntry {
  readonly companyId: CompanyId;
  readonly factoryId: string;
  readonly product: Product;
  readonly priority: number;
  readonly desiredQuantity: HosoEqTons;
  /** 実際に生産可能と判定された完成品数量（各種制約の最小値）。 */
  readonly allocatedQuantity: HosoEqTons;
  /** 生産できなかった量（desiredQuantity - allocatedQuantity、0以上）。 */
  readonly shortfallQuantity: HosoEqTons;
  /** 生産できなかった理由（複数該当しうる。desiredQuantityと一致した場合は空配列）。 */
  readonly shortfallReasons: readonly ProductionShortfallReason[];
  /** この配分が要求する原料消費量（allocatedQuantity / saleableRecoveryRatio）。 */
  readonly requiredRawMaterialQuantity: HosoEqTons;
  /**
   * 各制約段階での中間値（監査・テスト用）。すべて完成品HOSO換算量ベース
   * （commonCapacityLimitedは、工場共通処理能力による原料投入側の制約を
   * saleableRecoveryRatioで完成品換算量へ変換した値）。
   */
  readonly stages: {
    readonly rawMaterialLimited: HosoEqTons;
    readonly commonCapacityLimited: HosoEqTons;
    readonly freezingPackagingLimited: HosoEqTons;
    readonly productCapacityLimited: HosoEqTons;
    readonly laborLimited: HosoEqTons;
  };
  /** 工場共通ワーカープールから実際に配分された人数・有効労働能力（§2「ワーカーを工場共通資源にする」）。 */
  readonly labor: {
    readonly assignedRegularHeadcount: number;
    readonly assignedTemporaryHeadcount: number;
    readonly appliedOvertimeRate: Ratio;
  };
}

export interface ProductionAllocationResult {
  readonly period: PeriodV2;
  readonly entries: readonly ProductionAllocationEntry[];
  /** 工場ごとの配分後・未配置ワーカー人数（優先順位配分で使い切れなかった人数）。 */
  readonly factoryWorkerSummaries: readonly FactoryWorkerAllocationSummary[];
}

// ---------------------------------------------------------------------
// 5. 生産バッチ・歩留まり
// ---------------------------------------------------------------------

/** 1生産バッチが消費した原料ロットの内訳1件。 */
export interface ProductionBatchRawMaterialConsumption {
  readonly lotId: string;
  readonly quantity: HosoEqTons;
  readonly unitCost: UsdPerHosoEqKg;
  readonly originCountry: CountryId;
}

/**
 * 1生産バッチ（1社×1工場×1商品×1四半期の生産実行結果）。
 * 原料消費量 = 完成品数量 + 加工損失（数量保存。§5参照）。
 * 加工費・損失額はPhase8へ渡せる情報として保持するのみで、会計計上しない。
 */
export interface ProductionBatch {
  readonly batchId: string;
  readonly companyId: CompanyId;
  readonly factoryId: string;
  readonly product: Product;
  readonly period: PeriodV2;
  readonly rawMaterialConsumed: readonly ProductionBatchRawMaterialConsumption[];
  readonly rawMaterialConsumedTotal: HosoEqTons;
  readonly finishedGoodsQuantity: HosoEqTons;
  readonly processingLoss: HosoEqTons;
  /** 消費原料の加重平均取得原価に基づく原料取得原価（記録用、非会計計上）。 */
  readonly rawMaterialCost: UsdM;
  /** 基準加工費（parameters由来の単位加工費 × finishedGoodsQuantity、記録用、非会計計上）。 */
  readonly baseProcessingCost: UsdM;
  /** 操業負荷指標（このバッチの生産達成率 = finishedGoodsQuantity / desiredQuantity、[0,1]）。 */
  readonly capacityUtilizationIndex: Ratio;
  readonly shortfallQuantity: HosoEqTons;
  readonly shortfallReasons: readonly ProductionShortfallReason[];
}

// ---------------------------------------------------------------------
// 6. 完成品在庫（ロット）
// ---------------------------------------------------------------------

export type FinishedGoodsLotStatus =
  | "available" // 使用可能
  | "allocated" // 契約へ充当済み（remainingQuantity=0）
  | "expired"; // 期限切れ・廃棄

/** 完成品1ロット。 */
export interface FinishedGoodsLot {
  readonly lotId: string;
  readonly companyId: CompanyId;
  readonly factoryId: string;
  readonly product: Product;
  readonly producedPeriod: PeriodV2;
  readonly originalQuantity: HosoEqTons;
  readonly remainingQuantity: HosoEqTons;
  /** 対応する原料ロット（消費内訳。複数ロットにまたがりうる）。 */
  readonly sourceRawMaterialLots: readonly ProductionBatchRawMaterialConsumption[];
  /** 原料原産国（sourceRawMaterialLotsから重複排除して導出）。 */
  readonly rawMaterialOriginCountries: readonly CountryId[];
  /** 原料単価（消費原料の加重平均、USD/HOSO換算kg）。 */
  readonly rawMaterialUnitCost: UsdPerHosoEqKg;
  /** 基準加工費（記録用、非会計計上）。 */
  readonly baseProcessingCost: UsdM;
  readonly availableFromPeriod: PeriodV2;
  readonly expiryPeriod?: PeriodV2;
  readonly status: FinishedGoodsLotStatus;
}

/** Phase6内部・将来の他Phaseから渡される完成品消費指示（会社×商品単位、FIFOで消費する）。 */
export interface FinishedGoodsConsumptionInstruction {
  readonly companyId: CompanyId;
  readonly product: Product;
  readonly quantity: HosoEqTons;
}

// ---------------------------------------------------------------------
// 7. 契約履行
// ---------------------------------------------------------------------

/** 1件の契約履行（追跡用）。どの完成品ロットからいくら使ったかを記録する。 */
export interface FinishedGoodsUsageRecord {
  readonly contractId: string;
  readonly companyId: CompanyId;
  readonly product: Product;
  readonly lotId: string;
  readonly quantity: HosoEqTons;
}

/** 契約履行計画（適用前に算出する。実際の適用はsales/backlog.tsのapplyFulfillmentsへ委譲する）。 */
export interface ContractFulfillmentPlan {
  /** applyFulfillments（sales/backlog.ts）へそのまま渡せる、契約ID単位の明示履行指示。 */
  readonly explicitInstructions: readonly { readonly kind: "explicit"; readonly contractId: string; readonly quantity: HosoEqTons }[];
  /** consumeFinishedGoodsへそのまま渡せる、会社×商品単位の集計消費指示。 */
  readonly finishedGoodsConsumption: readonly FinishedGoodsConsumptionInstruction[];
  /** 契約×完成品ロットの使用内訳（追跡用）。 */
  readonly usage: readonly FinishedGoodsUsageRecord[];
}

// ---------------------------------------------------------------------
// 8. PD/VAPプレミアムへの供給シグナル
// ---------------------------------------------------------------------

/** 1社・1商品（PD/VAPのみ）の当期供給シグナル。計画値と実績値を区別する。 */
export interface ProductionSupplySignalInput {
  readonly companyId: CompanyId;
  readonly product: Extract<Product, "pd" | "vap">;
  /** 供給計画（当期の価格形成＝productPremiumへの入力に使う）。 */
  readonly plannedQuantity: HosoEqTons;
  /** 供給実績（次期以降へのフィードバックに使う。当期価格形成には使わない）。 */
  readonly actualQuantity: HosoEqTons;
}

/** 産地（国）単位に集計した供給シグナル。 */
export interface CountryProductionSupplySignal {
  readonly country: CountryId;
  readonly product: Extract<Product, "pd" | "vap">;
  readonly plannedCapacity: HosoEqTons;
  readonly actualCapacity: HosoEqTons;
}

// ---------------------------------------------------------------------
// 9. 操業負荷指標（Phase7向け）
// ---------------------------------------------------------------------

export interface FactoryLoadMetrics {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  /** 設備稼働率（実際の生産量合計 / 工場の有効設備能力合計）。 */
  readonly equipmentUtilizationRate: Ratio;
  /** 労働稼働率（実際の生産量合計 / 有効労働能力合計）。 */
  readonly laborUtilizationRate: Ratio;
  /** 残業率（配置されたWorkerAssignmentの適用後残業率）。 */
  readonly overtimeRate: Ratio;
  /** 臨時ワーカー比率。 */
  readonly temporaryWorkerShare: Ratio;
  /** 商品構成の複雑度（0〜1。生産した商品区分数に基づく正規化指標）。 */
  readonly productMixComplexity: Ratio;
  /** 消費した原料ロットの平均経過期間（四半期数、入庫からの経過ターン数の加重平均）。 */
  readonly averageRawMaterialAgeQuarters: number;
  /** 生産未達率（合計shortfall / 合計desiredQuantity）。 */
  readonly productionShortfallRate: Ratio;
  /** 加工損失率（合計processingLoss / 合計rawMaterialConsumed）。 */
  readonly processingLossRate: Ratio;
}

export interface CompanyLoadMetrics {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly equipmentUtilizationRate: Ratio;
  readonly laborUtilizationRate: Ratio;
  readonly overtimeRate: Ratio;
  readonly temporaryWorkerShare: Ratio;
  readonly productMixComplexity: Ratio;
  readonly averageRawMaterialAgeQuarters: number;
  readonly productionShortfallRate: Ratio;
  readonly processingLossRate: Ratio;
}

// ---------------------------------------------------------------------
// 10. 四半期ランナー
// ---------------------------------------------------------------------

export interface ProductionQuarterInput {
  readonly factories: readonly Factory[];
  readonly workerAssignments: readonly WorkerAssignment[];
  readonly plans: readonly CompanyProductionPlanEntry[];
  /** 会社→産地（VN固定が基本だが将来の拡張性のため明示入力とする）のマッピング。PD/VAP供給シグナル集計に使う。 */
  readonly companyCountry: Readonly<Record<CompanyId, CountryId>>;
}

export interface ProductionQuarterRecord {
  readonly period: PeriodV2;
  readonly allocation: ProductionAllocationResult;
  readonly batches: readonly ProductionBatch[];
  readonly newFinishedGoodsLots: readonly FinishedGoodsLot[];
  readonly expiredFinishedGoodsLots: readonly FinishedGoodsLot[];
  readonly fulfillmentPlan: ContractFulfillmentPlan;
  readonly supplySignals: readonly CountryProductionSupplySignal[];
  readonly factoryLoadMetrics: readonly FactoryLoadMetrics[];
  readonly companyLoadMetrics: readonly CompanyLoadMetrics[];
}

export interface ProductionState {
  readonly currentPeriod: PeriodV2;
  readonly finishedGoodsLots: readonly FinishedGoodsLot[];
  readonly history: readonly ProductionQuarterRecord[];
}
