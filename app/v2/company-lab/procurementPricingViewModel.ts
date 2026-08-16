// ShrimpX V2 — Procurement Planning: 調達価格の表示（国内・輸入・養殖）
//
// 【この層がやること】既存のpure function・パラメータをそのまま呼び出し、
// UIが表示しやすい形へ並べ替えるだけ。新しい価格計算式・UI独自の定数は
// 一切作らない。
//
// 【国内 Implied Offer Price】
//   bidPrice = marketPrice + priceAdjustment（sales/allocation.ts の askPrice導出と
//   対称の式。rawMaterials/domesticPurchase.ts 内でインラインに計算されている
//   1行の加算をそのままここでも行うだけで、価格モデル自体を複製するものではない）。
//   有効なbidPriceの範囲（Valid Bid Range）は
//   rawMaterials/domesticPurchase.ts の assertValidBidPrice が検証する
//   [marketPrice × minBidPriceRatioOfMarket, marketPrice × maxBidPriceRatioOfMarket]
//   をそのまま読み出す（パラメータの複製であって、検証ロジックの複製ではない）。
//
// 【輸入 Landed Cost】rawMaterials/imports.ts の calculateLandedPrice をそのまま呼ぶ。
// 【養殖単価】rawMaterials/parameters.ts の aquacultureUnitCostUsdPerHosoEqKg をそのまま読む。

import { UsdPerHosoEqKg, unwrapUnit } from "../../lib/v2/core/units";
import { CountryId } from "../../lib/v2/market/types";
import { calculateLandedPrice } from "../../lib/v2/rawMaterials/imports";
import { ImportLandedPriceBreakdown, RawMaterialLot } from "../../lib/v2/rawMaterials/types";
import { RAW_MATERIALS_PARAMETERS_V1, RawMaterialsParameters } from "../../lib/v2/rawMaterials/parameters";

// ---------------------------------------------------------------------
// 国内調達
// ---------------------------------------------------------------------

export interface DomesticPricingViewModel {
  /** 参考価格（前四半期の国内原料清算価格、またはturn1参考価格）。呼び出し側から渡される。 */
  readonly referencePriceUsdPerHosoEqKg: number;
  /** 提示価格の調整額（draft入力。値引きは負）。 */
  readonly priceAdjustmentUsdPerHosoEqKg: number;
  /** Implied Offer Price = referencePrice + priceAdjustment（bidPriceの導出式そのもの）。 */
  readonly impliedOfferPriceUsdPerHosoEqKg: number;
  /** 有効なbidPriceの範囲（この範囲外だとassertValidBidPriceがエラーにする）。 */
  readonly validBidRange: {
    readonly minUsdPerHosoEqKg: number;
    readonly maxUsdPerHosoEqKg: number;
  };
  /** impliedOfferPriceが有効範囲内かどうか（提出前チェック用の参考値。実際の検証はエンジン側）。 */
  readonly isWithinValidBidRange: boolean;
}

/**
 * 国内調達の価格3段（Reference / Adjustment / Implied Offer）とValid Bid Rangeを組み立てる。
 * referencePriceUsdPerHosoEqKg は呼び出し側が用意する（turn1は
 * companyLab/domesticReferencePrice.ts の computeDomesticReferencePrice、turn2以降は
 * publicInfo.vietnamDomesticPriorPrice。本関数はどちらから来た値かを区別しない）。
 */
export function buildDomesticPricingViewModel(
  referencePriceUsdPerHosoEqKg: number,
  priceAdjustmentUsdPerHosoEqKg: number,
  params: RawMaterialsParameters = RAW_MATERIALS_PARAMETERS_V1
): DomesticPricingViewModel {
  const dp = params.domesticPurchase;
  const impliedOfferPriceUsdPerHosoEqKg = referencePriceUsdPerHosoEqKg + priceAdjustmentUsdPerHosoEqKg;
  const minUsdPerHosoEqKg = referencePriceUsdPerHosoEqKg * dp.minBidPriceRatioOfMarket;
  const maxUsdPerHosoEqKg = referencePriceUsdPerHosoEqKg * dp.maxBidPriceRatioOfMarket;
  return {
    referencePriceUsdPerHosoEqKg,
    priceAdjustmentUsdPerHosoEqKg,
    impliedOfferPriceUsdPerHosoEqKg,
    validBidRange: { minUsdPerHosoEqKg, maxUsdPerHosoEqKg },
    isWithinValidBidRange: impliedOfferPriceUsdPerHosoEqKg >= minUsdPerHosoEqKg && impliedOfferPriceUsdPerHosoEqKg <= maxUsdPerHosoEqKg,
  };
}

// ---------------------------------------------------------------------
// 輸入
// ---------------------------------------------------------------------

export interface ImportPricingRow {
  readonly originCountry: CountryId;
  readonly breakdown: ImportLandedPriceBreakdown;
}

/**
 * 原産国別の輸入着地価格内訳（origin FOB / duty / freight / insurance / country
 * adjustment / landed cost）を、既存の calculateLandedPrice をそのまま呼んで並べる。
 */
