// ShrimpX V2 — Company Lab 財務・資金・設備投資パネル 共通表示部品
//
// 既存の永続化済みデータをそのまま表示するだけの純粋な表示コンポーネント群。
// 【当期・前期・増減】の3列表示、および「ゼロ」「該当なし（undefined）」の
// 区別（ゼロは"$0"、該当なしは"—"）を、全タブ（PL/BS/CF/資金調達/設備投資）で
// 統一する。

import { formatUsd } from "../../../../lib/v2/industryLab/ui/formatters";

/** 数値行1本ぶんの表示。current/previousがundefinedなら「該当項目自体が存在しない」= "—"。0は"$0"として区別する。 */
export function LineRow(props: {
  readonly label: string;
  readonly current: number | undefined;
  readonly previous: number | null | undefined;
  readonly bold?: boolean;
  readonly indent?: boolean;
}) {
  const hasCurrent = props.current !== undefined && props.current !== null;
  const hasPrevious = props.previous !== undefined && props.previous !== null;
  const change = hasCurrent && hasPrevious ? (props.current as number) - (props.previous as number) : null;
  const changeColor = change === null ? "text-gray-500" : change < 0 ? "text-rose-400" : change > 0 ? "text-emerald-400" : "text-gray-500";
  return (
    <tr className={props.bold ? "font-semibold text-gray-100" : "text-gray-300"}>
      <td className={`py-1 pr-3 ${props.indent ? "pl-4" : ""}`}>{props.label}</td>
      <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">{hasCurrent ? formatUsd(props.current as number) : "—"}</td>
      <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap text-gray-500">{hasPrevious ? formatUsd(props.previous as number) : "—"}</td>
      <td className={`py-1 text-right tabular-nums whitespace-nowrap ${changeColor}`}>
        {change !== null ? `${change >= 0 ? "+" : ""}${formatUsd(change)}` : "—"}
      </td>
    </tr>
  );
}

/** 数値ではなく文字列（分類・ステータス等）1本ぶんの表示行。増減列は使わない。 */
export function TextRow(props: { readonly label: string; readonly current: string; readonly previous?: string; readonly bold?: boolean }) {
  return (
    <tr className={props.bold ? "font-semibold text-gray-100" : "text-gray-300"}>
      <td className="py-1 pr-3">{props.label}</td>
      <td className="py-1 pr-3 text-right whitespace-nowrap" colSpan={props.previous !== undefined ? 1 : 3}>
        {props.current}
      </td>
      {props.previous !== undefined && <td className="py-1 pr-3 text-right whitespace-nowrap text-gray-500" colSpan={2}>{props.previous}</td>}
    </tr>
  );
}

export function TableHead(props: { readonly valueLabel?: string }) {
  return (
    <thead>
      <tr className="text-[11px] text-gray-500 border-b border-gray-700">
        <th className="text-left py-1 pr-3 font-normal">{props.valueLabel ?? "科目"}</th>
        <th className="text-right py-1 pr-3 font-normal">当期</th>
        <th className="text-right py-1 pr-3 font-normal">前期</th>
        <th className="text-right py-1 font-normal">増減</th>
      </tr>
    </thead>
  );
}

export function NoDataNotice(props: { readonly label: string }) {
  return <div className="text-xs text-gray-500 py-4 text-center">{props.label}のデータが未作成です（この四半期はまだ処理されていません）。</div>;
}

export function UnitNote(props: { readonly text?: string }) {
  return <div className="text-[11px] text-gray-500">{props.text ?? "単位: USD（表示は小数点以下四捨五入。内部保持精度は変更しない）"}</div>;
}

export function ReasonList(props: { readonly reasons: readonly string[] }) {
  if (props.reasons.length === 0) return null;
  return (
    <ul className="text-[11px] text-amber-200 space-y-0.5 list-disc list-inside">
      {props.reasons.map((r, idx) => (
        <li key={idx}>{r}</li>
      ))}
    </ul>
  );
}

export function Badge(props: { readonly text: string; readonly tone: "ok" | "warn" | "danger" | "neutral" }) {
  const toneClass = {
    ok: "bg-teal-950/60 border-teal-700/50 text-teal-200",
    warn: "bg-amber-950/60 border-amber-700/50 text-amber-200",
    danger: "bg-rose-950/60 border-rose-700/50 text-rose-200",
    neutral: "bg-gray-900/50 border-gray-700/50 text-gray-300",
  }[props.tone];
  return <span className={`text-[11px] border rounded-full px-2 py-0.5 ${toneClass}`}>{props.text}</span>;
}
