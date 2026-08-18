// ShrimpX V2 — TSV正式化 ベンチマーク（TSV正式化指示§28・§24）＋ DIV-3 AI配当ON/OFF比較
//
// 【Benchmark 1・2（TSV正式化時から不変）】autoPolicy（暫定自動方針）で動く5社の
// TSV推移と、1社だけ毎Turn全額配当した場合の「15%複利が支配戦略化していないか」診断。
//
// 1. baseline run（5社すべてautoPolicy・配当0）を32Turn実行し、
//    T8/T16/T24/T32時点の5社ぶんのDividend Value/NormalizedCF/EnterpriseValue/
//    Cash/Debt/CurrentCompanyValue/TSV/Rankを出力する。
// 2. 15%が「序盤大量配当が常に圧倒的最適解」を作っていないかの診断として、
//    同じseed・同じ会社構成で、1社だけ毎Turン分配可能利益を全額配当する
//    "aggressive-dividend"変種を実行し、baseline（無配当）のTSV推移と比較する。
//
// 【Benchmark 3・4（Phase DIV-3で追加）】Standard AI（経営性格プロファイルON）の
// AI配当ON/OFF比較。Benchmark 1・2がautoPolicy（DIV-3の変更対象外）で動くのに対し、
// DIV-3が変えるのはStandard AI（standardAi/policy.ts）であるため、比較にはこちらを
// 使う必要がある。
//
// 3. dividendBasePayoutRatioを0（OFF）〜0.15（提案書の初期候補）までスイープし、
//    各社のTSV・累計配当・配当発火Turn数・期末現金・生産0四半期数・distress四半期数を
//    比較する。§24と同じ「配当が支配戦略化していないか」に加えて、DIV-3固有の
//    「基準配当ルールが会社の運転資金を痩せさせていないか」を同時に診断する。
// 4. 各ratioでのTSV変化率（OFF比）を一覧し、支配戦略化の有無を判定する。
// 5. 【DIV-3で最も重要な安全診断】既存のStandard AI頑健性回帰（CCI-9「複数seedでも
//    生産停止ゼロ・現金負ゼロ・在庫発散なし」、companyLab/vision/__tests__/
//    commercialCommitmentIntegration.test.ts）と同じ条件を、各ratio×各seedで再現し、
//    「基準配当ルールが会社を資金枯渇させないratioの上限」を数値で示す。
//    これがdividendBasePayoutRatioの初期値を決めた根拠である。
//
// 使い方: npx tsx scripts/tsvLeaderboardBenchmark.ts

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../app/lib/v2/companyLab/autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState, CompanyFixture } from "../app/lib/v2/companyLab/types";
import { computeAllCompaniesEvaluationSnapshot, rankCompaniesByTotalShareholderValue } from "../app/lib/v2/companyLab/evaluation/evaluationSemantics";
import { createStandardAiProvider } from "../app/lib/v2/companyLab/standardAi/policy";
import { createManagementProfileParamsResolver } from "../app/lib/v2/companyLab/standardAi/managementProfile";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "../app/lib/v2/companyLab/standardAi/parameters";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../app/lib/v2/companyLab/runner";
import { SALES_PARAMETERS_V1, SalesParameters } from "../app/lib/v2/sales/parameters";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { unwrapUsd } from "../app/lib/v2/finance/types";
import { Product } from "../app/lib/v2/market/types";

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

console.log("=== TSV Benchmark 1: baseline（5社すべてautoPolicy・配当0）===");
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


// ---------------------------------------------------------------------
// 【Phase DIV-4】Benchmark 3・4・5: Standard AI配当ポリシー（Flow-Based Annual）の
// ON/OFF・payout ratio別比較
// ---------------------------------------------------------------------

console.log("\n\n=== TSV Benchmark 3: Standard AI配当ポリシー（DIV-4 Flow-Based Annual）ratio別比較 ===");
console.log(
  "5社すべてStandard AI（経営性格プロファイルON）。dividendBasePayoutRatioだけを変えて32Turn実行する。\n" +
    "DIV-4のStandard AI配当は「年度末Q4のみ・当期純利益×payoutRatio・distributableEarningsは上限としてのみ使用」。\n" +
    "ratio=0がAI配当OFF（DIV-1と完全に同じ挙動）。ratio=5%はDIV-3暫定値をcontrolとして残したもの。"
);

