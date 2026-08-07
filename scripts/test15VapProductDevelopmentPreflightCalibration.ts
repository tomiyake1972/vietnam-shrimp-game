// ShrimpX V2 — Test15前 VAP商品開発投資 プリフライト校正（Phase7・診断専用スクリプト）
//
// 【本スクリプトの位置づけ（重要）】
//   これは診断専用スクリプトであり、ゲーム本体の共有デフォルトパラメータ
//   （companyLab/productDevelopmentState.ts の PRODUCT_DEVELOPMENT_PARAMETERS_V1・
//   companyLab/premiumPolicy.ts の VAP_CAPABILITY_WEIGHTS_V1 等）を一切変更しない。
//   4段階のVAP商品開発費（$0/$100,000/$250,000/$500,000）を毎四半期一定額で
//   BALへ入力するのみの、このスクリプト内だけで完結するシナリオ構築である。
//   他の4社・他の会社ラボ呼び出し元は一切触れていない。
//
// 【メカニズム（コード読解で確認済み）】
//   VAP商品開発費（CompanyDecisionInput.vapProductDevelopmentSpendUsd）は、
//   companyLab/productDevelopmentState.tsのupdateProductDevelopmentStateで、
//   ヘッドルーム付きの式（score += gainCoefficient(4.0) ×
//   min(spend/standardBudgetUsd(250,000), investmentRatioCap(2.0)) ×
//   headroom(=1-score/100)）により、会社のVAP商品開発スコア（0〜100、中立50）を
//   更新する。spend=0の四半期は中立値50へ向けて6%/四半期で減衰する。
//   このスコアは companyLab/premiumPolicy.ts の
//   calculateCompanyCapabilityCoefficient経由（重み0.4、他に営業基盤0.3・
//   品質0.2・納期信頼性0.1）で「VAP能力合成係数(vapCapabilityScore)」へ合成され、
//   sales/allocation.tsのvapCapability競争力ウェイトとして、他社とのVAP需要の
//   奪い合い（配分）に効く。すなわちVAP商品開発費は生産能力そのものを増やすの
//   ではなく、「他社よりVAP需要を多く獲得できる競争力」を底上げする投資である。

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../app/lib/v2/companyLab/autoPolicy";
import { CompanyDecisionInput, CompanyLabState, CompanyQuarterRecord } from "../app/lib/v2/companyLab/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { extractCompanyFinancialResult } from "../app/v2/company-lab/play/_lib/financialViewSelectors";
import { PRODUCT_DEVELOPMENT_PARAMETERS_V1, VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD } from "../app/lib/v2/companyLab/productDevelopmentState";
import { VAP_CAPABILITY_WEIGHTS_V1, calculateCompanyCapabilityCoefficient } from "../app/lib/v2/companyLab/premiumPolicy";
import { lookupSalesBaseScore } from "../app/lib/v2/companyLab/salesBase";
import { DEMAND_MARKET_IDS } from "../app/lib/v2/market/types";
import { score0to100, unwrapUnit } from "../app/lib/v2/core/units";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const FOCUS_COMPANY_ID = "BAL";
const HORIZON_QUARTERS = 12; // 4段階を同一12四半期ずつ、一定spendで維持する

export const SEEDS: readonly string[] = [
  "test15-vapdev-seed-1",
  "test15-vapdev-seed-2",
  "test15-vapdev-seed-3",
];

export const SPEND_LEVELS_USD: readonly number[] = VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD; // [0, 100_000, 250_000, 500_000]

// ---------------------------------------------------------------------
// 0. 報告専用: VAP能力合成係数の再現（companyLab/runner.tsの
//    applyAuthoritativeVapCapabilityScoresと厳密に同じ入力・同じ関数
//    （calculateCompanyCapabilityCoefficient）を使う。エンジン内部では
//    advanceCompanyLabQuarter呼び出しの最中にdecision側へ上書きされるため、
//    呼び出し側（本スクリプト）が渡すdecisionには反映されない。報告用に
//    「エンジンが当四半期実際に使った値」を、エンジンと同一の計算経路で
//    複製するだけであり、新しい計算式を作るものではない。
// ---------------------------------------------------------------------

