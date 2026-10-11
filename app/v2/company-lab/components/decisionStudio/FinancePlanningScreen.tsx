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
import { FinancingQuarterResult } from "../../../../lib/v2/financing/types";
import LastQuarterFinancingResultPanel from "../LastQuarterFinancingResultPanel";
import { CompanyDividendQuarterResult } from "../../../../lib/v2/finance/dividend";
import { AnnualDividendGuidance } from "../../../../lib/v2/finance/annualDividendGuidance";
import CollapsibleSection from "../CollapsibleSection";
import { buildBorrowingCapacityGuide } from "../../borrowingCapacityGuide";
import { NumberCell } from "../InputCells";
import { ColumnHeader, InputFieldLabel } from "../FieldAnnotations";
import { humanizeFinanceReason } from "../../financeReasonText";
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
  /** 前ターンの純利益表示用（意思決定には使わない、参考情報）。 */
  readonly lastQuarterFinancialResult?: CompanyFinancialQuarterResult | null;
  /**
   * 【INT-1 §2B】前Turnの借入審査・緊急融資の確定記録。
   * 申請額と実行額は別の値であり、減額・否認理由もここに記録されている。
   * 記録が無いRunでは null/undefined のまま渡り、「未取得」と表示される。
   */
  readonly lastQuarterFinancingResult?: FinancingQuarterResult | null;
  /** 直近確定ターンの配当結果（累積配当・却下理由の表示用）。 */
  readonly lastQuarterDividendResult?: CompanyDividendQuarterResult | null;
  /**
   * 【D1 §8】年度中の配当参考表示。管理者がバランス調整で配当性向を明示指定している場合、
   * その会社はQ4決算直後に自動精算される（Playerの追加操作は不要）。
   * 渡されなければ何も表示しない＝この機能より前とまったく同じ画面になる。
   */
  readonly annualDividendGuidance?: AnnualDividendGuidance | null;
}

