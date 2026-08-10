// ShrimpX V2 — Phase 6B 営業能力モデル テスト（#04 B-1「営業モデルテスト15項目」）
//
// 【このテストが固定すること】
//   営業能力モデル（perMarket / companyWide / companyWideWithFragmentation）の
//   構造的な性質だけを固定する。**ゲームバランスの数値そのものは固定しない**
//   （校正中のため）。既定値が perMarket であること＝既存挙動が不変であることは
//   明示的に検証する（#04 §14「Scenario・市場を変更しない」）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  SALES_CAPACITY_MODEL_PER_MARKET,
  SalesCapacityModel,
  companySalesOrganizationCapacity,
  computeMarketSalesCapacities,
  marketFragmentationFactor,
} from "../salesCapacityModel";
import { SALES_PARAMETERS_V1, SalesParameters } from "../parameters";
import { processingCapacity } from "../salesForce";
import { salesEffortWeightedQuantity, computeMarketSalesEffort, applyMarketSalesEffortCapacity } from "../marketEffort";
import { DemandMarketId, Product } from "../../market/types";
import { unwrapUnit, hosoEqTons } from "../../core/units";
import { CompanySalesPlanEntry } from "../types";

const MARKETS: readonly DemandMarketId[] = ["JP", "US", "EU", "CN", "OTHER"];

const COMPANY_WIDE: SalesCapacityModel = {
  kind: "companyWide",
  companyBaselineCapacityTons: 1_000,
  companyCapacityMaxIncrementTons: 95_000,
  companyCapacitySaturationHeadcount: 190,
  fragmentationPenaltyPerExtraMarket: 0,
  fragmentationFloor: 1,
};

const CASE_C: SalesCapacityModel = {
  ...COMPANY_WIDE,
  kind: "companyWideWithFragmentation",
  fragmentationPenaltyPerExtraMarket: 0.03,
  fragmentationFloor: 0.85,
};

/** V3 営業工数係数（Case C + V3 候補）。 */
const V3: Readonly<Record<Product, number>> = { hoso: 1.0, pd: 1.25, vap: 1.75 };

function paramsWith(model: SalesCapacityModel, effort: Readonly<Record<Product, number>> = V3): SalesParameters {
  return { ...SALES_PARAMETERS_V1, salesEffortCoefficients: effort, salesCapacityModel: model };
}

/** 各市場に等しい工数需要がある状況（配分の偏りを排除して能力だけを見る）。 */
function evenDemand(markets: readonly DemandMarketId[], perMarket = 10_000): Map<DemandMarketId, number> {
  return new Map(markets.map((m) => [m, perMarket]));
}

function evenHeadcount(markets: readonly DemandMarketId[], total: number): Map<DemandMarketId, number> {
  const per = Math.floor(total / markets.length);
  return new Map(markets.map((m) => [m, per]));
}

function sum(values: Iterable<number>): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

// ---------------------------------------------------------------------
// SCM-1 会社全体の営業能力が唯一の計算箇所（SSoT）から出ること
// ---------------------------------------------------------------------

test("SCM-1: 会社全体モデルの市場別能力は computeMarketSalesCapacities だけで決まり、会社能力式と一致する", () => {
  const params = paramsWith(COMPANY_WIDE);
  const totalHeadcount = 150;
  const capacities = computeMarketSalesCapacities(
    totalHeadcount,
    evenDemand(MARKETS),
    evenHeadcount(MARKETS, totalHeadcount),
    params
  );
  const expected = companySalesOrganizationCapacity(totalHeadcount, COMPANY_WIDE);
  assert.ok(Math.abs(sum(capacities.values()) - expected) < 1e-6, "市場別能力の合計が会社能力式と一致すること");
  // 市場別の人数配分を変えても、会社全体の能力は変わらない（会社単位のSSoT）。
  const skewed = new Map<DemandMarketId, number>([
    ["JP", 100],
    ["US", 20],
    ["EU", 10],
    ["CN", 10],
    ["OTHER", 10],
  ]);
  const capacities2 = computeMarketSalesCapacities(totalHeadcount, evenDemand(MARKETS), skewed, params);
  assert.ok(Math.abs(sum(capacities2.values()) - expected) < 1e-6);
});

