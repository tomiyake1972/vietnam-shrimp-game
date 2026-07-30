// ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール Phase3市場結果アダプター（Phase 4）
//
// Phase3の市場・価格形成モジュール（app/lib/v2/market）の出力
// MarketQuarterResult・入力 MarketQuarterInput を読み取るだけの純粋関数のみを
// 提供する。価格・需給の計算式は一切変更・再実装しない
// （実装指示「国際基準価格そのものは変更しない」に対応）。
//
// 本モジュールが実装する5社は全員ベトナムの輸出会社という前提（ゲーム設定）
// のため、基準価格は常にベトナム（VN）のHOSO FOB価格＋PD/VAPプレミアムを使う。
//
// --- 対象需要（targetDemand）の導出について（Phase4固有の暫定前提・要校正） ---
// MarketQuarterResult は「商品区分（hoso/pd/vap）ごとの世界全体需要」は持つが、
// 「市場（CN/US/EU/JP/OTHER）ごとの当期需要」も「うちベトナム産がどれだけ
// 獲得できるか」も直接は持たない（市場別の需要内訳はPhase1の入力側
// MarketQuarterInput.demandMarkets[*].priorPeriodConsumptionにのみ存在し、
// 当期の需要成長式はPhase1内部で計算されるため、Phase4側では再計算しない）。
// 本アダプターは、成約配分の上限として必要な「市場×商品区分×ベトナム産」の
// 対象需要を、既存フィールドのみから次の3段階で機械的に按分する。新しい
// 価格・需給の経済ロジックは一切追加していない（既存の集計値を比率で
// 分配しているだけ）。
//   (a) ベトナムが世界需要のうち実際に獲得した数量 =
//       marketResult.hosoPrices.VN.allocatedDemand （Phase1がすでに計算済み）
//   (b) (a)を商品区分（hoso/pd/vap）へ、世界全体の商品構成比
//       （worldDemandに対するhoso/pd/vapそれぞれの世界需要の比率）で按分する
//       （ベトナムの商品構成が世界平均と同じという簡略化）。
//   (c) (b)の各商品区分ぶんを、5市場（CN/US/EU/JP/OTHER）へ、各市場の
//       priorPeriodConsumption（前期消費量、MarketQuarterInputの生値）の
//       構成比で按分する（商品区分によらず市場ごとの相対的な大きさの比率は
//       同じという簡略化。当期の需要成長式は再計算せず、前期実績という
//       生の入力値だけを相対ウェイトとして使う）。
// これはPhase4固有の暫定前提であり、Phase3のassumptions.tsと同じ位置づけで
// ここに集約する。将来、Phase1側に市場別・商品別の需要分解が実装されたら、
// このアダプターだけを置き換えればよい。

import { HosoEqTons, UsdPerHosoEqKg, hosoEqTons, unwrapUnit } from "../core/units";
import { DEMAND_MARKET_IDS, DemandMarketId, MarketQuarterInput, MarketQuarterResult, Product } from "../market/types";
import { deriveMarketReferencePrices } from "../market/destinationPricing";
import {
  CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS,
  DestinationMarketPriceCoefficientTable,
} from "../market/destinationPricingParameters";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/**
 * ベトナム（5社の共通産地）の商品区分ごとの基準価格。Phase3のプレミアムを含む。
 * 【Phase 8P-0A】この関数自体は変更していない（市場非依存・商品別のみの
 * 基準価格を返す既存の意味を維持する。既存テスト
 * sales/__tests__/marketAdapter.test.ts が検証）。成約配分の実際の基準価格には
 * 代わりに deriveVietnamMarketReferencePrices（仕向市場別）を使う。
 */
export function deriveVietnamBasePrices(marketResult: MarketQuarterResult): Readonly<Record<Product, UsdPerHosoEqKg>> {
  return {
    hoso: marketResult.hosoPrices.VN.price,
    pd: marketResult.pdPremium.byCountry.VN.finalPrice,
    vap: marketResult.vapPremium.byCountry.VN.finalPrice,
  };
}

/**
 * 【Phase 8P-0A】ベトナム（5社の共通産地）の商品×仕向市場ごとの参照価格。
 * market/destinationPricing.ts の価格分解・係数適用をそのまま呼び出すだけの
 * アダプター（新しい価格形成ロジックはここには実装しない）。
 * coefficients省略時は CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
 * （現行運用中の係数セット）を使う。
 */
export function deriveVietnamMarketReferencePrices(
  marketResult: MarketQuarterResult,
  coefficients: DestinationMarketPriceCoefficientTable = CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
): Readonly<Record<DemandMarketId, Readonly<Record<Product, UsdPerHosoEqKg>>>> {
  return deriveMarketReferencePrices(marketResult, coefficients);
}

