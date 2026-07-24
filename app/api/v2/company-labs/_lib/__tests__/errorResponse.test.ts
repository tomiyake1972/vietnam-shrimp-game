// ShrimpX V2 — 会社ラボ API ドメインエラー→HTTP変換テスト（Phase 8C-3A §8）

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapDomainErrorToHttp } from "../errorResponse";
import {
  CompanyLabAlreadyExistsError,
  CompanyLabCompletedError,
  CompanyLabDraftAlreadySubmittedError,
  CompanyLabDraftConflictError,
  CompanyLabDraftNotFoundError,
  CompanyLabDraftNotSubmittedError,
  CompanyLabDraftTurnMismatchError,
  CompanyLabHistoryEntryNotFoundError,
  CompanyLabIntegrityError,
  CompanyLabLockConflictError,
  CompanyLabLockUnavailableError,
  CompanyLabNotFoundError,
  CompanyLabQuarterProcessingError,
  CompanyLabRepositoryError,
  CompanyLabRevisionConflictError,
  CompanyLabTurnConflictError,
} from "../../../../../lib/v2/companyLab/persistence/errors";
import { CompanyLabError } from "../../../../../lib/v2/companyLab/types";

const CASES: readonly { readonly label: string; readonly build: () => unknown; readonly status: number }[] = [
  { label: "CompanyLabNotFoundError", build: () => new CompanyLabNotFoundError("l"), status: 404 },
  { label: "CompanyLabHistoryEntryNotFoundError", build: () => new CompanyLabHistoryEntryNotFoundError("l", 1), status: 404 },
  { label: "CompanyLabAlreadyExistsError", build: () => new CompanyLabAlreadyExistsError("l"), status: 409 },
  { label: "CompanyLabCompletedError", build: () => new CompanyLabCompletedError("l"), status: 409 },
  { label: "CompanyLabDraftNotFoundError", build: () => new CompanyLabDraftNotFoundError("l"), status: 409 },
  { label: "CompanyLabDraftNotSubmittedError", build: () => new CompanyLabDraftNotSubmittedError("l"), status: 409 },
  { label: "CompanyLabDraftAlreadySubmittedError", build: () => new CompanyLabDraftAlreadySubmittedError("l"), status: 409 },
  { label: "CompanyLabDraftConflictError", build: () => new CompanyLabDraftConflictError("l", "turn-1", "turn-2"), status: 409 },
  { label: "CompanyLabDraftTurnMismatchError", build: () => new CompanyLabDraftTurnMismatchError("l", "turn-1", "turn-2"), status: 409 },
  { label: "CompanyLabRevisionConflictError", build: () => new CompanyLabRevisionConflictError("l", 0, 1), status: 409 },
  { label: "CompanyLabTurnConflictError", build: () => new CompanyLabTurnConflictError("l", 1, "turn-x"), status: 409 },
  { label: "CompanyLabLockConflictError", build: () => new CompanyLabLockConflictError("l"), status: 409 },
  { label: "CompanyLabLockUnavailableError", build: () => new CompanyLabLockUnavailableError("l"), status: 423 },
  { label: "CompanyLabQuarterProcessingError", build: () => new CompanyLabQuarterProcessingError("l", "engine crashed"), status: 422 },
  { label: "CompanyLabError", build: () => new CompanyLabError("scenario not found"), status: 400 },
  { label: "CompanyLabIntegrityError", build: () => new CompanyLabIntegrityError("l", "inconsistent"), status: 500 },
  { label: "CompanyLabRepositoryError", build: () => new CompanyLabRepositoryError("redis down"), status: 500 },
  { label: "plain Error", build: () => new Error("something totally unexpected"), status: 500 },
  { label: "raw string throw", build: () => "a raw string throw", status: 500 },
];

for (const { label, build, status } of CASES) {
  test(`mapDomainErrorToHttp: ${label} -> ${status}`, () => {
    const result = mapDomainErrorToHttp(build());
    assert.equal(result.status, status);
    assert.ok(result.body.error.code.length > 0);
    assert.ok(result.body.error.message.length > 0);
  });
}

test("mapDomainErrorToHttp: 内部エラー(500)応答のメッセージには元例外のメッセージ内容を含めない（内部詳細の非露出）", () => {
  const secretDetail = "ヒミツのRedis接続文字列やスタックトレースの断片XYZ123";
  const result = mapDomainErrorToHttp(new CompanyLabRepositoryError(`失敗しました: ${secretDetail}`));
  assert.equal(result.status, 500);
  assert.ok(!result.body.error.message.includes(secretDetail), "内部詳細が500応答へ漏れている");
});
