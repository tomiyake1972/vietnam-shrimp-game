// ShrimpX V2 — Redis永続化アダプター Repository（Phase 5.7）
//
// PersistedGameStateV2 ⇄ Redis の読み書きを行う。実際のJSON化・ランタイム
// 検証はapp/lib/v2/persistence/（encodePersistedGameState/
// decodePersistedGameStateFromStored）へ完全に委譲し、本ファイルは
// JSON.parse/JSON.stringifyを一切直接書かない。runTurn自体（app/lib/v2/turn/）
// の公開契約も変更しない。
//
// Redisキーは必ずredisKeys.tsのgameKeyV2()経由で生成し、実際の書き込み・削除の
// 直前に必ずredisKeyGuard.tsのassertAllowedKeysV2()を通す
// （docs/v2/CORE_ARCHITECTURE_v0.1.md §3で「Phase 1でApplication層から利用
// される想定」と明記されていた配線を、本Phaseで実際に行う）。

import { gameKeyV2 } from "./redisKeys";
import { assertAllowedKeysV2 } from "./redisKeyGuard";
import { DuplicateTurnExecutionError, GameNotFoundError, PersistenceError, SerializationError } from "./errors";
import { ApplyTurnOutcome, GameStateRepository, GameStateRepositoryDependencies, V2RedisClient } from "./types";
import { AppEnvV2, AppVersion } from "../core/version";
import {
  ExternalTurnInput,
  PersistedGameStateV2,
  applyTurnResultToPersistedState,
  decodePersistedGameStateFromStored,
  encodePersistedGameState,
  hydrateTurnInputFromPersistedState,
} from "../persistence";
import { runTurn } from "../turn/runner";

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function assertNonEmptyGameId(gameId: string): void {
  if (typeof gameId !== "string" || gameId.length === 0) {
    throw new PersistenceError("gameIdは空でない文字列である必要があります。");
  }
}

function assertNonEmptyTurnExecutionId(turnExecutionId: string): void {
  if (typeof turnExecutionId !== "string" || turnExecutionId.length === 0) {
    throw new PersistenceError("turnExecutionIdは空でない文字列である必要があります。");
  }
}

/**
 * Redis上のV2ゲーム状態を読み書きするRepositoryを作る。
 * client・appVersion・appEnvはすべて明示的に注入する（純粋な依存注入。
 * テストでは実際のRedis接続もAPP_VERSION/APP_ENV環境変数も不要にするため）。
 * 実際の本番運用でこの関数を呼び出す際は、client.tsのcreateDefaultV2RedisClient()
 * と、app/lib/v2/core/version.tsのreadAppVersionFromEnv()/readAppEnvV2FromEnv()を
 * 渡す想定（本Phaseではその配線コード自体は追加しない。将来のApplication/API層の
 * 責務）。
 */