// ---------------------------------------------------------------------
// SCM-2 市場配分の合計が会社能力を超えない
// ---------------------------------------------------------------------

test("SCM-2: 市場別能力の合計は、どの需要分布でも会社全体能力を超えない", () => {
  for (const model of [COMPANY_WIDE, CASE_C]) {
    const params = paramsWith(model);
    const ceiling = companySalesOrganizationCapacity(140, model) * marketFragmentationFactor(MARKETS.length, model);
    const distributions: ReadonlyMap<DemandMarketId, number>[] = [
      evenDemand(MARKETS),
      new Map<DemandMarketId, number>([["JP", 50_000], ["US", 1], ["EU", 0], ["CN", 0], ["OTHER", 0]]),
      new Map<DemandMarketId, number>(MARKETS.map((m, i) => [m, i * 3_000])),
      new Map<DemandMarketId, number>(MARKETS.map((m) => [m, 0])),
    ];
    for (const d of distributions) {
      const c = computeMarketSalesCapacities(140, d, evenHeadcount(MARKETS, 140), params);
      assert.ok(sum(c.values()) <= ceiling + 1e-6, `${model.kind}: 合計 ${sum(c.values())} <= ${ceiling}`);
    }
  }
});

// ---------------------------------------------------------------------
// SCM-3 市場を増やしても能力が不自然に倍増・崩壊しない
// ---------------------------------------------------------------------

test("SCM-3: 会社全体モデルでは、展開市場を増やしても総能力が倍増しない（perMarket は倍増する＝現行の構造問題）", () => {
  const params = paramsWith(COMPANY_WIDE);
  const totals: number[] = [];
  for (const count of [1, 2, 3, 5]) {
    const markets = MARKETS.slice(0, count);
    const c = computeMarketSalesCapacities(150, evenDemand(markets), evenHeadcount(markets, 150), params);
    totals.push(sum(c.values()));
  }
  for (const t of totals) assert.ok(Math.abs(t - totals[0]) < 1e-6, "市場数によらず会社能力は一定");

  // 対照: 現行 perMarket は市場を増やすほど総能力が増える（この非対称が Phase 6B の発端）。
  const control = SALES_PARAMETERS_V1;
  const one = computeMarketSalesCapacities(150, evenDemand(MARKETS.slice(0, 1)), new Map([["JP" as DemandMarketId, 150]]), control, SALES_CAPACITY_MODEL_PER_MARKET);
  const five = computeMarketSalesCapacities(150, evenDemand(MARKETS), evenHeadcount(MARKETS, 150), control, SALES_CAPACITY_MODEL_PER_MARKET);
  assert.ok(sum(five.values()) > sum(one.values()), "perMarket は市場数で総能力が増える（現行構造の記録）");
});

test("SCM-3b: 会社全体モデルでは、需要が観測できない市場へ能力を配らない", () => {
  const params = paramsWith(COMPANY_WIDE);
  const demand = new Map<DemandMarketId, number>([["JP", 10_000], ["US", 0], ["EU", 0], ["CN", 0], ["OTHER", 0]]);
  const c = computeMarketSalesCapacities(150, demand, evenHeadcount(MARKETS, 150), params);
  assert.equal(c.get("US"), 0);
  assert.ok((c.get("JP") ?? 0) > 0);
});

// ---------------------------------------------------------------------
// SCM-4 fragmentation penalty の単調性
// ---------------------------------------------------------------------

