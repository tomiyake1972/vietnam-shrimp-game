// ShrimpX V2 — 初期VAP能力の Before/After ベンチマーク（#04指示§6）
//
// 同一seed・同一シナリオで Turn1〜4 を走らせ、VAP まわりの指標を出す。
// fixtures.ts の初期VAP能力を変える前後で実行し、出力を比較する。
//
//   npx tsx scripts/vapCapacityBenchmark.ts > /tmp/.../before.txt
//   （fixtures.ts を変更）
//   npx tsx scripts/vapCapacityBenchmark.ts > /tmp/.../after.txt

import { buildCompanyFixtures } from "../app/lib/v2/companyLab/fixtures";
import { initializeCompanyLab, advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecision } from "../app/lib/v2/companyLab/standardAi/policy";
import { DYNAMIC_SCENARIO_1 } from "../app/lib/v2/scenario/definitions/dynamicScenario1";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { PeriodV2 } from "../app/lib/v2/core/period";
import { CompanyLabState } from "../app/lib/v2/companyLab/types";
import { computeFactoryUsedSpaceUnits, resolveFactoryTotalSpaceUnits, computeProjectRequiredSpaceUnits } from "../app/lib/v2/production/factorySpace";

const fmt = (n: number) => Math.round(n).toLocaleString();
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const SEEDS = ["ds1-bench-a", "ds1-bench-b", "ds1-bench-c"];
const TURNS = 4;

console.log("### 初期VAP能力（fixtures.ts）");
let nominalTotal = 0;
for (const f of buildCompanyFixtures("Y1Q1" as unknown as PeriodV2)) {
  for (const fac of f.factories) {
    nominalTotal += unwrapUnit(fac.vapCapacity);
    const used = computeFactoryUsedSpaceUnits(fac);
    const total = resolveFactoryTotalSpaceUnits(fac);
    const vapLineSpace = computeProjectRequiredSpaceUnits({ projectType: "vapLineExpansion", targetPool: "vap", capacityIncreaseTons: 250 });
    console.log(
      `  ${f.companyId.padEnd(6)} vap=${String(fmt(unwrapUnit(fac.vapCapacity))).padStart(7)}` +
        `  hoso=${String(fmt(unwrapUnit(fac.hosoCapacity))).padStart(7)}` +
        `  pd=${String(fmt(unwrapUnit(fac.pdCapacity))).padStart(7)}` +
        `  common=${String(fmt(unwrapUnit(fac.commonProcessingCapacity))).padStart(7)}` +
        `  freeze=${String(fmt(unwrapUnit(fac.freezingPackagingCapacity))).padStart(7)}` +
        `  cold=${String(fmt(fac.coldStorageCapacity === undefined ? 0 : unwrapUnit(fac.coldStorageCapacity))).padStart(7)}` +
        `  space used/total=${used.toFixed(0)}/${total.toFixed(0)}` +
        `  空き=${(total - used).toFixed(0)}` +
        `  VAP+250t所要=${vapLineSpace.toFixed(0)}` +
        `  → ${total - used >= vapLineSpace ? "増設可" : "スペース不足"}`
    );
  }
}
console.log(`  5社合計 nominal VAP capacity = ${fmt(nominalTotal)}\n`);

for (const seed of SEEDS) {
  console.log(`### seed=${seed}`);
  const { state: initialState, fixtures } = initializeCompanyLab({
    scenarioId: DYNAMIC_SCENARIO_1.scenarioId,
    mode: "canonical",
    seed,
    turns: 32,
  });

  let state: CompanyLabState = initialState;
  for (let turn = 1; turn <= TURNS; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions = fixtures.map((f) =>
      generateStandardAiDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)
    );
    const plannedVap = decisions.reduce(
      (sum, d) => sum + d.productionPlans.filter((p) => p.product === "vap").reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0),
      0
    );
    const vapCapexProposals = decisions.reduce(
      (sum, d) => sum + d.capexDecision.newProjectProposals.filter((p) => p.projectType === "vapLineExpansion").length,
      0
    );
    const allCapexProposals = decisions.reduce((sum, d) => sum + d.capexDecision.newProjectProposals.length, 0);

    state = advanceCompanyLabQuarter(state, fixtures, Object.fromEntries(decisions.map((d) => [d.companyId, d])));
    const record = state.history[state.history.length - 1];
    const vap = record.marketResult.vapPremium;
    const pd = record.marketResult.pdPremium;

    const actualVap = record.companySummaries.reduce((sum, c) => sum + unwrapUnit(c.vapProduced), 0);
    const contractedAll = record.companySummaries.reduce((sum, c) => sum + unwrapUnit(c.newContractedQuantity), 0);
    const fgAll = record.companySummaries.reduce((sum, c) => sum + unwrapUnit(c.finishedGoodsInventory), 0);

    console.log(
      `  T${turn}` +
        ` demand=${String(fmt(unwrapUnit(vap.globalDemand))).padStart(7)}` +
        ` capacity=${String(fmt(unwrapUnit(vap.globalCapacity))).padStart(8)}` +
        ` (VN=${String(fmt(plannedVap)).padStart(6)})` +
        ` util=${pct(vap.globalUtilization).padStart(6)}` +
        ` basePrem=${unwrapUnit(vap.basePremium).toFixed(4)}` +
        ` vnVapPrice=${unwrapUnit(vap.byCountry.VN.finalPrice).toFixed(3)}` +
        ` prod=${String(fmt(actualVap)).padStart(6)}` +
        ` 新規成約(全商品)=${String(fmt(contractedAll)).padStart(7)}` +
        ` 製品在庫(全商品)=${String(fmt(fgAll)).padStart(7)}` +
        ` vapCapex=${vapCapexProposals}/${allCapexProposals}` +
        ` oversupply=${vap.drivers.includes("PROCESSING_CAPACITY_OVERSUPPLY") ? "YES" : "no"}` +
        ` | PDutil=${pct(pd.globalUtilization)}`
    );
  }
  console.log("");
}
