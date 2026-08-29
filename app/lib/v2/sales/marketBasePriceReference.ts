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

import { DemandMarketId, Product } from "../market/types";
import { UsdPerHosoEqKg } from "../core/units";
import { MarketProductAllocationResult } from "./types";

/** 基準価格表示専用の最小DTO。market・product・basePrice以外のフィールドは持たない。 */
export interface MarketProductBasePriceReference {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly basePrice: UsdPerHosoEqKg;
}

/**
 * 確定済みMarketProductAllocationResult[]から、公開してよい最小DTOへ射影する。
 * 各社の内訳（companies配列）・targetDemand・externalOptionQuantityは意図的に破棄する。
 */
export function projectMarketBasePriceReferences(
  allocations: readonly MarketProductAllocationResult[] | undefined
): readonly MarketProductBasePriceReference[] | undefined {
  return allocations?.map((a) => ({ market: a.market, product: a.product, basePrice: a.basePrice }));
}
