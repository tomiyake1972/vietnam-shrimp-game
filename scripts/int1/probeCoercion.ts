/** 【INT-1 §6】buildDecisionInputFromDraft が無効値をどう扱うかの実測（クランプか素通しか）。 */
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo } from "../../app/lib/v2/companyLab";
import { generateStandardAiDecision } from "../../app/lib/v2/companyLab/standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../../app/v2/company-lab/decisionDraft";

const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "coerce", turns: 6 });
const fixture = fixtures.find((f) => f.companyId === "BAL")!;
const ownState = buildCompanyOwnState(state, fixture);
const ai = generateStandardAiDecision(fixture, ownState, buildPublicMarketInfo(state), state.currentPeriod, 1);
const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);

function show(label: string, mutate: (d: unknown) => void, pick: (dec: unknown) => unknown): void {
  const copy = JSON.parse(JSON.stringify(draft));
  mutate(copy);
  const dec = buildDecisionInputFromDraft(JSON.parse(JSON.stringify(copy)), fixture, state.currentPeriod);
  console.log(`${label}\n    → decision側の値: ${JSON.stringify(pick(dec))}`);
}
const base = buildDecisionInputFromDraft(JSON.parse(JSON.stringify(draft)), fixture, state.currentPeriod);
const findPlan = (dec: unknown) => (dec as { salesPlans: { market: string; product: string; desiredQuantity: unknown }[] }).salesPlans.find((p) => p.market === "CN" && p.product === "hoso");
const findProd = (dec: unknown) => (dec as { productionPlans: { factoryId: string; product: string; desiredQuantity: unknown }[] }).productionPlans.find((p) => p.product === "hoso");
const findWa = (dec: unknown) => (dec as { workerAssignments: { regularHeadcount: unknown; temporaryHeadcount: unknown; overtimeRate: unknown }[] }).workerAssignments[0];
const sp = (d: unknown) => (d as { salesPlans: Record<string, unknown>[] }).salesPlans;
const pp = (d: unknown) => (d as { productionPlans: Record<string, unknown>[] }).productionPlans;
const wa = (d: unknown) => (d as { workerAssignments: Record<string, unknown>[] }).workerAssignments;

console.log(`無改変の基準値:\n    salesPlans(CN,hoso)=${JSON.stringify(findPlan(base))}\n    productionPlans(hoso).desiredQuantity=${JSON.stringify(findProd(base)?.desiredQuantity)}\n    workerAssignments[0]=${JSON.stringify(findWa(base))}\n    dividendDecision=${JSON.stringify((base as { dividendDecision?: unknown }).dividendDecision)}\n`);
show("salesPlans[0].desiredQuantity = null", (d) => { sp(d)[0].desiredQuantity = null; }, (dec) => findPlan(dec));
show("salesPlans[0].desiredQuantity = -5000", (d) => { sp(d)[0].desiredQuantity = -5000; }, (dec) => findPlan(dec));
show('salesPlans[0].desiredQuantity = "abc"', (d) => { sp(d)[0].desiredQuantity = "abc"; }, (dec) => findPlan(dec));
show("productionPlans[0].desiredQuantity = -9999", (d) => { pp(d)[0].desiredQuantity = -9999; }, (dec) => findProd(dec)?.desiredQuantity);
show("workerAssignments[0].regularHeadcount = -100", (d) => { wa(d)[0].regularHeadcount = -100; }, (dec) => findWa(dec));
show("workerAssignments[0].overtimeRate = 99", (d) => { wa(d)[0].overtimeRate = 99; }, (dec) => findWa(dec));
show("dividendAmountUsd = -1000000", (d) => { (d as Record<string, unknown>).dividendAmountUsd = -1000000; }, (dec) => (dec as { dividendDecision?: unknown }).dividendDecision);
show("dividendAmountUsd = null", (d) => { (d as Record<string, unknown>).dividendAmountUsd = null; }, (dec) => (dec as { dividendDecision?: unknown }).dividendDecision);
