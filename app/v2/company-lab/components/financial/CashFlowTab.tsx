// ShrimpX V2 — Company Lab 財務パネル CFタブ
//
// CompanyFinancialQuarterResult.cashFlow（finance/quarterClose.tsが既に計算・
// 永続化済み）をそのまま表示するだけ。CF期末現金とBS現金の整合性チェックは、
// エンジン側が別々に計算した2つの値（closingCash・balanceSheet.cash）を
// 画面側で突き合わせるだけであり、値そのものは一切再計算しない。

import { CompanyFinancialQuarterResult } from "../../../../lib/v2/finance/types";
import { Badge, LineRow, NoDataNotice, TableHead, UnitNote } from "./financialTableParts";

interface Props {
  readonly current: CompanyFinancialQuarterResult | null;
  readonly previous: CompanyFinancialQuarterResult | null;
}

const CASH_TOLERANCE_USD = 1;

export default function CashFlowTab({ current, previous }: Props) {
  if (!current) return <NoDataNotice label="CF（キャッシュフロー計算書）" />;
  const cf = current.cashFlow;
  const prevCf = previous?.cashFlow;
  const od = cf.operatingDirect;
  const pod = prevCf?.operatingDirect;
  const consistent = Math.abs(cf.closingCash - current.balanceSheet.cash) < CASH_TOLERANCE_USD;
  const directIndirectOk = Math.abs(cf.directIndirectDifference) < CASH_TOLERANCE_USD;

  return (
    <div className="space-y-3">
      <UnitNote />
      <div>
        <div className="text-xs text-gray-400 mb-1">営業活動によるキャッシュフロー（直接法）</div>
        <table className="min-w-full text-xs">
          <TableHead />
          <tbody className="divide-y divide-gray-800">
            <LineRow label="顧客からの入金" current={od.receiptsFromCustomers} previous={pod?.receiptsFromCustomers} indent />
            <LineRow label="原材料の支払" current={od.paymentsForRawMaterials} previous={pod?.paymentsForRawMaterials} indent />
            <LineRow label="製造費の支払" current={od.paymentsForManufacturing} previous={pod?.paymentsForManufacturing} indent />
            <LineRow label="販管費の支払" current={od.paymentsForSellingGeneralAdmin} previous={pod?.paymentsForSellingGeneralAdmin} indent />
            <LineRow label="利息の支払" current={od.interestPaid} previous={pod?.interestPaid} indent />
            <LineRow label="法人税の支払" current={od.incomeTaxPaid} previous={pod?.incomeTaxPaid} indent />
            <LineRow label="営業活動によるキャッシュフロー合計" current={cf.operatingCashFlow} previous={prevCf?.operatingCashFlow} bold />
          </tbody>
        </table>
      </div>
      <div>
        <table className="min-w-full text-xs">
          <TableHead />
          <tbody className="divide-y divide-gray-800">
            <LineRow label="投資活動によるキャッシュフロー" current={cf.investingCashFlow} previous={prevCf?.investingCashFlow} bold />
            <LineRow label="財務活動によるキャッシュフロー" current={cf.financingCashFlow} previous={prevCf?.financingCashFlow} bold />
            <LineRow label="現金増減額" current={cf.netCashChange} previous={prevCf?.netCashChange} bold />
            <LineRow label="期首現金残高" current={cf.openingCash} previous={prevCf?.openingCash} indent />
            <LineRow label="期末現金残高" current={cf.closingCash} previous={prevCf?.closingCash} bold />
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Badge text={consistent ? "期末現金とBS現金が一致 ✓" : "期末現金とBS現金が不一致（要確認）"} tone={consistent ? "ok" : "danger"} />
        <Badge text={directIndirectOk ? "直接法・間接法の差額ゼロ ✓" : "直接法・間接法に差額あり（要確認）"} tone={directIndirectOk ? "ok" : "danger"} />
      </div>
    </div>
  );
}
