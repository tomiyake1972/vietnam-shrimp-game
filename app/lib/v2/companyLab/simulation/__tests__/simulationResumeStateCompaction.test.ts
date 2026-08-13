// ShrimpX V2 — Management Console Resume Snapshot Phase 2: state compaction のテスト
//
// 【このテスト群が守る因果】
// resumePayloadから「履行済み／キャンセル済みの古い契約」「完全消費済み・期限切れの
// 原料ロット」「完全充当済み・期限切れの完成品ロット」「productionState.history」を
// 除去しても（resume.ts参照、consumer audit根拠つき）、continuous run（一度もreloadしない）
// と reload run（途中でresumePayload経由の復元を挟む）で、gameplay-relevant な結果
// （cash・debt・production・backlog・Standard AIの意思決定）が一致すること。
// 一致しなければ、consumer auditの見落としが実際に挙動を変えてしまったことを意味する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurns, createSimulationSession } from "../engine";
import { buildResumePayload, restoreSessionFromResumePayload } from "../persistence/resume";
import { SimulationSession } from "../types";

const AT = "2026-01-01T00:00:00.000Z";
const SCENARIO_ID = "baseline";
const SEED = "state-compaction-test";

function continuousRun(totalTurns: number): SimulationSession {
  const session = createSimulationSession({ simulationRunId: "continuous", scenarioId: SCENARIO_ID, seed: SEED, requestedTurns: 32, startedAt: AT });
  return advanceSimulationTurns({ session, turns: totalTurns, timestamp: AT });
}

/** reloadPoints で刻んだTurnごとに resumePayload を経由して復元し直しながら進める。 */
function reloadingRun(totalTurns: number, reloadPoints: readonly number[]): SimulationSession {
  let session = createSimulationSession({ simulationRunId: "continuous", scenarioId: SCENARIO_ID, seed: SEED, requestedTurns: 32, startedAt: AT });
  let doneUpTo = 0;
  for (const point of [...reloadPoints, totalTurns]) {
    const turnsToRun = point - doneUpTo;
    if (turnsToRun <= 0) continue;
    session = advanceSimulationTurns({ session, turns: turnsToRun, timestamp: AT });
    doneUpTo = point;
    if (doneUpTo >= totalTurns) break;
    const payload = buildResumePayload(session, {}, {});
    const roundTripped = JSON.parse(JSON.stringify(payload));
    session = restoreSessionFromResumePayload(session.run, roundTripped, { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns });
  }
  return session;
}

/**
 * 会社別のgameplay-relevantな要約値（受注・履行・延滞・原料在庫・生産・完成品在庫）
 * ＋会社別の現金・借入・売掛金（state.financeState/financingStateから直接）。
 * CompanyQuarterSummaryはfinance summaryを持たないため、財務はstateから直接取る。
 */
function summarize(session: SimulationSession) {
  const record = session.state.history[session.state.history.length - 1];
  const companyRows = [...record.companySummaries]
    .sort((a, b) => a.companyId.localeCompare(b.companyId))
    .map((c) => ({
      companyId: c.companyId,
      newContractedQuantity: c.newContractedQuantity,
      fulfilledQuantity: c.fulfilledQuantity,
      outstandingQuantity: c.outstandingQuantity,
      overdueQuantity: c.overdueQuantity,
      rawMaterialInventory: c.rawMaterialInventory,
      hosoProduced: c.hosoProduced,
      pdProduced: c.pdProduced,
      vapProduced: c.vapProduced,
      finishedGoodsInventory: c.finishedGoodsInventory,
    }));
  return {
    turn: record.turn,
    period: record.period,
    companies: companyRows,
    financeState: session.state.financeState,
    financingState: session.state.financingState,
    capexState: session.state.capexState,
    workforceState: session.state.workforceState,
  };
}

// PERSIST-B-COMPACT-1: continuous run と reload run（Turn16で1回reload）で、Turn24時点の
// gameplay-relevant要約が完全一致する（今回のcontracts/rawMaterialLots/productionState
// compactionが、次Turn以降の計算結果へ一切影響しないことの直接証拠）。
test("PERSIST-B-COMPACT-1: continuous run と Turn16でreloadしたrunで、Turn24のgameplay-relevant結果が一致する", () => {
  const continuous = continuousRun(24);
  const reloaded = reloadingRun(24, [16]);
  assert.deepEqual(summarize(reloaded), summarize(continuous));
});

