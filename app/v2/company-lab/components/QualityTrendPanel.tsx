// ShrimpX V2 — 会社経営統合テスト環境 品質ダッシュボード（Phase 7B） 4. 8/32ターン推移
//
// dashboardViewModel.buildTrendGroupsが既存の会社ラボ実行結果（history）から
// 抽出した系列を、意味の近い指標ごとに分けてスパークライン表示するだけ。
// 新たな計算・シミュレーションの実行は一切行わない。

"use client";

import { useState } from "react";
import { TrendGroup } from "../dashboardViewModel";
import QualitySparkline from "./QualitySparkline";

interface QualityTrendPanelProps {
  readonly buildGroups: (turnsWindow: number) => readonly TrendGroup[];
  readonly maxAvailableTurns: number;
}

const SERIES_COLORS = ["#2dd4bf", "#f59e0b", "#a855f7", "#3b82f6", "#ef4444"];

export default function QualityTrendPanel(props: QualityTrendPanelProps) {
  const { buildGroups, maxAvailableTurns } = props;
  const [turnsWindow, setTurnsWindow] = useState<8 | 32>(8);

  const effectiveWindow = Math.min(turnsWindow, Math.max(1, maxAvailableTurns));
  const groups: readonly TrendGroup[] = buildGroups(effectiveWindow);

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-base font-semibold text-gray-100">推移（直近{effectiveWindow}ターン）</h3>
        <div className="flex items-center gap-1 text-xs">
          {([8, 32] as const).map((w) => (
            <button
              key={w}
              onClick={() => setTurnsWindow(w)}
              className={`px-3 py-1 rounded-lg font-semibold ${turnsWindow === w ? "bg-teal-600 text-white" : "bg-gray-700 text-gray-300"}`}
            >
              {w}ターン
            </button>
          ))}
        </div>
      </div>

      {maxAvailableTurns < turnsWindow && (
        <p className="text-[11px] text-gray-500">実行済みのターン数（{maxAvailableTurns}）が{turnsWindow}ターンに満たないため、実行済み分のみ表示しています。</p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {groups.map((g) => (
          <div key={g.groupLabel} className="bg-gray-900/40 rounded-xl p-3 space-y-2">
            <div className="text-xs font-semibold text-gray-300">{g.groupLabel}</div>
            <div className="space-y-2">
              {g.series.map((s, idx) => (
                <div key={s.key} className="flex items-center gap-2">
                  <span className="w-32 text-[10px] text-gray-400 shrink-0 truncate" title={s.label}>
                    {s.label}
                  </span>
                  <QualitySparkline points={s.points} color={SERIES_COLORS[idx % SERIES_COLORS.length]} width={200} height={32} />
                  <span className="text-[10px] text-gray-500 shrink-0">
                    {(() => {
                      const last = [...s.points].reverse().find((p) => p.value !== undefined);
                      return last?.value !== undefined ? last.value.toFixed(g.unit === "ratio" ? 2 : 1) : "—";
                    })()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
