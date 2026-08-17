// ShrimpX V2 — Phase 2A: MASS 初期借入 80M / 40M の比較ベンチマーク
//
// Case 0 = Dynamic Scenario 1（MASS 借入 80M）
// Case 1 = Dynamic Scenario 2（MASS 借入 40M）
// 世界の側は同一（DS2 は DS1 をスプレッドで継承）なので、差は借入だけ。
//
//   npx tsx scripts/dynamicScenario2MassDebtBenchmark.ts

import { initializeCompanyLab, advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecision } from "../app/lib/v2/companyLab/standardAi/policy";
import { DYNAMIC_SCENARIO_1 } from "../app/lib/v2/scenario/definitions/dynamicScenario1";
import { DYNAMIC_SCENARIO_2 } from "../app/lib/v2/scenario/definitions/dynamicScenario2";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { CompanyLabState } from "../app/lib/v2/companyLab/types";

const M = (n: number) => (n / 1e6).toFixed(1);
const T = (n: number) => Math.round(n).toLocaleString();
const SEEDS = ["ds2-bench-a", "ds2-bench-b"];
const TURNS = 8;
const TARGET = "MASS";

function run(scenarioId: string, seed: string) {
  const { state: initialState, fixtures } = initializeCompanyLab({ scenarioId, mode: "canonical", seed, turns: 32 });
  let state: CompanyLabState = initialState;
  const rows: string[] = [];
  const companyTotals = new Map<string, { op: number; cash: number }>();

  for (let turn = 1; turn <= TURNS; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions = fixtures.map((f) =>
      generateStandardAiDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)
    );
    state = advanceCompanyLabQuarter(state, fixtures, Object.fromEntries(decisions.map((d) => [d.companyId, d])));
    const record = state.history[state.history.length - 1];

    const fin = record.financialResults.find((r) => r.companyId === TARGET);
    const sum = record.companySummaries.find((c) => c.companyId === TARGET);
    const fng = record.financingResults?.find((r) => r.companyId === TARGET);
    if (!fin || !sum) continue;

    const pl = fin.profitAndLoss;
    const bs = fin.balanceSheet;
    const debt = Number(bs.shortTermLoans) + Number(bs.longTermLoans);

    rows.push(
      `  T${turn}` +
        ` 売上=${M(Number(pl.netRevenue))}M` +
        ` 営業利益=${M(Number(pl.operatingProfit))}M` +
        
        ` 現金=${M(Number(bs.cash))}M` +
        ` 借入=${M(debt)}M` +
        ` HOSO生産=${T(unwrapUnit(sum.hosoProduced))}t` +
        ` 新規成約=${T(unwrapUnit(sum.newContractedQuantity))}t` +
        ` 受注残=${T(unwrapUnit(sum.outstandingQuantity))}t` +
        ` 製品在庫=${T(unwrapUnit(sum.finishedGoodsInventory))}t` +
        ` 原料調達=${T(unwrapUnit(sum.domesticPurchaseQuantity))}t` +
        ` 原料在庫=${T(unwrapUnit(sum.rawMaterialInventory))}t` +
        ` 資金不足=${fin.cashShortfall ? "YES" : "no"}` +
        (fng
          ? ` 利息発生=${M(fng.interestAccrualUsd)}M 元本返済=${M(fng.principalPaidCashUsd)}M` +
            ` 借入枠=${M(fng.borrowingCapacity.grossLimitUsd)}M 与信=${fng.creditScore.tier ?? "-"}` +
            ` 調達制約=${fng.procurementConstraint ? "YES" : "no"}`
          : "")
    );

    for (const r of record.financialResults) {
      const prev = companyTotals.get(r.companyId) ?? { op: 0, cash: 0 };
      companyTotals.set(r.companyId, { op: prev.op + Number(r.profitAndLoss.operatingProfit), cash: Number(r.balanceSheet.cash) });
    }
  }
  return { rows, companyTotals };
}

for (const seed of SEEDS) {
  console.log(`\n############ seed=${seed} ############`);
  for (const [label, scenarioId] of [
    ["Case 0 — DS1（MASS借入 80M）", DYNAMIC_SCENARIO_1.scenarioId],
    ["Case 1 — DS2（MASS借入 40M）", DYNAMIC_SCENARIO_2.scenarioId],
  ] as const) {
    console.log(`\n### ${label}`);
    const { rows, companyTotals } = run(scenarioId, seed);
    for (const r of rows) console.log(r);
    console.log(
      "  [5社] T1-8累計営業利益 / T8現金: " +
        Array.from(companyTotals.entries())
          .map(([id, v]) => `${id}=${M(v.op)}M/${M(v.cash)}M`)
          .join("  ")
    );
  }
}
