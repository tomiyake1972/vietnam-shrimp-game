// SP-Q2 §4-6: MASS PROFILE ON逆方向結果のroot cause分離
//
// MASS growth(ManagementProfile) + chinaVolume(OrientationProfile) を構成要素へ分解し、
// 1軸ずつ有効化したparamsで32Qを実行、OFF基準からのKPI変化を比較する。
// 「複合効果」で終わらせず、寄与順序を確定させる。
//
// 使い方: npx tsx scripts/spq2MassAblation.ts <scenario> <seed>

import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { STANDARD_AI_PARAMETERS_V1 } from "../app/lib/v2/companyLab/standardAi/parameters";
import { StandardAiParameters } from "../app/lib/v2/companyLab/standardAi/parameters";
import { MANAGEMENT_PROFILES } from "../app/lib/v2/companyLab/standardAi/managementProfile";
import { COMPANY_ORIENTATION_PROFILES } from "../app/lib/v2/companyLab/standardAi/orientationProfile";

const scenario = process.argv[2] ?? "baseline";
const seed = process.argv[3] ?? "seed-1";

const growth = MANAGEMENT_PROFILES.growth;
const chinaVolume = COMPANY_ORIENTATION_PROFILES.chinaVolume;

// --- 各軸を個別に有効化したparams variants ---
const VARIANTS: Record<string, StandardAiParameters> = {
  OFF: STANDARD_AI_PARAMETERS_V1,
  "A_marketOrientation_only": {
    ...STANDARD_AI_PARAMETERS_V1,
    marketOrientationMultipliers: chinaVolume.marketMultipliers,
  },
  "B_productOrientation_only": {
    ...STANDARD_AI_PARAMETERS_V1,
    productOrientationMultipliers: chinaVolume.productMultipliers,
  },
  "C_importMixRatio_only": {
    ...STANDARD_AI_PARAMETERS_V1,
    importMixRatio: STANDARD_AI_PARAMETERS_V1.importMixRatio * (1 + growth.importRelianceRatio),
  },
  "D_salesAggressiveness_only": {
    ...STANDARD_AI_PARAMETERS_V1,
    salesUtilizationTarget: STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget * (1 + growth.salesAggressivenessRatio),
  },
  "E_discountTolerance_only": {
    ...STANDARD_AI_PARAMETERS_V1,
    maxDiscountRatioForExcessStock: STANDARD_AI_PARAMETERS_V1.maxDiscountRatioForExcessStock * (1 + growth.discountToleranceRatio),
  },
  "F_headcountPace_only": {
    ...STANDARD_AI_PARAMETERS_V1,
    regularHeadcountAdjustmentDamping: STANDARD_AI_PARAMETERS_V1.regularHeadcountAdjustmentDamping * (1 + growth.headcountPaceRatio),
  },
  "G_both_orientation_only": {
    ...STANDARD_AI_PARAMETERS_V1,
    marketOrientationMultipliers: chinaVolume.marketMultipliers,
    productOrientationMultipliers: chinaVolume.productMultipliers,
  },
  "H_management_profile_only": {
    ...STANDARD_AI_PARAMETERS_V1,
    salesUtilizationTarget: STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget * (1 + growth.salesAggressivenessRatio),
    maxDiscountRatioForExcessStock: STANDARD_AI_PARAMETERS_V1.maxDiscountRatioForExcessStock * (1 + growth.discountToleranceRatio),
    importMixRatio: STANDARD_AI_PARAMETERS_V1.importMixRatio * (1 + growth.importRelianceRatio),
    regularHeadcountAdjustmentDamping: STANDARD_AI_PARAMETERS_V1.regularHeadcountAdjustmentDamping * (1 + growth.headcountPaceRatio),
  },
  "ON_full_combined": {
    ...STANDARD_AI_PARAMETERS_V1,
    salesUtilizationTarget: STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget * (1 + growth.salesAggressivenessRatio),
    maxDiscountRatioForExcessStock: STANDARD_AI_PARAMETERS_V1.maxDiscountRatioForExcessStock * (1 + growth.discountToleranceRatio),
    importMixRatio: STANDARD_AI_PARAMETERS_V1.importMixRatio * (1 + growth.importRelianceRatio),
    regularHeadcountAdjustmentDamping: STANDARD_AI_PARAMETERS_V1.regularHeadcountAdjustmentDamping * (1 + growth.headcountPaceRatio),
    marketOrientationMultipliers: chinaVolume.marketMultipliers,
    productOrientationMultipliers: chinaVolume.productMultipliers,
  },
};

// engine.ts uses its own internal profile resolver, so to test arbitrary custom
// params variants we bypass createSimulationSession's standardAiProfileMode and
// instead call generateStandardAiDecisionWithDiagnostics directly, replicating a
// minimal turn loop for MASS only (single-company diagnostic, not full 5-company sim).
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo, advanceCompanyLabQuarter } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { CompanyLabConfig, CompanyLabState, CompanyDecisionInput } from "../app/lib/v2/companyLab/types";
import { CompanyFixture } from "../app/lib/v2/companyLab/types";

