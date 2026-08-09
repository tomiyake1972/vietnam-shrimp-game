"use client";

// ShrimpX V2 — 32Q Analysis: AI Trace タブ（Phase 2）
//
// 【生成AIで理由を補完しない】
// 表示するのは、Standard AI が意思決定の過程で**実際に計算した値**と、
// Standard AI 自身が付けた理由コード・メッセージだけである。
// 「なぜそう判断したか」を後から文章で作り足すことはしない。
// 記録に無い項目は「－」と表示する。

import { useState } from "react";
import { AI_TRACE_STAGES, AI_TRACE_STAGE_LABELS, AiTraceStage, SimulationAnalyticsDataset } from "../../../../lib/v2/companyLab/simulation/analytics/types";

interface Props {
  readonly dataset: SimulationAnalyticsDataset;
}

const DASH = "－";

function formatValue(value: number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  if (unit === "USD") return `${(value / 1_000_000).toFixed(2)}M USD`;
  if (unit === "ratio" || unit === "0-1") return value.toFixed(3);
  if (unit === "USD/kg") return `${value.toFixed(3)} USD/kg`;
  return `${Math.round(value).toLocaleString()}${unit ? ` ${unit}` : ""}`;
}

const STAGE_ACCENTS: Readonly<Record<AiTraceStage, string>> = {
  OBSERVED: "border-sky-700/70",
  DIAGNOSED: "border-amber-700/70",
  WANTED: "border-emerald-700/70",
  CONSTRAINED: "border-rose-700/70",
  DECIDED: "border-violet-700/70",
  RESULT: "border-slate-600",
};

