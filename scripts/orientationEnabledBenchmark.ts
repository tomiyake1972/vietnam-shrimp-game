// ShrimpX V2 — Phase SAI-5B: CompanyOrientationProfile 有効化のbenchmark
//
// 【実ゲームと同じ経路で測る】Management Console の Simulation Run と同じ
// createSimulationSession → advanceSimulationTurn を使う。Standard AI へ渡す params は
// engine.ts が resolveStandardAiProfileForMode で解決するため、このスクリプトは
// paramsを一切自前で組み立てない（診断専用の別経路を作らない）。
//
// ゲームロジック・プロファイル定義・シナリオ・保存データは一切変更しない読み取り専用。
//
//   npx tsx scripts/orientationEnabledBenchmark.ts                       # 既定: ON / 32Turn / 5 seed
//   AI_PROFILE_MODE=OFF npx tsx scripts/orientationEnabledBenchmark.ts   # 有効化前との比較
//   TURNS=8 SEEDS=1 npx tsx scripts/orientationEnabledBenchmark.ts       # 短期検証（指示§9）

import { createSimulationSession, advanceSimulationTurn } from "../app/lib/v2/companyLab/simulation/engine";
import { SimulationSession } from "../app/lib/v2/companyLab/simulation/types";
import { DYNAMIC_SCENARIO_2 } from "../app/lib/v2/scenario/definitions/dynamicScenario2";
import { unwrapUnit } from "../app/lib/v2/core/units";

const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const PRODUCTS = ["hoso", "pd", "vap"] as const;
const MARKETS = ["CN", "US", "EU", "JP", "OTHER"] as const;
const ALL_SEEDS = ["sai5b-a", "sai5b-b", "sai5b-c", "sai5b-d", "sai5b-e"];

const MODE: "OFF" | "ON" = process.env.AI_PROFILE_MODE === "OFF" ? "OFF" : "ON";
const TURNS = process.env.TURNS ? Number(process.env.TURNS) : 32;
const SEEDS = ALL_SEEDS.slice(0, process.env.SEEDS ? Number(process.env.SEEDS) : 5);
const SNAPSHOTS = [1, 4, 8, 12, 16, 20, 24, 28, 32].filter((t) => t <= TURNS);
const AT = "2026-01-01T00:00:00.000Z";

const M = (n: number) => (n / 1e6).toFixed(1);
const T = (n: number) => Math.round(n).toLocaleString();
const pct = (part: number, total: number) => (total <= 0 ? "  -" : `${((part / total) * 100).toFixed(0)}`.padStart(3));

interface TurnRow {
  readonly turn: number;
  readonly companyId: string;
  readonly prod: Record<string, number>;
  readonly salesByProduct: Record<string, number>;
  readonly salesByMarket: Record<string, number>;
  readonly op: number;
  readonly revenue: number;
  readonly cash: number;
  readonly debt: number;
  readonly shortfall: boolean;
}

interface SeedResult {
  readonly seed: string;
  readonly completedTurns: number;
  readonly rows: readonly TurnRow[];
  readonly capexEvents: ReadonlyMap<string, number>;
  readonly profileIdByCompany: ReadonlyMap<string, string>;
}

