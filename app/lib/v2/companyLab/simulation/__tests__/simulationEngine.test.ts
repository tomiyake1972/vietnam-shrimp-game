// ShrimpX V2 — 32Q Management Console Phase 1: シミュレーション実行の単体テスト
//
// 【守る因果】
//  ・1 Turn / 4 Turns / 32 Turns は「ちょうどその回数」だけ通常ゲームの
//    ターン処理を通る（fast-run 専用の近道が無い）
//  ・STOP は完了済みターンを保存し、処理中ターンを中途半端に残さない
//  ・失敗したターンを成功扱いしない
//  ・同じ seed・同じ設定なら同じ結果になる

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceSimulationTurn,
  advanceSimulationTurns,
  createSimulationSession,
  resolveGameParameterVersion,
  resolveStandardAiVersion,
} from "../engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../types";
import { buildCompanySeries, buildCompanyInspectorSnapshot, COMPANY_COLORS } from "../series";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../standardAi/policy";
import {
  FACTORY_SPACE_PARAMETERS_V1,
  computeFactoryUsedSpaceUnits,
  resolveFactoryTotalSpaceUnits,
} from "../../../production/factorySpace";
import { computeCandidateProjectSpaceUnits } from "../../../capex/factorySpace";
import {
  createEmptyStrategyDocument,
  resolveStrategyAtTurn,
  STRATEGY_PROFILE_SCHEMA_VERSION,
} from "../../strategyProfile/types";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const TS = "2026-08-09T00:00:00.000Z";

function newSession(turns: number, seed = "console-test-seed") {
  return createSimulationSession({
    simulationRunId: "run-test-1",
    scenarioId: "baseline",
    seed,
    requestedTurns: turns,
    startedAt: TS,
  });
}

// ---------------------------------------------------------------------
// Run Control: ちょうど N ターン
// ---------------------------------------------------------------------

test("CONSOLE-1: 1 Turn はちょうど1ターンだけ進む", () => {
  const s0 = newSession(1);
  assert.equal(s0.state.history.length, 0);
  const s1 = advanceSimulationTurns({ session: s0, turns: 1, timestamp: TS });
  assert.equal(s1.state.history.length, 1, "履歴が1ターン分でない");
  assert.equal(s1.run.completedTurns, 1);
  assert.equal(s1.run.stopReason, "completed");
});

test("CONSOLE-2: 4 Turns はちょうど4ターン進む", () => {
  const s = advanceSimulationTurns({ session: newSession(4), turns: 4, timestamp: TS });
  assert.equal(s.state.history.length, 4);
  assert.equal(s.run.completedTurns, 4);
  assert.equal(s.run.stopReason, "completed");
});

test("CONSOLE-3: 32 Turns はちょうど32ターン進む（8Q前提になっていない）", () => {
  const s = advanceSimulationTurns({
    session: newSession(MANAGEMENT_CONSOLE_STANDARD_TURNS),
    turns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    timestamp: TS,
  });
  assert.equal(MANAGEMENT_CONSOLE_STANDARD_TURNS, 32);
  assert.equal(s.state.history.length, 32, `32ターン走っていない（${s.state.history.length}）`);
  assert.equal(s.run.completedTurns, 32);
  assert.equal(s.run.stopReason, "completed");
  // 全ターンの turn 番号が 1..32 で欠けていない。
  assert.deepEqual(
    s.state.history.map((r) => r.turn),
    Array.from({ length: 32 }, (_, i) => i + 1)
  );
});

// ---------------------------------------------------------------------
// STOP
// ---------------------------------------------------------------------

