#!/usr/bin/env -S npx tsx
// Dynamic Scenario 1 — Phase 1 audit: 市場需要の減衰メカニズムの特定（read-only）。
//
// baseline 32Q で JP / EU / OTHER の需要が壊滅する現象の因果を、
// consumerInventory の3層（消費 / 在庫 / 購買）の実測値で分解する。
// ゲームロジックは一切変更しない。

import { advanceSimulationTurns, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { DEMAND_MARKET_IDS, DemandMarketId } from "../app/lib/v2/market/types";
import { unwrapUnit } from "../app/lib/v2/core/units";

const AT = "2026-01-01T00:00:00.000Z";
const scenarioAlias = process.argv[2] ?? "baseline";

let session = createSimulationSession({
  simulationRunId: `ds1-decay-${scenarioAlias}`,
  scenarioId: scenarioAlias,
  seed: "ds1-world-audit",
  requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
  startedAt: AT,
});
session = advanceSimulationTurns({ session, turns: MANAGEMENT_CONSOLE_STANDARD_TURNS, timestamp: AT });

const history = session.state.history;
console.log(`# consumerInventory 分解 — scenario=${scenarioAlias} turns=${history.length}`);

for (const market of DEMAND_MARKET_IDS as readonly DemandMarketId[]) {
  console.log(`\n## ${market}`);
  console.log(["turn", "planCons", "realCons", "desiredBuy", "actualBuy", "openInv", "endInv", "covM", "tgtCovM", "phase", "consGrowth"].join("\t"));
  for (const h of history) {
    const rec = h.consumerMarketRecords?.find((r) => r.market === market);
    if (!rec) continue;
    console.log(
      [
        h.turn,
        Math.round(unwrapUnit(rec.plannedConsumptionTons)),
        Math.round(unwrapUnit(rec.realizedConsumptionTons)),
        Math.round(unwrapUnit(rec.desiredPurchaseTons)),
        Math.round(unwrapUnit(rec.actualPurchaseTons)),
        Math.round(unwrapUnit(rec.openingInventoryTons)),
        Math.round(unwrapUnit(rec.endingInventoryTons)),
        rec.inventoryCoverageMonths.toFixed(2),
        rec.targetCoverageMonths.toFixed(2),
        rec.marketPhase,
        (rec.consumptionGrowthRate * 100).toFixed(1) + "%",
      ].join("\t")
    );
  }
}

// 市場別ウェイト（= desiredPurchase 構成比）の推移。targetDemand 按分の直接の分母。
console.log("\n## 市場別 desiredPurchase シェア（deriveTargetDemand の按分ウェイト）");
console.log(["turn", ...DEMAND_MARKET_IDS].join("\t"));
for (const h of history) {
  const recs = h.consumerMarketRecords;
  if (!recs) continue;
  const total = recs.reduce((s, r) => s + unwrapUnit(r.desiredPurchaseTons), 0);
  console.log(
    [
      h.turn,
      ...DEMAND_MARKET_IDS.map((m) => {
        const r = recs.find((x) => x.market === m);
        return total > 0 && r ? ((unwrapUnit(r.desiredPurchaseTons) / total) * 100).toFixed(2) + "%" : "-";
      }),
    ].join("\t")
  );
}
