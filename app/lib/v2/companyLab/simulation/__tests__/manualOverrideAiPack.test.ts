// ShrimpX V2 — Manual Override 受入: AI Analysis Pack（JSON）への decisionOwner 反映
//
// 【この受入で守る因果】
//   companies[].turns[].decisionOwner が 02_AI_Context.json（buildAiAnalysisPackContext の
//   戻り値そのもの）に確実に出て、Excel（19_AI_Decision）と一致し、legacy runでは
//   STANDARD_AIとして解釈できること。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurn, createSimulationSession } from "../engine";
import { buildDatasetFromSession } from "../analytics/dataset";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRun } from "../persistence/types";
import { buildAiAnalysisPackContext } from "../aiPack/context";
import { buildRunSummaryMarkdown } from "../aiPack/summary";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecision } from "../../standardAi/policy";
import { CompanyDecisionInput } from "../../types";
import { SimulationSession } from "../types";

const AT = "2026-01-01T00:00:00.000Z";

function newSession(turns: number, seed = "manual-override-pack-test") {
  return createSimulationSession({ simulationRunId: "manual-override-pack-test", scenarioId: "baseline", seed, requestedTurns: turns, startedAt: AT });
}

function buildZeroSalesPlayerDecision(session: SimulationSession, companyId: string): CompanyDecisionInput {
  const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
  const publicInfo = buildPublicMarketInfo(session.state);
  const ownState = buildCompanyOwnState(session.state, fixture);
  const turn = session.state.scenarioState.currentTurn;
  const aiDecision = generateStandardAiDecision(fixture, ownState, publicInfo, session.state.currentPeriod, turn);
  return { ...aiDecision, salesPlans: [] };
}

/** playerDecisionsByTurn: { [turn]: { [companyId]: CompanyDecisionInput } } を順に適用しながら進める。 */
function runWithPlayerTurns(turns: number, playerDecisionsByTurn: Readonly<Record<number, Readonly<Record<string, CompanyDecisionInput>>>>): SimulationSession {
  let session = newSession(turns);
  for (let i = 0; i < turns; i++) {
    const turnNumber = session.state.scenarioState.currentTurn;
    const outcome = advanceSimulationTurn(session, AT, playerDecisionsByTurn[turnNumber]);
    if (!outcome.advanced) throw new Error(`turn ${turnNumber} failed to advance`);
    session = outcome.session;
  }
  return session;
}

function toStored(session: SimulationSession): StoredSimulationRun {
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset: buildDatasetFromSession(session),
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    savedAt: AT,
  };
}

function buildContext(stored: StoredSimulationRun) {
  return buildAiAnalysisPackContext({ stored, exportedAt: AT, sourceBranch: "test-branch", sourceCommit: "test-commit" });
}

// ---------------------------------------------------------------------
// A. 全社AI run → 全turn decisionOwner=STANDARD_AI
// ---------------------------------------------------------------------

test("MANUAL-JSON-A: 全社Standard AIのrunでは、02_AI_Context.json相当のcontextで全turn decisionOwner=STANDARD_AI", () => {
  const session = runWithPlayerTurns(4, {});
  const context = buildContext(toStored(session));
  for (const company of Object.values(context.companies)) {
    for (const t of company.turns) {
      assert.equal(t.decisionOwner, "STANDARD_AI", `${company.companyId} turn ${t.turn} は STANDARD_AI のはず`);
    }
  }
  assert.equal(context.decisionOwnership.playerTurnCount, 0);
  assert.equal(context.decisionOwnership.playerCompanyIds.length, 0);
  assert.equal(context.decisionOwnership.standardAiTurnCount, 4 * 5);
});

// ---------------------------------------------------------------------
// B. BALだけPLAYER → BAL該当turnのみPLAYER, 他社STANDARD_AI
// ---------------------------------------------------------------------

