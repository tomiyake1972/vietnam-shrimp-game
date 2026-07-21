// ShrimpX V2 — 商品×仕向市場の参照価格差別化（Phase 8P-0A）
//
// 【背景・目的】既存モデルでは、同じ商品（HOSO/PD/VAP）であれば仕向市場
// （CN/US/EU/JP/OTHER）による基準価格差がなく、販売数量（対象需要の按分）だけが
// 市場別に変化していた（sales/marketAdapter.ts の deriveVietnamBasePrices・
// deriveTargetDemand を参照）。本モジュールは、既存の原産国競争由来の商品基準価格
// （Phase1 calculateMarketQuarter の出力）を書き換えることなく、その「上に」
// 仕向市場ごとの評価差（主に加工プレミアムの評価差）を追加する。
//
// 【原産国と仕向市場の違い（実装指示 §16）】
// 本モジュールが読む CountryId（EC/IN/ID/VN）は「どこで獲れたエビか」（供給側）、
// DemandMarketId（CN/US/EU/JP/OTHER）は「どこに売るか」（需要側）であり、
// 別の軸である。5社は全員ベトナム拠点の輸出会社という前提（sales/marketAdapter.ts
// と同じゲーム設定）のため、本モジュールは常に byCountry.VN の価格を分解の起点とする。
// 国際HOSO価格の需給形成（market/hosoPricing.ts）・PD/VAPプレミアムの世界稼働率
// 連動（market/productPremium.ts）は一切変更・再実装しない。
//
// 【価格分解（実装指示 §6）】
//   PD基準価格  = HOSO基準価格 + PD加工プレミアム
//   VAP基準価格 = HOSO基準価格 + PD加工プレミアム + VAP追加プレミアム
// の関係を使い、既存の商品別基準価格（すべてVN起点、HOSO換算kgあたりUSD）から
//   pdProcessingPremium  = existingPdPrice  - existingHosoPrice
//   vapIncrementalPremium = existingVapPrice - existingPdPrice
// として逆算する。既存モデルは pdPremium.byCountry.VN.finalPrice =
// hosoPrice + max(basePremiumValue + qualityAdjustmentValue, minPremiumUsdPerKg)
// （productPremium.ts）という加算構造のため、この分解は常に非負の
// pdProcessingPremium を生む。vapIncrementalPremium も同様に非負であることを
// 5シナリオ×32ターンで検証済み（vapBasePremiumRatio(0.55) > pdBasePremiumRatio(0.18)
// が常に成り立つ設計のため。docs/v2/DESTINATION_MARKET_PRICING_v0.1.md 参照）。
// 万一の逆転（浮動小数点誤差・将来のパラメータ変更）に備え、Math.max(0, ...)で
// 黙って値を切り上げるのではなく、assertNonNegativePremium が発生回数を数えられる
// よう診断フラグを結果へ含める。
//
// 【仕向市場別参照価格の式（実装指示 §7）】
//   HOSO市場参照価格 = HOSO基礎価値部分
//   PD市場参照価格   = HOSO基礎価値部分 + PDプレミアム部分
//   VAP市場参照価格  = HOSO基礎価値部分 + PDプレミアム部分 + VAPプレミアム部分
// ここで
//   HOSO基礎価値部分 = hosoBasePrice × baseValueCoefficient（HOSO/PD/VAP共通）
//   PDプレミアム部分 = pdProcessingPremium × pdPremiumCoefficient（PD・VAPに含まれる。HOSOには含まれない）
//   VAPプレミアム部分 = vapIncrementalPremium × vapPremiumCoefficient（VAPのみ）
// 係数は各部分にのみ適用し、価格全体への単純乗算は行わない（VAP市場係数が
// HOSO基礎価値やPDプレミアムへ波及することはない。実装指示 §7重要事項）。
//
// 【HOSO換算単位（実装指示 §17項目）】
// 本モジュールが扱う価格は常にUSD/HOSO換算kg。production/yieldConversion.ts の
// physicalYieldRatio（PD ≈ 54%等、物理重量換算専用の参照値）はここでは一切
// 参照・乗算しない（数量・価格ともにHOSO換算基準を維持する）。

