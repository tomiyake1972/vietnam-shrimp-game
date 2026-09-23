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
  simulationRunStagingPartKeyV2,
  simulationRunSummaryKeyV2,
} from "../../../redis/simulationRunRedisKeys";
import {
  SIMULATION_RUN_RETENTION_LIMIT,
  SimulationRunPart,
  SimulationRunRepository,
  SimulationRunRepositoryError,
  SimulationRunSchemaError,
  SimulationRunStaleRevisionError,
  SimulationRunWriteAttempt,
  assertStorableSimulationRun,
  createSimulationRunWriteToken,
  sortAndLimitSummaries,
} from "./repository";
import { StoredSimulationRunManifest, SimulationRunSummary, StoredSimulationRun, isReadableSimulationRunSchema, toSimulationRunSummary } from "./types";

/**
 * manifest本体 + 要約 + index 追加 + 保存上限超過分の追い出しを一度に行う。
 * manifestは小さい（run metadata + revision + flagsのみ）ため、旧実装と同じ
 * Lua一括更新パターンを維持できる（このLua自体は巨大payload問題の対象ではない）。
 */
/**
 * 【O1・テストからの参照用にexportする】フェイククライアントがこのスクリプト定数と
 * 一致することで本物の保存経路だと判別し、Luaと論理的に同じ手順を再現する
 * （会社ラボ側 atomicCommit.ts が同じ理由でスクリプトをexportしているのと同じ方式）。
 */
export const SIMULATION_RUN_SAVE_MANIFEST_SCRIPT = `
-- 【O1・原子的CAS + パート昇格】
-- KEYS: 1 manifest, 2 summary, 3 index,
--       4 staging dataset, 5 staging resume, 6 staging pack,
--       7 canonical dataset, 8 canonical resume, 9 canonical pack
-- ARGV: 1 manifestJson, 2 summaryJson, 3 score, 4 runId, 5 limit,
--       6 expectedBaseRevision, 7 hasResume("1"/"0"), 8 hasPack("1"/"0")
--
-- 「現在公開中のrevisionを読む → 比較する → 書く」を1回のLuaで行う。
-- 別々のnetwork callへ分けると、その隙間に他のwriterが公開してしまう。
local manifestKey = KEYS[1]
local summaryKey = KEYS[2]
local indexKey = KEYS[3]
local manifestJson = ARGV[1]
local summaryJson = ARGV[2]
local score = tonumber(ARGV[3])
local runId = ARGV[4]
local limit = tonumber(ARGV[5])
local expectedBase = tonumber(ARGV[6])
local hasResume = ARGV[7] == '1'
local hasPack = ARGV[8] == '1'

-- 0. 【書き込み前に全部検査しきる】Redisのスクリプトは途中でエラーになっても、
--    それまでに実行した書き込みを巻き戻さない（Luaに自動rollbackは無い）。
--    そのため「RENAMEやSETを始めたあとでエラーになり得る要素」を、
--    書き込みが1つも起きていないこの位置で先に弾いておく。
if score == nil or limit == nil or expectedBase == nil then
  return { 'INVALID_ARGS' }
end

-- 1. 現在公開中のrevisionを取得する（保存物が無い / revisionを持たない旧Runは0）。
local published = 0
local currentRaw = redis.call('GET', manifestKey)
if currentRaw then
  local ok, parsed = pcall(cjson.decode, currentRaw)
  if ok and type(parsed) == 'table' and type(parsed.persistenceRevision) == 'number' then
    published = parsed.persistenceRevision
  end
end

-- 2. 基準がずれていれば何も変更しない（古い正本を新しい正本へ被せない）。
if published ~= expectedBase then
  return { 'CONFLICT', tostring(published) }
end

-- 3. このattemptの未公開パートが揃っているか確認する（部分保存を正本化しない）。
if redis.call('EXISTS', KEYS[4]) == 0 then return { 'MISSING_PART', 'dataset' } end
if hasResume and redis.call('EXISTS', KEYS[5]) == 0 then return { 'MISSING_PART', 'resume' } end
if hasPack and redis.call('EXISTS', KEYS[6]) == 0 then return { 'MISSING_PART', 'pack' } end

-- 4. このattemptのパートだけを正規キーへ昇格させる。敗者のstagingは触らない。
redis.call('RENAME', KEYS[4], KEYS[7])
if hasResume then redis.call('RENAME', KEYS[5], KEYS[8]) end
if hasPack then redis.call('RENAME', KEYS[6], KEYS[9]) end

-- 5. manifestを公開する（ここで初めてこのrevisionが読み込み可能になる）。
redis.call('SET', manifestKey, manifestJson)
redis.call('SET', summaryKey, summaryJson)
redis.call('ZADD', indexKey, score, runId)

local total = redis.call('ZCARD', indexKey)
local excess = total - limit
if excess <= 0 then
  return { 'OK' }
end
local evicted = redis.call('ZRANGE', indexKey, 0, excess - 1)
local result = { 'OK' }
for i = 1, #evicted do
  redis.call('ZREM', indexKey, evicted[i])
  result[#result + 1] = evicted[i]
end
return result
`;

