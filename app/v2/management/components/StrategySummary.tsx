"use client";

// ShrimpX V2 — Console の5社サマリー（志・成長圧力・新工場の検討状態）
//
// 【既定画面を重くしない】この表は Collapsible の中に置かれ、既定では閉じている。
// 詳しく見るための入口は /v2/management/analysis/strategy（独立URL）である。

import Link from "next/link";
import { PackCompanyTurnCapture } from "../../../lib/v2/companyLab/simulation/types";

interface Props {
  readonly strategyTurns: readonly PackCompanyTurnCapture[];
  readonly runId: string | null;
}

const GROWTH_PRESSURE_LABELS: Readonly<Record<string, string>> = {
  LOW: "低",
  MODERATE: "中",
  HIGH: "高",
  URGENT: "切迫",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  NOT_CONSIDERED: "検討対象外",
  MONITORING: "監視中",
  CONSIDERING: "検討中",
  READY_TO_BUILD: "提案",
  DEFERRED: "見送り",
  APPROVED: "承認済み・建設中",
};

const DASH = "－";

export function StrategySummary({ strategyTurns, runId }: Props) {
  if (strategyTurns.length === 0) {
    return (
      <p className="text-xs text-slate-400" data-testid="console-strategy-empty">
        この実行には Vision・戦略成長の記録がありません。
      </p>
    );
  }

  // 会社ごとに最新ターンの記録だけを見る。
  const latestByCompany = new Map<string, PackCompanyTurnCapture>();
  for (const row of strategyTurns) {
    const current = latestByCompany.get(row.companyId);
    if (!current || row.turn > current.turn) latestByCompany.set(row.companyId, row);
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[11px]" data-testid="console-strategy-summary">
          <thead className="text-slate-400">
            <tr>
              <th className="px-1.5 py-1">会社</th>
              <th className="px-1.5 py-1">Q32で目指す規模</th>
              <th className="px-1.5 py-1">参考規模（当期）</th>
              <th className="px-1.5 py-1">持続可能規模</th>
              <th className="px-1.5 py-1">成長圧力</th>
              <th className="px-1.5 py-1">新工場</th>
            </tr>
          </thead>
          <tbody>
            {[...latestByCompany.values()]
              .sort((a, b) => a.companyId.localeCompare(b.companyId))
              .map((row) => {
                const s = row.strategy;
                return (
                  <tr key={row.companyId} className="border-t border-slate-800 text-slate-300">
                    <td className="px-1.5 py-1 font-semibold text-slate-100">{row.companyId}</td>
                    <td className="px-1.5 py-1 tabular-nums">
                      {s.vision ? `${s.vision.targetScaleTonsPerQuarterAtQ32.toLocaleString()}t` : DASH}
                    </td>
                    <td className="px-1.5 py-1 tabular-nums">
                      {s.visionTargetScaleAtCurrentTurn === null ? DASH : `${Math.round(s.visionTargetScaleAtCurrentTurn).toLocaleString()}t`}
                    </td>
                    <td className="px-1.5 py-1 tabular-nums">
                      {s.currentSustainableScaleTons === null ? DASH : `${Math.round(s.currentSustainableScaleTons).toLocaleString()}t`}
                    </td>
                    <td className="px-1.5 py-1">{s.growthPressure === null ? DASH : (GROWTH_PRESSURE_LABELS[s.growthPressure] ?? s.growthPressure)}</td>
                    <td className="px-1.5 py-1">{s.newFactory === null ? DASH : (STATUS_LABELS[s.newFactory.status] ?? s.newFactory.status)}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
        Vision（志）を決めるのは人間の経営者です。Standard AI は志を自分で作らず、志と現在地の差に反応します。
      </p>
      <Link
        href={runId ? `/v2/management/analysis/strategy?run=${encodeURIComponent(runId)}` : "/v2/management/analysis/strategy"}
        className="mt-1.5 inline-block rounded border border-slate-600 px-2.5 py-1 text-[11px] hover:bg-slate-800"
        data-testid="console-strategy-link"
      >
        Vision と戦略成長の詳細 →
      </Link>
    </div>
  );
}