import { UsdPerHosoEqKg, unwrapUnit, usdPerHosoEqKg } from "../core/units";
import { DemandMarketId, MarketQuarterResult, MarketValidationError, Product } from "./types";
import { DestinationMarketPriceCoefficientTable, DestinationMarketPriceCoefficients } from "./destinationPricingParameters";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** 商品別基準価格（VN起点）を、HOSO基礎価値・PD加工プレミアム・VAP追加プレミアムへ分解した結果。 */
export interface ProductPriceDecomposition {
  readonly hosoBasePrice: UsdPerHosoEqKg;
  readonly pdProcessingPremium: UsdPerHosoEqKg;
  readonly vapIncrementalPremium: UsdPerHosoEqKg;
  /** 分解前のPD基準価格がHOSO基準価格を下回っていたため、非負化のためmax(0,...)を適用したか。 */
  readonly pdPremiumWasClampedToZero: boolean;
  /** 分解前のVAP基準価格がPD基準価格を下回っていたため、非負化のためmax(0,...)を適用したか。 */
  readonly vapPremiumWasClampedToZero: boolean;
}

/**
 * VN起点の商品別基準価格（既存のPhase1/Phase4計算そのまま。市場非依存）を
 * HOSO基礎価値・PD加工プレミアム・VAP追加プレミアムへ分解する。市場結果
 * （calculateMarketQuarterの出力）を一切変更しない純粋関数。
 */
export function decomposeVietnamProductPrices(marketResult: MarketQuarterResult): ProductPriceDecomposition {
  const hosoPrice = unwrapUnit(marketResult.hosoPrices.VN.price);
  const pdPrice = unwrapUnit(marketResult.pdPremium.byCountry.VN.finalPrice);
  const vapPrice = unwrapUnit(marketResult.vapPremium.byCountry.VN.finalPrice);

  for (const [label, value] of [
    ["HOSO基準価格", hosoPrice],
    ["PD基準価格", pdPrice],
    ["VAP基準価格", vapPrice],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new MarketValidationError(`価格分解の入力 ${label} が有限数ではありません。受け取った値: ${value}`);
    }
  }

  const rawPdPremium = pdPrice - hosoPrice;
  const rawVapPremium = vapPrice - pdPrice;

  return {
    hosoBasePrice: usdPerHosoEqKg(hosoPrice),
    pdProcessingPremium: usdPerHosoEqKg(Math.max(0, rawPdPremium)),
    vapIncrementalPremium: usdPerHosoEqKg(Math.max(0, rawVapPremium)),
    pdPremiumWasClampedToZero: rawPdPremium < 0,
    vapPremiumWasClampedToZero: rawVapPremium < 0,
  };
}

/** 1商品×1市場ぶんの参照価格の内訳（説明可能性のための診断構造。実装指示 §8）。 */
export interface ProductMarketReferencePriceBreakdown {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly hosoBasePrice: UsdPerHosoEqKg;
  readonly pdProcessingPremium: UsdPerHosoEqKg;
  readonly vapIncrementalPremium: UsdPerHosoEqKg;
  readonly baseValueCoefficient: number;
  readonly pdPremiumCoefficient: number;
  readonly vapPremiumCoefficient: number;
  /** HOSO基礎価値部分 = hosoBasePrice × baseValueCoefficient（全商品共通）。 */
  readonly hosoBaseValuePart: UsdPerHosoEqKg;
  /** PDプレミアム部分 = pdProcessingPremium × pdPremiumCoefficient（hosoでは常に0）。 */
  readonly pdPremiumPart: UsdPerHosoEqKg;
  /** VAPプレミアム部分 = vapIncrementalPremium × vapPremiumCoefficient（vap以外は常に0）。 */
  readonly vapPremiumPart: UsdPerHosoEqKg;
  /** 最終市場参照価格 = hosoBaseValuePart + pdPremiumPart + vapPremiumPart。 */
  readonly marketReferencePrice: UsdPerHosoEqKg;
}

function assertValidCoefficients(c: DestinationMarketPriceCoefficients, market: DemandMarketId): void {
  for (const [name, value] of Object.entries(c)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new MarketValidationError(`市場 "${market}" の係数 "${name}" が不正です（0より大きい有限数である必要があります）。受け取った値: ${value}`);
    }
  }
}

/**
 * 1商品×1市場ぶんの参照価格を、分解済みの基準価格＋市場係数から計算する
 * （実装指示 §7の式そのもの）。係数は各部分（HOSO基礎価値／PDプレミアム／
 * VAPプレミアム）にのみ適用し、価格全体への乗算は行わない。
 */
