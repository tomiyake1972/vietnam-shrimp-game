// ShrimpX V2 — MANUAL-BALANCE-1 管理会計の分類不整合の再現（修正はしない）
//
// 【目的】実績表示に管理会計（変動原価計算）指標を出すにあたり、現行Engineの
// absorption P&L と Contribution Margin レポートの間に分類上の不整合が
// 残っていることを**実測して記録する**。
//
// 【修正しない】原因はEngineの費用式（finance/quarterClose.ts）にあり、
// その変更は本Phaseでは禁止されている（#05の費用Projection接続Phaseで
// 「等式Aを字義どおり成立させるにはEngineの費用式変更が必要で、本Phaseでは
// 禁止されている」と明記済み）。ここでは差分を測り、画面の限界表示の根拠を
// テストとして残すだけである。
//
// 【既存の記述との整合】standardAi/__tests__/costProjectionWiring.test.ts が
// 同じ4費目を absorption 専用費目として列挙している。本テストはその列挙が
// 現時点でも正しいことを独立に確認する（同じ式を別経路から再計算する）。

import test from "node:test";
import assert from "node:assert/strict";

import { createSimulationSession, advanceSimulationTurns } from "../../simulation/engine";
import {
  MANAGEMENT_ACCOUNTING_ABSORPTION_ONLY_COST_ITEMS,
  summarizeManagementAccountingGap,
} from "../managementAccountingGap";

const EPSILON_USD = 0.01;

test("MAG-1: absorption専用費目の4項目が、Contribution Marginの固定費プールに含まれていない", () => {
  let session = createSimulationSession({
    simulationRunId: "mag-1",
    scenarioId: "baseline",
    seed: "mag-seed",
    requestedTurns: 12,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  session = advanceSimulationTurns({ session, turns: 12, timestamp: "2026-01-01T00:00:00.000Z" });

  const summary = summarizeManagementAccountingGap(session.state.history);

  // 4項目の名前が想定どおりであること（列挙が古くなっていないことの確認）。
  assert.deepEqual(
    [...MANAGEMENT_ACCOUNTING_ABSORPTION_ONLY_COST_ITEMS],
    ["capexMaintenanceCost", "factoryLifecycleCarryingCost", "salesForceSeveranceCost", "vapProductDevelopmentSpendUsd"],
    "absorption専用費目の列挙が変わっている（再調査が必要）"
  );

  // 実測: 不整合は今も存在する。0件になっていたら、どこかで修正されている
  // （＝画面の限界表示を外せる）ことを意味するので、その場合はここで気づけるようにする。
  assert.ok(
    summary.recordsWithGap > 0,
    `分類不整合が1件も検出されなかった。どこかで修正された可能性があるため限界表示の要否を再確認すること（総レコード${summary.totalRecords}件）`
  );

  // 差額は「absorption専用費目の合計」で説明しきれること。
  // 説明しきれない残差があるなら、4項目以外の原因が増えている。
  assert.ok(
    summary.maxUnexplainedResidualUsd <= EPSILON_USD,
    `4項目で説明できない残差がある（max=${summary.maxUnexplainedResidualUsd} USD）。原因が4項目以外にも増えている可能性がある`
  );
});

test("MAG-2: 分類不整合の実測値が画面の限界表示の根拠として取得できる", () => {
  let session = createSimulationSession({
    simulationRunId: "mag-2",
    scenarioId: "baseline",
    seed: "mag-seed-2",
    requestedTurns: 8,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  session = advanceSimulationTurns({ session, turns: 8, timestamp: "2026-01-01T00:00:00.000Z" });

  const summary = summarizeManagementAccountingGap(session.state.history);
  assert.ok(summary.totalRecords > 0);
  assert.ok(summary.maxAbsorptionOnlyCostUsd > 0, "absorption専用費目の合計が常に0（テスト条件が弱い）");
  // 画面が「影響あり」と表示するための判定材料が揃っていること。
  assert.equal(typeof summary.recordsWithGap, "number");
  assert.equal(typeof summary.maxAbsorptionOnlyCostUsd, "number");
});
