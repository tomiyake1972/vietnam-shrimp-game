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
//
// 【Test15統合branchでの再ベースライン】営業処理能力曲線の再校正
// （capacityMaxIncrementTons 4800→24000 / capacitySaturationHeadcount 10→70、
// sales/parameters.ts）により、C(h) が変わったため、旧曲線下のTest14実測値は
// そのままでは再現しない。期待値は校正後の実測値へ更新した。
//
// 入力（headcount・商品別desired）はTest14実測のまま一切変更していない。
// 変わったのは「その入力に対してエンジンが返す値」だけである。トレーサビリティの
// ため、旧曲線下のTest14 Export API実測値も各定義の直後にコメントで残す。
//
// 本テストが守る性質そのもの（営業容量は単調増加・限界効果は逓減・商品別営業工数
// 係数が効く・effort容量制約で比例縮小される）は再校正後も変更していない。

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

// --- Turn1（入力はBAL_company_Test14_turn1.json実測。expectedAllocatedは営業校正後の実測値） ---
// 旧曲線（k=10/M=4800）下のTest14 Export API実測値:
//   CN 1294.96+258.99+64.75=1618.70 / US 628.57+392.86+157.14=1178.57
//   EU 989.30+659.54+131.91=1780.75 / JP 100+100+100=300 / OTHER 200+200+50=450
const TURN1_MARKETS: Record<string, { headcount: number; desired: Record<Product, number>; expectedAllocated: number }> = {
  CN: { headcount: 5, desired: { hoso: 2000, pd: 400, vap: 100 }, expectedAllocated: 1618.71 },
  US: { headcount: 4, desired: { hoso: 800, pd: 500, vap: 200 }, expectedAllocated: 1122.97 },
  EU: { headcount: 7, desired: { hoso: 1500, pd: 1000, vap: 200 }, expectedAllocated: 1948.76 },
  // JPは校正後は営業容量が希望量を上回るため縮小されない（isConstrained=false）。
  JP: { headcount: 1, desired: { hoso: 100, pd: 100, vap: 100 }, expectedAllocated: 300.0 },
  OTHER: { headcount: 1, desired: { hoso: 200, pd: 200, vap: 50 }, expectedAllocated: 410.36 },
};

