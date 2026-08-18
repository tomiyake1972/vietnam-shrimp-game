"use client";

// ShrimpX V2 — Game End / Final Results（END-3）: 5社比較チャート5種
//
// 【新しい計算をしない】Revenue/Operating Profit/PATは既存toCompanySeries
// （analytics/views.ts）をそのまま呼ぶ。Dividend/TSVはbuildDividendSeries/
// buildTsvSeries（analytics/finalResultsSeries.ts）をそのまま呼ぶ。
// このコンポーネント自身は一切の集計・計算を行わない。
//
// 【32Turn固定にしない(指示§10/§13)】totalTurnsは呼び出し側が渡すGame End Turn。
// Turn12で終わったRunでも、Turn32まで走ったRunでも、同じコンポーネントで描く。

import { CompanyFixture, CompanyQuarterRecord } from "../../../lib/v2/companyLab/types";
import { SimulationAnalyticsDataset } from "../../../lib/v2/companyLab/simulation/analytics/types";
import { toCompanySeries } from "../../../lib/v2/companyLab/simulation/analytics/views";
import { buildDividendSeries, buildTsvSeries } from "../../../lib/v2/companyLab/simulation/analytics/finalResultsSeries";
import { SeriesChart } from "./SeriesChart";

export function FinalResultsCharts({
  dataset,
  history,
  fixtures,
  gameEndTurn,
  highlightKey,
}: {
  readonly dataset: SimulationAnalyticsDataset;
  readonly history: readonly CompanyQuarterRecord[];
  readonly fixtures: readonly CompanyFixture[];
  readonly gameEndTurn: number;
  readonly highlightKey?: string | null;
}) {
  const revenueSeries = toCompanySeries(dataset, "revenue").map((s) => ({ key: s.companyId, label: s.displayName, color: s.color, points: s.points }));
  const profitSeries = toCompanySeries(dataset, "operatingProfit").map((s) => ({ key: s.companyId, label: s.displayName, color: s.color, points: s.points }));
  const patSeries = toCompanySeries(dataset, "netIncome").map((s) => ({ key: s.companyId, label: s.displayName, color: s.color, points: s.points }));
  const dividendSeries = buildDividendSeries(history, fixtures, gameEndTurn).map((s) => ({ key: s.companyId, label: s.displayName, color: s.color, points: s.points }));
  const tsvSeries = buildTsvSeries(history, fixtures, gameEndTurn).map((s) => ({ key: s.companyId, label: s.displayName, color: s.color, points: s.points }));

  return (
    <div className="space-y-3" data-testid="final-results-charts">
      <SeriesChart
        title="Total Shareholder Value 推移（5社）"
        series={tsvSeries}
        totalTurns={gameEndTurn}
        highlightKey={highlightKey}
        unitLabel="USD"
        testId="final-results-chart-tsv"
        emptyMessage="TSV推移を表示するには確定Turnが必要です。"
      />
      <SeriesChart
        title="売上高推移（5社）"
        series={revenueSeries}
        totalTurns={gameEndTurn}
        highlightKey={highlightKey}
        unitLabel="USD"
        testId="final-results-chart-revenue"
        emptyMessage="まだデータがありません。"
      />
      <SeriesChart
        title="営業利益推移（5社）"
        series={profitSeries}
        totalTurns={gameEndTurn}
        highlightKey={highlightKey}
        unitLabel="USD"
        testId="final-results-chart-operating-profit"
        emptyMessage="まだデータがありません。"
      />
      <SeriesChart
        title="税引後利益（PAT）推移（5社）"
        series={patSeries}
        totalTurns={gameEndTurn}
        highlightKey={highlightKey}
        unitLabel="USD"
        testId="final-results-chart-pat"
        emptyMessage="まだデータがありません。"
      />
      <SeriesChart
        title="配当推移（5社）"
        series={dividendSeries}
        totalTurns={gameEndTurn}
        highlightKey={highlightKey}
        unitLabel="USD"
        testId="final-results-chart-dividend"
        emptyMessage="配当実績がまだありません。"
      />
    </div>
  );
}
