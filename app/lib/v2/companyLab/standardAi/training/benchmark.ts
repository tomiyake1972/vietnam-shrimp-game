// ShrimpX V2 — Standard AI Training Harness: ベンチマーク実行と decision/result 記録
//
// 【目的】固定されたゲーム環境の中でStandard AIを多数自動プレイさせ、
// 各 company-quarter の「意思決定」と「結果」を機械可読な形で残す。
// この記録だけを入力として、audit.ts が経営矛盾を検出する。
//
// 【この層がやらないこと】
//   - ゲーム環境（market/sales/rawMaterials/production/finance/…）を一切変更しない。
//     既存の runCompanyLabWithAutoPolicyForAllCompanies と generateStandardAiDecisionWithDiagnostics を
//     そのまま呼ぶだけで、独自の四半期処理は書かない。
//   - Test15の保存データ・Turnに触れない（独立したin-memoryシミュレーションのみ）。
//   - 値の再計算をしない。記録するのはエンジンが返した値そのもの。

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import type { PublicMarketInfo } from "../../types";
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyLabState } from "../../types";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { computeEnvironmentFingerprint, EnvironmentFingerprint } from "./fingerprint";

// ---------------------------------------------------------------------
// ベンチマークprofile
// ---------------------------------------------------------------------

export interface BenchmarkProfile {
  readonly name: string;
  readonly quarters: number;
  readonly seedCount: number;
  readonly scenarioId: string;
  readonly description: string;
}

/**
 * seedは profile名 + 連番から決定論的に導出する（hard-codeした固定リストを持たない）。
 * 同じprofileなら常に同じseed列になるため、Before/Afterで必ず同じ世界を比較できる。
 */
export function seedsForProfile(profile: BenchmarkProfile): readonly string[] {
  return Array.from({ length: profile.seedCount }, (_, i) => `sai-train-${profile.name}-${String(i + 1).padStart(3, "0")}`);
}

export const BENCHMARK_PROFILES: Readonly<Record<"quick" | "standard" | "deep", BenchmarkProfile>> = {
  quick: {
    name: "quick",
    quarters: 8,
    seedCount: 3,
    scenarioId: "baseline",
    description: "5社 × 8四半期 × 3seed。開発中の高速な往復用。",
  },
  standard: {
    name: "standard",
    quarters: 32,
    seedCount: 10,
    scenarioId: "baseline",
    description: "5社 × 32四半期 × 10seed。keep/revert判定に使う既定のベンチマーク。",
  },
  deep: {
    name: "deep",
    quarters: 32,
    seedCount: 50,
    scenarioId: "baseline",
    description: "5社 × 32四半期 × 50seed。稀な矛盾の掘り起こし用（実行時間が長い）。",
  },
};

// ---------------------------------------------------------------------
// 記録するdecision / result
// ---------------------------------------------------------------------

/** 1つの company-quarter で Standard AI が下した意思決定（指示§5）。 */
export interface RecordedDecision {
  // Sales
  readonly salesPlans: readonly {
    readonly market: string;
    readonly product: string;
    readonly desiredQuantity: number;
    readonly priceAdjustment: number;
    readonly salesForceHeadcount: number;
  }[];
  readonly salesHeadcountByMarket: Readonly<Record<string, number>>;
  readonly salesForceTotalAssigned: number;
  readonly salesForceHireCount: number;
  readonly salesForceLayoffCount: number;
  // Production
  readonly productionPlans: readonly { readonly factoryId: string; readonly product: string; readonly desiredQuantity: number; readonly priority: number }[];
  readonly plannedProductionByProduct: Readonly<Record<string, number>>;
  // Labor
  readonly workerAssignments: readonly {
    readonly factoryId: string;
    readonly regularHeadcount: number;
    readonly temporaryHeadcount: number;
    readonly overtimeRate: number;
  }[];
  readonly totalRegularWorkers: number;
  readonly totalTemporaryWorkers: number;
  readonly maxOvertimeRate: number;
  // Raw
  readonly domesticPurchaseQuantity: number;
  readonly domesticPurchasePriceAdjustment: number;
  readonly importOrderedQuantity: number;
  readonly aquacultureStockingQuantity: number;
  // Finance
  readonly requestedBorrowingUsd: number;
  readonly requestedPrepaymentUsd: number;
  // Investment
  readonly capexProposals: readonly { readonly projectType: string; readonly targetFactoryId: string | null }[];
  readonly vapProductDevelopmentSpendUsd: number;
  // Standard AI internals
  readonly reasonCodes: readonly { readonly code: string; readonly domain: string; readonly severity: string; readonly message: string }[];
  /**
   * 【Batch 002】この四半期に公開されていた市場×商品別観測需要（2四半期前の実績、
   * またはゲーム開始時点の既知市場情報）。AIが実際に見ていた情報を記録することで、
   * 「見えていたのに使わなかった」のか「そもそも見えていなかった」のかを
   * 監査で区別できるようにする。
   */
  readonly observedDemandByMarket: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly marketDemandObservationSource: string | null;
  readonly marketDemandSourceQuarter: number | null;
  readonly primaryConstraint: string | null;
  readonly secondaryConstraint: string | null;
  readonly salesFulfillmentState: string | null;
  readonly productionLoadState: string | null;
  readonly workerLoadState: string | null;
  readonly rawMaterialCoverageState: string | null;
  readonly inventoryExcessState: string | null;
  readonly liquidityCoverageState: string | null;
}

