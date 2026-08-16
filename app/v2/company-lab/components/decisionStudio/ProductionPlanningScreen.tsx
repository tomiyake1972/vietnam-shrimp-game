// ShrimpX V2 — Decision Studio: PRODUCTION（工場×商品の生産計画・処理能力・入力に対する警告）
//
// 旧DecisionEditor.tsxの「現在の入力に対する警告」「凍結・包装処理能力（フロー）と
// 冷凍・冷蔵保管能力（ストック）」「工場の加工能力（現時点・現在追加中）」
// 「生産計画（工場×商品）」の4 CollapsibleSectionをそのまま移設。
// 新しいengine式は一切作らない（DecisionStudioViewModel経由の既存VM出力を
// そのまま表示するだけ）。

import { CompanyDecisionDraft } from "../../decisionDraft";
import { formatHosoEqTons } from "../../../../lib/v2/industryLab/ui/formatters";
import { CapacityPoolKey } from "../../processingCapacityViewModel";
import { DecisionStudioViewModel } from "../../decisionStudioViewModel";
import CapacityEffectiveRatePanel from "../CapacityEffectiveRatePanel";
import ProcessingForecastPanel from "../ProcessingForecastPanel";
import ProcessingCapacityPanel from "../ProcessingCapacityPanel";
import ColdStoragePanel from "../ColdStoragePanel";
import PlanningWarningsPanel from "../PlanningWarningsPanel";
import CollapsibleSection from "../CollapsibleSection";
import { NumberCell } from "../InputCells";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, INFO_VALUE_CLASS, NO_VALUE_TEXT } from "../panelStyles";

interface ProductionPlanningScreenProps {
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  readonly vm: DecisionStudioViewModel;
}

