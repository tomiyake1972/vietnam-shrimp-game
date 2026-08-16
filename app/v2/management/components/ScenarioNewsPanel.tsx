"use client";

// ShrimpX V2 — Management Console: シナリオNews表示（Testplay 用の最小実装）
//
// 【この層がやること】渡された記事を並べて表示するだけ。
// 【この層がやらないこと】
//  - どの記事を出すかの判定（lib/scenarioNews.ts の責務）
//  - ターン番号・シナリオIDでの内容の分岐
//  - 開発用の内部メタデータ（signalClass / 重要度 / 効果発生ターン等）の表示
//    ＝そもそも InformationRelease にそれらのフィールドは存在しない。

import { InformationRelease } from "../../../lib/v2/scenario/types";

interface Props {
  readonly turn: number;
  readonly releases: readonly InformationRelease[];
  /** シナリオ定義が解決できなかった場合（設定ミスを黙って隠さない）。 */
  readonly scenarioNotFound: boolean;
}

export function ScenarioNewsPanel({ turn, releases, scenarioNotFound }: Props) {
  if (scenarioNotFound) {
    return <p className="text-xs text-slate-400">シナリオ定義を解決できませんでした。</p>;
  }
  if (releases.length === 0) {
    return <p className="text-xs text-slate-400">このシナリオにはニュースがありません。</p>;
  }

  const currentTurnCount = releases.filter((r) => r.availableFromTurn === turn).length;

  return (
    <div data-testid="console-scenario-news">
      <p className="mb-2 text-[11px] text-slate-400">
        Turn {turn} 時点で読める記事 {releases.length} 件（うち今ターン {currentTurnCount} 件）。
        プレイヤーが見るのと同じ内容です。
      </p>
      <ul className="flex flex-col gap-2">
        {releases.map((r) => (
          <li
            key={r.informationId}
            className="rounded border border-slate-700 bg-slate-900/60 p-2"
            data-testid={`console-news-item-${r.informationId}`}
          >
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <span className="shrink-0 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-200">T{r.availableFromTurn}</span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                  r.isRumor ? "bg-amber-900/70 text-amber-200" : "bg-slate-700 text-slate-200"
                }`}
              >
                {r.isRumor ? "観測・噂" : "確報"}
              </span>
              {r.availableFromTurn === turn && (
                <span className="shrink-0 rounded bg-teal-800 px-1.5 py-0.5 text-[10px] text-teal-100">新着</span>
              )}
              <span className="text-xs font-semibold text-slate-100">{r.headlineTemplate}</span>
            </div>
            {r.body && <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-slate-300">{r.body}</p>}
            {r.structuredFacts.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-400">
                {r.structuredFacts.map((fact) => (
                  <span key={fact.key}>
                    {fact.label}: {String(fact.value)}
                    {fact.unit ?? ""}
                  </span>
                ))}
              </div>
            )}
            {r.estimateRange && (
              <div className="mt-0.5 text-[10px] text-slate-500">
                推定幅: {r.estimateRange.low} 〜 {r.estimateRange.high}
                {r.estimateRange.unit ?? ""}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
