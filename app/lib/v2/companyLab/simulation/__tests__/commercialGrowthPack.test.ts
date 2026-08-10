// ShrimpX V2 — Phase 6C 完成テスト（#05 §28）
//
// 正式切替（Case B + V1 = 会社営業組織モデル v1）と、
// Vision → Ambition → Commitment → Contracts → Production の因果が
// 画面・Pack の双方から追えることを固定する。

import test from "node:test";
import assert from "node:assert/strict";

import { SALES_PARAMETERS_LEGACY_PER_MARKET, SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import {
  SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1,
  SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_WITH_FRAGMENTATION_RESEARCH,
  SALES_CAPACITY_MODEL_PER_MARKET,
} from "../../../sales/salesCapacityModel";
import { advanceSimulationTurns, createSimulationSession } from "../engine";
import { buildAiAnalysisPackContext } from "../aiPack/context";
import { buildDatasetFromSession } from "../analytics/dataset";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRun } from "../persistence/types";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS, SimulationSession } from "../types";
import { deriveNextCommercialHistoryState, commercialHistoryForCompany } from "../../commercialHistoryState";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../../persistence/snapshot";
import { validateCompanyLabRuntimeSnapshot } from "../../persistence/schema";

const TURNS = 12;
const AT = "2026-08-10T00:00:00.000Z";

function runTurns(turns: number): SimulationSession {
  const session = createSimulationSession({ simulationRunId: "phase6c-pack", scenarioId: "baseline", seed: "phase6c-pack", requestedTurns: turns, startedAt: AT });
  return advanceSimulationTurns({ session, turns, timestamp: AT });
}

function storedFrom(session: SimulationSession): StoredSimulationRun {
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset: buildDatasetFromSession(session),
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    savedAt: AT,
  };
}

const session = runTurns(TURNS);

// ---------------------------------------------------------------------
// P6C-1 正式切替（production default）
// ---------------------------------------------------------------------

test("P6C-1: Test16 の既定営業能力モデルは会社営業組織モデル v1（Case B + V1）である", () => {
  assert.equal(SALES_PARAMETERS_V1.salesCapacityModel, SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1);
  assert.equal(SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1.kind, "companyWide");
  assert.equal(SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1.companyBaselineCapacityTons, 1_000);
  assert.equal(SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1.companyCapacityMaxIncrementTons, 95_000);
  assert.equal(SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1.companyCapacitySaturationHeadcount, 190);
  assert.equal(SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1.fragmentationPenaltyPerExtraMarket, 0);
  // 営業工数係数は切替で変更していない。
  assert.deepEqual(SALES_PARAMETERS_V1.salesEffortCoefficients, { hoso: 1.0, pd: 1.2, vap: 3.0 });
});

test("P6C-1b: 研究候補（Case C 相当）は残っているが production default ではない", () => {
  assert.equal(SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_WITH_FRAGMENTATION_RESEARCH.kind, "companyWideWithFragmentation");
  assert.notEqual(SALES_PARAMETERS_V1.salesCapacityModel, SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_WITH_FRAGMENTATION_RESEARCH);
  // legacy も明示的に残っている（後方互換・比較対照）。
  assert.equal(SALES_PARAMETERS_LEGACY_PER_MARKET.salesCapacityModel, SALES_CAPACITY_MODEL_PER_MARKET);
});

// ---------------------------------------------------------------------
// P6C-2 因果が「別々の量」として記録されている
// ---------------------------------------------------------------------

test("P6C-2: Ambition ≠ Commitment ≠ Submitted ≠ Contracts ≠ Production が記録される", () => {
  const captures = session.packCompanyTurns.filter((c) => c.turn === TURNS);
  assert.equal(captures.length, 5);
  for (const c of captures) {
    const g = c.commercialGrowth;
    assert.equal(g.availability, "AVAILABLE", `${c.companyId}: 商業成長が記録されている`);
    assert.ok(g.commercialAmbitionTons !== null, "売りたい量が記録されている");
    assert.ok(g.commercialCommitmentTons !== null, "取りに行く量が記録されている");
    assert.ok(g.submittedSalesTons > 0, "市場へ提示した量が記録されている");
    assert.ok(g.contractedSalesTons > 0, "成約量が記録されている");
    assert.ok(g.actualProductionTons > 0, "生産量が記録されている");
    // 成約は提出を超えない。
    assert.ok(g.contractedSalesTons <= g.submittedSalesTons + 1, `${c.companyId}: 成約が提出を超えていない`);
  }
  // 5社のうち少なくとも1社で、提出と成約が別の値になっている（同一値へ潰れていない）。
  assert.ok(captures.some((c) => Math.abs(c.commercialGrowth.submittedSalesTons - c.commercialGrowth.contractedSalesTons) > 1));
});

