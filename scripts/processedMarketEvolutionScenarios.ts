// ShrimpX V2 — 加工品市場進化: 4つの検証シナリオ（実装指示 §11）と生データ出力（§14）
//
// 【目的】「能力・需要・営業・Worker・原料・資金がそろって初めて成果になる」という
// 設計テーゼを、主張ではなく実機の数値で確かめる。4つの戦略プロファイルを
// 同一シナリオ・同一シードで走らせて比較する。
//
//   A: 加工投資なし        … HOSO中心。省人化もVAP開発も新工場も行わない。
//   B: PD先行             … 需要成長に合わせて営業を伸ばし、能力が律速になったら
//                            新工場を建て、他産地参入期に省人化でコストを下げる。
//   C: VAP先行            … VAP商品開発を継続し、営業・品質・顧客関係を強め、
//                            PD黄金期のあとVAP比率を上げる。
//   D: 無調整の過剰投資    … 需要が伸びる**前に**新工場・省人化・VAP開発を同時実行し、
//                            原料・営業・資金の制約を解消しないまま進める。
//
// B・Cが常に勝つ必要はないが、Aを明確に上回る条件と時期が存在しなければならない。
// **Dは失敗しなければならない**（正しい投資でもタイミングと接続を誤れば負ける）。
//
// 【重要・世界を厳しくしていないこと】4ケースはすべて同一のシナリオ・同一の
// パラメータ・同一のシードで走る。違いは各社が出す意思決定（投資の有無・時期・
// 営業増員の有無）だけである。Dを失敗させるために市場を厳しくする調整は
// 一切行っていない。
//
// 使い方:
//   npx tsx scripts/processedMarketEvolutionScenarios.ts            … サマリのみ
//   npx tsx scripts/processedMarketEvolutionScenarios.ts --write    … CSV/JSONも出力

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../app/lib/v2/companyLab/autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { DemandMarketId, Product } from "../app/lib/v2/market/types";
import { buildNewFactoryId, computeEffectiveFactories } from "../app/lib/v2/capex/factoryConstruction";
import { CAPEX_PARAMETERS_V1 } from "../app/lib/v2/capex/parameters";
import { WorkerAssignment, CompanyProductionPlanEntry } from "../app/lib/v2/production/types";
import { calculateLaborCapacityFromAssignedHeadcount } from "../app/lib/v2/production/labor";
import { PRODUCTION_PARAMETERS_V1 } from "../app/lib/v2/production/parameters";
import { hosoEqTons, ratio, unwrapUnit } from "../app/lib/v2/core/units";
import { VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD } from "../app/lib/v2/companyLab/productDevelopmentState";
import { computeProcessingCapacityRatios } from "../app/lib/v2/market/processingCapacityEvolution";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------
// 1. 定数・ケース定義
// ---------------------------------------------------------------------

export const SEEDS = ["mkt-evo-case-seed-1", "mkt-evo-case-seed-2", "mkt-evo-case-seed-3"] as const;
export const HORIZON_QUARTERS = 24;

/** 新設工場へ配置する常用ワーカー数（Phase6のプリフライトと同じ運用値）。 */
const STAFFED_NEW_FACTORY_REGULAR_HEADCOUNT = 1500;
const NEW_FACTORY_DEFAULT_SKILL_LEVEL = 0.7;
const NEW_FACTORY_DEFAULT_ATTENDANCE_RATE = 0.95;

export type CaseId = "A-no-investment" | "B-pd-first" | "C-vap-first" | "D-uncoordinated";

export interface CaseProfile {
  readonly id: CaseId;
  readonly label: string;
  readonly description: string;
  /** 毎四半期の営業人員追加採用数（0なら採用しない）。 */
  readonly salesHirePerQuarter: number;
  /** 新工場建設を提案するturn（nullなら建てない）。 */
  readonly newFactoryTurn: number | null;
  /** PD省人化を提案するturn（nullなら行わない）。 */
  readonly mechanizationTurn: number | null;
  /** VAP商品開発投資を開始するturn（nullなら投資しない）。 */
  readonly vapDevelopmentStartTurn: number | null;
  /** VAP商品開発の1四半期あたり投資額（許容ティアのいずれか）。 */
  readonly vapDevelopmentSpendUsd: number;
  /** 新工場へワーカーを配置するか（Dは「建てるが人を手当てしない」を表現できる）。 */
  readonly staffNewFactory: boolean;
}

