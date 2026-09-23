// ShrimpX V2 — 年度中の配当参考表示：確定履歴からの組み立て（D1 §8）
//
// 【責務】finance/annualDividendGuidance.ts（純粋な式）へ渡す入力を、
// 確定済みの四半期記録と当TurnのManual Balance設定から取り出すだけ。
// ここで新しい会計計算・予測は一切しない。
//
// 【なぜ engine の resolver をそのまま使うのか】画面に出す「管理者指定配当性向」が、
// 実際にQ4で適用される率と別経路で決まると、参考値と確定値が食い違う。
// 当Turnの率は runner.ts と同じ resolveManualBalanceForTurn /
// resolvedDividendPayoutRatio から取る。

import { toYearQuarter } from "../core/period";
import {
  AnnualDividendGuidance,
  AnnualDividendGuidanceQuarterFact,
  buildAnnualDividendGuidance,
} from "../finance/annualDividendGuidance";
import { unwrapUsd } from "../finance/types";
import { resolveManualBalanceForTurn, resolvedDividendPayoutRatio } from "./manualBalance/overrides";
import type { ManualBalanceSchedule } from "./manualBalance/overrides";
import type { CompanyLabState, CompanyQuarterRecord } from "./types";

export interface AnnualDividendGuidanceViewInput {
  readonly history: readonly CompanyQuarterRecord[];
  readonly currentPeriod: CompanyLabState["currentPeriod"];
  readonly turn: number;
  readonly companyId: string;
  readonly manualBalanceOverrides: ManualBalanceSchedule | undefined;
  /** 現在の現金残高（前Turnまでに確定した値）。 */
  readonly currentCashUsd: number;
  /** 現在の配当可能額 ＝ min(現金, 分配可能利益)。 */
  readonly dividendCapacityUsd: number;
}

/**
 * 対象年度のうち「既に確定した四半期だけ」を取り出す。
 * 未確定四半期を0で埋めない（埋めると年初来実績が実際より大きく見える）。
 */
function confirmedQuartersOfCurrentYear(
  history: readonly CompanyQuarterRecord[],
  targetYear: number,
  companyId: string
): readonly AnnualDividendGuidanceQuarterFact[] {
  const facts: AnnualDividendGuidanceQuarterFact[] = [];
  for (const record of history) {
    const { year, quarter } = toYearQuarter(record.period);
    if (year !== targetYear) continue;
    const financial = record.financialResults.find((f) => f.companyId === companyId);
    if (!financial) continue;
    facts.push({
      quarter,
      netIncomeUsd: unwrapUsd(financial.profitAndLoss.netIncome),
      appliedDividendUsd: record.dividendResults?.find((d) => d.companyId === companyId)?.appliedDividendUsd ?? 0,
    });
  }
  return facts;
}

export function buildAnnualDividendGuidanceView(input: AnnualDividendGuidanceViewInput): AnnualDividendGuidance {
  const { year } = toYearQuarter(input.currentPeriod);
  const resolved = resolveManualBalanceForTurn(input.manualBalanceOverrides, input.turn);
  return buildAnnualDividendGuidance({
    period: input.currentPeriod,
    adminPayoutRatio: resolvedDividendPayoutRatio(resolved),
    confirmedQuarters: confirmedQuartersOfCurrentYear(input.history, year, input.companyId),
    currentCashUsd: input.currentCashUsd,
    dividendCapacityUsd: input.dividendCapacityUsd,
  });
}
