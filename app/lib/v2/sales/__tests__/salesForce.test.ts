import { test } from "node:test";
import assert from "node:assert/strict";
import { salesCoverageScore, processingCapacity } from "../salesForce";
import { SALES_PARAMETERS_V1 } from "../parameters";
import { SalesValidationError } from "../types";
import { unwrapUnit } from "../../core/units";

test("headcount=0でも既存顧客ぶんのカバレッジ（baseline）が残る", () => {
  const coverage = salesCoverageScore(0, SALES_PARAMETERS_V1);
  assert.equal(coverage, SALES_PARAMETERS_V1.salesForce.baselineCoverageAtZeroHeadcount);
  assert.ok(coverage > 0);
});

test("headcount=0でも既存顧客ぶんの処理能力（baseline）が残る", () => {
  const capacity = unwrapUnit(processingCapacity(0, SALES_PARAMETERS_V1));
  assert.equal(capacity, SALES_PARAMETERS_V1.salesForce.baselineCapacityTons);
  assert.ok(capacity > 0);
});

test("カバレッジはheadcount増加とともに単調増加する", () => {
  const values = [0, 2, 5, 10, 20, 50].map((h) => salesCoverageScore(h, SALES_PARAMETERS_V1));
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] > values[i - 1], `coverage(${[0, 2, 5, 10, 20, 50][i]}) should exceed coverage(${[0, 2, 5, 10, 20, 50][i - 1]})`);
  }
});

test("処理能力はheadcount増加とともに単調増加する", () => {
  const values = [0, 2, 5, 10, 20, 50].map((h) => unwrapUnit(processingCapacity(h, SALES_PARAMETERS_V1)));
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] > values[i - 1]);
  }
});

test("カバレッジ・処理能力とも1を超えない／無制限に増えない（漸近的に上限へ収束する）", () => {
  const largeCoverage = salesCoverageScore(100000, SALES_PARAMETERS_V1);
  assert.ok(largeCoverage < 1);
  assert.ok(largeCoverage > 0.99);

  const largeCapacity = unwrapUnit(processingCapacity(100000, SALES_PARAMETERS_V1));
  const asymptote = SALES_PARAMETERS_V1.salesForce.baselineCapacityTons + SALES_PARAMETERS_V1.salesForce.capacityMaxIncrementTons;
  assert.ok(largeCapacity < asymptote);
  assert.ok(largeCapacity > asymptote * 0.99);
});

test("headcountの効果は逓減する（限界増分が減少していく）", () => {
  const step = 5;
  const points = [0, step, step * 2, step * 3, step * 4];
  const coverageDeltas = points.slice(1).map((h, i) => salesCoverageScore(h, SALES_PARAMETERS_V1) - salesCoverageScore(points[i], SALES_PARAMETERS_V1));
  for (let i = 1; i < coverageDeltas.length; i++) {
    assert.ok(coverageDeltas[i] < coverageDeltas[i - 1], "marginal coverage gain should shrink as headcount grows");
  }

  const capacityDeltas = points
    .slice(1)
    .map((h, i) => unwrapUnit(processingCapacity(h, SALES_PARAMETERS_V1)) - unwrapUnit(processingCapacity(points[i], SALES_PARAMETERS_V1)));
  for (let i = 1; i < capacityDeltas.length; i++) {
    assert.ok(capacityDeltas[i] < capacityDeltas[i - 1], "marginal capacity gain should shrink as headcount grows");
  }
});

test("負のheadcountや非整数はSalesValidationErrorを投げる", () => {
  assert.throws(() => salesCoverageScore(-1, SALES_PARAMETERS_V1), SalesValidationError);
  assert.throws(() => salesCoverageScore(2.5, SALES_PARAMETERS_V1), SalesValidationError);
  assert.throws(() => processingCapacity(-1, SALES_PARAMETERS_V1), SalesValidationError);
  assert.throws(() => processingCapacity(2.5, SALES_PARAMETERS_V1), SalesValidationError);
});
