// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） CLI 実行オーケストレーション
//
// 画面（app/v2/company-lab/page.tsx）と同じ統合ランナー
// （runCompanyLabWithAutoPolicyForAllCompanies + generateAutoPolicyDecision）を
// そのまま呼び出すだけ。process.argv・console.log・process.exitには一切
// 触れない（scripts/v2CompanySimulate.ts が唯一の副作用を持つ薄いエントリ
// ポイント）ため、このファイル自体はNode専用APIに依存せず、そのまま
// ユニットテストできる。Redis・API Route・生成AIには一切依存しない。

import { resolveScenarioDefinition } from "../../industryLab/cli/scenarioAliases";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyLabError, CompanyLabConfig } from "../types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../runner";
import { parseCompanyLabCliArgs, buildCompanyLabUsageText } from "./argParser";
import { CliArgumentError, CliInvocationResult } from "./types";
import { formatCompanyLabResultAsCsv, formatCompanyLabResultAsJson, formatCompanyLabResultAsSummary } from "./output";

function describeError(e: unknown): string {
  if (e instanceof CliArgumentError) return `引数エラー: ${e.message}`;
  if (e instanceof CompanyLabError) return `シミュレーションエラー: ${e.message}`;
  if (e instanceof Error) return `予期しないエラー: ${e.message}`;
  return "予期しないエラーが発生しました。";
}

/**
 * CLIの入口。argvを解析し、既存の純粋な統合ランナーを呼び出し、要求された
 * 形式で整形した結果を返す。標準出力・標準エラー出力への実際の書き込みと
 * 終了コードでのプロセス終了は呼び出し元（scripts/v2CompanySimulate.ts）が行う。
 */
export function runCompanyLabCli(argv: readonly string[]): CliInvocationResult {
  let args;
  try {
    args = parseCompanyLabCliArgs(argv);
  } catch (e) {
    return { stdout: "", stderr: `${describeError(e)}\n\n${buildCompanyLabUsageText()}`, exitCode: 1 };
  }

  if (args.help) {
    return { stdout: buildCompanyLabUsageText(), stderr: "", exitCode: 0 };
  }

  const scenarioDefinition = resolveScenarioDefinition(args.scenario);
  if (!scenarioDefinition) {
    // parseCompanyLabCliArgsですでに検証済みのため通常到達しないが、念のためのガード。
    return { stdout: "", stderr: `引数エラー: シナリオ "${args.scenario}" を解決できません。\n`, exitCode: 1 };
  }

  const config: CompanyLabConfig = {
    scenarioId: scenarioDefinition.scenarioId,
    mode: args.mode,
    seed: args.seed,
    turns: args.turns,
  };

  try {
    const result = runCompanyLabWithAutoPolicyForAllCompanies(config, generateAutoPolicyDecision);

    const stdout =
      args.format === "json"
        ? formatCompanyLabResultAsJson(result, scenarioDefinition.title, args.company)
        : args.format === "csv"
          ? formatCompanyLabResultAsCsv(result, args.company)
          : formatCompanyLabResultAsSummary(result, scenarioDefinition.title, args.company);

    return { stdout, stderr: "", exitCode: 0 };
  } catch (e) {
    return { stdout: "", stderr: `${describeError(e)}\n`, exitCode: 1 };
  }
}