function runSeed(seed: string): SeedResult {
  let session: SimulationSession = createSimulationSession({
    simulationRunId: `sai5b-${MODE}-${seed}`,
    scenarioId: DYNAMIC_SCENARIO_2.scenarioId,
    seed,
    requestedTurns: TURNS,
    startedAt: AT,
    // 既定（未指定）は DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE = "ON"。
    // OFF比較のときだけ明示的に無効化する。
    standardAiProfileMode: MODE === "OFF" ? "OFF" : undefined,
  });

  const rows: TurnRow[] = [];
  const capexEvents = new Map<string, number>();
  const profileIdByCompany = new Map<string, string>();
  let completedTurns = 0;

  while (completedTurns < TURNS) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) break;
    session = outcome.session;
    completedTurns += 1;
    const record = session.state.history[session.state.history.length - 1];

    for (const companyId of COMPANIES) {
      const summary = record.companySummaries.find((c) => c.companyId === companyId);
      const fin = record.financialResults.find((r) => r.companyId === companyId);
      const salesByProduct: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
      const salesByMarket: Record<string, number> = { CN: 0, US: 0, EU: 0, JP: 0, OTHER: 0 };
      for (const c of record.salesRecord.newContracts) {
        if (c.companyId !== companyId) continue;
        const q = unwrapUnit(c.originalQuantity);
        salesByProduct[c.product] += q;
        salesByMarket[c.market] += q;
      }
      rows.push({
        turn: completedTurns,
        companyId,
        prod: {
          hoso: summary ? unwrapUnit(summary.hosoProduced) : 0,
          pd: summary ? unwrapUnit(summary.pdProduced) : 0,
          vap: summary ? unwrapUnit(summary.vapProduced) : 0,
        },
        salesByProduct,
        salesByMarket,
        op: fin ? Number(fin.profitAndLoss.operatingProfit) : 0,
        revenue: fin ? Number(fin.profitAndLoss.netRevenue) : 0,
        cash: fin ? Number(fin.balanceSheet.cash) : 0,
        debt: fin ? Number(fin.balanceSheet.shortTermLoans) + Number(fin.balanceSheet.longTermLoans) : 0,
        shortfall: Boolean(fin?.cashShortfall),
      });
    }
    for (const r of record.capexResults ?? []) {
      capexEvents.set(r.companyId, (capexEvents.get(r.companyId) ?? 0) + (r.events ?? []).length);
    }
    // engine.tsが実際に解決したprofileを記録する（有効化されたことの実経路での確認）。
    for (const entry of session.packCompanyTurns) {
      if (entry.turn !== completedTurns) continue;
      const p = entry.strategy?.profile;
      if (p) profileIdByCompany.set(entry.companyId, `${p.mode}:${p.managementProfileId}+${p.orientationProfileId}`);
    }
  }

  return { seed, completedTurns, rows, capexEvents, profileIdByCompany };
}

console.log(`=== Phase SAI-5B benchmark（Dynamic Scenario 2 / standardAiProfileMode=${MODE} / ${TURNS}Turn / seed×${SEEDS.length}）===`);

const results = SEEDS.map(runSeed);
const first = results[0];

console.log(`\n### engine.tsが解決したprofile（seed=${first.seed}・実経路での有効化確認）`);
for (const companyId of COMPANIES) {
  console.log(`  ${companyId.padEnd(6)} ${first.profileIdByCompany.get(companyId) ?? "(記録なし)"}`);
}

function mixLines(label: string, pick: (r: TurnRow) => Record<string, number>, keys: readonly string[]): void {
  console.log(`\n### ${label}`);
  console.log("  Turn " + COMPANIES.map((c) => c.padStart(keys.length === 3 ? 14 : 22)).join(""));
  for (const t of SNAPSHOTS) {
    const row = COMPANIES.map((companyId) => {
      const r = first.rows.find((x) => x.turn === t && x.companyId === companyId)!;
      const values = pick(r);
      const total = keys.reduce((a, k) => a + values[k], 0);
      return keys.map((k) => pct(values[k], total)).join("/").padStart(keys.length === 3 ? 14 : 22);
    }).join("");
    console.log(`  T${String(t).padEnd(4)}` + row);
  }
}

console.log(`\n--- seed=${first.seed} の推移（指示§11・§12） ---`);
mixLines("生産構成 %（HOSO/PD/VAP）", (r) => r.prod, PRODUCTS as unknown as string[]);
mixLines("成約構成 %（HOSO/PD/VAP）", (r) => r.salesByProduct, PRODUCTS as unknown as string[]);
mixLines("成約の市場構成 %（CN/US/EU/JP/OTHER）", (r) => r.salesByMarket, MARKETS as unknown as string[]);

