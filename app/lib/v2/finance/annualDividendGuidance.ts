// ShrimpX V2 — 年度中の配当参考表示（D1 §8）
//
// 【何のためのモジュールか】管理者がバランス調整で配当性向を明示指定した場合、
// その会社はQ4決算直後に年間純利益ベースで自動精算される。PLAYERは配当欄へ何も
// 入力しなくてよいが、「いくら出ていくのか」がまったく見えないままQ4を迎えると、
// 手元資金の計画が立てられない。そこで年度の途中でも、確定済み実績と現在残高だけを
// 使った参考値を出す。
//
// 【絶対に予測しない】ここで計算してよいのは
//   - 既に確定した四半期の純利益（年初来）
//   - 既に実際に支払った配当（年初来）
//   - 現在の現金・配当可能額
// だけである。まだ確定していないQ4の利益・市場の真値・将来の価格は一切使わない。
// したがってこの値は「年間配当見込」でも「確定額」でもなく、
// 「年初来実績ベース参考額」である。呼び出し側の表示もその名前で統一する。
//
// 【engineの契約を再実装しない】年間目標の式（max(0, 年間純利益) × 率、既払控除、
// min(現金, 分配可能利益)の上限）は annualDividend.ts と同じものを使う。
// ここが独自の式を持つと、画面の参考値とQ4の確定値が別の理屈で動いてしまう。

import { PeriodV2, toYearQuarter } from "../core/period";

/** 年度中の参考表示に必要な、確定済み四半期1つぶんの実績。 */
export interface AnnualDividendGuidanceQuarterFact {
  readonly quarter: 1 | 2 | 3 | 4;
  readonly netIncomeUsd: number;
  /** その四半期に実際に支払われた配当（Player金額指定ぶんを含む実支払額）。 */
  readonly appliedDividendUsd: number;
}

export interface AnnualDividendGuidanceInput {
  /** 現在（これから意思決定する）Turnの期。対象年度はこの年で決める。 */
  readonly period: PeriodV2;
  /**
   * 現在Turnに有効な管理者指定配当性向。
   *   number    … 明示指定あり（0 も「0%と明示指定した」であり未指定ではない）
   *   null      … 管理者指定なし（設定は読めたが指定が無い）
   *   undefined … 設定自体を読めない（この機能より前のRun等）。推測で埋めない。
   */
  readonly adminPayoutRatio: number | null | undefined;
  /** 対象年度のうち、既に確定した四半期だけ。未確定四半期を0で埋めて渡さないこと。 */
  readonly confirmedQuarters: readonly AnnualDividendGuidanceQuarterFact[];
  /** 現在の現金残高（前Turnまでに確定した値）。 */
  readonly currentCashUsd: number;
  /** 現在の配当可能額 ＝ min(現金, 分配可能利益)。engine側 computeMaxDividendUsd と同じ値を渡す。 */
  readonly dividendCapacityUsd: number;
}

/** 管理者指定がある場合の参考値（すべて確定実績と現在残高だけから算出）。 */
export interface AnnualDividendGuidanceFigures {
  /** 対象年度。 */
  readonly targetYear: number;
  /** 現在Turnの四半期。4ならこのTurnの決算直後に精算される。 */
  readonly currentQuarter: 1 | 2 | 3 | 4;
  /** 管理者指定配当性向（0も指定値）。 */
  readonly adminPayoutRatio: number;
  /** 参考値の根拠になった確定四半期の数（0なら年初来実績がまだ無い）。 */
  readonly confirmedQuarterCount: number;
  /** 年初来の確定純利益（赤字四半期は符号付きで合算）。 */
  readonly ytdNetIncomeUsd: number;
  /** 年初来実績ベース参考配当額 ＝ max(0, 年初来確定純利益) × 管理者指定率。 */
  readonly ytdReferenceDividendUsd: number;
  /** 年初来に実際に支払った配当。 */
  readonly ytdPaidDividendUsd: number;
  /** 参考の追加必要額 ＝ max(0, 参考配当額 − 年初来実支払)。 */
  readonly referenceAdditionalUsd: number;
  /** 現在残高ベースの参考支払可能額 ＝ min(参考追加必要額, 配当可能額)。 */
  readonly referencePayableUsd: number;
  /** 現在残高ベースの参考配当後Cash ＝ 現在現金 − 参考支払可能額。 */
  readonly referenceCashAfterUsd: number;
}

export type AnnualDividendGuidance =
  /** 管理者指定あり。Q4決算直後に自動精算される。 */
  | { readonly kind: "ADMIN_SPECIFIED"; readonly figures: AnnualDividendGuidanceFigures }
  /** 管理者指定なし。AIの既定率を表示も強制もしない。 */
  | { readonly kind: "NO_ADMIN_SETTING"; readonly targetYear: number }
  /** 設定自体を読めない（この機能より前のRun等）。0や100を埋めない。 */
  | { readonly kind: "UNKNOWN"; readonly targetYear: number };

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * 年度中の配当参考表示を組み立てる。
 *
 * 【未確定分を0で埋めない】confirmedQuartersには確定した四半期だけを渡すこと。
 * 年初来の実績が1件も無ければ ytdNetIncomeUsd は 0 になるが、それは
 * 「利益が0」ではなく「まだ確定実績が無い」であり、confirmedQuarterCount で区別できる。
 */
export function buildAnnualDividendGuidance(input: AnnualDividendGuidanceInput): AnnualDividendGuidance {
  const { year, quarter } = toYearQuarter(input.period);
  if (input.adminPayoutRatio === undefined) return { kind: "UNKNOWN", targetYear: year };
  if (input.adminPayoutRatio === null) return { kind: "NO_ADMIN_SETTING", targetYear: year };

  const ratio = Number.isFinite(input.adminPayoutRatio) ? input.adminPayoutRatio : 0;
  const ytdNetIncomeUsd = input.confirmedQuarters.reduce((sum, q) => sum + finiteOrZero(q.netIncomeUsd), 0);
  const ytdPaidDividendUsd = input.confirmedQuarters.reduce((sum, q) => sum + Math.max(0, finiteOrZero(q.appliedDividendUsd)), 0);
  // engine（annualDividend.ts）と同じ式。赤字年度は目標0で、マイナスの配当は作らない。
  const ytdReferenceDividendUsd = Math.max(0, ytdNetIncomeUsd) * ratio;
  const referenceAdditionalUsd = Math.max(0, ytdReferenceDividendUsd - ytdPaidDividendUsd);
  const capacityUsd = Math.max(0, finiteOrZero(input.dividendCapacityUsd));
  const referencePayableUsd = Math.min(referenceAdditionalUsd, capacityUsd);
  const currentCashUsd = finiteOrZero(input.currentCashUsd);

  return {
    kind: "ADMIN_SPECIFIED",
    figures: {
      targetYear: year,
      currentQuarter: quarter,
      adminPayoutRatio: ratio,
      confirmedQuarterCount: input.confirmedQuarters.length,
      ytdNetIncomeUsd,
      ytdReferenceDividendUsd,
      ytdPaidDividendUsd,
      referenceAdditionalUsd,
      referencePayableUsd,
      referenceCashAfterUsd: currentCashUsd - referencePayableUsd,
    },
  };
}
