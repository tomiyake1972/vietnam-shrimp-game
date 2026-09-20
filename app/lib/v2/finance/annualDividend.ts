// ShrimpX V2 — 年間純利益ベース配当（Annual Net-Income-Based Dividend Settlement）
//
// 【確定仕様】配当は「Q4に、直前Q3の純利益 × 配当性向」ではなく、
// 「Q4決算後に、同年度Q1〜Q4の税引後純利益合計 × 配当性向を年間目標として精算」する。
//
// 【なぜ配当率の嵩上げで代用しないのか】旧実装は
//   baseDividend = max(0, 直近確定四半期の純利益) × payoutRatio
// であり、Q4の意思決定時点で参照できる「直近確定四半期」は同年Q3である。
// つまり実質「Q3純利益 × 配当性向」であり、年間の1/4しか基準にしていない。
// これを率で補正すると、四半期ごとの利益の偏り（季節性・一時費用）がそのまま
// 配当額の歪みになる。計算契約そのものを年間基準へ直す。
//
// 【このモジュールは純粋関数しか持たない】会計仕訳・Cash減額・BS更新は行わない。
// 実際の支払は既存の finance/dividend.ts（resolveDividendDecision /
// applyDividendToFinanceState）と runner.ts の経路をそのまま通る。
// ここで新しい資金制約・新しい借入・新しい救済措置を作らない。

import { PeriodV2, toYearQuarter } from "../core/period";
import { CompanyFinancialQuarterResult, unwrapUsd, usd } from "./types";

/** 1年度の四半期数。年度の区切りは既存のPeriodV2（年+四半期）表現だけで決める。 */
export const FISCAL_QUARTERS_PER_YEAR = 4;

const EPS_USD = 1e-6;

/** 配当性向がどこから来たか。金額指定（PLAYER）は「率」ではないので混同しない。 */
export type DividendPayoutRatioSource =
  /** Management Console の手動バランス調整で管理者が明示指定した率。 */
  | "MANUAL_OVERRIDE"
  /** Standard AI の実効配当性向（既定値＋経営性格バイアス）。 */
  | "STANDARD_AI";

/** 年間精算が実行できなかった理由。推測で0を埋めないために必ず理由を残す。 */
export type AnnualDividendUnavailableReason =
  /** 対象年度のQ1〜Q4のうち確定済み四半期が揃っていない（0補完しない）。 */
  | "INCOMPLETE_FISCAL_YEAR"
  /** 年間純利益・既支払配当に有限でない数値が混ざっている。 */
  | "INVALID_FINANCIAL_INPUT";

/** 年間目標に届かなかった理由。 */
export type AnnualDividendShortfallReason =
  /** 現金が足りない。 */
  | "CASH_LIMIT"
  /** 分配可能利益が足りない。 */
  | "DISTRIBUTABLE_EARNINGS_LIMIT"
  /** Standard AI の安全gate（財務健全性・Crisis・当期CAPEX等）で配当自体を見送った。 */
  | "POLICY_GATE"
  /** 年間利益を確定できなかった。 */
  | "SETTLEMENT_UNAVAILABLE";

/** 対象年度の1四半期ぶんの確定実績（netIncomeと、その四半期に実際に支払った配当）。 */
export interface AnnualQuarterFact {
  readonly turn: number;
  readonly period: PeriodV2;
  readonly quarter: 1 | 2 | 3 | 4;
  readonly netIncomeUsd: number;
  /** その四半期に実際に支払われた配当（Player金額指定ぶんを含む実支払額）。 */
  readonly appliedDividendUsd: number;
}

export type AnnualDividendAggregation =
  | {
      readonly available: true;
      readonly year: number;
      readonly quarters: readonly AnnualQuarterFact[];
      /** Q1〜Q4の符号付き合計。赤字四半期もそのまま加える（黒字だけ抽出しない）。 */
      readonly annualNetIncomeUsd: number;
      /** 同年度に既に実際に支払った配当の合計（実支払額のみ。設定値から推測しない）。 */
      readonly paidDividendEarlierInYearUsd: number;
    }
  | {
      readonly available: false;
      readonly year: number;
      readonly reason: AnnualDividendUnavailableReason;
      /** 欠落している四半期番号（INCOMPLETE_FISCAL_YEARのとき）。 */
      readonly missingQuarters: readonly number[];
      readonly quarters: readonly AnnualQuarterFact[];
    };

/**
 * 対象年度のQ1〜Q4の確定実績を集計する。
 *
 * 【0補完しない】1四半期でも欠落していたら available:false を返す。
 * 「欠落＝利益0」とみなして支払を実行することはしない（実装指示§10）。
 *
 * 【入力は確定実績のみ】呼び出し側は、state.history に確定済みの四半期と、
 * 当Turn（Q4）に決算で確定したばかりの四半期を合わせて渡す。
 * ここで Operating Profit や Cash Flow を Net Income の代用にしてはならない。
 */
