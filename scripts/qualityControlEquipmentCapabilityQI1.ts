// Standard AI Capability Expansion — Phase QI-I1 Benchmark
//
// qualityControlEquipmentのゲーム効果（capex/qualityControlEquipmentEffect.ts・
// companyLab/qualityControlEquipmentState.ts・quality/batchAdjustment.ts）を、
// Control（設備なし）・Q20/Q30/Q40（full effect 20%/30%/40%削減）の4候補 ×
// Normal/Moderate/Severe（操業ストレス）3環境 × HOSO/PD/VAP 3商品で比較する。
//
// 【この benchmark の設計】Standard AI はまだ qualityControlEquipment を提案しない
// （指示§12「絶対に接続しない」）ため、5社×32Qの通常シナリオを回しても実際には
// この投資が一度も発生しない。そこで、既存の品質モジュール純粋関数
// （applyQualityToBatches・updateQualityByCompanyProduct・updateCustomerTrustScore・
// calculateCompanyCapabilityCoefficient）を直接呼び出す、単一会社・単一工場の
// 制御されたマルチQシミュレーションとして構成する（新しいゲームロジックは
// 一切作らない。既存の公開関数をそのまま並べているだけ）。
//
// 出力:
//   docs/standard_ai/benchmarks/quality_control_equipment_qi1_summary.md
//   docs/standard_ai/benchmarks/quality_control_equipment_qi1_company.csv (candidate x stress x product x quarter)
//   docs/standard_ai/benchmarks/quality_control_equipment_qi1_timeline.csv (quarter-by-quarter detail)
//   docs/standard_ai/benchmarks/quality_control_equipment_qi1_off_on.csv (candidate comparison summary)
//
// 使い方: npx tsx scripts/qualityControlEquipmentCapabilityQI1.ts

import * as fs from "fs";
import * as path from "path";
import { period, nextPeriod, PeriodV2 } from "../app/lib/v2/core/period";
import { hosoEqTons, ratio, score0to100, unwrapUnit, usdM } from "../app/lib/v2/core/units";
import { Factory, FactoryLoadMetrics, ProductionBatch } from "../app/lib/v2/production/types";
import { CapexState, CapitalProject } from "../app/lib/v2/capex/types";
import { applyQualityToBatches } from "../app/lib/v2/quality/batchAdjustment";
import { updateQualityByCompanyProduct, updateCustomerTrustScore } from "../app/lib/v2/quality";
import { calculateCompanyCapabilityCoefficient } from "../app/lib/v2/companyLab/premiumPolicy";
import { buildQualityEquipmentRiskMultiplierByFactory } from "../app/lib/v2/companyLab/qualityControlEquipmentState";
import { QUALITY_PARAMETERS_V1, QualityParameters } from "../app/lib/v2/quality/parameters";
import { CompanyProductQualityState } from "../app/lib/v2/quality/types";
import { Product } from "../app/lib/v2/market/types";

const COMPANY_ID = "BENCH";
const FACTORY_ID = "BENCH-F1";
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
const QUARTERS_TO_TRACK = 6; // 完成後最低4Q追跡（指示§9）+ 完成直後2Qぶんの余裕
const SEEDS = ["seed-1", "seed-2", "seed-3", "seed-4", "seed-5"];

// 【指示§8】既存値がある場合の経済損失換算用の代表単価（USD/kg）。新しいROI
// ロジックをゲーム本体へ追加せず、分析用benchmarkだけで使う参考値であることを
// 明示する（既存テストフィクスチャで頻繁に使われる代表的なHOSO市場価格
// ~$5/kgを、3商品共通の簡易換算単価として流用。商品別の正確な単価は
// CompanyFixture.productEconomicsに存在するが、この独立benchmarkスクリプトは
// 特定会社のfixtureに依存しない設計にするため、代表値1つで近似する）。
const ILLUSTRATIVE_USD_PER_KG = 5;

interface Candidate {
  readonly name: string;
  readonly params: QualityParameters;
}

const CANDIDATES: readonly Candidate[] = [
  { name: "Control", params: { ...QUALITY_PARAMETERS_V1, qualityControlEquipment: { fullEffectRiskReductionRatio: 0, rampQuarters: 2 } } },
  { name: "Q20", params: { ...QUALITY_PARAMETERS_V1, qualityControlEquipment: { fullEffectRiskReductionRatio: 0.2, rampQuarters: 2 } } },
  { name: "Q30", params: { ...QUALITY_PARAMETERS_V1, qualityControlEquipment: { fullEffectRiskReductionRatio: 0.3, rampQuarters: 2 } } },
  { name: "Q40", params: { ...QUALITY_PARAMETERS_V1, qualityControlEquipment: { fullEffectRiskReductionRatio: 0.4, rampQuarters: 2 } } },
];

