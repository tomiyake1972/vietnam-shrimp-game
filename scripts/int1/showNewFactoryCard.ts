/** 【INT-1 §6】修正後の新工場建設カード文言を実測で確認するだけの読み取り専用スクリプト。 */
import { buildCompanyOwnState, buildPublicMarketInfo, generateAutoPolicyDecision, initializeCompanyLab } from "../../app/lib/v2/companyLab";
import { CAPEX_PARAMETERS_V1 } from "../../app/lib/v2/capex";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../../app/v2/company-lab/decisionDraft";
import { buildCompanyInvestmentPlanningViewModel } from "../../app/v2/company-lab/investmentPlanningViewModel";

const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "int1-show-card", turns: 6 });
const fixture = fixtures.find((f) => f.companyId === "BAL")!;
const ownState = buildCompanyOwnState(state, fixture);
const auto = generateAutoPolicyDecision(fixture, ownState, buildPublicMarketInfo(state), state.currentPeriod, 1);
const draft = buildInitialDraft(fixture, auto, ownState.workforceState);
const decisionInput = buildDecisionInputFromDraft(draft, fixture, state.currentPeriod);
const planning = buildCompanyInvestmentPlanningViewModel({
  companyId: fixture.companyId,
  baseFactories: fixture.factories,
  capexState: { companies: [ownState.capexState] },
  period: state.currentPeriod,
  productionPlans: decisionInput.productionPlans,
  workerAssignments: decisionInput.workerAssignments,
  workforceState: ownState.workforceState,
  rawMaterialLots: ownState.rawMaterialLots,
  finishedGoodsLots: ownState.finishedGoodsLots,
  capexParams: CAPEX_PARAMETERS_V1,
});
for (const t of ["newFactoryConstruction", "qualityControlEquipment", "pdMechanization"] as const) {
  const c = planning.investmentCards.find((x) => x.projectType === t)!;
  console.log(`\n--- ${t} ---\n${c.noEffectReason ?? "(noEffectReason なし)"}`);
}
