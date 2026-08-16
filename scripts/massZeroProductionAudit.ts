// MASS 32Q生産ゼロ異常 — 原因監査（Turn-by-Turn dump）
//
// 使い方: npx tsx scripts/massZeroProductionAudit.ts <scenario> <seed> [companyId=MASS]

import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";

const AT = "2026-01-01T00:00:00.000Z";
const scenarioId = process.argv[2] ?? "global-demand-boom";
const seed = process.argv[3] ?? "seed-1";
const companyId = process.argv[4] ?? "MASS";

let session = createSimulationSession({
  simulationRunId: `mass-zero-audit-${scenarioId}-${seed}`,
  scenarioId,
  seed,
  requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
  startedAt: AT,
});

console.log(`=== ${scenarioId} / ${seed} / ${companyId} ===`);
console.log(
  "turn | desiredSales | newContracted | backlog | prodReqHOSO/PD/VAP | actualHOSO/PD/VAP | rawAvail | domesticPurchDesired | commonCap | factoryCount | regularWorkers | tempWorkers | cash | debt | financingDesired | reasonCodes(last3)"
);

for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
  const outcome = advanceSimulationTurn(session, AT);
  if (!outcome.advanced) {
    console.log(`Turn ${session.state.scenarioState.currentTurn}: FAILED TO ADVANCE — ${outcome.error}`);
    break;
  }
  session = outcome.session;
  const record = session.state.history[session.state.history.length - 1];
  const decision = record.decisions.find((d) => d.companyId === companyId);
  const summary = record.companySummaries.find((s) => s.companyId === companyId);
  const financialResult = record.financialResults.find((f) => f.companyId === companyId);
  const capexFactories = session.fixtures.find((f) => f.companyId === companyId)?.factories ?? [];
  const factoryCount = summary?.finishedGoodsInventory !== undefined ? undefined : undefined;

  const prodPlans = decision?.productionPlans.filter((p) => p.companyId === companyId) ?? [];
  const prodByProduct = { hoso: 0, pd: 0, vap: 0 };
  for (const p of prodPlans) prodByProduct[p.product] += Number(p.desiredQuantity);

  const salesPlans = decision?.salesPlans ?? [];
  const desiredSalesTotal = salesPlans.reduce((s, p) => s + Number(p.desiredQuantity ?? 0), 0);

  const domesticDesired = decision?.domesticPurchasePlan.desiredQuantity ?? null;

  const globalCodes = record.globalReasonCodes.filter((c) => c.companyId === companyId);
  const lastCodes = globalCodes
    .slice(-3)
    .map((c) => c.code)
    .join(",");

  const domesticActual = record.domesticAllocation.companies.find((a) => a.companyId === companyId)?.allocatedQuantity ?? null;
  const workerAssignments = decision?.workerAssignments.filter((w) => w.companyId === companyId) ?? [];
  const regularHeadcount = workerAssignments.reduce((s, w) => s + Number(w.regularHeadcount), 0);
  const temporaryHeadcount = workerAssignments.reduce((s, w) => s + Number(w.temporaryHeadcount), 0);
  const financingResult = record.financingResults.find((f) => f.companyId === companyId);
  const pc = financingResult?.procurementConstraint;

  console.log(
    `${record.turn} | ds=${desiredSalesTotal.toFixed(0)} | nc=${summary?.newContractedQuantity ?? "?"} | bl=${summary?.outstandingQuantity ?? "?"}+${summary?.overdueQuantity ?? "?"} | ` +
      `preq=${prodByProduct.hoso.toFixed(0)}/${prodByProduct.pd.toFixed(0)}/${prodByProduct.vap.toFixed(0)} | ` +
      `act=${summary?.hosoProduced ?? "?"}/${summary?.pdProduced ?? "?"}/${summary?.vapProduced ?? "?"} | ` +
      `rawInv=${summary?.rawMaterialInventory ?? "?"} | domPurchDesired=${domesticDesired ?? "?"} domPurchActual=${domesticActual ?? "?"} | ` +
      `commonCap=${capexFactories.reduce((s, f) => s + Number(f.commonProcessingCapacity ?? 0), 0)} | factories=${capexFactories.length} | ` +
      `regW=${regularHeadcount} tempW=${temporaryHeadcount} | ` +
      `rawShort=${summary?.rawMaterialShortfall ?? "?"} eqShort=${summary?.equipmentShortfall ?? "?"} laborShort=${summary?.laborShortfall ?? "?"} | ` +
      `cash=${(financialResult ? Number(financialResult.balanceSheet.cash) / 1e6 : NaN).toFixed(1)}M | debt=${(financialResult ? (Number(financialResult.balanceSheet.shortTermLoans) + Number(financialResult.balanceSheet.longTermLoans)) / 1e6 : NaN).toFixed(1)}M | ` +
      `financing=${decision?.financingRequest.desiredAmountUsd ?? "?"} | codes=${lastCodes} | ` +
      `PC: scaleRatio=${pc?.scaleRatio.toFixed(3) ?? "?"} constrainedDomPurch=${pc?.constrainedDomesticPurchaseQuantityTons.toFixed(0) ?? "?"} availLiq=${pc?.availableLiquidityUsd.toFixed(0) ?? "?"} plannedNeed=${pc?.plannedCashNeedUsd.toFixed(0) ?? "?"} importBlocked=${pc?.importOrdersBlocked ?? "?"} | ` +
      `frozen=${financingResult?.borrowingCapacity.underwritingFrozen ?? "?"} tier=${financingResult?.creditScore.tier ?? "?"} health=${financingResult?.financialHealth ?? "?"} approved=${financingResult?.underwriting.approvedAmountUsd.toFixed(0) ?? "?"} loanDraw=${financingResult?.loanDrawUsd.toFixed(0) ?? "?"}`
  );
}
