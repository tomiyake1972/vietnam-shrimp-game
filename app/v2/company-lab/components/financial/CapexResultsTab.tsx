// ShrimpX V2 — Company Lab 財務パネル 設備投資結果タブ
//
// CapexQuarterResult（capex/capexClose.tsが既に計算・永続化済み）をそのまま
// 表示するだけ。案件種別の表示名はCAPEX_PARAMETERS_V1（既存の唯一の情報源）から
// 取得し、この画面独自の値をハードコードしない。

import { CapexQuarterResult, CAPEX_PARAMETERS_V1, CapitalProjectStatus, CapitalProjectType } from "../../../../lib/v2/capex";
import { formatUsd } from "../../../../lib/v2/industryLab/ui/formatters";
import { LineRow, NoDataNotice, ReasonList, TableHead, UnitNote } from "./financialTableParts";

interface Props {
  readonly current: CapexQuarterResult | null;
  readonly previous: CapexQuarterResult | null;
}

const STATUS_LABELS: Record<CapitalProjectStatus, string> = {
  proposed: "提案中",
  approved: "承認済み",
  underConstruction: "建設中",
  suspended: "支払保留（中断）",
  completed: "完成",
  cancelled: "取消",
};

function projectTypeDisplayName(projectType: CapitalProjectType): string {
  const template = CAPEX_PARAMETERS_V1.templatesByType[projectType];
  return template ? template.displayName : projectType;
}

export default function CapexResultsTab({ current, previous }: Props) {
  if (!current) return <NoDataNotice label="当期の設備投資結果" />;

  return (
    <div className="space-y-4">
      <UnitNote />
      <div>
        <div className="text-xs text-gray-400 mb-1">当期サマリー</div>
        <table className="min-w-full text-xs">
          <TableHead />
          <tbody className="divide-y divide-gray-800">
            <LineRow label="当期投資可能現金（最低現金準備控除後）" current={current.cashAvailableForCapexUsd} previous={previous?.cashAvailableForCapexUsd} />
            <LineRow label="当期支払総額" current={current.totalPaidThisQuarterUsd} previous={previous?.totalPaidThisQuarterUsd} bold />
            <LineRow label="当期完成・固定資産振替額" current={current.completedProjectsTransferUsd} previous={previous?.completedProjectsTransferUsd} />
            <LineRow label="期末建設仮勘定残高" current={current.endingConstructionInProgressUsd} previous={previous?.endingConstructionInProgressUsd} />
            <LineRow label="当期減価償却費（設備投資分）" current={current.capexAssetsDepreciationUsd} previous={previous?.capexAssetsDepreciationUsd} />
            <LineRow label="　内訳：建物" current={current.capexAssetsBuildingDepreciationUsd} previous={previous?.capexAssetsBuildingDepreciationUsd} indent />
            <LineRow label="　内訳：機械" current={current.capexAssetsMachineryDepreciationUsd} previous={previous?.capexAssetsMachineryDepreciationUsd} indent />
            <LineRow label="当期固定保守費" current={current.capexMaintenanceCostUsd} previous={previous?.capexMaintenanceCostUsd} />
          </tbody>
        </table>
      </div>

      <div>
        <div className="text-xs text-gray-400 mb-1">当期の案件イベント</div>
        {current.events.length === 0 ? (
          <div className="text-xs text-gray-500">当期は案件の状態変化はありませんでした。</div>
        ) : (
          <div className="space-y-2">
            {current.events.map((e, idx) => (
              <div key={idx} className="bg-gray-900/50 rounded-lg px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-sm text-gray-100">
                  <span className="font-medium">{projectTypeDisplayName(e.projectType)}</span>
                  <span className="text-[11px] text-gray-500">
                    （{e.projectId}） {STATUS_LABELS[e.statusBefore]} → {STATUS_LABELS[e.statusAfter]}
                  </span>
                </div>
                <div className="text-[11px] text-gray-400 mt-0.5">
                  支払試行: {e.paymentAttempted ? "あり" : "なし"}
                  {e.paymentAttempted && `（成功額 ${formatUsd(e.paymentSucceededUsd)}）`}
                </div>
                <ReasonList reasons={e.reasons} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="text-xs text-gray-400 mb-1">当期の却下提案</div>
        {current.rejectedProposals.length === 0 ? (
          <div className="text-xs text-gray-500">当期、却下された新規提案はありません。</div>
        ) : (
          <div className="space-y-2">
            {current.rejectedProposals.map((p, idx) => (
              <div key={idx} className="bg-rose-950/30 border border-rose-800/40 rounded-lg px-3 py-2">
                <div className="text-sm text-gray-100">
                  {projectTypeDisplayName(p.projectType)}（申請額 {formatUsd(p.requestedBudgetUsd)}）
                </div>
                <ReasonList reasons={p.reasons} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
