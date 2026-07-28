// ShrimpX V2 — 会社経営統合テスト環境 意思決定生成器の共有ヘルパー（Phase 9 SAI-1で抽出）
//
// 【抽出の経緯】これらの純粋関数は、もともと autoPolicy.ts（暫定自動方針・
// アーキタイプ別の個性を持つテスト用フィクスチャAI）だけが内部に持っていた
// 会社状態の集計処理だが、standardAi/（SAI-1・アーキタイプ非依存の標準AI）も
// 同じ集計（自社原料在庫・パイプライン量・約定残・完成品在庫・工場能力合計等）を
// 必要とするため、共有モジュールとして切り出した。
//
// 【重要】ここには「振る舞い・閾値・アーキタイプ別個性」は一切含めない。
// CompanyOwnState / CompanyFixture / PublicMarketInfo から素直に読み取れる
// 集計値を返すだけの、完全に決定論的な純粋関数のみを置く。autoPolicy.ts・
// standardAi/ のどちらも、ここから同じ値を読み取った上で、それぞれ異なる
// 閾値・ルールで意思決定を組み立てる。

import { unwrapUnit } from "../core/units";
import { CountryId, DemandMarketId, MarketQuarterResult, Product } from "../market/types";
import { deriveMarketReferencePrices } from "../market/destinationPricing";
import { CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS } from "../market/destinationPricingParameters";
import { PlanCostExpectation } from "../sales/types";
import { CompanyFixture, CompanyOwnState, PublicMarketInfo } from "./types";

const EPSILON = 1e-6;

/**
 * 前期実績が未知（turn 1等）の場合に使う国内原料価格の想定値（USD/HOSO換算kg）。
 * 農家留保価格（2.25）と通常需給価格帯（2.4〜3.0）の間の暫定値（要校正）。
 */
export const DEFAULT_EXPECTED_RAW_PRICE_USD_PER_KG = 2.5;

/** 会社の利用可能（status="available"）な原料在庫の合計（HOSO換算量、単位剥がし済み）。 */
export function availableRawMaterialQuantity(ownState: CompanyOwnState): number {
  return ownState.rawMaterialLots.filter((l) => l.status === "available").reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

/** 輸送中の輸入・養殖中など、将来利用可能になる予定の原料パイプライン量。 */
export function pipelineRawMaterialQuantity(ownState: CompanyOwnState): number {
  return ownState.rawMaterialLots
    .filter((l) => l.status === "inTransitImport" || l.status === "growingAquaculture")
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

/** 未履行（open・partiallyFulfilled・overdue）契約数量の合計（商品区別なし）。 */
export function outstandingContractQuantity(ownState: CompanyOwnState): number {
  return ownState.contracts
    .filter((c) => c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue")
    .reduce((sum, c) => sum + unwrapUnit(c.outstandingQuantity), 0);
}

/** 未履行契約数量の商品別内訳。 */
export function outstandingContractQuantityByProduct(ownState: CompanyOwnState): Record<Product, number> {
  const result: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const c of ownState.contracts) {
    if (c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue") {
      result[c.product] += unwrapUnit(c.outstandingQuantity);
    }
  }
  return result;
}

/** 期日超過（overdue）契約数量の商品別内訳（納期遅延の緊急度判定に使う）。 */
export function overdueContractQuantityByProduct(ownState: CompanyOwnState): Record<Product, number> {
  const result: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const c of ownState.contracts) {
    if (c.status === "overdue") result[c.product] += unwrapUnit(c.outstandingQuantity);
  }
  return result;
}

/** 利用可能（status="available"）な完成品在庫の商品別内訳。 */
export function finishedGoodsByProduct(ownState: CompanyOwnState): Record<Product, number> {
  const result: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const l of ownState.finishedGoodsLots) {
    if (l.status === "available") result[l.product] += unwrapUnit(l.remainingQuantity);
  }
  return result;
}

/** 会社の工場商品別能力の合計。 */
export function totalProductCapacity(fixture: CompanyFixture): Record<Product, number> {
  const result: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const f of fixture.factories) {
    result.hoso += unwrapUnit(f.hosoCapacity);
    result.pd += unwrapUnit(f.pdCapacity);
    result.vap += unwrapUnit(f.vapCapacity);
  }
  return result;
}

/** 会社の工場共通原料処理能力の合計（調達処理能力の工場能力連動方式に使う）。 */
export function totalCommonProcessingCapacity(fixture: CompanyFixture): number {
  return fixture.factories.reduce((sum, f) => sum + unwrapUnit(f.commonProcessingCapacity), 0);
}

