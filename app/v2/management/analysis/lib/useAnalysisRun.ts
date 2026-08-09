"use client";

// ShrimpX V2 — Analysis 画面共通: Simulation Run の解決とURL状態
//
// 【この層が守る2つの規約】
//  1. **Analysis 画面を開いても current run を切り替えない。**
//     どの分析画面も `?run=` を読むだけで、active run（localStorage）へは書き込まない。
//     これにより、別のbrowser tabで別のrunを開いても互いのrunが入れ替わらない。
//  2. **画面の選択状態はURLに持つ。** market / company の選択も query に載せるため、
//     「JPの価格」「BALの営業配置」をそれぞれ別のbrowser tabとして保持できる。
//
// 【Simulationを実行しない】この層は保存済みの Simulation Run を読むだけであり、
// engine を一切呼ばない。

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { SimulationRunSummary, StoredSimulationRun } from "../../../../lib/v2/companyLab/simulation/persistence/types";
import { getActiveSimulationRunId, listSimulationRuns, loadSimulationRun } from "../../lib/simulationRunStore";

export interface AnalysisRunState {
  readonly stored: StoredSimulationRun | null;
  readonly runs: readonly SimulationRunSummary[];
  readonly loading: boolean;
  /** URLで指定されたが見つからなかった runId（見つかった場合・未指定の場合は null）。 */
  readonly notFoundRunId: string | null;
  /** 現在表示している runId（未解決なら null）。 */
  readonly runId: string | null;
}

/** 現在のURLのquery（SSR時は空）。 */
function currentSearchParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

/** query から1つ読む。 */
export function readQueryParam(key: string): string | null {
  return currentSearchParams().get(key);
}

/** URL が書き換わったことを購読者へ知らせる自前のイベント（history API は通知を出さないため）。 */
const QUERY_CHANGED_EVENT = "shrimpx:analysis-query-changed";

/**
 * queryを1つ書き換える（履歴を汚さず、リロードもしない）。
 * URLに載せることで、そのタブの選択状態がリロード後も保たれる。
 */
export function replaceQueryParam(key: string, value: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set(key, value);
  window.history.replaceState(null, "", url.toString());
  window.dispatchEvent(new Event(QUERY_CHANGED_EVENT));
}

function subscribeToQuery(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("popstate", onChange);
  window.addEventListener(QUERY_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(QUERY_CHANGED_EVENT, onChange);
  };
}

/**
 * URL の query を**唯一の情報源**として読む。
 *
 * 画面のローカル state に選択状態を二重に持たない。これにより
 *   - リロードしても選択が保たれる
 *   - 別のブラウザタブが別の選択を持っていても互いに影響しない
 * が自然に成立する。URL は React の外にある状態なので useSyncExternalStore で購読する
 * （サーバー描画時は fallback を返すため、hydration のズレも起きない）。
 */
export function useQueryParam(key: string, fallback: string): string {
  return useSyncExternalStore(
    subscribeToQuery,
    () => currentSearchParams().get(key) ?? fallback,
    () => fallback
  );
}

/**
 * 分析画面へのリンクを作る。
 * **通常の `<a href>` として使えること**が重要で、これにより Ctrl+Click・中クリック・
 * 「新しいタブで開く」がそのまま機能する。
 */
export function analysisHref(path: string, runId: string | null, extra?: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  if (runId) params.set("run", runId);
  for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
  const query = params.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

/**
 * 表示対象の Simulation Run を解決する。
 *
 * 優先順位: URLの `?run=` → active run → 保存済みの最新。
 * **どの経路でも active run を書き換えない**（読むだけ）。
 */
export function useAnalysisRun(): AnalysisRunState & { readonly reload: () => void } {
  const [state, setState] = useState<AnalysisRunState>({ stored: null, runs: [], loading: true, notFoundRunId: null, runId: null });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const runs = await listSimulationRuns();
      if (cancelled) return;

      const requested = readQueryParam("run");
      const target = requested ?? getActiveSimulationRunId() ?? runs[0]?.simulationRunId ?? null;
      if (target === null) {
        setState({ stored: null, runs, loading: false, notFoundRunId: null, runId: null });
        return;
      }
      const stored = await loadSimulationRun(target);
      if (cancelled) return;
      setState({
        stored,
        runs,
        loading: false,
        notFoundRunId: stored === null ? target : null,
        runId: stored === null ? null : target,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { ...state, reload };
}
