// ShrimpX V2 — ENG-CROWDING-MARKDOWN-1 必須 unit tests（CRWD-1〜15）
//
// このファイルが固定すること:
//  - markdown 関数の数学的性質（単調非増加・threshold 維持・連続・floor・非NaN）
//  - FAKE CAPACITY 不可（desired を巨大化しても physical ATP が同じなら価格が動かない）
//  - dueDate bucket の独立性と、既存 commitment の反映
//  - 既存契約の unitPrice が後続 Crowding で変わらないこと
//  - MOTHBALLED/SOLD 工場・未到着 import が ATP へ入らないこと
//  - legacy / tiered の両方が共通 Crowding 層を通ること
//  - Crowding OFF で既存結果がビット単位で同一であること
//  - 同一 seed の決定論

import test from "node:test";
import assert from "node:assert/strict";

import { hosoEqTons, ratio, score0to100, usdPerHosoEqKg } from "../../core/units";
import { nextPeriod, period } from "../../core/period";
import { DemandMarketId, Product } from "../../market/types";
import {
  CROWDING_POLICY_VERSION_V1,
  CrowdingMarkdownCoefficients,
  CrowdingPolicy,
  NEUTRAL_CROWDING_POLICY,
  PHYSICAL_ATP_METHOD_V1,
  FORWARD_DEMAND_PROXY_METHOD_V1,
  crowdingMultiplier,
  crowdingRatioOf,
} from "../crowding";
import { applyCrowdingLayer } from "../crowdingLayer";
import { buildPhysicalSupplyPool, resolveCredibleOffersForPool } from "../credibleOffer";
import type { CompanyProductPhysicalSupply } from "../credibleOffer";
import { resolveDueDateForPlanEntry } from "../contracts";
import { advanceSalesQuarterWithDiagnostics, initializeSalesState } from "../runner";
import { SALES_PARAMETERS_TIERED_FIXTURE_V0, SALES_PARAMETERS_V1, SalesParameters } from "../parameters";
import { CompanySalesPlanEntry, SalesContract, SalesQuarterInput } from "../types";
import { PHYSICAL_ATP_PROXY_LIMITATIONS, buildCompanyPhysicalSupplies } from "../../companyLab/physicalSupplySnapshot";
import { runIndustrySimulation } from "../../industryLab/simulationRunner";
import type { Factory, WorkerAssignment, CompanyProductionPlanEntry, ProductionShortfallReason } from "../../production/types";
import type { RawMaterialLot } from "../../rawMaterials/types";

const P0 = period(2020, 1);
const MARKETS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP", "OTHER"];
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

const ACTIVE: CrowdingMarkdownCoefficients = { threshold: 1.0, lambda: 0.8, gamma: 1.0, floor: 0.7 };

function activePolicy(overrides: Partial<CrowdingPolicy> = {}): CrowdingPolicy {
  return {
    policyVersion: CROWDING_POLICY_VERSION_V1,
    enabled: true,
    byProduct: { hoso: ACTIVE, pd: ACTIVE, vap: ACTIVE },
    protectedExternalShare: { hoso: 0.2, pd: 0.2, vap: 0.2 },
    physicalAtpMethod: PHYSICAL_ATP_METHOD_V1,
    forwardDemandProxyMethod: FORWARD_DEMAND_PROXY_METHOD_V1,
    ...overrides,
  };
}

function priceTable(value: number) {
  const t = {} as Record<DemandMarketId, Record<Product, number>>;
  for (const m of MARKETS) {
    t[m] = {} as Record<Product, number>;
    for (const p of PRODUCTS) t[m][p] = value;
  }
  return t;
}

function plan(
  companyId: string,
  market: DemandMarketId,
  product: Product,
  desired: number,
  extra: Partial<CompanySalesPlanEntry> = {}
): CompanySalesPlanEntry {
  return {
    companyId,
    market,
    product,
    desiredQuantity: hosoEqTons(desired),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 20,
    qualityReputation: score0to100(70),
    customerRelationship: score0to100(60),
    deliveryReliability: score0to100(60),
    ...extra,
  };
}

function supply(companyId: string, product: Product, onHand: number, committed: number): CompanyProductPhysicalSupply {
  return {
    companyId,
    product,
    onHandFinishedGoods: onHand,
    conservativeCommittedSupply: committed,
    method: PHYSICAL_ATP_METHOD_V1,
    limitations: [],
  };
}

