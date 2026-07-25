// ShrimpX V2 — Company Lab 財務パネル PLタブ
//
// CompanyFinancialQuarterResult.profitAndLoss（finance/quarterClose.tsが既に計算・
// 永続化済み）をそのまま表示するだけ。ここでは一切再計算しない。

import { CompanyFinancialQuarterResult } from "../../../../lib/v2/finance/types";
import { LineRow, NoDataNotice, TableHead, UnitNote } from "./financialTableParts";

interface Props {
  readonly current: CompanyFinancialQuarterResult | null;
  readonly previous: CompanyFinancialQuarterResult | null;
}

export default function ProfitAndLossTab({ current, previous }: Props) {
  if (!current) return <NoDataNotice label="PL（損益計算書）" />;
  const pl = current.profitAndLoss;
  const prevPl = previous?.profitAndLoss;
  const c = pl.costOfSales;
  const pc = prevPl?.costOfSales;

  return (
    <div className="space-y-2">
      <UnitNote />
      <table className="min-w-full text-xs">
        <TableHead />
        <tbody className="divide-y divide-gray-800">
          <LineRow label="売上高" current={pl.grossRevenue} previous={prevPl?.grossRevenue} />
          <LineRow label="格落ち控除" current={-pl.qualitySalesDeduction} previous={prevPl ? -prevPl.qualitySalesDeduction : undefined} indent />
          <LineRow label="純売上高" current={pl.netRevenue} previous={prevPl?.netRevenue} bold />
          <LineRow label="原材料費" current={-c.rawMaterialCost} previous={pc ? -pc.rawMaterialCost : undefined} indent />
          <LineRow label="加工費" current={-c.processingCost} previous={pc ? -pc.processingCost : undefined} indent />
          <LineRow label="労務費" current={-c.laborCost} previous={pc ? -pc.laborCost : undefined} indent />
          <LineRow label="工場固定費" current={-c.factoryFixedCost} previous={pc ? -pc.factoryFixedCost : undefined} indent />
          <LineRow label="手直しコスト" current={-c.reworkCost} previous={pc ? -pc.reworkCost : undefined} indent />
          <LineRow label="廃棄損" current={-c.discardLoss} previous={pc ? -pc.discardLoss : undefined} indent />
          <LineRow label="未吸収固定製造費" current={-c.unabsorbedFixedManufacturingCost} previous={pc ? -pc.unabsorbedFixedManufacturingCost : undefined} indent />
          <LineRow label="遊休労務費" current={-c.idleLaborCost} previous={pc ? -pc.idleLaborCost : undefined} indent />
          <LineRow label="設備維持費（capex）" current={-c.capexMaintenanceCost} previous={pc ? -pc.capexMaintenanceCost : undefined} indent />
          <LineRow label="売上原価合計" current={-pl.totalCostOfSales} previous={prevPl ? -prevPl.totalCostOfSales : undefined} bold />
          <LineRow label="売上総利益" current={pl.grossProfit} previous={prevPl?.grossProfit} bold />
          <LineRow label="販管費" current={-pl.sellingGeneralAdmin} previous={prevPl ? -prevPl.sellingGeneralAdmin : undefined} indent />
          <LineRow label="営業利益" current={pl.operatingProfit} previous={prevPl?.operatingProfit} bold />
          <LineRow label="支払利息" current={-pl.interestExpense} previous={prevPl ? -prevPl.interestExpense : undefined} indent />
          <LineRow label="税引前利益" current={pl.profitBeforeTax} previous={prevPl?.profitBeforeTax} bold />
          <LineRow label="法人税等" current={-pl.incomeTax} previous={prevPl ? -prevPl.incomeTax : undefined} indent />
          <LineRow label="当期純利益" current={pl.netIncome} previous={prevPl?.netIncome} bold />
        </tbody>
      </table>
    </div>
  );
}
