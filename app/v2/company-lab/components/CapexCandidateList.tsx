// ShrimpX V2 — 会社経営統合テスト環境 設備投資意思決定UI（Phase 8B-3） A. 新規案件候補一覧
//
// capexViewModel.buildAllCapexCandidateViewModelsが既に算出したプレビュー値
// （投資額・工期・支払スケジュール・稼働開始四半期・保守費・建物/機械別減価償却）を
// 表示するだけの純粋な表示コンポーネント。案件種別ごとの金額・比率・耐用年数を
// このコンポーネント内でハードコードしない（実装指示§13）。

import { useState } from "react";
import { CapitalProjectType } from "../../../lib/v2/capex/types";
import { formatHosoEqTons, formatUsd } from "../../../lib/v2/industryLab/ui/formatters";
import { CapexCandidateViewModel } from "../capexViewModel";

interface CapexCandidateListProps {
  readonly candidates: readonly CapexCandidateViewModel[];
  readonly currentCashUsd: number;
  readonly draftPaymentThisQuarterUsd: number;
  readonly isDuplicate: (projectType: CapitalProjectType) => boolean;
  readonly onAdd: (projectType: CapitalProjectType) => void;
  readonly disabled: boolean;
}

function DetailRow(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex justify-between gap-2 text-[11px]">
      <span className="text-gray-500">{props.label}</span>
      <span className="text-gray-200 text-right">{props.value}</span>
    </div>
  );
}

function CandidateCard(props: {
  readonly candidate: CapexCandidateViewModel;
  readonly duplicate: boolean;
  readonly onAdd: () => void;
  readonly disabled: boolean;
}) {
  const { candidate: c, duplicate, onAdd, disabled } = props;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-gray-900/60 border border-gray-700/60 rounded-xl p-3 space-y-2 flex flex-col">
      <div>
        <h4 className="text-sm font-semibold text-gray-100">{c.displayName}</h4>
        <p className="text-[11px] text-gray-400 mt-0.5">{c.description}</p>
      </div>

      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
        <DetailRow label="総投資額" value={formatUsd(c.totalInvestmentUsd)} />
        <DetailRow label="工期" value={`${c.constructionQuarters}四半期`} />
        <DetailRow label="今期予定支払額" value={formatUsd(c.thisQuarterExpectedPaymentUsd)} />
        <DetailRow label="能力増加" value={c.capacityIncreaseTonsPerQuarter > 0 ? `${formatHosoEqTons(c.capacityIncreaseTonsPerQuarter)}/四半期（${c.targetProductLabel ?? "—"}）` : "なし"} />
        <DetailRow label="完成予定" value={c.expectedCompletionPeriod} />
        <DetailRow label="稼働開始予定" value={c.expectedOperationalStartPeriod} />
        <DetailRow label="稼働後の固定保守費" value={`${formatUsd(c.quarterlyMaintenanceCostUsd)}/四半期`} />
        <DetailRow label="稼働後の減価償却費" value={`${formatUsd(c.quarterlyTotalDepreciationUsd)}/四半期`} />
      </div>

      <button
        onClick={() => setExpanded((v) => !v)}
        className="text-[11px] text-teal-400 hover:text-teal-300 text-left"
      >
        {expanded ? "詳細を閉じる ▲" : "詳細を見る（支払スケジュール・建物/機械内訳） ▼"}
      </button>

      {expanded && (
        <div className="bg-gray-950/60 rounded-lg p-2 space-y-2 text-[11px]">
          <div>
            <div className="text-gray-500 mb-1">支払スケジュール（四半期ごと）</div>
            <div className="flex flex-wrap gap-1">
              {c.paymentScheduleUsd.map((amount, idx) => (
                <span key={idx} className="bg-gray-800 rounded px-2 py-0.5 text-gray-200">
                  第{idx + 1}回: {formatUsd(amount)}
                </span>
              ))}
            </div>
          </div>
          <DetailRow label="建物・構築物区分" value={`${Math.round(c.buildingRatio * 100)}%（${formatUsd(c.totalInvestmentUsd * c.buildingRatio)}）／耐用${c.buildingUsefulLifeQuarters}四半期／${formatUsd(c.quarterlyBuildingDepreciationUsd)}/四半期`} />
          <DetailRow label="機械・設備区分" value={`${Math.round(c.machineryRatio * 100)}%（${formatUsd(c.totalInvestmentUsd * c.machineryRatio)}）／耐用${c.machineryUsefulLifeQuarters}四半期／${formatUsd(c.quarterlyMachineryDepreciationUsd)}/四半期`} />
          <DetailRow label="稼働開始まで" value={`完成の翌四半期 + ${c.readinessQuartersAfterCompletion}四半期`} />
        </div>
      )}

      {duplicate && (
        <div className="text-[11px] text-amber-400 bg-amber-950/40 border border-amber-700/50 rounded px-2 py-1">
          この案件種別はすでに今期のドラフトに追加されています（同時に複数件を計画すること自体は可能です）。
        </div>
      )}

      <button
        onClick={onAdd}
        disabled={disabled}
        className="mt-auto px-3 py-1.5 bg-teal-700 hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-semibold text-white"
      >
        今期の意思決定へ追加
      </button>
    </div>
  );
}

export default function CapexCandidateList(props: CapexCandidateListProps) {
  const { candidates, currentCashUsd, draftPaymentThisQuarterUsd, isDuplicate, onAdd, disabled } = props;
  const projectedCashAfterPayment = currentCashUsd - draftPaymentThisQuarterUsd;

  return (
    <div className="space-y-3">
      <div className="bg-gray-900/60 rounded-lg px-3 py-2 flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
        <span className="text-gray-400">
          現在の現金残高（前四半期末時点）: <span className="text-gray-100 font-semibold">{formatUsd(currentCashUsd)}</span>
        </span>
        <span className="text-gray-400">
          今期ドラフトの新規投資による予定支払額: <span className="text-gray-100 font-semibold">{formatUsd(draftPaymentThisQuarterUsd)}</span>
        </span>
        <span className={projectedCashAfterPayment < 0 ? "text-amber-400 font-semibold" : "text-gray-400"}>
          支払後の目安残高: {formatUsd(projectedCashAfterPayment)}
          {projectedCashAfterPayment < 0 && "（現金繰りに注意。支払時期・借入余力次第で実際には見送られる場合があります）"}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {candidates.map((c) => (
          <CandidateCard
            key={c.projectType}
            candidate={c}
            duplicate={isDuplicate(c.projectType)}
            onAdd={() => onAdd(c.projectType)}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}
