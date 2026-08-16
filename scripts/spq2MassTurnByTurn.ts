// SP-Q2 §5: MASS OFF vs 単一軸variantのTurn-by-Turn比較（最初の分岐点を確定する）
//
// 使い方: npx tsx scripts/spq2MassTurnByTurn.ts <scenario> <seed> <variant>
//   variant: importMix | marketOrientation | productOrientation | full

import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo, advanceCompanyLabQuarter } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { CompanyLabConfig, CompanyLabState, CompanyDecisionInput, CompanyFixture } from "../app/lib/v2/companyLab/types";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "../app/lib/v2/companyLab/standardAi/parameters";
import { MANAGEMENT_PROFILES } from "../app/lib/v2/companyLab/standardAi/managementProfile";
import { COMPANY_ORIENTATION_PROFILES } from "../app/lib/v2/companyLab/standardAi/orientationProfile";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";

const scenario = process.argv[2] ?? "baseline";
const seed = process.argv[3] ?? "seed-1";
const variantName = process.argv[4] ?? "importMix";

const growth = MANAGEMENT_PROFILES.growth;
const chinaVolume = COMPANY_ORIENTATION_PROFILES.chinaVolume;

const VARIANTS: Record<string, StandardAiParameters> = {
  importMix: { ...STANDARD_AI_PARAMETERS_V1, importMixRatio: STANDARD_AI_PARAMETERS_V1.importMixRatio * (1 + growth.importRelianceRatio) },
  marketOrientation: { ...STANDARD_AI_PARAMETERS_V1, marketOrientationMultipliers: chinaVolume.marketMultipliers },
  productOrientation: { ...STANDARD_AI_PARAMETERS_V1, productOrientationMultipliers: chinaVolume.productMultipliers },
  full: {
    ...STANDARD_AI_PARAMETERS_V1,
    salesUtilizationTarget: STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget * (1 + growth.salesAggressivenessRatio),
    maxDiscountRatioForExcessStock: STANDARD_AI_PARAMETERS_V1.maxDiscountRatioForExcessStock * (1 + growth.discountToleranceRatio),
    importMixRatio: STANDARD_AI_PARAMETERS_V1.importMixRatio * (1 + growth.importRelianceRatio),
    regularHeadcountAdjustmentDamping: STANDARD_AI_PARAMETERS_V1.regularHeadcountAdjustmentDamping * (1 + growth.headcountPaceRatio),
    marketOrientationMultipliers: chinaVolume.marketMultipliers,
    productOrientationMultipliers: chinaVolume.productMultipliers,
  },
};

function baseConfig(): CompanyLabConfig {
  return { scenarioId: scenario, mode: "canonical", seed, turns: MANAGEMENT_CONSOLE_STANDARD_TURNS };
}

interface TurnSnapshot {
  turn: number;
  domesticDesired: number;
  importDesired: number;
  importActual: number;
  domesticActual: number;
  rawMaterialInventory: number;
  requiredRawMaterial: number;
  productionReq: { hoso: number; pd: number; vap: number };
  productionActual: { hoso: number; pd: number; vap: number };
  cash: number;
  debt: number;
  scaleRatio: number | null;
  importOrdersBlocked: boolean | null;
  underwritingFrozen: boolean | null;
  financialHealth: string | null;
  crisisState: string;
  salesHireCount: number;
}

