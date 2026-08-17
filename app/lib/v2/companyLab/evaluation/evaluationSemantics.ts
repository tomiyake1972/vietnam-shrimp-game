// ShrimpX V2 — EVAL-1: 任意Turn評価サービスの基盤（実装指示§13-§24）
//
// 【この実装が満たすもの】
// §13: 「Turn16で終了しても・Turn23で終了しても・Turn32まで走っても、同じ評価
//   システムで評価できる」という要求を満たすため、この関数群は特定のTurn数を
//   一切前提としない。呼び出し側が渡した history 配列（何Turnぶんであっても）と
//   評価対象Turn（asOfTurn）だけから、その時点までの確定実績を集計する。
// §15/§16: Current Shareholder Value の正式な算定式はまだ決まっていない
//   （DCF・マルチプル等の企業価値モデルを独自判断で組み込むことを明示的に禁止
//   されている）。そのため currentShareholderValueUsd は常にnull・
//   shareholderValueModelVersion="pending-v1" の暫定プレースホルダーとし、
//   いかなるランキング・比較にも使わない。
// §17: Total Shareholder Value（= 将来的に weightedCumulativeDividendValueUsd +
//   currentShareholderValueUsd）も同じ理由でまだ計算しない
//   （totalShareholderValueStatus="not_finalized"）。
// §23: KPI基盤は「新しい巨大な集計システム」を作らず、既存の
//   CompanyQuarterRecord（financialResults・financingResults・
//   companySummaries・dividendResults）から組み立てるだけの純粋関数とする
//   （新しい永続化状態・新しい計算契約は一切追加しない）。
// §24: Awards（表彰）はこのPhaseでは正式スコア化しない。KPIを個別に読み出せる
//   形にするだけで、順位付け・受賞ロジックは実装しない。
//
// 【配当関連フィールドの出どころ】cumulativeDividendUsd・
// weightedCumulativeDividendValueUsdは、finance/dividend.tsが既に計算・
// CompanyQuarterRecord.dividendResultsへ保存済みの値をasOfTurn時点の直近確定
// レコードからそのまま読むだけであり、ここで再計算はしない
// （二重計算ロジックの禁止）。
//
// 【distressTurnCountの定義】financingResults[].financialHealth.primary
// （app/lib/v2/financing/types.ts）が既存のCrisis/財務健全性のSSoTであり、
// "healthy" 以外の値（watch/stressed/covenantBreach/paymentArrears/
// insolvent/paymentDefault）を記録したTurn数を数える。新しいCrisis状態は
// 導入しない。

import { CompanyId } from "../../sales/types";
import { CompanyQuarterRecord } from "../types";

export interface CompanyKpiSnapshot {
  readonly companyId: CompanyId;
  /** この評価が対象とする最終Turn（この値以下のTurnだけを集計する）。 */
  readonly asOfTurn: number;
  /** 実際に確定実績があった最初/最後のTurn（historyに1件も無ければ両方null）。 */
  readonly firstRecordedTurn: number | null;
  readonly lastRecordedTurn: number | null;
  readonly cumulativeOperatingProfitUsd: number;
  readonly cumulativeRevenueUsd: number;
  /** 販売実績数量の累計（fulfilledQuantity。単位はHosoEqTons由来のnumber）。 */
  readonly cumulativeSalesVolumeHosoEqTons: number;
  /** 平均営業利益率（cumulativeOperatingProfitUsd / cumulativeRevenueUsd）。売上0ならnull。 */
  readonly averageOperatingMarginRatio: number | null;
  readonly endingCashUsd: number | null;
  readonly endingDebtUsd: number | null;
  /**
   * 【暫定定義・§24未確定のためAwards用の正式指標ではない】直近確定Turnの売上高を
   * 最初の確定Turnの売上高と比較した成長率（(last-first)/|first|）。
   * どちらかが存在しない、またはfirstが0ならnull。
   */
  readonly revenueGrowthRatio: number | null;
  /** revenueGrowthRatioと同じ暫定定義を営業利益に適用したもの。 */
  readonly profitGrowthRatio: number | null;
  /** financialHealth.primaryが"healthy"以外だったTurn数（0〜asOfTurnの確定Turn数）。 */
  readonly distressTurnCount: number;
  /** asOfTurn時点までの累積配当額（finance/dividend.tsの確定値をそのまま読む）。 */
  readonly cumulativeDividendUsd: number;
}

export interface CompanyEvaluationSnapshot {
  readonly companyId: CompanyId;
  readonly asOfTurn: number;
  readonly kpis: CompanyKpiSnapshot;
  /** §11/§17: 時間加重配当価値の累積（finance/dividend.tsの確定値をそのまま読む）。 */
  readonly weightedCumulativeDividendValueUsd: number;
  /** §15/§16: 正式な算定式が決まるまでの暫定プレースホルダー。ランキングに使用禁止。 */
  readonly currentShareholderValueUsd: null;
  readonly shareholderValueModelVersion: "pending-v1";
  /** §17: 正式化するまでの暫定ステータス（totalShareholderValueUsdは常にnull）。 */
  readonly totalShareholderValueUsd: null;
  readonly totalShareholderValueStatus: "not_finalized";
}

function sumAt<T>(records: readonly CompanyQuarterRecord[], companyId: CompanyId, pick: (record: CompanyQuarterRecord) => T | undefined): T[] {
  const values: T[] = [];
  for (const record of records) {
    const value = pick(record);
    if (value !== undefined) values.push(value);
  }
  return values;
}

/**
 * companyIdの、asOfTurn以下のTurnだけに絞った確定履歴を集計してKPIスナップショットを返す。
 * historyが何Turnぶんであっても（Run全体が16Turnで終わっていても32Turn走っていても）、
 * 同じロジックで動く（§13）。
 */