test("SCM-4: fragmentation 係数は市場数に対して単調非増加であり、floor で下げ止まる", () => {
  let previous = Infinity;
  for (let marketCount = 1; marketCount <= 12; marketCount++) {
    const f = marketFragmentationFactor(marketCount, CASE_C);
    assert.ok(f <= previous + 1e-12, `市場数 ${marketCount} で係数が増えた`);
    assert.ok(f >= CASE_C.fragmentationFloor - 1e-12, "floor を下回らない");
    previous = f;
  }
  assert.equal(marketFragmentationFactor(1, CASE_C), 1, "1市場では罰しない");
  assert.ok(Math.abs(marketFragmentationFactor(5, CASE_C) - 0.88) < 1e-12);
  // penalty を強めるほど係数は小さくなる（感度比較 0.02 / 0.03 / 0.04 の前提）。
  const factors = [0.02, 0.03, 0.04].map((p) => marketFragmentationFactor(5, { ...CASE_C, fragmentationPenaltyPerExtraMarket: p }));
  assert.ok(factors[0] > factors[1] && factors[1] > factors[2]);
  // perMarket / companyWide では常に 1（この機構は Case C 専用）。
  assert.equal(marketFragmentationFactor(5, COMPANY_WIDE), 1);
  assert.equal(marketFragmentationFactor(5, SALES_CAPACITY_MODEL_PER_MARKET), 1);
});

// ---------------------------------------------------------------------
// SCM-5 / SCM-6 商品別営業工数の差
// ---------------------------------------------------------------------

test("SCM-5: HOSO / PD / VAP で必要営業工数が異なる（同じ数量でも消費能力が違う）", () => {
  const params = paramsWith(CASE_C);
  const hoso = salesEffortWeightedQuantity({ hoso: 1_000, pd: 0, vap: 0 }, params);
  const pd = salesEffortWeightedQuantity({ hoso: 0, pd: 1_000, vap: 0 }, params);
  const vap = salesEffortWeightedQuantity({ hoso: 0, pd: 0, vap: 1_000 }, params);
  assert.ok(hoso < pd && pd < vap, `HOSO ${hoso} < PD ${pd} < VAP ${vap}`);
});

test("SCM-6: VAP は HOSO より明確に重い（同一営業人数で売れる VAP トン数が少ない）", () => {
  const params = paramsWith(CASE_C);
  const capacity = companySalesOrganizationCapacity(120, CASE_C) * marketFragmentationFactor(5, CASE_C);
  const hosoTons = capacity / params.salesEffortCoefficients.hoso;
  const vapTons = capacity / params.salesEffortCoefficients.vap;
  assert.ok(vapTons < hosoTons);
  assert.ok(params.salesEffortCoefficients.vap / params.salesEffortCoefficients.hoso >= 1.5, "VAP は HOSO の1.5倍以上の工数");
});

// ---------------------------------------------------------------------
// SCM-7 成長ラダー（60 / 100 / 130 / 160 / 180 人）
// ---------------------------------------------------------------------

test("SCM-7: 営業人数を増やすほど実売可能トンが単調に増え、逓減する（60→180人）", () => {
  const params = paramsWith(CASE_C);
  const perTon = 0.4 * V3.hoso + 0.35 * V3.pd + 0.25 * V3.vap; // mixed 構成
  const ladder = [60, 100, 130, 160, 180].map(
    (h) => (companySalesOrganizationCapacity(h, CASE_C) * marketFragmentationFactor(5, CASE_C)) / perTon
  );
  for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i] > ladder[i - 1], "単調増加");
  // 逓減: 1人あたりの限界増分が縮んでいく。
  const marginal = [
    (ladder[1] - ladder[0]) / 40,
    (ladder[2] - ladder[1]) / 30,
    (ladder[3] - ladder[2]) / 30,
    (ladder[4] - ladder[3]) / 20,
  ];
  for (let i = 1; i < marginal.length; i++) assert.ok(marginal[i] < marginal[i - 1], "限界生産性は逓減する");
  // 60人でも1工場（約18,500t）に届かず、増員が必要であること（営業投資が意味を持つ）。
  assert.ok(ladder[0] < 18_500, `60人での実売可能量 ${Math.round(ladder[0])}t は1工場分未満であること`);
  assert.ok(ladder[4] > ladder[0] * 1.5, "180人では60人の1.5倍以上を売れること");
  void params;
});

// ---------------------------------------------------------------------
// SCM-8 / SCM-9 採用ランプ 30% ルールと減員の自由度（営業モデル変更で壊れないこと）
// ---------------------------------------------------------------------

