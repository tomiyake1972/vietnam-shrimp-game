// ShrimpX V2 — Decision Studio: 競合動向ニュース（INFOタブ）
//
// 【この層がやること】サーバーが既に組み立てた CompetitorNewsItem を並べるだけ。
// 記事の生成・選別・要約はしない（生成は competitorNews.ts の責務）。
//
// 【この層がやらないこと】
//  - isMisleading を画面へ出さない。外れている可能性があることは確度ラベル
//    （観測・噂）で示すのみで、「この記事は外れです」とは出さない
//    （出したら噂である意味が無い）。
//  - 記事の優先順位・本数上限をここで変えない（生成側で確定済み）。

import type { CompetitorNewsConfidence, CompetitorNewsItem } from "../../../../lib/v2/companyLab/competitorNews";
import { AREA_TONES } from "../panelStyles";

const CONFIDENCE_LABEL: Readonly<Record<CompetitorNewsConfidence, string>> = {
  confirmed: "確報",
  rumored: "観測・噂",
};

const CONFIDENCE_BADGE_CLASS: Readonly<Record<CompetitorNewsConfidence, string>> = {
  confirmed: "bg-slate-700 text-slate-200",
  rumored: "bg-amber-900/70 text-amber-200",
};

export function CompetitorNewsFeed({ news, turn }: { readonly news: readonly CompetitorNewsItem[]; readonly turn: number }) {
  const tone = AREA_TONES.info;

  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="decision-studio-competitor-news">
      <div className="mb-2 flex items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>競合動向（Turn {turn}）</span>
      </div>

      {news.length === 0 ? (
        <p className="text-xs text-gray-400">前四半期に目立った競合の動きはありません。</p>
      ) : (
        <ul className="space-y-1.5">
          {news.map((item) => (
            <li
              key={item.newsId}
              className="rounded-lg border border-gray-700 bg-gray-900/50 p-2.5"
              data-testid={`competitor-news-item-${item.newsId}`}
            >
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${CONFIDENCE_BADGE_CLASS[item.confidence]}`}>
                  {CONFIDENCE_LABEL[item.confidence]}
                </span>
                <span className="text-sm font-semibold text-gray-100">{item.headline}</span>
              </div>
              <p className="text-[11px] leading-snug text-gray-300">{item.body}</p>
              {item.tags.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {item.tags.map((tag) => (
                    <span key={tag} className="rounded bg-gray-800 px-1 py-0.5 text-[10px] text-gray-400">
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[11px] leading-snug text-gray-500">
        「確報」は前四半期の確定結果にもとづく事実です。「観測・噂」は業界で流れている話で、裏付けが取れていません。
        そのまま信じず、次の四半期の実績と照らして判断してください。
      </p>
    </div>
  );
}
