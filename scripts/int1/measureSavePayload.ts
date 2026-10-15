/**
 * 【FOT-1 実測】GM Console の保存（simulationRunStore.saveToServer）が
 * 1回あたり何バイトをブラウザ→サーバーへ送っているかを測る。
 *
 * なぜ必要か: Vercel Fast Origin Transfer の超過は「送信量」が原因であり、
 * 10/9 の BW-1（読込側の削減）では効かない経路である。依頼書の推定値
 * （dataset 約3.9MB / resume 約2.7MB / pack 未計測 / 1Run 約1GB）を
 * 実測値へ置き換える。
 *
 * 測るもの（saveToServer が実際に送る4本の POST と同じ区分）:
 *   dataset  … buildDatasetFromSession(session)
 *   resume   … buildResumePayload(session, modes, confirmed)
 *   pack     … { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns }
 *   manifest … run / savedAt / persistenceRevision / has* フラグ
 *
 * 共有 Redis へは接続しない（engine と保存物の組み立てだけを呼ぶ）。
 * ゲーム計算・保存形式は一切変更していない。
 */
import { gzipSync } from "node:zlib";
import { createSimulationSession, advanceSimulationTurn } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import { buildResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../app/lib/v2/companyLab/simulation/persistence/types";
import type { CompanyControlMode, SimulationSession } from "../../app/lib/v2/companyLab/simulation/types";

const AT = "2026-10-15T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const MODES: Readonly<Record<string, CompanyControlMode>> = Object.fromEntries(
  COMPANIES.map((c) => [c, "PLAYER" as CompanyControlMode])
);
const TOTAL_TURNS = 32;

/**
 * 1Turn あたりの保存回数。5社PLAYERでは
 *   PLAYER意思決定の確定 … 5回（PlayerWorkspace.tsx / 1社ずつ）
 *   Turn完了            … 1回（ManagementConsole.tsx）
 * の計6回。依頼書の「約6回」と一致する。
 */
const SAVES_PER_TURN = COMPANIES.length + 1;

const REPORT_TURNS = [1, 16, 32];

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function gzipBytes(value: unknown): number {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8")).length;
}

interface PartSizes {
  readonly dataset: number;
  readonly resume: number;
  readonly pack: number;
  readonly manifest: number;
}

function measure(session: SimulationSession, sizer: (v: unknown) => number): PartSizes {
  const dataset = sizer(buildDatasetFromSession(session));
  const resume = sizer(buildResumePayload(session, MODES, {}));
  const pack = sizer({ companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns });
  const manifest = sizer({
    manifestOnly: true,
    run: session.run,
    savedAt: AT,
    persistenceRevision: 1,
    hasResumePayload: true,
    hasPackCapture: true,
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    expectedBaseRevision: 0,
    writeToken: "gm-measure-0000000000",
  });
  return { dataset, resume, pack, manifest };
}

function total(p: PartSizes): number {
  return p.dataset + p.resume + p.pack + p.manifest;
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

function main(): void {
  let session = createSimulationSession({
    simulationRunId: "fot1-measure",
    scenarioId: "baseline",
    seed: "fot1-measure",
    requestedTurns: TOTAL_TURNS,
    startedAt: AT,
    sourceCommit: "FOT1",
    companyControlModes: MODES,
    salesModelId: "tiered-v200-crowding-v1",
  });

  const raw: PartSizes[] = [];
  const gz: PartSizes[] = [];

  for (let turn = 1; turn <= TOTAL_TURNS; turn += 1) {
    const outcome = advanceSimulationTurn(session, AT, {}, "FOT1");
    if (!outcome.session) {
      console.log(`# Turn ${turn} で進行が止まった: ${outcome.error?.message ?? "理由不明"}`);
      break;
    }
    session = outcome.session;
    raw.push(measure(session, utf8Bytes));
    gz.push(measure(session, gzipBytes));
  }

  if (raw.length < TOTAL_TURNS) {
    console.log("# 32Turn ぶんを取得できなかったため集計しない（取得不能）。");
    return;
  }

  /**
   * ここが出す数値は各パートの JSON の実バイト数であり、改修前の wire が
   * そのまま送っていた量と同じである。改修後もこの数値は変わらない
   * （保存物の中身は変えていないため）。改修後に実際にネットワークへ出た量は
   * scripts/int1/measureSaveTransferAfter.ts で測る。
   * この不変性は「同一seedでエンジン出力が変わっていないこと」の確認にも使える。
   */
  console.log("# FOT-1 各パートのJSONバイト数（＝改修前の wire が1回の保存で送っていた量）");
  console.log(`# 5社PLAYER / salesModelId=tiered-v200-crowding-v1 / 1Turnあたり保存${SAVES_PER_TURN}回`);
  console.log("");
  console.log("Turn\tdataset\tresume\tpack\tmanifest\t1保存合計\t1保存合計(MB)");
  for (const t of REPORT_TURNS) {
    const p = raw[t - 1];
    console.log(`${t}\t${p.dataset}\t${p.resume}\t${p.pack}\t${p.manifest}\t${total(p)}\t${mb(total(p))}`);
  }

  console.log("");
  console.log("# gzip 圧縮後（案2の圧縮でどこまで下がるかの参考値）");
  console.log("Turn\tdataset\tresume\tpack\tmanifest\t1保存合計\t圧縮率");
  for (const t of REPORT_TURNS) {
    const p = gz[t - 1];
    const r = raw[t - 1];
    console.log(`${t}\t${p.dataset}\t${p.resume}\t${p.pack}\t${p.manifest}\t${total(p)}\t${((total(p) / total(r)) * 100).toFixed(1)}%`);
  }

  const runTotal = raw.reduce((acc, p) => acc + total(p) * SAVES_PER_TURN, 0);
  const runTotalPackOnce = raw.reduce((acc, p, i) => acc + (p.dataset + p.resume + p.manifest) * SAVES_PER_TURN + (i === raw.length - 1 ? p.pack : 0), 0);
  const runTotalGz = gz.reduce((acc, p) => acc + total(p) * SAVES_PER_TURN, 0);

  console.log("");
  console.log("# 1Run（5社PLAYER×32Turn）の送信量合計");
  console.log(`現状（毎回 dataset+resume+pack+manifest を全量送信）: ${runTotal} B = ${mb(runTotal)} MB`);
  console.log(`参考: pack を最後の1回だけにした場合                : ${runTotalPackOnce} B = ${mb(runTotalPackOnce)} MB`);
  console.log(`参考: 全量のまま gzip だけ適用した場合              : ${runTotalGz} B = ${mb(runTotalGz)} MB`);
  console.log("");
  console.log("# 内訳（1Run合計に対する各パートの寄与）");
  for (const key of ["dataset", "resume", "pack", "manifest"] as const) {
    const sum = raw.reduce((acc, p) => acc + p[key] * SAVES_PER_TURN, 0);
    console.log(`${key}\t${sum} B\t${mb(sum)} MB\t${((sum / runTotal) * 100).toFixed(1)}%`);
  }
}

main();
