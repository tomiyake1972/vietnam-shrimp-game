// ShrimpX V2 — Independent Player Flow: Player Session Cookie のテスト
//
// app/lib/__tests__/companyLabUiSession.test.ts と同じ方針: cookies()（next/headers）に
// 依存しない純粋なsign/verifyロジックだけをここでユニットテストする
// （setPlayerSessionCookie/readPlayerSessionIdFromCookie自体はNode.jsの
// リクエストスコープ外から呼ぶと例外になるためブラウザE2Eで検証する）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { derivePlayerSessionSecret, signPlayerCookieValue, verifyPlayerCookieValue } from "../sessionCookie";

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

test("PLAYER-COOKIE-1: 署名・検証が往復し、sessionIdを正しく取り出せる", () => {
  withStagingAdminToken("secret-abc-123", () => {
    const value = signPlayerCookieValue("session-xyz");
    assert.ok(value);
    assert.equal(verifyPlayerCookieValue(value), "session-xyz");
  });
});

test("PLAYER-COOKIE-2: STAGING_ADMIN_TOKENが無ければ署名も検証もできない（本番・未設定環境の多重防御）", () => {
  withStagingAdminToken(undefined, () => {
    assert.equal(signPlayerCookieValue("session-xyz"), null);
    assert.equal(verifyPlayerCookieValue("anything.anything"), null);
  });
});

test("PLAYER-COOKIE-3: 鍵はPlayer専用のdomain prefixから導出される（既存staging admin sessionの鍵と一致しない）", () => {
  withStagingAdminToken("shared-token", () => {
    const secret = derivePlayerSessionSecret();
    assert.ok(secret);
    const expectedPlayerDomainSecret = createHash("sha256").update("shrimpx-player-session-v1:" + "shared-token", "utf8").digest();
    assert.deepEqual(secret, expectedPlayerDomainSecret);
    // 既存のstaging admin session（companyLabUiSession.ts）が使うのは別のprefixであり、
    // 同じSTAGING_ADMIN_TOKENでも異なる鍵になる（Cookie名も別なので混同のしようがないが、
    // 鍵レベルでも分離されていることをここで固定する）。
    const otherModuleDomainSecret = createHash("sha256").update("company-lab-ui-session-v1:" + "shared-token", "utf8").digest();
    assert.notDeepEqual(secret, otherModuleDomainSecret);
  });
});

test("PLAYER-COOKIE-4: 署名部分を改ざんすると無効になる", () => {
  withStagingAdminToken("secret-abc-123", () => {
    const value = signPlayerCookieValue("session-xyz");
    assert.ok(value);
    const [payloadB64] = value.split(".");
    const tampered = `${payloadB64}.${"0".repeat(64)}`;
    assert.equal(verifyPlayerCookieValue(tampered), null);
  });
});

test("PLAYER-COOKIE-5: payload部分を改ざんすると無効になる（署名が一致しなくなるため）", () => {
  withStagingAdminToken("secret-abc-123", () => {
    const value = signPlayerCookieValue("session-legit");
    assert.ok(value);
    const [, signature] = value.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sessionId: "session-forged", iat: 0, exp: Date.now() + 1_000_000_000 }), "utf8").toString(
      "base64url"
    );
    assert.equal(verifyPlayerCookieValue(`${forgedPayload}.${signature}`), null);
  });
});

test("PLAYER-COOKIE-6: 形式が壊れた値は無効", () => {
  withStagingAdminToken("secret-abc-123", () => {
    assert.equal(verifyPlayerCookieValue(undefined), null);
    assert.equal(verifyPlayerCookieValue(null), null);
    assert.equal(verifyPlayerCookieValue(""), null);
    assert.equal(verifyPlayerCookieValue("not-a-valid-cookie"), null);
    assert.equal(verifyPlayerCookieValue("a.b.c"), null);
  });
});

test("PLAYER-COOKIE-7: STAGING_ADMIN_TOKENをローテーションすると、発行済みCookieは無効になる", () => {
  const value = withStagingAdminToken("old-secret-token", () => {
    const v = signPlayerCookieValue("session-rotate");
    assert.ok(v);
    return v;
  });
  withStagingAdminToken("new-secret-token-after-rotation", () => {
    assert.equal(verifyPlayerCookieValue(value), null);
  });
});

test("PLAYER-COOKIE-8: 期限切れのpayloadは無効になる（同じ鍵で正しく署名されていても）", () => {
  withStagingAdminToken("secret-abc-123", () => {
    const secret = derivePlayerSessionSecret();
    assert.ok(secret);
    const expiredPayload = { sessionId: "session-expired", iat: Date.now() - 1_000_000, exp: Date.now() - 1 };
    const payloadB64 = Buffer.from(JSON.stringify(expiredPayload), "utf8").toString("base64url");
    const signature = createHmac("sha256", secret).update(payloadB64, "utf8").digest("hex");
    assert.equal(verifyPlayerCookieValue(`${payloadB64}.${signature}`), null);
  });
});