function runLayer(args: {
  plans: readonly CompanySalesPlanEntry[];
  supplies: readonly CompanyProductPhysicalSupply[];
  contracts?: readonly SalesContract[];
  demand?: number;
  policy?: CrowdingPolicy;
  params?: SalesParameters;
}) {
  const params = args.params ?? SALES_PARAMETERS_V1;
  return applyCrowdingLayer({
    period: P0,
    policy: args.policy ?? activePolicy(),
    adjustedPlans: args.plans,
    existingContracts: args.contracts ?? [],
    physicalSupplies: args.supplies,
    preCrowdingStructuralPrices: priceTable(4.0),
    forwardDemandProxyByMarketProduct: priceTable(args.demand ?? 10_000),
    resolveDueDateForPlan: (e, p) => resolveDueDateForPlanEntry(e, p, params),
  });
}

// ---------------------------------------------------------------------
// CRWD-1 / 2 / 3 / 4: markdown 関数の性質
// ---------------------------------------------------------------------

test("CRWD-1: credible offer が増えると post-crowding price は単調非増加", () => {
  // 関数レベル
  let prev = Number.POSITIVE_INFINITY;
  for (let r = 0; r <= 5; r += 0.05) {
    const m = crowdingMultiplier(r, ACTIVE);
    assert.ok(m <= prev + 1e-12, `ratio=${r} で単調性が崩れた: ${m} > ${prev}`);
    prev = m;
  }

  // 層レベル: 提示会社を増やしていくと clearing price が下がり続ける
  let prevPrice = Number.POSITIVE_INFINITY;
  for (let n = 1; n <= 5; n++) {
    const ids = ["A", "B", "C", "D", "E"].slice(0, n);
    const r = runLayer({
      plans: ids.map((id) => plan(id, "CN", "hoso", 4_000)),
      supplies: ids.map((id) => supply(id, "hoso", 0, 4_000)),
    });
    const price = r.clearingPrices.CN.hoso;
    assert.ok(price <= prevPrice + 1e-12, `n=${n} で価格が上がった: ${price} > ${prevPrice}`);
    prevPrice = price;
  }
  assert.ok(prevPrice < 4.0, "5社集中では構造価格より低くなること");
});

test("CRWD-2: threshold 以下では structural price を維持する", () => {
  assert.equal(crowdingMultiplier(0, ACTIVE), 1);
  assert.equal(crowdingMultiplier(ACTIVE.threshold, ACTIVE), 1);
  assert.equal(crowdingMultiplier(ACTIVE.threshold / 2, ACTIVE), 1);

  // 層レベル: 需要に対して提示が小さければ価格は構造価格のまま
  const r = runLayer({
    plans: [plan("A", "CN", "hoso", 1_000)],
    supplies: [supply("A", "hoso", 0, 1_000)],
    demand: 100_000,
  });
  assert.equal(r.clearingPrices.CN.hoso, 4.0);
  assert.equal(r.buckets[0].crowdingMultiplier, 1);
});

test("CRWD-3: ratio 境界で価格 jump が無い（連続）", () => {
  const eps = 1e-7;
  const t = ACTIVE.threshold;
  const left = crowdingMultiplier(t - eps, ACTIVE);
  const at = crowdingMultiplier(t, ACTIVE);
  const right = crowdingMultiplier(t + eps, ACTIVE);
  assert.equal(left, 1);
  assert.equal(at, 1);
  assert.ok(Math.abs(right - at) < 1e-6, `threshold 直後に jump: ${at} -> ${right}`);

  // 広い範囲で隣接点の差が小さいこと（滑らかさ）
  let previous = crowdingMultiplier(0, ACTIVE);
  for (let r = 0.001; r <= 4; r += 0.001) {
    const m = crowdingMultiplier(r, ACTIVE);
    assert.ok(Math.abs(m - previous) < 1e-3, `ratio=${r} で不連続な変化: ${previous} -> ${m}`);
    previous = m;
  }
});

