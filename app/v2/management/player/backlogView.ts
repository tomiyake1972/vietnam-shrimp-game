// ShrimpX V2 — PLAYER Company Workspace: 受注残（Backlog）表示の共通ソース
//
// 【新しい計算をしない】ここは既存の CompanyQuarterSummary（会社ラボが既に
// 確定させた実績サマリー）から表示用の値を選ぶだけで、受注残・納期超過の
// 計算式そのものは一切持たない（計算は会社ラボ本体の売上確定処理が既に
// 行っている＝newContractedQuantity/fulfilledQuantity/outstandingQuantity/
// overdueQuantity）。
//
// 【単一の情報源】Sales（Overview）表示とInventory表示のどちらも、この
// 1つの関数を通してのみ受注残・納期超過の値を得る。呼び出し側ごとに
// summaryから直接フィールドを拾わせると、将来どちらかだけ値がずれる事故に
// つながるため、ここへ集約する。

import { CompanyQuarterSummary } from "../../../lib/v2/companyLab/types";
import { unwrapUnit } from "../../../lib/v2/core/units";

export interface BacklogDisplay {
  readonly newContractedTons: number;
  readonly fulfilledTons: number;
  readonly backlogTons: number;
  readonly previousBacklogTons: number | null;
  readonly overdueTons: number;
  /** 納期超過が0より大きい＝UIで目立たせてよい（指示F）。 */
  readonly overdueIsSignificant: boolean;
  readonly finishedGoodsInventoryTons: number;
  readonly rawMaterialInventoryTons: number;
}

/**
 * 直近確定Turnの会社サマリー（＋あれば前期のサマリー）から、Sales/Inventory
 * 両方の表示に使う値をまとめて選ぶ。summaryがまだ無い（1Turnも確定していない）
 * 場合はnull（0で埋めて捏造しない）。
 */
export function buildBacklogDisplay(
  summary: CompanyQuarterSummary | null,
  previousSummary: CompanyQuarterSummary | null
): BacklogDisplay | null {
  if (!summary) return null;
  const overdueTons = unwrapUnit(summary.overdueQuantity);
  return {
    newContractedTons: unwrapUnit(summary.newContractedQuantity),
    fulfilledTons: unwrapUnit(summary.fulfilledQuantity),
    backlogTons: unwrapUnit(summary.outstandingQuantity),
    previousBacklogTons: previousSummary ? unwrapUnit(previousSummary.outstandingQuantity) : null,
    overdueTons,
    overdueIsSignificant: overdueTons > 0,
    finishedGoodsInventoryTons: unwrapUnit(summary.finishedGoodsInventory),
    rawMaterialInventoryTons: unwrapUnit(summary.rawMaterialInventory),
  };
}
