// ShrimpX V2 — 32Q Management Console Phase 2/Turn14 BLOCKER修正: Simulation Run の Redis Repository
//
// repository.ts の SimulationRunRepository 契約を、実際の Redis に対して実装する。
//
// 【Turn14以降Save/Resume停止BLOCKER修正・保存の分割】
// 旧実装は resumePayload + dataset + packCapture を1つのJSON valueへ束ね、
// 1本のLuaスクリプトで丸ごとSETしていた。実測（scripts配下の計測、baseline
// シナリオ）で、この束ねたJSONがTurn10で約4.46MB・Turn12で約5.03MBに達することを
// 確認した。Vercel Functionsのrequest body上限（既定約4.5MB）はクライアント→
// サーバーのHTTP POST自体をプラットフォーム側で拒否する制約であり、アプリケーション
// コードに到達する前に失敗する。dataset/packCaptureはAnalysis用の正史として
// O(turns)で成長し続ける設計（それ自体は正しい。指示§9のC/D）であるため、
// 1つのJSON・1回のrequestへ束ねたままでは32Qまで到達し得ない。
//
// このため、保存を revision でバージョニングした複数キーへ分割する
// （simulationRunRedisKeys.ts の simulationRunResumeKeyV2 / DatasetKeyV2 / PackKeyV2）。
// manifest（＝この関数群が書く simulationRunKeyV2、内容は小さい）は、resume/dataset/
// packの全パートを書き終えたあと最後にだけ更新する（指示§21/§22 atomic save /
// manifest方式）。manifestの更新に成功した時点で初めて、そのrevisionは「読み込み
// 可能な完全な状態」として保証される。
//
// 【後方互換】schemaVersion 1〜4のデータはこの分割より前に保存されており、
// manifestキーに直接 dataset 等が埋め込まれた「旧形式」である。loadRunは
// manifestを読んだ時点でdatasetが直接埋め込まれていればそれをそのまま使う
// （分割後のパートキーを探しに行かない）。

import { AppEnvV2 } from "../../../core/version";
import { CompanyLabRedisClient } from "../../../redis/companyLabTypes";
import {
  assertAllowedSimulationRunKeys,
  simulationRunDatasetKeyV2,
  simulationRunIndexKeyV2,
  simulationRunManifestKeyV2,
  simulationRunPackKeyV2,
  simulationRunResumeKeyV2,
  simulationRunSummaryKeyV2,
} from "../../../redis/simulationRunRedisKeys";
import {
  SIMULATION_RUN_RETENTION_LIMIT,
  SimulationRunPart,
  SimulationRunRepository,
  SimulationRunRepositoryError,
  SimulationRunSchemaError,
  assertStorableSimulationRun,
  sortAndLimitSummaries,
} from "./repository";
import { StoredSimulationRunManifest, SimulationRunSummary, StoredSimulationRun, isReadableSimulationRunSchema, toSimulationRunSummary } from "./types";

/**
 * manifest本体 + 要約 + index 追加 + 保存上限超過分の追い出しを一度に行う。
 * manifestは小さい（run metadata + revision + flagsのみ）ため、旧実装と同じ
 * Lua一括更新パターンを維持できる（このLua自体は巨大payload問題の対象ではない）。
 */