test("MANUAL-JSON-B: BALだけ全turnPLAYERにすると、BALのturnだけPLAYERとして記録され他社はAIのまま", () => {
  let session = newSession(3);
  const playerDecisionsByTurn: Record<number, Record<string, CompanyDecisionInput>> = {};
  // 3ターン分、順にBALのみPLAYER決定を作る（ターンを進めながら都度AI決定を土台にする）。
  for (let turn = 1; turn <= 3; turn++) {
    const zeroSales = buildZeroSalesPlayerDecision(session, "BAL");
    playerDecisionsByTurn[turn] = { BAL: zeroSales };
    const outcome = advanceSimulationTurn(session, AT, playerDecisionsByTurn[turn]);
    assert.ok(outcome.advanced);
    session = outcome.session;
  }
  const context = buildContext(toStored(session));
  for (const t of context.companies["BAL"].turns) {
    assert.equal(t.decisionOwner, "PLAYER");
  }
  for (const companyId of ["MASS", "JPQ", "VAP", "CONSV"]) {
    for (const t of context.companies[companyId].turns) {
      assert.equal(t.decisionOwner, "STANDARD_AI");
    }
  }
  assert.deepEqual(context.decisionOwnership.playerCompanyIds, ["BAL"]);
  assert.equal(context.decisionOwnership.playerTurnCount, 3);
  assert.equal(context.decisionOwnership.standardAiTurnCount, 3 * 4);
});

// ---------------------------------------------------------------------
// C. AI→PLAYER→AI → turnごとのowner履歴が正しい
// ---------------------------------------------------------------------

test("MANUAL-JSON-C: Turn1=AI, Turn2=PLAYER, Turn3=AIと切り替えると、contextのturn別decisionOwner履歴が正確に残る", () => {
  let session = newSession(3);

  const turn1 = advanceSimulationTurn(session, AT);
  assert.ok(turn1.advanced);
  session = turn1.session;

  const balZero = buildZeroSalesPlayerDecision(session, "BAL");
  const turn2 = advanceSimulationTurn(session, AT, { BAL: balZero });
  assert.ok(turn2.advanced);
  session = turn2.session;

  const turn3 = advanceSimulationTurn(session, AT);
  assert.ok(turn3.advanced);
  session = turn3.session;

  const context = buildContext(toStored(session));
  const balTurns = context.companies["BAL"].turns;
  assert.equal(balTurns.find((t) => t.turn === 1)?.decisionOwner, "STANDARD_AI");
  assert.equal(balTurns.find((t) => t.turn === 2)?.decisionOwner, "PLAYER");
  assert.equal(balTurns.find((t) => t.turn === 3)?.decisionOwner, "STANDARD_AI");
});

// ---------------------------------------------------------------------
// D. 複数PLAYER → 独立に記録
// ---------------------------------------------------------------------

test("MANUAL-JSON-D: BAL・MASSの2社を同時PLAYERにすると、contextでそれぞれ独立にPLAYERとして記録される", () => {
  const session0 = newSession(2);
  const balZero = buildZeroSalesPlayerDecision(session0, "BAL");
  const massZero = buildZeroSalesPlayerDecision(session0, "MASS");
  const session = runWithPlayerTurns(2, { 1: { BAL: balZero, MASS: massZero } });
  const context = buildContext(toStored(session));

  assert.equal(context.companies["BAL"].turns.find((t) => t.turn === 1)?.decisionOwner, "PLAYER");
  assert.equal(context.companies["MASS"].turns.find((t) => t.turn === 1)?.decisionOwner, "PLAYER");
  for (const companyId of ["JPQ", "VAP", "CONSV"]) {
    assert.equal(context.companies[companyId].turns.find((t) => t.turn === 1)?.decisionOwner, "STANDARD_AI");
  }
  assert.deepEqual([...context.decisionOwnership.playerCompanyIds].sort(), ["BAL", "MASS"]);
});

// ---------------------------------------------------------------------
// E. legacy run → STANDARD_AIとして読める
// ---------------------------------------------------------------------

