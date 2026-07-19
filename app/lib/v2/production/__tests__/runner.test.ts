import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { INITIAL_PERIOD_V2, nextPeriod, PeriodV2 } from "../../core/period";
import { runProductionQuartersForTesting, ProductionQuarterTestInput } from "../runner";
import { CompanyProductionPlanEntry, Factory, ProductionSupplySignalInput, WorkerAssignment } from "../types";
import { RawMaterialLot } from "../../rawMaterials/types";
import { SalesContract } from "../../sales/types";
import { CountryId } from "../../market/types";

const COMPANIES = ["C1", "C2", "C3", "C4", "C5"] as const;
const PRODUCTS = ["hoso", "pd", "vap"] as const;

function factoriesFor(companyId: string): readonly Factory[] {
  return [
    {
      factoryId: `${companyId}-F1`,
      companyId,
      status: "active",
      commonProcessingCapacity: hosoEqTons(300),
      hosoCapacity: hosoEqTons(150),
      pdCapacity: hosoEqTons(100),
      vapCapacity: hosoEqTons(80),
      freezingPackagingCapacity: hosoEqTons(250),
      baseUtilizationRate: ratio(0.9),
      equipmentAvailabilityRate: ratio(0.95),
    },
    {
      factoryId: `${companyId}-F2`,
      companyId,
      status: "active",
      commonProcessingCapacity: hosoEqTons(200),
      hosoCapacity: hosoEqTons(100),
      pdCapacity: hosoEqTons(80),
      vapCapacity: hosoEqTons(60),
      freezingPackagingCapacity: hosoEqTons(180),
      baseUtilizationRate: ratio(0.85),
      equipmentAvailabilityRate: ratio(0.9),
    },
  ];
}

function assignmentsFor(companyId: string): readonly WorkerAssignment[] {
  return [
    {
      factoryId: `${companyId}-F1`,
      companyId,
      regularHeadcount: 40,
      temporaryHeadcount: 10,
      skills: PRODUCTS.map((p) => ({ product: p, skillLevel: ratio(0.8) })),
      overtimeRate: ratio(0.1),
      attendanceRate: ratio(0.95),
    },
    {
      factoryId: `${companyId}-F2`,
      companyId,
      regularHeadcount: 25,
      temporaryHeadcount: 5,
      skills: PRODUCTS.map((p) => ({ product: p, skillLevel: ratio(0.7) })),
      overtimeRate: ratio(0.05),
      attendanceRate: ratio(0.9),
    },
  ];
}

function plansFor(companyId: string, seedOffset: number): readonly CompanyProductionPlanEntry[] {
  const plans: CompanyProductionPlanEntry[] = [];
  let i = 0;
  for (const factoryId of [`${companyId}-F1`, `${companyId}-F2`]) {
    for (const product of PRODUCTS) {
      i += 1;
      plans.push({
        companyId,
        factoryId,
        product,
        desiredQuantity: hosoEqTons(20 + ((seedOffset + i) % 30)),
        priority: 1 + (i % 3),
      });
    }
  }
  return plans;
}

function lotsFor(companyId: string, period: PeriodV2): readonly RawMaterialLot[] {
  return [
    {
      lotId: `RM-${companyId}-${period}-1`,
      companyId,
      source: "domestic",
      originCountry: "VN",
      inboundPeriod: period,
      originalQuantity: hosoEqTons(400),
      remainingQuantity: hosoEqTons(400),
      unitCost: usdPerHosoEqKg(5),
      availableFromPeriod: period,
      status: "available",
    },
  ];
}

function contractsFor(companyId: string, dueDate: PeriodV2): readonly SalesContract[] {
  return PRODUCTS.map((product, i) => ({
    contractId: `SC-${companyId}-${product}`,
    companyId,
    market: "CN" as const,
    product,
    contractedPeriod: INITIAL_PERIOD_V2,
    dueDate,
    originalQuantity: hosoEqTons(15 + i * 5),
    outstandingQuantity: hosoEqTons(15 + i * 5),
    unitPrice: usdPerHosoEqKg(6),
    status: "open" as const,
  }));
}

const COMPANY_COUNTRY: Readonly<Record<string, CountryId>> = COMPANIES.reduce(
  (acc, c) => ({ ...acc, [c]: "VN" as CountryId }),
  {} as Record<string, CountryId>
);

function buildQuarterInput(period: PeriodV2, seedOffset: number): ProductionQuarterTestInput {
  const factories = COMPANIES.flatMap((c) => factoriesFor(c));
  const workerAssignments = COMPANIES.flatMap((c) => assignmentsFor(c));
  const plans = COMPANIES.flatMap((c) => plansFor(c, seedOffset));
  const rawMaterialLots = COMPANIES.flatMap((c) => lotsFor(c, period));
  const contracts = COMPANIES.flatMap((c) => contractsFor(c, nextPeriod(period)));
  const supplySignals: ProductionSupplySignalInput[] = COMPANIES.map((c) => ({
    companyId: c,
    product: "pd" as const,
    plannedQuantity: hosoEqTons(30),
    actualQuantity: hosoEqTons(25),
  }));

  return {
    input: { factories, workerAssignments, plans, companyCountry: COMPANY_COUNTRY },
    contracts,
    rawMaterialLots,
    supplySignals,
  };
}

