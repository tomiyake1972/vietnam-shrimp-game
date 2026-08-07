// ShrimpX V2 — CompanyLabReadOnlyRepository（エクスポートAPI専用） 書き込み権限境界テスト
//
// 【必須テスト】「Export ルートは書き込み可能な Company Lab Repository を直接参照しない
// 構成にし、型とテストの両方で確認する」の「テスト」側を担う。型レベルの保証
// （CompanyLabReadOnlyRepositoryを受け取るコードは、そもそもcreateLab等を呼び出す
// コードを書いてもコンパイルが通らない）は、このテストファイル自体・
// app/api/v2/exports/_lib配下の全ファイルがビルド（tsc --noEmit）を通過している
// ことで保証される。本テストは、それに加えて実行時レベルでも書き込みメソッドへの
// 参照が一切存在しないことを直接検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryCompanyLabStateRepository } from "../repository";
import { createCompanyLabQuarterFlowService } from "../../application/companyLabQuarterFlowService";
import { handleCreateLab } from "../../../../../api/v2/company-labs/_lib/handlers";
import { toReadOnlyCompanyLabRepository } from "../readOnlyRepository";

const WRITE_METHOD_NAMES = [
  "createLab",
  "saveDraft",
  "loadDraft",
  "acquireProcessingLock",
  "releaseProcessingLock",
  "commitQuarterAtomically",
  "loadFullHistory",
] as const;

const READ_METHOD_NAMES = ["loadCurrentState", "labExists", "loadHistoryEntry", "loadHistoryIndex", "loadLatestHistoryEntry", "loadHistoryPage"] as const;

test("toReadOnlyCompanyLabRepository: 返すオブジェクトに書き込みメソッドへの参照が一切存在しない", () => {
  const writable = createInMemoryCompanyLabStateRepository();
  const readOnly = toReadOnlyCompanyLabRepository(writable);

  for (const methodName of WRITE_METHOD_NAMES) {
    assert.equal(methodName in readOnly, false, `${methodName} が読み取り専用オブジェクトに存在してはならない`);
    assert.equal((readOnly as unknown as Record<string, unknown>)[methodName], undefined, `${methodName} はundefinedであるべき`);
  }
});

test("toReadOnlyCompanyLabRepository: 許可された6個の読み取りメソッドだけを持つ（プロトタイプ経由の想定外メソッドが漏れていないこと）", () => {
  const writable = createInMemoryCompanyLabStateRepository();
  const readOnly = toReadOnlyCompanyLabRepository(writable);

  const ownKeys = Object.keys(readOnly).sort();
  assert.deepEqual(ownKeys, [...READ_METHOD_NAMES].sort());

  for (const methodName of READ_METHOD_NAMES) {
    assert.equal(typeof (readOnly as unknown as Record<string, unknown>)[methodName], "function");
  }
});

test("toReadOnlyCompanyLabRepository: 読み取りメソッドは元のRepositoryへ正しく委譲する（結果が一致する）", async () => {
  const writable = createInMemoryCompanyLabStateRepository();
  const readOnly = toReadOnlyCompanyLabRepository(writable);

  const service = createCompanyLabQuarterFlowService({ repository: writable });
  const createResult = await handleCreateLab(
    { repository: writable, service },
    { scenarioId: "baseline", mode: "canonical", seed: "readonly-repo-test-seed", turns: 2, playerCompanyId: "BAL", labId: "readonly-repo-test-lab" },
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(createResult.status, 201, JSON.stringify(createResult.body));
  const labId = "readonly-repo-test-lab";

  const viaWritable = await writable.loadCurrentState(labId);
  const viaReadOnly = await readOnly.loadCurrentState(labId);
  assert.deepEqual(viaReadOnly, viaWritable);

  assert.equal(await readOnly.labExists(labId), true);
  assert.equal(await readOnly.labExists("__no_such_lab__"), false);

  const indexViaWritable = await writable.loadHistoryIndex(labId);
  const indexViaReadOnly = await readOnly.loadHistoryIndex(labId);
  assert.deepEqual(indexViaReadOnly, indexViaWritable);
});
