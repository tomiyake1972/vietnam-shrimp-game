// ShrimpX V2 — External Origin VAP capability の監査（External VAP Capacity Recalibration）
//
// 会社シミュレーションを回さず、シナリオエンジンの出力だけを見る読み取り専用スクリプト。
// 「産地ごとのVAP加工産業の厚み」を設計するために、現状が何を出しているかを実測する。
//
//   npx tsx scripts/externalVapCapacityAudit.ts

import { initializeScenario, getScenarioTurnInput } from "../app/lib/v2/scenario/scenarioEngine";
import { DYNAMIC_SCENARIO_1 } from "../app/lib/v2/scenario/definitions/dynamicScenario1";
import { SCENARIO_ENGINE_PARAMETERS_V1 } from "../app/lib/v2/scenario/parameters";
import { CountryId } from "../app/lib/v2/market/types";
import { unwrapUnit } from "../app/lib/v2/core/units";

const fmt = (n: number) => Math.round(n).toLocaleString();
const COUNTRIES: readonly CountryId[] = ["VN", "EC", "IN", "ID"];
const TURNS = [1, 4, 8, 12, 16, 20, 24, 28, 32];

const state = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "external-vap-audit");

console.log("既定のVAP能力導出: 国別 production × defaultVapCapacityRatioOfProduction");
console.log(`  defaultVapCapacityRatioOfProduction = ${SCENARIO_ENGINE_PARAMETERS_V1.defaultVapCapacityRatioOfProduction}`);
console.log(`  defaultPdCapacityRatioOfProduction  = ${SCENARIO_ENGINE_PARAMETERS_V1.defaultPdCapacityRatioOfProduction}`);
console.log(
  `  DS1 が宣言している VAP_PROCESSING_CAPACITY trend: ` +
    (DYNAMIC_SCENARIO_1.longTermTrends.filter((t) => t.variable === "VAP_PROCESSING_CAPACITY").length || "なし（＝全産地が既定比率）")
);
console.log("");

console.log("--- 国別 production（HOSO換算 t/四半期） ---");
console.log("turn".padStart(6) + COUNTRIES.map((c) => c.padStart(12)).join(""));
for (const turn of TURNS) {
  const input = getScenarioTurnInput(state, turn);
  const row = COUNTRIES.map((c) => fmt(unwrapUnit(input.countries[c].production)).padStart(12)).join("");
  console.log(String(turn).padStart(6) + row);
}

console.log("\n--- 国別 VAP processing capacity（現状＝production × 0.1） ---");
console.log("turn".padStart(6) + COUNTRIES.map((c) => c.padStart(12)).join("") + "world".padStart(12) + "VAP需要".padStart(12) + "稼働率".padStart(9));
for (const turn of TURNS) {
  const input = getScenarioTurnInput(state, turn);
  const caps = COUNTRIES.map((c) => unwrapUnit(input.countries[c].vapProcessingCapacity));
  const world = caps.reduce((a, b) => a + b, 0);
  const demand = unwrapUnit(input.pdVapDemand.vapDemand);
  console.log(
    String(turn).padStart(6) +
      caps.map((v) => fmt(v).padStart(12)).join("") +
      fmt(world).padStart(12) +
      fmt(demand).padStart(12) +
      `${((demand / world) * 100).toFixed(1)}%`.padStart(9)
  );
}

console.log("\n--- 参考: 国別 PD processing capacity（現状＝production × 0.35） ---");
console.log("turn".padStart(6) + COUNTRIES.map((c) => c.padStart(12)).join("") + "world".padStart(12) + "PD需要".padStart(12) + "稼働率".padStart(9));
for (const turn of TURNS) {
  const input = getScenarioTurnInput(state, turn);
  const caps = COUNTRIES.map((c) => unwrapUnit(input.countries[c].pdProcessingCapacity));
  const world = caps.reduce((a, b) => a + b, 0);
  const demand = unwrapUnit(input.pdVapDemand.pdDemand);
  console.log(
    String(turn).padStart(6) +
      caps.map((v) => fmt(v).padStart(12)).join("") +
      fmt(world).padStart(12) +
      fmt(demand).padStart(12) +
      `${((demand / world) * 100).toFixed(1)}%`.padStart(9)
  );
}

console.log("\n【注】VN の vapProcessingCapacity は、会社シミュレーション実行時に");
console.log("      production/supplySignal.ts が「5社の当期VAP生産計画の合計」で置き換えるため、");
console.log("      上表の VN 値は実際の市場計算には使われない（＝VNは既に企業側が決めている）。");
