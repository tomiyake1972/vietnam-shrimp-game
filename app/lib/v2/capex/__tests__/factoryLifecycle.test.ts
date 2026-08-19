// ShrimpX V2 — ENG-FAC-1 単体テスト
//
// Factory lifecycle（Mothball / Reactivate / Sale）の
//   - state導出とtiming（T / T+1 / T+2）
//   - validation（最低1工場ルールを含む）
//   - 工場スロット占有・解放
//   - 工場別PPE射影のreconciliation invariant
// を、エンジン全体を回さずに固定する。
//
// 会社固有の分岐が無いことを構造的に確認するため、テストの会社IDは
// 実在の5社（MASS/JPQ/VAP/CONSV/BAL）ではなく架空のIDを使う。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { hosoEqTons, ratio } from "../../core/units";
import { Factory } from "../../production/types";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import { CAPEX_PARAMETERS_V1 } from "../parameters";
import { CapitalProject } from "../types";
import {
  FACTORY_LIFECYCLE_PARAMETERS_V1,
  FactoryLifecycleDecisionRecord,
  FactoryLifecycleValidationError,
  applyFactoryLifecycleDecisions,
  isFactorySaleCompletedIn,
  occupiesFactorySlot,
  resolveFactoryLifecycleStateAt,
} from "../factoryLifecycle";
import { applyFactoryLifecycleToFactories, computeFactorySlotRelease, countProspectiveFactories } from "../factoryConstruction";
import { computeFactoryAssetProjection } from "../factoryAssetProjection";
import { computeFactoryLifecycleAccounting } from "../factoryDisposal";

const COMPANY = "TESTCO";
const Q1 = period(2015, 1);
const Q2 = period(2015, 2);
const Q3 = period(2015, 3);
const Q4 = period(2015, 4);
const Y2Q1 = period(2016, 1);

function factory(factoryId: string, capacityScale = 1): Factory {
  return {
    factoryId,
    companyId: COMPANY,
    status: "active",
    commonProcessingCapacity: hosoEqTons(10_000 * capacityScale),
    hosoCapacity: hosoEqTons(4_000 * capacityScale),
    pdCapacity: hosoEqTons(3_000 * capacityScale),
    vapCapacity: hosoEqTons(2_000 * capacityScale),
    freezingPackagingCapacity: hosoEqTons(9_000 * capacityScale),
    baseUtilizationRate: ratio(0.8),
    equipmentAvailabilityRate: ratio(0.95),
  };
}

function decisionsOf(...records: readonly FactoryLifecycleDecisionRecord[]): readonly FactoryLifecycleDecisionRecord[] {
  return records;
}

// ---------------------------------------------------------------------
// state導出とtiming
// ---------------------------------------------------------------------

test("FAC-LC-1: Mothballは決定四半期Tでは効かず、T+1からMOTHBALLEDになる", () => {
  const d = decisionsOf({ factoryId: "F2", type: "MOTHBALL_FACTORY", decidedPeriod: Q2 });
  assert.equal(resolveFactoryLifecycleStateAt(d, "F2", Q1), "OPERATING");
  assert.equal(resolveFactoryLifecycleStateAt(d, "F2", Q2), "OPERATING", "決定した四半期そのものは通常操業のまま");
  assert.equal(resolveFactoryLifecycleStateAt(d, "F2", Q3), "MOTHBALLED");
  assert.equal(resolveFactoryLifecycleStateAt(d, "F2", Q4), "MOTHBALLED", "解除するまで継続する");
});

test("FAC-LC-2: Reactivationも決定四半期Tでは効かず、T+1からOPERATINGへ戻る", () => {
  const d = decisionsOf(
    { factoryId: "F2", type: "MOTHBALL_FACTORY", decidedPeriod: Q1 },
    { factoryId: "F2", type: "REACTIVATE_FACTORY", decidedPeriod: Q3 }
  );
  assert.equal(resolveFactoryLifecycleStateAt(d, "F2", Q2), "MOTHBALLED");
  assert.equal(resolveFactoryLifecycleStateAt(d, "F2", Q3), "MOTHBALLED", "再稼働を決定した四半期はまだ休止中");
  assert.equal(resolveFactoryLifecycleStateAt(d, "F2", Q4), "OPERATING");
});