/** 1つの company-quarter の結果（指示§6）。 */
export interface RecordedResult {
  readonly newContractedQuantity: number;
  readonly newContractedAveragePrice: number;
  readonly fulfilledQuantity: number;
  readonly outstandingQuantity: number;
  readonly overdueQuantity: number;
  /** 市場×商品別の成約量（この会社ぶん）と、その市場の対象需要。 */
  readonly allocationsByMarketProduct: readonly {
    readonly market: string;
    readonly product: string;
    readonly targetDemand: number;
    readonly allocatedQuantity: number;
    readonly desiredQuantity: number;
    readonly marketShare: number;
  }[];
  readonly producedByProduct: Readonly<Record<string, number>>;
  readonly finishedGoodsInventory: number;
  readonly rawMaterialInventory: number;
  readonly rawMaterialShortfall: number;
  readonly equipmentShortfall: number;
  readonly laborShortfall: number;
  readonly equipmentUtilizationRate: number;
  readonly laborUtilizationRate: number;
  readonly overtimeRate: number;
  readonly temporaryWorkerShare: number;
  // Finance
  readonly cash: number;
  readonly accountsReceivable: number;
  readonly accountsPayable: number;
  readonly shortTermLoans: number;
  readonly longTermLoans: number;
  readonly operatingCashFlow: number;
  readonly operatingProfit: number;
  readonly netIncome: number;
  readonly idleLaborCost: number;
  readonly normalBorrowingApprovedUsd: number;
  readonly emergencyBorrowingUsd: number;
  readonly paymentDefault: boolean;
  readonly insolvent: boolean;
  // Capex
  readonly underConstructionProjectIds: readonly string[];
  readonly constructionInProgressUsd: number;
}

export interface CompanyQuarterRecordRow {
  readonly seed: string;
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly decision: RecordedDecision;
  readonly result: RecordedResult;
}

export interface BenchmarkRun {
  readonly profile: BenchmarkProfile;
  readonly fingerprint: EnvironmentFingerprint;
  readonly generatedAt: string;
  readonly rows: readonly CompanyQuarterRecordRow[];
}

const N = (x: unknown): number => {
  const v = Number(x ?? 0);
  return Number.isFinite(v) ? v : 0;
};

function sumBy<T>(items: readonly T[], pick: (t: T) => number): number {
  return items.reduce((s, t) => s + pick(t), 0);
}

