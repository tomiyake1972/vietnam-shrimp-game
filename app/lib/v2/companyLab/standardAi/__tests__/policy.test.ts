// ShrimpX V2 — 標準AI（SAI-1）判断ロジック ユニットテスト
//
// 実在のフィクスチャ（fixtures.ts）・ラボ初期状態（runner.ts の
// initializeCompanyLab/buildCompanyOwnState/buildPublicMarketInfo）をそのまま
// 使い、そこから得られる CompanyFixture / CompanyOwnState / PublicMarketInfo を
// computeStandardAiDecision へ直接渡す。新しい合成フィクスチャは作らない
// （既存のラボ初期化ロジックが正しいことは runner.test.ts 側で別途検証済み）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { CompanyLabConfig, CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../../types";
import { computeStandardAiDecision } from "../policy";
import { StandardAiReasonCode } from "../types";
import { hosoEqTons, unwrapUnit, usdM, usdPerHosoEqKg } from "../../../core/units";
import { parsePeriod } from "../../../core/period";
import { usd } from "../../../finance/types";

const EPSILON = 1e-6;

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "standard-ai-unit-001", turns: 1, ...overrides };
}

/** 5社ぶんの (fixture, ownState, publicInfo) を、実在の初期化ロジックから得る。 */
function buildFiveCompanyInputs(config: CompanyLabConfig = baseConfig()) {
  const { state, fixtures } = initializeCompanyLab(config);
  const publicInfo = buildPublicMarketInfo(state);
  return fixtures.map((fixture) => ({
    fixture,
    ownState: buildCompanyOwnState(state, fixture),
    publicInfo,
  }));
}

function assertFiniteNonNegative(value: number, label: string): void {
  assert.ok(Number.isFinite(value), `${label} は有限でなければならない（受け取った値: ${value}）`);
  assert.ok(value >= -EPSILON, `${label} は負であってはならない（受け取った値: ${value}）`);
}

/** 意思決定に含まれるすべての数値フィールドが有限・非負・妥当な比率であることを検証する。 */
function assertDecisionIsValid(decision: ReturnType<typeof computeStandardAiDecision>["decision"]): void {
  for (const plan of decision.salesPlans) {
    assertFiniteNonNegative(unwrapUnit(plan.desiredQuantity), `salesPlans[${plan.market}/${plan.product}].desiredQuantity`);
    assert.ok(Number.isFinite(plan.priceAdjustmentUsdPerHosoEqKg), "priceAdjustmentUsdPerHosoEqKg は有限でなければならない");
  }
  assertFiniteNonNegative(unwrapUnit(decision.domesticPurchasePlan.desiredQuantity), "domesticPurchasePlan.desiredQuantity");
  for (const order of decision.importOrders) {
    assertFiniteNonNegative(unwrapUnit(order.orderedQuantity), `importOrders[${order.originCountry}].quantity`);
  }
  for (const plan of decision.aquacultureStockingPlans) {
    assertFiniteNonNegative(unwrapUnit(plan.plannedStockingQuantity), "aquacultureStockingPlans.stockingQuantity");
  }
  for (const plan of decision.productionPlans) {
    assertFiniteNonNegative(unwrapUnit(plan.desiredQuantity), `productionPlans[${plan.factoryId}/${plan.product}].plannedQuantity`);
    assert.ok(Number.isFinite(plan.priority), "productionPlans.priority は有限でなければならない");
  }
  for (const w of decision.workerAssignments) {
    assertFiniteNonNegative(w.regularHeadcount, `workerAssignments[${w.factoryId}].regularHeadcount`);
    assertFiniteNonNegative(w.temporaryHeadcount, `workerAssignments[${w.factoryId}].temporaryHeadcount`);
    const overtime = unwrapUnit(w.overtimeRate);
    assertFiniteNonNegative(overtime, `workerAssignments[${w.factoryId}].overtimeRate`);
    assert.ok(overtime <= 1 + EPSILON, `workerAssignments[${w.factoryId}].overtimeRate は1以下でなければならない`);
  }
  assertFiniteNonNegative(decision.financingRequest.desiredAmountUsd, "financingRequest.desiredAmountUsd");
  assertFiniteNonNegative(decision.financingRequest.desiredPrepaymentUsd, "financingRequest.desiredPrepaymentUsd");
  assert.ok(Number.isFinite(decision.financingRequest.desiredTermQuarters));
  assert.ok(decision.capexDecision !== undefined && decision.capexDecision !== null, "capexDecision は常に値を持たなければならない");
  assert.deepEqual(decision.capexDecision.newProjectProposals, []);
  assert.deepEqual(decision.capexDecision.cancelRequests, []);
  assert.deepEqual(decision.capexDecision.resumeRequests, []);
}

