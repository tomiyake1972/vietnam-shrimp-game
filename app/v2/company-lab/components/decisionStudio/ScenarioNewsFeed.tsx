// ShrimpX V2 — Decision Studio: Scenario News Feed（Turn Start / INFOタブ用）
//
// 【原因】Test26 (Dynamic Scenario 1) をManagement Console → PLAYER Workspace
// 経由でtestplayすると、News（世界情勢の記事）がどこにも表示されなかった。
// 調査の結果、Newsデータ自体はシナリオ側に豊富に存在し（dynamicScenario1News.ts）、
// GM向けのManagement Console画面（ManagementConsole.tsx）には既に配線されていたが、
// プレイヤーが実際に操作するPLAYER Workspace（Decision Studio INFOタブ）には
// 一度も配線されていなかった（A: UIへの配線漏れ。scenario側のNews contract・
// 情報公開判定ロジックは変更していない）。
//
// 【この層がやること】既存の ScenarioNewsItem（openingInfoViewModel.tsが
// InformationRelease から変換した、プレイヤー向けに絞り込み済みの記事）を
// 並べて表示するだけ。本文の生成・要約・重要度判定は一切行わない。
//
// 【この層がやらないこと】
//  - 記事本文の再生成・AI要約をしない（渡された body をそのまま出す）。
//  - 「重要Newsだけ」の自動選別をしない（全記事を一覧に出す）。
//  - signalStrength / scenarioRelevance / hidden importance / 効果発生ターン等、
//    非公開の内部メタデータを一切表示しない（そもそも ScenarioNewsItem に
//    含まれていない）。confidence（確信度）もデータにはあるが、重要度に
//    見えてしまうため表示しない（既存のScenarioNewsPanelと同じ方針）。
//  - Current Event / Leading Indicator / Structural Trend の分類は「重要度」
//    ではなく「時間軸」の分類であり、classifyScenarioNewsTimeAxisが
//    isRumor・relatedEventIdという既存の公開フィールドから機械的に導出する
//    （dynamicScenario1News.ts が明記している規約をそのまま使う。新しい
//    重要度ラベルを作らない）。

import { useState } from "react";
import { classifyScenarioNewsTimeAxis, ScenarioNewsItem, ScenarioNewsTimeAxis } from "../../play/_lib/openingInfoViewModel";
import { AREA_TONES } from "../panelStyles";

const TIME_AXIS_LABEL: Readonly<Record<ScenarioNewsTimeAxis, string>> = {
  current: "確報 (Current Event)",
  leading: "観測・噂 (Leading Indicator)",
  structural: "構造トレンド (Structural Trend)",
};

const TIME_AXIS_BADGE_CLASS: Readonly<Record<ScenarioNewsTimeAxis, string>> = {
  current: "bg-slate-700 text-slate-200",
  leading: "bg-amber-900/70 text-amber-200",
  structural: "bg-sky-900/70 text-sky-200",
};

/** リード文の目安文字数（2〜3行相当）。本文がこれ以下ならそのまま全文を表示する。 */
const LEAD_CHARS = 140;

