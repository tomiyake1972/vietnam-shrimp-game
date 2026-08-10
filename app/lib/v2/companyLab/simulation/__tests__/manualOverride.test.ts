// ShrimpX V2 — 32Q Management Console: PLAYER / STANDARD_AI 経営モード切替（Phase 7・Manual Override）
//
// 【エンジン側の変更点】advanceSimulationTurn(session, completedAt, playerDecisions?) が
// 会社ごとの意思決定を Standard AI ではなくプレイヤー入力（CompanyDecisionInput）へ
// 差し替えられるようにした。UI（1/4/32 Turnsボタン）側の「PLAYER未確定なら進めない」判断は
// ManagementConsole.tsx が行うため、ここではエンジン本体の契約（引数を渡せば実際に
// 使われる／渡さなければ従来どおりStandard AIのまま／会社ごとにdecisionOwnerが記録される）
// だけを検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurn, createSimulationSession } from "../engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecision } from "../../standardAi/policy";
import { CompanyDecisionInput } from "../../types";
import { unwrapUnit } from "../../../core/units";

const TS = "2026-08-09T00:00:00.000Z";

function newSession(seed = "manual-override-test-seed") {
  return createSimulationSession({
    simulationRunId: "run-manual-override-test",
    scenarioId: "baseline",
    seed,
    requestedTurns: 8,
    startedAt: TS,
  });
}

/** そのターン時点でのAI決定をそのまま複製し、salesPlansだけ空にした「明らかに違う」プレイヤー決定を作る。 */
function buildZeroSalesPlayerDecision(session: ReturnType<typeof newSession>, companyId: string): CompanyDecisionInput {
  const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
  const publicInfo = buildPublicMarketInfo(session.state);
  const ownState = buildCompanyOwnState(session.state, fixture);
  const turn = session.state.scenarioState.currentTurn;
  const aiDecision = generateStandardAiDecision(fixture, ownState, publicInfo, session.state.currentPeriod, turn);
  return { ...aiDecision, salesPlans: [] };
}

// ---------------------------------------------------------------------
// A/D: playerDecisions を渡さなければ、従来どおり全社 STANDARD_AI のまま
// ---------------------------------------------------------------------

test("MANUAL-A: playerDecisions省略なら全社decisionOwnerがSTANDARD_AI（既定挙動を壊さない）", () => {
  const s0 = newSession();
  const outcome = advanceSimulationTurn(s0, TS);
  assert.ok(outcome.advanced);
  const owners = outcome.session.packCompanyTurns.filter((t) => t.turn === 1).map((t) => t.decisionOwner);
  assert.equal(owners.length, 5);
  assert.ok(owners.every((o) => o === "STANDARD_AI"));
});

test("MANUAL-D: playerDecisionsを空オブジェクトで渡しても全社STANDARD_AIのまま", () => {
  const s0 = newSession();
  const outcome = advanceSimulationTurn(s0, TS, {});
  assert.ok(outcome.advanced);
  const owners = outcome.session.packCompanyTurns.filter((t) => t.turn === 1).map((t) => t.decisionOwner);
  assert.ok(owners.every((o) => o === "STANDARD_AI"));
});

// ---------------------------------------------------------------------
// F/Q: PLAYER の意思決定が実際にエンジンへ入り、decisionOwnerに記録される
// ---------------------------------------------------------------------

test("MANUAL-F/Q: BALをPLAYERの意思決定（販売0件）にすると、その通り成約0になり、decisionOwnerがPLAYERで記録される", () => {
  const s0 = newSession();
  const zeroSales = buildZeroSalesPlayerDecision(s0, "BAL");
  const outcome = advanceSimulationTurn(s0, TS, { BAL: zeroSales });
  assert.ok(outcome.advanced);

  const balSummary = outcome.session.state.history[0].companySummaries.find((c) => c.companyId === "BAL");
  assert.ok(balSummary);
  assert.equal(unwrapUnit(balSummary!.newContractedQuantity), 0, "販売計画0のプレイヤー決定を使ったのに成約が発生している");

  const balTurn = outcome.session.packCompanyTurns.find((t) => t.turn === 1 && t.companyId === "BAL");
  assert.equal(balTurn?.decisionOwner, "PLAYER");
});

// ---------------------------------------------------------------------
// G: 同一Turn内でAI4社＋PLAYER1社が混在して実行できる
// ---------------------------------------------------------------------