test("CRWD-4: 極端な over-offer でも floor 未満・負価格・NaN にならない", () => {
  for (const r of [10, 1e3, 1e6, 1e12]) {
    const m = crowdingMultiplier(r, ACTIVE);
    assert.ok(Number.isFinite(m), `NaN/Infinity: ratio=${r}`);
    assert.ok(m >= ACTIVE.floor, `floor 未満: ${m} < ${ACTIVE.floor}`);
    assert.ok(m <= 1, `1 を超えた: ${m}`);
  }
  // 需要が実質ゼロでも Infinity/NaN を出さない
  assert.equal(crowdingRatioOf(0, 0), 0);
  assert.ok(Number.isFinite(crowdingRatioOf(100, 0)));

  const r = runLayer({
    plans: [plan("A", "CN", "hoso", 1e9)],
    supplies: [supply("A", "hoso", 1e9, 0)],
    demand: 1,
  });
  const price = r.clearingPrices.CN.hoso;
  assert.ok(Number.isFinite(price) && price > 0, `価格が不正: ${price}`);
  assert.ok(price >= 4.0 * ACTIVE.floor - 1e-12, `floor 未満の価格: ${price}`);
});

// ---------------------------------------------------------------------
// CRWD-5: FAKE CAPACITY
// ---------------------------------------------------------------------

test("CRWD-5: desired を10倍にしても physical ATP が同じなら credible offer も価格も変わらない", () => {
  const supplies = [supply("A", "hoso", 1_000, 2_000), supply("B", "hoso", 1_000, 2_000)];

  // Case A: desired = physical capability 相当（3,000t）
  const caseA = runLayer({
    plans: [plan("A", "CN", "hoso", 3_000), plan("B", "CN", "hoso", 3_000)],
    supplies,
  });
  // Case B: desired だけ 10 倍（30,000t）。physical ATP は同じ。
  const caseB = runLayer({
    plans: [plan("A", "CN", "hoso", 30_000), plan("B", "CN", "hoso", 30_000)],
    supplies,
  });

  const a = caseA.buckets[0];
  const b = caseB.buckets[0];
  assert.deepEqual(
    a.companyOffers.map((o) => o.credibleOffer),
    b.companyOffers.map((o) => o.credibleOffer),
    "credible offer が desired の水増しで変わってはならない"
  );
  assert.equal(a.totalCredibleOffers, b.totalCredibleOffers);
  assert.equal(a.crowdingRatio, b.crowdingRatio);
  assert.equal(a.crowdingMultiplier, b.crowdingMultiplier);
  assert.equal(caseA.clearingPrices.CN.hoso, caseB.clearingPrices.CN.hoso);
  // 水増し側は physical ATP が拘束していること
  assert.equal(b.companyOffers[0].bindingReason, "PHYSICAL_ATP");
});

test("CRWD-5b: 同一 company×product×dueDate の pool を複数市場へ二重利用できない", () => {
  // CN/JP/EU へそれぞれ 8,000 / 4,000 / 8,000 を希望、pool は 10,000。
  const r = runLayer({
    plans: [plan("A", "CN", "vap", 8_000), plan("A", "JP", "vap", 4_000), plan("A", "EU", "vap", 8_000)],
    supplies: [supply("A", "vap", 10_000, 0)],
  });
  const offers = r.credibleOffers.filter((o) => o.companyId === "A" && o.product === "vap");
  const total = offers.reduce((s, o) => s + o.credibleOffer, 0);
  assert.ok(total <= 10_000 + 1e-9, `pool 超過: ${total}`);
  // 希望比での按分（8:4:8 → 4,000 / 2,000 / 4,000）
  const byMarket = new Map(offers.map((o) => [o.market, o.credibleOffer]));
  assert.ok(Math.abs((byMarket.get("CN") ?? 0) - 4_000) < 1e-9, `CN=${byMarket.get("CN")}`);
  assert.ok(Math.abs((byMarket.get("JP") ?? 0) - 2_000) < 1e-9, `JP=${byMarket.get("JP")}`);
  assert.ok(Math.abs((byMarket.get("EU") ?? 0) - 4_000) < 1e-9, `EU=${byMarket.get("EU")}`);
});

// ---------------------------------------------------------------------
// CRWD-6 / 7 / 8: dueDate bucket と既存契約
// ---------------------------------------------------------------------