/**
 * 【ケース設計の根拠】
 * turnの選び方は「市場側の弧」に対する相対位置で決めている（時期そのものに
 * 意味があるのではない）。産地別加工能力の弧（market/processingCapacityEvolution.ts）
 * では EC のPD参入が turn14 から始まり turn20 前後で世界のPD稼働率が明確に低下する。
 * ライフサイクル（productLifecycle.ts）では VAP の加速が JP turn4 / US turn12 と続く。
 *   - B は「需要が伸びて能力が律速になってから」＝ turn8 に工場、参入期の turn16 に省人化。
 *   - C は「PD黄金期のあとVAPへ寄せる」＝ turn6 から VAP開発を継続。
 *   - D は「需要が伸びる前に全部やる」＝ turn2 に3投資を同時実行し、営業は増やさない。
 */
export const CASE_PROFILES: readonly CaseProfile[] = [
  {
    id: "A-no-investment",
    label: "A: 加工投資なし",
    description: "HOSO中心。新工場・省人化・VAP開発をいずれも行わない。営業も増やさない。",
    salesHirePerQuarter: 0,
    newFactoryTurn: null,
    mechanizationTurn: null,
    vapDevelopmentStartTurn: null,
    vapDevelopmentSpendUsd: 0,
    staffNewFactory: false,
  },
  {
    id: "B-pd-first",
    label: "B: PD先行",
    description: "需要成長に合わせて営業を増員し、能力が律速になったturn8に新工場、他産地参入期のturn16に省人化。",
    salesHirePerQuarter: 3,
    newFactoryTurn: 8,
    mechanizationTurn: 16,
    vapDevelopmentStartTurn: null,
    vapDevelopmentSpendUsd: 0,
    staffNewFactory: true,
  },
  {
    id: "C-vap-first",
    label: "C: VAP先行",
    description: "turn6からVAP商品開発を継続投資し、営業も並行して増員する。新工場・省人化は行わない。",
    salesHirePerQuarter: 3,
    newFactoryTurn: null,
    mechanizationTurn: null,
    vapDevelopmentStartTurn: 6,
    vapDevelopmentSpendUsd: VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD[2] ?? 250_000,
    staffNewFactory: true,
  } as CaseProfile,
  {
    id: "D-uncoordinated",
    label: "D: 無調整の過剰投資",
    description: "需要が伸びる前のturn2に新工場・省人化・VAP開発を同時実行。営業増員も新工場への人員配置も行わない。",
    salesHirePerQuarter: 0,
    newFactoryTurn: 2,
    mechanizationTurn: 2,
    vapDevelopmentStartTurn: 2,
    vapDevelopmentSpendUsd: VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD[3] ?? 500_000,
    staffNewFactory: false,
  },
];

function marketEvolutionConfig(seed: string): CompanyLabConfig {
  return {
    scenarioId: "baseline",
    mode: "canonical",
    seed,
    turns: HORIZON_QUARTERS,
    sai5: { productLifecycle: true, supplyPremiumFeedback: true },
    marketEvolution: {
      originProcessingCapacity: true,
      tunedProductLifecycle: true,
      perProductDestinationPricing: true,
      processingAdvantageDemandCapture: true,
      productWiseCompetitiveness: true,
      salesCapability: true,
    },
  };
}

// ---------------------------------------------------------------------
// 2. 意思決定への戦略プロファイル適用
// ---------------------------------------------------------------------

