// ShrimpX V2 — 会社経営統合テスト環境 品質・信頼・納期ダッシュボード（Phase 7B）表示用データ層
//
// app/lib/v2/quality/（Phase 7A）・app/lib/v2/sales/（Phase 4/6.3、Phase 7Bで
// competitivenessBreakdownを追加）・app/lib/v2/companyLab/（Phase 6.2、
// CompanyQuarterSummary・BatchQualityAdjustment・MarketDeliveryObservation）が
// 既に計算済みの結果だけを読み取り、画面表示用に抽出・集計・整形する。
//
// 【禁止事項（実装指示 §5「表示用データ層」より）】
//   - 品質スコアの再計算
//   - 操業リスクの再計算
//   - 事故判定の再実行
//   - 信頼スコアの再計算
//   - 成約競争力または配分量の再計算
// 本ファイルが行ってよいのは、既に計算済みの値の「抽出・合計・平均・除算による
// 比率表示・前期比較・丸め」だけである（app/lib/v2/companyLab/qualitySummary.ts
// のbuildCompanyQualitySummaryが会社合計のonTimeDeliveryRateをdueQuantity/
// onTimeQuantityの除算で出しているのと同じ種類の「集計・整形」であり、
// 品質・リスク・信頼・配分の計算式そのものには一切触れない）。

import { HosoEqTons, unwrapUnit } from "../../lib/v2/core/units";
import { PeriodV2 } from "../../lib/v2/core/period";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../lib/v2/market/types";
import { CompanyFixture, CompanyQuarterRecord, CompanyQuarterSummary } from "../../lib/v2/companyLab";
import { CompanyAllocationEntry } from "../../lib/v2/sales/types";

export const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

const EPSILON = 1e-6;

export function findCompanySummary(record: CompanyQuarterRecord, companyId: string): CompanyQuarterSummary | undefined {
  return record.companySummaries.find((s) => s.companyId === companyId);
}

function unwrapOrUndefined(value: HosoEqTons | undefined): number | undefined {
  return value === undefined ? undefined : unwrapUnit(value);
}

// ---------------------------------------------------------------------
// A. 当期経営サマリー
// ---------------------------------------------------------------------

export interface SummaryCardViewModel {
  readonly companyId: string;
  readonly period: PeriodV2;
  /** 総生産量（品質調整前、格落ち・再加工・廃棄すべて含む原始生産量の合計）。 */
  readonly totalProductionQuantity: number;
  /** 販売可能完成品数量（廃棄分だけを差し引いた後の量。会社の生産サマリーと同じ値）。 */
  readonly saleableFinishedGoodsQuantity: number;
  readonly downgradeQuantity: number;
  readonly reworkQuantity: number;
  readonly discardQuantity: number;
  readonly onTimeDeliveryRate?: number;
  readonly hasMajorIncident: boolean;
  readonly majorIncidentCount: number;
}

export function buildSummaryCardViewModel(record: CompanyQuarterRecord, companyId: string): SummaryCardViewModel | undefined {
  const summary = findCompanySummary(record, companyId);
  if (!summary) return undefined;

  const companyAdjustments = record.qualityAdjustments.filter((a) => a.companyId === companyId);
  const totalProductionQuantity = companyAdjustments.reduce((sum, a) => sum + unwrapUnit(a.originalFinishedGoodsQuantity), 0);
  const saleableFinishedGoodsQuantity = unwrapUnit(summary.hosoProduced) + unwrapUnit(summary.pdProduced) + unwrapUnit(summary.vapProduced);

  return {
    companyId,
    period: record.period,
    totalProductionQuantity: Math.round(totalProductionQuantity * 100) / 100,
    saleableFinishedGoodsQuantity: Math.round(saleableFinishedGoodsQuantity * 100) / 100,
    downgradeQuantity: unwrapUnit(summary.downgradeQuantity),
    reworkQuantity: unwrapUnit(summary.reworkQuantity),
    discardQuantity: unwrapUnit(summary.discardQuantity),
    onTimeDeliveryRate: summary.onTimeDeliveryRate,
    hasMajorIncident: summary.majorIncidentCount > 0,
    majorIncidentCount: summary.majorIncidentCount,
  };
}

