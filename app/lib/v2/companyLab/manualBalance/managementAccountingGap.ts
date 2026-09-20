// ShrimpX V2 — 管理会計（変動原価計算）レポートの分類不整合の計測
//
// 【このファイルは「測る」だけで「直さない」】
// 現行Engineの absorption P&L には含まれるが、Contribution Margin レポートの
// 変動費プール・固定費プールのどちらにも入っていない費目が4つある。
// 原因は finance/quarterClose.ts の費用式であり、その変更は本Phaseでは禁止。
// ここでは差額を計測し、画面へ「この指標にはこの費目が含まれていない」という
// 限界表示を出すための根拠を返すだけである。
//
// 【経済実態は変えていない】これは分類（どのプールに入れるか）だけの問題であり、
// 現金・利益そのものを動かす修正ではない。absorption側の operatingProfit には
// 4費目が正しく含まれており、Cashもそちらと整合している。管理会計レポートの
// managementOperatingProfit だけが4費目を差し引いていない。
// 分類のみの修正と、経済実態/Cashを変える修正は別物である（混同しないこと）。
//
// 【計算式の出所】standardAi/__tests__/costProjectionWiring.test.ts が
// 同じ式で absorption 専用費目を算出している。ここでは同じ式を独立に実装せず、
// 同じ導出（P&LとCMレポートの差分）をそのまま使う。

import type { CompanyQuarterRecord } from "../types";

/**
 * absorption P&L に含まれるが Contribution Margin の各プールに含まれない費目。
 * 【出所】finance/quarterClose.ts の実測。
 *   - costOfSales.capexMaintenanceCost … fixedManufacturingCost に含まれない
 *   - costOfSales.factoryLifecycleCarryingCost … 同上
 *   - salesForceSeveranceCost … fixedPersonnelCost（salesForceCost+procurementCost）に含まれない
 *   - vapProductDevelopmentSpendUsd … どのプールにも含まれない
 */
export const MANAGEMENT_ACCOUNTING_ABSORPTION_ONLY_COST_ITEMS = [
  "capexMaintenanceCost",
  "factoryLifecycleCarryingCost",
  "salesForceSeveranceCost",
  "vapProductDevelopmentSpendUsd",
] as const;

export interface ManagementAccountingGapSummary {
  /** 検査した財務レコード件数（会社×四半期）。 */
  readonly totalRecords: number;
  /** absorption専用費目が0でなかった（＝分類不整合が実在した）件数。 */
  readonly recordsWithGap: number;
  /** absorption専用費目の合計の最大値（USD）。限界表示の規模感に使う。 */
  readonly maxAbsorptionOnlyCostUsd: number;
  /**
   * 4費目を戻しても説明できない残差の最大値（USD）。
   * 0に近いことが「原因は4費目で尽きている」ことの根拠になる。
   */
  readonly maxUnexplainedResidualUsd: number;
}

/**
 * 確定済みの四半期記録から、管理会計レポートの分類不整合を計測する。
 *
 * 【新しい会計を作らない】ここでは既存の profitAndLoss / contributionMargin /
 * absorptionVariableReconciliation が持つ値を読み、差分を取るだけである。
 */
export function summarizeManagementAccountingGap(
  history: readonly CompanyQuarterRecord[]
): ManagementAccountingGapSummary {
  let totalRecords = 0;
  let recordsWithGap = 0;
  let maxAbsorptionOnlyCostUsd = 0;
  let maxUnexplainedResidualUsd = 0;

  for (const entry of history) {
    for (const fin of entry.financialResults) {
      const pl = fin.profitAndLoss;
      const cm = fin.contributionMargin;
      const rec = fin.absorptionVariableReconciliation;
      totalRecords += 1;

      // SG&Aのうち、CMのどのプールにも入っていない部分
      // （= salesForceSeveranceCost + vapProductDevelopmentSpendUsd）。
      const sgaOnlyInAbsorption =
        Number(pl.sellingGeneralAdmin) -
        Number(cm.fixedPersonnelCost) -
        Number(cm.fixedSellingAdminCost) -
        Number(cm.variableSellingCost);

      const absorptionOnlyCosts =
        Number(pl.costOfSales.capexMaintenanceCost) +
        Number(pl.costOfSales.factoryLifecycleCarryingCost) +
        sgaOnlyInAbsorption;

      if (Math.abs(absorptionOnlyCosts) > 0) recordsWithGap += 1;
      maxAbsorptionOnlyCostUsd = Math.max(maxAbsorptionOnlyCostUsd, Math.abs(absorptionOnlyCosts));

      // 4費目を戻すと、absorption と variable の利益差は在庫中固定費の増減で閉じる。
      const opening = Number(rec.fixedCostInOpeningInventory);
      const closing = Number(rec.fixedCostInClosingInventory);
      const unexplained = Math.abs(Number(rec.profitDifference) + absorptionOnlyCosts - (closing - opening));
      maxUnexplainedResidualUsd = Math.max(maxUnexplainedResidualUsd, unexplained);
    }
  }

  return { totalRecords, recordsWithGap, maxAbsorptionOnlyCostUsd, maxUnexplainedResidualUsd };
}
