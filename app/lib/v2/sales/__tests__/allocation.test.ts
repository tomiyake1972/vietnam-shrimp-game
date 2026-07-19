import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateMarketProduct, computeCompetitivenessBreakdown, computeCompetitivenessWeight } from "../allocation";
import { SALES_PARAMETERS_V1 } from "../parameters";
import { CompanySalesPlanEntry, SalesValidationError } from "../types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";

const P1 = period(2015, 1);
const BASE_PRICE = usdPerHosoEqKg(4.5);

function entry(companyId: string, overrides: Partial<CompanySalesPlanEntry> = {}): CompanySalesPlanEntry {
  return {
    companyId,
    market: "CN",
    product: "hoso",
    desiredQuantity: hosoEqTons(1000),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 5,
    ...overrides,
  };
}

test("全社合計成約量（外部選択肢含む）は対象需要を超えない", () => {
  const entries = ["A", "B", "C", "D", "E"].map((id) => entry(id, { salesForceHeadcount: 8 }));
  const targetDemand = hosoEqTons(3000);
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, targetDemand, SALES_PARAMETERS_V1);

  const totalCompanies = result.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);
  const total = totalCompanies + unwrapUnit(result.externalOptionQuantity);
  assert.ok(total <= unwrapUnit(targetDemand) + 0.1, `total (${total}) should not exceed target demand (${unwrapUnit(targetDemand)})`);
});

test("各社成約量は販売希望量を超えない", () => {
  const entries = ["A", "B", "C", "D", "E"].map((id) => entry(id, { desiredQuantity: hosoEqTons(50), salesForceHeadcount: 40 }));
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(100000), SALES_PARAMETERS_V1);
  for (const c of result.companies) {
    assert.ok(unwrapUnit(c.allocatedQuantity) <= 50 + 1e-6, `company ${c.companyId} exceeded desiredQuantity`);
  }
});

test("各社成約量は営業処理能力を超えない", () => {
  const entries = ["A", "B", "C", "D", "E"].map((id, i) => entry(id, { desiredQuantity: hosoEqTons(1000000), salesForceHeadcount: i * 3 }));
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(1000000), SALES_PARAMETERS_V1);
  for (const c of result.companies) {
    assert.ok(unwrapUnit(c.allocatedQuantity) <= unwrapUnit(c.processingCapacity) + 1e-6, `company ${c.companyId} exceeded processing capacity`);
  }
});

test("入力順（配列の並び）を変えても結果が変わらない", () => {
  const entries = ["A", "B", "C", "D", "E"].map((id, i) => entry(id, { priceAdjustmentUsdPerHosoEqKg: (i - 2) * 0.1, salesForceHeadcount: i * 4 }));
  const shuffled = [entries[3], entries[0], entries[4], entries[1], entries[2]];

  const resultA = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(4000), SALES_PARAMETERS_V1);
  const resultB = allocateMarketProduct("CN", "hoso", P1, shuffled, BASE_PRICE, hosoEqTons(4000), SALES_PARAMETERS_V1);

  assert.deepEqual(resultA, resultB);
});

test("他条件一定で提示価格を上げると成約量が減少する（能力・希望量が制約にならない条件下）", () => {
  // 全社同じheadcount・非常に大きいdesiredQuantityにして、処理能力・希望量ではなく
  // 価格競争力だけが差を生む条件を作る。targetDemandも各社の処理能力を大きく下回る値にする。
  const priceAdjustments = [-0.3, -0.15, 0, 0.15, 0.3];
  const entries = priceAdjustments.map((adj, i) =>
    entry(`P${i}`, { priceAdjustmentUsdPerHosoEqKg: adj, desiredQuantity: hosoEqTons(1000000), salesForceHeadcount: 8 })
  );
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(3000), SALES_PARAMETERS_V1);

  const quantities = priceAdjustments.map((_, i) => {
    const c = result.companies.find((x) => x.companyId === `P${i}`)!;
    return unwrapUnit(c.allocatedQuantity);
  });

  for (let i = 1; i < quantities.length; i++) {
    assert.ok(quantities[i] < quantities[i - 1], `higher ask price should yield lower allocation: ${quantities.join(",")}`);
  }
});