test("P6C-3: 未成約の販売計画には期待成約率が実際に掛かっている（提出量をそのまま作らない）", () => {
  // 【この検証の形について】
  // 「生産量が成約量に近い」という結果だけを見る検証は、受注残・在庫目標の
  // 大きい四半期では成立しない（生産には確定した受注残も入るため）。
  // ここでは仕組みそのもの——観測成約率が1未満のとき、生産の見積りに
  // 実際に1未満の率が使われていること——を固定する。
  // 32Q走破後の結果水準は commercialCommitmentIntegration.test.ts の CCI-6 が担保する。
  let checked = 0;
  for (const c of session.packCompanyTurns) {
    const g = c.commercialGrowth;
    if (g.observedConversionRatio === null) continue;
    checked += 1;
    if (g.observedConversionRatio < 0.95) {
      assert.ok(
        (g.productionExpectedConversionRatio ?? 1) < 1,
        `${c.companyId} turn${c.turn}: 観測成約率 ${(g.observedConversionRatio * 100).toFixed(0)}% なのに生産の見積りが100%のまま`
      );
    }
    // 生産の見積り率は観測値そのもの（下限で打ち切り）であり、目標帯へ寄せた
    // 提出用の率とは別の値である。
    assert.ok((g.productionExpectedConversionRatio ?? 1) <= 1 + 1e-9);
  }
  assert.ok(checked > 0, "観測成約率が記録された四半期が存在する（テストの前提）");
});

// ---------------------------------------------------------------------
// P6C-4 営業組織（理由の無い採用0を作らない）
// ---------------------------------------------------------------------

test("P6C-4: 採用0の四半期には必ず理由コードが入る", () => {
  let zero = 0;
  for (const c of session.packCompanyTurns) {
    const s = c.salesOrganization;
    assert.equal(s.availability, "AVAILABLE");
    if (s.actualHireCount > 0) {
      assert.equal(s.constraintReason, null, `${c.companyId} turn${c.turn}: 採用した四半期に「増やさなかった理由」は入らない`);
      continue;
    }
    zero += 1;
    assert.ok(s.constraintReason, `${c.companyId} turn${c.turn}: 採用0なのに理由が無い`);
  }
  assert.ok(zero > 0, "採用0の四半期が存在する（テスト自体の前提）");
});

test("P6C-5: 「人が足りない」と「増やしたくない」が別々の数値として区別できる", () => {
  for (const c of session.packCompanyTurns.filter((x) => x.turn === TURNS)) {
    const s = c.salesOrganization;
    assert.ok(s.requiredHeadcount !== null && s.requiredHeadcount >= 0);
    assert.ok(s.unconstrainedEconomicDesiredHeadcount !== null);
    assert.ok(s.organizationallyAllowedHeadcount !== null);
    assert.ok(s.financiallyAllowedHeadcount !== null);
    // 組織上の上限は現在人数以上（減らす方向には効かない）。
    assert.ok((s.organizationallyAllowedHeadcount ?? 0) >= s.currentHeadcount);
  }
});

// ---------------------------------------------------------------------
// P6C-6 Pack（完全 / 途中）と後方互換
// ---------------------------------------------------------------------

test("P6C-6: AI Analysis Pack の context に commercialGrowth / salesOrganization が入る", () => {
  const context = buildAiAnalysisPackContext({ stored: storedFrom(session), exportedAt: AT });
  const company = Object.values(context.companies)[0];
  assert.ok(company.turns.length > 0);
  for (const t of company.turns) {
    assert.ok(t.commercialGrowth, "commercialGrowth が存在する");
    assert.ok(t.salesOrganization, "salesOrganization が存在する");
  }
  const last = company.turns[company.turns.length - 1];
  assert.equal(last.commercialGrowth.availability, "AVAILABLE");
  assert.ok(last.commercialGrowth.commercialCommitmentTons !== null);
  assert.ok(last.salesOrganization.requiredHeadcount !== null);
});

