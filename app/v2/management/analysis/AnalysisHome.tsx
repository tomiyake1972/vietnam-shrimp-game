"use client";

// ShrimpX V2 — Analysis Home（分析の索引）
//
// 【この画面は「詳細を見る画面」ではない】
// 32Q の比較では、市場価格・商品採算・営業人数・営業配置・固定費を**同時に**並べたい。
// したがってここは巨大 dashboard ではなく、「見たい分析へすぐ移動する索引」にする。
//
//  - 各カテゴリは既定ですべて閉じている（開くまでリンク一覧すら描かない）
//  - チャートは1つも描かない。dataset の中身も先読みしない
//  - 各分析へは通常の <a href> で移動する（Ctrl+Click・中クリック・新しいタブが効く）
//
// 【Simulationを実行しない・current run を切り替えない】
// 表示中の run は URL の `?run=` を読むだけで、active run は書き換えない。

import Link from "next/link";
import { ANALYSIS_CATEGORIES, QUICK_NAVIGATION } from "./catalog";
import { Collapsible } from "../components/Collapsible";
import { ExportPackButton } from "../components/ExportPackButton";
import { analysisHref, useAnalysisRun } from "./lib/useAnalysisRun";

const STOP_REASON_LABELS: Readonly<Record<string, string>> = {
  completed: "完走",
  stopped_by_user: "途中停止",
  error: "失敗",
  scenario_end: "シナリオ終端",
  running: "実行中",
};

export function AnalysisHome() {
  const { stored, runs, loading, notFoundRunId } = useAnalysisRun();
  const runId = stored?.run.simulationRunId ?? null;

  return (
    <div className="min-h-screen bg-slate-950 p-4 text-slate-100">
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-base font-bold">32Q Analysis</h1>
        <Link href={runId ? `/v2/management?run=${encodeURIComponent(runId)}` : "/v2/management"} className="rounded border border-slate-600 px-2.5 py-1 text-xs hover:bg-slate-800">
          ← 経営管制室
        </Link>
        <span className="text-xs text-slate-400" data-testid="analysis-run-status">
          {loading
            ? "読み込み中…"
            : stored
              ? `${stored.dataset.turns.length} / ${stored.run.requestedTurns} Turns（${STOP_REASON_LABELS[stored.run.stopReason] ?? stored.run.stopReason}） ・ ${stored.run.simulationRunId}`
              : "保存済みの Simulation Run がありません"}
        </span>
      </header>

      {!loading && !stored ? (
        <p className="mb-3 rounded border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200" data-testid="analysis-empty">
          {notFoundRunId ? `Simulation Run「${notFoundRunId}」が見つかりませんでした。` : "まだ保存された Simulation Run がありません。"} 経営管制室で 32 Turns
          を実行してください。
        </p>
      ) : null}

      {/* --- Quick Navigation：1クリックで主要分析へ --- */}
      <nav className="mb-3 flex flex-wrap items-center gap-1.5" aria-label="主要分析へのショートカット">
        <span className="text-xs text-slate-400">Quick:</span>
        {QUICK_NAVIGATION.map((q) => (
          <Link
            key={q.testId}
            href={analysisHref(q.path, runId)}
            data-testid={q.testId}
            className="rounded border border-sky-700 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-sky-300 hover:bg-slate-800"
          >
            {q.label}
          </Link>
        ))}
      </nav>

      <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
        各分析は独立した URL を持ちます。リンクを <kbd className="rounded bg-slate-800 px-1">Ctrl</kbd>+クリック（または中クリック・右クリック →
        「新しいタブで開く」）すると、別のブラウザタブで開いて並べて比較できます。別タブで Run
        を切り替えても、このタブが見ている Run は変わりません。
      </p>

      {/* --- AI Analysis Pack：選択中の Simulation Run について出力する --- */}
      <div className="mb-3">
        <ExportPackButton
          simulationRunId={stored?.run.simulationRunId ?? null}
          scenarioId={stored?.run.scenarioId ?? null}
          seed={stored?.run.seed ?? null}
          completedTurns={stored?.run.completedTurns ?? null}
        />
      </div>

      {/* --- カテゴリ：初期状態はすべて閉じている --- */}
      <div className="flex flex-col gap-2" data-testid="analysis-categories">
        {ANALYSIS_CATEGORIES.map((category) => (
          <Collapsible key={category.key} title={category.label} testId={`analysis-category-${category.key}`}>
            <ul className="flex flex-col gap-1">
              {category.items.map((item, index) => (
                <li key={`${category.key}-${index}`}>
                  {item.implemented ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Link href={analysisHref(item.path, runId)} className="text-sm text-sky-300 underline-offset-2 hover:underline">
                        {item.label}
                      </Link>
                      <Link
                        href={analysisHref(item.path, runId)}
                        target="_blank"
                        rel="noopener"
                        title="新しいタブで開く"
                        className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-800"
                      >
                        新しいタブ ↗
                      </Link>
                    </span>
                  ) : (
                    <span className="text-sm text-slate-500">
                      {item.label}
                      <span className="ml-2 text-[11px]">（未実装{item.note ? ` — ${item.note}` : ""}）</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Collapsible>
        ))}
      </div>

      {runs.length > 1 ? (
        <div className="mt-3">
          <Collapsible title={`保存済み Simulation Run（${runs.length}件）`} testId="analysis-category-runs">
            <ul className="flex flex-col gap-1 text-xs">
              {runs.map((r, index) => (
                <li key={r.simulationRunId} className="flex flex-wrap items-center gap-2">
                  <Link href={analysisHref("/v2/management/analysis", r.simulationRunId)} className="font-mono text-sky-300 underline-offset-2 hover:underline">
                    {index === 0 ? "Current" : `Previous ${index}`}: {r.simulationRunId}
                  </Link>
                  <span className="text-slate-500">
                    {r.completedTurns}/{r.requestedTurns}Q ・ {STOP_REASON_LABELS[r.stopReason] ?? r.stopReason} ・ {r.savedAt.slice(0, 19).replace("T", " ")}
                  </span>
                </li>
              ))}
            </ul>
          </Collapsible>
        </div>
      ) : null}
    </div>
  );
}