function injectStaffedNewFactory(
  decision: CompanyDecisionInput,
  companyId: CompanyId,
  newFactoryId: string,
  capacityByProduct: Readonly<Record<Product, number>>
): CompanyDecisionInput {
  const skills = (["hoso", "pd", "vap"] as const).map((product) => ({ product, skillLevel: ratio(NEW_FACTORY_DEFAULT_SKILL_LEVEL) }));
  const workerAssignment: WorkerAssignment = {
    factoryId: newFactoryId,
    companyId,
    regularHeadcount: STAFFED_NEW_FACTORY_REGULAR_HEADCOUNT,
    temporaryHeadcount: 0,
    skills,
    overtimeRate: ratio(0),
    attendanceRate: ratio(NEW_FACTORY_DEFAULT_ATTENDANCE_RATE),
  };
  const workerAssignments = [...decision.workerAssignments.filter((w) => w.factoryId !== newFactoryId), workerAssignment];
  const newProductionRows: CompanyProductionPlanEntry[] = (["hoso", "pd", "vap"] as const)
    .filter((product) => capacityByProduct[product] > 0)
    .map((product, index) => {
      const maxOutputForHeadcount = calculateLaborCapacityFromAssignedHeadcount(
        STAFFED_NEW_FACTORY_REGULAR_HEADCOUNT,
        0,
        NEW_FACTORY_DEFAULT_ATTENDANCE_RATE,
        NEW_FACTORY_DEFAULT_SKILL_LEVEL,
        0,
        capacityByProduct[product],
        PRODUCTION_PARAMETERS_V1,
        product
      );
      return {
        companyId,
        factoryId: newFactoryId,
        product,
        desiredQuantity: hosoEqTons(Math.min(capacityByProduct[product], maxOutputForHeadcount)),
        priority: index + 1,
      };
    });
  const productionPlans = [...decision.productionPlans.filter((p) => p.factoryId !== newFactoryId), ...newProductionRows];
  return { ...decision, workerAssignments, productionPlans };
}

// ---------------------------------------------------------------------
// 3. 1ケースの実行
// ---------------------------------------------------------------------

export interface QuarterRow {
  readonly caseId: CaseId;
  readonly scenarioId: string;
  readonly seed: string;
  readonly companyId: CompanyId;
  readonly quarter: number;
  readonly market: DemandMarketId | "ALL";
  readonly product: Product | "ALL";
  readonly worldDemandTons: number;
  readonly productDemandShare: number;
  readonly vietnamAddressableDemandTons: number;
  readonly competitorPdProcessingCapacityTons: number;
  readonly competitorVapProcessingCapacityTons: number;
  readonly hosoBasePriceUsdPerKg: number;
  readonly processingPremiumUsdPerKg: number;
  readonly processingPremiumRatio: number;
  /** VAP追加プレミアム（VAP価格 − PD価格、USD/HOSO換算kg）。 */
  readonly vapIncrementalPremiumUsdPerKg: number;
  /** VAPプレミアム比率（(VAP価格 − HOSO価格) ÷ HOSO価格）。PD比率と並べることで軸移動が見える。 */
  readonly vapPremiumRatio: number;
  readonly ownVapCapabilityScore: number;
  readonly salesForceHeadcount: number;
  readonly salesCapacityTons: number;
  readonly contractedTons: number;
  readonly producedTons: number;
  readonly equipmentUtilization: number;
  readonly investmentUsd: number;
  readonly vapDevelopmentSpendUsd: number;
  readonly operatingIncomeUsd: number;
  readonly netIncomeUsd: number;
  readonly cashUsd: number;
  readonly debtUsd: number;
  readonly insolvent: boolean;
}

