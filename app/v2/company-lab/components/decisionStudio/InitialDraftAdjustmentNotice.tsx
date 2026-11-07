// ShrimpX V2 — 初期入力を実行可能な範囲へ丸めたことを画面で伝える（表示専用）
//
// 【テストプレイ指摘①の続き・2026-11】入力欄の初期値はAIの提案だが、AIは実効能力・
// 製品在庫・受注残を見ていないため、そのままでは納められない量が入っていた。
// initialDraftFeasibility.ts が初期値を上限へ丸めるので、何をどう変えたかを必ず示す
// （黙って書き換えると、提出した内容と見た数字の対応が分からなくなる）。

import { formatHosoEqTons } from "../../../../lib/v2/industryLab/ui/formatters";
import type { InitialDraftAdjustment } from "../../initialDraftFeasibility";

export default function InitialDraftAdjustmentNotice({
  adjustments,
}: {
  readonly adjustments: readonly InitialDraftAdjustment[];
}) {
  if (adjustments.length === 0) return null;
  return (
    <div
      className="rounded-lg border border-sky-700/60 bg-sky-950/30 px-3 py-2 text-[11px] leading-snug text-sky-100"
      data-testid="initial-draft-adjustment-notice"
    >
      <p className="font-semibold text-sky-200">初期値を実行可能な範囲に調整しました（AIの提案そのままではありません）</p>
      <ul className="mt-1 space-y-1">
        {adjustments.map((a) => (
          <li key={`${a.field}-${a.product ?? "all"}`} data-testid={`initial-draft-adjustment-${a.field}-${a.product ?? "all"}`}>
            {a.label}: AIの提案 {formatHosoEqTons(a.proposedTons)} → <span className="font-semibold">{formatHosoEqTons(a.adjustedTons)}</span>
            <span className="text-sky-200/80">（{a.reason}）</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-sky-200/80">
        調整後の値も上限ぎりぎりとは限りません。市場ごとの配分・価格・生産計画はこのあと自由に変更できます。
      </p>
    </div>
  );
}
