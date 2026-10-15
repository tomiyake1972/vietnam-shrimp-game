/**
 * 【FOT-1】Redis 実装のパート再利用（reuse）・差分追記（append）の実Redis検証。
 *
 * 【なぜ実Redisで確かめるのか】reuse は新しい Lua スクリプト
 * （SIMULATION_RUN_COPY_PART_TO_STAGING_SCRIPT）で動く。インメモリ実装の
 * テストでは Lua そのものを検証できない。また、このコードベースには
 * 「RENAME は残りTTLを引き継ぐため、昇格直後に PERSIST しないと正本が
 * 1時間で消える」という実測で見つかった落とし穴が記録されている
 * （redisRepository.ts のコメント）。reuse はその stagingキーを新しく作る経路なので、
 * 同じ落とし穴を踏んでいないことを PTTL で直接確かめる必要がある。
 *
 * 【隔離】このスクリプトが使うのは、呼び出し側が起動した一時 Redis だけ
 * （既定ポート 6402）。共有 Redis へは一切接続しない。
 * product コードも Lua も書き換えない。
 */
import { connectIsolatedRedis } from "./respClient";
import { createRedisSimulationRunRepository } from "../../app/lib/v2/companyLab/simulation/persistence/redisRepository";
import { createSimulationRunWriteToken } from "../../app/lib/v2/companyLab/simulation/persistence/repository";
import {
  CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
  StoredSimulationRunManifest,
  manifestToSimulationRunSummary,
} from "../../app/lib/v2/companyLab/simulation/persistence/types";
import { mergeSimulationRunPart, maxTurnOfSimulationRunPart, sliceSimulationRunPartAfterTurn } from "../../app/lib/v2/companyLab/simulation/persistence/partWire";
import { simulationRunDatasetKeyV2, simulationRunPackKeyV2 } from "../../app/lib/v2/redis/simulationRunRedisKeys";
import { SimulationRun } from "../../app/lib/v2/companyLab/simulation/types";

const PORT = Number(process.env.INT1_REDIS_PORT ?? 6402);
const APP_ENV = "staging" as const;
const AT = "2026-10-15T00:00:00.000Z";
const RUN_ID = "fot1-redis-run";

function fakeRun(completedTurns: number): SimulationRun {
  return {
    simulationRunId: RUN_ID,
    scenarioId: "baseline",
    scenarioVersion: "v1",
    seed: "seed",
    gameParameterVersion: "v1",
    standardAiVersion: "v1",
    strategyProfileVersion: "v1",
    startingTurn: 1,
    requestedTurns: 32,
    completedTurns,
    startedAt: AT,
    completedAt: null,
    stopReason: "running",
    errorMessage: null,
    failedAtTurn: null,
  };
}

function manifestFor(revision: number, completedTurns: number): StoredSimulationRunManifest {
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: fakeRun(completedTurns),
    persistenceRevision: revision,
    savedAt: new Date(Date.parse(AT) + revision * 1000).toISOString(),
    hasResumePayload: true,
    hasPackCapture: true,
  };
}

function datasetThrough(maxTurn: number) {
  const turns = Array.from({ length: maxTurn }, (_, i) => i + 1);
  return {
    schemaVersion: "simulationAnalytics-v1",
    turns,
    companies: [{ companyId: "BAL", displayName: "BAL", color: "#000" }],
    companyMetrics: turns.map((turn) => ({ turn, companyId: "BAL", metric: "revenue", value: turn * 100 })),
    marketMetrics: [],
    producerCountryMetrics: [],
    bottlenecks: [],
    aiTrace: [],
    salesTrace: [],
    hiringTrace: [],
    investmentTrace: [],
    contribution: [],
    fixedCosts: [],
    salesAllocation: [],
  };
}

function packThrough(maxTurn: number) {
  const turns = Array.from({ length: maxTurn }, (_, i) => i + 1);
  return {
    companyTurns: turns.map((turn) => ({ turn, companyId: "BAL", marker: `c${turn}` })),
    worldTurns: turns.map((turn) => ({ turn, marker: `w${turn}` })),
  };
}

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`PASS  ${label}  ${detail}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}  ${detail}`);
  }
}

