// ShrimpX V2 — ENG-CROWDING-MARKDOWN-1B 必須テスト DUE-1〜7
//
// X' 方式（dueDate 別に Sales Engine 内部で独立 allocation し、契約生成後に
// market × product へ再集約する）が満たすべき契約を固定する。
//
//  - T+1 の混雑が T+3 の ratio / multiplier / clearing price / allocation へ
//    一切影響しないこと（完全分離）
//  - 納期別の clearing price が SalesContract.unitPrice へ正しく snapshot されること
//  - SalesQuarterRecord.allocations は market × product につき1件だけであること
//  - 集約値が bucket 合計と一致すること
//  - 全社同一納期なら従来の1bucket結果と完全一致すること

import test from "node:test";
import assert from "node:assert/strict";

import { hosoEqTons, score0to100, unwrapUnit } from "../../core/units";
import { nextPeriod } from "../../core/period";
import { DemandMarketId, Product } from "../../market/types";
import {
  CROWDING_POLICY_VERSION_V1,
  CrowdingPolicy,
  FORWARD_DEMAND_PROXY_METHOD_V1,
  PHYSICAL_ATP_METHOD_V1,
} from "../crowding";
import type { CompanyProductPhysicalSupply } from "../credibleOffer";
import { advanceSalesQuarterWithDiagnostics, initializeSalesState } from "../runner";
import { SALES_PARAMETERS_V1 } from "../parameters";
import { CompanySalesPlanEntry, SalesQuarterInput } from "../types";
import { runIndustrySimulation } from "../../industryLab/simulationRunner";
import { INITIAL_PERIOD_V2 } from "../../core/period";

const MARKET: DemandMarketId = "CN";
const PRODUCT: Product = "vap";
const LEAD_NEAR = 1;
const LEAD_FAR = 3;

const COEF = { threshold: 0.5, lambda: 0.8, gamma: 1.0, floor: 0.7 };
const POLICY: CrowdingPolicy = {
  policyVersion: CROWDING_POLICY_VERSION_V1,
  enabled: true,
  // 感応度用の仮係数。正式採用値ではない。
  byProduct: { hoso: COEF, pd: COEF, vap: COEF },
  protectedExternalShare: { hoso: 0.2, pd: 0.2, vap: 0.2 },
  physicalAtpMethod: PHYSICAL_ATP_METHOD_V1,
  forwardDemandProxyMethod: FORWARD_DEMAND_PROXY_METHOD_V1,
};

const QUARTERS = runIndustrySimulation({
  scenarioId: "baseline-v0.1",
  mode: "canonical",
  seed: "crowding-duedate-fixture",
  turns: 2,
}).quarters;

function plan(
  companyId: string,
  desired: number,
  leadTimeTurns: number,
  priceAdjustment = 0
): CompanySalesPlanEntry {
  return {
    companyId,
    market: MARKET,
    product: PRODUCT,
    desiredQuantity: hosoEqTons(desired),
    priceAdjustmentUsdPerHosoEqKg: priceAdjustment,
    salesForceHeadcount: 20,
    qualityReputation: score0to100(70),
    customerRelationship: score0to100(60),
    deliveryReliability: score0to100(60),
    desiredLeadTimeTurns: leadTimeTurns,
  };
}

function supply(companyId: string, onHand: number): CompanyProductPhysicalSupply {
  return {
    companyId,
    product: PRODUCT,
    onHandFinishedGoods: onHand,
    conservativeCommittedSupply: 0,
    method: PHYSICAL_ATP_METHOD_V1,
    limitations: [],
  };
}

function run(plans: readonly CompanySalesPlanEntry[], supplies: readonly CompanyProductPhysicalSupply[], quarter = 0) {
  const input: SalesQuarterInput = {
    plans,
    marketResult: QUARTERS[quarter].marketResult,
    marketInput: QUARTERS[quarter].marketInput,
    crowding: { policy: POLICY, physicalSupplies: supplies },
  };
  return advanceSalesQuarterWithDiagnostics(initializeSalesState(INITIAL_PERIOD_V2), input, SALES_PARAMETERS_V1);
}

/** 標準構成: A/B が T+1、C/D/E が T+3。 */
function standardPlans(nearDesired: number, farDesired: number): CompanySalesPlanEntry[] {
  return [
    plan("A", nearDesired, LEAD_NEAR),
    plan("B", nearDesired, LEAD_NEAR),
    plan("C", farDesired, LEAD_FAR),
    plan("D", farDesired, LEAD_FAR),
    plan("E", farDesired, LEAD_FAR),
  ];
}

function standardSupplies(nearSupply: number, farSupply: number): CompanyProductPhysicalSupply[] {
  return [
    supply("A", nearSupply),
    supply("B", nearSupply),
    supply("C", farSupply),
    supply("D", farSupply),
    supply("E", farSupply),
  ];
}

