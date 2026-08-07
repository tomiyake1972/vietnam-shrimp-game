// ShrimpX V2 — ターン・オーケストレーター エントリポイント（Phase 5後続差分）
//
// Phase1（市場・価格形成）・Phase4（販売・約定残）・Phase5（国内原料・輸入・
// 養殖・原料在庫）を接続する、永続化（Redis）・API・UIから独立した純粋な
// アプリケーション層。現時点でV2には本番ターン実行経路・意思決定保存スキーマ・
// APIルートが存在しないため（docs/v2/RAW_MATERIALS_ARCHITECTURE_v0.1.md 追補
// 参照）、本モジュールはそれらの代替ではなく、将来のV2 API・Redis・UIが
// runTurnを呼び出すための土台として新設したものである。
//
// 想定される呼び出し方（将来のAPI/Redis層からの利用イメージ。本モジュール自身は
// Redis/APIに一切依存しない）:
//
//   const result = runTurn({
//     currentPeriod, marketInput, salesPlans,
//     domesticPurchaseIntentSource: { type: "companyPlans", plans },
//     importOrders, aquacultureStockingPlans,
//     existingContracts, existingLots, seed,
//   });
//   // 次ターンは result.pendingState の値だけを次の呼び出しへ渡す。
//   const next = runTurn({
//     currentPeriod: result.pendingState.nextPeriod,
//     existingContracts: result.pendingState.contracts,
//     existingLots: result.pendingState.lots,
//     ...
//   });

export * from "./types";
export { runTurn } from "./runner";
