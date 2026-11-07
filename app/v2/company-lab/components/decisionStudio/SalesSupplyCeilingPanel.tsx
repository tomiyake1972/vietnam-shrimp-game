// ShrimpX V2 — SALES: 供給上限の目安パネル（表示専用）
//
// 【テストプレイ指摘①・2026-11】販売計画の入力欄の「すぐ上」に、商品別の
// 上限（完成品在庫＋実効加工能力）と、受注残を差し引いた新規販売の余地を出す。
// 値は salesSupplyCeilingViewModel が確定値から組み立てたものをそのまま並べるだけで、
// このファイルは整形しかしない。

import { formatHosoEqTons } from "../../../../lib/v2/industryLab/ui/formatters";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, NO_VALUE_TEXT } from "../panelStyles";
import type { SalesSupplyCeiling } from "../../salesSupplyCeilingViewModel";

function tons(value: number | null): string {
  return value === null ? NO_VALUE_TEXT : formatHosoEqTons(value);
}

export default function SalesSupplyCeilingPanel({ ceiling }: { readonly ceiling: SalesSupplyCeiling }) {
  if (ceiling.rows.length === 0) return null;

  return (
    <div className="mb-3 rounded-lg border border-sky-800/60 bg-sky-950/20 p-2.5" data-testid="sales-supply-ceiling">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <h4 className="text-xs font-semibold text-sky-200">今期この商品を何トンまで売る計画にできるか（目安）</h4>
        <span className="rounded border border-gray-600/70 bg-gray-800 px-1 py-[1px] text-[10px] text-gray-300">自動計算値</span>
      </div>

      {ceiling.capacityUnavailable ? (
        <p className="text-[11px] text-gray-400" data-testid="sales-supply-ceiling-unavailable">
          実効加工能力をこの画面へ渡せていないため、上限を表示できません（推測した数値は出しません）。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300" data-testid="sales-supply-ceiling-table">
            <thead>
              <tr className={INFO_TABLE_HEAD_CLASS}>
                <th className="pr-3 py-1 text-left">商品</th>
                <th className="pr-3 py-1 text-right">完成品在庫</th>
                <th className="pr-3 py-1 text-right">当期の実効加工能力</th>
                <th className="pr-3 py-1 text-right font-semibold">納められる上限</th>
                <th className="pr-3 py-1 text-right">受注残</th>
                <th className="pr-3 py-1 text-right font-semibold">販売可能量（上限）</th>
                <th className="pr-3 py-1 text-right">今の販売計画</th>
              </tr>
            </thead>
            <tbody>
              {ceiling.rows.map((row) => (
                <tr key={row.product} className={INFO_TABLE_ROW_CLASS} data-testid={`sales-supply-ceiling-row-${row.product}`}>
                  <td className="pr-3 py-1 uppercase">{row.product}</td>
                  <td className="pr-3 py-1 text-right tabular-nums" data-testid={`sales-supply-ceiling-finished-${row.product}`}>
                    {tons(row.finishedGoodsTons)}
                  </td>
                  <td className="pr-3 py-1 text-right tabular-nums" data-testid={`sales-supply-ceiling-capacity-${row.product}`}>
                    {tons(row.effectiveCapacityTons)}
                  </td>
                  <td className="pr-3 py-1 text-right font-semibold tabular-nums text-gray-100" data-testid={`sales-supply-ceiling-total-${row.product}`}>
                    {tons(row.supplyCeilingTons)}
                  </td>
                  <td className="pr-3 py-1 text-right tabular-nums" data-testid={`sales-supply-ceiling-backlog-${row.product}`}>
                    {tons(row.backlogTons)}
                    {row.backlogDueNowTons > 0 ? (
                      <span className="ml-1 text-[10px] text-amber-300">うち今期納期 {formatHosoEqTons(row.backlogDueNowTons)}</span>
                    ) : null}
                  </td>
                  <td
                    className={`pr-3 py-1 text-right font-semibold tabular-nums ${row.exceedsAvailableForNewSales ? "text-amber-300" : "text-sky-200"}`}
                    data-testid={`sales-supply-ceiling-available-${row.product}`}
                  >
                    {tons(row.availableForNewSalesTons)}
                  </td>
                  <td
                    className={`pr-3 py-1 text-right tabular-nums ${row.exceedsSupplyCeiling ? "font-semibold text-rose-300" : ""}`}
                    data-testid={`sales-supply-ceiling-planned-${row.product}`}
                  >
                    {tons(row.plannedTons)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ceiling.productsOverSupplyCeiling.length > 0 ? (
        <p className="mt-1.5 text-[11px] leading-snug text-rose-300" role="alert" data-testid="sales-supply-ceiling-over-warning">
          {ceiling.productsOverSupplyCeiling.map((p) => p.toUpperCase()).join("・")} の販売計画が、完成品在庫と当期の実効加工能力を足した上限を超えています。
          この量は今期どうやっても納められません。初期値として入っているAIの提案は、在庫・受注残・実効能力を見ていないことがあります。
        </p>
      ) : null}
      {ceiling.productsOverAvailableForNewSales.length > 0 ? (
        <p className="mt-1.5 text-[11px] leading-snug text-amber-300" role="alert" data-testid="sales-supply-ceiling-backlog-warning">
          {ceiling.productsOverAvailableForNewSales.map((p) => p.toUpperCase()).join("・")} の販売計画が「販売可能量（上限）」を超えています（納められる上限の内側ですが、受注残を先に納めると足りません）。
          受注残の納品が遅れると納期信頼性が下がります。
        </p>
      ) : null}

      {/* 【納期ルールの明示・2026-11】実測（dynamic-scenario-2 / BAL / Turn1）:
          当期に成約した 10,194t はすべて納期が翌期だが、そのうち 8,295t は当期中に納入された。
          初期受注残 3,100t のうち 2,800t も、納期（翌期・翌々期）より前に当期中に納入された。
          契約の充当は納期で絞らず、在庫がある分だけ古い契約から順に出荷する実装である
          （sales/backlog.ts applyFulfillments）。したがって受注残は納期が先の分も
          当期の在庫・生産能力を取り合うため、上限からは全額を差し引く。 */}
      <p className="mt-1.5 text-[11px] leading-snug text-gray-400" data-testid="sales-supply-ceiling-due-rule">
        <span className="font-semibold">納期の決まり:</span>{" "}
        いま新しく成約する分の納期は翌期です。ただし当期中に出荷できる分は当期に納入されます。
        受注残も、納期が先のぶんであっても在庫があれば当期に出荷されるため、当期の在庫・生産能力を取り合います。
        だから上限からは受注残を全額差し引いています。
      </p>
      <p className="mt-1.5 text-[11px] leading-snug text-gray-500">
        「納められる上限」＝ 完成品在庫 ＋ 当期の実効加工能力。「販売可能量（上限）」＝ その上限 − 受注残。
        入力欄の初期値もこの「販売可能量（上限）」に収まるよう調整してあります。
        いずれも目安です。実効加工能力は現時点の原料在庫を前提にした見込みで、当期の買付・輸入到着ぶんは含みません。
        提示した量がそのまま成約するわけでもありません（成約量は5社の競争で決まります）。
      </p>
    </div>
  );
}
