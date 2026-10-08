import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo } from "../../app/lib/v2/companyLab";
import { generateStandardAiDecision } from "../../app/lib/v2/companyLab/standardAi/policy";
import { buildInitialDraft } from "../../app/v2/company-lab/decisionDraft";
const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "probe", turns: 6 });
const fixture = fixtures.find((f) => f.companyId === "BAL")!;
const ownState = buildCompanyOwnState(state, fixture);
const ai = generateStandardAiDecision(fixture, ownState, buildPublicMarketInfo(state), state.currentPeriod, 1);
const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
console.log("top-level keys:", Object.keys(draft).join(", "));
const d = draft as unknown as Record<string, unknown>;
for (const k of Object.keys(d)) {
  const v = d[k];
  if (Array.isArray(v)) console.log(`  ${k}: Array(${v.length}) first=${JSON.stringify(v[0])?.slice(0,200)}`);
  else if (v !== null && typeof v === "object") console.log(`  ${k}: object keys=${Object.keys(v as object).join(",")}`);
  else console.log(`  ${k}: ${JSON.stringify(v)}`);
}
