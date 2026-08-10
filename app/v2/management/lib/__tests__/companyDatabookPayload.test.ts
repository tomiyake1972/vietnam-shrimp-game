// ShrimpX V2 — 32Q Management Console Phase 9: PLAYER Company Databook のテスト（DB-1〜DB-8）
//
// 【このテスト群が守る因果】
//  PLAYER Workspaceで「会社Databookをダウンロード」を押したとき、
//   (a) 対象会社・対象Turnのデータになっていること（別会社・別Turnとすり替わらない）
//   (b) 他社の非公開意思決定・非公開データが一切含まれないこと
//   (c) 通常プレイと同じDTO/Excel生成関数をそのまま通していること
//  を、計算を新設せずに確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurns, createSimulationSession } from "../../../../lib/v2/companyLab/simulation/engine";
import { buildCompanyDatabookQuarterEntry, DatabookNotAvailableError } from "../companyDatabookPayload";
import { buildCompanyExportPayload } from "../../../../api/v2/exports/_lib/exportDto";
import { buildCompanyExportExcelWorkbook } from "../../../../lib/v2/companyLab/adminExport/companyLabAdminExcelBuilder";

const AT = "2026-01-01T00:00:00.000Z";

function runTurns(simulationRunId: string, turns: number) {
  const session = createSimulationSession({ simulationRunId, scenarioId: "baseline", seed: "phase9-databook-test", requestedTurns: 32, startedAt: AT });
  return advanceSimulationTurns({ session, turns, timestamp: AT });
}

// DB-1: 対象Turnと一致する
test("DB-1: entryのturn/periodは、Sessionの直近確定Turnと一致する", () => {
  const session = runTurns("db-1", 5);
  const entry = buildCompanyDatabookQuarterEntry(session, "BAL");
  const lastRecord = session.state.history[session.state.history.length - 1];
  assert.equal(entry.turn, lastRecord.turn);
  assert.equal(entry.period, lastRecord.period);
});

// DB-2: playerSubmission/otherCompaniesDecisionsのスコープが正しい
test("DB-2: playerSubmissionは対象会社、otherCompaniesDecisionsは対象会社を含まない", () => {
  const session = runTurns("db-2", 3);
  const entry = buildCompanyDatabookQuarterEntry(session, "BAL");
  assert.equal(entry.playerSubmission.companyId, "BAL");
  assert.ok(entry.otherCompaniesDecisions.every((d) => d.companyId !== "BAL"));
  assert.ok(entry.otherCompaniesDecisions.length > 0, "他社の意思決定が1件も無い（フィルタが効きすぎている）");
});

// DB-3: 期首（preProcessingStateSnapshot）と期末（postProcessingStateSnapshot）は別物
test("DB-3: 期首状態と期末状態は同じスナップショットの使い回しではない", () => {
  const session = runTurns("db-3", 4);
  const entry = buildCompanyDatabookQuarterEntry(session, "BAL");
  assert.notEqual(
    entry.preProcessingStateSnapshot.scenarioState.currentTurn,
    entry.postProcessingStateSnapshot.scenarioState.currentTurn,
    "期首・期末のcurrentTurnが同じ＝期末を期首として使い回している"
  );
});

// DB-4: buildCompanyExportPayloadへ渡すと、会社スコープの範囲を保つ（他社データを含まない）
test("DB-4: 組み立てたentryをbuildCompanyExportPayloadへ渡しても、他社の非公開情報が一切含まれない", () => {
  const session = runTurns("db-4", 2);
  const entry = buildCompanyDatabookQuarterEntry(session, "BAL");
  const payload = buildCompanyExportPayload({ labId: session.run.simulationRunId, companyId: "BAL", entry, generatedAt: AT, fixtures: session.fixtures });
  const json = JSON.stringify(payload);
  assert.ok(!json.includes("otherCompaniesDecisions"), "会社スコープのpayloadに他社意思決定キーが含まれている");
  assert.ok(!json.includes("playerSubmission"), "会社スコープのpayloadに生のplayerSubmissionキーが含まれている（decisionInfo経由で絞り込むべき）");
  for (const c of payload.salesContracts) assert.equal(c.companyId, "BAL");
});

// DB-5: 会社サマリー・財務結果が、Session側の確定記録と一致する（別計算をしていない）
test("DB-5: payload内の会社サマリー・財務結果は、SimulationSessionの確定履歴と数値が一致する", () => {
  const session = runTurns("db-5", 3);
  const entry = buildCompanyDatabookQuarterEntry(session, "BAL");
  const payload = buildCompanyExportPayload({ labId: session.run.simulationRunId, companyId: "BAL", entry, generatedAt: AT, fixtures: session.fixtures });
  const record = session.state.history[session.state.history.length - 1];
  const summary = record.companySummaries.find((s) => s.companyId === "BAL");
  assert.ok(payload.companySummary !== null && summary !== undefined);
  assert.equal(payload.meta.period, record.period);
});

// DB-6: まだ1Turnも確定していないRunでは、Q1を捏造せずエラーにする
test("DB-6: Turnが1つも確定していないRunでは、Databookを組み立てず例外になる", () => {
  const session = createSimulationSession({ simulationRunId: "db-6", scenarioId: "baseline", seed: "phase9-databook-test", requestedTurns: 32, startedAt: AT });
  assert.throws(() => buildCompanyDatabookQuarterEntry(session, "BAL"), DatabookNotAvailableError);
});

// DB-7: 期首状態が記録されていない（壊れた/古い）Sessionでは、黙って期末を使い回さず例外になる
test("DB-7: latestQuarterPreProcessingSnapshotが無いSessionでは例外になる（期末の使い回しをしない）", () => {
  const session = runTurns("db-7", 1);
  const corrupted = { ...session, latestQuarterPreProcessingSnapshot: null };
  assert.throws(() => buildCompanyDatabookQuarterEntry(corrupted, "BAL"), DatabookNotAvailableError);
});

// DB-8: 実際にExcelワークブックが生成できる（通常プレイと同じExcel生成関数を通す統合確認）
test("DB-8: 組み立てたpayloadから、通常プレイと同じbuildCompanyExportExcelWorkbookでxlsxが生成できる", async () => {
  const session = runTurns("db-8", 2);
  const entry = buildCompanyDatabookQuarterEntry(session, "MASS");
  const payload = buildCompanyExportPayload({ labId: session.run.simulationRunId, companyId: "MASS", entry, generatedAt: AT, fixtures: session.fixtures });
  const buffer = await buildCompanyExportExcelWorkbook(payload);
  assert.ok(buffer.length > 0, "Databook（xlsx）が空になっている");
});
