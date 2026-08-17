// ShrimpX V2 — AI Management Meeting: Operational KPI Semantics（AMM-M2.4）
//
// 【背景・root cause】Test26 BAL Turn4で「現在の当社業績を分析して」という質問に対し、
// 会議形式・役割分担は改善したが、Databookと照合すると複数のFact/Semantic Errorが
// 残っていた: (1) overdue=0の健全なforward backlogを「納期遅延」と混同する余地、
// (2) equipmentUtilization(47.44%)とlaborUtilization(95.32%)を「utilization」として
// 一括表現し「工場全体が能力上限」と誤解させる余地、(3) company-wide equipment
// utilizationだけでは商品別のローカルなボトルネック（PD equipment shortage=1,015t）
// が見えない、(4) rawMaterial/equipment/laborの3種のshortfallの優先順位（bottleneck
// hierarchy）が明示されていない、(5) opening/ending/in-transit等の在庫の種類が
// 区別されず「原料在庫10,165t」のような曖昧な発言の余地がある、(6) regular/temporary
// workerの区別が無く存在しない人数を発言する余地がある、(7) interest-bearing debt
// （有利子負債）とtotal liabilities（負債合計）が区別されていない。
//
// 【会計・生産監査結果（変更しない。既存の値をそのまま転記・単純集計するだけ）】
// app/lib/v2/companyLab/types.ts の CompanyQuarterSummary、
// app/lib/v2/production/types.ts の ProductionAllocationEntry・WorkerAssignment を
// 監査した結果、実装指示が要求する全KPI（equipmentUtilizationRate・laborUtilizationRate・
// overtimeRate・temporaryWorkerShare・rawMaterialShortfall・equipmentShortfall・
// laborShortfall・rawMaterialInventory・regularHeadcount・temporaryHeadcount等）は
// 既にengine（production/quarterRunner等）が計算済みであり、新しい生産計算を
// 一切増設する必要がないことを確認した（production/sales/finance engine自体は
// 一切変更しない）。商品別のequipment shortageのみ、既存のProductionAllocationEntry
// （companyId×factoryId×product単位）を商品でグルーピングする単純集計を追加する
// （新しい判定ロジックではなく、既存reasonCodes.tsの会社全体集計と同じフィルタ条件を
// 商品単位に分解しただけ）。

import { CompanyQuarterSummary } from "../types";
import { ProductionAllocationEntry, WorkerAssignment } from "../../production/types";
import { unwrapUnit } from "../../core/units";

/** 実装指示§3。equipmentUtilization / laborUtilization / overtimeRateを別KPIとして保持し、「utilization」へ一括しない。 */
export interface UtilizationPacket {
  readonly periodLabel: string;
  readonly equipmentUtilizationRate: number;
  readonly laborUtilizationRate: number;
  readonly overtimeRate: number;
  readonly temporaryWorkerShare: number;
}

export type BottleneckCategory = "RAW_MATERIAL" | "EQUIPMENT" | "LABOR" | "NONE";

/** 実装指示§4。商品別のshortfall内訳（company-wide equipment utilizationだけでは見えないlocalなボトルネックを区別する）。 */
export interface ProductBottleneckFact {
  readonly product: string;
  readonly rawMaterialShortageTons: number;
  readonly equipmentShortageTons: number;
  readonly laborShortageTons: number;
}

/** 実装指示§5。rawMaterial/equipment/laborのshortfall優先順位（lost productionの大きさで判定するだけ。新しい経営判断ロジックではない）。 */
export interface BottleneckPacket {
  readonly periodLabel: string;
  readonly rawMaterialShortageTons: number;
  readonly equipmentShortageTons: number;
  readonly laborShortageTons: number;
  readonly primaryBottleneck: BottleneckCategory;
  readonly secondaryBottleneck: BottleneckCategory | null;
  readonly productBottlenecks: readonly ProductBottleneckFact[];
}

/** 実装指示§6。opening/ending/in-transit/plannedを区別する（「原料在庫◯◯t」のような曖昧発言を防ぐ）。 */
export interface InventoryPacket {
  readonly periodLabel: string;
  readonly endingRawMaterialInventoryTons: number;
  /** 前期のendingが無い場合（turn1等）はnull（捏造しない）。 */
  readonly openingRawMaterialInventoryTons: number | null;
  readonly endingFinishedGoodsInventoryTons: number;
  readonly importInTransitTons: number;
  readonly importArrivedTons: number;
  readonly domesticPurchaseTons: number;
}

/** 実装指示§7。regular/temporary workerを別項目化し、存在しない人数を発言できないようにする。 */
export interface WorkforcePacket {
  readonly periodLabel: string;
  readonly regularWorkers: number;
  readonly temporaryWorkers: number;
  readonly overtimeRate: number;
}

