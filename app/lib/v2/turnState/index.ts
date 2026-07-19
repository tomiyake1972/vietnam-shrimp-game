// ShrimpX V2 — ターン状態遷移層 エントリポイント（Phase 5.5）
//
// app/lib/v2/turn/（ターン・オーケストレーター、runTurn）と、将来の永続化層
// （Redis保存・V2 API・GameSessionV2・Replay・Save/Load）の間に入る、
// 決定論的な純粋関数の境界。Redis・API Route・UIには一切依存しない。
//
// 想定される呼び出し方（将来のAPI/Redis層からの利用イメージ。本モジュール自身は
// Redis/APIに一切依存しない）:
//
//   const result = runTurn(input);
//   // ...結果を保存する（本モジュールの対象外）...
//   const nextInputSkeleton = buildNextTurnInput(input, result);
//   // 呼び出し側（将来のシナリオ/API層）が、次期の実データで一部フィールドを
//   // 上書きしてからrunTurnへ渡す。
//   const nextInput = {
//     ...nextInputSkeleton,
//     marketInput: nextScenarioMarketInput,
//     salesPlans: nextSalesPlans,
//     domesticPurchaseIntentSource: { type: "companyPlans", plans: nextDomesticPlans },
//     importOrders: nextImportOrders,
//     aquacultureStockingPlans: nextAquaculturePlans,
//   };
//   const nextResult = runTurn(nextInput);

export * from "./types";
export { buildNextTurnInput } from "./builder";
