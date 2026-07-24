// ShrimpX V2 — 会社ラボ専用Redisキー許可判定テスト（Phase 8C-1 §8-4）
//
// 要求されている拒否ケースを網羅する: V1キーの拒否・既存V2本番ゲームキー
// （v2:game:）の拒否・production/staging取り違えの拒否・labId取り違え
// （他ラボのキー混入）の拒否・不正なlabId/turnの拒否。許可ケースとして、
// V2本番会社ラボキー・V2ステージング会社ラボキーの両方を確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertAllowedCompanyLabKeys,
  assertAllowedCompanyLabListKey,
  CompanyLabRedisKeyGuardError,
  isAllowedCompanyLabKey,
  isAllowedCompanyLabListKey,
} from "../companyLabRedisKeyGuard";
import {
  companyLabCurrentStateKeyV2,
  companyLabDraftKeyV2,
  companyLabHistoryEntryKeyV2,
  companyLabHistoryIndexKeyV2,
  companyLabListKeyV2,
  companyLabLockKeyV2,
} from "../companyLabRedisKeys";

test("V2本番会社ラボキー（current/draft/lock/history:index/history:<turn>）はすべて許可される", () => {
  const labId = "lab-1";
  assert.equal(isAllowedCompanyLabKey(companyLabCurrentStateKeyV2("production", labId), "production", labId), true);
  assert.equal(isAllowedCompanyLabKey(companyLabDraftKeyV2("production", labId), "production", labId), true);
  assert.equal(isAllowedCompanyLabKey(companyLabLockKeyV2("production", labId), "production", labId), true);
  assert.equal(isAllowedCompanyLabKey(companyLabHistoryIndexKeyV2("production", labId), "production", labId), true);
  assert.equal(isAllowedCompanyLabKey(companyLabHistoryEntryKeyV2("production", labId, 7), "production", labId), true);
});

test("V2ステージング会社ラボキーもすべて許可される", () => {
  const labId = "lab-1";
  assert.equal(isAllowedCompanyLabKey(companyLabCurrentStateKeyV2("staging", labId), "staging", labId), true);
  assert.equal(isAllowedCompanyLabKey(companyLabHistoryEntryKeyV2("staging", labId, 1), "staging", labId), true);
  assert.ok(companyLabCurrentStateKeyV2("staging", labId).startsWith("staging:"));
});

test("V1キー（v1:等の想定）は拒否される", () => {
  assert.equal(isAllowedCompanyLabKey("v1:game:ABCD", "production", "lab-1"), false);
  assert.equal(isAllowedCompanyLabKey("v1:companyLab:lab-1:current", "production", "lab-1"), false);
});

test("既存V2本番ゲームキー（v2:game:）は拒否される", () => {
  assert.equal(isAllowedCompanyLabKey("v2:game:ABCD", "production", "lab-1"), false);
  assert.equal(isAllowedCompanyLabKey("v2:games", "production", "lab-1"), false);
});

test("production/stagingの取り違えは拒否される", () => {
  const labId = "lab-1";
  const prodKey = companyLabCurrentStateKeyV2("production", labId);
  const stagingKey = companyLabCurrentStateKeyV2("staging", labId);
  assert.equal(isAllowedCompanyLabKey(prodKey, "staging", labId), false, "本番キーをstaging名前空間で許可してはならない");
  assert.equal(isAllowedCompanyLabKey(stagingKey, "production", labId), false, "stagingキーを本番名前空間で許可してはならない");
});

test("他labIdのキー混入は拒否される（クロスlabId汚染の防止）", () => {
  const keyForLabA = companyLabCurrentStateKeyV2("production", "lab-A");
  assert.equal(isAllowedCompanyLabKey(keyForLabA, "production", "lab-B"), false);
});

test("不正なlabId（空文字・\":\"を含む）は、いかなるキーも許可しない（fail closed）", () => {
  assert.equal(isAllowedCompanyLabKey("v2:companyLab::current", "production", ""), false);
  const weirdLabId = "lab:with:colon";
  const key = `v2:companyLab:${weirdLabId}:current`;
  assert.equal(isAllowedCompanyLabKey(key, "production", weirdLabId), false);
});

test("不正なturn（0・負・非整数・非数値文字列）を含むhistoryキーは拒否される", () => {
  const labId = "lab-1";
  assert.equal(isAllowedCompanyLabKey(`v2:companyLab:${labId}:history:0`, "production", labId), false);
  assert.equal(isAllowedCompanyLabKey(`v2:companyLab:${labId}:history:-1`, "production", labId), false);
  assert.equal(isAllowedCompanyLabKey(`v2:companyLab:${labId}:history:1.5`, "production", labId), false);
  assert.equal(isAllowedCompanyLabKey(`v2:companyLab:${labId}:history:abc`, "production", labId), false);
  assert.equal(isAllowedCompanyLabKey(`v2:companyLab:${labId}:history:1`, "production", labId), true);
});

test("一覧キー（companyLabListKeyV2）はlabIdに依存せず、production/stagingそれぞれで許可される", () => {
  assert.equal(isAllowedCompanyLabListKey(companyLabListKeyV2("production"), "production"), true);
  assert.equal(isAllowedCompanyLabListKey(companyLabListKeyV2("staging"), "staging"), true);
  assert.equal(isAllowedCompanyLabListKey(companyLabListKeyV2("production"), "staging"), false);
});

test("assertAllowedCompanyLabKeys: 許可外キーが1件でも含まれていれば例外を投げる", () => {
  const labId = "lab-1";
  assert.doesNotThrow(() => assertAllowedCompanyLabKeys([companyLabCurrentStateKeyV2("production", labId), companyLabDraftKeyV2("production", labId)], "production", labId));
  assert.throws(() => assertAllowedCompanyLabKeys([companyLabCurrentStateKeyV2("production", labId), "v2:game:XYZ"], "production", labId), CompanyLabRedisKeyGuardError);
  assert.throws(() => assertAllowedCompanyLabKeys([companyLabCurrentStateKeyV2("staging", labId)], "production", labId), CompanyLabRedisKeyGuardError);
});

test("assertAllowedCompanyLabKeys: 一覧キーは常に許可される（labIdに依存しない）", () => {
  const labId = "lab-1";
  assert.doesNotThrow(() => assertAllowedCompanyLabKeys([companyLabListKeyV2("production")], "production", labId));
});

test("assertAllowedCompanyLabListKey: 一覧キー以外を渡すと例外を投げる", () => {
  assert.doesNotThrow(() => assertAllowedCompanyLabListKey(companyLabListKeyV2("production"), "production"));
  assert.throws(() => assertAllowedCompanyLabListKey("v2:game:XYZ", "production"), CompanyLabRedisKeyGuardError);
  assert.throws(() => assertAllowedCompanyLabListKey(companyLabListKeyV2("staging"), "production"), CompanyLabRedisKeyGuardError);
});
