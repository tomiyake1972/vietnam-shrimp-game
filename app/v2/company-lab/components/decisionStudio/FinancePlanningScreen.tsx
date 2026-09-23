// ShrimpX V2 — Decision Studio: FINANCE（借入・任意期限前返済・既存借入情報・配当）
//
// 旧DecisionEditor.tsxの「資金調達（借入・返済）」CollapsibleSectionをそのまま移設。
// Projected Ending Cash相当の表示は行わない（ShrimpXの教育目的上、Player自身が
// 資金余力を判断する設計を維持する。自動の「最適配当額」やCash Forecastは作らない）。
//
// 【配当Decision UI接続】配当のsource of truthはfinance/dividend.ts
// （DividendDecisionInput { dividendAmountUsd }・resolveDividendDecision・
// computeMaxDividendUsd）であり、ここでは一切再計算しない。draft.dividendAmountUsd
// →（DecisionStudio外側のbuildDecisionInputFromDraft経由で）
// dividendDecision.dividendAmountUsdへ、既存の変換パスをそのまま使う
// （decisionDraft.tsは元から対応済みで、今回はUI欄を追加するだけ）。

import { CompanyDecisionDraft } from "../../decisionDraft";
import { DecisionStudioViewModel } from "../../decisionStudioViewModel";
import { CompanyFinancialQuarterResult } from "../../../../lib/v2/finance/types";
import { CompanyDividendQuarterResult } from "../../../../lib/v2/finance/dividend";
import { AnnualDividendGuidance } from "../../../../lib/v2/finance/annualDividendGuidance";
import CollapsibleSection from "../CollapsibleSection";
import { NumberCell } from "../InputCells";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, INPUT_CONTROL_CLASS } from "../panelStyles";

const LOAN_TYPE_LABELS: Record<CompanyDecisionDraft["financingRequest"]["desiredLoanType"], string> = {
  workingCapital: "運転資金",
  termLoan: "設備・長期資金",
  emergency: "緊急融資",
};

const REPAYMENT_METHOD_LABELS: Record<CompanyDecisionDraft["financingRequest"]["desiredRepaymentMethod"], string> = {
  bulletAtMaturity: "満期一括",
  equalPrincipal: "元金均等",
};

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function ratioPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

interface FinancePlanningScreenProps {
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  readonly vm: DecisionStudioViewModel;
  /** 前Turンの純利益表示用（意思決定には使わない、参考情報）。 */
  readonly lastQuarterFinancialResult?: CompanyFinancialQuarterResult | null;
  /** 直近確定Turンの配当結果（累積配当・却下理由の表示用）。 */
  readonly lastQuarterDividendResult?: CompanyDividendQuarterResult | null;
  /**
   * 【D1 §8】年度中の配当参考表示。管理者がバランス調整で配当性向を明示指定している場合、
   * その会社はQ4決算直後に自動精算される（Playerの追加操作は不要）。
   * 渡されなければ何も表示しない＝この機能より前とまったく同じ画面になる。
   */
  readonly annualDividendGuidance?: AnnualDividendGuidance | null;
}