test("FAC-LC-3: SaleはT=通常操業 / T+1=SALE_PENDING / T+2以降=SOLD（即時Cash化しない）", () => {
  const d = decisionsOf({ factoryId: "F2", type: "SELL_FACTORY", decidedPeriod: Q2 });
  assert.equal(resolveFactoryLifecycleStateAt(d, "F2", Q2), "OPERATING");
  assert.equal(resolveFactoryLifecycleStateAt(d, "F2", Q3), "SALE_PENDING");
  assert.equal(resolveFactoryLifecycleStateAt(d, "F2", Q4), "SOLD");
  assert.equal(resolveFactoryLifecycleStateAt(d, "F2", Y2Q1), "SOLD", "SOLDは終端状態");
  // 売却完了として認識されるのは T+2 の一度だけ（二重計上しない）。
  assert.equal(isFactorySaleCompletedIn(d, "F2", Q3), false);
  assert.equal(isFactorySaleCompletedIn(d, "F2", Q4), true);
  assert.equal(isFactorySaleCompletedIn(d, "F2", Y2Q1), false);
});

test("FAC-LC-4: MOTHBALLEDはidle、SALE_PENDINGはsuspendedへ写像され、SOLDはFactory[]から消える", () => {
  const factories = [factory("F1"), factory("F2"), factory("F3")];
  const decisions = decisionsOf(
    { factoryId: "F2", type: "MOTHBALL_FACTORY", decidedPeriod: Q1 },
    { factoryId: "F3", type: "SELL_FACTORY", decidedPeriod: Q1 }
  );
  const table = { companies: [{ companyId: COMPANY, decisions }] };

  const atQ2 = applyFactoryLifecycleToFactories(factories, table, Q2);
  assert.deepEqual(
    atQ2.map((f) => `${f.factoryId}:${f.status}`),
    ["F1:active", "F2:idle", "F3:suspended"]
  );

  const atQ3 = applyFactoryLifecycleToFactories(factories, table, Q3);
  assert.deepEqual(
    atQ3.map((f) => `${f.factoryId}:${f.status}`),
    ["F1:active", "F2:idle"],
    "売却完了した工場は保有していないためFactory[]から消える"
  );
});

// ---------------------------------------------------------------------
// §20 必須テスト 1〜4: 最低1工場ルール（Factory #1固定保護にしない）
// ---------------------------------------------------------------------

test("ENG-FAC-1: 1工場企業のSaleは拒否される（保有工場が0になるため）", () => {
  assert.throws(
    () =>
      applyFactoryLifecycleDecisions({ companyId: COMPANY, decisions: [] }, [{ type: "SELL_FACTORY", factoryId: "F1" }], {
        ownedFactoryIds: ["F1"],
        period: Q1,
      }),
    (e: unknown) => e instanceof FactoryLifecycleValidationError && /最低1工場/.test((e as Error).message)
  );
});

test("ENG-FAC-2: 1工場企業でもMothballは成功する（能力0にはできるが工場資産は失わない）", () => {
  const next = applyFactoryLifecycleDecisions({ companyId: COMPANY, decisions: [] }, [{ type: "MOTHBALL_FACTORY", factoryId: "F1" }], {
    ownedFactoryIds: ["F1"],
    period: Q1,
  });
  assert.equal(next.decisions.length, 1);
  assert.equal(resolveFactoryLifecycleStateAt(next.decisions, "F1", Q2), "MOTHBALLED");
});

