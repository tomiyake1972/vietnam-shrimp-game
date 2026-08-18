// ShrimpX V2 — TSV正式化 ベンチマーク（TSV正式化指示§28・§24）
//
// 1. baseline run（5社すべてStandard AI・配当は指示§25どおり常に0）を32Turn実行し、
//    T8/T16/T24/T32時点の5社ぶんのDividend Value/NormalizedCF/EnterpriseValue/
//    Cash/Debt/CurrentCompanyValue/TSV/Rankを出力する。
// 2. 15%が「序盤大量配当が常に圧倒的最適解」を作っていないかの診断として、
//    同じseed・同じ会社構成で、1社だけ毎Turン分配可能利益を全額配当する
//    "aggressive-dividend"変種を実行し、baseline（無配当）のTSV推移と比較する。

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../app/lib/v2/companyLab/autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState, CompanyFixture } from "../app/lib/v2/companyLab/types";
import { computeAllCompaniesEvaluationSnapshot, rankCompaniesByTotalShareholderValue } from "../app/lib/v2/companyLab/evaluation/evaluationSemantics";

const TOTAL_TURNS = 32;
const CHECKPOINT_TURNS = [8, 16, 24, 32];
const AGGRESSIVE_DIVIDEND_COMPANY_INDEX = 0;

function baseConfig(seed: string): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed, turns: TOTAL_TURNS };
}

function stepOnce(
  state: CompanyLabState,
  fixtures: readonly CompanyFixture[],
  aggressiveDividendCompanyId?: string
): CompanyLabState {
  const publicInfo = buildPublicMarketInfo(state);
  const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const ownState = buildCompanyOwnState(state, f);
    const auto = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
    if (f.companyId === aggressiveDividendCompanyId) {
      const distributable = Number(ownState.financeState.distributableEarnings);
      decisionsByCompanyId[f.companyId] = { ...auto, dividendDecision: { dividendAmountUsd: Math.max(0, distributable) } };
    } else {
      decisionsByCompanyId[f.companyId] = auto;
    }
  }
  return advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
}

function runToCompletion(seed: string, aggressiveDividendCompanyId?: string): { state: CompanyLabState; fixtures: readonly CompanyFixture[] } {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig(seed));
  let state = state0;
  for (let i = 0; i < TOTAL_TURNS; i++) state = stepOnce(state, fixtures, aggressiveDividendCompanyId);
  return { state, fixtures };
}

function fmt(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value / 1e6).toFixed(2)}M`;
}

console.log("=== TSV Benchmark 1: baseline（5社すべてStandard AI・配当0）===");
const baseline = runToCompletion("tsv-benchmark-baseline-001");
const nameById = new Map(baseline.fixtures.map((f) => [f.companyId, f.displayName]));
const companyIds = baseline.fixtures.map((f) => f.companyId);

for (const turn of CHECKPOINT_TURNS) {
  console.log(`\n--- Turn ${turn} ---`);
  const snapshots = computeAllCompaniesEvaluationSnapshot(baseline.state.history, companyIds, turn);
  const ranked = rankCompaniesByTotalShareholderValue(snapshots);
  console.log("Rank | Company | TSV | DividendValue | NormalizedCF | EV | Cash | Debt | CurrentCompanyValue");
  ranked.forEach((s, i) => {
    console.log(
      `${i + 1} | ${nameById.get(s.companyId)} | ${fmt(s.totalShareholderValueUsd)} | ${fmt(s.currentDividendValueUsd)} | ` +
        `${fmt(s.currentCompanyValue.normalizedQuarterlyCashFlowUsd)} | ${fmt(s.currentCompanyValue.enterpriseValueUsd)} | ` +
        `${fmt(s.currentCompanyValue.cashUsd)} | ${fmt(s.currentCompanyValue.debtUsd)} | ${fmt(s.currentCompanyValue.currentCompanyValueUsd)}`
    );
  });
}

console.log("\n\n=== TSV Benchmark 2: 15%支配戦略チェック（§24）===");
console.log(`対象会社: ${nameById.get(companyIds[AGGRESSIVE_DIVIDEND_COMPANY_INDEX])}（毎Turン分配可能利益を全額配当 vs 同社の配当0ベースライン）`);
const aggressiveTargetId = companyIds[AGGRESSIVE_DIVIDEND_COMPANY_INDEX];
const aggressive = runToCompletion("tsv-benchmark-baseline-001", aggressiveTargetId);

for (const turn of CHECKPOINT_TURNS) {
  const baselineSnapshot = computeAllCompaniesEvaluationSnapshot(baseline.state.history, [aggressiveTargetId], turn)[0];
  const aggressiveSnapshot = computeAllCompaniesEvaluationSnapshot(aggressive.state.history, [aggressiveTargetId], turn)[0];
  const baselineTsv = baselineSnapshot.totalShareholderValueUsd;
  const aggressiveTsv = aggressiveSnapshot.totalShareholderValueUsd;
  const diffPct = baselineTsv !== null && aggressiveTsv !== null && baselineTsv !== 0 ? (((aggressiveTsv - baselineTsv) / Math.abs(baselineTsv)) * 100).toFixed(1) : "n/a";
  console.log(
    `Turn ${turn}: baseline(配当0) TSV=${fmt(baselineTsv)} / aggressive(全額配当) TSV=${fmt(aggressiveTsv)} / 差=${diffPct}% ` +
      `| aggressiveのDividendValue=${fmt(aggressiveSnapshot.currentDividendValueUsd)} / CurrentCompanyValue=${fmt(aggressiveSnapshot.currentCompanyValue.currentCompanyValueUsd)}`
  );
}
