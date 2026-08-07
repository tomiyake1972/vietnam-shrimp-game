// ShrimpX V2 — 会社経営統合テスト環境 設備投資意思決定UI（Phase 8B-3） C. 投資案件ポートフォリオ一覧
//
// capexViewModel.buildCapexPortfolioViewModelが既に整形した表示値のみを描画する
// 純粋な表示コンポーネント。ステータス判定・進捗率・稼働開始判定・減価償却・
// 保守費の計算は一切ここで行わない（実装指示§13）。

import { useState } from "react";
import { formatHosoEqTons, formatUsd } from "../../../lib/v2/industryLab/ui/formatters";
import { CapexPortfolioRowViewModel } from "../capexViewModel";

interface CapexPortfolioListProps {
  readonly rows: readonly CapexPortfolioRowViewModel[];
  readonly cancelRequestedProjectIds: ReadonlySet<string>;
  readonly onRequestCancel: (projectId: string) => void;
  readonly onUndoCancelRequest: (projectId: string) => void;
  readonly disabled: boolean;
}

const STATUS_STYLE: Record<string, string> = {
  planned: "bg-gray-700 text-gray-200",
  underConstruction: "bg-amber-900/60 border border-amber-600/50 text-amber-200",
  suspended: "bg-red-950/60 border border-red-700/50 text-red-200",
  completedPreparing: "bg-blue-950/60 border border-blue-700/50 text-blue-200",
  operating: "bg-teal-900/60 border border-teal-600/50 text-teal-200",
  cancelled: "bg-gray-800 text-gray-500 line-through",
};

function StatusBadge(props: { readonly displayStatus: string; readonly label: string }) {
  return <span className={`text-[11px] rounded-full px-2 py-0.5 font-semibold ${STATUS_STYLE[props.displayStatus] ?? "bg-gray-700 text-gray-200"}`}>{props.label}</span>;
}

function Row(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex justify-between gap-2 text-[11px]">
      <span className="text-gray-500">{props.label}</span>
      <span className="text-gray-200 text-right">{props.value}</span>
    </div>
  );
}

function PortfolioCard(props: {
  readonly row: CapexPortfolioRowViewModel;
  readonly cancelRequested: boolean;
  readonly onRequestCancel: (projectId: string) => void;
  readonly onUndoCancelRequest: (projectId: string) => void;
  readonly disabled: boolean;
}) {
  const { row, cancelRequested, onRequestCancel, onUndoCancelRequest, disabled } = props;
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="bg-gray-900/60 border border-gray-700/60 rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h4 className="text-sm font-semibold text-gray-100">{row.projectTypeDisplayName}</h4>
        <StatusBadge displayStatus={row.displayStatus} label={row.displayStatusLabel} />
      </div>
      <div className="text-[10px] text-gray-500">{row.projectId}</div>

      <div className="space-y-1">
        <Row label="総投資額" value={formatUsd(row.totalInvestmentUsd)} />
        <Row label="申請四半期" value={row.approvedPeriod} />
        <Row label={row.isCompletionEstimate ? "完成予定（見積り）" : "完成四半期"} value={row.completionPeriod ?? "未定（支払保留中）"} />
        {row.operationalStartPeriod !== undefined && <Row label="稼働開始四半期" value={row.operationalStartPeriod} />}
        <Row label="累計支払額" value={formatUsd(row.cumulativePaidUsd)} />
        <Row label="残り予定支払額" value={formatUsd(row.remainingScheduledPaymentUsd)} />
        {row.nextScheduledPaymentUsd > 0 && <Row label="今期予定支払額（成功見込み）" value={formatUsd(row.nextScheduledPaymentUsd)} />}
        {row.lastActualPaymentUsd !== undefined && row.lastActualPaymentUsd > 0 && (
          <Row label="直近四半期の実際の支払額" value={formatUsd(row.lastActualPaymentUsd)} />
        )}
        {row.constructionProgressRatio !== undefined && (
          <Row label="建設進捗（参考情報）" value={`${Math.round(row.constructionProgressRatio * 1000) / 10}%`} />
        )}
        <Row label="現在の能力へ反映済みか" value={row.isCapacityReflected ? "反映済み" : "未反映"} />
        {row.capacityIncreaseTonsPerQuarter > 0 && (
          <Row label="能力増加" value={`${formatHosoEqTons(row.capacityIncreaseTonsPerQuarter)}/四半期（${row.targetProductLabel ?? "—"}）`} />
        )}
        <Row label="今期の固定保守費" value={`${formatUsd(row.quarterlyMaintenanceCostUsd)}`} />
        <Row label="今期の減価償却費（建物+機械）" value={`${formatUsd(row.quarterlyDepreciationUsd)}`} />
        {row.quarterlyDepreciationUsd > 0 && (
          <Row label="内訳（建物/機械）" value={`${formatUsd(row.quarterlyBuildingDepreciationUsd)} / ${formatUsd(row.quarterlyMachineryDepreciationUsd)}`} />
        )}
      </div>

      {row.cancellable && (
        <div className="pt-1">
          {cancelRequested ? (
            <button
              onClick={() => onUndoCancelRequest(row.projectId)}
              disabled={disabled}
              className="w-full px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-semibold text-gray-100"
            >
              取消要求を取り下げる
            </button>
          ) : confirming ? (
            <div className="space-y-1.5 bg-red-950/40 border border-red-700/50 rounded-lg p-2">
              <p className="text-[11px] text-red-200">
                本当にこの案件を取消しますか？まだ支払実績が無い案件のため、返金の発生自体がありません（着工前の取消です）。
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    onRequestCancel(row.projectId);
                    setConfirming(false);
                  }}
                  disabled={disabled}
                  className="flex-1 px-3 py-1.5 bg-red-800 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-semibold text-white"
                >
                  はい、取消する
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="flex-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs font-semibold text-gray-100"
                >
                  いいえ
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              disabled={disabled}
              className="w-full px-3 py-1.5 bg-red-900/60 hover:bg-red-900 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-semibold text-red-200"
            >
              この案件を取消する
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function CapexPortfolioList(props: CapexPortfolioListProps) {
  const { rows, cancelRequestedProjectIds, onRequestCancel, onUndoCancelRequest, disabled } = props;

  if (rows.length === 0) {
    return <div className="text-[11px] text-gray-500">この会社にはまだ設備投資案件がありません。</div>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {rows.map((row) => (
        <PortfolioCard
          key={row.projectId}
          row={row}
          cancelRequested={cancelRequestedProjectIds.has(row.projectId)}
          onRequestCancel={onRequestCancel}
          onUndoCancelRequest={onUndoCancelRequest}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
