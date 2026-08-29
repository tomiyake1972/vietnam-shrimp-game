// ShrimpX V2 — TIERED-MKT-P1D §20 品質管理設備 市場評価 直接ボーナスのテスト
//
// 【二重計上防止の設計】既存の operationalRisk 低減（capex/qualityControlEquipmentEffect.ts）
// は一切変更しない。ここで追加するのは、ramp 進捗だけを共有する別の決定論的な
// 「市場評価」加点であり、risk multiplier を再利用しない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period, nextPeriod } from "../../core/period";
import { hosoEqTons, ratio, score0to100, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { Factory } from "../../production/types";
import { CapexState, CapitalProject } from "../../capex/types";
import { QUALITY_PARAMETERS_V1 } from "../../quality/parameters";
import { buildQualityEquipmentRiskMultiplierByFactory } from "../qualityControlEquipmentState";
import {
  EQUIPMENT_QUALITY_BONUS_FULL_EFFECT_POINTS,
  applyEquipmentQualityBonusToSalesPlans,
  computeEquipmentQualityBonusByCompanyProduct,
  equipmentQualityBonusKey,
} from "../qualityEquipmentMarketBonus";
import { CompanySalesPlanEntry } from "../../sales/types";

const P1 = period(2020, 1);
const P2 = nextPeriod(P1);
const P3 = nextPeriod(P2);
const P4 = nextPeriod(P3);

function makeFactory(factoryId: string, companyId = "BAL", capacity = 1000, status: Factory["status"] = "active"): Factory {
  return {
    factoryId,
    companyId,
    status,
    commonProcessingCapacity: hosoEqTons(capacity),
    hosoCapacity: hosoEqTons(capacity),
    pdCapacity: hosoEqTons(capacity),
    vapCapacity: hosoEqTons(capacity),
    freezingPackagingCapacity: hosoEqTons(capacity),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
  };
}

function project(overrides: Partial<CapitalProject> = {}): CapitalProject {
  return {
    projectId: "PROJ-Q1",
    companyId: "BAL",
    projectType: "qualityControlEquipment",
    approvedBudgetUsd: 1_200_000,
    paymentSchedule: [
      { stageIndex: 0, plannedRatio: 0.6 },
      { stageIndex: 1, plannedRatio: 0.4 },
    ],
    completedPaymentStagesCount: 2,
    cumulativePaidUsd: 1_200_000,
    elapsedConstructionQuartersWithPayment: 2,
    requiredConstructionQuarters: 2,
    status: "completed",
    proposedPeriod: P1,
    approvedPeriod: P1,
    completedPeriod: P1,
    capitalizedAmountUsd: 1_200_000,
    targetFactoryId: "BAL-F1",
    futureCapacityEffect: { capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 },
    lastDiagnosticReasons: [],
    priority: 1,
    ...overrides,
  } as CapitalProject;
}

function capexStateWith(projects: readonly CapitalProject[]): CapexState {
  return { companies: [{ companyId: "BAL", portfolio: { companyId: "BAL", projects }, nextProjectSequence: projects.length + 1 }] };
}

const bonusOf = (m: ReadonlyMap<string, number>, product: "hoso" | "pd" | "vap", companyId = "BAL") =>
  m.get(equipmentQualityBonusKey(companyId, product)) ?? 0;

// =====================================================================

test("P1D-QE-1: 建設中（未完成）は direct bonus = 0", () => {
  const factories = [makeFactory("BAL-F1")];
  const inProgress = capexStateWith([
    project({ status: "underConstruction", completedPeriod: undefined, completedPaymentStagesCount: 1, elapsedConstructionQuartersWithPayment: 1 }),
  ]);
  const m = computeEquipmentQualityBonusByCompanyProduct(inProgress, factories, P3);
  assert.equal(m.size, 0);
});

test("P1D-QE-2: ランプ1Q目は partial（rampQuarters=2 の線形ランプ）", () => {
  assert.equal(QUALITY_PARAMETERS_V1.qualityControlEquipment.rampQuarters, 2);
  const factories = [makeFactory("BAL-F1")];
  const capex = capexStateWith([project()]);
  // 既存 ramp をそのまま使う（新しい ramp clock を作らない）。完成四半期 P1 の
  // 翌四半期 P2 が稼働開始（経過0Q＝進捗0）、P3 で 1/2、P4 でフル。
  assert.equal(bonusOf(computeEquipmentQualityBonusByCompanyProduct(capex, factories, P1), "hoso"), 0);
  assert.equal(bonusOf(computeEquipmentQualityBonusByCompanyProduct(capex, factories, P2), "hoso"), 0);
  assert.ok(Math.abs(bonusOf(computeEquipmentQualityBonusByCompanyProduct(capex, factories, P3), "hoso") - 2) < 1e-12);
  assert.ok(Math.abs(bonusOf(computeEquipmentQualityBonusByCompanyProduct(capex, factories, P4), "hoso") - 4) < 1e-12);
});

test("P1D-QE-3: full ramp で company×product 最大 +4", () => {
  const factories = [makeFactory("BAL-F1")];
  const m = computeEquipmentQualityBonusByCompanyProduct(capexStateWith([project()]), factories, nextPeriod(P4));
  for (const p of ["hoso", "pd", "vap"] as const) {
    assert.ok(Math.abs(bonusOf(m, p) - EQUIPMENT_QUALITY_BONUS_FULL_EFFECT_POINTS) < 1e-12);
  }
});

test("P1D-QE-4: 設備なしなら bonus = 0", () => {
  const m = computeEquipmentQualityBonusByCompanyProduct(capexStateWith([]), [makeFactory("BAL-F1")], P4);
  assert.equal(m.size, 0);
});

test("P1D-QE-5: operationalRisk 低減は従来どおり維持（式も値も変えていない）", () => {
  const factories = [makeFactory("BAL-F1")];
  const capex = capexStateWith([project()]);
  const risk = buildQualityEquipmentRiskMultiplierByFactory(capex, factories, P4);
  const expected = 1 - QUALITY_PARAMETERS_V1.qualityControlEquipment.fullEffectRiskReductionRatio;
  assert.ok(Math.abs(risk.get("BAL-F1")! - expected) < 1e-12, `risk multiplier ${risk.get("BAL-F1")} != ${expected}`);
  // direct bonus は risk multiplier を再利用していない（別の値・別の単位）。
  const bonus = bonusOf(computeEquipmentQualityBonusByCompanyProduct(capex, factories, P4), "hoso");
  assert.equal(bonus, 4);
  assert.notEqual(bonus, risk.get("BAL-F1"));
});

test("P1D-QE-6: 複数 Factory・複数設備でも +4 を超えない", () => {
  const factories = [makeFactory("BAL-F1"), makeFactory("BAL-F2"), makeFactory("BAL-F3")];
  const capex = capexStateWith([
    project({ projectId: "PROJ-Q1", targetFactoryId: "BAL-F1" }),
    project({ projectId: "PROJ-Q2", targetFactoryId: "BAL-F2" }),
    project({ projectId: "PROJ-Q3", targetFactoryId: "BAL-F3" }),
  ]);
  const m = computeEquipmentQualityBonusByCompanyProduct(capex, factories, P4);
  for (const p of ["hoso", "pd", "vap"] as const) {
    assert.ok(bonusOf(m, p) <= EQUIPMENT_QUALITY_BONUS_FULL_EFFECT_POINTS + 1e-12);
    assert.ok(Math.abs(bonusOf(m, p) - 4) < 1e-12, "全能力カバーなのに +4 に達していない");
  }
});

test("P1D-QE-7: capacity coverage 比に比例する（25 / 50 / 75 / 100%）", () => {
  for (const [covered, total, expected] of [
    [250, 1000, 1],
    [500, 1000, 2],
    [750, 1000, 3],
    [1000, 1000, 4],
  ] as const) {
    const factories = [makeFactory("BAL-F1", "BAL", covered), makeFactory("BAL-F2", "BAL", total - covered)];
    const capex = capexStateWith([project({ targetFactoryId: "BAL-F1" })]);
    const m = computeEquipmentQualityBonusByCompanyProduct(capex, factories, P4);
    assert.ok(Math.abs(bonusOf(m, "vap") - expected) < 1e-12, `coverage ${covered}/${total}: ${bonusOf(m, "vap")} != ${expected}`);
  }
});

test("P1D-QE-8: resume（JSON往復）前後で完全一致", () => {
  const factories = [makeFactory("BAL-F1", "BAL", 600), makeFactory("BAL-F2", "BAL", 400)];
  const capex = capexStateWith([project({ targetFactoryId: "BAL-F1" })]);
  const before = computeEquipmentQualityBonusByCompanyProduct(capex, factories, P3);
  const after = computeEquipmentQualityBonusByCompanyProduct(
    JSON.parse(JSON.stringify(capex)) as CapexState,
    JSON.parse(JSON.stringify(factories)) as Factory[],
    P3
  );
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
});

test("P1D-QE-9: 休止・売却予定 Factory は分母にも分子にも入らない", () => {
  // BAL-F2 が MOTHBALLED（status=idle）なら、実効能力を持つのは BAL-F1 だけ。
  const factories = [makeFactory("BAL-F1", "BAL", 500), makeFactory("BAL-F2", "BAL", 500, "idle")];
  const capex = capexStateWith([project({ targetFactoryId: "BAL-F1" })]);
  assert.ok(Math.abs(bonusOf(computeEquipmentQualityBonusByCompanyProduct(capex, factories, P4), "pd") - 4) < 1e-12);
  // 逆に、設備が休止工場側にある場合は稼働工場のカバレッジ 0 ＝ bonus 0。
  const capex2 = capexStateWith([project({ targetFactoryId: "BAL-F2" })]);
  assert.equal(bonusOf(computeEquipmentQualityBonusByCompanyProduct(capex2, factories, P4), "pd"), 0);
});

test("P1D-QE-10: 加算後も qualityReputation が 0〜100 を超えない・未設定は埋めない", () => {
  const plans: CompanySalesPlanEntry[] = [
    {
      companyId: "BAL",
      market: "CN",
      product: "vap",
      desiredQuantity: hosoEqTons(100),
      priceAdjustmentUsdPerHosoEqKg: 0,
      salesForceHeadcount: 5,
      qualityReputation: score0to100(99),
    },
    {
      companyId: "BAL",
      market: "CN",
      product: "pd",
      desiredQuantity: hosoEqTons(100),
      priceAdjustmentUsdPerHosoEqKg: 0,
      salesForceHeadcount: 5,
      // qualityReputation 未設定 → ボーナスを乗せない（50 で埋めない）。
    },
    {
      companyId: "MASS",
      market: "CN",
      product: "vap",
      desiredQuantity: hosoEqTons(100),
      priceAdjustmentUsdPerHosoEqKg: 0,
      salesForceHeadcount: 5,
      qualityReputation: score0to100(60),
    },
  ];
  const bonus = new Map<string, number>([
    [equipmentQualityBonusKey("BAL", "vap"), 4],
    [equipmentQualityBonusKey("BAL", "pd"), 4],
  ]);
  const out = applyEquipmentQualityBonusToSalesPlans(plans, bonus);
  assert.equal(unwrapUnit(out[0].qualityReputation!), 100); // 99 + 4 → clamp 100
  assert.equal(out[1].qualityReputation, undefined);
  assert.equal(unwrapUnit(out[2].qualityReputation!), 60); // 対象外の会社は不変
  // 空 map は完全な no-op。
  assert.deepEqual(applyEquipmentQualityBonusToSalesPlans(plans, new Map()), [...plans]);
  void usdPerHosoEqKg;
});