export default function FinancePlanningScreen({ draft, onChange, disabled, vm, lastQuarterFinancialResult, lastQuarterDividendResult, annualDividendGuidance }: FinancePlanningScreenProps) {
  const {
    existingLoans,
    existingLoanBalanceUsd,
    accruedInterestPayableUsd,
    currentCashUsd,
    retainedEarningsUsd,
    maxDividendUsd,
    capexDraftThisQuarterPaymentUsd,
  } = vm;
  const dividendAmountUsd = draft.dividendAmountUsd ?? 0;
  const cumulativeDividendUsd = lastQuarterDividendResult?.cumulativeDividendUsd ?? 0;
  const lastQuarterNetIncomeUsd = lastQuarterFinancialResult?.profitAndLoss.netIncome as number | undefined;

  return (
    <div className="space-y-3" data-testid="decision-studio-finance-screen">
      <CollapsibleSection
        title="資金調達（借入・返済）"
        tone="input"
        testId="financing-section"
        summaryRight={`既存借入残高合計 ${formatUsd(existingLoanBalanceUsd)}`}
      >
        <div className="text-xs text-gray-400">
          既存借入残高合計 {formatUsd(existingLoanBalanceUsd)}
          {accruedInterestPayableUsd > 0 && <span className="ml-2">未払利息 {formatUsd(accruedInterestPayableUsd)}</span>}
        </div>
        {existingLoans.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-gray-300">
              <thead>
                <tr className={INFO_TABLE_HEAD_CLASS}>
                  <th className="pr-3 py-1">借入ID</th>
                  <th className="pr-3 py-1">種別</th>
                  <th className="pr-3 py-1">残高</th>
                  <th className="pr-3 py-1">年率</th>
                  <th className="pr-3 py-1">返済方式</th>
                  <th className="pr-3 py-1">満期</th>
                </tr>
              </thead>
              <tbody>
                {existingLoans.map((loan) => (
                  <tr key={loan.loanId} className={INFO_TABLE_ROW_CLASS}>
                    <td className="pr-3 py-1">{loan.loanId}</td>
                    <td className="pr-3 py-1">{LOAN_TYPE_LABELS[loan.loanType]}</td>
                    <td className="pr-3 py-1">{formatUsd(loan.currentPrincipalUsd)}</td>
                    <td className="pr-3 py-1">{(loan.annualInterestRate * 100).toFixed(2)}%</td>
                    <td className="pr-3 py-1">{REPAYMENT_METHOD_LABELS[loan.repaymentMethod]}</td>
                    <td className="pr-3 py-1">{loan.maturityPeriod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap gap-4 text-xs text-gray-300">
          <label className="flex flex-col gap-1">
            追加希望借入額(USD)
            <NumberCell
              value={draft.financingRequest.desiredAmountUsd}
              disabled={disabled}
              step={100000}
              onChange={(n) => onChange({ ...draft, financingRequest: { ...draft.financingRequest, desiredAmountUsd: n } })}
            />
          </label>
          <label className="flex flex-col gap-1">
            借入種別
            <select
              value={draft.financingRequest.desiredLoanType}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...draft, financingRequest: { ...draft.financingRequest, desiredLoanType: e.target.value as CompanyDecisionDraft["financingRequest"]["desiredLoanType"] } })
              }
              className={INPUT_CONTROL_CLASS}
            >
              <option value="workingCapital">運転資金</option>
              <option value="termLoan">設備・長期資金</option>
              <option value="emergency">緊急融資</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            希望期間(四半期)
            <NumberCell
              value={draft.financingRequest.desiredTermQuarters}
              disabled={disabled}
              onChange={(n) => onChange({ ...draft, financingRequest: { ...draft.financingRequest, desiredTermQuarters: Math.max(1, Math.round(n)) } })}
            />
          </label>
          <label className="flex flex-col gap-1">
            返済方式
            <select
              value={draft.financingRequest.desiredRepaymentMethod}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...draft,
                  financingRequest: { ...draft.financingRequest, desiredRepaymentMethod: e.target.value as CompanyDecisionDraft["financingRequest"]["desiredRepaymentMethod"] },
                })
              }
              className={INPUT_CONTROL_CLASS}
            >
              <option value="bulletAtMaturity">満期一括</option>
              <option value="equalPrincipal">元金均等</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            任意期限前返済希望額(USD)
            <NumberCell
              value={draft.financingRequest.desiredPrepaymentUsd}
              disabled={disabled}
              step={100000}
              warn={draft.financingRequest.desiredPrepaymentUsd > existingLoanBalanceUsd}
              onChange={(n) => onChange({ ...draft, financingRequest: { ...draft.financingRequest, desiredPrepaymentUsd: n } })}
            />
          </label>
          <label className="flex flex-col gap-1 justify-end">
            <span className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.financingRequest.emergencyAcceptable}
                disabled={disabled}
                onChange={(e) => onChange({ ...draft, financingRequest: { ...draft.financingRequest, emergencyAcceptable: e.target.checked } })}
                className="accent-sky-500"
              />
              緊急融資も許容する
            </span>
          </label>
        </div>
      </CollapsibleSection>

      {/* 【配当Decision UI接続】配当額の入力欄。engine truth（resolveDividendDecision・
          computeMaxDividendUsd）はそのままfinance/dividend.tsに残し、ここでは
          配当希望額をdraftへ入れるだけ。Projected Ending Cash・自動の「最適配当額」は
          作らない（Player自身が資金余力を判断する設計を維持する）。 */}
      <CollapsibleSection title="配当" tone="input" testId="dividend-section" summaryRight={`配当可能額 ${formatUsd(maxDividendUsd)}`}>
        <p className="text-xs text-gray-400">今Turンに株主へ支払う配当額を決定します。前Turンまでに確定した現金・分配可能利益が上限です。</p>

        {lastQuarterDividendResult?.rejected && lastQuarterDividendResult.rejectionReason && (
          <div className="bg-rose-950/50 border border-rose-700/60 text-rose-200 rounded-lg px-3 py-2 text-xs" data-testid="dividend-last-rejection">
            前Turンの配当は却下されました：{lastQuarterDividendResult.rejectionReason}
          </div>
        )}

        {annualDividendGuidance?.kind === "ADMIN_SPECIFIED" && (
          <div
            className="rounded-lg border border-sky-700/60 bg-sky-950/40 px-3 py-2 text-xs text-sky-100"
            data-testid="annual-dividend-guidance"
          >
            <p className="font-semibold" data-testid="annual-dividend-guidance-headline">
              {annualDividendGuidance.figures.targetYear}年度は管理者指定の配当性向{" "}
              {ratioPercent(annualDividendGuidance.figures.adminPayoutRatio)} が適用されます
            </p>
            <p className="mt-1 leading-snug text-sky-200/90">
              Q4決算直後に、その年度Q1〜Q4の当期純利益合計をもとに自動精算されます。追加操作は不要です
              （配当額欄へ入力しなくても精算されます）。
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              <div>
                <dt className="text-sky-300/80">年初来確定純利益（{annualDividendGuidance.figures.confirmedQuarterCount}四半期）</dt>
                <dd className="tabular-nums" data-testid="annual-dividend-guidance-ytd-net-income">
                  {annualDividendGuidance.figures.confirmedQuarterCount === 0
                    ? "－（確定実績なし）"
                    : formatUsd(annualDividendGuidance.figures.ytdNetIncomeUsd)}
                </dd>
              </div>
              <div>
                <dt className="text-sky-300/80">年初来実績ベース参考配当額</dt>
                <dd className="tabular-nums" data-testid="annual-dividend-guidance-reference-dividend">
                  {formatUsd(annualDividendGuidance.figures.ytdReferenceDividendUsd)}
                </dd>
              </div>
              <div>
                <dt className="text-sky-300/80">年初来支払済み配当</dt>
                <dd className="tabular-nums" data-testid="annual-dividend-guidance-ytd-paid">
                  {formatUsd(annualDividendGuidance.figures.ytdPaidDividendUsd)}
                </dd>
              </div>
              <div>
                <dt className="text-sky-300/80">現在残高ベースの参考支払可能額</dt>
                <dd className="tabular-nums" data-testid="annual-dividend-guidance-payable">
                  {formatUsd(annualDividendGuidance.figures.referencePayableUsd)}
                </dd>
              </div>
              <div>
                <dt className="text-sky-300/80">現在残高ベースの参考配当後Cash</dt>
                <dd className="tabular-nums" data-testid="annual-dividend-guidance-cash-after">
                  {formatUsd(annualDividendGuidance.figures.referenceCashAfterUsd)}
                </dd>
              </div>
            </dl>
            <p className="mt-2 leading-snug text-sky-300/80">
              これは<strong>年初来実績ベース参考額</strong>です。現在の確定実績と現在残高だけを使った参考値であり、
              Q4決算後の確定額とは異なる場合があります（まだ確定していない四半期の利益は含めていません）。
            </p>
          </div>
        )}
        {annualDividendGuidance?.kind === "NO_ADMIN_SETTING" && (
          <p className="text-xs text-gray-500" data-testid="annual-dividend-guidance-none">
            {annualDividendGuidance.targetYear}年度の配当性向は<strong>管理者指定なし</strong>です。
            年度末の自動精算は行われないため、配当する場合はこの画面で金額を指定してください。
          </p>
        )}
        {annualDividendGuidance?.kind === "UNKNOWN" && (
          <p className="text-xs text-gray-500" data-testid="annual-dividend-guidance-unknown">
            配当性向の管理者設定を確認できません（この機能より前に作成されたRunのため不明）。
          </p>
        )}

        {/* 【指示§5】dt/ddをdivで1組ずつ包む（HTML5のdl content modelが許可する形）。
            単純にdt/ddを並べてgrid-cols-3へ流すと、ペア数が列数の倍数でない場合に
            行の境目でラベルと値がずれ、別項目の値が別の見出しの下に来てしまう
            （実機確認で発見・修正）。1組=1 grid itemにすることでこれを構造的に防ぐ。 */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-gray-300 sm:grid-cols-3">
          <div>
            <dt className="text-gray-500">現在現金</dt>
            <dd className="tabular-nums" data-testid="dividend-info-cash">
              {formatUsd(currentCashUsd)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">利益剰余金</dt>
            <dd className="tabular-nums" data-testid="dividend-info-retained-earnings">
              {formatUsd(retainedEarningsUsd)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">有利子負債</dt>
            <dd className="tabular-nums" data-testid="dividend-info-debt">
              {formatUsd(existingLoanBalanceUsd)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">配当可能額（現金・分配可能利益の小さい方）</dt>
            <dd className="tabular-nums" data-testid="dividend-info-max-dividend">
              {formatUsd(maxDividendUsd)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">前Turン純利益</dt>
            <dd className="tabular-nums" data-testid="dividend-info-last-net-income">
              {lastQuarterNetIncomeUsd === undefined ? "－" : formatUsd(lastQuarterNetIncomeUsd)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">累積配当</dt>
            <dd className="tabular-nums" data-testid="dividend-info-cumulative">
              {formatUsd(cumulativeDividendUsd)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">今Turンの借入希望額</dt>
            <dd className="tabular-nums" data-testid="dividend-info-planned-borrowing">
              {formatUsd(draft.financingRequest.desiredAmountUsd)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">今Turンの早期返済希望額</dt>
            <dd className="tabular-nums" data-testid="dividend-info-planned-prepayment">
              {formatUsd(draft.financingRequest.desiredPrepaymentUsd)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">今Turンの設備投資支払予定</dt>
            <dd className="tabular-nums" data-testid="dividend-info-planned-capex">
              {formatUsd(capexDraftThisQuarterPaymentUsd)}
            </dd>
          </div>
        </dl>

        <label className="flex flex-col gap-1 text-xs text-gray-300">
          配当額(USD)
          <NumberCell
            value={dividendAmountUsd}
            disabled={disabled}
            step={100000}
            warn={dividendAmountUsd > maxDividendUsd}
            testId="dividend-amount-input"
            onChange={(n) => onChange({ ...draft, dividendAmountUsd: n })}
          />
        </label>
      </CollapsibleSection>
    </div>
  );
}