function computeReportedVapCapabilityScore(state: CompanyLabState, companyId: CompanyId, productDevelopmentScore: number): number {
  const vapSalesBaseScores = DEMAND_MARKET_IDS.map((market) => lookupSalesBaseScore(state.salesBaseState, companyId, market, "vap"));
  const salesBaseAvg = vapSalesBaseScores.reduce((s, v) => s + v, 0) / Math.max(1, vapSalesBaseScores.length);
  const qualityEntry = state.qualityState.qualityByCompanyProduct.find((q) => q.companyId === companyId && q.product === "vap");
  const qualityScore = qualityEntry?.qualityScore;
  const trustEntries = state.qualityState.trustByCompanyMarket.filter((t) => t.companyId === companyId);
  const deliveryAvg =
    trustEntries.length > 0 ? trustEntries.reduce((s, t) => s + unwrapUnit(t.deliveryReliabilityScore), 0) / trustEntries.length : undefined;
  return calculateCompanyCapabilityCoefficient({
    productDevelopmentScore: score0to100(productDevelopmentScore),
    salesBaseScore: score0to100(salesBaseAvg),
    qualityScore,
    deliveryReliabilityScore: deliveryAvg !== undefined ? score0to100(deliveryAvg) : undefined,
  });
}

// ---------------------------------------------------------------------
// 1. 1ケースぶんのシミュレーション（実エンジンを通す。並行計算式を作らない）
// ---------------------------------------------------------------------

export interface QuarterMetricsRow {
  readonly seed: string;
  readonly spendLevelUsd: number;
  readonly companyId: string;
  readonly quarter: number;
  readonly period: string;
  readonly vapProductDevelopmentSpendUsd: number;
  readonly cumulativeSpendUsd: number;
  readonly vapDevScore: number; // 当四半期開始時点（前四半期末まで）のスコア
  readonly vapDevScoreIncrease: number; // 前四半期末からの増分
  readonly vapCapabilityScore: number; // 当四半期にエンジンが実際に使ったVAP能力合成係数（報告用に同一経路で複製）
  readonly vapDesiredQuantityTons: number; // 成約希望量（salesPlansのvap合計desiredQuantity）
  readonly vapNewContractedQuantityTons: number; // 成約量（当四半期の新規契約合計数量）
  readonly vapNewContractValueUsdApprox: number; // 新規成約金額の概算（原単価×数量の合計。厳密な当期認識売上ではない）
  readonly vapFulfilledQuantityTons: number; // 当四半期に実際に出荷・履行された数量（販売数量）
  readonly vapProducedTons: number;
  readonly netIncomeUsd: number;
  readonly cashUsd: number;
  readonly insolvent: boolean;
}

export interface CaseRunOptions {
  readonly seed: string;
  readonly spendLevelUsd: number;
  readonly horizonQuarters: number;
}