test("ENG-FAC-3: 2工場企業はFactory #1を売却できる（第1工場を特別扱いしない）", () => {
  const next = applyFactoryLifecycleDecisions({ companyId: COMPANY, decisions: [] }, [{ type: "SELL_FACTORY", factoryId: "F1" }], {
    ownedFactoryIds: ["F1", "F2"],
    period: Q1,
  });
  assert.equal(resolveFactoryLifecycleStateAt(next.decisions, "F1", Q3), "SOLD");
  assert.equal(resolveFactoryLifecycleStateAt(next.decisions, "F2", Q3), "OPERATING", "古いF1を売って新しいF2を残せる");
});

test("ENG-FAC-4: 2工場企業はFactory #2を売却できる。ただし残り1工場になった後の追加売却は拒否される", () => {
  const afterFirst = applyFactoryLifecycleDecisions({ companyId: COMPANY, decisions: [] }, [{ type: "SELL_FACTORY", factoryId: "F2" }], {
    ownedFactoryIds: ["F1", "F2"],
    period: Q1,
  });
  assert.equal(resolveFactoryLifecycleStateAt(afterFirst.decisions, "F2", Q3), "SOLD");

  assert.throws(
    () =>
      applyFactoryLifecycleDecisions(afterFirst, [{ type: "SELL_FACTORY", factoryId: "F1" }], {
        ownedFactoryIds: ["F1", "F2"],
        period: Q3,
      }),
    FactoryLifecycleValidationError,
    "F2売却後にF1も売ると保有0になるため拒否されるはず"
  );
});

test("FAC-LC-5: 同一四半期に2工場を同時売却しようとすると、2件目が最低1工場ルールで拒否される", () => {
  assert.throws(
    () =>
      applyFactoryLifecycleDecisions(
        { companyId: COMPANY, decisions: [] },
        [
          { type: "SELL_FACTORY", factoryId: "F1" },
          { type: "SELL_FACTORY", factoryId: "F2" },
        ],
        { ownedFactoryIds: ["F1", "F2"], period: Q1 }
      ),
    FactoryLifecycleValidationError
  );
});

test("FAC-LC-6: validationは状態不整合・未完了案件・存在しない工場を拒否する", () => {
  const base = { companyId: COMPANY, decisions: [] as readonly FactoryLifecycleDecisionRecord[] };
  const ctx = { ownedFactoryIds: ["F1", "F2"], period: Q1 };

  assert.throws(() => applyFactoryLifecycleDecisions(base, [{ type: "MOTHBALL_FACTORY", factoryId: "F9" }], ctx), FactoryLifecycleValidationError);
  assert.throws(
    () => applyFactoryLifecycleDecisions(base, [{ type: "REACTIVATE_FACTORY", factoryId: "F2" }], ctx),
    FactoryLifecycleValidationError,
    "稼働中の工場は再稼働できない"
  );
  const mothballed = applyFactoryLifecycleDecisions(base, [{ type: "MOTHBALL_FACTORY", factoryId: "F2" }], ctx);
  assert.throws(
    () => applyFactoryLifecycleDecisions(mothballed, [{ type: "MOTHBALL_FACTORY", factoryId: "F2" }], { ...ctx, period: Q2 }),
    FactoryLifecycleValidationError,
    "既に休止中の工場はもう一度休止できない"
  );
  assert.throws(
    () =>
      applyFactoryLifecycleDecisions(base, [{ type: "SELL_FACTORY", factoryId: "F2" }], { ...ctx, activeProjectFactoryIds: ["F2"] }),
    FactoryLifecycleValidationError,
    "未完了の設備投資案件がある工場は売却できない"
  );
});

// ---------------------------------------------------------------------
// §20 必須テスト 24・25: 工場スロット
// ---------------------------------------------------------------------