/**
 * ベトナムの商品区分別・獲得需要（世界全体のうちベトナム産に配分された数量を、
 * 世界全体の商品構成比で按分したもの）。市場別内訳を持たない中間値。
 */
function deriveVietnamDemandByProduct(marketResult: MarketQuarterResult): Readonly<Record<Product, number>> {
  const vietnamAllocatedDemand = unwrapUnit(marketResult.hosoPrices.VN.allocatedDemand);
  const worldDemand = unwrapUnit(marketResult.worldDemand);
  const globalPdDemand = unwrapUnit(marketResult.pdPremium.globalDemand);
  const globalVapDemand = unwrapUnit(marketResult.vapPremium.globalDemand);
  // "hoso"（未加工のまま販売される分）= 世界需要 - PD需要 - VAP需要。
  const globalHosoDemand = Math.max(0, worldDemand - globalPdDemand - globalVapDemand);

  if (worldDemand <= 0) {
    return { hoso: 0, pd: 0, vap: 0 };
  }

  return {
    hoso: vietnamAllocatedDemand * (globalHosoDemand / worldDemand),
    pd: vietnamAllocatedDemand * (globalPdDemand / worldDemand),
    vap: vietnamAllocatedDemand * (globalVapDemand / worldDemand),
  };
}

/**
 * 市場×商品区分ごとの対象需要（ベトナム産がこの四半期に獲得できる上限の目安）。
 * 5社の成約配分（allocateMarketProduct）の需要上限として使う。
 *
 * 【Phase 8F-1】市場別の按分ウェイトは、従来は各市場の生の
 * priorPeriodConsumption（前期消費量、静的な構成比）のみで決めていたが、
 * これは「消費」と「購買」を混同したまま需要を按分していた箇所であり、
 * 監査結果で二重計上リスクとして特定された唯一の置き換え対象である
 * （market/consumerInventory.ts のヘッダコメント参照）。
 * `marketWeights` を渡すと、market/consumerInventory.ts の
 * deriveMarketWeightsFromDesiredPurchase が算出した「希望購買量ベースの
 * 市場別構成比」で按分する（消費だけでなく在庫水準・当期価格を反映した
 * ウェイト）。省略時は既存の priorPeriodConsumption ベースの按分を維持し、
 * 後方互換を保つ（Phase 8F-1配線前の呼び出し元・既存テストへ影響しない）。
 */
export function deriveTargetDemand(
  marketResult: MarketQuarterResult,
  marketInput: MarketQuarterInput,
  marketWeights?: Readonly<Record<DemandMarketId, number>>,
  /**
   * 【SAI-5C】市場×商品の需要構成比行列（market/productLifecycle.ts の
   * computeMarketProductMix。各市場の行和=1）。指定時は、従来の
   * 「世界一律の商品構成比 × 市場ウェイト」（分離形。全市場が同じ商品構成に
   * なる簡略化＝上記(b)(c)）を「市場ウェイト × 市場別の商品構成比」（結合形）
   * へ置き換える。どちらの形でも全セルの合計はベトナム獲得需要の総量に一致する
   * （総需要保存。分離形はΣ_p世界構成比=1、結合形はΣ_p行和=1のため）。
   * 省略時は完全に従来の計算（後方互換・ビット単位一致）。
   */
  marketProductMix?: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>
): Readonly<Record<DemandMarketId, Readonly<Record<Product, HosoEqTons>>>> {
  const vietnamDemandByProduct = deriveVietnamDemandByProduct(marketResult);

  const totalPriorConsumption = DEMAND_MARKET_IDS.reduce(
    (sum, m) => sum + unwrapUnit(marketInput.demandMarkets[m].priorPeriodConsumption),
    0
  );

  const vietnamAllocatedDemandTotal = marketProductMix
    ? PRODUCTS.reduce((sum, p) => sum + vietnamDemandByProduct[p], 0)
    : 0;

  const result = {} as Record<DemandMarketId, Record<Product, HosoEqTons>>;
  for (const market of DEMAND_MARKET_IDS) {
    const marketShare = marketWeights
      ? marketWeights[market]
      : totalPriorConsumption > 0
      ? unwrapUnit(marketInput.demandMarkets[market].priorPeriodConsumption) / totalPriorConsumption
      : 1 / DEMAND_MARKET_IDS.length;
    const perProduct = {} as Record<Product, HosoEqTons>;
    for (const product of PRODUCTS) {
      const cell = marketProductMix
        ? vietnamAllocatedDemandTotal * marketShare * marketProductMix[market][product]
        : vietnamDemandByProduct[product] * marketShare;
      perProduct[product] = hosoEqTons(Math.max(0, cell));
    }
    result[market] = perProduct;
  }
  return result;
}