interface StressLevel {
  readonly name: string;
  readonly loadMetrics: Omit<FactoryLoadMetrics, "factoryId" | "companyId" | "period">;
}

const STRESS_LEVELS: readonly StressLevel[] = [
  {
    name: "Normal",
    loadMetrics: {
      equipmentUtilizationRate: ratio(0.75),
      laborUtilizationRate: ratio(0.75),
      overtimeRate: ratio(0),
      temporaryWorkerShare: ratio(0.05),
      productMixComplexity: ratio(0.1),
      averageRawMaterialAgeQuarters: 0.5,
      productionShortfallRate: ratio(0),
      processingLossRate: ratio(0),
    },
  },
  {
    name: "Moderate",
    loadMetrics: {
      equipmentUtilizationRate: ratio(0.9),
      laborUtilizationRate: ratio(0.9),
      overtimeRate: ratio(0.1),
      temporaryWorkerShare: ratio(0.25),
      productMixComplexity: ratio(0.4),
      averageRawMaterialAgeQuarters: 2,
      productionShortfallRate: ratio(0),
      processingLossRate: ratio(0),
    },
  },
  {
    name: "Severe",
    loadMetrics: {
      equipmentUtilizationRate: ratio(0.98),
      laborUtilizationRate: ratio(0.98),
      overtimeRate: ratio(0.2),
      temporaryWorkerShare: ratio(0.5),
      productMixComplexity: ratio(0.8),
      averageRawMaterialAgeQuarters: 3.5,
      productionShortfallRate: ratio(0),
      processingLossRate: ratio(0),
    },
  },
];

const P_COMPLETION = period(2020, 1); // 設備完成期
const PRODUCTION_QUANTITY_TONS = 1000;

function makeFactory(): Factory {
  return {
    factoryId: FACTORY_ID,
    companyId: COMPANY_ID,
    status: "active",
    commonProcessingCapacity: hosoEqTons(10000),
    hosoCapacity: hosoEqTons(5000),
    pdCapacity: hosoEqTons(5000),
    vapCapacity: hosoEqTons(5000),
    freezingPackagingCapacity: hosoEqTons(10000),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
  };
}

function makeQualityEquipmentProject(): CapitalProject {
  return {
    projectId: "BENCH-QCE-1",
    companyId: COMPANY_ID,
    projectType: "qualityControlEquipment",
    approvedBudgetUsd: 1_200_000,
    paymentSchedule: [
      { stageIndex: 0, plannedRatio: 0.6 },
      { stageIndex: 1, plannedRatio: 0.4 },
    ],
    completedPaymentStagesCount: 2,
    cumulativePaidUsd: 1_200_000,
    elapsedConstructionQuartersWithPayment: 2,
    requiredConstructionQuarters: 2,
    status: "completed",
    proposedPeriod: P_COMPLETION,
    approvedPeriod: P_COMPLETION,
    completedPeriod: P_COMPLETION,
    capitalizedAmountUsd: 1_200_000,
    targetFactoryId: FACTORY_ID,
    futureCapacityEffect: { capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 },
    lastDiagnosticReasons: [],
    priority: 1,
  } as CapitalProject;
}

interface QuarterRow {
  readonly candidate: string;
  readonly stress: string;
  readonly product: string;
  readonly seed: string;
  readonly quarterIndex: number;
  readonly period: string;
  readonly qualityEquipmentRiskMultiplier: number;
  readonly baseOperationalRisk: number;
  readonly effectiveOperationalRisk: number;
  readonly downgradeTons: number;
  readonly reworkTons: number;
  readonly disposalTons: number;
  readonly majorIncidentProbability: number;
  readonly majorIncidentOccurred: boolean;
  readonly productionQuantityTons: number;
  readonly qualityScore: number;
  readonly customerTrustScore: number;
  readonly vapCapabilityCoefficient: number;
  readonly economicLossUsd: number;
}

