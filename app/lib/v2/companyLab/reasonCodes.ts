// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 理由コード
//
// 生成AIを使わず、既存Phaseの出力（shortfallReasons・MarketPriceDriver・
// 契約状態・養殖収穫結果等）から機械的に理由コードへ変換するだけの純粋関数群。
// 新しい判定ロジックは持たない（既存Phaseの判定結果をそのまま読み替えるのみ）。

import { unwrapUnit } from "../core/units";
import { MarketPriceDriver } from "../market/types";
import { AquacultureHarvestResult } from "../rawMaterials/types";
import { ProductionAllocationEntry, ProductionShortfallReason } from "../production/types";
import { CompanyId, CompanyAllocationEntry, SalesContract } from "../sales/types";
import { MarketSalesEffortAdjustment } from "../sales/marketEffort";
import { CompanyReasonCode, CompanyReasonEntry } from "./types";

const EPSILON = 1e-6;

const SHORTFALL_REASON_MESSAGE: Readonly<Record<ProductionShortfallReason, { code: CompanyReasonCode; message: string }>> = {
  rawMaterialShortage: { code: "RAW_MATERIAL_SHORTAGE", message: "原料不足により生産希望量を満たせなかった。" },
  commonCapacityShortage: { code: "EQUIPMENT_CAPACITY_SHORTAGE", message: "工場共通処理能力（原料投入側）の不足により生産希望量を満たせなかった。" },
  packagingCapacityShortage: { code: "EQUIPMENT_CAPACITY_SHORTAGE", message: "冷凍・包装能力の不足により生産希望量を満たせなかった。" },
  productCapacityShortage: { code: "EQUIPMENT_CAPACITY_SHORTAGE", message: "商品別設備能力の不足により生産希望量を満たせなかった。" },
  laborShortage: { code: "LABOR_SHORTAGE", message: "ワーカー不足により生産希望量を満たせなかった。" },
};

/** 生産配分結果（1社ぶんに絞り込み済み）から、原料・設備・労働不足の理由コードを抽出する。 */
export function reasonCodesFromProductionEntries(companyId: CompanyId, entries: readonly ProductionAllocationEntry[]): readonly CompanyReasonEntry[] {
  const seen = new Set<string>();
  const result: CompanyReasonEntry[] = [];
  for (const e of entries) {
    for (const reason of e.shortfallReasons) {
      const mapped = SHORTFALL_REASON_MESSAGE[reason];
      const key = `${mapped.code}::${e.product}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ code: mapped.code, companyId, message: `${e.product.toUpperCase()}: ${mapped.message}` });
    }
    if (unwrapUnit(e.labor.appliedOvertimeRate) > 0.2) {
      const key = `OVERTIME::${e.product}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ code: "OVERTIME_CAP_REACHED", companyId, message: `${e.product.toUpperCase()}: 残業率が高水準（${(unwrapUnit(e.labor.appliedOvertimeRate) * 100).toFixed(0)}%）で稼働している。` });
      }
    }
  }
  return result;
}

/** 販売成約配分（会社の1件）から、安値提示による成約増・営業能力不足の理由コードを抽出する。 */
export function reasonCodesFromSalesAllocation(companyId: CompanyId, entry: CompanyAllocationEntry, basePrice: number): readonly CompanyReasonEntry[] {
  const result: CompanyReasonEntry[] = [];
  const askPrice = unwrapUnit(entry.askPrice);
  if (askPrice < basePrice - EPSILON && unwrapUnit(entry.allocatedQuantity) > EPSILON) {
    result.push({ code: "LOW_PRICE_WON_SHARE", companyId, message: `基準価格(${basePrice.toFixed(2)})より低い提示価格(${askPrice.toFixed(2)})で成約量を増やした。` });
  }
  if (entry.coverageScore < 0.5) {
    result.push({ code: "SALES_FORCE_SHORTAGE", companyId, message: `営業人員によるカバレッジが低く（${(entry.coverageScore * 100).toFixed(0)}%）、成約機会を取りきれていない。` });
  }
  return result;
}

/**
 * 【SAI-2追加作業: 市場別営業配置・商品別営業工数】会社×市場ごとの営業工数換算
 * 能力制約(sales/marketEffort.ts)により、当期の販売計画(desiredQuantity)が実際に
 * 比例縮小された場合の理由コードを抽出する（1社ぶんに絞り込み済み）。
 */
