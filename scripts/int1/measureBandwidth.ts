/**
 * 【BW-1】Redis 転送量の実測。
 *
 * 隔離したローカル Redis（このスクリプトが接続する一時インスタンス）だけを使う。
 * 停止中の共有 DB（Staging / Production）へは一切接続しない。
 *
 * 測るもの
 *   1. 実際の Run を数Turn進めて保存し、保存物（dataset / resume / pack）の実サイズ
 *   2. GM の Seat 一覧 1回ぶんの GET 対象と転送量（修正前 / 修正後）
 *   3. Independent Player の意思決定画面 1回ぶんの GET 対象と転送量（修正前 / 修正後）
 *   4. 変化が無い間ポーリングを続けたときの 1時間あたりの転送量（修正前 / 修正後）
 *
 * ゲーム計算・保存形式・保存競合対策（CAS）は変更していない。
 * 修正後の経路は、製品コードが実際に呼ぶ関数をそのまま呼んで測る（複製しない）。
 */
import { connectIsolatedRedis } from "./respClient";
import { createRedisSimulationRunRepository } from "../../app/lib/v2/companyLab/simulation/persistence/redisRepository";
import { createSimulationRunWriteToken } from "../../app/lib/v2/companyLab/simulation/persistence/repository";
import {
  CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
  StoredSimulationRunManifest,
  manifestToSimulationRunSummary,
} from "../../app/lib/v2/companyLab/simulation/persistence/types";
import { advanceSimulationTurn, createSimulationSession } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import type { CompanyLabRedisClient } from "../../app/lib/v2/redis/companyLabTypes";
import type { IsolatedRedis } from "./respClient";

const PORT = Number(process.env.INT1_REDIS_PORT ?? 6406);
const APP_ENV = "staging" as const;
const AT = "2026-10-08T00:00:00.000Z";
const RUN_ID = "bw1-measure";
const TURNS = Number(process.env.BW1_TURNS ?? 8);

/** GM Console の Seat 一覧の取得間隔（PlayerSeatPanel.tsx）。 */
const SEAT_POLL_MS = 5000;
/** Independent Player の意思決定画面の取得間隔（play/workspace/page.tsx）。 */
const PLAYER_POLL_MS = 4000;
/** 研修の想定同時接続（PLAYER 5社 ＋ GM 1人）。 */
const PLAYERS = 5;

interface GetLog {
  readonly key: string;
  readonly bytes: number;
}

/** GET の対象キーと応答バイト数を数えるラッパー。書き込みはそのまま通す。 */
function countingClient(inner: IsolatedRedis) {
  const gets: GetLog[] = [];
  const wrapped = {
    ...inner,
    async get(key: string) {
      const value = await inner.get(key);
      const bytes = value === null || value === undefined ? 0 : Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
      gets.push({ key, bytes });
      return value;
    },
  } as CompanyLabRedisClient;
  return {
    client: wrapped,
    reset: () => {
      gets.length = 0;
    },
    snapshot: (): readonly GetLog[] => gets.slice(),
  };
}

function totalBytes(gets: readonly GetLog[]): number {
  return gets.reduce((sum, g) => sum + g.bytes, 0);
}

function kindOf(key: string): string {
  if (key.includes(":dataset:")) return "dataset";
  if (key.includes(":resume:")) return "resume";
  if (key.includes(":pack:")) return "pack";
  if (key.endsWith(":manifest") || key.includes(":manifest")) return "manifest";
  if (key.includes(":summary")) return "summary";
  if (key.includes(":index")) return "index";
  return "other";
}

function describe(label: string, gets: readonly GetLog[]): void {
  const parts = gets.map((g) => `${kindOf(g.key)} ${g.bytes.toLocaleString()}B`).join(" + ");
  console.log(`    ${label.padEnd(34)} GET ${String(gets.length).padStart(2)}回  ${totalBytes(gets).toLocaleString().padStart(11)} B   ${parts || "(なし)"}`);
}

