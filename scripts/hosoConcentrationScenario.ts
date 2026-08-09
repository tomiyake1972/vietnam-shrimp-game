// ShrimpX V2 — Test16: HOSO集中戦略の成立確認（専用シナリオ）
//
// 【目的】
// Standard AI が自然にそこへ行くかではなく、
// **ゲームルールとして HOSO 集中戦略が実際に選択可能か** を確認する。
//
// MASS が意図的に HOSO 集中を選んだ場合に、能力が
//   12,000 → 16,000 → 20,000 → 24,000（MAX_HOSO_CAPACITY_TONS）
// へ増強できるかを追う。
//
// 【この専用シナリオで整える条件（指示3で明示的に許可された範囲）】
//   ・HOSO需要が十分ある     … 販売計画のHOSO希望量を引き上げる
//   ・必要原料を合理的に調達できる … 毎ターン十分な原料を供給する
//   ・営業力が十分            … 営業人員を潤沢にする
//   ・設備投資判断に必要な資金余力がある … 初期現金を厚くする
//
// 【本番パラメータ・ゲームエンジンは変更しない】
// fixture と state、および意思決定（プレイヤーが入力し得る範囲）だけを操作する。
// capex の判定条件・集中カーブ・資金ゲートの式には一切触れていない。
// これは「手動プレイヤーが HOSO 集中戦略を選んだ場合」の代理である。
//
// 【決定論性】Date.now()・Math.random()を使わない。
//
// 使い方: npx tsx scripts/hosoConcentrationScenario.ts > artifacts/hosoConcentrationScenario.json

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { CompanyLabConfig, CompanyDecisionInput, CompanyLabState, CompanyFixture } from "../app/lib/v2/companyLab/types";
import { RawMaterialLot } from "../app/lib/v2/rawMaterials/types";
import { calculateFactoryEffectiveCapacity } from "../app/lib/v2/production/capacity";
import { computeEffectiveFactories } from "../app/lib/v2/capex/factoryConstruction";
import { concentrationFactor } from "../app/lib/v2/production/concentration";
import { requiredHeadcountForQuantity, requiredHeadcountForQuantityWithConcentration, effectiveEfficiencyPerHeadTons } from "../app/lib/v2/production/labor";
import { PRODUCTION_PARAMETERS_V1 } from "../app/lib/v2/production/parameters";
import { hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../app/lib/v2/core/units";
import { usd } from "../app/lib/v2/finance/types";

const TURNS = 12;
const FOCUS = "MASS";
/** 毎ターン供給する原料（全社。HOSO集中で必要量が大きいため十分量を置く）。 */
const RAW_TOPUP_TONS = 120_000;
const RAW_TOPUP_UNIT_COST = 4.2;
/** 集中側の会社へ与える初期現金（設備投資の資金余力を作るため）。 */
const FOCUS_INITIAL_CASH_USD = 250_000_000;
/** 集中側の会社の営業人員（営業がボトルネックにならない水準）。 */
const FOCUS_SALES_HEADCOUNT = 400;
/** HOSO希望量の引き上げ倍率（HOSO需要が十分にある状態を作る）。 */
const HOSO_DEMAND_MULTIPLIER = 6;

function config(): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "hoso-concentration-scenario-20260809", turns: TURNS } as unknown as CompanyLabConfig;
}

/** 集中側の会社だけ営業人員を厚くする。 */
function withStrongSales(fixtures: readonly CompanyFixture[]): readonly CompanyFixture[] {
  return fixtures.map((f) => (f.companyId === FOCUS ? { ...f, salesForceHeadcountTotal: FOCUS_SALES_HEADCOUNT } : f));
}

/** 集中側の会社へ潤沢な初期現金を与える。 */
function withInitialCash(state: CompanyLabState): CompanyLabState {
  return {
    ...state,
    financeState: {
      ...state.financeState,
      companies: state.financeState.companies.map((c) => (c.companyId === FOCUS ? { ...c, cash: usd(FOCUS_INITIAL_CASH_USD) } : c)),
    },
  };
}