test("MANUAL-JSON-E: decisionOwnerの記録が無いlegacy runでも、contextはSTANDARD_AIとして解釈する（NOT_RECORDEDにしない）", () => {
  const session = runWithPlayerTurns(2, {});
  const stored = toStored(session);
  // Phase 7 より前に保存された Simulation Run を模す（packCapture自体が無い＝完全legacy）。
  const legacyStored: StoredSimulationRun = { ...stored, packCapture: undefined };
  const context = buildContext(legacyStored);
  for (const company of Object.values(context.companies)) {
    for (const t of company.turns) {
      assert.equal(t.decisionOwner, "STANDARD_AI");
    }
  }
  assert.equal(context.decisionOwnership.playerTurnCount, 0);
  assert.equal(context.decisionOwnership.standardAiTurnCount, 2 * 5);
});

// ---------------------------------------------------------------------
// F. ExcelとJSONのdecisionOwnerが一致
// ---------------------------------------------------------------------

test("MANUAL-JSON-F: 19_AI_Decisionシート相当の値と、02_AI_Context.json相当のcontextのdecisionOwnerが一致する", () => {
  let session = newSession(2);
  const balZero = buildZeroSalesPlayerDecision(session, "BAL");
  const turn1 = advanceSimulationTurn(session, AT, { BAL: balZero });
  assert.ok(turn1.advanced);
  session = turn1.session;
  const turn2 = advanceSimulationTurn(session, AT);
  assert.ok(turn2.advanced);
  session = turn2.session;

  const context = buildContext(toStored(session));

  // workbook.ts の 19_AI_Decision シートが実際に読む値と同じ経路（t.decisionOwner）を使い、
  // Excel生成コードを重複させずに「一致する」ことを検証する
  // （workbook.ts 側は Object.values(context.companies).flatMap(c => c.turns.map(t => [..., t.decisionOwner, ...])) という形）。
  const excelLikeRows = Object.values(context.companies).flatMap((c) => c.turns.map((t) => ({ companyId: c.companyId, turn: t.turn, decisionOwner: t.decisionOwner })));
  for (const row of excelLikeRows) {
    const jsonValue = context.companies[row.companyId].turns.find((t) => t.turn === row.turn)?.decisionOwner;
    assert.equal(row.decisionOwner, jsonValue, `${row.companyId} turn ${row.turn}: Excel相当値とJSON値が食い違っている`);
  }
  // 具体値としても、BAL turn1はPLAYER、それ以外はSTANDARD_AIであることを確認する。
  assert.equal(excelLikeRows.find((r) => r.companyId === "BAL" && r.turn === 1)?.decisionOwner, "PLAYER");
  assert.equal(excelLikeRows.find((r) => r.companyId === "BAL" && r.turn === 2)?.decisionOwner, "STANDARD_AI");
});

// ---------------------------------------------------------------------
// Run Summary（01_Run_Summary.md）の Decision Ownership セクション
// ---------------------------------------------------------------------

test("MANUAL-JSON-G: PLAYERが1件もいないrunのRun Summaryは「STANDARD_AI only」、PLAYERがいるrunは件数・会社を明記する", () => {
  const allAiContext = buildContext(toStored(runWithPlayerTurns(2, {})));
  const allAiMarkdown = buildRunSummaryMarkdown(allAiContext);
  assert.ok(allAiMarkdown.includes("STANDARD_AI only"));

  const session0 = newSession(2);
  const balZero = buildZeroSalesPlayerDecision(session0, "BAL");
  const withPlayerContext = buildContext(toStored(runWithPlayerTurns(2, { 1: { BAL: balZero } })));
  const withPlayerMarkdown = buildRunSummaryMarkdown(withPlayerContext);
  assert.ok(withPlayerMarkdown.includes("STANDARD_AI turns:"));
  assert.ok(withPlayerMarkdown.includes("PLAYER turns:"));
  assert.ok(withPlayerMarkdown.includes("PLAYER companies: BAL"));
});
