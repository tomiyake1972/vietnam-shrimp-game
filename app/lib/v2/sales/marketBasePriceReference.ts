// ShrimpX V2 — SALES基準価格参考表示: Player公開用の最小DTO
//
// 【最重要・セキュリティ境界】MarketProductAllocationResultには
// companies: readonly CompanyAllocationEntry[]（各社のaskPrice・allocatedQuantity・
// processingCapacity・competitivenessWeight・competitivenessBreakdown等の内訳）や
// targetDemand・externalOptionQuantityが含まれる。これをそのままIndependent Player
// （/api/v2/play/session経由でPlayerのブラウザへ返る）へ渡すと、他社の非公開情報が
// 丸ごと公開されてしまい「Player cannot inspect competitor private state」に反する。
//
// このモジュールは、Player・GM代理操作・company-lab/play の3経路すべてが同じ
// 最小DTO（market・product・basePriceだけ）を使うための、唯一の射影関数を提供する。
// 新しい価格計算は一切行わない（既存の確定済みbasePriceをそのまま転記するだけ）。

import { DemandMarketId, DEMAND_MARKET_IDS, Product } from "../market/types";
import { usdPerHosoEqKg, UsdPerHosoEqKg } from "../core/units";
import {
  buildGameStartMarketReferencePrice,
  type MarketReferencePriceSource,
} from "../market/gameStartReferencePrice";
import { MarketProductAllocationResult } from "./types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** 基準価格表示専用の最小DTO。market・product・basePrice以外のフィールドは持たない。 */
export interface MarketProductBasePriceReference {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly basePrice: UsdPerHosoEqKg;
  /**
   * 【UI-CLARITY-1 A-8】この基準価格の出どころ。
   * 省略時は従来どおり「前四半期の確定結果」とみなす（既存の保存データ・
   * 既存のテストをそのまま通すため、必須にはしない）。
   */
  readonly source?: MarketReferencePriceSource;
}

/**
 * 確定済みMarketProductAllocationResult[]から、公開してよい最小DTOへ射影する。
 * 各社の内訳（companies配列）・targetDemand・externalOptionQuantityは意図的に破棄する。
 */
export function projectMarketBasePriceReferences(
  allocations: readonly MarketProductAllocationResult[] | undefined
): readonly MarketProductBasePriceReference[] | undefined {
  return allocations?.map((a) => ({
    market: a.market,
    product: a.product,
    basePrice: a.basePrice,
    source: "LAST_QUARTER_MARKET_RESULT" as const,
  }));
}

/**
 * 【UI-CLARITY-1 A-8】販売計画の画面へ渡す基準価格を解決する。
 *
 * Turn1には前四半期が存在しないため、従来はここが undefined になり、
 * 5市場×3商品の基準価格がすべて「－」になっていた。プレイヤーが入力できるのは
 * 基準価格からの調整額だけなので、基準が見えない状態では価格を決められない。
 * そこで前四半期が無い場合に限り、ゲーム開始時点の既知市場情報
 * （market/gameStartReferencePrice.ts。Standard AI も同じ関数を参照する）を返す。
 *
 * 前四半期の確定結果がある場合の挙動は従来と完全に同一である。
 * 新しい価格計算はこの関数では行わない（開始時点の表も engine の
 * computeMarketReferencePrice がそのまま計算している）。
 */
export function resolveMarketBasePriceReferences(
  allocations: readonly MarketProductAllocationResult[] | undefined
): readonly MarketProductBasePriceReference[] | undefined {
  const projected = projectMarketBasePriceReferences(allocations);
  if (projected !== undefined && projected.length > 0) return projected;

  const gameStart = buildGameStartMarketReferencePrice();
  const references: MarketProductBasePriceReference[] = [];
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      references.push({
        market,
        product,
        basePrice: usdPerHosoEqKg(gameStart.byMarketProduct[market][product]),
        source: gameStart.source,
      });
    }
  }
  return references;
}
