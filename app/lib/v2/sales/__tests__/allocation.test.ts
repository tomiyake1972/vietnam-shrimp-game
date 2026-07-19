import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateMarketProduct } from "../allocation";
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
