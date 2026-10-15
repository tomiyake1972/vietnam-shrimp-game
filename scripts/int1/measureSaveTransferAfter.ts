/**
 * 【FOT-1 改修後の実測】実際の simulationRunStore.saveSimulationRun を、
 * 実物と同じプロトコルを話すフェイクサーバーに対して 32Turn ぶん走らせ、
 * ブラウザ→サーバーへ出たバイト数を数える。
 *
 * 改修前の値は scripts/int1/measureSavePayload.ts（JSONの大きさから算出）。
 * こちらは「送り方」まで含めた実測であり、圧縮・再利用・差分追記が
 * 実際に効いた後のバイト数になる。
 *
 * 1Turn の保存順序は実機と同じにする:
 *   PLAYER意思決定の確定 … 5回（このときTurnはまだ進んでいない＝dataset/packは不変）
 *   Turn完了            … 1回（datasetが1Turnぶん増え、packも増える）
 *
 * 共有 Redis へは接続しない（fetch をフェイクへ差し替える）。
 */
import { gunzipSync } from "node:zlib";
import { createSimulationSession, advanceSimulationTurn } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import { buildResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../app/lib/v2/companyLab/simulation/persistence/types";
import {
  SIMULATION_RUN_BODY_ENCODING_GZIP,
  SIMULATION_RUN_BODY_ENCODING_HEADER,
  maxTurnOfSimulationRunPart,
  mergeSimulationRunPart,
} from "../../app/lib/v2/companyLab/simulation/persistence/partWire";
import type { SimulationRunPart } from "../../app/lib/v2/companyLab/simulation/persistence/repository";
import type { CompanyControlMode, SimulationSession } from "../../app/lib/v2/companyLab/simulation/types";
import type { CompanyDecisionInput } from "../../app/lib/v2/companyLab/types";

const AT = "2026-10-15T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const MODES: Readonly<Record<string, CompanyControlMode>> = Object.fromEntries(
  COMPANIES.map((c) => [c, "PLAYER" as CompanyControlMode])
);
const TOTAL_TURNS = 32;
const REPORT_TURNS = [1, 16, 32];

// --------------------------------------------------------------
// ブラウザ環境の最小スタブ（localStorage）
// --------------------------------------------------------------
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

// --------------------------------------------------------------
// 実物と同じプロトコルを話すフェイクサーバー
// --------------------------------------------------------------
interface FakeServerStats {
  /** 受け取ったリクエストのボディ合計（＝ブラウザから出たバイト数）。 */
  receivedBytes: number;
}