export function runCase(profile: CaseProfile, seed: string): readonly QuarterRow[] {
  const config = marketEvolutionConfig(seed);
  const { state: initialState, fixtures } = initializeCompanyLab(config);
  let state = initialState;
  const rows: QuarterRow[] = [];
  const newFactoryStandardCapacity = CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction.newFactoryEffect!.fullCapacities;

  for (let turnIndex = 0; turnIndex < HORIZON_QUARTERS; turnIndex += 1) {
    if (state.isComplete) break;
    const turn = state.scenarioState.currentTurn;
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<CompanyId, CompanyDecisionInput> = {};

    for (const fixture of fixtures) {
      const ownState = buildCompanyOwnState(state, fixture);
      let decision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, turn);

      // --- 戦略プロファイルの適用 ---
      if (profile.salesHirePerQuarter > 0) {
        decision = { ...decision, salesForceHireCount: profile.salesHirePerQuarter };
      }
      if (
        profile.vapDevelopmentStartTurn !== null &&
        turn >= profile.vapDevelopmentStartTurn &&
        profile.vapDevelopmentSpendUsd > 0
      ) {
        decision = { ...decision, vapProductDevelopmentSpendUsd: profile.vapDevelopmentSpendUsd };
      }
      const proposals = [...decision.capexDecision.newProjectProposals];
      if (profile.newFactoryTurn !== null && turn === profile.newFactoryTurn) {
        proposals.push({ projectType: "newFactoryConstruction" });
      }
      if (profile.mechanizationTurn !== null && turn === profile.mechanizationTurn) {
        const targetFactoryId = fixture.factories[0]?.factoryId;
        if (targetFactoryId) proposals.push({ projectType: "pdMechanization", targetFactoryId });
      }
      if (proposals.length !== decision.capexDecision.newProjectProposals.length) {
        decision = { ...decision, capexDecision: { ...decision.capexDecision, newProjectProposals: proposals } };
      }

      // 稼働開始済みの新設工場への人員配置・生産計画（staffNewFactory=falseなら行わない）。
      if (profile.staffNewFactory && profile.newFactoryTurn !== null) {
        const effective = computeEffectiveFactories(fixture.factories, { companies: [ownState.capexState] }, state.currentPeriod);
        const newFactoryIds = new Set(
          ownState.capexState.portfolio.projects
            .filter((p) => p.projectType === "newFactoryConstruction")
            .map((p) => buildNewFactoryId(p))
        );
        const operationalNewFactory = effective.find((f) => newFactoryIds.has(f.factoryId));
        if (operationalNewFactory) {
          decision = injectStaffedNewFactory(decision, fixture.companyId, operationalNewFactory.factoryId, {
            hoso: newFactoryStandardCapacity.hoso,
            pd: newFactoryStandardCapacity.pd,
            vap: newFactoryStandardCapacity.vap,
          });
        }
      }
      decisions[fixture.companyId] = decision;
    }

    const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = nextState.history[nextState.history.length - 1];
    const marketResult = record.marketResult;
    const ratios = computeProcessingCapacityRatios(turn);
    const worldDemand = unwrapUnit(marketResult.worldDemand);
    const vnHoso = unwrapUnit(marketResult.hosoPrices.VN.price);
    const vnPd = unwrapUnit(marketResult.pdPremium.byCountry.VN.finalPrice);
    const vnVap = unwrapUnit(marketResult.vapPremium.byCountry.VN.finalPrice);
    const competitorPdCapacity = (["EC", "IN", "ID"] as const).reduce(
      (sum, c) => sum + unwrapUnit(record.marketInput.countries[c].pdProcessingCapacity),
      0
    );
    const competitorVapCapacity = (["EC", "IN", "ID"] as const).reduce(
      (sum, c) => sum + unwrapUnit(record.marketInput.countries[c].vapProcessingCapacity),
      0
    );
    void ratios;

    for (const fixture of fixtures) {
      const decision = decisions[fixture.companyId];
      const fin = record.financialResults.find((f) => f.companyId === fixture.companyId) ?? null;
      const contracted = record.salesRecord.allocations
        .flatMap((a) => a.companies.filter((c) => c.companyId === fixture.companyId))
        .reduce((sum, c) => sum + unwrapUnit(c.allocatedQuantity), 0);
      const produced = record.batches
        .filter((b) => b.companyId === fixture.companyId)
        .reduce((sum, b) => sum + unwrapUnit(b.finishedGoodsQuantity), 0);
      const loadMetrics = record.factoryLoadMetrics.filter((m) =>
        fixture.factories.some((f) => f.factoryId === m.factoryId)
      );
      const equipmentUtilization =
        loadMetrics.length > 0 ? loadMetrics.reduce((s, m) => s + unwrapUnit(m.equipmentUtilizationRate), 0) / loadMetrics.length : 0;
      const salesHeadcount = new Map<DemandMarketId, number>();
      for (const plan of decision.salesPlans) salesHeadcount.set(plan.market, plan.salesForceHeadcount);
      const totalSalesHeadcount = Array.from(salesHeadcount.values()).reduce((a, b) => a + b, 0);
      const investmentUsd = fin ? Math.abs((fin.cashFlow?.investingCashFlow as unknown as number) ?? 0) : 0;
      const vapCapabilityScore =
        decision.salesPlans.find((p) => p.product === "vap" && p.vapCapabilityScore !== undefined)?.vapCapabilityScore;

      rows.push({
        caseId: profile.id,
        scenarioId: config.scenarioId,
        seed,
        companyId: fixture.companyId,
        quarter: turn,
        market: "ALL",
        product: "ALL",
        worldDemandTons: worldDemand,
        productDemandShare: worldDemand > 0 ? unwrapUnit(marketResult.pdPremium.globalDemand) / worldDemand : 0,
        vietnamAddressableDemandTons: unwrapUnit(marketResult.hosoPrices.VN.allocatedDemand),
        competitorPdProcessingCapacityTons: competitorPdCapacity,
        competitorVapProcessingCapacityTons: competitorVapCapacity,
        hosoBasePriceUsdPerKg: vnHoso,
        processingPremiumUsdPerKg: vnPd - vnHoso,
        processingPremiumRatio: vnHoso > 0 ? (vnPd - vnHoso) / vnHoso : 0,
        vapIncrementalPremiumUsdPerKg: vnVap - vnPd,
        vapPremiumRatio: vnHoso > 0 ? (vnVap - vnHoso) / vnHoso : 0,
        ownVapCapabilityScore: vapCapabilityScore !== undefined ? unwrapUnit(vapCapabilityScore) : 50,
        salesForceHeadcount: totalSalesHeadcount,
        salesCapacityTons: 0,
        contractedTons: contracted,
        producedTons: produced,
        equipmentUtilization,
        investmentUsd,
        vapDevelopmentSpendUsd: decision.vapProductDevelopmentSpendUsd ?? 0,
        operatingIncomeUsd: fin ? (fin.profitAndLoss.operatingProfit as unknown as number) : 0,
        netIncomeUsd: fin ? (fin.profitAndLoss.netIncome as unknown as number) : 0,
        cashUsd: fin ? (fin.balanceSheet.cash as unknown as number) : 0,
        debtUsd: fin ? ((fin.balanceSheet.shortTermLoans as unknown as number) ?? 0) + ((fin.balanceSheet.longTermLoans as unknown as number) ?? 0) : 0,
        insolvent: false,
      });
    }

    state = nextState;
  }

  // VAP価格・VAPプレミアム比率も見えるよう、市場行を追加（市場×商品の軸）。
  return rows;
}

