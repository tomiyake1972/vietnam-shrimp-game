// ShrimpX V2 — 四半期Period（Phase 0B）
//
// V1（app/lib/redisKeys.ts の formatPeriod）と同じ "YYYYQn" 文字列表現を踏襲しつつ、
// V2ではbranded typeとして扱い、生成・パースを本ファイルへ集約する。
// ゲーム開始は2015年（全体実装計画書 表紙）。

import { UnitValidationError } from "./units";

declare const periodBrand: unique symbol;

/** "2015Q1" のような四半期文字列。生成・パースは本ファイルの関数のみを経由する。 */
export type PeriodV2 = string & { readonly [periodBrand]: "PeriodV2" };

const PERIOD_PATTERN = /^(\d{4})Q([1-4])$/;

export interface YearQuarter {
  year: number;
  quarter: 1 | 2 | 3 | 4;
}

function assertValidYearQuarter(year: number, quarter: number): asserts quarter is 1 | 2 | 3 | 4 {
  if (!Number.isInteger(year)) {
    throw new UnitValidationError(`Period の year は整数である必要があります。受け取った値: ${year}`);
  }
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new UnitValidationError(`Period の quarter は1〜4の整数である必要があります。受け取った値: ${quarter}`);
  }
}

/** year/quarter から PeriodV2 を生成する。唯一の生成経路。 */
export function period(year: number, quarter: number): PeriodV2 {
  assertValidYearQuarter(year, quarter);
  return `${year}Q${quarter}` as PeriodV2;
}

/** 文字列がPeriodV2として妥当かどうかを判定する（型ガード）。 */
export function isValidPeriodString(s: unknown): s is string {
  return typeof s === "string" && PERIOD_PATTERN.test(s);
}

/** 文字列をパースしてPeriodV2として検証つきで受け入れる。不正な形式は例外。 */
export function parsePeriod(s: string): PeriodV2 {
  if (!isValidPeriodString(s)) {
    throw new UnitValidationError(
      `PeriodV2 の形式が不正です（"YYYYQn" 形式である必要があります）。受け取った値: ${JSON.stringify(s)}`
    );
  }
  return s as PeriodV2;
}

/** PeriodV2を year/quarter に分解する。 */
export function toYearQuarter(p: PeriodV2): YearQuarter {
  const m = PERIOD_PATTERN.exec(p);
  if (!m) {
    // parsePeriod/period を経由していれば到達しないが、念のため防御する。
    throw new UnitValidationError(`PeriodV2 の内部値が不正です: ${JSON.stringify(p)}`);
  }
  return { year: Number(m[1]), quarter: Number(m[2]) as 1 | 2 | 3 | 4 };
}

/** 次の四半期のPeriodV2を返す（Q4の次はQ1・年+1）。 */
export function nextPeriod(p: PeriodV2): PeriodV2 {
  const { year, quarter } = toYearQuarter(p);
  return quarter >= 4 ? period(year + 1, 1) : period(year, ((quarter + 1) as 1 | 2 | 3 | 4));
}

/** 前の四半期のPeriodV2を返す（Q1の前は前年Q4）。 */
export function previousPeriod(p: PeriodV2): PeriodV2 {
  const { year, quarter } = toYearQuarter(p);
  return quarter <= 1 ? period(year - 1, 4) : period(year, ((quarter - 1) as 1 | 2 | 3 | 4));
}

/** PeriodV2をプレーンな文字列へ戻す（表示・Redisキー生成用）。 */
export function periodToString(p: PeriodV2): string {
  return p as unknown as string;
}

/** V2ゲームの初期Period（2015Q1）。 */
export const INITIAL_PERIOD_V2: PeriodV2 = period(2015, 1);
