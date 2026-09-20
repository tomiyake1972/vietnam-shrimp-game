// ShrimpX V2 — Balance Calibration Log（BALANCE-PROFILE-1 §11）
//
// 【目的】32Turn実行後に「どの条件で回して、各Turnに何が実際に適用され、
// 価格が補正前後でどう動いたか」を1つの表として取り出せるようにする。
// 経済バランスの感応度比較を、画面のスクロールではなく表計算で行うため。
//
// 【再計算しない】行の値はすべて確定済みの run / config / manualBalanceApplied から
// 読み出すだけで、ここで指数を掛け直したり価格を再計算したりしない
// （Exportの値とEngineが使った値が別計算になる事故を防ぐ）。
//
// 【新しいExport体系を作らない】出力は素のJSON/CSV文字列を返すだけの純粋関数であり、
// ダウンロードの実行は既存の Export ボタンと同じ toDownload() パターンへ任せる。

import type { SimulationSession } from "../simulation/types";
import {
  UNKNOWN_SOURCE_COMMIT,
  isSingleCalculationCommit,
  resolveCalculationCommitForTurn,
  type CalculationCommitHistory,
} from "../simulation/calculationCommit";

/** Runの条件（全行に共通する見出し部分）。 */
export interface BalanceCalibrationLogHeader {
  readonly runId: string;
  readonly runName: string;
  /**
   * 【Export実行時に動いていたアプリのcommit】
   * このRunのTurnを計算したcommitでは**ない**。混同を避けるため名前で区別する。
   * 過去Turnの計算commitは行ごとの calculationSourceCommit を見る。
   */
  readonly exportAppCommit: string;
  /**
   * このRunを作成したアプリのcommit。
   * 【計算commitではない】作成しただけでまだ計算していない可能性があるため、
   * Turnの計算commitとしては使わない（行ごとの calculationSourceCommit を見る）。
   * 記録の無い古いRunでは "UNKNOWN"。
   */
  readonly runCreatedByCommit: string;
  /**
   * Runが単一commitだけで計算された場合のみ、そのcommit。
   * 複数commitにまたがる場合は null（単一値へ潰さない）。履歴が無い古いRunでも null。
   */
  readonly runCalculationCommit: string | null;
  /** 計算commitの区間履歴そのもの（JSON出力にはこれを含める）。 */
  readonly calculationCommitHistory: CalculationCommitHistory;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly seed: string;
  /** 未指定（legacy解決）のRunでは "(未指定)"。推測で具体名を埋めない。 */
  readonly salesModelId: string;
  /** Profileを使わずに開始したRun・旧Runでは "(なし/不明)"。 */
  readonly balanceProfileName: string;
  readonly balanceProfileId: string;
  readonly balanceProfileSpecVersion: string;
  readonly completedTurns: number;
  readonly exportedAt: string;
}

/** 1Turnぶんの実績行。 */
export interface BalanceCalibrationLogRow {
  readonly turn: number;
  /**
   * そのTurnを実際に計算したcommit。履歴が無い（この機能より前に計算された）Turnは
   * "UNKNOWN"。現在アプリのcommitで埋めない。
   */
  readonly calculationSourceCommit: string;
  readonly manualSalesPriceIndex: number;
  readonly manualRawMarketPriceIndex: number;
  /** 手動指定が無いTurnは null（0ではない）。 */
  readonly manualDividendPayoutRatio: number | null;
  readonly scenarioRawPriceCaptureIndex: number;
  readonly preManualRawMarketPrice: number;
  readonly appliedRawMarketPrice: number;
  /** 販売基準価格は市場×商品で多数あるため、代表としてCN/hosoの補正前後を出す。 */
  readonly preManualSalesReferencePriceCnHoso: number | null;
  readonly appliedSalesReferencePriceCnHoso: number | null;
  readonly warningCount: number;
  readonly warnings: string;
}

export interface BalanceCalibrationLog {
  readonly header: BalanceCalibrationLogHeader;
  readonly rows: readonly BalanceCalibrationLogRow[];
  /**
   * 適用実績そのものが記録されていないRun（この機能より前のRun）では true。
   * 画面・Exportは推測で0や100を埋めず、この旗で「不明」であることを示す。
   */
  readonly appliedRecordsUnavailable: boolean;
}

const UNKNOWN = "(なし/不明)";