const EQUIPMENT_SHORTFALL_REASONS: ReadonlySet<string> = new Set(["commonCapacityShortage", "productCapacityShortage", "packagingCapacityShortage"]);

export function buildUtilizationPacket(summary: CompanyQuarterSummary, periodLabel: string): UtilizationPacket {
  return {
    periodLabel,
    equipmentUtilizationRate: unwrapUnit(summary.equipmentUtilizationRate),
    laborUtilizationRate: unwrapUnit(summary.laborUtilizationRate),
    overtimeRate: unwrapUnit(summary.overtimeRate),
    temporaryWorkerShare: unwrapUnit(summary.temporaryWorkerShare),
  };
}

/** rawMaterial/equipment/laborのうち、shortfall量が最大のものをprimary、次点をsecondaryとする（全て0ならNONE）。 */
export function computeBottleneckHierarchy(
  rawMaterialShortageTons: number,
  equipmentShortageTons: number,
  laborShortageTons: number
): { readonly primary: BottleneckCategory; readonly secondary: BottleneckCategory | null } {
  const ranked = (
    [
      ["RAW_MATERIAL", rawMaterialShortageTons],
      ["EQUIPMENT", equipmentShortageTons],
      ["LABOR", laborShortageTons],
    ] as const
  )
    .filter(([, tons]) => tons > 1e-9)
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { primary: "NONE", secondary: null };
  return { primary: ranked[0][0], secondary: ranked.length > 1 ? ranked[1][0] : null };
}

export function buildBottleneckPacket(summary: CompanyQuarterSummary, productionEntries: readonly ProductionAllocationEntry[], periodLabel: string): BottleneckPacket {
  const rawMaterialShortageTons = unwrapUnit(summary.rawMaterialShortfall);
  const equipmentShortageTons = unwrapUnit(summary.equipmentShortfall);
  const laborShortageTons = unwrapUnit(summary.laborShortfall);
  const { primary, secondary } = computeBottleneckHierarchy(rawMaterialShortageTons, equipmentShortageTons, laborShortageTons);

  const byProduct = new Map<string, { rawMaterialShortageTons: number; equipmentShortageTons: number; laborShortageTons: number }>();
  for (const entry of productionEntries) {
    const shortfall = unwrapUnit(entry.shortfallQuantity);
    if (shortfall <= 1e-9 || entry.shortfallReasons.length === 0) continue;
    const bucket = byProduct.get(entry.product) ?? { rawMaterialShortageTons: 0, equipmentShortageTons: 0, laborShortageTons: 0 };
    if (entry.shortfallReasons.includes("rawMaterialShortage")) bucket.rawMaterialShortageTons += shortfall;
    if (entry.shortfallReasons.some((r) => EQUIPMENT_SHORTFALL_REASONS.has(r))) bucket.equipmentShortageTons += shortfall;
    if (entry.shortfallReasons.includes("laborShortage")) bucket.laborShortageTons += shortfall;
    byProduct.set(entry.product, bucket);
  }

  return {
    periodLabel,
    rawMaterialShortageTons,
    equipmentShortageTons,
    laborShortageTons,
    primaryBottleneck: primary,
    secondaryBottleneck: secondary,
    productBottlenecks: [...byProduct.entries()].map(([product, v]) => ({ product, ...v })),
  };
}

export function buildInventoryPacket(summary: CompanyQuarterSummary, priorSummary: CompanyQuarterSummary | null, periodLabel: string): InventoryPacket {
  return {
    periodLabel,
    endingRawMaterialInventoryTons: unwrapUnit(summary.rawMaterialInventory),
    openingRawMaterialInventoryTons: priorSummary ? unwrapUnit(priorSummary.rawMaterialInventory) : null,
    endingFinishedGoodsInventoryTons: unwrapUnit(summary.finishedGoodsInventory),
    importInTransitTons: unwrapUnit(summary.importInTransitQuantity),
    importArrivedTons: unwrapUnit(summary.importArrivedQuantity),
    domesticPurchaseTons: unwrapUnit(summary.domesticPurchaseQuantity),
  };
}

export function buildWorkforcePacket(workerAssignments: readonly WorkerAssignment[], summary: CompanyQuarterSummary, periodLabel: string): WorkforcePacket {
  return {
    periodLabel,
    regularWorkers: workerAssignments.reduce((sum, w) => sum + w.regularHeadcount, 0),
    temporaryWorkers: workerAssignments.reduce((sum, w) => sum + w.temporaryHeadcount, 0),
    overtimeRate: unwrapUnit(summary.overtimeRate),
  };
}
