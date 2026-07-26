// ShrimpX V2 — Phase 8D 警告パネル
//
// 実装指示§10のとおり、警告は種類を区別し、赤色表示だけでなく
// 「不足量」または「発生理由」を必ず文章でも示す。

import { PlanningWarning, PlanningWarningKind } from "../investmentPlanningViewModel";

interface PlanningWarningsPanelProps {
  readonly warnings: readonly PlanningWarning[];
}

/**
 * 警告種別ごとの見た目。エリア色分け（sky/gray）とは独立した状態表現であり、
 * panelStyles.ts のカラーコントラクトを侵さない（amber＝警告・rose＝エラーの既存方針どおり）。
 */
const KIND_STYLE: Readonly<Record<PlanningWarningKind, string>> = {
  equipmentCapacityShortage: "bg-amber-950/40 border-amber-700/50 text-amber-200",
  workerShortage: "bg-amber-950/40 border-amber-700/50 text-amber-200",
  factorySpaceShortage: "bg-rose-950/40 border-rose-700/50 text-rose-200",
  freezingPackagingShortage: "bg-amber-950/40 border-amber-700/50 text-amber-200",
  coldStorageOverCapacity: "bg-amber-950/40 border-amber-700/50 text-amber-200",
  investmentNotAvailableYet: "bg-gray-900/60 border-gray-700/60 text-gray-300",
  engineNotConnected: "bg-gray-900/60 border-gray-700/60 text-gray-300",
};

export default function PlanningWarningsPanel(props: PlanningWarningsPanelProps) {
  if (props.warnings.length === 0) {
    return <p className="text-[11px] text-gray-400">現在の入力に対する警告はありません。</p>;
  }

  return (
    <ul className="space-y-1">
      {props.warnings.map((w, idx) => (
        <li key={`${w.kind}-${idx}`} className={`rounded-lg border px-3 py-2 ${KIND_STYLE[w.kind]}`}>
          <div className="text-[11px] font-semibold">
            {w.label}
            {w.shortfallAmount !== undefined && w.shortfallUnitLabel !== undefined && (
              <span className="ml-2 font-normal">
                （{w.shortfallAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })} {w.shortfallUnitLabel}）
              </span>
            )}
          </div>
          <p className="text-[11px] mt-0.5">{w.sentence}</p>
        </li>
      ))}
    </ul>
  );
}
