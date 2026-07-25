// ShrimpX V2 — app/lib/stagingExport.ts のテスト
//
// STAGING_ADMIN_TOKENのテスト（stagingAdmin.test.ts）と同じ構造・同じ検証方針を、
// STAGING_EXPORT_TOKEN専用に踏襲する。isProductionはモジュール読込時に一度だけ
// 確定するトップレベルconstのため、本番環境での拒否は別プロセス（npx tsx -e）で検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";
import { checkStagingExportToken, assertStagingExport } from "../stagingExport";

const ORIGINAL_TOKEN_ENV = process.env.STAGING_EXPORT_TOKEN;

function withStagingExportToken<T>(token: string | undefined, fn: () => T): T {
  const original = process.env.STAGING_EXPORT_TOKEN;
  if (token === undefined) {
    delete process.env.STAGING_EXPORT_TOKEN;
  } else {
    process.env.STAGING_EXPORT_TOKEN = token;
  }
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.STAGING_EXPORT_TOKEN;
    } else {
      process.env.STAGING_EXPORT_TOKEN = original;
    }
  }
}

test.after(() => {
  if (ORIGINAL_TOKEN_ENV === undefined) {
    delete process.env.STAGING_EXPORT_TOKEN;
  } else {
    process.env.STAGING_EXPORT_TOKEN = ORIGINAL_TOKEN_ENV;
  }
});

// --- 必須テスト(1): 正しいトークンでのGET成功（の前提となるトークン照合成功） ---

test("checkStagingExportToken: 正しいトークンなら認証成功する", () => {
  withStagingExportToken("correct-export-token-xyz", () => {
    const result = checkStagingExportToken("correct-export-token-xyz");
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
  });
});

// --- 必須テスト(2): 未設定/欠落/不正トークンの拒否 ---

test("checkStagingExportToken: 誤ったトークンは拒否される", () => {
  withStagingExportToken("correct-export-token-xyz", () => {
    const result = checkStagingExportToken("wrong-token");
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test("checkStagingExportToken: トークン未指定（null）は拒否される", () => {
  withStagingExportToken("correct-export-token-xyz", () => {
    const result = checkStagingExportToken(null);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test("checkStagingExportToken: トークン未指定（undefined）は拒否される", () => {
  withStagingExportToken("correct-export-token-xyz", () => {
    const result = checkStagingExportToken(undefined);
    assert.equal(result.ok, false);
  });
});

test("checkStagingExportToken: 空文字列は拒否される", () => {
  withStagingExportToken("correct-export-token-xyz", () => {
    const result = checkStagingExportToken("");
    assert.equal(result.ok, false);
  });
});

test("checkStagingExportToken: サーバー側にSTAGING_EXPORT_TOKENが未設定なら、どんな入力でも拒否される（fail-closed）", () => {
  withStagingExportToken(undefined, () => {
    const result = checkStagingExportToken("anything");
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test("checkStagingExportToken: トークン不一致とトークン未設定は、同一のエラーメッセージ・ステータスになる（推測防止）", () => {
  const wrongTokenResult = withStagingExportToken("correct-export-token-xyz", () => checkStagingExportToken("wrong"));
  const noTokenResult = withStagingExportToken(undefined, () => checkStagingExportToken("wrong"));
  assert.equal(wrongTokenResult.status, noTokenResult.status);
  assert.equal(wrongTokenResult.error, noTokenResult.error);
});

// --- assertStagingExport（NextRequestからのBearerヘッダー抽出） ---

test("assertStagingExport: 正しいBearerヘッダーで認証成功する", () => {
  withStagingExportToken("correct-export-token-xyz", () => {
    const req = new NextRequest("http://localhost/api/v2/exports/company-labs/lab1", {
      headers: { authorization: "Bearer correct-export-token-xyz" },
    });
    const result = assertStagingExport(req);
    assert.equal(result.ok, true);
  });
});

test("assertStagingExport: Authorizationヘッダーが無ければ拒否される", () => {
  withStagingExportToken("correct-export-token-xyz", () => {
    const req = new NextRequest("http://localhost/api/v2/exports/company-labs/lab1");
    const result = assertStagingExport(req);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test("assertStagingExport: 'Bearer '接頭辞が無いAuthorizationヘッダーは拒否される", () => {
  withStagingExportToken("correct-export-token-xyz", () => {
    const req = new NextRequest("http://localhost/api/v2/exports/company-labs/lab1", {
      headers: { authorization: "correct-export-token-xyz" },
    });
    const result = assertStagingExport(req);
    assert.equal(result.ok, false);
  });
});

test("assertStagingExport: クエリパラメータにトークンを付けても認証されない（Authorizationヘッダーのみが正当な経路）", () => {
  withStagingExportToken("correct-export-token-xyz", () => {
    const req = new NextRequest("http://localhost/api/v2/exports/company-labs/lab1?token=correct-export-token-xyz");
    const result = assertStagingExport(req);
    assert.equal(result.ok, false);
  });
});

// --- 必須テスト(9)の一部: 応答にトークン自体を含まない ---

test("assertStagingExport: 応答にトークン自体やSTAGING_EXPORT_TOKENという語を含まない（秘密情報を漏らさない）", () => {
  withStagingExportToken("correct-export-token-xyz", () => {
    const req = new NextRequest("http://localhost/api/v2/exports/company-labs/lab1", { headers: { authorization: "Bearer wrong" } });
    const result = assertStagingExport(req);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("correct-export-token-xyz"), false);
    assert.equal(serialized.toUpperCase().includes("STAGING_EXPORT_TOKEN"), false);
  });
});

// --- 必須テスト(3): 本番環境では正しいトークンでも拒否される（別プロセスで検証） ---

test("checkStagingExportToken: 本番環境（APP_ENV=production）では、正しいトークンでも拒否される", () => {
  const script = `
    import { checkStagingExportToken } from "./app/lib/stagingExport";
    const result = checkStagingExportToken("correct-export-token-xyz");
    console.log(JSON.stringify(result));
  `;
  const out = execFileSync("npx", ["tsx", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, APP_ENV: "production", STAGING_EXPORT_TOKEN: "correct-export-token-xyz" },
    encoding: "utf8",
  });
  const result = JSON.parse(out.trim().split("\n").pop() ?? "{}");
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /本番環境/);
});
