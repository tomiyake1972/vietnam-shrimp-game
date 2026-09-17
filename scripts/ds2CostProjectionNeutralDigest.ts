// ShrimpX V2 — #05 Standard AI費用Projection接続: 中立互換（テストA）の実測用digest
//
// 読み取り専用。ゲームロジックを一切変更しない。
// base（接続前）と feature（接続後）の**同じ引数**でこのスクリプトを実行し、
// 出力JSONが1文字も違わないことを確認するためだけに存在する。
// Scenario・seed・販売市場モデル・Turn数はすべて引数で固定する。

import { createSimulationSession, advanceSimulationTurns } from "../app/lib/v2/companyLab/simulation/engine";
import { createHash } from "node:crypto";

const SCENARIOS = ["baseline-v0.1", "dynamic-scenario-1-v0.1", "dynamic-scenario-2-v0.1"] as const;
const SEEDS = ["ds2-neutral-a", "ds2-neutral-b"] as const;
const TURNS = 32;
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function digestOf(scenarioId: string, seed: string) {
  let session = createSimulationSession({
    simulationRunId: `neutral-${scenarioId}-${seed}`,
    scenarioId,
    seed,
    requestedTurns: TURNS,
    startedAt: TIMESTAMP,
  });
  session = advanceSimulationTurns({ session, turns: TURNS, timestamp: TIMESTAMP });
  const state = session.state;
  const companies = state.history[state.history.length - 1].companySummaries.map((s) => s.companyId).sort();
  const perCompany = companies.map((companyId) => {
    let cumulativeOperatingProfit = 0;
    let capexApprovals = 0;
    let productionTons = 0;
    for (const h of state.history) {
      const fin = h.financialResults.find((r) => r.companyId === companyId);
      if (fin) cumulativeOperatingProfit += Number(fin.profitAndLoss.operatingProfit);
      const s = h.companySummaries.find((c) => c.companyId === companyId);
      if (s) productionTons += Number(s.hosoProduced) + Number(s.pdProduced) + Number(s.vapProduced);
      capexApprovals += (h.capexResults ?? []).filter((c) => c.companyId === companyId).length;
    }
    const last = state.history[state.history.length - 1].financialResults.find((r) => r.companyId === companyId);
    return {
      companyId,
      cumulativeOperatingProfit,
      productionTons,
      capexApprovals,
      endingCash: last ? Number(last.balanceSheet.cash) : null,
      endingEquity: last ? Number(last.balanceSheet.totalEquity ?? 0) : null,
    };
  });
  // 32Turn最終stateそのものの一致まで見るため、state全体のhashも取る。
  const stateHash = createHash("sha256").update(JSON.stringify(state)).digest("hex");
  return { scenarioId, seed, completedTurns: state.history.length, perCompany, stateHash };
}

const out = [];
for (const scenarioId of SCENARIOS) for (const seed of SEEDS) out.push(digestOf(scenarioId, seed));
console.log(JSON.stringify(out, null, 2));
