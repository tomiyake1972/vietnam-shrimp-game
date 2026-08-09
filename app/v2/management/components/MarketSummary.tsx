"use client";

// ShrimpX V2 — 32Q Management Console: Market Summary（Phase 1・簡易表示）
//
// 【取得できるものだけを出す】市場×商品の需要量・価格は確定記録
// （salesRecord.allocations の targetDemand / basePrice）から取れる。
// 国別供給シェアは記録に存在しないため**表示しない**（架空値を作らない）。
//
// 【TRUE WORLD と OBSERVABLE の区別】ここに出しているのは Game Owner 向けの
// TRUE WORLD（確定記録）である。Standard AI はこの値を直接受け取らず、
// observation 経由の観測値（遅延つき）だけを見る。両者を混同しないよう明示する。

import { CompanyLabState } from "../../../lib/v2/companyLab/types";
import { unwrapUnit } from "../../../lib/v2/core/units";

const PRODUCTS = ["hoso", "pd", "vap"] as const;

export function MarketSummary({ state }: { readonly state: CompanyLabState }) {
  const record = state.history[state.history.length - 1];
  if (!record) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
        <h2 className="mb-1 text-sm font-semibold">Market Summary</h2>
        <p className="text-xs text-slate-400">ターンを進めると表示されます。</p>
      </section>
    );
  }

  const byMarket = new Map<string, Record<string, { demand: number; price: number }>>();
  for (const a of record.salesRecord.allocations) {
    const key = String(a.market);
    const row = byMarket.get(key) ?? {};
    row[String(a.product)] = {
      demand: unwrapUnit(a.targetDemand),
      price: unwrapUnit(a.basePrice),
    };
    byMarket.set(key, row);
  }
  const markets = [...byMarket.keys()].sort();

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Market Summary（Turn {record.turn}）</h2>
        <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
          TRUE WORLD
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <thead>
            <tr className="border-b border-slate-700 text-slate-400">
              <th className="py-1 pr-2 text-left">市場</th>
              {PRODUCTS.map((p) => (
                <th key={`d-${p}`} className="px-1 py-1 text-right">{p.toUpperCase()} 需要(t)</th>
              ))}
              {PRODUCTS.map((p) => (
                <th key={`p-${p}`} className="px-1 py-1 text-right">{p.toUpperCase()} 価格</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => {
              const row = byMarket.get(m)!;
              return (
                <tr key={m} className="border-b border-slate-800">
                  <td className="py-1 pr-2 font-semibold">{m}</td>
                  {PRODUCTS.map((p) => (
                    <td key={`d-${p}`} className="px-1 py-1 text-right tabular-nums">
                      {row[p] ? Math.round(row[p].demand).toLocaleString() : "－"}
                    </td>
                  ))}
                  {PRODUCTS.map((p) => (
                    <td key={`p-${p}`} className="px-1 py-1 text-right tabular-nums">
                      {row[p] ? row[p].price.toFixed(3) : "－"}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
        これは Game Owner 向けの確定記録（TRUE WORLD）です。Standard AI はこの値を直接は見ず、
        観測遅延のある observation だけを使います。国別（ベトナム／エクアドル／インド／インドネシア）の
        供給シェアは市場別には記録されていないため表示していません。
      </p>
    </section>
  );
}
