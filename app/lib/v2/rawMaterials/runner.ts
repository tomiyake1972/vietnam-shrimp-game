// ShrimpX V2 — 国内原料・輸入・養殖・原料在庫モジュール 四半期ランナー（Phase 5）
//
// Phase4のrunner.ts（app/lib/v2/sales/runner.ts）と同じ構造
// （initializeX / advanceX / 複数四半期テスト用ランナー）を踏襲する。
// advanceRawMaterialsQuarterは次を1四半期分まとめて行う。
//   約定残から必要原料量集計 → 国内買付希望量集計・配分 →
//   輸入注文作成・到着処理 → 養殖池入れ・収穫処理 → 在庫への反映
// FIFO消費（consumeRawMaterials）はPhase6からの実際の消費量が届いてから
// 呼び出し側が明示的に呼ぶ別ステップとする（advanceRawMaterialsQuarter自身は
// 消費を行わない）。

import { nextPeriod, PeriodV2 } from "../core/period";
import { ratio } from "../core/units";
import { SalesContract } from "../sales/types";
import { summarizeRawMaterialRequirements } from "./requirements";
import { allocateDomesticPurchase } from "./domesticPurchase";
import { createDomesticPurchaseLots, applyExpiryForQuarterEnd } from "./inventory";
import { createImportLots, receiveArrivedImports } from "./imports";
import { createGrowingLots, harvestAquacultureLots } from "./aquaculture";
import { RAW_MATERIALS_PARAMETERS_V1, RawMaterialsParameters } from "./parameters";
import { RawMaterialsQuarterInput, RawMaterialsQuarterRecord, RawMaterialsState } from "./types";

/** 空の原料状態を作る（ロット・履歴なし）。 */
export function initializeRawMaterialsState(startPeriod: PeriodV2): RawMaterialsState {
  return { currentPeriod: startPeriod, lots: [], history: [] };
}

/**
 * 1四半期分の原料調達処理を行い、新しい RawMaterialsState を返す（入力stateは
 * 変更しない）。約定残（contracts）から必要原料量を集計するのは意思決定支援
 * 情報としてのみで、調達量には一切反映しない（会社の入力がすべて）。
 */
export function advanceRawMaterialsQuarter(
  state: RawMaterialsState,
  input: RawMaterialsQuarterInput,
  contracts: readonly SalesContract[],
  params: RawMaterialsParameters = RAW_MATERIALS_PARAMETERS_V1
): RawMaterialsState {
  const period = state.currentPeriod;

  const requirements = summarizeRawMaterialRequirements(contracts);

  const domesticAllocation = allocateDomesticPurchase(
    period,
    input.domesticPurchasePlans,
    input.vietnamDomesticPrice,
    input.vietnamDomesticSupply,
    params,
    input.shareCapReferenceSupply ?? input.vietnamDomesticSupply
  );
  const domesticLots = createDomesticPurchaseLots(domesticAllocation, params);

  const newImportLots = createImportLots(input.importOrders, input.originHosoFobPrice, input.originExportableSupply, params);

  const newGrowingLots = createGrowingLots(input.aquacultureStockingPlans, params);

  // まず今期生成された新規ロット（国内購入・輸入・養殖池入れ）を在庫へ加える。
  const lotsAfterNewIntake = [...state.lots, ...domesticLots, ...newImportLots, ...newGrowingLots];

  // 到着・収穫時期に達したものを可用化する。
  const lotsAfterImportArrival = receiveArrivedImports(lotsAfterNewIntake, period);
  const diseasePressure = input.diseasePressure ?? ratio(0);
  const { lots: lotsAfterHarvest, harvestResults } = harvestAquacultureLots(lotsAfterImportArrival, period, diseasePressure, params);

  // 四半期末の期限切れ処理。
  const lotsAfterExpiry = applyExpiryForQuarterEnd(lotsAfterHarvest, period);

  const arrivedImportLots = lotsAfterExpiry.filter(
    (lot) => lot.source === "import" && lot.status === "available" && lot.availableFromPeriod === period
  );
  const harvestedLots = lotsAfterExpiry.filter(
    (lot) => lot.source === "aquaculture" && lot.status === "available" && lot.availableFromPeriod === period && harvestResults.some((h) => h.companyId === lot.companyId && h.harvestPeriod === period)
  );
  const expiredLots = lotsAfterExpiry.filter((lot) => lot.status === "expired" && !state.lots.some((prior) => prior.lotId === lot.lotId && prior.status === "expired"));

  const record: RawMaterialsQuarterRecord = {
    period,
    requirements,
    domesticAllocation,
    newImportLots,
    arrivedImportLots,
    newGrowingLots,
    harvestedLots,
    harvestResults,
    expiredLots,
  };

  return {
    currentPeriod: nextPeriod(period),
    lots: lotsAfterExpiry,
    history: [...state.history, record],
  };
}

/**
 * 複数四半期を再現可能に実行するテスト用ランナー。各要素が1四半期分の
 * (RawMaterialsQuarterInput, contracts) となる配列を、そのまま順に
 * advanceRawMaterialsQuarterへ渡す。
 */
export function runRawMaterialsQuartersForTesting(
  startPeriod: PeriodV2,
  quarterInputs: readonly { readonly input: RawMaterialsQuarterInput; readonly contracts: readonly SalesContract[] }[],
  params: RawMaterialsParameters = RAW_MATERIALS_PARAMETERS_V1
): RawMaterialsState {
  let state = initializeRawMaterialsState(startPeriod);
  for (const { input, contracts } of quarterInputs) {
    state = advanceRawMaterialsQuarter(state, input, contracts, params);
  }
  return state;
}