interface AiRunCompanyMetrics {
  readonly companyId: string;
  readonly tsvUsd: number | null;
  readonly dividendValueUsd: number | null;
  readonly companyValueUsd: number | null;
  readonly cumulativeDividendUsd: number;
  readonly dividendTurnCount: number;
  readonly dividendTurns: readonly number[];
  readonly endingCashUsd: number;
  readonly minimumCashUsd: number;
  readonly endingDebtUsd: number;
  readonly zeroProductionQuarters: number;
  readonly distressQuarters: number;
  readonly capexCompletedCount: number;
  readonly newFactoryActivationTurns: readonly number[];
  readonly totalCapexPaidUsd: number;
}

function runStandardAi(seed: string, payoutRatio: number): readonly AiRunCompanyMetrics[] {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig(seed));
  const base: StandardAiParameters = { ...STANDARD_AI_PARAMETERS_V1, dividendBasePayoutRatio: payoutRatio };
  const { provider } = createStandardAiProvider({ resolveParams: createManagementProfileParamsResolver(base) });

  let state = state0;
  for (let i = 0; i < TOTAL_TURNS; i++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      decisions[f.companyId] = provider(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
    }
    state = advanceCompanyLabQuarter(state, fixtures, decisions);
  }

  const ids = fixtures.map((f) => f.companyId);
  const snapshots = computeAllCompaniesEvaluationSnapshot(state.history, ids, TOTAL_TURNS);
  return ids.map((companyId) => {
    const snapshot = snapshots.find((s) => s.companyId === companyId);
    let cumulativeDividendUsd = 0;
    const dividendTurns: number[] = [];
    let zeroProductionQuarters = 0;
    let distressQuarters = 0;
    let endingCashUsd = 0;
    let minimumCashUsd = Infinity;
    let endingDebtUsd = 0;
    let capexCompletedCount = 0;
    let totalCapexPaidUsd = 0;
    const newFactoryActivationTurns: number[] = [];
    const seenFactoryProjects = new Set<string>();

    for (const record of state.history) {
      const dividend = record.dividendResults?.find((d) => d.companyId === companyId);
      if (dividend && dividend.appliedDividendUsd > 0) {
        cumulativeDividendUsd = dividend.cumulativeDividendUsd;
        dividendTurns.push(record.turn);
      }
      const summary = record.companySummaries.find((c) => c.companyId === companyId);
      if (summary && Number(summary.hosoProduced) + Number(summary.pdProduced) + Number(summary.vapProduced) <= 0) {
        zeroProductionQuarters++;
      }
      const financing = record.financingResults.find((f) => f.companyId === companyId);
      if (financing && financing.financialHealth.primary !== "healthy") distressQuarters++;
      const financial = record.financialResults.find((f) => f.companyId === companyId);
      if (financial) {
        endingCashUsd = Number(financial.balanceSheet.cash);
        minimumCashUsd = Math.min(minimumCashUsd, endingCashUsd);
        endingDebtUsd = Number(financial.balanceSheet.shortTermLoans) + Number(financial.balanceSheet.longTermLoans);
      }
      const capex = record.capexResults.find((c) => c.companyId === companyId);
      for (const event of capex?.events ?? []) {
        totalCapexPaidUsd += event.paymentSucceededUsd;
        if (event.statusAfter === "completed" && event.statusBefore !== "completed") {
          capexCompletedCount++;
          // 新工場（newFactory）の稼働開始タイミングだけを別途記録する。
          if (event.projectType === "newFactoryConstruction" && !seenFactoryProjects.has(event.projectId)) {
            seenFactoryProjects.add(event.projectId);
            newFactoryActivationTurns.push(record.turn);
          }
        }
      }
    }
    return {
      companyId,
      tsvUsd: snapshot?.totalShareholderValueUsd ?? null,
      dividendValueUsd: snapshot?.currentDividendValueUsd ?? null,
      companyValueUsd: snapshot?.currentCompanyValue.currentCompanyValueUsd ?? null,
      cumulativeDividendUsd,
      dividendTurnCount: dividendTurns.length,
      dividendTurns,
      endingCashUsd,
      minimumCashUsd: minimumCashUsd === Infinity ? 0 : minimumCashUsd,
      endingDebtUsd,
      zeroProductionQuarters,
      distressQuarters,
      capexCompletedCount,
      newFactoryActivationTurns,
      totalCapexPaidUsd,
    };
  });
}

