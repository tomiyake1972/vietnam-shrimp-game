// 検証専用: Export（加工能力セクション）の実効能力を Engine / Player VM と並べて出力する。
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../app/lib/v2/companyLab/autoPolicy";
import { computeEffectiveFactories } from "../app/lib/v2/capex/factoryConstruction";
import { calculateFactoryEffectiveCapacity } from "../app/lib/v2/production/capacity";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { CompanyDecisionInput, CompanyFixture, CompanyLabState } from "../app/lib/v2/companyLab/types";
import { createCompanyLabRuntimeSnapshot } from "../app/lib/v2/companyLab/persistence/snapshot";
import { buildExportProcessingCapacity } from "../app/api/v2/exports/_lib/dto/processingCapacityDto";
import { buildCompanyProcessingCapacityViewModel } from "../app/v2/company-lab/processingCapacityViewModel";

const mode = process.argv[2] ?? "mothball";
const turns = Number(process.argv[3] ?? 6);
const dumpJson = process.argv[4] === "json";

function withSecondFactory(fixtures: readonly CompanyFixture[], companyId: string): CompanyFixture[] {
  return fixtures.map((f) => {
    if (f.companyId !== companyId) return { ...f };
    const f1 = f.factories[0];
    return { ...f, factories: [f1, { ...f1, factoryId: `${companyId}-F2` }] };
  });
}

const init = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "export-probe", turns });
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

const pad = (v: number) => Math.round(v).toString().padStart(7);
if (!dumpJson) {
  console.log(`mode=${mode} target=${target}`);
  console.log(["turn", "engine", "playerVM", "export", "exportFactories", "exportStatuses"].join("\t"));
}

let state: CompanyLabState = init.state;
for (let turn = 1; turn <= turns; turn++) {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, turn);

  const fixture = fixtures.find((f) => f.companyId === target)!;
  const own = buildCompanyOwnState(state, fixture);
  const snapshot = createCompanyLabRuntimeSnapshot(state);
  const engine = computeEffectiveFactories(
    fixtures.flatMap((f) => f.factories),
    state.capexState,
    state.currentPeriod,
    state.factoryLifecycleState
  )
    .filter((f) => f.companyId === target)
    .reduce((s, f) => s + unwrapUnit(calculateFactoryEffectiveCapacity(f).commonProcessing), 0);
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: target,
    baseFactories: fixture.factories,
    capexState: { companies: [own.capexState] },
    period: state.currentPeriod,
    factoryLifecycleState: own.factoryLifecycleState,
  });
  const exported = buildExportProcessingCapacity({
    companyId: target,
    fixtures,
    capexState: snapshot.capexState,
    asOfPeriod: snapshot.currentPeriod,
    pdMechanizationState: snapshot.pdMechanizationState,
    factoryLifecycleState: snapshot.factoryLifecycleState,
  });
  const commonOf = (rows: readonly { poolKey: string; currentEffectiveTons: number }[]) =>
    rows.find((r) => r.poolKey === "commonProcessing")?.currentEffectiveTons ?? 0;
  if (dumpJson) {
    console.log(`T${turn}\t${JSON.stringify(exported)}`);
  } else {
    console.log(
      [
        turn,
        pad(engine),
        pad(commonOf(vm.companyTotals)),
        pad(commonOf(exported.companyTotals)),
        String(exported.factories.length).padStart(15),
        exported.factories.map((f) => `${f.factoryId}:${f.status}`).join(","),
      ].join("\t")
    );
  }
  const lc = lifecycleByTurn[turn];
  if (lc) decisions[target] = { ...decisions[target], factoryLifecycleDecisions: lc };
  state = advanceCompanyLabQuarter(state, fixtures, decisions);
}