export default function FinancePlanningScreen({ draft, onChange, disabled, vm, lastQuarterFinancialResult, lastQuarterFinancingResult, lastQuarterDividendResult, annualDividendGuidance }: FinancePlanningScreenProps) {
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
      {/* 【INT-1 §2B】借入・配当を決める前に、前四半期に実際に実行された借入額と理由を見られるようにする。 */}
      <LastQuarterFinancingResultPanel financingResult={lastQuarterFinancingResult} testIdPrefix="finance" />
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
        {/* 【UI-CLARITY-1 A-7】いつ資金が入るかが画面のどこにも書かれていなかった。
            実際の順序は financing/liquidityClose.ts が決めている:
            当四半期の実績が確定したあとに審査と実行が行われ、実行額はその四半期の
            国内買付の資金として数えられる（computeProcurementConstraint が
            「前期末現金×配分比 ＋ 当期の承認実行額」を買付可能額にしている）。 */}
        {/* 【UI-CLARITY-1 A-1】申請する前に「いくらまで借りられそうか」と
            「何がその上限を決めているか」を出す。前四半期末の確定記録であり、
            今期の審査結果を約束するものではない（記録が無いTurnでは出さない）。 */}
        {(() => {
          const guide = buildBorrowingCapacityGuide(lastQuarterFinancingResult);
          if (guide === null) {
            return (
              <p className="text-[11px] text-gray-400" data-testid="borrowing-capacity-guide-unavailable">
                借入余力の記録がまだありません（前四半期の審査記録が無いため）。残高などから推測した額は表示しません。
              </p>
            );
          }
          return (
            <div
              className="rounded border border-gray-700/60 bg-gray-900/40 px-2 py-1 text-[11px] text-gray-200"
              data-testid="borrowing-capacity-guide"
            >
              <div className="font-semibold text-gray-100">
                借入余力の目安 <span className="font-normal text-gray-400">（前四半期末の記録。今期の審査を約束するものではありません）</span>
              </div>
              <dl className="mt-0.5 grid grid-cols-2 gap-x-4 gap-y-0.5">
                <dt className="text-gray-400">これ以上借りられるとされた額</dt>
                <dd className="text-right tabular-nums" data-testid="borrowing-capacity-available">
                  {formatUsd(guide.availableAdditionalCapacityUsd)}
                </dd>
                <dt className="text-gray-400">上限を決めている要因</dt>
                <dd className="text-right" data-testid="borrowing-capacity-binding">
                  {guide.bindingConstraintLabel}
                </dd>
                <dt className="text-gray-400">信用区分</dt>
                <dd className="text-right" data-testid="borrowing-capacity-tier">
                  {guide.creditTier}
                </dd>
              </dl>
              {guide.underwritingFrozen && (
                <p className="mt-0.5 text-rose-300" data-testid="borrowing-capacity-frozen">
                  新規の通常融資は現在停止しています。申請しても実行されません。
                </p>
              )}
              {guide.covenantBreach && (
                <p className="mt-0.5 text-amber-300" data-testid="borrowing-capacity-covenant">
                  財務制限条項に違反しているため、金利が上乗せされます。
                </p>
              )}
            </div>
          );
        })()}
        <p className="rounded border border-sky-800/60 bg-sky-950/30 px-2 py-1 text-[11px] text-sky-100" data-testid="financing-timing-note">
          <span className="font-semibold">いつ資金が入るか:</span>{" "}
          申請した四半期のうちに審査され、承認された額はその四半期の資金として使えます（翌四半期まで待つ必要はありません）。
          ただし審査は当四半期の業績が確定したあとに行われるため、<span className="font-semibold">実行額は申請額と異なることがあります</span>。
          国内買付に使える資金は「前四半期末の現金の一部 ＋ 今回実行された借入額」で決まります。
          実際に実行された額と理由は、次の四半期にこの画面の上部へ表示されます。
        </p>
        {existingLoans.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-gray-300">
              <thead>
                <tr className={INFO_TABLE_HEAD_CLASS}>
                  {/* 【UI-TRIAL-1 §4】この表はすべて読むだけ（今の借入の状態）。 */}
                  <th className="pr-3 py-1 align-bottom"><ColumnHeader name="借入ID" kind="current" testId="finance-col-loan-id" /></th>
                  <th className="pr-3 py-1 align-bottom"><ColumnHeader name="種別" kind="current" /></th>
                  <th className="pr-3 py-1 align-bottom"><ColumnHeader name="残高" kind="current" /></th>
                  <th className="pr-3 py-1 align-bottom"><ColumnHeader name="年率" kind="current" /></th>
                  <th className="pr-3 py-1 align-bottom"><ColumnHeader name="返済方式" kind="current" /></th>
                  <th className="pr-3 py-1 align-bottom"><ColumnHeader name="満期" kind="current" /></th>
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
          <div className="flex flex-col gap-1">
            <InputFieldLabel name="追加希望借入額" unit="USD" target="全社・当四半期">
              申請額です。銀行審査で減額・否認されることがあります（実行額ではありません）。
            </InputFieldLabel>
            <NumberCell
              value={draft.financingRequest.desiredAmountUsd}
              disabled={disabled}
              step={100000}
              testId="finance-desired-amount-input"
              ariaLabel="追加希望借入額（USD・全社）"
              onChange={(n) => onChange({ ...draft, financingRequest: { ...draft.financingRequest, desiredAmountUsd: n } })}
            />
          </div>
          <label className="flex flex-col gap-1">
            <InputFieldLabel name="借入種別" target="全社・当四半期" />
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
          <div className="flex flex-col gap-1">
            <InputFieldLabel name="希望期間" unit="四半期" target="全社・当四半期" />
            <NumberCell
              value={draft.financingRequest.desiredTermQuarters}
              disabled={disabled}
              testId="finance-desired-term-input"
              ariaLabel="借入の希望期間（四半期）"
              onChange={(n) => onChange({ ...draft, financingRequest: { ...draft.financingRequest, desiredTermQuarters: Math.max(1, Math.round(n)) } })}
            />
          </div>
          <label className="flex flex-col gap-1">
            <InputFieldLabel name="返済方式" target="全社・当四半期" />
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
          <div className="flex flex-col gap-1">
            <InputFieldLabel name="任意期限前返済希望額" unit="USD" target="全社・当四半期" />
            <NumberCell
              value={draft.financingRequest.desiredPrepaymentUsd}
              disabled={disabled}
              step={100000}
              warn={draft.financingRequest.desiredPrepaymentUsd > existingLoanBalanceUsd}
              testId="finance-prepayment-input"
              ariaLabel="任意の期限前返済希望額（USD）"
              onChange={(n) => onChange({ ...draft, financingRequest: { ...draft.financingRequest, desiredPrepaymentUsd: n } })}
            />
          </div>
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
        <p className="text-xs text-gray-400">今ターンに株主へ支払う配当額を決定します。前ターンまでに確定した現金・分配可能利益が上限です。</p>

        {lastQuarterDividendResult?.rejected && lastQuarterDividendResult.rejectionReason && (
          <div className="bg-rose-950/50 border border-rose-700/60 text-rose-200 rounded-lg px-3 py-2 text-xs" data-testid="dividend-last-rejection">
            前ターンの配当は却下されました：{humanizeFinanceReason(lastQuarterDividendResult.rejectionReason)}
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
            <dt className="text-gray-500">前ターン純利益</dt>
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
            <dt className="text-gray-500">今ターンの借入希望額</dt>
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

        <div className="flex flex-col gap-1 text-xs text-gray-300">
          <InputFieldLabel name="配当額（あなたの指示）" unit="USD" target="全社・当四半期">
            申請額です。配当可能額を超える場合は全額が拒否されます（実行額ではありません）。
          </InputFieldLabel>
          <NumberCell
            value={dividendAmountUsd}
            disabled={disabled}
            step={100000}
            warn={dividendAmountUsd > maxDividendUsd}
            testId="dividend-amount-input"
            ariaLabel="当四半期の配当額（USD・あなたの指示）"
            onChange={(n) => onChange({ ...draft, dividendAmountUsd: n })}
          />
        </div>
      </CollapsibleSection>
    </div>
  );
}
