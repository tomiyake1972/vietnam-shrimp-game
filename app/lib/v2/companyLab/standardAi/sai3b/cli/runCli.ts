// ShrimpX V2 — Phase SAI-3B-1: Excel生成CLI 実行オーケストレーション
//
// process.argv・console・process.exit・実ファイルシステムには一切触れない
// （Sai3bCliIoとして注入されたreadFileのみを使う）。実際のfs読み込み・
// xlsx書き出しはscripts/sai3bExcel.tsが行う。

import { SAI3A_REQUIRED_RUN_FILES, loadSai3aRun } from "../loadRun";
import { validateComparableRuns } from "../compareRuns";
import { buildSai3bAnalysis } from "../buildAnalysis";
import { renderSai3bWorkbookToBuffer } from "../workbook/writeWorkbook";
import { LoadedSai3aRun, Sai3bInputError } from "../schema";
import { buildSai3bUsageText, parseSai3bCliArgs } from "./argParser";
import { Sai3bCliArgumentError, Sai3bCliIo, Sai3bCliResult } from "./types";

export interface Sai3bCliOptions {
  /** ブック生成日時（ISO8601）。呼び出し元（scripts/側）がDate.now()由来の値を
   *  注入する（本関数自体はDate.now()を呼ばない）。 */
  readonly generatedAtIso: string;
}

function describeError(e: unknown): string {
  if (e instanceof Sai3bCliArgumentError) return `引数エラー: ${e.message}`;
  if (e instanceof Sai3bInputError) return `入力データエラー: ${e.message}`;
  if (e instanceof Error) return `予期しないエラー: ${e.message}`;
  return "予期しないエラーが発生しました。";
}

function loadRunFromDir(io: Sai3bCliIo, dir: string): LoadedSai3aRun {
  const files: Record<string, string | undefined> = {};
  for (const fileName of SAI3A_REQUIRED_RUN_FILES) {
    files[fileName] = io.readFile(`${dir}/${fileName}`);
  }
  const manifestText = files["manifest.json"];
  let runLabel = dir.split("/").filter((s) => s.length > 0).pop() ?? dir;
  if (manifestText !== undefined) {
    try {
      const parsed = JSON.parse(manifestText) as { runId?: unknown };
      if (typeof parsed.runId === "string" && parsed.runId.length > 0) runLabel = parsed.runId;
    } catch {
      // manifestが壊れている場合はloadSai3aRun側で詳細なエラーを出すため、ここでは無視する。
    }
  }
  return loadSai3aRun({ runLabel, sourceDir: dir, files });
}

export async function runSai3bExcelCli(argv: readonly string[], io: Sai3bCliIo, options: Sai3bCliOptions): Promise<Sai3bCliResult> {
  let args;
  try {
    args = parseSai3bCliArgs(argv);
  } catch (e) {
    return { stdout: "", stderr: `${describeError(e)}\n\n${buildSai3bUsageText()}`, exitCode: 1 };
  }

  if (args.help) {
    return { stdout: buildSai3bUsageText(), stderr: "", exitCode: 0 };
  }

  let loadedRuns: LoadedSai3aRun[];
  try {
    loadedRuns = args.inputDirs.map((dir) => loadRunFromDir(io, dir));
  } catch (e) {
    return { stdout: "", stderr: `${describeError(e)}\n`, exitCode: 1 };
  }

  const comparison = validateComparableRuns(loadedRuns);
  const warningLines: string[] = [];
  for (const w of loadedRuns.flatMap((r) => r.loadWarnings)) warningLines.push(`[警告] ${w}`);
  for (const issue of comparison.issues) warningLines.push(`[警告] ${issue}`);

  if (loadedRuns.length >= 2 && !comparison.comparable) {
    return {
      stdout: "",
      stderr:
        `複数run間の比較条件が不整合なため、比較ブックを生成できません:\n` +
        comparison.issues.map((i) => `  - ${i}`).join("\n") +
        `\n\n共通するseed・会社IDが1件も無い場合は、--inputに指定したrunディレクトリが正しいか確認してください。\n`,
      exitCode: 1,
    };
  }

  try {
    const analysis = buildSai3bAnalysis(loadedRuns, { generatedAtIso: options.generatedAtIso });
    const xlsxBuffer = await renderSai3bWorkbookToBuffer(analysis);
    const stdoutLines = [
      `SAI-3B-1 Excelブックを生成しました: ${args.outputPath}`,
      `入力run数: ${loadedRuns.length}（${loadedRuns.map((r) => r.runLabel).join(", ")}）`,
      ...warningLines,
    ];
    return { stdout: stdoutLines.join("\n") + "\n", stderr: "", exitCode: 0, xlsxBuffer, outputPath: args.outputPath };
  } catch (e) {
    return { stdout: "", stderr: `${describeError(e)}\n`, exitCode: 1 };
  }
}
