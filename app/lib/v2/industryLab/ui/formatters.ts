// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） 数値・単位フォーマッタ
//
// 画面表示専用の純粋関数のみを提供する（実装指示 §10「金額・数量・比率の
// 単位を表示」「大きな数値には桁区切り」・§13「数値・単位フォーマット」）。
// ブランド型（HosoEqTons等）を受け取る関数は unwrapUnit() 経由でプレーンな
// numberへ変換してからフォーマットする。

import { HosoEqTons, UsdPerHosoEqKg, Ratio, Score0to100, unwrapUnit } from "../../core/units";

const TONS_FORMATTER = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
const USD_FORMATTER = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const PERCENT_FORMATTER = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const SCORE_FORMATTER = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
const INDEX_FORMATTER = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 千円単位ではない、USD金額そのものの桁区切り表示用（小数点以下は表示しない。内部の保持精度は変更しない）。 */
const USD_AMOUNT_FORMATTER = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });

/** HOSO換算トン量を「1,234 トン」のように桁区切り付きで表示する。 */
export function formatHosoEqTons(value: HosoEqTons | number): string {
  const n = typeof value === "number" ? value : unwrapUnit(value);
  return `${TONS_FORMATTER.format(n)} トン`;
}

/** USD/HOSO換算kg価格を「$5.1234/kg」のように表示する。 */
export function formatUsdPerHosoEqKg(value: UsdPerHosoEqKg | number): string {
  const n = typeof value === "number" ? value : unwrapUnit(value);
  return `$${USD_FORMATTER.format(n)}/kg`;
}

/** Ratio(0〜1)を「85.0%」のようにパーセント表示する。 */
export function formatRatioAsPercent(value: Ratio | number): string {
  const n = typeof value === "number" ? value : unwrapUnit(value);
  return `${PERCENT_FORMATTER.format(n * 100)}%`;
}

/** 比率の変化量（-1〜1程度）を符号付きパーセントで表示する（例: "+3.2%" "-8.0%"）。 */
export function formatSignedPercent(ratioChange: number): string {
  const pct = ratioChange * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${PERCENT_FORMATTER.format(pct)}%`;
}

/** Score0to100を「62.5点」のように表示する。 */
export function formatScore(value: Score0to100 | number): string {
  const n = typeof value === "number" ? value : unwrapUnit(value);
  return `${SCORE_FORMATTER.format(n)}点`;
}

/** 景気指数・コスト指数などの無次元指数を「1.03倍」のように表示する。 */
export function formatIndex(value: number): string {
  return `${INDEX_FORMATTER.format(value)}倍`;
}

/** 符号付きの数量差分（トン）を「+1,234 トン」のように表示する。 */
export function formatSignedHosoEqTons(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${TONS_FORMATTER.format(value)} トン`;
}

/** 符号付きの価格差分（USD/kg）を「+$0.1234/kg」のように表示する。 */
export function formatSignedUsdPerHosoEqKg(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}$${USD_FORMATTER.format(value)}/kg`;
}

/** 需給比率（(demand-supply)/supply）を「供給不足 12.3%」「供給過剰 8.0%」のように表示する。 */
export function formatSupplyDemandBalance(balance: number): string {
  if (Math.abs(balance) < 1e-9) return "均衡";
  const label = balance > 0 ? "供給不足" : "供給過剰";
  return `${label} ${PERCENT_FORMATTER.format(Math.abs(balance) * 100)}%`;
}

/**
 * 【Phase 8B-3】USD金額を「$2,500,000」のように桁区切り付きで表示する
 * （設備投資UIの投資額・支払額・現金残高等の表示用。小数点以下は四捨五入して
 * 表示するだけであり、保存されている内部値の精度そのものは一切変更しない）。
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${USD_AMOUNT_FORMATTER.format(Math.abs(value))}`;
}
