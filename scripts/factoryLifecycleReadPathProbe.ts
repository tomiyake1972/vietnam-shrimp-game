// 検証専用プローブ（#04 Factory Lifecycle Read-Path Consistency）。
// Engine / Standard AI / series / AI Pack / Player VM 3本 の実効能力を同一 state で並べる。
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../app/lib/v2/companyLab/autoPolicy";
import { buildStandardAiObservation } from "../app/lib/v2/companyLab/standardAi/observation";
import { computeEffectiveFactories } from "../app/lib/v2/capex/factoryConstruction";
import { calculateFactoryEffectiveCapacity } from "../app/lib/v2/production/capacity";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { CompanyDecisionInput, CompanyFixture, CompanyLabState } from "../app/lib/v2/companyLab/types";
import { buildCompanyInspectorSnapshot } from "../app/lib/v2/companyLab/simulation/series";
import { captureCompanyStateSnapshot } from "../app/lib/v2/companyLab/simulation/aiPack/capture";
import { buildCompanyProcessingCapacityViewModel } from "../app/v2/company-lab/processingCapacityViewModel";
import { buildCompanyProcessingForecast } from "../app/v2/company-lab/processingForecastViewModel";
import { buildCompanyInvestmentPlanningViewModel } from "../app/v2/company-lab/investmentPlanningViewModel";

const mode = process.argv[2] ?? "mothball"; // mothball | sale | reactivate | none
const turns = Number(process.argv[3] ?? 6);

function withSecondFactory(fixtures: readonly CompanyFixture[], companyId: string): CompanyFixture[] {
  return fixtures.map((f) => {
    if (f.companyId !== companyId) return { ...f };
    const f1 = f.factories[0];
    return { ...f, factories: [f1, { ...f1, factoryId: `${companyId}-F2` }] };
  });
}

const init = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "readpath-probe", turns });
const target = init.fixtures[0].companyId;
const fixtures = mode === "none" ? init.fixtures.map((f) => ({ ...f })) : withSecondFactory(init.fixtures, target);
const f2 = `${target}-F2`;
const lifecycleByTurn: Record<number, CompanyDecisionInput["factoryLifecycleDecisions"]> = {};
if (mode === "mothball") lifecycleByTurn[2] = [{ type: "MOTHBALL_FACTORY", factoryId: f2 }];
if (mode === "sale") lifecycleByTurn[2] = [{ type: "SELL_FACTORY", factoryId: f2 }];
if (mode === "reactivate") {
  lifecycleByTurn[2] = [{ type: "MOTHBALL_FACTORY", factoryId: f2 }];
  lifecycleByTurn[4] = [{ type: "REACTIVATE_FACTORY", factoryId: f2 }];
}

const n = (v: number) => Math.round(v).toString().padStart(7);
console.log(`mode=${mode} target=${target}`);
console.log(["turn", "engine", "stdAI", "series", "aiPack", "capVM", "fcstVM", "planVM", "vmFactories", "spaceUnits"].join("\t"));

let state: CompanyLabState = init.state;
const baseFactories = fixtures.flatMap((f) => f.factories);
for (let turn = 1; turn <= turns; turn++) {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, turn);

  if (turn > 1) {
    const fixture = fixtures.find((f) => f.companyId === target)!;
    const own = buildCompanyOwnState(state, fixture);
    const eff = computeEffectiveFactories(baseFactories, state.capexState, state.currentPeriod, state.factoryLifecycleState).filter(
      (f) => f.companyId === target
    );
    const engine = eff.reduce((s, f) => s + unwrapUnit(calculateFactoryEffectiveCapacity(f).commonProcessing), 0);
    const obs = buildStandardAiObservation(fixture, own, publicInfo, state.currentPeriod, turn);
    const inspector = buildCompanyInspectorSnapshot(state, target, fixtures);
    const pack = captureCompanyStateSnapshot(state, fixture);
    const capexStateForCompany = { companies: [own.capexState] };
    const capVM = buildCompanyProcessingCapacityViewModel({
      companyId: target,
      baseFactories: fixture.factories,
      capexState: capexStateForCompany,
      period: state.currentPeriod,
      factoryLifecycleState: own.factoryLifecycleState,
    });
    const fcst = buildCompanyProcessingForecast({
      companyId: target,
      baseFactories: fixture.factories,
      capexState: capexStateForCompany,
      period: state.currentPeriod,
      factoryLifecycleState: own.factoryLifecycleState,
      productionPlans: [],
      workerAssignments: [],
      rawMaterialLots: own.rawMaterialLots,
    });
    const plan = buildCompanyInvestmentPlanningViewModel({
      companyId: target,
      baseFactories: fixture.factories,
      capexState: capexStateForCompany,
      period: state.currentPeriod,
      factoryLifecycleState: own.factoryLifecycleState,
      productionPlans: [],
      workerAssignments: [],
      workforceState: own.workforceState,
      rawMaterialLots: own.rawMaterialLots,
      finishedGoodsLots: own.finishedGoodsLots,
    });
    const poolOf = (rows: readonly { poolKey: string; currentEffectiveTons: number }[]) =>
      rows.find((r) => r.poolKey === "commonProcessing")?.currentEffectiveTons ?? 0;
    const rateOf = (rows: readonly { poolKey: string; effectiveTons: number }[]) =>
      rows.find((r) => r.poolKey === "commonProcessing")?.effectiveTons ?? 0;
    console.log(
      [
        turn,
        n(engine),
        n(obs.totalEffectiveCommonProcessingCapacity),
        n(inspector?.commonCapacity ?? 0),
        n(pack.commonProcessingCapacityTons ?? 0),
        n(poolOf(capVM.companyTotals)),
        n(rateOf(fcst.companyRateTable.rows)),
        n(rateOf(plan.forecast.companyRateTable.rows)),
        String(capVM.factories.length).padStart(11),
        n(plan.factorySpace.totalSpaceUnits),
      ].join("\t")
    );
  }
  const lc = lifecycleByTurn[turn];
  if (lc) decisions[target] = { ...decisions[target], factoryLifecycleDecisions: lc };
  state = advanceCompanyLabQuarter(state, fixtures, decisions);
}
