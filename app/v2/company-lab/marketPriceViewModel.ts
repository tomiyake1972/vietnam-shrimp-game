// ShrimpX V2 — 市場情報パネル（Phase 8C-3D） 価格一覧・前四半期比の表示用データ層
//
// 【目的】ゲーム画面の「市場情報（全社共通・公開）」を、値がバラバラのボックス群から
// 「仕向市場（消費国）×商品」「産地国×商品」の一覧表へ整理し、あわせて各価格に
// 前四半期比を添える（改善要望 ①一覧化・②前四半期比）。
//
// 【禁止事項（本プロジェクトの既存規約をそのまま踏襲）】
// このファイルは新しい価格形成ロジックを一切実装しない。行ってよいのは、
//   (a) 確定履歴に保存済みの値の読み取り、
//   (b) 既存エンジン関数 market/destinationPricing.ts の deriveMarketReferencePrices
//       （Phase 8P-0A。「会社ラボ・CLI診断出力向け」と明記されている公開API）の呼び出し、
//   (c) (price - priorPrice) / priorPrice という前期比の除算、
// だけである。国際HOSO価格の需給形成（market/hosoPricing.ts）・PD/VAPプレミアムの
// 世界稼働率連動（market/productPremium.ts）・仕向市場係数（destinationPricingParameters.ts）
// のいずれも再実装・変更しない。
//
// 【産地国と仕向市場は別の軸】
// CountryId（EC/IN/ID/VN）は「どこで獲れたエビか」（供給側・産地）、
// DemandMarketId（CN/US/EU/JP/OTHER）は「どこに売るか」（需要側・消費国）であり、
// 従来この画面に出ていた「HOSO FOB（EC）」等は前者、改善要望①の「各消費国」は
// 後者を指す。両方を別の表として並べ、混同しないよう見出しで明示する。
//
// 【前四半期比のデータ源（推測値を作らないための三段階）】
//   1. previousQuarter … 前四半期の確定 marketResult がある場合。最も正確で、
//      HOSO・PD・VAP・仕向市場別・国内原料価格のすべてに使える。
//   2. storedPriorPrice … 前四半期の確定 marketResult が無い（初回四半期）場合の、
//      HOSO限定の代替。CountryHosoPriceResult.priorPrice / changeRatio は当期の
//      確定結果そのものに保存されている値であり、推測ではない。
//      仕向市場別のHOSO参照価格については、destinationPricing.ts §7 の式より
//      「HOSO市場参照価格 = hosoBasePrice × baseValueCoefficient」であり、
//      baseValueCoefficient は四半期によらない固定パラメータなので、
//      前期のHOSO市場参照価格は「保存済み priorPrice × 同じ係数」に一致する
//      （新しい価格ロジックではなく、既存の同じ式を保存済み前期価格へ適用するだけ）。
//   3. unavailable … 上のいずれも使えない場合（初回四半期のPD/VAP・国内原料価格）。
//      changeRatio を null のままにし、画面では0で埋めずに「-」と表示する。

import { UsdPerHosoEqKg, unwrapUnit } from "../../lib/v2/core/units";
import { COUNTRY_IDS, CountryId, DEMAND_MARKET_IDS, DemandMarketId, MarketQuarterResult, Product } from "../../lib/v2/market/types";
import { decomposeVietnamProductPrices, deriveMarketReferencePrices } from "../../lib/v2/market/destinationPricing";
import {
  CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS,
  DestinationMarketPriceCoefficientTable,
} from "../../lib/v2/market/destinationPricingParameters";

/** 前四半期比の値がどこから来たか（画面の注記と、テストでの検証のために明示的に持つ）。 */
export type QuarterOverQuarterSource = "previousQuarter" | "storedPriorPrice" | "unavailable";

/** 1つの価格セル。前期比が取れない場合、priorPrice・changeRatioは0で埋めずnullにする。 */
export interface PriceWithQoq {
  /** 当期の価格（USD/HOSO換算kg）。確定履歴の値、または既存エンジン関数の出力そのまま。 */
  readonly price: number;
  readonly priorPrice: number | null;
  /** (price - priorPrice) / priorPrice。前期価格が無い、または0近傍の場合はnull。 */
  readonly changeRatio: number | null;
  readonly source: QuarterOverQuarterSource;
}

/** 1仕向市場（消費国）ぶんの商品別参照価格。 */
export interface DestinationMarketPriceRow {
  readonly market: DemandMarketId;
  readonly hoso: PriceWithQoq;
  readonly pd: PriceWithQoq;
  readonly vap: PriceWithQoq;
}

