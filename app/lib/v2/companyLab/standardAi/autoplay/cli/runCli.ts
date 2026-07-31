// ShrimpX V2 — Phase SAI-3A: 自動テストプレイCLI 実行オーケストレーション
//
// companyLab/cli/runCli.tsと同じ方針。process.argv・console.log・process.exit・
// fsには一切触れない（scripts/sai3aAutoplay.tsが唯一の副作用を持つ薄い
// エントリポイントで、ここが返すfilesマップをそのまま書き出すだけ）。
// 既存のrunAutoplayBatch（バッチ実行・エラー隔離）・output.ts（ファイル内容整形）を
// そのまま呼び出すだけで、新しいシミュレーション・新しい集計ロジックは持たない。

import { CompanyLabError } from "../../../types";
import { STANDARD_BASELINE_CANDIDATES } from "../../report/standardBaseline";
import { runAutoplayBatch } from "../runBatch";
import {
  formatAdjustmentTraceCsv,
  formatCaseSummaryCsv,
  formatDecisionTraceJsonl,
  formatManifestJson,
  formatMarketAllocationTraceCsv,
  formatQuarterSummaryCsv,
  formatRunSummaryJson,
  formatSai5LifecycleMixTraceCsv,
  formatSai5MarketEvolutionTraceCsv,
  formatSai5SalesBaseTraceCsv,
  formatWarningsCsv,
} from "../output";
import { AutoplayRunManifest, SAI3A_LOG_SCHEMA_VERSION, SaiCompanyId } from "../schema";
import { parseAutoplayCliArgs, buildAutoplayUsageText } from "./argParser";
import { AutoplayCliInvocationResult, CliArgumentError } from "./types";

const AI_POLICY_VERSION = "STANDARD_AI_PARAMETERS_V1";

function describeError(e: unknown): string {
  if (e instanceof CliArgumentError) return `引数エラー: ${e.message}`;
  if (e instanceof CompanyLabError) return `シミュレーションエラー: ${e.message}`;
  if (e instanceof Error) return `予期しないエラー: ${e.message}`;
  return "予期しないエラーが発生しました。";
}

export interface AutoplayCliOptions {
  /** 実行日時（ISO8601）。再現性の対象外の参考情報のため、副作用（Date生成）は
   *  呼び出し元（scripts/側）が担い、ここへ値として渡す（本関数は純粋関数のまま）。 */
  readonly executedAtIso?: string;
  /** このrunを実行したgit commit ID。同上の理由で呼び出し元から値として渡す。 */
  readonly appCommitId?: string;
}

/**
 * CLIの入口。argvを解析し、既存のrunAutoplayBatchを呼び出し、出力ファイル一式
 * （マニフェスト・ケースサマリー・四半期サマリー・意思決定トレース・調整トレース・
 * 警告一覧・run全体サマリー）の内容を組み立てて返す。実際のfs書き込みは
 * scripts/sai3aAutoplay.tsが行う。
 */