export function buildImportPricingRows(
  originCountries: readonly CountryId[],
  originHosoFobPrice: Readonly<Record<CountryId, UsdPerHosoEqKg>>,
  params: RawMaterialsParameters = RAW_MATERIALS_PARAMETERS_V1
): readonly ImportPricingRow[] {
  return originCountries.map((originCountry) => ({
    originCountry,
    breakdown: calculateLandedPrice(originHosoFobPrice[originCountry], originCountry, params),
  }));
}

// ---------------------------------------------------------------------
// 養殖
// ---------------------------------------------------------------------

export interface AquaculturePricingViewModel {
  /** 養殖原料の単位取得原価（固定パラメータ。市場価格に連動しない）。 */
  readonly unitCostUsdPerHosoEqKg: number;
}

export function buildAquaculturePricingViewModel(params: RawMaterialsParameters = RAW_MATERIALS_PARAMETERS_V1): AquaculturePricingViewModel {
  return { unitCostUsdPerHosoEqKg: params.aquaculture.aquacultureUnitCostUsdPerHosoEqKg };
}

// ---------------------------------------------------------------------
// 加重平均原料単価・source mix（既存ロットの簿価集計。新しい価格式は使わない）
// ---------------------------------------------------------------------

export interface RawMaterialCostSummaryLotLike {
  readonly source: "domestic" | "import" | "aquaculture";
  readonly remainingQuantity: number;
  readonly unitCost: number;
}

export interface RawMaterialCostBySourceEntry {
  readonly source: "domestic" | "import" | "aquaculture";
  readonly quantityTons: number;
  /** この source の数量シェア（0〜1）。合計数量が0のときは0。 */
  readonly shareOfTotal: number;
  /** この source の数量加重平均単価。この source の数量が0のときは undefined（0除算を捏造しない）。 */
  readonly weightedAverageUnitCostUsdPerHosoEqKg: number | undefined;
}

export interface RawMaterialCostSummary {
  readonly bySource: readonly RawMaterialCostBySourceEntry[];
  readonly totalQuantityTons: number;
  /** 全ロット数量加重平均単価。総数量が0のときは undefined。 */
  readonly overallWeightedAverageUnitCostUsdPerHosoEqKg: number | undefined;
}

const SOURCES: readonly RawMaterialCostSummaryLotLike["source"][] = ["domestic", "import", "aquaculture"];

/**
 * 既存ロット（status="available"のみ。手持ち在庫の実際の簿価を見るため）の
 * source別・全体の数量加重平均単価と構成比を求める。新しい価格計算式ではなく、
 * ロットが既に持つ unitCost（取得原価）を remainingQuantity で加重平均するだけ。
 */
export function buildRawMaterialCostSummary(lots: readonly RawMaterialCostSummaryLotLike[]): RawMaterialCostSummary {
  const totals = new Map<RawMaterialCostSummaryLotLike["source"], { quantityTons: number; costWeightedSum: number }>();
  for (const s of SOURCES) totals.set(s, { quantityTons: 0, costWeightedSum: 0 });

  let totalQuantityTons = 0;
  let totalCostWeightedSum = 0;
  for (const lot of lots) {
    const quantity = Number.isFinite(lot.remainingQuantity) && lot.remainingQuantity > 0 ? lot.remainingQuantity : 0;
    if (quantity <= 0) continue;
    const cost = Number.isFinite(lot.unitCost) ? lot.unitCost : 0;
    const bucket = totals.get(lot.source)!;
    bucket.quantityTons += quantity;
    bucket.costWeightedSum += quantity * cost;
    totalQuantityTons += quantity;
    totalCostWeightedSum += quantity * cost;
  }

  const bySource: RawMaterialCostBySourceEntry[] = SOURCES.map((source) => {
    const bucket = totals.get(source)!;
    return {
      source,
      quantityTons: bucket.quantityTons,
      shareOfTotal: totalQuantityTons > 0 ? bucket.quantityTons / totalQuantityTons : 0,
      weightedAverageUnitCostUsdPerHosoEqKg: bucket.quantityTons > 0 ? bucket.costWeightedSum / bucket.quantityTons : undefined,
    };
  });

  return {
    bySource,
    totalQuantityTons,
    overallWeightedAverageUnitCostUsdPerHosoEqKg: totalQuantityTons > 0 ? totalCostWeightedSum / totalQuantityTons : undefined,
  };
}

/**
 * RawMaterialLot（ブランド型フィールド）から RawMaterialCostSummaryLotLike へ変換する薄いヘルパー。
 * status="available"（手持ち在庫の実際の簿価）以外は null を返す（呼び出し側でフィルタする）。
 */
export function toCostSummaryLotLike(lot: RawMaterialLot): RawMaterialCostSummaryLotLike | null {
  if (lot.status !== "available") return null;
  return {
    source: lot.source,
    remainingQuantity: unwrapUnit(lot.remainingQuantity),
    unitCost: unwrapUnit(lot.unitCost),
  };
}