test("ENG-FAC-24: SALE_PENDING中は工場スロットを占有し続ける", () => {
  const d = decisionsOf({ factoryId: "F2", type: "SELL_FACTORY", decidedPeriod: Q1 });
  assert.equal(occupiesFactorySlot(resolveFactoryLifecycleStateAt(d, "F2", Q2)), true, "SALE_PENDINGは占有");
  const release = computeFactorySlotRelease([factory("F1"), factory("F2")], d, Q2);
  assert.equal(release.soldBaselineFactoryCount, 0);
  assert.equal(countProspectiveFactories(2, [], release), 2, "SALE_PENDING中は工場数が減らない");
});

test("ENG-FAC-25: 売却完了(SOLD)後は工場スロットが解放される", () => {
  const d = decisionsOf({ factoryId: "F2", type: "SELL_FACTORY", decidedPeriod: Q1 });
  assert.equal(occupiesFactorySlot(resolveFactoryLifecycleStateAt(d, "F2", Q3)), false);
  const release = computeFactorySlotRelease([factory("F1"), factory("F2")], d, Q3);
  assert.equal(release.soldBaselineFactoryCount, 1);
  assert.equal(countProspectiveFactories(2, [], release), 1, "3工場保有→1売却→2工場、と同じ理屈で枠が空く");
});

// ---------------------------------------------------------------------
// §20 必須テスト 19・20 の土台: 工場別PPE射影のreconciliation invariant
// ---------------------------------------------------------------------

const COMPANY_GROSS = 90_000_000;

test("FAC-PPE-1: 初期工場のNBVは不変なbaseline capacity比で按分され、合計は会社BSと一致する", () => {
  const baselineFactories = [factory("F1", 1), factory("F2", 3)]; // design capacity比 1:3
  const projection = computeFactoryAssetProjection({
    baselineFactories,
    projects: [],
    lifecycleDecisions: [],
    period: Q1,
    companyFixedAssetsGrossUsd: COMPANY_GROSS,
    companyAccumulatedDepreciationUsd: 0,
    financeParams: FINANCE_PARAMETERS_V1,
    capexParams: CAPEX_PARAMETERS_V1,
  });
  assert.equal(projection.get("F1")!.grossPpeUsd, COMPANY_GROSS * 0.25);
  assert.equal(projection.get("F2")!.grossPpeUsd, COMPANY_GROSS * 0.75);
  const total = [...projection.values()].reduce((s, v) => s + v.grossPpeUsd, 0);
  assert.equal(total, COMPANY_GROSS, "工場別Gross PPEの合計は会社BSと厳密に一致する");
});

test("FAC-PPE-2: MothballでeffectiveCapacityが0になってもNBVは一切変動しない（按分キーがbaselineだから）", () => {
  const baselineFactories = [factory("F1", 1), factory("F2", 3)];
  const common = {
    baselineFactories,
    projects: [] as readonly CapitalProject[],
    period: Q3,
    companyFixedAssetsGrossUsd: COMPANY_GROSS,
    companyAccumulatedDepreciationUsd: 5_000_000,
    financeParams: FINANCE_PARAMETERS_V1,
    capexParams: CAPEX_PARAMETERS_V1,
  };
  const withoutMothball = computeFactoryAssetProjection({ ...common, lifecycleDecisions: [] });
  const withMothball = computeFactoryAssetProjection({
    ...common,
    lifecycleDecisions: decisionsOf({ factoryId: "F2", type: "MOTHBALL_FACTORY", decidedPeriod: Q1 }),
  });
  assert.equal(withMothball.get("F2")!.netBookValueUsd, withoutMothball.get("F2")!.netBookValueUsd);
  assert.equal(withMothball.get("F1")!.netBookValueUsd, withoutMothball.get("F1")!.netBookValueUsd);
});