export function aggregateAnnualDividendFacts(params: {
  readonly year: number;
  readonly facts: readonly AnnualQuarterFact[];
}): AnnualDividendAggregation {
  const { year } = params;
  // 同一四半期が複数渡された場合は、後から確定した側（turnが大きい方）を採用する。
  const byQuarter = new Map<number, AnnualQuarterFact>();
  for (const fact of params.facts) {
    const existing = byQuarter.get(fact.quarter);
    if (!existing || fact.turn >= existing.turn) byQuarter.set(fact.quarter, fact);
  }
  const quarters = [...byQuarter.values()].sort((a, b) => a.quarter - b.quarter);

  const missingQuarters: number[] = [];
  for (let q = 1; q <= FISCAL_QUARTERS_PER_YEAR; q++) {
    if (!byQuarter.has(q)) missingQuarters.push(q);
  }
  if (missingQuarters.length > 0) {
    return { available: false, year, reason: "INCOMPLETE_FISCAL_YEAR", missingQuarters, quarters };
  }

  let annualNetIncomeUsd = 0;
  let paidDividendEarlierInYearUsd = 0;
  for (const fact of quarters) {
    if (!Number.isFinite(fact.netIncomeUsd) || !Number.isFinite(fact.appliedDividendUsd)) {
      return { available: false, year, reason: "INVALID_FINANCIAL_INPUT", missingQuarters: [], quarters };
    }
    // 【符号付き合計】赤字四半期もそのまま加算する。黒字四半期だけを抽出しない。
    annualNetIncomeUsd += fact.netIncomeUsd;
    paidDividendEarlierInYearUsd += fact.appliedDividendUsd;
  }

  return { available: true, year, quarters, annualNetIncomeUsd, paidDividendEarlierInYearUsd };
}

/** 年間精算の計算結果（金額の確定のみ。会計仕訳はしない）。 */
export interface AnnualDividendSettlement {
  readonly year: number;
  readonly annualNetIncomeUsd: number;
  readonly appliedPayoutRatio: number;
  readonly payoutRatioSource: DividendPayoutRatioSource;
  /** max(0, 年間純利益) × 配当性向。年間純利益<=0なら0。 */
  readonly annualDividendTargetUsd: number;
  /** 同年度に既に実際に支払った配当の合計。 */
  readonly paidDividendEarlierInYearUsd: number;
  /** max(0, 年間目標 − 既支払)。既払い超過でもマイナスにはせず、返還もしない。 */
  readonly yearEndAdditionalTargetUsd: number;
  /** 既存の配当可能上限 min(Cash, 分配可能利益)。ここを緩めない。 */
  readonly maxDividendUsd: number;
  /** 実際に支払う年末追加配当。 */
  readonly appliedDividendUsd: number;
  /** 年間目標に届かなかった額。 */
  readonly annualDividendShortfallUsd: number;
  readonly shortfallReason: AnnualDividendShortfallReason | null;
}

/**
 * 年間配当目標と年末追加支払額を確定する（純粋関数）。
 *
 * 【既存の資金制約を緩めない】上限は呼び出し側が computeMaxDividendUsd
 * （= min(Cash, 分配可能利益)）で計算した値をそのまま受け取る。
 * ここで自動借入・緊急融資・特別救済・翌年繰越・強制配当は一切行わない。
 *
 * 【目標と上限を分けて記録する】年間目標（yearEndAdditionalTargetUsd）と
 * 実支払（appliedDividendUsd）を別フィールドとして残し、未達なら理由を付ける。
 */
export function computeAnnualDividendSettlement(params: {
  readonly year: number;
  readonly annualNetIncomeUsd: number;
  readonly appliedPayoutRatio: number;
  readonly payoutRatioSource: DividendPayoutRatioSource;
  readonly paidDividendEarlierInYearUsd: number;
  readonly maxDividendUsd: number;
  readonly availableCashUsd: number;
  readonly distributableEarningsUsd: number;
}): AnnualDividendSettlement {
  const {
    year,
    annualNetIncomeUsd,
    appliedPayoutRatio,
    payoutRatioSource,
    paidDividendEarlierInYearUsd,
    maxDividendUsd,
    availableCashUsd,
    distributableEarningsUsd,
  } = params;

  // 【年間純利益 <= 0 は無配】既に支払った配当の返還はしない。
  const annualDividendTargetUsd = Math.max(0, annualNetIncomeUsd) * appliedPayoutRatio;
  const yearEndAdditionalTargetUsd = Math.max(0, annualDividendTargetUsd - paidDividendEarlierInYearUsd);
  const appliedDividendUsd = Math.max(0, Math.min(yearEndAdditionalTargetUsd, maxDividendUsd));
  const annualDividendShortfallUsd = Math.max(0, yearEndAdditionalTargetUsd - appliedDividendUsd);

  let shortfallReason: AnnualDividendShortfallReason | null = null;
  if (annualDividendShortfallUsd > EPS_USD) {
    // 何が上限を決めたのかを区別する（現金か分配可能利益か）。
    shortfallReason = availableCashUsd <= distributableEarningsUsd + EPS_USD ? "CASH_LIMIT" : "DISTRIBUTABLE_EARNINGS_LIMIT";
  }

  return {
    year,
    annualNetIncomeUsd,
    appliedPayoutRatio,
    payoutRatioSource,
    annualDividendTargetUsd,
    paidDividendEarlierInYearUsd,
    yearEndAdditionalTargetUsd,
    maxDividendUsd,
    appliedDividendUsd,
    annualDividendShortfallUsd,
    shortfallReason,
  };
}