/**
 * 【O1・孤児stagingキーの寿命】未公開パートの置き場にはTTLを付ける。
 *
 * CAS conflict / パート欠落 / manifest commit失敗 / クライアント切断 / retry中断 では、
 * そのattemptのstagingキーは昇格されずに残る（＝孤児）。孤児が残ること自体は
 * 公開正本に影響しないが、TTLが無いと無制限に溜まり続ける。
 * 既存のRedis SET PX（processingLock.tsが使っているのと同じ仕組み）を使って寿命を切る。
 * 新しいcleanup worker・SCAN全体処理・migrationは追加しない。
 *
 * 1時間: 正常な保存は数秒で完了する（パート3本のPOST＋manifest commit）。
 * 32Qの大きなdatasetでも桁違いに短い。これを超えて未commitのまま残っている
 * stagingは、既に失敗したattemptのものと判断してよい。
 * 逆に短すぎると、アップロード中にTTLが切れてcommitがMISSING_PARTになるため、
 * 「正常系が絶対に触れない」長さを取る。
 */
export const SIMULATION_RUN_STAGING_TTL_MS = 60 * 60 * 1000;

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

  async function saveRunPart(simulationRunId: string, attempt: SimulationRunWriteAttempt, part: SimulationRunPart, value: unknown): Promise<void> {
    /**
     * 【O1】未公開パートはattempt固有のstagingキーへ書く。
     * 正規キー（:dataset:{revision} 等）へ直接書いていた頃は、同じ正本を読んだ
     * 2つのwriterが同じrevision番号を選んで同じキーを奪い合い、
     * manifest CASで負けた側が勝った側のパートを壊していた。
     * 正規キーの形・内容は変えていないため、既存Runの読み出しは不変（migration不要）。
     */
    const key = simulationRunStagingPartKeyV2(appEnv, simulationRunId, attempt.writeToken, part);
    assertAllowedSimulationRunKeys([key], appEnv);
    try {
      // TTLを付けて、昇格されなかった孤児が無制限に残らないようにする。
      await client.set(key, JSON.stringify(value), { pxMilliseconds: SIMULATION_RUN_STAGING_TTL_MS });
    } catch (e) {
      throw new SimulationRunRepositoryError(
        `Simulation Run のパート保存に失敗しました（simulationRunId=${simulationRunId}, writeToken=${attempt.writeToken}, part=${part}）: ${toErrorMessage(e)}`
      );
    }
  }

  async function commitRunManifest(manifest: StoredSimulationRunManifest, summary: SimulationRunSummary, attempt: SimulationRunWriteAttempt): Promise<void> {
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
    const stagingKeys = (["dataset", "resume", "pack"] as const).map((part) => simulationRunStagingPartKeyV2(appEnv, runId, attempt.writeToken, part));
    const canonicalKeys = [
      simulationRunDatasetKeyV2(appEnv, runId, revision),
      simulationRunResumeKeyV2(appEnv, runId, revision),
      simulationRunPackKeyV2(appEnv, runId, revision),
    ];
    assertAllowedSimulationRunKeys([...stagingKeys, ...canonicalKeys], appEnv);

    let outcome: unknown;
    try {
      outcome = await client.eval(
        SIMULATION_RUN_SAVE_MANIFEST_SCRIPT,
        [manifestKey, summaryKey, indexKey, ...stagingKeys, ...canonicalKeys],
        [
          JSON.stringify(manifest),
          JSON.stringify(summary),
          String(score),
          runId,
          String(SIMULATION_RUN_RETENTION_LIMIT),
          String(attempt.expectedBaseRevision),
          manifest.hasResumePayload ? "1" : "0",
          manifest.hasPackCapture ? "1" : "0",
        ]
      );
    } catch (e) {
      throw new SimulationRunRepositoryError(`Simulation Run のmanifest保存に失敗しました（simulationRunId=${runId}, revision=${revision}）: ${toErrorMessage(e)}`);
    }

    // Luaの戻り値の先頭が結果コード。CONFLICT なら公開状態は一切変わっていない。
    const asArray = Array.isArray(outcome) ? outcome : [];
    const status = String(asArray[0] ?? "");
    if (status === "CONFLICT") {
      throw new SimulationRunStaleRevisionError(runId, attempt.expectedBaseRevision, Number(asArray[1] ?? 0));
    }
    if (status === "INVALID_ARGS") {
      throw new SimulationRunRepositoryError(
        `Simulation Run のmanifest保存へ不正な引数が渡されました（simulationRunId=${runId}, revision=${revision}）。保存は行われていません。`
      );
    }
    if (status === "MISSING_PART") {
      throw new SimulationRunRepositoryError(
        `Simulation Run の保存パートが揃っていません（simulationRunId=${runId}, revision=${revision}, part=${String(asArray[1] ?? "?")}）。`
      );
    }
    if (status !== "OK") {
      throw new SimulationRunRepositoryError(`Simulation Run のmanifest保存が想定外の結果を返しました（simulationRunId=${runId}）: ${JSON.stringify(outcome)}`);
    }
    const evicted = asArray.slice(1);

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
  /**
   * 【O1】現在公開中のrevision（保存物が無い / revisionを持たない旧Runは0）。
   * 書き手はこれを expectedBaseRevision として保存attemptに載せる。
   */
  async function currentPublishedRevision(simulationRunId: string): Promise<number> {
    const manifestKey = simulationRunManifestKeyV2(appEnv, simulationRunId);
    let raw: unknown;
    try {
      raw = await client.get(manifestKey);
    } catch (e) {
      throw new SimulationRunRepositoryError(`Simulation Run のrevision確認に失敗しました（key=${manifestKey}）: ${toErrorMessage(e)}`);
    }
    if (raw === null || raw === undefined) return 0;
    const parsed = parseJsonValue(raw) as Partial<StoredSimulationRunManifest>;
    return typeof parsed?.persistenceRevision === "number" ? parsed.persistenceRevision : 0;
  }

  async function saveRun(stored: StoredSimulationRun, attempt?: SimulationRunWriteAttempt): Promise<void> {
    assertStorableSimulationRun(stored);
    const runId = stored.run.simulationRunId;
    // 【attempt省略時】その場で公開中revisionを読み、それを基準にする（テスト・旧形式保存向け）。
    const base = attempt?.expectedBaseRevision ?? (await currentPublishedRevision(runId));
    const effective: SimulationRunWriteAttempt = {
      expectedBaseRevision: base,
      writeToken: attempt?.writeToken ?? createSimulationRunWriteToken("inline"),
    };
    const revision = stored.persistenceRevision ?? base + 1;
    await saveRunPart(runId, effective, "dataset", stored.dataset);
    if (stored.resumePayload !== undefined) await saveRunPart(runId, effective, "resume", stored.resumePayload);
    if (stored.packCapture !== undefined) await saveRunPart(runId, effective, "pack", stored.packCapture);
    await commitRunManifest(
      {
        schemaVersion: stored.schemaVersion,
        run: stored.run,
        persistenceRevision: revision,
        savedAt: stored.savedAt,
        hasResumePayload: stored.resumePayload !== undefined,
        hasPackCapture: stored.packCapture !== undefined,
      },
      toSimulationRunSummary(stored),
      effective
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

  return { saveRun, saveRunPart, commitRunManifest, loadRun, listRuns, deleteRun, currentPublishedRevision };
}