function baseConfig(): CompanyLabConfig {
  return { scenarioId: scenario, mode: "canonical", seed, turns: MANAGEMENT_CONSOLE_STANDARD_TURNS };
}

interface RunResult {
  endingCash: number;
  endingDebt: number;
  endingOP: number;
  totalCapexPaidUsd: number;
  salesHiresTotal: number;
  crisisQuarters: number;
  hosoProdCum: number;
  pdProdCum: number;
  vapProdCum: number;
}

function runVariant(params: StandardAiParameters, turnsToRun: number): RunResult {
  const { state: initState, fixtures } = initializeCompanyLab(baseConfig());
  let state: CompanyLabState = initState;
  let cash = 0;
  let debt = 0;
  let opCum = 0;
  let capexCum = 0;
  let hiresCum = 0;
  let crisisQ = 0;
  let hosoCum = 0;
  let pdCum = 0;
  let vapCum = 0;

  for (let turn = 1; turn <= turnsToRun; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
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
        hiresCum += Number(decision.salesForceHireCount ?? 0);
        const crisisState = diagnostics.crisis?.state ?? "NORMAL";
        if (crisisState !== "NORMAL") crisisQ++;
      }
    }
    const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = nextState.history[nextState.history.length - 1];
    const massSummary = record.companySummaries.find((s) => s.companyId === "MASS");
    const massFin = record.financialResults.find((f) => f.companyId === "MASS");
    const massCapex = record.capexResults.find((c) => c.companyId === "MASS");
    if (massSummary) {
      hosoCum += Number(massSummary.hosoProduced);
      pdCum += Number(massSummary.pdProduced);
      vapCum += Number(massSummary.vapProduced);
    }
    if (massFin) {
      cash = Number(massFin.balanceSheet.cash);
      debt = Number(massFin.balanceSheet.shortTermLoans) + Number(massFin.balanceSheet.longTermLoans);
      opCum += Number(massFin.profitAndLoss.operatingProfit);
    }
    if (massCapex) {
      for (const e of massCapex.events) capexCum += e.paymentSucceededUsd;
    }
    state = nextState;
  }

  return {
    endingCash: cash,
    endingDebt: debt,
    endingOP: opCum,
    totalCapexPaidUsd: capexCum,
    salesHiresTotal: hiresCum,
    crisisQuarters: crisisQ,
    hosoProdCum: hosoCum,
    pdProdCum: pdCum,
    vapProdCum: vapCum,
  };
}

async function main() {
  console.log(`=== MASS ablation: ${scenario}/${seed} (32Q) ===\n`);
  const results: Record<string, RunResult> = {};
  for (const [name, params] of Object.entries(VARIANTS)) {
    console.log(`Running variant: ${name}...`);
    results[name] = runVariant(params, MANAGEMENT_CONSOLE_STANDARD_TURNS);
  }

  const off = results.OFF;
  console.log(`\n${"variant".padEnd(28)} cash($M)  debt($M)  OP($M)   capex($M) hires  crisisQ  hosoProd  pdProd  vapProd`);
  for (const [name, r] of Object.entries(results)) {
    console.log(
      `${name.padEnd(28)} ${(r.endingCash / 1e6).toFixed(1).padStart(8)} ${(r.endingDebt / 1e6).toFixed(1).padStart(8)} ${(r.endingOP / 1e6).toFixed(1).padStart(7)} ${(r.totalCapexPaidUsd / 1e6).toFixed(1).padStart(9)} ${String(r.salesHiresTotal).padStart(5)} ${String(r.crisisQuarters).padStart(7)} ${r.hosoProdCum.toFixed(0).padStart(9)} ${r.pdProdCum.toFixed(0).padStart(7)} ${r.vapProdCum.toFixed(0).padStart(7)}`
    );
  }

  console.log(`\n=== Delta from OFF ===`);
  for (const [name, r] of Object.entries(results)) {
    if (name === "OFF") continue;
    console.log(
      `${name.padEnd(28)} cash=${(((r.endingCash - off.endingCash) / (off.endingCash || 1)) * 100).toFixed(1)}% OP=${(((r.endingOP - off.endingOP) / (Math.abs(off.endingOP) || 1)) * 100).toFixed(1)}% capex=${(((r.totalCapexPaidUsd - off.totalCapexPaidUsd) / (off.totalCapexPaidUsd || 1)) * 100).toFixed(1)}% hires=${(((r.salesHiresTotal - off.salesHiresTotal) / (off.salesHiresTotal || 1)) * 100).toFixed(1)}% crisisQ=${r.crisisQuarters - off.crisisQuarters}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