test("CRWD-6: 別 dueDate の offer は互いの crowding へ入らない", () => {
  const r = runLayer({
    plans: [
      plan("A", "CN", "hoso", 5_000, { desiredLeadTimeTurns: 1 }),
      plan("B", "CN", "hoso", 5_000, { desiredLeadTimeTurns: 4 }),
    ],
    supplies: [supply("A", "hoso", 5_000, 0), supply("B", "hoso", 5_000, 0)],
  });
  assert.equal(r.buckets.length, 2, "dueDate が違えば別 bucket");
  for (const b of r.buckets) {
    assert.equal(b.companyOffers.length, 1, `bucket ${b.dueDate} に1社だけ`);
    assert.equal(b.totalCredibleOffers, 5_000);
  }
  assert.notEqual(r.buckets[0].dueDate, r.buckets[1].dueDate);

  // 同一 dueDate に2社집중した場合と比べ、ratio が小さいこと
  const together = runLayer({
    plans: [plan("A", "CN", "hoso", 5_000), plan("B", "CN", "hoso", 5_000)],
    supplies: [supply("A", "hoso", 5_000, 0), supply("B", "hoso", 5_000, 0)],
  });
  assert.equal(together.buckets.length, 1);
  assert.ok(together.buckets[0].crowdingRatio > r.buckets[0].crowdingRatio);
});

test("CRWD-7: 同じ dueDate への既存契約は、別 contracting turn のものでも existing commitment として反映される", () => {
  const dueDate = nextPeriod(P0);
  const existing: SalesContract = {
    contractId: "SC-prev",
    companyId: "Z",
    market: "CN",
    product: "hoso",
    // 前ターンに成約した契約（contractedPeriod が当期より前）
    contractedPeriod: period(2019, 4),
    dueDate,
    originalQuantity: hosoEqTons(3_000),
    outstandingQuantity: hosoEqTons(3_000),
    unitPrice: usdPerHosoEqKg(4.0),
    status: "open",
  };
  const withExisting = runLayer({
    plans: [plan("A", "CN", "hoso", 4_000)],
    supplies: [supply("A", "hoso", 4_000, 0)],
    contracts: [existing],
  });
  const without = runLayer({
    plans: [plan("A", "CN", "hoso", 4_000)],
    supplies: [supply("A", "hoso", 4_000, 0)],
  });
  const b = withExisting.buckets[0];
  assert.equal(b.existingCommittedOutstanding, 3_000);
  assert.equal(b.crowdingLoad, 3_000 + 4_000);
  assert.ok(b.crowdingRatio > without.buckets[0].crowdingRatio, "既存 commitment が分子へ入ること");
  // 残余需要は既存 commitment のぶん減っている
  assert.equal(b.residualContestableDemand, b.grossCompanyAddressableDemand - 3_000);
});

test("CRWD-8: 既存契約の unitPrice は後続の crowding で変化しない", () => {
  const dueDate = nextPeriod(P0);
  const existing: SalesContract = {
    contractId: "SC-prev",
    companyId: "Z",
    market: "CN",
    product: "hoso",
    contractedPeriod: period(2019, 4),
    dueDate,
    originalQuantity: hosoEqTons(3_000),
    outstandingQuantity: hosoEqTons(3_000),
    unitPrice: usdPerHosoEqKg(4.0),
    status: "open",
  };
  const frozen = JSON.parse(JSON.stringify(existing));
  const r = runLayer({
    plans: ["A", "B", "C", "D", "E"].map((id) => plan(id, "CN", "hoso", 9_000)),
    supplies: ["A", "B", "C", "D", "E"].map((id) => supply(id, "hoso", 9_000, 0)),
    contracts: [existing],
  });
  assert.ok(r.clearingPrices.CN.hoso < 4.0, "当期の clearing price は下がっている");
  assert.deepEqual(JSON.parse(JSON.stringify(existing)), frozen, "既存契約オブジェクトが変更されていない");
  assert.equal(existing.unitPrice as unknown as number, 4.0);
});

// ---------------------------------------------------------------------
// CRWD-9 / 10 / 11: physical ATP の構成
// ---------------------------------------------------------------------

