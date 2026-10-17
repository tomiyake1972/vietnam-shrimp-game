/**
 * 【REUSE-1】Redis 実装のパート再利用の実Redis検証。
 *
 * 【なぜ実Redisで確かめるのか】再利用は新しい Lua スクリプト
 * （SIMULATION_RUN_COPY_PART_TO_STAGING_SCRIPT）で動く。インメモリ実装のテストでは
 * Lua 自体を検証できない。またこのコードベースには「RENAME は残りTTLを引き継ぐため、
 * 昇格直後に PERSIST しないと正本が1時間で消える」という実測で見つかった落とし穴が
 * 記録されている（redisRepository.ts のコメント）。再利用は stagingキーを新しく作る
 * 経路なので、同じ落とし穴を踏んでいないことを PTTL で直接確かめる必要がある。
 *
 * 【隔離】呼び出し側が起動した一時 Redis だけを使う（既定ポート 6403）。
 * 共有 Redis へは一切接続しない。product コードも Lua も書き換えない。
 *
 * 使い方:
 *   redis-server --port 6403 --dir <tmp> --save '' --appendonly no --daemonize yes
 *   INT1_REDIS_PORT=6403 npx tsx scripts/int1/reuse1IsolatedRedis.ts
 */
import { connectIsolatedRedis } from "./respClient";
import { createRedisSimulationRunRepository, SIMULATION_RUN_STAGING_TTL_MS } from "../../app/lib/v2/companyLab/simulation/persistence/redisRepository";
import { createSimulationRunWriteToken } from "../../app/lib/v2/companyLab/simulation/persistence/repository";
import {
  CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
  StoredSimulationRunManifest,
  manifestToSimulationRunSummary,
} from "../../app/lib/v2/companyLab/simulation/persistence/types";
import {
  simulationRunDatasetKeyV2,
  simulationRunManifestKeyV2,
  simulationRunPackKeyV2,
  simulationRunStagingPartKeyV2,
} from "../../app/lib/v2/redis/simulationRunRedisKeys";
import { SimulationRunStaleRevisionError } from "../../app/lib/v2/companyLab/simulation/persistence/repository";
import { SimulationRun } from "../../app/lib/v2/companyLab/simulation/types";

