// ShrimpX V2 — Phase SAI-3B-1: SAI-3A runディレクトリの読み込み（純粋関数）
//
// fsに触れない。呼び出し元（CLI層）が「このrunに属するファイル名→内容」の
// マップを渡す。必須ファイルの欠落は分かりやすく失敗させ（三宅さんの指示§9）、
// schema versionを検証し、対応外のバージョンは明示的にエラーとする。

import { LoadedSai3aRun, Sai3bInputError, SUPPORTED_SAI3A_SCHEMA_VERSIONS } from "./schema";
import {
  parseAdjustmentTraceCsv,
  parseCaseSummaryCsv,
  parseDecisionTraceJsonl,
  parseManifestJson,
  parseMarketAllocationTraceCsv,
  parseQuarterSummaryCsv,
  parseRunSummaryJson,
  parseWarningsCsv,
} from "./parse";

export const SAI3A_REQUIRED_RUN_FILES: readonly string[] = [
  "manifest.json",
  "case-summary.csv",
  "quarter-summary.csv",
  "decision-trace.jsonl",
  "adjustment-trace.csv",
  "warnings.csv",
  "run-summary.json",
];

export interface RunFilesInput {
  /** run比較時の識別ラベル（既定はmanifest.runIdをそのまま使うが、CLI引数で
   *  別名を明示指定できる。複数run入力時に同名衝突があればcompareRuns.tsで検出）。 */
  readonly runLabel: string;
  /** ユーザー向けの表示用ディレクトリパス（エラーメッセージ・READMEシートに使う）。 */
  readonly sourceDir: string;
  /** ファイル名 -> 内容（読み込めなかったファイルはキー自体が存在しないかundefined）。 */
  readonly files: Readonly<Record<string, string | undefined>>;
}

/** 1個のSAI-3A runディレクトリぶんの入力を検証・パースし、LoadedSai3aRunへ変換する。 */
export function loadSai3aRun(input: RunFilesInput): LoadedSai3aRun {
  const { runLabel, sourceDir, files } = input;

  const missingFiles = SAI3A_REQUIRED_RUN_FILES.filter((f) => files[f] === undefined);
  if (missingFiles.length > 0) {
    throw new Sai3bInputError(
      `run "${runLabel}"（${sourceDir}）に必須ファイルが見つかりません: ${missingFiles.join(", ")}。` +
        `SAI-3AのCLI（scripts/sai3aAutoplay.ts）が出力したrunディレクトリを指定してください。`
    );
  }

  const manifest = parseManifestJson(files["manifest.json"]!, `${sourceDir}/manifest.json`);

  if (!SUPPORTED_SAI3A_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
    throw new Sai3bInputError(
      `run "${runLabel}"（${sourceDir}）のschemaVersion "${manifest.schemaVersion}" はSAI-3B-1が対応していません` +
        `（対応バージョン: ${SUPPORTED_SAI3A_SCHEMA_VERSIONS.join(", ")}）。SAI-3B側の対応バージョン追加が必要です。`
    );
  }

  const caseSummaryRows = parseCaseSummaryCsv(files["case-summary.csv"]!, sourceDir);
  const quarterSummaryRows = parseQuarterSummaryCsv(files["quarter-summary.csv"]!, sourceDir);
  const decisionTraceLines = parseDecisionTraceJsonl(files["decision-trace.jsonl"]!, sourceDir);
  const adjustmentTraceRows = parseAdjustmentTraceCsv(files["adjustment-trace.csv"]!, sourceDir);
  const warningRows = parseWarningsCsv(files["warnings.csv"]!, sourceDir);
  const runSummary = parseRunSummaryJson(files["run-summary.json"]!, sourceDir);

  // market-allocation-trace.csv（SAI-3B-2で追加）は任意ファイル。既存run
  // （SAI-3B-2以前に生成されたrunディレクトリ）との後方互換のため、無くても
  // 必須ファイル欠落エラーにはしない（=空配列として扱い、依存するチャート・
  // シートは「現時点の出力データでは作成不能」の扱いにする）。
  const marketAllocationTraceRows =
    files["market-allocation-trace.csv"] !== undefined ? parseMarketAllocationTraceCsv(files["market-allocation-trace.csv"], sourceDir) : [];

  const loadWarnings: string[] = [];
  if (files["market-allocation-trace.csv"] === undefined) {
    loadWarnings.push(
      `run "${runLabel}": market-allocation-trace.csvが見つかりません（SAI-3B-2より前に生成されたrunディレクトリの可能性）。` +
        `市場別シェア推移など、このファイルに依存する分析は「現時点の出力データでは作成不能」として扱われます。`
    );
  }
  if (runSummary.errors.length > 0) {
    loadWarnings.push(
      `run "${runLabel}": run-summary.jsonに${runSummary.errors.length}件のケースエラーが記録されています` +
        `（seed: ${runSummary.errors.map((e) => e.seed).join(", ")}）。これらのケースは集計から除外されず、` +
        `case-summary.csv側のcompleted=falseとして扱われます。`
    );
  }
  if (caseSummaryRows.length === 0) {
    loadWarnings.push(`run "${runLabel}": case-summary.csvに行が1件もありません。`);
  }
  if (decisionTraceLines.length === 0) {
    loadWarnings.push(`run "${runLabel}": decision-trace.jsonlに行が1件もありません。`);
  }

  return {
    runLabel,
    sourceDir,
    manifest,
    caseSummaryRows,
    quarterSummaryRows,
    decisionTraceLines,
    adjustmentTraceRows,
    warningRows,
    marketAllocationTraceRows,
    runSummary,
    loadWarnings,
  };
}
