// ShrimpX V2 — Company Lab 財務パネル 資金調達・信用力タブ
//
// FinancingQuarterResult（financing/liquidityClose.tsが既に計算・永続化済み）を
// そのまま表示するだけ。申請額（requestedAmountUsd）と承認・実行額
// （approvedAmountUsd）は別フィールドとして分けて表示し、否決・コベナンツ違反・
// 延滞理由は reasons / checks / arrearsEvents をそのまま列挙する（画面側での
// 判定ロジックの追加は行わない）。既存の借入残高一覧は ownState.financingState
// （DecisionEditor.tsxの資金調達セクションと同じデータソース）から表示する。

import { CompanyFinancingState } from "../../../../lib/v2/financing/types";
import { FinancingQuarterResult } from "../../../../lib/v2/financing/types";
import { formatUsd, formatRatioAsPercent } from "../../../../lib/v2/industryLab/ui/formatters";
import { Badge, NoDataNotice, ReasonList, TextRow } from "./financialTableParts";

interface Props {
  readonly current: FinancingQuarterResult | null;
  readonly previous: FinancingQuarterResult | null;
  readonly ownFinancingState: CompanyFinancingState;
}

const LOAN_TYPE_LABELS: Record<string, string> = {
  workingCapital: "運転資金",
  termLoan: "設備・長期資金",
  emergency: "緊急融資",
};

const HEALTH_TIER_LABELS: Record<string, { readonly label: string; readonly tone: "ok" | "warn" | "danger" }> = {
  healthy: { label: "健全", tone: "ok" },
  watch: { label: "要注意", tone: "warn" },
  stressed: { label: "財務ストレス", tone: "warn" },
  covenantBreach: { label: "コベナンツ違反", tone: "danger" },
  paymentArrears: { label: "延滞", tone: "danger" },
  insolvent: { label: "債務超過", tone: "danger" },
  paymentDefault: { label: "デフォルト", tone: "danger" },
};

