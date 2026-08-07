// ShrimpX V2 — 会社経営統合テスト環境 設備投資意思決定UI（Phase 8B-3） B. 今期ドラフトの確認（提出前レビュー）
//
// このアプリには意思決定編集画面と別の「提出確認画面」は存在せず、
// DecisionEditor自体が編集中＝提出内容の確認を兼ねる（既存の販売計画等の
// セクションと同じ構造）。本コンポーネントは、今期ドラフトに追加済みの新規
// 投資案件候補・取消要求を一覧表示し、提出前（disabled=false）ならその場で
// 取り下げられるようにする。

import { CapitalProjectType } from "../../../lib/v2/capex/types";
import { formatUsd } from "../../../lib/v2/industryLab/ui/formatters";
import { CapexProjectProposalDraftRow } from "../decisionDraft";

interface CapexDraftListProps {
  readonly newProjectProposals: readonly CapexProjectProposalDraftRow[];
  readonly cancelRequestProjectIds: readonly string[];
  readonly displayNameByType: (projectType: CapitalProjectType) => string;
  readonly budgetByType: (projectType: CapitalProjectType, requestedBudgetUsd: number | undefined) => number;
  readonly onRemoveProposal: (index: number) => void;
  readonly onRemoveCancelRequest: (projectId: string) => void;
  readonly disabled: boolean;
}

export default function CapexDraftList(props: CapexDraftListProps) {
  const { newProjectProposals, cancelRequestProjectIds, displayNameByType, budgetByType, onRemoveProposal, onRemoveCancelRequest, disabled } = props;

  if (newProjectProposals.length === 0 && cancelRequestProjectIds.length === 0) {
    return <div className="text-[11px] text-gray-500">今期は設備投資に関する意思決定はありません（新規案件の申請・取消要求のどちらもありません）。</div>;
  }

  return (
    <div className="space-y-2">
      {newProjectProposals.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] text-gray-400">今期申請する新規投資案件（{newProjectProposals.length}件）</div>
          <ul className="space-y-1">
            {newProjectProposals.map((p, idx) => (
              <li key={`${p.projectType}-${idx}`} className="flex items-center justify-between bg-gray-900/60 rounded-lg px-3 py-1.5 text-xs text-gray-200">
                <span>
                  {displayNameByType(p.projectType)}（{formatUsd(budgetByType(p.projectType, p.requestedBudgetUsd))}）
                </span>
                <button
                  onClick={() => onRemoveProposal(idx)}
                  disabled={disabled}
                  className="text-red-400 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed text-[11px]"
                >
                  取り下げる
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {cancelRequestProjectIds.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] text-gray-400">今期取消を要求する既存案件（{cancelRequestProjectIds.length}件）</div>
          <ul className="space-y-1">
            {cancelRequestProjectIds.map((projectId) => (
              <li key={projectId} className="flex items-center justify-between bg-gray-900/60 rounded-lg px-3 py-1.5 text-xs text-gray-200">
                <span>{projectId}</span>
                <button
                  onClick={() => onRemoveCancelRequest(projectId)}
                  disabled={disabled}
                  className="text-red-400 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed text-[11px]"
                >
                  取消要求を取り下げる
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
