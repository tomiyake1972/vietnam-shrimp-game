// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） シナリオ比較パネル
//
// 同じシード・同じモード・同じターン数で実行した2つのシナリオの差分を表示する。
// 差分計算はすべて app/lib/v2/industryLab/ui/comparison.ts（純粋関数）が行い、
// ここでは結果を並べて表示するだけ（実装指示 §9「価格計算をUI内で再実装しない」）。

import { COUNTRY_IDS } from "../../../lib/v2/market/types";
import { ScenarioComparisonResult } from "../../../lib/v2/industryLab";
import { formatSignedUsdPerHosoEqKg, formatSignedHosoEqTons, scenarioEventTypeLabel } from "../../../lib/v2/industryLab";
import { COUNTRY_NAMES } from "./chartColors";
import LineChart, { LineChartSeries } from "./LineChart";

export interface ComparisonScenarioOption {
  readonly scenarioId: string;
  readonly title: string;
}

interface ComparisonPanelProps {
  readonly scenarioOptions: readonly ComparisonScenarioOption[];
  readonly baseScenarioTitle: string;
  readonly comparisonScenarioId: string | null;
  readonly onChangeComparisonScenarioId: (id: string | null) => void;
  readonly comparison: ScenarioComparisonResult | null;
  readonly comparisonScenarioTitle: string | null;
  readonly disabledReason: string | null;
}

export default function ComparisonPanel(props: ComparisonPanelProps) {
  const {
    scenarioOptions,
    baseScenarioTitle,
    comparisonScenarioId,
    onChangeComparisonScenarioId,
    comparison,
    comparisonScenarioTitle,
    disabledReason,
  } = props;

  const priceDiffSeries: readonly LineChartSeries[] = comparison
    ? COUNTRY_IDS.map((c, i) => ({
        key: c,
        label: COUNTRY_NAMES[c],
        color: ["#f59e0b", "#10b981", "#6366f1", "#ef4444"][i],
        values: comparison.quarters.map((q) => q.hosoPriceDiff[c]),
      }))
    : [];

  const supplyDemandDiffSeries: readonly LineChartSeries[] = comparison
    ? [
        { key: "supply", label: "世界供給差 (B-A)", color: "#3b82f6", values: comparison.quarters.map((q) => q.worldSupplyDiff) },
        { key: "demand", label: "世界需要差 (B-A)", color: "#a855f7", values: comparison.quarters.map((q) => q.worldDemandDiff) },
      ]
    : [];

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-4">
      <h2 className="text-base font-semibold text-gray-100">シナリオ比較</h2>
      <p className="text-xs text-gray-400">
        基準シナリオ「{baseScenarioTitle}」に対し、同じモード・シード・ターン数で別シナリオを実行して比較します（B − A）。
      </p>

      <label className="flex flex-col gap-1 text-xs text-gray-400 max-w-xs">
        比較対象シナリオ
        <select
          value={comparisonScenarioId ?? ""}
          onChange={(e) => onChangeComparisonScenarioId(e.target.value || null)}
          className="bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
        >
          <option value="">比較しない</option>
          {scenarioOptions.map((opt) => (
            <option key={opt.scenarioId} value={opt.scenarioId}>
              {opt.title}
            </option>
          ))}
        </select>
      </label>

      {disabledReason && <p className="text-sm text-amber-300">{disabledReason}</p>}

      {comparison && comparisonScenarioTitle && (
        <div className="space-y-4">
          <p className="text-xs text-gray-400">
            A = {baseScenarioTitle} ／ B = {comparisonScenarioTitle}（{comparison.quarters.length}四半期分）
          </p>

          <LineChart title="HOSO価格差（国別、B − A）" xLabels={comparison.quarters.map((q) => q.periodLabelA)} series={priceDiffSeries} unit="USD/kg" />
          <LineChart
            title="世界供給・需要差（B − A）"
            xLabels={comparison.quarters.map((q) => q.periodLabelA)}
            series={supplyDemandDiffSeries}
            unit="トン"
          />

          <div className="overflow-x-auto">
            <table className="w-full text-xs sm:text-sm text-left border-collapse min-w-[720px]">
              <thead>
                <tr className="text-gray-400 border-b border-gray-700">
                  <th className="py-1.5 pr-3">ターン</th>
                  <th className="py-1.5 pr-3">HOSO価格差(VN)</th>
                  <th className="py-1.5 pr-3">国内原料価格差</th>
                  <th className="py-1.5 pr-3">世界供給差</th>
                  <th className="py-1.5 pr-3">世界需要差</th>
                  <th className="py-1.5 pr-3">PDプレミアム差</th>
                  <th className="py-1.5 pr-3">VAPプレミアム差</th>
                </tr>
              </thead>
              <tbody>
                {comparison.quarters
                  .filter((_, i) => i % Math.max(1, Math.ceil(comparison.quarters.length / 8)) === 0)
                  .map((q) => (
                    <tr key={q.turn} className="border-b border-gray-700/50">
                      <td className="py-1.5 pr-3">{q.turn}</td>
                      <td className="py-1.5 pr-3">{formatSignedUsdPerHosoEqKg(q.hosoPriceDiff.VN)}</td>
                      <td className="py-1.5 pr-3">{formatSignedUsdPerHosoEqKg(q.vietnamDomesticPriceDiff)}</td>
                      <td className="py-1.5 pr-3">{formatSignedHosoEqTons(q.worldSupplyDiff)}</td>
                      <td className="py-1.5 pr-3">{formatSignedHosoEqTons(q.worldDemandDiff)}</td>
                      <td className="py-1.5 pr-3">{formatSignedUsdPerHosoEqKg(q.pdPremiumDiff)}</td>
                      <td className="py-1.5 pr-3">{formatSignedUsdPerHosoEqKg(q.vapPremiumDiff)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p className="text-[10px] text-gray-500 mt-1">表は間引いて表示しています（全{comparison.quarters.length}四半期のうち抜粋）。</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="bg-gray-900/50 rounded-lg p-3">
              <div className="text-gray-400 mb-1">Aのみに存在するイベント</div>
              {comparison.eventDiff.onlyInA.length === 0 ? (
                <p className="text-gray-500">なし</p>
              ) : (
                <ul className="space-y-0.5 text-gray-300">
                  {comparison.eventDiff.onlyInA.map((e) => (
                    <li key={e.eventId}>{scenarioEventTypeLabel(e.eventType)}（turn {e.resolvedStartTurn}〜）</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="bg-gray-900/50 rounded-lg p-3">
              <div className="text-gray-400 mb-1">Bのみに存在するイベント</div>
              {comparison.eventDiff.onlyInB.length === 0 ? (
                <p className="text-gray-500">なし</p>
              ) : (
                <ul className="space-y-0.5 text-gray-300">
                  {comparison.eventDiff.onlyInB.map((e) => (
                    <li key={e.eventId}>{scenarioEventTypeLabel(e.eventType)}（turn {e.resolvedStartTurn}〜）</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