function factory(factoryId: string, companyId: string, status: Factory["status"], cap: number): Factory {
  return {
    factoryId,
    companyId,
    status,
    commonProcessingCapacity: hosoEqTons(cap),
    hosoCapacity: hosoEqTons(cap),
    pdCapacity: hosoEqTons(cap),
    vapCapacity: hosoEqTons(cap),
    freezingPackagingCapacity: hosoEqTons(cap),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
  } as Factory;
}

function assignment(factoryId: string, companyId: string): WorkerAssignment {
  return {
    factoryId,
    companyId,
    regularHeadcount: 100_000,
    temporaryHeadcount: 0,
    skills: PRODUCTS.map((p) => ({ product: p, skillLevel: ratio(1) })),
    overtimeRate: ratio(0),
    attendanceRate: ratio(1),
  };
}

function productionPlan(companyId: string, factoryId: string, product: Product, q: number): CompanyProductionPlanEntry {
  return { companyId, factoryId, product, desiredQuantity: hosoEqTons(q), priority: 1 };
}

function rawLot(companyId: string, q: number, availableFrom = P0, status = "available"): RawMaterialLot {
  return {
    lotId: `RM-${companyId}-${availableFrom}-${q}`,
    companyId,
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: P0,
    originalQuantity: hosoEqTons(q),
    remainingQuantity: hosoEqTons(q),
    unitCost: usdPerHosoEqKg(3.0),
    availableFromPeriod: availableFrom,
    status,
  } as RawMaterialLot;
}

test("CRWD-9: MOTHBALLED / SOLD 工場の能力は ATP へ入らない", () => {
  const active = buildCompanyPhysicalSupplies(
    {
      companyId: "A",
      effectiveFactories: [factory("F1", "A", "active", 5_000)],
      productionPlans: [productionPlan("A", "F1", "hoso", 5_000)],
      workerAssignments: [assignment("F1", "A")],
      finishedGoodsLots: [],
      rawMaterialLots: [rawLot("A", 100_000)],
    },
    P0
  );
  const hosoActive = active.find((s) => s.product === "hoso")!;
  assert.ok(hosoActive.conservativeCommittedSupply > 0, "稼働工場の計画は供給になる");

  // lifecycle で effectiveFactories から外れた工場（MOTHBALLED/SOLD 相当）
  const mothballed = buildCompanyPhysicalSupplies(
    {
      companyId: "A",
      effectiveFactories: [],
      productionPlans: [productionPlan("A", "F1", "hoso", 5_000)],
      workerAssignments: [assignment("F1", "A")],
      finishedGoodsLots: [],
      rawMaterialLots: [rawLot("A", 100_000)],
    },
    P0
  );
  assert.equal(mothballed.find((s) => s.product === "hoso")!.conservativeCommittedSupply, 0);

  // status が active でない工場は能力 0（production/capacity.ts の既存仕様）
  const idle = buildCompanyPhysicalSupplies(
    {
      companyId: "A",
      effectiveFactories: [factory("F1", "A", "idle", 5_000)],
      productionPlans: [productionPlan("A", "F1", "hoso", 5_000)],
      workerAssignments: [assignment("F1", "A")],
      finishedGoodsLots: [],
      rawMaterialLots: [rawLot("A", 100_000)],
    },
    P0
  );
  assert.equal(idle.find((s) => s.product === "hoso")!.conservativeCommittedSupply, 0);
});

test("CRWD-10: 納期までに到着しない import（未到着ロット）は ATP へ入らない", () => {
  const notArrived = buildCompanyPhysicalSupplies(
    {
      companyId: "A",
      effectiveFactories: [factory("F1", "A", "active", 5_000)],
      productionPlans: [productionPlan("A", "F1", "hoso", 5_000)],
      workerAssignments: [assignment("F1", "A")],
      finishedGoodsLots: [],
      // 輸送中（status != available）かつ利用可能四半期が将来
      rawMaterialLots: [rawLot("A", 100_000, nextPeriod(P0), "inTransitImport")],
    },
    P0
  );
  assert.equal(
    notArrived.find((s) => s.product === "hoso")!.conservativeCommittedSupply,
    0,
    "未到着の原料では当期の確定供給は作れない"
  );

  const arrived = buildCompanyPhysicalSupplies(
    {
      companyId: "A",
      effectiveFactories: [factory("F1", "A", "active", 5_000)],
      productionPlans: [productionPlan("A", "F1", "hoso", 5_000)],
      workerAssignments: [assignment("F1", "A")],
      finishedGoodsLots: [],
      rawMaterialLots: [rawLot("A", 100_000)],
    },
    P0
  );
  assert.ok(arrived.find((s) => s.product === "hoso")!.conservativeCommittedSupply > 0);
});

