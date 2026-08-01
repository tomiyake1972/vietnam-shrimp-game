// ShrimpX V2 — Company Lab 手動観察テスト向け追加パネル
//
// 【追加の経緯】三宅さんの手動観察テストで、turn 1（初回の意思決定前）は
// 「直近の四半期結果」セクション自体が存在せず、貸借対照表（現金・借入余力・
// AR・AP等）が画面のどこにも一括表示されないという指摘を受けた。既存の
// DecisionEditor内には現金等の断片的な参照値が意思決定領域ごとに散在しているが、
// 会社の期首状態をひとめで把握できる場所がなかったため、Standard AIの判断ロジック
// 本体には一切触れず、既存のCompanyOwnState（前四半期末までの状態、真実の唯一の
// ソース）をそのまま転記するだけの、読み取り専用の要約パネルを追加する。
//
// 値の再計算・見積りは一切行わない（既存フィールドの単純な合計・件数のみ）。

import { CompanyOwnState } from "../../../lib/v2/companyLab/types";

export interface OpeningCompanyStatePanelProps {
  readonly ownState: CompanyOwnState;
  readonly turn: number;
}

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function formatTons(value: number): string {
  return `${Math.round(value * 10) / 10} t`;
}

export default function OpeningCompanyStatePanel({ ownState, turn }: OpeningCompanyStatePanelProps) {
  const cashUsd = ownState.financeState.cash as number;
  const receivablesTotalUsd = ownState.financeState.receivables.reduce((sum, r) => sum + (r.amount as number), 0);
  const payablesTotalUsd = ownState.financeState.payables.reduce((sum, p) => sum + (p.amount as number), 0);
  const retainedEarningsUsd = ownState.financeState.retainedEarnings as number;

  const activeLoans = ownState.financingState.loanPortfolio.loans.filter((l) => l.status !== "closed");
  const loanBalanceUsd = activeLoans.reduce((sum, l) => sum + l.currentPrincipalUsd, 0);
  const accruedInterestPayableUsd = ownState.financingState.accruedInterestPayableUsd;

  const backlogTons = ownState.contracts.reduce((sum, c) => sum + (c.outstandingQuantity as number), 0);
  const rawMaterialTons = ownState.rawMaterialLots.reduce((sum, lot) => sum + (lot.remainingQuantity as number), 0);
  const finishedGoodsTons = ownState.finishedGoodsLots.reduce((sum, lot) => sum + (lot.remainingQuantity as number), 0);

  const items: ReadonlyArray<{ label: string; value: string }> = [
    { label: "現金", value: formatUsd(cashUsd) },
    { label: "売掛金（AR）合計", value: `${formatUsd(receivablesTotalUsd)}（${ownState.financeState.receivables.length}件）` },
    { label: "買掛金（AP）合計", value: `${formatUsd(payablesTotalUsd)}（${ownState.financeState.payables.length}件）` },
    { label: "借入残高（元本合計）", value: `${formatUsd(loanBalanceUsd)}（${activeLoans.length}件）` },
    { label: "未払利息", value: formatUsd(accruedInterestPayableUsd) },
    { label: "利益剰余金", value: formatUsd(retainedEarningsUsd) },
    { label: "受注残（未履行契約）", value: formatTons(backlogTons) },
    { label: "原料在庫", value: formatTons(rawMaterialTons) },
    { label: "完成品在庫", value: formatTons(finishedGoodsTons) },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
      <p className="col-span-full text-xs text-gray-400">
        turn {turn} 開始時点（前四半期末までの確定値。借入余力の上限は当期の銀行審査結果として四半期処理後に判明する）。
      </p>
      {items.map((item) => (
        <div key={item.label} className="flex justify-between sm:block">
          <span className="text-gray-400">{item.label}</span>
          <span className="sm:block font-medium">{item.value}</span>
        </div>
      ))}
    </div>
  );
}