export default function ProductionPlanningScreen({ draft, onChange, disabled, vm }: ProductionPlanningScreenProps) {
  const { planning, capacityViewModel, processingForecast, freezingPackagingPool, plannedFreezingProcessingTons, coldStorageInvestmentUsdPerTon, pendingCapacityTotalTons, rawMaterialInventory, outstandingBacklog } = vm;

  const currentCapacityTons = (factoryId: string, pool: CapacityPoolKey): number | undefined => {
    const factory = capacityViewModel.factories.find((f) => f.factoryId === factoryId);
    return factory?.pools.find((p) => p.poolKey === pool)?.currentNominalTons;
  };

  return (
    <div className="space-y-3" data-testid="decision-studio-production-screen">
      <div className="rounded-lg bg-gray-900/60 border border-gray-700/60 px-3 py-2 text-xs text-gray-400">
        参考情報: 原料在庫（利用可能） {formatHosoEqTons(rawMaterialInventory)} / 未履行契約残高 {formatHosoEqTons(outstandingBacklog)} / 販売希望量・原料利用可否はSALES・PROCUREMENTタブ参照
      </div>

      {/* 【Phase 8D】現在の入力に対する警告 */}
      <CollapsibleSection
        title="現在の入力に対する警告"
        tone="info"
        testId="planning-warnings-section"
        summaryRight={planning.warnings.length > 0 ? `${planning.warnings.length}件` : "なし"}
      >
        <PlanningWarningsPanel warnings={planning.warnings} />
        <details className="mt-2">
          <summary className="text-[11px] text-teal-400 hover:text-teal-300 cursor-pointer">
            生産計画 → 必要能力 → 必要Worker → 必要スペース → 不足 → 投資 のつながり
          </summary>
          <ol className="mt-1 space-y-0.5">
            {planning.chainExplanationSteps.map((s, i) => (
              <li key={i} className="text-[11px] text-gray-400">
                {s}
              </li>
            ))}
          </ol>
        </details>
      </CollapsibleSection>

      {/* 【Phase 8D-5】凍結・包装処理能力（フロー）と冷凍・冷蔵保管能力（ストック） */}
      <CollapsibleSection
        title="凍結・包装処理能力（フロー）と冷凍・冷蔵保管能力（ストック）"
        tone="info"
        testId="cold-storage-section"
        summaryRight={planning.coldStorage.utilizationRate !== undefined ? `保管使用率 ${(planning.coldStorage.utilizationRate * 100).toFixed(1)}%` : undefined}
      >
        <ColdStoragePanel
          state={planning.coldStorage}
          freezingPackagingPool={freezingPackagingPool}
          plannedProcessingTons={plannedFreezingProcessingTons}
          investmentUsdPerStorageTon={coldStorageInvestmentUsdPerTon}
          explanationText={planning.freezingVsStorageExplanation}
        />
      </CollapsibleSection>

      {/* 工場加工能力（現時点＋現在追加中） */}
      <CollapsibleSection
        title="工場の加工能力（現時点・現在追加中）"
        tone="info"
        testId="processing-capacity-section"
        summaryRight={pendingCapacityTotalTons > 0 ? `現在追加中 合計 +${formatHosoEqTons(pendingCapacityTotalTons)} t/四半期` : "現在追加中の能力なし"}
      >
        <ProcessingCapacityPanel viewModel={capacityViewModel} />
        <div className="mt-4 space-y-4">
          <CapacityEffectiveRatePanel table={processingForecast.companyRateTable} title="名目能力 → 実効能力の計算（会社合計・トン/四半期）" />
          {processingForecast.factoryRateTables.length > 1 &&
            processingForecast.factoryRateTables.map((table) => (
              <CapacityEffectiveRatePanel key={table.factoryId ?? "company"} table={table} title={`名目能力 → 実効能力の計算（${table.factoryId}）`} />
            ))}
        </div>
      </CollapsibleSection>

      {/* 生産計画 */}
      <CollapsibleSection
        title="生産計画（工場×商品）"
        tone="input"
        testId="production-plan-section"
        description="「商品別能力」は、稼働開始済みの設備投資による増加ぶんを含んだ現時点の名目能力です（工場の加工能力セクションの内訳と同じ値）。"
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className={INFO_TABLE_HEAD_CLASS}>
                <th className="pr-3 py-1">工場</th>
                <th className="pr-3 py-1">商品</th>
                <th className="pr-3 py-1">商品別能力(t)</th>
                <th className="pr-3 py-1">生産希望量(t)</th>
                <th className="pr-3 py-1">優先度(小=優先)</th>
              </tr>
            </thead>
            <tbody>
              {draft.productionPlans.map((row, idx) => {
                const capacityNum = currentCapacityTons(row.factoryId, row.product as CapacityPoolKey);
                return (
                  <tr key={`${row.factoryId}-${row.product}`} className={INFO_TABLE_ROW_CLASS}>
                    <td className="pr-3 py-1">{row.factoryId}</td>
                    <td className="pr-3 py-1 uppercase">{row.product}</td>
                    <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{capacityNum !== undefined ? formatHosoEqTons(capacityNum) : NO_VALUE_TEXT}</td>
                    <td className="pr-3 py-1">
                      <NumberCell
                        value={row.desiredQuantity}
                        disabled={disabled}
                        warn={capacityNum !== undefined && row.desiredQuantity > capacityNum * 1.5}
                        onChange={(n) => {
                          const next = [...draft.productionPlans];
                          next[idx] = { ...row, desiredQuantity: n };
                          onChange({ ...draft, productionPlans: next });
                        }}
                      />
                    </td>
                    <td className="pr-3 py-1">
                      <NumberCell
                        value={row.priority}
                        disabled={disabled}
                        onChange={(n) => {
                          const next = [...draft.productionPlans];
                          next[idx] = { ...row, priority: Math.round(n) };
                          onChange({ ...draft, productionPlans: next });
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 bg-gray-900/50 border border-gray-700/60 rounded-lg px-3 py-2">
          <ProcessingForecastPanel forecast={processingForecast} />
        </div>
      </CollapsibleSection>
    </div>
  );
}
