// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run の Redis Repository
//
// repository.ts の SimulationRunRepository 契約を、実際の Redis に対して実装する。
// 会社ラボ本体の redisRepository.ts と同じく、キー生成→キーガード→クライアント呼び出し
// の順で書き、Redis 接続そのものは呼び出し側から注入する。
//
// 【保存の原子性】保存は「本体SET + 要約SET + indexへZADD + 古い実行の追い出し」を
// 1本の Lua で行う。TypeScript 側で「読んで比較して複数回SET」はしない
// （会社ラボの原子コミットと同じ方針）。

import { AppEnvV2 } from "../../../core/version";
import { CompanyLabRedisClient } from "../../../redis/companyLabTypes";
import {
  assertAllowedSimulationRunKeys,
  simulationRunIndexKeyV2,
  simulationRunKeyV2,
  simulationRunSummaryKeyV2,
} from "../../../redis/simulationRunRedisKeys";
import {
  SIMULATION_RUN_RETENTION_LIMIT,
  SimulationRunRepository,
  SimulationRunRepositoryError,
  assertStorableSimulationRun,
  parseStoredSimulationRun,
  sortAndLimitSummaries,
} from "./repository";
import { SimulationRunSummary, StoredSimulationRun, toSimulationRunSummary } from "./types";

/**
 * 保存本体 + 要約 + index 追加 + 保存上限超過分の追い出しを一度に行う。
 * 追い出し対象の本体キーは Lua 側で組み立てず、id を返して呼び出し側が消す
 * （キー名を Lua 内部で合成せず、書き込むキーをすべて明示するため）。
 */
const SAVE_SCRIPT = `
local runKey = KEYS[1]
local summaryKey = KEYS[2]
local indexKey = KEYS[3]
local runJson = ARGV[1]
local summaryJson = ARGV[2]
local score = tonumber(ARGV[3])
local runId = ARGV[4]
local limit = tonumber(ARGV[5])

redis.call('SET', runKey, runJson)
redis.call('SET', summaryKey, summaryJson)
redis.call('ZADD', indexKey, score, runId)

local total = redis.call('ZCARD', indexKey)
local excess = total - limit
if excess <= 0 then
  return {}
end
local evicted = redis.call('ZRANGE', indexKey, 0, excess - 1)
for i = 1, #evicted do
  redis.call('ZREM', indexKey, evicted[i])
end
return evicted
`;

export interface SimulationRunRepositoryDependencies {
  readonly client: CompanyLabRedisClient;
  readonly appEnv: AppEnvV2;
}

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createRedisSimulationRunRepository(deps: SimulationRunRepositoryDependencies): SimulationRunRepository {
  const { client, appEnv } = deps;

  async function saveRun(stored: StoredSimulationRun): Promise<void> {
    assertStorableSimulationRun(stored);
    const runId = stored.run.simulationRunId;
    const runKey = simulationRunKeyV2(appEnv, runId);
    const summaryKey = simulationRunSummaryKeyV2(appEnv, runId);
    const indexKey = simulationRunIndexKeyV2(appEnv);
    assertAllowedSimulationRunKeys([runKey, summaryKey, indexKey], appEnv);

    // score は保存時刻。ISO8601 として解釈できない場合は 0（＝最も古い扱い）にせず、
    // 呼び出し契約違反として弾く（順序が壊れた一覧を静かに作らない）。
    const score = Date.parse(stored.savedAt);
    if (!Number.isFinite(score)) {
      throw new SimulationRunRepositoryError(`savedAt が ISO8601 として解釈できません: ${JSON.stringify(stored.savedAt)}`);
    }

    let evicted: unknown;
    try {
      evicted = await client.eval(SAVE_SCRIPT, [runKey, summaryKey, indexKey], [
        JSON.stringify(stored),
        JSON.stringify(toSimulationRunSummary(stored)),
        String(score),
        runId,
        String(SIMULATION_RUN_RETENTION_LIMIT),
      ]);
    } catch (e) {
      throw new SimulationRunRepositoryError(`Simulation Run の保存に失敗しました（simulationRunId=${runId}）: ${toErrorMessage(e)}`);
    }

    // 追い出された実行の本体・要約を削除する（index からは Lua 側で既に外れている）。
    if (Array.isArray(evicted)) {
      for (const raw of evicted) {
        const evictedId = String(raw);
        if (evictedId === runId) continue;
        try {
          await client.del(simulationRunKeyV2(appEnv, evictedId));
          await client.del(simulationRunSummaryKeyV2(appEnv, evictedId));
        } catch {
          // 追い出しの後始末が失敗しても、保存そのものは成立している。
          // index からは既に外れているため一覧・読み込みには現れない（孤児キーが残るだけ）。
        }
      }
    }
  }

  async function loadRun(simulationRunId: string): Promise<StoredSimulationRun | null> {
    const key = simulationRunKeyV2(appEnv, simulationRunId);
    let raw: unknown;
    try {
      raw = await client.get(key);
    } catch (e) {
      throw new SimulationRunRepositoryError(`Simulation Run の読み込みに失敗しました（key=${key}）: ${toErrorMessage(e)}`);
    }
    if (raw === null || raw === undefined) return null;
    return parseStoredSimulationRun(raw, simulationRunId);
  }

  async function listRuns(limit = SIMULATION_RUN_RETENTION_LIMIT): Promise<readonly SimulationRunSummary[]> {
    const indexKey = simulationRunIndexKeyV2(appEnv);
    let ids: unknown[];
    try {
      ids = await client.zrange(indexKey, 0, -1);
    } catch (e) {
      throw new SimulationRunRepositoryError(`Simulation Run 一覧の読み込みに失敗しました（key=${indexKey}）: ${toErrorMessage(e)}`);
    }
    const summaries: SimulationRunSummary[] = [];
    for (const raw of ids) {
      const id = String(raw);
      let value: unknown;
      try {
        value = await client.get(simulationRunSummaryKeyV2(appEnv, id));
      } catch {
        continue; // 個別の要約が読めなくても一覧全体を落とさない
      }
      if (value === null || value === undefined) continue;
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      summaries.push(parsed as SimulationRunSummary);
    }
    return sortAndLimitSummaries(summaries, limit);
  }

  async function deleteRun(simulationRunId: string): Promise<void> {
    const runKey = simulationRunKeyV2(appEnv, simulationRunId);
    const summaryKey = simulationRunSummaryKeyV2(appEnv, simulationRunId);
    const indexKey = simulationRunIndexKeyV2(appEnv);
    assertAllowedSimulationRunKeys([runKey, summaryKey, indexKey], appEnv);
    try {
      await client.del(runKey);
      await client.del(summaryKey);
      await client.eval("redis.call('ZREM', KEYS[1], ARGV[1]) return 1", [indexKey], [simulationRunId]);
    } catch (e) {
      throw new SimulationRunRepositoryError(`Simulation Run の削除に失敗しました（simulationRunId=${simulationRunId}）: ${toErrorMessage(e)}`);
    }
  }

  return { saveRun, loadRun, listRuns, deleteRun };
}
