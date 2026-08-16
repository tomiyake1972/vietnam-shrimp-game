#!/usr/bin/env -S npx tsx
// Dynamic Scenario 1 — Phase 1 audit harness (read-only observatory).
//
// 既存の 32Q Management Console シミュレーションをそのまま走らせ、
// 「世界（scenario → market）が実際にどう動いているか」だけを取り出す。
// ゲームロジックは一切変更しない。Scenario 設計の出発点となる baseline を
// 実測するための監査用スクリプト。

import { advanceSimulationTurns, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { DEMAND_MARKET_IDS } from "../app/lib/v2/market/types";
import { computeMarketProductMix } from "../app/lib/v2/market/productLifecycle";

const AT = "2026-01-01T00:00:00.000Z";
const scenarioAlias = process.argv[2] ?? "baseline";

let session = createSimulationSession({
  simulationRunId: `ds1-audit-${scenarioAlias}`,
  scenarioId: scenarioAlias,
  seed: "ds1-world-audit",
  requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
  startedAt: AT,
});
session = advanceSimulationTurns({ session, turns: MANAGEMENT_CONSOLE_STANDARD_TURNS, timestamp: AT });

const turns = session.packWorldTurns;

console.log(`# Dynamic Scenario 1 audit — scenario=${scenarioAlias} completed=${session.run.completedTurns}/32 stop=${session.run.stopReason}`);

// ---- 1. 市場別 true demand（全商品合計） ----
console.log("\n## A. 市場別 true demand 合計 (HOSO-eq tons)");
console.log(["turn", ...DEMAND_MARKET_IDS, "WORLD"].join("\t"));
for (const t of turns) {
  const byMarket = new Map<string, number>();
  for (const mp of t.trueWorld.marketProducts) {
    byMarket.set(mp.market, (byMarket.get(mp.market) ?? 0) + (mp.trueDemandTons ?? 0));
  }
  const row = DEMAND_MARKET_IDS.map((m) => Math.round(byMarket.get(m) ?? 0));
  console.log([t.turn, ...row, row.reduce((a, b) => a + b, 0)].join("\t"));
}

// ---- 2. 市場×商品 true demand ----
console.log("\n## B. 市場×商品 true demand (HOSO-eq tons)");
const cells = DEMAND_MARKET_IDS.flatMap((m) => ["hoso", "pd", "vap"].map((p) => `${m}.${p}`));
console.log(["turn", ...cells].join("\t"));
for (const t of turns) {
  const key = (m: string, p: string) => `${m}|${p}`;
  const map = new Map<string, number>();
  for (const mp of t.trueWorld.marketProducts) map.set(key(mp.market, mp.product), mp.trueDemandTons ?? 0);
  console.log([t.turn, ...DEMAND_MARKET_IDS.flatMap((m) => ["hoso", "pd", "vap"].map((p) => Math.round(map.get(key(m, p)) ?? 0)))].join("\t"));
}

// ---- 3. Vietnam domestic raw vs origin HOSO FOB ----
console.log("\n## C. 原料: VN国内価格 / 各国HOSO FOB (USD per HOSO-eq kg) + VN供給/取引量");
const originHeader = turns[0]?.trueWorld.producerCountries.map((c) => c.country) ?? [];
console.log(["turn", "VN_domestic", "VN_ceiling", "VN_farmerReserv", ...originHeader.map((c) => `${c}_fob`), "VN_supply", "VN_transacted"].join("\t"));
for (const t of turns) {
  const d = t.trueWorld.vietnamDomesticRawMaterial;
  const fob = new Map(t.trueWorld.producerCountries.map((c) => [c.country, c.hosoFobPriceUsdPerKg]));
  console.log(
    [
      t.turn,
      d.priceUsdPerKg?.toFixed(3) ?? "-",
      d.buyingCeilingUsdPerKg?.toFixed(3) ?? "-",
      d.farmerReservationPriceUsdPerKg?.toFixed(3) ?? "-",
      ...originHeader.map((c) => fob.get(c)?.toFixed(3) ?? "-"),
      Math.round(d.supplyTons ?? 0),
      Math.round(d.transactedTons ?? 0),
    ].join("\t")
  );
}

// ---- 4. 産地供給 ----
console.log("\n## D. 産地別 production / exportableSupply (HOSO-eq tons)");
console.log(["turn", ...originHeader.flatMap((c) => [`${c}_prod`, `${c}_exp`])].join("\t"));
for (const t of turns) {
  const byC = new Map(t.trueWorld.producerCountries.map((c) => [c.country, c]));
  console.log([t.turn, ...originHeader.flatMap((c) => [Math.round(byC.get(c)?.productionTons ?? 0), Math.round(byC.get(c)?.exportableSupplyTons ?? 0)])].join("\t"));
}

// ---- 5. productLifecycle 構成比（scenario から動かせない現行の固定表） ----
console.log("\n## E. productLifecycle 構成比（PRODUCT_LIFECYCLE_PARAMETERS_V1・scenario非依存）");
console.log(["turn", ...cells].join("\t"));
for (let turn = 1; turn <= 32; turn++) {
  const mix = computeMarketProductMix(turn);
  console.log([turn, ...DEMAND_MARKET_IDS.flatMap((m) => ["hoso", "pd", "vap"].map((p) => mix[m][p as "hoso"].toFixed(4)))].join("\t"));
}

// ---- 6. scenario events ----
console.log("\n## F. 有効だった scenario events");
for (const t of turns) {
  if (t.scenarioEvents.length > 0) {
    console.log(`turn ${t.turn}: ${t.scenarioEvents.map((e) => `${e.eventId}(x${e.magnitudeScale})`).join(", ")}`);
  }
}
