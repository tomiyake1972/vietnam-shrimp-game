#!/usr/bin/env -S npx tsx
// ShrimpX V2 — Phase SAI-3B-2: 80/85/90人比較の「軽量レビュー用サンプルブック」生成
//
// 【背景】三宅さんのご指摘（受入レビュー2回目）§6:
// 「80/85/90人比較の正式12seed版ブック（headcount-80-85-90-comparison.xlsx、
// 約74MB）はレビューにはサイズが大きすぎるため、同一の会社・seed対応関係を
// 維持したまま、代表的な3seed程度に絞り込んだ軽量版を作成してください。
// グラフ・シート構成・計算ロジックは正式版と同一のものを使用し、ファイル名で
// レビュー用であることが分かるようにし、正式12seed版を置き換えないこと。」
//
// 【方針】新しい集計・表示ロジックは一切書かない。正式版と全く同じ
// パイプライン（loadSai3aRun → validateComparableRuns → buildSai3bAnalysis →
// renderSai3bWorkbookToBuffer、すべてapp/lib/v2/companyLab/standardAi/sai3b/
// 配下の既存の純粋関数）に、seed絞り込み後のLoadedSai3aRunを渡すだけである。
// これにより「グラフ・シート構成・計算ロジックは正式版と同一」という要件を、
// コードを複製・再実装することなく構造的に保証する。
//
// 【seedのフィルタリングについて】LoadedSai3aRunの各配列（caseSummaryRows等）
// はすべてseedフィールドを持つ行データなので、単純にフィルタするだけで済む。
// 例外はrunSummary.runSummary（totalCases/errorCases/topReasonCodeCounts）で、
// これは元のrun-summary.json由来の「12seed全体」の値であり、フィルタ後の
// 行データからは自動的には再計算されない。この3フィールドだけは、フィルタ後の
// 生データから単純な件数カウント・集計を行い、正しい値に置き換える
// （新しい業務ロジックではなく、run-summary.json自体が元々行っている単純な
// カウント処理を、絞り込んだseedに対して行っているだけ）。それ以外の
// フィールド・計算はすべて既存のsai3bパイプラインにそのまま委ねる。

import * as fs from "node:fs";
import * as path from "node:path";
import {
  SAI3A_OPTIONAL_RUN_FILES,
  SAI3A_REQUIRED_RUN_FILES,
  loadSai3aRun,
} from "../app/lib/v2/companyLab/standardAi/sai3b/loadRun";
import { validateComparableRuns } from "../app/lib/v2/companyLab/standardAi/sai3b/compareRuns";
import { buildSai3bAnalysis } from "../app/lib/v2/companyLab/standardAi/sai3b/buildAnalysis";
import { renderSai3bWorkbookToBuffer } from "../app/lib/v2/companyLab/standardAi/sai3b/workbook/writeWorkbook";
import type { LoadedSai3aRun } from "../app/lib/v2/companyLab/standardAi/sai3b/schema";

// ---------------------------------------------------------------------
// 対象run・選定seed
// ---------------------------------------------------------------------

const INPUT_DIRS = [
  "artifacts/sai3a/headcount-80-12seed-8q",
  "artifacts/sai3a/headcount-85-12seed-8q",
  "artifacts/sai3a/headcount-90-12seed-8q",
];

const OUTPUT_PATH = "artifacts/sai3b/headcount-80-85-90-comparison-review-sample.xlsx";

// 選定理由（会社BALのcase-summary.csv・paymentDefaultEverByRequestedTurns列を
// 80/85/90人の3run間で突き合わせて確認した実測結果に基づく。三宅さんへの
// 完了報告書（docs/v2/reports/sai3b2_completion_report.md）にも同内容を記載）:
//
// - sai3a-001: 80/85/90人のすべてでdefaultが発生する（営業人数を増やしても
//   defaultを回避できない、いわば「底堅い」ワーストケース）。
// - sai3a-003: 85人時のみdefaultが発生し、80人・90人ではdefaultしない
//   （80_85_90人比較シートの「85人だけdefaultフラグ」が典型的に立つケース。
//   この機能の動作を確認する上で代表性が高い）。
// - sai3a-006: 80人・90人でdefaultするが85人ではしない、という非単調な
//   パターン（営業人数を増やせば増やすほど改善するとは限らないことを示す、
//   対比としての「異例」ケース）。
//
// 3seedで「一貫して悪い」「中間だけ悪い」「非単調」という3つの異なる挙動
// パターンを代表させることを狙った（三宅さんの指示: 大規模な作り直しは不要、
// 代表的なseedを選べばよい）。
const REVIEW_SAMPLE_SEEDS = ["sai3a-001", "sai3a-003", "sai3a-006"];

// ---------------------------------------------------------------------

function readFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function loadFullRun(dir: string): LoadedSai3aRun {
  const files: Record<string, string | undefined> = {};
  for (const fileName of [...SAI3A_REQUIRED_RUN_FILES, ...SAI3A_OPTIONAL_RUN_FILES]) {
    files[fileName] = readFile(path.join(dir, fileName));
  }
  const manifestText = files["manifest.json"];
  let runLabel = dir.split("/").filter((s) => s.length > 0).pop() ?? dir;
  if (manifestText !== undefined) {
    try {
      const parsed = JSON.parse(manifestText) as { runId?: unknown };
      if (typeof parsed.runId === "string" && parsed.runId.length > 0) runLabel = parsed.runId;
    } catch {
      // loadSai3aRun側で詳細エラーになるためここでは無視。
    }
  }
  return loadSai3aRun({ runLabel, sourceDir: dir, files });
}