test("ENG-FAC-19: 初期工場の売却後、残存工場へ簿価を付け替えない（legacy PPE projection invariant）", () => {
  const baselineFactories = [factory("F1", 1), factory("F2", 1)];
  const beforeSale = computeFactoryAssetProjection({
    baselineFactories,
    projects: [],
    lifecycleDecisions: [],
    period: Q2,
    companyFixedAssetsGrossUsd: COMPANY_GROSS,
    companyAccumulatedDepreciationUsd: 0,
    financeParams: FINANCE_PARAMETERS_V1,
    capexParams: CAPEX_PARAMETERS_V1,
  });
  const f1Before = beforeSale.get("F1")!;
  const f2Before = beforeSale.get("F2")!;
  assert.equal(f1Before.grossPpeUsd, COMPANY_GROSS / 2);

  // F2を売却完了させ、会社BSからその取得原価ぶんを除却した後の世界。
  const decisions = decisionsOf({ factoryId: "F2", type: "SELL_FACTORY", decidedPeriod: Q1 });
  const afterSale = computeFactoryAssetProjection({
    baselineFactories,
    projects: [],
    lifecycleDecisions: decisions,
    period: Q3, // F2はSOLD
    companyFixedAssetsGrossUsd: COMPANY_GROSS - f2Before.grossPpeUsd,
    companyAccumulatedDepreciationUsd: 0,
    financeParams: FINANCE_PARAMETERS_V1,
    capexParams: CAPEX_PARAMETERS_V1,
  });
  assert.equal(afterSale.get("F2")!.grossPpeUsd, 0, "売却済み工場に簿価は残らない");
  assert.equal(
    afterSale.get("F1")!.grossPpeUsd,
    f1Before.grossPpeUsd,
    "残存工場F1の簿価は売却の前後で厳密に不変（売却工場の簿価を付け替えていない）"
  );
});

test("ENG-FAC-20: CAPEX建設された工場のNBVは capitalizedAmountUsd と CAPEX減価償却から再構成される", () => {
  const capitalized = 22_000_000;
  const newFactoryProject: CapitalProject = {
    projectId: `${COMPANY}-CAPEX-1`,
    companyId: COMPANY,
    projectType: "newFactoryConstruction",
    approvedBudgetUsd: capitalized,
    paymentSchedule: [],
    completedPaymentStagesCount: 3,
    cumulativePaidUsd: capitalized,
    elapsedConstructionQuartersWithPayment: 3,
    requiredConstructionQuarters: 3,
    status: "completed",
    proposedPeriod: Q1,
    approvedPeriod: Q1,
    completedPeriod: Q1,
    capitalizedAmountUsd: capitalized,
    priority: 1,
    lastDiagnosticReasons: [],
  };
  const newFactoryId = `${COMPANY}-NEWF-${newFactoryProject.projectId}`;

  const projection = computeFactoryAssetProjection({
    baselineFactories: [factory("F1")],
    projects: [newFactoryProject],
    lifecycleDecisions: [],
    period: Q2,
    companyFixedAssetsGrossUsd: COMPANY_GROSS + capitalized,
    companyAccumulatedDepreciationUsd: 0,
    financeParams: FINANCE_PARAMETERS_V1,
    capexParams: CAPEX_PARAMETERS_V1,
  });

  assert.equal(projection.get(newFactoryId)!.grossPpeUsd, capitalized, "新設工場のGross PPEは capitalizedAmountUsd そのもの");
  assert.equal(projection.get("F1")!.grossPpeUsd, COMPANY_GROSS, "初期工場側はcapex分を含まない（legacy PPEだけ）");
  const total = [...projection.values()].reduce((s, v) => s + v.grossPpeUsd, 0);
  assert.equal(total, COMPANY_GROSS + capitalized, "合計は会社BSと一致する");
  assert.ok(
    projection.get(newFactoryId)!.netBookValueUsd <= capitalized,
    "稼働開始後は減価償却されるためNBVは取得原価以下"
  );
});

// ---------------------------------------------------------------------
// パラメータと売却価格
// ---------------------------------------------------------------------

