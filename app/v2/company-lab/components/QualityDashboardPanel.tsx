// ShrimpX V2 — 会社経営統合テスト環境 品質・信頼・納期ダッシュボード（Phase 7B） ルートパネル
//
// A〜D・警告・8/32ターン推移（選択中1社ぶん）と、5社比較（GM専用）を束ねる
// コンテナ。計算ロジックは一切持たず、dashboardViewModel/dashboardWarnings/
// dashboardExplanationの純粋関数と、下位の表示コンポーネントを呼び出すだけ。

import { CompanyFixture, CompanyQuarterRecord } from "../../../lib/v2/companyLab";
import { DEMAND_MARKET_IDS } from "../../../lib/v2/market/types";
import {
  buildCompanyComparisonRows,
  buildCompetitivenessExplanationRows,
  buildMarketTrustRows,
  buildProductQualityRows,
  buildSummaryCardViewModel,
  buildTrendGroups,
} from "../dashboardViewModel";
import { buildWarnings, topWarning } from "../dashboardWarnings";
import QualitySummaryCard from "./QualitySummaryCard";
import QualityProductTable from "./QualityProductTable";
import QualityMarketTrustTable from "./QualityMarketTrustTable";
import QualityCompetitivenessExplanation from "./QualityCompetitivenessExplanation";
import QualityWarningsList from "./QualityWarningsList";
import QualityCompanyComparison from "./QualityCompanyComparison";
import QualityTrendPanel from "./QualityTrendPanel";

interface QualityDashboardPanelProps {
  readonly record: CompanyQuarterRecord;
  readonly previousRecord?: CompanyQuarterRecord;
  readonly history: readonly CompanyQuarterRecord[];
  readonly fixtures: readonly CompanyFixture[];
  readonly companyId: string;
  readonly displayName: string;
  readonly showCompanyComparison: boolean;
}

export default function QualityDashboardPanel(props: QualityDashboardPanelProps) {
  const { record, previousRecord, history, fixtures, companyId, displayName, showCompanyComparison } = props;

  const summary = buildSummaryCardViewModel(record, companyId);
  const productRows = buildProductQualityRows(record, companyId);
  const marketRows = buildMarketTrustRows(record, companyId, DEMAND_MARKET_IDS, previousRecord);
  const explanationRows = buildCompetitivenessExplanationRows(record, companyId, previousRecord);
  const warnings = buildWarnings(record, companyId);

  if (!summary) {
    return <div className="bg-gray-800 rounded-2xl p-8 text-center text-gray-400 text-sm">この会社の当期データが見つかりません。</div>;
  }

  return (
    <div className="space-y-5">
      <QualitySummaryCard displayName={displayName} summary={summary} topWarning={topWarning(warnings)} />
      <QualityWarningsList warnings={warnings} />
      <QualityProductTable rows={productRows} />
      <QualityMarketTrustTable rows={marketRows} />
      <QualityCompetitivenessExplanation rows={explanationRows} />
      <QualityTrendPanel
        buildGroups={(turnsWindow) => buildTrendGroups(history, companyId, turnsWindow, DEMAND_MARKET_IDS)}
        maxAvailableTurns={history.length}
      />
      {showCompanyComparison && (
        <QualityCompanyComparison buildRows={(productFilter, marketFilter) => buildCompanyComparisonRows(record, fixtures, productFilter, marketFilter)} />
      )}
    </div>
  );
}