test("CONSOLE-4: STOP は完了済みターンを保存し、処理中ターンを中途半端に残さない", () => {
  let processed = 0;
  const s = advanceSimulationTurns({
    session: newSession(32),
    turns: 32,
    // 5ターン目の処理**前**に停止する。
    shouldStop: () => {
      const stop = processed >= 5;
      if (!stop) processed += 1;
      return stop;
    },
    timestamp: TS,
  });
  assert.equal(s.run.stopReason, "stopped_by_user");
  assert.equal(s.run.completedTurns, 5, "完了ターン数が正しくない");
  assert.equal(s.state.history.length, 5, "履歴に中途半端なターンが残っている");
  // 保存された最後のターンは完全な記録である（財務結果まで揃っている）。
  const last = s.state.history[s.state.history.length - 1];
  assert.ok((last.financialResults?.length ?? 0) > 0, "最後のターンの財務結果が欠けている");
});

test("CONSOLE-5: STOP後のセッションから続きを再開できる（状態が壊れていない）", () => {
  let count = 0;
  const stopped = advanceSimulationTurns({
    session: newSession(32),
    turns: 32,
    shouldStop: () => {
      const stop = count >= 3;
      if (!stop) count += 1;
      return stop;
    },
    timestamp: TS,
  });
  assert.equal(stopped.state.history.length, 3);
  const resumed = advanceSimulationTurns({ session: stopped, turns: 2, timestamp: TS });
  assert.equal(resumed.state.history.length, 5);
  assert.equal(resumed.run.completedTurns, 5);
});

// ---------------------------------------------------------------------
// エラー処理
// ---------------------------------------------------------------------

test("CONSOLE-6: ターン処理が失敗したら、そのターンを成功扱いにしない", () => {
  const s0 = newSession(4);
  // 壊れた状態を渡して失敗させる（fixtures を空にすると意思決定が組めない）。
  const broken = { ...s0, fixtures: [] as typeof s0.fixtures };
  const outcome = advanceSimulationTurn(
    { ...broken, state: { ...broken.state, contracts: null as never } },
    TS
  );
  assert.equal(outcome.advanced, false);
  assert.equal(outcome.session.run.completedTurns, 0, "失敗したターンが完了扱いになっている");
  assert.equal(outcome.session.run.stopReason, "error");
  assert.ok(outcome.session.run.failedAtTurn !== null, "失敗したターン番号が記録されていない");
  assert.ok(outcome.session.run.errorMessage, "エラー原因が記録されていない");
});

// ---------------------------------------------------------------------
// SimulationRun metadata / determinism
// ---------------------------------------------------------------------

test("CONSOLE-7: SimulationRun に再現に必要なメタデータが揃っている", () => {
  const s = newSession(32);
  const r = s.run;
  assert.equal(r.scenarioId, "baseline");
  assert.equal(r.seed, "console-test-seed");
  assert.equal(r.requestedTurns, 32);
  assert.equal(r.completedTurns, 0);
  assert.equal(r.startingTurn, 1);
  assert.equal(r.startedAt, TS);
  assert.equal(r.completedAt, null);
  assert.equal(r.stopReason, "running");
  for (const [key, value] of Object.entries({
    scenarioVersion: r.scenarioVersion,
    gameParameterVersion: r.gameParameterVersion,
    standardAiVersion: r.standardAiVersion,
    strategyProfileVersion: r.strategyProfileVersion,
  })) {
    assert.ok(typeof value === "string" && value.length > 0, `${key} が空`);
  }
  assert.equal(r.gameParameterVersion, resolveGameParameterVersion());
  assert.equal(r.standardAiVersion, resolveStandardAiVersion());
});

test("CONSOLE-8: 同じ seed・同じ設定なら同じ結果になる（決定論）", () => {
  const a = advanceSimulationTurns({ session: newSession(6, "determinism-seed"), turns: 6, timestamp: TS });
  const b = advanceSimulationTurns({ session: newSession(6, "determinism-seed"), turns: 6, timestamp: TS });
  const pick = (s: typeof a) =>
    s.state.history.map((r) => ({
      turn: r.turn,
      results: (r.financialResults ?? []).map((f) => ({
        companyId: f.companyId,
        revenue: f.profitAndLoss.netRevenue,
        operatingProfit: f.profitAndLoss.operatingProfit,
      })),
    }));
  assert.deepEqual(pick(a), pick(b));
});