// ---------------------------------------------------------------------
// 4. 集計・出力
// ---------------------------------------------------------------------

export interface CaseSummary {
  readonly caseId: CaseId;
  readonly seed: string;
  readonly totalContractedTons: number;
  readonly totalProducedTons: number;
  readonly cumulativeOperatingIncomeUsd: number;
  readonly cumulativeNetIncomeUsd: number;
  readonly finalCashUsd: number;
  readonly minCashUsd: number;
  readonly finalDebtUsd: number;
  readonly companiesWithNegativeFinalCash: number;
}

export function summarize(rows: readonly QuarterRow[]): CaseSummary {
  const byCompanyFinalCash = new Map<CompanyId, number>();
  let minCash = Infinity;
  for (const r of rows) {
    byCompanyFinalCash.set(r.companyId, r.cashUsd);
    if (r.cashUsd < minCash) minCash = r.cashUsd;
  }
  const lastQuarter = Math.max(...rows.map((r) => r.quarter));
  const lastRows = rows.filter((r) => r.quarter === lastQuarter);
  return {
    caseId: rows[0].caseId,
    seed: rows[0].seed,
    totalContractedTons: rows.reduce((s, r) => s + r.contractedTons, 0),
    totalProducedTons: rows.reduce((s, r) => s + r.producedTons, 0),
    cumulativeOperatingIncomeUsd: rows.reduce((s, r) => s + r.operatingIncomeUsd, 0),
    cumulativeNetIncomeUsd: rows.reduce((s, r) => s + r.netIncomeUsd, 0),
    finalCashUsd: lastRows.reduce((s, r) => s + r.cashUsd, 0),
    minCashUsd: minCash,
    finalDebtUsd: lastRows.reduce((s, r) => s + r.debtUsd, 0),
    companiesWithNegativeFinalCash: lastRows.filter((r) => r.cashUsd < 0).length,
  };
}