function bucketOf(r: ReturnType<typeof run>, dueDate: string) {
  const b = r.crowding!.buckets.find((x) => x.market === MARKET && x.product === PRODUCT && x.dueDate === dueDate);
  assert.ok(b, `bucket が見つかりません: ${dueDate}`);
  return b!;
}

function dueDates(startPeriod: string) {
  let near = startPeriod;
  for (let i = 0; i < LEAD_NEAR; i++) near = nextPeriod(near as never) as unknown as string;
  let far = startPeriod;
  for (let i = 0; i < LEAD_FAR; i++) far = nextPeriod(far as never) as unknown as string;
  return { near, far };
}

const DUE = dueDates(INITIAL_PERIOD_V2 as unknown as string);

// ---------------------------------------------------------------------
// DUE-1 / DUE-2: 納期別の完全分離
// ---------------------------------------------------------------------

test("DUE-1: T+1 の offer だけ増やしても T+3 の ratio / multiplier / clearing price / allocation は完全不変", () => {
  const base = run(standardPlans(3_000, 3_000), standardSupplies(3_000, 3_000));
  const more = run(standardPlans(9_000, 3_000), standardSupplies(9_000, 3_000));

  const nearBase = bucketOf(base, DUE.near);
  const nearMore = bucketOf(more, DUE.near);
  const farBase = bucketOf(base, DUE.far);
  const farMore = bucketOf(more, DUE.far);

  // T+1: 混雑が増す方向に動く
  assert.ok(nearMore.totalCredibleOffers > nearBase.totalCredibleOffers, "T+1 の提示量が増えている");
  assert.ok(nearMore.crowdingRatio > nearBase.crowdingRatio, "T+1 の ratio が上昇");
  assert.ok(nearMore.crowdingMultiplier < nearBase.crowdingMultiplier, "T+1 の multiplier が低下");
  assert.ok(
    nearMore.postCrowdingClearingPrice < nearBase.postCrowdingClearingPrice,
    "T+1 の clearing price が低下"
  );

  // T+3: 完全不変（数値として厳密一致）
  assert.equal(farMore.totalCredibleOffers, farBase.totalCredibleOffers, "T+3 の提示量が不変");
  assert.equal(farMore.crowdingRatio, farBase.crowdingRatio, "T+3 の ratio が完全不変");
  assert.equal(farMore.crowdingMultiplier, farBase.crowdingMultiplier, "T+3 の multiplier が完全不変");
  assert.equal(
    farMore.postCrowdingClearingPrice,
    farBase.postCrowdingClearingPrice,
    "T+3 の clearing price が完全不変"
  );

  // T+3 の allocation（契約）も完全不変
  const farContracts = (r: ReturnType<typeof run>) =>
    r.state.history[0].newContracts
      .filter((c) => c.dueDate === DUE.far)
      .map((c) => [c.contractId, unwrapUnit(c.unitPrice), unwrapUnit(c.originalQuantity)]);
  assert.deepEqual(farContracts(more), farContracts(base), "T+3 の allocation / 契約が完全不変");
});

test("DUE-2: T+3 の offer だけ増やしても T+1 は完全不変（逆方向）", () => {
  const base = run(standardPlans(3_000, 3_000), standardSupplies(3_000, 3_000));
  const more = run(standardPlans(3_000, 9_000), standardSupplies(3_000, 9_000));

  const farBase = bucketOf(base, DUE.far);
  const farMore = bucketOf(more, DUE.far);
  const nearBase = bucketOf(base, DUE.near);
  const nearMore = bucketOf(more, DUE.near);

  assert.ok(farMore.crowdingRatio > farBase.crowdingRatio, "T+3 の ratio が上昇");
  assert.ok(farMore.crowdingMultiplier < farBase.crowdingMultiplier, "T+3 の multiplier が低下");
  assert.ok(farMore.postCrowdingClearingPrice < farBase.postCrowdingClearingPrice, "T+3 の clearing price が低下");

  assert.equal(nearMore.totalCredibleOffers, nearBase.totalCredibleOffers, "T+1 の提示量が不変");
  assert.equal(nearMore.crowdingRatio, nearBase.crowdingRatio, "T+1 の ratio が完全不変");
  assert.equal(nearMore.crowdingMultiplier, nearBase.crowdingMultiplier, "T+1 の multiplier が完全不変");
  assert.equal(
    nearMore.postCrowdingClearingPrice,
    nearBase.postCrowdingClearingPrice,
    "T+1 の clearing price が完全不変"
  );

  const nearContracts = (r: ReturnType<typeof run>) =>
    r.state.history[0].newContracts
      .filter((c) => c.dueDate === DUE.near)
      .map((c) => [c.contractId, unwrapUnit(c.unitPrice), unwrapUnit(c.originalQuantity)]);
  assert.deepEqual(nearContracts(more), nearContracts(base), "T+1 の allocation / 契約が完全不変");
});

