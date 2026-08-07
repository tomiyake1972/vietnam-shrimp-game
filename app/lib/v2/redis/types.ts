// ShrimpX V2 — Redis永続化アダプター 共通型（Phase 5.7）
//
// app/lib/v2/persistence/（永続化状態モデル・シリアライズ契約）を、実際に
// Redisへ読み書きするためのアダプター層。Redisクライアント本体
// （@upstash/redis）には一切依存せず、実際に使う最小限の操作
// （get/set/exists/del）だけを持つインターフェースを介して抽象化する。
//
// こうする理由:
//   1. app/lib/redis.ts（V1/V2共有のRedisクライアントfacade）は、モジュール
//      読み込み時点で環境変数（本番/staging用REST API URL・TOKEN）を必須
//      チェックする設計になっている。本モジュールをテスト・ビルド（ページ
//      データ収集含む）から安全に読み込めるようにするため、実クライアントへの
//      依存はclient.ts側で遅延importにとどめ、Repository自体は
//      V2RedisClientという狭いインターフェースにだけ依存する。
//   2. テストでは、実際のRedis接続を用意せずに、V2RedisClientを実装した
//      インメモリのフェイクを注入するだけでRepositoryの全ロジックを検証できる。

import { AppEnvV2, AppVersion } from "../core/version";
import { ExternalTurnInput, PersistedGameStateV2 } from "../persistence/types";
import { TurnOrchestratorResult } from "../turn/types";

/**
 * Repositoryが実際に必要とするRedis操作だけを持つ、狭いインターフェース。
 * app/lib/redis.ts の `redis` facadeが実際に提供する操作（get/set/exists/del等）
 * の能力に合わせており、それ以上の機能（lrange/scan/lpush等、V2の単一ゲーム
 * 状態保存では使わない操作）は含めない。
 */
export interface V2RedisClient {
  /** 値が存在すればその値（文字列、またはクライアントが自動でJSON deserialize
   * した場合はプレーンオブジェクト）を、存在しなければ null/undefined を返す。 */
  get(key: string): Promise<unknown>;
  /** 値を保存する。 */
  set(key: string, value: string): Promise<unknown>;
  /** 指定したキーが存在するキーの数を返す（Upstash `EXISTS` と同じ意味）。 */
  exists(key: string): Promise<number>;
  /** 指定したキーを削除する。 */
  del(key: string): Promise<unknown>;
}

/** applyTurnの戻り値。更新後の永続化状態と、当該ターンのrunTurn結果の両方を返す。 */
export interface ApplyTurnOutcome {
  readonly state: PersistedGameStateV2;
  readonly turnResult: TurnOrchestratorResult;
}

/**
 * V2ゲーム状態のRedis Repository。実装（repository.ts）は
 * load → runTurn → apply → save を1つの操作としてまとめた`applyTurn`を提供する。
 * 現状はRedisのWATCH/MULTI等による原子性は持たない（実装指示・docs参照）。
 * 将来そのような排他制御へ置き換える場合も、このインターフェース自体は
 * 変える必要がない設計にしてある。
 */
export interface GameStateRepository {
  loadGameState(gameId: string): Promise<PersistedGameStateV2>;
  saveGameState(state: PersistedGameStateV2): Promise<void>;
  gameExists(gameId: string): Promise<boolean>;
  deleteGame(gameId: string): Promise<void>;
  applyTurn(
    gameId: string,
    externalTurnInput: ExternalTurnInput,
    turnExecutionId: string,
    updatedAt: string
  ): Promise<ApplyTurnOutcome>;
}

/** Repositoryを構築するための依存関係（すべて明示的に注入する。テスト容易性のため）。 */
export interface GameStateRepositoryDependencies {
  readonly client: V2RedisClient;
  readonly appVersion: AppVersion;
  readonly appEnv: AppEnvV2;
}
