// ShrimpX V2 — 工場・ワーカー・生産モジュール ID生成（Phase 6）
//
// rawMaterials/inventoryIds.ts（buildLotId）・sales（buildContractId）と同じ考え方で、
// 決定論的なIDを生成する。sequenceは呼び出し側が同一四半期内で衝突しないよう
// 採番する連番。

import { PeriodV2 } from "../core/period";
import { Product } from "../market/types";

/** 生産バッチID。1社×1工場×1商品×1四半期の実行結果を一意に識別する。 */
export function buildBatchId(companyId: string, factoryId: string, product: Product, period: PeriodV2, sequence: number): string {
  return `PB-${period}-${product}-${factoryId}-${companyId}-${sequence}`;
}

/** 完成品ロットID。 */
export function buildFinishedGoodsLotId(companyId: string, factoryId: string, product: Product, period: PeriodV2, sequence: number): string {
  return `FG-${period}-${product}-${factoryId}-${companyId}-${sequence}`;
}
