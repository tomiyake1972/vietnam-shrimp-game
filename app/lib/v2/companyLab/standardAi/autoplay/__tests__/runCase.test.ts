// ShrimpX V2 — Phase SAI-3A: 自動テストプレイ実行（runAutoplayCase）のテスト
//
// 「同一条件・同一seedなら常に同一結果」「異なるseedなら結果が変わりうる」
// 「headcount overrideが実際に反映される」という、判断記録基盤の再現性の
// 大前提を確認する。既存のstandardAi/companyLabの経済ロジック自体は
// 一切変更していないため、経済ロジックの網羅的な検証はしない
// （既存の report/__tests__ 側の責務）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutoplayCase } from "../runCase";
import { ALL_COMPANY_IDS } from "../../report/decomposeHarness";
import { STANDARD_BASELINE_CANDIDATES, SELECTED_STANDARD_BASELINE_CANDIDATE_ID } from "../../report/standardBaseline";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

test("runAutoplayCase: 同一scenario・同一candidate・同一seedなら、履歴・診断・キャプチャが完全に一致する（決定論的）", () => {
  const config = { scenarioId: "baseline", seed: "sai3a-test-repro-001", quarters: 4, companyIds: ALL_COMPANY_IDS, candidate };
  const a = runAutoplayCase(config);
  const b = runAutoplayCase(config);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));
  assert.equal(JSON.stringify(a.diagnostics), JSON.stringify(b.diagnostics));
  assert.equal(JSON.stringify(a.quarterStartCaptures), JSON.stringify(b.quarterStartCaptures));
});

test("runAutoplayCase: 異なるseedでは結果が変わりうる（少なくとも履歴のどこかが異なる）", () => {
  const base = { scenarioId: "baseline", quarters: 4, companyIds: ALL_COMPANY_IDS, candidate };
  const a = runAutoplayCase({ ...base, seed: "sai3a-test-seedA" });
  const b = runAutoplayCase({ ...base, seed: "sai3a-test-seedB" });
  assert.notEqual(JSON.stringify(a.history), JSON.stringify(b.history), "異なるseedで履歴が完全一致するのは想定外（乱数要素が反映されていない可能性）");
});

test("runAutoplayCase: quartersを指定した通りのturn数だけ実行する（completedTurns/historyの長さが一致）", () => {
  const result = runAutoplayCase({ scenarioId: "baseline", seed: "sai3a-test-turns", quarters: 3, companyIds: ALL_COMPANY_IDS, candidate });
  assert.equal(result.completedTurns, 3);
  assert.equal(result.history.length, 3);
  assert.deepEqual(
    result.history.map((h) => h.turn),
    [1, 2, 3]
  );
});

test("runAutoplayCase: companyIdsを指定した会社だけを実行する（会社数を絞り込める）", () => {
  const result = runAutoplayCase({ scenarioId: "baseline", seed: "sai3a-test-company-subset", quarters: 2, companyIds: ["BAL", "MASS"], candidate });
  assert.deepEqual(result.companyIds, ["BAL", "MASS"]);
  for (const capture of result.quarterStartCaptures) {
    assert.ok(["BAL", "MASS"].includes(capture.companyId), `想定外の会社IDがキャプチャされた: ${capture.companyId}`);
  }
});

test("runAutoplayCase: salesForceHeadcountOverrideを指定すると、実際のfixtureのsalesForceHeadcountTotalへ反映される", () => {
  const result = runAutoplayCase({
    scenarioId: "baseline",
    seed: "sai3a-test-headcount-override",
    quarters: 1,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    salesForceHeadcountOverride: 85,
  });
  for (const fixture of result.companies) {
    assert.equal(fixture.salesForceHeadcountTotal, 85);
  }
  for (const capture of result.quarterStartCaptures) {
    assert.equal(capture.fixture.salesForceHeadcountTotal, 85);
  }
});

test("runAutoplayCase: 診断情報とキャプチャの件数は、会社数×クォーター数と一致する", () => {
  const quarters = 3;
  const companyIds = ["BAL", "MASS", "JPQ"] as const;
  const result = runAutoplayCase({ scenarioId: "baseline", seed: "sai3a-test-counts", quarters, companyIds, candidate });
  assert.equal(result.quarterStartCaptures.length, companyIds.length * quarters);
  assert.equal(result.diagnostics.length, companyIds.length * quarters);
});