test("CONSOLE-9: seed が違えば結果も違う（seedが実際に効いている）", () => {
  const a = advanceSimulationTurns({ session: newSession(4, "seed-A"), turns: 4, timestamp: TS });
  const b = advanceSimulationTurns({ session: newSession(4, "seed-B"), turns: 4, timestamp: TS });
  const rev = (s: typeof a) => (s.state.history.at(-1)?.financialResults ?? []).map((f) => f.profitAndLoss.netRevenue);
  assert.notDeepEqual(rev(a), rev(b));
});

// ---------------------------------------------------------------------
// チャートデータ
// ---------------------------------------------------------------------

test("CONSOLE-10: Revenue / Operating Profit の32Qチャートデータが5社分そろう", () => {
  const s = advanceSimulationTurns({ session: newSession(32), turns: 32, timestamp: TS });
  const series = buildCompanySeries(s.state.history, s.fixtures);
  assert.equal(series.length, 5, "5社分のシリーズになっていない");
  for (const cs of series) {
    assert.equal(cs.points.length, 32, `${cs.companyId} が32点でない`);
    assert.equal(cs.color, COMPANY_COLORS[cs.companyId], "会社ごとの固定色が使われていない");
    assert.ok(cs.points.every((p) => p.revenue !== null), `${cs.companyId} の売上に欠損がある`);
    assert.ok(cs.points.every((p) => p.operatingProfit !== null), `${cs.companyId} の営業利益に欠損がある`);
  }
});

test("CONSOLE-11: Company Inspector が最新ターンの状態を返す（会社切替で計算をやり直さない）", () => {
  const s = advanceSimulationTurns({ session: newSession(4), turns: 4, timestamp: TS });
  for (const f of s.fixtures) {
    const snap = buildCompanyInspectorSnapshot(s.state, f.companyId, s.fixtures);
    assert.ok(snap, `${f.companyId} のスナップショットが取れない`);
    assert.equal(snap!.turn, 4);
    assert.equal(snap!.companyId, f.companyId);
    assert.ok(snap!.hosoCapacity !== null && snap!.hosoCapacity > 0, "HOSO能力が取れていない");
    assert.ok(snap!.salesHeadcount !== null, "営業人数が取れていない");
  }
});

// ---------------------------------------------------------------------
// Regression: 既存の挙動を壊していないこと
// ---------------------------------------------------------------------

test("CONSOLE-12: market-aware sales allocation が維持されている（top-price 50%固定へ戻っていない）", () => {
  const s = advanceSimulationTurns({ session: newSession(3), turns: 3, timestamp: TS });
  // 旧方式は「最高価格市場へ50%固定」だった。全社の日本市場シェアが揃って50%に
  // なっていないこと、および観測機会ベースの配分diagnosticsが出ていることを確認する。
  const record = s.state.history[s.state.history.length - 1];
  const shares: number[] = [];
  for (const f of s.fixtures) {
    const plans = record.decisions.find((d) => d.companyId === f.companyId)?.salesPlans ?? [];
    const byMarket = new Map<string, number>();
    for (const p of plans) byMarket.set(String(p.market), Number(p.salesForceHeadcount ?? 0));
    const total = [...byMarket.values()].reduce((a, b) => a + b, 0);
    if (total > 0) shares.push((byMarket.get("JP") ?? 0) / total);
  }
  assert.ok(shares.length > 0, "販売計画が取れていない");
  assert.ok(
    !shares.every((v) => Math.abs(v - 0.5) < 1e-6),
    `全社の日本シェアが50%固定になっている（旧 legacy_price_rank へ戻っている）: ${shares.join(",")}`
  );
});

