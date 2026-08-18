// ShrimpX V2 — EVAL-1: 任意Turn評価サービスの基盤 + TSV正式化（実装指示§13-§24, TSV正式化指示）
//
// 【この実装が満たすもの】
// §13: 「Turn16で終了しても・Turn23で終了しても・Turn32まで走っても、同じ評価
//   システムで評価できる」という要求を満たすため、この関数群は特定のTurn数を
//   一切前提としない。呼び出し側が渡した history 配列（何Turnぶんであっても）と
//   評価対象Turn（asOfTurn）だけから、その時点までの確定実績を集計する。
// §23: KPI基盤は「新しい巨大な集計システム」を作らず、既存の
//   CompanyQuarterRecord（financialResults・financingResults・
//   companySummaries・dividendResults）から組み立てるだけの純粋関数とする
//   （新しい永続化状態・新しい計算契約は一切追加しない）。
// §24: Awards（表彰）はこのPhaseでは正式スコア化しない。KPIを個別に読み出せる
//   形にするだけで、順位付け・受賞ロジックは実装しない。TSVへの加点もしない。
//
// 【distressTurnCountの定義】financingResults[].financialHealth.primary
// （app/lib/v2/financing/types.ts）が既存のCrisis/財務健全性のSSoTであり、
// "healthy" 以外の値を記録したTurn数を数える。新しいCrisis状態は導入しない。
//
// ---------------------------------------------------------------------
// 【TSV正式化・2026-08-18指示】Total Shareholder Value（総株主価値）
// ---------------------------------------------------------------------
//
// TSV(t) = Dividend Value(t) + Current Company Value(t)
// Current Company Value(t) = Enterprise Value(t) + Cash(t) - Debt(t)
//
// 【評価時点は常に「現在Turn」】TSV(t)はTurn t時点の情報だけから計算する。
// 未来（t+1以降）の利益・Cash・Debt・配当・シナリオ情報は一切参照しない
// （Future leakage禁止・指示§14）。Turn32まで到達することを仮定した値は
// 一切使わない（指示§6）。history配列を`turn <= asOfTurn`でフィルタしてから
// 集計する既存のasOfTurnパターン（§13）をそのまま踏襲することで、この禁止を
// 構造的に満たす（「未来を読める位置に実装しない」）。
//
// 【Dividend Value = 現在Turn基準・年率15%複利】旧DIV-2の段階係数
// （T1-8=1.50等、finance/dividend.tsのgetDividendTimeWeight）は、Turn32を
// 暗黙の基準にした「最終到達点からの逆算」であり、今回の「常に現在Turn基準」
// という要求と根本的に矛盾するため、正式TSVでは使用しない。旧フィールドは
// CompanyQuarterRecord.dividendResultsに保存されたまま（save非破壊）だが、
// このモジュールはその値を読まず、各Turnの実際の配当額（appliedDividendUsd。
// 既存フィールド、変更なし）とTurn差分から、asOfTurnごとに再計算する
// （指示§15第一候補）。これによりmigrationは一切不要（旧Runもそのままdecode
// 可能。dividend.ts・finance/types.ts・persistence/schema.tsへの変更なし）。
//
// 計算式（指示§4）:
//   DividendFutureValue(d, t) = Dividend(d) × (1.15)^((t-d)/4)
//   DividendValue(t) = Σ DividendFutureValue(d, t)  for all d <= t
// d = 配当を実施したTurn、t = 評価Turn（asOfTurn）。1Turn=1四半期のため
// 指数は(t-d)/4（4Turn=1年）。d=tなら指数0＝1.0倍（指示§5）。
//
// 【Enterprise Value = 直近3Turn正常化CFの年換算・10年10%DCF・Terminal Valueなし】
// 「正常化Cash Flow」の定義（指示§18）は、既存のFinance構造を監査した結果、
// CashFlowStatement.operatingCashFlow（finance/quarterClose.ts・
// finance/types.ts）をそのまま使う。理由：
//   - investingCashFlow（CAPEX支払）・financingCashFlow（借入実行・返済）は
//     別項目として最初から分離されている（このモジュールでは合算しない）。
//   - 配当はDIV-1の設計上、四半期開始前にprevFinance.cashを直接調整する
//     方式で実装されており（app/lib/v2/finance/dividend.ts参照）、
//     CashFlowStatementのどの項目にも一切現れない（P&L非計上と同じ理由で
//     CF上も非計上）。
//   - 「equity injection」に相当する仕組みはこのエンジンに存在しない
//     （grep確認済み）。
//   したがって operatingCashFlow は、財務・資本政策（借入・返済・配当・
//   増資・裁量的な成長投資CAPEX）で直接歪まない、事業そのものが生み出す
//   Cash創出力として一意に定義できる（新しい税率・maintenance CAPEX仮定は
//   一切導入していない）。
//
// 計算：
//   NormalizedQuarterlyCashFlow(t) = 直近min(3, 確定Turn数)の
//     operatingCashFlowの単純平均
//   AnnualizedCashFlow(t) = NormalizedQuarterlyCashFlow(t) × 4
//   EnterpriseValue(t) = AnnualizedCashFlow(t) × Σ(year=1..10) 1/1.10^year
//     （年金現価係数。プログラムで正確に算出。約6.144567）
// Terminal Valueは加算しない。負のNormalized Cash Flowも0でフロアせず、
// 負のEnterprise Value / Current Company Value / TSVをそのまま許容する
// （指示§19）。
//
// 【10%と15%は別レート】Enterprise Value側は資本コストとして10%のDCF、
// Dividend Value側は早期還元プレミアムとして15%の複利。意図的に異なる値
// であり、混同・共通化しない（指示§8）。

