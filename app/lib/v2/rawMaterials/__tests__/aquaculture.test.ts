import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateExpectedProduction, calculateSurvivalRatio, createGrowingLots, harvestAquacultureLots } from "../aquaculture";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../parameters";
import { AquacultureStockingPlanEntry, RawMaterialsValidationError } from "../types";
import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { period } from "../../core/period";

const P1 = period(2015, 1);
const P2 = period(2015, 2);

function entry(companyId: string, overrides: Partial<AquacultureStockingPlanEntry> = {}): AquacultureStockingPlanEntry {
  return {
    companyId,
    aquacultureCapacity: hosoEqTons(1000),
    plannedStockingQuantity: hosoEqTons(500),
    aquacultureIntensity: ratio(0.5),
    bioSecurityLevel: ratio(0.5),
    stockingPeriod: P1,
    ...overrides,
  };
}

test("池入れ予定生産量が養殖能力を超えるとRawMaterialsValidationErrorを投げる", () => {
  const e = entry("A", { aquacultureCapacity: hosoEqTons(100), plannedStockingQuantity: hosoEqTons(200) });
  assert.throws(() => createGrowingLots([e], RAW_MATERIALS_PARAMETERS_V1), RawMaterialsValidationError);
});

test("養殖強度が高いほど予定生産量（疾病影響前）が増える", () => {
  const low = calculateExpectedProduction(entry("A", { aquacultureIntensity: ratio(0.1) }), RAW_MATERIALS_PARAMETERS_V1);
  const high = calculateExpectedProduction(entry("A", { aquacultureIntensity: ratio(0.9) }), RAW_MATERIALS_PARAMETERS_V1);
  assert.ok(unwrapUnit(high) > unwrapUnit(low));
});

test("標準では池入れの翌四半期に収穫する", () => {
  const lots = createGrowingLots([entry("A", { stockingPeriod: P1 })], RAW_MATERIALS_PARAMETERS_V1);
  assert.equal(lots[0].availableFromPeriod, P2);
  assert.equal(lots[0].status, "growingAquaculture");
});

test("疾病圧力があると生残率が下がる", () => {
  const e = entry("A");
  const noDisease = calculateSurvivalRatio(e, ratio(0), RAW_MATERIALS_PARAMETERS_V1);
  const withDisease = calculateSurvivalRatio(e, ratio(0.5), RAW_MATERIALS_PARAMETERS_V1);
  assert.ok(unwrapUnit(withDisease) < unwrapUnit(noDisease));
});

test("疾病時には高い養殖強度の方が損失（生残率の低下）が大きい", () => {
  const low = entry("A", { aquacultureIntensity: ratio(0.1), bioSecurityLevel: ratio(0.3) });
  const high = entry("B", { aquacultureIntensity: ratio(0.9), bioSecurityLevel: ratio(0.3) });
  const diseasePressure = ratio(0.6);
  const survivalLow = calculateSurvivalRatio(low, diseasePressure, RAW_MATERIALS_PARAMETERS_V1);
  const survivalHigh = calculateSurvivalRatio(high, diseasePressure, RAW_MATERIALS_PARAMETERS_V1);
  assert.ok(unwrapUnit(survivalHigh) < unwrapUnit(survivalLow), "高強度養殖の方が疾病時の生残率が低い（損失が大きい）はず");
});

test("バイオセキュリティ水準が高いほど疾病損失が緩和される", () => {
  const lowBio = entry("A", { bioSecurityLevel: ratio(0.1) });
  const highBio = entry("B", { bioSecurityLevel: ratio(0.9) });
  const diseasePressure = ratio(0.6);
  const survivalLowBio = calculateSurvivalRatio(lowBio, diseasePressure, RAW_MATERIALS_PARAMETERS_V1);
  const survivalHighBio = calculateSurvivalRatio(highBio, diseasePressure, RAW_MATERIALS_PARAMETERS_V1);
  assert.ok(unwrapUnit(survivalHighBio) > unwrapUnit(survivalLowBio));
});

test("収穫時期未到達のロットはharvestAquacultureLotsで変化しない", () => {
  const lots = createGrowingLots([entry("A", { stockingPeriod: P1 })], RAW_MATERIALS_PARAMETERS_V1);
  const { lots: updated, harvestResults } = harvestAquacultureLots(lots, P1, ratio(0), RAW_MATERIALS_PARAMETERS_V1);
  assert.equal(updated[0].status, "growingAquaculture");
  assert.equal(harvestResults.length, 0);
});

test("収穫時期到達後はstatus=availableへ遷移し、疾病影響を反映した実際の収穫量になる", () => {
  const e = entry("A", { stockingPeriod: P1, plannedStockingQuantity: hosoEqTons(1000), aquacultureIntensity: ratio(0), bioSecurityLevel: ratio(0) });
  const lots = createGrowingLots([e], RAW_MATERIALS_PARAMETERS_V1);
  const diseasePressure = ratio(0.5);
  const { lots: updated, harvestResults } = harvestAquacultureLots(lots, P2, diseasePressure, RAW_MATERIALS_PARAMETERS_V1);

  assert.equal(updated[0].status, "available");
  assert.equal(harvestResults.length, 1);
  const h = harvestResults[0];
  assert.equal(unwrapUnit(h.diseasePressure), 0.5);
  assert.ok(unwrapUnit(h.actualHarvestQuantity) < unwrapUnit(h.expectedProduction));
  assert.ok(Math.abs(unwrapUnit(updated[0].remainingQuantity) - unwrapUnit(h.actualHarvestQuantity)) < 1e-6);
  assert.ok(Math.abs(unwrapUnit(updated[0].originalQuantity) - unwrapUnit(h.actualHarvestQuantity)) < 1e-6);
});

test("疾病圧力0なら実際の収穫量は疾病影響前の予定生産量と一致する", () => {
  const e = entry("A", { stockingPeriod: P1 });
  const lots = createGrowingLots([e], RAW_MATERIALS_PARAMETERS_V1);
  const { harvestResults } = harvestAquacultureLots(lots, P2, ratio(0), RAW_MATERIALS_PARAMETERS_V1);
  assert.ok(Math.abs(unwrapUnit(harvestResults[0].actualHarvestQuantity) - unwrapUnit(harvestResults[0].expectedProduction)) < 1e-6);
});

test("収穫量・取得原価は原料ロットとして保持され、会計処理（PL等）フィールドは一切含まれない", () => {
  const e = entry("A");
  const lots = createGrowingLots([e], RAW_MATERIALS_PARAMETERS_V1);
  const { lots: updated } = harvestAquacultureLots(lots, P2, ratio(0), RAW_MATERIALS_PARAMETERS_V1);
  const serialized = JSON.stringify(updated);
  for (const forbidden of ["revenue", "profit", "cogs", "expense"]) {
    assert.ok(!serialized.toLowerCase().includes(forbidden));
  }
});
