import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAllowedKeys } from "../redisKeyGuard";

// 許可されるべきキー ------------------------------------------------------

test("production: 'games' は許可される", () => {
  assert.doesNotThrow(() => assertAllowedKeys(["games"], true));
});

test("production: 'game:ABC' は許可される", () => {
  assert.doesNotThrow(() => assertAllowedKeys(["game:ABC"], true));
});

test("staging: 'staging:games' は許可される", () => {
  assert.doesNotThrow(() => assertAllowedKeys(["staging:games"], false));
});

test("staging: 'staging:game:ABC' は許可される", () => {
  assert.doesNotThrow(() => assertAllowedKeys(["staging:game:ABC"], false));
});

// 拒否されるべきキー ------------------------------------------------------

test("production: 'staging:game:ABC' は拒否される", () => {
  assert.throws(() => assertAllowedKeys(["staging:game:ABC"], true));
});

test("production: 'v2:game:ABC' は拒否される", () => {
  assert.throws(() => assertAllowedKeys(["v2:game:ABC"], true));
});

test("staging: 'game:ABC'（プレフィックスなし）は拒否される", () => {
  assert.throws(() => assertAllowedKeys(["game:ABC"], false));
});

test("staging: 'staging:v2:game:ABC' は拒否される", () => {
  assert.throws(() => assertAllowedKeys(["staging:v2:game:ABC"], false));
});

test("staging: 'staging:foo'（許可リストにもgame:プレフィックスにも一致しない）は拒否される", () => {
  assert.throws(() => assertAllowedKeys(["staging:foo"], false));
});

// 複数キー・混在ケース ------------------------------------------------------

test("複数キーのうち1件でも不正なら例外になる（del等の複数キー渡し）", () => {
  assert.throws(() => assertAllowedKeys(["game:ABC", "v2:game:XYZ"], true));
});

test("複数キーが全て正しければ例外にならない", () => {
  assert.doesNotThrow(() => assertAllowedKeys(["game:ABC", "games"], true));
  assert.doesNotThrow(() => assertAllowedKeys(["staging:game:ABC", "staging:games"], false));
});
