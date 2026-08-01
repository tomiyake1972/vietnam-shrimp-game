// ShrimpX V2 — app/v2/company-lab/play/_lib/aiExplanationUiDependencies.ts のテスト（MVP）
//
// uiDependencies.test.ts と同じ方針: 実Upstash接続が必要な通常経路
// （createDefaultCompanyLabRedisClient経由）は既存のcompanyLabClient.ts側で検証済みのため、
// ここではE2E in-memoryフォールバック分岐（COMPANY_LAB_UI_E2E_IN_MEMORY=1）だけを対象にする。

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAiExplanationUiDependencies } from "../aiExplanationUiDependencies";
import { resolveCompanyLabUiDependencies } from "../uiDependencies";

const ORIGINAL_FLAG = process.env.COMPANY_LAB_UI_E2E_IN_MEMORY;

async function withFlag<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const original = process.env.COMPANY_LAB_UI_E2E_IN_MEMORY;
  if (value === undefined) {
    delete process.env.COMPANY_LAB_UI_E2E_IN_MEMORY;
  } else {
    process.env.COMPANY_LAB_UI_E2E_IN_MEMORY = value;
  }
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.COMPANY_LAB_UI_E2E_IN_MEMORY;
    } else {
      process.env.COMPANY_LAB_UI_E2E_IN_MEMORY = original;
    }
  }
}

test.after(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.COMPANY_LAB_UI_E2E_IN_MEMORY;
  } else {
    process.env.COMPANY_LAB_UI_E2E_IN_MEMORY = ORIGINAL_FLAG;
  }
});

test("resolveAiExplanationUiDependencies: フラグ='1'なら、実Redis未設定でも例外を投げずredisClientを含む依存関係を返す", async () => {
  await withFlag("1", async () => {
    const deps = await resolveAiExplanationUiDependencies();
    assert.ok(deps.repository);
    assert.ok(deps.service);
    assert.ok(deps.redisClient);
  });
});

test("resolveAiExplanationUiDependencies: フラグ='1'の間は、repository/serviceがresolveCompanyLabUiDependencies()と同一インスタンス(重複実装ではなく再利用)", async () => {
  await withFlag("1", async () => {
    const base = await resolveCompanyLabUiDependencies();
    const explanationDeps = await resolveAiExplanationUiDependencies();
    assert.strictEqual(explanationDeps.repository, base.repository);
    assert.strictEqual(explanationDeps.service, base.service);
  });
});

test("resolveAiExplanationUiDependencies: フラグ='1'の間は、複数回の呼び出しで同一のredisClientインスタンス（プロセス内シングルトン）を返す", async () => {
  await withFlag("1", async () => {
    const depsA = await resolveAiExplanationUiDependencies();
    const depsB = await resolveAiExplanationUiDependencies();
    assert.strictEqual(depsA.redisClient, depsB.redisClient);
  });
});

test("resolveAiExplanationUiDependencies: in-memoryのredisClientはget/set/existsが実際に動作する", async () => {
  await withFlag("1", async () => {
    const deps = await resolveAiExplanationUiDependencies();
    const missing = await deps.redisClient.get("ai-explanation-ui-deps-test-key-missing");
    assert.equal(missing, null);
    await deps.redisClient.set("ai-explanation-ui-deps-test-key", "value-1");
    const loaded = await deps.redisClient.get("ai-explanation-ui-deps-test-key");
    assert.equal(loaded, "value-1");
    assert.equal(await deps.redisClient.exists("ai-explanation-ui-deps-test-key"), 1);
  });
});
