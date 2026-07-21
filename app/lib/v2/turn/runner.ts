// ShrimpX V2 — ターン・オーケストレーター 実行本体（Phase 5後続差分）
//
// Phase1（市場・価格形成）・Phase4（販売・約定残）・Phase5（国内原料・輸入・
// 養殖・原料在庫）を、決定論的な純粋関数として下記の順序で実行する。
// 永続化（Redis）・API・UIには一切依存しない（app/lib/v2/turn/types.ts 冒頭コメント参照）。
//
// 実行順序（実装指示のとおり。Phase4→Phase5の順は既存モジュール責務に合わせて
// そのまま踏襲する。理由: Phase5のrequirements.tsはPhase4のSalesContract[]を
// 入力とするため、Phase4の当四半期契約生成（advanceSalesQuarter）が先に完了して
// いないと、当四半期分の必要原料量集計に新規契約が反映されない。旧四半期までの
// 契約だけで良ければ順序は入れ替えられるが、「今期成約した分の必要原料量も
// 当期のうちに可視化する」ことを優先し、Phase4を先に実行する）。
//   1. 各社の有効買付意向を算出
//   2. 有効買付意向を集計
//   3. 市場入力へ国内買付意向を上書き適用
//   4. calculateMarketQuarterを実行
//   5. Phase4販売処理を実行
//   6. 約定残から必要原料量を集計
//   7. Phase5国内買付配分を実行
//   8. 国内買付ロットを生成
//   9. 輸入注文・到着処理
//   10. 養殖池入れ・収穫処理
//   11. 期限切れ・在庫状態遷移処理
//   12. 統合結果を返す

import { createRandomStream } from "../core/random";
import { HosoEqTons, hosoEqTons, ratio, unwrapUnit } from "../core/units";
import { MARKET_PARAMETERS_V1 } from "../market/parameters";
import { calculateMarketQuarter } from "../market/index";
import { CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS } from "../market/destinationPricingParameters";
import { SALES_PARAMETERS_V1 } from "../sales/parameters";
import { advanceSalesQuarter } from "../sales/runner";
import { CompanyId, SalesState } from "../sales/types";
import {
  aggregateDomesticPurchaseIntent,
  applyDomesticPurchaseIntentOverride,
  calculateEffectivePurchaseIntent,
} from "../rawMaterials/domesticPurchase";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../rawMaterials/parameters";
import { advanceRawMaterialsQuarter } from "../rawMaterials/runner";
import { RawMaterialsQuarterInput, RawMaterialsState } from "../rawMaterials/types";
import { TurnOrchestratorInput, TurnOrchestratorResult } from "./types";

/**
 * 1ターン（1四半期）分の Phase1・Phase4・Phase5 処理を、決定論的な純粋関数として
 * まとめて実行する。入力オブジェクト（input、input内のmarketInput/existingContracts/
 * existingLots等）は一切変更しない。同じinput（同じseedを含む）から常に同じ結果を
 * 返す。呼び出し側が「前回呼び出しの結果（pendingState由来の値）」だけを次の
 * currentPeriod/existingContracts/existingLotsとして渡す限り、ターンは1回分だけ
 * 進む（同じinputを2回渡しても同じ結果になるだけで、ロットが重複生成されることはない）。
 */