export function AiTraceTab({ dataset }: Props) {
  const [companyId, setCompanyId] = useState<string>(dataset.companies[0]?.companyId ?? "");
  const [turn, setTurn] = useState<number>(dataset.turns[0] ?? 1);

  const facts = dataset.aiTrace.filter((f) => f.companyId === companyId && f.turn === turn);
  const salesRows = dataset.salesTrace.filter((f) => f.companyId === companyId && f.turn === turn);
  const hiringRow = dataset.hiringTrace.find((f) => f.companyId === companyId && f.turn === turn) ?? null;
  const investmentRows = dataset.investmentTrace.filter((f) => f.companyId === companyId && f.turn === turn);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-slate-400">会社</span>
          <select
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            data-testid="aitrace-company"
            className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
          >
            {dataset.companies.map((c) => (
              <option key={c.companyId} value={c.companyId}>
                {c.companyId}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-slate-400">Turn</span>
          <select
            value={turn}
            onChange={(e) => setTurn(Number(e.target.value))}
            data-testid="aitrace-turn"
            className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
          >
            {dataset.turns.map((t) => (
              <option key={t} value={t}>
                Q{t}
              </option>
            ))}
          </select>
        </label>
        <span className="text-[11px] text-slate-500">
          表示しているのは Standard AI が実際に計算した値と、AI 自身が付けた理由コードだけです（説明文の自動生成はしていません）。
        </span>
      </div>

      {facts.length === 0 ? (
        <p className="rounded border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-400" data-testid="aitrace-empty">
          この会社・このターンの思考記録がありません。
        </p>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2" data-testid="aitrace-stages">
          {AI_TRACE_STAGES.map((stage) => {
            const fact = facts.find((f) => f.stage === stage);
            return (
              <div key={stage} className={`rounded-lg border bg-slate-900/60 p-3 ${STAGE_ACCENTS[stage]}`} data-testid={`aitrace-stage-${stage}`}>
                <h3 className="mb-1.5 text-xs font-semibold text-slate-200">{AI_TRACE_STAGE_LABELS[stage]}</h3>
                {!fact || fact.items.length === 0 ? (
                  <p className="text-[11px] text-slate-500">記録なし</p>
                ) : (
                  <dl className="flex flex-col gap-0.5">
                    {fact.items.map((item, i) => (
                      <div key={`${item.label}-${i}`} className="flex items-baseline justify-between gap-3">
                        <dt className="text-[11px] leading-snug text-slate-400">{item.label}</dt>
                        <dd className="shrink-0 text-[11px] font-medium tabular-nums text-slate-100">
                          {item.value === null || item.value === undefined ? (item.text ?? DASH) : formatValue(item.value, item.unit)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* --- 販売トレース --- */}
      <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
        <h3 className="mb-2 text-sm font-semibold">販売トレース（希望 → 計画 → 成約）</h3>
        {salesRows.length === 0 ? (
          <p className="text-xs text-slate-400">記録なし</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-xs" data-testid="aitrace-sales">
              <thead>
                <tr className="border-b border-slate-700 text-left text-slate-400">
                  <th className="py-1 pr-2">市場</th>
                  <th className="py-1 pr-2">商品</th>
                  <th className="py-1 pr-2 text-right">希望（工数制約前）</th>
                  <th className="py-1 pr-2 text-right">販売計画</th>
                  <th className="py-1 text-right">成約</th>
                </tr>
              </thead>
              <tbody>
                {salesRows.map((r, i) => (
                  <tr key={`${r.market}-${r.product}-${i}`} className="border-b border-slate-800">
                    <td className="py-1 pr-2">{r.market}</td>
                    <td className="py-1 pr-2">{r.product.toUpperCase()}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.wishedQuantity === null ? DASH : Math.round(r.wishedQuantity).toLocaleString()}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.plannedQuantity === null ? DASH : Math.round(r.plannedQuantity).toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums">{r.contractedQuantity === null ? DASH : Math.round(r.contractedQuantity).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* --- 採用トレース --- */}
      <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
        <h3 className="mb-2 text-sm font-semibold">採用トレース</h3>
        {hiringRow === null ? (
          <p className="text-xs text-slate-400">記録なし</p>
        ) : (
          <dl className="grid gap-x-6 gap-y-0.5 text-xs sm:grid-cols-2" data-testid="aitrace-hiring">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-400">営業人員 採用</dt>
              <dd className="tabular-nums">{hiringRow.salesForceHireCount} 人</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-400">営業人員 減員</dt>
              <dd className="tabular-nums">{hiringRow.salesForceLayoffCount} 人</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-400">期末営業人員</dt>
              <dd className="tabular-nums">{hiringRow.endingSalesHeadcount === null ? DASH : `${hiringRow.endingSalesHeadcount} 人`}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-400">臨時ワーカー配置</dt>
              <dd className="tabular-nums">{hiringRow.totalTemporaryWorkers} 人</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-400">平均残業率</dt>
              <dd className="tabular-nums">{hiringRow.averageOvertimeRate === null ? DASH : hiringRow.averageOvertimeRate.toFixed(3)}</dd>
            </div>
          </dl>
        )}
      </div>

      {/* --- 投資トレース --- */}
      <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
        <h3 className="mb-2 text-sm font-semibold">投資トレース</h3>
        {investmentRows.length === 0 ? (
          <p className="text-xs text-slate-400">このターンの設備投資イベントはありません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs" data-testid="aitrace-investment">
              <thead>
                <tr className="border-b border-slate-700 text-left text-slate-400">
                  <th className="py-1 pr-2">案件</th>
                  <th className="py-1 pr-2">種別</th>
                  <th className="py-1 pr-2">状態</th>
                  <th className="py-1 pr-2 text-right">金額</th>
                  <th className="py-1">理由</th>
                </tr>
              </thead>
              <tbody>
                {investmentRows.map((r, i) => (
                  <tr key={`${r.projectId}-${i}`} className="border-b border-slate-800">
                    <td className="py-1 pr-2 font-mono text-[10px]">{r.projectId}</td>
                    <td className="py-1 pr-2">{r.projectType}</td>
                    <td className="py-1 pr-2">{r.status}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.budgetUsd === null ? DASH : `${(r.budgetUsd / 1_000_000).toFixed(2)}M`}</td>
                    <td className="py-1 text-[11px] leading-snug text-slate-300">{r.note ?? DASH}</td>
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