function runAndSnapshot(params: StandardAiParameters): TurnSnapshot[] {
  const { state: initState, fixtures } = initializeCompanyLab(baseConfig());
  let state: CompanyLabState = initState;
  const snapshots: TurnSnapshot[] = [];

  for (let turn = 1; turn <= MANAGEMENT_CONSOLE_STANDARD_TURNS; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    let massDecision: CompanyDecisionInput | null = null;
    let massDiagCrisis = "NORMAL";
    for (const fixture of fixtures as readonly CompanyFixture[]) {
      const ownState = buildCompanyOwnState(state, fixture);
      const isMass = fixture.companyId === "MASS";
      const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(
        fixture,
        ownState,
        publicInfo,
        state.currentPeriod,
        turn,
        isMass ? params : STANDARD_AI_PARAMETERS_V1
      );
      decisions[fixture.companyId] = decision;
      if (isMass) {
        massDecision = decision;
        massDiagCrisis = diagnostics.crisis?.state ?? "NORMAL";
      }
    }
    const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = nextState.history[nextState.history.length - 1];
    const summary = record.companySummaries.find((s) => s.companyId === "MASS");
    const fin = record.financialResults.find((f) => f.companyId === "MASS");
    const financing = record.financingResults.find((f) => f.companyId === "MASS");
    const prodPlans = massDecision?.productionPlans.filter((p) => p.companyId === "MASS") ?? [];
    const prodReq = { hoso: 0, pd: 0, vap: 0 };
    for (const p of prodPlans) prodReq[p.product] += Number(p.desiredQuantity);

    snapshots.push({
      turn,
      domesticDesired: Number(massDecision?.domesticPurchasePlan.desiredQuantity ?? 0),
      importDesired: massDecision?.importOrders.reduce((s, o) => s + Number(o.orderedQuantity), 0) ?? 0,
      importActual: Number(summary?.importArrivedQuantity ?? 0) + Number(summary?.importInTransitQuantity ?? 0),
      domesticActual: Number(summary?.domesticPurchaseQuantity ?? 0),
      rawMaterialInventory: Number(summary?.rawMaterialInventory ?? 0),
      requiredRawMaterial: prodReq.hoso + prodReq.pd + prodReq.vap,
      productionReq: prodReq,
      productionActual: { hoso: Number(summary?.hosoProduced ?? 0), pd: Number(summary?.pdProduced ?? 0), vap: Number(summary?.vapProduced ?? 0) },
      cash: fin ? Number(fin.balanceSheet.cash) : NaN,
      debt: fin ? Number(fin.balanceSheet.shortTermLoans) + Number(fin.balanceSheet.longTermLoans) : NaN,
      scaleRatio: financing?.procurementConstraint?.scaleRatio ?? null,
      importOrdersBlocked: financing?.procurementConstraint?.importOrdersBlocked ?? null,
      underwritingFrozen: financing?.borrowingCapacity.underwritingFrozen ?? null,
      financialHealth: financing?.financialHealth.primary ?? null,
      crisisState: massDiagCrisis,
      salesHireCount: Number(massDecision?.salesForceHireCount ?? 0),
    });
    state = nextState;
  }
  return snapshots;
}

async function main() {
  console.log(`=== MASS OFF vs ${variantName} — ${scenario}/${seed} ===\n`);
  const off = runAndSnapshot(STANDARD_AI_PARAMETERS_V1);
  const on = runAndSnapshot(VARIANTS[variantName]);

  console.log(
    "turn | OFF: domD/impD/impA/domA rawInv reqRaw prod(h/p/v) cash debt scaleR blocked frozen health crisis | ON: (same)"
  );
  for (let i = 0; i < off.length; i++) {
    const o = off[i];
    const n = on[i];
    const fmt = (s: TurnSnapshot) =>
      `domD=${s.domesticDesired.toFixed(0)} impD=${s.importDesired.toFixed(0)} impA=${s.importActual.toFixed(0)} domA=${s.domesticActual.toFixed(0)} rawInv=${s.rawMaterialInventory.toFixed(0)} reqRaw=${s.requiredRawMaterial.toFixed(0)} prod=${s.productionActual.hoso.toFixed(0)}/${s.productionActual.pd.toFixed(0)}/${s.productionActual.vap.toFixed(0)} cash=${(s.cash / 1e6).toFixed(1)}M debt=${(s.debt / 1e6).toFixed(1)}M scaleR=${s.scaleRatio?.toFixed(3) ?? "?"} blocked=${s.importOrdersBlocked ?? "?"} frozen=${s.underwritingFrozen ?? "?"} health=${s.financialHealth ?? "?"} crisis=${s.crisisState} hires=${s.salesHireCount}`;
    const diverged =
      o.crisisState !== n.crisisState || Math.abs(o.cash - n.cash) > 1e6 || o.importOrdersBlocked !== n.importOrdersBlocked;
    console.log(`T${o.turn}${diverged ? " *** DIVERGED ***" : ""}`);
    console.log(`  OFF: ${fmt(o)}`);
    console.log(`  ON:  ${fmt(n)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