// ---------------------------------------------------------------------
// B. 商品別品質
// ---------------------------------------------------------------------

export interface ProductQualityRow {
  readonly product: Product;
  /** 当期この商品の生産が実際にあったか（無ければ品質イベント自体が存在しない）。 */
  readonly hasProduction: boolean;
  /** 前四半期末までの蓄積品質スコア（0〜100）。CompanyQuarterSummary.qualityScoreByProductそのまま。 */
  readonly qualityScore?: number;
  /** 当期の数量加重平均操業リスク（0〜1）。CompanyQuarterSummary.operationalRiskByProductそのまま。 */
  readonly operationalRisk?: number;
  readonly originalProductionQuantity: number;
  readonly saleableProductionQuantity: number;
  readonly downgradeQuantity: number;
  readonly reworkQuantity: number;
  readonly discardQuantity: number;
  /** saleableProductionQuantity / originalProductionQuantity（生産があった場合のみ）。廃棄のみが真の数量損失であることの表示根拠。 */
  readonly saleableRecoveryRatio?: number;
  readonly hasMajorIncident: boolean;
  readonly majorIncidentCount: number;
}

export function buildProductQualityRows(record: CompanyQuarterRecord, companyId: string): readonly ProductQualityRow[] {
  const summary = findCompanySummary(record, companyId);
  const companyAdjustments = record.qualityAdjustments.filter((a) => a.companyId === companyId);

  return PRODUCTS.map((product) => {
    const productAdjustments = companyAdjustments.filter((a) => a.product === product);
    const original = productAdjustments.reduce((sum, a) => sum + unwrapUnit(a.originalFinishedGoodsQuantity), 0);
    const saleable = productAdjustments.reduce((sum, a) => sum + unwrapUnit(a.adjustedFinishedGoodsQuantity), 0);
    const downgrade = productAdjustments.reduce((sum, a) => sum + unwrapUnit(a.downgradeQuantity), 0);
    const rework = productAdjustments.reduce((sum, a) => sum + unwrapUnit(a.reworkQuantity), 0);
    const discard = productAdjustments.reduce((sum, a) => sum + unwrapUnit(a.discardQuantity), 0);
    const majorIncidentCount = productAdjustments.filter((a) => a.outcome.majorIncident.occurred).length;

    return {
      product,
      hasProduction: original > EPSILON,
      qualityScore: summary?.qualityScoreByProduct[product] !== undefined ? unwrapUnit(summary.qualityScoreByProduct[product]!) : undefined,
      operationalRisk: summary?.operationalRiskByProduct[product],
      originalProductionQuantity: Math.round(original * 100) / 100,
      saleableProductionQuantity: Math.round(saleable * 100) / 100,
      downgradeQuantity: Math.round(downgrade * 100) / 100,
      reworkQuantity: Math.round(rework * 100) / 100,
      discardQuantity: Math.round(discard * 100) / 100,
      saleableRecoveryRatio: original > EPSILON ? saleable / original : undefined,
      hasMajorIncident: majorIncidentCount > 0,
      majorIncidentCount,
    };
  });
}

// ---------------------------------------------------------------------
// C. 市場別信頼
// ---------------------------------------------------------------------

export type TrendDirection = "improved" | "worsened" | "flat" | "unknown";

function trendDirection(current: number | undefined, previous: number | undefined, flatBand: number): TrendDirection {
  if (current === undefined || previous === undefined) return "unknown";
  const delta = current - previous;
  if (Math.abs(delta) < flatBand) return "flat";
  return delta > 0 ? "improved" : "worsened";
}

