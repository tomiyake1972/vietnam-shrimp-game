// ShrimpX V2 — Management Console: liveSessionRegistry（Phase 8・Run Context Preservation）
//
// 【この受入で守る因果】
//   同じsimulationRunIdへの部分更新（upsertLiveSession）が、他方が持つフィールド
//   （例: Consoleのcompany控えmodesとWorkspaceのpendingDrafts）を上書きしないこと。
//   別のsimulationRunIdは互いに影響しないこと。

import { test } from "node:test";
import assert from "node:assert/strict";
import { clearLiveSessionRegistry, getLiveSession, upsertLiveSession } from "../liveSessionRegistry";
import { createSimulationSession } from "../../../../lib/v2/companyLab/simulation/engine";

const AT = "2026-01-01T00:00:00.000Z";

function session(id: string) {
  return createSimulationSession({ simulationRunId: id, scenarioId: "baseline", seed: "registry-test", requestedTurns: 1, startedAt: AT });
}

test("REGISTRY-1: 初回書き込みは既定値（空オブジェクト・selectedCompanyId=BAL）で作られる", () => {
  clearLiveSessionRegistry();
  const s = session("registry-test-1");
  upsertLiveSession(s.run.simulationRunId, { session: s });
  const entry = getLiveSession(s.run.simulationRunId);
  assert.ok(entry);
  assert.deepEqual(entry?.companyControlModes, {});
  assert.deepEqual(entry?.pendingDrafts, {});
  assert.equal(entry?.selectedCompanyId, "BAL");
});

test("REGISTRY-2: Console由来の更新（companyControlModes）は、Workspace由来のpendingDraftsを消さない", () => {
  clearLiveSessionRegistry();
  const s = session("registry-test-2");
  upsertLiveSession(s.run.simulationRunId, { session: s });
  // WorkspaceがpendingDraftsを書き込む。
  upsertLiveSession(s.run.simulationRunId, { session: s, pendingDrafts: { BAL: { fake: true } as never } });
  // Consoleがcompany控えmodesだけを書き込む（pendingDraftsには触れない）。
  upsertLiveSession(s.run.simulationRunId, { session: s, companyControlModes: { BAL: "PLAYER" } });

  const entry = getLiveSession(s.run.simulationRunId);
  assert.deepEqual(entry?.companyControlModes, { BAL: "PLAYER" });
  assert.ok(entry?.pendingDrafts["BAL"], "ConsoleのcompanyControlModes更新でpendingDraftsが消えてしまっている");
});

test("REGISTRY-3: 異なるsimulationRunIdは互いに独立している", () => {
  clearLiveSessionRegistry();
  const a = session("registry-test-a");
  const b = session("registry-test-b");
  upsertLiveSession(a.run.simulationRunId, { session: a, companyControlModes: { BAL: "PLAYER" } });
  upsertLiveSession(b.run.simulationRunId, { session: b, companyControlModes: { MASS: "PLAYER" } });

  assert.deepEqual(getLiveSession(a.run.simulationRunId)?.companyControlModes, { BAL: "PLAYER" });
  assert.deepEqual(getLiveSession(b.run.simulationRunId)?.companyControlModes, { MASS: "PLAYER" });
});

test("REGISTRY-4: 登録されていないrunIdはnullを返す（架空の状態を作らない）", () => {
  clearLiveSessionRegistry();
  assert.equal(getLiveSession("never-registered"), null);
});