async function main(): Promise<void> {
  const client = await connectIsolatedRedis(PORT);
  const repository = createRedisSimulationRunRepository({ client, appEnv: APP_ENV });

  try {
    await client.raw("FLUSHALL");

    // --- revision 1: 全量保存 ---
    const a1 = { expectedBaseRevision: 0, writeToken: createSimulationRunWriteToken("fot1") };
    await repository.saveRunPart(RUN_ID, a1, "dataset", datasetThrough(3));
    await repository.saveRunPart(RUN_ID, a1, "resume", { marker: "r1" });
    await repository.saveRunPart(RUN_ID, a1, "pack", packThrough(3));
    const m1 = manifestFor(1, 3);
    await repository.commitRunManifest(m1, manifestToSimulationRunSummary(m1), a1);

    // --- revision 2: dataset/pack は reuse、resume だけ全量 ---
    const a2 = { expectedBaseRevision: 1, writeToken: createSimulationRunWriteToken("fot1") };
    const copiedDataset = await repository.stagePartFromPublished(RUN_ID, a2, "dataset", 1);
    const copiedPack = await repository.stagePartFromPublished(RUN_ID, a2, "pack", 1);
    check("FOT-R1", copiedDataset && copiedPack, `公開済みパートのコピー dataset=${copiedDataset} pack=${copiedPack}`);
    await repository.saveRunPart(RUN_ID, a2, "resume", { marker: "r2" });
    const m2 = manifestFor(2, 3);
    await repository.commitRunManifest(m2, manifestToSimulationRunSummary(m2), a2);

    const afterReuse = await repository.loadRun(RUN_ID);
    check(
      "FOT-R2",
      JSON.stringify(afterReuse?.dataset) === JSON.stringify(datasetThrough(3)) &&
        JSON.stringify(afterReuse?.packCapture) === JSON.stringify(packThrough(3)),
      "reuse した dataset / pack が全量送信時と同一"
    );
    check("FOT-R3", afterReuse?.persistenceRevision === 2 && JSON.stringify(afterReuse?.resumePayload) === JSON.stringify({ marker: "r2" }), `revision=${afterReuse?.persistenceRevision} / resume のみ更新`);

    /**
     * 【落とし穴の確認】reuse は staging キーを PX（1時間）付きで作る。commit の Lua が
     * RENAME 後に PERSIST しなければ、昇格した正本が1時間で消える。
     * PTTL が -1（TTL無し）であることを直接確かめる。
     */
    const datasetPttl = await client.raw("PTTL", simulationRunDatasetKeyV2(APP_ENV, RUN_ID, 2));
    const packPttl = await client.raw("PTTL", simulationRunPackKeyV2(APP_ENV, RUN_ID, 2));
    check("FOT-R4", Number(datasetPttl) === -1 && Number(packPttl) === -1, `昇格後の正規キーにTTLが無い dataset PTTL=${String(datasetPttl)} pack PTTL=${String(packPttl)}`);

    // --- revision 3: pack は append、dataset は全量 ---
    const a3 = { expectedBaseRevision: 2, writeToken: createSimulationRunWriteToken("fot1") };
    const fullPack = packThrough(5);
    const publishedPack = await repository.readPublishedPart(RUN_ID, "pack", 2);
    const delta = sliceSimulationRunPartAfterTurn("pack", fullPack, 3);
    const merged = mergeSimulationRunPart("pack", publishedPack, delta);
    check("FOT-R5", maxTurnOfSimulationRunPart("pack", merged) === 5, `差分マージ後の最大turn=${maxTurnOfSimulationRunPart("pack", merged)}`);
    await repository.saveRunPart(RUN_ID, a3, "dataset", datasetThrough(5));
    await repository.saveRunPart(RUN_ID, a3, "resume", { marker: "r3" });
    await repository.saveRunPart(RUN_ID, a3, "pack", merged);
    const m3 = manifestFor(3, 5);
    await repository.commitRunManifest(m3, manifestToSimulationRunSummary(m3), a3);

    const afterAppend = await repository.loadRun(RUN_ID);
    check("FOT-R6", JSON.stringify(afterAppend?.packCapture) === JSON.stringify(fullPack), "append 後の pack が全量ビルドと同一");

    // --- 土台が無い reuse は false（呼び出し側が全量送信へ切り替える根拠） ---
    const a4 = { expectedBaseRevision: 3, writeToken: createSimulationRunWriteToken("fot1") };
    const missing = await repository.stagePartFromPublished(RUN_ID, a4, "dataset", 1);
    check("FOT-R7", missing === false, `古いrevision(1)からの reuse は false（実際=${missing}）`);

    const absent = await repository.stagePartFromPublished("no-such-run", a4, "dataset", 1);
    check("FOT-R8", absent === false, `存在しないRunからの reuse は false（実際=${absent}）`);
  } finally {
    await client.close();
  }

  console.log("");
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  if (failures > 0) process.exitCode = 1;
}

void main();
