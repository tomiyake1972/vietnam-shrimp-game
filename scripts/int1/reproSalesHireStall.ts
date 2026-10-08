/** 【INT-1 §3 再現】営業人員の採用上限超過が提出時に通り、GMのTurn実行で初めて拒否される経路。 */
import { createInMemorySimulationRunRepository } from "../../app/lib/v2/companyLab/simulation/persistence/repository";
import { handleSaveSimulationRun, handleSaveSimulationRunPart } from "../../app/api/v2/simulation-runs/_lib/handlers";
import { submitPlayerDecision } from "../../app/lib/v2/player/submit";
import { advanceSimulationTurn, createSimulationSession } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../app/lib/v2/companyLab/runner";
import { generateStandardAiDecision } from "../../app/lib/v2/companyLab/standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft, validateDecisionDraftNumbers } from "../../app/v2/company-lab/decisionDraft";
import { computeMaxSalesHiresPerQuarter } from "../../app/lib/v2/companyLab/salesForceHiring";
import { buildResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import type { CompanyDecisionInput } from "../../app/lib/v2/companyLab/types";

const AT = "2026-10-07T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;

async function main(): Promise<void> {
  const repo = createInMemorySimulationRunRepository();
  const seat = { recordSubmission: async () => {} } as never;
  const runId = "repro-hire-stall";
  const modes = Object.fromEntries(COMPANIES.map((c) => [c, c === "BAL" ? "PLAYER" : "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">;
  let session = createSimulationSession({
    simulationRunId: runId, scenarioId: "baseline", seed: "repro-hire", requestedTurns: 32,
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
  const ownState = buildCompanyOwnState(session.state, fixture);
  const ai = generateStandardAiDecision(fixture, ownState, buildPublicMarketInfo(session.state), session.state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);

  const currentHeadcount = ownState.salesForceHiringState.headcount;
  const limit = computeMaxSalesHiresPerQuarter(currentHeadcount);
  console.log(`# 現在の営業人員 = ${currentHeadcount}人 / 1四半期の採用上限 = ${limit}人`);

  const overLimit = { ...JSON.parse(JSON.stringify(draft)), salesForceHireCount: limit + 1 };
  console.log(`# 提出する採用人数 = ${overLimit.salesForceHireCount}人（上限+1）`);
  console.log(`# INT-1の数値検証（validateDecisionDraftNumbers）: ${JSON.stringify(validateDecisionDraftNumbers(overLimit))}`);

  const decision = buildDecisionInputFromDraft(overLimit, fixture, session.state.currentPeriod);
  console.log(`# buildDecisionInputFromDraft 後の salesForceHireCount = ${(decision as { salesForceHireCount?: number }).salesForceHireCount}`);

  let submitError: string | null = null;
  try {
    await submitPlayerDecision(repo, seat, { runId, companyId: "BAL", claimedTurn: 1, decision });
  } catch (e) {
    submitError = `${(e as Error).name}: ${(e as Error).message.slice(0, 120)}`;
  }
  console.log(`# 提出結果: ${submitError ?? "受理された（エラーなし）"}`);

  const stored = await repo.loadRun(runId);
  const saved = (stored?.resumePayload?.confirmedPlayerDecisions ?? {}) as Record<string, { salesForceHireCount?: number }>;
  console.log(`# 保存された BAL の salesForceHireCount = ${JSON.stringify(saved["BAL"]?.salesForceHireCount)}`);

  let advanceError: string | null = null;
  try {
    const out = advanceSimulationTurn(session, AT, saved as never, "REPRO");
    advanceError = out.advanced ? null : `advanced=false: ${String(out.error)}`;
    if (out.advanced) session = out.session;
  } catch (e) {
    advanceError = `例外 ${(e as Error).name}: ${(e as Error).message.slice(0, 160)}`;
  }
  console.log(`# GMのTurn進行: ${advanceError ?? "成功"}`);

  // 同じTurnへ正しい値で再提出できるか（PLAYER自身で直せるか）
  let resubmit: string | null = null;
  try {
    const fixed = buildDecisionInputFromDraft({ ...JSON.parse(JSON.stringify(draft)), salesForceHireCount: limit }, fixture, session.state.currentPeriod);
    await submitPlayerDecision(repo, seat, { runId, companyId: "BAL", claimedTurn: 1, decision: fixed });
  } catch (e) {
    resubmit = `${(e as Error).name}: ${(e as Error).message.slice(0, 120)}`;
  }
  console.log(`# 同じTurnへ正しい値で再提出: ${resubmit ?? "成功"}`);
}
void main();
