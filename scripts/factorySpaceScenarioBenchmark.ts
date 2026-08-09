// ShrimpX V2 — Test16 最終調整: 商品別スペース係数のシナリオ検証
//
// A. MASS HOSO集中  … HOSO 12→16→20→24 が既存工場内で可能か
// B. BAL 混合型      … スペース制約が意味を持つか
// C. VAP 高付加価値型 … VAP拡張でHOSOより早く新工場が必要になるか
//
// 【本番パラメータ・エンジンは変更しない】原料・現金・営業・希望量という
// プレイヤーが動かせる範囲だけを整え、承認判定はエンジンへ委ねる。
// 【決定論性】Date.now()・Math.random()を使わない。
//
// 使い方: npx tsx scripts/factorySpaceScenarioBenchmark.ts > artifacts/factorySpaceScenarioBenchmark.json

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { CompanyLabConfig, CompanyDecisionInput, CompanyLabState, CompanyFixture } from "../app/lib/v2/companyLab/types";
import { RawMaterialLot } from "../app/lib/v2/rawMaterials/types";
import { computeEffectiveFactories } from "../app/lib/v2/capex/factoryConstruction";
import { buildCompanyFactorySpaceState, computeCandidateProjectSpaceUnits } from "../app/lib/v2/capex/factorySpace";
import { CapitalProjectType } from "../app/lib/v2/capex/types";
import { hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../app/lib/v2/core/units";
import { usd } from "../app/lib/v2/finance/types";

const TURNS = 12;
const RAW_TOPUP_TONS = 120_000;
const INITIAL_CASH_USD = 250_000_000;
const SALES_HEADCOUNT = 400;
const DEMAND_MULTIPLIER = 6;

/** 検証する3ケース。増設対象の商品だけが異なる。 */
const CASES = [
  { label: "A-MASS-HOSO集中", focus: "MASS", products: ["hoso"] as const, projects: ["hosoLineExpansion"] as CapitalProjectType[] },
  { label: "B-BAL-混合型", focus: "BAL", products: ["hoso", "pd", "vap"] as const, projects: ["hosoLineExpansion", "pdLineExpansion", "vapLineExpansion"] as CapitalProjectType[] },
  { label: "C-VAP-高付加価値集中", focus: "VAP", products: ["vap"] as const, projects: ["vapLineExpansion"] as CapitalProjectType[] },
] as const;

function config(): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "factory-space-scenario-20260809", turns: TURNS } as unknown as CompanyLabConfig;
}

function withStrongSales(fixtures: readonly CompanyFixture[], focus: string): readonly CompanyFixture[] {
  return fixtures.map((f) => (f.companyId === focus ? { ...f, salesForceHeadcountTotal: SALES_HEADCOUNT } : f));
}

function withInitialCash(state: CompanyLabState, focus: string): CompanyLabState {
  return {
    ...state,
    financeState: {
      ...state.financeState,
      companies: state.financeState.companies.map((c) => (c.companyId === focus ? { ...c, cash: usd(INITIAL_CASH_USD) } : c)),
    },
  };
}

function withRawMaterial(state: CompanyLabState, companyIds: readonly string[], turn: number): CompanyLabState {
  const topups: RawMaterialLot[] = companyIds.map((companyId) => ({
    lotId: `${companyId}-SPACE-SCN-T${turn}`,
    companyId: companyId as RawMaterialLot["companyId"],
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: state.currentPeriod,
    originalQuantity: hosoEqTons(RAW_TOPUP_TONS),
    remainingQuantity: hosoEqTons(RAW_TOPUP_TONS),
    unitCost: usdPerHosoEqKg(4.2),
    availableFromPeriod: state.currentPeriod,
    status: "available",
  }));
  return { ...state, rawMaterialLots: [...state.rawMaterialLots, ...topups] };
}

interface Row {
  readonly turn: number;
  readonly usedSpaceUnits: number;
  readonly remainingSpaceUnits: number;
  readonly totalSpaceUnits: number;
  readonly investmentSpaceRequirement: Readonly<Record<string, number>>;
  readonly hosoCapacity: number;
  readonly pdCapacity: number;
  readonly vapCapacity: number;
  readonly commonCapacity: number;
  readonly capexApproved: readonly string[];
  readonly capexRejections: readonly string[];
}