test("P6C-7: 途中export（partial run）でも完了ターンぶんだけが入り、ゼロ埋めしない", () => {
  const partial = runTurns(4);
  const context = buildAiAnalysisPackContext({ stored: storedFrom(partial), exportedAt: AT });
  const company = Object.values(context.companies)[0];
  assert.equal(company.turns.length, 4);
  assert.ok(company.turns.every((t) => t.commercialGrowth.availability === "AVAILABLE"));
  assert.ok(MANAGEMENT_CONSOLE_STANDARD_TURNS > 4, "32Q 標準に対して途中である（テストの前提）");
});

// ---------------------------------------------------------------------
// P6C-8 転換率の学習と永続化（Console と API が同じ結果になること）
// ---------------------------------------------------------------------

test("P6C-8: 転換率の履歴はラボ状態として持ち越され、スナップショット往復で失われない", () => {
  const state = session.state;
  assert.ok(state.commercialHistoryState, "履歴 carry state が存在する");
  const before = commercialHistoryForCompany(state.commercialHistoryState, "BAL");
  assert.ok(before.length > 0, "自社の提出履歴が蓄積されている");

  const snapshot = createCompanyLabRuntimeSnapshot(state);
  const validated = validateCompanyLabRuntimeSnapshot(JSON.parse(JSON.stringify(snapshot)), "snapshot");
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(state.config, validated);
  const after = commercialHistoryForCompany(restored.commercialHistoryState, "BAL");
  assert.deepEqual(
    after.map((r) => [r.turn, r.submittedTotalTons]),
    before.map((r) => [r.turn, r.submittedTotalTons]),
    "永続化往復で提出履歴が保存される（API 経路でも Console と同じ学習になる）"
  );
});

test("P6C-9: 履歴を持たない旧スナップショットからでも壊れない（移行互換）", () => {
  const snapshot = JSON.parse(JSON.stringify(createCompanyLabRuntimeSnapshot(session.state))) as Record<string, unknown>;
  delete snapshot.commercialHistoryState;
  const validated = validateCompanyLabRuntimeSnapshot(snapshot, "snapshot");
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(session.state.config, validated);
  assert.equal(restored.commercialHistoryState, undefined);
  assert.deepEqual(commercialHistoryForCompany(restored.commercialHistoryState, "BAL"), []);
});

test("P6C-10: 転換率の履歴は決定論的・冪等（同一ターンの再処理で二重追記しない）", () => {
  const decisions = session.state.history[0].decisions;
  const period = session.state.history[0].period;
  const first = deriveNextCommercialHistoryState(undefined, decisions, period, 1);
  const twice = deriveNextCommercialHistoryState(first, decisions, period, 1);
  assert.deepEqual(twice, first);
});

// ---------------------------------------------------------------------
// P6C-11 AI Trace（既存を壊さない拡張）
// ---------------------------------------------------------------------

test("P6C-11: AI Trace の6段階は維持され、WANTED に Vision→Ambition→Commitment→営業組織が入る", () => {
  const dataset = buildDatasetFromSession(session);
  const stages = [...new Set(dataset.aiTrace.map((t) => t.stage))];
  for (const required of ["OBSERVED", "DIAGNOSED", "WANTED", "CONSTRAINED", "DECIDED", "RESULT"]) {
    assert.ok(stages.includes(required as never), `既存の段階 ${required} が維持されている`);
  }
  const wanted = dataset.aiTrace.filter((t) => t.stage === "WANTED" && t.turn === TURNS);
  assert.ok(wanted.length > 0);
  const labels = wanted.flatMap((t) => t.items.map((i) => i.label));
  assert.ok(labels.some((l) => l.includes("Commercial Ambition")), "売りたい量が Trace に出る");
  assert.ok(labels.some((l) => l.includes("Commercial Commitment")), "取りに行く量が Trace に出る");
  assert.ok(labels.some((l) => l.includes("営業 必要人数")), "営業組織が Trace に出る");
  assert.ok(labels.some((l) => l.includes("販売希望量")), "既存項目が消えていない");
});

// ---------------------------------------------------------------------
// P6C-12 決定論
// ---------------------------------------------------------------------

test("P6C-12: 同一 seed で 12Q を2回回すと商業成長の記録が完全に一致する", () => {
  const again = runTurns(TURNS);
  assert.deepEqual(
    again.packCompanyTurns.map((c) => [c.turn, c.companyId, c.commercialGrowth, c.salesOrganization]),
    session.packCompanyTurns.map((c) => [c.turn, c.companyId, c.commercialGrowth, c.salesOrganization])
  );
});
