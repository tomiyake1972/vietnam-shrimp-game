// ShrimpX V2 — Persistence Architecture Phase 3: simulationRunStore のテスト（PERSIST-D1〜D10ほか）
//
// 【このテスト群が守る因果】
// 実stagingで、localStorageへ full StoredSimulationRun（dataset・packCapture・
// resumePayload込み）を保存する旧設計が、Turn26付近でQuotaExceededErrorを起こした。
// 新設計はブラウザを「軽量キャッシュ（SimulationRunSummaryだけ）」に限定し、
// server（Redis）をauthoritativeとする。このテスト群は:
//   1. ブラウザ側の保存物がdataset等の巨大フィールドを一切持たないこと
//      （PERSIST-D2, PERSIST-D9-ish）
//   2. loadSimulationRunが常にserverだけをauthoritativeな情報源として使い、
//      browserの（古い・新しいに関わらず）summaryだけでは完全なStoredSimulationRunを
//      作らないこと（PERSIST-D6, PERSIST-D10-ish）
//   3. server保存の成否（serverSaveSucceeded）だけがTurn進行の可否を決め、
//      browser cache単独の失敗ではブロックしないこと（PERSIST-D3, PERSIST-D4）
//   4. 失敗を silent successにしないこと（degraded表現。既存PERSIST-5/6の踏襲）
// を守る。
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
  key(index: number): string | null;
  readonly length: number;
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
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

/**
 * サーバー側の保存物を模す、テストごとに独立したin-memoryストア。
 *
 * 【Persistence Architecture Phase 3】実際のAPI（app/api/v2/simulation-runs/route.ts）は
 * dataset/resume/packを個別のPOST（{simulationRunId, revision, part, value}）で受け、
 * 最後にmanifestOnly:trueのPOSTでcommitする（manifest-last。redisRepository.tsと同じ
 * 意味論）。このフェイクもそれに合わせて、part単位で受けてrevisionごとに保持し、
 * manifestOnlyのPOSTを受けて初めてGETで見えるようにする（committされていない
 * revisionのpartはGETで読めない、という実物の挙動を再現する）。
 * `store`（呼び出し元へ返す）は「manifest committされた最新の完全なRun」を
 * simulationRunId→StoredSimulationRun-shapeで保持する（テストがGET結果を直接
 * 差し替えたい場合に使う。PERSIST-D9参照）。
 */