/** LoadedSai3aRunを指定seed集合だけに絞り込む。新しい集計ロジックは追加せず、
 *  既存の行データ配列をフィルタするのみ（唯一の例外はrunSummary.runSummaryの
 *  3フィールドで、これは絞り込み後の行データから単純にカウントし直す）。 */
function filterRunToSeeds(run: LoadedSai3aRun, seeds: readonly string[]): LoadedSai3aRun {
  const seedSet = new Set(seeds);
  const caseSummaryRows = run.caseSummaryRows.filter((r) => seedSet.has(r.seed));
  const quarterSummaryRows = run.quarterSummaryRows.filter((r) => seedSet.has(r.seed));
  const decisionTraceLines = run.decisionTraceLines.filter((l) => seedSet.has(l.seed));
  const adjustmentTraceRows = run.adjustmentTraceRows.filter((r) => seedSet.has(r.seed));
  const warningRows = run.warningRows.filter((r) => seedSet.has(r.seed));
  const marketAllocationTraceRows = run.marketAllocationTraceRows.filter((r) => seedSet.has(r.seed));
  const filteredErrors = run.runSummary.errors.filter((e) => seedSet.has(e.seed));

  // topReasonCodeCounts: run-summary.json自身も単純に「そのrun内のwarningRowsを
  // code別にカウントして降順ソートしたもの」であり、これと同じ単純カウントを
  // 絞り込み後のwarningRowsに対して行うだけ（新しい業務ロジックの追加ではない）。
  const codeCounts = new Map<string, number>();
  for (const w of warningRows) codeCounts.set(w.code, (codeCounts.get(w.code) ?? 0) + 1);
  const topReasonCodeCounts = Array.from(codeCounts.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  const paymentDefaultCases = caseSummaryRows.filter((r) => r.paymentDefaultEverByRequestedTurns).length;
  const underwritingFrozenCases = caseSummaryRows.filter((r) => r.underwritingFrozenEverByRequestedTurns).length;
  const totalFinalCash = caseSummaryRows.reduce((s, r) => s + r.finalCashUsd, 0);
  const totalRevenue = caseSummaryRows.reduce((s, r) => s + r.cumulativeRevenueUsd, 0);
  const totalGrossProfit = caseSummaryRows.reduce((s, r) => s + r.cumulativeGrossProfitUsd, 0);
  const totalOperatingProfit = caseSummaryRows.reduce((s, r) => s + r.cumulativeOperatingProfitUsd, 0);

  return {
    ...run,
    manifest: { ...run.manifest, seeds: [...seeds].sort() },
    caseSummaryRows,
    quarterSummaryRows,
    decisionTraceLines,
    adjustmentTraceRows,
    warningRows,
    marketAllocationTraceRows,
    runSummary: {
      runSummary: {
        ...run.runSummary.runSummary,
        totalCases: caseSummaryRows.length + filteredErrors.length,
        completedCases: caseSummaryRows.length,
        errorCases: filteredErrors.length,
        paymentDefaultRate: caseSummaryRows.length > 0 ? paymentDefaultCases / caseSummaryRows.length : 0,
        underwritingFrozenRate: caseSummaryRows.length > 0 ? underwritingFrozenCases / caseSummaryRows.length : 0,
        averageCumulativeRevenueUsd: caseSummaryRows.length > 0 ? totalRevenue / caseSummaryRows.length : 0,
        averageCumulativeGrossProfitUsd: caseSummaryRows.length > 0 ? totalGrossProfit / caseSummaryRows.length : 0,
        averageCumulativeOperatingProfitUsd: caseSummaryRows.length > 0 ? totalOperatingProfit / caseSummaryRows.length : 0,
        averageFinalCashUsd: caseSummaryRows.length > 0 ? totalFinalCash / caseSummaryRows.length : 0,
        topReasonCodeCounts,
        totalWarningCount: warningRows.length,
      },
      errors: filteredErrors,
    },
    loadWarnings: [
      ...run.loadWarnings,
      `[review-sample] このrunはレビュー用軽量サンプルであり、元run（${run.sourceDir}）の全12seedのうち` +
        `${seeds.length}seed（${[...seeds].sort().join(", ")}）のみに絞り込んでいます。正式な12seed版の代替ではありません。`,
    ],
  };
}

async function main() {
  const fullRuns = INPUT_DIRS.map((dir) => loadFullRun(dir));
  const filteredRuns = fullRuns.map((r) => filterRunToSeeds(r, REVIEW_SAMPLE_SEEDS));

  const comparison = validateComparableRuns(filteredRuns);
  if (!comparison.comparable) {
    process.stderr.write(`比較条件が不整合です:\n${comparison.issues.map((i) => `  - ${i}`).join("\n")}\n`);
    process.exit(1);
  }

  const analysis = buildSai3bAnalysis(filteredRuns, { generatedAtIso: new Date().toISOString() });
  const xlsxBuffer = await renderSai3bWorkbookToBuffer(analysis);

  const absoluteOutputPath = path.resolve(process.cwd(), OUTPUT_PATH);
  fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
  fs.writeFileSync(absoluteOutputPath, xlsxBuffer);

  process.stdout.write(
    [
      `レビュー用軽量サンプルブックを生成しました: ${absoluteOutputPath}`,
      `対象seed（${REVIEW_SAMPLE_SEEDS.length}件、全12seed中）: ${REVIEW_SAMPLE_SEEDS.join(", ")}`,
      `ファイルサイズ: ${(xlsxBuffer.length / 1024 / 1024).toFixed(2)} MB`,
      ...comparison.issues.map((i) => `[警告] ${i}`),
    ].join("\n") + "\n"
  );
}

main().catch((e) => {
  process.stderr.write(`予期しないエラー: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
