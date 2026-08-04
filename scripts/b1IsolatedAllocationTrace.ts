// ShrimpX V2 — B-1/B-3: allocation段階の厳密な因果分離トレース
// （Standard AI・他社の意思決定を一切介さず、実コードallocateMarketProductを
// 直接呼ぶことでheadcountの純粋な効果だけを取り出す）。
//
// 【目的】b4DynamicHeadcountTrace.tsはStandard AI駆動の動的トレースであり、
// 他の意思決定（生産・調達・価格）も内生的に変わりうる「交絡込み」の測定
// である。本スクリプトはその対極として、sales/allocation.tsの実コード
// （allocateMarketProduct）を直接呼び出し、対象会社(A)のheadcountだけを
// 変化させ、他の4社・basePrice・targetDemand・全パラメータを完全固定した
// 「真に因果分離された」比較を行う。production coreコードは一切変更しない
// （呼ぶだけ）。
//
// 使い方: npx tsx scripts/b1IsolatedAllocationTrace.ts

import { allocateMarketProduct } from "../app/lib/v2/sales/allocation";
import { salesCoverageScore, processingCapacity } from "../app/lib/v2/sales/salesForce";
import { SALES_PARAMETERS_V1 } from "../app/lib/v2/sales/parameters";
import { CompanySalesPlanEntry } from "../app/lib/v2/sales/types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../app/lib/v2/core/units";
import { period } from "../app/lib/v2/core/period";

const P1 = period(2015, 1);
const BASE_PRICE = usdPerHosoEqKg(4.5);
const params = SALES_PARAMETERS_V1;

function competitor(companyId: string, headcount: number, desiredQuantity: number): CompanySalesPlanEntry {
  return {
    companyId,
    market: "CN",
    product: "hoso",
    desiredQuantity: hosoEqTons(desiredQuantity),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: headcount,
  };
}

// 対象会社Aのheadcountだけを動かす。他4社（B/C/D/E）はheadcount=80（baseline相当）で固定。
const HEADCOUNTS = [0, 40, 80, 88, 100, 120, 160, 240, 320];

// 【シナリオ1: 市場が十分に大きい（targetDemandが誰の上限にも届かない）場合】
// →headcountを増やしてもshareCapが先に効くかどうかを見る
const LARGE_TARGET_DEMAND = hosoEqTons(50000);
// 【シナリオ2: 市場が小さい（targetDemandがすぐ埋まる）場合】
// →headcountを増やしても他社との取り合いにしかならない場合を見る
const SMALL_TARGET_DEMAND = hosoEqTons(5000);

function runScenario(label: string, targetDemand: ReturnType<typeof hosoEqTons>) {
  console.log(`\n\n========== シナリオ: ${label}（targetDemand=${unwrapUnit(targetDemand)}t） ==========`);
  console.log(
    "headcountA | coverageA | capacityA(t) | desiredQtyA(t) | shareCap(t) | allocatedA(t) | 実際の拘束要因 | askPriceA | weightA | 外部選択肢(t)"
  );
  console.log("-".repeat(160));

  for (const h of HEADCOUNTS) {
    // 会社Aは「営業能力の限界まで売りたい」という設計（desiredQuantityを
    // 大きく設定し、allocation段階の拘束が処理能力・市場シェア・対象需要の
    // どれで決まるかを明確にする）。
    const entryA = competitor("A", h, 100000);
    const others = ["B", "C", "D", "E"].map((id) => competitor(id, 80, 100000));
    const entries = [entryA, ...others];

    const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, targetDemand, params);
    const a = result.companies.find((c) => c.companyId === "A")!;

    const coverage = salesCoverageScore(h, params);
    const capacity = unwrapUnit(processingCapacity(h, params));
    const shareCap = unwrapUnit(targetDemand) * params.maximumSupplierShare;
    const allocatedA = unwrapUnit(a.allocatedQuantity);

    // 実際にどの上限が拘束したかを判定（cap = min(desiredQuantity, capacity, shareCap, approvedCap)。
    // approvedCapは今回未指定＝Infinity）。allocatedAがcapに極めて近ければ「そのcapで頭打ち」、
    // capより明確に小さければ「水位法の予算(targetDemand)不足で頭打ち」と判定する。
    const capValue = Math.min(100000, capacity, shareCap);
    const EPS = 1;
    let bindingReason: string;
    if (Math.abs(allocatedA - capValue) < EPS) {
      if (Math.abs(capacity - capValue) < EPS) bindingReason = "processingCapacity（営業人員由来の処理能力上限）";
      else if (Math.abs(shareCap - capValue) < EPS) bindingReason = "shareCap（市場シェア上限）";
      else bindingReason = "desiredQuantity（自社の販売希望量）";
    } else {
      bindingReason = "targetDemand不足（水位法予算・他社との競合で頭打ち）";
    }

    console.log(
      `${String(h).padStart(10)} | ${coverage.toFixed(4).padStart(9)} | ${capacity.toFixed(1).padStart(12)} | ${(100000).toString().padStart(15)} | ` +
        `${shareCap.toFixed(1).padStart(11)} | ${allocatedA.toFixed(1).padStart(13)} | ${bindingReason.padEnd(30)} | ` +
        `${unwrapUnit(a.askPrice).toFixed(3).padStart(9)} | ${a.competitivenessWeight.toFixed(4).padStart(7)} | ${unwrapUnit(result.externalOptionQuantity).toFixed(1).padStart(12)}`
    );
  }
}

runScenario("大きい市場（誰のcapにも対象需要が制約されない）", LARGE_TARGET_DEMAND);
runScenario("小さい市場（対象需要が容易に埋まる、他社との競合が支配的）", SMALL_TARGET_DEMAND);

// 限界効果（headcountを1人ずつ増やした場合のΔallocatedQuantity、大きい市場シナリオで）
console.log("\n\n========== 限界効果（大きい市場シナリオ、headcount→headcount+1） ==========");
for (const h of [0, 79, 80, 119, 120, 159, 160]) {
  const mk = (hh: number) => {
    const entries = [competitor("A", hh, 100000), ...["B", "C", "D", "E"].map((id) => competitor(id, 80, 100000))];
    return allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, LARGE_TARGET_DEMAND, params).companies.find((c) => c.companyId === "A")!;
  };
  const a0 = mk(h);
  const a1 = mk(h + 1);
  console.log(`  ${h}→${h + 1}: Δallocated=${(unwrapUnit(a1.allocatedQuantity) - unwrapUnit(a0.allocatedQuantity)).toFixed(3)}t`);
}
