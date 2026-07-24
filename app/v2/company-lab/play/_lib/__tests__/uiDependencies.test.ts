// ShrimpX V2 — app/v2/company-lab/play/_lib/uiDependencies.ts のテスト（Phase 8C-3B §13.2・§14）
//
// 通常時（COMPANY_LAB_UI_E2E_IN_MEMORY未設定）は実Redis用のcreateCompanyLabApiDependencies
// （8C-3A・既存）をそのまま返すだけであり、そちらのふるまいはdependencies.ts側の既存方針で
// 確認済み（モジュール読込時に一切Redis接続しない）。ここでは8C-3Bで追加したin-memory
// フォールバック分岐だけを対象にテストする。
//
// isCompanyLabUiRunningInMemoryForE2e/resolveCompanyLabUiDependencies は呼び出しのたびに
// process.env を読み直す設計（モジュール読込時に固定しない）ため、同一プロセス内で
// 環境変数を書き換えながら繰り返し呼び出してテストできる（isProductionだけは
// app/lib/env.tsのトップレベルconstであり、この単一プロセス内では固定される。
// 本番判定については別プロセス（npx tsx -e）で検証する）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { isCompanyLabUiRunningInMemoryForE2e, resolveCompanyLabUiDependencies } from "../uiDependencies";

const ORIGINAL_FLAG = process.env.COMPANY_LAB_UI_E2E_IN_MEMORY;

// 【注意】fnがasync関数の場合、fn()はPromiseを即座に返すだけなので、finallyで
// awaitせずに環境変数を復元すると、fnの内部のawait実行前に環境変数が消えてしまう
// （実際にこのバグを一度作り込み、テスト失敗から検出・修正した）。そのため常に
// `await fn()` する（fnが同期関数でもPromise.resolve()でラップされるだけで問題ない）。
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

test("isCompanyLabUiRunningInMemoryForE2e: フラグ未設定ならfalse（デフォルトでin-memoryへ落ちない）", async () => {
  await withFlag(undefined, () => {
    assert.equal(isCompanyLabUiRunningInMemoryForE2e(), false);
  });
});

test("isCompanyLabUiRunningInMemoryForE2e: フラグが'1'以外の値ならfalse", async () => {
  await withFlag("true", () => {
    assert.equal(isCompanyLabUiRunningInMemoryForE2e(), false);
  });
});

test("isCompanyLabUiRunningInMemoryForE2e: フラグ='1'ならtrue（非本番環境）", async () => {
  await withFlag("1", () => {
    assert.equal(isCompanyLabUiRunningInMemoryForE2e(), true);
  });
});

test("resolveCompanyLabUiDependencies: フラグ='1'なら、Redis未設定でも例外を投げずin-memory Repositoryを返す", async () => {
  await withFlag("1", async () => {
    const deps = await resolveCompanyLabUiDependencies();
    assert.ok(deps.repository);
    assert.ok(deps.service);
  });
});

test("resolveCompanyLabUiDependencies: フラグ='1'の間は、複数回の呼び出しで同一のRepository/Serviceインスタンス（プロセス内で状態が保持される）を返す", async () => {
  await withFlag("1", async () => {
    const depsA = await resolveCompanyLabUiDependencies();
    const depsB = await resolveCompanyLabUiDependencies();
    assert.strictEqual(depsA.repository, depsB.repository);
    assert.strictEqual(depsA.service, depsB.service);
  });
});

test("resolveCompanyLabUiDependencies: in-memoryモードでは実際にラボを作成・再読み込みできる（ブラウザE2Eのフォールバック経路が機能することの確認）", async () => {
  await withFlag("1", async () => {
    const deps = await resolveCompanyLabUiDependencies();
    const created = await deps.service.createLab({
      labId: "ui-deps-functional-test-lab",
      config: { scenarioId: "baseline-v0.1", mode: "canonical", seed: "seed-ui-deps-test", turns: 2 },
      playerCompanyId: "BAL",
      now: new Date(0).toISOString(),
    });
    assert.equal(created.stored.playerCompanyId, "BAL");
    const reloaded = await deps.repository.loadCurrentState("ui-deps-functional-test-lab");
    assert.equal(reloaded.labId, "ui-deps-functional-test-lab");
  });
});

test("isCompanyLabUiRunningInMemoryForE2e: 本番環境（APP_ENV=production）では、フラグが'1'でも常にfalse", () => {
  const script = `
    process.env.COMPANY_LAB_UI_E2E_IN_MEMORY = "1";
    import { isCompanyLabUiRunningInMemoryForE2e } from "./app/v2/company-lab/play/_lib/uiDependencies";
    console.log(JSON.stringify({ inMemory: isCompanyLabUiRunningInMemoryForE2e() }));
  `;
  const out = execFileSync("npx", ["tsx", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, APP_ENV: "production", COMPANY_LAB_UI_E2E_IN_MEMORY: "1" },
    encoding: "utf8",
  });
  const result = JSON.parse(out.trim().split("\n").pop() ?? "{}");
  assert.equal(result.inMemory, false);
});