function runCase(c: (typeof CASES)[number]): Row[] {
  const { state: initialState, fixtures: baseFixtures } = initializeCompanyLab(config());
  const fixtures = withStrongSales(baseFixtures, c.focus);
  let state = withInitialCash(initialState, c.focus);
  const companyIds = fixtures.map((f) => f.companyId);
  const rows: Row[] = [];

  for (let turn = 1; turn <= TURNS && !state.isComplete; turn++) {
    state = withRawMaterial(state, companyIds, turn);
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    let spaceState: ReturnType<typeof buildCompanyFactorySpaceState> | undefined;
    let caps = { hoso: 0, pd: 0, vap: 0, common: 0 };

    for (const fixture of fixtures) {
      const ownState = buildCompanyOwnState(state, fixture);
      const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, turn);
      if (fixture.companyId !== c.focus) {
        decisions[fixture.companyId] = decision;
        continue;
      }
      // 戦略選択の代理: 対象商品の希望量を引き上げ、対象の増設を毎期提案する。
      const boost = <T extends { product: string; desiredQuantity: unknown }>(p: T): T =>
        (c.products as readonly string[]).includes(p.product)
          ? ({ ...p, desiredQuantity: hosoEqTons(unwrapUnit(p.desiredQuantity as never) * DEMAND_MULTIPLIER) } as T)
          : p;
      decisions[fixture.companyId] = {
        ...decision,
        salesPlans: decision.salesPlans.map(boost),
        productionPlans: decision.productionPlans.map(boost),
        capexDecision: {
          ...decision.capexDecision,
          newProjectProposals: [
            ...decision.capexDecision.newProjectProposals.filter((x) => !c.projects.includes(x.projectType)),
            ...c.projects.map((projectType) => ({ projectType })),
          ],
        },
      };

      const capexStateForCompany = state.capexState.companies.find((x) => x.companyId === c.focus);
      const effectiveFactories = capexStateForCompany
        ? computeEffectiveFactories(fixture.factories, { companies: [capexStateForCompany] }, state.currentPeriod)
        : fixture.factories;
      spaceState = buildCompanyFactorySpaceState({
        companyId: c.focus as never,
        baseFactories: fixture.factories,
        currentFactories: effectiveFactories,
        capexState: capexStateForCompany ? { companies: [capexStateForCompany] } : { companies: [] },
        period: state.currentPeriod,
      });
      caps = {
        hoso: effectiveFactories.reduce((s, f) => s + unwrapUnit(f.hosoCapacity), 0),
        pd: effectiveFactories.reduce((s, f) => s + unwrapUnit(f.pdCapacity), 0),
        vap: effectiveFactories.reduce((s, f) => s + unwrapUnit(f.vapCapacity), 0),
        common: effectiveFactories.reduce((s, f) => s + unwrapUnit(f.commonProcessingCapacity), 0),
      };
    }

    state = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = state.history[state.history.length - 1];
    const capexResult = (record?.capexResults ?? []).find((x) => x.companyId === c.focus);

    rows.push({
      turn,
      usedSpaceUnits: spaceState?.usedAfterPendingSpaceUnits ?? 0,
      remainingSpaceUnits: Math.max(0, (spaceState?.totalSpaceUnits ?? 0) - (spaceState?.usedAfterPendingSpaceUnits ?? 0)),
      totalSpaceUnits: spaceState?.totalSpaceUnits ?? 0,
      investmentSpaceRequirement: Object.fromEntries(c.projects.map((t) => [String(t), computeCandidateProjectSpaceUnits(t)])),
      hosoCapacity: caps.hoso,
      pdCapacity: caps.pd,
      vapCapacity: caps.vap,
      commonCapacity: caps.common,
      capexApproved: (capexResult?.events ?? []).map((e) => `${String(e.projectType)}:${String(e.statusBefore)}→${String(e.statusAfter)}`),
      capexRejections: (capexResult?.rejectedProposals ?? []).map((r) => `${String(r.projectType)}: ${(r.reasons ?? []).join("/")}`),
    });
  }
  return rows;
}

function run(): void {
  const results = CASES.map((c) => ({ label: c.label, focus: c.focus, rows: runCase(c) }));
  process.stdout.write(JSON.stringify({ label: "factory-space-scenario-benchmark", turns: TURNS, results }, null, 2));
}

run();
