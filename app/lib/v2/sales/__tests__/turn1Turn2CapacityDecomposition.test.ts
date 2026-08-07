// ShrimpX V2 — Test14 BAL社 Turn1/Turn2 実データに基づく営業容量分解の回帰テスト
//
// 【目的】docs/standard_ai/TEST14_TURN1_VS_TURN2_SALES_CAPACITY_DECOMPOSITION.md の
// 分析結果（実際の管理者Export API出力データ）が、実際のsalesForce.ts/marketEffort.tsの
// 純粋関数と数値レベルで一致することを固定するための回帰テスト。営業人員数を増やしても
// 販売量が線形に伸びない現象（飽和曲線）・商品別営業工数係数・effort容量制約による
// 比例縮小が、コード変更で意図せず変わってしまわないことを検知する。
//
// 【スコープについて】本テストは診断・検証専用であり、production決定ロジック
// （sales engine / market engine / production decision / Standard AI / Worker / finance）
// を一切変更しない。既存のsalesForce.ts/marketEffort.tsの純粋関数をそのまま呼ぶのみ。

import { test } from "node:test";
import assert from "node:assert/strict";
import { processingCapacity, salesCoverageScore } from "../salesForce";
import { computeMarketSalesEffort, salesEffortWeightedQuantity } from "../marketEffort";
import { SALES_PARAMETERS_V1 } from "../parameters";
import { unwrapUnit } from "../../core/units";
import { Product } from "../../market/types";

const PARAMS = SALES_PARAMETERS_V1;