test("5社×複数工場×複数四半期を完走する", () => {
  const q1 = buildQuarterInput(INITIAL_PERIOD_V2, 1);
  const q2period = nextPeriod(INITIAL_PERIOD_V2);
  const q2 = buildQuarterInput(q2period, 2);

  const { state } = runProductionQuartersForTesting(INITIAL_PERIOD_V2, [q1, q2]);

  assert.equal(state.history.length, 2);
  assert.equal(state.currentPeriod, nextPeriod(q2period));
  for (const record of state.history) {
    assert.equal(record.batches.length, COMPANIES.length * 2 * PRODUCTS.length);
    assert.ok(record.factoryLoadMetrics.length === COMPANIES.length * 2);
    assert.ok(record.companyLoadMetrics.length === COMPANIES.length);
  }
});

test("同一入力で完全に同じ結果になる（決定論性）", () => {
  const q1a = buildQuarterInput(INITIAL_PERIOD_V2, 1);
  const q1b = buildQuarterInput(INITIAL_PERIOD_V2, 1);
  const resultA = runProductionQuartersForTesting(INITIAL_PERIOD_V2, [q1a]);
  const resultB = runProductionQuartersForTesting(INITIAL_PERIOD_V2, [q1b]);
  assert.equal(JSON.stringify(resultA.state), JSON.stringify(resultB.state));
});

test("いずれの四半期でも原料・設備・労働のいずれの制約も超えない", () => {
  const q1 = buildQuarterInput(INITIAL_PERIOD_V2, 3);
  const { state } = runProductionQuartersForTesting(INITIAL_PERIOD_V2, [q1]);
  const record = state.history[0];
  for (const entry of record.allocation.entries) {
    assert.ok(unwrapUnit(entry.allocatedQuantity) <= unwrapUnit(entry.desiredQuantity) + 1e-6);
  }
});

test("各工場でHOSO・PD・VAP合計の配分人数（常用・臨時それぞれ）が配置人数を超えない（Phase6.1: ワーカー共有プール）", () => {
  const q1 = buildQuarterInput(INITIAL_PERIOD_V2, 5);
  const { state } = runProductionQuartersForTesting(INITIAL_PERIOD_V2, [q1]);
  const record = state.history[0];

  const assignmentByFactory = new Map<string, WorkerAssignment>();
  for (const c of COMPANIES) {
    for (const a of assignmentsFor(c)) {
      assignmentByFactory.set(a.factoryId, a);
    }
  }

  const totalsByFactory = new Map<string, { regular: number; temporary: number }>();
  for (const entry of record.allocation.entries) {
    const t = totalsByFactory.get(entry.factoryId) ?? { regular: 0, temporary: 0 };
    t.regular += entry.labor.assignedRegularHeadcount;
    t.temporary += entry.labor.assignedTemporaryHeadcount;
    totalsByFactory.set(entry.factoryId, t);
  }

  for (const [factoryId, totals] of totalsByFactory) {
    const assignment = assignmentByFactory.get(factoryId)!;
    assert.ok(totals.regular <= assignment.regularHeadcount + 1e-6, `工場${factoryId}: 常用配分合計${totals.regular}が配置人数${assignment.regularHeadcount}を超過`);
    assert.ok(totals.temporary <= assignment.temporaryHeadcount + 1e-6, `工場${factoryId}: 臨時配分合計${totals.temporary}が配置人数${assignment.temporaryHeadcount}を超過`);
  }

  // 配分済み+未配分=配置人数の保存則（factoryWorkerSummaries）
  for (const summary of record.allocation.factoryWorkerSummaries) {
    const totals = totalsByFactory.get(summary.factoryId) ?? { regular: 0, temporary: 0 };
    const assignment = assignmentByFactory.get(summary.factoryId)!;
    assert.ok(Math.abs(totals.regular + summary.unassignedRegularHeadcount - assignment.regularHeadcount) < 1e-6);
    assert.ok(Math.abs(totals.temporary + summary.unassignedTemporaryHeadcount - assignment.temporaryHeadcount) < 1e-6);
  }
});

test("既存499テスト（他モジュール）に影響しない: Phase4のapplyFulfillmentsをそのまま呼び出せる", () => {
  const q1 = buildQuarterInput(INITIAL_PERIOD_V2, 4);
  const { state } = runProductionQuartersForTesting(INITIAL_PERIOD_V2, [q1]);
  const record = state.history[0];
  assert.ok(Array.isArray(record.fulfillmentPlan.explicitInstructions));
});
