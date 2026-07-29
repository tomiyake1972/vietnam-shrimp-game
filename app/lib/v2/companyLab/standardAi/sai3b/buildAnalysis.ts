// ShrimpX V2 — Phase SAI-3B-1: 分析データ一式の組み立て（純粋関数、fs非依存）
//
// 複数のLoadedSai3aRun（loadRun.tsで読み込み済み）から、Excelブックの各シートに
// 対応する集計データ一式（Sai3bAnalysis）を組み立てる。ここではExcelJSに一切
// 触れない（workbook/writeWorkbook.tsが本オブジェクトを受け取ってシート化する）。

import { validateComparableRuns } from "./compareRuns";
import { LoadedSai3aRun, Sai3bAnalysis, SAI3B_VERSION } from "./schema";
import {
  buildAdjustmentAnalysis,
  buildCompanyPerformance,
  buildDashboardSummary,
  buildDecisionTrace,
  buildDefaultWarningEvents,
  buildHeadcountComparison,
  buildProcurementProduction,
  buildQuarterPerformance,
  buildReasonCodeTally,
  buildSalesAnalysis,
  buildSalesCapacity,
  buildSalesCapacityMarketBreakdown,
} from "./aggregate";

export interface BuildSai3bAnalysisOptions {
  /** ブック生成日時（ISO8601）。再現性・テスト容易性のため、呼び出し元
   *  （CLI層）がDate.now()由来の値を注入する（本関数自体は純粋関数のまま）。 */
  readonly generatedAtIso: string;
}

const MISSING_FIELD_NOTES: readonly string[] = [
  "四半期結果側の実際の生産量（QuarterResultLog.productionQuantityByProduct、生産能力制約後の実績値）は" +
    "SAI-3Aのいずれの出力ファイル（quarter-summary.csv/decision-trace.jsonl）にも含まれていないため、" +
    "本ブックでは取得できない。四半期業績シート・調達生産在庫シートの生産量は、AIが提出した生産計画" +
    "（productionDesiredQuantityByProduct）であり、実績ではない点に注意（三宅さんの指示11.3）。",
  "実際に成約・履行された販売数量（QuarterResultLog.newContractedQuantityHosoEqTons・" +
    "fulfilledQuantityHosoEqTons・outstandingQuantityHosoEqTons・overdueQuantityHosoEqTons）は同様に" +
    "SAI-3Aの出力ファイルに含まれていないため取得できない。販売分析・四半期業績シートの販売数量は、" +
    "営業工数制約適用後にquarter runnerへ渡された「最終計画数量」（salesQuantityTrace.finalPlannedQuantity）" +
    "であり、市場での実際の成約結果とは異なる可能性がある。",
  "四半期末時点の売掛金・買掛金残高はSAI-3Aの出力に含まれていない。四半期業績シートの売掛金・買掛金は" +
    "「四半期開始時点」の値（QuarterStartState由来）であり、期末残高ではない。",
  "市場別の営業工数換算能力・使用率（HOSO×1.0+PD×1.2+VAP×3.0の係数を用いた値）は、会社全体の合計値のみ" +
    "quarter-summary.csvに含まれており、市場別の内訳はSAI-3Aの出力に含まれていない。営業能力分析シートの" +
    "市場別内訳（4-7下段）は、係数を用いた再計算を避けるため、物理数量（トン）ベースの希望量・最終計画量・" +
    "削減量のみを示す。",
  "売上総利益・営業利益の商品別・市場別内訳（粗利益の詳細な要因分解）はSAI-3Aの出力に含まれていないため、" +
    "販売分析シートでは単価・粗利益列を提供できない（三宅さんの指示4-5「可能なら」に対応できなかった項目）。",
];

/** 複数（1件を含む）のLoadedSai3aRunから、Sai3bAnalysis（全シートぶんの集計結果）を組み立てる。 */
export function buildSai3bAnalysis(loadedRuns: readonly LoadedSai3aRun[], options: BuildSai3bAnalysisOptions): Sai3bAnalysis {
  const comparison = validateComparableRuns(loadedRuns);

  return {
    generatedAtIso: options.generatedAtIso,
    sai3bVersion: SAI3B_VERSION,
    loadedRuns,
    comparison,
    dashboard: buildDashboardSummary(loadedRuns),
    companyPerformance: buildCompanyPerformance(loadedRuns),
    quarterPerformance: buildQuarterPerformance(loadedRuns),
    salesAnalysis: buildSalesAnalysis(loadedRuns),
    procurementProduction: buildProcurementProduction(loadedRuns),
    salesCapacity: buildSalesCapacity(loadedRuns),
    salesCapacityMarketBreakdown: buildSalesCapacityMarketBreakdown(loadedRuns),
    adjustmentAnalysis: buildAdjustmentAnalysis(loadedRuns),
    defaultWarningEvents: buildDefaultWarningEvents(loadedRuns),
    reasonCodeTally: buildReasonCodeTally(loadedRuns),
    headcountComparison: buildHeadcountComparison(loadedRuns, comparison.commonSeeds, comparison.commonCompanyIds),
    decisionTrace: buildDecisionTrace(loadedRuns),
    missingFieldReports: MISSING_FIELD_NOTES,
  };
}
