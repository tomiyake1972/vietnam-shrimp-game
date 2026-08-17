// ShrimpX V2 — Dynamic Scenario 2 の複数seed検証（MASS 初期借入の妥当性判定）
//
// ゲームロジックは一切変更しない読み取り専用スクリプト。
// 環境変数 DS2_MASS_DEBT_M を与えると、その借入額（百万USD）で感度分析できる
// （与えない場合はシナリオ定義どおり＝40M）。
//
//   npx tsx scripts/dynamicScenario2SeedSweep.ts
//   DS2_MASS_DEBT_M=50 npx tsx scripts/dynamicScenario2SeedSweep.ts

import { initializeCompanyLab, advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecision } from "../app/lib/v2/companyLab/standardAi/policy";
import { DYNAMIC_SCENARIO_2 } from "../app/lib/v2/scenario/definitions/dynamicScenario2";
import { ScenarioDefinition } from "../app/lib/v2/scenario/types";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { CompanyLabState } from "../app/lib/v2/companyLab/types";

const M = (n: number) => (n / 1e6).toFixed(1);
const T = (n: number) => Math.round(n).toLocaleString();
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const SEEDS = ["ds2-full-a", "ds2-full-b", "ds2-s3", "ds2-s4", "ds2-s5", "ds2-s6", "ds2-s7", "ds2-s8"];

// 感度分析用。短期:長期 = 35:45 の比率を保ったまま総額だけ変える。
const debtOverrideM = process.env.DS2_MASS_DEBT_M ? Number(process.env.DS2_MASS_DEBT_M) : null;
// 感度分析では、レジストリ上の DS2 定義そのものの初期借入だけを差し替える
// （initializeCompanyLab は scenarioId でレジストリを引くため、別IDでは解決できない）。
// このスクリプト内だけの一時的な差し替えで、コミット対象の定義は変えていない。
if (debtOverrideM !== null) {
  (DYNAMIC_SCENARIO_2 as { initialCompanyDebtUsd?: unknown }).initialCompanyDebtUsd = {
    MASS: {
      shortTermLoans: debtOverrideM * 1e6 * (35 / 80),
      longTermLoans: debtOverrideM * 1e6 * (45 / 80),
    },
  };
}
const definition: ScenarioDefinition = DYNAMIC_SCENARIO_2;

interface CompanyResult {
  readonly companyId: string;
  readonly cumulativeOp: number;
  readonly endingCash: number;
  readonly endingDebt: number;
  readonly shortfallTurns: number;
  readonly negativeCashTurns: number;
  readonly capexEvents: number;
  readonly factories: number;
  readonly production: number;
  readonly mix: string;
}

interface SeedResult {
  readonly seed: string;
  readonly completed: number;
  readonly companies: readonly CompanyResult[];
  readonly massByPeriod: ReadonlyMap<string, { op: number; revenue: number; hoso: number; cash: number; debt: number; procurement: number; fg: number }>;
}

const PERIODS: readonly (readonly [string, number, number])[] = [
  ["T1-4", 1, 4],
  ["T5-16", 5, 16],
  ["T17-20", 17, 20],
  ["T21-24", 21, 24],
  ["T25-32", 25, 32],
];

