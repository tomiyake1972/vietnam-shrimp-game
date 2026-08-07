// ShrimpX V2 — Phase SAI-3B-1: reasonCodeCatalog.ts のユニットテスト
//
// 既存レジストリ（standardAi/reasonCodes.ts）のコードがすべてカタログに
// 含まれていること（新規コードを作らず、既存を漏れなく参照していること）を検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { STANDARD_AI_REASON_CODES } from "../../reasonCodes";
import { lookupReasonCode, REASON_CODE_CATALOG } from "../reasonCodeCatalog";

test("REASON_CODE_CATALOG: standardAi/reasonCodes.tsの全コードを含む", () => {
  const catalogCodes = new Set(REASON_CODE_CATALOG.filter((e) => e.source === "standardAi").map((e) => e.code));
  for (const code of STANDARD_AI_REASON_CODES) {
    assert.ok(catalogCodes.has(code), `missing code in catalog: ${code}`);
  }
});

test("lookupReasonCode: 既知コードはdescription/domainを返す", () => {
  const entry = lookupReasonCode("RAW_MATERIAL_SHORTAGE", "standardAi");
  assert.equal(entry.description, "原料不足");
  assert.equal(entry.domain, "raw_material");
});

test("lookupReasonCode: 未知コードは捏造せず「説明未登録」を返す", () => {
  const entry = lookupReasonCode("SOME_UNKNOWN_CODE", "standardAi");
  assert.match(entry.description, /説明未登録/);
});
