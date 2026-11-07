// ShrimpX V2 — SALES 供給上限の目安（テストプレイ指摘①・2026-11）の検算
//
// 【このテストが守るもの】
//   1. 上限 ＝ 完成品在庫 ＋ 当期の実効加工能力（それ以外を足さない）。
//   2. 新規販売に回せる量 ＝ 上限 − 受注残（マイナスにしない）。
//   3. 実効加工能力が取得できない商品は 0 で埋めず null にし、超過判定もしない。
//   4. 「上限そのものを超えている」と「上限内だが受注残で足りない」を混ぜない。

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSalesSupplyCeiling } from "../salesSupplyCeilingViewModel";
import type { Product } from "../../../lib/v2/market/types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

test("SUPPLY-1【上限の定義】: 上限は完成品在庫＋実効加工能力で、それ以外を足さない", () => {
  const vm = buildSalesSupplyCeiling({
    products: PRODUCTS,
    plannedTonsByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsTonsByProduct: { hoso: 766, pd: 2015, vap: 0 },
    effectiveCapacityByProduct: { hoso: 1000, pd: 500, vap: 5130 },
    backlogByProduct: [],
  });
  const row = (p: Product) => vm.rows.find((r) => r.product === p)!;
  assert.equal(row("hoso").supplyCeilingTons, 766 + 1000);
  assert.equal(row("pd").supplyCeilingTons, 2015 + 500);
  assert.equal(row("vap").supplyCeilingTons, 0 + 5130);
});

test("SUPPLY-2【受注残を先に納める】: 新規販売に回せる量は上限から受注残を引いた残り", () => {
  const vm = buildSalesSupplyCeiling({
    products: ["pd"],
    plannedTonsByProduct: { pd: 100 },
    finishedGoodsTonsByProduct: { pd: 200 },
    effectiveCapacityByProduct: { pd: 300 },
    backlogByProduct: [{ product: "pd", totalTons: 120, dueNowTons: 50 }],
  });
  const row = vm.rows[0];
  assert.equal(row.supplyCeilingTons, 500);
  assert.equal(row.availableForNewSalesTons, 380);
  assert.equal(row.backlogDueNowTons, 50);
});

test("SUPPLY-3【マイナスにしない】: 受注残が上限を超えていても新規販売の余地は0どまり", () => {
  const vm = buildSalesSupplyCeiling({
    products: ["pd"],
    plannedTonsByProduct: { pd: 0 },
    finishedGoodsTonsByProduct: { pd: 0 },
    effectiveCapacityByProduct: { pd: 100 },
    backlogByProduct: [{ product: "pd", totalTons: 400, dueNowTons: 400 }],
  });
  assert.equal(vm.rows[0].availableForNewSalesTons, 0);
});

test("SUPPLY-4【0で埋めない】: 実効加工能力が無い商品は null にし、超過判定もしない", () => {
  const vm = buildSalesSupplyCeiling({
    products: ["hoso", "pd"],
    plannedTonsByProduct: { hoso: 9999, pd: 10 },
    finishedGoodsTonsByProduct: {},
    effectiveCapacityByProduct: { pd: 100 },
    backlogByProduct: [],
  });
  const hoso = vm.rows.find((r) => r.product === "hoso")!;
  assert.equal(hoso.effectiveCapacityTons, null);
  assert.equal(hoso.supplyCeilingTons, null);
  assert.equal(hoso.availableForNewSalesTons, null);
  assert.equal(hoso.exceedsSupplyCeiling, false, "能力が不明な商品を超過と断定してはいけない");
  assert.deepEqual(vm.productsOverSupplyCeiling, []);
  assert.equal(vm.capacityUnavailable, false, "1商品でも能力が取れていれば表全体は出せる");

  const none = buildSalesSupplyCeiling({
    products: ["hoso"],
    plannedTonsByProduct: {},
    finishedGoodsTonsByProduct: {},
    effectiveCapacityByProduct: undefined,
    backlogByProduct: [],
  });
  assert.equal(none.capacityUnavailable, true);
});

test("SUPPLY-5【2種類の警告を混ぜない】: 上限超過と受注残による不足を別々に数える", () => {
  const vm = buildSalesSupplyCeiling({
    products: ["hoso", "pd", "vap"],
    // hoso: 上限(100)そのものを超過 / pd: 上限(500)内だが受注残(400)で足りない / vap: 問題なし
    plannedTonsByProduct: { hoso: 150, pd: 300, vap: 10 },
    finishedGoodsTonsByProduct: { hoso: 0, pd: 200, vap: 0 },
    effectiveCapacityByProduct: { hoso: 100, pd: 300, vap: 100 },
    backlogByProduct: [{ product: "pd", totalTons: 400, dueNowTons: 0 }],
  });
  assert.deepEqual(vm.productsOverSupplyCeiling, ["hoso"]);
  assert.deepEqual(vm.productsOverAvailableForNewSales, ["pd"], "上限超過の商品を受注残側にも重複して数えない");
});
