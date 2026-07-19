// ShrimpX V2 — 会社経営統合テスト環境 品質ダッシュボード（Phase 7B） D. 成約競争力の説明
//
// dashboardViewModel.buildCompetitivenessExplanationRowsが抽出したPhase 4/6.3/7A
// の実績値（sales/allocation.tsのcomputeCompetitivenessBreakdownが既に算出した
// 内訳）を、dashboardExplanation.tsの固定ルールで日本語文へ組み立てて表示する
// だけ。成約競争力・配分量の計算式はここでは一切再計算しない。

import { CompetitivenessExplanationRow } from "../dashboardViewModel";
import { buildCompetitivenessExplanationText, buildWeightTrendNote } from "../dashboardExplanation";
import { formatHosoEqTons, formatUsdPerHosoEqKg } from "../../../lib/v2/industryLab/ui/formatters";
import { DEMAND_MARKET_NAMES } from "../../industry-lab/components/chartColors";

interface QualityCompetitivenessExplanationProps {
  readonly rows: readonly CompetitivenessExplanationRow[];
}

const PRODUCT_LABELS: Record<string, string> = { hoso: "HOSO", pd: "PD", vap: "VAP" };

function ContributionBar(props: { readonly label: string; readonly value: number; readonly max: number }) {
  const { label, value, max } = props;
  const pct = max > 1e-9 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 text-[10px] text-gray-500 shrink-0">{label}</span>
      <div className="flex-1 bg-gray-900/60 rounded h-2 overflow-hidden">
        <div className="h-2 bg-teal-500/80" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-14 text-[10px] text-gray-400 text-right shrink-0">{value.toFixed(3)}</span>
    </div>
  );
}

export default function QualityCompetitivenessExplanation(props: QualityCompetitivenessExplanationProps) {
  const { rows } = props;

  if (rows.length === 0) {
    return (
      <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 text-sm text-gray-400">当期はこの会社の販売計画がありません。</div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-4">
      <h3 className="text-base font-semibold text-gray-100">成約競争力の説明</h3>
      <p className="text-[11px] text-gray-500">
        競争力ウェイトの内訳（価格・カバレッジ・顧客関係・品質・納期信頼性の5要素）は、成約配分計算（sales/allocation.ts）が実際に使った値をそのまま表示しています。UI側での再計算は行っていません。
      </p>

      {rows.map((r) => {
        const maxContribution = Math.max(r.priceContribution, r.coverageContribution, r.relationshipContribution, r.qualityContribution, r.deliveryReliabilityContribution, 1e-6);
        return (
          <div key={`${r.market}-${r.product}`} className="bg-gray-900/40 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="text-sm font-semibold text-gray-100">
                {DEMAND_MARKET_NAMES[r.market]}（{r.market}） / {PRODUCT_LABELS[r.product] ?? r.product}
              </div>
              <div className="text-xs text-gray-400">
                提示価格 {formatUsdPerHosoEqKg(r.askPrice)}（基準 {formatUsdPerHosoEqKg(r.basePrice)}） / 成約 {formatHosoEqTons(r.allocatedQuantity)} / 希望 {formatHosoEqTons(r.desiredQuantity)}
              </div>
            </div>

            <p className="text-xs text-gray-200">
              {buildCompetitivenessExplanationText(r)} {buildWeightTrendNote(r)}
            </p>

            <div className="space-y-1">
              <ContributionBar label="価格" value={r.priceContribution} max={maxContribution} />
              <ContributionBar label="営業カバレッジ" value={r.coverageContribution} max={maxContribution} />
              <ContributionBar label="顧客関係" value={r.relationshipContribution} max={maxContribution} />
              <ContributionBar label="品質評価" value={r.qualityContribution} max={maxContribution} />
              <ContributionBar label="納期信頼性" value={r.deliveryReliabilityContribution} max={maxContribution} />
            </div>

            <div className="text-[10px] text-gray-500">
              合成競争力ウェイト: {r.competitivenessWeight.toFixed(4)}
              {r.previousCompetitivenessWeight !== undefined ? `（前期 ${r.previousCompetitivenessWeight.toFixed(4)}）` : ""}
              {r.isPriceScoreAtCeiling && <span className="ml-2 text-amber-400">価格競争力は上限到達済み</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
