// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） サマリーパネル

import { COUNTRY_IDS } from "../../../lib/v2/market/types";
import { ScenarioMode } from "../../../lib/v2/scenario/types";
import { IndustryQuarterRecord } from "../../../lib/v2/industryLab";
import { formatHosoEqTons, formatUsdPerHosoEqKg, formatSupplyDemandBalance, scenarioEventTypeLabel, scenarioEventPhaseLabel } from "../../../lib/v2/industryLab";
import { selectCurrentlyActiveEvents } from "../../../lib/v2/industryLab";
import { COUNTRY_NAMES } from "./chartColors";

interface SummaryPanelProps {
  readonly scenarioTitle: string;
  readonly mode: ScenarioMode;
  readonly seed: string;
  readonly currentTurn: number;
  readonly totalTurns: number;
  readonly quarter: IndustryQuarterRecord | undefined;
}

export default function SummaryPanel({ scenarioTitle, mode, seed, currentTurn, totalTurns, quarter }: SummaryPanelProps) {
  const activeEvents = quarter ? selectCurrentlyActiveEvents(quarter) : [];

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-sm">
        <Stat label="シナリオ" value={scenarioTitle} />
        <Stat label="モード" value={mode === "canonical" ? "Canonical" : "Variation"} />
        <Stat label="シード" value={seed} mono />
        <Stat label="ターン" value={`${currentTurn} / ${totalTurns}`} />
        <Stat label="期間" value={quarter?.periodLabel ?? "—"} />
        <Stat
          label="需給ギャップ"
          value={quarter ? formatSupplyDemandBalance(quarter.marketResult.worldSupplyDemandBalance) : "—"}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        <Stat label="世界総供給" value={quarter ? formatHosoEqTons(quarter.marketResult.worldSupply) : "—"} />
        <Stat label="世界総需要" value={quarter ? formatHosoEqTons(quarter.marketResult.worldDemand) : "—"} />
        <Stat
          label="ベトナム国内原料価格"
          value={quarter ? formatUsdPerHosoEqKg(quarter.marketResult.vietnamDomestic.price) : "—"}
        />
      </div>

      <div>
        <div className="text-xs text-gray-400 mb-1">
          現在の国際HOSO価格（国別。既存結果型に統一基準価格が無いため国別に表示）
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          {COUNTRY_IDS.map((c) => (
            <span key={c} className="bg-gray-700/60 rounded-lg px-3 py-1.5">
              {COUNTRY_NAMES[c]}: {quarter ? formatUsdPerHosoEqKg(quarter.marketResult.hosoPrices[c].price) : "—"}
            </span>
          ))}
        </div>
      </div>

      <div>
        <div className="text-xs text-gray-400 mb-1">現在発生中の主要イベント</div>
        {activeEvents.length === 0 ? (
          <p className="text-sm text-gray-500">なし</p>
        ) : (
          <ul className="flex flex-wrap gap-2 text-sm">
            {activeEvents.map((e) => (
              <li key={e.eventId} className="bg-purple-900/40 border border-purple-700/40 rounded-lg px-3 py-1.5">
                {scenarioEventTypeLabel(e.eventType)}（{scenarioEventPhaseLabel(e.phase)}・強度{Math.round(e.intensity * 100)}%）
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-gray-900/50 rounded-lg px-3 py-2">
      <div className="text-[11px] text-gray-400">{label}</div>
      <div className={`text-gray-100 font-semibold truncate ${mono ? "font-mono text-xs" : ""}`}>{value}</div>
    </div>
  );
}