export function computeCompanyKpiSnapshot(history: readonly CompanyQuarterRecord[], companyId: CompanyId, asOfTurn: number): CompanyKpiSnapshot {
  const scoped = history.filter((r) => r.turn <= asOfTurn).sort((a, b) => a.turn - b.turn);

  const financialResults = sumAt(scoped, companyId, (r) => r.financialResults.find((f) => f.companyId === companyId));
  const financingResultsScoped = sumAt(scoped, companyId, (r) => r.financingResults.find((f) => f.companyId === companyId));
  const summaries = sumAt(scoped, companyId, (r) => r.companySummaries.find((s) => s.companyId === companyId));
  const dividendResultsScoped = sumAt(scoped, companyId, (r) => (r.dividendResults ?? []).find((d) => d.companyId === companyId));

  const cumulativeOperatingProfitUsd = financialResults.reduce((sum, f) => sum + Number(f.profitAndLoss.operatingProfit), 0);
  const cumulativeRevenueUsd = financialResults.reduce((sum, f) => sum + Number(f.profitAndLoss.netRevenue), 0);
  const cumulativeSalesVolumeHosoEqTons = summaries.reduce((sum, s) => sum + Number(s.fulfilledQuantity), 0);
  const averageOperatingMarginRatio = cumulativeRevenueUsd !== 0 ? cumulativeOperatingProfitUsd / cumulativeRevenueUsd : null;

  const lastFinancial = financialResults[financialResults.length - 1] ?? null;
  const endingCashUsd = lastFinancial ? Number(lastFinancial.balanceSheet.cash) : null;
  const endingDebtUsd = lastFinancial ? Number(lastFinancial.balanceSheet.shortTermLoans) + Number(lastFinancial.balanceSheet.longTermLoans) : null;

  const firstRevenue = financialResults.length > 0 ? Number(financialResults[0].profitAndLoss.netRevenue) : null;
  const lastRevenue = financialResults.length > 0 ? Number(financialResults[financialResults.length - 1].profitAndLoss.netRevenue) : null;
  const revenueGrowthRatio = firstRevenue !== null && lastRevenue !== null && firstRevenue !== 0 ? (lastRevenue - firstRevenue) / Math.abs(firstRevenue) : null;

  const firstProfit = financialResults.length > 0 ? Number(financialResults[0].profitAndLoss.operatingProfit) : null;
  const lastProfit = financialResults.length > 0 ? Number(financialResults[financialResults.length - 1].profitAndLoss.operatingProfit) : null;
  const profitGrowthRatio = firstProfit !== null && lastProfit !== null && firstProfit !== 0 ? (lastProfit - firstProfit) / Math.abs(firstProfit) : null;

  const distressTurnCount = financingResultsScoped.filter((f) => f.financialHealth.primary !== "healthy").length;

  const lastDividend = dividendResultsScoped[dividendResultsScoped.length - 1] ?? null;
  const cumulativeDividendUsd = lastDividend ? lastDividend.cumulativeDividendUsd : 0;

  const recordedTurns = scoped.filter((r) => r.financialResults.some((f) => f.companyId === companyId)).map((r) => r.turn);

  return {
    companyId,
    asOfTurn,
    firstRecordedTurn: recordedTurns.length > 0 ? recordedTurns[0] : null,
    lastRecordedTurn: recordedTurns.length > 0 ? recordedTurns[recordedTurns.length - 1] : null,
    cumulativeOperatingProfitUsd,
    cumulativeRevenueUsd,
    cumulativeSalesVolumeHosoEqTons,
    averageOperatingMarginRatio,
    endingCashUsd,
    endingDebtUsd,
    revenueGrowthRatio,
    profitGrowthRatio,
    distressTurnCount,
    cumulativeDividendUsd,
  };
}

/**
 * companyIdの、asOfTurn時点の評価スナップショット（KPI＋加重配当価値＋
 * Current/Total Shareholder Valueの暫定プレースホルダー）を返す。
 * §13の要求どおり、Runが何Turnで終わっていても同じ関数で計算できる。
 */
export function computeCompanyEvaluationSnapshot(history: readonly CompanyQuarterRecord[], companyId: CompanyId, asOfTurn: number): CompanyEvaluationSnapshot {
  const kpis = computeCompanyKpiSnapshot(history, companyId, asOfTurn);
  const scoped = history.filter((r) => r.turn <= asOfTurn).sort((a, b) => a.turn - b.turn);
  const dividendResultsScoped = sumAt(scoped, companyId, (r) => (r.dividendResults ?? []).find((d) => d.companyId === companyId));
  const lastDividend = dividendResultsScoped[dividendResultsScoped.length - 1] ?? null;

  return {
    companyId,
    asOfTurn,
    kpis,
    weightedCumulativeDividendValueUsd: lastDividend ? lastDividend.cumulativeWeightedDividendValueUsd : 0,
    currentShareholderValueUsd: null,
    shareholderValueModelVersion: "pending-v1",
    totalShareholderValueUsd: null,
    totalShareholderValueStatus: "not_finalized",
  };
}

/** 複数社ぶんの評価スナップショットを一括で計算する（§14 End Game / GM画面向け）。 */
export function computeAllCompaniesEvaluationSnapshot(
  history: readonly CompanyQuarterRecord[],
  companyIds: readonly CompanyId[],
  asOfTurn: number
): readonly CompanyEvaluationSnapshot[] {
  return companyIds.map((companyId) => computeCompanyEvaluationSnapshot(history, companyId, asOfTurn));
}
