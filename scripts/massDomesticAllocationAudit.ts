// MASS 32Q生産ゼロ異常 — 国内原料調達の配分（オークション）詳細監査
import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";

const AT = "2026-01-01T00:00:00.000Z";
const scenarioId = process.argv[2] ?? "global-demand-boom";
const seed = process.argv[3] ?? "seed-1";

let session = createSimulationSession({
  simulationRunId: `mass-domestic-audit-${scenarioId}-${seed}`,
  scenarioId,
  seed,
  requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
  startedAt: AT,
});

console.log(`=== ${scenarioId} / ${seed} — domestic allocation, all companies ===`);

for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
  const outcome = advanceSimulationTurn(session, AT);
  if (!outcome.advanced) {
    console.log(`Turn ${session.state.scenarioState.currentTurn}: FAILED — ${outcome.error}`);
    break;
  }
  session = outcome.session;
  const record = session.state.history[session.state.history.length - 1];
  if (record.turn < 13 || record.turn > 21) continue; // 分岐区間だけ詳細表示

  console.log(`\n--- Turn ${record.turn} ---`);
  console.log(`  marketPrice=${record.domesticAllocation.marketPrice} availableSupply=${record.domesticAllocation.availableSupply} unallocated=${record.domesticAllocation.unallocatedSupply}`);
  for (const entry of record.domesticAllocation.companies) {
    const decision = record.decisions.find((d) => d.companyId === entry.companyId);
    console.log(
      `  ${entry.companyId}: bid=${Number(entry.bidPrice).toFixed(3)} coverage=${entry.coverageScore.toFixed(3)} weight=${entry.competitivenessWeight.toFixed(4)} ` +
        `allocated=${Number(entry.allocatedQuantity).toFixed(0)} | desired=${decision?.domesticPurchasePlan.desiredQuantity ?? "?"} priceAdj=${decision?.domesticPurchasePlan.priceAdjustmentUsdPerHosoEqKg ?? "?"} procHC=${decision?.domesticPurchasePlan.procurementHeadcount ?? "?"} ` +
        `factoryCommonCap=${decision?.domesticPurchasePlan.factoryCommonProcessingCapacityTons ?? "?"} approvedCap=${decision?.domesticPurchasePlan.approvedPurchaseCap ?? "?"}`
    );
  }
  const massImports = record.decisions.find((d) => d.companyId === "MASS")?.importOrders ?? [];
  console.log(`  MASS importOrders: ${massImports.map((o) => `${o.originCountry}:${o.orderedQuantity}`).join(", ") || "(none)"}`);
  const massAquaculture = record.decisions.find((d) => d.companyId === "MASS")?.aquacultureStockingPlans ?? [];
  console.log(`  MASS aquaculture: ${massAquaculture.map((p) => `${p.plannedStockingQuantity}(cap${p.aquacultureCapacity})`).join(", ") || "(none)"}`);
}
