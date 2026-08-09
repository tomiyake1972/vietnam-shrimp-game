"use client";

// ShrimpX V2 — 数値表（既定で折りたたみ）
//
// 各分析画面ではまずチャートを見せ、生の数値は「▶ 数値表を表示」で開く。
// 32Q × 複数系列の表を最初から描かないための部品。

import { Collapsible } from "../../components/Collapsible";

export interface RawRow {
  readonly label: string;
  readonly values: readonly (number | null)[];
}

interface Props {
  readonly turns: readonly number[];
  readonly rows: readonly RawRow[];
  readonly format: (v: number) => string;
  readonly unitNote?: string;
  readonly testId?: string;
}

export function RawValuesTable({ turns, rows, format, unitNote, testId }: Props) {
  return (
    <Collapsible title="数値表を表示" testId={testId ?? "raw-values-toggle"}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-xs" data-testid="raw-values-table">
          <thead>
            <tr className="border-b border-slate-700 text-slate-400">
              <th className="py-1 pr-2 text-left">系列</th>
              {turns.map((t) => (
                <th key={t} className="px-1 py-1 text-right">
                  Q{t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-slate-800">
                <td className="py-1 pr-2 whitespace-nowrap">{row.label}</td>
                {row.values.map((v, i) => (
                  <td key={turns[i] ?? i} className={`px-1 py-1 text-right tabular-nums ${v !== null && v < 0 ? "text-rose-400" : ""}`}>
                    {v === null ? "－" : format(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unitNote ? <p className="mt-1.5 text-[11px] text-slate-500">{unitNote}</p> : null}
    </Collapsible>
  );
}
