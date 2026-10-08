/** 【INT-1 §6 再現】無効な値（非有限数）を含む提出が保存され、GMのTurn進行で初めて失敗するか。 */
import { createInMemorySimulationRunRepository } from "../../app/lib/v2/companyLab/simulation/persistence/repository";
import { handleSaveSimulationRun, handleSaveSimulationRunPart } from "../../app/api/v2/simulation-runs/_lib/handlers";
import { submitPlayerDecision } from "../../app/lib/v2/player/submit";
import { advanceSimulationTurn, createSimulationSession } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../app/lib/v2/companyLab/standardAi/policy";
import { buildResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import type { CompanyDecisionInput } from "../../app/lib/v2/companyLab/types";

const AT = "2026-10-07T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;

async function main(): Promise<void> {
  const repo = createInMemorySimulationRunRepository();
  const seat = { recordSubmission: async () => {} } as never;
  const runId = "repro-invalid";
  const modes = Object.fromEntries(COMPANIES.map((c) => [c, c === "BAL" ? "PLAYER" : "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">;
  let session = createSimulationSession({
    simulationRunId: runId, scenarioId: "baseline", seed: "repro", requestedTurns: 32,
    startedAt: AT, sourceCommit: "REPRO", companyControlModes: modes,
  });

  const save = async (confirmed: Record<string, CompanyDecisionInput>, base: number, token: string) => {
    const revision = base + 1;
    const attempt = { expectedBaseRevision: base, writeToken: token };
    for (const [part, value] of [
      ["dataset", buildDatasetFromSession(session)],
      ["resume", buildResumePayload(session, modes, confirmed)],
      ["pack", { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns }],
    ] as const) {
      const r = await handleSaveSimulationRunPart(repo, { simulationRunId: runId, revision, part, value, ...attempt });
      if (r.status !== 200) throw new Error(`part save failed: ${JSON.stringify(r)}`);
    }
    return handleSaveSimulationRun(repo, {
      manifestOnly: true, run: session.run, savedAt: AT, persistenceRevision: revision,
      hasResumePayload: true, hasPackCapture: true, ...attempt,
    });
  };
  await save({}, 0, "init");

  const fixture = session.fixtures.find((f) => f.companyId === "BAL")!;
  const good = generateStandardAiDecisionWithDiagnostics(
    fixture, buildCompanyOwnState(session.state, fixture), buildPublicMarketInfo(session.state),
    session.state.currentPeriod, session.state.scenarioState.currentTurn
  ).decision;

  // 非有限数（NaN）を1箇所だけ混ぜる。実経路（route.ts）では
  // クライアントJSONのdraftから buildDecisionInputFromDraft を通るため、
  // ここでは「decisionに非有限数が入った状態」を直接再現する。
  const bad = JSON.parse(JSON.stringify(good)) as CompanyDecisionInput;
  const plans = (bad as unknown as { salesPlans: { desiredQuantity: number }[] }).salesPlans;
  console.log(`# salesPlans 件数 = ${plans.length}, 先頭 desiredQuantity = ${plans[0]?.desiredQuantity}`);
  plans[0].desiredQuantity = Number.NaN;

  let submitError: string | null = null;
  try {
    await submitPlayerDecision(repo, seat, { runId, companyId: "BAL", claimedTurn: 1, decision: bad });
  } catch (e) {
    submitError = `${(e as Error).name}: ${(e as Error).message}`;
  }
  console.log(`# 提出結果: ${submitError ?? "受理された（エラーなし）"}`);

  const stored = await repo.loadRun(runId);
  const savedPlans = (stored?.resumePayload?.confirmedPlayerDecisions?.["BAL"] as { salesPlans?: { desiredQuantity: unknown }[] } | undefined)?.salesPlans;
  console.log(`# 保存された confirmedPlayerDecisions.BAL の有無: ${savedPlans !== undefined}`);
  if (savedPlans) console.log(`# 保存された先頭 desiredQuantity = ${JSON.stringify(savedPlans[0]?.desiredQuantity)} (JSON往復で NaN → null)`);

  // GMがTurnを進めるとどうなるか。
  let advanceError: string | null = null;
  try {
    const confirmed = (stored?.resumePayload?.confirmedPlayerDecisions ?? {}) as Record<string, CompanyDecisionInput>;
    const out = advanceSimulationTurn(session, AT, confirmed, "REPRO");
    advanceError = out.advanced ? null : `advanced=false: ${String(out.error)}`;
    if (out.advanced) session = out.session;
  } catch (e) {
    advanceError = `例外 ${(e as Error).name}: ${(e as Error).message}`;
  }
  console.log(`# GMのTurn進行: ${advanceError ?? "成功（無効値が計算へ流れた）"}`);
}
void main();