test("CONSOLE-13: Test16 の工場スペース設計を壊していない（MASS が HOSO 24,000t へ到達できる余地がある）", () => {
  const s = newSession(1);
  const mass = s.fixtures.find((f) => f.companyId === "MASS")!;
  const factory = mass.factories[0];
  const total = resolveFactoryTotalSpaceUnits(factory, FACTORY_SPACE_PARAMETERS_V1);
  const used = computeFactoryUsedSpaceUnits(factory, FACTORY_SPACE_PARAMETERS_V1);
  const perProject = computeCandidateProjectSpaceUnits("hosoLineExpansion");
  // 12,000 → 24,000 に必要な3回ぶんの空きがある。
  assert.ok(total - used >= perProject * 3, "HOSO増設3回ぶんのスペースが無い（Test16の設計が壊れている）");
  assert.equal(FACTORY_SPACE_PARAMETERS_V1.spaceUnitsPerCapacityTon.pd / FACTORY_SPACE_PARAMETERS_V1.spaceUnitsPerCapacityTon.hoso, 2);
  assert.equal(FACTORY_SPACE_PARAMETERS_V1.spaceUnitsPerCapacityTon.vap / FACTORY_SPACE_PARAMETERS_V1.spaceUnitsPerCapacityTon.hoso, 3);
});

test("CONSOLE-14: Management Console を通しても、手書きループで回した場合と結果が完全に一致する", () => {
  // Console は engine を呼ぶだけで意思決定へ介入しない。それを示すために、
  // 通常ゲームと同じ手順を手書きで回した履歴と、Console 経由の履歴を突き合わせる。
  //
  // 【なぜ「生のAI出力」と比べないか】記録される decisions には、エンジンが
  // 付与する項目（VAP能力スコア等）が含まれる。これはエンジン本来の処理であり
  // Console とは無関係なので、比較対象は「同じエンジンを通した結果」どうしにする。
  const seed = "no-interference-seed";
  const viaConsole = advanceSimulationTurns({ session: newSession(2, seed), turns: 2, timestamp: TS });

  const manual = newSession(2, seed);
  let state = manual.state;
  for (let t = 0; t < 2; t++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["decision"]> = {};
    for (const f of manual.fixtures) {
      decisions[f.companyId] = generateStandardAiDecisionWithDiagnostics(
        f,
        buildCompanyOwnState(state, f),
        publicInfo,
        state.currentPeriod,
        state.scenarioState.currentTurn
      ).decision;
    }
    state = advanceCompanyLabQuarter(state, manual.fixtures, decisions);
  }

  const pick = (history: typeof state.history) =>
    history.map((r) => ({
      turn: r.turn,
      decisions: r.decisions,
      financialResults: (r.financialResults ?? []).map((f) => ({
        companyId: f.companyId,
        netRevenue: f.profitAndLoss.netRevenue,
        operatingProfit: f.profitAndLoss.operatingProfit,
      })),
    }));
  assert.deepEqual(pick(viaConsole.state.history), pick(state.history), "Console 経由で結果が変わっている");
});

test("CONSOLE-15: Strategy Profile はまだ AI 判断へ接続されていない（Phase 1 の約束）", () => {
  const doc = createEmptyStrategyDocument("BAL");
  assert.equal(doc.mission, "", "Mission に自動生成された文言が入っている");
  assert.equal(doc.vision, "", "Vision に自動生成された文言が入っている");
  assert.equal(doc.schemaVersion, STRATEGY_PROFILE_SCHEMA_VERSION);
  // effectiveFromTurn で戦略履歴を持てる。
  const at1 = resolveStrategyAtTurn(doc, 1);
  assert.ok(at1);
  assert.equal(at1!.effectiveFromTurn, 1);
  assert.equal(resolveStrategyAtTurn(doc, 0), null, "有効化前のターンで戦略が返っている");
  // strategyProfile モジュールは standardAi を import していない（依存の分離）。
  const source = readFileSync(resolvePath(__dirname, "..", "..", "strategyProfile", "types.ts"), "utf8");
  const importLines = source.split("\n").filter((l) => /^\s*import\s/.test(l));
  assert.ok(
    !importLines.some((l) => /standardAi/.test(l)),
    `strategyProfile が standardAi へ依存している: ${importLines.join(" | ")}`
  );
});