export function computeMarketReferencePrice(
  decomposition: ProductPriceDecomposition,
  market: DemandMarketId,
  product: Product,
  coefficients: DestinationMarketPriceCoefficientTable
): ProductMarketReferencePriceBreakdown {
  const c = coefficients[market];
  assertValidCoefficients(c, market);

  const hosoBaseValuePart = unwrapUnit(decomposition.hosoBasePrice) * c.baseValueCoefficient;
  const pdPremiumPart = product === "hoso" ? 0 : unwrapUnit(decomposition.pdProcessingPremium) * c.pdPremiumCoefficient;
  const vapPremiumPart = product === "vap" ? unwrapUnit(decomposition.vapIncrementalPremium) * c.vapPremiumCoefficient : 0;
  const marketReferencePriceRaw = hosoBaseValuePart + pdPremiumPart + vapPremiumPart;

  if (!Number.isFinite(marketReferencePriceRaw) || marketReferencePriceRaw <= 0) {
    throw new MarketValidationError(
      `市場 "${market}" 商品 "${product}" の参照価格が不正です（0より大きい有限数である必要があります）。算出値: ${marketReferencePriceRaw}`
    );
  }

  return {
    market,
    product,
    hosoBasePrice: decomposition.hosoBasePrice,
    pdProcessingPremium: decomposition.pdProcessingPremium,
    vapIncrementalPremium: decomposition.vapIncrementalPremium,
    baseValueCoefficient: c.baseValueCoefficient,
    pdPremiumCoefficient: c.pdPremiumCoefficient,
    vapPremiumCoefficient: c.vapPremiumCoefficient,
    hosoBaseValuePart: usdPerHosoEqKg(hosoBaseValuePart),
    pdPremiumPart: usdPerHosoEqKg(pdPremiumPart),
    vapPremiumPart: usdPerHosoEqKg(vapPremiumPart),
    marketReferencePrice: usdPerHosoEqKg(marketReferencePriceRaw),
  };
}

const DEMAND_MARKET_IDS_LOCAL: readonly DemandMarketId[] = ["CN", "US", "EU", "JP", "OTHER"];

/**
 * 5市場×3商品ぶんの参照価格の内訳を一括計算する（会社ラボ・CLI診断出力向け）。
 */
export function deriveMarketReferencePriceBreakdowns(
  marketResult: MarketQuarterResult,
  coefficients: DestinationMarketPriceCoefficientTable
): Readonly<Record<DemandMarketId, Readonly<Record<Product, ProductMarketReferencePriceBreakdown>>>> {
  const decomposition = decomposeVietnamProductPrices(marketResult);
  const result = {} as Record<DemandMarketId, Record<Product, ProductMarketReferencePriceBreakdown>>;
  for (const market of DEMAND_MARKET_IDS_LOCAL) {
    const perProduct = {} as Record<Product, ProductMarketReferencePriceBreakdown>;
    for (const product of PRODUCTS) {
      perProduct[product] = computeMarketReferencePrice(decomposition, market, product, coefficients);
    }
    result[market] = perProduct;
  }
  return result;
}

/**
 * 5市場×3商品ぶんの参照価格（UsdPerHosoEqKgのみ、内訳なし）を一括計算する。
 * sales/marketAdapter.ts の deriveVietnamMarketReferencePrices が、成約配分
 * （allocateMarketProduct）へ渡す basePrice としてこの結果をそのまま使う。
 */
export function deriveMarketReferencePrices(
  marketResult: MarketQuarterResult,
  coefficients: DestinationMarketPriceCoefficientTable
): Readonly<Record<DemandMarketId, Readonly<Record<Product, UsdPerHosoEqKg>>>> {
  const breakdowns = deriveMarketReferencePriceBreakdowns(marketResult, coefficients);
  const result = {} as Record<DemandMarketId, Record<Product, UsdPerHosoEqKg>>;
  for (const market of DEMAND_MARKET_IDS_LOCAL) {
    result[market] = {
      hoso: breakdowns[market].hoso.marketReferencePrice,
      pd: breakdowns[market].pd.marketReferencePrice,
      vap: breakdowns[market].vap.marketReferencePrice,
    };
  }
  return result;
}
