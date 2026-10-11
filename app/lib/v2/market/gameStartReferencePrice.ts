// ShrimpX V2 — UI-CLARITY-1 A-8: ゲーム開始時点（Turn1）の市場×商品の参照価格
//
// 【直す問題】販売計画の画面は、市場×商品の基準価格を「前四半期の確定結果」からしか
// 取っていない。Turn1には前四半期が無いため、5市場×3商品の基準価格がすべて空欄になる。
// プレイヤーが入力できるのは基準価格からの「調整額」だけなので、基準が見えないまま
// 調整額を決めることになり、経営判断として成立しない。
//
// 【需要と同じ扱いにする】market demand は既に同じ問題を
// marketDemandObservation.ts の buildInitialObservedMarketDemand で解いている
// （turn1・turn2は「ゲーム開始時点の既知市場情報」を公開する）。価格も同じ形にする。
// プレイヤー画面と Standard AI は、必ずこのファイルの同じ関数を呼ぶ
// （どちらか一方だけが情報を持つことを構造的に防ぐ、という既存の原則を守る）。
// 価格には需要のような観測遅延が無いため、必要なのは Turn1 だけである
// （Turn2以降は前四半期の確定結果が存在する）。
// 置き場所を companyLab ではなく market にしているのは、販売側（sales/）と
// 会社ラボ側（companyLab/）の両方から循環参照なしに参照できるようにするため。
//
// 【engineの式を複製しない】市場×商品の参照価格は
// market/destinationPricing.ts computeMarketReferencePrice が唯一の計算箇所であり、
// ここはその関数へ「開始時点の価格分解」を渡すだけである。
//   参照価格 = HOSO基礎価値×市場係数 + PD加工プレミアム×市場係数 + VAP追加プレミアム×市場係数
//
// 【3つの構成要素の出どころ（新しい数値を発明していない）】
// ゲーム開始時点の在世界の価格として唯一実在するのは、各社が開始時点で既に結んでいる
// 契約の単価である（companyLab/initialContracts.ts。16件・9セルぶん）。
// そこから、上の式を逆に解いて3つの構成要素を数量加重で求めた。
//   HOSO契約（CN/US/EU/OTHER 計6,900t）→ hosoBase = 5.223
//   PD契約  （US/EU/JP 計3,250t）       → pdPremium = 1.560
//   VAP契約 （EU/JP 計1,500t）          → vapPremium = 1.624
// この3つを式へ戻すと、実在の初期契約単価を概ね2%以内で再現する（テストで検査する）。
// 契約が無い6セル（CN/PD・CN/VAP・US/VAP・JP/HOSO・OTHER/PD・OTHER/VAP）も、
// 同じ係数表で埋まる。
//
// 【これは「予定」であって約束ではない】Turn1の実際の市場清算はこの値と一致しない。
// 画面には参考値であることを必ず明記する。

import { unwrapUnit, usdPerHosoEqKg } from "../core/units";
import { computeMarketReferencePrice, type ProductPriceDecomposition } from "./destinationPricing";
import { CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS } from "./destinationPricingParameters";
import type { DestinationMarketPriceCoefficientTable } from "./destinationPricingParameters";
import { DEMAND_MARKET_IDS, type DemandMarketId, type Product } from "./types";

/**
 * ゲーム開始時点のVN起点の価格分解。
 * 値の導出は上のコメントのとおり、initialContracts.ts の実在単価からの逆算である。
 * ここを変えると Turn1 の公開価格が変わる（＝プレイヤーとStandard AIの両方が変わる）。
 */
export const GAME_START_HOSO_BASE_PRICE_USD_PER_KG = 5.223;
export const GAME_START_PD_PROCESSING_PREMIUM_USD_PER_KG = 1.56;
export const GAME_START_VAP_INCREMENTAL_PREMIUM_USD_PER_KG = 1.624;

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** 価格の出どころ。需要側の MarketDemandObservationSource と同じ考え方。 */
export type MarketReferencePriceSource =
  /** ゲーム開始時点の既知市場情報（Turn1。まだ前四半期が存在しない）。 */
  | "GAME_START_MARKET_INFORMATION"
  /** 前四半期の確定結果（Turn2以降）。 */
  | "LAST_QUARTER_MARKET_RESULT";

export interface InitialMarketReferencePrice {
  /** 市場×商品の参照価格（USD/HOSO換算kg）。 */
  readonly byMarketProduct: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>;
  readonly source: MarketReferencePriceSource;
  /** 分解の内訳（画面・診断で根拠を示すため）。 */
  readonly decomposition: {
    readonly hosoBasePriceUsdPerKg: number;
    readonly pdProcessingPremiumUsdPerKg: number;
    readonly vapIncrementalPremiumUsdPerKg: number;
  };
}

/** ゲーム開始時点の価格分解（engineの型そのまま）。 */
export function gameStartPriceDecomposition(): ProductPriceDecomposition {
  return {
    hosoBasePrice: usdPerHosoEqKg(GAME_START_HOSO_BASE_PRICE_USD_PER_KG),
    pdProcessingPremium: usdPerHosoEqKg(GAME_START_PD_PROCESSING_PREMIUM_USD_PER_KG),
    vapIncrementalPremium: usdPerHosoEqKg(GAME_START_VAP_INCREMENTAL_PREMIUM_USD_PER_KG),
    pdPremiumWasClampedToZero: false,
    vapPremiumWasClampedToZero: false,
  };
}

/**
 * Turn1 に公開する市場×商品の参照価格を組み立てる。
 * 計算は engine の computeMarketReferencePrice だけが行う。
 */
export function buildGameStartMarketReferencePrice(
  coefficients: DestinationMarketPriceCoefficientTable = CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
): InitialMarketReferencePrice {
  const decomposition = gameStartPriceDecomposition();
  const byMarketProduct = {} as Record<DemandMarketId, Record<Product, number>>;
  for (const market of DEMAND_MARKET_IDS) {
    const perProduct = {} as Record<Product, number>;
    for (const product of PRODUCTS) {
      perProduct[product] = unwrapUnit(
        computeMarketReferencePrice(decomposition, market, product, coefficients).marketReferencePrice
      );
    }
    byMarketProduct[market] = perProduct;
  }
  return {
    byMarketProduct,
    source: "GAME_START_MARKET_INFORMATION",
    decomposition: {
      hosoBasePriceUsdPerKg: GAME_START_HOSO_BASE_PRICE_USD_PER_KG,
      pdProcessingPremiumUsdPerKg: GAME_START_PD_PROCESSING_PREMIUM_USD_PER_KG,
      vapIncrementalPremiumUsdPerKg: GAME_START_VAP_INCREMENTAL_PREMIUM_USD_PER_KG,
    },
  };
}