function installFakeServer(stats: FakeServerStats) {
  const published = new Map<string, { revision: number; parts: Partial<Record<SimulationRunPart, unknown>> }>();
  const staging = new Map<string, Partial<Record<SimulationRunPart, unknown>>>();

  function readBody(init: RequestInit): { body: Record<string, unknown>; bytes: number } {
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (headers[SIMULATION_RUN_BODY_ENCODING_HEADER] === SIMULATION_RUN_BODY_ENCODING_GZIP) {
      const buf = Buffer.from(init.body as Uint8Array);
      return { body: JSON.parse(gunzipSync(buf).toString("utf8")), bytes: buf.byteLength };
    }
    const text = String(init.body);
    return { body: JSON.parse(text), bytes: Buffer.byteLength(text, "utf8") };
  }

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/v2/simulation-runs" && init?.method === "POST") {
      const { body, bytes } = readBody(init);
      stats.receivedBytes += bytes;
      const token = body.writeToken as string;

      if (body.manifestOnly) {
        const run = body.run as { simulationRunId: string };
        const parts = staging.get(token) ?? {};
        published.set(run.simulationRunId, { revision: body.persistenceRevision as number, parts });
        staging.delete(token);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      const runId = body.simulationRunId as string;
      const part = body.part as SimulationRunPart;
      const parts = staging.get(token) ?? {};
      const current = published.get(runId);

      function publishedPart(revision: number): unknown {
        if (!current || current.revision !== revision) return undefined;
        return current.parts[part];
      }

      if (body.reuseFromRevision !== undefined) {
        const base = publishedPart(body.reuseFromRevision as number);
        if (base === undefined) {
          return new Response(JSON.stringify({ error: { code: "DELTA_BASE_MISMATCH", message: "no base" } }), { status: 409 });
        }
        parts[part] = base;
      } else if (body.appendFromRevision !== undefined) {
        const base = publishedPart(body.appendFromRevision as number);
        if (base === undefined) {
          return new Response(JSON.stringify({ error: { code: "DELTA_BASE_MISMATCH", message: "no base" } }), { status: 409 });
        }
        const merged = mergeSimulationRunPart(part, base, body.value);
        if (maxTurnOfSimulationRunPart(part, merged) !== (body.expectedMaxTurn as number)) {
          return new Response(JSON.stringify({ error: { code: "DELTA_BASE_MISMATCH", message: "turn mismatch" } }), { status: 409 });
        }
        parts[part] = merged;
      } else {
        parts[part] = body.value;
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
  const stats: FakeServerStats = { receivedBytes: 0 };
  const server = installFakeServer(stats);
  const store = await import("../../app/v2/management/lib/simulationRunStore");

  let session = createSimulationSession({
    simulationRunId: "fot1-after",
    scenarioId: "baseline",
    seed: "fot1-measure",
    requestedTurns: TOTAL_TURNS,
    startedAt: AT,
    sourceCommit: "FOT1",
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
    if (!result.serverSaveSucceeded) {
      throw new Error(`保存が失敗した: ${result.serverError}`);
    }
    return stats.receivedBytes - before;
  }

  const perTurnPlayerSaveBytes: number[] = [];
  const perTurnCompleteSaveBytes: number[] = [];

  // Run開始時の保存（SetupScreen 相当）。
  const initialBytes = await save(session, {});

  for (let turn = 1; turn <= TOTAL_TURNS; turn += 1) {
    /**
     * PLAYER意思決定の確定（5回）。このときTurnはまだ進んでいないため、
     * dataset と pack は前回保存した内容と同一＝再利用されるはず。
     */
    let playerBytes = 0;
    const confirmed: Record<string, CompanyDecisionInput> = {};
    for (const companyId of COMPANIES) {
      confirmed[companyId] = { companyId } as unknown as CompanyDecisionInput;
      playerBytes += await save(session, { ...confirmed });
    }
    perTurnPlayerSaveBytes.push(playerBytes);

    // Turn完了（1回）。
    const outcome = advanceSimulationTurn(session, AT, {}, "FOT1");
    if (!outcome.session) {
      console.log(`# Turn ${turn} で進行が止まった: ${outcome.error?.message ?? "理由不明"}`);
      return;
    }
    session = outcome.session;
    perTurnCompleteSaveBytes.push(await save(session, {}));
  }

  // 【中身が従来と同一であることの確認】最後に公開された正本が、全量ビルドと一致するか。
  const finalPublished = server.published.get("fot1-after");
  const expectedDataset = JSON.stringify(buildDatasetFromSession(session));
  const expectedPack = JSON.stringify({ companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns });
  const datasetMatches = JSON.stringify(finalPublished?.parts.dataset) === expectedDataset;
  const packMatches = JSON.stringify(finalPublished?.parts.pack) === expectedPack;

  console.log("# FOT-1 改修後（実際に simulationRunStore が送ったバイト数）");
  console.log(`# 5社PLAYER / salesModelId=tiered-v200-crowding-v1 / 1Turnあたり保存${COMPANIES.length + 1}回`);
  console.log("");
  console.log("Turn\tPLAYER確定5回合計\t1回あたり\tTurn完了1回");
  for (const t of REPORT_TURNS) {
    const p = perTurnPlayerSaveBytes[t - 1];
    console.log(`${t}\t${p}\t${Math.round(p / COMPANIES.length)}\t${perTurnCompleteSaveBytes[t - 1]}`);
  }

  const total = stats.receivedBytes;
  console.log("");
  console.log(`Run開始時の保存: ${initialBytes} B`);
  console.log(`1Run 合計送信量: ${total} B = ${mb(total)} MB`);
  console.log("");
  console.log("# 保存される中身が全量送信時と同一か（AI Analysis Pack の出力一致の前提）");
  console.log(`dataset: ${datasetMatches ? "一致" : "不一致"}`);
  console.log(`pack   : ${packMatches ? "一致" : "不一致"}`);
}

void main();
