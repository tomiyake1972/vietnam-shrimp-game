/**
 * 【REUSE-1 実測】「変更していない dataset / pack を送り直さない」修正だけでの転送量。
 *
 * 【旧 FOT-1 の数値を流用しない】旧 FOT-1 は圧縮・差分追記・デバウンス・提出経路変更を
 * 含んでいた。ここで測るのは再利用だけを入れた状態である。
 *
 * 実物の simulationRunStore.saveSimulationRun を、実物と同じプロトコルを話す
 * フェイクサーバーへ走らせ、リクエストボディのバイト数を数える。
 * 圧縮は入れていないので、ここで数えた値がそのままブラウザの送出バイト数になる。
 *
 * 1Turn の保存順序は実機と同じにする:
 *   PLAYER意思決定の確定 … 5回（Turnはまだ進んでいない＝dataset/packは不変）
 *   Turn完了            … 1回（dataset が1Turnぶん増え、pack も増える）
 *
 * 【あわせて検証する】32Turn 走らせたあとの公開済み dataset / pack / resume が、
 * 全量送信方式で保存した場合と一致すること、およびその正本から resume
 * （restoreSessionFromResumePayload）が同じセッションを復元できること。
 *
 * 共有 Redis へは接続しない（fetch をフェイクへ差し替える）。
 */
import { createSimulationSession, advanceSimulationTurn } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import { buildResumePayload, restoreSessionFromResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../app/lib/v2/companyLab/simulation/persistence/types";
import type { SimulationRunPart } from "../../app/lib/v2/companyLab/simulation/persistence/repository";
import type { CompanyControlMode, SimulationSession } from "../../app/lib/v2/companyLab/simulation/types";
import type { CompanyDecisionInput } from "../../app/lib/v2/companyLab/types";

const AT = "2026-10-16T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const MODES: Readonly<Record<string, CompanyControlMode>> = Object.fromEntries(
  COMPANIES.map((c) => [c, "PLAYER" as CompanyControlMode])
);
const TOTAL_TURNS = 32;
const REPORT_TURNS = [1, 16, 32];

function installFakeWindow(): void {
  const data = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (data.has(k) ? data.get(k) : null) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  };
}

interface Stats {
  receivedBytes: number;
  reuseCount: number;
  valueCount: number;
}

