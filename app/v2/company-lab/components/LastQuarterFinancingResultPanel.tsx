// ShrimpX V2 — INT-1 §2B: 前Turnの借入結果・緊急融資をPLAYER画面で確認できるようにする
//
// 【修正前の事実】申請額と承認・実行額の分離表示は FinancingTab.tsx に既にあったが、
// それを含む FinancialResultsSection は company-lab/play/[labId]（GM/開発者用の
// テストプレイ画面）だけが描画していた。Management Console内PLAYER と
// Independent Player のワークスペースへは lastQuarterFinancialResult（PL/BS/CF）しか
// 渡しておらず、借入審査の記録（FinancingQuarterResult）は未配線だった。
//
// 【このパネルがすること】既存の確定済み FinancingQuarterResult を**そのまま**表示する。
//   underwriting.requestedAmountUsd  申請額
//   underwriting.approvedAmountUsd   実行額
//   underwriting.deniedAmountUsd     減額・否認された額
//   underwriting.reasons             engineが記録した理由（文字列をそのまま出す）
//   emergencyLoan                    緊急融資の申請・実行・上限・適用金利・理由
// 金融ルール（審査・金利・上限の決め方）は一切変更しない。
//
// 【推測しない】記録が無い（この機能より前に保存されたRun等）場合は「未取得」と表示し、
// 借入残高の差から実行額や理由を逆算しない。

import { FinancingQuarterResult } from "../../../lib/v2/financing/types";
import CollapsibleSection from "./CollapsibleSection";

const UNKNOWN = "未取得";

const usd = (n: number | undefined): string =>
  n === undefined || !Number.isFinite(n) ? UNKNOWN : `${(n / 1e6).toFixed(2)}M USD`;

const percent = (rate: number | undefined): string =>
  rate === undefined || !Number.isFinite(rate) ? UNKNOWN : `年利 ${(rate * 100).toFixed(2)}%`;

export default function LastQuarterFinancingResultPanel(props: {
  readonly financingResult: FinancingQuarterResult | null | undefined;
  readonly testIdPrefix: string;
}) {
  const { financingResult, testIdPrefix } = props;

  if (!financingResult) {
    return (
      <CollapsibleSection
        title="前四半期の借入結果・緊急融資"
        description="前四半期の借入審査の記録です。"
        tone="info"
        testId={`${testIdPrefix}-financing-result-section`}
      >
        <p className="text-[11px] text-gray-400" data-testid={`${testIdPrefix}-financing-result-unavailable`}>
          この実行には前四半期の借入審査の記録がありません（{UNKNOWN}）。借入残高の差から実行額や理由を推測して表示することはしません。
        </p>
      </CollapsibleSection>
    );
  }

  const uw = financingResult.underwriting;
  const em = financingResult.emergencyLoan;
  const reduced = uw.deniedAmountUsd > 0;

  return (
    <CollapsibleSection
      title="前四半期の借入結果・緊急融資"
      description="前四半期に実際に実行された額と、減額・否認の理由です。申請額と実行額は別の値です。"
      tone="info"
      testId={`${testIdPrefix}-financing-result-section`}
      summaryRight={`申請 ${usd(uw.requestedAmountUsd)} → 実行 ${usd(uw.approvedAmountUsd)}`}
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]" data-testid={`${testIdPrefix}-financing-underwriting`}>
        <dt className="text-gray-400">申請額</dt>
        <dd className="text-right tabular-nums" data-testid={`${testIdPrefix}-financing-requested`}>
          {usd(uw.requestedAmountUsd)}
        </dd>
        <dt className="text-gray-400">実行額（承認され実際に借りられた額）</dt>
        <dd className="text-right font-semibold tabular-nums" data-testid={`${testIdPrefix}-financing-approved`}>
          {usd(uw.approvedAmountUsd)}
        </dd>
        <dt className="text-gray-400">減額・否認された額</dt>
        <dd className={`text-right tabular-nums ${reduced ? "text-amber-300" : ""}`} data-testid={`${testIdPrefix}-financing-denied`}>
          {usd(uw.deniedAmountUsd)}
        </dd>
        <dt className="text-gray-400">適用金利</dt>
        <dd className="text-right tabular-nums">{percent(uw.appliedAnnualRate)}</dd>
      </dl>

      <div className="mt-2">
        <h4 className="mb-1 text-[11px] font-semibold text-gray-300">記録されている理由</h4>
        {uw.reasons.length === 0 ? (
          <p className="text-[11px] text-gray-500" data-testid={`${testIdPrefix}-financing-reasons-empty`}>
            理由の記録はありません。
          </p>
        ) : (
          <ul className="list-disc pl-4 text-[11px] text-gray-300" data-testid={`${testIdPrefix}-financing-reasons`}>
            {uw.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 border-t border-gray-700/60 pt-2">
        <h4 className="mb-1 text-[11px] font-semibold text-gray-300">緊急融資</h4>
        {em === undefined ? (
          <p className="text-[11px] text-gray-400" data-testid={`${testIdPrefix}-emergency-loan-none`}>
            前四半期に緊急融資の記録はありません（実行されていません）。
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]" data-testid={`${testIdPrefix}-emergency-loan`}>
            <dt className="text-gray-400">実行有無</dt>
            <dd className="text-right" data-testid={`${testIdPrefix}-emergency-loan-executed`}>
              {em.approvedUsd > 0 ? "実行された" : "実行されなかった"}
            </dd>
            <dt className="text-gray-400">申請額</dt>
            <dd className="text-right tabular-nums">{usd(em.requestedUsd)}</dd>
            <dt className="text-gray-400">実行額</dt>
            <dd className="text-right font-semibold tabular-nums" data-testid={`${testIdPrefix}-emergency-loan-approved`}>
              {usd(em.approvedUsd)}
            </dd>
            <dt className="text-gray-400">適用金利</dt>
            <dd className="text-right tabular-nums" data-testid={`${testIdPrefix}-emergency-loan-rate`}>
              {percent(em.annualRate)}
            </dd>
            <dt className="text-gray-400">上限</dt>
            <dd className="text-right tabular-nums">{usd(em.capUsd)}</dd>
            <dt className="text-gray-400">理由</dt>
            <dd className="text-right">{em.reason}</dd>
          </dl>
        )}
      </div>

      {financingResult.financialHealth.usedEmergencyLoanThisPeriod ? (
        <p className="mt-2 text-[11px] text-amber-300" data-testid={`${testIdPrefix}-financing-used-emergency-badge`}>
          前四半期は緊急融資を利用しました（engineの財務健全性記録より）。
        </p>
      ) : null}
    </CollapsibleSection>
  );
}