test("FAC-LC-7: 売却代金は NBV × 70%、売却損は NBV × 30%（いずれもparameter化されている）", () => {
  const baselineFactories = [factory("F1"), factory("F2")];
  const decisions = decisionsOf({ factoryId: "F2", type: "SELL_FACTORY", decidedPeriod: Q1 });
  const result = computeFactoryLifecycleAccounting({
    companyId: COMPANY,
    period: Q3, // T+2 ＝ 売却完了
    decisions,
    baselineFactories,
    projects: [],
    companyFixedAssetsGrossUsd: COMPANY_GROSS,
    companyAccumulatedDepreciationUsd: 0,
    normalCashFixedFactoryCostUsdPerQuarter: 1_450_000,
    financeParams: FINANCE_PARAMETERS_V1,
    capexParams: CAPEX_PARAMETERS_V1,
  });

  const nbv = result.adjustment.disposalGrossPpeRemovedUsd - result.adjustment.disposalAccumulatedDepreciationRemovedUsd;
  assert.ok(nbv > 0);
  assert.equal(result.adjustment.disposalProceedsUsd, nbv * FACTORY_LIFECYCLE_PARAMETERS_V1.saleProceedsRecoveryRate);
  assert.equal(result.adjustment.disposalGainLossUsd, result.adjustment.disposalProceedsUsd - nbv);
  assert.ok(result.adjustment.disposalGainLossUsd < 0, "回収率70%のため通常は売却損になる");
  assert.deepEqual(
    result.events.map((e) => e.code).filter((c) => c.startsWith("FACTORY_SALE") || c.startsWith("FACTORY_DISPOSAL")),
    ["FACTORY_SALE_COMPLETED", "FACTORY_DISPOSAL_LOSS"]
  );
});

test("FAC-LC-8: carrying cost 25% / holding cost 10% / reactivation cost はすべてparameterから算出される", () => {
  const normalCost = 1_450_000;
  const baselineFactories = [factory("F1"), factory("F2"), factory("F3")];
  const decisions = decisionsOf(
    { factoryId: "F2", type: "MOTHBALL_FACTORY", decidedPeriod: Q1 },
    { factoryId: "F3", type: "SELL_FACTORY", decidedPeriod: Q1 }
  );
  const atQ2 = computeFactoryLifecycleAccounting({
    companyId: COMPANY,
    period: Q2,
    decisions,
    baselineFactories,
    projects: [],
    companyFixedAssetsGrossUsd: COMPANY_GROSS,
    companyAccumulatedDepreciationUsd: 0,
    normalCashFixedFactoryCostUsdPerQuarter: normalCost,
    financeParams: FINANCE_PARAMETERS_V1,
    capexParams: CAPEX_PARAMETERS_V1,
  });
  assert.equal(atQ2.adjustment.mothballCarryingCostUsd, normalCost * FACTORY_LIFECYCLE_PARAMETERS_V1.mothballCarryingCostRatio);
  assert.equal(atQ2.adjustment.salePendingHoldingCostUsd, normalCost * FACTORY_LIFECYCLE_PARAMETERS_V1.salePendingHoldingCostRatio);
  assert.equal(atQ2.adjustment.reactivationCostUsd, 0);

  const withReactivation = computeFactoryLifecycleAccounting({
    companyId: COMPANY,
    period: Q3,
    decisions: decisionsOf(...decisions, { factoryId: "F2", type: "REACTIVATE_FACTORY", decidedPeriod: Q3 }),
    baselineFactories,
    projects: [],
    companyFixedAssetsGrossUsd: COMPANY_GROSS,
    companyAccumulatedDepreciationUsd: 0,
    normalCashFixedFactoryCostUsdPerQuarter: normalCost,
    financeParams: FINANCE_PARAMETERS_V1,
    capexParams: CAPEX_PARAMETERS_V1,
  });
  assert.equal(
    withReactivation.adjustment.reactivationCostUsd,
    FACTORY_LIFECYCLE_PARAMETERS_V1.reactivationCostUsd,
    "再稼働コストは決定した四半期に1工場ぶん計上される"
  );
});