/** 毎ターン、使用可能原料を全社へ積み増す。 */
function withRawMaterial(state: CompanyLabState, companyIds: readonly string[], turn: number): CompanyLabState {
  const topups: RawMaterialLot[] = companyIds.map((companyId) => ({
    lotId: `${companyId}-HOSO-SCN-T${turn}`,
    companyId: companyId as RawMaterialLot["companyId"],
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: state.currentPeriod,
    originalQuantity: hosoEqTons(RAW_TOPUP_TONS),
    remainingQuantity: hosoEqTons(RAW_TOPUP_TONS),
    unitCost: usdPerHosoEqKg(RAW_TOPUP_UNIT_COST),
    availableFromPeriod: state.currentPeriod,
    status: "available",
  }));
  return { ...state, rawMaterialLots: [...state.rawMaterialLots, ...topups] };
}

/**
 * 【プレイヤーの戦略選択の代理】集中側の会社の意思決定を「HOSO集中」へ寄せる。
 *
 *  ・HOSOの販売希望量・生産希望量を引き上げる（HOSO需要が十分ある状態）
 *  ・HOSOライン増設を毎期提案する（上限・進行中案件・資金の各ゲートは
 *    エンジン側がそのまま判定する。ここで承認を強制してはいない）
 *
 * PD/VAPの計画には手を触れない。ゲームのルール・パラメータも変更していない。
 */
function asHosoConcentrationDecision(decision: CompanyDecisionInput): CompanyDecisionInput {
  return {
    ...decision,
    salesPlans: decision.salesPlans.map((p) =>
      p.product === "hoso"
        ? { ...p, desiredQuantity: hosoEqTons(unwrapUnit(p.desiredQuantity) * HOSO_DEMAND_MULTIPLIER) }
        : p
    ),
    productionPlans: decision.productionPlans.map((p) =>
      p.product === "hoso"
        ? { ...p, desiredQuantity: hosoEqTons(unwrapUnit(p.desiredQuantity) * HOSO_DEMAND_MULTIPLIER) }
        : p
    ),
    capexDecision: {
      ...decision.capexDecision,
      newProjectProposals: [
        ...decision.capexDecision.newProjectProposals.filter((x) => x.projectType !== "hosoLineExpansion"),
        { projectType: "hosoLineExpansion" as const },
      ],
    },
  };
}