export function reasonCodesFromSalesEffortAdjustments(companyId: CompanyId, adjustments: readonly MarketSalesEffortAdjustment[]): readonly CompanyReasonEntry[] {
  return adjustments
    .filter((a) => a.companyId === companyId)
    .map((a) => ({
      code: "SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY" as const,
      companyId,
      message:
        `市場 "${a.market}": 営業人員${a.headcount}人による処理能力（${a.capacityHosoEqTons.toFixed(1)}トン、HOSO換算）に対し、` +
        `商品別営業工数を加味した希望販売量（${a.desiredEffortWeightedQuantity.toFixed(1)}トン相当）が上回ったため、` +
        `全商品の販売計画を一律${(a.scaleFactor * 100).toFixed(0)}%へ縮小した。`,
    }));
}

/** 国内買付配分（会社の1件）から、国内買付競争激化の理由コードを抽出する。 */
export function reasonCodeFromDomesticCompetition(companyId: CompanyId, coverageScore: number, allocatedRatioOfDesired: number): readonly CompanyReasonEntry[] {
  if (allocatedRatioOfDesired < 0.7) {
    return [
      {
        code: "DOMESTIC_COMPETITION_INTENSE",
        companyId,
        message: `国内買付希望量に対する実際の配分比率が低く（${(allocatedRatioOfDesired * 100).toFixed(0)}%）、他社との買付競争が激しい可能性がある。`,
      },
    ];
  }
  return [];
}

/** 輸入ロットの状態から、輸入到着待ちの理由コードを抽出する。 */
export function reasonCodeFromImportInTransit(companyId: CompanyId, inTransitQuantity: number): readonly CompanyReasonEntry[] {
  if (inTransitQuantity > EPSILON) {
    return [{ code: "IMPORT_IN_TRANSIT", companyId, message: `輸送中の輸入原料が${inTransitQuantity.toFixed(1)}トン(HOSO換算)あり、到着まで使用できない。` }];
  }
  return [];
}

/** 養殖収穫結果から、疾病による収穫減・計画どおりの理由コードを抽出する。 */
export function reasonCodesFromAquacultureHarvest(companyId: CompanyId, results: readonly AquacultureHarvestResult[]): readonly CompanyReasonEntry[] {
  return results.map((r) => {
    const survivalRatio = unwrapUnit(r.survivalRatio);
    if (survivalRatio < 0.85) {
      return {
        code: "DISEASE_HARVEST_LOSS" as const,
        companyId,
        message: `疾病圧力(${(unwrapUnit(r.diseasePressure) * 100).toFixed(0)}%)の影響で生残率が${(survivalRatio * 100).toFixed(0)}%に低下し、収穫量が減少した。`,
      };
    }
    return {
      code: "AQUACULTURE_HARVEST_ON_TRACK" as const,
      companyId,
      message: `養殖収穫はほぼ計画どおり（生残率${(survivalRatio * 100).toFixed(0)}%）。`,
    };
  });
}

/** 契約が納期超過に転じたかどうかの理由コード。 */
export function reasonCodesFromOverdueContracts(companyId: CompanyId, contractsBefore: readonly SalesContract[], contractsAfter: readonly SalesContract[]): readonly CompanyReasonEntry[] {
  const beforeById = new Map(contractsBefore.map((c) => [c.contractId, c.status]));
  const newlyOverdue = contractsAfter.filter((c) => c.status === "overdue" && beforeById.get(c.contractId) !== "overdue");
  if (newlyOverdue.length === 0) return [];
  const totalOutstanding = newlyOverdue.reduce((sum, c) => sum + unwrapUnit(c.outstandingQuantity), 0);
  return [
    {
      code: "OVER_CONTRACTED_OVERDUE",
      companyId,
      message: `${newlyOverdue.length}件の契約が納期超過に転じた（未履行合計 約${totalOutstanding.toFixed(1)}トン、HOSO換算）。契約過多の可能性がある。`,
    },
  ];
}

/** 国際市場のPD/VAPプレミアム関連ドライバーから、供給増加によるプレミアム低下の理由コードを抽出する（会社非依存の全体理由）。 */
export function globalReasonCodesFromMarketDrivers(drivers: readonly MarketPriceDriver[]): readonly CompanyReasonEntry[] {
  const result: CompanyReasonEntry[] = [];
  if (drivers.includes("PD_CAPACITY_TIGHTNESS") === false && drivers.includes("PROCESSING_CAPACITY_OVERSUPPLY")) {
    result.push({ code: "PD_SUPPLY_INCREASE_LOWERS_PREMIUM", companyId: "*", message: "PD加工能力の供給過剰により、PDプレミアムが押し下げられている。" });
  }
  if (drivers.includes("VAP_DEMAND_STRENGTH") === false && drivers.includes("PROCESSING_CAPACITY_OVERSUPPLY")) {
    result.push({ code: "VAP_SUPPLY_INCREASE_LOWERS_PREMIUM", companyId: "*", message: "VAP加工能力の供給過剰により、VAPプレミアムが押し下げられている。" });
  }
  return result;
}
