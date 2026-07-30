// ShrimpX V2 — Phase SAI-3A: 判断記録基盤 — 複数seedのバッチ実行（ケース単位のエラー隔離）
//
// 【方針】1 seedの実行・ログ組み立ては既存のrunAutoplayCase（既存ハーネスの薄い
// ラッパー）・buildAutoplayCaseLogs（純粋な組み立て関数）にすべて委譲する。本ファイル
// が新たに持つロジックは「seed単位のtry/catchによるエラー隔離」と「run全体の集計
// （RunSummary）」のみ。1件のseedが失敗しても、残りのseedの実行を継続する
// （三宅さんの指示§2「一部が失敗しても残りのケースの実行を続行し、失敗の診断情報を
// 保持する」に対応）。

import { CompanyId } from "../../../sales/types";
import { StandardBaselineCandidate } from "../report/standardBaseline";
import { runAutoplayCase } from "./runCase";
import { buildAutoplayCaseLogs } from "./buildLog";
import { AutoplayCaseLog, CaseError, RunSummary, SaiCompanyId } from "./schema";

export interface AutoplayBatchConfig {
  readonly runId: string;
  readonly scenarioId: string;
  readonly seeds: readonly string[];
  readonly quarters: number;
  readonly companyIds: readonly CompanyId[];
  readonly candidate: StandardBaselineCandidate;
  /** 標準候補の営業人数を上書きする場合の値（未指定なら候補既定値のまま）。 */
  readonly salesForceHeadcountOverride?: number;
  /** 【SAI-4追加】5社共通の養殖能力上書き値（HOSO換算トン）。runCase.tsのAutoplayCaseConfig
   *  参照。未指定なら候補既定値のまま。 */
  readonly aquacultureCapacityOverrideHosoEqTons?: number;
  /** 【SAI-4追加】trueの場合のみ経営性格プロファイル（managementProfile.ts）を適用する。 */
  readonly managementProfilesEnabled?: boolean;
}

export interface AutoplayBatchResult {
  readonly runId: string;
  readonly caseLogs: readonly AutoplayCaseLog[];
  readonly errors: readonly CaseError[];
  readonly runSummary: RunSummary;
}

/**
 * 指定した全seedを順に実行する。1件のseedの実行（runAutoplayCase）または
 * ログ組み立て（buildAutoplayCaseLogs）が例外を投げても、そのseedをCaseErrorとして
 * 記録し、残りのseedの実行を継続する（一つの失敗が全体を止めない）。
 */
export function runAutoplayBatch(config: AutoplayBatchConfig): AutoplayBatchResult {
  const caseLogs: AutoplayCaseLog[] = [];
  const errors: CaseError[] = [];

  for (const seed of config.seeds) {
    try {
      const caseResult = runAutoplayCase({
        scenarioId: config.scenarioId,
        seed,
        quarters: config.quarters,
        companyIds: config.companyIds,
        candidate: config.candidate,
        salesForceHeadcountOverride: config.salesForceHeadcountOverride,
        aquacultureCapacityOverrideHosoEqTons: config.aquacultureCapacityOverrideHosoEqTons,
        managementProfilesEnabled: config.managementProfilesEnabled,
      });
      caseLogs.push(buildAutoplayCaseLogs(caseResult));
    } catch (err) {
      errors.push({
        seed,
        companyIds: config.companyIds as readonly SaiCompanyId[],
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  const runSummary = buildRunSummary(config.runId, caseLogs, errors, config.seeds.length * config.companyIds.length);
  return { runId: config.runId, caseLogs, errors, runSummary };
}

/** 全ケース（全seed×全社）のCaseSummaryRowから、run全体の集計値を作る。 */
export function buildRunSummary(
  runId: string,
  caseLogs: readonly AutoplayCaseLog[],
  errors: readonly CaseError[],
  totalCases: number
): RunSummary {
  const rows = caseLogs.flatMap((log) => log.caseSummaryRows);
  const completedCases = rows.length;
  const errorCases = totalCases - completedCases;

  const paymentDefaultCount = rows.filter((r) => r.paymentDefaultEverByRequestedTurns).length;
  const underwritingFrozenCount = rows.filter((r) => r.underwritingFrozenEverByRequestedTurns).length;

  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const avg = (f: (r: (typeof rows)[number]) => number) => (completedCases > 0 ? sum(f) / completedCases : 0);

  const reasonCodeCounts = new Map<string, number>();
  let totalWarningCount = 0;
  for (const row of rows) {
    for (const code of row.topReasonCodes) {
      // topReasonCodesはケースごとの上位5件のみのため、run全体での「登場ケース数」
      // としての近似集計になる（正確な総出現回数はケースごとのwarningCount経由でのみ
      // 概算できる。厳密な全件集計が必要な場合はquarterResultLog.reasonCodesを
      // 走査するSAI-3B側の集計に委ねる）。
      reasonCodeCounts.set(code, (reasonCodeCounts.get(code) ?? 0) + 1);
    }
    totalWarningCount += row.warningCount;
  }
  const topReasonCodeCounts = Array.from(reasonCodeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([code, count]) => ({ code, count }));

  return {
    runId,
    totalCases,
    completedCases,
    errorCases: Math.max(errorCases, errors.length),
    paymentDefaultRate: completedCases > 0 ? paymentDefaultCount / completedCases : 0,
    underwritingFrozenRate: completedCases > 0 ? underwritingFrozenCount / completedCases : 0,
    averageCumulativeRevenueUsd: avg((r) => r.cumulativeRevenueUsd),
    averageCumulativeGrossProfitUsd: avg((r) => r.cumulativeGrossProfitUsd),
    averageCumulativeOperatingProfitUsd: avg((r) => r.cumulativeOperatingProfitUsd),
    averageFinalCashUsd: avg((r) => r.finalCashUsd),
    topReasonCodeCounts,
    totalWarningCount,
  };
}
