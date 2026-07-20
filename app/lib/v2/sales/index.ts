// ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール エントリポイント（Phase 4）
//
// 画面・API・Redis保存・生成AIから独立した純粋なTypeScriptドメインモジュール。
// Redis・API Route・外部サービスには一切依存しない。
//
// 想定される呼び出し方:
//
//   let state = initializeSalesState(INITIAL_PERIOD_V2);
//   state = advanceSalesQuarter(state, { plans, marketResult, marketInput });
//   // ...Phase6から実際の出荷実績が届いたら:
//   const contracts = applyFulfillments(state.contracts, [{ kind: "fifo", companyId, market, product, quantity }]);
//   const updated = updateContractStatusesForQuarterEnd(contracts, state.currentPeriod);

export * from "./types";
export * from "./parameters";
export { deriveVietnamBasePrices, deriveTargetDemand } from "./marketAdapter";
export { salesCoverageScore, processingCapacity } from "./salesForce";
export { computeCompetitivenessWeight, computeCompetitivenessBreakdown, allocateMarketProduct } from "./allocation";
export { buildContractId, createContractsFromAllocation } from "./contracts";
export { applyFulfillments, cancelContract, updateContractStatusesForQuarterEnd } from "./backlog";
export { initializeSalesState, advanceSalesQuarter, runSalesQuartersForTesting } from "./runner";
