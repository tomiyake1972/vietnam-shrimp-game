// ShrimpX V2 — 工場・ワーカー・HOSO/PD/VAP生産・完成品在庫・契約履行モジュール
// エントリポイント（Phase 6）
//
// UI・Redis・API・生成AIから完全に独立した純粋関数群。Phase5のターン・
// オーケストレーター（app/lib/v2/turn/）へは本Phaseでは接続しない
// （既存オーケストレーターの公開契約を書き換えない）。
//
// 想定される呼び出し方（将来のturn/連携アダプター実装時のイメージ。本モジュール
// 自身はturn/を一切importしない）:
//
//   let productionState = initializeProductionState(INITIAL_PERIOD_V2);
//   const { state, updatedRawMaterialLots } = advanceProductionQuarter(
//     productionState, quarterInput, contracts, rawMaterialLots, supplySignals
//   );
//   // 契約への実際の適用（Phase4の既存関数をそのまま使う）:
//   const updatedContracts = applyFulfillments(contracts, state.history[state.history.length - 1].fulfillmentPlan.explicitInstructions);
//   // 完成品ロットの実消費:
//   const updatedFinishedGoodsLots = consumeFinishedGoods(state.finishedGoodsLots, plan.finishedGoodsConsumption);
//   productionState = state;

export * from "./types";
export { PRODUCTION_PARAMETERS_V1 } from "./parameters";
export type { ProductionParameters } from "./parameters";
export { buildBatchId, buildFinishedGoodsLotId } from "./ids";
export { calculateFactoryEffectiveCapacity, calculateFactoryEffectiveCapacities } from "./capacity";
export {
  calculateLaborCapacityFromAssignedHeadcount,
  allocateWorkersToPlans,
  requiredHeadcountForQuantity,
  effectiveEfficiencyPerHeadTons,
  laborIntensityCoefficientFor,
} from "./labor";
export type { WorkerDemandItem } from "./labor";
export { calculatePhysicalOutputTons } from "./yieldConversion";
export { allocateByPriorityTiers } from "./priorityAllocation";
export type { PriorityAllocationItem } from "./priorityAllocation";
export { allocateProductionPlans } from "./allocation";
export { buildProductionBatches } from "./batches";
export type { ProductionBatchBuildResult } from "./batches";
export { createFinishedGoodsLots, consumeFinishedGoods, applyFinishedGoodsExpiryForQuarterEnd } from "./finishedGoods";
export { planContractFulfillment } from "./fulfillment";
export { aggregateProductionSupplySignals, applySupplySignalToCountrySupply } from "./supplySignal";
export { calculateFactoryLoadMetrics, calculateAllFactoryLoadMetrics, calculateCompanyLoadMetrics } from "./loadMetrics";
export type { RawMaterialLotOrigin } from "./loadMetrics";
export {
  initializeProductionState,
  advanceProductionQuarter,
  runProductionQuartersForTesting,
} from "./runner";
export type { ProductionQuarterTestInput } from "./runner";
