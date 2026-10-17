/**
 * 【COMP-2】サーバー側「展開後サイズ上限」の根拠を取る。
 *
 * 実物の simulationRunStore.saveSimulationRun に、実物と同じプロトコルを話す
 * フェイクサーバーを組み合わせ、32Turn を通して「サーバーが実際に受け取る
 * 展開後の request body」の最大バイト数をパート別に測る。
 * 上限値を勘で決めないための実測であり、通信サイズ上限（4 MiB）とは別の根拠になる。
 *
 * 値そのものではなく request body 全体（外枠のフィールド込み）を測る。
 * サーバーが展開するのは body であって value ではないため。
 */
import { gunzipSync } from "node:zlib";
import { createSimulationSession, advanceSimulationTurn } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import { buildResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../app/lib/v2/companyLab/simulation/persistence/types";
import type { SimulationRunPart } from "../../app/lib/v2/companyLab/simulation/persistence/repository";
import type { CompanyControlMode, SimulationSession } from "../../app/lib/v2/companyLab/simulation/types";
import type { CompanyDecisionInput } from "../../app/lib/v2/companyLab/types";
import {
  SIMULATION_RUN_BODY_ENCODING_GZIP,
  SIMULATION_RUN_BODY_ENCODING_HEADER,
} from "../../app/lib/v2/companyLab/simulation/persistence/partBodyEncoding";

const AT = "2026-10-16T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const MODES: Readonly<Record<string, CompanyControlMode>> = Object.fromEntries(
  COMPANIES.map((c) => [c, "PLAYER" as CompanyControlMode])
);
const TOTAL_TURNS = 32;
const SCENARIOS = [
  "baseline",
  "dynamic-scenario-1",
  "dynamic-scenario-2",
  "ecuador-early-expansion",
  "global-demand-boom",
  "global-disease-crisis",
] as const;

function installFakeWindow(): void {
  const data = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (data.has(k) ? data.get(k) : null) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() { return data.size; },
    },
  };
}

interface Peak { readonly part: string; readonly bytes: number; readonly turn: number }

function installFakeServer(peaks: Map<string, number>, envelopes: Map<string, number>) {
  const published = new Map<string, { revision: number; parts: Partial<Record<SimulationRunPart, unknown>> }>();
  const staging = new Map<string, Partial<Record<SimulationRunPart, unknown>>>();

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/v2/simulation-runs" && init?.method === "POST") {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const gzipped = (headers[SIMULATION_RUN_BODY_ENCODING_HEADER] ?? "").trim().toLowerCase() === SIMULATION_RUN_BODY_ENCODING_GZIP;
      const text = gzipped
        ? gunzipSync(Buffer.from(init.body as unknown as Uint8Array)).toString("utf8")
        : String(init.body);
      const body = JSON.parse(text) as Record<string, unknown>;
      const label = body.manifestOnly ? "manifest" : String(body.part);
      const bytes = Buffer.byteLength(text, "utf8");
      peaks.set(label, Math.max(peaks.get(label) ?? 0, bytes));
      // 外枠（value を除いた分）の大きさ。上限に乗せる余白の根拠にする。
      if (!body.manifestOnly) {
        const envelopeOnly = { ...body, value: undefined };
        envelopes.set(label, Math.max(envelopes.get(label) ?? 0, Buffer.byteLength(JSON.stringify(envelopeOnly), "utf8")));
      }
      const token = body.writeToken as string;

      if (body.manifestOnly) {
        const run = body.run as { simulationRunId: string };
        published.set(run.simulationRunId, { revision: body.persistenceRevision as number, parts: staging.get(token) ?? {} });
        staging.delete(token);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const runId = body.simulationRunId as string;
      const part = body.part as SimulationRunPart;
      const current = staging.get(token) ?? {};
      if (body.reuseFromRevision !== undefined) {
        const pub = published.get(runId);
        current[part] = pub?.parts[part];
      } else {
        current[part] = body.value;
      }
      staging.set(token, current);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.startsWith("/api/v2/simulation-runs")) return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

async function main(): Promise<void> {
  installFakeWindow();
  const overall: Peak[] = [];
  const store = await import("../../app/v2/management/lib/simulationRunStore");

  console.log("# COMP-2 展開後サイズの実測（5社PLAYER / 32Turn / tiered-v200-crowding-v1）");
  console.log("# 測っているのは request body 全体（外枠込み・展開後）のバイト数");
  console.log("");
  console.log("シナリオ                   dataset      resume        pack    manifest");

  for (const scenarioId of SCENARIOS) {
    const peaks = new Map<string, number>();
    const envelopes = new Map<string, number>();
    installFakeServer(peaks, envelopes);

    let session: SimulationSession = createSimulationSession({
      simulationRunId: `ceiling-${scenarioId}`,
      scenarioId,
      seed: "comp2-ceiling",
      requestedTurns: TOTAL_TURNS,
      startedAt: AT,
      sourceCommit: "COMP2",
      companyControlModes: MODES,
      salesModelId: "tiered-v200-crowding-v1",
    });

    async function save(current: SimulationSession, confirmed: Readonly<Record<string, CompanyDecisionInput>>): Promise<void> {
      const r = await store.saveSimulationRun({
        schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
        run: current.run,
        dataset: buildDatasetFromSession(current),
        packCapture: { companyTurns: current.packCompanyTurns, worldTurns: current.packWorldTurns },
        resumePayload: buildResumePayload(current, MODES, confirmed),
        savedAt: AT,
      } as never);
      if (!r.serverSaveSucceeded) throw new Error(`保存が失敗した: ${r.serverError}`);
    }

    await save(session, {});
    for (let turn = 1; turn <= TOTAL_TURNS; turn += 1) {
      const confirmed: Record<string, CompanyDecisionInput> = {};
      for (const companyId of COMPANIES) {
        confirmed[companyId] = { companyId } as unknown as CompanyDecisionInput;
        await save(session, { ...confirmed });
      }
      const outcome = advanceSimulationTurn(session, AT, {}, "COMP2");
      if (!outcome.session) { console.log(`# ${scenarioId}: Turn ${turn} で停止`); break; }
      session = outcome.session;
      await save(session, {});
    }

    const row = ["dataset", "resume", "pack", "manifest"].map((p) => (peaks.get(p) ?? 0).toLocaleString("en-US").padStart(11)).join(" ");
    console.log(`${scenarioId.padEnd(24)}${row}`);
    for (const [part, bytes] of peaks) overall.push({ part, bytes, turn: TOTAL_TURNS });
    for (const [part, bytes] of envelopes) overall.push({ part: `${part}(外枠のみ)`, bytes, turn: TOTAL_TURNS });
  }

  console.log("");
  const max = overall.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  console.log(`全シナリオを通じた最大: ${max.part} = ${max.bytes.toLocaleString("en-US")} B = ${(max.bytes / 1024 / 1024).toFixed(3)} MiB`);
  const envMax = overall.filter((o) => o.part.includes("外枠")).reduce((a, b) => (b.bytes > a.bytes ? b : a));
  console.log(`外枠（value を除いた分）の最大: ${envMax.bytes.toLocaleString("en-US")} B`);
  for (const mult of [1.5, 2, 3, 4]) {
    const v = max.bytes * mult;
    console.log(`  実測最大の ${mult} 倍 = ${(v / 1024 / 1024).toFixed(2)} MiB`);
  }
}

void main();
