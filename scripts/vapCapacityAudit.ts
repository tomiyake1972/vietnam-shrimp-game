// ShrimpX V2 — 初期VAP能力の監査（Initial VAP Capacity Recalibration Phase 1）
//
// 変更は一切行わない読み取り専用スクリプト。#04指示§1の監査項目を実測する。
//
//   npx tsx scripts/vapCapacityAudit.ts

import { buildCompanyFixtures } from "../app/lib/v2/companyLab/fixtures";
import { initializeCompanyLab, advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecision } from "../app/lib/v2/companyLab/standardAi/policy";
import { DYNAMIC_SCENARIO_1 } from "../app/lib/v2/scenario/definitions/dynamicScenario1";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { PeriodV2 } from "../app/lib/v2/core/period";
import { CompanyLabState } from "../app/lib/v2/companyLab/types";

const fmt = (n: number) => Math.round(n).toLocaleString();
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

console.log("=".repeat(78));
console.log("1. 各社の初期Factory / product別 nominal capacity（fixtures.ts）");
console.log("=".repeat(78));
console.log(
  ["company", "factory", "common", "hoso", "pd", "vap", "freeze", "coldStore", "space"].map((h) => h.padStart(10)).join("")
);
let worldCompanyVapNominal = 0;
for (const f of buildCompanyFixtures("Y1Q1" as unknown as PeriodV2)) {
  for (const fac of f.factories) {
    worldCompanyVapNominal += unwrapUnit(fac.vapCapacity);
    console.log(
      [
        f.companyId,
        fac.factoryId,
        fmt(unwrapUnit(fac.commonProcessingCapacity)),
        fmt(unwrapUnit(fac.hosoCapacity)),
        fmt(unwrapUnit(fac.pdCapacity)),
        fmt(unwrapUnit(fac.vapCapacity)),
        fmt(unwrapUnit(fac.freezingPackagingCapacity)),
        fmt(fac.coldStorageCapacity === undefined ? 0 : unwrapUnit(fac.coldStorageCapacity)),
        String(fac.totalFactorySpaceUnits ?? "-"),
      ]
        .map((c) => String(c).padStart(10))
        .join("")
    );
  }
}
console.log(`\n5社合計 nominal VAP capacity = ${fmt(worldCompanyVapNominal)} HOSO-eq t/quarter`);

console.log("\n" + "=".repeat(78));
console.log("2. Dynamic Scenario 1 を走らせ、市場が見る VAP capacity の内訳を実測");
console.log("=".repeat(78));

const { state: initialState, fixtures } = initializeCompanyLab({
  scenarioId: DYNAMIC_SCENARIO_1.scenarioId,
  mode: "canonical",
  seed: "vap-audit",
  turns: 32,
});

let state: CompanyLabState = initialState;
const TURNS = 4;
for (let turn = 1; turn <= TURNS; turn++) {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions = fixtures.map((f) =>
    generateStandardAiDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)
  );
  const decisionsById = Object.fromEntries(decisions.map((d) => [d.companyId, d]));
  state = advanceCompanyLabQuarter(state, fixtures, decisionsById);
  const record = state.history[state.history.length - 1];
  const market = record.marketResult;

  const vapPremium = market.vapPremium;
  const pdPremium = market.pdPremium;

  // 5社のVAP生産計画。supplySignal.ts により、この合計が VN の
  // vapProcessingCapacity を「置き換える」（能力ではなく計画供給量が入る）。
  const plannedVap = decisions.reduce(
    (sum, d) => sum + d.productionPlans.filter((p) => p.product === "vap").reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0),
    0
  );
  const actualVap = record.companySummaries.reduce((sum, c) => sum + unwrapUnit(c.vapProduced), 0);

  const worldVapCapacity = unwrapUnit(vapPremium.globalCapacity);
  const vapDemand = unwrapUnit(vapPremium.globalDemand);
  const otherCountries = worldVapCapacity - plannedVap;

  console.log(`\n--- Turn ${turn} ---`);
  console.log(`  world VAP capacity   = ${fmt(worldVapCapacity)}`);
  console.log(`    うち VN（5社の生産計画で置換） = ${fmt(plannedVap)}  (${pct(plannedVap / worldVapCapacity)})`);
  console.log(`    うち EC+IN+ID（シナリオ由来）  = ${fmt(otherCountries)}  (${pct(otherCountries / worldVapCapacity)})`);
  console.log(`  world VAP demand     = ${fmt(vapDemand)}`);
  console.log(`  VAP utilization      = ${pct(vapPremium.globalUtilization)}`);
  console.log(`  VAP drivers          = ${vapPremium.drivers.join(", ") || "(なし)"}`);
  console.log(`  VAP basePremium      = ${unwrapUnit(vapPremium.basePremium).toFixed(4)} USD/kg`);
  console.log(
    `  VN VAP price         = ${unwrapUnit(vapPremium.byCountry.VN.finalPrice).toFixed(3)}  premium=${unwrapUnit(vapPremium.byCountry.VN.premium).toFixed(3)}`
  );
  console.log(`  （参考）PD utilization = ${pct(pdPremium.globalUtilization)}  PD basePremium=${unwrapUnit(pdPremium.basePremium).toFixed(4)}`);
  console.log(`  5社 VAP 生産計画 = ${fmt(plannedVap)} / 実績 = ${fmt(actualVap)}`);
}