test("MANUAL-G: 同一Turn内で1社PLAYER・4社STANDARD_AIが混在し、それぞれ正しくdecisionOwnerが分かれる", () => {
  const s0 = newSession();
  const zeroSales = buildZeroSalesPlayerDecision(s0, "BAL");
  const outcome = advanceSimulationTurn(s0, TS, { BAL: zeroSales });
  assert.ok(outcome.advanced);

  const turn1 = outcome.session.packCompanyTurns.filter((t) => t.turn === 1);
  assert.equal(turn1.length, 5);
  assert.equal(turn1.find((t) => t.companyId === "BAL")?.decisionOwner, "PLAYER");
  for (const companyId of ["MASS", "JPQ", "VAP", "CONSV"]) {
    assert.equal(turn1.find((t) => t.companyId === companyId)?.decisionOwner, "STANDARD_AI", `${companyId} はAIのままのはず`);
  }
});

// ---------------------------------------------------------------------
// H: 複数社PLAYERでも動く
// ---------------------------------------------------------------------

test("MANUAL-H: BAL・MASSの2社を同時にPLAYERにしても、それぞれ独立に反映される", () => {
  const s0 = newSession();
  const balZero = buildZeroSalesPlayerDecision(s0, "BAL");
  const massZero = buildZeroSalesPlayerDecision(s0, "MASS");
  const outcome = advanceSimulationTurn(s0, TS, { BAL: balZero, MASS: massZero });
  assert.ok(outcome.advanced);

  const balSummary = outcome.session.state.history[0].companySummaries.find((c) => c.companyId === "BAL");
  const massSummary = outcome.session.state.history[0].companySummaries.find((c) => c.companyId === "MASS");
  assert.equal(unwrapUnit(balSummary!.newContractedQuantity), 0);
  assert.equal(unwrapUnit(massSummary!.newContractedQuantity), 0);

  const turn1 = outcome.session.packCompanyTurns.filter((t) => t.turn === 1);
  assert.equal(turn1.find((t) => t.companyId === "BAL")?.decisionOwner, "PLAYER");
  assert.equal(turn1.find((t) => t.companyId === "MASS")?.decisionOwner, "PLAYER");
  for (const companyId of ["JPQ", "VAP", "CONSV"]) {
    assert.equal(turn1.find((t) => t.companyId === companyId)?.decisionOwner, "STANDARD_AI");
  }
});

// ---------------------------------------------------------------------
// I/J: AI→PLAYER→AI の途中切替でも会社状態は初期化されない（同じsessionを進めるだけ）
// ---------------------------------------------------------------------

test("MANUAL-I/J: Turn1=AI, Turn2=PLAYER, Turn3=AIと切り替えても、cashが前ターンから連続して引き継がれる（再初期化されない）", () => {
  let session = newSession();

  const turn1 = advanceSimulationTurn(session, TS);
  assert.ok(turn1.advanced);
  session = turn1.session;
  const cashAfterTurn1 = session.state.history[0].financialResults.find((f) => f.companyId === "BAL")!.balanceSheet.cash;

  const balZero = buildZeroSalesPlayerDecision(session, "BAL");
  const turn2 = advanceSimulationTurn(session, TS, { BAL: balZero });
  assert.ok(turn2.advanced);
  session = turn2.session;
  const cashAfterTurn2 = session.state.history[1].financialResults.find((f) => f.companyId === "BAL")!.balanceSheet.cash;
  // 販売0なので売上は立たないが、会社状態（現金）は前ターンの実績の上に積み上がる連続値であり、
  // 0や初期値へ巻き戻っていないことを確認する（＝会社状態を初期化していない）。
  assert.notEqual(unwrapUnit(cashAfterTurn2 as never), unwrapUnit(cashAfterTurn1 as never));

  const turn3 = advanceSimulationTurn(session, TS);
  assert.ok(turn3.advanced);
  session = turn3.session;
  const turn3Owner = session.packCompanyTurns.find((t) => t.turn === 3 && t.companyId === "BAL")?.decisionOwner;
  assert.equal(turn3Owner, "STANDARD_AI", "Turn3はAIへ戻したのでSTANDARD_AIのはず");
  assert.equal(session.state.history.length, 3, "3ターンとも連続した同じsessionの履歴として積み上がっている");
});

// ---------------------------------------------------------------------
// K: 決定論（同じ入力なら同じ結果）
// ---------------------------------------------------------------------

test("MANUAL-K: 同じseed・同じplayerDecisionsなら、2回実行しても同じ結果になる", () => {
  const runOnce = () => {
    const s0 = newSession();
    const zeroSales = buildZeroSalesPlayerDecision(s0, "BAL");
    return advanceSimulationTurn(s0, TS, { BAL: zeroSales }).session;
  };
  const a = runOnce();
  const b = runOnce();
  assert.deepEqual(
    a.state.history[0].companySummaries.map((c) => unwrapUnit(c.newContractedQuantity)),
    b.state.history[0].companySummaries.map((c) => unwrapUnit(c.newContractedQuantity))
  );
  assert.deepEqual(
    a.packCompanyTurns.map((t) => t.decisionOwner),
    b.packCompanyTurns.map((t) => t.decisionOwner)
  );
});