function NewsCard({ item }: { readonly item: ScenarioNewsItem }) {
  const timeAxis = classifyScenarioNewsTimeAxis(item);
  const body = item.body;
  const lead = body !== null && body.length > LEAD_CHARS ? body.slice(0, LEAD_CHARS) : body;
  const rest = body !== null && body.length > LEAD_CHARS ? body.slice(LEAD_CHARS) : null;

  return (
    <li className="rounded-lg border border-gray-700 bg-gray-900/50 p-2.5" data-testid={`scenario-news-feed-item-${item.informationId}`}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${TIME_AXIS_BADGE_CLASS[timeAxis]}`}>{TIME_AXIS_LABEL[timeAxis]}</span>
        <span className="text-sm font-semibold text-gray-100">{item.headline}</span>
      </div>
      {item.facts.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {item.facts.map((f) => (
            <span key={f.label} className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
              {f.label}: {f.value}
              {f.unit ?? ""}
            </span>
          ))}
        </div>
      )}
      {lead !== null && <p className="text-[11px] leading-relaxed text-gray-300">{lead}{rest !== null ? "…" : ""}</p>}
      {rest !== null && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-sky-300 hover:text-sky-200">全文を読む</summary>
          <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-gray-300">{rest}</p>
          {item.estimateRange && (
            <p className="mt-1 text-[10px] text-gray-500">
              推定幅: {item.estimateRange.low} 〜 {item.estimateRange.high}
              {item.estimateRange.unit ?? ""}
            </p>
          )}
        </details>
      )}
      {rest === null && item.estimateRange && (
        <p className="mt-1 text-[10px] text-gray-500">
          推定幅: {item.estimateRange.low} 〜 {item.estimateRange.high}
          {item.estimateRange.unit ?? ""}
        </p>
      )}
    </li>
  );
}

function groupByTurn(news: readonly ScenarioNewsItem[]): ReadonlyMap<number, readonly ScenarioNewsItem[]> {
  const map = new Map<number, ScenarioNewsItem[]>();
  for (const item of news) {
    const list = map.get(item.availableFromTurn);
    if (list) list.push(item);
    else map.set(item.availableFromTurn, [item]);
  }
  return map;
}

interface ScenarioNewsHistoryProps {
  readonly turns: readonly number[];
  readonly byTurn: ReadonlyMap<number, readonly ScenarioNewsItem[]>;
}

function ScenarioNewsHistory({ turns, byTurn }: ScenarioNewsHistoryProps) {
  const [open, setOpen] = useState(false);
  if (turns.length === 0) return null;
  const totalCount = turns.reduce((sum, t) => sum + (byTurn.get(t)?.length ?? 0), 0);

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900/30" data-testid="scenario-news-history">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="scenario-news-history-toggle"
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-xs font-semibold text-gray-300">
          過去のニュース（Turn {turns[turns.length - 1]}〜{turns[0]}、{totalCount}件）
        </span>
        <span aria-hidden className="text-gray-500 text-[10px]">
          {open ? "▼" : "▶"}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          {turns.map((t) => {
            const items = byTurn.get(t) ?? [];
            return (
              <details key={t} data-testid={`scenario-news-history-turn-${t}`}>
                <summary className="cursor-pointer text-[11px] font-semibold text-gray-400 hover:text-gray-300">
                  Turn {t}（{items.length}件）
                </summary>
                <ul className="mt-1.5 flex flex-col gap-1.5 pl-2">
                  {items.map((item) => (
                    <NewsCard key={item.informationId} item={item} />
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ScenarioNewsFeedProps {
  readonly news: readonly ScenarioNewsItem[];
  readonly turn: number;
}

export default function ScenarioNewsFeed({ news, turn }: ScenarioNewsFeedProps) {
  const tone = AREA_TONES.info;
  const byTurn = groupByTurn(news);
  const currentTurnItems = byTurn.get(turn) ?? [];
  const historyTurns = [...byTurn.keys()].filter((t) => t !== turn).sort((a, b) => b - a);

  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="decision-studio-scenario-news">
      <div className="mb-2 flex items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>世界のニュース（Turn {turn}）</span>
      </div>

      {news.length === 0 ? (
        <p className="text-xs text-gray-500">このシナリオにはニュースがありません。</p>
      ) : (
        <>
          {currentTurnItems.length > 0 ? (
            <ul className="flex flex-col gap-2" data-testid="scenario-news-feed-current-turn">
              {currentTurnItems.map((item) => (
                <NewsCard key={item.informationId} item={item} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-gray-500">Turn {turn} の新着記事はありません。</p>
          )}
          <div className="mt-2">
            <ScenarioNewsHistory turns={historyTurns} byTurn={byTurn} />
          </div>
        </>
      )}
    </div>
  );
}