test("他条件一定で営業人員を増やすと成約力（成約量）が上がるが、効果は逓減する", () => {
  // 需要・希望量を処理能力よりずっと大きくし、処理能力そのものが上限として効くようにする
  // （processingCapacity自体がheadcountについて逓減曲線であることはsalesForce.test.tsで検証済み）。
  const headcounts = [0, 10, 20, 30, 40];
  const entries = headcounts.map((h, i) => entry(`H${i}`, { salesForceHeadcount: h, desiredQuantity: hosoEqTons(1000000) }));
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(1000000), SALES_PARAMETERS_V1);

  const quantities = headcounts.map((_, i) => {
    const c = result.companies.find((x) => x.companyId === `H${i}`)!;
    return unwrapUnit(c.allocatedQuantity);
  });

  for (let i = 1; i < quantities.length; i++) {
    assert.ok(quantities[i] > quantities[i - 1], "more headcount should yield more allocation");
  }
  const deltas = quantities.slice(1).map((q, i) => q - quantities[i]);
  for (let i = 1; i < deltas.length; i++) {
    assert.ok(deltas[i] < deltas[i - 1], "marginal gain from additional headcount should shrink");
  }
});

test("営業人員だけを無制限に増やしても需要を超えて売れない（対象需要が上限になる）", () => {
  const entries = ["A"].map((id) => entry(id, { salesForceHeadcount: 1000000, desiredQuantity: hosoEqTons(1000000) }));
  const targetDemand = hosoEqTons(500);
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, targetDemand, SALES_PARAMETERS_V1);
  const total = result.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0) + unwrapUnit(result.externalOptionQuantity);
  assert.ok(Math.abs(total - unwrapUnit(targetDemand)) < 0.1);
  assert.ok(unwrapUnit(result.companies[0].allocatedQuantity) <= unwrapUnit(targetDemand) + 1e-6);
});

test("外部選択肢（5社以外の供給者・非購入）が存在し、5社が必ず全需要を獲得するわけではない", () => {
  const entries = ["A", "B", "C", "D", "E"].map((id) => entry(id, { salesForceHeadcount: 20, desiredQuantity: hosoEqTons(1000000) }));
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(1000000), SALES_PARAMETERS_V1);
  assert.ok(unwrapUnit(result.externalOptionQuantity) > 0);
});

test("上限に達した会社の未配分需要は、まだ上限に達していない会社へ再配分される", () => {
  // Aは非常に低い上限（希望量が小さい）、B〜Eは大きな上限。
  const entries = [
    entry("A", { desiredQuantity: hosoEqTons(10), salesForceHeadcount: 20 }),
    ...["B", "C", "D", "E"].map((id) => entry(id, { desiredQuantity: hosoEqTons(1000000), salesForceHeadcount: 20 })),
  ];
  const targetDemand = hosoEqTons(2000);
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, targetDemand, SALES_PARAMETERS_V1);

  const a = result.companies.find((c) => c.companyId === "A")!;
  assert.ok(Math.abs(unwrapUnit(a.allocatedQuantity) - 10) < 1e-6, "A should be capped exactly at its desiredQuantity");

  const others = result.companies.filter((c) => c.companyId !== "A");
  const totalOthers = others.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);
  // Aが得られなかった分（targetDemandからAの10を引いた分の一部）が、外部選択肢だけでなく
  // 残りの4社にも回っているはず（4社の合計配分が、Aと同じ重みだった場合の理論値
  // targetDemand*(1/5)*4=1600よりは小さくなるが、Aが受け取れなかった10近くの分は
  // どこかへ再配分されているため、他4社+外部の合計はtargetDemand-10と一致する）。
  const total = totalOthers + unwrapUnit(a.allocatedQuantity) + unwrapUnit(result.externalOptionQuantity);
  assert.ok(Math.abs(total - unwrapUnit(targetDemand)) < 0.1);
  assert.ok(totalOthers > 0);
});

test("国際基準価格（basePrice）そのものは配分結果に含まれるだけで変更されない", () => {
  const entries = ["A", "B"].map((id) => entry(id));
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(1000), SALES_PARAMETERS_V1);
  assert.equal(unwrapUnit(result.basePrice), unwrapUnit(BASE_PRICE));
});

test("提示価格が許容範囲外（basePriceに対する比率）だとSalesValidationErrorを投げる", () => {
  const tooLow = [entry("A", { priceAdjustmentUsdPerHosoEqKg: -10 })]; // askPrice would go far below minAskPriceRatioOfBase
  assert.throws(
    () => allocateMarketProduct("CN", "hoso", P1, tooLow, BASE_PRICE, hosoEqTons(1000), SALES_PARAMETERS_V1),
    SalesValidationError
  );

  const tooHigh = [entry("A", { priceAdjustmentUsdPerHosoEqKg: 100 })];
  assert.throws(
    () => allocateMarketProduct("CN", "hoso", P1, tooHigh, BASE_PRICE, hosoEqTons(1000), SALES_PARAMETERS_V1),
    SalesValidationError
  );
});