export function runCase(options: CaseRunOptions): readonly QuarterMetricsRow[] {
  const config = { scenarioId: "baseline" as const, mode: "canonical" as const, seed: options.seed, turns: options.horizonQuarters };
  const { state: initialState, fixtures } = initializeCompanyLab(config);
  const focusFixture = fixtures.find((f) => f.companyId === FOCUS_COMPANY_ID)!;

  let state: CompanyLabState = initialState;
  const rows: QuarterMetricsRow[] = [];
  let cumulativeSpend = 0;
  let previousScore = PRODUCT_DEVELOPMENT_PARAMETERS_V1.neutralScore;

  for (let turn = 0; turn < options.horizonQuarters; turn++) {
    if (state.isComplete) break;
    const publicInfo = buildPublicMarketInfo(state);
    const ownStateBefore = buildCompanyOwnState(state, focusFixture);
    const scoreAtQuarterStart = ownStateBefore.vapProductDevelopmentScore;

    const decisions: Record<CompanyId, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      const ownState = buildCompanyOwnState(state, f);
      let decision = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
      if (f.companyId === FOCUS_COMPANY_ID && options.spendLevelUsd > 0) {
        decision = { ...decision, vapProductDevelopmentSpendUsd: options.spendLevelUsd };
      }
      decisions[f.companyId] = decision;
    }

    const balDecisionForQuarter = decisions[FOCUS_COMPANY_ID];
    const vapCapabilityScoreForQuarter = computeReportedVapCapabilityScore(state, FOCUS_COMPANY_ID as CompanyId, scoreAtQuarterStart);

    const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record: CompanyQuarterRecord = nextState.history[nextState.history.length - 1];
    const financial = extractCompanyFinancialResult(record, FOCUS_COMPANY_ID);
    const summary = record.companySummaries.find((s) => s.companyId === FOCUS_COMPANY_ID)!;

    const vapDesiredQuantityTons = balDecisionForQuarter.salesPlans
      .filter((p) => p.product === "vap")
      .reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
    const vapNewContracts = record.salesRecord.newContracts.filter((c) => c.companyId === FOCUS_COMPANY_ID && c.product === "vap");
    const vapNewContractedQuantityTons = vapNewContracts.reduce((s, c) => s + unwrapUnit(c.originalQuantity), 0);
    const vapNewContractValueUsdApprox = vapNewContracts.reduce((s, c) => s + unwrapUnit(c.originalQuantity) * unwrapUnit(c.unitPrice) * 1000, 0);
    const vapFulfilledQuantityTons = record.fulfillmentPlan.finishedGoodsConsumption
      .filter((e) => e.companyId === FOCUS_COMPANY_ID && e.product === "vap")
      .reduce((s, e) => s + unwrapUnit(e.quantity), 0);

    cumulativeSpend += options.spendLevelUsd;

    rows.push({
      seed: options.seed,
      spendLevelUsd: options.spendLevelUsd,
      companyId: FOCUS_COMPANY_ID,
      quarter: record.turn,
      period: record.period,
      vapProductDevelopmentSpendUsd: options.spendLevelUsd,
      cumulativeSpendUsd: cumulativeSpend,
      vapDevScore: scoreAtQuarterStart,
      vapDevScoreIncrease: scoreAtQuarterStart - previousScore,
      vapCapabilityScore: vapCapabilityScoreForQuarter,
      vapDesiredQuantityTons,
      vapNewContractedQuantityTons,
      vapNewContractValueUsdApprox,
      vapFulfilledQuantityTons,
      vapProducedTons: unwrapUnit(summary.vapProduced),
      netIncomeUsd: financial ? (financial.profitAndLoss.netIncome as unknown as number) : 0,
      cashUsd: financial ? (financial.balanceSheet.cash as unknown as number) : 0,
      insolvent: financial ? financial.negativeEquity || financial.cashShortfall : false,
    });

    previousScore = scoreAtQuarterStart;
    state = nextState;
  }

  return rows;
}

// ---------------------------------------------------------------------
// 2. 全体オーケストレーション
// ---------------------------------------------------------------------

export interface SeedResult {
  readonly seed: string;
  readonly rowsByLevel: ReadonlyMap<number, readonly QuarterMetricsRow[]>;
}

export function runFullStudy(): readonly SeedResult[] {
  return SEEDS.map((seed) => {
    const rowsByLevel = new Map<number, readonly QuarterMetricsRow[]>();
    for (const level of SPEND_LEVELS_USD) {
      rowsByLevel.set(level, runCase({ seed, spendLevelUsd: level, horizonQuarters: HORIZON_QUARTERS }));
    }
    return { seed, rowsByLevel };
  });
}

function cumulativeNetIncome(rows: readonly QuarterMetricsRow[]): number {
  return rows.reduce((s, r) => s + r.netIncomeUsd, 0);
}

/** 各四半期で、spend>0の水準がbaseline($0)を成約量で上回った、最初の四半期番号（無ければnull）。 */
export function findFirstQuarterOutperformingBaseline(
  levelRows: readonly QuarterMetricsRow[],
  baselineRows: readonly QuarterMetricsRow[]
): number | null {
  for (let i = 0; i < levelRows.length; i++) {
    const l = levelRows[i];
    const b = baselineRows[i];
    if (!b) continue;
    if (l.vapNewContractedQuantityTons > b.vapNewContractedQuantityTons + 1e-6) return l.quarter;
  }
  return null;
}

// ---------------------------------------------------------------------
// 3. CSV/JSON出力
// ---------------------------------------------------------------------

const CSV_COLUMNS: readonly (keyof QuarterMetricsRow)[] = [
  "seed",
  "spendLevelUsd",
  "companyId",
  "quarter",
  "period",
  "vapProductDevelopmentSpendUsd",
  "cumulativeSpendUsd",
  "vapDevScore",
  "vapDevScoreIncrease",
  "vapCapabilityScore",
  "vapDesiredQuantityTons",
  "vapNewContractedQuantityTons",
  "vapNewContractValueUsdApprox",
  "vapFulfilledQuantityTons",
  "vapProducedTons",
  "netIncomeUsd",
  "cashUsd",
  "insolvent",
];

export function toCsv(rows: readonly QuarterMetricsRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((r) => CSV_COLUMNS.map((c) => String(r[c])).join(","));
  return [header, ...lines].join("\n");
}