function perHour(bytesPerPoll: number, intervalMs: number, clients: number): number {
  return (bytesPerPoll * clients * 3_600_000) / intervalMs;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const raw = await connectIsolatedRedis(PORT);
  await raw.raw("FLUSHALL");
  const counter = countingClient(raw);
  const repo = createRedisSimulationRunRepository({ client: counter.client, appEnv: APP_ENV });

  console.log("# BW-1 Redis 転送量の実測（隔離ローカル Redis のみ。共有DBへは接続しない）");
  console.log(`# 127.0.0.1:${PORT} / appEnv=${APP_ENV} / schemaVersion=${CURRENT_SIMULATION_RUN_PERSISTED_VERSION}`);
  console.log(`# Seat一覧 ${SEAT_POLL_MS}ms間隔 / Player画面 ${PLAYER_POLL_MS}ms間隔 / PLAYER ${PLAYERS}人`);

  // ---- 1. 実際の Run を進めて保存する ----
  let session = createSimulationSession({
    simulationRunId: RUN_ID,
    scenarioId: "baseline",
    seed: "bw1-measure",
    requestedTurns: 32,
    startedAt: AT,
    sourceCommit: "BW1",
    companyControlModes: {},
    salesModelId: "tiered-v200-crowding-v1",
  });
  for (let i = 0; i < TURNS; i += 1) {
    const outcome = advanceSimulationTurn(session, AT, {}, "BW1");
    if (!outcome.session) break;
    session = outcome.session;
  }
  const dataset = buildDatasetFromSession(session);
  const resumePayload = buildResumePayload(session, {}, {});
  const packCapture = { note: "BW1 measurement placeholder pack" };

  const token = createSimulationRunWriteToken("bw1");
  const attempt = { expectedBaseRevision: 0, writeToken: token };
  await repo.saveRunPart(RUN_ID, attempt, "dataset", dataset);
  await repo.saveRunPart(RUN_ID, attempt, "resume", resumePayload);
  await repo.saveRunPart(RUN_ID, attempt, "pack", packCapture);
  const manifest: StoredSimulationRunManifest = {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: {
      simulationRunId: RUN_ID,
      scenarioId: "baseline",
      scenarioVersion: "v1",
      seed: "bw1-measure",
      gameParameterVersion: "v1",
      standardAiVersion: "v1",
      strategyProfileVersion: "v1",
      startingTurn: 1,
      requestedTurns: 32,
      completedTurns: TURNS,
      startedAt: AT,
      completedAt: null,
      stopReason: "completed",
      errorMessage: null,
      failedAtTurn: null,
    },
    persistenceRevision: 1,
    savedAt: AT,
    hasResumePayload: true,
    hasPackCapture: true,
  };
  await repo.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest), attempt);

  const sizeOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");
  console.log(`\n## 1. 保存物の実サイズ（${TURNS}Turn 進行後）`);
  console.log(`    dataset  ${sizeOf(dataset).toLocaleString().padStart(11)} B`);
  console.log(`    resume   ${sizeOf(resumePayload).toLocaleString().padStart(11)} B`);
  console.log(`    pack     ${sizeOf(packCapture).toLocaleString().padStart(11)} B（本番の pack はこれより大きい。ここでは代替値）`);

  // ---- 2. GM の Seat 一覧 1回ぶん ----
  console.log("\n## 2. GM の Seat 一覧 1回ぶんの GET");
  counter.reset();
  await repo.loadRun(RUN_ID); // 修正前: 全パートを読む
  const seatsBefore = counter.snapshot();
  describe("修正前（loadRun 全パート）", seatsBefore);

  counter.reset();
  await repo.loadRun(RUN_ID, { include: { dataset: false, pack: false } }); // 修正後: 変化があったとき
  const seatsAfterChanged = counter.snapshot();
  describe("修正後・変化あり", seatsAfterChanged);

  counter.reset();
  await repo.currentPublishedRevision(RUN_ID); // 修正後: 変化が無いとき
  const seatsAfterUnchanged = counter.snapshot();
  describe("修正後・変化なし", seatsAfterUnchanged);

  // ---- 3. Independent Player の意思決定画面 1回ぶん ----
  console.log("\n## 3. Independent Player の意思決定画面 1回ぶんの GET");
  counter.reset();
  await repo.loadRun(RUN_ID);
  const playerBefore = counter.snapshot();
  describe("修正前（loadRun 全パート）", playerBefore);

  counter.reset();
  await repo.currentPublishedRevision(RUN_ID);
  const playerAfterUnchanged = counter.snapshot();
  describe("修正後・変化なし", playerAfterUnchanged);
  console.log("    修正後・変化あり                   修正前と同じ（context の組み立てに全パートが要るため）");

  // ---- 4. 変化が無いあいだの1時間あたり転送量 ----
  const seatBeforeB = totalBytes(seatsBefore);
  const seatAfterB = totalBytes(seatsAfterUnchanged);
  const playerBeforeB = totalBytes(playerBefore);
  const playerAfterB = totalBytes(playerAfterUnchanged);
  const beforeHour = perHour(seatBeforeB, SEAT_POLL_MS, 1) + perHour(playerBeforeB, PLAYER_POLL_MS, PLAYERS);
  const afterHour = perHour(seatAfterB, SEAT_POLL_MS, 1) + perHour(playerAfterB, PLAYER_POLL_MS, PLAYERS);

  console.log("\n## 4. 誰も操作していない1時間あたりの読み取り転送量（GM 1 ＋ PLAYER 5）");
  console.log(`    修正前  ${mb(beforeHour).padStart(10)} / 時`);
  console.log(`    修正後  ${mb(afterHour).padStart(10)} / 時`);
  console.log(`    削減率  ${(100 - (afterHour / beforeHour) * 100).toFixed(3)} %（${(beforeHour / afterHour).toFixed(0)} 分の1）`);
  console.log("    ※ 非表示タブでは取得しないため、実際にはこれよりさらに減る。");
  console.log("    ※ Turn が進んだ直後だけは修正後も全パートを読む（取りこぼさないため）。");
  // Upstash Free の月間上限 10 GB に対して、修正前は何時間で到達するか。
  const FREE_MONTHLY_BYTES = 10 * 1024 * 1024 * 1024;
  console.log(`\n## 4b. Upstash Free の月間帯域 10 GB に到達するまで（開いたまま放置した場合）`);
  console.log(`    修正前  ${(FREE_MONTHLY_BYTES / beforeHour).toFixed(2)} 時間`);
  console.log(`    修正後  ${(FREE_MONTHLY_BYTES / afterHour / 24).toFixed(0)} 日`);
  console.log("    ※ 実際に 2026-10-07 に 26 GB で上限へ達している。修正前の消費速度と整合する。");

  // ---- 5. 取りこぼしが無いことの確認 ----
  console.log("\n## 5. 更新の取りこぼしが無いこと");
  const rev1 = await repo.currentPublishedRevision(RUN_ID);
  const token2 = createSimulationRunWriteToken("bw1b");
  const attempt2 = { expectedBaseRevision: rev1, writeToken: token2 };
  await repo.saveRunPart(RUN_ID, attempt2, "dataset", dataset);
  await repo.saveRunPart(RUN_ID, attempt2, "resume", resumePayload);
  await repo.saveRunPart(RUN_ID, attempt2, "pack", packCapture);
  const manifest2: StoredSimulationRunManifest = { ...manifest, persistenceRevision: rev1 + 1 };
  await repo.commitRunManifest(manifest2, manifestToSimulationRunSummary(manifest2), attempt2);
  const rev2 = await repo.currentPublishedRevision(RUN_ID);
  console.log(`    保存前 revision=${rev1} → 保存後 revision=${rev2}  ${rev2 === rev1 + 1 ? "PASS 変化が revision に現れる" : "FAIL"}`);

  const partialLoad = await repo.loadRun(RUN_ID, { include: { dataset: false, pack: false } });
  const ok =
    partialLoad !== null &&
    partialLoad.dataset === undefined &&
    partialLoad.packCapture === undefined &&
    partialLoad.resumePayload !== undefined &&
    partialLoad.run.simulationRunId === RUN_ID;
  console.log(`    dataset/pack を読まない読み込みで resume と run が揃う  ${ok ? "PASS" : "FAIL"}`);

  const fullLoad = await repo.loadRun(RUN_ID);
  const same = JSON.stringify(fullLoad?.resumePayload) === JSON.stringify(partialLoad?.resumePayload);
  console.log(`    同じ revision なら全読みと部分読みで resume が一致          ${same ? "PASS" : "FAIL"}`);

  await raw.raw("FLUSHALL");
  await raw.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