export function runTurn(input: TurnOrchestratorInput): TurnOrchestratorResult {
  const marketParams = input.parameters?.market ?? MARKET_PARAMETERS_V1;
  const salesParams = input.parameters?.sales ?? SALES_PARAMETERS_V1;
  const rawMaterialsParams = input.parameters?.rawMaterials ?? RAW_MATERIALS_PARAMETERS_V1;
  const destinationMarketPriceCoefficients = input.parameters?.destinationMarketPricing ?? CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS;

  // --- 1〜3. 国内買付意向の算出・集計・市場入力への上書き適用 ---
  const domesticProcurementIntentBeforeOverride = input.marketInput.vietnamDomestic.domesticProcurementIntent;

  let companyEffectivePurchaseIntents: readonly { readonly companyId: CompanyId; readonly effectiveIntent: HosoEqTons }[] = [];
  let aggregatedPurchaseIntent: HosoEqTons | undefined;
  let externalProcessorIntent: HosoEqTons | undefined;
  let overriddenMarketInput = input.marketInput;

  if (input.domesticPurchaseIntentSource.type === "companyPlans") {
    const referenceSupply = input.marketInput.vietnamDomestic.domesticRawSupply;
    const plans = input.domesticPurchaseIntentSource.plans;

    companyEffectivePurchaseIntents = plans
      .map((entry) => ({
        companyId: entry.companyId,
        effectiveIntent: calculateEffectivePurchaseIntent(entry, referenceSupply, rawMaterialsParams),
      }))
      .sort((a, b) => a.companyId.localeCompare(b.companyId));

    aggregatedPurchaseIntent = aggregateDomesticPurchaseIntent(plans, referenceSupply, rawMaterialsParams);
    // 【Phase 6.3（実装指示 §5）】国内価格形成用の総買付意向 =
    // 外部加工業者需要 + プレイヤー系会社の信認済み買付意向。プレイヤー系会社の
    // 行動は国内価格へ明確に影響するが、会社が買付を止めただけでベトナム全体の
    // 需要がゼロになる構造にはしない（externalIntent未指定時は従来どおり0）。
    externalProcessorIntent = input.domesticPurchaseIntentSource.externalIntent;
    const totalIntent = hosoEqTons(
      unwrapUnit(aggregatedPurchaseIntent) + (externalProcessorIntent !== undefined ? unwrapUnit(externalProcessorIntent) : 0)
    );
    overriddenMarketInput = applyDomesticPurchaseIntentOverride(input.marketInput, totalIntent);
  }
  // "phase3Fallback" の場合はinput.marketInputをそのまま使う（上書きしない）。

  const domesticProcurementIntentAfterOverride = overriddenMarketInput.vietnamDomestic.domesticProcurementIntent;

  // --- 4. Phase1市場計算 ---
  const randomStream = createRandomStream(`${input.seed}::${input.currentPeriod}`);
  const marketResult = calculateMarketQuarter(overriddenMarketInput, marketParams, randomStream);

  // --- 5. Phase4販売処理（既存契約を引き継いだ一時SalesStateをこのターンだけ進める） ---
  const salesStateBefore: SalesState = {
    currentPeriod: input.currentPeriod,
    contracts: input.existingContracts,
    history: [],
  };
  const salesStateAfter = advanceSalesQuarter(
    salesStateBefore,
    { plans: input.salesPlans, marketResult, marketInput: overriddenMarketInput },
    salesParams,
    destinationMarketPriceCoefficients
  );
  const salesRecord = salesStateAfter.history[0];
  const contracts = salesStateAfter.contracts;

  // --- 6〜11. Phase5原料処理（既存ロットを引き継いだ一時RawMaterialsStateをこのターンだけ進める） ---
  const rawMaterialsStateBefore: RawMaterialsState = {
    currentPeriod: input.currentPeriod,
    lots: input.existingLots,
    history: [],
  };
  // 【Phase 6.3（実装指示 §4・§5）】プレイヤー系会社が配分対象にできる国内原料量。
  // 当期の実際の取引成立量（transactedVolume。留保価格による数量調整後）のうち、
  // 総買付意向に占める会社側意向の比率分だけを会社別配分の原資とする。
  //   - 通常時（供給 >= 需要、数量調整なし）: transacted = 実効需要 → 原資 = 会社集計意向
  //   - 供給不足・数量調整時: transacted < 実効需要 → 原資が比例的に縮小し、調達未達が発生
  // 未売却の潜在供給（unsoldSupply）は会社在庫へ自動計上されない。
  const effectiveDemandValue = unwrapUnit(marketResult.vietnamDomestic.effectiveDemand);
  const companyAvailableDomesticSupply: HosoEqTons =
    aggregatedPurchaseIntent !== undefined && effectiveDemandValue > 1e-9
      ? hosoEqTons(
          unwrapUnit(marketResult.vietnamDomestic.transactedVolume) *
            Math.min(1, unwrapUnit(aggregatedPurchaseIntent) / effectiveDemandValue)
        )
      : marketResult.vietnamDomestic.transactedVolume;

  const rawMaterialsQuarterInput: RawMaterialsQuarterInput = {
    domesticPurchasePlans: input.domesticPurchaseIntentSource.type === "companyPlans" ? input.domesticPurchaseIntentSource.plans : [],
    importOrders: input.importOrders,
    aquacultureStockingPlans: input.aquacultureStockingPlans,
    vietnamDomesticPrice: marketResult.vietnamDomestic.price,
    vietnamDomesticSupply: companyAvailableDomesticSupply,
    // 1社あたりの最大買付シェア（maximumBuyerShare）の基準は、会社向け原資ではなく
    // 国内市場全体の供給量のまま維持する（Phase 6.3）。
    shareCapReferenceSupply: marketResult.vietnamDomestic.supply,
    originHosoFobPrice: Object.fromEntries(
      Object.entries(marketResult.hosoPrices).map(([country, r]) => [country, r.price])
    ) as RawMaterialsQuarterInput["originHosoFobPrice"],
    originExportableSupply: Object.fromEntries(
      Object.entries(marketResult.hosoPrices).map(([country, r]) => [country, r.exportableSupply])
    ) as RawMaterialsQuarterInput["originExportableSupply"],
    diseasePressure: input.scenarioVariables?.diseasePressure ?? ratio(0),
  };
  const rawMaterialsStateAfter = advanceRawMaterialsQuarter(rawMaterialsStateBefore, rawMaterialsQuarterInput, contracts, rawMaterialsParams);
  const rmRecord = rawMaterialsStateAfter.history[0];
  const lots = rawMaterialsStateAfter.lots;

  // --- 12. 統合結果の組み立て ---
  const companyDomesticAllocations = rmRecord.domesticAllocation.companies
    .map((c) => ({ companyId: c.companyId, allocatedQuantity: c.allocatedQuantity }))
    .sort((a, b) => a.companyId.localeCompare(b.companyId));

  return {
    period: input.currentPeriod,
    marketResult,
    salesRecord,
    contracts,
    rawMaterialRequirements: rmRecord.requirements,
    domesticAllocation: rmRecord.domesticAllocation,
    lots,
    newImportLots: rmRecord.newImportLots,
    arrivedImportLots: rmRecord.arrivedImportLots,
    newGrowingLots: rmRecord.newGrowingLots,
    harvestedLots: rmRecord.harvestedLots,
    expiredLots: rmRecord.expiredLots,
    aquacultureHarvestResults: rmRecord.harvestResults,
    pendingState: {
      nextPeriod: rawMaterialsStateAfter.currentPeriod,
      contracts,
      lots,
    },
    debug: {
      companyEffectivePurchaseIntents,
      aggregatedPurchaseIntent,
      externalProcessorIntent,
      companyAvailableDomesticSupply,
      domesticProcurementIntentBeforeOverride,
      domesticProcurementIntentAfterOverride,
      domesticMarketPrice: marketResult.vietnamDomestic.price,
      domesticMarketSupply: marketResult.vietnamDomestic.supply,
      companyDomesticAllocations,
    },
  };
}