/** 年度末（Q4）かどうか。新しい暦・年度の概念を作らず既存PeriodV2だけを読む。 */
export function isFiscalYearEnd(period: PeriodV2): boolean {
  return toYearQuarter(period).quarter === FISCAL_QUARTERS_PER_YEAR;
}


// ---------------------------------------------------------------------
// 決算後の会計反映（PL不変・CF/BSは整合させる）
// ---------------------------------------------------------------------

/**
 * 確定済みの四半期決算へ、年度末の追加配当を反映した新しい決算結果を返す（純粋関数）。
 *
 * 【なぜ決算「後」に反映するのか】年間配当目標はQ4の純利益が確定して初めて決まる。
 * 旧実装のようにTurn開始時点で現金を減らす方式では、まだ存在しない年間純利益を
 * 先読みしなければならない。そこで年間精算だけは決算後に適用する。
 *
 * 【PLは絶対に動かさない】配当は費用ではないため profitAndLoss には一切触れない。
 * netIncome は配当の前後で同一である（実装指示§9）。
 *
 * 【動かすもの】
 *   CF: dividendsPaid（新設）・financingCashFlow・netCashChange・closingCash
 *   BS: cash・retainedEarnings・totalAssets・totalEquity・
 *       totalLiabilitiesAndEquity・balanceDifference
 *   そのほか cashShortfall / negativeEquity の判定も更新後の値で取り直す。
 * Debtは配当では動かさない（配当のための自動借入をしないため）。
 *
 * 【間接法照合（directIndirectDifference）を壊さない】配当は営業CFではないので
 * operatingCashFlow・indirectReconciliation には一切触れない。したがって
 * 既存の直接法/間接法一致検査はそのまま成立する。
 */
export function applyAnnualDividendToQuarterResult(
  result: CompanyFinancialQuarterResult,
  dividendPaidUsd: number
): CompanyFinancialQuarterResult {
  if (!(dividendPaidUsd > EPS_USD)) return result;

  const cf = result.cashFlow;
  const bs = result.balanceSheet;

  const dividendsPaidUsd = (cf.dividendsPaid !== undefined ? unwrapUsd(cf.dividendsPaid) : 0) + dividendPaidUsd;
  const financingCashFlow = unwrapUsd(cf.financingCashFlow) - dividendPaidUsd;
  const netCashChange = unwrapUsd(cf.netCashChange) - dividendPaidUsd;
  const closingCash = unwrapUsd(cf.closingCash) - dividendPaidUsd;

  const cashEnd = unwrapUsd(bs.cash) - dividendPaidUsd;
  const retainedEarningsEnd = unwrapUsd(bs.retainedEarnings) - dividendPaidUsd;
  const totalAssets = unwrapUsd(bs.totalAssets) - dividendPaidUsd;
  const totalEquity = unwrapUsd(bs.totalEquity) - dividendPaidUsd;
  const totalLiabilitiesAndEquity = unwrapUsd(bs.totalLiabilities) + totalEquity;

  return {
    ...result,
    // profitAndLoss は意図的にそのまま（配当はPL費用ではない）。
    balanceSheet: {
      ...bs,
      cash: usd(cashEnd),
      retainedEarnings: usd(retainedEarningsEnd),
      totalAssets: usd(totalAssets),
      totalEquity: usd(totalEquity),
      totalLiabilitiesAndEquity: usd(totalLiabilitiesAndEquity),
      balanceDifference: usd(totalAssets - totalLiabilitiesAndEquity),
    },
    cashFlow: {
      ...cf,
      dividendsPaid: usd(dividendsPaidUsd),
      financingCashFlow: usd(financingCashFlow),
      netCashChange: usd(netCashChange),
      closingCash: usd(closingCash),
    },
    cashShortfall: cashEnd < 0,
    cashShortfallAmount: usd(cashEnd < 0 ? -cashEnd : 0),
    negativeEquity: totalEquity < 0,
  };
}
