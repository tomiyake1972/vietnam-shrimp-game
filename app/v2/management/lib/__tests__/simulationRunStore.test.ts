// ShrimpX V2 — Save/Resume 長期永続化・鮮度整合 BLOCKER修正: simulationRunStore のテスト（PERSIST-2〜7,14）
//
// 【このテスト群が守る因果】
// browser（localStorage）とserver（Redis）に別々の世代のRunが存在しても、
// loadSimulationRunは常により新しい方を選ぶこと。古いbrowserエントリがnon-nullで
// あるというだけの理由でそれが選ばれてしまう旧実装のバグ（指示§1）を再発させないこと。
//
// window/fetch はテストプロセス内でのみ差し替えるモジュールレベルのグローバルであり、
// このファイルは他のテストファイルと別プロセスで実行される前提（node --test の
// デフォルト挙動）。他ファイルの状態に影響しない。

import { test } from "node:test";
import assert from "node:assert/strict";

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function createFakeLocalStorage(quotaBytes: number | null): FakeStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => {
      let total = value.length;
      for (const [k, v] of data) if (k !== key) total += v.length;
      if (quotaBytes !== null && total > quotaBytes) {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      }
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

/** サーバー側の保存物を模す、テストごとに独立したin-memoryストア。 */
function installFakeServer(initial: Map<string, unknown> = new Map()) {
  const store = initial;
  let serverUp = true;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!serverUp) return new Response(null, { status: 500 });
    if (url === "/api/v2/simulation-runs" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      store.set(body.run.simulationRunId, body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const match = url.match(/^\/api\/v2\/simulation-runs\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const found = store.get(id);
      if (!found) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(found), { status: 200 });
    }
    if (url === "/api/v2/simulation-runs") {
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { store, setServerUp: (up: boolean) => (serverUp = up) };
}

function stubRun(id: string, completedTurns: number) {
  return {
    schemaVersion: 4,
    run: {
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
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      stopReason: "running" as const,
      errorMessage: null,
      failedAtTurn: null,
    },
    dataset: { schemaVersion: "simulationAnalytics-v1", turns: [], companies: [], companyMetrics: [], marketMetrics: [], producerCountryMetrics: [], bottlenecks: [], aiTrace: [], salesTrace: [], hiringTrace: [], investmentTrace: [], contribution: [], fixedCosts: [], salesAllocation: [] },
    savedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function withFreshStore<T>(quotaBytes: number | null, run: (store: typeof import("../simulationRunStore")) => Promise<T>): Promise<T> {
  (globalThis as unknown as { window: { localStorage: FakeStorage } }).window = { localStorage: createFakeLocalStorage(quotaBytes) };
  const mod = await import(`../simulationRunStore?t=${Math.random()}`);
  return run(mod);
}

// PERSIST-2: browser Q8 / server Q10 → Q10（serverを選ぶ）
test("PERSIST-2: browserが古くserverが新しい場合、loadSimulationRunはserverを選ぶ", async () => {
  const { store } = installFakeServer();
  await withFreshStore(null, async (mod) => {
    const saved = await mod.saveSimulationRun(stubRun("run-a", 8) as never);
    // browser に Q8（revision=saved.persistenceRevision）が入った状態で、server 側にだけ
    // より高いrevisionを持つQ10を投入する（別端末で進んだ想定）。
    store.set("run-a", { ...stubRun("run-a", 10), persistenceRevision: saved.persistenceRevision + 1 });
    const loaded = await mod.loadSimulationRun("run-a");
    assert.equal(loaded?.run.completedTurns, 10, "serverの方が新しいのにbrowserの古いQ8が選ばれている");
  });
});

// PERSIST-3: browser Q10 / server Q8 → Q10（browserを選ぶ）
test("PERSIST-3: browserが新しくserverが古い場合、loadSimulationRunはbrowserを選ぶ", async () => {
  const { store } = installFakeServer();
  await withFreshStore(null, async (mod) => {
    await mod.saveSimulationRun(stubRun("run-b", 8) as never);
    store.set("run-b", stubRun("run-b", 8)); // serverはQ8のまま
    await mod.saveSimulationRun(stubRun("run-b", 10) as never); // browserはQ10まで進む
    // saveSimulationRunは両方へ書くので、serverを意図的に古いまま固定するために書き戻す。
    store.set("run-b", stubRun("run-b", 8));
    const loaded = await mod.loadSimulationRun("run-b");
    assert.equal(loaded?.run.completedTurns, 10, "browserの方が新しいのにserverの古いQ8が選ばれている");
  });
});

// PERSIST-4: 同一Turnでもrevisionが新しい方を選ぶ
test("PERSIST-4: 同じcompletedTurnsでも、より高いpersistenceRevisionを持つ方を選ぶ", async () => {
  const { store } = installFakeServer();
  await withFreshStore(null, async (mod) => {
    const first = await mod.saveSimulationRun(stubRun("run-c", 10) as never);
    const second = await mod.saveSimulationRun(stubRun("run-c", 10) as never);
    assert.ok(second.persistenceRevision > first.persistenceRevision, "2回目の保存のrevisionが1回目以下になっている");
    // serverを意図的に1回目のrevisionへ巻き戻す。
    const firstStored = { ...stubRun("run-c", 10), persistenceRevision: first.persistenceRevision };
    store.set("run-c", firstStored);
    const loaded = await mod.loadSimulationRun("run-c");
    assert.equal(loaded?.persistenceRevision, second.persistenceRevision, "revisionの低い方が選ばれている");
  });
});

// PERSIST-5: QuotaExceededErrorはsilent failureにならない（browserErrorとして返る）
test("PERSIST-5: browser保存がQuotaExceededErrorで失敗した場合、silentに成功扱いにしない", async () => {
  installFakeServer();
  await withFreshStore(500, async (mod) => {
    // 本体payload(約700バイト)より小さいquotaで、確実にQuotaExceededErrorを起こす
    // （indexだけは書ける程度の余地は残す）。
    const result = await mod.saveSimulationRun(stubRun("run-d", 1) as never);
    assert.ok(result.browserError !== null, "quota超過なのにbrowserErrorがnullになっている（silent failure）");
    assert.equal(result.degraded, true, "browser保存失敗なのにdegraded=falseになっている");
  });
});

// PERSIST-6: server保存失敗もdegraded状態として表現される
test("PERSIST-6: server保存が失敗した場合もdegraded=trueとして表現される（silent successにしない）", async () => {
  const { setServerUp } = installFakeServer();
  setServerUp(false);
  await withFreshStore(null, async (mod) => {
    const result = await mod.saveSimulationRun(stubRun("run-e", 5) as never);
    assert.ok(result.serverError !== null);
    assert.equal(result.degraded, true);
    assert.deepEqual(result.savedTo, ["browser"]);
  });
});

// PERSIST-15: index（Run History一覧・概要表示）が、本体保存に失敗した新しいsummaryを
// 指してしまわない（実ブラウザE2Eで発見: confirm直後にQuota超過が起きた場合、画面上部が
// 新しいcompletedTurnsを指す一方、実際に復元される本体は古いturnのままという食い違いがあった）。
test("PERSIST-15: 本体保存に失敗した場合、browser indexは古い（最後に成功した）summaryのままになる", async () => {
  installFakeServer();
  await withFreshStore(2000, async (mod) => {
    const okResult = await mod.saveSimulationRun(stubRun("run-g", 5) as never);
    assert.equal(okResult.browserError, null, "前提: 最初の保存は容量内で成功していること");

    // 2回目は極端に巨大なdatasetを載せ、本体保存だけを確実に失敗させる。
    const huge = { ...stubRun("run-g", 29), dataset: { ...stubRun("run-g", 29).dataset, companyMetrics: Array.from({ length: 500 }, (_, i) => ({ turn: i, companyId: "BAL", metric: "revenue", value: 1 })) } };
    const failResult = await mod.saveSimulationRun(huge as never);
    assert.ok(failResult.browserError !== null, "前提: 2回目の本体保存が容量超過で失敗していること");

    const summaries = await mod.listSimulationRuns();
    const summary = summaries.find((s) => s.simulationRunId === "run-g");
    assert.equal(summary?.completedTurns, 5, "本体保存に失敗したのに、indexが新しい（未保存の）completedTurns=29を指している");
  });
});

// PERSIST-14: 複数Runの独立性 — 片方のrevisionが他方に混線しない
test("PERSIST-14: 複数Runを保存しても、revisionカウンタが別Run同士で混線しない", async () => {
  installFakeServer();
  await withFreshStore(null, async (mod) => {
    const a1 = await mod.saveSimulationRun(stubRun("run-f-a", 5) as never);
    const b1 = await mod.saveSimulationRun(stubRun("run-f-b", 5) as never);
    const a2 = await mod.saveSimulationRun(stubRun("run-f-a", 6) as never);
    assert.equal(a2.persistenceRevision, a1.persistenceRevision + 1, "run-f-aのrevisionがrun-f-bの保存に影響されている");
    assert.equal(b1.persistenceRevision, 1);
  });
});