const AI_DIVIDEND_SEED = "div3-ai-dividend-001";
// 【実装指示§6】Flow + annual frequencyへ変更後、15%を中心値として10/15/20/25%を比較。
// 0%（OFF）と、DIV-3暫定値の5%をcontrolとして残す。
const PAYOUT_RATIOS = [0, 0.05, 0.1, 0.15, 0.2, 0.25];
const aiRuns = new Map<number, readonly AiRunCompanyMetrics[]>();
for (const ratio of PAYOUT_RATIOS) aiRuns.set(ratio, runStandardAi(AI_DIVIDEND_SEED, ratio));

const aiCompanyIds = (aiRuns.get(0) ?? []).map((m) => m.companyId);
for (const ratio of PAYOUT_RATIOS) {
  console.log(`\n--- dividendBasePayoutRatio = ${(ratio * 100).toFixed(0)}%${ratio === 0 ? "（AI配当OFF）" : ""} / Turn ${TOTAL_TURNS} 時点 ---`);
  console.log(
    "Company | TSV | CompanyValue | DividendValue | 累計配当 | 配当回数 | 配当Turn | 期末Cash | 最小Cash | 期末Debt | CAPEX完了 | 新工場稼働Turn | 生産0 | distress"
  );
  for (const m of aiRuns.get(ratio) ?? []) {
    console.log(
      `${m.companyId} | ${fmt(m.tsvUsd)} | ${fmt(m.companyValueUsd)} | ${fmt(m.dividendValueUsd)} | ${fmt(m.cumulativeDividendUsd)} | ` +
        `${m.dividendTurnCount} | [${m.dividendTurns.join(",")}] | ${fmt(m.endingCashUsd)} | ${fmt(m.minimumCashUsd)} | ${fmt(m.endingDebtUsd)} | ` +
        `${m.capexCompletedCount} | [${m.newFactoryActivationTurns.join(",")}] | ${m.zeroProductionQuarters} | ${m.distressQuarters}`
    );
  }
}

console.log("\n\n=== TSV Benchmark 4: 支配戦略診断（実装指示§12・TSV正式化§24と同じ観点）===");
console.log(
  "各ratioのTurn32 TSVを、AI配当OFF（ratio=0）比の変化率として並べる。\n" +
    "payout ratioを増やすほど全社一様にTSVが上昇するならStop Condition（配当が支配戦略）。"
);
const offById = new Map((aiRuns.get(0) ?? []).map((m) => [m.companyId, m]));
console.log(`Company | ${PAYOUT_RATIOS.map((r) => `${(r * 100).toFixed(0)}%`).join(" | ")}`);
const monotonicCompanies: string[] = [];
for (const companyId of aiCompanyIds) {
  const offTsv = offById.get(companyId)?.tsvUsd ?? null;
  const tsvByRatio = PAYOUT_RATIOS.map((ratio) => (aiRuns.get(ratio) ?? []).find((m) => m.companyId === companyId)?.tsvUsd ?? null);
  const cells = tsvByRatio.map((tsv) => {
    if (offTsv === null || tsv === null || offTsv === 0) return "n/a";
    return `${(((tsv - offTsv) / Math.abs(offTsv)) * 100).toFixed(1)}%`;
  });
  console.log(`${companyId} | ${cells.join(" | ")}`);
  // ratioに対して単調増加しているかどうか（支配戦略の兆候）を機械的に判定する。
  let monotonic = true;
  for (let i = 1; i < tsvByRatio.length; i++) {
    const prev = tsvByRatio[i - 1];
    const cur = tsvByRatio[i];
    if (prev === null || cur === null || cur <= prev) monotonic = false;
  }
  if (monotonic) monotonicCompanies.push(companyId);
}
console.log(
  `\n支配戦略判定: payout ratioに対しTSVが単調増加した会社 = ${monotonicCompanies.length === 0 ? "なし" : monotonicCompanies.join(",")}` +
    `（5社中${monotonicCompanies.length}社）。全社一様に単調増加した場合のみStop Conditionとする。`
);

console.log("\n配当頻度・運転資金への副作用（5社計）:");
for (const ratio of PAYOUT_RATIOS) {
  const runs = aiRuns.get(ratio) ?? [];
  const zeroProduction = runs.reduce((sum, m) => sum + m.zeroProductionQuarters, 0);
  const distress = runs.reduce((sum, m) => sum + m.distressQuarters, 0);
  const dividendTurns = runs.reduce((sum, m) => sum + m.dividendTurnCount, 0);
  const cumulativeDividend = runs.reduce((sum, m) => sum + m.cumulativeDividendUsd, 0);
  const capexCompleted = runs.reduce((sum, m) => sum + m.capexCompletedCount, 0);
  console.log(
    `ratio=${(ratio * 100).toFixed(0)}%: 配当発火回数=${dividendTurns}（理論上限40=5社×8年度） / 累計配当=${fmt(cumulativeDividend)} / ` +
      `CAPEX完了=${capexCompleted}件 / 生産0四半期=${zeroProduction} / distress四半期=${distress}`
  );
}

