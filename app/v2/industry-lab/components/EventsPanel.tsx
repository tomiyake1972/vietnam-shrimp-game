// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） イベントパネル
//
// このテスト環境は開発者・GM専用であるため（プレイヤー向け画面ではない）、
// ここではシナリオ内部の真実（hiddenDescription・実際の効果）をそのまま表示する。
// 実装指示 §7「シナリオの真実と公開情報を視覚的に区別」に対応するため、
// 公開情報パネル（InformationPanel、青系）とは配色を変え、「内部の真実」で
// あることが一目でわかるようにする。

import { ActiveScenarioEvent, IndustryQuarterRecord } from "../../../lib/v2/industryLab";
import { scenarioEventTypeLabel, scenarioEventPhaseLabel, MARKET_PRICE_DRIVER_LABELS } from "../../../lib/v2/industryLab";
import { COUNTRY_NAMES, DEMAND_MARKET_NAMES } from "./chartColors";

interface EventsPanelProps {
  readonly quarter: IndustryQuarterRecord | undefined;
}

const PHASE_BADGE_COLOR: Record<ActiveScenarioEvent["phase"], string> = {
  beforeStart: "bg-gray-700 text-gray-300",
  rampUp: "bg-yellow-800/60 text-yellow-200",
  active: "bg-red-800/60 text-red-200",
  recovering: "bg-orange-800/60 text-orange-200",
  ended: "bg-gray-800 text-gray-500",
};

export default function EventsPanel({ quarter }: EventsPanelProps) {
  const events = quarter?.activeEvents ?? [];

  return (
    <div className="bg-purple-950/30 border border-purple-800/40 rounded-2xl p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-purple-200 mb-1">
        イベント（内部の真実 — GM専用ビュー。公開情報パネルとは別物です）
      </h3>
      <p className="text-xs text-purple-300/70 mb-3">
        シナリオに定義された全イベントの、この四半期時点での状態を表示します（開始前・終了後も含む）。
      </p>
      {events.length === 0 ? (
        <p className="text-sm text-gray-500">シミュレーションを開始してください。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm text-left border-collapse min-w-[720px]">
            <thead>
              <tr className="text-purple-300/80 border-b border-purple-800/40">
                <th className="py-1.5 pr-3">イベント</th>
                <th className="py-1.5 pr-3">対象</th>
                <th className="py-1.5 pr-3">開始ターン</th>
                <th className="py-1.5 pr-3">段階</th>
                <th className="py-1.5 pr-3">現在の効果</th>
                <th className="py-1.5 pr-3">GM向け内部説明</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.eventId} className="border-b border-purple-900/30 align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{scenarioEventTypeLabel(e.eventType)}</td>
                  <td className="py-1.5 pr-3">
                    {[
                      ...e.targetCountries.map((c) => COUNTRY_NAMES[c]),
                      ...e.targetMarkets.map((m) => DEMAND_MARKET_NAMES[m]),
                    ].join("・") || "（全体）"}
                  </td>
                  <td className="py-1.5 pr-3">turn {e.resolvedStartTurn}</td>
                  <td className="py-1.5 pr-3">
                    <span className={`px-2 py-0.5 rounded ${PHASE_BADGE_COLOR[e.phase]}`}>
                      {scenarioEventPhaseLabel(e.phase)}
                    </span>
                    <span className="text-gray-400 ml-1">{Math.round(e.intensity * 100)}%</span>
                  </td>
                  <td className="py-1.5 pr-3 space-y-0.5">
                    {e.effects.map((eff, i) => (
                      <div key={i} className="text-gray-300">
                        {eff.variable}: {eff.mode === "multiplicative" ? `×${eff.magnitude}` : `${eff.magnitude > 0 ? "+" : ""}${eff.magnitude}pt`}
                      </div>
                    ))}
                  </td>
                  <td className="py-1.5 pr-3 text-gray-400 max-w-xs">{e.hiddenDescription}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[10px] text-purple-400/60 mt-2">
        参考: 理由コード（MarketPriceDriver）の日本語対応は{Object.keys(MARKET_PRICE_DRIVER_LABELS).length}種類すべてに定義済み（価格変動理由パネル参照）。
      </p>
    </div>
  );
}
