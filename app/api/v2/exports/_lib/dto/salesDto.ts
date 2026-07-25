// ShrimpX V2 — Export DTO / §3 市場別×商品別の販売計画・成約配分明細
//
// 【データ源（すべて既存の確定履歴に保存済み）】
//   - 販売計画: entry.record.decisions[].salesPlans（CompanySalesPlanEntry[]）
//   - 成約配分: entry.record.salesRecord.allocations（MarketProductAllocationResult[]）
//
// 【四半期粒度について】現行エンジンは四半期単位であり、月別（1月・2月・3月）の
// 実績は保存されていない。存在しない月別実績を推測して作らない
// （三宅さんの指示 §3）。本DTOの粒度は「四半期 × 市場 × 商品区分 × 会社」。
//
// 【スコープ隔離】MarketProductAllocationResult.companies[] には他社の提示価格・
// 営業カバレッジ・競争力内訳・成約量（＝他社の非公開情報）が含まれる。会社スコープ
// では companies[] を対象会社のみへ絞り込み、市場レベルの公開情報（basePrice・
// targetDemand・externalOptionQuantity）はそのまま出力する。
//
// 【再計算しない】成約金額（数量×単価）、成約できなかった数量（販売希望量−成約量）、
// 市場別・商品別の小計は、いずれもExcel側の数式で組み立てる。

import {
  CompanyAllocationEntry,
  CompanyId,
  CompanySalesPlanEntry,
  CompetitivenessWeightBreakdown,
  MarketProductAllocationResult,
  PlanCostExpectation,
} from "../../../../../lib/v2/sales/types";
import { CompanyLabQuarterHistoryEntry } from "../../../../../lib/v2/companyLab/persistence/types";
import { PeriodV2 } from "../../../../../lib/v2/core/period";

/** 販売計画時点の予想原価（PlanCostExpectation の許可項目）。 */
export interface ExportPlanCostExpectation {
  readonly expectedRawMaterialPriceUsdPerHosoEqKg: number;
  readonly expectedProcessingCostUsdPerHosoEqKg: number;
  readonly minimumAcceptablePriceUsdPerHosoEqKg: number;
}

function buildExportPlanCostExpectation(cost: PlanCostExpectation): ExportPlanCostExpectation {
  return {
    expectedRawMaterialPriceUsdPerHosoEqKg: cost.expectedRawMaterialPriceUsdPerHosoEqKg,
    expectedProcessingCostUsdPerHosoEqKg: cost.expectedProcessingCostUsdPerHosoEqKg,
    minimumAcceptablePriceUsdPerHosoEqKg: cost.minimumAcceptablePriceUsdPerHosoEqKg,
  };
}

/** 1社・1市場・1商品区分の当期販売計画（CompanySalesPlanEntry の許可項目）。 */
export interface ExportSalesPlanEntry {
  readonly companyId: CompanyId;
  readonly market: string;
  readonly product: string;
  /** 販売希望量（HOSO換算トン）。 */
  readonly desiredQuantity: number;
  /** 基準価格に対する提示価格の調整額（USD/HOSO換算kg、値引きは負値）。 */
  readonly priceAdjustmentUsdPerHosoEqKg: number;
  readonly salesForceHeadcount: number;
  /** 希望リードタイム（未指定なら null＝標準リードタイム）。 */
  readonly desiredLeadTimeTurns: number | null;
  readonly customerRelationship: number | null;
  readonly qualityReputation: number | null;
  readonly deliveryReliability: number | null;
  readonly approvedAllocationCap: number | null;
  readonly costExpectation: ExportPlanCostExpectation | null;
}

export function buildExportSalesPlanEntry(plan: CompanySalesPlanEntry): ExportSalesPlanEntry {
  return {
    companyId: plan.companyId,
    market: plan.market,
    product: plan.product,
    desiredQuantity: plan.desiredQuantity,
    priceAdjustmentUsdPerHosoEqKg: plan.priceAdjustmentUsdPerHosoEqKg,
    salesForceHeadcount: plan.salesForceHeadcount,
    desiredLeadTimeTurns: plan.desiredLeadTimeTurns ?? null,
    customerRelationship: plan.customerRelationship ?? null,
    qualityReputation: plan.qualityReputation ?? null,
    deliveryReliability: plan.deliveryReliability ?? null,
    approvedAllocationCap: plan.approvedAllocationCap ?? null,
    costExpectation: plan.costExpectation ? buildExportPlanCostExpectation(plan.costExpectation) : null,
  };
}

/** competitivenessWeight の内訳（CompetitivenessWeightBreakdown の許可項目）。 */
export interface ExportCompetitivenessBreakdown {
  readonly priceContribution: number;
  readonly coverageContribution: number;
  readonly relationshipContribution: number;
  readonly qualityContribution: number;
  readonly deliveryReliabilityContribution: number;
  readonly rawPriceScore: number;
  readonly clampedPriceScore: number;
  readonly isPriceScoreAtCeiling: boolean;
  readonly isPriceScoreAtFloor: boolean;
}

