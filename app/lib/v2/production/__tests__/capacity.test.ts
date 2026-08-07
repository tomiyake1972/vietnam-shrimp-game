import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { calculateFactoryEffectiveCapacity, calculateFactoryEffectiveCapacities } from "../capacity";
import { Factory } from "../types";

function makeFactory(overrides: Partial<Factory> = {}): Factory {
  return {
    factoryId: "F1",
    companyId: "C1",
    status: "active",
    commonProcessingCapacity: hosoEqTons(1000),
    hosoCapacity: hosoEqTons(600),
    pdCapacity: hosoEqTons(300),
    vapCapacity: hosoEqTons(200),
    freezingPackagingCapacity: hosoEqTons(900),
    baseUtilizationRate: ratio(0.9),
    equipmentAvailabilityRate: ratio(0.95),
    ...overrides,
  };
}

test("稼働中の工場は基準稼働率×設備利用可能率を各能力プールへ適用する", () => {
  const factory = makeFactory();
  const capacity = calculateFactoryEffectiveCapacity(factory);
  const expected = 1000 * 0.9 * 0.95;
  assert.ok(Math.abs(unwrapUnit(capacity.commonProcessing) - expected) < 0.01);
  assert.ok(unwrapUnit(capacity.hoso) < 600);
  assert.ok(unwrapUnit(capacity.pd) < 300);
  assert.ok(unwrapUnit(capacity.vap) < 200);
  assert.ok(unwrapUnit(capacity.freezingPackaging) < 900);
});

test("idle/suspendedの工場は全プールが0になる", () => {
  for (const status of ["idle", "suspended"] as const) {
    const capacity = calculateFactoryEffectiveCapacity(makeFactory({ status }));
    assert.equal(unwrapUnit(capacity.commonProcessing), 0);
    assert.equal(unwrapUnit(capacity.hoso), 0);
    assert.equal(unwrapUnit(capacity.pd), 0);
    assert.equal(unwrapUnit(capacity.vap), 0);
    assert.equal(unwrapUnit(capacity.freezingPackaging), 0);
  }
});

test("有効能力は入力を変更しない（不変性）", () => {
  const factory = makeFactory();
  const before = JSON.stringify(factory);
  calculateFactoryEffectiveCapacity(factory);
  assert.equal(JSON.stringify(factory), before);
});

test("複数工場の一括計算は個別計算と一致する", () => {
  const factories = [makeFactory({ factoryId: "F1" }), makeFactory({ factoryId: "F2", status: "idle" })];
  const results = calculateFactoryEffectiveCapacities(factories);
  assert.equal(results.length, 2);
  assert.equal(results[0].factoryId, "F1");
  assert.ok(unwrapUnit(results[0].commonProcessing) > 0);
  assert.equal(unwrapUnit(results[1].commonProcessing), 0);
});
