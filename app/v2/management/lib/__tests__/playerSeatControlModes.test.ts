// ShrimpX V2 — SEAT-1: 経営モードの切替が参加枠（seat）へ即時反映されること
//
// 【この修正が守る因果（実機で観測）】
//   2026-10-17 の staging 実機確認で、BAL を「自分で操作」に切り替えても
//   参加パネルが「自分で操作にした会社がありません」のままで、参加リンクを
//   発行できなかった。1 Turn 進めると現れた。Turn 2 で MASS を切り替えた
//   ときも同じで、「あと 1 社の提出待ち」も BAL しか数えていなかった。
//
//   原因は保存側にある。参加枠API（app/api/v2/management/player-seats/
//   [runId]/route.ts:93）は stored.run.companyControlModes を読む。
//   ところが run.companyControlModes を書いていたのは Turn 進行の経路だけで
//   （ManagementConsole.tsx:728 / :745）、経営モードの切替で走る保存では
//   モードが resumePayload 側にしか入らず、run には入らなかった。
//   その結果「画面では自分で操作になっているのに、サーバーの run はまだ
//   STANDARD_AI のまま」という状態が、次の Turn 進行まで続いていた。
//
//   Turn 進行ゲート（handlers.ts:167）も同じ run.companyControlModes を
//   見るため、提出待ち社数も同時にずれる。
//
// 【このテスト群が守ること】
//   A. 経営モードを渡して保存したら、サーバーへ渡る run にそのモードが載る
//   B. Turn を進めていなくても載る（実機の症状そのもの）
//   C. PLAYER が1社も居ないRunの run は、この機能の導入前と同じ形のまま

import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  SIMULATION_RUN_BODY_ENCODING_GZIP,
  SIMULATION_RUN_BODY_ENCODING_HEADER,
} from "../../../../lib/v2/companyLab/simulation/persistence/partBodyEncoding";
import { createSimulationSession, advanceSimulationTurn } from "../../../../lib/v2/companyLab/simulation/engine";
import type { CompanyControlMode, SimulationSession } from "../../../../lib/v2/companyLab/simulation/types";

const AT = "2026-10-17T00:00:00.000Z";

interface SavedManifest {
  readonly run: { readonly simulationRunId: string; readonly companyControlModes?: Readonly<Record<string, CompanyControlMode>> };
}

/** 実サーバーと同じ受け取り方（gzip ヘッダがあれば展開してから JSON）。 */
function parseRequestBody(init: RequestInit): Record<string, unknown> {
  const headers = (init.headers ?? {}) as Record<string, string>;
  const encoding = (headers[SIMULATION_RUN_BODY_ENCODING_HEADER] ?? "").trim().toLowerCase();
  if (encoding === SIMULATION_RUN_BODY_ENCODING_GZIP) {
    const view = init.body as unknown as Uint8Array;
    return JSON.parse(gunzipSync(Buffer.from(view)).toString("utf8")) as Record<string, unknown>;
  }
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** manifest commit だけを捕まえる最小のフェイクサーバー。 */
function installFakeServer() {
  const manifests: SavedManifest[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/v2/simulation-runs" && init?.method === "POST") {
      const body = parseRequestBody(init);
      if (body.manifestOnly) manifests.push({ run: body.run as SavedManifest["run"] });
      return new Response(JSON.stringify({ ok: true, persistenceRevision: manifests.length }), { status: 200 });
    }
    if (url.startsWith("/api/v2/simulation-runs")) return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { manifests };
}

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

/**
 * 実エンジンでセッションを作る（簡略なスタブでは buildResumePayload が通らないため、
 * 実機と同じ経路で作る）。completedTurns ぶん Turn を進める。
 */
function sessionAt(completedTurns: number): SimulationSession {
  let session = createSimulationSession({
    simulationRunId: "seat1-run",
    scenarioId: "baseline",
    seed: "seat1",
    requestedTurns: 32,
    startedAt: AT,
    sourceCommit: "SEAT1",
  });
  for (let turn = 1; turn <= completedTurns; turn += 1) {
    const outcome = advanceSimulationTurn(session, AT, {}, "SEAT1");
    assert.ok(outcome.session, `Turn ${turn} を進められなかった: ${outcome.error?.message ?? "理由不明"}`);
    session = outcome.session;
  }
  return session;
}

async function freshPersistRun() {
  return import(`../persistRun?t=${Math.random()}`);
}

test("SEAT-1: 経営モードを切り替えて保存したら、サーバーへ渡る run にそのモードが載る", async () => {
  installFakeWindow();
  const server = installFakeServer();
  const mod = await freshPersistRun();

  const modes: Readonly<Record<string, CompanyControlMode>> = { BAL: "PLAYER" };
  const result = await mod.persistResumableRun(sessionAt(0), modes, {});
  assert.equal(result.serverSaveSucceeded, true, `保存が失敗した: ${result.serverError}`);

  const manifest = server.manifests.at(-1);
  assert.ok(manifest, "manifest commit が送られていない");
  assert.deepEqual(
    manifest.run.companyControlModes,
    { BAL: "PLAYER" },
    "保存された run に経営モードが載っていない（参加枠APIはここを読むため、参加リンクを発行できない）"
  );
});

test("SEAT-2: Turn を1つも進めていなくても載る（実機で出た症状そのもの）", async () => {
  installFakeWindow();
  const server = installFakeServer();
  const mod = await freshPersistRun();

  // completedTurns = 0。Turn 進行の経路は一度も通っていない。
  await mod.persistResumableRun(sessionAt(0), { BAL: "PLAYER" } as Readonly<Record<string, CompanyControlMode>>, {});
  assert.equal(
    server.manifests.at(-1)?.run.companyControlModes?.BAL,
    "PLAYER",
    "Turn 0 の時点で run にモードが載っていない"
  );
});

test("SEAT-3: 途中Turnで会社を足したときも、その場で載る", async () => {
  installFakeWindow();
  const server = installFakeServer();
  const mod = await freshPersistRun();

  await mod.persistResumableRun(sessionAt(2), { BAL: "PLAYER" } as Readonly<Record<string, CompanyControlMode>>, {});
  await mod.persistResumableRun(
    sessionAt(2),
    { BAL: "PLAYER", MASS: "PLAYER" } as Readonly<Record<string, CompanyControlMode>>,
    {}
  );
  assert.deepEqual(
    server.manifests.at(-1)?.run.companyControlModes,
    { BAL: "PLAYER", MASS: "PLAYER" },
    "あとから足した会社が run に載っていない（提出待ち社数もずれる）"
  );
});

test("SEAT-4: PLAYERが1社も居ないRunの run は、この修正の前と同じ形のまま", async () => {
  installFakeWindow();
  const server = installFakeServer();
  const mod = await freshPersistRun();

  await mod.persistResumableRun(sessionAt(0), {} as Readonly<Record<string, CompanyControlMode>>, {});
  const run = server.manifests.at(-1)?.run as Record<string, unknown> | undefined;
  assert.ok(run, "manifest commit が送られていない");
  assert.equal(
    "companyControlModes" in run,
    false,
    "全社 Standard AI のRunに companyControlModes キーが増えている（既存Runと同じ形を保つこと）"
  );
});
