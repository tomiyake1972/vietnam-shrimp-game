// ShrimpX V2 — 会社ラボ永続化 ランタイムスナップショット生成テスト（Phase 8C-1 §8-1）
//
// createCompanyLabRuntimeSnapshot・restoreCompanyLabStateFromRuntimeSnapshot・
// snapshotHasForbiddenHistoryKeysの検証。最重要の確認事項は「historyの再帰的複製が
// 一切発生しないこと」であり、トップレベルのhistoryだけでなく、productionState内部の
// historyも対象にしている点に注意する（types.ts・snapshot.ts冒頭コメント参照）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeCompanyLab } from "../../runner";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot, snapshotHasForbiddenHistoryKeys } from "../snapshot";
import { runRealQuartersWithAutoPolicy, baseTestConfig } from "./testHelpers";

test("空のhistoryからでもCompanyLabRuntimeSnapshotを生成できる", () => {
  const { state } = initializeCompanyLab(baseTestConfig({ turns: 4 }));
  assert.equal(state.history.length, 0);
  const snapshot = createCompanyLabRuntimeSnapshot(state);
  assert.equal(snapshotHasForbiddenHistoryKeys(snapshot), false);
  assert.equal(snapshot.currentPeriod, state.currentPeriod);
  assert.equal(snapshot.isComplete, false);
});

test("スナップショットにはトップレベルのhistoryキー自体が存在しない", () => {
  const { state } = initializeCompanyLab(baseTestConfig({ turns: 4 }));
  const snapshot = createCompanyLabRuntimeSnapshot(state) as unknown as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, "history"), false);
});

test("複数四半期分のhistoryが存在する状態からスナップショットを作っても、historyは除外される（処理前・処理後の両方）", () => {
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: 8 }), 8);
  assert.equal(quarters.length, 8);
  for (const q of quarters) {
    assert.ok(q.stateAfter.history.length >= 1, "処理後stateには少なくとも1件のhistoryがあるはず");
    const pre = createCompanyLabRuntimeSnapshot(q.stateBefore);
    const post = createCompanyLabRuntimeSnapshot(q.stateAfter);
    assert.equal(snapshotHasForbiddenHistoryKeys(pre), false, `turn ${q.record.turn} preスナップショットにhistoryが混入`);
    assert.equal(snapshotHasForbiddenHistoryKeys(post), false, `turn ${q.record.turn} postスナップショットにhistoryが混入`);
    assert.equal(Object.prototype.hasOwnProperty.call(pre, "history"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(post, "history"), false);
  }
  void fixtures;
});

test("productionState内部にもhistoryキーが存在しない（ProductionState.historyの再帰的複製の防止）", () => {
  const { quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: 5 }), 5);
  for (const q of quarters) {
    // 元のCompanyLabState側は当然productionState.historyを持つ（エンジンの通常の挙動）。
    assert.ok(Array.isArray(q.stateAfter.productionState.history));
    const post = createCompanyLabRuntimeSnapshot(q.stateAfter) as unknown as { productionState: Record<string, unknown> };
    assert.equal(Object.prototype.hasOwnProperty.call(post.productionState, "history"), false, `turn ${q.record.turn} productionState.historyが混入`);
  }
});

test("JSON文字列化した結果にも、最上位の\"history\"キーは（再帰的複製の意味では）出現しない", () => {
  const { quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: 10 }), 10);
  const last = quarters[quarters.length - 1];
  const post = createCompanyLabRuntimeSnapshot(last.stateAfter);
  const json = JSON.stringify(post);
  const parsed = JSON.parse(json);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "history"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.productionState, "history"), false);
  // 素朴な文字列検索でも「トップレベルキーとしての"history"」は出現しないことを補助的に確認する
  // （financingState.companies[].historyという正当な小さいオブジェクトフィールドは別に存在してよい。
  // 次のテストでその区別を明示的に確認する）。
  assert.equal(/"history"\s*:\s*\[/.test(json.slice(0, json.indexOf('"scenarioState"'))), false);
});

test("financingState.companies[].history（延滞回数等の集計カウンタ）は正当なフィールドとして保持され、誤って除去されない", () => {
  const { quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: 6 }), 6);
  const last = quarters[quarters.length - 1];
  const post = createCompanyLabRuntimeSnapshot(last.stateAfter);
  assert.ok(post.financingState.companies.length > 0);
  for (const c of post.financingState.companies) {
    // CompanyFinancingHistoryは配列ではなく、カウンタを持つオブジェクトである。
    assert.equal(typeof c.history, "object");
    assert.equal(Array.isArray(c.history), false);
    assert.ok("consecutiveArrearsQuarters" in c.history);
  }
  // snapshotHasForbiddenHistoryKeysは、この正当なfinancingState.companies[].historyを
  // 誤検出してはならない（無差別な再帰走査ではなく、トップレベルとproductionStateのみを見る設計）。
  assert.equal(snapshotHasForbiddenHistoryKeys(post), false);
});

test("スナップショットから再開に必要な全フィールドを復元できる（restoreCompanyLabStateFromRuntimeSnapshot）", () => {
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: 3 }), 3);
  const last = quarters[quarters.length - 1];
  const snapshot = createCompanyLabRuntimeSnapshot(last.stateAfter);
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(last.stateAfter.config, snapshot, []);

  assert.equal(restored.currentPeriod, last.stateAfter.currentPeriod);
  assert.equal(restored.isComplete, last.stateAfter.isComplete);
  assert.deepEqual(restored.contracts, last.stateAfter.contracts);
  assert.deepEqual(restored.rawMaterialLots, last.stateAfter.rawMaterialLots);
  assert.deepEqual(restored.productionState.finishedGoodsLots, last.stateAfter.productionState.finishedGoodsLots);
  assert.deepEqual(restored.productionState.history, []); // 意図的に空配列で復元される
  assert.deepEqual(restored.qualityState, last.stateAfter.qualityState);
  assert.deepEqual(restored.financeState, last.stateAfter.financeState);
  assert.deepEqual(restored.financingState, last.stateAfter.financingState);
  assert.deepEqual(restored.capexState, last.stateAfter.capexState);
  void fixtures;
});

test("snapshotHasForbiddenHistoryKeysは非オブジェクト・null・配列を安全にfalse扱いする", () => {
  assert.equal(snapshotHasForbiddenHistoryKeys(null), false);
  assert.equal(snapshotHasForbiddenHistoryKeys(undefined), false);
  assert.equal(snapshotHasForbiddenHistoryKeys(42), false);
  assert.equal(snapshotHasForbiddenHistoryKeys("string"), false);
  assert.equal(snapshotHasForbiddenHistoryKeys([]), false);
});

test("snapshotHasForbiddenHistoryKeysはトップレベルにhistoryを持つ不正なオブジェクトを検出する", () => {
  assert.equal(snapshotHasForbiddenHistoryKeys({ history: [] }), true);
  assert.equal(snapshotHasForbiddenHistoryKeys({ productionState: { history: [] } }), true);
  assert.equal(snapshotHasForbiddenHistoryKeys({ productionState: { finishedGoodsLots: [] } }), false);
});