test("同じ会社が同じmarket×productに重複した販売計画を持つとSalesValidationErrorを投げる", () => {
  const dup = [entry("A"), entry("A", { priceAdjustmentUsdPerHosoEqKg: 0.1 })];
  assert.throws(() => allocateMarketProduct("CN", "hoso", P1, dup, BASE_PRICE, hosoEqTons(1000), SALES_PARAMETERS_V1), SalesValidationError);
});

test("対象市場・商品区分に一致しない販売計画は無視される", () => {
  const entries = [entry("A", { market: "US" }), entry("B", { product: "pd" }), entry("C", { market: "CN", product: "hoso" })];
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(1000), SALES_PARAMETERS_V1);
  assert.equal(result.companies.length, 1);
  assert.equal(result.companies[0].companyId, "C");
});

// --- 価格競争力の飽和（下限・上限）と個社の最大成約シェア（Task D差分） ---

test("通常範囲の値下げ（10%程度）では、他条件一定なら成約量が増える", () => {
  // 会社を2社だけにすると、いずれの成約量も対象需要に対する自然シェアが35%を
  // 超えやすく、maximumSupplierShare由来の上限が先に効いて価格差が見えなくなる。
  // そのため既存の「他条件一定で提示価格を上げると成約量が減少する」テストと同様、
  // 5社構成にして個社の自然シェアを35%未満に抑え、価格競争力の純粋な効果を見る。
  const entries = [
    entry("Z", { priceAdjustmentUsdPerHosoEqKg: 0, desiredQuantity: hosoEqTons(1000000), salesForceHeadcount: 8 }),
    entry("T", { priceAdjustmentUsdPerHosoEqKg: -0.1 * unwrapUnit(BASE_PRICE), desiredQuantity: hosoEqTons(1000000), salesForceHeadcount: 8 }),
    entry("F1", { priceAdjustmentUsdPerHosoEqKg: 0, desiredQuantity: hosoEqTons(1000000), salesForceHeadcount: 8 }),
    entry("F2", { priceAdjustmentUsdPerHosoEqKg: 0, desiredQuantity: hosoEqTons(1000000), salesForceHeadcount: 8 }),
    entry("F3", { priceAdjustmentUsdPerHosoEqKg: 0, desiredQuantity: hosoEqTons(1000000), salesForceHeadcount: 8 }),
  ];
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(3000), SALES_PARAMETERS_V1);
  const z = result.companies.find((c) => c.companyId === "Z")!;
  const t = result.companies.find((c) => c.companyId === "T")!;
  assert.ok(unwrapUnit(t.allocatedQuantity) > unwrapUnit(z.allocatedQuantity), "10%値引きの方が成約量が多いはず");
});

test("大幅値下げでも価格競争力（competitivenessWeight由来のpriceScore）が設定上限を超えない", () => {
  const params = SALES_PARAMETERS_V1;
  // minAskPriceRatioOfBase=0.5により、値引き率は50%未満でなければならない。上限(1.6)は
  // 約20%値引き（exp(3*0.2)=1.822）で既に到達するため、20%・30%・45%を比較する。
  const discounts = [0.2, 0.3, 0.45];
  const entries = discounts.map((d, i) =>
    entry(`D${i}`, {
      priceAdjustmentUsdPerHosoEqKg: -d * unwrapUnit(BASE_PRICE),
      desiredQuantity: hosoEqTons(1000000),
      salesForceHeadcount: 8,
    })
  );
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(20000), params);
  // 上限到達後は価格効果が増えないため、20%・30%・45%の3社は同一のcompetitivenessWeight（＝同一allocatedQuantity）になるはず。
  const weights = discounts.map((_, i) => result.companies.find((c) => c.companyId === `D${i}`)!.competitivenessWeight);
  assert.ok(Math.abs(weights[0] - weights[1]) < 1e-9, "20%と30%値引きのcompetitivenessWeightは一致するはず（上限到達済み）");
  assert.ok(Math.abs(weights[1] - weights[2]) < 1e-9, "30%と45%値引きのcompetitivenessWeightは一致するはず（上限到達済み）");

  const quantities = discounts.map((_, i) => unwrapUnit(result.companies.find((c) => c.companyId === `D${i}`)!.allocatedQuantity));
  assert.ok(Math.abs(quantities[0] - quantities[1]) < 0.1, "上限到達後は成約量も増えないはず（20% vs 30%）");
  assert.ok(Math.abs(quantities[1] - quantities[2]) < 0.1, "上限到達後は成約量も増えないはず（30% vs 45%）");
});

