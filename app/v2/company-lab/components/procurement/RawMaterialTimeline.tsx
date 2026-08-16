// ShrimpX V2 — Procurement Planning: Raw Material Timeline（表示専用）
//
// rawMaterialTimelineViewModel.ts の buildRawMaterialTimeline（既存・確定済みロット）
// と、plannedProcurementViewModel.ts の draft由来の行（Planned層）を、同じ表の中で
// 別グループとして並べる。certainty（confirmed/expected/planned/unknown）をバッジで
// 視覚的に区別し、合計を混ぜない（Confirmed/Expectedの既存合計にPlannedを混入しない）。

import { formatHosoEqTons } from "../../../../lib/v2/industryLab/ui/formatters";
import { RawMaterialTimeline, TIMELINE_BUCKET_KEYS, TimelineRow, TimelineRowCertainty } from "../../rawMaterialTimelineViewModel";
import { AREA_TONES, INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, NO_VALUE_TEXT } from "../panelStyles";

interface RawMaterialTimelineTableProps {
  readonly timeline: RawMaterialTimeline;
  /** 当期のdraft入力から導いたPlanned層の行（plannedProcurementViewModel.ts）。任意。 */
  readonly plannedRows?: readonly TimelineRow[];
}

const CERTAINTY_BADGE: Readonly<Record<TimelineRowCertainty, string>> = {
  confirmed: "bg-emerald-900/60 text-emerald-200 border border-emerald-700/60",
  expected: "bg-amber-900/50 text-amber-200 border border-amber-700/60",
  planned: "bg-sky-900/60 text-sky-200 border border-sky-700/60",
  unknown: "bg-gray-800 text-gray-400 border border-gray-600/60",
};

const CERTAINTY_LABEL: Readonly<Record<TimelineRowCertainty, string>> = {
  confirmed: "Confirmed",
  expected: "Expected",
  planned: "Planned",
  unknown: "Unknown",
};

function TimelineRowLine({ row }: { readonly row: TimelineRow }) {
  return (
    <tr className={INFO_TABLE_ROW_CLASS} data-testid={`raw-material-timeline-row-${row.rowKey}`}>
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
  );
}

export default function RawMaterialTimelineTable({ timeline, plannedRows }: RawMaterialTimelineTableProps) {
  const tone = AREA_TONES.info;
  const hasPlannedRows = plannedRows !== undefined && plannedRows.length > 0;
  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="raw-material-timeline">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>Raw Material Timeline</span>
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
              <TimelineRowLine key={row.rowKey} row={row} />
            ))}
            <tr className="border-t border-gray-600 font-semibold">
              <td className="pr-3 py-1" colSpan={2}>
                Existing 合計（Confirmed: {formatHosoEqTons(timeline.confirmedTotalTons)} / Expected: {formatHosoEqTons(timeline.expectedTotalTons)}）
              </td>
              {TIMELINE_BUCKET_KEYS.map((b) => (
                <td key={b} className="pr-3 py-1 text-right tabular-nums">
                  {formatHosoEqTons(timeline.totalByBucket[b])}
                </td>
              ))}
              <td className="pr-3 py-1 text-right tabular-nums">{formatHosoEqTons(timeline.grandTotalTons)}</td>
            </tr>

            {hasPlannedRows && (
              <>
                <tr>
                  <td colSpan={TIMELINE_BUCKET_KEYS.length + 3} className="pt-3 pb-1 text-[11px] font-semibold text-sky-300">
                    Planned（今回のdraft入力。未提出・未確定）
                  </td>
                </tr>
                {plannedRows!.map((row) => (
                  <TimelineRowLine key={row.rowKey} row={row} />
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        Confirmed（手持ち在庫＋輸入到着）・Expected（養殖の当期収穫見込み）・Planned（今回のdraft入力）はいずれも別の確実性を持つため、
        合計を混ぜていません。Plannedの国内買付は競争配分前、輸入発注は原産国供給上限適用前、養殖池入れは疾病圧力適用前の希望値です。
      </p>
    </div>
  );
}
