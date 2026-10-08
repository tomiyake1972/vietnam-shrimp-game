/**
 * 【INT-1 §5】TTL実Redis相当試験。
 *
 * 隔離ローカルRedis（このスクリプトが起動した一時インスタンス）だけを使う。
 * product constant（SIMULATION_RUN_STAGING_TTL_MS = 1時間）は変更しない。
 * 「staging TTL相当時間の経過後も公開済みcanonical Runを読める」ことは、
 * product の saveRunPart が付けたTTLを **テスト側から外部的に PEXPIRE で短縮**して
 * から commit し、その短縮TTLを超えて待ってから loadRun することで実測する
 * （productコードもLuaも書き換えない）。
 */
import { connectIsolatedRedis } from "./respClient";
import { createRedisSimulationRunRepository, SIMULATION_RUN_STAGING_TTL_MS } from "../../app/lib/v2/companyLab/simulation/persistence/redisRepository";
import {
  SimulationRunStaleRevisionError,
  createSimulationRunWriteToken,
} from "../../app/lib/v2/companyLab/simulation/persistence/repository";
import {
  CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
  StoredSimulationRunManifest,
  manifestToSimulationRunSummary,
} from "../../app/lib/v2/companyLab/simulation/persistence/types";
import {
  simulationRunDatasetKeyV2,
  simulationRunResumeKeyV2,
  simulationRunPackKeyV2,
  simulationRunManifestKeyV2,
  simulationRunStagingPartKeyV2,
} from "../../app/lib/v2/redis/simulationRunRedisKeys";
import { SimulationRun } from "../../app/lib/v2/companyLab/simulation/types";

const PORT = Number(process.env.INT1_REDIS_PORT ?? 6401);
const APP_ENV = "staging" as const;
const AT = "2026-10-06T00:00:00.000Z";

function fakeRun(id: string, completedTurns: number): SimulationRun {
  return {
    simulationRunId: id,
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
    stopReason: "completed",
    errorMessage: null,
    failedAtTurn: null,
  };
}