// --- Turn2（入力はBAL_company_Test14_turn2.json実測。expectedAllocatedは営業校正後の実測値） ---
// 旧曲線（k=10/M=4800）下のTest14 Export API実測値:
//   CN 1335.63+400.69+333.91=2070.23 / US 542.63+813.95+271.32=1627.90
//   EU 883.46+588.97+294.49=1766.92 / JP 260.17+312.20+312.20=884.57
//   OTHER 418.60+279.07+348.84=1046.51
const TURN2_MARKETS: Record<string, { headcount: number; desired: Record<Product, number>; expectedAllocated: number }> = {
  CN: { headcount: 12, desired: { hoso: 4000, pd: 1200, vap: 1000 }, expectedAllocated: 2726.97 },
  US: { headcount: 8, desired: { hoso: 2000, pd: 3000, vap: 1000 }, expectedAllocated: 1856.89 },
  EU: { headcount: 9, desired: { hoso: 3000, pd: 2000, vap: 1000 }, expectedAllocated: 2095.84 },
  JP: { headcount: 4, desired: { hoso: 1000, pd: 1200, vap: 1200 }, expectedAllocated: 842.85 },
  OTHER: { headcount: 5, desired: { hoso: 1200, pd: 800, vap: 1000 }, expectedAllocated: 1046.51 },
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

test("Turn1→Turn2: 全社合計成約量が営業校正後の実測値（5,400.8t→8,569.1t）と一致する", () => {
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
  approxEqual(turn1Total, 5400.8, 3, "Turn1合計成約量");
  approxEqual(turn2Total, 8569.07, 3, "Turn2合計成約量");
});

test("headcount 18→38（+111%）に対し、営業容量（effort-t）が+86.6%増える（営業校正後。旧曲線では+61.2%しか増えなかった）", () => {
  const turn1Capacity = Object.values(TURN1_MARKETS).reduce((sum, m) => sum + unwrapUnit(processingCapacity(m.headcount, PARAMS)), 0);
  const turn2Capacity = Object.values(TURN2_MARKETS).reduce((sum, m) => sum + unwrapUnit(processingCapacity(m.headcount, PARAMS)), 0);
  const growthRatio = turn2Capacity / turn1Capacity - 1;
  approxEqual(turn1Capacity, 6755.18, 1, "Turn1総容量");
  approxEqual(turn2Capacity, 12605.22, 1, "Turn2総容量");
  approxEqual(growthRatio, 0.866, 0.01, "容量成長率");
  // 【Test15校正の受入条件】人員+111%に対し容量増が+61.2%しかない（旧曲線）状態では
  // 営業投資の判断がゲームとして成立しなかった。校正後は増員が十分に報われることを固定する。
  assert.ok(growthRatio >= 0.8, `18人→38人の営業容量増加が不十分（+${(growthRatio * 100).toFixed(1)}%）`);
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

  // 単調増加は任意の点列で成立する。
  const points = [18, 25, 38, 50, 75, 100, 1000];
  const sales = points.map(totalSalesFor);

  for (let i = 1; i < sales.length; i++) {
    assert.ok(sales[i] >= sales[i - 1] - 1e-6, `総人数${points[i]}での成約量は${points[i - 1]}以上であるべき（単調増加）`);
  }

  // 逓減性は、市場別人数の整数丸め（Math.round）が入らない点列で確認する。
  // 総人数が38の倍数のときだけ各市場の人数が厳密に整数になり、丸めによる
  // ±1人のジッタが限界値に乗らない（校正後の曲線では、18/25/38/50…のような
  // 任意点列だと丸め由来で限界値が0.4%程度前後し、逓減の判定が不安定になる。
  // これは曲線の性質ではなく離散化の副作用であり、逓減性そのものは
  // C(h)=base+M*h/(h+k) が凹関数であることから常に成立する）。
  const proportionalPoints = [38, 76, 114, 190, 380, 3800];
  const proportionalSales = proportionalPoints.map(totalSalesFor);
  const marginal = proportionalSales.map((s, i) =>
    i === 0 ? null : (s - proportionalSales[i - 1]) / (proportionalPoints[i] - proportionalPoints[i - 1])
  );
  for (let i = 2; i < marginal.length; i++) {
    assert.ok(
      (marginal[i] as number) <= (marginal[i - 1] as number) + 1e-6,
      `追加1人あたりの成約量増分（marginal）は人数が増えるほど逓減するべき（${proportionalPoints[i - 1]}人:${(marginal[i - 1] as number).toFixed(2)} → ${proportionalPoints[i]}人:${(marginal[i] as number).toFixed(2)}）`
    );
  }

  approxEqual(sales[2], 8569.1, 5, "総人数38人（実績）での推定成約量");
});

test("無限人数の理論上限は希望量合計24,600トン（Turn2の商品構成を固定した場合）に漸近し、それを超えない", () => {
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
  const desiredTotal = Object.values(marketDesired).reduce((sum, d) => sum + d.hoso + d.pd + d.vap, 0);
  approxEqual(desiredTotal, 24600, 1e-9, "Turn2の希望量合計");

  // 【営業校正後の変化】旧曲線（k=10/M=4800、1市場あたりの漸近上限5,000 effort-t）では、
  // 人数を無限に増やしても営業容量が希望量に届かず、理論上限は約16,455tで頭打ちだった
  // （＝商品構成上、希望量24,600t自体が到達不可能）。校正後（M=24000、1市場あたりの
  // 漸近上限24,200 effort-t）は営業容量が希望量を上回るため、容量制約は最終的に外れ、
  // 上限は希望量そのものへ収束する。
  approxEqual(ceiling, 24600.0, 5, "商品構成固定時の理論上限（無限人数）");
  // 営業容量をいくら増やしても、希望量を超える成約は決して発生しない（縮小のみで増幅しない）。
  assert.ok(ceiling <= desiredTotal + 1e-6, "理論上限が希望量合計を超えている（営業容量は希望量を増幅してはならない）");
});

test("coverageScoreは0〜1の範囲に収まり、単調増加する（headcount=0でもbaseline分は残る）", () => {
  const zero = salesCoverageScore(0, PARAMS);
  const ten = salesCoverageScore(10, PARAMS);
  const large = salesCoverageScore(100000, PARAMS);
  approxEqual(zero, 0.15, 1e-9, "headcount=0のカバレッジ");
  assert.ok(ten > zero && ten < 1, "headcount=10のカバレッジはbaselineと1の間");
  assert.ok(large < 1 && large > 0.999, "headcountが非常に大きいとき1に漸近するが超えない");
});