test("極端な安値・高い営業人員・大きな販売希望量を同時に設定しても、個社成約量が最大供給者シェアを超えない", () => {
  const params = SALES_PARAMETERS_V1;
  const extreme = entry("X", {
    priceAdjustmentUsdPerHosoEqKg: -0.45 * unwrapUnit(BASE_PRICE), // 45%値引き（許容範囲内の実質下限に近い極端な安値）
    salesForceHeadcount: 1000, // 非常に高い営業人員
    desiredQuantity: hosoEqTons(1000000), // 非常に大きい販売希望量
  });
  const others = ["B", "C", "D", "E"].map((id) => entry(id, { salesForceHeadcount: 5 }));
  const targetDemand = hosoEqTons(10000);
  const result = allocateMarketProduct("CN", "hoso", P1, [extreme, ...others], BASE_PRICE, targetDemand, params);

  const x = result.companies.find((c) => c.companyId === "X")!;
  const maxShareCap = unwrapUnit(targetDemand) * params.maximumSupplierShare;
  assert.ok(
    unwrapUnit(x.allocatedQuantity) <= maxShareCap + 0.1,
    `会社Xの成約量(${unwrapUnit(x.allocatedQuantity)})が最大供給者シェア上限(${maxShareCap})を超えている`
  );

  // 残余需要は他社・外部選択肢へ再配分される（Xの上限超過分が消えていない）。
  const totalOthers = result.companies.filter((c) => c.companyId !== "X").reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);
  const total = unwrapUnit(x.allocatedQuantity) + totalOthers + unwrapUnit(result.externalOptionQuantity);
  assert.ok(Math.abs(total - unwrapUnit(targetDemand)) < 0.1);
  assert.ok(totalOthers > 0, "Xがシェア上限で打ち切られた分は他社にも再配分されるはず");
});

test("承認済み取引枠（approvedAllocationCap）を指定した場合、その数量を超えない", () => {
  const params = SALES_PARAMETERS_V1;
  const capped = entry("A", {
    priceAdjustmentUsdPerHosoEqKg: -0.45 * unwrapUnit(BASE_PRICE),
    salesForceHeadcount: 1000,
    desiredQuantity: hosoEqTons(1000000),
    approvedAllocationCap: hosoEqTons(50),
  });
  const others = ["B", "C", "D", "E"].map((id) => entry(id, { salesForceHeadcount: 5 }));
  const targetDemand = hosoEqTons(10000);
  const result = allocateMarketProduct("CN", "hoso", P1, [capped, ...others], BASE_PRICE, targetDemand, params);

  const a = result.companies.find((c) => c.companyId === "A")!;
  assert.ok(unwrapUnit(a.allocatedQuantity) <= 50 + 1e-6, `会社Aの成約量(${unwrapUnit(a.allocatedQuantity)})がapprovedAllocationCap(50)を超えている`);

  // approvedAllocationCapは maximumSupplierShare由来の上限(10000*0.35=3500)より厳しいので、
  // それが優先して効いているはず（=50近辺で打ち切られる）。
  assert.ok(unwrapUnit(a.allocatedQuantity) > 0, "承認枠の範囲内では成約が発生するはず");
});

test("最大供給者シェア・承認済み取引枠を適用しても、入力順（配列の並び）を変えても結果が変わらない", () => {
  const entries = ["A", "B", "C", "D", "E"].map((id, i) =>
    entry(id, {
      priceAdjustmentUsdPerHosoEqKg: -0.3 * unwrapUnit(BASE_PRICE),
      salesForceHeadcount: i * 4,
      desiredQuantity: hosoEqTons(1000000),
      approvedAllocationCap: i === 0 ? hosoEqTons(100) : undefined,
    })
  );
  const shuffled = [entries[3], entries[0], entries[4], entries[1], entries[2]];

  const resultA = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(4000), SALES_PARAMETERS_V1);
  const resultB = allocateMarketProduct("CN", "hoso", P1, shuffled, BASE_PRICE, hosoEqTons(4000), SALES_PARAMETERS_V1);

  assert.deepEqual(resultA, resultB);
});