function manifestFor(id: string, revision: number, completedTurns: number, hasPack: boolean): StoredSimulationRunManifest {
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: fakeRun(id, completedTurns),
    persistenceRevision: revision,
    savedAt: new Date(Date.parse(AT) + revision * 1000).toISOString(),
    hasResumePayload: true,
    hasPackCapture: hasPack,
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
  await client.raw("FLUSHALL");
  console.log(`# isolated redis 127.0.0.1:${PORT} / appEnv=${APP_ENV}`);
  console.log(`# product SIMULATION_RUN_STAGING_TTL_MS = ${SIMULATION_RUN_STAGING_TTL_MS} (未変更)`);
  console.log(`# CURRENT_SIMULATION_RUN_PERSISTED_VERSION = ${CURRENT_SIMULATION_RUN_PERSISTED_VERSION}`);

  const repo = createRedisSimulationRunRepository({ client, appEnv: APP_ENV });
  const pttl = async (key: string): Promise<number> => Number(await client.raw("PTTL", key));

  // ---------- 試験1〜3, 5, 6: product経路で保存し、TTLの所在を実測 ----------
  const id1 = "int1-ttl-a";
  const tokenA = createSimulationRunWriteToken("int1a");
  const attemptA = { expectedBaseRevision: 0, writeToken: tokenA };
  await repo.saveRunPart(id1, attemptA, "dataset", { marker: "ds-A", schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION });
  await repo.saveRunPart(id1, attemptA, "resume", { marker: "rs-A" });
  await repo.saveRunPart(id1, attemptA, "pack", { marker: "pk-A" });

  const stDs = simulationRunStagingPartKeyV2(APP_ENV, id1, tokenA, "dataset");
  const stRs = simulationRunStagingPartKeyV2(APP_ENV, id1, tokenA, "resume");
  const stPk = simulationRunStagingPartKeyV2(APP_ENV, id1, tokenA, "pack");
  const sd = await pttl(stDs);
  const sr = await pttl(stRs);
  const sp = await pttl(stPk);
  check("試験1 stagingにTTLがある", sd > 0 && sr > 0 && sp > 0, `staging PTTL = ${sd} / ${sr} / ${sp} ms`);

  // 試験2: RENAMEでTTLがdestinationへ継承される（Redis素の挙動。別キーで直接実測）
  await client.raw("SET", "int1:ttlprobe:src", "v", "PX", 3600000);
  const probeSrc = await pttl("int1:ttlprobe:src");
  await client.raw("RENAME", "int1:ttlprobe:src", "int1:ttlprobe:dst");
  const probeDst = await pttl("int1:ttlprobe:dst");
  check("試験2 RENAMEはTTLをdestinationへ継承する", probeDst > 0, `src PTTL=${probeSrc} → RENAME後 dst PTTL=${probeDst}（-1ではない）`);
  const persistRet = Number(await client.raw("PERSIST", "int1:ttlprobe:dst"));
  const afterPersist = await pttl("int1:ttlprobe:dst");
  check("試験3 PERSISTでTTLが消える", persistRet === 1 && afterPersist === -1, `PERSIST戻り値=${persistRet}, 直後のPTTL=${afterPersist}`);
  const persistRet2 = Number(await client.raw("PERSIST", "int1:ttlprobe:dst"));
  check("試験3b TTLが無いキーへのPERSISTは0を返す（失敗ではない）", persistRet2 === 0, `PERSIST戻り値=${persistRet2}`);
  await client.raw("DEL", "int1:ttlprobe:dst");

  // 公開（commit）
  const m1 = manifestFor(id1, 1, 4, true);
  await repo.commitRunManifest(m1, manifestToSimulationRunSummary(m1), attemptA);

  const caDs = simulationRunDatasetKeyV2(APP_ENV, id1, 1);
  const caRs = simulationRunResumeKeyV2(APP_ENV, id1, 1);
  const caPk = simulationRunPackKeyV2(APP_ENV, id1, 1);
  const cd = await pttl(caDs);
  const cr = await pttl(caRs);
  const cp = await pttl(caPk);
  check("試験5 昇格後のcanonicalはTTLを持たない", cd === -1 && cr === -1 && cp === -1, `canonical PTTL = ${cd} / ${cr} / ${cp}（-1 = TTLなし）`);
  const mfTtl = await pttl(simulationRunManifestKeyV2(APP_ENV, id1));
  check("試験5b manifest自体もTTLを持たない", mfTtl === -1, `manifest PTTL = ${mfTtl}`);
  const stAfter = [await pttl(stDs), await pttl(stRs), await pttl(stPk)];
  check("試験5c 昇格済みstagingキーは消えている", stAfter.every((v) => v === -2), `staging PTTL = ${stAfter.join(" / ")}（-2 = キー無し）`);

  const loaded1 = await repo.loadRun(id1);
  check(
    "試験6 manifest公開後にloadRunできる",
    loaded1 !== null && (loaded1.dataset as { marker?: string }).marker === "ds-A" && loaded1.run.completedTurns === 4,
    `loadRun marker=${(loaded1?.dataset as { marker?: string })?.marker}, completedTurns=${loaded1?.run.completedTurns}, schemaVersion=${loaded1?.schemaVersion}`
  );
  check("試験6b 読み出したschemaVersionがv9である", loaded1?.schemaVersion === 9, `schemaVersion=${loaded1?.schemaVersion}`);

  // ---------- 試験4: CAS敗者のstagingはTTL付きのまま残り、勝者canonicalは無傷 ----------
  const published = await repo.currentPublishedRevision(id1);
  const tokenW = createSimulationRunWriteToken("int1win");
  const tokenL = createSimulationRunWriteToken("int1lose");
  const attemptW = { expectedBaseRevision: published, writeToken: tokenW };
  const attemptL = { expectedBaseRevision: published, writeToken: tokenL };
  for (const [att, mark] of [
    [attemptW, "ds-W"],
    [attemptL, "ds-L"],
  ] as const) {
    await repo.saveRunPart(id1, att, "dataset", { marker: mark, schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION });
    await repo.saveRunPart(id1, att, "resume", { marker: mark });
  }
  const mW = manifestFor(id1, published + 1, 8, false);
  await repo.commitRunManifest(mW, manifestToSimulationRunSummary(mW), attemptW);
  let loserRejected = "（拒否されなかった）";
  try {
    const mL = manifestFor(id1, published + 1, 99, false);
    await repo.commitRunManifest(mL, manifestToSimulationRunSummary(mL), attemptL);
  } catch (e) {
    loserRejected = e instanceof SimulationRunStaleRevisionError ? `SimulationRunStaleRevisionError (expected=${e.expectedBaseRevision}, current=${e.currentPublishedRevision})` : `${(e as Error).name}`;
  }
  const loseDs = await pttl(simulationRunStagingPartKeyV2(APP_ENV, id1, tokenL, "dataset"));
  const loseRs = await pttl(simulationRunStagingPartKeyV2(APP_ENV, id1, tokenL, "resume"));
  check("試験4 CAS敗者はStaleRevisionErrorで拒否される", loserRejected.startsWith("SimulationRunStaleRevisionError"), loserRejected);
  check("試験4b 敗者stagingはTTL付きのまま残る", loseDs > 0 && loseRs > 0, `敗者 staging PTTL = ${loseDs} / ${loseRs} ms`);
  const afterWin = await repo.loadRun(id1);
  check(
    "試験4c 勝者canonicalは無傷（敗者に壊されない）",
    afterWin !== null && (afterWin.dataset as { marker?: string }).marker === "ds-W" && afterWin.run.completedTurns === 8,
    `loadRun marker=${(afterWin?.dataset as { marker?: string })?.marker}, completedTurns=${afterWin?.run.completedTurns}`
  );
  const winDsTtl = await pttl(simulationRunDatasetKeyV2(APP_ENV, id1, published + 1));
  check("試験4d 勝者canonicalはTTL無し", winDsTtl === -1, `勝者canonical dataset PTTL = ${winDsTtl}`);

  // ---------- 試験7: staging元TTL相当時間の経過後もcanonicalを読める ----------
  // productの1時間定数は変えず、saveRunPartが付けたTTLをテスト側からPEXPIREで
  // 短縮（1500ms）してからcommitする。RENAMEはこの短縮TTLを継承するため、
  // PERSISTが無ければ1.5秒後にcanonicalが消える。
  const id2 = "int1-ttl-b";
  const tokenB = createSimulationRunWriteToken("int1b");
  const attemptB = { expectedBaseRevision: 0, writeToken: tokenB };
  const SHORT_TTL_MS = 1500;
  await repo.saveRunPart(id2, attemptB, "dataset", { marker: "ds-B", schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION });
  await repo.saveRunPart(id2, attemptB, "resume", { marker: "rs-B" });
  await repo.saveRunPart(id2, attemptB, "pack", { marker: "pk-B" });
  for (const part of ["dataset", "resume", "pack"] as const) {
    await client.raw("PEXPIRE", simulationRunStagingPartKeyV2(APP_ENV, id2, tokenB, part), SHORT_TTL_MS);
  }
  const shortened = await pttl(simulationRunStagingPartKeyV2(APP_ENV, id2, tokenB, "dataset"));
  console.log(`#  試験7: staging TTLをテスト専用の ${SHORT_TTL_MS}ms へ外部短縮（実測 PTTL=${shortened}）`);
  const m2 = manifestFor(id2, 1, 12, true);
  await repo.commitRunManifest(m2, manifestToSimulationRunSummary(m2), attemptB);
  const b1 = await pttl(simulationRunDatasetKeyV2(APP_ENV, id2, 1));
  const b2 = await pttl(simulationRunResumeKeyV2(APP_ENV, id2, 1));
  const b3 = await pttl(simulationRunPackKeyV2(APP_ENV, id2, 1));
  check("試験7a 短縮TTLでもcanonicalは昇格直後にTTL無し", b1 === -1 && b2 === -1 && b3 === -1, `canonical PTTL = ${b1} / ${b2} / ${b3}`);
  const waitMs = SHORT_TTL_MS + 1200;
  console.log(`#  試験7: ${waitMs}ms 待機（短縮TTLを確実に超える）…`);
  await new Promise((r) => setTimeout(r, waitMs));
  const b1b = await pttl(simulationRunDatasetKeyV2(APP_ENV, id2, 1));
  const b2b = await pttl(simulationRunResumeKeyV2(APP_ENV, id2, 1));
  const b3b = await pttl(simulationRunPackKeyV2(APP_ENV, id2, 1));
  const existsAll =
    Number(await client.exists(simulationRunDatasetKeyV2(APP_ENV, id2, 1))) +
    Number(await client.exists(simulationRunResumeKeyV2(APP_ENV, id2, 1))) +
    Number(await client.exists(simulationRunPackKeyV2(APP_ENV, id2, 1)));
  check("試験7b 元staging TTL超過後もcanonicalパートが存在する", existsAll === 3, `EXISTS合計=${existsAll}/3, PTTL = ${b1b} / ${b2b} / ${b3b}`);
  const loaded2 = await repo.loadRun(id2);
  check(
    "試験7c 元staging TTL超過後もloadRunできる",
    loaded2 !== null && (loaded2.dataset as { marker?: string }).marker === "ds-B" && loaded2.run.completedTurns === 12,
    `loadRun marker=${(loaded2?.dataset as { marker?: string })?.marker}, completedTurns=${loaded2?.run.completedTurns}`
  );
  const resumeMark = (loaded2?.resumePayload as { marker?: string } | undefined)?.marker;
  const packMark = (loaded2?.packCapture as { marker?: string } | undefined)?.marker;
  check("試験7d resume / pack も残っている", resumeMark === "rs-B" && packMark === "pk-B", `resume.marker=${resumeMark}, pack.marker=${packMark}`);
  const stB = await pttl(simulationRunStagingPartKeyV2(APP_ENV, id2, tokenB, "dataset"));
  check("試験7e 孤児回収の仕組みは生きている（昇格済みstagingは消滅）", stB === -2, `staging PTTL = ${stB}（-2 = キー無し）`);

  // ---------- 旧版Run互換（v1〜v8をv9コードで読む / v10は拒否） ----------
  for (const v of [1, 7, 8]) {
    const idv = `int1-oldver-${v}`;
    const tk = createSimulationRunWriteToken(`int1v${v}`);
    const att = { expectedBaseRevision: 0, writeToken: tk };
    await repo.saveRunPart(idv, att, "dataset", { marker: `ds-v${v}` });
    const mv: StoredSimulationRunManifest = { ...manifestFor(idv, 1, 2, false), schemaVersion: v, hasResumePayload: false };
    await repo.commitRunManifest(mv, manifestToSimulationRunSummary(mv), att);
    const lv = await repo.loadRun(idv);
    check(`旧版互換 v${v} をv9コードで読める`, lv !== null && lv.schemaVersion === v, `schemaVersion=${lv?.schemaVersion}, marker=${(lv?.dataset as { marker?: string })?.marker}`);
  }
  const idFuture = "int1-future-v10";
  const tkF = createSimulationRunWriteToken("int1v10");
  const attF = { expectedBaseRevision: 0, writeToken: tkF };
  await repo.saveRunPart(idFuture, attF, "dataset", { marker: "ds-v10" });
  const mF: StoredSimulationRunManifest = { ...manifestFor(idFuture, 1, 2, false), schemaVersion: 10, hasResumePayload: false };
  let v10Rejected = "（拒否されなかった）";
  try {
    await repo.commitRunManifest(mF, manifestToSimulationRunSummary(mF), attF);
    const lf = await repo.loadRun(idFuture);
    v10Rejected = `loadRunがv10を返した（schemaVersion=${lf?.schemaVersion}）`;
  } catch (e) {
    v10Rejected = (e as Error).name;
  }
  check("前方互換なし: v10は読まない/受けない", v10Rejected.includes("Error"), v10Rejected);

  await client.raw("FLUSHALL");
  await client.close();
  console.log(`\n# INT-1 §5 TTL試験: FAIL=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
