// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） 公開情報パネル
//
// 選択した情報レベルに応じて、プレイヤー（またはGM）が実際に見える情報だけを
// 表示する。IndustryQuarterRecordはpublic/standard/advanced/gmを事前計算済み
// なので、選択レベル以外の情報がここに混入することはない（実装指示 §7
// 「public表示中にadvanced/gm/postGame情報が漏れないように」）。
// イベントパネル（内部の真実、紫系）とは配色を変え、「公開情報」であることを
// 視覚的に区別する。

import { IndustryQuarterRecord, DisplayInformationLevel } from "../../../lib/v2/industryLab";
import { selectInformationForLevel, displayInformationLevelLabel } from "../../../lib/v2/industryLab";

interface InformationPanelProps {
  readonly quarter: IndustryQuarterRecord | undefined;
  readonly level: DisplayInformationLevel;
  readonly onChangeLevel: (level: DisplayInformationLevel) => void;
}

const LEVELS: readonly DisplayInformationLevel[] = ["public", "standard", "advanced", "gm"];

export default function InformationPanel({ quarter, level, onChangeLevel }: InformationPanelProps) {
  const releases = quarter ? selectInformationForLevel(quarter, level) : [];

  return (
    <div className="bg-sky-950/30 border border-sky-800/40 rounded-2xl p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-sky-200">公開情報（この情報レベルで実際に見える情報のみ）</h3>
        <div className="flex gap-1">
          {LEVELS.map((lv) => (
            <button
              key={lv}
              onClick={() => onChangeLevel(lv)}
              className={`px-2.5 py-1 rounded text-xs font-semibold ${
                lv === level ? "bg-sky-600 text-white" : "bg-sky-900/40 text-sky-300 hover:bg-sky-900/70"
              }`}
            >
              {lv}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-sky-300/70 mb-3">現在の表示レベル: {displayInformationLevelLabel(level)}</p>

      {!quarter ? (
        <p className="text-sm text-gray-500">シミュレーションを開始してください。</p>
      ) : releases.length === 0 ? (
        <p className="text-sm text-gray-500">この四半期・このレベルで公開されている情報はありません。</p>
      ) : (
        <ul className="space-y-2">
          {releases.map((r) => (
            <li key={r.informationId} className="bg-sky-900/20 rounded-lg p-3 text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sky-100">{r.headlineTemplate}</span>
                {r.isRumor && (
                  <span className="text-[10px] bg-yellow-800/60 text-yellow-200 px-1.5 py-0.5 rounded">噂</span>
                )}
                {r.revisionOf && (
                  <span className="text-[10px] bg-blue-800/60 text-blue-200 px-1.5 py-0.5 rounded">
                    訂正情報（{r.revisionOf}を更新）
                  </span>
                )}
                {r.confidence !== undefined && (
                  <span className="text-[10px] text-sky-300/70">信頼度 {Math.round(r.confidence * 100)}%</span>
                )}
              </div>
              {r.structuredFacts.length > 0 && (
                <ul className="mt-1.5 text-xs text-sky-200/80 space-y-0.5">
                  {r.structuredFacts.map((f, i) => (
                    <li key={i}>
                      {f.label}: {f.value}
                      {f.unit ? ` ${f.unit}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {r.estimateRange && (
                <p className="mt-1 text-xs text-sky-300/70">
                  推定範囲: {r.estimateRange.low} 〜 {r.estimateRange.high}
                  {r.estimateRange.unit ? ` ${r.estimateRange.unit}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