console.log("\n\n=== TSV Benchmark 5: seed頑健性診断（既存CCI-9と同一条件・実装指示§16 DIV-FLOW-15）===");
console.log(
  "既存の頑健性回帰CCI-9（companyLab/vision/__tests__/commercialCommitmentIntegration.test.ts）と\n" +
    "同じ会社全体営業能力モデル・同じseed群で、dividendBasePayoutRatioだけを変えて32Turn実行する。\n" +
    "CCI-9の合格条件: 生産0四半期=0 かつ 最小現金>=0 かつ 期末完成品在庫<60,000t。"
);

const CCI9_SALES_PARAMS: SalesParameters = {
  ...SALES_PARAMETERS_V1,
  salesEffortCoefficients: { hoso: 1.0, pd: 1.2, vap: 3.0 } as Readonly<Record<Product, number>>,
  salesCapacityModel: {
    kind: "companyWide",
    companyBaselineCapacityTons: 1_000,
    companyCapacityMaxIncrementTons: 95_000,
    companyCapacitySaturationHeadcount: 190,
    fragmentationPenaltyPerExtraMarket: 0,
    fragmentationFloor: 1,
  },
};
const CCI9_SEEDS = ["phase6c-regression", "seed-a", "seed-b", "management-console-32q"];

for (const ratio of PAYOUT_RATIOS) {
  const lines: string[] = [];
  for (const seed of CCI9_SEEDS) {
    const config: CompanyLabConfig = {
      scenarioId: "baseline",
      mode: "canonical",
      seed,
      turns: TOTAL_TURNS,
      salesParamsOverride: CCI9_SALES_PARAMS,
    };
    const { provider } = createStandardAiProvider({
      salesParams: CCI9_SALES_PARAMS,
      resolveParams: createManagementProfileParamsResolver({ ...STANDARD_AI_PARAMETERS_V1, dividendBasePayoutRatio: ratio }),
    });
    const result = runCompanyLabWithAutoPolicyForAllCompanies(config, provider);
    let zeroProductionQuarters = 0;
    let minimumCashUsd = Infinity;
    let dividendTurns = 0;
    let endingDebtUsd = 0;
    for (const h of result.history) {
      for (const c of h.companySummaries) {
        if (unwrapUnit(c.hosoProduced) + unwrapUnit(c.pdProduced) + unwrapUnit(c.vapProduced) <= 0) zeroProductionQuarters++;
      }
      for (const f of h.financialResults) minimumCashUsd = Math.min(minimumCashUsd, unwrapUsd(f.balanceSheet.cash));
      for (const d of h.dividendResults ?? []) if (d.appliedDividendUsd > 0) dividendTurns++;
    }
    for (const f of result.history[TOTAL_TURNS - 1].financialResults) {
      endingDebtUsd += unwrapUsd(f.balanceSheet.shortTermLoans) + unwrapUsd(f.balanceSheet.longTermLoans);
    }
    const finishedGoodsTons = result.history[TOTAL_TURNS - 1].companySummaries.reduce((sum, c) => sum + unwrapUnit(c.finishedGoodsInventory), 0);
    const pass = zeroProductionQuarters === 0 && minimumCashUsd >= 0 && finishedGoodsTons < 60_000;
    lines.push(
      `  ${pass ? "PASS" : "FAIL"} ${seed}: 生産0四半期=${zeroProductionQuarters} / 最小現金=${minimumCashUsd.toFixed(2)}USD / ` +
        `期末完成品在庫=${Math.round(finishedGoodsTons)}t / 期末Debt(5社計)=${fmt(endingDebtUsd)} / 配当発火回数(5社計)=${dividendTurns}`
    );
  }
  console.log(`\nratio=${(ratio * 100).toFixed(0)}%`);
  for (const line of lines) console.log(line);
}

console.log(
  "\n注: 最小現金が-0.00USD（浮動小数点の丸め誤差レベル）のFAILは、資金枯渇ではなく" +
    "CCI-9の判定式（>= 0）が厳密比較であることによるもの。"
);