test("CRWD-11: 既存 backlog は physical ATP から差し引かれる", () => {
  const dueDate = nextPeriod(P0);
  const pool = buildPhysicalSupplyPool({
    supply: supply("A", "hoso", 4_000, 1_000),
    dueDate,
    existingBacklogDueByDueDate: 2_000,
  });
  assert.equal(pool.physicalAtpCap, 4_000 + 1_000 - 2_000);

  // backlog が供給を上回っても負にならない
  const drained = buildPhysicalSupplyPool({
    supply: supply("A", "hoso", 1_000, 0),
    dueDate,
    existingBacklogDueByDueDate: 9_999,
  });
  assert.equal(drained.physicalAtpCap, 0);

  // 層レベル: 同じ会社の未履行契約があると credible offer が減る
  const backlogContract: SalesContract = {
    contractId: "SC-backlog",
    companyId: "A",
    market: "US",
    product: "hoso",
    contractedPeriod: period(2019, 4),
    dueDate,
    originalQuantity: hosoEqTons(3_000),
    outstandingQuantity: hosoEqTons(3_000),
    unitPrice: usdPerHosoEqKg(4.0),
    status: "open",
  };
  const withBacklog = runLayer({
    plans: [plan("A", "CN", "hoso", 5_000)],
    supplies: [supply("A", "hoso", 5_000, 0)],
    contracts: [backlogContract],
  });
  assert.equal(withBacklog.buckets.find((b) => b.market === "CN")!.totalCredibleOffers, 2_000);
});

// ---------------------------------------------------------------------
// CRWD-12 / 13 / 14 / 15: allocation 接続・決定論
// ---------------------------------------------------------------------

// 市場入力は実際の industry simulation から取る（スタブを自作して形を取り違えない）。
const INDUSTRY_QUARTERS = runIndustrySimulation({
  scenarioId: "baseline-v0.1",
  mode: "canonical",
  seed: "crowding-markdown-fixture",
  turns: 1,
}).quarters;

function quarterInput(
  plans: readonly CompanySalesPlanEntry[],
  crowding?: SalesQuarterInput["crowding"]
): SalesQuarterInput {
  return {
    plans,
    marketResult: INDUSTRY_QUARTERS[0].marketResult,
    marketInput: INDUSTRY_QUARTERS[0].marketInput,
    crowding,
  };
}

test("CRWD-12: legacy と tiered の両方が共通 Crowding 層を通る", () => {
  const plans = ["A", "B", "C"].map((id) => plan(id, "CN", "hoso", 9_000));
  const supplies = ["A", "B", "C"].map((id) => supply(id, "hoso", 9_000, 0));
  const crowding = { policy: activePolicy(), physicalSupplies: supplies };

  const legacyParams: SalesParameters = SALES_PARAMETERS_V1;
  const tieredParams: SalesParameters = SALES_PARAMETERS_TIERED_FIXTURE_V0;

  for (const [label, params] of [
    ["legacy", legacyParams],
    ["tiered", tieredParams],
  ] as const) {
    const off = advanceSalesQuarterWithDiagnostics(initializeSalesState(P0), quarterInput(plans), params);
    const on = advanceSalesQuarterWithDiagnostics(initializeSalesState(P0), quarterInput(plans, crowding), params);

    assert.equal(off.crowding, undefined, `${label}: Crowding 未指定なら診断なし`);
    assert.ok(on.crowding, `${label}: Crowding 指定時は診断が返る`);
    assert.ok(on.crowding!.buckets.length > 0, `${label}: bucket が作られる`);

    const cnOff = off.state.history[0].newContracts.filter((c) => c.market === "CN" && c.product === "hoso");
    const cnOn = on.state.history[0].newContracts.filter((c) => c.market === "CN" && c.product === "hoso");
    assert.ok(cnOff.length > 0 && cnOn.length > 0, `${label}: 契約が生成される`);
    const priceOff = cnOff[0].unitPrice as unknown as number;
    const priceOn = cnOn[0].unitPrice as unknown as number;
    assert.ok(priceOn < priceOff, `${label}: Crowding 後の成約単価が下がること (${priceOn} < ${priceOff})`);
  }
});

