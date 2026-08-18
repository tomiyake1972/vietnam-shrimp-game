// ShrimpX V2 — AI Management Meeting: Finance Semantics（AMM-M2.2）
//
// 【背景・root cause】Test26 BAL Turn1で、CommercialのHealthy Forward Backlogに関する
// 誤発言（M2.1で修正済み）を受け、CFOがさらに「Trust低下→売掛金回収遅延→投資余力減」
// という、engineに存在しない因果を連鎖的に補完してしまった。この根本原因は、
// CFO向けbriefingに「売掛金がいつ・いくら現金化されるか」という実在するengineの事実
// （ReceivableRecord.dueSettlementPeriod）が一切渡っておらず、CFOが一般的な企業会計の
// 常識（Trustが下がれば入金が遅れる、というのはShrimpXには存在しないルール）で
// 空白を埋めてしまったことにある。
//
// 【AR回収ルールの監査結果（変更しない。既存の事実を渡すだけ）】
// app/lib/v2/finance/quarterClose.ts（売掛金・買掛金の決済と新規発生セクション）を
// 監査した結果:
//   - 売掛金はparams.workingCapital.arCollectionQuarters（finance/parameters.ts、
//     現在値=1）四半期後に、市場・商品・Trustの値によらず一律decisive collectする
//     （dueSettlementPeriod = 発生期 + arCollectionQuarters）。
//   - 買掛金（輸入原料）も同様にapImportPaymentQuarters（現在値=1）四半期後に決済。
//   - Customer Trust・delivery reliabilityがAR回収タイミングに影響するロジックは
//     存在しない（quarterClose.tsのAR決済処理はdueSettlementPeriod <= periodの
//     単純フィルタのみで、trustScoreを一切参照しない）。
//   - ReceivableRecord型自体にarrears（延滞）フィールドは存在しない（LoanRecordには
//     arrearsPrincipalUsd/arrearsInterestUsdがあるが、これは融資の返済延滞専用で、
//     売掛金の貸し倒れ・回収遅延とは別の仕組み）。bad debt / late payment mechanicは
//     売掛金には実装されていない。
// この監査結果に基づき、CFO向けbriefingには「AR残高」と「AR回収予定（実在する
// dueSettlementPeriodから導出）」を分離して渡す（§5・§7・§16対応）。engine自体は
// 一切変更しない。

import { toYearQuarter } from "../../core/period";
import { PayableRecord, ReceivableRecord } from "../../finance/types";
import { LoanRecord } from "../../financing/types";
import { CapitalProject } from "../../capex/types";
import { isActiveStatus } from "../../capex/projectLifecycle";

export interface ScheduleEntry {
  readonly periodLabel: string;
  readonly amountUsd: number;
  /** 現在turnから何四半期後か（0=当四半期中に決済、1=来期、…）。負値にはならない想定（決済済みは既にreceivables配列から除外されている）。 */
  readonly turnsFromNow: number;
}

export interface FinanceSemantics {
  readonly receivablesTotalUsd: number;
  /** 【§5・§16】AR残高とcollection scheduleを分離。既存ReceivableRecord.dueSettlementPeriodのみから導出（新しい回収ルールは作らない）。 */
  readonly receivablesScheduleByPeriod: readonly ScheduleEntry[];
  readonly payablesTotalUsd: number;
  readonly payablesScheduleByPeriod: readonly ScheduleEntry[];
  /** 【§5監査結果】売掛金自体にはarrearsフィールドが存在しない。融資の延滞のみ、この2値で表す。 */
  readonly loanArrearsPrincipalUsd: number;
  readonly loanArrearsInterestUsd: number;
  /** 承認済みだが未払（cumulativePaidUsd未満）の設備投資コミット残高合計（既存CapitalProject.approvedBudgetUsd/cumulativePaidUsdの単純な差分合計。新しい支払スケジュール予測はしない）。 */
  readonly activeCapexRemainingCommitmentUsd: number;
}

const TOP_N_SCHEDULE_ENTRIES = 4;

function periodIndexOf(p: ReceivableRecord["dueSettlementPeriod"]): number {
  const yq = toYearQuarter(p);
  return yq.year * 4 + yq.quarter;
}

function buildSchedule(records: readonly { readonly amount: number; readonly dueSettlementPeriod: ReceivableRecord["dueSettlementPeriod"] }[], currentPeriodIdx: number): readonly ScheduleEntry[] {
  const byPeriod = new Map<string, { amountUsd: number; periodIdx: number; label: string }>();
  for (const r of records) {
    const periodIdx = periodIndexOf(r.dueSettlementPeriod);
    const yq = toYearQuarter(r.dueSettlementPeriod);
    const label = `${yq.year}年Q${yq.quarter}`;
    const existing = byPeriod.get(label);
    if (existing) existing.amountUsd += r.amount;
    else byPeriod.set(label, { amountUsd: r.amount, periodIdx, label });
  }
  return Array.from(byPeriod.values())
    .sort((a, b) => a.periodIdx - b.periodIdx)
    .slice(0, TOP_N_SCHEDULE_ENTRIES)
    .map((e) => ({ periodLabel: e.label, amountUsd: e.amountUsd, turnsFromNow: Math.max(0, e.periodIdx - currentPeriodIdx) }));
}

export function computeFinanceSemantics(
  receivables: readonly ReceivableRecord[],
  payables: readonly PayableRecord[],
  loans: readonly LoanRecord[],
  capexProjects: readonly CapitalProject[],
  companyId: string,
  currentYear: number,
  currentQuarter: number
): FinanceSemantics {
  const currentPeriodIdx = currentYear * 4 + currentQuarter;
  const ownReceivables = receivables.filter((r) => r.companyId === companyId);
  const ownPayables = payables.filter((p) => p.companyId === companyId);
  const ownLoans = loans.filter((l) => l.companyId === companyId);
  const ownCapexProjects = capexProjects.filter((p) => p.companyId === companyId);

  return {
    receivablesTotalUsd: ownReceivables.reduce((s, r) => s + (r.amount as unknown as number), 0),
    receivablesScheduleByPeriod: buildSchedule(
      ownReceivables.map((r) => ({ amount: r.amount as unknown as number, dueSettlementPeriod: r.dueSettlementPeriod })),
      currentPeriodIdx
    ),
    payablesTotalUsd: ownPayables.reduce((s, p) => s + (p.amount as unknown as number), 0),
    payablesScheduleByPeriod: buildSchedule(
      ownPayables.map((p) => ({ amount: p.amount as unknown as number, dueSettlementPeriod: p.dueSettlementPeriod })),
      currentPeriodIdx
    ),
    loanArrearsPrincipalUsd: ownLoans.reduce((s, l) => s + l.arrearsPrincipalUsd, 0),
    loanArrearsInterestUsd: ownLoans.reduce((s, l) => s + l.arrearsInterestUsd, 0),
    activeCapexRemainingCommitmentUsd: ownCapexProjects
      .filter((p) => isActiveStatus(p.status))
      .reduce((s, p) => s + Math.max(0, p.approvedBudgetUsd - p.cumulativePaidUsd), 0),
  };
}