const PORT = Number(process.env.INT1_REDIS_PORT ?? 6403);
const APP_ENV = "staging" as const;
const AT = "2026-10-16T00:00:00.000Z";
const RUN_ID = "reuse1-redis-run";

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
    const a1 = { expectedBaseRevision: 0, writeToken: createSimulationRunWriteToken("reuse1") };
    await repository.saveRunPart(RUN_ID, a1, "dataset", datasetThrough(3));
    await repository.saveRunPart(RUN_ID, a1, "resume", { marker: "r1" });
    await repository.saveRunPart(RUN_ID, a1, "pack", packThrough(3));
    const m1 = manifestFor(1, 3);
    await repository.commitRunManifest(m1, manifestToSimulationRunSummary(m1), a1);

    // --- revision 2: dataset/pack は再利用、resume だけ全量 ---
    const a2 = { expectedBaseRevision: 1, writeToken: createSimulationRunWriteToken("reuse1") };
    const copiedDataset = await repository.stagePartFromPublished(RUN_ID, a2, "dataset", 1);
    const copiedPack = await repository.stagePartFromPublished(RUN_ID, a2, "pack", 1);
    check("REUSE-R1", copiedDataset && copiedPack, `公開済みパートのコピー dataset=${copiedDataset} pack=${copiedPack}`);

    /**
     * 【昇格前のstagingキーにはTTLが付いていること】孤児が無制限に残らないための既存方針。
     * 再利用で作ったstagingキーも同じ扱いになっていることを確認する。
     */
    const stagingPttl = await client.raw("PTTL", simulationRunStagingPartKeyV2(APP_ENV, RUN_ID, a2.writeToken, "dataset"));
    const stagingTtlOk = Number(stagingPttl) > 0 && Number(stagingPttl) <= SIMULATION_RUN_STAGING_TTL_MS;
    check("REUSE-R2", stagingTtlOk, `再利用で作ったstagingキーのPTTL=${String(stagingPttl)}（上限 ${SIMULATION_RUN_STAGING_TTL_MS}）`);

    await repository.saveRunPart(RUN_ID, a2, "resume", { marker: "r2" });
    const m2 = manifestFor(2, 3);
    await repository.commitRunManifest(m2, manifestToSimulationRunSummary(m2), a2);

    const afterReuse = await repository.loadRun(RUN_ID);
    check(
      "REUSE-R3",
      JSON.stringify(afterReuse?.dataset) === JSON.stringify(datasetThrough(3)) &&
        JSON.stringify(afterReuse?.packCapture) === JSON.stringify(packThrough(3)),
      "再利用した dataset / pack が全量送信時と同一"
    );
    check(
      "REUSE-R4",
      afterReuse?.persistenceRevision === 2 && JSON.stringify(afterReuse?.resumePayload) === JSON.stringify({ marker: "r2" }),
      `revision=${afterReuse?.persistenceRevision} / resume だけ更新されている`
    );

    /**
     * 【落とし穴の確認】昇格した正規キーは永続でなければならない。
     * commit の Lua が RENAME 後に PERSIST しているので PTTL は -1 になる。
     */
    const datasetPttl = await client.raw("PTTL", simulationRunDatasetKeyV2(APP_ENV, RUN_ID, 2));
    const packPttl = await client.raw("PTTL", simulationRunPackKeyV2(APP_ENV, RUN_ID, 2));
    check("REUSE-R5", Number(datasetPttl) === -1 && Number(packPttl) === -1, `昇格後の正規キーにTTLが無い dataset PTTL=${String(datasetPttl)} pack PTTL=${String(packPttl)}`);

    // --- 土台が無い／古い場合は false（呼び出し側が全量送信へ切り替える根拠） ---
    const a3 = { expectedBaseRevision: 2, writeToken: createSimulationRunWriteToken("reuse1") };
    const stale = await repository.stagePartFromPublished(RUN_ID, a3, "dataset", 1);
    check("REUSE-R6", stale === false, `古いrevision(1)からの再利用は false（実際=${stale}）`);

    const absent = await repository.stagePartFromPublished("no-such-run", a3, "dataset", 1);
    check("REUSE-R7", absent === false, `存在しないRunからの再利用は false（実際=${absent}）`);

    /**
     * 【再利用を繰り返しても中身が劣化しないこと】revision を3回進め、
     * そのあいだ dataset/pack は一度も送らない。
     */
    let base = 2;
    for (let i = 0; i < 3; i += 1) {
      const a = { expectedBaseRevision: base, writeToken: createSimulationRunWriteToken("reuse1") };
      const okDataset = await repository.stagePartFromPublished(RUN_ID, a, "dataset", base);
      const okPack = await repository.stagePartFromPublished(RUN_ID, a, "pack", base);
      if (!okDataset || !okPack) {
        check("REUSE-R8", false, `${i + 1}回目の再利用でコピー元が見つからなかった`);
        break;
      }
      await repository.saveRunPart(RUN_ID, a, "resume", { marker: `chain-${i}` });
      const m = manifestFor(base + 1, 3);
      await repository.commitRunManifest(m, manifestToSimulationRunSummary(m), a);
      base += 1;
    }
    const chained = await repository.loadRun(RUN_ID);
    check(
      "REUSE-R8",
      chained?.persistenceRevision === 5 &&
        JSON.stringify(chained?.dataset) === JSON.stringify(datasetThrough(3)) &&
        JSON.stringify(chained?.packCapture) === JSON.stringify(packThrough(3)),
      `再利用を3回連鎖しても中身は同一（revision=${chained?.persistenceRevision}）`
    );
    const chainedPttl = await client.raw("PTTL", simulationRunDatasetKeyV2(APP_ENV, RUN_ID, 5));
    check("REUSE-R9", Number(chainedPttl) === -1, `連鎖後の正規キーも永続 PTTL=${String(chainedPttl)}`);

    /**
     * 【受入前の指摘2】古いパートのキーが残っていても、公開中revisionと食い違えば
     * 再利用を拒否すること。commitRunManifest の旧revision削除はベストエフォートなので
     * 孤児キーは現実に残り得る。ここでは孤児を意図的に作って検証する。
     * （product コードは変更していない。テスト側から外部的にキーを置くだけ。）
     */
    const published = 5;
    const orphanRevision = published - 1;
    const orphanKey = simulationRunDatasetKeyV2(APP_ENV, RUN_ID, orphanRevision);
    await client.set(orphanKey, JSON.stringify(datasetThrough(99)));
    const orphanExists = Number(await client.raw("EXISTS", orphanKey)) === 1;

    const aOrphan = { expectedBaseRevision: orphanRevision, writeToken: createSimulationRunWriteToken("reuse1") };
    const fromOrphan = await repository.stagePartFromPublished(RUN_ID, aOrphan, "dataset", orphanRevision);
    check(
      "REUSE-R10",
      orphanExists && fromOrphan === false,
      `孤児キーが存在（EXISTS=${orphanExists}）しても、公開中revision(${published})と違う${orphanRevision}からの再利用は false（実際=${fromOrphan}）`
    );

    /**
     * fromRevision は公開中と一致するが expectedBaseRevision が食い違う場合も拒否すること
     * （三者一致を要求する契約）。
     */
    const aMixed = { expectedBaseRevision: orphanRevision, writeToken: createSimulationRunWriteToken("reuse1") };
    const mixed = await repository.stagePartFromPublished(RUN_ID, aMixed, "dataset", published);
    check("REUSE-R11", mixed === false, `fromRevision=${published} / expectedBaseRevision=${orphanRevision} の不整合は false（実際=${mixed}）`);

    /** 逆向きの不整合（expectedBaseRevision は公開中と一致、fromRevision が古い）も拒否。 */
    const aMixed2 = { expectedBaseRevision: published, writeToken: createSimulationRunWriteToken("reuse1") };
    const mixed2 = await repository.stagePartFromPublished(RUN_ID, aMixed2, "dataset", orphanRevision);
    check("REUSE-R12", mixed2 === false, `fromRevision=${orphanRevision} / expectedBaseRevision=${published} の不整合は false（実際=${mixed2}）`);

    /** 孤児キーの内容が正本へ混入していないこと（拒否されたので当然だが明示して確認する）。 */
    const afterOrphan = await repository.loadRun(RUN_ID);
    check(
      "REUSE-R13",
      JSON.stringify(afterOrphan?.dataset) === JSON.stringify(datasetThrough(3)) && afterOrphan?.persistenceRevision === published,
      `孤児の内容が正本へ混入していない（revision=${afterOrphan?.persistenceRevision}）`
    );
    await client.del(orphanKey);

    /**
     * 【manifest公開時のCASが維持されていること】再利用でパートを置いたあとでも、
     * 基準がずれた commit は拒否される。
     */
    const aWin = { expectedBaseRevision: published, writeToken: createSimulationRunWriteToken("reuse1") };
    const aLose = { expectedBaseRevision: published, writeToken: createSimulationRunWriteToken("reuse1") };
    for (const a of [aWin, aLose]) {
      const okD = await repository.stagePartFromPublished(RUN_ID, a, "dataset", published);
      const okP = await repository.stagePartFromPublished(RUN_ID, a, "pack", published);
      if (!okD || !okP) {
        check("REUSE-R14", false, "CAS検証の準備で再利用に失敗した");
        break;
      }
      await repository.saveRunPart(RUN_ID, a, "resume", { marker: a.writeToken });
    }
    const mWin = manifestFor(published + 1, 3);
    await repository.commitRunManifest(mWin, manifestToSimulationRunSummary(mWin), aWin);
    let loserRejected = false;
    try {
      await repository.commitRunManifest(mWin, manifestToSimulationRunSummary(mWin), aLose);
    } catch (e) {
      loserRejected = e instanceof SimulationRunStaleRevisionError;
    }
    const afterCas = await repository.loadRun(RUN_ID);
    check(
      "REUSE-R14",
      loserRejected && JSON.stringify(afterCas?.resumePayload) === JSON.stringify({ marker: aWin.writeToken }),
      `再利用後も manifest CAS は維持（敗者を拒否=${loserRejected}、正本は勝者の内容）`
    );

    /** manifest が壊れている／無い場合も再利用しないこと（捏造した revision で通さない）。 */
    const manifestKey = simulationRunManifestKeyV2(APP_ENV, RUN_ID);
    const savedManifest = await client.get(manifestKey);
    await client.set(manifestKey, "{not json");
    const aBroken = { expectedBaseRevision: published + 1, writeToken: createSimulationRunWriteToken("reuse1") };
    const broken = await repository.stagePartFromPublished(RUN_ID, aBroken, "dataset", published + 1);
    check("REUSE-R15", broken === false, `manifest が壊れている場合の再利用は false（実際=${broken}）`);
    await client.set(manifestKey, String(savedManifest));
  } finally {
    await client.close();
  }

  console.log("");
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  if (failures > 0) process.exitCode = 1;
}

void main();