console.log("\n### 期間平均（全seed平均・会社別の傾きが出ているかの判定用）");
console.log("  会社    生産HOSO 生産PD 生産VAP  成約HOSO 成約PD 成約VAP   CN    US    EU    JP  OTHER");
for (const companyId of COMPANIES) {
  const rows = results.flatMap((r) => r.rows).filter((r) => r.companyId === companyId);
  const sum = (f: (r: TurnRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const prodTotal = PRODUCTS.reduce((a, p) => a + sum((r) => r.prod[p]), 0);
  const salesTotal = PRODUCTS.reduce((a, p) => a + sum((r) => r.salesByProduct[p]), 0);
  const marketTotal = MARKETS.reduce((a, k) => a + sum((r) => r.salesByMarket[k]), 0);
  const cells = [
    ...PRODUCTS.map((p) => `${((sum((r) => r.prod[p]) / Math.max(1, prodTotal)) * 100).toFixed(1)}`.padStart(8)),
    " ",
    ...PRODUCTS.map((p) => `${((sum((r) => r.salesByProduct[p]) / Math.max(1, salesTotal)) * 100).toFixed(1)}`.padStart(8)),
    " ",
    ...MARKETS.map((k) => `${((sum((r) => r.salesByMarket[k]) / Math.max(1, marketTotal)) * 100).toFixed(1)}`.padStart(6)),
  ];
  console.log(`  ${companyId.padEnd(6)}` + cells.join(""));
}

console.log("\n### 最終順位（seed別・累計営業利益/期末現金/期末借入/累計生産/資金不足T/CAPEX）");
for (const r of results) {
  console.log(`\n  [${r.seed}] 完走=${r.completedTurns}T`);
  const perCompany = COMPANIES.map((companyId) => {
    const rows = r.rows.filter((x) => x.companyId === companyId);
    const last = rows[rows.length - 1];
    const sum = (f: (x: TurnRow) => number) => rows.reduce((a, x) => a + f(x), 0);
    const prodTotal = PRODUCTS.reduce((a, p) => a + sum((x) => x.prod[p]), 0);
    return {
      companyId,
      op: sum((x) => x.op),
      cash: last.cash,
      debt: last.debt,
      production: prodTotal,
      mix: PRODUCTS.map((p) => ((sum((x) => x.prod[p]) / Math.max(1, prodTotal)) * 100).toFixed(0)).join("/"),
      shortfall: rows.filter((x) => x.shortfall).length,
      capex: r.capexEvents.get(companyId) ?? 0,
    };
  }).sort((a, b) => b.op - a.op);
  perCompany.forEach((c, i) => {
    console.log(
      `    ${i + 1}位 ${c.companyId.padEnd(6)} OP=${M(c.op).padStart(7)}M  現金=${M(c.cash).padStart(6)}M  借入=${M(c.debt).padStart(5)}M` +
        `  生産=${T(c.production).padStart(8)}t  ${c.mix}%  資金不足=${String(c.shortfall).padStart(2)}  CAPEX=${String(c.capex).padStart(2)}`
    );
  });
}

console.log("\n### 順位分布（全seed）");
for (const companyId of COMPANIES) {
  const ranks = results.map((r) => {
    const ranked = COMPANIES.map((c) => ({
      companyId: c,
      op: r.rows.filter((x) => x.companyId === c).reduce((a, x) => a + x.op, 0),
    })).sort((a, b) => b.op - a.op);
    return ranked.findIndex((x) => x.companyId === companyId) + 1;
  });
  const ops = results.map((r) => r.rows.filter((x) => x.companyId === companyId).reduce((a, x) => a + x.op, 0));
  console.log(
    `  ${companyId.padEnd(6)} 順位=${ranks.join(",")}  累計OP 平均=${M(ops.reduce((a, b) => a + b, 0) / ops.length).padStart(7)}M` +
      `  最小=${M(Math.min(...ops)).padStart(7)}M 最大=${M(Math.max(...ops)).padStart(7)}M`
  );
}

console.log("\n### 会社間ばらつき（全seed平均shareの 最大−最小、%ポイント）");
{
  const shares = (pick: (r: TurnRow) => Record<string, number>, keys: readonly string[], key: string) =>
    COMPANIES.map((companyId) => {
      const rows = results.flatMap((r) => r.rows).filter((r) => r.companyId === companyId);
      const sum = (k: string) => rows.reduce((a, r) => a + pick(r)[k], 0);
      const total = keys.reduce((a, k) => a + sum(k), 0);
      return total <= 0 ? 0 : (sum(key) / total) * 100;
    });
  for (const p of PRODUCTS) {
    const s = shares((r) => r.salesByProduct, PRODUCTS, p);
    console.log(`  成約${p.toUpperCase().padEnd(5)} ${(Math.max(...s) - Math.min(...s)).toFixed(1).padStart(6)}pt`);
  }
  for (const k of MARKETS) {
    const s = shares((r) => r.salesByMarket, MARKETS, k);
    console.log(`  市場${k.padEnd(6)} ${(Math.max(...s) - Math.min(...s)).toFixed(1).padStart(6)}pt`);
  }
}
