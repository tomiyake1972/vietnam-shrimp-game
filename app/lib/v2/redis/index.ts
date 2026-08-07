// ShrimpX V2 — Redis永続化アダプター エントリポイント（Phase 0A + Phase 5.7）
//
// app/lib/v2/persistence/（永続化状態モデル・シリアライズ契約）を、実際に
// Redisへ読み書きするための最終アダプター層。V2 API・UI・決定提出画面は
// まだ存在しない（本Phaseの対象外）。将来のApplication/API層は、この
// index.ts経由でRepositoryを構築して使う想定。
//
// 想定される呼び出し方（将来のAPI層からの利用イメージ。本モジュール自身は
// Next.js API Route・UIには一切依存しない）:
//
//   import { createGameStateRepository, createDefaultV2RedisClient } from "app/lib/v2/redis";
//   import { readAppVersionFromEnv, readAppEnvV2FromEnv } from "app/lib/v2/core/version";
//
//   const repo = createGameStateRepository({
//     client: await createDefaultV2RedisClient(),
//     appVersion: readAppVersionFromEnv(),
//     appEnv: readAppEnvV2FromEnv(),
//   });
//   const { state, turnResult } = await repo.applyTurn(gameId, externalTurnInput, turnExecutionId, updatedAt);

export * from "./redisKeys";
export * from "./redisKeyGuard";
export * from "./types";
export * from "./errors";
export { createGameStateRepository } from "./repository";
export { createDefaultV2RedisClient } from "./client";