/**
 * priceAdjustment系の係数は「基準価格に対する比率」（例: -0.15 = 基準価格の15%値引き）
 * として扱う。絶対USD額の固定調整にすると、シナリオによっては基準価格自体が
 * 大きく変動（暴落）した際に、許容価格帯（Phase4/Phase5のmin/maxAskPriceRatioOfBase・
 * min/maxBidPriceRatioOfMarket）を外れて例外になる（固定USD調整は価格が下がるほど
 * 相対的に効きすぎるため）。比率で持てば、基準価格が動いても常に妥当な相対調整に
 * 収まる。referencePriceが未知（ターン1で前期実績が無い等）の場合は調整0（基準価格
 * どおり）とする。
 */
export function ratioAdjustmentToUsd(ratioAdjustment: number, referencePrice: number | undefined): number {
  if (referencePrice === undefined || referencePrice <= EPSILON) return 0;
  // Phase4/Phase5のmin/maxAskPriceRatioOfBase・min/maxBidPriceRatioOfMarketは[0.5, 2.0]。
  // 前期価格を参照する都合上の1四半期分のラグを考慮し、安全側に[-0.3, +0.3]へ収める。
  const clampedRatio = Math.max(-0.3, Math.min(0.3, ratioAdjustment));
  return clampedRatio * referencePrice;
}

/**
 * 前期公開情報から、商品×仕向市場ごとの参照価格（USD/HOSO換算kg）を取り出す。
 * 未知（turn1等でlastMarketResultが無い場合）ならundefined。
 * market/destinationPricing.ts の価格分解・係数適用をそのまま呼び出すだけで、
 * 新しい価格形成ロジックはここには実装しない。
 */
export function referencePricesByMarketProduct(
  lastMarketResult: MarketQuarterResult | undefined
): Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>> | undefined {
  if (!lastMarketResult) return undefined;
  const breakdown = deriveMarketReferencePrices(lastMarketResult, CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS);
  const result = {} as Record<DemandMarketId, Record<Product, number>>;
  for (const market of Object.keys(breakdown) as DemandMarketId[]) {
    result[market] = {
      hoso: unwrapUnit(breakdown[market].hoso),
      pd: unwrapUnit(breakdown[market].pd),
      vap: unwrapUnit(breakdown[market].vap),
    };
  }
  return result;
}

/** 前期公開情報から商品別の市場プレミアム（VN、USD/HOSO換算kg）を取り出す。未知ならundefined。 */
export function marketPremiumsFromPublicInfo(publicInfo: PublicMarketInfo): Record<"pd" | "vap", number | undefined> {
  const last = publicInfo.lastMarketResult;
  return {
    pd: last ? unwrapUnit(last.pdPremium.byCountry.VN.premium) : undefined,
    vap: last ? unwrapUnit(last.vapPremium.byCountry.VN.premium) : undefined,
  };
}

/** 輸入発注のデフォルト原産国（会社のarchetypeに依存しない、統一の既定値）。 */
export const DEFAULT_IMPORT_ORIGIN_COUNTRY: CountryId = "ID";

/**
 * 販売計画へ添付する契約時予想原価（実装指示 §9）。fixture.productEconomics
 * （会社固有の実データ）と publicInfo（公開情報）だけを参照する、アーキタイプに
 * 依存しない純粋関数。autoPolicy.ts・standardAi/ の両方が同じロジックを使う。
 */
export function buildCostExpectation(fixture: CompanyFixture, product: Product, publicInfo: PublicMarketInfo): PlanCostExpectation {
  const expectedRawPrice =
    publicInfo.vietnamDomesticPriorPrice > EPSILON ? publicInfo.vietnamDomesticPriorPrice : DEFAULT_EXPECTED_RAW_PRICE_USD_PER_KG;
  const expectedProcessingCost = fixture.productEconomics.expectedProcessingCostUsdPerHosoEqKg[product];

  // 最低受注価格: HOSO基準価格（前期実績）+ 最低受注プレミアム（PD/VAP）。
  // HOSO自体は基準商品のため、予想原料価格＋予想加工費を下限の目安とする。
  const lastHoso = publicInfo.lastMarketResult ? unwrapUnit(publicInfo.lastMarketResult.hosoPrices.VN.price) : undefined;
  let minimumAcceptablePrice: number;
  if (product === "hoso" || lastHoso === undefined) {
    minimumAcceptablePrice = expectedRawPrice + expectedProcessingCost;
  } else {
    const econ = fixture.productEconomics.premiumEconomics[product];
    const minPremium =
      econ.avoidableVariableProcessingCostUsdPerHosoEqKg +
      econ.incrementalSellingAndLogisticsCostUsdPerHosoEqKg +
      econ.minimumContributionMarginUsdPerHosoEqKg;
    minimumAcceptablePrice = lastHoso + minPremium;
  }

  return {
    expectedRawMaterialPriceUsdPerHosoEqKg: Math.round(expectedRawPrice * 10000) / 10000,
    expectedProcessingCostUsdPerHosoEqKg: Math.round(expectedProcessingCost * 10000) / 10000,
    minimumAcceptablePriceUsdPerHosoEqKg: Math.round(minimumAcceptablePrice * 10000) / 10000,
  };
}