export function createGameStateRepository(deps: GameStateRepositoryDependencies): GameStateRepository {
  const { client, appVersion, appEnv } = deps;

  function stateKey(gameId: string): string {
    assertNonEmptyGameId(gameId);
    const key = gameKeyV2(appEnv, gameId);
    assertAllowedKeysV2([key], appVersion, appEnv);
    return key;
  }

  async function loadGameState(gameId: string): Promise<PersistedGameStateV2> {
    const key = stateKey(gameId);
    let raw: unknown;
    try {
      raw = await client.get(key);
    } catch (e) {
      throw new PersistenceError(`Redisからの読み込みに失敗しました（key=${key}）: ${toErrorMessage(e)}`);
    }
    if (raw === null || raw === undefined) {
      throw new GameNotFoundError(gameId);
    }
    try {
      return decodePersistedGameStateFromStored(raw);
    } catch (e) {
      throw new SerializationError(`保存されていたV2状態のdecodeに失敗しました（gameId=${gameId}）: ${toErrorMessage(e)}`);
    }
  }

  async function saveGameState(state: PersistedGameStateV2): Promise<void> {
    // save時のupdatedAt更新・createdAtの維持は、createInitialPersistedGameState /
    // applyTurnResultToPersistedState（app/lib/v2/persistence/builder.ts）の責務。
    // Repositoryは渡された状態をそのまま保存するだけで、タイムスタンプを
    // 独自に書き換えることはしない（呼び出し側が正しいbuilderを経由した状態を
    // 渡してくる、という契約）。
    const key = stateKey(state.gameId);
    let serialized: string;
    try {
      serialized = encodePersistedGameState(state);
    } catch (e) {
      throw new SerializationError(`V2状態のencodeに失敗しました（gameId=${state.gameId}）: ${toErrorMessage(e)}`);
    }
    try {
      await client.set(key, serialized);
    } catch (e) {
      throw new PersistenceError(`Redisへの書き込みに失敗しました（key=${key}）: ${toErrorMessage(e)}`);
    }
  }

  async function gameExists(gameId: string): Promise<boolean> {
    const key = stateKey(gameId);
    try {
      const count = await client.exists(key);
      return count > 0;
    } catch (e) {
      throw new PersistenceError(`Redisへの存在確認に失敗しました（key=${key}）: ${toErrorMessage(e)}`);
    }
  }

  async function deleteGame(gameId: string): Promise<void> {
    const key = stateKey(gameId);
    // 本番Redisのデータを削除・初期化しない、という本セッション全体の方針に
    // 従い、本番環境（appEnv==="production"）ではdeleteGame自体を拒否する
    // （V1のstagingAdmin.tsが管理系操作を本番で一律拒否するのと同じ設計思想を、
    // まだAPI/認証層が存在しないRepository層で先取りして適用する）。
    if (appEnv === "production") {
      throw new PersistenceError(`本番環境（appEnv="production"）でのV2ゲーム削除は許可されていません（gameId=${gameId}）。`);
    }
    try {
      await client.del(key);
    } catch (e) {
      throw new PersistenceError(`Redisからの削除に失敗しました（key=${key}）: ${toErrorMessage(e)}`);
    }
  }

  async function applyTurn(
    gameId: string,
    externalTurnInput: ExternalTurnInput,
    turnExecutionId: string,
    updatedAt: string
  ): Promise<ApplyTurnOutcome> {
    assertNonEmptyTurnExecutionId(turnExecutionId);

    // load
    const previousState = await loadGameState(gameId);

    // turnExecutionIdの重複は、runTurn（比較的重い純粋計算）を実行する前に
    // 検出して拒否する（実装指示§9「二重反映は禁止」。無駄な計算を避ける）。
    if (previousState.execution.lastTurnExecutionId === turnExecutionId) {
      throw new DuplicateTurnExecutionError(gameId, turnExecutionId);
    }

    // runTurn（app/lib/v2/turn/runner.tsの公開契約はそのまま利用するだけで変更しない）
    const turnInput = hydrateTurnInputFromPersistedState(previousState, externalTurnInput);
    const turnResult = runTurn(turnInput);

    // apply
    let nextState: PersistedGameStateV2;
    try {
      nextState = applyTurnResultToPersistedState(previousState, turnResult, turnExecutionId, updatedAt);
    } catch (e) {
      // period不一致等はhydrateTurnInputFromPersistedStateの設計上ここでは
      // 通常発生しないが、万一の内部不整合はPersistenceErrorとして表面化する
      // （GameNotFound/DuplicateTurnExecutionのいずれでもないため）。
      throw new PersistenceError(`ターン結果の永続化状態への適用に失敗しました（gameId=${gameId}）: ${toErrorMessage(e)}`);
    }

    // save
    //
    // Atomic Update についての注記（実装指示§8）: 現状は
    //   load（redisからGET） → runTurn（純粋計算） → apply（純粋計算） → save（redisへSET）
    // を、Repositoryの1メソッド呼び出しの中で順に実行するだけであり、Redis上の
    // 排他制御（WATCH/MULTI等）は行っていない。複数の実行が同時にこの関数を
    // 呼んだ場合、後勝ちで上書きされうる（教科書的なread-modify-write競合）。
    // 将来この関数の中身だけを「WATCHでkeyを監視 → GET → 計算 → MULTI/EXECで
    // 条件付きSET、競合時はリトライ」という実装へ差し替えれば、
    // GameStateRepository.applyTurnの公開シグネチャ・呼び出し側のコードは
    // 一切変更せずに済む（既存Redisクライアント（Upstash REST API）が
    // 現時点でこの能力をどこまでサポートするかに応じて、将来のPhaseで検討する）。
    await saveGameState(nextState);

    return { state: nextState, turnResult };
  }

  return { loadGameState, saveGameState, gameExists, deleteGame, applyTurn };
}

export type { V2RedisClient, GameStateRepository, GameStateRepositoryDependencies, ApplyTurnOutcome, AppEnvV2, AppVersion };