function approxEqual(actual: number, expected: number, tolerance: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected≈${expected}, actual=${actual}, diff=${Math.abs(actual - expected)}`
  );
}

// --- Turn1実績（BAL_company_Test14_turn1.json / all_companies_Test14_turn1.json より） ---
const TURN1_MARKETS: Record<string, { headcount: number; desired: Record<Product, number>; expectedAllocated: number }> = {
  CN: { headcount: 5, desired: { hoso: 2000, pd: 400, vap: 100 }, expectedAllocated: 1294.96 + 258.99 + 64.75 },
  US: { headcount: 4, desired: { hoso: 800, pd: 500, vap: 200 }, expectedAllocated: 628.57 + 392.86 + 157.14 },
  EU: { headcount: 7, desired: { hoso: 1500, pd: 1000, vap: 200 }, expectedAllocated: 989.3 + 659.54 + 131.91 },
  JP: { headcount: 1, desired: { hoso: 100, pd: 100, vap: 100 }, expectedAllocated: 100 + 100 + 100 },
  OTHER: { headcount: 1, desired: { hoso: 200, pd: 200, vap: 50 }, expectedAllocated: 200 + 200 + 50 },
};

// --- Turn2実績（BAL_company_Test14_turn2.json / all_companies_Test14_turn2.json より） ---
const TURN2_MARKETS: Record<string, { headcount: number; desired: Record<Product, number>; expectedAllocated: number }> = {
  CN: { headcount: 12, desired: { hoso: 4000, pd: 1200, vap: 1000 }, expectedAllocated: 1335.63 + 400.69 + 333.91 },
  US: { headcount: 8, desired: { hoso: 2000, pd: 3000, vap: 1000 }, expectedAllocated: 542.63 + 813.95 + 271.32 },
  EU: { headcount: 9, desired: { hoso: 3000, pd: 2000, vap: 1000 }, expectedAllocated: 883.46 + 588.97 + 294.49 },
  JP: { headcount: 4, desired: { hoso: 1000, pd: 1200, vap: 1200 }, expectedAllocated: 260.17 + 312.2 + 312.2 },
  OTHER: { headcount: 5, desired: { hoso: 1200, pd: 800, vap: 1000 }, expectedAllocated: 418.6 + 279.07 + 348.84 },
};

test("Turn1: 5市場すべてでcomputeMarketSalesEffortの縮小後数量が実データのallocatedQuantity合計と一致する", () => {
  for (const [market, m] of Object.entries(TURN1_MARKETS)) {
    const result = computeMarketSalesEffort(m.headcount, m.desired, PARAMS);
    const adjustedTotal = result.adjustedQuantityByProduct.hoso + result.adjustedQuantityByProduct.pd + result.adjustedQuantityByProduct.vap;
    approxEqual(adjustedTotal, m.expectedAllocated, 2, `Turn1 市場${market}の縮小後合計`);
  }
});

test("Turn2: 5市場すべてでcomputeMarketSalesEffortの縮小後数量が実データのallocatedQuantity合計と一致する", () => {
  for (const [market, m] of Object.entries(TURN2_MARKETS)) {
    const result = computeMarketSalesEffort(m.headcount, m.desired, PARAMS);
    const adjustedTotal = result.adjustedQuantityByProduct.hoso + result.adjustedQuantityByProduct.pd + result.adjustedQuantityByProduct.vap;
    approxEqual(adjustedTotal, m.expectedAllocated, 2, `Turn2 市場${market}の縮小後合計`);
  }
});

test("Turn1→Turn2: 全社合計成約量が実データ（5,328.0t→7,396.1t）と一致する", () => {
  let turn1Total = 0;
  for (const m of Object.values(TURN1_MARKETS)) {
    const r = computeMarketSalesEffort(m.headcount, m.desired, PARAMS);
    turn1Total += r.adjustedQuantityByProduct.hoso + r.adjustedQuantityByProduct.pd + r.adjustedQuantityByProduct.vap;
  }
  let turn2Total = 0;
  for (const m of Object.values(TURN2_MARKETS)) {
    const r = computeMarketSalesEffort(m.headcount, m.desired, PARAMS);
    turn2Total += r.adjustedQuantityByProduct.hoso + r.adjustedQuantityByProduct.pd + r.adjustedQuantityByProduct.vap;
  }
  approxEqual(turn1Total, 5328.02, 3, "Turn1合計成約量");
  approxEqual(turn2Total, 7396.13, 3, "Turn2合計成約量");
});

test("headcount 18→38（+111%）に対し、営業容量（effort-t）の増加は+61.2%程度に留まる（飽和曲線の実効果）", () => {
  const turn1Capacity = Object.values(TURN1_MARKETS).reduce((sum, m) => sum + unwrapUnit(processingCapacity(m.headcount, PARAMS)), 0);
  const turn2Capacity = Object.values(TURN2_MARKETS).reduce((sum, m) => sum + unwrapUnit(processingCapacity(m.headcount, PARAMS)), 0);
  const growthRatio = turn2Capacity / turn1Capacity - 1;
  approxEqual(turn1Capacity, 6820.6, 1, "Turn1総容量");
  approxEqual(turn2Capacity, 10996.6, 1, "Turn2総容量");
  approxEqual(growthRatio, 0.612, 0.01, "容量成長率");
});

test("effort係数(hoso=1.0/pd=1.2/vap=3.0)がsalesEffortWeightedQuantityに反映されている", () => {
  const q = salesEffortWeightedQuantity({ hoso: 4000, pd: 1200, vap: 1000 }, PARAMS);
  approxEqual(q, 8440, 0.01, "CN市場Turn2のeffort換算希望量");
});

test("反実仮想の単調性: 市場配分比率を固定したまま総人数を増やすと、成約量は単調増加するが増分は逓減する（限界効果の低下）", () => {
  const marketWeights: Record<string, number> = { CN: 12, US: 8, EU: 9, JP: 4, OTHER: 5 };
  const marketDesired: Record<string, Record<Product, number>> = {
    CN: TURN2_MARKETS.CN.desired,
    US: TURN2_MARKETS.US.desired,
    EU: TURN2_MARKETS.EU.desired,
    JP: TURN2_MARKETS.JP.desired,
    OTHER: TURN2_MARKETS.OTHER.desired,
  };
  const totalWeight = Object.values(marketWeights).reduce((s, w) => s + w, 0);

  function totalSalesFor(headcountTotal: number): number {
    let total = 0;
    for (const [market, weight] of Object.entries(marketWeights)) {
      const h = Math.round((headcountTotal * weight) / totalWeight);
      const r = computeMarketSalesEffort(h, marketDesired[market], PARAMS);
      total += r.adjustedQuantityByProduct.hoso + r.adjustedQuantityByProduct.pd + r.adjustedQuantityByProduct.vap;
    }
    return total;
  }

  const points = [18, 25, 38, 50, 75, 100, 1000];
  const sales = points.map(totalSalesFor);

  for (let i = 1; i < sales.length; i++) {
    assert.ok(sales[i] >= sales[i - 1] - 1e-6, `総人数${points[i]}での成約量は${points[i - 1]}以上であるべき（単調増加）`);
  }

  const marginal = sales.map((s, i) => (i === 0 ? null : (s - sales[i - 1]) / (points[i] - points[i - 1])));
  for (let i = 2; i < marginal.length; i++) {
    assert.ok(
      (marginal[i] as number) <= (marginal[i - 1] as number) + 1e-6,
      "追加1人あたりの成約量増分（marginal）は人数が増えるほど逓減するべき"
    );
  }

  approxEqual(sales[2], 7396.1, 5, "総人数38人（実績）での推定成約量");
});

test("無限人数の理論上限は約16,446トン（Turn2の商品構成を固定した場合）に漸近する", () => {
  const marketDesired: Record<string, Record<Product, number>> = {
    CN: TURN2_MARKETS.CN.desired,
    US: TURN2_MARKETS.US.desired,
    EU: TURN2_MARKETS.EU.desired,
    JP: TURN2_MARKETS.JP.desired,
    OTHER: TURN2_MARKETS.OTHER.desired,
  };
  const veryLargeHeadcount = 10_000_000;
  let ceiling = 0;
  for (const desired of Object.values(marketDesired)) {
    const r = computeMarketSalesEffort(veryLargeHeadcount, desired, PARAMS);
    ceiling += r.adjustedQuantityByProduct.hoso + r.adjustedQuantityByProduct.pd + r.adjustedQuantityByProduct.vap;
  }
  approxEqual(ceiling, 16454.8, 5, "商品構成固定時の理論上限（無限人数）");
  // Turn2希望量24,600tは、商品構成をこのまま固定する限り、人数を無限に増やしても到達不可能。
  assert.ok(ceiling < 24600, "理論上限は希望量24,600tより低いはず（商品構成上、希望量自体が過大）");
});

test("coverageScoreは0〜1の範囲に収まり、単調増加する（headcount=0でもbaseline分は残る）", () => {
  const zero = salesCoverageScore(0, PARAMS);
  const ten = salesCoverageScore(10, PARAMS);
  const large = salesCoverageScore(100000, PARAMS);
  approxEqual(zero, 0.15, 1e-9, "headcount=0のカバレッジ");
  assert.ok(ten > zero && ten < 1, "headcount=10のカバレッジはbaselineと1の間");
  assert.ok(large < 1 && large > 0.999, "headcountが非常に大きいとき1に漸近するが超えない");
});
