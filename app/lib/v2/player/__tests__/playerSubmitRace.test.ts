// ShrimpX V2 — O1: PLAYER提出とGM保存の競合（submit service）
//
// 【修正前に実測した事象】GMがTurnを進めた直後、UIのturn counterは進むが保存はまだ
// 終わっていない。その窓でPLAYERが次Turnを提出すると、直後に走るGMの保存が
// confirmedPlayerDecisions={} を含む resumePayload 全体を書き戻し、提出が
// storage実体から消えていた（seat記録だけが残り、GMからは「未提出」に見える）。
//
// ここでは製品と同じ呼び出し順序を明示的に並べて再現する（sleepに依存しない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurn, createSimulationSession } from "../../companyLab/simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../companyLab/standardAi/policy";
import { buildResumePayload } from "../../companyLab/simulation/persistence/resume";
import { buildDatasetFromSession } from "../../companyLab/simulation/analytics/dataset";
import { createInMemorySimulationRunRepository, SimulationRunRepository } from "../../companyLab/simulation/persistence/repository";
import { handleSaveSimulationRun, handleSaveSimulationRunPart } from "../../../../api/v2/simulation-runs/_lib/handlers";
import { submitPlayerDecision } from "../submit";
import { PlayerSubmitError } from "../types";
import type { SimulationSession } from "../../companyLab/simulation/types";
import type { CompanyDecisionInput } from "../../companyLab/types";

const AT = "2026-09-23T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;

/** seat記録（提出済み表示・Advance gateが参照する副次情報）。 */
function createSeatSpy() {
  const records: { companyId: string; turn: number }[] = [];
  return {
    records,
    repo: {
      recordSubmission: async (_runId: string, companyId: string, turn: number) => {
        records.push({ companyId, turn });
      },
    } as never,
  };
}

