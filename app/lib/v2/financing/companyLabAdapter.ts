// ShrimpX V2 — 資金繰りモジュール 会社ラボ実績アダプター（Phase 8B-1）
//
// finance/companyLabAdapter.tsと同じ考え方（抽出・金額換算のみ、再計算しない）を、
// 銀行の与信判断が参照してよい「担保入力（CollateralInput）」の組み立てに適用する。
// 【銀行は未来を知らない】ここで参照するのは常に「当四半期の意思決定が確定する
// 時点で既に確定している情報」だけである。
//   - 売掛金: 前期末の財務状態（prevFinance.receivables）。
//   - 原料在庫（使用可能・輸送中輸入）: 期首時点の実ロット（state.rawMaterialLots。
//     turnResult計算より前に取得するため、当期の市場・生産実績を含まない）。
//   - 完成品在庫: 前期末のBS完成品在庫金額（priorQuarterResult.balanceSheet）。
//     当期の完成品原価台帳から再計算しない（当期分は当期の生産実績を必要とし、
//     銀行がまだ知らない情報になってしまうため）。

import { unwrapUnit } from "../core/units";
import { CompanyFinanceState, CompanyFinancialQuarterResult, unwrapUsd } from "../finance/types";
import { RawMaterialLot } from "../rawMaterials/types";
import { CompanyId } from "../sales/types";
import { CollateralInput } from "./borrowingCapacity";

/** kg/HOSO換算トン。finance/money.tsのKG_PER_HOSO_EQ_TONと同じ換算式（×1,000）を用いる。 */
const KG_PER_HOSO_EQ_TON = 1000;

/** ロット一覧のうち指定ステータスぶんの金額合計（Σ 残数量×取得単価×1,000）。 */
function lotsValueUsdByStatus(lots: readonly RawMaterialLot[], companyId: CompanyId, statuses: readonly RawMaterialLot["status"][]): number {
  let total = 0;
  for (const lot of lots) {
    if (lot.companyId !== companyId) continue;
    if (!statuses.includes(lot.status)) continue;
    total += unwrapUnit(lot.remainingQuantity) * KG_PER_HOSO_EQ_TON * unwrapUnit(lot.unitCost);
  }
  return total;
}

export interface CompanyCollateralSource {
  readonly companyId: CompanyId;
  /** 期首時点（当期の市場・生産実績より前）の全原料ロット。 */
  readonly rawMaterialLotsAtStart: readonly RawMaterialLot[];
  readonly prevFinanceState: CompanyFinanceState;
  /** 前期の財務結果（初回四半期はundefined）。 */
  readonly priorQuarterResult?: CompanyFinancialQuarterResult;
}

/**
 * 銀行の与信判断（planQuarterFinancing・緊急融資判定）へ渡す担保入力を組み立てる。
 * 当期の事業実績は一切参照しない（関数の入力自体に含まれない）。
 */
export function buildCollateralInputFromCompanyLab(src: CompanyCollateralSource): CollateralInput {
  const receivablesUsd = src.prevFinanceState.receivables.reduce((s, r) => s + unwrapUsd(r.amount), 0);
  const rawMaterialAvailableUsd = lotsValueUsdByStatus(src.rawMaterialLotsAtStart, src.companyId, ["available"]);
  const rawMaterialInTransitUsd = lotsValueUsdByStatus(src.rawMaterialLotsAtStart, src.companyId, ["inTransitImport"]);
  const finishedGoodsUsd = src.priorQuarterResult ? unwrapUsd(src.priorQuarterResult.balanceSheet.finishedGoodsInventory) : 0;
  return { receivablesUsd, rawMaterialAvailableUsd, rawMaterialInTransitUsd, finishedGoodsUsd };
}