export interface MarketTrustRow {
  readonly market: DemandMarketId;
  readonly customerTrustScore?: number;
  readonly deliveryReliabilityScore?: number;
  /** 当期が納期の契約だけを対象にした、この市場の当期納期遵守率（0〜100）。評価対象がなければundefined。 */
  readonly onTimeDeliveryRateThisPeriod?: number;
  readonly customerTrustDelta?: number;
  readonly customerTrustTrend: TrendDirection;
  readonly deliveryReliabilityDelta?: number;
  readonly deliveryReliabilityTrend: TrendDirection;
}

const TREND_FLAT_BAND_SCORE = 0.5;

export function buildMarketTrustRows(
  record: CompanyQuarterRecord,
  companyId: string,
  markets: readonly DemandMarketId[],
  previousRecord?: CompanyQuarterRecord
): readonly MarketTrustRow[] {
  const summary = findCompanySummary(record, companyId);
  const previousSummary = previousRecord ? findCompanySummary(previousRecord, companyId) : undefined;

  return markets.map((market) => {
    const trust = summary?.customerTrustByMarket[market];
    const reliability = summary?.deliveryReliabilityByMarket[market];
    const prevTrust = previousSummary?.customerTrustByMarket[market];
    const prevReliability = previousSummary?.deliveryReliabilityByMarket[market];

    const observation = record.deliveryObservations.find((d) => d.companyId === companyId && d.market === market);
    const dueQuantity = observation ? unwrapUnit(observation.dueQuantity) : 0;
    const onTimeDeliveryRateThisPeriod =
      observation && dueQuantity > EPSILON ? Math.round((unwrapUnit(observation.onTimeQuantity) / dueQuantity) * 10000) / 100 : undefined;

    const trustNum = trust !== undefined ? unwrapUnit(trust) : undefined;
    const prevTrustNum = prevTrust !== undefined ? unwrapUnit(prevTrust) : undefined;
    const reliabilityNum = reliability !== undefined ? unwrapUnit(reliability) : undefined;
    const prevReliabilityNum = prevReliability !== undefined ? unwrapUnit(prevReliability) : undefined;

    return {
      market,
      customerTrustScore: trustNum,
      deliveryReliabilityScore: reliabilityNum,
      onTimeDeliveryRateThisPeriod,
      customerTrustDelta: trustNum !== undefined && prevTrustNum !== undefined ? Math.round((trustNum - prevTrustNum) * 100) / 100 : undefined,
      customerTrustTrend: trendDirection(trustNum, prevTrustNum, TREND_FLAT_BAND_SCORE),
      deliveryReliabilityDelta:
        reliabilityNum !== undefined && prevReliabilityNum !== undefined ? Math.round((reliabilityNum - prevReliabilityNum) * 100) / 100 : undefined,
      deliveryReliabilityTrend: trendDirection(reliabilityNum, prevReliabilityNum, TREND_FLAT_BAND_SCORE),
    };
  });
}

// ---------------------------------------------------------------------
// D. 成約競争力の説明
// ---------------------------------------------------------------------

export interface CompetitivenessExplanationRow {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly askPrice: number;
  readonly basePrice: number;
  readonly priceDeviationRatio: number;
  readonly isPriceScoreAtCeiling: boolean;
  readonly isPriceScoreAtFloor: boolean;
  readonly qualityReputation?: number;
  readonly customerRelationship?: number;
  readonly deliveryReliability?: number;
  readonly coverageScore: number;
  readonly priceContribution: number;
  readonly coverageContribution: number;
  readonly relationshipContribution: number;
  readonly qualityContribution: number;
  readonly deliveryReliabilityContribution: number;
  readonly competitivenessWeight: number;
  readonly desiredQuantity: number;
  readonly allocatedQuantity: number;
  readonly previousCompetitivenessWeight?: number;
  readonly previousAllocatedQuantity?: number;
  readonly weightTrend: TrendDirection;
}

const TREND_FLAT_BAND_WEIGHT = 1e-4;

