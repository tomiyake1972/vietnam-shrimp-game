// ShrimpX V2 — app/lib/stagingAdmin.ts のテスト（Phase 8C-3B §13.2）
//
// checkStagingAdminToken（8C-3Bでassert StagingAdminから抽出・export済み）が
// 唯一のトークン比較・本番判定ロジックであり、既存のBearerヘッダー方式（JSON API）と
// 新しいCompany Lab UIのセッションログイン（companyLabUiSession.ts）の両方から
// 再利用される。ここでテストすれば、両方の呼び出し元の認証判定が同時に検証される。
//
// isProduction（app/lib/env.ts）はモジュール読込時に一度だけ確定するトップレベルconstで
// あり、この単一プロセス内で動的に切り替えられない。本番環境での拒否（403・本番専用の
// エラー文言）は、APP_ENV=production を設定した別プロセス（npx tsx -e）で検証する
// （node:child_process.execFileSyncを使う。モジュールキャッシュに一切依存しない、
// 最も確実な検証方法）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";
import { checkStagingAdminToken, assertStagingAdmin } from "../stagingAdmin";

const ORIGINAL_TOKEN_ENV = process.env.STAGING_ADMIN_TOKEN;

function withStagingAdminToken<T>(token: string | undefined, fn: () => T): T {
  const original = process.env.STAGING_ADMIN_TOKEN;
  if (token === undefined) {
    delete process.env.STAGING_ADMIN_TOKEN;
  } else {
    process.env.STAGING_ADMIN_TOKEN = token;
  }
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.STAGING_ADMIN_TOKEN;
    } else {
      process.env.STAGING_ADMIN_TOKEN = original;
    }
  }
}

test.after(() => {
  if (ORIGINAL_TOKEN_ENV === undefined) {
    delete process.env.STAGING_ADMIN_TOKEN;
  } else {
    process.env.STAGING_ADMIN_TOKEN = ORIGINAL_TOKEN_ENV;
  }
});

// --- checkStagingAdminToken（非本番環境。このテストプロセス自体がAPP_ENV未設定のためdevelopment＝非本番） ---

test("checkStagingAdminToken: 正しいトークンなら認証成功する", () => {
  withStagingAdminToken("correct-token-xyz", () => {
    const result = checkStagingAdminToken("correct-token-xyz");
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
  });
});

test("checkStagingAdminToken: 誤ったトークンは拒否される", () => {
  withStagingAdminToken("correct-token-xyz", () => {
    const result = checkStagingAdminToken("wrong-token");
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test("checkStagingAdminToken: トークン未指定（null）は拒否される", () => {
  withStagingAdminToken("correct-token-xyz", () => {
    const result = checkStagingAdminToken(null);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test("checkStagingAdminToken: トークン未指定（undefined）は拒否される", () => {
  withStagingAdminToken("correct-token-xyz", () => {
    const result = checkStagingAdminToken(undefined);
    assert.equal(result.ok, false);
  });
});

test("checkStagingAdminToken: 空文字列は拒否される", () => {
  withStagingAdminToken("correct-token-xyz", () => {
    const result = checkStagingAdminToken("");
    assert.equal(result.ok, false);
  });
});

test("checkStagingAdminToken: サーバー側にSTAGING_ADMIN_TOKENが未設定なら、どんな入力でも拒否される", () => {
  withStagingAdminToken(undefined, () => {
    const result = checkStagingAdminToken("anything");
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test("checkStagingAdminToken: トークン不一致とトークン未設定は、同一のエラーメッセージ・ステータスになる（推測防止）", () => {
  const wrongTokenResult = withStagingAdminToken("correct-token-xyz", () => checkStagingAdminToken("wrong"));
  const noTokenResult = withStagingAdminToken(undefined, () => checkStagingAdminToken("wrong"));
  assert.equal(wrongTokenResult.status, noTokenResult.status);
  assert.equal(wrongTokenResult.error, noTokenResult.error);
});

// --- assertStagingAdmin（NextRequestからのBearerヘッダー抽出） ---

test("assertStagingAdmin: 正しいBearerヘッダーで認証成功する", () => {
  withStagingAdminToken("correct-token-xyz", () => {
    const req = new NextRequest("http://localhost/api/v2/company-labs", { headers: { authorization: "Bearer correct-token-xyz" } });
    const result = assertStagingAdmin(req);
    assert.equal(result.ok, true);
  });
});

test("assertStagingAdmin: Authorizationヘッダーが無ければ拒否される", () => {
  withStagingAdminToken("correct-token-xyz", () => {
    const req = new NextRequest("http://localhost/api/v2/company-labs");
    const result = assertStagingAdmin(req);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test("assertStagingAdmin: 'Bearer '接頭辞が無いAuthorizationヘッダーは拒否される", () => {
  withStagingAdminToken("correct-token-xyz", () => {
    const req = new NextRequest("http://localhost/api/v2/company-labs", { headers: { authorization: "correct-token-xyz" } });
    const result = assertStagingAdmin(req);
    assert.equal(result.ok, false);
  });
});

test("assertStagingAdmin: 応答にトークン自体やSTAGING_ADMIN_TOKENという語を含まない（秘密情報を漏らさない）", () => {
  withStagingAdminToken("correct-token-xyz", () => {
    const req = new NextRequest("http://localhost/api/v2/company-labs", { headers: { authorization: "Bearer wrong" } });
    const result = assertStagingAdmin(req);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("correct-token-xyz"), false);
    assert.equal(serialized.toUpperCase().includes("STAGING_ADMIN_TOKEN"), false);
  });
});

// --- 本番環境での拒否（別プロセスで検証。isProductionがトップレベルconstのため） ---

test("checkStagingAdminToken: 本番環境（APP_ENV=production）では、正しいトークンでも拒否される", () => {
  const script = `
    import { checkStagingAdminToken } from "./app/lib/stagingAdmin";
    const result = checkStagingAdminToken("correct-token-xyz");
    console.log(JSON.stringify(result));
  `;
  const out = execFileSync("npx", ["tsx", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, APP_ENV: "production", STAGING_ADMIN_TOKEN: "correct-token-xyz" },
    encoding: "utf8",
  });
  const result = JSON.parse(out.trim().split("\n").pop() ?? "{}");
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /本番環境/);
});
