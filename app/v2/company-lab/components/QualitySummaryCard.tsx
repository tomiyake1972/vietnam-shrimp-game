// ShrimpX V2 — 会社経営統合テスト環境 品質ダッシュボード（Phase 7B） A. 当期経営サマリー
//
// dashboardViewModel.buildSummaryCardViewModel / dashboardWarnings.buildWarnings が
// 既に抽出・集約した値を表示するだけの純粋な表示コンポーネント。品質・リスク・
// 事故判定の計算は一切行わない。

import { SummaryCardViewModel } from "../dashboardViewModel";
import { WarningViewModel } from "../dashboardWarnings";
import { formatHosoEqTons, formatScore } from "../../../lib/v2/industryLab/ui/formatters";

interface QualitySummaryCardProps {
  readonly displayName: string;
  readonly summary: SummaryCardViewModel;
  readonly topWarning?: WarningViewModel;
}

function StatCell(props: { readonly label: string; readonly value: string; readonly emphasis?: boolean }) {
  return (
    <div className={`rounded-lg px-3 py-2 ${props.emphasis ? "bg-red-950/40 border border-red-700/50" : "bg-gray-900/50"}`}>
      <div className="text-[11px] text-gray-500">{props.label}</div>
      <div className={`text-sm ${props.emphasis ? "text-red-200 font-semibold" : "text-gray-100"}`}>{props.value}</div>
    </div>
  );
}

const SEVERITY_STYLE: Record<string, string> = {
  重大: "bg-red-950/70 border-red-600 text-red-200",
  警戒: "bg-amber-950/70 border-amber-600 text-amber-200",
  注意: "bg-yellow-950/50 border-yellow-700/60 text-yellow-200",
};

export default function QualitySummaryCard(props: QualitySummaryCardProps) {
  const { displayName, summary, topWarning } = props;

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-base font-semibold text-gray-100">
          当期経営サマリー — {summary.companyId}（{displayName}） / {summary.period}
        </h3>
        {summary.hasMajorIncident && (
          <span className="text-xs font-bold bg-red-700 text-white rounded-full px-3 py-1 animate-pulse">
            ⚠ 重大品質事故 発生（{summary.majorIncidentCount}件）
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCell label="総生産量" value={formatHosoEqTons(summary.totalProductionQuantity)} />
        <StatCell label="販売可能完成品数量" value={formatHosoEqTons(summary.saleableFinishedGoodsQuantity)} />
        <StatCell label="格落ち量" value={formatHosoEqTons(summary.downgradeQuantity)} />
        <StatCell label="再加工量" value={formatHosoEqTons(summary.reworkQuantity)} />
        <StatCell label="廃棄量" value={formatHosoEqTons(summary.discardQuantity)} emphasis={summary.discardQuantity > 0} />
        <StatCell label="納期遵守率" value={summary.onTimeDeliveryRate !== undefined ? formatScore(summary.onTimeDeliveryRate) : "対象なし"} />
        <StatCell label="重大品質事故" value={summary.hasMajorIncident ? `あり（${summary.majorIncidentCount}件）` : "なし"} emphasis={summary.hasMajorIncident} />
      </div>

      <p className="text-[11px] text-gray-500">
        廃棄だけが販売可能数量を減らします。格落ち・再加工は数量損失ではなく、記録用の内訳です（総生産量 = 販売可能完成品数量 + 廃棄量）。
      </p>

      {topWarning && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${SEVERITY_STYLE[topWarning.severity] ?? SEVERITY_STYLE["注意"]}`}>
          <span className="font-semibold">
            最も大きい操業上の警告［{topWarning.severity}］{topWarning.label}
          </span>
          <span className="ml-2">{topWarning.detail}</span>
        </div>
      )}
    </div>
  );
}