test("CRWD-13: Crowding 後も tiered の品質優位が相対 allocation に残る", () => {
  const tieredParams: SalesParameters = SALES_PARAMETERS_TIERED_FIXTURE_V0;
  const plans = [
    plan("HI", "CN", "hoso", 9_000, { qualityReputation: score0to100(95) }),
    plan("LO", "CN", "hoso", 9_000, { qualityReputation: score0to100(40) }),
  ];
  const supplies = [supply("HI", "hoso", 9_000, 0), supply("LO", "hoso", 9_000, 0)];

  const on = advanceSalesQuarterWithDiagnostics(
    initializeSalesState(P0),
    quarterInput(plans, { policy: activePolicy(), physicalSupplies: supplies }),
    tieredParams
  );
  const alloc = on.state.history[0].allocations.find((a) => a.market === "CN" && a.product === "hoso")!;
  const hi = alloc.companies.find((c) => c.companyId === "HI")!;
  const lo = alloc.companies.find((c) => c.companyId === "LO")!;
  assert.ok(
    (hi.allocatedQuantity as unknown as number) > (lo.allocatedQuantity as unknown as number),
    "品質優位社の配分が多いこと"
  );
});

test("CRWD-14: Crowding OFF / 中立 policy で既存結果がビット単位で同一", () => {
  const plans = ["A", "B", "C"].map((id) => plan(id, "CN", "hoso", 5_000));
  const supplies = ["A", "B", "C"].map((id) => supply(id, "hoso", 5_000, 0));

  for (const params of [SALES_PARAMETERS_V1, SALES_PARAMETERS_TIERED_FIXTURE_V0]) {
    const baseline = advanceSalesQuarterWithDiagnostics(initializeSalesState(P0), quarterInput(plans), params);
    const neutral = advanceSalesQuarterWithDiagnostics(
      initializeSalesState(P0),
      quarterInput(plans, { policy: NEUTRAL_CROWDING_POLICY, physicalSupplies: supplies }),
      params
    );
    assert.equal(
      JSON.stringify(neutral.state),
      JSON.stringify(baseline.state),
      "中立 policy では state がビット単位で同一"
    );
    // 中立 policy でも診断は作られるが multiplier は恒等 1
    for (const b of neutral.crowding!.buckets) assert.equal(b.crowdingMultiplier, 1);
  }
});

test("CRWD-15: 同一入力に対して決定論的", () => {
  const plans = ["A", "B", "C", "D", "E"].map((id) => plan(id, "CN", "hoso", 7_000));
  const supplies = ["A", "B", "C", "D", "E"].map((id) => supply(id, "hoso", 7_000, 0));
  const runs = [0, 1, 2].map(() => runLayer({ plans, supplies }));
  assert.equal(JSON.stringify(runs[0]), JSON.stringify(runs[1]));
  assert.equal(JSON.stringify(runs[1]), JSON.stringify(runs[2]));

  // 入力配列の順序を変えても結果が同じ（決定論的なソートが効いている）
  const reversed = runLayer({ plans: [...plans].reverse(), supplies: [...supplies].reverse() });
  assert.equal(JSON.stringify(reversed), JSON.stringify(runs[0]));
});

test("CRWD-16(補): credible offer 解決は pool と不整合な入力を silent fallback しない", () => {
  const pool = buildPhysicalSupplyPool({
    supply: supply("A", "hoso", 1_000, 0),
    dueDate: nextPeriod(P0),
    existingBacklogDueByDueDate: 0,
  });
  assert.throws(
    () =>
      resolveCredibleOffersForPool(pool, [
        {
          companyId: "B",
          market: "CN",
          product: "hoso",
          dueDate: nextPeriod(P0),
          desiredAfterSalesEffort: 1_000,
          commercialApprovedCap: Number.POSITIVE_INFINITY,
        },
      ]),
    /pool と entry の/
  );
});

// ---------------------------------------------------------------------
// ENG-CROWDING-MARKDOWN-1A §6 / §7
// ---------------------------------------------------------------------