function runOne(candidate: Candidate, stress: StressLevel, product: Product, seed: string, includeEquipment: boolean): QuarterRow[] {
  const factory = makeFactory();
  const capexState: CapexState = includeEquipment
    ? { companies: [{ companyId: COMPANY_ID, portfolio: { companyId: COMPANY_ID, projects: [makeQualityEquipmentProject()] }, nextProjectSequence: 2 }] }
    : { companies: [{ companyId: COMPANY_ID, portfolio: { companyId: COMPANY_ID, projects: [] }, nextProjectSequence: 1 }] };

  let qualityByCompanyProduct: readonly CompanyProductQualityState[] = [
    { companyId: COMPANY_ID, product, qualityScore: QUALITY_PARAMETERS_V1.qualityOutcome.baselineOperationalQuality },
  ];
  let customerTrustScore = score0to100(50);
  let cursorPeriod: PeriodV2 = nextPeriod(P_COMPLETION); // Q1= 完成の翌期（稼働開始期）

  const rows: QuarterRow[] = [];
  for (let q = 1; q <= QUARTERS_TO_TRACK; q++) {
    const riskMultiplierByFactory = buildQualityEquipmentRiskMultiplierByFactory(capexState, [factory], cursorPeriod, candidate.params);
    const multiplier = riskMultiplierByFactory.get(FACTORY_ID) ?? 1;

    const batch: ProductionBatch = {
      batchId: `${COMPANY_ID}::${FACTORY_ID}::${product}::${q}`,
      companyId: COMPANY_ID,
      factoryId: FACTORY_ID,
      product,
      period: cursorPeriod,
      rawMaterialConsumed: [],
      rawMaterialConsumedTotal: hosoEqTons(PRODUCTION_QUANTITY_TONS),
      finishedGoodsQuantity: hosoEqTons(PRODUCTION_QUANTITY_TONS),
      processingLoss: hosoEqTons(0),
      rawMaterialCost: usdM(0),
      baseProcessingCost: usdM(0),
      capacityUtilizationIndex: ratio(1),
      shortfallQuantity: hosoEqTons(0),
      shortfallReasons: [],
    };

    const loadMetrics: FactoryLoadMetrics = { factoryId: FACTORY_ID, companyId: COMPANY_ID, period: cursorPeriod, ...stress.loadMetrics };

    const result = applyQualityToBatches(
      {
        batches: [batch],
        factoryLoadMetrics: [loadMetrics],
        factories: [factory],
        rampHistory: [],
        overtimeRateCap: 0.2,
        period: cursorPeriod,
        turn: q,
        gameSeed: `qi1-bench-${seed}`,
        qualityEquipmentRiskMultiplierByFactory: riskMultiplierByFactory,
      },
      candidate.params
    );
    const adjustment = result.adjustments[0];

    qualityByCompanyProduct = updateQualityByCompanyProduct(qualityByCompanyProduct, result.adjustments, candidate.params);
    const qualityEntry = qualityByCompanyProduct.find((s) => s.companyId === COMPANY_ID && s.product === product)!;

    customerTrustScore = updateCustomerTrustScore(customerTrustScore, adjustment.outcome.observedQualityScore, score0to100(90), 0, candidate.params);
    const vapCapabilityCoefficient = calculateCompanyCapabilityCoefficient({ productDevelopmentScore: score0to100(50), qualityScore: qualityEntry.qualityScore });

    const downgradeTons = unwrapUnit(adjustment.downgradeQuantity);
    const reworkTons = unwrapUnit(adjustment.reworkQuantity);
    const disposalTons = unwrapUnit(adjustment.discardQuantity);
    const economicLossUsd = (downgradeTons + reworkTons + disposalTons) * 1000 * ILLUSTRATIVE_USD_PER_KG;

    rows.push({
      candidate: candidate.name,
      stress: stress.name,
      product,
      seed,
      quarterIndex: q,
      period: String(cursorPeriod),
      qualityEquipmentRiskMultiplier: multiplier,
      baseOperationalRisk: adjustment.risk.operationalRisk,
      effectiveOperationalRisk: adjustment.effectiveOperationalRisk,
      downgradeTons,
      reworkTons,
      disposalTons,
      majorIncidentProbability: adjustment.outcome.majorIncident.probability,
      majorIncidentOccurred: adjustment.outcome.majorIncident.occurred,
      productionQuantityTons: PRODUCTION_QUANTITY_TONS,
      qualityScore: unwrapUnit(qualityEntry.qualityScore),
      customerTrustScore: unwrapUnit(customerTrustScore),
      vapCapabilityCoefficient,
      economicLossUsd,
    });

    cursorPeriod = nextPeriod(cursorPeriod);
  }
  return rows;
}

