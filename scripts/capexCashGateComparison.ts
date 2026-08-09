// ShrimpX V2 — Test16: 設備投資の現金ゲート方式の比較ベンチマーク
//
// 【比較する3ケース】
//   legacy … requiredCash = targetMinimumCash × capexCashSafetyMultiple(1.75)   ← 旧方式
//   r025   … requiredCash = targetMinimumCash + 投資額 × (1 + 0.25)
//   r050   … requiredCash = targetMinimumCash + 投資額 × (1 + 0.50)
//
// いずれも capexSustainedUtilizationThreshold・shortfall・在庫・借入余力・
// 進行中案件の各ゲートは変更していない。現金条件の式だけを差し替える。
//
// 【決定論性】Date.now()・Math.random()を使わない。
//
// 使い方: npx tsx scripts/capexCashGateComparison.ts > artifacts/capexCashGateComparison.json

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "../app/lib/v2/companyLab/standardAi/parameters";
import { CompanyLabConfig, CompanyDecisionInput } from "../app/lib/v2/companyLab/types";
import { calculateFactoryEffectiveCapacity } from "../app/lib/v2/production/capacity";
import { computeEffectiveFactories } from "../app/lib/v2/capex/factoryConstruction";
import { unwrapUnit } from "../app/lib/v2/core/units";

const TURNS = 8;

function config(): CompanyLabConfig {
  return {
    scenarioId: "baseline",
    mode: "canonical",
    seed: "market-aware-sales-benchmark-20260808",
    turns: TURNS,
  } as unknown as CompanyLabConfig;
}

const CASES: readonly { readonly label: string; readonly params: StandardAiParameters }[] = [
  { label: "legacy", params: { ...STANDARD_AI_PARAMETERS_V1, capexCashGateMode: "legacyMultiple" } },
  { label: "r025", params: { ...STANDARD_AI_PARAMETERS_V1, capexCashGateMode: "costBased", capexCostSafetyRatio: 0.25 } },
  { label: "r050", params: { ...STANDARD_AI_PARAMETERS_V1, capexCashGateMode: "costBased", capexCostSafetyRatio: 0.5 } },
];

interface Row {
  readonly turn: number;
  readonly companyId: string;
  readonly hosoCapacity: number | null;
  readonly capexProposals: readonly string[];
  /** 実際に着工・進行中/完成した案件数（stateのcapexポートフォリオから読む）。 */
  readonly capexProjectsInPortfolio: number | null;
  readonly capexProjectStatuses: readonly string[];
  readonly cash: number | null;
  readonly debt: number | null;
  readonly domesticProcured: number | null;
  readonly production: number | null;
  readonly rawMaterialShortfall: number | null;
  readonly operatingProfit: number | null;
  readonly creditTier: string | null;
  readonly severeArrears: boolean | null;
  readonly financialHealth: string | null;
}

function n(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function runCase(params: StandardAiParameters): Row[] {
  const { state: initialState, fixtures } = initializeCompanyLab(config());
  let state = initialState;
  const rows: Row[] = [];

  for (let turn = 1; turn <= TURNS && !state.isComplete; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    const proposalsByCompany: Record<string, string[]> = {};
    const hosoByCompany: Record<string, number> = {};

    for (const fixture of fixtures) {
      const ownState = buildCompanyOwnState(state, fixture);
      const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, turn, params);
      decisions[fixture.companyId] = decision;
      proposalsByCompany[fixture.companyId] = (decision.capexDecision?.newProjectProposals ?? []).map((p) => String(p.projectType));

      const capexStateForCompany = state.capexState.companies.find((c) => c.companyId === fixture.companyId);
      const effectiveFactories = capexStateForCompany
        ? computeEffectiveFactories(fixture.factories, { companies: [capexStateForCompany] }, state.currentPeriod)
        : fixture.factories;
      hosoByCompany[fixture.companyId] = effectiveFactories.reduce((s, f) => s + unwrapUnit(calculateFactoryEffectiveCapacity(f).hoso), 0);
    }

    state = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = state.history[state.history.length - 1];

    for (const fixture of fixtures) {
      const id = fixture.companyId;
      const summary = record?.companySummaries.find((s) => s.companyId === id);
      const fin = record?.financialResults?.find((f) => f.companyId === id);
      const financing = record?.financingResults?.find((f) => f.companyId === id);
      // 提案が実際に案件として成立したかは、期末のcapexポートフォリオで確認する。
      const capexCompany = state.capexState.companies.find((c) => c.companyId === id);
      const projects = capexCompany?.portfolio.projects ?? [];

      rows.push({
        turn,
        companyId: id,
        hosoCapacity: hosoByCompany[id] ?? null,
        capexProposals: proposalsByCompany[id] ?? [],
        capexProjectsInPortfolio: projects.length,
        capexProjectStatuses: projects.map((p) => `${String(p.projectType)}:${String(p.status)}`),
        cash: n(fin?.balanceSheet?.cash),
        debt: n(financing?.endingShortTermLoansUsd) !== null || n(financing?.endingLongTermLoansUsd) !== null
          ? (financing?.endingShortTermLoansUsd ?? 0) + (financing?.endingLongTermLoansUsd ?? 0)
          : null,
        domesticProcured: n(summary?.domesticPurchaseQuantity),
        production: n(summary?.fulfilledQuantity),
        rawMaterialShortfall: n(summary?.rawMaterialShortfall),
        operatingProfit: n(fin?.profitAndLoss?.operatingProfit),
        creditTier: financing?.creditScore ? String((financing.creditScore as { tier?: unknown }).tier ?? "") : null,
        severeArrears: (financing?.arrearsEvents?.length ?? 0) > 0,
        financialHealth: financing?.financialHealth ? JSON.stringify(financing.financialHealth) : null,
      });
    }
  }
  return rows;
}

function run(): void {
  const results = CASES.map((c) => ({
    label: c.label,
    capexCashGateMode: c.params.capexCashGateMode,
    capexCostSafetyRatio: c.params.capexCostSafetyRatio,
    capexCashSafetyMultiple: c.params.capexCashSafetyMultiple,
    rows: runCase(c.params),
  }));
  process.stdout.write(JSON.stringify({ label: "capex-cash-gate-comparison", turns: TURNS, results }, null, 2));
}

run();
