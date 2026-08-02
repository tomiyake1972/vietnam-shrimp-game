// ShrimpX V2 — 標準AIの市場認識・投資判断の観測（加工品市場進化 §h）
//
// Phase8の標準AI統合自動プレイでは、5社×3シードの15通りすべてが
//   - 新投資タイプ（新工場建設・PD省人化・VAP商品開発）を一度も採用せず
//   - 期末現金が完全に同一（$-29,718,000）
// という状態だった。この2点が解消したかを実測する。
//
// 使い方: npx tsx scripts/standardAiMarketEvolutionAutoplay.ts

import { runAutoplayCase } from "../app/lib/v2/companyLab/standardAi/autoplay/runCase";
import { SELECTED_STANDARD_BASELINE_CANDIDATE_ID, STANDARD_BASELINE_CANDIDATES } from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import { ALL_COMPANY_IDS } from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";

import type { CompanyId } from "../app/lib/v2/sales/types";

const SEEDS = ["mkt-evo-sai-seed-1", "mkt-evo-sai-seed-2", "mkt-evo-sai-seed-3"] as const;
const HORIZON_QUARTERS = 32;

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

interface CompanyOutcome {
  readonly seed: string;
  readonly companyId: CompanyId;
  readonly marketEvolutionEnabled: boolean;
  readonly newFactoryProposals: number;
  readonly pdMechanizationProposals: number;
  readonly vapDevelopmentQuarters: number;
  readonly vapDevelopmentTotalUsd: number;
  readonly firstNewFactoryTurn: number | null;
  readonly firstMechanizationTurn: number | null;
  readonly firstVapDevelopmentTurn: number | null;
  readonly finalCashUsd: number;
  readonly cumulativeNetIncomeUsd: number;
}

function runSeed(seed: string, marketEvolutionEnabled: boolean): readonly CompanyOutcome[] {
  const result = runAutoplayCase({
    scenarioId: "baseline",
    seed,
    quarters: HORIZON_QUARTERS,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    ...(marketEvolutionEnabled
      ? {
          marketEvolutionEnabled: true,
          productLifecycleEnabled: true,
          supplyPremiumFeedbackEnabled: true,
        }
      : {}),
  });

  return ALL_COMPANY_IDS.map((companyId) => {
    let newFactoryProposals = 0;
    let pdMechanizationProposals = 0;
    let vapDevelopmentQuarters = 0;
    let vapDevelopmentTotalUsd = 0;
    let firstNewFactoryTurn: number | null = null;
    let firstMechanizationTurn: number | null = null;
    let firstVapDevelopmentTurn: number | null = null;

    result.history.forEach((record, index) => {
      const turn = index + 1;
      const decision = record.decisions.find((d) => d.companyId === companyId);
      if (!decision) return;
      for (const proposal of decision.capexDecision.newProjectProposals) {
        if (proposal.projectType === "newFactoryConstruction") {
          newFactoryProposals += 1;
          if (firstNewFactoryTurn === null) firstNewFactoryTurn = turn;
        }
        if (proposal.projectType === "pdMechanization") {
          pdMechanizationProposals += 1;
          if (firstMechanizationTurn === null) firstMechanizationTurn = turn;
        }
      }
      const vapSpend = decision.vapProductDevelopmentSpendUsd ?? 0;
      if (vapSpend > 0) {
        vapDevelopmentQuarters += 1;
        vapDevelopmentTotalUsd += vapSpend;
        if (firstVapDevelopmentTurn === null) firstVapDevelopmentTurn = turn;
      }
    });

    const last = result.history[result.history.length - 1];
    const finance = last?.financialResults.find((f) => f.companyId === companyId);
    const cumulativeNetIncomeUsd = result.history.reduce((sum, record) => {
      const fr = record.financialResults.find((f) => f.companyId === companyId);
      return sum + (fr ? (fr.profitAndLoss.netIncome as unknown as number) : 0);
    }, 0);

    return {
      seed,
      companyId,
      marketEvolutionEnabled,
      newFactoryProposals,
      pdMechanizationProposals,
      vapDevelopmentQuarters,
      vapDevelopmentTotalUsd,
      firstNewFactoryTurn,
      firstMechanizationTurn,
      firstVapDevelopmentTurn,
      finalCashUsd: finance ? (finance.balanceSheet.cash as unknown as number) : 0,
      cumulativeNetIncomeUsd,
    };
  });
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

const rows: CompanyOutcome[] = [];
for (const marketEvolutionEnabled of [false, true]) {
  for (const seed of SEEDS) {
    rows.push(...runSeed(seed, marketEvolutionEnabled));
  }
}

for (const enabled of [false, true]) {
  const subset = rows.filter((r) => r.marketEvolutionEnabled === enabled);
  console.log(`\n=== 市場進化 ${enabled ? "ON" : "OFF"}（${HORIZON_QUARTERS}四半期・5社×${SEEDS.length}シード）===`);
  console.log("seed                | 会社  | 新工場 | 省人化 | VAP開発Q | VAP開発額     | 初回投資turn      | 期末現金        | 累積純利益");
  console.log("--------------------|-------|--------|--------|----------|---------------|-------------------|-----------------|----------------");
  for (const r of subset) {
    const firsts = [r.firstNewFactoryTurn, r.firstMechanizationTurn, r.firstVapDevelopmentTurn]
      .map((t) => (t === null ? "-" : String(t)))
      .join("/");
    console.log(
      `${r.seed.padEnd(19)} | ${r.companyId.padEnd(5)} | ${String(r.newFactoryProposals).padStart(6)} | ` +
        `${String(r.pdMechanizationProposals).padStart(6)} | ${String(r.vapDevelopmentQuarters).padStart(8)} | ` +
        `${fmt(r.vapDevelopmentTotalUsd).padStart(13)} | ${firsts.padStart(17)} | ${fmt(r.finalCashUsd).padStart(15)} | ${fmt(r.cumulativeNetIncomeUsd).padStart(14)}`
    );
  }
  const distinctCash = new Set(subset.map((r) => Math.round(r.finalCashUsd)));
  const adopters = subset.filter((r) => r.newFactoryProposals + r.pdMechanizationProposals + r.vapDevelopmentQuarters > 0);
  console.log(
    `→ 期末現金の相異なる値: ${distinctCash.size}/${subset.length}通り、` +
      `新投資を採用した会社×シード: ${adopters.length}/${subset.length}`
  );
}
