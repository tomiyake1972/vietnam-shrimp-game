// ShrimpX V2 — 国内原料・輸入・養殖・原料在庫モジュール エントリポイント（Phase 5）
//
// 画面・API・Redis保存・生成AIから独立した純粋なTypeScriptドメインモジュール。
// Redis・API Route・外部サービスには一切依存しない。
//
// 想定される呼び出し方:
//
//   let state = initializeRawMaterialsState(INITIAL_PERIOD_V2);
//   state = advanceRawMaterialsQuarter(state, {
//     domesticPurchasePlans, importOrders, aquacultureStockingPlans,
//     vietnamDomesticPrice, vietnamDomesticSupply, originHosoFobPrice,
//     originExportableSupply, diseasePressure,
//   }, contracts);
//   // ...Phase6から実際の消費量が届いたら:
//   const lots = consumeRawMaterials(state.lots, [{ companyId, quantity }]);

export * from "./types";
export * from "./parameters";
export { summarizeRawMaterialRequirements } from "./requirements";
export {
  aggregateDomesticPurchaseIntent,
  applyDomesticPurchaseIntentOverride,
  procurementCoverageScore,
  computeBuyerCompetitivenessWeight,
  allocateDomesticPurchase,
} from "./domesticPurchase";
export { calculateLandedPrice, createImportLots, receiveArrivedImports } from "./imports";
export { calculateExpectedProduction, calculateSurvivalRatio, createGrowingLots, harvestAquacultureLots } from "./aquaculture";
export {
  initializeRawMaterialInventory,
  createDomesticPurchaseLots,
  consumeRawMaterials,
  applyExpiryForQuarterEnd,
} from "./inventory";
export { buildLotId } from "./inventoryIds";
export { initializeRawMaterialsState, advanceRawMaterialsQuarter, runRawMaterialsQuartersForTesting } from "./runner";
