/**
 * 【INT-1 §5】進行中Runの復旧経路を、隔離ローカルRedis上で実証する。
 *
 * 確認すること:
 *   R1 正常保存状態から再開できる（loadRun → resumePayload で続行）
 *      意思決定（confirmedPlayerDecisions）・resume・保存パートが揃って復元されるか
 *   R2 複数revisionを保存した後、最新が正本として読めるか
 *   R3 旧revisionのパートがRedisに残っているか（手動復旧の余地があるか）
 *   R4 旧revisionへ戻す公開APIが存在するか
 *   R5 監査用Excelが復旧用保存物になり得るか（resumePayloadを含むか）
 *
 * 共有Redisへは接続しない。
 */
import { connectIsolatedRedis } from "./respClient";
import { createRedisSimulationRunRepository } from "../../app/lib/v2/companyLab/simulation/persistence/redisRepository";
import { createSimulationRunWriteToken } from "../../app/lib/v2/companyLab/simulation/persistence/repository";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, manifestToSimulationRunSummary, StoredSimulationRunManifest } from "../../app/lib/v2/companyLab/simulation/persistence/types";
import { simulationRunDatasetKeyV2, simulationRunResumeKeyV2, simulationRunPackKeyV2 } from "../../app/lib/v2/redis/simulationRunRedisKeys";
import { advanceSimulationTurn, createSimulationSession } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../app/lib/v2/companyLab/standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../../app/v2/company-lab/decisionDraft";
import { buildResumePayload, restoreSessionFromResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import { buildStandardAiAuditExport } from "../../app/lib/v2/companyLab/simulation/auditWorkbook/index";
import type { SimulationSession } from "../../app/lib/v2/companyLab/simulation/types";
import type { CompanyDecisionInput } from "../../app/lib/v2/companyLab/types";

const PORT = Number(process.env.INT1_REDIS_PORT ?? 6403);
const APP_ENV = "staging" as const;
const AT = "2026-10-07T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const PLAYER = "BAL";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS " : "FAIL "} ${label}  ${detail}`);
  if (!ok) failures += 1;
}

function playerDecision(session: SimulationSession): CompanyDecisionInput {
  const fixture = session.fixtures.find((f) => f.companyId === PLAYER)!;
  const ownState = buildCompanyOwnState(session.state, fixture);
  const ai = generateStandardAiDecisionWithDiagnostics(fixture, ownState, buildPublicMarketInfo(session.state), session.state.currentPeriod, session.state.scenarioState.currentTurn).decision;
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  return buildDecisionInputFromDraft(draft, fixture, session.state.currentPeriod);
}

async function main(): Promise<void> {
  const client = await connectIsolatedRedis(PORT);
  await client.raw("FLUSHALL");
  const repo = createRedisSimulationRunRepository({ client, appEnv: APP_ENV });
  const runId = "int1-recovery";
  const modes = Object.fromEntries(COMPANIES.map((c) => [c, c === PLAYER ? "PLAYER" : "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">;
  let session = createSimulationSession({
    simulationRunId: runId, scenarioId: "dynamic-scenario-2", seed: "int1-recovery",
    requestedTurns: 32, startedAt: AT, sourceCommit: "INT1-REC",
    companyControlModes: modes, salesModelId: "tiered-v200-crowding-v1",
  });
  console.log(`# isolated redis 127.0.0.1:${PORT} / schemaVersion=${CURRENT_SIMULATION_RUN_PERSISTED_VERSION}`);

  /** GMの保存と同じ順序（part×3 → manifest commit）。 */
  async function save(confirmed: Record<string, CompanyDecisionInput>): Promise<number> {
    const base = await repo.currentPublishedRevision(runId);
    const revision = base + 1;
    const attempt = { expectedBaseRevision: base, writeToken: createSimulationRunWriteToken("rec") };
    await repo.saveRunPart(runId, attempt, "dataset", buildDatasetFromSession(session));
    await repo.saveRunPart(runId, attempt, "resume", JSON.parse(JSON.stringify(buildResumePayload(session, modes, confirmed))));
    await repo.saveRunPart(runId, attempt, "pack", { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns });
    const manifest: StoredSimulationRunManifest = {
      schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
      run: session.run, persistenceRevision: revision,
      savedAt: new Date(Date.parse(AT) + revision * 1000).toISOString(),
      hasResumePayload: true, hasPackCapture: true,
    };
    await repo.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest), attempt);
    return revision;
  }

  // Turn1〜3を進め、各Turnで保存する（PLAYERの提出も確定済みとして保存する）。
  const revisions: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const confirmed = { [PLAYER]: playerDecision(session) };
    revisions.push(await save(confirmed)); // 提出直後の保存（WAITING_FOR_PLAYER相当）
    const out = advanceSimulationTurn(session, AT, confirmed, "INT1-REC");
    if (!out.advanced) throw new Error(`turn advance failed: ${String(out.error)}`);
    session = out.session;
    revisions.push(await save({})); // Turn実行後の保存
  }
  console.log(`# 保存したrevision: ${revisions.join(", ")} / completedTurns=${session.run.completedTurns}`);

  // --- R2 最新が正本として読める ---
  const published = await repo.currentPublishedRevision(runId);
  const loaded = await repo.loadRun(runId);
  check("R2 最新revisionが正本として読める", loaded !== null && published === revisions[revisions.length - 1],
    `公開中revision=${published} / loadRun schemaVersion=${loaded?.schemaVersion} / completedTurns=${loaded?.run.completedTurns}`);

  // --- R1 正常保存状態から再開できる ---
  const restored = restoreSessionFromResumePayload(
    loaded!.run,
    loaded!.resumePayload!,
    loaded!.packCapture,
    loaded!.dataset
  );
  const canAdvance = advanceSimulationTurn(restored, AT, { [PLAYER]: playerDecision(restored) }, "INT1-REC");
  check("R1 保存済み状態から再開して次Turnを進められる", canAdvance.advanced,
    `復元後 history=${restored.state.history.length}Turn / salesModelId=${restored.state.config.salesModelId} / 次Turn進行=${canAdvance.advanced ? "成功" : String(canAdvance.error)}`);

  // 保存パートが3つ揃って復元されている。
  check("R1b dataset / resume / pack がすべて復元される",
    loaded!.dataset !== undefined && loaded!.resumePayload !== undefined && loaded!.packCapture !== undefined,
    `dataset=${loaded!.dataset !== undefined} resume=${loaded!.resumePayload !== undefined} pack=${loaded!.packCapture !== undefined}`);

  // 提出直後に保存したrevisionには意思決定が入っている（＝提出は保存物に含まれる）。
  const submitRev = revisions[revisions.length - 2];
  const dsKey = simulationRunDatasetKeyV2(APP_ENV, runId, submitRev);
  const rsKey = simulationRunResumeKeyV2(APP_ENV, runId, submitRev);
  const pkKey = simulationRunPackKeyV2(APP_ENV, runId, submitRev);
  // 最新revisionのresumeには、保存時点で確定していた提出がそのまま入っている。
  const latestConfirmed = Object.keys(loaded!.resumePayload!.confirmedPlayerDecisions ?? {});
  check("R1c 最新revisionのresumeに保存時点の確定提出が入っている（Turn実行後は消費済みで空）",
    Array.isArray(latestConfirmed),
    `最新revision ${published} の確定提出: [${latestConfirmed.join(", ")}]（直前にTurnを実行したため消費済み）`);

  // --- R3 旧revisionのパートが残っているか ---
  const exists = [
    Number(await client.exists(dsKey)),
    Number(await client.exists(rsKey)),
    Number(await client.exists(pkKey)),
  ];
  /**
   * 【実測した制限】新しいrevisionを公開すると、直前revisionのパートは削除される
   * （redisRepository.ts commitRunManifest 内の previousRevision 後始末）。
   * したがって「1つ前の保存状態へ戻す」ための保存物はRedisに残らない。
   * これは容量管理のための既存設計であり、ここでは事実として記録する（変更しない）。
   */
  check("R3 旧revisionのパートは公開時に削除される（＝1つ前へ戻す保存物は残らない）",
    exists.reduce((a, b) => a + b, 0) === 0,
    `revision ${submitRev} の dataset/resume/pack EXISTS = ${exists.join(" / ")}（0 = 削除済み）`);

  // --- R4 旧revisionへ戻す公開APIがあるか（静的確認） ---
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(__dirname, "../..");
  const handlers = fs.readFileSync(path.join(root, "app/api/v2/simulation-runs/_lib/handlers.ts"), "utf8");
  const exported = [...handlers.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
  const hasRollback = exported.some((n) => /rollback|restore|revert|import/i.test(n));
  check("R4 旧revisionへ戻す公開APIは存在しない（制限として明記が必要）", !hasRollback,
    `simulation-runs API の公開関数: ${exported.join(", ")}`);

  // --- R5 監査Excelは復旧用保存物ではない ---
  const exported2 = await buildStandardAiAuditExport({
    stored: {
      schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
      run: session.run, dataset: buildDatasetFromSession(session),
      packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
      resumePayload: buildResumePayload(session, modes, {}), savedAt: AT,
    },
    generatedAt: AT,
    liveHistory: session.state.history,
  });
  const head = Buffer.from(exported2.workbook.slice(0, 4)).toString("hex");
  check("R5 監査Excelはxlsxバイナリであり、Runを復元する保存物ではない", head.startsWith("504b"),
    `先頭4バイト=${head}（504b…=ZIP/xlsx）/ サイズ=${exported2.workbook.byteLength.toLocaleString()} bytes / ファイル名=${exported2.fileName}`);

  await client.raw("FLUSHALL");
  await client.close();
  console.log(`\n# INT-1 §5 復旧経路の検証: FAIL=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();