function recordDecision(
  decision: CompanyDecisionInput,
  diagnostics: ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["diagnostics"],
  publicInfo: PublicMarketInfo
): RecordedDecision {
  const observed = publicInfo.observedMarketDemand;
  const observedDemandByMarket: Record<string, Record<string, number>> = {};
  for (const e of observed?.entries ?? []) {
    observedDemandByMarket[String(e.market)] = {
      hoso: e.observedDemandByProduct.hoso,
      pd: e.observedDemandByProduct.pd,
      vap: e.observedDemandByProduct.vap,
    };
  }

  const salesPlans = (decision.salesPlans ?? []).map((p) => ({
    market: String(p.market),
    product: String(p.product),
    desiredQuantity: N(p.desiredQuantity),
    priceAdjustment: N(p.priceAdjustmentUsdPerHosoEqKg),
    salesForceHeadcount: N(p.salesForceHeadcount),
  }));
  // 同一市場の複数商品行は同じ営業人員を共有するため、市場ごとに重複排除する。
  const salesHeadcountByMarket: Record<string, number> = {};
  for (const p of salesPlans) salesHeadcountByMarket[p.market] = p.salesForceHeadcount;

  const plannedProductionByProduct: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const p of decision.productionPlans ?? []) plannedProductionByProduct[String(p.product)] += N(p.desiredQuantity);

  const workers = (decision.workerAssignments ?? []).map((w) => ({
    factoryId: String(w.factoryId),
    regularHeadcount: N(w.regularHeadcount),
    temporaryHeadcount: N(w.temporaryHeadcount),
    overtimeRate: N(w.overtimeRate),
  }));

  const sd = diagnostics.situationDiagnosis;

  return {
    salesPlans,
    salesHeadcountByMarket,
    salesForceTotalAssigned: Object.values(salesHeadcountByMarket).reduce((s, v) => s + v, 0),
    salesForceHireCount: N(decision.salesForceHireCount),
    salesForceLayoffCount: N(decision.salesForceLayoffCount),
    productionPlans: (decision.productionPlans ?? []).map((p) => ({
      factoryId: String(p.factoryId),
      product: String(p.product),
      desiredQuantity: N(p.desiredQuantity),
      priority: N(p.priority),
    })),
    plannedProductionByProduct,
    workerAssignments: workers,
    totalRegularWorkers: sumBy(workers, (w) => w.regularHeadcount),
    totalTemporaryWorkers: sumBy(workers, (w) => w.temporaryHeadcount),
    maxOvertimeRate: workers.length > 0 ? Math.max(...workers.map((w) => w.overtimeRate)) : 0,
    domesticPurchaseQuantity: N(decision.domesticPurchasePlan?.desiredQuantity),
    domesticPurchasePriceAdjustment: N(decision.domesticPurchasePlan?.priceAdjustmentUsdPerHosoEqKg),
    importOrderedQuantity: sumBy(decision.importOrders ?? [], (o) => N(o.orderedQuantity)),
    aquacultureStockingQuantity: sumBy(decision.aquacultureStockingPlans ?? [], (a) => N(a.plannedStockingQuantity)),
    requestedBorrowingUsd: N(decision.financingRequest?.desiredAmountUsd),
    requestedPrepaymentUsd: N(decision.financingRequest?.desiredPrepaymentUsd),
    capexProposals: (decision.capexDecision?.newProjectProposals ?? []).map((p) => ({
      projectType: String(p.projectType),
      targetFactoryId: p.targetFactoryId !== undefined ? String(p.targetFactoryId) : null,
    })),
    vapProductDevelopmentSpendUsd: N(decision.vapProductDevelopmentSpendUsd),
    reasonCodes: diagnostics.entries.map((e) => ({
      code: String(e.code),
      domain: String(e.domain),
      severity: String(e.severity),
      message: String(e.message),
    })),
    observedDemandByMarket,
    marketDemandObservationSource: observed ? String(observed.observationSource) : null,
    marketDemandSourceQuarter: observed?.sourceQuarter ?? null,
    primaryConstraint: sd ? String(sd.primaryConstraint) : null,
    secondaryConstraint: sd?.secondaryConstraint ? String(sd.secondaryConstraint) : null,
    salesFulfillmentState: sd ? String(sd.salesFulfillmentState) : null,
    productionLoadState: sd ? String(sd.productionLoadState) : null,
    workerLoadState: sd ? String(sd.workerLoadState) : null,
    rawMaterialCoverageState: sd ? String(sd.rawMaterialCoverageState) : null,
    inventoryExcessState: sd ? String(sd.inventoryExcessState) : null,
    liquidityCoverageState: sd ? String(sd.liquidityCoverageState) : null,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function recordResult(record: any, companyId: string, decision: RecordedDecision): RecordedResult {
  const summary = record.companySummaries.find((s: any) => s.companyId === companyId);
  const financial = record.financialResults?.find((f: any) => f.companyId === companyId);
  const financing = record.financingResults?.find((f: any) => f.companyId === companyId);
  const capex = record.capexResults?.find((c: any) => c.companyId === companyId);

  const desiredByKey = new Map<string, number>();
  for (const p of decision.salesPlans) desiredByKey.set(`${p.market}::${p.product}`, p.desiredQuantity);

  const allocations: RecordedResult["allocationsByMarketProduct"] = (record.salesRecord?.allocations ?? []).flatMap((a: any) => {
    const own = a.companies.find((c: any) => c.companyId === companyId);
    if (!own) return [];
    const targetDemand = N(a.targetDemand);
    const allocated = N(own.allocatedQuantity);
    return [
      {
        market: String(a.market),
        product: String(a.product),
        targetDemand,
        allocatedQuantity: allocated,
        desiredQuantity: desiredByKey.get(`${a.market}::${a.product}`) ?? 0,
        marketShare: targetDemand > 0 ? allocated / targetDemand : 0,
      },
    ];
  });

  const projects = capex?.newCapexState?.portfolio?.projects ?? [];
  const underConstruction = projects.filter((p: any) => p.status === "underConstruction" || p.status === "suspended");

  return {
    newContractedQuantity: N(summary?.newContractedQuantity),
    newContractedAveragePrice: N(summary?.newContractedAveragePrice),
    fulfilledQuantity: N(summary?.fulfilledQuantity),
    outstandingQuantity: N(summary?.outstandingQuantity),
    overdueQuantity: N(summary?.overdueQuantity),
    allocationsByMarketProduct: allocations,
    producedByProduct: {
      hoso: N(summary?.hosoProduced),
      pd: N(summary?.pdProduced),
      vap: N(summary?.vapProduced),
    },
    finishedGoodsInventory: N(summary?.finishedGoodsInventory),
    rawMaterialInventory: N(summary?.rawMaterialInventory),
    rawMaterialShortfall: N(summary?.rawMaterialShortfall),
    equipmentShortfall: N(summary?.equipmentShortfall),
    laborShortfall: N(summary?.laborShortfall),
    equipmentUtilizationRate: N(summary?.equipmentUtilizationRate),
    laborUtilizationRate: N(summary?.laborUtilizationRate),
    overtimeRate: N(summary?.overtimeRate),
    temporaryWorkerShare: N(summary?.temporaryWorkerShare),
    cash: N(financial?.balanceSheet?.cash),
    accountsReceivable: N(financial?.balanceSheet?.accountsReceivable),
    accountsPayable: N(financial?.balanceSheet?.accountsPayable),
    shortTermLoans: N(financial?.balanceSheet?.shortTermLoans),
    longTermLoans: N(financial?.balanceSheet?.longTermLoans),
    operatingCashFlow: N(financial?.cashFlow?.operatingCashFlow),
    operatingProfit: N(financial?.profitAndLoss?.operatingProfit),
    netIncome: N(financial?.profitAndLoss?.netIncome),
    idleLaborCost: N(financial?.profitAndLoss?.costOfSales?.idleLaborCost),
    normalBorrowingApprovedUsd: N(financing?.underwriting?.approvedAmountUsd),
    emergencyBorrowingUsd: N(financing?.emergencyFinancing?.drawnAmountUsd),
    paymentDefault: Boolean(financing?.paymentDefault?.occurred ?? financing?.paymentDefault),
    insolvent: Boolean(financing?.financialHealth?.insolvent),
    underConstructionProjectIds: underConstruction.map((p: any) => String(p.projectId)),
    constructionInProgressUsd: N(financial?.balanceSheet?.constructionInProgress),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 1 seed ぶんのシミュレーションを実行し、company-quarter 行を返す。 */
export function runSingleSeed(profile: BenchmarkProfile, seed: string): readonly CompanyQuarterRecordRow[] {
  const config: CompanyLabConfig = {
    scenarioId: profile.scenarioId,
    mode: "canonical",
    seed,
    turns: profile.quarters,
  };
  const { state: initialState, fixtures } = initializeCompanyLab(config);
  let state: CompanyLabState = initialState;
  const rows: CompanyQuarterRecordRow[] = [];

  while (!state.isComplete) {
    const publicInfo = buildPublicMarketInfo(state);
    const turn = state.scenarioState.currentTurn;
    const decisions: Record<string, CompanyDecisionInput> = {};
    const recordedDecisions: Record<string, RecordedDecision> = {};

    for (const f of fixtures) {
      const ownState = buildCompanyOwnState(state, f);
      const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(f, ownState, publicInfo, state.currentPeriod, turn);
      decisions[f.companyId] = decision;
      recordedDecisions[f.companyId] = recordDecision(decision, diagnostics, publicInfo);
    }

    const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = nextState.history[nextState.history.length - 1];

    for (const f of fixtures) {
      rows.push({
        seed,
        companyId: f.companyId,
        turn: record.turn,
        period: String(record.period),
        decision: recordedDecisions[f.companyId],
        result: recordResult(record, f.companyId, recordedDecisions[f.companyId]),
      });
    }
    state = nextState;
  }
  return rows;
}

/** profile全体（全seed）を実行する。 */
export function runBenchmark(profile: BenchmarkProfile, generatedAt: string): BenchmarkRun {
  const rows: CompanyQuarterRecordRow[] = [];
  for (const seed of seedsForProfile(profile)) {
    rows.push(...runSingleSeed(profile, seed));
  }
  return {
    profile,
    fingerprint: computeEnvironmentFingerprint(),
    generatedAt,
    rows,
  };
}

/** fixtures（会社一覧）を外部から参照したい場合のヘルパー。 */
export function benchmarkCompanyIds(profile: BenchmarkProfile): readonly string[] {
  const { fixtures } = initializeCompanyLab({
    scenarioId: profile.scenarioId,
    mode: "canonical",
    seed: seedsForProfile(profile)[0] ?? "sai-train-probe",
    turns: 1,
  });
  return fixtures.map((f: CompanyFixture) => f.companyId);
}
