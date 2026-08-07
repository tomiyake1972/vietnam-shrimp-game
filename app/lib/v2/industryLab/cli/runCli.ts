// ShrimpX V2 — 業界シミュレーション CLI（差分） 実行オーケストレーション
//
// 画面（app/v2/industry-lab/page.tsx）と同じく、計算そのものは一切行わず
// Phase 3ですでに実装済みの runIndustrySimulation / compareIndustrySimulations
// をそのまま呼び出すだけ。process.argv・console.log・process.exitには
// 一切触れない（scripts/v2Simulate.ts が唯一の副作用を持つ薄いエントリ
// ポイント）ため、このファイル自体はNode専用APIに依存せず、そのまま
// ユニットテストできる。

import { runIndustrySimulation } from "../simulationRunner";
import { compareIndustrySimulations } from "../ui/comparison";
import { IndustrySimulationConfig, IndustrySimulationError } from "../types";
import { parseCliArgs, buildUsageText } from "./argParser";
import { resolveScenarioDefinition } from "./scenarioAliases";
import { CliArgumentError, CliInvocationResult } from "./types";
import {
  formatResultAsSummary,
  formatResultAsJson,
  formatResultAsCsv,
  formatComparisonAsSummary,
  formatComparisonAsJson,
  formatComparisonAsCsv,
} from "./output";

function describeError(e: unknown): string {
  if (e instanceof CliArgumentError) return `引数エラー: ${e.message}`;
  if (e instanceof IndustrySimulationError) return `シミュレーションエラー: ${e.message}`;
  if (e instanceof Error) return `予期しないエラー: ${e.message}`;
  return "予期しないエラーが発生しました。";
}

/**
 * CLIの入口。argvを解析し、既存の純粋なシミュレーション関数を呼び出し、
 * 要求された形式で整形した結果を返す。標準出力・標準エラー出力への実際の
 * 書き込みと終了コードでのプロセス終了は呼び出し元（scripts/v2Simulate.ts）
 * が行う。
 */
export function runCli(argv: readonly string[]): CliInvocationResult {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    return { stdout: "", stderr: `${describeError(e)}\n\n${buildUsageText()}`, exitCode: 1 };
  }

  if (args.help) {
    return { stdout: buildUsageText(), stderr: "", exitCode: 0 };
  }

  const scenarioDefinition = resolveScenarioDefinition(args.scenario);
  if (!scenarioDefinition) {
    // parseCliArgsですでに検証済みのため通常到達しないが、念のためのガード。
    return { stdout: "", stderr: `引数エラー: シナリオ "${args.scenario}" を解決できません。\n`, exitCode: 1 };
  }

  const config: IndustrySimulationConfig = {
    scenarioId: scenarioDefinition.scenarioId,
    mode: args.mode,
    seed: args.seed,
    turns: args.turns,
  };

  try {
    const result = runIndustrySimulation(config);

    if (args.compareScenario !== undefined) {
      const compareDefinition = resolveScenarioDefinition(args.compareScenario);
      if (!compareDefinition) {
        return { stdout: "", stderr: `引数エラー: 比較対象シナリオ "${args.compareScenario}" を解決できません。\n`, exitCode: 1 };
      }
      const compareConfig: IndustrySimulationConfig = { ...config, scenarioId: compareDefinition.scenarioId };
      const compareResult = runIndustrySimulation(compareConfig);
      const comparison = compareIndustrySimulations(result, compareResult);
      const labels = { scenarioTitleA: scenarioDefinition.title, scenarioTitleB: compareDefinition.title };

      const stdout =
        args.format === "json"
          ? formatComparisonAsJson(result, compareResult, comparison, labels)
          : args.format === "csv"
            ? formatComparisonAsCsv(comparison)
            : formatComparisonAsSummary(result, compareResult, comparison, labels);

      return { stdout, stderr: "", exitCode: 0 };
    }

    const stdout =
      args.format === "json"
        ? formatResultAsJson(result, scenarioDefinition.title)
        : args.format === "csv"
          ? formatResultAsCsv(result)
          : formatResultAsSummary(result, scenarioDefinition.title);

    return { stdout, stderr: "", exitCode: 0 };
  } catch (e) {
    return { stdout: "", stderr: `${describeError(e)}\n`, exitCode: 1 };
  }
}
