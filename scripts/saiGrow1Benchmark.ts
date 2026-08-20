// ShrimpX V2 — Phase SAI-GROW-1 ベンチマーク（読み取り専用・Decisionは一切変更しない）
//
//   npx tsx scripts/saiGrow1Benchmark.ts            … DS1/DS2 × 3 seed
//   SCENARIO=ds2 SEEDS=a,b npx tsx scripts/saiGrow1Benchmark.ts
//
// 出力:
//   (1) T8/T16/T24/T32 の会社別サマリ（現行Visionでのshadow）
//   (2) 候補Vision（DS3想定reference）でのshadow比較（HIGH/URGENT turn数・onset turn・制約分布）
//   (3) 現行の提出cap（0.35/0.5）で捨てている観測機会
//
// **Decisionは読むだけで一切変更しない。** shadowはgenerateStandardAiDecisionWithDiagnostics
// が返す診断値をそのまま読み、候補Visionのケースだけ assessGrowthPressure を再評価する。

import { initializeCompanyLab, advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { buildStandardAiObservation } from "../app/lib/v2/companyLab/standardAi/observation";
import { assessGrowthPressure, computeGrowthPressureCore } from "../app/lib/v2/companyLab/standardAi/growth";
import { GrowthPressureAssessment } from "../app/lib/v2/companyLab/standardAi/growth/types";
import { DYNAMIC_SCENARIO_1 } from "../app/lib/v2/scenario/definitions/dynamicScenario1";
import { DYNAMIC_SCENARIO_2 } from "../app/lib/v2/scenario/definitions/dynamicScenario2";
import { CompanyLabState } from "../app/lib/v2/companyLab/types";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { defaultVisionDocumentFor } from "../app/lib/v2/companyLab/vision/defaults";
import { CompanyVision, referenceScaleAtTurn } from "../app/lib/v2/companyLab/vision/types";

const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const CAPTURE_TURNS = [8, 16, 24, 32];
const T = (n: number) => Math.round(n).toLocaleString();
const M = (n: number) => (n / 1e6).toFixed(1);

/** 実装指示§7の候補Vision（DS3想定reference）。**販売目標としては一切使わない。** */
const CANDIDATE_Q32_SCALE: Readonly<Record<string, number>> = {
  MASS: 100_000,
  BAL: 65_000,
  JPQ: 55_000,
  VAP: 55_000,
  CONSV: 50_000,
};

/**
 * 候補Visionは、既存Visionの参考成長軌道の**形をそのまま保ったまま**Q32値だけを
 * 差し替える（新しい成長曲線を発明しない）。q1は現行のまま固定し、中盤以降の
 * waypointを比例配分で引き上げる。
 */
function candidateVision(companyId: string): CompanyVision | null {
  const doc = defaultVisionDocumentFor(companyId);
  const base = doc?.visions[0];
  if (!base) return null;
  const targetQ32 = CANDIDATE_Q32_SCALE[companyId];
  if (targetQ32 === undefined) return null;
  const path = [...base.referenceGrowthPath].sort((a, b) => a.turn - b.turn);
  const q1 = path[0]?.scaleTonsPerQuarter ?? base.targetScaleTonsPerQuarterAtQ32;
  const currentQ32 = base.targetScaleTonsPerQuarterAtQ32;
  const span = Math.max(1e-6, currentQ32 - q1);
  return {
    ...base,
    visionId: `${base.visionId}-candidate`,
    targetScaleTonsPerQuarterAtQ32: targetQ32,
    referenceGrowthPath: path.map((w) => ({
      turn: w.turn,
      // 現行軌道の進捗率をそのまま保ち、終点だけ候補値へ伸ばす。
      scaleTonsPerQuarter: q1 + ((w.scaleTonsPerQuarter - q1) / span) * (targetQ32 - q1),
    })),
  };
}

interface Row {
  readonly turn: number;
  readonly companyId: string;
  readonly desiredSales: number;
  readonly actualSales: number;
  readonly production: number;
  readonly salesHeadcount: number;
  readonly capacity: number;
  readonly inventory: number;
  readonly cash: number;
  readonly debt: number;
  readonly opMargin: number | null;
  readonly rawShortage: boolean;
  readonly current: GrowthPressureAssessment;
  readonly candidate: GrowthPressureAssessment | null;
}

function runScenario(scenarioId: string, seed: string): Row[] {
  const { state: s0, fixtures } = initializeCompanyLab({ scenarioId, mode: "canonical", seed, turns: 32 });
  let state: CompanyLabState = s0;
  const rows: Row[] = [];
  while (!state.isComplete) {
    const publicInfo = buildPublicMarketInfo(state);
    const turn = state.scenarioState.currentTurn;
    const results = fixtures.map((f) =>
      generateStandardAiDecisionWithDiagnostics(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, turn)
    );
    const ownStates = new Map(fixtures.map((f) => [f.companyId, buildCompanyOwnState(state, f)]));
    // 候補Vision評価用に、意思決定と同一入力のobservationを作り直す（Decisionは触らない）。
    const observations = new Map(
      fixtures.map((f) => [f.companyId, buildStandardAiObservation(f, ownStates.get(f.companyId)!, publicInfo, state.currentPeriod, turn)])
    );
    state = advanceCompanyLabQuarter(state, fixtures, Object.fromEntries(results.map((r) => [r.decision.companyId, r.decision])));
    const record = state.history[state.history.length - 1];
    for (const r of results) {
      const d = r.diagnostics;
      const current = d.growthPressure;
      if (!current) continue;
      const summary = record.companySummaries.find((s) => s.companyId === d.companyId);
      const fin = record.financialResults.find((f) => f.companyId === d.companyId);
      const own = ownStates.get(d.companyId);

      // --- 候補Visionでのshadow再評価（Decisionは触らない） ---
      let candidate: GrowthPressureAssessment | null = null;
      const cv = candidateVision(d.companyId);
      if (cv && own && d.commercialAmbition && d.commercialCommitment && d.observableOpportunity && d.conversionObservation && d.unservedOpportunity && d.salesHiring && d.crisis) {
        const candidateCore = computeGrowthPressureCore({
          companyId: d.companyId,
          period: d.period,
          observation: observations.get(d.companyId)!,
          contracts: own.contracts,
          visionReferenceScaleTons: referenceScaleAtTurn(cv, turn, current.currentRelevantScaleTons),
          growthAmbition: cv.growthAmbition,
          strategicPosture: cv.strategicPosture ?? null,
          financialRiskTolerance: cv.financialRiskTolerance,
          currentRelevantScaleTons: current.currentRelevantScaleTons,
          attainableProfitableTons: d.observableOpportunity.attainableProfitableTons,
          orientationWeightedOpportunityTons: current.orientationWeightedOpportunityTons,
          weightedContributionUsdPerKg: d.observableOpportunity.weightedContributionUsdPerKg,
          priceObservationMissing: d.observableOpportunity.priceObservationMissing,
          observedConversionRatio: d.conversionObservation.conversionRatio,
          finishedGoodsExcessRatioByProduct: d.pressures.finishedGoodsExcessRatioByProduct,
          crisisState: d.crisis.state,
          lastQuarterFinancialHealthTier: null,
        });
        candidate = assessGrowthPressure({
          core: candidateCore,
          observation: observations.get(d.companyId)!,
          commercialAmbition: d.commercialAmbition,
          ambitionTonsWithBaseStep: d.commercialAmbition.ambitionTons,
          ambitionTonsWithoutStepLimit: d.commercialAmbition.ambitionTons,
          unservedOpportunity: d.unservedOpportunity,
          salesHiringZeroReason: d.salesHiring.zeroHireReason,
          salesForceHireCount: 0,
          newCapexProposalCount: 0,
        });
      }

      const revenue = fin ? Number(fin.profitAndLoss.netRevenue) : 0;
      rows.push({
        turn,
        companyId: d.companyId,
        desiredSales: d.decision.salesPlans.reduce((a, p) => a + unwrapUnit(p.desiredQuantity), 0),
        actualSales: summary ? unwrapUnit(summary.newContractedQuantity) : 0,
        production: summary ? unwrapUnit(summary.hosoProduced) + unwrapUnit(summary.pdProduced) + unwrapUnit(summary.vapProduced) : 0,
        salesHeadcount: d.salesHiring?.currentHeadcount ?? 0,
        capacity: current.currentRelevantScaleTons,
        inventory: summary ? unwrapUnit(summary.finishedGoodsInventory) : 0,
        cash: fin ? Number(fin.balanceSheet.cash) : 0,
        debt: fin ? Number(fin.balanceSheet.shortTermLoans) + Number(fin.balanceSheet.longTermLoans) : 0,
        opMargin: fin && revenue > 0 ? Number(fin.profitAndLoss.operatingProfit) / revenue : null,
        rawShortage: d.situationDiagnosis?.rawMaterialSupplyConstraintState === "shortage",
        current,
        candidate,
      });
    }
  }
  return rows;
}

function summarize(label: string, rows: Row[]): void {
  console.log(`\n######## ${label} ########`);
  for (const c of COMPANIES) {
    const mine = rows.filter((r) => r.companyId === c);
    if (mine.length === 0) continue;
    console.log(`\n### ${c}`);
    console.log(
      "turn  desired  actual  prod    hc  scale   visionRef  gap    oppTons  submitCap  suppressed  supp  score  level     primary                dest                 margin cash    debt"
    );
    for (const t of CAPTURE_TURNS) {
      const r = mine.find((x) => x.turn === t);
      if (!r) continue;
      const g = r.current;
      console.log(
        `${String(t).padStart(4)} ${T(r.desiredSales).padStart(8)} ${T(r.actualSales).padStart(7)} ${T(r.production).padStart(7)} ${String(r.salesHeadcount).padStart(3)} ` +
          `${T(g.currentRelevantScaleTons).padStart(7)} ${T(g.visionReferenceScaleTons).padStart(9)} ${g.strategicScaleGapRatio.toFixed(2).padStart(5)} ` +
          `${T(g.observedOpportunityTons).padStart(8)} ${T(g.currentSubmissionCeilingTons).padStart(9)} ${T(g.ceilingSuppressedOpportunityTons).padStart(11)} ` +
          `${g.opportunitySupport.toFixed(2).padStart(5)} ${g.score.toFixed(3).padStart(6)} ${g.level.padEnd(9)} ${g.primaryGrowthConstraint.padEnd(22)} ${g.recommendedPressureDestination.padEnd(20)} ` +
          `${(r.opMargin === null ? "n/a" : (r.opMargin * 100).toFixed(1) + "%").padStart(6)} ${M(r.cash).padStart(6)}M ${M(r.debt).padStart(5)}M`
      );
    }
    const levelCount = (list: Row[], pick: (r: Row) => GrowthPressureAssessment | null) => {
      const counts: Record<string, number> = { LOW: 0, MODERATE: 0, HIGH: 0, URGENT: 0 };
      for (const r of list) {
        const g = pick(r);
        if (g) counts[g.level] += 1;
      }
      return counts;
    };
    const onset = (list: Row[], pick: (r: Row) => GrowthPressureAssessment | null) => {
      const hit = list.find((r) => {
        const g = pick(r);
        return g !== null && (g.level === "HIGH" || g.level === "URGENT");
      });
      return hit ? `T${hit.turn}` : "なし";
    };
    const cur = levelCount(mine, (r) => r.current);
    const cand = levelCount(mine, (r) => r.candidate);
    console.log(
      `  現行Vision : LOW=${cur.LOW} MOD=${cur.MODERATE} HIGH=${cur.HIGH} URG=${cur.URGENT} / HIGH以上のonset=${onset(mine, (r) => r.current)}`
    );
    console.log(
      `  候補Vision : LOW=${cand.LOW} MOD=${cand.MODERATE} HIGH=${cand.HIGH} URG=${cand.URGENT} / HIGH以上のonset=${onset(mine, (r) => r.candidate)}`
    );
    const constraintCounts: Record<string, number> = {};
    for (const r of mine) constraintCounts[r.current.primaryGrowthConstraint] = (constraintCounts[r.current.primaryGrowthConstraint] ?? 0) + 1;
    console.log(
      `  primary constraint分布(現行): ` +
        Object.entries(constraintCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
    );
    const engineCap = mine.filter((r) => r.current.reasonCodes.includes("GROWTH_BLOCKED_BY_ENGINE_CAP")).length;
    const engineCapCandidate = mine.filter((r) => r.candidate?.reasonCodes.includes("GROWTH_BLOCKED_BY_ENGINE_CAP")).length;
    const deadlock = mine.filter((r) => r.current.reasonCodes.includes("COMMERCIAL_CAPACITY_CONSTRAINED_BY_CURRENT_PRODUCTION")).length;
    const selfRef = mine.filter((r) => r.current.reasonCodes.includes("GROWTH_PRESSURE_BLOCKED_BY_SELF_REFERENTIAL_CAPACITY_GATE")).length;
    const suppressedAvg = mine.reduce((a, r) => a + r.current.ceilingSuppressedOpportunityTons, 0) / mine.length;
    console.log(
      `  engine cap診断: 現行${engineCap}/32 候補${engineCapCandidate}/32 / 営業deadlock ${deadlock}/32 / 自己参照capacity gate ${selfRef}/32 / 平均suppressed機会 ${T(suppressedAvg)}t`
    );
  }
}

const SCENARIOS: readonly (readonly [string, string])[] = [
  ["DS1", DYNAMIC_SCENARIO_1.scenarioId],
  ["DS2", DYNAMIC_SCENARIO_2.scenarioId],
];
const SEEDS = (process.env.SEEDS ?? "grow1-s1,grow1-s2,grow1-s3").split(",");

for (const [label, scenarioId] of SCENARIOS) {
  for (const seed of SEEDS) {
    const rows = runScenario(scenarioId, seed);
    summarize(`${label} seed=${seed}`, rows);
  }
}
