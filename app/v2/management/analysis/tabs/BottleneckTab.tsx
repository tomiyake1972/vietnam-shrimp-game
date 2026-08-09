"use client";

// ShrimpX V2 — 32Q Analysis: Bottleneck タブ（Phase 2）
//
// 【生成AIによる分類をしない】
// 各セルの律速要因は、確定記録に既にある3つの不足量（原料・設備・労働）の
// 大小比較だけで決まる。文章生成・推論・外部モデル呼び出しは一切ない。
// 同点のときは 原料 → 設備 → 労働 の順で決める（実行ごとに揺れない）。

import { BOTTLENECK_COLORS, BOTTLENECK_LABELS, BottleneckKind, SimulationAnalyticsDataset } from "../../../../lib/v2/companyLab/simulation/analytics/types";
import { buildBottleneckTransitions } from "../../../../lib/v2/companyLab/simulation/analytics/dataset";
import { toBottleneckHeatmap } from "../../../../lib/v2/companyLab/simulation/analytics/views";

interface Props {
  readonly dataset: SimulationAnalyticsDataset;
}

const KINDS: readonly BottleneckKind[] = ["rawMaterial", "equipment", "labor", "none"];

export function BottleneckTab({ dataset }: Props) {
  const heatmap = toBottleneckHeatmap(dataset);
  const transitions = buildBottleneckTransitions(dataset.bottlenecks);

  // 濃さは「その会社の最大不足量に対する相対値」。会社間で規模が違うため、
  // 全社共通の絶対スケールにすると小さい会社の律速が全部同じ色に潰れる。
  const maxSeverityByCompany = new Map<string, number>();
  for (const row of heatmap) {
    maxSeverityByCompany.set(row.companyId, Math.max(1e-9, ...row.cells.map((c) => c.severity)));
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">律速ヒートマップ（5社 × {dataset.turns.length}Q）</h2>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {KINDS.map((k) => (
              <li key={k} className="flex items-center gap-1.5 text-[11px] text-slate-300">
                <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: BOTTLENECK_COLORS[k] }} aria-hidden />
                {BOTTLENECK_LABELS[k]}
              </li>
            ))}
          </ul>
        </div>

        <div className="overflow-x-auto">
          <table className="border-separate border-spacing-0.5 text-[10px]" data-testid="bottleneck-heatmap">
            <thead>
              <tr className="text-slate-400">
                <th className="pr-2 text-left font-normal">会社</th>
                {dataset.turns.map((t) => (
                  <th key={t} className="w-5 font-normal">
                    {t % 4 === 1 ? `Q${t}` : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {heatmap.map((row) => {
                const maxSeverity = maxSeverityByCompany.get(row.companyId) ?? 1;
                return (
                  <tr key={row.companyId}>
                    <td className="pr-2 text-xs font-semibold text-slate-200">{row.companyId}</td>
                    {row.cells.map((cell) => (
                      <td key={cell.turn} className="p-0">
                        <div
                          className="h-5 w-5 rounded-[2px]"
                          style={{
                            backgroundColor: BOTTLENECK_COLORS[cell.kind],
                            opacity: cell.kind === "none" ? 1 : 0.35 + 0.65 * Math.min(1, cell.severity / maxSeverity),
                          }}
                          title={`${row.companyId} Q${cell.turn}: ${BOTTLENECK_LABELS[cell.kind]}${
                            cell.kind === "none" ? "" : ` / 不足 ${Math.round(cell.severity).toLocaleString()}t`
                          }`}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
          色は主要因、濃さはその会社の中での相対的な不足量です（会社ごとに規模が違うため、全社共通の絶対スケールにしていません）。
          分類は確定記録の3つの不足量の大小比較だけで決めており、生成AIによる分類は行っていません。
        </p>
      </div>

      <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
        <h2 className="mb-2 text-sm font-semibold">律速の遷移（何が何に変わったか）</h2>
        {transitions.length === 0 ? (
          <p className="text-xs text-slate-400">この実行では律速要因の切り替わりが記録されていません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-xs" data-testid="bottleneck-transitions">
              <thead>
                <tr className="border-b border-slate-700 text-left text-slate-400">
                  <th className="py-1 pr-2">Turn</th>
                  <th className="py-1 pr-2">会社</th>
                  <th className="py-1 pr-2">変化前</th>
                  <th className="py-1">変化後</th>
                </tr>
              </thead>
              <tbody>
                {transitions.map((t, i) => (
                  <tr key={`${t.companyId}-${t.turn}-${i}`} className="border-b border-slate-800">
                    <td className="py-1 pr-2 tabular-nums">Q{t.turn}</td>
                    <td className="py-1 pr-2 font-semibold">{t.companyId}</td>
                    <td className="py-1 pr-2">
                      <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ backgroundColor: BOTTLENECK_COLORS[t.from] }} aria-hidden />
                      {BOTTLENECK_LABELS[t.from]}
                    </td>
                    <td className="py-1">
                      <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ backgroundColor: BOTTLENECK_COLORS[t.to] }} aria-hidden />
                      {BOTTLENECK_LABELS[t.to]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