test("SCM-8: 営業能力モデルを変えても採用ランプ 30% ルールは不変", async () => {
  const { computeMaxSalesHiresPerQuarter, applySalesHireRampLimit, SALES_HIRE_RAMP_RATIO, MIN_SALES_HIRES_PER_QUARTER } = await import(
    "../../companyLab/salesForceHiring"
  );
  assert.equal(SALES_HIRE_RAMP_RATIO, 0.3);
  assert.equal(MIN_SALES_HIRES_PER_QUARTER, 3);
  assert.equal(computeMaxSalesHiresPerQuarter(5), 3);
  assert.equal(computeMaxSalesHiresPerQuarter(20), 6);
  assert.equal(computeMaxSalesHiresPerQuarter(60), 18);
  assert.equal(computeMaxSalesHiresPerQuarter(130), 39);
  assert.deepEqual(applySalesHireRampLimit(60, 100), { actualHireCount: 18, limit: 18, deferredCount: 82 });
});

test("SCM-9: 減員には上限がない（前期末人数で頭打ちになるだけ）", async () => {
  const { computeEffectiveSalesForceLayoffCount } = await import("../../companyLab/salesForceHiring");
  assert.equal(computeEffectiveSalesForceLayoffCount(130, 130), 130, "全員の減員が可能");
  assert.equal(computeEffectiveSalesForceLayoffCount(130, 200), 130, "在籍数で頭打ち");
  assert.equal(computeEffectiveSalesForceLayoffCount(130, 40), 40);
  assert.equal(computeEffectiveSalesForceLayoffCount(130, -5), 0);
});

// ---------------------------------------------------------------------
// SCM-10 Player と Standard AI が同じモデルを通ること
// ---------------------------------------------------------------------

function plan(companyId: string, market: DemandMarketId, product: Product, tons: number, headcount: number): CompanySalesPlanEntry {
  return {
    companyId,
    market,
    product,
    desiredQuantity: hosoEqTons(tons),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: headcount,
  };
}

test("SCM-10: エンジン側（applyMarketSalesEffortCapacity）も computeMarketSalesCapacities と同じ能力で制約する", () => {
  const params = paramsWith(CASE_C);
  const headcountByMarket = new Map<DemandMarketId, number>(MARKETS.map((m) => [m, 24]));
  const plans = MARKETS.map((m) => plan("BAL", m, "hoso", 20_000, 24));
  const { adjustedPlans } = applyMarketSalesEffortCapacity(plans, params);

  const effortDemand = new Map<DemandMarketId, number>(MARKETS.map((m) => [m, params.salesEffortCoefficients.hoso * 20_000]));
  const capacities = computeMarketSalesCapacities(120, effortDemand, headcountByMarket, params);

  for (const p of adjustedPlans) {
    const expectedTons = (capacities.get(p.market) ?? 0) / params.salesEffortCoefficients.hoso;
    // 数量は hosoEqTons の丸め規約（小数2桁）を通るため、その粒度で一致を見る。
    assert.ok(
      Math.abs(unwrapUnit(p.desiredQuantity) - expectedTons) < 0.01,
      `${p.market}: エンジン ${unwrapUnit(p.desiredQuantity)} vs モデル ${expectedTons}`
    );
  }
  // 会社全体の縮小後合計は、会社能力の範囲に収まる。
  const totalAfter = adjustedPlans.reduce((s, p) => s + params.salesEffortCoefficients.hoso * unwrapUnit(p.desiredQuantity), 0);
  const ceiling = companySalesOrganizationCapacity(120, CASE_C) * marketFragmentationFactor(5, CASE_C);
  // 丸め（小数2桁×5市場）ぶんの許容差を置く。
  assert.ok(totalAfter <= ceiling + 0.1, `${totalAfter} <= ${ceiling}`);
});

// ---------------------------------------------------------------------
// SCM-11 / SCM-12 既存挙動（財務・生産）への非影響 ＝ 既定が perMarket であること
// ---------------------------------------------------------------------

test("SCM-11: 既定パラメータは salesCapacityModel を持たず、従来の市場別能力と完全一致する", () => {
  assert.equal(SALES_PARAMETERS_V1.salesCapacityModel, undefined, "既定では新モデルを有効化しない");
  const headcountByMarket = evenHeadcount(MARKETS, 150);
  const capacities = computeMarketSalesCapacities(150, evenDemand(MARKETS), headcountByMarket, SALES_PARAMETERS_V1);
  for (const m of MARKETS) {
    const legacy = unwrapUnit(processingCapacity(headcountByMarket.get(m) ?? 0, SALES_PARAMETERS_V1));
    assert.equal(capacities.get(m), legacy, `${m}: 既定経路は従来式と同値`);
  }
});

