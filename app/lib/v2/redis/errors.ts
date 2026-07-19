// ShrimpX V2 — Redis永続化アダプター エラー型（Phase 5.7）
//
// 用途別に明示的なエラー型を用意する。すべて`code`プロパティで種別を判定
// できる（`instanceof`でも`error.code`でも判定できる）。

export type V2RedisRepositoryErrorCode =
  | "GAME_NOT_FOUND"
  | "DUPLICATE_TURN_EXECUTION"
  | "PERSISTENCE_ERROR"
  | "SERIALIZATION_ERROR";

abstract class V2RedisRepositoryErrorBase extends Error {
  abstract readonly code: V2RedisRepositoryErrorCode;
}

/** 指定したgameIdのV2ゲーム状態がRedis上に存在しない。 */
export class GameNotFoundError extends V2RedisRepositoryErrorBase {
  readonly code = "GAME_NOT_FOUND" as const;
  readonly gameId: string;
  constructor(gameId: string) {
    super(`ゲーム "${gameId}" のV2状態が見つかりません。`);
    this.name = "GameNotFoundError";
    this.gameId = gameId;
  }
}

/**
 * 同一turnExecutionIdを再適用しようとした（二重反映の禁止。§9「実行識別子と
 * 冪等性境界」）。applyTurnは、実際にrunTurnを実行する前に
 * `previousState.execution.lastTurnExecutionId`と比較して本エラーを投げる
 * （無駄な計算を避けるため）。
 */
export class DuplicateTurnExecutionError extends V2RedisRepositoryErrorBase {
  readonly code = "DUPLICATE_TURN_EXECUTION" as const;
  readonly gameId: string;
  readonly turnExecutionId: string;
  constructor(gameId: string, turnExecutionId: string) {
    super(`ゲーム "${gameId}" では turnExecutionId "${turnExecutionId}" は既に適用済みです（二重反映は禁止されています）。`);
    this.name = "DuplicateTurnExecutionError";
    this.gameId = gameId;
    this.turnExecutionId = turnExecutionId;
  }
}

/**
 * Redisクライアントとの実際の入出力（get/set/exists/del）が失敗した場合、
 * および本番環境での破壊的操作（deleteGame）が拒否された場合に使う。
 */
export class PersistenceError extends V2RedisRepositoryErrorBase {
  readonly code = "PERSISTENCE_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "PersistenceError";
  }
}

/**
 * PersistedGameStateV2のencode/decodeに失敗した場合（保存されていた値が
 * 壊れている・スキーマバージョンが未対応等）。app/lib/v2/persistence/errors.ts
 * の各エラー（PersistedStateParseError等）を、Repositoryの利用者から見て
 * 「保存データのシリアライズに関する問題」として一貫して扱えるよう、
 * このエラーへラップし直す（元のエラーメッセージはそのまま引き継ぐ）。
 */
export class SerializationError extends V2RedisRepositoryErrorBase {
  readonly code = "SERIALIZATION_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "SerializationError";
  }
}
