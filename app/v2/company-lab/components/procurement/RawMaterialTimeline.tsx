// ShrimpX V2 — Procurement Planning: Raw Material Timeline（表示専用）
//
// rawMaterialTimelineViewModel.ts の buildRawMaterialTimeline が返した値を
// そのまま表として並べるだけ。certainty（confirmed/expected/unknown）を
// バッジで視覚的に区別する。Planned Procurement（draft入力）はまだこの表に
// 含めない（Step 4の範囲外。既存・確定済みlotのみを対象とする）。

import { formatHosoEqTons } from "../../../../lib/v2/industryLab/ui/formatters";
import { RawMaterialTimeline, TIMELINE_BUCKET_KEYS, TimelineRowCertainty } from "../../rawMaterialTimelineViewModel";
import { AREA_TONES, INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, NO_VALUE_TEXT } from "../panelStyles";

interface RawMaterialTimelineTableProps {
  readonly timeline: RawMaterialTimeline;
}

const CERTAINTY_BADGE: Readonly<Record<TimelineRowCertainty, string>> = {
  confirmed: "bg-emerald-900/60 text-emerald-200 border border-emerald-700/60",
  expected: "bg-amber-900/50 text-amber-200 border border-amber-700/60",
  unknown: "bg-gray-800 text-gray-400 border border-gray-600/60",
};

const CERTAINTY_LABEL: Readonly<Record<TimelineRowCertainty, string>> = {
  confirmed: "Confirmed",
  expected: "Expected",
  unknown: "Unknown",
};

export default function RawMaterialTimelineTable({ timeline }: RawMaterialTimelineTableProps) {
  const tone = AREA_TONES.info;
  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="raw-material-timeline">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>Raw Material Timeline（既存・確定済みロット）</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs text-gray-300" data-testid="raw-material-timeline-table">
          <thead>
            <tr className={INFO_TABLE_HEAD_CLASS}>
              <th className="pr-3 py-1">Source</th>
              <th className="pr-3 py-1">確実性</th>
              {TIMELINE_BUCKET_KEYS.map((b) => (
                <th key={b} className="pr-3 py-1 text-right">
                  {timeline.bucketLabels[b]}
                </th>
              ))}
              <th className="pr-3 py-1 text-right font-semibold">合計</th>
            </tr>
          </thead>
          <tbody>
            {timeline.rows.map((row) => (
              <tr key={row.rowKey} className={INFO_TABLE_ROW_CLASS} data-testid={`raw-material-timeline-row-${row.rowKey}`}>
                <td className="pr-3 py-1">{row.label}</td>
                <td className="pr-3 py-1">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${CERTAINTY_BADGE[row.certainty]}`}>{CERTAINTY_LABEL[row.certainty]}</span>
                </td>
                {TIMELINE_BUCKET_KEYS.map((b) => (
                  <td key={b} className="pr-3 py-1 text-right tabular-nums">
                    {row.byBucket[b].tons > 0 ? formatHosoEqTons(row.byBucket[b].tons) : NO_VALUE_TEXT}
                  </td>
                ))}
                <td className="pr-3 py-1 text-right font-semibold tabular-nums">{formatHosoEqTons(row.totalTons)}</td>
              </tr>
            ))}
            <tr className="border-t border-gray-600 font-semibold">
              <td className="pr-3 py-1" colSpan={2}>
                合計（Confirmed: {formatHosoEqTons(timeline.confirmedTotalTons)} / Expected: {formatHosoEqTons(timeline.expectedTotalTons)}）
              </td>
              {TIMELINE_BUCKET_KEYS.map((b) => (
                <td key={b} className="pr-3 py-1 text-right tabular-nums">
                  {formatHosoEqTons(timeline.totalByBucket[b])}
                </td>
              ))}
              <td className="pr-3 py-1 text-right tabular-nums">{formatHosoEqTons(timeline.grandTotalTons)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        今回の入力（国内買付希望・輸入発注・養殖池入れ計画）はこの表にまだ含まれません（Planned Procurement層は次段階で追加予定）。ここは既存・確定済みロットの一覧です。
      </p>
    </div>
  );
}