test("SCM-12: 既定パラメータでは applyMarketSalesEffortCapacity の結果が従来経路とビット単位で一致する", () => {
  const plans = MARKETS.flatMap((m) => [plan("BAL", m, "hoso", 4_000, 24), plan("BAL", m, "pd", 2_000, 24), plan("BAL", m, "vap", 1_000, 24)]);
  const { adjustedPlans } = applyMarketSalesEffortCapacity(plans, SALES_PARAMETERS_V1);
  for (const m of MARKETS) {
    const byProduct: Record<Product, number> = { hoso: 4_000, pd: 2_000, vap: 1_000 };
    const expected = computeMarketSalesEffort(24, byProduct, SALES_PARAMETERS_V1);
    for (const p of adjustedPlans.filter((x) => x.market === m)) {
      assert.ok(
        Math.abs(unwrapUnit(p.desiredQuantity) - expected.adjustedQuantityByProduct[p.product]) < 0.01,
        `${m}/${p.product}: ${unwrapUnit(p.desiredQuantity)} vs ${expected.adjustedQuantityByProduct[p.product]}`
      );
    }
  }
});

// ---------------------------------------------------------------------
// SCM-13 決定性（同一入力 → 同一出力・呼び出し順に依存しない）
// ---------------------------------------------------------------------

test("SCM-13: 同一入力に対して常に同一の能力を返し、市場の列挙順に依存しない", () => {
  const params = paramsWith(CASE_C);
  const demandA = new Map<DemandMarketId, number>([["JP", 3_000], ["US", 9_000], ["EU", 1_000], ["CN", 12_000], ["OTHER", 500]]);
  const demandB = new Map<DemandMarketId, number>([["OTHER", 500], ["CN", 12_000], ["EU", 1_000], ["US", 9_000], ["JP", 3_000]]);
  const a = computeMarketSalesCapacities(133, demandA, evenHeadcount(MARKETS, 133), params);
  const b = computeMarketSalesCapacities(133, demandB, evenHeadcount(MARKETS, 133), params);
  for (const m of MARKETS) assert.equal(a.get(m), b.get(m), `${m} が列挙順で変わった`);
  const again = computeMarketSalesCapacities(133, demandA, evenHeadcount(MARKETS, 133), params);
  for (const m of MARKETS) assert.equal(a.get(m), again.get(m));
});

// ---------------------------------------------------------------------
// SCM-14 永続化・移行（salesCapacityModel を持たない古い設定でも壊れない）
// ---------------------------------------------------------------------

test("SCM-14: salesCapacityModel を持たない旧パラメータでも既定 perMarket として動作する（移行互換）", () => {
  const legacy: SalesParameters = { ...SALES_PARAMETERS_V1 };
  delete (legacy as { salesCapacityModel?: SalesCapacityModel }).salesCapacityModel;
  const c = computeMarketSalesCapacities(100, evenDemand(MARKETS), evenHeadcount(MARKETS, 100), legacy);
  for (const m of MARKETS) {
    assert.equal(c.get(m), unwrapUnit(processingCapacity(20, legacy)));
  }
  // 明示的に perMarket を渡した場合も同値。
  const explicit = computeMarketSalesCapacities(100, evenDemand(MARKETS), evenHeadcount(MARKETS, 100), legacy, SALES_CAPACITY_MODEL_PER_MARKET);
  for (const m of MARKETS) assert.equal(c.get(m), explicit.get(m));
});

// ---------------------------------------------------------------------
// SCM-15 会社能力式そのものの健全性
// ---------------------------------------------------------------------

