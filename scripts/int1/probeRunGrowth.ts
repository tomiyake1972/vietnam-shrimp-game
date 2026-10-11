/**
 * 【BW-1 見積りの訂正根拠】保存物の大きさが Turn の進行でどう増えるかを実測する。
 *
 * なぜ必要か: BW-1 の「32Turn 3.68 GB」は、8Turn 時点の Run で 1Turn ぶんを実測した
 * 117.9 MB を 32 倍した換算値だった。1Turn ぶんの転送量は、ほぼ
 * 「保存物の大きさ × その Turn で全体を取り直す回数（研修では一定）」で決まるので、
 * 保存物が Turn とともに増えるなら、32 倍の線形換算は実際とずれる。
 * そのずれの向きと倍率を実測して示す。
 *
 * 共有 DB へは接続しない（Redis も HTTP も使わない。engine と保存物の組み立てだけを呼ぶ）。
 * ゲーム計算・保存形式は変更していない。
 */
import { createSimulationSession, advanceSimulationTurn } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import { buildResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import type { CompanyControlMode } from "../../app/lib/v2/companyLab/simulation/types";

const AT = "2026-10-08T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const MODES: Readonly<Record<string, CompanyControlMode>> = Object.fromEntries(
  COMPANIES.map((c) => [c, "PLAYER" as CompanyControlMode])
);
const TOTAL_TURNS = 32;
/** 換算の基準に使われた Turn 深さ（verifyBw1Propagation.ts の BW1_TURNS 既定値）。 */
const BASELINE_TURN = 8;

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function main(): void {
  let session = createSimulationSession({
    simulationRunId: "bw1-growth",
    scenarioId: "baseline",
    seed: "bw1-growth",
    requestedTurns: TOTAL_TURNS,
    startedAt: AT,
    sourceCommit: "BW1",
    companyControlModes: MODES,
    salesModelId: "tiered-v200-crowding-v1",
  });

  const sizes: number[] = [];
  console.log("# 保存物の大きさ（dataset + resume）の推移");
  console.log("# pack は計測用の代替値のため含めない（BW-1 §3-3 の注記と同じ条件）。");
  console.log("");
  console.log("Turn\tdataset(B)\tresume(B)\t合計(B)\t8Turn比");

  for (let turn = 1; turn <= TOTAL_TURNS; turn += 1) {
    const outcome = advanceSimulationTurn(session, AT, {}, "BW1");
    if (!outcome.session) {
      console.log(`# Turn ${turn} で進行が止まった: ${outcome.error?.message ?? "理由不明"}`);
      break;
    }
    session = outcome.session;
    const d = bytes(buildDatasetFromSession(session));
    const r = bytes(buildResumePayload(session, MODES, {}));
    sizes.push(d + r);
    if (turn <= 3 || turn % 4 === 0 || turn === TOTAL_TURNS) {
      const ratio = sizes[BASELINE_TURN - 1] === undefined ? "-" : ((d + r) / sizes[BASELINE_TURN - 1]).toFixed(3);
      console.log(`${turn}\t${d}\t${r}\t${d + r}\t${ratio}`);
    }
  }

  const base = sizes[BASELINE_TURN - 1];
  if (base === undefined || sizes.length < TOTAL_TURNS) {
    console.log("\n# 32Turn ぶんを取得できなかったため換算は行わない（取得不能）。");
    return;
  }
  const sum = sizes.reduce((a, b) => a + b, 0);
  const linear = base * TOTAL_TURNS;
  console.log("");
  console.log(`8Turn 時点の保存物: ${base} B`);
  console.log(`32Turn 時点の保存物: ${sizes[TOTAL_TURNS - 1]} B（8Turn の ${(sizes[TOTAL_TURNS - 1] / base).toFixed(3)} 倍）`);
  console.log(`Turn1..32 の保存物の総和: ${sum} B`);
  console.log(`8Turn 固定で32倍した場合: ${linear} B`);
  console.log(`補正係数（総和 ÷ 線形換算）: ${(sum / linear).toFixed(3)}`);
  console.log("");
  console.log("# この係数を 1Turn 実測 117.9 MB に掛けたものが、32Turn の見積りとして線形換算より妥当。");
  console.log(`#   117.9 MB × 32 × ${(sum / linear).toFixed(3)} = ${((117.9 * 32 * sum) / linear / 1024).toFixed(2)} GB`);
  console.log("# ただしこれも見積りであり、32Turn を通した実測ではない。");
}

main();