function runSeed(seed: string): SeedResult {
  const { state: initialState, fixtures } = initializeCompanyLab({ scenarioId: definition.scenarioId, mode: "canonical", seed, turns: 32 });
  let state: CompanyLabState = initialState;
  const perTurn: { turn: number; companyId: string; op: number; revenue: number; cash: number; debt: number; shortfall: boolean; hoso: number; pd: number; vap: number; procurement: number; fg: number }[] = [];
  const capex = new Map<string, number>();
  let completed = 0;

  while (!state.isComplete) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions = fixtures.map((f) =>
      generateStandardAiDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)
    );
    state = advanceCompanyLabQuarter(state, fixtures, Object.fromEntries(decisions.map((d) => [d.companyId, d])));
    const record = state.history[state.history.length - 1];
    completed += 1;
    for (const s of record.companySummaries) {
      const fin = record.financialResults.find((r) => r.companyId === s.companyId);
      if (!fin) continue;
      perTurn.push({
        turn: completed,
        companyId: s.companyId,
        op: Number(fin.profitAndLoss.operatingProfit),
        revenue: Number(fin.profitAndLoss.netRevenue),
        cash: Number(fin.balanceSheet.cash),
        debt: Number(fin.balanceSheet.shortTermLoans) + Number(fin.balanceSheet.longTermLoans),
        shortfall: Boolean(fin.cashShortfall),
        hoso: unwrapUnit(s.hosoProduced),
        pd: unwrapUnit(s.pdProduced),
        vap: unwrapUnit(s.vapProduced),
        procurement: unwrapUnit(s.domesticPurchaseQuantity),
        fg: unwrapUnit(s.finishedGoodsInventory),
      });
    }
    for (const r of record.capexResults ?? []) capex.set(r.companyId, (capex.get(r.companyId) ?? 0) + (r.events ?? []).length);
  }

  const companies = COMPANIES.map((companyId) => {
    const all = perTurn.filter((r) => r.companyId === companyId);
    const last = all[all.length - 1];
    const sum = (f: (r: (typeof all)[number]) => number) => all.reduce((a, r) => a + f(r), 0);
    const hoso = sum((r) => r.hoso);
    const pd = sum((r) => r.pd);
    const vap = sum((r) => r.vap);
    const total = Math.max(1, hoso + pd + vap);
    const fixture = fixtures.find((f) => f.companyId === companyId);
    return {
      companyId,
      cumulativeOp: sum((r) => r.op),
      endingCash: last.cash,
      endingDebt: last.debt,
      shortfallTurns: all.filter((r) => r.shortfall).length,
      negativeCashTurns: all.filter((r) => r.cash < 0).length,
      capexEvents: capex.get(companyId) ?? 0,
      factories: fixture?.factories.length ?? 0,
      production: total,
      mix: `${((hoso / total) * 100).toFixed(0)}/${((pd / total) * 100).toFixed(0)}/${((vap / total) * 100).toFixed(0)}`,
    };
  });

  const massByPeriod = new Map<string, { op: number; revenue: number; hoso: number; cash: number; debt: number; procurement: number; fg: number }>();
  for (const [label, from, to] of PERIODS) {
    const seg = perTurn.filter((r) => r.companyId === "MASS" && r.turn >= from && r.turn <= to);
    const last = seg[seg.length - 1];
    const sum = (f: (r: (typeof seg)[number]) => number) => seg.reduce((a, r) => a + f(r), 0);
    massByPeriod.set(label, {
      op: sum((r) => r.op),
      revenue: sum((r) => r.revenue),
      hoso: sum((r) => r.hoso),
      cash: last.cash,
      debt: last.debt,
      procurement: sum((r) => r.procurement),
      fg: last.fg,
    });
  }

  return { seed, completed, companies, massByPeriod };
}

console.log(`=== Dynamic Scenario 2 seed sweep（MASS 借入 = ${debtOverrideM === null ? "40（定義どおり）" : debtOverrideM}M）===\n`);

const results = SEEDS.map(runSeed);

console.log("### seed別 5社結果（累計営業利益M / 期末現金M / 期末借入M / 資金不足T / 現金マイナスT / CAPEX / 工場 / 累計生産t / 構成HOSO-PD-VAP）");
for (const r of results) {
  console.log(`\n  [${r.seed}] 完走=${r.completed}T`);
  const ranked = [...r.companies].sort((a, b) => b.cumulativeOp - a.cumulativeOp);
  ranked.forEach((c, i) => {
    console.log(
      `    ${i + 1}位 ${c.companyId.padEnd(6)} OP=${M(c.cumulativeOp).padStart(7)}M  現金=${M(c.endingCash).padStart(6)}M  借入=${M(c.endingDebt).padStart(5)}M` +
        `  資金不足=${c.shortfallTurns}  現金マイナス=${c.negativeCashTurns}  CAPEX=${String(c.capexEvents).padStart(2)}  工場=${c.factories}` +
        `  生産=${T(c.production).padStart(8)}t  ${c.mix}%`
    );
  });
}

