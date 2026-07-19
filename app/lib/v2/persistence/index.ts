// ShrimpX V2 — 永続化状態・シリアライズ契約 エントリポイント（Phase 5.6）
//
// app/lib/v2/turn/（ターン・オーケストレーター）・app/lib/v2/turnState/
// （状態遷移層）の外側、将来のRedis/API層の内側に位置する、
// 「ターンをまたいで保存すべき最小限のゲーム状態」と、その安全な
// シリアライズ契約（encode/decode）を提供する。Redis・Next.js API・
// ブラウザAPIには一切依存しない。
//
// 想定される呼び出し方（将来のRedis/API層からの利用イメージ。本モジュール
// 自身はRedis/APIに一切依存しない）:
//
//   let state = createInitialPersistedGameState({ gameId, scenarioId, initialPeriod, seed, initialContracts: [], initialRawMaterialLots: [], createdAt });
//   // ...Redisへ保存: await redis.set(key, encodePersistedGameState(state))...
//
//   // 次ターン:
//   // ...Redisから読み込み: const state = decodePersistedGameState(await redis.get(key))...
//   const turnInput = hydrateTurnInputFromPersistedState(state, externalTurnInput);
//   const turnResult = runTurn(turnInput);
//   state = applyTurnResultToPersistedState(state, turnResult, turnExecutionId, updatedAt);
//   // ...Redisへ保存: await redis.set(key, encodePersistedGameState(state))...

export * from "./types";
export * from "./errors";
export { validatePersistedGameState } from "./schema";
export { encodePersistedGameState, decodePersistedGameState } from "./codec";
export {
  createInitialPersistedGameState,
  applyTurnResultToPersistedState,
  hydrateTurnInputFromPersistedState,
} from "./builder";
export type { CreateInitialPersistedGameStateInput } from "./builder";