/** 実物のハンドラーと同じ2経路（value / reuse）を再現するフェイクサーバー。 */
function installFakeServer(stats: Stats) {
  const published = new Map<string, { revision: number; parts: Partial<Record<SimulationRunPart, unknown>> }>();
  const staging = new Map<string, Partial<Record<SimulationRunPart, unknown>>>();

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/v2/simulation-runs" && init?.method === "POST") {
      const text = String(init.body);
      stats.receivedBytes += Buffer.byteLength(text, "utf8");
      const body = JSON.parse(text) as Record<string, unknown>;
      const token = body.writeToken as string;

      if (body.manifestOnly) {
        const run = body.run as { simulationRunId: string };
        published.set(run.simulationRunId, { revision: body.persistenceRevision as number, parts: staging.get(token) ?? {} });
        staging.delete(token);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      const runId = body.simulationRunId as string;
      const part = body.part as SimulationRunPart;
      const parts = staging.get(token) ?? {};
      if (body.reuseFromRevision !== undefined) {
        const current = published.get(runId);
        const base = current && current.revision === (body.reuseFromRevision as number) ? current.parts[part] : undefined;
        if (base === undefined) {
          return new Response(JSON.stringify({ error: { code: "REUSE_BASE_MISMATCH", message: "no base" } }), { status: 409 });
        }
        parts[part] = base;
        stats.reuseCount += 1;
      } else {
        parts[part] = body.value;
        stats.valueCount += 1;
      }
      staging.set(token, parts);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url === "/api/v2/simulation-runs") {
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  return { published };
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

async function main(): Promise<void> {
  installFakeWindow();
  const stats: Stats = { receivedBytes: 0, reuseCount: 0, valueCount: 0 };
  const server = installFakeServer(stats);
  const store = await import("../../app/v2/management/lib/simulationRunStore");

  let session = createSimulationSession({
    simulationRunId: "reuse1-measure",
    scenarioId: "baseline",
    seed: "fot1-measure",
    requestedTurns: TOTAL_TURNS,
    startedAt: AT,
    sourceCommit: "REUSE1",
    companyControlModes: MODES,
    salesModelId: "tiered-v200-crowding-v1",
  });

  async function save(current: SimulationSession, confirmed: Readonly<Record<string, CompanyDecisionInput>>): Promise<number> {
    const before = stats.receivedBytes;
    const result = await store.saveSimulationRun({
      schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
      run: current.run,
      dataset: buildDatasetFromSession(current),
      packCapture: { companyTurns: current.packCompanyTurns, worldTurns: current.packWorldTurns },
      resumePayload: buildResumePayload(current, MODES, confirmed),
      savedAt: AT,
    });
    if (!result.serverSaveSucceeded) throw new Error(`保存が失敗した: ${result.serverError}`);
    return stats.receivedBytes - before;
  }

  const playerSaveBytes: number[] = [];
  const completeSaveBytes: number[] = [];
  const initialBytes = await save(session, {});

  for (let turn = 1; turn <= TOTAL_TURNS; turn += 1) {
    let playerBytes = 0;
    const confirmed: Record<string, CompanyDecisionInput> = {};
    for (const companyId of COMPANIES) {
      confirmed[companyId] = { companyId } as unknown as CompanyDecisionInput;
      playerBytes += await save(session, { ...confirmed });
    }
    playerSaveBytes.push(playerBytes);

    const outcome = advanceSimulationTurn(session, AT, {}, "REUSE1");
    if (!outcome.session) {
      console.log(`# Turn ${turn} で進行が止まった: ${outcome.error?.message ?? "理由不明"}`);
      return;
    }
    session = outcome.session;
    completeSaveBytes.push(await save(session, {}));
  }

  // --- 保存内容が従来方式と一致するか ---
  const finalPublished = server.published.get("reuse1-measure");
  const expectedDataset = buildDatasetFromSession(session);
  const expectedPack = { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns };
  const expectedResume = buildResumePayload(session, MODES, {});
  const datasetMatches = JSON.stringify(finalPublished?.parts.dataset) === JSON.stringify(expectedDataset);
  const packMatches = JSON.stringify(finalPublished?.parts.pack) === JSON.stringify(expectedPack);
  const resumeMatches = JSON.stringify(finalPublished?.parts.resume) === JSON.stringify(expectedResume);

  // --- その正本から resume できるか（従来方式の復元結果と一致するか） ---
  const restoredFromPublished = restoreSessionFromResumePayload(
    session.run,
    finalPublished?.parts.resume as never,
    finalPublished?.parts.pack as never,
    finalPublished?.parts.dataset as never
  );
  const restoredFromFull = restoreSessionFromResumePayload(session.run, expectedResume, expectedPack, expectedDataset);
  const resumeRestoreMatches = JSON.stringify(restoredFromPublished) === JSON.stringify(restoredFromFull);

  console.log("# REUSE-1 実測（再利用のみ。圧縮・差分追記・デバウンス・提出経路変更は含まない）");
  console.log(`# 5社PLAYER / salesModelId=tiered-v200-crowding-v1 / 1Turnあたり保存${COMPANIES.length + 1}回 / seed=fot1-measure`);
  console.log("");
  console.log("Turn\tPLAYER確定5回合計\t同 1回あたり\tTurn完了1回");
  for (const t of REPORT_TURNS) {
    const p = playerSaveBytes[t - 1];
    console.log(`${t}\t${p}\t${Math.round(p / COMPANIES.length)}\t${completeSaveBytes[t - 1]}`);
  }

  console.log("");
  console.log(`Run開始時の保存: ${initialBytes} B`);
  console.log(`1Run 合計送信量: ${stats.receivedBytes} B = ${mb(stats.receivedBytes)} MB`);
  console.log(`パート保存の内訳: 完全な値 ${stats.valueCount} 回 / 再利用 ${stats.reuseCount} 回`);
  console.log("");
  console.log("# 保存内容が従来方式（毎回全量送信）と一致するか");
  console.log(`dataset       : ${datasetMatches ? "一致" : "不一致"}`);
  console.log(`pack          : ${packMatches ? "一致" : "不一致"}`);
  console.log(`resume        : ${resumeMatches ? "一致" : "不一致"}`);
  console.log(`resume後の復元: ${resumeRestoreMatches ? "一致" : "不一致"}`);
}

void main();