import { CompanyId } from "../../sales/types";
import { CompanyQuarterRecord } from "../types";

// ---------------------------------------------------------------------
// パラメータ
// ---------------------------------------------------------------------

/** 【指示§4】配当の早期還元プレミアム（年率）。EnterpriseValueの10%とは別。 */
const DIVIDEND_COMPOUND_ANNUAL_RATE = 0.15;
/** 【指示§2】Enterprise Value DCFの割引率（年率）。Dividend Valueの15%とは別。 */
const ENTERPRISE_VALUE_DISCOUNT_RATE = 0.1;
/** 【指示§2】DCF期間（年）。Terminal Valueなし。 */
const ENTERPRISE_VALUE_DCF_YEARS = 10;
/** 【指示§2】正常化Cash Flow算定の遡及Turn数上限（Turn1は1Turn平均、Turn2は2Turn平均、Turn3以降は3Turn平均）。 */
const NORMALIZED_CASH_FLOW_LOOKBACK_TURNS = 3;
/** 1Turn = 1四半期 = 1年の1/4。 */
const TURNS_PER_YEAR = 4;

/** 年金現価係数 Σ(year=1..n) 1/(1+r)^year を正確に算出する（指示§2の「約6.144567」を丸めずに再現）。 */
function annuityPresentValueFactor(annualRate: number, years: number): number {
  return (1 - Math.pow(1 + annualRate, -years)) / annualRate;
}

const ENTERPRISE_VALUE_ANNUITY_FACTOR = annuityPresentValueFactor(ENTERPRISE_VALUE_DISCOUNT_RATE, ENTERPRISE_VALUE_DCF_YEARS);

// ---------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------

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

/** 【指示§11】自社のみ閲覧可能な、Current Company Valueの内訳。 */
export interface CompanyCurrentCompanyValueBreakdown {
  /** 直近min(3,確定Turn数)のoperatingCashFlow平均。確定実績が無ければnull。 */
  readonly normalizedQuarterlyCashFlowUsd: number | null;
  readonly annualizedCashFlowUsd: number | null;
  /** 10年・年率10%DCF・Terminal Valueなし。normalizedQuarterlyCashFlowUsdが負でも0でフロアしない。 */
  readonly enterpriseValueUsd: number | null;
  readonly cashUsd: number | null;
  readonly debtUsd: number | null;
  /** = enterpriseValueUsd + cashUsd - debtUsd。負値を許容する。 */
  readonly currentCompanyValueUsd: number | null;
}