// PERSIST-B-COMPACT-2: 複数回reload（Turn8, Turn16, Turn24）でもTurn32結果が継続runと一致する。
test("PERSIST-B-COMPACT-2: Turn8/16/24で複数回reloadしても、Turn32のgameplay-relevant結果が継続runと一致する", () => {
  const continuous = continuousRun(32);
  const reloaded = reloadingRun(32, [8, 16, 24]);
  assert.deepEqual(summarize(reloaded), summarize(continuous));
});

// PERSIST-B-COMPACT-3: compaction後もresumePayload.state.contractsには、未履行の契約
// （backlog・overdueの根拠）が必ず残っている（消えていない）。
test("PERSIST-B-COMPACT-3: 未履行契約（open/partiallyFulfilled/overdue）はcompaction後も必ず残る", () => {
  const session = continuousRun(24);
  const payload = buildResumePayload(session, {}, {});
  const liveUnresolvedIds = new Set(
    session.state.contracts.filter((c) => c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue").map((c) => c.contractId)
  );
  const resumeContractIds = new Set(payload.state.contracts.map((c) => c.contractId));
  for (const id of liveUnresolvedIds) {
    assert.ok(resumeContractIds.has(id), `未履行契約 ${id} がresumePayloadから消えている`);
  }
});

// PERSIST-B-COMPACT-4: compaction後もresumePayload.state.rawMaterialLotsには、使用可能・
// 輸送中・養殖中のロットが必ず残っている。
test("PERSIST-B-COMPACT-4: available/inTransitImport/growingAquacultureのロットはcompaction後も必ず残る", () => {
  const session = continuousRun(24);
  const payload = buildResumePayload(session, {}, {});
  const liveLiveIds = new Set(
    session.state.rawMaterialLots
      .filter((l) => l.status === "available" || l.status === "inTransitImport" || l.status === "growingAquaculture")
      .map((l) => l.lotId)
  );
  const resumeLotIds = new Set(payload.state.rawMaterialLots.map((l) => l.lotId));
  for (const id of liveLiveIds) {
    assert.ok(resumeLotIds.has(id), `使用可能ロット ${id} がresumePayloadから消えている`);
  }
});

// PERSIST-B-COMPACT-5: productionState.historyはresumePayloadで常に空配列（既存の
// company-lab本体snapshot.tsと同じ前提・同じ挙動）。
test("PERSIST-B-COMPACT-5: resumePayload.state.productionState.historyは常に空配列", () => {
  const session = continuousRun(16);
  const payload = buildResumePayload(session, {}, {});
  assert.deepEqual(payload.state.productionState.history, []);
  assert.ok(session.state.productionState.history.length > 0, "テスト前提が崩れている（本来ならhistoryが貯まっているはず）");
});

// PERSIST-B-COMPACT-6: サイズが実際に縮小し、かつQ8以降ほぼ横ばい（無制限増大しない）。
test("PERSIST-B-COMPACT-6: resumePayloadサイズはQ8以降ほぼ横ばいで、Q32でも安全マージンを持つ", () => {
  let session = createSimulationSession({ simulationRunId: "size-check", scenarioId: SCENARIO_ID, seed: SEED, requestedTurns: 32, startedAt: AT });
  const sizes: Record<number, number> = {};
  for (let t = 1; t <= 32; t++) {
    session = advanceSimulationTurns({ session, turns: 1, timestamp: AT });
    if (![8, 16, 22, 24, 32].includes(t)) continue;
    const payload = buildResumePayload(session, {}, {});
    sizes[t] = Buffer.byteLength(JSON.stringify(payload));
  }
  const VERCEL_LIMIT = 4.5 * 1024 * 1024;
  assert.ok(sizes[32] < VERCEL_LIMIT * 0.75, `Turn32のresumePayloadが${sizes[32]}bytesあり、安全マージン（上限の75%）を超えている`);
  // Q8→Q32で growth ratio が2倍未満（指示§29「Q16→Q32でほぼ倍増する構造は避ける」）。
  const growthRatio = sizes[32] / sizes[8];
  assert.ok(growthRatio < 1.5, `Turn8→Turn32でresumePayloadサイズが${growthRatio.toFixed(2)}倍に増えている（ほぼ横ばいであるべき）`);
});
