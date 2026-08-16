// ShrimpX V2 — Procurement Planning（親component）
//
// 【Step 5】旧DecisionEditor.tsxの「国内原料買付・輸入・養殖」3入力セクションを、
// このcomponentへ完全に統合する。ここが唯一のProcurement Planning UIであり、
// DecisionEditor.tsx側は本componentを呼ぶだけにする。
//
// 【計算しない】既存のview-model層（procurementRequirementViewModel.ts /
// rawMaterialTimelineViewModel.ts / procurementPricingViewModel.ts /
// procurementCapacityViewModel.ts / procurementCashViewModel.ts /
// plannedProcurementViewModel.ts）が返した値をそのまま子componentへ渡すだけで、
// このファイル自体は新しい計算式・新しい判定ロジックを一切持たない
// （draft入力を既存のbuildDecisionInputFromDraftへ通し、既存のpure functionを
// 既存の引数で呼ぶだけ）。
//
// 【AI Meeting将来対応】このcomponentは固定viewport幅・大きな絶対配置に依存しない
// （max-widthやgrid-cols-*はすべてTailwindの相対クラス）。AIチャット・プロンプト・
// 会議コンテキストに関するstate/ロジックはここには一切持たない
// （将来のAuxiliaryPanel/DecisionStudioShellの追加を妨げないため）。

