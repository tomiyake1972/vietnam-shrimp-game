// ShrimpX V2 — companyLabAdminExportSource.ts のテスト
//
// 【カバーする必須テスト】
//   - Productionでは拒否する
//   - Secret未設定時に拒否する（fail-closed）
//   - トークンがエラーメッセージ等（クライアントへ返る情報）へ一切露出しない
//   - Authorizationヘッダーの組み立てが正しいこと（fetchへ渡すheadersを検証）

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkAdminExportPreconditions, fetchLabIndex, isExportSecretAvailable } from "../companyLabAdminExportSource";

const ORIGINAL_TOKEN_ENV = process.env.STAGING_EXPORT_TOKEN;

function withExportToken<T>(token: string | undefined, fn: () => T): T {
  const original = process.env.STAGING_EXPORT_TOKEN;
  if (token === undefined) delete process.env.STAGING_EXPORT_TOKEN;
  else process.env.STAGING_EXPORT_TOKEN = token;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.STAGING_EXPORT_TOKEN;
    else process.env.STAGING_EXPORT_TOKEN = original;
  }
}

test.after(() => {
  if (ORIGINAL_TOKEN_ENV === undefined) delete process.env.STAGING_EXPORT_TOKEN;
  else process.env.STAGING_EXPORT_TOKEN = ORIGINAL_TOKEN_ENV;
});

test("checkAdminExportPreconditions: STAGING_EXPORT_TOKEN未設定ならsecretNotConfiguredで拒否する（fail-closed）", () => {
  withExportToken(undefined, () => {
    const result = checkAdminExportPreconditions();
    assert.ok(result);
    assert.equal(result?.reason, "secretNotConfigured");
  });
});

test("checkAdminExportPreconditions: STAGING_EXPORT_TOKEN設定済みなら非本番環境ではnull（許可）を返す", () => {
  withExportToken("dummy-token-for-precondition-check", () => {
    const result = checkAdminExportPreconditions();
    assert.equal(result, null);
  });
});

test("isExportSecretAvailable: トークン未設定ならfalse、設定済みならtrueを返す（値は一切公開しない）", () => {
  withExportToken(undefined, () => {
    assert.equal(isExportSecretAvailable(), false);
  });
  withExportToken("dummy-token-for-precondition-check", () => {
    assert.equal(isExportSecretAvailable(), true);
  });
});

test("checkAdminExportPreconditions: 本番環境（APP_ENV=production）では、トークンが設定済みでもproductionDisabledで拒否する", () => {
  const script = `
    import { checkAdminExportPreconditions } from "./app/lib/v2/companyLab/adminExport/companyLabAdminExportSource";
    const result = checkAdminExportPreconditions();
    console.log(JSON.stringify(result));
  `;
  const out = execFileSync("npx", ["tsx", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, APP_ENV: "production", STAGING_EXPORT_TOKEN: "correct-token-xyz" },
    encoding: "utf8",
  });
  const result = JSON.parse(out.trim().split("\n").pop() ?? "{}");
  assert.equal(result.reason, "productionDisabled");
});

test("fetchLabIndex: Authorizationヘッダーへ正しくBearerトークンを組み立てて送り、応答にトークン値が一切含まれない", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Headers | undefined;
  let capturedUrl: string | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ schemaVersion: 1, generatedAt: "x", labId: "lab1", engineVersion: "e", dataStatus: "confirmed", playerCompanyId: "BAL", availableTurns: [1], latestProcessedTurn: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await withExportToken("captured-token-value-xyz", async () => {
      const result = await fetchLabIndex("http://example.test", "lab1");
      assert.equal(result.ok, true);
      assert.equal(capturedUrl, "http://example.test/api/v2/exports/company-labs/lab1");
      assert.equal(capturedHeaders?.get("authorization"), "Bearer captured-token-value-xyz");

  const serialized = JSON.stringify(result);
      assert.equal(serialized.includes("captured-token-value-xyz"), false, "戻り値にトークン値が含まれてはならない");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchLabIndex: VERCEL_AUTOMATION_BYPASS_SECRETが設定されていれば、x-vercel-protection-bypassヘッダーを付けて自己fetchする（値は戻り値に含まれない）", async () => {
  const originalFetch = globalThis.fetch;
  const originalBypassEnv = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  let capturedHeaders: Headers | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ schemaVersion: 1, generatedAt: "x", labId: "lab1", engineVersion: "e", dataStatus: "confirmed", playerCompanyId: "BAL", availableTurns: [1], latestProcessedTurn: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "captured-bypass-secret-xyz";

  try {
    await withExportToken("token-for-bypass-test", async () => {
      const result = await fetchLabIndex("http://example.test", "lab1");
      assert.equal(result.ok, true);
      assert.equal(capturedHeaders?.get("x-vercel-protection-bypass"), "captured-bypass-secret-xyz");
      assert.equal(capturedHeaders?.get("x-vercel-set-bypass-cookie"), "true");

      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes("captured-bypass-secret-xyz"), false, "戻り値にbypass secretの値が含まれてはならない");
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBypassEnv === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = originalBypassEnv;
  }
});

test("fetchLabIndex: VERCEL_AUTOMATION_BYPASS_SECRET未設定でも、x-vercel-protection-bypassヘッダーを付けずに従来通り動作する", async () => {
  const originalFetch = globalThis.fetch;
  const originalBypassEnv = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  let capturedHeaders: Headers | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ schemaVersion: 1, generatedAt: "x", labId: "lab1", engineVersion: "e", dataStatus: "confirmed", playerCompanyId: "BAL", availableTurns: [1], latestProcessedTurn: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  try {
    await withExportToken("token-for-no-bypass-test", async () => {
      const result = await fetchLabIndex("http://example.test", "lab1");
      assert.equal(result.ok, true);
      assert.equal(capturedHeaders?.has("x-vercel-protection-bypass"), false);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBypassEnv === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = originalBypassEnv;
  }
});

test("fetchLabIndex: Export APIが401(Vercel Deployment Protectionによるブロックの想定)を返した場合、分かりやすいメッセージを返す", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>Authentication Required</html>", { status: 401, headers: { "content-type": "text/html" } })) as typeof fetch;
  try {
    await withExportToken("token-for-401-test", async () => {
      const result = await fetchLabIndex("http://example.test", "lab1");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.userMessage, /デプロイ保護|Deployment Protection/);
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchLabIndex: Export APIが404を返した場合、labNotFoundとして分かりやすいメッセージを返し、トークン値を含まない", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "LAB_NOT_FOUND", message: "not found" } }), { status: 404 })) as typeof fetch;
  try {
    await withExportToken("secret-should-not-leak", async () => {
      const result = await fetchLabIndex("http://example.test", "__no_such_lab__");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "labNotFound");
        assert.equal(result.userMessage.includes("secret-should-not-leak"), false);
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchLabIndex: Export APIが403を返した場合、secretNotConfiguredとして分かりやすいメッセージを返す", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "auth failed" } }), { status: 403 })) as typeof fetch;
  try {
    await withExportToken("secret-should-not-leak-2", async () => {
      const result = await fetchLabIndex("http://example.test", "lab1");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "secretNotConfigured");
        assert.equal(result.userMessage.includes("secret-should-not-leak-2"), false);
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
