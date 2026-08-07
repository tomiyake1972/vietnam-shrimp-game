// ShrimpX V2 — Company Lab 財務パネル BSタブ
//
// CompanyFinancialQuarterResult.balanceSheet（finance/quarterClose.tsが既に計算・
// 永続化済み）をそのまま表示するだけ。balanceDifference（貸借差額）は既に
// エンジン側で計算済みの整合性チェック用フィールドをそのまま表示する
// （画面側で新たに貸借を計算し直すことはしない）。

import { CompanyFinancialQuarterResult } from "../../../../lib/v2/finance/types";
import { Badge, LineRow, NoDataNotice, TableHead, UnitNote } from "./financialTableParts";

interface Props {
  readonly current: CompanyFinancialQuarterResult | null;
  readonly previous: CompanyFinancialQuarterResult | null;
}

const BALANCE_TOLERANCE_USD = 1;

export default function BalanceSheetTab({ current, previous }: Props) {
  if (!current) return <NoDataNotice label="BS（貸借対照表）" />;
  const bs = current.balanceSheet;
  const prevBs = previous?.balanceSheet;
  const balanced = Math.abs(bs.balanceDifference) < BALANCE_TOLERANCE_USD;

  return (
    <div className="space-y-3">
      <UnitNote />
      <div>
        <div className="text-xs text-gray-400 mb-1">資産の部</div>
        <table className="min-w-full text-xs">
          <TableHead />
          <tbody className="divide-y divide-gray-800">
            <LineRow label="現金" current={bs.cash} previous={prevBs?.cash} indent />
            <LineRow label="売掛金" current={bs.accountsReceivable} previous={prevBs?.accountsReceivable} indent />
            <LineRow label="原材料在庫" current={bs.rawMaterialInventory} previous={prevBs?.rawMaterialInventory} indent />
            <LineRow label="完成品在庫" current={bs.finishedGoodsInventory} previous={prevBs?.finishedGoodsInventory} indent />
            <LineRow label="その他流動資産" current={bs.otherCurrentAssets} previous={prevBs?.otherCurrentAssets} indent />
            <LineRow label="固定資産（純額）" current={bs.fixedAssetsNet} previous={prevBs?.fixedAssetsNet} indent />
            <LineRow label="建設仮勘定（設備投資中）" current={bs.constructionInProgress} previous={prevBs?.constructionInProgress} indent />
            <LineRow label="資産合計" current={bs.totalAssets} previous={prevBs?.totalAssets} bold />
          </tbody>
        </table>
      </div>
      <div>
        <div className="text-xs text-gray-400 mb-1">負債の部</div>
        <table className="min-w-full text-xs">
          <TableHead />
          <tbody className="divide-y divide-gray-800">
            <LineRow label="買掛金" current={bs.accountsPayable} previous={prevBs?.accountsPayable} indent />
            <LineRow label="短期借入金" current={bs.shortTermLoans} previous={prevBs?.shortTermLoans} indent />
            <LineRow label="長期借入金" current={bs.longTermLoans} previous={prevBs?.longTermLoans} indent />
            <LineRow label="未払利息" current={bs.accruedInterestPayable} previous={prevBs?.accruedInterestPayable} indent />
            <LineRow label="その他負債" current={bs.otherLiabilities} previous={prevBs?.otherLiabilities} indent />
            <LineRow label="負債合計" current={bs.totalLiabilities} previous={prevBs?.totalLiabilities} bold />
          </tbody>
        </table>
      </div>
      <div>
        <div className="text-xs text-gray-400 mb-1">純資産の部</div>
        <table className="min-w-full text-xs">
          <TableHead />
          <tbody className="divide-y divide-gray-800">
            <LineRow label="資本金" current={bs.capitalStock} previous={prevBs?.capitalStock} indent />
            <LineRow label="利益剰余金" current={bs.retainedEarnings} previous={prevBs?.retainedEarnings} indent />
            <LineRow label="純資産合計" current={bs.totalEquity} previous={prevBs?.totalEquity} bold />
            <LineRow label="負債・純資産合計" current={bs.totalLiabilitiesAndEquity} previous={prevBs?.totalLiabilitiesAndEquity} bold />
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Badge text={balanced ? "貸借一致 ✓" : "貸借不一致（要確認）"} tone={balanced ? "ok" : "danger"} />
        <span className="text-[11px] text-gray-500">貸借差額: {bs.balanceDifference.toLocaleString("en-US")} USD</span>
      </div>
      {current.negativeEquity && <Badge text="純資産マイナス（債務超過）" tone="danger" />}
      {current.cashShortfall && <Badge text={`現金不足（不足額 ${current.cashShortfallAmount.toLocaleString("en-US")} USD）`} tone="danger" />}
    </div>
  );
}