export function writeStudyOutputs(results: readonly SeedResult[], outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  const allRows: QuarterMetricsRow[] = results.flatMap((r) => SPEND_LEVELS_USD.flatMap((level) => r.rowsByLevel.get(level) ?? []));
  writeFileSync(join(outDir, "test15-vap-product-development-preflight.csv"), toCsv(allRows), "utf8");
  writeFileSync(
    join(outDir, "test15-vap-product-development-preflight.json"),
    JSON.stringify(
      {
        seeds: SEEDS,
        spendLevelsUsd: SPEND_LEVELS_USD,
        results: results.map((r) => ({
          seed: r.seed,
          byLevel: SPEND_LEVELS_USD.map((level) => {
            const rows = r.rowsByLevel.get(level) ?? [];
            const baselineRows = r.rowsByLevel.get(0) ?? [];
            return {
              spendLevelUsd: level,
              cumulativeNetIncomeUsd: cumulativeNetIncome(rows),
              cumulativeNetIncomeVsBaselineUsd: cumulativeNetIncome(rows) - cumulativeNetIncome(baselineRows),
              finalVapDevScore: rows[rows.length - 1]?.vapDevScore ?? null,
              totalVapNewContractedQuantityTons: rows.reduce((s, row) => s + row.vapNewContractedQuantityTons, 0),
              totalVapFulfilledQuantityTons: rows.reduce((s, row) => s + row.vapFulfilledQuantityTons, 0),
              firstQuarterOutperformingBaseline: level > 0 ? findFirstQuarterOutperformingBaseline(rows, baselineRows) : null,
            };
          }),
        })),
      },
      null,
      2
    ),
    "utf8"
  );
}

// ---------------------------------------------------------------------
// 4. CLIエントリポイント
// ---------------------------------------------------------------------

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function printStudySummary(results: readonly SeedResult[]): void {
  console.log("\n=== Test15前 VAP商品開発投資プリフライト校正 ===\n");
  console.log(`gainCoefficient=${PRODUCT_DEVELOPMENT_PARAMETERS_V1.gainCoefficient} standardBudgetUsd=${fmtUsd(PRODUCT_DEVELOPMENT_PARAMETERS_V1.standardBudgetUsd)} investmentRatioCap=${PRODUCT_DEVELOPMENT_PARAMETERS_V1.investmentRatioCap} idleDecayRatioPerQuarter=${PRODUCT_DEVELOPMENT_PARAMETERS_V1.idleDecayRatioPerQuarter}`);
  console.log(`VAP能力合成係数の重み: productDevelopment=${VAP_CAPABILITY_WEIGHTS_V1.productDevelopment} salesBase=${VAP_CAPABILITY_WEIGHTS_V1.salesBase} quality=${VAP_CAPABILITY_WEIGHTS_V1.quality} deliveryReliability=${VAP_CAPABILITY_WEIGHTS_V1.deliveryReliability}\n`);

  for (const r of results) {
    console.log(`--- seed=${r.seed} ---`);
    for (const level of SPEND_LEVELS_USD) {
      const rows = r.rowsByLevel.get(level)!;
      const baselineRows = r.rowsByLevel.get(0)!;
      const finalScore = rows[rows.length - 1]?.vapDevScore ?? 0;
      const totalContracted = rows.reduce((s, row) => s + row.vapNewContractedQuantityTons, 0);
      const totalContractedBaseline = baselineRows.reduce((s, row) => s + row.vapNewContractedQuantityTons, 0);
      const cumNet = cumulativeNetIncome(rows);
      const cumNetBaseline = cumulativeNetIncome(baselineRows);
      const firstOutperform = level > 0 ? findFirstQuarterOutperformingBaseline(rows, baselineRows) : null;
      console.log(
        `  spend=${fmtUsd(level)}/四半期 最終スコア=${finalScore.toFixed(1)} 累計VAP成約量=${totalContracted.toFixed(0)}トン(差=${(totalContracted - totalContractedBaseline).toFixed(0)}) ` +
          `累計純利益=${fmtUsd(cumNet)}(差=${fmtUsd(cumNet - cumNetBaseline)}) baseline上回った最初の四半期=${firstOutperform ?? "なし"}`
      );
    }
  }
}

if (require.main === module) {
  const results = runFullStudy();
  printStudySummary(results);
  const outDir = join(__dirname, "..", "artifacts", "test15", "preflight-calibration");
  writeStudyOutputs(results, outDir);
  console.log(`\nCSV/JSON出力: ${outDir}/test15-vap-product-development-preflight.csv / .json`);
}