test("SCM-15: 会社能力式は 0人で baseline、単調増加、上限へ漸近する", () => {
  assert.equal(companySalesOrganizationCapacity(0, COMPANY_WIDE), COMPANY_WIDE.companyBaselineCapacityTons);
  let previous = -Infinity;
  for (const h of [0, 10, 60, 100, 190, 400, 10_000]) {
    const c = companySalesOrganizationCapacity(h, COMPANY_WIDE);
    assert.ok(c > previous, "単調増加");
    assert.ok(c < COMPANY_WIDE.companyBaselineCapacityTons + COMPANY_WIDE.companyCapacityMaxIncrementTons, "漸近上限を超えない");
    previous = c;
  }
  // 半飽和点でちょうど増分の半分。
  const half = companySalesOrganizationCapacity(COMPANY_WIDE.companyCapacitySaturationHeadcount, COMPANY_WIDE);
  assert.ok(Math.abs(half - (COMPANY_WIDE.companyBaselineCapacityTons + COMPANY_WIDE.companyCapacityMaxIncrementTons / 2)) < 1e-6);
  // 負の人数は0扱い（防御）。
  assert.equal(companySalesOrganizationCapacity(-10, COMPANY_WIDE), COMPANY_WIDE.companyBaselineCapacityTons);
});

// ---------------------------------------------------------------------
// SCM-16〜SCM-18 【Phase 6C §15】営業能力 SSoT
// 成約配分（sales/allocation.ts）が、販売計画の縮小に使ったのと**同じ能力**を
// 使うこと。従来は allocation.ts が processingCapacity() を自分で呼び直しており、
// 会社全体営業能力モデルを通らない二重制約になっていた。
// ---------------------------------------------------------------------

test("SCM-16: applyMarketSalesEffortCapacity は、実際に適用した会社×市場の能力を公開する", () => {
  const params = paramsWith(CASE_C);
  const plans = MARKETS.map((m) => plan("BAL", m, "hoso", 20_000, 24));
  const { capacityByCompanyMarket } = applyMarketSalesEffortCapacity(plans, params);

  const effortDemand = new Map<DemandMarketId, number>(MARKETS.map((m) => [m, params.salesEffortCoefficients.hoso * 20_000]));
  const expected = computeMarketSalesCapacities(120, effortDemand, evenHeadcount(MARKETS, 120), params);
  for (const m of MARKETS) {
    assert.ok(
      Math.abs((capacityByCompanyMarket.get(`BAL::${m}`) ?? 0) - (expected.get(m) ?? 0)) < 1e-9,
      `${m}: 公開された能力がモデルの値と一致すること`
    );
  }
});

test("SCM-17: 既定（perMarket）では、公開される能力が従来の processingCapacity と同値", () => {
  const plans = MARKETS.map((m) => plan("BAL", m, "hoso", 1_000, 24));
  const { capacityByCompanyMarket } = applyMarketSalesEffortCapacity(plans, SALES_PARAMETERS_V1);
  const legacy = unwrapUnit(processingCapacity(24, SALES_PARAMETERS_V1));
  for (const m of MARKETS) {
    assert.equal(capacityByCompanyMarket.get(`BAL::${m}`), legacy);
  }
});

test("SCM-18: 会社全体モデルでは、成約配分側の個社上限も会社全体能力を反映する（二重制約の解消）", () => {
  const params = paramsWith(CASE_C);
  // 会社の営業組織が小さいのに、市場ごとの人数配置だけは大きく見える状況を作る。
  const plans = MARKETS.map((m) => plan("BAL", m, "hoso", 50_000, 40));
  const { capacityByCompanyMarket } = applyMarketSalesEffortCapacity(plans, params);
  const total = [...capacityByCompanyMarket.values()].reduce((a, b) => a + b, 0);
  const companyCeiling = companySalesOrganizationCapacity(200, CASE_C) * marketFragmentationFactor(5, CASE_C);
  assert.ok(total <= companyCeiling + 1e-6, "成約配分へ渡る能力の合計も会社全体能力を超えない");

  // 旧実装（市場ごとに processingCapacity(40) を独立適用）はこの上限を超えていた。
  const legacyTotal = MARKETS.length * unwrapUnit(processingCapacity(40, params));
  assert.ok(legacyTotal > companyCeiling, "旧実装は会社全体能力を超えていた（この差が二重制約の正体）");
});
