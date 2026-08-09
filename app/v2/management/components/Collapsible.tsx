"use client";

// ShrimpX V2 — 折りたたみセクション
//
// 【既定は必ず閉じる】画面を開いた直後に大量のチャート・巨大な表を描かないための部品。
// 閉じている間は children を**マウントしない**（描画コストも発生しない）。

import { useState } from "react";

interface Props {
  readonly title: string;
  readonly testId?: string;
  /** 既定は閉。開いた状態で出したい場合だけ true にする。 */
  readonly defaultOpen?: boolean;
  readonly hint?: string;
  readonly children: React.ReactNode;
}

export function Collapsible({ title, testId, defaultOpen = false, hint, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900/50">
      <h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid={testId}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold hover:bg-slate-800/60"
        >
          <span aria-hidden className="text-slate-400">
            {open ? "▼" : "▶"}
          </span>
          <span>{title}</span>
          {hint ? <span className="ml-auto text-[11px] font-normal text-slate-500">{hint}</span> : null}
        </button>
      </h2>
      {/* 閉じている間はマウントしない（先読みも描画もしない） */}
      {open ? <div className="border-t border-slate-800 p-3">{children}</div> : null}
    </section>
  );
}