test("CRWD-ATP-1: physical ATP proxy の制約集合が実 Engine の制約集合と一致する（§6 再監査）", () => {
  // 実 production Engine が生産数量を減らす理由は ProductionShortfallReason の5つで閉じている
  // （production/allocation.ts:198-204）。physicalSupplySnapshot.ts はこの5つと同じ
  // 制約だけを clip しており、coldStorage / factorySpace は Engine 側でも数量を
  // 拘束しないため除外している。省略による ATP の上振れは存在しない。
  const engineReasons: readonly ProductionShortfallReason[] = [
    "rawMaterialShortage",
    "commonCapacityShortage",
    "productCapacityShortage",
    "laborShortage",
    "packagingCapacityShortage",
  ];
  assert.equal(engineReasons.length, 5, "Engine の数量制約は5種類");

  // coldStorage / factorySpace は Engine の制約理由に存在しない。
  for (const r of engineReasons) {
    assert.ok(!/cold|storage|space/i.test(r), `Engine 制約に保管・スペースが現れた: ${r}`);
  }

  // proxy 側の limitations に、除外理由が「Engine でも拘束しない」として明記されている。
  const note = PHYSICAL_ATP_PROXY_LIMITATIONS.find((l) => l.includes("coldStorage"));
  assert.ok(note, "coldStorage / factorySpace の扱いが limitations に明記されていること");
  assert.ok(
    note!.includes("上回る原因にはならない"),
    "省略が ATP の上振れ要因にならないことを明記していること（保守的 proxy と誤称しない）"
  );
});

test("CRWD-LOAD-1: 1社あたり提示量 Q 固定で SOLO < TWO < CROWD（§7）", () => {
  const Q = 3_000;
  const make = (n: number) => {
    const ids = ["A", "B", "C", "D", "E"].slice(0, n);
    return runLayer({
      plans: ids.map((id) => plan(id, "CN", "hoso", Q)),
      supplies: ids.map((id) => supply(id, "hoso", Q, 0)),
    });
  };
  const solo = make(1);
  const two = make(2);
  const crowd = make(5);

  const load = (r: ReturnType<typeof make>) => r.buckets[0].totalCredibleOffers;
  const ratio = (r: ReturnType<typeof make>) => r.buckets[0].crowdingRatio;
  const price = (r: ReturnType<typeof make>) => r.clearingPrices.CN.hoso;

  // total credible offer: SOLO < TWO < CROWD
  assert.ok(load(solo) < load(two), `${load(solo)} < ${load(two)}`);
  assert.ok(load(two) < load(crowd), `${load(two)} < ${load(crowd)}`);
  // crowdingRatio: SOLO < TWO < CROWD
  assert.ok(ratio(solo) < ratio(two), `${ratio(solo)} < ${ratio(two)}`);
  assert.ok(ratio(two) < ratio(crowd), `${ratio(two)} < ${ratio(crowd)}`);
  // post-crowding price: SOLO >= TWO >= CROWD
  assert.ok(price(solo) >= price(two), `${price(solo)} >= ${price(two)}`);
  assert.ok(price(two) >= price(crowd), `${price(two)} >= ${price(crowd)}`);
  // 少なくとも CROWD では実際に下がっていること（性質が空虚に成立していない）
  assert.ok(price(crowd) < price(solo), `CROWD は SOLO より安いこと: ${price(crowd)} < ${price(solo)}`);
});

test("CRWD-LOAD-2: 同じ total load を会社数だけ分割しても clearing price は同一（会社数は式に入らない）", () => {
  const TOTAL = 12_000;
  const split = (n: number) => {
    const ids = ["A", "B", "C", "D", "E"].slice(0, n);
    return runLayer({
      plans: ids.map((id) => plan(id, "CN", "hoso", TOTAL / n)),
      supplies: ids.map((id) => supply(id, "hoso", TOTAL / n, 0)),
    });
  };
  const one = split(1);
  const base = one.clearingPrices.CN.hoso;
  for (const n of [2, 3, 5]) {
    const r = split(n);
    assert.equal(
      r.buckets[0].totalCredibleOffers,
      one.buckets[0].totalCredibleOffers,
      `n=${n}: total credible offer が同一`
    );
    assert.equal(r.clearingPrices.CN.hoso, base, `n=${n}: clearing price が同一（会社数に依存しない）`);
  }
});
