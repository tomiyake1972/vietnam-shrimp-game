// ShrimpX V2 — Phase 8D-0 基準状態（旧仕様のふるまい）の固定テスト
//
// 【このテストの目的】
//   Phase 8D（設備投資・工場スペース・Worker・能力表示の再設計）で、既存の
//   ゲームエンジンのふるまいを壊していないことを、再現可能な形で保証する。
//   テストプレイ中の実ゲーム（ラボ test12）は削除も再実行もしないため、
//   「同じseed・同じシナリオ・同じ自動方針なら同じ結果になる」という
//   決定論性を基準状態として代わりに固定する（実装指示 Phase 8D-0
//   「再現可能なseed、fixture、診断コマンド、テスト出力のいずれかで
//   基準状態を残すこと」に対応）。
//
// 【なぜ期待値を直書きしないか】
//   期待値をここで独自計算すると、エンジンの誤りをテストが追認してしまう。
//   そこで、
//     (a) 決定論性（同じ入力 → 同じ出力）
//     (b) 32四半期の完走
//     (c) 不正値（NaN・Infinity・不正な負値）が発生しないこと
//     (d) 自動方針は設備投資を一切提案しない（＝Phase 8Dの投資テンプレート
//         変更がこの基準シミュレーションへ影響し得ないことの構造的な保証）
//   という「性質」を固定する。数値そのものの妥当性は、既存の各モジュールの
//   テストが担う。
//
// 【禁止事項】
//   - このテストの中でエンジンの計算式を再実装しない。
//   - 実ゲーム（test12）の状態をここへ写経しない（推測値を実績にしない）。

import test from "node:test";
import assert from "node:assert/strict";

import { CompanyLabConfig } from "../types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { COMPANY_LAB_COMPANY_IDS } from "../fixtures";

/**
 * 基準シミュレーションの構成。ここに書かれた scenario / mode / seed / turns が
 * 「基準状態を再生成するための唯一の情報」である（Phase 8D-0の保存対象）。
 */
export const PHASE_8D_BASELINE_CONFIG: CompanyLabConfig = {
  scenarioId: "baseline",
  mode: "canonical",
  seed: "phase8d-baseline",
  turns: 32,
};

function runBaseline() {
  return runCompanyLabWithAutoPolicyForAllCompanies(PHASE_8D_BASELINE_CONFIG, (fixture, ownState, publicInfo, period, turn) =>
    generateAutoPolicyDecision(fixture, ownState, publicInfo, period, turn)
  );
}

function assertFiniteNumbersDeep(value: unknown, path: string, seen: Set<unknown>): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} が有限の数値ではありません: ${value}`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertFiniteNumbersDeep(v, `${path}[${i}]`, seen));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertFiniteNumbersDeep(v, `${path}.${k}`, seen);
  }
}

test("Phase 8D-0基準: 32四半期の会社シミュレーションが完走し、5社ぶんの履歴が32件そろう", () => {
  const result = runBaseline();
  assert.equal(result.history.length, 32, "32四半期ぶんの確定履歴が必要です");
  assert.equal(result.companies.length, COMPANY_LAB_COMPANY_IDS.length);
  for (const record of result.history) {
    assert.equal(record.companySummaries.length, COMPANY_LAB_COMPANY_IDS.length, `turn ${record.turn} の会社サマリーが5社ぶんありません`);
    assert.equal(record.financialResults.length, COMPANY_LAB_COMPANY_IDS.length, `turn ${record.turn} の財務結果が5社ぶんありません`);
  }
});

test("Phase 8D-0基準: 同じseed・同じ自動方針なら、32四半期の結果が完全に一致する（決定論性）", () => {
  const a = runBaseline();
  const b = runBaseline();
  assert.deepEqual(JSON.parse(JSON.stringify(b.history)), JSON.parse(JSON.stringify(a.history)));
});

test("Phase 8D-0基準: 32四半期の確定履歴に NaN・Infinity が一切発生しない", () => {
  const result = runBaseline();
  assertFiniteNumbersDeep(result.history, "history", new Set());
});

test("Phase 8D-0基準: 自動方針は設備投資を一切提案しないため、投資テンプレートの変更は基準シミュレーションへ影響しない", () => {
  const result = runBaseline();
  for (const record of result.history) {
    for (const capex of record.capexResults) {
      assert.equal(capex.rejectedProposals.length, 0, `turn ${record.turn} / ${capex.companyId}: 自動方針は投資提案を行わない前提です`);
      assert.equal(capex.events.length, 0, `turn ${record.turn} / ${capex.companyId}: 投資案件が存在しない前提です`);
      assert.equal(capex.totalPaidThisQuarterUsd, 0);
      assert.equal(capex.endingConstructionInProgressUsd, 0);
    }
  }
});

test("Phase 8D-0基準: 数量・比率に不正な負値が発生しない（生産・在庫・能力）", () => {
  const result = runBaseline();
  for (const record of result.history) {
    for (const entry of record.productionAllocation.entries) {
      assert.ok((entry.allocatedQuantity as number) >= 0, `turn ${record.turn}: 生産配分量が負です`);
      assert.ok((entry.shortfallQuantity as number) >= 0, `turn ${record.turn}: 未処理量が負です`);
    }
    for (const summary of record.companySummaries) {
      assert.ok((summary.equipmentUtilizationRate as number) >= 0, `turn ${record.turn}: 設備稼働率が負です`);
      assert.ok((summary.laborUtilizationRate as number) >= 0, `turn ${record.turn}: 労働稼働率が負です`);
    }
  }
});