function newSession(runId: string, players: readonly string[]): SimulationSession {
  const modes = Object.fromEntries(COMPANIES.map((c) => [c, players.includes(c) ? "PLAYER" : "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">;
  return createSimulationSession({
    simulationRunId: runId, scenarioId: "baseline", seed: "o1", requestedTurns: 32,
    startedAt: AT, sourceCommit: "O1-TEST", companyControlModes: modes,
  });
}

function decisionFor(session: SimulationSession, companyId: string): CompanyDecisionInput {
  const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
  return generateStandardAiDecisionWithDiagnostics(
    fixture, buildCompanyOwnState(session.state, fixture), buildPublicMarketInfo(session.state),
    session.state.currentPeriod, session.state.scenarioState.currentTurn
  ).decision;
}

/**
 * GM側の保存（persistResumableRun → saveToServer）がサーバーへ出すrequest列を
 * そのまま再現する: dataset/resume/pack の3part + manifest commit。
 * expectedBaseRevision は「GMが最後に確認した公開中revision」。
 */
async function gmSave(
  repo: SimulationRunRepository,
  runId: string,
  session: SimulationSession,
  confirmed: Readonly<Record<string, CompanyDecisionInput>>,
  expectedBaseRevision: number,
  writeToken: string
): Promise<{ status: number; body: unknown }> {
  const revision = expectedBaseRevision + 1;
  const attempt = { expectedBaseRevision, writeToken };
  const resumePayload = buildResumePayload(session, session.run.companyControlModes ?? {}, confirmed);
  for (const [part, value] of [
    ["dataset", buildDatasetFromSession(session)],
    ["resume", resumePayload],
    ["pack", { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns }],
  ] as const) {
    const r = await handleSaveSimulationRunPart(repo, { simulationRunId: runId, revision, part, value, ...attempt });
    if (r.status !== 200) return r;
  }
  return handleSaveSimulationRun(repo, {
    manifestOnly: true, run: session.run, savedAt: new Date(Date.parse(AT) + revision * 1000).toISOString(),
    persistenceRevision: revision, hasResumePayload: true, hasPackCapture: true, ...attempt,
  });
}

async function confirmedKeys(repo: SimulationRunRepository, runId: string): Promise<string[]> {
  const stored = await repo.loadRun(runId);
  return Object.keys(stored?.resumePayload?.confirmedPlayerDecisions ?? {}).sort();
}

// ---------------------------------------------------------------------

test("O1-01: GM保存#1 → Player次Turn提出 → GMのstale保存、の順でもPlayerの提出が消えない", async () => {
  const repo = createInMemorySimulationRunRepository();
  const seat = createSeatSpy();
  const runId = "o1-01";
  let session = newSession(runId, ["BAL"]);

  // 初期保存（公開revision 1）。
  assert.equal((await gmSave(repo, runId, session, {}, 0, "gm-init")).status, 200);

  // Player Turn1提出。
  await submitPlayerDecision(repo, seat.repo, { runId, companyId: "BAL", claimedTurn: 1, decision: decisionFor(session, "BAL") });
  assert.deepEqual(await confirmedKeys(repo, runId), ["BAL"]);
  const afterSubmit1 = (await repo.loadRun(runId))!.persistenceRevision!;

  // GMがTurn1を実行して保存する（消費済みなのでconfirmedは空）。
  const stored = await repo.loadRun(runId);
  const pending = { ...(stored!.resumePayload!.confirmedPlayerDecisions ?? {}) } as Record<string, CompanyDecisionInput>;
  session = advanceSimulationTurn(session, AT, pending, "O1-TEST").session;
  assert.equal((await gmSave(repo, runId, session, {}, afterSubmit1, "gm-turn1")).status, 200);
  const afterGmTurn1 = (await repo.loadRun(runId))!.persistenceRevision!;

  // 【窓】PlayerがTurn2を提出する。
  await submitPlayerDecision(repo, seat.repo, { runId, companyId: "BAL", claimedTurn: 2, decision: decisionFor(session, "BAL") });
  assert.deepEqual(await confirmedKeys(repo, runId), ["BAL"], "Turn2の提出が保存されていない");

  // 【修正前はここでGMのstale保存が提出を消していた】GMは自分が最後に見たrevisionを基準にする。
  const staleSave = await gmSave(repo, runId, session, {}, afterGmTurn1, "gm-stale");
  assert.equal(staleSave.status, 409, "古い基準の保存が受理されてしまっている");
  assert.equal((staleSave.body as { error: { code: string } }).error.code, "STALE_PERSISTENCE_REVISION");

  assert.deepEqual(await confirmedKeys(repo, runId), ["BAL"], "GMのstale保存でPlayerの提出が消えた（DATA LOSS）");
});

test("O1-05: BALとMASSが同じTurnへ続けて提出しても、両方が最終resumePayloadに残る", async () => {
  const repo = createInMemorySimulationRunRepository();
  const seat = createSeatSpy();
  const runId = "o1-05";
  const session = newSession(runId, ["BAL", "MASS"]);
  assert.equal((await gmSave(repo, runId, session, {}, 0, "gm-init")).status, 200);

  await submitPlayerDecision(repo, seat.repo, { runId, companyId: "BAL", claimedTurn: 1, decision: decisionFor(session, "BAL") });
  await submitPlayerDecision(repo, seat.repo, { runId, companyId: "MASS", claimedTurn: 1, decision: decisionFor(session, "MASS") });

  assert.deepEqual(await confirmedKeys(repo, runId), ["BAL", "MASS"], "片方の提出が消えている");
});

test("O1-05b: 2社が同じbase revisionから提出しても、後発がCASで読み直して両方残る", async () => {
  const repo = createInMemorySimulationRunRepository();
  const seat = createSeatSpy();
  const runId = "o1-05b";
  const session = newSession(runId, ["BAL", "MASS"]);
  assert.equal((await gmSave(repo, runId, session, {}, 0, "gm-init")).status, 200);

  // 同時提出（同じ正本を読んだ状態から2社が提出する）を、順序を固定して再現する。
  const [balResult, massResult] = await Promise.all([
    submitPlayerDecision(repo, seat.repo, { runId, companyId: "BAL", claimedTurn: 1, decision: decisionFor(session, "BAL") }),
    submitPlayerDecision(repo, seat.repo, { runId, companyId: "MASS", claimedTurn: 1, decision: decisionFor(session, "MASS") }),
  ]);
  assert.ok(balResult.persistenceRevision > 0);
  assert.ok(massResult.persistenceRevision > 0);
  assert.notEqual(balResult.persistenceRevision, massResult.persistenceRevision, "2つの提出が同じrevisionを名乗っている");
  assert.deepEqual(await confirmedKeys(repo, runId), ["BAL", "MASS"], "同時提出で片方が消えている");
});

test("O1-06: Player提出とGMのTurn進行が競合しても、Turnの整合性が崩れない", async () => {
  const repo = createInMemorySimulationRunRepository();
  const seat = createSeatSpy();
  const runId = "o1-06";
  let session = newSession(runId, ["BAL"]);
  assert.equal((await gmSave(repo, runId, session, {}, 0, "gm-init")).status, 200);

  await submitPlayerDecision(repo, seat.repo, { runId, companyId: "BAL", claimedTurn: 1, decision: decisionFor(session, "BAL") });
  const baseAfterSubmit = (await repo.loadRun(runId))!.persistenceRevision!;

  const stored = await repo.loadRun(runId);
  session = advanceSimulationTurn(session, AT, { ...(stored!.resumePayload!.confirmedPlayerDecisions ?? {}) } as Record<string, CompanyDecisionInput>, "O1-TEST").session;
  assert.equal((await gmSave(repo, runId, session, {}, baseAfterSubmit, "gm-turn1")).status, 200);

  const after = await repo.loadRun(runId);
  assert.equal(after?.resumePayload?.state.scenarioState.currentTurn, 2, "Turnが進んでいない");
  assert.equal(after?.run.completedTurns, 1);
  assert.deepEqual(Object.keys(after?.resumePayload?.confirmedPlayerDecisions ?? {}), [], "消費済みの提出が残っている");
});

test("O1-07: 競合再試行中にTurnが進んでいたら STALE_TURN になる", async () => {
  const repo = createInMemorySimulationRunRepository();
  const seat = createSeatSpy();
  const runId = "o1-07";
  let session = newSession(runId, ["BAL"]);
  assert.equal((await gmSave(repo, runId, session, {}, 0, "gm-init")).status, 200);
  const decision = decisionFor(session, "BAL");

  // GMがTurnを進めてしまった後に、Turn1として提出しようとする。
  session = advanceSimulationTurn(session, AT, { BAL: decision }, "O1-TEST").session;
  const base = (await repo.loadRun(runId))!.persistenceRevision!;
  assert.equal((await gmSave(repo, runId, session, {}, base, "gm-turn1")).status, 200);

  await assert.rejects(
    () => submitPlayerDecision(repo, seat.repo, { runId, companyId: "BAL", claimedTurn: 1, decision }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "STALE_TURN"
  );
});

test("O1-08: 同じ会社が同じTurnへ二重提出すると DUPLICATE_SUBMIT になる", async () => {
  const repo = createInMemorySimulationRunRepository();
  const seat = createSeatSpy();
  const runId = "o1-08";
  const session = newSession(runId, ["BAL"]);
  assert.equal((await gmSave(repo, runId, session, {}, 0, "gm-init")).status, 200);
  const decision = decisionFor(session, "BAL");

  await submitPlayerDecision(repo, seat.repo, { runId, companyId: "BAL", claimedTurn: 1, decision });
  await assert.rejects(
    () => submitPlayerDecision(repo, seat.repo, { runId, companyId: "BAL", claimedTurn: 1, decision }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "DUPLICATE_SUBMIT"
  );
  assert.deepEqual(await confirmedKeys(repo, runId), ["BAL"]);
});

test("O1-10: decision.companyId と提出先companyId の不一致をserver側で拒否する", async () => {
  const repo = createInMemorySimulationRunRepository();
  const seat = createSeatSpy();
  const runId = "o1-10";
  const session = newSession(runId, ["BAL"]);
  assert.equal((await gmSave(repo, runId, session, {}, 0, "gm-init")).status, 200);

  const massDecision = decisionFor(session, "MASS");
  assert.equal((massDecision as { companyId?: string }).companyId, "MASS", "前提が崩れている（decisionにcompanyIdが無い）");
  await assert.rejects(
    () => submitPlayerDecision(repo, seat.repo, { runId, companyId: "BAL", claimedTurn: 1, decision: massDecision }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "INVALID_DECISION"
  );
  assert.deepEqual(await confirmedKeys(repo, runId), [], "拒否したのに保存されている");
});

test("O1-11: FINISHED lock回帰 — ゲーム終了後の提出は RUN_FINISHED で拒否される", async () => {
  const repo = createInMemorySimulationRunRepository();
  const seat = createSeatSpy();
  const runId = "o1-11";
  const session = newSession(runId, ["BAL"]);
  const ended: SimulationSession = { ...session, run: { ...session.run, gameEndedAt: AT, gameEndTurn: 1 } };
  assert.equal((await gmSave(repo, runId, ended, {}, 0, "gm-init")).status, 200);

  await assert.rejects(
    () => submitPlayerDecision(repo, seat.repo, { runId, companyId: "BAL", claimedTurn: 1, decision: decisionFor(session, "BAL") }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "RUN_FINISHED"
  );
});

test("O1-12: PLAYERでない会社の提出は NOT_PLAYER_CONTROLLED で拒否される（seat gate回帰）", async () => {
  const repo = createInMemorySimulationRunRepository();
  const seat = createSeatSpy();
  const runId = "o1-12";
  const session = newSession(runId, ["BAL"]);
  assert.equal((await gmSave(repo, runId, session, {}, 0, "gm-init")).status, 200);

  await assert.rejects(
    () => submitPlayerDecision(repo, seat.repo, { runId, companyId: "JPQ", claimedTurn: 1, decision: decisionFor(session, "JPQ") }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "NOT_PLAYER_CONTROLLED"
  );
});

test("O1-16: 提出が確定しなかった場合、seat記録だけが残らない", async () => {
  const repo = createInMemorySimulationRunRepository();
  const seat = createSeatSpy();
  const runId = "o1-16";
  const session = newSession(runId, ["BAL"]);
  assert.equal((await gmSave(repo, runId, session, {}, 0, "gm-init")).status, 200);

  // 拒否される提出（別会社のdecision本体）ではseat記録を書かない。
  await assert.rejects(() => submitPlayerDecision(repo, seat.repo, { runId, companyId: "BAL", claimedTurn: 1, decision: decisionFor(session, "MASS") }));
  assert.deepEqual(seat.records, [], "保存が成立していないのにseat記録が書かれている");

  // 成功した提出ではseat記録が書かれる（順序: decision保存 → seat記録）。
  await submitPlayerDecision(repo, seat.repo, { runId, companyId: "BAL", claimedTurn: 1, decision: decisionFor(session, "BAL") });
  assert.deepEqual(seat.records, [{ companyId: "BAL", turn: 1 }]);
  assert.deepEqual(await confirmedKeys(repo, runId), ["BAL"]);
});
