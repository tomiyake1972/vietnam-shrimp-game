/** 【INT-1 §6 再現2】実経路（クライアントJSONのdraft → buildDecisionInputFromDraft）で
 *  無効な値がどこまで通るか。route.ts と同じ順序で確認し、decision全体を走査する。 */
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo } from "../../app/lib/v2/companyLab";
import { generateStandardAiDecision } from "../../app/lib/v2/companyLab/standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../../app/v2/company-lab/decisionDraft";
import { advanceCompanyLabQuarter, generateAutoPolicyDecision } from "../../app/lib/v2/companyLab";
import type { CompanyDecisionInput } from "../../app/lib/v2/companyLab/types";

const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "repro2", turns: 6 });
const fixture = fixtures.find((f) => f.companyId === "BAL")!;
const ownState = buildCompanyOwnState(state, fixture);
const publicInfo = buildPublicMarketInfo(state);
const ai = generateStandardAiDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);

/** decision 全体を走査して、非有限数・数値であるべき箇所のnull/文字列を数える。 */
function scan(value: unknown, path = ""): string[] {
  const bad: string[] = [];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) bad.push(`${path}=${value}`);
    return bad;
  }
  if (value === null) return bad;
  if (Array.isArray(value)) {
    value.forEach((v, i) => bad.push(...scan(v, `${path}[${i}]`)));
    return bad;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as object)) bad.push(...scan(v, path ? `${path}.${k}` : k));
  }
  return bad;
}

function tryDraft(label: string, mutate: (d: unknown) => void): void {
  const copy = JSON.parse(JSON.stringify(draft));
  mutate(copy);
  const wire = JSON.parse(JSON.stringify(copy)); // クライアント→サーバのJSON往復
  let decision: CompanyDecisionInput;
  try {
    decision = buildDecisionInputFromDraft(wire, fixture, state.currentPeriod);
  } catch (e) {
    console.log(`拒否(build)  ${label}  → ${(e as Error).name}: ${(e as Error).message.slice(0, 100)}`);
    return;
  }
  const nonFinite = scan(decision);
  // GMのTurn進行まで通すと何が起きるか（他社はAuto Policy）。
  let advance = "成功";
  try {
    const byCompany = Object.fromEntries(
      fixtures.map((f) => [
        f.companyId,
        f.companyId === "BAL"
          ? decision
          : generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, 1),
      ])
    );
    advanceCompanyLabQuarter(state, fixtures, byCompany);
  } catch (e) {
    advance = `失敗 ${(e as Error).name}: ${(e as Error).message.slice(0, 90)}`;
  }
  console.log(`受理(build)  ${label}`);
  console.log(`             decision内の非有限数: ${nonFinite.length === 0 ? "なし" : nonFinite.slice(0, 3).join(", ")}`);
  console.log(`             GMのTurn進行: ${advance}`);
}

const sp = (d: unknown) => (d as { salesPlans: Record<string, unknown>[] }).salesPlans;
const wa = (d: unknown) => (d as { workerAssignments: Record<string, unknown>[] }).workerAssignments;
const pp = (d: unknown) => (d as { productionPlans: Record<string, unknown>[] }).productionPlans;
console.log(`# draft.salesPlans=${sp(draft).length}件 / productionPlans=${pp(draft).length}件 / workerAssignments=${wa(draft).length}件\n`);
tryDraft("salesPlans[0].desiredQuantity = null（NaN/Infinityの実体）", (d) => { sp(d)[0].desiredQuantity = null; });
tryDraft("salesPlans[0].desiredQuantity = -5000（負数）", (d) => { sp(d)[0].desiredQuantity = -5000; });
tryDraft('salesPlans[0].desiredQuantity = "abc"（文字列）', (d) => { sp(d)[0].desiredQuantity = "abc"; });
tryDraft("productionPlans[0].desiredQuantity = null", (d) => { pp(d)[0].desiredQuantity = null; });
tryDraft("productionPlans[0].desiredQuantity = -9999", (d) => { pp(d)[0].desiredQuantity = -9999; });
tryDraft("workerAssignments[0].regularHeadcount = -100", (d) => { wa(d)[0].regularHeadcount = -100; });
tryDraft("workerAssignments[0].overtimeRate = 99", (d) => { wa(d)[0].overtimeRate = 99; });
tryDraft("salesForceHireCount = 999999（採用上限超過）", (d) => { (d as Record<string, unknown>).salesForceHireCount = 999999; });
tryDraft("dividendAmountUsd = -1000000（負の配当）", (d) => { (d as Record<string, unknown>).dividendAmountUsd = -1000000; });