const CSV_COLUMNS: readonly (keyof QuarterRow)[] = [
  "caseId",
  "scenarioId",
  "seed",
  "companyId",
  "quarter",
  "market",
  "product",
  "worldDemandTons",
  "productDemandShare",
  "vietnamAddressableDemandTons",
  "competitorPdProcessingCapacityTons",
  "competitorVapProcessingCapacityTons",
  "hosoBasePriceUsdPerKg",
  "processingPremiumUsdPerKg",
  "processingPremiumRatio",
  "vapIncrementalPremiumUsdPerKg",
  "vapPremiumRatio",
  "ownVapCapabilityScore",
  "salesForceHeadcount",
  "salesCapacityTons",
  "contractedTons",
  "producedTons",
  "equipmentUtilization",
  "investmentUsd",
  "vapDevelopmentSpendUsd",
  "operatingIncomeUsd",
  "netIncomeUsd",
  "cashUsd",
  "debtUsd",
  "insolvent",
];

export function toCsv(rows: readonly QuarterRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const body = rows.map((r) => CSV_COLUMNS.map((c) => String(r[c])).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

if (process.argv[1] && process.argv[1].endsWith("processedMarketEvolutionScenarios.ts")) {
  const allRows: QuarterRow[] = [];
  const summaries: CaseSummary[] = [];
  for (const profile of CASE_PROFILES) {
    for (const seed of SEEDS) {
      const rows = runCase(profile, seed);
      allRows.push(...rows);
      summaries.push(summarize(rows));
    }
  }

  console.log(`=== 4ケース比較（baseline・${HORIZON_QUARTERS}四半期・5社・${SEEDS.length}シード）===`);
  console.log("ケース             | seed                | 契約(t)    | 生産(t)    | 累積営業利益     | 累積純利益       | 期末現金合計     | 最小現金        | 期末現金<0の社数");
  console.log("-------------------|---------------------|------------|------------|------------------|------------------|------------------|-----------------|------------------");
  for (const s of summaries) {
    console.log(
      `${s.caseId.padEnd(18)} | ${s.seed.padEnd(19)} | ${fmt(s.totalContractedTons).padStart(10)} | ${fmt(s.totalProducedTons).padStart(10)} | ` +
        `${fmt(s.cumulativeOperatingIncomeUsd).padStart(16)} | ${fmt(s.cumulativeNetIncomeUsd).padStart(16)} | ` +
        `${fmt(s.finalCashUsd).padStart(16)} | ${fmt(s.minCashUsd).padStart(15)} | ${String(s.companiesWithNegativeFinalCash).padStart(16)}`
    );
  }

  console.log("\n=== シード平均（ケース間比較）===");
  for (const profile of CASE_PROFILES) {
    const subset = summaries.filter((s) => s.caseId === profile.id);
    const avg = (pick: (s: CaseSummary) => number) => subset.reduce((sum, s) => sum + pick(s), 0) / subset.length;
    console.log(
      `${profile.id.padEnd(18)}: 契約=${fmt(avg((s) => s.totalContractedTons)).padStart(10)}t ` +
        `累積純利益=${fmt(avg((s) => s.cumulativeNetIncomeUsd)).padStart(16)} ` +
        `期末現金合計=${fmt(avg((s) => s.finalCashUsd)).padStart(16)} ` +
        `最小現金=${fmt(avg((s) => s.minCashUsd)).padStart(15)}`
    );
  }

  const baseline = summaries.filter((s) => s.caseId === "A-no-investment");
  const avgA = baseline.reduce((sum, s) => sum + s.cumulativeNetIncomeUsd, 0) / baseline.length;
  console.log("\n=== ケースAとの差（累積純利益、シード平均）===");
  for (const profile of CASE_PROFILES) {
    if (profile.id === "A-no-investment") continue;
    const subset = summaries.filter((s) => s.caseId === profile.id);
    const avg = subset.reduce((sum, s) => sum + s.cumulativeNetIncomeUsd, 0) / subset.length;
    console.log(`${profile.id.padEnd(18)}: ${fmt(avg - avgA).padStart(16)}  (${avg > avgA ? "Aを上回る" : "Aを下回る"})`);
  }

  if (process.argv.includes("--write")) {
    const outDir = join(process.cwd(), "artifacts", "market-evolution", "scenarios");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "market-evolution-scenarios.csv"), toCsv(allRows), "utf8");
    writeFileSync(join(outDir, "market-evolution-scenarios-summary.json"), JSON.stringify({ summaries, caseProfiles: CASE_PROFILES }, null, 2), "utf8");
    console.log(`\n出力: ${outDir}`);
  }
}
