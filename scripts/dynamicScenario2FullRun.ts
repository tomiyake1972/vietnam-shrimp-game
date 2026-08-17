// ShrimpX V2 — Dynamic Scenario 2 の 5社 × 32Turn 通し実行（Phase 2A 検証）
//
// HOSO Scale mechanic は入れていない状態での確認。読み取り専用。
//
//   npx tsx scripts/dynamicScenario2FullRun.ts

import { initializeCompanyLab, advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecision } from "../app/lib/v2/companyLab/standardAi/policy";
import { DYNAMIC_SCENARIO_2 } from "../app/lib/v2/scenario/definitions/dynamicScenario2";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { CompanyLabState } from "../app/lib/v2/companyLab/types";

const M = (n: number) => (n / 1e6).toFixed(1);
const T = (n: number) => Math.round(n).toLocaleString();
const SEEDS = ["ds2-full-a", "ds2-full-b"];
const PERIODS: readonly (readonly [string, number, number])[] = [
  ["T1-4", 1, 4],
  ["T5-8", 5, 8],
  ["T9-16", 9, 16],
  ["T17-20", 17, 20],
  ["T21-24", 21, 24],
  ["T25-32", 25, 32],
];

interface TurnRow {
  readonly turn: number;
  readonly companyId: string;
  readonly revenue: number;
  readonly op: number;
  readonly cash: number;
  readonly debt: number;
  readonly shortfall: boolean;
  readonly procurement: number;
  readonly hoso: number;
  readonly pd: number;
  readonly vap: number;
  readonly contracted: number;
  readonly backlog: number;
  readonly fg: number;
  readonly factories: number;
}

