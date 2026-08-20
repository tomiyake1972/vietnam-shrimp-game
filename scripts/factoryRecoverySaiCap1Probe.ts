// 検証専用プローブ（#04 Factory Recovery × SAI-CAP-1 統合検証）。
// Standard AI が Factory lifecycle 後の実効能力をどう認識しているかを実測する。
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { buildStandardAiObservation } from "../app/lib/v2/companyLab/standardAi/observation";
import { computePhysicalCapacity } from "../app/lib/v2/companyLab/standardAi/bindingCapacity";
import { PRODUCTION_PARAMETERS_V1 } from "../app/lib/v2/production/parameters";
import { computeEffectiveFactories } from "../app/lib/v2/capex/factoryConstruction";
import { calculateFactoryEffectiveCapacity } from "../app/lib/v2/production/capacity";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { CompanyDecisionInput, CompanyFixture, CompanyLabState } from "../app/lib/v2/companyLab/types";

function withSecondFactory(fixtures: readonly CompanyFixture[], companyId: string): CompanyFixture[] {
  return fixtures.map((f) => {
    if (f.companyId !== companyId) return { ...f };
    const f1 = f.factories[0];
    return { ...f, factories: [f1, { ...f1, factoryId: `${companyId}-F2` }] };
  });
}

const scenarioArg = process.argv[2] ?? "baseline";
const modeArg = process.argv[3] ?? "mothball"; // mothball | sale | reactivate | none
const turns = Number(process.argv[4] ?? 6);

const init = initializeCompanyLab({ scenarioId: scenarioArg, mode: "canonical", seed: "factrec-saicap1-probe", turns });
const target = init.fixtures[0].companyId;
const fixtures = modeArg === "none" ? init.fixtures.map((f) => ({ ...f })) : withSecondFactory(init.fixtures, target);
const f2 = `${target}-F2`;

const lifecycleByTurn: Record<number, CompanyDecisionInput["factoryLifecycleDecisions"]> = {};
if (modeArg === "mothball") lifecycleByTurn[2] = [{ type: "MOTHBALL_FACTORY", factoryId: f2 }];
if (modeArg === "reactivate") {
  lifecycleByTurn[2] = [{ type: "MOTHBALL_FACTORY", factoryId: f2 }];
  lifecycleByTurn[4] = [{ type: "REACTIVATE_FACTORY", factoryId: f2 }];
}
if (modeArg === "sale") lifecycleByTurn[2] = [{ type: "SELL_FACTORY", factoryId: f2 }];

let state: CompanyLabState = init.state;
const baseFactories = fixtures.flatMap((f) => f.factories);

console.log(`scenario=${scenarioArg} mode=${modeArg} target=${target} f2=${f2}`);
console.log(
  [
    "turn",
    "engineFactories(status)",
    "engineBindingTons",
    "aiFactoryCount",
    "aiLineTons",
    "aiCommonTons",
    "aiFreezeTons",
    "aiBindingTons",
    "aiBindingPool",
    "aiNearTermBindingTons",
    "prospectiveFactoryCount",
    "capexProposalTypes",
    "newFactoryStatus",
  ].join("\t")
);

for (let turn = 1; turn <= turns; turn++) {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  let line = "";
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    const out = generateStandardAiDecisionWithDiagnostics(f, own, publicInfo, state.currentPeriod, turn);
    decisions[f.companyId] = out.decision;
    if (f.companyId !== target) continue;

    const engineFactories = computeEffectiveFactories(baseFactories, state.capexState, state.currentPeriod, state.factoryLifecycleState).filter(
      (x) => x.companyId === target
    );
    let eLine = 0;
    let eCommon = 0;
    let eFreeze = 0;
    const byProduct = { hoso: 0, pd: 0, vap: 0 };
    for (const fac of engineFactories) {
      const c = calculateFactoryEffectiveCapacity(fac);
      byProduct.hoso += unwrapUnit(c.hoso);
      byProduct.pd += unwrapUnit(c.pd);
      byProduct.vap += unwrapUnit(c.vap);
      eCommon += unwrapUnit(c.commonProcessing);
      eFreeze += unwrapUnit(c.freezingPackaging);
    }
    eLine = byProduct.hoso + byProduct.pd + byProduct.vap;
    const enginePhysical = computePhysicalCapacity({
      effectiveCapacityByProduct: byProduct,
      commonProcessingInputCapacityTons: eCommon,
      freezingPackagingCapacityTons: eFreeze,
      saleableRecoveryRatioByProduct: PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio,
    });

    const obs = buildStandardAiObservation(f, own, publicInfo, state.currentPeriod, turn);
    const aiPhysical = computePhysicalCapacity({
      effectiveCapacityByProduct: obs.totalEffectiveCapacityByProduct,
      commonProcessingInputCapacityTons: obs.totalEffectiveCommonProcessingCapacity,
      freezingPackagingCapacityTons: obs.totalEffectiveFreezingPackagingCapacity,
      saleableRecoveryRatioByProduct: PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio,
    });
    const aiNearTerm = computePhysicalCapacity({
      effectiveCapacityByProduct: obs.nearTermEffectiveCapacityByProduct,
      commonProcessingInputCapacityTons: obs.nearTermEffectiveCommonProcessingCapacity,
      freezingPackagingCapacityTons: obs.nearTermEffectiveFreezingPackagingCapacity,
      saleableRecoveryRatioByProduct: PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio,
    });
    const aiLine =
      obs.totalEffectiveCapacityByProduct.hoso + obs.totalEffectiveCapacityByProduct.pd + obs.totalEffectiveCapacityByProduct.vap;

    void eLine;
    line = [
      turn,
      engineFactories.map((x) => `${x.factoryId}:${x.status}`).join(","),
      enginePhysical.bindingPhysicalCapacityTons.toFixed(1),
      obs.factories.length,
      aiLine.toFixed(1),
      obs.totalEffectiveCommonProcessingCapacity.toFixed(1),
      obs.totalEffectiveFreezingPackagingCapacity.toFixed(1),
      aiPhysical.bindingPhysicalCapacityTons.toFixed(1),
      aiPhysical.bindingPhysicalPool,
      aiNearTerm.bindingPhysicalCapacityTons.toFixed(1),
      obs.prospectiveFactoryCount,
      (out.decision.capexDecision?.newProjectProposals ?? []).map((x) => x.projectType).join("|") || "-",
      out.diagnostics.newFactoryAssessment?.status ?? "-",
    ].join("\t");
  }
  const lc = lifecycleByTurn[turn];
  if (lc) decisions[target] = { ...decisions[target], factoryLifecycleDecisions: lc };
  console.log(line);
  state = advanceCompanyLabQuarter(state, fixtures, decisions);
}