test("同一入力・同一設定なら常に同一の意思決定を返す（決定性）", () => {
  const inputs = buildFiveCompanyInputs();
  for (const { fixture, ownState, publicInfo } of inputs) {
    const r1 = computeStandardAiDecision(fixture, ownState, publicInfo, parsePeriod("2026Q1"), 1);
    const r2 = computeStandardAiDecision(fixture, ownState, publicInfo, parsePeriod("2026Q1"), 1);
    assert.deepEqual(r1.decision, r2.decision, `${fixture.companyId}: 同一入力での意思決定が一致しない`);
    assert.deepEqual(r1.diagnostics.reasons, r2.diagnostics.reasons, `${fixture.companyId}: 同一入力での診断理由が一致しない`);
  }
});

test("5社すべてについて、意思決定の全フィールドが存在し有効な値である", () => {
  const inputs = buildFiveCompanyInputs();
  for (const { fixture, ownState, publicInfo } of inputs) {
    const { decision } = computeStandardAiDecision(fixture, ownState, publicInfo, parsePeriod("2026Q1"), 1);
    assert.equal(decision.companyId, fixture.companyId);
    assertDecisionIsValid(decision);
  }
});

test("会社名（companyId／archetype）だけを入れ替えても判断原則は変わらない（数値が同じなら同じ意思決定になる）", () => {
  const inputs = buildFiveCompanyInputs();
  const a = inputs[0];
  const b = inputs[1];

  // bの数値データ（工場能力・在庫・契約等）はそのまま、companyId・displayName・archetypeだけをaのものへ差し替える。
  const relabeledFixture: CompanyFixture = {
    ...b.fixture,
    companyId: a.fixture.companyId,
    displayName: a.fixture.displayName,
    archetype: a.fixture.archetype,
  };
  const relabeledOwnState: CompanyOwnState = { ...b.ownState, companyId: a.fixture.companyId };

  const resultB = computeStandardAiDecision(b.fixture, b.ownState, b.publicInfo, parsePeriod("2026Q1"), 1);
  const resultRelabeled = computeStandardAiDecision(relabeledFixture, relabeledOwnState, b.publicInfo, parsePeriod("2026Q1"), 1);

  // companyId自体（意思決定内のすべての階層に埋め込まれている）は意図的に変えているので、
  // それを再帰的に取り除いた上で、それ以外の意思決定フィールドが完全一致することを確認する。
  const omitCompanyIdDeep = (decision: typeof resultB.decision): unknown =>
    JSON.parse(JSON.stringify(decision, (key, value) => (key === "companyId" ? undefined : value)));

  assert.deepEqual(
    omitCompanyIdDeep(resultB.decision),
    omitCompanyIdDeep(resultRelabeled.decision),
    "companyId/archetypeの違いだけで判断内容が変わってはならない"
  );
});

function sumDesired(decision: ReturnType<typeof computeStandardAiDecision>["decision"]): number {
  return decision.salesPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
}

test("完成品在庫が過剰とみなされる場合、販売希望を抑制する", () => {
  const { fixture, ownState, publicInfo } = buildFiveCompanyInputs()[0];
  const baseline = computeStandardAiDecision(fixture, ownState, publicInfo, parsePeriod("2026Q1"), 1);

  // ターン1のためownState.finishedGoodsLotsは空。HOSOの完成品在庫が明らかに過剰な状態
  // （能力に対して極端に大きい在庫）を、実在の型を満たす1ロットを追加することで作る。
  const excessLot: CompanyOwnState["finishedGoodsLots"][number] = {
    lotId: "TEST-EXCESS-HOSO-LOT",
    companyId: fixture.companyId,
    factoryId: fixture.factories[0].factoryId,
    product: "hoso",
    producedPeriod: parsePeriod("2025Q4"),
    originalQuantity: hosoEqTons(1_000_000),
    remainingQuantity: hosoEqTons(1_000_000),
    sourceRawMaterialLots: [],
    rawMaterialOriginCountries: [],
    rawMaterialUnitCost: usdPerHosoEqKg(2.5),
    baseProcessingCost: usdM(0),
    availableFromPeriod: parsePeriod("2025Q4"),
    status: "available",
  };
  const excessOwnState: CompanyOwnState = { ...ownState, finishedGoodsLots: [...ownState.finishedGoodsLots, excessLot] };
  const excessResult = computeStandardAiDecision(fixture, excessOwnState, publicInfo, parsePeriod("2026Q1"), 1);

  const totalSalesBaseline = sumDesired(baseline.decision);
  const totalSalesExcess = sumDesired(excessResult.decision);
  assert.ok(totalSalesExcess < totalSalesBaseline, "在庫過剰時は販売希望合計が減るはず");
  assert.ok(
    excessResult.diagnostics.reasons.some((r: { code: StandardAiReasonCode }) => r.code === "SALES_REDUCED_FINISHED_GOODS_EXCESS"),
    "在庫過剰理由（SALES_REDUCED_FINISHED_GOODS_EXCESS）が記録されるはず"
  );
});

