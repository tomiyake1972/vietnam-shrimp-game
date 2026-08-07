import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAppVersion, assertAppEnvV2 } from "../version";

// テスト1: APP_VERSION未設定は拒否される
test("APP_VERSION未設定（undefined）は拒否される", () => {
  assert.throws(() => assertAppVersion(undefined));
});

test("APP_VERSION未設定（空文字）は拒否される", () => {
  assert.throws(() => assertAppVersion(""));
});

// テスト2: APP_VERSION不正値は拒否される
test("APP_VERSION不正値（'v3'）は拒否される", () => {
  assert.throws(() => assertAppVersion("v3"));
});

test("APP_VERSION正常値（'v1'/'v2'）は許可される", () => {
  assert.equal(assertAppVersion("v1"), "v1");
  assert.equal(assertAppVersion("v2"), "v2");
});

// APP_ENVについても同様に検証する（V2はproduction/stagingのみ許可）
test("APP_ENV未設定は拒否される", () => {
  assert.throws(() => assertAppEnvV2(undefined));
});

test("APP_ENV不正値（V1のみが許容する'development'）はV2では拒否される", () => {
  assert.throws(() => assertAppEnvV2("development"));
  assert.throws(() => assertAppEnvV2("preview"));
});

test("APP_ENV正常値（'production'/'staging'）は許可される", () => {
  assert.equal(assertAppEnvV2("production"), "production");
  assert.equal(assertAppEnvV2("staging"), "staging");
});