import { PeriodV2 } from "../../../../lib/v2/core/period";
import { unwrapUnit, UsdPerHosoEqKg } from "../../../../lib/v2/core/units";
import { COUNTRY_IDS, CountryId } from "../../../../lib/v2/market/types";
import { CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../../../../lib/v2/companyLab";
import { calculateExpectedProduction } from "../../../../lib/v2/rawMaterials/aquaculture";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../../../../lib/v2/rawMaterials/parameters";
import { buildDecisionInputFromDraft, CompanyDecisionDraft } from "../../decisionDraft";
import { buildProcurementRequirementViewModel, ProductionPlanQuantityRow } from "../../procurementRequirementViewModel";
import { buildRawMaterialTimeline } from "../../rawMaterialTimelineViewModel";
import {
  buildAquaculturePricingViewModel,
  buildDomesticPricingViewModel,
  buildImportPricingRows,
  buildRawMaterialCostSummary,
  RawMaterialCostSummaryLotLike,
  toCostSummaryLotLike,
} from "../../procurementPricingViewModel";
import { buildProcurementCapacityViewModel } from "../../procurementCapacityViewModel";
import { buildProcurementCashViewModel } from "../../procurementCashViewModel";
import { buildPlannedProcurementSummary, PlannedImportOrderInput } from "../../plannedProcurementViewModel";
import ProductionLinkageHeader from "./ProductionLinkageHeader";
import RawMaterialTimelineTable from "./RawMaterialTimeline";
import DomesticProcurementSection from "./DomesticProcurementSection";
import ImportProcurementSection from "./ImportProcurementSection";
import AquacultureSection from "./AquacultureSection";
import ProcurementAutoCalcPanel from "./ProcurementAutoCalcPanel";
import PreFinancingLiquidityPanel from "./PreFinancingLiquidityPanel";
import { AREA_TONES } from "../panelStyles";

interface ProcurementPlanningSectionProps {
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  readonly period: PeriodV2;
  /** 省略時（例: turn1でまだ公開市場情報が無い画面）は各auto-calc表示が「－」になる。 */
  readonly publicInfo?: PublicMarketInfo;
  readonly turn?: number;
}

export default function ProcurementPlanningSection({ fixture, ownState, draft, onChange, disabled, period, publicInfo, turn }: ProcurementPlanningSectionProps) {
  const tone = AREA_TONES.input;

  // decisionInputForForecastは「提出時に実際にエンジンへ渡るのと同じ形」（draftの生値ではない）。
  const decisionInputForForecast = buildDecisionInputFromDraft(draft, fixture, period);

  // --- 1. Production & Raw Requirement ---
  const procurementProductionRows: readonly ProductionPlanQuantityRow[] = decisionInputForForecast.productionPlans.map((p) => ({
    product: p.product,
    desiredQuantity: unwrapUnit(p.desiredQuantity),
  }));
  const procurementRequirement = buildProcurementRequirementViewModel({
    productionPlanRows: procurementProductionRows,
    rawMaterialLots: ownState.rawMaterialLots,
    companyId: fixture.companyId,
    currentPeriod: period,
  });

  // --- 2. Raw Material Timeline（Confirmed/Expected層 + Planned層） ---
  const rawMaterialTimeline = buildRawMaterialTimeline(ownState.rawMaterialLots, fixture.companyId, period);

  const standardLeadTimeTurns = RAW_MATERIALS_PARAMETERS_V1.imports.standardLeadTimeTurns;
  const aquacultureEntry = decisionInputForForecast.aquacultureStockingPlans[0];
  const aquacultureExpectedProductionTons = aquacultureEntry ? unwrapUnit(calculateExpectedProduction(aquacultureEntry, RAW_MATERIALS_PARAMETERS_V1)) : undefined;
  const plannedImportOrderInputs: readonly PlannedImportOrderInput[] = decisionInputForForecast.importOrders.map((o) => ({
    originCountry: o.originCountry,
    orderedQuantityTons: unwrapUnit(o.orderedQuantity),
    leadTimeTurns: o.leadTimeTurns,
  }));
  const plannedSummary = buildPlannedProcurementSummary(
    unwrapUnit(decisionInputForForecast.domesticPurchasePlan.desiredQuantity),
    plannedImportOrderInputs,
    aquacultureExpectedProductionTons,
    period,
    standardLeadTimeTurns
  );

  // --- 3. Domestic Procurement（価格・能力/意向） ---
  // 国内Reference Priceはturn2以降のみ公開情報から取得できる（turn1はvietnamDomesticPriorPrice=0）。
  const domesticReferencePriceUsdPerHosoEqKg =
    publicInfo !== undefined && publicInfo.vietnamDomesticPriorPrice > 0 ? publicInfo.vietnamDomesticPriorPrice : undefined;
  const procurementDomesticPricing =
    domesticReferencePriceUsdPerHosoEqKg !== undefined
      ? buildDomesticPricingViewModel(domesticReferencePriceUsdPerHosoEqKg, draft.domesticPurchase.priceAdjustmentUsdPerHosoEqKg)
      : null;

  const domesticReferenceSupplyTons = publicInfo?.lastMarketResult?.vietnamDomestic.supply;
  const procurementCapacity = buildProcurementCapacityViewModel({
    companyId: fixture.companyId,
    desiredQuantityTons: unwrapUnit(decisionInputForForecast.domesticPurchasePlan.desiredQuantity),
    procurementHeadcount: decisionInputForForecast.domesticPurchasePlan.procurementHeadcount,
    factoryCommonProcessingCapacityTons: decisionInputForForecast.domesticPurchasePlan.factoryCommonProcessingCapacityTons,
    referenceSupplyTons: domesticReferenceSupplyTons ?? 0,
  });
  const procurementReferenceSupplyKnown = domesticReferenceSupplyTons !== undefined;

  // --- 4. Import Procurement（原産国別価格） ---
  // 輸入原産国別価格は前四半期の確定市場結果からのみ取得できる（turn1は未確定）。
  const lastHosoPricesByCountry = publicInfo?.lastMarketResult?.hosoPrices;
  const originFobPriceByCountry: Record<CountryId, UsdPerHosoEqKg> | null = lastHosoPricesByCountry
    ? COUNTRY_IDS.reduce(
        (acc, c) => {
          acc[c] = lastHosoPricesByCountry[c].price;
          return acc;
        },
        {} as Record<CountryId, UsdPerHosoEqKg>
      )
    : null;
  const procurementImportPricingRows = originFobPriceByCountry ? buildImportPricingRows(COUNTRY_IDS, originFobPriceByCountry) : [];

  // --- 5. Aquaculture（単価） ---
  const procurementAquaculturePricing = buildAquaculturePricingViewModel();

  // --- 6. Auto Calculated Impact（手持ち在庫の加重平均原料単価） ---
  const costSummaryLots: RawMaterialCostSummaryLotLike[] = ownState.rawMaterialLots
    .filter((l) => l.companyId === fixture.companyId)
    .map(toCostSummaryLotLike)
    .filter((l): l is RawMaterialCostSummaryLotLike => l !== null);
  const rawMaterialCostSummary = buildRawMaterialCostSummary(costSummaryLots);

  // --- 7. Pre-Financing Liquidity Constraint ---
  // Pre-Financing Liquidity（P5）はStandardAiObservationの構築にturn・publicInfoを要する。
  const procurementCash =
    publicInfo !== undefined && turn !== undefined
      ? buildProcurementCashViewModel({
          fixture,
          ownState,
          publicInfo,
          period,
          turn,
          domesticDesiredQuantityTons: unwrapUnit(decisionInputForForecast.domesticPurchasePlan.desiredQuantity),
          importOrderedQuantityTons: decisionInputForForecast.importOrders.reduce((sum, o) => sum + unwrapUnit(o.orderedQuantity), 0),
        })
      : null;

  return (
    <div className={`rounded-xl p-3 space-y-3 ${tone.section}`} data-testid="procurement-planning-section">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <h2 className={`text-base font-bold ${tone.heading}`}>PROCUREMENT PLANNING</h2>
        {disabled ? (
          <span className="text-[11px] rounded px-1.5 py-0.5 bg-gray-800 text-gray-400 border border-gray-600/70" data-testid="procurement-planning-status-badge">
            この四半期はすでに進行済みです。編集内容は次の四半期に反映されます。
          </span>
        ) : (
          <span className="text-[11px] rounded px-1.5 py-0.5 bg-sky-900/70 text-sky-200 border border-sky-700/70" data-testid="procurement-planning-status-badge">
            EDITABLE / DRAFT・未提出
          </span>
        )}
      </div>

      {/* 1. Production & Raw Requirement */}
      <ProductionLinkageHeader vm={procurementRequirement} />

      {/* 2. Raw Material Timeline（Confirmed/Expected + Planned） */}
      <RawMaterialTimelineTable timeline={rawMaterialTimeline} plannedRows={plannedSummary.rows} />

      {/* 3. Domestic Procurement */}
      <DomesticProcurementSection
        draft={draft}
        onChange={onChange}
        disabled={disabled}
        pricing={procurementDomesticPricing}
        capacity={procurementCapacity}
        referenceSupplyKnown={procurementReferenceSupplyKnown}
      />

      {/* 4. Import Procurement */}
      <ImportProcurementSection
        draft={draft}
        onChange={onChange}
        disabled={disabled}
        pricingRows={procurementImportPricingRows}
        period={period}
        standardLeadTimeTurns={standardLeadTimeTurns}
      />

      {/* 5. Aquaculture */}
      <AquacultureSection
        draft={draft}
        onChange={onChange}
        disabled={disabled}
        aquacultureCapacityTons={fixture.aquacultureCapacity}
        expectedProductionTons={aquacultureExpectedProductionTons}
        unitCostUsdPerHosoEqKg={procurementAquaculturePricing.unitCostUsdPerHosoEqKg}
      />

      {/* 6. Auto Calculated Impact */}
      <ProcurementAutoCalcPanel plannedSummary={plannedSummary} costSummary={rawMaterialCostSummary} />

      {/* 7. Pre-Financing Liquidity Constraint */}
      <PreFinancingLiquidityPanel
        cash={procurementCash}
        effectivePurchaseIntentTons={procurementReferenceSupplyKnown ? procurementCapacity.effectivePurchaseIntentTons : null}
      />
    </div>
  );
}
