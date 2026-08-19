// ShrimpX V2 — DS3: BAL 資金不足の root cause 監査（読み取り専用）
//
// 指示§3「DS3世界の問題か、Standard AI の BAL 投資判断の問題かを分離する」。
// factory CAPEX / PD・VAP CAPEX / sales hiring / raw material purchase /
// borrowing / cash reserve の Turn 別推移を出す。
// ゲームロジック・シナリオ定義・保存データは一切変更しない。
//
//   npx tsx scripts/dynamicScenario3BalAudit.ts
//   COMPANY=MASS SEED=ds3-d npx tsx scripts/dynamicScenario3BalAudit.ts
//   SCENARIO=dynamic-scenario-2-v0.1 npx tsx scripts/dynamicScenario3BalAudit.ts

import { createSimulationSession, advanceSimulationTurn } from "../app/lib/v2/companyLab/simulation/engine";
import { SimulationSession } from "../app/lib/v2/companyLab/simulation/types";
import { DYNAMIC_SCENARIO_3 } from "../app/lib/v2/scenario/definitions/dynamicScenario3";
import { unwrapUnit } from "../app/lib/v2/core/units";

const SCENARIO_ID = process.env.SCENARIO ?? DYNAMIC_SCENARIO_3.scenarioId;
const COMPANY = process.env.COMPANY ?? "BAL";
const SEEDS = (process.env.SEED ?? "ds3-a,ds3-d").split(",");
const TURNS = 32;
const AT = "2026-01-01T00:00:00.000Z";

const M = (v: number) => (v / 1e6).toFixed(1);
const n0 = (v: number) => Math.round(v).toLocaleString();

for (const seed of SEEDS) {
  let session: SimulationSession = createSimulationSession({
    simulationRunId: `bal-audit-${seed}`,
    scenarioId: SCENARIO_ID,
    seed,
    requestedTurns: TURNS,
    startedAt: AT,
  });

  console.log(`\n${"=".repeat(140)}`);
  console.log(`=== ${COMPANY} 監査（scenario=${SCENARIO_ID} / seed=${seed}）`);
  console.log("=".repeat(140));
  console.log(
    "  Turn  現金M  借入M 借入実行M 資金不足  投資CF_M 新規案件 稼働案件  営業人員 採用  国内調達t 輸入到着t  生産t  成約t  在庫t  営業利益M  能力anchor"
  );

  let cumulativeCapex = 0;
  for (let t = 0; t < TURNS; t++) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) break;
    session = outcome.session;
    const turn = t + 1;
    const record = session.state.history[session.state.history.length - 1];

    const fin = record.financialResults.find((r) => r.companyId === COMPANY);
    const summary = record.companySummaries.find((s) => s.companyId === COMPANY);
    const financing = record.financingResults.find((r) => r.companyId === COMPANY);
    const capex = (record.capexResults ?? []).find((r) => r.companyId === COMPANY);
    const decision = record.decisions.find((d) => d.companyId === COMPANY);
    const cap = session.capacityByTurn.find((x) => x.turn === turn && x.companyId === COMPANY);
    const hc = session.salesHeadcountByTurn.find((x) => x.turn === turn && x.companyId === COMPANY);

    const capexSpend = fin ? Math.abs(Number(fin.cashFlow.investingCashFlow)) : 0;
    cumulativeCapex += capexSpend;
    const contracted = record.salesRecord.newContracts
      .filter((c) => c.companyId === COMPANY)
      .reduce((a, c) => a + unwrapUnit(c.originalQuantity), 0);
    const produced = summary
      ? unwrapUnit(summary.hosoProduced) + unwrapUnit(summary.pdProduced) + unwrapUnit(summary.vapProduced)
      : 0;
    const capacityAnchor = cap ? Math.min(cap.hoso + cap.pd + cap.vap, cap.commonProcessing) : 0;

    console.log(
      `  T${String(turn).padEnd(4)}` +
        M(fin ? Number(fin.balanceSheet.cash) : 0).padStart(7) +
        M(fin ? Number(fin.balanceSheet.shortTermLoans) + Number(fin.balanceSheet.longTermLoans) : 0).padStart(7) +
        M(financing ? Number(financing.loanDrawUsd) : 0).padStart(9) +
        (fin?.cashShortfall ? "   不足  " : "     -   ") +
        M(capexSpend).padStart(10) +
        String(decision?.capexDecision.newProjectProposals.length ?? 0).padStart(8) +
        String((capex?.events ?? []).length).padStart(8) +
        String(hc?.headcount ?? 0).padStart(10) +
        String(decision?.salesForceHireCount ?? 0).padStart(5) +
        n0(summary ? unwrapUnit(summary.domesticPurchaseQuantity) : 0).padStart(10) +
        n0(summary ? unwrapUnit(summary.importArrivedQuantity) : 0).padStart(10) +
        n0(produced).padStart(8) +
        n0(contracted).padStart(7) +
        n0(summary ? unwrapUnit(summary.finishedGoodsInventory) : 0).padStart(7) +
        M(fin ? Number(fin.profitAndLoss.operatingProfit) : 0).padStart(10) +
        n0(capacityAnchor).padStart(12)
    );
  }
  console.log(`  累計CAPEX支出 = ${M(cumulativeCapex)}M`);
}
