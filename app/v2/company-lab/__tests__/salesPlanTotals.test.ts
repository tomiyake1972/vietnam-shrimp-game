// ShrimpX V2 — DecisionEditor: 販売希望数量 合計表示のテスト（SALES-TOTAL-1〜7）

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSalesPlanTotals, SalesPlanTotalsRow } from "../salesPlanTotals";

const ROWS: readonly SalesPlanTotalsRow[] = [
  { market: "CN", product: "hoso", desiredQuantity: 1000 },
  { market: "CN", product: "pd", desiredQuantity: 200 },
  { market: "CN", product: "vap", desiredQuantity: 50 },
  { market: "US", product: "hoso", desiredQuantity: 2000 },
  { market: "US", product: "pd", desiredQuantity: 300 },
  { market: "US", product: "vap", desiredQuantity: 100 },
  { market: "EU", product: "hoso", desiredQuantity: 1500 },
  { market: "EU", product: "pd", desiredQuantity: 250 },
  { market: "EU", product: "vap", desiredQuantity: 75 },
];

// SALES-TOTAL-1: 商品別合計が正しい
test("SALES-TOTAL-1: 商品別合計（全市場の合計）が正しい", () => {
  const totals = computeSalesPlanTotals(ROWS);
  assert.equal(totals.productTotalTons("hoso"), 1000 + 2000 + 1500);
  assert.equal(totals.productTotalTons("pd"), 200 + 300 + 250);
  assert.equal(totals.productTotalTons("vap"), 50 + 100 + 75);
});

// SALES-TOTAL-2: 市場別合計が正しい
test("SALES-TOTAL-2: 市場別合計（全商品の合計）が正しい", () => {
  const totals = computeSalesPlanTotals(ROWS);
  assert.equal(totals.marketTotalTons("CN"), 1000 + 200 + 50);
  assert.equal(totals.marketTotalTons("US"), 2000 + 300 + 100);
  assert.equal(totals.marketTotalTons("EU"), 1500 + 250 + 75);
});

// SALES-TOTAL-3: 全体合計が正しい
test("SALES-TOTAL-3: 全体合計が全行の総和と一致する", () => {
  const totals = computeSalesPlanTotals(ROWS);
  const expected = ROWS.reduce((sum, r) => sum + r.desiredQuantity, 0);
  assert.equal(totals.grandTotalTons, expected);
});

// SALES-TOTAL-4: 入力変更で即時更新（pure derived valueであることの確認）
test("SALES-TOTAL-4: 1セルの値を変更すると、対応する商品合計・市場合計・全体合計だけが変わる", () => {
  const before = computeSalesPlanTotals(ROWS);
  const changed = ROWS.map((r) => (r.market === "US" && r.product === "hoso" ? { ...r, desiredQuantity: r.desiredQuantity + 1000 } : r));
  const after = computeSalesPlanTotals(changed);

  assert.equal(after.cellTons("US", "hoso"), before.cellTons("US", "hoso") + 1000);
  assert.equal(after.productTotalTons("hoso"), before.productTotalTons("hoso") + 1000);
  assert.equal(after.marketTotalTons("US"), before.marketTotalTons("US") + 1000);
  assert.equal(after.grandTotalTons, before.grandTotalTons + 1000);
  // 無関係のセル・合計は変わらない。
  assert.equal(after.productTotalTons("pd"), before.productTotalTons("pd"));
  assert.equal(after.marketTotalTons("CN"), before.marketTotalTons("CN"));
});

// SALES-TOTAL-5: 空欄/undefinedでNaNにならない
test("SALES-TOTAL-5: desiredQuantityがundefined/NaNの行があっても、合計はNaNにならず0として扱われる", () => {
  const rowsWithGaps: readonly SalesPlanTotalsRow[] = [
    { market: "CN", product: "hoso", desiredQuantity: 1000 },
    { market: "CN", product: "pd", desiredQuantity: undefined as unknown as number },
    { market: "CN", product: "vap", desiredQuantity: NaN },
  ];
  const totals = computeSalesPlanTotals(rowsWithGaps);
  assert.equal(totals.cellTons("CN", "pd"), 0);
  assert.equal(totals.cellTons("CN", "vap"), 0);
  assert.equal(totals.marketTotalTons("CN"), 1000);
  assert.ok(Number.isFinite(totals.grandTotalTons), "全体合計にNaNが混入している");
  assert.equal(totals.grandTotalTons, 1000);
});

// SALES-TOTAL-6: 全市場・全商品0 → 合計0
test("SALES-TOTAL-6: すべての行が0のとき、商品別・市場別・全体合計もすべて0になる", () => {
  const zeroRows = ROWS.map((r) => ({ ...r, desiredQuantity: 0 }));
  const totals = computeSalesPlanTotals(zeroRows);
  for (const product of totals.products) assert.equal(totals.productTotalTons(product), 0);
  for (const market of totals.markets) assert.equal(totals.marketTotalTons(market), 0);
  assert.equal(totals.grandTotalTons, 0);
});

// SALES-TOTAL-7: 小数入力でも正しく集計
test("SALES-TOTAL-7: 小数を含む入力でも、丸めずに正しく集計される", () => {
  const decimalRows: readonly SalesPlanTotalsRow[] = [
    { market: "CN", product: "hoso", desiredQuantity: 100.25 },
    { market: "CN", product: "pd", desiredQuantity: 50.5 },
    { market: "US", product: "hoso", desiredQuantity: 200.1 },
  ];
  const totals = computeSalesPlanTotals(decimalRows);
  assert.equal(totals.marketTotalTons("CN"), 100.25 + 50.5);
  assert.equal(totals.productTotalTons("hoso"), 100.25 + 200.1);
  assert.ok(Math.abs(totals.grandTotalTons - (100.25 + 50.5 + 200.1)) < 1e-9);
});

// 市場・商品の並び順は登場順（既存DecisionEditorの並びをそのまま反映する）
test("市場・商品の並び順は、渡した行の登場順をそのまま保持する", () => {
  const totals = computeSalesPlanTotals(ROWS);
  assert.deepEqual(totals.markets, ["CN", "US", "EU"]);
  assert.deepEqual(totals.products, ["hoso", "pd", "vap"]);
});
