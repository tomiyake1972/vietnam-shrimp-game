// ShrimpX V2 — Vision 既定値の校正用実測（Phase 5 §4）
//
// 「Q32で70,000t/四半期」といった Vision 既定案を置く前に、現行の初期状態・能力・
// 市場需要が実際にどの水準かを測る。数字を推測で置かないための計測スクリプト。

import { advanceSimulationTurns, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { buildDatasetFromSession } from "../app/lib/v2/companyLab/simulation/analytics/dataset";

const AT = "2026-01-01T00:00:00.000Z";

let session = createSimulationSession({
  simulationRunId: "vision-calibration",
  scenarioId: "baseline",
  seed: "management-console-32q",
  requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
  startedAt: AT,
});
session = advanceSimulationTurns({ session, turns: MANAGEMENT_CONSOLE_STANDARD_TURNS, timestamp: AT });

const world = session.packWorldTurns;
const companies = session.packCompanyTurns;

const sum = (xs: readonly (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

console.log("=== TRUE WORLD: ベトナム5社が獲得対象にできた需要（HOSO換算トン/四半期） ===");
for (const t of world) {
  if (t.turn !== 1 && t.turn !== 8 && t.turn !== 16 && t.turn !== 24 && t.turn !== 32) continue;
  const demand = sum(t.trueWorld.marketProducts.map((m) => m.trueDemandTons));
  const contracted = sum(t.trueWorld.marketProducts.map((m) => m.contractedTons));
  const external = sum(t.trueWorld.marketProducts.map((m) => m.externalOptionTons));
  console.log(
    `Q${String(t.turn).padStart(2)}  需要 ${demand.toFixed(0).padStart(7)}  5社成約 ${contracted.toFixed(0).padStart(7)}  他産地等 ${external.toFixed(0).padStart(7)}  1社平均成約 ${(contracted / 5).toFixed(0)}`
  );
}

const dataset = buildDatasetFromSession(session);
const metric = (turn: number, companyId: string, key: string) =>
  dataset.companyMetrics.find((f) => f.turn === turn && f.companyId === companyId && f.metric === key)?.value ?? null;

console.log("");
console.log("=== 会社別: 生産能力・生産量・現金・負債 ===");
const companyIds = [...new Set(companies.map((c) => c.companyId))];
for (const companyId of companyIds) {
  console.log(`\n--- ${companyId} ---`);
  for (const turn of [1, 8, 16, 24, 32]) {
    const t = companies.find((c) => c.companyId === companyId && c.turn === turn);
    if (!t) continue;
    const cap = t.beginningState.capacityTonsByProduct;
    const capTotal = (cap.hoso ?? 0) + (cap.pd ?? 0) + (cap.vap ?? 0);
    const produced = sum(["hosoProduced", "pdProduced", "vapProduced"].map((k) => metric(turn, companyId, k)));
    const contracted = metric(turn, companyId, "newContractedQuantity") ?? 0;
    console.log(
      `Q${String(turn).padStart(2)}  工場${t.beginningState.factoryCount}  設備能力(3品目計) ${capTotal.toFixed(0).padStart(6)}  共通 ${(t.beginningState.commonProcessingCapacityTons ?? 0).toFixed(0).padStart(6)}  生産 ${produced.toFixed(0).padStart(6)}  成約 ${contracted.toFixed(0).padStart(6)}  現金 ${((t.endingState.cashUsd ?? 0) / 1e6).toFixed(1).padStart(6)}M  負債 ${((t.endingState.debtUsd ?? 0) / 1e6).toFixed(1)}M  営業 ${t.beginningState.salesHeadcount}  スペース残 ${t.endingState.factorySpaceRemainingUnits}`
    );
  }
}