export interface CompanyEvaluationSnapshot {
  readonly companyId: CompanyId;
  readonly asOfTurn: number;
  readonly kpis: CompanyKpiSnapshot;
  /**
   * 【正式TSV】各Turnの実配当額（appliedDividendUsd）を、asOfTurn基準で年率15%
   * 複利評価して合算した値。Turn32等の未到達Turnを仮定した値は含まない。
   */
  readonly currentDividendValueUsd: number;
  /**
   * 【後方参照専用・公式TSVでは不使用】旧DIV-2の段階係数
   * （finance/dividend.ts getDividendTimeWeight）ベースの累積加重配当価値。
   * 保存済みdividendResultsの値をそのまま読むだけ（再計算しない）。
   */
  readonly legacyWeightedDividendValueUsd: number;
  readonly currentCompanyValue: CompanyCurrentCompanyValueBreakdown;
  /** 【正式化】TSV = currentDividendValueUsd + currentCompanyValue.currentCompanyValueUsd。算出不能ならnull。 */
  readonly totalShareholderValueUsd: number | null;
  readonly shareholderValueModelVersion: "tsv-dcf-v1";
}

// ---------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------

function sumAt<T>(records: readonly CompanyQuarterRecord[], companyId: CompanyId, pick: (record: CompanyQuarterRecord) => T | undefined): T[] {
  const values: T[] = [];
  for (const record of records) {
    const value = pick(record);
    if (value !== undefined) values.push(value);
  }
  return values;
}

function scopedHistory(history: readonly CompanyQuarterRecord[], asOfTurn: number): readonly CompanyQuarterRecord[] {
  return history.filter((r) => r.turn <= asOfTurn).sort((a, b) => a.turn - b.turn);
}

// ---------------------------------------------------------------------
// KPI（既存EVAL-1。変更なし）
// ---------------------------------------------------------------------

/**
 * companyIdの、asOfTurn以下のTurnだけに絞った確定履歴を集計してKPIスナップショットを返す。
 * historyが何Turnぶんであっても（Run全体が16Turnで終わっていても32Turn走っていても）、
 * 同じロジックで動く（§13）。
 */