/** 1産地国ぶんの商品別FOB価格。 */
export interface OriginCountryPriceRow {
  readonly country: CountryId;
  readonly hoso: PriceWithQoq;
  readonly pd: PriceWithQoq;
  readonly vap: PriceWithQoq;
}

/** 価格以外の基礎指標（1行1項目）。 */
export interface MarketIndicatorRow {
  readonly key: string;
  readonly label: string;
  /** "price" は USD/HOSO換算kg、"ratio" は比率（前期比ではなく前期差ptで見る）。 */
  readonly kind: "price" | "ratio";
  readonly value: number;
  readonly priorValue: number | null;
  /** kind==="price" のときの前期比。kind==="ratio" では常にnull（比率の比は意味を持たない）。 */
  readonly changeRatio: number | null;
  /** kind==="ratio" のときの前期差（当期 - 前期）。kind==="price" では常にnull。 */
  readonly difference: number | null;
  readonly source: QuarterOverQuarterSource;
}

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** 前期価格が0近傍のときに ±Infinity / NaN を画面へ出さないための下限。 */
const PRIOR_PRICE_EPSILON = 1e-9;

function safeChangeRatio(price: number, priorPrice: number | null): number | null {
  if (priorPrice === null) return null;
  if (!Number.isFinite(price) || !Number.isFinite(priorPrice)) return null;
  if (Math.abs(priorPrice) < PRIOR_PRICE_EPSILON) return null;
  return (price - priorPrice) / priorPrice;
}

function priceWithQoq(price: number, priorPrice: number | null, source: QuarterOverQuarterSource): PriceWithQoq {
  if (priorPrice === null || !Number.isFinite(priorPrice)) return unavailable(price);
  return { price, priorPrice, changeRatio: safeChangeRatio(price, priorPrice), source };
}

function unavailable(price: number): PriceWithQoq {
  return { price, priorPrice: null, changeRatio: null, source: "unavailable" };
}

// ---------------------------------------------------------------------
// A. 仕向市場（消費国）×商品 の参照価格一覧（改善要望①）
// ---------------------------------------------------------------------

/**
 * 5仕向市場×3商品の参照価格を、前四半期比つきで返す。
 * 当期・前期いずれの価格も deriveMarketReferencePrices（既存エンジン関数）へ
 * marketResult をそのまま渡して得るだけで、ここで価格を組み立てることはしない。
 */
export function buildDestinationMarketPriceRows(
  marketResult: MarketQuarterResult,
  previousMarketResult: MarketQuarterResult | null,
  coefficients: DestinationMarketPriceCoefficientTable = CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
): readonly DestinationMarketPriceRow[] {
  const current = deriveMarketReferencePrices(marketResult, coefficients);
  const previous = previousMarketResult !== null ? deriveMarketReferencePrices(previousMarketResult, coefficients) : null;

  // 【初回四半期のHOSO限定の代替源】前期の確定marketResultが無い場合だけ使う。
  // destinationPricing.ts §7 より HOSO市場参照価格 = hosoBasePrice × baseValueCoefficient
  // であり、hosoBasePrice の前期値（priorPrice）は当期の確定結果に保存されている。
  const storedPriorVietnamHoso = previous === null ? unwrapUnit(marketResult.hosoPrices.VN.priorPrice) : null;

  return DEMAND_MARKET_IDS.map((market) => {
    const cell = (product: Product): PriceWithQoq => {
      const price = unwrapUnit(current[market][product]);
      if (previous !== null) {
        return priceWithQoq(price, unwrapUnit(previous[market][product]), "previousQuarter");
      }
      if (product === "hoso" && storedPriorVietnamHoso !== null && Number.isFinite(storedPriorVietnamHoso)) {
        return priceWithQoq(price, storedPriorVietnamHoso * coefficients[market].baseValueCoefficient, "storedPriorPrice");
      }
      return unavailable(price);
    };
    return { market, hoso: cell("hoso"), pd: cell("pd"), vap: cell("vap") };
  });
}

// ---------------------------------------------------------------------
// B. 産地国×商品 のFOB価格一覧（従来の「HOSO FOB（EC）」等の一覧化）
// ---------------------------------------------------------------------

function originProductPrice(marketResult: MarketQuarterResult, country: CountryId, product: Product): UsdPerHosoEqKg {
  if (product === "hoso") return marketResult.hosoPrices[country].price;
  if (product === "pd") return marketResult.pdPremium.byCountry[country].finalPrice;
  return marketResult.vapPremium.byCountry[country].finalPrice;
}

/**
 * 4産地国×3商品のFOB価格を、前四半期比つきで返す。すべて確定結果に保存済みの値の
 * 読み取りのみ（HOSOは price / priorPrice / changeRatio、PD・VAPは byCountry の finalPrice）。
 */
