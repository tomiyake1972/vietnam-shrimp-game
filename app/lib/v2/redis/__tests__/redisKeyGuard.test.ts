import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAllowedKeysV2 } from "../redisKeyGuard";

// テスト3: v1 / production の許可・拒否
test("v1/production: 'games' と 'game:ABC' は許可される", () => {
  assert.doesNotThrow(() => assertAllowedKeysV2(["games"], "v1", "production"));
  assert.doesNotThrow(() => assertAllowedKeysV2(["game:ABC"], "v1", "production"));
});

test("v1/production: 'staging:games' や 'v2:games' は拒否される", () => {
  assert.throws(() => assertAllowedKeysV2(["staging:games"], "v1", "production"));
  assert.throws(() => assertAllowedKeysV2(["v2:games"], "v1", "production"));
});

// テスト4: v1 / staging の許可・拒否
test("v1/staging: 'staging:games' と 'staging:game:ABC' は許可される", () => {
  assert.doesNotThrow(() => assertAllowedKeysV2(["staging:games"], "v1", "staging"));
  assert.doesNotThrow(() => assertAllowedKeysV2(["staging:game:ABC"], "v1", "staging"));
});

test("v1/staging: 'games'（プレフィックスなし）は拒否される", () => {
  assert.throws(() => assertAllowedKeysV2(["games"], "v1", "staging"));
});

// テスト5: v2 / production の許可・拒否
test("v2/production: 'v2:games' と 'v2:game:ABC' は許可される", () => {
  assert.doesNotThrow(() => assertAllowedKeysV2(["v2:games"], "v2", "production"));
  assert.doesNotThrow(() => assertAllowedKeysV2(["v2:game:ABC"], "v2", "production"));
});

test("v2/production: 'games' や 'game:ABC'（V1のキー）は拒否される", () => {
  assert.throws(() => assertAllowedKeysV2(["games"], "v2", "production"));
  assert.throws(() => assertAllowedKeysV2(["game:ABC"], "v2", "production"));
});

// テスト6: v2 / staging の許可・拒否
test("v2/staging: 'staging:v2:games' と 'staging:v2:game:ABC' は許可される", () => {
  assert.doesNotThrow(() => assertAllowedKeysV2(["staging:v2:games"], "v2", "staging"));
  assert.doesNotThrow(() => assertAllowedKeysV2(["staging:v2:game:ABC"], "v2", "staging"));
});

test("v2/staging: 'staging:game:ABC'（V1staging）は拒否される", () => {
  assert.throws(() => assertAllowedKeysV2(["staging:game:ABC"], "v2", "staging"));
});

test("v2/staging: 'game:ABC'（V1production・プレフィックスなし）は拒否される", () => {
  assert.throws(() => assertAllowedKeysV2(["game:ABC"], "v2", "staging"));
});

// テスト7: V1/V2クロスコンタミネーションの拒否（4象限すべて）
test("v1/production コンテキストで v2:game:* は拒否される", () => {
  assert.throws(() => assertAllowedKeysV2(["v2:game:X"], "v1", "production"));
});

test("v1/staging コンテキストで staging:v2:game:* は拒否される", () => {
  assert.throws(() => assertAllowedKeysV2(["staging:v2:game:X"], "v1", "staging"));
});

test("v2/production コンテキストで staging:game:* は拒否される", () => {
  assert.throws(() => assertAllowedKeysV2(["staging:game:X"], "v2", "production"));
});

test("v2/staging コンテキストで v2:game:*（stagingプレフィックスなし）は拒否される", () => {
  assert.throws(() => assertAllowedKeysV2(["v2:game:X"], "v2", "staging"));
});

// テスト8: 近似衝突（プレフィックスの部分一致による誤許可）の拒否
test("v1/staging コンテキストで 'staging:v2:foo' は拒否される（'staging:game:'とは無関係）", () => {
  assert.throws(() => assertAllowedKeysV2(["staging:v2:foo"], "v1", "staging"));
});

test("v2/staging コンテキストで 'staging:v2:foo'（'staging:v2:game:'プレフィックス不一致）は拒否される", () => {
  assert.throws(() => assertAllowedKeysV2(["staging:v2:foo"], "v2", "staging"));
});

test("v1/production コンテキストで 'staging:v2:game:X' は拒否される（'game:'プレフィックスと誤認しない）", () => {
  assert.throws(() => assertAllowedKeysV2(["staging:v2:game:X"], "v1", "production"));
});

test("複数キーのうち1件でも不正なら例外になる", () => {
  assert.throws(() => assertAllowedKeysV2(["v2:game:ABC", "v2:games"], "v1", "production"));
});

test("複数キーが全て正しければ例外にならない", () => {
  assert.doesNotThrow(() => assertAllowedKeysV2(["v2:game:ABC", "v2:games"], "v2", "production"));
});
