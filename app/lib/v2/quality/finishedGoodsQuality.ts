// ShrimpX V2 — 品質・顧客信頼・納期信頼性モジュール 完成品ロットへの品質情報付与（Phase 7A）
//
// production/finishedGoods.ts の createFinishedGoodsLots（既存公開関数、
// 未変更）を品質調整後のバッチ配列に対して呼び出した結果へ、対応する
// BatchQualityAdjustmentから品質情報を後付けする。createFinishedGoodsLotsは
// 入力batchesを「finishedGoodsQuantity > EPSILON」でフィルタしてから同じ順序で
// 1ロットずつ生成するため、本関数側でも同じフィルタ条件を使って対応する
// バッチをzipし、位置対応でqualityInfoを付与する。

import { ratio, score0to100, unwrapUnit } from "../core/units";
import { FinishedGoodsLot, ProductionBatch } from "../production/types";
import { BatchQualityAdjustment } from "./types";

const EPSILON = 1e-6;

/**
 * createFinishedGoodsLots(adjustedBatches)の戻り値へ、対応するバッチの
 * BatchQualityAdjustmentから品質情報を付与する（純粋関数、入力は変更しない）。
 * 品質調整がスキップされたバッチ（生産量0）にはqualityInfoを付与しない。
 */
export function attachQualityInfoToFinishedGoodsLots(
  lots: readonly FinishedGoodsLot[],
  adjustedBatches: readonly ProductionBatch[],
  adjustments: ReadonlyMap<string, BatchQualityAdjustment>
): readonly FinishedGoodsLot[] {
  const producingBatches = adjustedBatches.filter((b) => unwrapUnit(b.finishedGoodsQuantity) > EPSILON);
  if (producingBatches.length !== lots.length) {
    // createFinishedGoodsLotsの内部フィルタ条件とここでの再現が食い違った場合、
    // 位置対応でqualityInfoを誤って別のロットへ付けてしまう危険があるため、
    // 黙って進めず例外にする（テストの決定論性チェックで確実に検出できるように
    // するため）。
    throw new Error(
      `完成品ロット数（${lots.length}）と品質調整後の生産バッチ数（${producingBatches.length}）が一致しません。createFinishedGoodsLotsのフィルタ条件と不整合があります。`
    );
  }

  return lots.map((lot, i) => {
    const batch = producingBatches[i];
    const adjustment = adjustments.get(batch.batchId);
    if (!adjustment) return lot;

    const downgradeQuantity = unwrapUnit(adjustment.downgradeQuantity);
    const originalQuantity = unwrapUnit(adjustment.originalFinishedGoodsQuantity);
    const downgradeRatioOfLot = originalQuantity > EPSILON ? Math.min(1, Math.max(0, downgradeQuantity / originalQuantity)) : 0;

    return {
      ...lot,
      qualityInfo: {
        qualityScore: score0to100(unwrapUnit(adjustment.outcome.observedQualityScore)),
        downgradeRatio: ratio(Math.round(downgradeRatioOfLot * 10000) / 10000),
        ...(adjustment.outcome.majorIncident.occurred
          ? { majorIncidentId: `${adjustment.batchId}::incident`, majorIncidentSeverity: adjustment.outcome.majorIncident.severity }
          : {}),
        producedPeriod: adjustment.period,
      },
    };
  });
}