export function buildBalanceCalibrationLog(
  session: SimulationSession,
  exportedAt: string,
  /**
   * Export実行時に動いているアプリのcommit。
   * 【Runの計算commitとして使わない】行ごとの計算commitは run.calculationCommitHistory
   * からのみ解決する（この引数はheaderのexportAppCommitにしか入らない）。
   */
  exportAppCommit: string
): BalanceCalibrationLog {
  const profile = session.run.appliedBalanceProfile;
  const history = session.run.calculationCommitHistory ?? [];
  const header: BalanceCalibrationLogHeader = {
    runId: session.run.simulationRunId,
    runName: session.run.runName ?? "",
    exportAppCommit,
    runCreatedByCommit: session.run.runCreatedByCommit ?? UNKNOWN_SOURCE_COMMIT,
    runCalculationCommit: isSingleCalculationCommit(history) ? history[0].sourceCommit : null,
    calculationCommitHistory: history,
    scenarioId: session.run.scenarioId,
    scenarioVersion: session.run.scenarioVersion,
    seed: session.run.seed,
    salesModelId: session.state.config.salesModelId ?? "(未指定)",
    balanceProfileName: profile?.appliedBalanceProfileName ?? UNKNOWN,
    balanceProfileId: profile?.appliedBalanceProfileId ?? UNKNOWN,
    balanceProfileSpecVersion: profile?.appliedBalanceProfileSpecVersion ?? UNKNOWN,
    completedTurns: session.run.completedTurns,
    exportedAt,
  };

  const applied = session.manualBalanceApplied;
  if (applied === undefined) {
    return { header, rows: [], appliedRecordsUnavailable: true };
  }

  const rows = applied.map((record): BalanceCalibrationLogRow => {
    const preCn = record.preManualSalesReferencePrices.CN?.hoso;
    const appliedCn = record.appliedSalesReferencePrices.CN?.hoso;
    return {
      turn: record.turn,
      calculationSourceCommit: resolveCalculationCommitForTurn(history, record.turn),
      manualSalesPriceIndex: record.manualSalesPriceIndex,
      manualRawMarketPriceIndex: record.manualRawMarketPriceIndex,
      manualDividendPayoutRatio: record.manualDividendPayoutRatio,
      scenarioRawPriceCaptureIndex: record.scenarioRawPriceCaptureIndex,
      preManualRawMarketPrice: record.preManualRawMarketPrice,
      appliedRawMarketPrice: record.appliedRawMarketPrice,
      preManualSalesReferencePriceCnHoso: preCn ?? null,
      appliedSalesReferencePriceCnHoso: appliedCn ?? null,
      warningCount: record.warnings.length,
      warnings: record.warnings.map((w) => w.code).join(";"),
    };
  });

  return { header, rows, appliedRecordsUnavailable: false };
}

export function balanceCalibrationLogToJson(log: BalanceCalibrationLog): string {
  return JSON.stringify(log, null, 2);
}

const CSV_COLUMNS: readonly (keyof BalanceCalibrationLogRow)[] = [
  "turn",
  // 【各Turn行に計算commitを出す】Runが複数commitにまたがる場合でも、
  // 行を見ればそのTurnをどのcommitで計算したかが分かる。
  "calculationSourceCommit",
  "manualSalesPriceIndex",
  "manualRawMarketPriceIndex",
  "manualDividendPayoutRatio",
  "scenarioRawPriceCaptureIndex",
  "preManualRawMarketPrice",
  "appliedRawMarketPrice",
  "preManualSalesReferencePriceCnHoso",
  "appliedSalesReferencePriceCnHoso",
  "warningCount",
  "warnings",
];

function csvCell(value: string | number | null): string {
  // 未設定は空欄にする（0と書くと「0%指定」と読めてしまうため）。
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 表計算で開ける形。Runの条件は先頭のコメント行ではなく、
 * 各行へ繰り返し入れる（行を並べ替えても条件が失われないようにする）。
 */
export function balanceCalibrationLogToCsv(log: BalanceCalibrationLog): string {
  const headerCols = [
    "runId",
    "runName",
    // Export実行時のアプリcommit。Runの計算commitではない（行側のcalculationSourceCommitを見る）。
    "exportAppCommit",
    // Runを作成したcommit。これも計算commitではない。
    "runCreatedByCommit",
    "scenarioId",
    "scenarioVersion",
    "seed",
    "salesModelId",
    "balanceProfileName",
    "balanceProfileId",
    "balanceProfileSpecVersion",
  ] as const;

  const lines: string[] = [];
  lines.push([...headerCols, ...CSV_COLUMNS].join(","));
  for (const row of log.rows) {
    const headerValues = headerCols.map((key) => csvCell(log.header[key]));
    const rowValues = CSV_COLUMNS.map((key) => csvCell(row[key]));
    lines.push([...headerValues, ...rowValues].join(","));
  }
  return lines.join("\n");
}