// ---------------------------------------------------------------------
// DUE-3: 納期別 clearing price の契約 snapshot
// ---------------------------------------------------------------------

test("DUE-3: P1 != P3 のとき、各社の契約単価が自分の bucket の clearing price + 自社調整額になる", () => {
  // T+1 を強く混雑させ、T+3 を非混雑にして P1 != P3 を作る。
  // 会社ごとに異なる priceAdjustment を与え、加算が正しいことも同時に確認する。
  const plans = [
    plan("A", 9_000, LEAD_NEAR, +0.10),
    plan("B", 9_000, LEAD_NEAR, -0.05),
    plan("C", 1_000, LEAD_FAR, +0.20),
    plan("D", 1_000, LEAD_FAR, 0),
    plan("E", 1_000, LEAD_FAR, -0.15),
  ];
  const supplies = [
    supply("A", 9_000),
    supply("B", 9_000),
    supply("C", 1_000),
    supply("D", 1_000),
    supply("E", 1_000),
  ];
  const r = run(plans, supplies);

  const p1 = bucketOf(r, DUE.near).postCrowdingClearingPrice;
  const p3 = bucketOf(r, DUE.far).postCrowdingClearingPrice;
  assert.ok(p1 < p3, `T+1 が混雑しているので P1 < P3 であること: ${p1} < ${p3}`);

  const adjustments = new Map(plans.map((pl) => [pl.companyId, pl.priceAdjustmentUsdPerHosoEqKg]));
  let checkedNear = 0;
  let checkedFar = 0;
  for (const c of r.state.history[0].newContracts) {
    if (c.market !== MARKET || c.product !== PRODUCT) continue;
    const adj = adjustments.get(c.companyId)!;
    const expected = (c.dueDate === DUE.near ? p1 : p3) + adj;
    assert.ok(
      Math.abs(unwrapUnit(c.unitPrice) - expected) < 1e-9,
      `${c.companyId}(${c.dueDate}): 実測 ${unwrapUnit(c.unitPrice)} 期待 ${expected}`
    );
    if (c.dueDate === DUE.near) checkedNear++;
    else checkedFar++;
  }
  assert.ok(checkedNear > 0 && checkedFar > 0, "両 bucket の契約が検証されていること");
});

// ---------------------------------------------------------------------
// DUE-4: 既存契約の不変性
// ---------------------------------------------------------------------

test("DUE-4: 後続 Turn でどちらかの bucket が混雑しても既存契約の unitPrice は不変", () => {
  const first = run(standardPlans(3_000, 3_000), standardSupplies(3_000, 3_000));
  const snapshot = first.state.contracts.map((c) => [c.contractId, unwrapUnit(c.unitPrice)] as const);
  const frozen = JSON.parse(JSON.stringify(first.state.contracts));
  assert.ok(snapshot.length > 0, "1Turn 目で契約が生成されていること");

  // 2Turn 目: 同じ納期へさらに混雑させる
  const second = advanceSalesQuarterWithDiagnostics(
    first.state,
    {
      plans: standardPlans(9_000, 9_000),
      marketResult: QUARTERS[1].marketResult,
      marketInput: QUARTERS[1].marketInput,
      crowding: { policy: POLICY, physicalSupplies: standardSupplies(9_000, 9_000) },
    },
    SALES_PARAMETERS_V1
  );

  const after = new Map(second.state.contracts.map((c) => [c.contractId, unwrapUnit(c.unitPrice)]));
  for (const [id, price] of snapshot) {
    assert.equal(after.get(id), price, `既存契約 ${id} が再価格設定された`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(first.state.contracts)), frozen, "既存契約オブジェクトが変更されていない");
});

// ---------------------------------------------------------------------
// DUE-5 / DUE-6: 再集約
// ---------------------------------------------------------------------

test("DUE-5: bucket が複数でも SalesQuarterRecord.allocations は market × product につき1件のみ", () => {
  const r = run(standardPlans(3_000, 3_000), standardSupplies(3_000, 3_000));
  assert.equal(r.crowding!.buckets.filter((b) => b.market === MARKET && b.product === PRODUCT).length, 2, "bucket は2つ");

  const allocations = r.state.history[0].allocations;
  const seen = new Set<string>();
  for (const a of allocations) {
    const key = `${a.market}::${a.product}`;
    assert.ok(!seen.has(key), `market × product が重複している: ${key}`);
    seen.add(key);
  }
  const target = allocations.filter((a) => a.market === MARKET && a.product === PRODUCT);
  assert.equal(target.length, 1, "対象 market × product の allocation は1件");
  // 1社は1 bucket にしか現れないので、会社も重複しない（§4 の不変条件）。
  const ids = target[0].companies.map((c) => c.companyId);
  assert.equal(new Set(ids).size, ids.length, "会社が重複していない");
  assert.deepEqual([...ids].sort(), ["A", "B", "C", "D", "E"], "全社が1回ずつ現れる");
});