function findAllocationEntry(record: CompanyQuarterRecord, companyId: string, market: DemandMarketId, product: Product): CompanyAllocationEntry | undefined {
  const allocation = record.salesRecord.allocations.find((a) => a.market === market && a.product === product);
  return allocation?.companies.find((c) => c.companyId === companyId);
}

/** 当該会社が当期・当該市場×商品で販売計画を提出した(=成約競争に参加した)組合せ一覧を返す。 */
export function buildCompetitivenessExplanationRows(
  record: CompanyQuarterRecord,
  companyId: string,
  previousRecord?: CompanyQuarterRecord
): readonly CompetitivenessExplanationRow[] {
  const decision = record.decisions.find((d) => d.companyId === companyId);
  if (!decision) return [];

  const rows: CompetitivenessExplanationRow[] = [];
  for (const plan of decision.salesPlans) {
    const allocationEntry = findAllocationEntry(record, companyId, plan.market, plan.product);
    const allocation = record.salesRecord.allocations.find((a) => a.market === plan.market && a.product === plan.product);
    if (!allocationEntry || !allocation) continue;

    const b = allocationEntry.competitivenessBreakdown;
    const previousEntry = previousRecord ? findAllocationEntry(previousRecord, companyId, plan.market, plan.product) : undefined;

    rows.push({
      market: plan.market,
      product: plan.product,
      askPrice: unwrapUnit(allocationEntry.askPrice),
      basePrice: unwrapUnit(allocation.basePrice),
      priceDeviationRatio: (unwrapUnit(allocationEntry.askPrice) - unwrapUnit(allocation.basePrice)) / unwrapUnit(allocation.basePrice),
      isPriceScoreAtCeiling: b.isPriceScoreAtCeiling,
      isPriceScoreAtFloor: b.isPriceScoreAtFloor,
      qualityReputation: plan.qualityReputation !== undefined ? unwrapUnit(plan.qualityReputation) : undefined,
      customerRelationship: plan.customerRelationship !== undefined ? unwrapUnit(plan.customerRelationship) : undefined,
      deliveryReliability: plan.deliveryReliability !== undefined ? unwrapUnit(plan.deliveryReliability) : undefined,
      coverageScore: allocationEntry.coverageScore,
      priceContribution: b.priceContribution,
      coverageContribution: b.coverageContribution,
      relationshipContribution: b.relationshipContribution,
      qualityContribution: b.qualityContribution,
      deliveryReliabilityContribution: b.deliveryReliabilityContribution,
      competitivenessWeight: allocationEntry.competitivenessWeight,
      desiredQuantity: unwrapUnit(plan.desiredQuantity),
      allocatedQuantity: unwrapUnit(allocationEntry.allocatedQuantity),
      previousCompetitivenessWeight: previousEntry?.competitivenessWeight,
      previousAllocatedQuantity: previousEntry ? unwrapUnit(previousEntry.allocatedQuantity) : undefined,
      weightTrend: trendDirection(allocationEntry.competitivenessWeight, previousEntry?.competitivenessWeight, TREND_FLAT_BAND_WEIGHT),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------
// 5社比較
// ---------------------------------------------------------------------

export type ProductFilter = Product | "all";
export type MarketFilter = DemandMarketId | "all";

export interface CompanyComparisonRow {
  readonly companyId: string;
  readonly displayName: string;
  readonly totalProductionQuantity: number;
  readonly saleableProductionQuantity: number;
  readonly qualityScore?: number;
  readonly operationalRisk?: number;
  readonly discardQuantity: number;
  readonly onTimeDeliveryRate?: number;
  readonly customerTrustScore?: number;
  readonly deliveryReliabilityScore?: number;
  readonly majorIncidentCount: number;
  readonly newContractedQuantity: number;
}

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function buildCompanyComparisonRows(
  record: CompanyQuarterRecord,
  fixtures: readonly CompanyFixture[],
  productFilter: ProductFilter,
  marketFilter: MarketFilter
): readonly CompanyComparisonRow[] {
  return fixtures.map((f) => {
    const summary = findCompanySummary(record, f.companyId);
    const companyAdjustments = record.qualityAdjustments.filter((a) => a.companyId === f.companyId);
    const relevantAdjustments = productFilter === "all" ? companyAdjustments : companyAdjustments.filter((a) => a.product === productFilter);

    const totalProductionQuantity = relevantAdjustments.reduce((sum, a) => sum + unwrapUnit(a.originalFinishedGoodsQuantity), 0);
    const saleableProductionQuantity = relevantAdjustments.reduce((sum, a) => sum + unwrapUnit(a.adjustedFinishedGoodsQuantity), 0);
    const discardQuantity = relevantAdjustments.reduce((sum, a) => sum + unwrapUnit(a.discardQuantity), 0);
    const majorIncidentCount = relevantAdjustments.filter((a) => a.outcome.majorIncident.occurred).length;

    const qualityScore = summary
      ? average(
          (productFilter === "all" ? PRODUCTS : [productFilter])
            .map((p) => summary.qualityScoreByProduct[p])
            .filter((v): v is NonNullable<typeof v> => v !== undefined)
            .map((v) => unwrapUnit(v))
        )
      : undefined;
    const operationalRisk = summary
      ? average(
          (productFilter === "all" ? PRODUCTS : [productFilter])
            .map((p) => summary.operationalRiskByProduct[p])
            .filter((v): v is number => v !== undefined)
        )
      : undefined;

    const marketsToUse: readonly DemandMarketId[] = marketFilter === "all" ? DEMAND_MARKET_IDS : [marketFilter];
    const customerTrustScore = summary
      ? average(
          marketsToUse
            .map((m) => summary.customerTrustByMarket[m])
            .filter((v): v is NonNullable<typeof v> => v !== undefined)
            .map((v) => unwrapUnit(v))
        )
      : undefined;
    const deliveryReliabilityScore = summary
      ? average(
          marketsToUse
            .map((m) => summary.deliveryReliabilityByMarket[m])
            .filter((v): v is NonNullable<typeof v> => v !== undefined)
            .map((v) => unwrapUnit(v))
        )
      : undefined;

    return {
      companyId: f.companyId,
      displayName: f.displayName,
      totalProductionQuantity: Math.round(totalProductionQuantity * 100) / 100,
      saleableProductionQuantity: Math.round(saleableProductionQuantity * 100) / 100,
      qualityScore,
      operationalRisk,
      discardQuantity: Math.round(discardQuantity * 100) / 100,
      onTimeDeliveryRate: summary?.onTimeDeliveryRate,
      customerTrustScore,
      deliveryReliabilityScore,
      majorIncidentCount,
      newContractedQuantity: summary ? unwrapUnit(summary.newContractedQuantity) : 0,
    };
  });
}

// ---------------------------------------------------------------------
// 8/32ターン推移
// ---------------------------------------------------------------------

export interface TrendPoint {
  readonly turn: number;
  readonly period: PeriodV2;
  readonly value: number | undefined;
}

export interface TrendSeries {
  readonly key: string;
  readonly label: string;
  readonly points: readonly TrendPoint[];
}

function windowedHistory(history: readonly CompanyQuarterRecord[], turnsWindow: number): readonly CompanyQuarterRecord[] {
  if (history.length <= turnsWindow) return history;
  return history.slice(history.length - turnsWindow);
}

export interface TrendGroup {
  readonly groupLabel: string;
  readonly unit: "score" | "ratio" | "tons" | "count";
  readonly series: readonly TrendSeries[];
}

const PRODUCT_LABELS: Readonly<Record<Product, string>> = { hoso: "HOSO", pd: "PD", vap: "VAP" };

export function buildTrendGroups(
  history: readonly CompanyQuarterRecord[],
  companyId: string,
  turnsWindow: number,
  markets: readonly DemandMarketId[]
): readonly TrendGroup[] {
  const windowed = windowedHistory(history, turnsWindow);

  const qualityScoreSeries: TrendSeries[] = PRODUCTS.map((product) => ({
    key: `quality-${product}`,
    label: `${PRODUCT_LABELS[product]} 品質スコア`,
    points: windowed.map((r) => {
      const summary = findCompanySummary(r, companyId);
      const v = summary?.qualityScoreByProduct[product];
      return { turn: r.turn, period: r.period, value: v !== undefined ? unwrapUnit(v) : undefined };
    }),
  }));

  const riskSeries: TrendSeries[] = PRODUCTS.map((product) => ({
    key: `risk-${product}`,
    label: `${PRODUCT_LABELS[product]} 操業リスク`,
    points: windowed.map((r) => {
      const summary = findCompanySummary(r, companyId);
      return { turn: r.turn, period: r.period, value: summary?.operationalRiskByProduct[product] };
    }),
  }));

  const summaryByTurn = new Map(windowed.map((r) => [r.turn, findCompanySummary(r, companyId)]));

  const quantityLossSeries: TrendSeries[] = [
    {
      key: "downgrade",
      label: "格落ち量",
      points: windowed.map((r) => ({ turn: r.turn, period: r.period, value: unwrapOrUndefined(summaryByTurn.get(r.turn)?.downgradeQuantity) })),
    },
    {
      key: "rework",
      label: "再加工量",
      points: windowed.map((r) => ({ turn: r.turn, period: r.period, value: unwrapOrUndefined(summaryByTurn.get(r.turn)?.reworkQuantity) })),
    },
    {
      key: "discard",
      label: "廃棄量",
      points: windowed.map((r) => ({ turn: r.turn, period: r.period, value: unwrapOrUndefined(summaryByTurn.get(r.turn)?.discardQuantity) })),
    },
  ];

  const deliverySeries: TrendSeries[] = [
    {
      key: "onTimeDeliveryRate",
      label: "納期遵守率",
      points: windowed.map((r) => ({ turn: r.turn, period: r.period, value: summaryByTurn.get(r.turn)?.onTimeDeliveryRate })),
    },
  ];

  const trustSeries: TrendSeries[] = [
    {
      key: "customerTrustAverage",
      label: "顧客信頼（市場平均）",
      points: windowed.map((r) => {
        const summary = findCompanySummary(r, companyId);
        const values = markets.map((m) => summary?.customerTrustByMarket[m]).filter((v): v is NonNullable<typeof v> => v !== undefined).map((v) => unwrapUnit(v));
        return { turn: r.turn, period: r.period, value: average(values) };
      }),
    },
    {
      key: "deliveryReliabilityAverage",
      label: "納期信頼性（市場平均）",
      points: windowed.map((r) => {
        const summary = findCompanySummary(r, companyId);
        const values = markets
          .map((m) => summary?.deliveryReliabilityByMarket[m])
          .filter((v): v is NonNullable<typeof v> => v !== undefined)
          .map((v) => unwrapUnit(v));
        return { turn: r.turn, period: r.period, value: average(values) };
      }),
    },
  ];

  const contractedSeries: TrendSeries[] = [
    {
      key: "newContractedQuantity",
      label: "成約量",
      points: windowed.map((r) => {
        const summary = findCompanySummary(r, companyId);
        return { turn: r.turn, period: r.period, value: summary ? unwrapUnit(summary.newContractedQuantity) : undefined };
      }),
    },
  ];

  return [
    { groupLabel: "商品別品質スコア", unit: "score", series: qualityScoreSeries },
    { groupLabel: "商品別操業リスク", unit: "ratio", series: riskSeries },
    { groupLabel: "数量損失（格落ち・再加工・廃棄）", unit: "tons", series: quantityLossSeries },
    { groupLabel: "納期遵守率", unit: "ratio", series: deliverySeries },
    { groupLabel: "顧客信頼・納期信頼性", unit: "score", series: trustSeries },
    { groupLabel: "成約量", unit: "tons", series: contractedSeries },
  ];
}