interface Row {
  readonly turn: number;
  readonly hosoCapacity: number;
  readonly hosoProduced: number;
  readonly hosoUtilization: number | null;
  readonly concentrationFactor: number;
  readonly baseRequiredWorkers: number;
  readonly adjustedRequiredWorkers: number;
  readonly workerReductionRatio: number;
  readonly capexProposals: readonly string[];
  readonly capexProjectStatuses: readonly string[];
  readonly capexRejections: readonly string[];
  readonly domesticProcured: number;
  readonly rawMaterialShortfall: number;
  readonly finishedGoodsInventory: number;
  readonly cash: number;
  readonly debt: number;
  readonly operatingProfit: number;
  readonly regularHeadcount: number;
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function run(): void {
  const { state: initialState, fixtures: baseFixtures } = initializeCompanyLab(config());
  const fixtures = withStrongSales(baseFixtures);
  let state = withInitialCash(initialState);
  const companyIds = fixtures.map((f) => f.companyId);
  const rows: Row[] = [];

  for (let turn = 1; turn <= TURNS && !state.isComplete; turn++) {
    state = withRawMaterial(state, companyIds, turn);
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    let hosoCapacity = 0;
    let proposals: string[] = [];
    let plannedHoso = 0;

    for (const fixture of fixtures) {
      const ownState = buildCompanyOwnState(state, fixture);
      const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, turn);
      const finalDecision = fixture.companyId === FOCUS ? asHosoConcentrationDecision(decision) : decision;
      decisions[fixture.companyId] = finalDecision;

      if (fixture.companyId === FOCUS) {
        const capexStateForCompany = state.capexState.companies.find((c) => c.companyId === FOCUS);
        const effectiveFactories = capexStateForCompany
          ? computeEffectiveFactories(fixture.factories, { companies: [capexStateForCompany] }, state.currentPeriod)
          : fixture.factories;
        hosoCapacity = effectiveFactories.reduce((s, f) => s + unwrapUnit(calculateFactoryEffectiveCapacity(f).hoso), 0);
        proposals = (finalDecision.capexDecision?.newProjectProposals ?? []).map((p) => String(p.projectType));
        plannedHoso = finalDecision.productionPlans
          .filter((p) => p.product === "hoso")
          .reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
      }
    }

    state = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = state.history[state.history.length - 1];
    const summary = record?.companySummaries.find((s) => s.companyId === FOCUS);
    const fin = record?.financialResults?.find((f) => f.companyId === FOCUS);
    const financing = record?.financingResults?.find((f) => f.companyId === FOCUS);
    const capexCompany = state.capexState.companies.find((c) => c.companyId === FOCUS);
    const workforce = state.workforceState?.companies.find((c) => c.companyId === FOCUS);

    const base = PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons;
    const factor = concentrationFactor("hoso", plannedHoso);
    const baseWorkers = requiredHeadcountForQuantity(
      plannedHoso,
      effectiveEfficiencyPerHeadTons(base, "hoso", PRODUCTION_PARAMETERS_V1),
      1, 1, 0, PRODUCTION_PARAMETERS_V1
    );
    const adjustedWorkers = requiredHeadcountForQuantityWithConcentration(plannedHoso, base, "hoso", 1, 1, 0, PRODUCTION_PARAMETERS_V1);
    const producedHoso = n(unwrapUnit(summary!.hosoProduced));

    rows.push({
      turn,
      hosoCapacity,
      hosoProduced: producedHoso,
      hosoUtilization: hosoCapacity > 0 ? producedHoso / hosoCapacity : null,
      concentrationFactor: factor,
      baseRequiredWorkers: baseWorkers,
      adjustedRequiredWorkers: adjustedWorkers,
      workerReductionRatio: baseWorkers > 0 ? 1 - adjustedWorkers / baseWorkers : 0,
      capexProposals: proposals,
      capexProjectStatuses: (capexCompany?.portfolio.projects ?? []).map((p) => `${String(p.projectType)}:${String(p.status)}`),
      capexRejections: ((record?.capexResults ?? []).find((c) => c.companyId === FOCUS)?.rejectedProposals ?? []).map((r) => `${String(r.projectType)}:${(r.reasons ?? []).join("/")}`),
      domesticProcured: n(unwrapUnit(summary!.domesticPurchaseQuantity)),
      rawMaterialShortfall: n(unwrapUnit(summary!.rawMaterialShortfall)),
      finishedGoodsInventory: n(unwrapUnit(summary!.finishedGoodsInventory)),
      cash: n(fin?.balanceSheet?.cash),
      debt: (financing?.endingShortTermLoansUsd ?? 0) + (financing?.endingLongTermLoansUsd ?? 0),
      operatingProfit: n(fin?.profitAndLoss?.operatingProfit),
      regularHeadcount: (workforce?.factories ?? []).reduce((s, f) => s + f.regularHeadcount, 0),
    });
  }

  process.stdout.write(
    JSON.stringify(
      {
        label: "hoso-concentration-scenario",
        focusCompany: FOCUS,
        turns: TURNS,
        scenarioConditions: {
          rawTopupTonsPerCompanyPerTurn: RAW_TOPUP_TONS,
          focusInitialCashUsd: FOCUS_INITIAL_CASH_USD,
          focusSalesHeadcount: FOCUS_SALES_HEADCOUNT,
          hosoDemandMultiplier: HOSO_DEMAND_MULTIPLIER,
        },
        rows,
      },
      null,
      2
    )
  );
}

run();