test("DUE-6: 集約値（targetDemand / externalOptionQuantity / allocatedQuantity / offered）が bucket 合計と一致", () => {
  const r = run(standardPlans(3_000, 3_000), standardSupplies(3_000, 3_000));
  const agg = r.state.history[0].allocations.find((a) => a.market === MARKET && a.product === PRODUCT)!;
  const buckets = r.crowding!.buckets.filter((b) => b.market === MARKET && b.product === PRODUCT);
  assert.equal(buckets.length, 2);

  // targetDemand は各 bucket の forwardDemandProxy の合計
  const expectedDemand = buckets.reduce((s, b) => s + b.forwardDemandProxy, 0);
  assert.ok(
    Math.abs(unwrapUnit(agg.targetDemand) - expectedDemand) < 1e-6,
    `targetDemand 実測 ${unwrapUnit(agg.targetDemand)} 期待 ${expectedDemand}`
  );

  // 需要保存: Σ各社成約 + external = targetDemand（各 bucket で成立するので合計でも成立）。
  // 数量は roundHosoEqTons（小数2桁 = 0.01t 刻み）で丸められるため、
  // 許容差は丸め粒度から導く（既存 tieredAllocation.ts:33 も「丸め誤差を除く」と明記）。
  // 1 bucket あたり 会社数 + 外部選択肢 の項が丸められるので、
  //   tolerance = 0.01 × (会社数 + 1) × bucket 数
  const allocated = agg.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);
  const external = unwrapUnit(agg.externalOptionQuantity);
  const tolerance = 0.01 * (agg.companies.length + 1) * buckets.length;
  const residual = Math.abs(allocated + external - unwrapUnit(agg.targetDemand));
  assert.ok(
    residual <= tolerance,
    `需要保存が丸め誤差を超えて崩れた: allocated=${allocated} + external=${external} ` +
      `!= demand=${unwrapUnit(agg.targetDemand)} (residual=${residual} > tolerance=${tolerance})`
  );

  // offered（信頼可能提示量）も bucket 合計と一致
  const offered = buckets.reduce((s, b) => s + b.totalCredibleOffers, 0);
  const credible = r
    .crowding!.credibleOffers.filter((o) => o.market === MARKET && o.product === PRODUCT)
    .reduce((s, o) => s + o.credibleOffer, 0);
  assert.ok(Math.abs(offered - credible) < 1e-9, `offered 合計不一致: ${offered} vs ${credible}`);
});

// ---------------------------------------------------------------------
// DUE-7: 全社同一納期なら従来と完全一致
// ---------------------------------------------------------------------

test("DUE-7: 同一 market × product で全社が同一納期なら、従来の1bucket結果と完全一致", () => {
  const plans = ["A", "B", "C", "D", "E"].map((id) => plan(id, 3_000, LEAD_NEAR));
  const supplies = ["A", "B", "C", "D", "E"].map((id) => supply(id, 3_000));
  const r = run(plans, supplies);

  const buckets = r.crowding!.buckets.filter((b) => b.market === MARKET && b.product === PRODUCT);
  assert.equal(buckets.length, 1, "bucket は1つ");

  const agg = r.state.history[0].allocations.find((a) => a.market === MARKET && a.product === PRODUCT)!;
  // 1 bucket のときは allocator の結果オブジェクトがそのまま保存される
  // （再集約による数値の作り直しが起きない）。
  assert.equal(unwrapUnit(agg.basePrice), buckets[0].postCrowdingClearingPrice, "basePrice が bucket の clearing price");
  assert.ok(
    Math.abs(unwrapUnit(agg.targetDemand) - buckets[0].forwardDemandProxy) < 1e-6,
    "targetDemand が bucket の forwardDemandProxy そのもの"
  );
  const allocated = agg.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);
  const tolerance = 0.01 * (agg.companies.length + 1);
  const residual = Math.abs(allocated + unwrapUnit(agg.externalOptionQuantity) - unwrapUnit(agg.targetDemand));
  assert.ok(residual <= tolerance, `需要保存が丸め誤差を超えて崩れた: residual=${residual} > tolerance=${tolerance}`);
  assert.equal(agg.companies.length, 5, "5社ぶんの配分が1件の allocation に入る");
});