function buildExportCompetitivenessBreakdown(breakdown: CompetitivenessWeightBreakdown): ExportCompetitivenessBreakdown {
  return {
    priceContribution: breakdown.priceContribution,
    coverageContribution: breakdown.coverageContribution,
    relationshipContribution: breakdown.relationshipContribution,
    qualityContribution: breakdown.qualityContribution,
    deliveryReliabilityContribution: breakdown.deliveryReliabilityContribution,
    rawPriceScore: breakdown.rawPriceScore,
    clampedPriceScore: breakdown.clampedPriceScore,
    isPriceScoreAtCeiling: breakdown.isPriceScoreAtCeiling,
    isPriceScoreAtFloor: breakdown.isPriceScoreAtFloor,
  };
}

/** 1社ぶんの成約配分結果（CompanyAllocationEntry の許可項目）。 */
export interface ExportCompanyAllocationEntry {
  readonly companyId: CompanyId;
  /** 提示価格（USD/HOSO換算kg）。 */
  readonly askPrice: number;
  /** 営業人員から導出した市場カバレッジ（0〜1）。 */
  readonly coverageScore: number;
  /** 営業人員・処理能力から導出した処理上限（HOSO換算トン）。 */
  readonly processingCapacity: number;
  readonly competitivenessWeight: number;
  readonly competitivenessBreakdown: ExportCompetitivenessBreakdown;
  /** 成約量（HOSO換算トン）。 */
  readonly allocatedQuantity: number;
}

function buildExportCompanyAllocationEntry(entry: CompanyAllocationEntry): ExportCompanyAllocationEntry {
  return {
    companyId: entry.companyId,
    askPrice: entry.askPrice,
    coverageScore: entry.coverageScore,
    processingCapacity: entry.processingCapacity,
    competitivenessWeight: entry.competitivenessWeight,
    competitivenessBreakdown: buildExportCompetitivenessBreakdown(entry.competitivenessBreakdown),
    allocatedQuantity: entry.allocatedQuantity,
  };
}

/** 1市場×1商品区分ぶんの成約配分結果（MarketProductAllocationResult の許可項目）。 */
export interface ExportMarketProductAllocation {
  readonly market: string;
  readonly product: string;
  readonly period: PeriodV2;
  /** 当期の市場×商品の基準価格（USD/HOSO換算kg、公開情報）。 */
  readonly basePrice: number;
  /** 当期の対象需要（HOSO換算トン、公開情報）。 */
  readonly targetDemand: number;
  /** 5社以外（他産地供給者・非購入）へ流れた需要（HOSO換算トン、公開情報）。 */
  readonly externalOptionQuantity: number;
  /**
   * 会社別の配分内訳。会社スコープでは対象会社1件のみに絞り込まれる
   * （他社の提示価格・競争力内訳を混入させない）。
   */
  readonly companies: readonly ExportCompanyAllocationEntry[];
}

export function buildExportMarketProductAllocation(
  allocation: MarketProductAllocationResult,
  scopedCompanyId?: CompanyId,
): ExportMarketProductAllocation {
  const companies =
    scopedCompanyId === undefined ? allocation.companies : allocation.companies.filter((c) => c.companyId === scopedCompanyId);
  return {
    market: allocation.market,
    product: allocation.product,
    period: allocation.period,
    basePrice: allocation.basePrice,
    targetDemand: allocation.targetDemand,
    externalOptionQuantity: allocation.externalOptionQuantity,
    companies: companies.map(buildExportCompanyAllocationEntry),
  };
}

/**
 * 当期の市場×商品別 成約配分明細。
 * scopedCompanyId を渡すと、各市場×商品の companies[] を対象会社のみへ絞り込む。
 */
export function buildExportMarketProductAllocations(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): readonly ExportMarketProductAllocation[] {
  return entry.record.salesRecord.allocations.map((a) => buildExportMarketProductAllocation(a, scopedCompanyId));
}

/** 指定会社の当期販売計画（会社スコープAPI用）。 */
export function buildExportSalesPlansForCompany(
  entry: CompanyLabQuarterHistoryEntry,
  companyId: CompanyId,
): readonly ExportSalesPlanEntry[] {
  const decision = entry.record.decisions.find((d) => d.companyId === companyId);
  if (!decision) return [];
  return decision.salesPlans.filter((p) => p.companyId === companyId).map(buildExportSalesPlanEntry);
}

/** 全社の当期販売計画（GMフルスコープのみ）。 */
export function buildExportSalesPlansAllCompanies(entry: CompanyLabQuarterHistoryEntry): readonly ExportSalesPlanEntry[] {
  return entry.record.decisions.flatMap((d) => d.salesPlans.map(buildExportSalesPlanEntry));
}