export function buildOriginCountryPriceRows(
  marketResult: MarketQuarterResult,
  previousMarketResult: MarketQuarterResult | null
): readonly OriginCountryPriceRow[] {
  return COUNTRY_IDS.map((country) => {
    const cell = (product: Product): PriceWithQoq => {
      const price = unwrapUnit(originProductPrice(marketResult, country, product));
      if (previousMarketResult !== null) {
        return priceWithQoq(price, unwrapUnit(originProductPrice(previousMarketResult, country, product)), "previousQuarter");
      }
      if (product === "hoso") {
        // 当期の確定結果に保存されている前期価格をそのまま使う（推測ではない）。
        return priceWithQoq(price, unwrapUnit(marketResult.hosoPrices[country].priorPrice), "storedPriorPrice");
      }
      return unavailable(price);
    };
    return { country, hoso: cell("hoso"), pd: cell("pd"), vap: cell("vap") };
  });
}

// ---------------------------------------------------------------------
// C. 基礎指標（国内原料価格・世界基準プレミアム・世界需給）
// ---------------------------------------------------------------------

function indicator(
  key: string,
  label: string,
  kind: MarketIndicatorRow["kind"],
  value: number,
  priorValue: number | null
): MarketIndicatorRow {
  if (priorValue === null || !Number.isFinite(priorValue)) {
    return { key, label, kind, value, priorValue: null, changeRatio: null, difference: null, source: "unavailable" };
  }
  return {
    key,
    label,
    kind,
    value,
    priorValue,
    changeRatio: kind === "price" ? safeChangeRatio(value, priorValue) : null,
    difference: kind === "ratio" ? value - priorValue : null,
    source: "previousQuarter",
  };
}

/**
 * 価格以外の公開指標を一覧で返す。国内原料価格・PD/VAPの世界基準プレミアム・
 * 世界需給バランスはいずれも確定結果からの読み取りのみ。前期の確定marketResultが
 * 無い場合は前期欄・前期比欄をnullにする（0で埋めない）。
 */
export function buildMarketIndicatorRows(
  marketResult: MarketQuarterResult,
  previousMarketResult: MarketQuarterResult | null
): readonly MarketIndicatorRow[] {
  const prev = previousMarketResult;
  return [
    indicator(
      "vietnamDomestic",
      "ベトナム国内原料価格",
      "price",
      unwrapUnit(marketResult.vietnamDomestic.price),
      prev !== null ? unwrapUnit(prev.vietnamDomestic.price) : null
    ),
    indicator(
      "pdBasePremium",
      "PDプレミアム（世界基準）",
      "price",
      unwrapUnit(marketResult.pdPremium.basePremium),
      prev !== null ? unwrapUnit(prev.pdPremium.basePremium) : null
    ),
    indicator(
      "vapBasePremium",
      "VAPプレミアム（世界基準）",
      "price",
      unwrapUnit(marketResult.vapPremium.basePremium),
      prev !== null ? unwrapUnit(prev.vapPremium.basePremium) : null
    ),
    indicator(
      "worldSupplyDemandBalance",
      "世界需給バランス",
      "ratio",
      marketResult.worldSupplyDemandBalance,
      prev !== null ? prev.worldSupplyDemandBalance : null
    ),
  ];
}

// ---------------------------------------------------------------------
// D. 仕向市場別価格の内訳（表の下に出す「なぜ市場ごとに違うのか」の説明用）
// ---------------------------------------------------------------------

export interface DestinationPriceExplanation {
  /** HOSO基礎価値（=VNのHOSO基準価格）。 */
  readonly hosoBasePrice: number;
  readonly pdProcessingPremium: number;
  readonly vapIncrementalPremium: number;
}

/**
 * 仕向市場別価格の起点となるVN基準価格の分解（既存の decomposeVietnamProductPrices
 * をそのまま呼ぶだけ）。画面では「この3つの部分に市場ごとの係数がかかっている」という
 * 説明のためだけに使う。
 */
export function buildDestinationPriceExplanation(marketResult: MarketQuarterResult): DestinationPriceExplanation {
  const d = decomposeVietnamProductPrices(marketResult);
  return {
    hosoBasePrice: unwrapUnit(d.hosoBasePrice),
    pdProcessingPremium: unwrapUnit(d.pdProcessingPremium),
    vapIncrementalPremium: unwrapUnit(d.vapIncrementalPremium),
  };
}

/** 表のヘッダ順を画面側とテストで共有する（PRODUCTSをexportして重複定義を防ぐ）。 */
export const MARKET_PANEL_PRODUCTS = PRODUCTS;

export const PRODUCT_LABELS: Readonly<Record<Product, string>> = {
  hoso: "HOSO",
  pd: "PD",
  vap: "VAP",
};