console.log("\n### MASS 期間別（seed別）");
for (const r of results) {
  const parts = PERIODS.map(([label]) => {
    const p = r.massByPeriod.get(label)!;
    return `${label}: OP=${M(p.op)}M 売上=${M(p.revenue)}M HOSO=${T(p.hoso)}t 現金=${M(p.cash)}M 借入=${M(p.debt)}M 調達=${T(p.procurement)}t 在庫=${T(p.fg)}t`;
  });
  console.log(`\n  [${r.seed}]`);
  for (const p of parts) console.log(`    ${p}`);
}

console.log("\n### 順位分布");
const massRanks: number[] = [];
const ratios: number[] = [];
for (const r of results) {
  const ranked = [...r.companies].sort((a, b) => b.cumulativeOp - a.cumulativeOp);
  const rank = ranked.findIndex((c) => c.companyId === "MASS") + 1;
  massRanks.push(rank);
  const mass = ranked.find((c) => c.companyId === "MASS")!;
  const second = ranked.filter((c) => c.companyId !== "MASS")[0];
  const ratio = mass.cumulativeOp / second.cumulativeOp;
  ratios.push(ratio);
  console.log(`  [${r.seed}] MASS ${rank}位  MASS/最上位他社 = ${ratio.toFixed(3)}  (MASS ${M(mass.cumulativeOp)}M vs ${second.companyId} ${M(second.cumulativeOp)}M)`);
}

const count = (n: number) => massRanks.filter((r) => r === n).length;
console.log(`\n  MASS 1位=${count(1)}回 / 2位=${count(2)}回 / 3位以下=${massRanks.filter((r) => r >= 3).length}回（全${massRanks.length}seed）`);

const massOps = results.map((r) => r.companies.find((c) => c.companyId === "MASS")!.cumulativeOp);
const sorted = [...massOps].sort((a, b) => a - b);
const median = sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
console.log(`  MASS 累計営業利益 平均=${M(massOps.reduce((a, b) => a + b, 0) / massOps.length)}M  中央値=${M(median)}M  最小=${M(sorted[0])}M  最大=${M(sorted[sorted.length - 1])}M`);
console.log(`  MASS/最上位他社 比率 平均=${(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(3)}  最小=${Math.min(...ratios).toFixed(3)}  最大=${Math.max(...ratios).toFixed(3)}`);

console.log("\n### T17-20 の落ち込み分布（T5-16 平均四半期OP → T17-20 平均四半期OP）");
for (const r of results) {
  const line = COMPANIES.map((companyId) => {
    const all = r.companies.find((c) => c.companyId === companyId)!;
    void all;
    return companyId;
  });
  void line;
  const mass = r.massByPeriod.get("T17-20")!;
  const massPrev = r.massByPeriod.get("T5-16")!;
  console.log(`  [${r.seed}] MASS T5-16 平均=${M(massPrev.op / 12)}M/Q → T17-20 平均=${M(mass.op / 4)}M/Q  在庫=${T(mass.fg)}t 現金=${M(mass.cash)}M`);
}

console.log("\n### distress 分布（資金不足Turn数）");
for (const r of results) {
  console.log(`  [${r.seed}] ` + r.companies.map((c) => `${c.companyId}=${c.shortfallTurns}`).join("  "));
}

console.log("\n### 期末現金分布");
for (const r of results) {
  console.log(`  [${r.seed}] ` + r.companies.map((c) => `${c.companyId}=${M(c.endingCash)}M`).join("  "));
}