const SAVE_MANIFEST_SCRIPT = `
local manifestKey = KEYS[1]
local summaryKey = KEYS[2]
local indexKey = KEYS[3]
local manifestJson = ARGV[1]
local summaryJson = ARGV[2]
local score = tonumber(ARGV[3])
local runId = ARGV[4]
local limit = tonumber(ARGV[5])

redis.call('SET', manifestKey, manifestJson)
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

function parseJsonValue(raw: unknown): unknown {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/** 旧形式（分割前）のmanifest値かどうか — datasetが直接埋め込まれていれば旧形式。 */
function isLegacyEmbeddedManifest(value: unknown): value is StoredSimulationRun {
  return typeof value === "object" && value !== null && "dataset" in value && (value as { dataset?: unknown }).dataset !== undefined;
}

export function createRedisSimulationRunRepository(deps: SimulationRunRepositoryDependencies): SimulationRunRepository {
  const { client, appEnv } = deps;

  async function saveRunPart(simulationRunId: string, revision: number, part: SimulationRunPart, value: unknown): Promise<void> {
    const key =
      part === "dataset"
        ? simulationRunDatasetKeyV2(appEnv, simulationRunId, revision)
        : part === "resume"
          ? simulationRunResumeKeyV2(appEnv, simulationRunId, revision)
          : simulationRunPackKeyV2(appEnv, simulationRunId, revision);
    assertAllowedSimulationRunKeys([key], appEnv);
    try {
      await client.set(key, JSON.stringify(value));
    } catch (e) {
      throw new SimulationRunRepositoryError(
        `Simulation Run のパート保存に失敗しました（simulationRunId=${simulationRunId}, revision=${revision}, part=${part}）: ${toErrorMessage(e)}`
      );
    }
  }

  async function commitRunManifest(manifest: StoredSimulationRunManifest, summary: SimulationRunSummary): Promise<void> {
    const runId = manifest.run.simulationRunId;
    const revision = manifest.persistenceRevision;
    const manifestKey = simulationRunManifestKeyV2(appEnv, runId);
    const summaryKey = simulationRunSummaryKeyV2(appEnv, runId);
    const indexKey = simulationRunIndexKeyV2(appEnv);
    assertAllowedSimulationRunKeys([manifestKey, summaryKey, indexKey], appEnv);

    // 旧revisionを後始末するために、現在のmanifestを読んでおく（ベストエフォート）。
    let previousRevision: number | null = null;
    try {
      const rawPrevious = await client.get(manifestKey);
      if (rawPrevious !== null && rawPrevious !== undefined) {
        const parsedPrevious = parseJsonValue(rawPrevious);
        if (!isLegacyEmbeddedManifest(parsedPrevious)) {
          const asManifest = parsedPrevious as Partial<StoredSimulationRunManifest>;
          previousRevision = typeof asManifest.persistenceRevision === "number" ? asManifest.persistenceRevision : null;
        }
      }
    } catch {
      previousRevision = null;
    }

    const score = Date.parse(manifest.savedAt);
    if (!Number.isFinite(score)) {
      throw new SimulationRunRepositoryError(`savedAt が ISO8601 として解釈できません: ${JSON.stringify(manifest.savedAt)}`);
    }

    // manifestを更新する（＝このrevisionを「読み込み可能な完全な状態」として公開する。
    // 呼び出し側は、この呼び出しより前に該当revisionのパート全部をsaveRunPartで
    // 書き終えている前提。ここで失敗すれば旧revisionを指したままになり、
    // 新しいパートは「未公開」のまま残る＝指示§21 partial saveを正本化しない）。
    let evicted: unknown;
    try {
      evicted = await client.eval(SAVE_MANIFEST_SCRIPT, [manifestKey, summaryKey, indexKey], [
        JSON.stringify(manifest),
        JSON.stringify(summary),
        String(score),
        runId,
        String(SIMULATION_RUN_RETENTION_LIMIT),
      ]);
    } catch (e) {
      throw new SimulationRunRepositoryError(`Simulation Run のmanifest保存に失敗しました（simulationRunId=${runId}, revision=${revision}）: ${toErrorMessage(e)}`);
    }

    // 旧revisionのパートキーを後始末する（ベストエフォート。失敗しても保存自体は成立している）。
    if (previousRevision !== null && previousRevision !== revision) {
      try {
        await client.del(simulationRunDatasetKeyV2(appEnv, runId, previousRevision));
        await client.del(simulationRunResumeKeyV2(appEnv, runId, previousRevision));
        await client.del(simulationRunPackKeyV2(appEnv, runId, previousRevision));
      } catch {
        /* 孤児キーが残るだけ（既存方針と同じ）。 */
      }
    }

    // 保存上限を超えて追い出された実行の後始末（manifest/summaryに加え、判明していれば
    // そのrevisionのパートキーも消す。revisionが分からない場合はmanifest/summaryだけ消し、
    // 孤児のパートキーが残ることを許容する＝既存方針と同じ）。
    if (Array.isArray(evicted)) {
      for (const raw of evicted) {
        const evictedId = String(raw);
        if (evictedId === runId) continue;
        try {
          const evictedManifestKey = simulationRunManifestKeyV2(appEnv, evictedId);
          const rawEvictedManifest = await client.get(evictedManifestKey);
          const parsedEvicted = rawEvictedManifest !== null && rawEvictedManifest !== undefined ? parseJsonValue(rawEvictedManifest) : null;
          await client.del(evictedManifestKey);
          await client.del(simulationRunSummaryKeyV2(appEnv, evictedId));
          if (parsedEvicted && !isLegacyEmbeddedManifest(parsedEvicted)) {
            const evictedRevision = (parsedEvicted as Partial<StoredSimulationRunManifest>).persistenceRevision;
            if (typeof evictedRevision === "number") {
              await client.del(simulationRunDatasetKeyV2(appEnv, evictedId, evictedRevision));
              await client.del(simulationRunResumeKeyV2(appEnv, evictedId, evictedRevision));
              await client.del(simulationRunPackKeyV2(appEnv, evictedId, evictedRevision));
            }
          }
        } catch {
          // 追い出しの後始末が失敗しても、保存そのものは成立している。
          // index からは既に外れているため一覧・読み込みには現れない（孤児キーが残るだけ）。
        }
      }
    }
  }

  /**
   * 便宜メソッド（テスト・小さいpayload向け）。saveRunPart×最大3回 → commitRunManifest
   * と同じ意味を持つ。HTTP経由の保存では、これを1回のrequestで呼ぶのではなく、
   * API層がsaveRunPart/commitRunManifestを個別のrequestとして順に呼ぶ。
   */
  async function saveRun(stored: StoredSimulationRun): Promise<void> {
    assertStorableSimulationRun(stored);
    const revision = stored.persistenceRevision ?? 1;
    await saveRunPart(stored.run.simulationRunId, revision, "dataset", stored.dataset);
    if (stored.resumePayload !== undefined) await saveRunPart(stored.run.simulationRunId, revision, "resume", stored.resumePayload);
    if (stored.packCapture !== undefined) await saveRunPart(stored.run.simulationRunId, revision, "pack", stored.packCapture);
    await commitRunManifest(
      {
        schemaVersion: stored.schemaVersion,
        run: stored.run,
        persistenceRevision: revision,
        savedAt: stored.savedAt,
        hasResumePayload: stored.resumePayload !== undefined,
        hasPackCapture: stored.packCapture !== undefined,
      },
      toSimulationRunSummary(stored)
    );
  }

  async function loadRun(simulationRunId: string): Promise<StoredSimulationRun | null> {
    const manifestKey = simulationRunManifestKeyV2(appEnv, simulationRunId);
    let rawManifest: unknown;
    try {
      rawManifest = await client.get(manifestKey);
    } catch (e) {
      throw new SimulationRunRepositoryError(`Simulation Run の読み込みに失敗しました（key=${manifestKey}）: ${toErrorMessage(e)}`);
    }
    if (rawManifest === null || rawManifest === undefined) return null;
    const parsedManifest = parseJsonValue(rawManifest);

    // 旧形式（分割前）: manifestキーに直接dataset等が埋め込まれている。そのまま返す。
    if (isLegacyEmbeddedManifest(parsedManifest)) {
      if (!isReadableSimulationRunSchema(parsedManifest.schemaVersion)) {
        throw new SimulationRunSchemaError(
          `保存されていた Simulation Run のスキーマ版（${JSON.stringify(parsedManifest.schemaVersion)}）を読み込めません（simulationRunId=${simulationRunId}）。`
        );
      }
      return parsedManifest;
    }

    const manifest = parsedManifest as Partial<StoredSimulationRunManifest>;
    if (!isReadableSimulationRunSchema(manifest.schemaVersion) || !manifest.run || typeof manifest.persistenceRevision !== "number") {
      throw new SimulationRunSchemaError(`保存されていた Simulation Run のmanifestが壊れています（simulationRunId=${simulationRunId}）。`);
    }
    const revision = manifest.persistenceRevision;

    const datasetKey = simulationRunDatasetKeyV2(appEnv, simulationRunId, revision);
    let rawDataset: unknown;
    try {
      rawDataset = await client.get(datasetKey);
    } catch (e) {
      throw new SimulationRunRepositoryError(`Simulation Run の dataset 読み込みに失敗しました（key=${datasetKey}）: ${toErrorMessage(e)}`);
    }
    if (rawDataset === null || rawDataset === undefined) {
      throw new SimulationRunSchemaError(
        `manifestが指すrevision=${revision}のdatasetが見つかりません（simulationRunId=${simulationRunId}）。manifestとパートの不整合です。`
      );
    }
    const dataset = parseJsonValue(rawDataset);

    let resumePayload: unknown;
    if (manifest.hasResumePayload) {
      const resumeKey = simulationRunResumeKeyV2(appEnv, simulationRunId, revision);
      const rawResume = await client.get(resumeKey).catch((e) => {
        throw new SimulationRunRepositoryError(`Simulation Run の resumePayload 読み込みに失敗しました（key=${resumeKey}）: ${toErrorMessage(e)}`);
      });
      resumePayload = rawResume !== null && rawResume !== undefined ? parseJsonValue(rawResume) : undefined;
    }

    let packCapture: unknown;
    if (manifest.hasPackCapture) {
      const packKey = simulationRunPackKeyV2(appEnv, simulationRunId, revision);
      const rawPack = await client.get(packKey).catch((e) => {
        throw new SimulationRunRepositoryError(`Simulation Run の packCapture 読み込みに失敗しました（key=${packKey}）: ${toErrorMessage(e)}`);
      });
      packCapture = rawPack !== null && rawPack !== undefined ? parseJsonValue(rawPack) : undefined;
    }

    return {
      schemaVersion: manifest.schemaVersion as number,
      run: manifest.run,
      dataset: dataset as StoredSimulationRun["dataset"],
      resumePayload: resumePayload as StoredSimulationRun["resumePayload"],
      packCapture: packCapture as StoredSimulationRun["packCapture"],
      savedAt: manifest.savedAt ?? "",
      persistenceRevision: manifest.persistenceRevision,
    };
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
      summaries.push(parseJsonValue(value) as SimulationRunSummary);
    }
    return sortAndLimitSummaries(summaries, limit);
  }

  async function deleteRun(simulationRunId: string): Promise<void> {
    const manifestKey = simulationRunManifestKeyV2(appEnv, simulationRunId);
    const summaryKey = simulationRunSummaryKeyV2(appEnv, simulationRunId);
    const indexKey = simulationRunIndexKeyV2(appEnv);
    assertAllowedSimulationRunKeys([manifestKey, summaryKey, indexKey], appEnv);
    try {
      const rawManifest = await client.get(manifestKey);
      const parsedManifest = rawManifest !== null && rawManifest !== undefined ? parseJsonValue(rawManifest) : null;
      await client.del(manifestKey);
      await client.del(summaryKey);
      await client.eval("redis.call('ZREM', KEYS[1], ARGV[1]) return 1", [indexKey], [simulationRunId]);
      if (parsedManifest && !isLegacyEmbeddedManifest(parsedManifest)) {
        const revision = (parsedManifest as Partial<StoredSimulationRunManifest>).persistenceRevision;
        if (typeof revision === "number") {
          await client.del(simulationRunDatasetKeyV2(appEnv, simulationRunId, revision));
          await client.del(simulationRunResumeKeyV2(appEnv, simulationRunId, revision));
          await client.del(simulationRunPackKeyV2(appEnv, simulationRunId, revision));
        }
      }
    } catch (e) {
      throw new SimulationRunRepositoryError(`Simulation Run の削除に失敗しました（simulationRunId=${simulationRunId}）: ${toErrorMessage(e)}`);
    }
  }

  return { saveRun, saveRunPart, commitRunManifest, loadRun, listRuns, deleteRun };
}
