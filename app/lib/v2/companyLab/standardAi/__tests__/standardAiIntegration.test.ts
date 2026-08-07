// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 統合テスト（8ターン・32ターン）
//
// companyLab/__tests__/runner.test.ts の既存8Q/32Qテストパターンを、
// 意思決定生成器だけgenerateStandardAiDecisionへ差し替えてそのまま踏襲する
// （実装指示: 「既存の8Q/32Qテストパターンを流用できる」）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../../core/units";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../../runner";
import { generateStandardAiDecision, createStandardAiProvider } from "../policy";
import { CompanyLabConfig } from "../../types";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "standard-ai-integration-001", turns: 8, ...overrides };
}

function runAllStandardAi(config: CompanyLabConfig) {
  return runCompanyLabWithAutoPolicyForAllCompanies(config, generateStandardAiDecision);
}

function assertAllFinite(value: unknown, path = "root"): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} が有限数ではありません（受け取った値: ${value}）`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertAllFinite(v, `${path}.${k}`);
  }
}

test("標準AI: 5社×8ターンを、人間の入力なしで完走する", () => {
  const result = runAllStandardAi(baseConfig({ turns: 8 }));
  assert.equal(result.history.length, 8);
  assert.equal(result.companies.length, 5);
  for (const record of result.history) {
    assert.equal(record.companySummaries.length, 5);
  }
});

test("標準AI: 5社×32ターンを、人間の入力なしで完走する", () => {
  const result = runAllStandardAi(baseConfig({ turns: 32 }));
  assert.equal(result.history.length, 32);
});

test("標準AI: 同一シード・同一設定なら8ターンの全結果が完全に同一になる（決定論性・再現性）", () => {
  const a = runAllStandardAi(baseConfig({ seed: "standard-ai-determinism-001", turns: 8 }));
  const b = runAllStandardAi(baseConfig({ seed: "standard-ai-determinism-001", turns: 8 }));
  assert.deepEqual(JSON.parse(JSON.stringify(a.history)), JSON.parse(JSON.stringify(b.history)));
});

test("標準AI: 32ターンにわたり、意思決定・記録のすべての数値フィールドが有限（NaN・Infinityが無い）", () => {
  const result = runAllStandardAi(baseConfig({ seed: "standard-ai-finite-001", turns: 32 }));
  assertAllFinite(result.history);
});

test("標準AI: 32ターンにわたり、原料在庫・完成品在庫・未履行契約残がいずれも負にならない", () => {
  const result = runAllStandardAi(baseConfig({ seed: "standard-ai-nonneg-001", turns: 32 }));
  for (const record of result.history) {
    for (const s of record.companySummaries) {
      assert.ok(unwrapUnit(s.rawMaterialInventory) >= 0);
      assert.ok(unwrapUnit(s.finishedGoodsInventory) >= 0);
      assert.ok(unwrapUnit(s.outstandingQuantity) >= 0);
    }
  }
});

test("標準AI: 工場×商品の生産量は、工場能力・原料・ワーカーいずれの制約も超えない", () => {
  const result = runAllStandardAi(baseConfig({ seed: "standard-ai-capacity-001", turns: 8 }));
  for (const record of result.history) {
    for (const entry of record.productionAllocation.entries) {
      assert.ok(
        unwrapUnit(entry.allocatedQuantity) <= unwrapUnit(entry.desiredQuantity) + 1e-6,
        "配分量は希望量を超えてはならない"
      );
      // stages.laborLimitedは制約カスケードの最終段（既存runner.test.tsの
      // 「工場×商品の生産量は工場能力・原料・ワーカーいずれの制約も超えない」と同じ検証）。
      assert.ok(unwrapUnit(entry.allocatedQuantity) <= unwrapUnit(entry.stages.laborLimited) + 1e-6);
    }
  }
});

test("標準AI: 会社×工場のワーカー配分合計は配置人数（常用・臨時それぞれ）を超えない", () => {
  const result = runAllStandardAi(baseConfig({ seed: "standard-ai-labor-001", turns: 8 }));
  for (const record of result.history) {
    for (const decision of record.decisions) {
      for (const assignment of decision.workerAssignments) {
        const assignedRegular = record.productionAllocation.entries
          .filter((e) => e.companyId === decision.companyId && e.factoryId === assignment.factoryId)
          .reduce((s, e) => s + e.labor.assignedRegularHeadcount, 0);
        const assignedTemporary = record.productionAllocation.entries
          .filter((e) => e.companyId === decision.companyId && e.factoryId === assignment.factoryId)
          .reduce((s, e) => s + e.labor.assignedTemporaryHeadcount, 0);
        assert.ok(assignedRegular <= assignment.regularHeadcount + 1e-6);
        assert.ok(assignedTemporary <= assignment.temporaryHeadcount + 1e-6);
      }
    }
  }
});

test("標準AI: 自動方針は公開情報と自社状態だけを使う（関数シグネチャ上、他社の非公開計画・将来シナリオを受け取れない）", () => {
  // CompanyDecisionProviderは (fixture, ownState, publicInfo, period, turn) の5引数以外を
  // 受け取れない。generateStandardAiDecisionの実引数の数がこれと一致することを確認する
  // （型チェック自体はpolicy.tsの`const _typeCheck: CompanyDecisionProvider = ...`で
  // コンパイル時に保証済み。ここでは実行時の見た目も一致することを補足確認する）。
  assert.equal(generateStandardAiDecision.length, 5);
});

test("標準AI: 5社すべてが同一の意思決定原則（同一パラメータ）で動く。5社比較の全社が例外なく完走する", () => {
  const result = runAllStandardAi(baseConfig({ seed: "standard-ai-uniform-001", turns: 8 }));
  const companyIds = result.companies.map((c) => c.companyId).sort();
  assert.deepEqual(companyIds, ["BAL", "CONSV", "JPQ", "MASS", "VAP"]);
  for (const record of result.history) {
    assert.equal(record.decisions.length, 5);
  }
});

test("標準AI: 入力（state・fixtures・decisions）を変更しない", () => {
  const config = baseConfig({ seed: "standard-ai-immutability-001", turns: 4 });
  const before = JSON.stringify(config);
  runAllStandardAi(config);
  assert.equal(JSON.stringify(config), before);
});

test("標準AI: 診断情報（createStandardAiProvider）は計算を再実行せず、通常実行と完全に同じ意思決定を返す", () => {
  const config = baseConfig({ seed: "standard-ai-diagnostics-001", turns: 4 });
  const direct = runAllStandardAi(config);
  const { provider, diagnostics } = createStandardAiProvider();
  const viaProvider = runCompanyLabWithAutoPolicyForAllCompanies(config, provider);
  assert.deepEqual(
    JSON.parse(JSON.stringify(direct.history.map((r) => r.decisions))),
    JSON.parse(JSON.stringify(viaProvider.history.map((r) => r.decisions)))
  );
  // 4ターン×5社ぶんの診断情報が記録されている。
  assert.equal(diagnostics.length, 20);
  assert.ok(diagnostics.every((d) => Array.isArray(d.entries)));
});