function csvEscape(v: string | number | boolean): string {
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath: string, headers: readonly string[], rows: readonly (readonly (string | number | boolean)[])[]): void {
  const lines = [headers.join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function main() {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });

  const allRows: QuarterRow[] = [];
  for (const candidate of CANDIDATES) {
    for (const stress of STRESS_LEVELS) {
      for (const product of PRODUCTS) {
        for (const seed of SEEDS) {
          const includeEquipment = candidate.name !== "Control";
          allRows.push(...runOne(candidate, stress, product, seed, includeEquipment));
        }
      }
    }
  }

  const timelineHeaders = [
    "candidate",
    "stress",
    "product",
    "seed",
    "quarterIndex",
    "period",
    "qualityEquipmentRiskMultiplier",
    "baseOperationalRisk",
    "effectiveOperationalRisk",
    "downgradeTons",
    "reworkTons",
    "disposalTons",
    "majorIncidentProbability",
    "majorIncidentOccurred",
    "productionQuantityTons",
    "qualityScore",
    "customerTrustScore",
    "vapCapabilityCoefficient",
    "economicLossUsd",
  ];
  const timelineRows = allRows.map((r) => [
    r.candidate,
    r.stress,
    r.product,
    r.seed,
    r.quarterIndex,
    r.period,
    r.qualityEquipmentRiskMultiplier,
    r.baseOperationalRisk,
    r.effectiveOperationalRisk,
    r.downgradeTons,
    r.reworkTons,
    r.disposalTons,
    r.majorIncidentProbability,
    r.majorIncidentOccurred,
    r.productionQuantityTons,
    r.qualityScore,
    r.customerTrustScore,
    r.vapCapabilityCoefficient,
    r.economicLossUsd,
  ]);
  writeCsv(path.join(outDir, "quality_control_equipment_qi1_timeline.csv"), timelineHeaders, timelineRows);

  // company.csv: candidate x stress x product、5シード平均、四半期別
  const companyHeaders = [
    "candidate",
    "stress",
    "product",
    "quarterIndex",
    "avgQualityEquipmentRiskMultiplier",
    "avgBaseOperationalRisk",
    "avgEffectiveOperationalRisk",
    "avgDowngradeTons",
    "avgReworkTons",
    "avgDisposalTons",
    "avgMajorIncidentProbability",
    "majorIncidentOccurredCount",
    "avgQualityScore",
    "avgCustomerTrustScore",
    "avgVapCapabilityCoefficient",
    "avgEconomicLossUsd",
  ];
  const companyRows: (string | number)[][] = [];
  for (const candidate of CANDIDATES) {
    for (const stress of STRESS_LEVELS) {
      for (const product of PRODUCTS) {
        for (let q = 1; q <= QUARTERS_TO_TRACK; q++) {
          const rows = allRows.filter((r) => r.candidate === candidate.name && r.stress === stress.name && r.product === product && r.quarterIndex === q);
          companyRows.push([
            candidate.name,
            stress.name,
            product,
            q,
            mean(rows.map((r) => r.qualityEquipmentRiskMultiplier)),
            mean(rows.map((r) => r.baseOperationalRisk)),
            mean(rows.map((r) => r.effectiveOperationalRisk)),
            mean(rows.map((r) => r.downgradeTons)),
            mean(rows.map((r) => r.reworkTons)),
            mean(rows.map((r) => r.disposalTons)),
            mean(rows.map((r) => r.majorIncidentProbability)),
            rows.filter((r) => r.majorIncidentOccurred).length,
            mean(rows.map((r) => r.qualityScore)),
            mean(rows.map((r) => r.customerTrustScore)),
            mean(rows.map((r) => r.vapCapabilityCoefficient)),
            mean(rows.map((r) => r.economicLossUsd)),
          ]);
        }
      }
    }
  }
  writeCsv(path.join(outDir, "quality_control_equipment_qi1_company.csv"), companyHeaders, companyRows);

  // off_on.csv: candidate比較（最終四半期時点、stress別、product平均）
  const offOnHeaders = [
    "candidate",
    "stress",
    "finalQuarterAvgEffectiveOperationalRisk",
    "finalQuarterAvgQualityScore",
    "finalQuarterAvgCustomerTrustScore",
    "finalQuarterAvgVapCapabilityCoefficient",
    "totalEconomicLossUsdOverTracking",
    "economicLossReductionVsControlUsd",
    "investmentCostUsd",
  ];
  const offOnRows: (string | number)[][] = [];
  const investmentCostUsd = makeQualityEquipmentProject().approvedBudgetUsd;
  for (const stress of STRESS_LEVELS) {
    const controlTotalLoss = mean(
      CANDIDATES.filter((c) => c.name === "Control")
        .flatMap((c) => PRODUCTS.map((product) => allRows.filter((r) => r.candidate === c.name && r.stress === stress.name && r.product === product)))
        .map((rows) => rows.reduce((s, r) => s + r.economicLossUsd, 0))
    );
    for (const candidate of CANDIDATES) {
      const finalQ = QUARTERS_TO_TRACK;
      const finalRows = allRows.filter((r) => r.candidate === candidate.name && r.stress === stress.name && r.quarterIndex === finalQ);
      const totalLossByProduct = PRODUCTS.map((product) =>
        allRows.filter((r) => r.candidate === candidate.name && r.stress === stress.name && r.product === product).reduce((s, r) => s + r.economicLossUsd, 0)
      );
      const totalLoss = mean(totalLossByProduct);
      offOnRows.push([
        candidate.name,
        stress.name,
        mean(finalRows.map((r) => r.effectiveOperationalRisk)),
        mean(finalRows.map((r) => r.qualityScore)),
        mean(finalRows.map((r) => r.customerTrustScore)),
        mean(finalRows.map((r) => r.vapCapabilityCoefficient)),
        totalLoss,
        controlTotalLoss - totalLoss,
        candidate.name === "Control" ? 0 : investmentCostUsd,
      ]);
    }
  }
  writeCsv(path.join(outDir, "quality_control_equipment_qi1_off_on.csv"), offOnHeaders, offOnRows);

  // summary.md
  const lines: string[] = [];
  lines.push("# Standard AI Capability Expansion QI-I1 — Quality Control Equipment Benchmark");
  lines.push("");
  lines.push(
    `Control / Q20 / Q30 / Q40 x Normal / Moderate / Severe x HOSO/PD/VAP, ${QUARTERS_TO_TRACK}Q tracked per case, ${SEEDS.length} seeds averaged. Standard AI is NOT connected this phase — this is a controlled, single-company/single-factory synthetic benchmark using the existing pure quality-module functions directly (no full 5-company/32Q scenario run, since Standard AI cannot yet propose this investment).`
  );
  lines.push("");
  lines.push("## Final-quarter (Q6) comparison, averaged across products and seeds");
  lines.push("");
  lines.push("| Stress | Candidate | Effective Risk | Quality Score | Customer Trust | VAP Capability | Total economic loss ($, over 6Q) | Loss reduction vs Control ($) | Investment ($) |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const row of offOnRows) {
    lines.push(
      `| ${row[1]} | ${row[0]} | ${(row[2] as number).toFixed(3)} | ${(row[3] as number).toFixed(1)} | ${(row[4] as number).toFixed(1)} | ${(
        row[5] as number
      ).toFixed(2)} | $${(row[6] as number).toLocaleString(undefined, { maximumFractionDigits: 0 })} | $${(row[7] as number).toLocaleString(undefined, {
        maximumFractionDigits: 0,
      })} | $${(row[8] as number).toLocaleString()} |`
    );
  }
  lines.push("");
  lines.push("## Ramp trajectory (Severe stress, HOSO, Q30 candidate, seed-1) — confirms no sudden jump at completion");
  lines.push("");
  lines.push("| Quarter | Risk multiplier | Effective risk | Quality Score |");
  lines.push("|---|---|---|---|");
  const rampRows = allRows.filter((r) => r.candidate === "Q30" && r.stress === "Severe" && r.product === "hoso" && r.seed === "seed-1");
  for (const r of rampRows) {
    lines.push(`| Q${r.quarterIndex} | ${r.qualityEquipmentRiskMultiplier.toFixed(3)} | ${r.effectiveOperationalRisk.toFixed(3)} | ${r.qualityScore.toFixed(1)} |`);
  }
  lines.push("");
  fs.writeFileSync(path.join(outDir, "quality_control_equipment_qi1_summary.md"), lines.join("\n") + "\n", "utf8");

  console.log(`Wrote ${timelineRows.length} timeline rows, ${companyRows.length} company rows, ${offOnRows.length} off/on rows to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