// --- 【Phase 7B】competitivenessBreakdown（説明用データ）のテスト ---
// UI（会社ラボ・成約競争力の説明）が読み取り専用で表示するためのデータであり、
// 計算式自体はcomputeCompetitivenessWeightと完全に同一である（内訳への分解のみ）。

test("受入確認D-1: competitivenessBreakdownの5つのcontribution合計はcompetitivenessWeightと厳密に一致する", () => {
  const params = SALES_PARAMETERS_V1;
  const entries = ["A", "B", "C", "D", "E"].map((id, i) =>
    entry(id, {
      priceAdjustmentUsdPerHosoEqKg: (i - 2) * 0.05 * unwrapUnit(BASE_PRICE),
      salesForceHeadcount: i * 3,
      customerRelationship: undefined,
      qualityReputation: undefined,
      deliveryReliability: undefined,
    })
  );
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(4000), params);
  for (const c of result.companies) {
    const b = c.competitivenessBreakdown;
    const sum = b.priceContribution + b.coverageContribution + b.relationshipContribution + b.qualityContribution + b.deliveryReliabilityContribution;
    assert.equal(sum, c.competitivenessWeight, `会社${c.companyId}: breakdown合計とcompetitivenessWeightが一致しない`);
  }
});

test("受入確認D-2: computeCompetitivenessBreakdownとcomputeCompetitivenessWeightは同一入力に対し整合する（単体関数レベル）", () => {
  const params = SALES_PARAMETERS_V1;
  const e = entry("A", { customerRelationship: undefined, qualityReputation: undefined, deliveryReliability: undefined });
  const askPrice = usdPerHosoEqKg(unwrapUnit(BASE_PRICE) * 0.8);
  const b = computeCompetitivenessBreakdown(e, askPrice, BASE_PRICE, 0.7, params);
  const w = computeCompetitivenessWeight(e, askPrice, BASE_PRICE, 0.7, params);
  const sum = b.priceContribution + b.coverageContribution + b.relationshipContribution + b.qualityContribution + b.deliveryReliabilityContribution;
  assert.equal(sum, w);
});

test("受入確認D-3: 価格競争力が上限(maximumPriceCompetitiveness)に到達した場合、isPriceScoreAtCeiling=trueになり、さらなる値引きでもpriceContributionが変化しない", () => {
  const params = SALES_PARAMETERS_V1;
  // 20%値引きで既に上限(1.6)に到達する設定（他のテストと同じ根拠）。
  const moderate = entry("M", { priceAdjustmentUsdPerHosoEqKg: -0.2 * unwrapUnit(BASE_PRICE), desiredQuantity: hosoEqTons(1000000), salesForceHeadcount: 8 });
  const deep = entry("F", { priceAdjustmentUsdPerHosoEqKg: -0.45 * unwrapUnit(BASE_PRICE), desiredQuantity: hosoEqTons(1000000), salesForceHeadcount: 8 });
  const result = allocateMarketProduct("CN", "hoso", P1, [moderate, deep], BASE_PRICE, hosoEqTons(20000), params);
  const m = result.companies.find((c) => c.companyId === "M")!;
  const f = result.companies.find((c) => c.companyId === "F")!;
  assert.equal(m.competitivenessBreakdown.isPriceScoreAtCeiling, true);
  assert.equal(f.competitivenessBreakdown.isPriceScoreAtCeiling, true);
  assert.equal(m.competitivenessBreakdown.priceContribution, f.competitivenessBreakdown.priceContribution);
  assert.equal(m.competitivenessBreakdown.clampedPriceScore, params.maximumPriceCompetitiveness);
});

test("受入確認D-4: 価格競争力が上限未満の通常提示価格では、isPriceScoreAtCeiling=falseになる", () => {
  const params = SALES_PARAMETERS_V1;
  const normal = entry("N", { priceAdjustmentUsdPerHosoEqKg: 0, salesForceHeadcount: 5 });
  const result = allocateMarketProduct("CN", "hoso", P1, [normal, entry("Z", { salesForceHeadcount: 5 })], BASE_PRICE, hosoEqTons(2000), params);
  const n = result.companies.find((c) => c.companyId === "N")!;
  assert.equal(n.competitivenessBreakdown.isPriceScoreAtCeiling, false);
});
