// MASS 32Q生産ゼロ異常 — allocateDomesticPurchaseを実際の記録済み入力で再実行し、
// 記録された配分結果と一致するか確認する（ブラックボックス再現テスト）。
import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { allocateDomesticPurchase, computeBuyerCompetitivenessWeight, procurementCapacity, procurementCoverageScore } from "../app/lib/v2/rawMaterials/domesticPurchase";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../app/lib/v2/rawMaterials/parameters";
import { DomesticPurchasePlanEntry } from "../app/lib/v2/rawMaterials/types";

const AT = "2026-01-01T00:00:00.000Z";
const targetTurn = Number(process.argv[2] ?? 16);

let session = createSimulationSession({
  simulationRunId: `mass-allocation-replay`,
  scenarioId: "global-demand-boom",
  seed: "seed-1",
  requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
  startedAt: AT,
});

let targetRecord = null as ReturnType<typeof advanceSimulationTurn>["session"]["state"]["history"][number] | null;
for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
  const outcome = advanceSimulationTurn(session, AT);
  if (!outcome.advanced) break;
  session = outcome.session;
  const record = session.state.history[session.state.history.length - 1];
  if (record.turn === targetTurn) {
    targetRecord = record;
    break;
  }
}

if (!targetRecord) {
  console.log("target turn not reached");
  process.exit(1);
}

const record = targetRecord;
console.log(`recorded domesticAllocation.marketPrice=${record.domesticAllocation.marketPrice} availableSupply=${record.domesticAllocation.availableSupply}`);
console.log(`marketResult.vietnamDomestic.supply (raw, shareCapReferenceSupply)=${record.marketResult.vietnamDomestic.supply}`);
console.log("recorded companies:", record.domesticAllocation.companies.map((c) => `${c.companyId}:${c.allocatedQuantity}`).join(", "));

const entries: DomesticPurchasePlanEntry[] = record.decisions.map((d) => d.domesticPurchasePlan);
console.log("\nreconstructed entries fed into allocateDomesticPurchase:");
for (const e of entries) {
  console.log(
    `  ${e.companyId}: desired=${e.desiredQuantity} priceAdj=${e.priceAdjustmentUsdPerHosoEqKg} procHC=${e.procurementHeadcount} factoryCommonCap=${e.factoryCommonProcessingCapacityTons} farmerRel=${e.farmerRelationship} paymentRel=${e.paymentReliability} approvedCap=${e.approvedPurchaseCap}`
  );
}

const replay = allocateDomesticPurchase(
  record.period,
  entries,
  record.domesticAllocation.marketPrice,
  record.domesticAllocation.availableSupply,
  RAW_MATERIALS_PARAMETERS_V1,
  record.marketResult.vietnamDomestic.supply
);
console.log("\nreplayed allocation:", replay.companies.map((c) => `${c.companyId}:${c.allocatedQuantity} (weight=${c.competitivenessWeight.toFixed(4)})`).join(", "));

console.log("\n--- manual per-company cap breakdown ---");
for (const e of entries) {
  const capacity = procurementCapacity(e.procurementHeadcount, RAW_MATERIALS_PARAMETERS_V1, e.factoryCommonProcessingCapacityTons);
  const coverage = procurementCoverageScore(e.procurementHeadcount, RAW_MATERIALS_PARAMETERS_V1);
  const weight = computeBuyerCompetitivenessWeight(
    e,
    record.domesticAllocation.marketPrice,
    record.domesticAllocation.marketPrice,
    coverage,
    RAW_MATERIALS_PARAMETERS_V1
  );
  const shareCap = Number(record.marketResult.vietnamDomestic.supply) * RAW_MATERIALS_PARAMETERS_V1.domesticPurchase.maximumBuyerShare;
  const cap = Math.min(Number(e.desiredQuantity), Number(capacity), shareCap);
  console.log(`  ${e.companyId}: capacity=${capacity} coverage=${coverage.toFixed(3)} weight=${weight.toFixed(4)} shareCap=${shareCap.toFixed(0)} cap=min(desired,capacity,shareCap)=${cap.toFixed(0)}`);
}