export function runAutoplayCli(argv: readonly string[], options: AutoplayCliOptions = {}): AutoplayCliInvocationResult {
  let args;
  try {
    args = parseAutoplayCliArgs(argv);
  } catch (e) {
    return { stdout: "", stderr: `${describeError(e)}\n\n${buildAutoplayUsageText()}`, exitCode: 1 };
  }

  if (args.help) {
    return { stdout: buildAutoplayUsageText(), stderr: "", exitCode: 0 };
  }

  const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === args.baselineId);
  if (!candidate) {
    // parseAutoplayCliArgsで既に検証済みのため通常到達しないが、念のためのガード。
    return { stdout: "", stderr: `引数エラー: 標準初期条件の候補 "${args.baselineId}" を解決できません。\n`, exitCode: 1 };
  }

  try {
    const batch = runAutoplayBatch({
      runId: args.runId,
      scenarioId: args.scenario,
      seeds: args.seeds,
      quarters: args.quarters,
      companyIds: args.companyIds,
      candidate,
      salesForceHeadcountOverride: args.salesForceHeadcountOverride,
      aquacultureCapacityOverrideHosoEqTons: args.aquacultureCapacityOverrideHosoEqTons,
      managementProfilesEnabled: args.managementProfilesEnabled,
      marketProductOrientationEnabled: args.marketProductOrientationEnabled,
      heterogeneousInitialConditionsEnabled: args.heterogeneousInitialConditionsEnabled,
      productLifecycleEnabled: args.productLifecycleEnabled,
      salesBaseAccumulationEnabled: args.salesBaseAccumulationEnabled,
      supplyPremiumFeedbackEnabled: args.supplyPremiumFeedbackEnabled,
      standardAiCapexEnabled: args.standardAiCapexEnabled,
    });

    // 標準営業人数は「実際に実行された1ケース目の四半期開始時状態」から観測する
    // （headcount overrideの有無に関わらず、実際に使われた値を正とする。候補側の
    // 既定値を別途再計算・重複実装しない）。
    const observedHeadcount =
      batch.caseLogs[0]?.quarterStartStates[0]?.salesForceHeadcountTotal ?? args.salesForceHeadcountOverride ?? NaN;

    const manifest: AutoplayRunManifest = {
      schemaVersion: SAI3A_LOG_SCHEMA_VERSION,
      appCommitId: options.appCommitId,
      executedAtIso: options.executedAtIso,
      runId: args.runId,
      scenarioId: args.scenario,
      standardBaselineId: args.baselineId,
      seeds: args.seeds,
      quarters: args.quarters,
      companyIds: args.companyIds as readonly SaiCompanyId[],
      aiPolicyVersion: AI_POLICY_VERSION,
      salesForceHeadcountTotal: observedHeadcount,
      keyParameters: {
        salesForceHeadcountOverrideSpecified: args.salesForceHeadcountOverride !== undefined,
        // 【SAI-4追加】三宅さんの追加条件2「分析成果物とrun metadataには、
        // aquacultureCapacityOverride = 4000が適用されたことを記録する」に対応。
        // keyParametersはRecord<string, number|string|boolean>として拡張可能に
        // 設計されており（SAI-3Bのマニフェストパーサーの必須フィールド一覧にも
        // 含まれない）、既存のSAI-3A/3Bの成果物・パーサーへの影響はゼロ。
        aquacultureCapacityOverrideSpecified: args.aquacultureCapacityOverrideHosoEqTons !== undefined,
        aquacultureCapacityOverrideHosoEqTons: args.aquacultureCapacityOverrideHosoEqTons ?? -1,
        managementProfilesEnabled: args.managementProfilesEnabled,
        // 【SAI-5】各機能フラグ（A/B比較の再現条件をmanifestへ記録）。
        marketProductOrientationEnabled: args.marketProductOrientationEnabled,
        heterogeneousInitialConditionsEnabled: args.heterogeneousInitialConditionsEnabled,
        productLifecycleEnabled: args.productLifecycleEnabled,
        salesBaseAccumulationEnabled: args.salesBaseAccumulationEnabled,
        supplyPremiumFeedbackEnabled: args.supplyPremiumFeedbackEnabled,
        standardAiCapexEnabled: args.standardAiCapexEnabled,
      },
      outputFormats: ["json", "csv"],
    };

    const files: Record<string, string> = {
      "manifest.json": formatManifestJson(manifest),
      "case-summary.csv": formatCaseSummaryCsv(batch),
      "quarter-summary.csv": formatQuarterSummaryCsv(batch),
      "decision-trace.jsonl": formatDecisionTraceJsonl(batch),
      "adjustment-trace.csv": formatAdjustmentTraceCsv(batch),
      "warnings.csv": formatWarningsCsv(batch),
      "market-allocation-trace.csv": formatMarketAllocationTraceCsv(batch),
      "run-summary.json": formatRunSummaryJson(batch),
    };
    // 【SAI-5G】市場進化・営業基盤の因果トレース（SAI-5機能フラグ有効時のみ
    // データが存在する任意ファイル。無効なrunではファイル自体を生成しない）。
    const sai5MarketEvolutionCsv = formatSai5MarketEvolutionTraceCsv(batch);
    if (sai5MarketEvolutionCsv !== undefined) files["market-evolution-trace.csv"] = sai5MarketEvolutionCsv;
    const sai5LifecycleMixCsv = formatSai5LifecycleMixTraceCsv(batch);
    if (sai5LifecycleMixCsv !== undefined) files["lifecycle-mix-trace.csv"] = sai5LifecycleMixCsv;
    const sai5SalesBaseCsv = formatSai5SalesBaseTraceCsv(batch);
    if (sai5SalesBaseCsv !== undefined) files["sales-base-trace.csv"] = sai5SalesBaseCsv;

    const outputDir = `${args.outDir}/${args.runId}`;
    const stdout = `run "${args.runId}" 完了: 完了ケース ${batch.runSummary.completedCases}/${batch.runSummary.totalCases}、エラー ${batch.runSummary.errorCases}件。出力先: ${outputDir}/\n`;
    return { stdout, stderr: "", exitCode: 0, files, outputDir };
  } catch (e) {
    return { stdout: "", stderr: `${describeError(e)}\n`, exitCode: 1 };
  }
}