export function computeCompanyKpiSnapshot(history: readonly CompanyQuarterRecord[], companyId: CompanyId, asOfTurn: number): CompanyKpiSnapshot {
  const scoped = scopedHistory(history, asOfTurn);

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

// ---------------------------------------------------------------------
// TSV正式化
// ---------------------------------------------------------------------

/**
 * 【指示§2】直近min(3,確定Turn数)のoperatingCashFlow単純平均。確定実績が
 * asOfTurnまでに1件も無ければnull（0で埋めない＝存在しないことを明示する）。
 */
export function computeNormalizedQuarterlyCashFlowUsd(history: readonly CompanyQuarterRecord[], companyId: CompanyId, asOfTurn: number): number | null {
  const scoped = scopedHistory(history, asOfTurn);
  const financialResults = sumAt(scoped, companyId, (r) => r.financialResults.find((f) => f.companyId === companyId));
  if (financialResults.length === 0) return null;
  const lookback = financialResults.slice(-NORMALIZED_CASH_FLOW_LOOKBACK_TURNS);
  const sum = lookback.reduce((total, f) => total + Number(f.cashFlow.operatingCashFlow), 0);
  return sum / lookback.length;
}

/**
 * 【指示§4/§5/§6/§14】各Turnの実配当額（appliedDividendUsd）を、常にasOfTurn
 * 基準で年率15%複利評価して合算する。scopedHistory自体がasOfTurnを超える
 * Turnを含まないため、未来の配当を混入させる余地が構造的に存在しない
 * （Future leakage禁止）。d=asOfTurnの配当は指数0＝1.0倍。
 */
export function computeCurrentDividendValueUsd(history: readonly CompanyQuarterRecord[], companyId: CompanyId, asOfTurn: number): number {
  const scoped = scopedHistory(history, asOfTurn);
  let total = 0;
  for (const record of scoped) {
    const entry = (record.dividendResults ?? []).find((d) => d.companyId === companyId);
    if (!entry || entry.appliedDividendUsd <= 0) continue;
    const turnsElapsed = asOfTurn - record.turn;
    const yearsElapsed = turnsElapsed / TURNS_PER_YEAR;
    total += entry.appliedDividendUsd * Math.pow(1 + DIVIDEND_COMPOUND_ANNUAL_RATE, yearsElapsed);
  }
  return total;
}

/** 【指示§11】自社詳細内訳。Cash/Debt/NormalizedCFは他社非公開（呼び出し側で表示範囲を制御する）。 */
export function computeCompanyCurrentCompanyValueBreakdown(
  history: readonly CompanyQuarterRecord[],
  companyId: CompanyId,
  asOfTurn: number
): CompanyCurrentCompanyValueBreakdown {
  const kpis = computeCompanyKpiSnapshot(history, companyId, asOfTurn);
  const normalizedQuarterlyCashFlowUsd = computeNormalizedQuarterlyCashFlowUsd(history, companyId, asOfTurn);
  const annualizedCashFlowUsd = normalizedQuarterlyCashFlowUsd === null ? null : normalizedQuarterlyCashFlowUsd * TURNS_PER_YEAR;
  const enterpriseValueUsd = annualizedCashFlowUsd === null ? null : annualizedCashFlowUsd * ENTERPRISE_VALUE_ANNUITY_FACTOR;
  const currentCompanyValueUsd =
    enterpriseValueUsd === null || kpis.endingCashUsd === null || kpis.endingDebtUsd === null
      ? null
      : enterpriseValueUsd + kpis.endingCashUsd - kpis.endingDebtUsd;

  return {
    normalizedQuarterlyCashFlowUsd,
    annualizedCashFlowUsd,
    enterpriseValueUsd,
    cashUsd: kpis.endingCashUsd,
    debtUsd: kpis.endingDebtUsd,
    currentCompanyValueUsd,
  };
}

/**
 * companyIdの、asOfTurn時点の評価スナップショット（KPI＋正式Dividend Value＋
 * Current Company Value＋TSV）を返す。§13の要求どおり、Runが何Turnで終わって
 * いても同じ関数で計算できる（asOfTurn以下のTurnだけを見るため、その後に
 * Runが何Turn続いたかによって値が変化しない）。
 */
export function computeCompanyEvaluationSnapshot(history: readonly CompanyQuarterRecord[], companyId: CompanyId, asOfTurn: number): CompanyEvaluationSnapshot {
  const kpis = computeCompanyKpiSnapshot(history, companyId, asOfTurn);
  const scoped = scopedHistory(history, asOfTurn);
  const dividendResultsScoped = sumAt(scoped, companyId, (r) => (r.dividendResults ?? []).find((d) => d.companyId === companyId));
  const lastDividend = dividendResultsScoped[dividendResultsScoped.length - 1] ?? null;

  const currentDividendValueUsd = computeCurrentDividendValueUsd(history, companyId, asOfTurn);
  const currentCompanyValue = computeCompanyCurrentCompanyValueBreakdown(history, companyId, asOfTurn);
  const totalShareholderValueUsd =
    currentCompanyValue.currentCompanyValueUsd === null ? null : currentDividendValueUsd + currentCompanyValue.currentCompanyValueUsd;

  return {
    companyId,
    asOfTurn,
    kpis,
    currentDividendValueUsd,
    legacyWeightedDividendValueUsd: lastDividend ? lastDividend.cumulativeWeightedDividendValueUsd : 0,
    currentCompanyValue,
    totalShareholderValueUsd,
    shareholderValueModelVersion: "tsv-dcf-v1",
  };
}

/** 複数社ぶんの評価スナップショットを一括で計算する（Leaderboard・End Game / GM画面向け）。 */
export function computeAllCompaniesEvaluationSnapshot(
  history: readonly CompanyQuarterRecord[],
  companyIds: readonly CompanyId[],
  asOfTurn: number
): readonly CompanyEvaluationSnapshot[] {
  return companyIds.map((companyId) => computeCompanyEvaluationSnapshot(history, companyId, asOfTurn));
}

/** 【指示§10/§12】TSV降順でランク付けした一覧を返す（同値は安定ソート順）。 */
export function rankCompaniesByTotalShareholderValue(snapshots: readonly CompanyEvaluationSnapshot[]): readonly CompanyEvaluationSnapshot[] {
  return [...snapshots].sort((a, b) => (b.totalShareholderValueUsd ?? Number.NEGATIVE_INFINITY) - (a.totalShareholderValueUsd ?? Number.NEGATIVE_INFINITY));
}
