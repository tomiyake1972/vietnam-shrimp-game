// ShrimpX V2 — app/lib/companyLabUiSession.ts のテスト（Phase 8C-3B §13.2）
//
// createSessionToken/verifySessionToken/deriveSessionSecret/isSameOriginHostは
// next/headers・next/navigation（リクエストスコープAPI）に依存しない純粋なロジックであり
// （8C-3Bでテスト用にexport済み。ファイル冒頭コメント参照）、ここで直接ユニットテストする。
//
// attemptStagingLogin/hasValidStagingSession/clearStagingSession/requireStagingSession/
// assertSameOriginRequest自体（cookies()・headers()を呼ぶ薄いラッパー部分）は、Next.jsの
// リクエストスコープ外（このnode:testプロセス）から呼ぶと
// 「`cookies` was called outside a request scope」で例外になるため、ここではテストしない
// （実際に確認済み）。これらはブラウザE2E（指示§14・Playwright）で検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createSessionToken, verifySessionToken, deriveSessionSecret, isSameOriginHost, COMPANY_LAB_UI_SESSION_COOKIE_NAME } from "../companyLabUiSession";

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

// --- createSessionToken / verifySessionToken ---

test("createSessionToken → verifySessionToken: 正しく発行したセッション値は有効と判定される", () => {
  withStagingAdminToken("secret-abc-123", () => {
    const token = createSessionToken();
    assert.ok(token);
    assert.equal(verifySessionToken(token), true);
  });
});

test("createSessionToken: STAGING_ADMIN_TOKEN未設定ならnullを返す（セッションを発行できない）", () => {
  withStagingAdminToken(undefined, () => {
    assert.equal(createSessionToken(), null);
  });
});

test("createSessionToken: 発行されたセッション値の文字列に、元のSTAGING_ADMIN_TOKEN自体は含まれない", () => {
  withStagingAdminToken("super-secret-token-should-not-leak", () => {
    const token = createSessionToken();
    assert.ok(token);
    assert.equal(token.includes("super-secret-token-should-not-leak"), false);
  });
});

test("createSessionToken: 連続して発行しても毎回異なる値になる（固定値・推測可能な値にならない）", () => {
  withStagingAdminToken("secret-abc-123", () => {
    const token1 = createSessionToken();
    const token2 = createSessionToken();
    assert.ok(token1);
    assert.ok(token2);
    assert.notEqual(token1, token2);
  });
});

test("verifySessionToken: null/undefined/空文字列は無効", () => {
  withStagingAdminToken("secret-abc-123", () => {
    assert.equal(verifySessionToken(null), false);
    assert.equal(verifySessionToken(undefined), false);
    assert.equal(verifySessionToken(""), false);
  });
});

test("verifySessionToken: 形式が壊れた値（'.'が無い、部品が多すぎる）は無効", () => {
  withStagingAdminToken("secret-abc-123", () => {
    assert.equal(verifySessionToken("not-a-valid-token"), false);
    assert.equal(verifySessionToken("a.b.c"), false);
  });
});

test("verifySessionToken: 署名部分を改ざんすると無効になる", () => {
  withStagingAdminToken("secret-abc-123", () => {
    const token = createSessionToken();
    assert.ok(token);
    const [payloadB64] = token.split(".");
    const tampered = `${payloadB64}.${"0".repeat(64)}`;
    assert.equal(verifySessionToken(tampered), false);
  });
});

test("verifySessionToken: payload部分を改ざんすると無効になる（署名が一致しなくなるため）", () => {
  withStagingAdminToken("secret-abc-123", () => {
    const token = createSessionToken();
    assert.ok(token);
    const [, signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ iat: 0, exp: Date.now() + 1_000_000_000, nonce: "forged" }), "utf8").toString("base64url");
    const tampered = `${forgedPayload}.${signature}`;
    assert.equal(verifySessionToken(tampered), false);
  });
});

test("verifySessionToken: STAGING_ADMIN_TOKENをローテーションすると、発行済みセッションは無効になる", () => {
  const token = withStagingAdminToken("old-secret-token", () => {
    const t = createSessionToken();
    assert.ok(t);
    return t;
  });
  withStagingAdminToken("new-secret-token-after-rotation", () => {
    assert.equal(verifySessionToken(token), false);
  });
});

test("verifySessionToken: 期限切れのpayloadは無効になる（同じ鍵で正しく署名されていても）", () => {
  withStagingAdminToken("secret-abc-123", () => {
    const secret = deriveSessionSecret();
    assert.ok(secret);
    const expiredPayload = { iat: Date.now() - 1_000_000, exp: Date.now() - 1, nonce: "expired-nonce" };
    const payloadB64 = Buffer.from(JSON.stringify(expiredPayload), "utf8").toString("base64url");
    const signature = createHmac("sha256", secret).update(payloadB64, "utf8").digest("hex");
    const expiredToken = `${payloadB64}.${signature}`;
    assert.equal(verifySessionToken(expiredToken), false);
  });
});

// --- deriveSessionSecret ---

test("deriveSessionSecret: STAGING_ADMIN_TOKEN未設定ならnull", () => {
  withStagingAdminToken(undefined, () => {
    assert.equal(deriveSessionSecret(), null);
  });
});

test("deriveSessionSecret: 同じトークンからは常に同じ鍵が導出される（決定論的）", () => {
  withStagingAdminToken("secret-abc-123", () => {
    const a = deriveSessionSecret();
    const b = deriveSessionSecret();
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.equals(b), true);
  });
});

test("deriveSessionSecret: 異なるトークンからは異なる鍵が導出される", () => {
  const a = withStagingAdminToken("token-A", () => deriveSessionSecret());
  const b = withStagingAdminToken("token-B", () => deriveSessionSecret());
  assert.ok(a);
  assert.ok(b);
  assert.equal(a.equals(b), false);
});

// --- isSameOriginHost（assertSameOriginRequestのCSRF判定本体） ---

test("isSameOriginHost: OriginとHostが一致すれば true", () => {
  assert.equal(isSameOriginHost("https://example.com", "example.com"), true);
  assert.equal(isSameOriginHost("http://localhost:3000", "localhost:3000"), true);
});

test("isSameOriginHost: Originが別ホストなら false（クロスオリジン状態変更リクエストの拒否）", () => {
  assert.equal(isSameOriginHost("https://evil.example.com", "example.com"), false);
  assert.equal(isSameOriginHost("https://attacker.test", "shrimpx-staging.vercel.app"), false);
});

test("isSameOriginHost: OriginまたはHostが欠落していれば false", () => {
  assert.equal(isSameOriginHost(null, "example.com"), false);
  assert.equal(isSameOriginHost("https://example.com", null), false);
  assert.equal(isSameOriginHost(undefined, undefined), false);
});

test("isSameOriginHost: Originが不正なURL文字列でも例外を投げずfalseを返す", () => {
  assert.doesNotThrow(() => isSameOriginHost("not a url", "example.com"));
  assert.equal(isSameOriginHost("not a url", "example.com"), false);
});

// --- モジュール読込時の副作用が無いこと ---

test("companyLabUiSessionモジュール自体の定数は、Redis・環境変数アクセス無しで参照できる", () => {
  assert.equal(COMPANY_LAB_UI_SESSION_COOKIE_NAME, "shrimpx_company_lab_ui_session");
});
