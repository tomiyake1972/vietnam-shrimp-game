/**
 * 【保存停止の切り分け】「Turn 27 で『保存中…』が3分止まる」の待ち場所を特定する。
 *
 * 候補は依頼書のとおり5つある。
 *   (1) 計算          … advanceSimulationTurn（エンジン）
 *   (2) データ生成    … buildDatasetFromSession / buildResumePayload / pack 組み立て
 *   (3) 直列化        … JSON.stringify（送信前に必ず通る）
 *   (4) 送信          … ネットワーク（ここでは測れない。バイト数から見積もる）
 *   (5) 再試行・サーバー保存 … タイムアウトと再試行上限の積（コードから算出）
 *
 * このスクリプトは (1)(2)(3) を Turn ごとに実測し、Turn 27 付近に計算量の崖が
 * あるかどうかを判定する。崖が無ければ、待ちは (4)(5) 側にあると切り分けられる。
 *
 * 共有 Redis へは接続しない。ゲーム計算・保存形式は変更していない。
 */
import { createSimulationSession, advanceSimulationTurn } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import { buildResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import type { CompanyControlMode } from "../../app/lib/v2/companyLab/simulation/types";

const AT = "2026-10-16T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const MODES: Readonly<Record<string, CompanyControlMode>> = Object.fromEntries(
  COMPANIES.map((c) => [c, "PLAYER" as CompanyControlMode])
);
const TOTAL_TURNS = 32;

/** 保存1回ぶんのクライアント側準備（PLAYER意思決定の確定で実際に走る処理）。 */
function measurePrepare(session: Parameters<typeof buildDatasetFromSession>[0] & Parameters<typeof buildResumePayload>[0]) {
  const t0 = performance.now();
  const dataset = buildDatasetFromSession(session);
  const t1 = performance.now();
  const resume = buildResumePayload(session, MODES, {});
  const t2 = performance.now();
  const pack = { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns };
  const t3 = performance.now();
  const datasetJson = JSON.stringify(dataset).length;
  const t4 = performance.now();
  const resumeJson = JSON.stringify(resume).length;
  const t5 = performance.now();
  const packJson = JSON.stringify(pack).length;
  const t6 = performance.now();
  return {
    buildDatasetMs: t1 - t0,
    buildResumeMs: t2 - t1,
    buildPackMs: t3 - t2,
    stringifyMs: t4 - t3 + (t5 - t4) + (t6 - t5),
    totalMs: t6 - t0,
    bytes: datasetJson + resumeJson + packJson,
  };
}

function main(): void {
  let session = createSimulationSession({
    simulationRunId: "stall-probe",
    scenarioId: "baseline",
    seed: "fot1-measure",
    requestedTurns: TOTAL_TURNS,
    startedAt: AT,
    sourceCommit: "STALL",
    companyControlModes: MODES,
    salesModelId: "tiered-v200-crowding-v1",
  });

  console.log("# 保存1回ぶんのクライアント側準備時間（ミリ秒）と送信バイト数");
  console.log("# 5社PLAYER / baseline / tiered-v200-crowding-v1 / seed=fot1-measure");
  console.log("");
  console.log("Turn\tengine\tdataset\tresume\tpack\tstringify\t準備計\t送信バイト");

  let worstTurn = 0;
  let worstMs = 0;

  for (let turn = 1; turn <= TOTAL_TURNS; turn += 1) {
    const e0 = performance.now();
    const outcome = advanceSimulationTurn(session, AT, {}, "STALL");
    const engineMs = performance.now() - e0;
    if (!outcome.session) {
      console.log(`# Turn ${turn} で進行が止まった: ${outcome.error?.message ?? "理由不明"}`);
      return;
    }
    session = outcome.session;
    const m = measurePrepare(session);
    if (m.totalMs > worstMs) {
      worstMs = m.totalMs;
      worstTurn = turn;
    }
    console.log(
      `${turn}\t${engineMs.toFixed(0)}\t${m.buildDatasetMs.toFixed(0)}\t${m.buildResumeMs.toFixed(0)}\t` +
        `${m.buildPackMs.toFixed(0)}\t${m.stringifyMs.toFixed(0)}\t\t${m.totalMs.toFixed(0)}\t${m.bytes}`
    );
  }

  console.log("");
  console.log(`準備時間が最大だったTurn: ${worstTurn}（${worstMs.toFixed(0)} ms）`);
  console.log("");
  console.log("# 送信時間の見積り（1保存あたり。実測ではなくバイト数からの計算値）");
  const finalBytes = measurePrepare(session).bytes;
  for (const mbps of [10, 5, 2, 1, 0.5]) {
    const seconds = (finalBytes * 8) / (mbps * 1000 * 1000);
    console.log(`  上り ${mbps} Mbps … ${seconds.toFixed(1)} 秒 / 1保存（T32 の ${finalBytes} B）`);
  }
}

main();