test("原料在庫がほぼ枯渇している場合、国内買付の希望量を積み増す", () => {
  const { fixture, ownState, publicInfo } = buildFiveCompanyInputs()[0];
  const starvedOwnState: CompanyOwnState = { ...ownState, rawMaterialLots: [] };

  const normalResult = computeStandardAiDecision(fixture, ownState, publicInfo, parsePeriod("2026Q1"), 1);
  const starvedResult = computeStandardAiDecision(fixture, starvedOwnState, publicInfo, parsePeriod("2026Q1"), 1);

  assert.ok(
    unwrapUnit(starvedResult.decision.domesticPurchasePlan.desiredQuantity) >= unwrapUnit(normalResult.decision.domesticPurchasePlan.desiredQuantity) - EPSILON,
    "原料在庫が枯渇している方が、国内買付希望量は同じか多くなるはず"
  );
  assert.ok(
    starvedResult.diagnostics.reasons.some((r: { code: StandardAiReasonCode }) => r.code === "PROCUREMENT_INCREASED_RAW_MATERIAL_SHORTAGE"),
    "原料不足理由（PROCUREMENT_INCREASED_RAW_MATERIAL_SHORTAGE）が記録されるはず"
  );
});

test("現金が最低水準を大きく下回る場合、必要最小限の借入を行い、調達量を抑制する", () => {
  const { fixture, ownState, publicInfo } = buildFiveCompanyInputs()[0];

  const poorOwnState: CompanyOwnState = {
    ...ownState,
    financeState: { ...ownState.financeState, cash: usd(-1_000_000_000) },
  };

  const normalResult = computeStandardAiDecision(fixture, ownState, publicInfo, parsePeriod("2026Q1"), 1);
  const poorResult = computeStandardAiDecision(fixture, poorOwnState, publicInfo, parsePeriod("2026Q1"), 1);

  assertFiniteNonNegative(poorResult.decision.financingRequest.desiredAmountUsd, "financingRequest.desiredAmountUsd");
  assert.ok(
    poorResult.decision.financingRequest.desiredAmountUsd > normalResult.decision.financingRequest.desiredAmountUsd - EPSILON,
    "現金不足時は借入希望が増えるはず"
  );
  assert.ok(
    poorResult.diagnostics.reasons.some((r: { code: StandardAiReasonCode }) => r.code === "FINANCING_MINIMUM_BORROW_CASH_SHORTAGE"),
    "現金不足理由（FINANCING_MINIMUM_BORROW_CASH_SHORTAGE）が記録されるはず"
  );
  assert.ok(
    unwrapUnit(poorResult.decision.domesticPurchasePlan.desiredQuantity) <= unwrapUnit(normalResult.decision.domesticPurchasePlan.desiredQuantity) + EPSILON,
    "現金不足時は調達量が同じか減るはず"
  );
});

test("設備投資意思決定は常に有効な値（空の投資無し）を返す", () => {
  const inputs = buildFiveCompanyInputs();
  for (const { fixture, ownState, publicInfo } of inputs) {
    const { decision, diagnostics } = computeStandardAiDecision(fixture, ownState, publicInfo, parsePeriod("2026Q1"), 1);
    assert.deepEqual(decision.capexDecision, { companyId: fixture.companyId, newProjectProposals: [], cancelRequests: [], resumeRequests: [] });
    assert.ok(diagnostics.reasons.some((r) => r.code === "CAPEX_DEFERRED_STANDARD_POLICY"));
  }
});

test("標準AIへの公開情報は、前四半期までの結果のみで当期の結果を含まない", () => {
  // 型シグネチャ上そもそも受け取れないことがこのテストの本質だが、実行時にも
  // publicInfoが「前四半期の公開結果」だけであることを確認する（当期の結果は含まれない）。
  const { state } = initializeCompanyLab(baseConfig({ turns: 1 }));
  const publicInfo: PublicMarketInfo = buildPublicMarketInfo(state);
  // turn1（初回）では前期結果が存在しないため undefined であるべき。
  assert.equal(publicInfo.lastMarketResult, undefined);
});