function installFakeServer(initial: Map<string, unknown> = new Map()) {
  const store = initial;
  let serverUp = true;
  let forcedStatus: number | null = null;
  const partsByRunAndRevision = new Map<string, Record<string, unknown>>();

  function partsKey(id: string, revision: number): string {
    return `${id}:${revision}`;
  }

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!serverUp) return new Response(null, { status: 500 });
    if (forcedStatus !== null) return new Response(JSON.stringify({ error: { code: "FORCED", message: "forced" } }), { status: forcedStatus });
    if (url === "/api/v2/simulation-runs" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body.manifestOnly) {
        const run = body.run as { simulationRunId: string };
        const revision = body.persistenceRevision as number;
        const key = partsKey(run.simulationRunId, revision);
        const parts = partsByRunAndRevision.get(key) ?? {};
        store.set(run.simulationRunId, {
          schemaVersion: 5,
          run,
          dataset: parts.dataset ?? { turns: [] },
          resumePayload: parts.resume,
          packCapture: parts.pack,
          savedAt: body.savedAt,
          persistenceRevision: revision,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const simulationRunId = body.simulationRunId as string;
      const revision = body.revision as number;
      const part = body.part as string;
      const key = partsKey(simulationRunId, revision);
      const parts = partsByRunAndRevision.get(key) ?? {};
      parts[part] = body.value;
      partsByRunAndRevision.set(key, parts);
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
      const runs = [...store.values()].map((r) => {
        const stored = r as { run: { simulationRunId: string; completedTurns: number }; savedAt: string; persistenceRevision?: number };
        return { simulationRunId: stored.run.simulationRunId, completedTurns: stored.run.completedTurns, savedAt: stored.savedAt, persistenceRevision: stored.persistenceRevision };
      });
      return new Response(JSON.stringify({ runs }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { store, setServerUp: (up: boolean) => (serverUp = up), forceStatus: (status: number | null) => (forcedStatus = status) };
}

function stubRun(id: string, completedTurns: number, extraCompanyMetricsCount = 0) {
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
    dataset: {
      schemaVersion: "simulationAnalytics-v1",
      turns: [],
      companies: [],
      companyMetrics: Array.from({ length: extraCompanyMetricsCount }, (_, i) => ({ turn: i, companyId: "BAL", metric: "revenue", value: 1 })),
      marketMetrics: [],
      producerCountryMetrics: [],
      bottlenecks: [],
      aiTrace: [],
      salesTrace: [],
      hiringTrace: [],
      investmentTrace: [],
      contribution: [],
      fixedCosts: [],
      salesAllocation: [],
    },
    savedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function withFreshStore<T>(quotaBytes: number | null, run: (store: typeof import("../simulationRunStore")) => Promise<T>): Promise<T> {
  (globalThis as unknown as { window: { localStorage: FakeStorage } }).window = { localStorage: createFakeLocalStorage(quotaBytes) };
  const mod = await import(`../simulationRunStore?t=${Math.random()}`);
  return run(mod);
}

// PERSIST-D9相当: サーバーがauthoritative。loadSimulationRunはサーバーの値をそのまま返す。
test("PERSIST-D9: loadSimulationRunはサーバー保存物をそのまま返す（authoritative）", async () => {
  const { store } = installFakeServer();
  await withFreshStore(null, async (mod) => {
    await mod.saveSimulationRun(stubRun("run-a", 8) as never);
    store.set("run-a", { ...stubRun("run-a", 10), persistenceRevision: 999 });
    const loaded = await mod.loadSimulationRun("run-a");
    assert.equal(loaded?.run.completedTurns, 10, "サーバーの値がそのまま返っていない");
  });
});

// PERSIST-D10相当: server未到達時、browserにcacheがあっても完全なStoredSimulationRunは
// 組み立てられない（旧設計の「browserだけで32Q完全復元」を維持しない、指示§22/§23）。
test("PERSIST-D10: serverが読めない場合、browserにcacheがあってもloadSimulationRunはnullを返す", async () => {
  const { setServerUp } = installFakeServer();
  await withFreshStore(null, async (mod) => {
    await mod.saveSimulationRun(stubRun("run-b", 10) as never);
    setServerUp(false);
    const loaded = await mod.loadSimulationRun("run-b");
    assert.equal(loaded, null, "serverが読めないのにbrowser cacheから完全なRunを組み立ててしまっている");
  });
});

// server未到達時でも、識別用のsummaryだけは軽量キャッシュから取り出せる。
test("serverが読めない場合でも、loadBrowserCacheSummaryFallbackで識別情報（summary）だけは取れる", async () => {
  const { setServerUp } = installFakeServer();
  await withFreshStore(null, async (mod) => {
    await mod.saveSimulationRun(stubRun("run-b2", 10) as never);
    setServerUp(false);
    const summary = mod.loadBrowserCacheSummaryFallback("run-b2");
    assert.equal(summary?.completedTurns, 10, "browser cacheからsummaryが取れていない");
  });
});

// PERSIST-4相当: 複数回保存してもrevisionは単調増加する。
test("PERSIST-D: 複数回保存してもpersistenceRevisionは単調増加する", async () => {
  installFakeServer();
  await withFreshStore(null, async (mod) => {
    const first = await mod.saveSimulationRun(stubRun("run-c", 10) as never);
    const second = await mod.saveSimulationRun(stubRun("run-c", 11) as never);
    assert.ok(second.persistenceRevision > first.persistenceRevision, "2回目の保存のrevisionが1回目以下になっている");
  });
});

// PERSIST-D3: server成功・browser cache失敗（quota）でも進行可能（serverSaveSucceeded=true）。
test("PERSIST-D3: server保存が成功していれば、browser cache失敗（quota）でもRun進行を許す（serverSaveSucceeded=true）", async () => {
  installFakeServer();
  // browser cacheはsummaryだけの極小payloadのため、確実に収まらない程度に小さいquotaにする。
  await withFreshStore(10, async (mod) => {
    const result = await mod.saveSimulationRun(stubRun("run-d", 1) as never);
    assert.ok(result.browserError !== null, "quota超過なのにbrowserErrorがnullになっている（silent failure）");
    assert.equal(result.degraded, true, "browser保存失敗なのにdegraded=falseになっている");
    assert.equal(result.serverSaveSucceeded, true, "server保存は成功しているのにserverSaveSucceeded=falseになっている（browser失敗だけでRunを止めてはいけない）");
  });
});

// PERSIST-D4: server保存失敗時はserverSaveSucceeded=falseになり、Runを止める根拠になる。
test("PERSIST-D4: server保存が失敗した場合はserverSaveSucceeded=false（Runを止める根拠になる）", async () => {
  const { setServerUp } = installFakeServer();
  setServerUp(false);
  await withFreshStore(null, async (mod) => {
    const result = await mod.saveSimulationRun(stubRun("run-e", 5) as never);
    assert.ok(result.serverError !== null);
    assert.equal(result.degraded, true);
    assert.equal(result.serverSaveSucceeded, false);
    assert.deepEqual(result.savedTo, ["browser"]);
  });
});

// SERVER-D1相当: HTTP 403は「認証セッション切れ」の可能性を示す文言へ翻訳される
// （dataset HTTP 403 root cause調査。app/lib/companyLabUiSession.tsのセッション
// Cookieが、Management ConsoleのSimulation Run APIの唯一の認証経路になっている）。
test("SERVER-D1: server保存がHTTP 403を返した場合、認証セッション切れを示すメッセージになる", async () => {
  const { forceStatus } = installFakeServer();
  forceStatus(403);
  await withFreshStore(null, async (mod) => {
    const result = await mod.saveSimulationRun(stubRun("run-f", 5) as never);
    assert.equal(result.serverSaveSucceeded, false);
    assert.match(result.serverError ?? "", /403/);
    assert.match(result.serverError ?? "", /セッション/);
  });
});

// PERSIST-D2: browser cacheはdatasetが巨大でも小さいまま（summaryだけを持つため）。
test("PERSIST-D2: browser cacheのサイズは、datasetがどれだけ大きくても小さいまま", async () => {
  installFakeServer();
  await withFreshStore(null, async (mod) => {
    // companyMetricsを大量に持つ巨大datasetでも、browser側はtoSimulationRunSummaryの
    // 結果（run metadataのみ）しか書かないため、成功する。
    const huge = stubRun("run-g", 29, 5000);
    const result = await mod.saveSimulationRun(huge as never);
    assert.equal(result.browserError, null, "巨大datasetのせいでbrowser cache保存が失敗している（summaryだけを保存しているはずが、まだ大きいものを書いている）");
  });
});

// PERSIST-15後継: 本体（サーバー）保存に失敗した場合、Run一覧はサーバー側の古い要約を返す
// （browser側のindexが新しいcompletedTurnsを指してしまい、実際には存在しないrevisionを
// 正本であるかのように見せない）。
test("server保存に失敗した場合、listSimulationRunsはサーバー側の古いsummaryを返す（browser側の新しいsummaryを正本として見せない）", async () => {
  const { setServerUp } = installFakeServer();
  await withFreshStore(null, async (mod) => {
    const okResult = await mod.saveSimulationRun(stubRun("run-h", 5) as never);
    assert.equal(okResult.serverSaveSucceeded, true, "前提: 最初の保存はサーバーへ成功していること");

    setServerUp(false);
    const failResult = await mod.saveSimulationRun(stubRun("run-h", 29) as never);
    assert.equal(failResult.serverSaveSucceeded, false, "前提: 2回目はサーバー保存が失敗していること");

    setServerUp(true);
    const summaries = await mod.listSimulationRuns();
    const summary = summaries.find((s) => s.simulationRunId === "run-h");
    assert.equal(summary?.completedTurns, 5, "サーバー保存に失敗したのに、一覧が未保存のcompletedTurns=29を指している");
  });
});

// PERSIST-14: 複数Runの独立性 — 片方のrevisionが他方に混線しない
test("複数Runを保存しても、revisionカウンタが別Run同士で混線しない", async () => {
  installFakeServer();
  await withFreshStore(null, async (mod) => {
    const a1 = await mod.saveSimulationRun(stubRun("run-f-a", 5) as never);
    const b1 = await mod.saveSimulationRun(stubRun("run-f-b", 5) as never);
    const a2 = await mod.saveSimulationRun(stubRun("run-f-a", 6) as never);
    assert.equal(a2.persistenceRevision, a1.persistenceRevision + 1, "run-f-aのrevisionがrun-f-bの保存に影響されている");
    assert.equal(b1.persistenceRevision, 1);
  });
});

// PERSIST-D7相当: 旧形式（`shrimpx:v2:simulationRun:{id}` へfull runを直接保存していた
// 形式）のエントリが残っていても、新しい保存の際にベストエフォートで掃除される。
test("PERSIST-D7: 旧形式のfull-run localStorageエントリは、新しい保存時に掃除される", async () => {
  installFakeServer();
  await withFreshStore(null, async (mod) => {
    const storage = (globalThis as unknown as { window: { localStorage: FakeStorage } }).window.localStorage;
    // 旧実装が書いていた形式を模す（巨大なfull run JSON）。
    storage.setItem("shrimpx:v2:simulationRun:legacy-run-id", JSON.stringify({ dataset: { big: "x".repeat(1000) } }));
    assert.ok(storage.getItem("shrimpx:v2:simulationRun:legacy-run-id") !== null, "前提: 旧形式エントリが書き込めていること");

    await mod.saveSimulationRun(stubRun("run-i", 1) as never);

    assert.equal(storage.getItem("shrimpx:v2:simulationRun:legacy-run-id"), null, "旧形式のfull-runエントリが掃除されていない");
  });
});