for (const seed of SEEDS) {
  console.log(`\n################ seed=${seed} ################`);
  const { state: initialState, fixtures } = initializeCompanyLab({
    scenarioId: DYNAMIC_SCENARIO_2.scenarioId,
    mode: "canonical",
    seed,
    turns: 32,
  });

  let state: CompanyLabState = initialState;
  const rows: TurnRow[] = [];
  const capexApproved = new Map<string, number>();
  let completed = 0;
  let failure: string | null = null;

  try {
    while (!state.isComplete) {
      const publicInfo = buildPublicMarketInfo(state);
      const decisions = fixtures.map((f) =>
        generateStandardAiDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)
      );
      state = advanceCompanyLabQuarter(state, fixtures, Object.fromEntries(decisions.map((d) => [d.companyId, d])));
      const record = state.history[state.history.length - 1];
      completed = record.turn ?? completed + 1;

      for (const s of record.companySummaries) {
        const fin = record.financialResults.find((r) => r.companyId === s.companyId);
        if (!fin) continue;
        rows.push({
          turn: completed,
          companyId: s.companyId,
          revenue: Number(fin.profitAndLoss.netRevenue),
          op: Number(fin.profitAndLoss.operatingProfit),
          cash: Number(fin.balanceSheet.cash),
          debt: Number(fin.balanceSheet.shortTermLoans) + Number(fin.balanceSheet.longTermLoans),
          shortfall: Boolean(fin.cashShortfall),
          procurement: unwrapUnit(s.domesticPurchaseQuantity),
          hoso: unwrapUnit(s.hosoProduced),
          pd: unwrapUnit(s.pdProduced),
          vap: unwrapUnit(s.vapProduced),
          contracted: unwrapUnit(s.newContractedQuantity),
          backlog: unwrapUnit(s.outstandingQuantity),
          fg: unwrapUnit(s.finishedGoodsInventory),
          factories: 0,
        });
      }
      for (const r of record.capexResults ?? []) {
        const n = (r.events ?? []).length;
        if (n > 0) capexApproved.set(r.companyId, (capexApproved.get(r.companyId) ?? 0) + n);
      }
    }
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  console.log(`完走: ${failure === null ? `YES（${completed} turns）` : `NO — ${failure}（${completed} turns まで）`}`);

  // --- MASS 期間別 ---
  console.log("\n### MASS 期間別（合計 / 期末値）");
  for (const [label, from, to] of PERIODS) {
    const seg = rows.filter((r) => r.companyId === "MASS" && r.turn >= from && r.turn <= to);
    if (seg.length === 0) continue;
    const last = seg[seg.length - 1];
    const sum = (f: (r: TurnRow) => number) => seg.reduce((a, r) => a + f(r), 0);
    console.log(
      `  ${label.padEnd(7)}` +
        ` 売上=${M(sum((r) => r.revenue)).padStart(7)}M` +
        ` 営業利益=${M(sum((r) => r.op)).padStart(7)}M` +
        ` 期末現金=${M(last.cash).padStart(6)}M` +
        ` 期末借入=${M(last.debt).padStart(6)}M` +
        ` 原料調達=${T(sum((r) => r.procurement)).padStart(8)}t` +
        ` HOSO生産=${T(sum((r) => r.hoso)).padStart(8)}t` +
        ` 成約=${T(sum((r) => r.contracted)).padStart(8)}t` +
        ` 期末受注残=${T(last.backlog).padStart(7)}t` +
        ` 期末製品在庫=${T(last.fg).padStart(6)}t` +
        ` 資金不足Turn=${seg.filter((r) => r.shortfall).length}`
    );
  }

  // --- T17-20 の5社比較（不況の効き方） ---
  console.log("\n### T17-20 不況期の5社比較（期間合計 / 期末）");
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    const seg = rows.filter((r) => r.companyId === companyId && r.turn >= 17 && r.turn <= 20);
    const prev = rows.filter((r) => r.companyId === companyId && r.turn >= 13 && r.turn <= 16);
    if (seg.length === 0) continue;
    const sum = (list: TurnRow[], f: (r: TurnRow) => number) => list.reduce((a, r) => a + f(r), 0);
    const opNow = sum(seg, (r) => r.op);
    const opPrev = sum(prev, (r) => r.op);
    const prodNow = sum(seg, (r) => r.hoso + r.pd + r.vap);
    const prodPrev = sum(prev, (r) => r.hoso + r.pd + r.vap);
    console.log(
      `  ${companyId.padEnd(6)}` +
        ` 営業利益 T13-16=${M(opPrev).padStart(7)}M → T17-20=${M(opNow).padStart(7)}M（${(opNow - opPrev >= 0 ? "+" : "") + M(opNow - opPrev)}M）` +
        ` 生産 ${T(prodPrev).padStart(7)}t → ${T(prodNow).padStart(7)}t（${((prodNow / Math.max(1, prodPrev) - 1) * 100).toFixed(0)}%）` +
        ` 期末現金=${M(seg[seg.length - 1].cash).padStart(6)}M` +
        ` 期末在庫=${T(seg[seg.length - 1].fg).padStart(6)}t`
    );
  }

  // --- T21-24 回復 ---
  console.log("\n### T21-24 回復期の5社比較");
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    const seg = rows.filter((r) => r.companyId === companyId && r.turn >= 21 && r.turn <= 24);
    const prev = rows.filter((r) => r.companyId === companyId && r.turn >= 17 && r.turn <= 20);
    if (seg.length === 0) continue;
    const sum = (list: TurnRow[], f: (r: TurnRow) => number) => list.reduce((a, r) => a + f(r), 0);
    console.log(
      `  ${companyId.padEnd(6)}` +
        ` 営業利益 T17-20=${M(sum(prev, (r) => r.op)).padStart(7)}M → T21-24=${M(sum(seg, (r) => r.op)).padStart(7)}M` +
        ` HOSO生産 ${T(sum(prev, (r) => r.hoso)).padStart(7)}t → ${T(sum(seg, (r) => r.hoso)).padStart(7)}t`
    );
  }

  // --- 最終比較 ---
  console.log("\n### Turn32 時点の5社比較");
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    const all = rows.filter((r) => r.companyId === companyId);
    if (all.length === 0) continue;
    const last = all[all.length - 1];
    const sum = (f: (r: TurnRow) => number) => all.reduce((a, r) => a + f(r), 0);
    const hoso = sum((r) => r.hoso);
    const pd = sum((r) => r.pd);
    const vap = sum((r) => r.vap);
    const total = Math.max(1, hoso + pd + vap);
    console.log(
      `  ${companyId.padEnd(6)}` +
        ` 累計営業利益=${M(sum((r) => r.op)).padStart(8)}M` +
        ` 累計売上=${M(sum((r) => r.revenue)).padStart(8)}M` +
        ` 期末現金=${M(last.cash).padStart(7)}M` +
        ` 期末借入=${M(last.debt).padStart(7)}M` +
        ` 累計生産=${T(total).padStart(8)}t` +
        ` 構成 HOSO/PD/VAP=${((hoso / total) * 100).toFixed(0)}/${((pd / total) * 100).toFixed(0)}/${((vap / total) * 100).toFixed(0)}%` +
        ` 資金不足Turn数=${all.filter((r) => r.shortfall).length}` +
        ` CAPEX件数=${capexApproved.get(companyId) ?? 0}`
    );
  }
}