export default function FinancingTab({ current, previous, ownFinancingState }: Props) {
  const existingLoans = ownFinancingState.loanPortfolio.loans.filter((l) => l.status !== "closed");
  const totalLoanBalance = existingLoans.reduce((sum, l) => sum + l.currentPrincipalUsd, 0);

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-400 mb-1">現在の借入残高（{ownFinancingState.companyId}）</div>
        <div className="text-sm text-gray-100 mb-2">
          合計 {formatUsd(totalLoanBalance)}
          {ownFinancingState.accruedInterestPayableUsd > 0 && `（うち未払利息 ${formatUsd(ownFinancingState.accruedInterestPayableUsd)}）`}
        </div>
        {existingLoans.length === 0 ? (
          <div className="text-xs text-gray-500">現在、有効な借入はありません。</div>
        ) : (
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-[11px] text-gray-500 border-b border-gray-700">
                <th className="text-left py-1 pr-3 font-normal">借入ID</th>
                <th className="text-left py-1 pr-3 font-normal">種別</th>
                <th className="text-right py-1 pr-3 font-normal">残高</th>
                <th className="text-right py-1 pr-3 font-normal">金利</th>
                <th className="text-left py-1 pr-3 font-normal">返済方法</th>
                <th className="text-left py-1 font-normal">満期</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {existingLoans.map((l) => (
                <tr key={l.loanId} className="text-gray-300">
                  <td className="py-1 pr-3">{l.loanId}</td>
                  <td className="py-1 pr-3">{LOAN_TYPE_LABELS[l.loanType] ?? l.loanType}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{formatUsd(l.currentPrincipalUsd)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{formatRatioAsPercent(l.annualInterestRate)}</td>
                  <td className="py-1 pr-3">{l.repaymentMethod === "bulletAtMaturity" ? "満期一括" : "元金均等"}</td>
                  <td className="py-1">{String(l.maturityPeriod)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!current ? (
        <NoDataNotice label="当期の資金繰り結果" />
      ) : (
        <>
          <div>
            <div className="text-xs text-gray-400 mb-1">信用スコア</div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm text-gray-100">
                {current.creditScore.score0to100.toFixed(1)}点（ティア {current.creditScore.tier}）
              </span>
              {previous && (
                <span className="text-[11px] text-gray-500">
                  前期: {previous.creditScore.score0to100.toFixed(1)}点（ティア {previous.creditScore.tier}）
                </span>
              )}
            </div>
            <table className="min-w-full text-xs">
              <thead>
                <tr className="text-[11px] text-gray-500 border-b border-gray-700">
                  <th className="text-left py-1 pr-3 font-normal">評価項目</th>
                  <th className="text-right py-1 pr-3 font-normal">正規化スコア</th>
                  <th className="text-right py-1 pr-3 font-normal">重み</th>
                  <th className="text-left py-1 font-normal">備考</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {current.creditScore.breakdown.map((b, idx) => (
                  <tr key={idx} className="text-gray-300">
                    <td className="py-1 pr-3">{b.factor}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{b.normalizedScore0to100.toFixed(1)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{(b.weight * 100).toFixed(0)}%</td>
                    <td className="py-1 text-gray-500">{b.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <div className="text-xs text-gray-400 mb-1">借入余力</div>
            <table className="min-w-full text-xs">
              <tbody className="divide-y divide-gray-800">
                <TextRow label="担保ベース上限" current={formatUsd(current.borrowingCapacity.collateralBasedLimitUsd)} />
                <TextRow label="収益ベース上限" current={formatUsd(current.borrowingCapacity.earningsBasedLimitUsd)} />
                <TextRow label="信用ティア上限" current={formatUsd(current.borrowingCapacity.creditTierCapUsd)} />
                <TextRow label="総枠（最小値）" current={formatUsd(current.borrowingCapacity.grossLimitUsd)} bold />
                <TextRow label="既存借入残高" current={formatUsd(current.borrowingCapacity.existingLoanBalanceUsd)} />
                <TextRow label="追加借入可能額" current={formatUsd(current.borrowingCapacity.availableAdditionalCapacityUsd)} bold />
                <TextRow label="拘束要因" current={current.borrowingCapacity.bindingConstraint} />
              </tbody>
            </table>
            {current.borrowingCapacity.underwritingFrozen && <Badge text="銀行審査が凍結中" tone="danger" />}
          </div>

          <div>
            <div className="text-xs text-gray-400 mb-1">当期の借入審査結果</div>
            <table className="min-w-full text-xs">
              <tbody className="divide-y divide-gray-800">
                <TextRow label="申請額" current={formatUsd(current.underwriting.requestedAmountUsd)} />
                <TextRow label="承認・実行額" current={formatUsd(current.underwriting.approvedAmountUsd)} bold />
                <TextRow label="否決額" current={formatUsd(current.underwriting.deniedAmountUsd)} />
                <TextRow label="適用年利率" current={formatRatioAsPercent(current.underwriting.appliedAnnualRate)} />
                <TextRow label="返済方法" current={current.underwriting.repaymentMethod === "bulletAtMaturity" ? "満期一括" : "元金均等"} />
              </tbody>
            </table>
            <ReasonList reasons={current.underwriting.reasons} />
          </div>

          <div>
            <div className="text-xs text-gray-400 mb-1">コベナンツ（財務制限条項）チェック</div>
            <div className="mb-1">
              <Badge text={current.covenant.anyBreach ? "違反あり" : "違反なし"} tone={current.covenant.anyBreach ? "danger" : "ok"} />
            </div>
            <table className="min-w-full text-xs">
              <thead>
                <tr className="text-[11px] text-gray-500 border-b border-gray-700">
                  <th className="text-left py-1 pr-3 font-normal">条項</th>
                  <th className="text-right py-1 pr-3 font-normal">基準値</th>
                  <th className="text-right py-1 pr-3 font-normal">実績値</th>
                  <th className="text-left py-1 font-normal">判定</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {current.covenant.checks.map((chk, idx) => (
                  <tr key={idx} className="text-gray-300">
                    <td className="py-1 pr-3">{chk.name}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{chk.requiredValue.toFixed(2)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{chk.actualValue.toFixed(2)}</td>
                    <td className="py-1">{chk.breached ? <Badge text="違反" tone="danger" /> : <Badge text="適合" tone="ok" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <div className="text-xs text-gray-400 mb-1">財務健全性・延滞・緊急融資</div>
            <div className="flex flex-wrap gap-2 mb-2">
              <Badge
                text={HEALTH_TIER_LABELS[current.financialHealth.primary]?.label ?? current.financialHealth.primary}
                tone={HEALTH_TIER_LABELS[current.financialHealth.primary]?.tone ?? "neutral"}
              />
              {current.financialHealth.usedEmergencyLoanThisPeriod && <Badge text="当期に緊急融資を利用" tone="warn" />}
              {current.financialHealth.consecutiveArrearsQuarters > 0 && (
                <Badge text={`延滞継続 ${current.financialHealth.consecutiveArrearsQuarters}四半期`} tone="danger" />
              )}
              {current.financialHealth.consecutiveCovenantBreachQuarters > 0 && (
                <Badge text={`コベナンツ違反継続 ${current.financialHealth.consecutiveCovenantBreachQuarters}四半期`} tone="danger" />
              )}
            </div>
            {current.arrearsEvents.length > 0 && (
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="text-[11px] text-gray-500 border-b border-gray-700">
                    <th className="text-left py-1 pr-3 font-normal">借入ID</th>
                    <th className="text-left py-1 pr-3 font-normal">区分</th>
                    <th className="text-right py-1 font-normal">延滞額</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {current.arrearsEvents.map((e, idx) => (
                    <tr key={idx} className="text-gray-300">
                      <td className="py-1 pr-3">{e.loanId}</td>
                      <td className="py-1 pr-3">{e.kind === "interest" ? "利息" : "元本"}</td>
                      <td className="py-1 text-right tabular-nums">{formatUsd(e.amountUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {current.emergencyLoan && (
              <div className="text-xs text-amber-200 mt-1">
                緊急融資: 申請 {formatUsd(current.emergencyLoan.requestedUsd)} / 承認 {formatUsd(current.emergencyLoan.approvedUsd)}（上限 {formatUsd(current.emergencyLoan.capUsd)}、年利
                {formatRatioAsPercent(current.emergencyLoan.annualRate)}） — {current.emergencyLoan.reason}
              </div>
            )}
            {current.procurementConstraint && (
              <div className="text-xs text-amber-200 mt-1">
                資金制約による調達縮小: 計画 {current.procurementConstraint.originalDomesticPurchaseQuantityTons.toLocaleString("en-US")}トン → 実行{" "}
                {current.procurementConstraint.constrainedDomesticPurchaseQuantityTons.toLocaleString("en-US")}トン（縮小率{" "}
                {formatRatioAsPercent(1 - current.procurementConstraint.scaleRatio)}） — {current.procurementConstraint.reason}
                {current.procurementConstraint.importOrdersBlocked && "／輸入発注も停止"}
              </div>
            )}
          </div>

          <div className="text-[11px] text-gray-500">
            当期利払 {formatUsd(current.interestPaidCashUsd)} / 当期元本返済 {formatUsd(current.principalPaidCashUsd)} / 当期新規借入 {formatUsd(current.loanDrawUsd)} / 期末短期借入{" "}
            {formatUsd(current.endingShortTermLoansUsd)} / 期末長期借入 {formatUsd(current.endingLongTermLoansUsd)} / 期末未払利息 {formatUsd(current.endingAccruedInterestPayableUsd)}
          </div>
        </>
      )}
    </div>
  );
}
