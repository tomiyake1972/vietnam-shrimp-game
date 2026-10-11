// ShrimpX V2 — Overview の先頭に置く「前Turnのふりかえり」
//
// 【この画面が答えること】ターンが新しくなったとき、経営者が最初に知りたいのは
//   「前期に自分が出した指示が、どう実行され、どういう結果になったか」である。
// 以前の Overview は先頭が Vision・Strategy Profile・Commercial Growth
// （Standard AI の戦略説明）で、自分の指示の結果が見えなかった。
//
// 【計算しない】表示する値はすべて lastTurnReviewViewModel が確定記録から
// 転記したものである。このコンポーネントに算式は無い。

import { useState } from "react";
import type { LastTurnReview, ReviewSection, ReviewTone } from "../lastTurnReviewViewModel";

const TONE_TEXT: Readonly<Record<ReviewTone, string>> = {
  neutral: "text-slate-200",
  good: "text-emerald-300",
  warn: "text-amber-300",
};

const TONE_BORDER: Readonly<Record<ReviewTone, string>> = {
  neutral: "border-slate-700",
  good: "border-emerald-800/70",
  warn: "border-amber-800/70",
};

function SectionBlock({ section, defaultOpen }: { readonly section: ReviewSection; readonly defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const tone = section.tone ?? "neutral";
  const hasInstructions = section.lines.some((line) => line.instructed !== undefined);
  return (
    <section className={`rounded-lg border ${TONE_BORDER[tone]} bg-slate-900/50`} data-testid={`review-section-${section.key}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left"
      >
        <span>
          <span className="block text-sm font-semibold text-slate-100">{section.title}</span>
          <span className={`block text-[11px] ${TONE_TEXT[tone]}`} data-testid={`review-headline-${section.key}`}>
            {section.headline}
          </span>
        </span>
        <span className="shrink-0 pt-0.5 text-[11px] text-slate-400">{open ? "閉じる" : "詳しく"}</span>
      </button>

      {open ? (
        <div className="overflow-x-auto border-t border-slate-800 px-3 py-2">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500">
                <th className="pr-3 pb-1 font-medium">項目</th>
                {/* 指示という概念が無いセクション（業績など）では、空欄だけの列を出さない。 */}
                {hasInstructions ? <th className="pr-3 pb-1 font-medium">あなたの指示</th> : null}
                <th className="pr-3 pb-1 font-medium">結果</th>
              </tr>
            </thead>
            <tbody>
              {section.lines.map((line) => (
                <tr key={line.testId} className="border-t border-slate-800/80 align-top" data-testid={line.testId}>
                  <td className="py-1 pr-3 text-slate-400">{line.label}</td>
                  {hasInstructions ? (
                    <td className="py-1 pr-3 tabular-nums text-slate-300" data-testid={`${line.testId}-instructed`}>
                      {line.instructed ?? "—"}
                    </td>
                  ) : null}
                  <td className={`py-1 pr-3 tabular-nums font-medium ${TONE_TEXT[line.tone ?? "neutral"]}`} data-testid={`${line.testId}-result`}>
                    {line.result ?? "記録なし"}
                    {line.note !== undefined ? (
                      <span className="mt-0.5 block text-[10px] font-normal leading-tight text-slate-400">{line.note}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export default function LastTurnReviewPanel({ review }: { readonly review: LastTurnReview }) {
  return (
    <div className="mb-3 space-y-2" data-testid="last-turn-review">
      <div className="rounded-lg border border-sky-800/70 bg-sky-950/30 px-3 py-2">
        <h2 className="text-sm font-semibold text-slate-100" data-testid="last-turn-review-title">
          Turn {review.turn}（{review.period}）のふりかえり — 出した指示とその結果
        </h2>
        <p className="mt-0.5 text-[11px] text-slate-400">
          直前に確定した四半期の記録です。左が提出した指示、右が実際に起きたことです。
          {review.hasSubmittedDecision
            ? ""
            : "（この四半期の提出内容は記録に残っていないため、「あなたの指示」列は空欄になります。）"}
        </p>
      </div>

      {review.sections.map((section, index) => (
        // 業績と販売は開いた状態で出す。残りは見出しの1行要約だけ見えていれば足りる。
        <SectionBlock key={section.key} section={section} defaultOpen={index < 2} />
      ))}
    </div>
  );
}
