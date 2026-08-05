// ShrimpX V2 — 市場シェア形成メカニズムの解剖・数値検証（三宅さんovernight指示・Part A/B）
//
// 【対象】production coreコードは一切変更しない（呼ぶだけ）。
// allocateMarketProduct・processingCapacity・salesCoverageScoreを実際に
// 呼び出し、市場シェア形成の実際の挙動を数値で確認する。
//
// 使い方: npx tsx scripts/marketShareMechanismAnalysis.ts

import { allocateMarketProduct } from "../app/lib/v2/sales/allocation";
import { salesCoverageScore, processingCapacity } from "../app/lib/v2/sales/salesForce";
import { SALES_PARAMETERS_V1 } from "../app/lib/v2/sales/parameters";
import { CompanySalesPlanEntry } from "../app/lib/v2/sales/types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg, HosoEqTons } from "../app/lib/v2/core/units";
import { period } from "../app/lib/v2/core/period";

const P1 = period(2015, 1);
const BASE_PRICE = usdPerHosoEqKg(4.5);
const params = SALES_PARAMETERS_V1;
const TARGET_DEMAND = hosoEqTons(10000);

function competitor(companyId: string, overrides: Partial<CompanySalesPlanEntry> = {}): CompanySalesPlanEntry {
  return {
    companyId,
    market: "CN",
    product: "hoso",
    desiredQuantity: hosoEqTons(100000),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 80,
    ...overrides,
  };
}

console.log(`params.maximumSupplierShare = ${params.maximumSupplierShare}`);
console.log(`shareCap(targetDemand=${unwrapUnit(TARGET_DEMAND)}t) = ${unwrapUnit(TARGET_DEMAND) * params.maximumSupplierShare}t\n`);

// ===== A-3: 35%が本当にハードな天井かどうかの数値実証 =====
// 【設計】競合4社(B/C/D/E)の競争力ウェイトを極端に落とす（極端な高値提示で
// priceScoreを最低に）ことで、水位法の予算(targetDemand)のほぼ全量がAへ
// 集中する状況を作る。この状態でAのdesiredQuantity・headcount・
// approvedAllocationCapを桁違いに増やしても、最終allocatedQuantityが
// targetDemandの35%（shareCap）を超えないことを確認する。
console.log("========== A-3: shareCap(35%)は実際にハードな天井か ==========");
console.log("headcountA(桁違いに増加) | desiredQtyA | approvedCapA(桁違いに大きい) | allocatedA(t) | targetDemandに対する比率 | 35%ちょうどか");
const WEAK_COMPETITOR_PRICE_ADJ = unwrapUnit(BASE_PRICE) * (params.maxAskPriceRatioOfBase - 1); // 許容上限価格まで値上げ＝競争力最低
for (const h of [80, 1000, 100000, 10000000]) {
  const entries = [
    competitor("A", { salesForceHeadcount: h, desiredQuantity: hosoEqTons(1e9), approvedAllocationCap: hosoEqTons(1e12) as HosoEqTons }),
    ...["B", "C", "D", "E"].map((id) => competitor(id, { priceAdjustmentUsdPerHosoEqKg: WEAK_COMPETITOR_PRICE_ADJ, salesForceHeadcount: 0 })),
  ];
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, TARGET_DEMAND, params);
  const a = result.companies.find((c) => c.companyId === "A")!;
  const allocatedA = unwrapUnit(a.allocatedQuantity);
  const ratio = allocatedA / unwrapUnit(TARGET_DEMAND);
  console.log(
    `${String(h).padStart(20)} | ${(1e9).toExponential(0).padStart(10)} | ${(1e12).toExponential(0).padStart(10)} | ${allocatedA.toFixed(2).padStart(12)} | ` +
      `${(ratio * 100).toFixed(4).padStart(9)}% | ${Math.abs(ratio - params.maximumSupplierShare) < 1e-6 ? "YES（35.0000%で完全に一致）" : "no"}`
  );
}
console.log(
  "\n結論: 競合他社の競争力を最低まで落とし、Aへ需要予算が集中する状況を作った上で、" +
    "approvedAllocationCap・desiredQuantity・headcountをどれだけ桁違いに増やしても、" +
    "allocatedQuantityは常にtargetDemandのちょうど35.0000%で頭打ちになる。これは" +
    "『他の制約と組み合わさると実質的にsoftになる』のではなく、" +
    "『desiredQuantity・processingCapacity・approvedCapのいずれも35%を上回っている限り、" +
    "shareCapが必ず最終的な拘束要因になる』という意味での構造的なハード上限である。"
);

// ===== B-1: 5社が完全に同一条件の場合の配分 =====
console.log("\n\n========== B-1: 5社完全同一条件（理論値=20% vs 実測値） ==========");
{
  const entries = ["A", "B", "C", "D", "E"].map((id) => competitor(id));
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, TARGET_DEMAND, params);
  console.log("会社 | allocated(t) | シェア(%)");
  for (const c of result.companies) {
    console.log(`  ${c.companyId} | ${unwrapUnit(c.allocatedQuantity).toFixed(2).padStart(10)} | ${((unwrapUnit(c.allocatedQuantity) / unwrapUnit(TARGET_DEMAND)) * 100).toFixed(3)}%`);
  }
  console.log(`  外部選択肢 | ${unwrapUnit(result.externalOptionQuantity).toFixed(2)}t | ${((unwrapUnit(result.externalOptionQuantity) / unwrapUnit(TARGET_DEMAND)) * 100).toFixed(3)}%`);
  console.log("理論値: 5社が完全に同一の競争力ウェイトを持つ場合、水位法は重み比例配分のため各社ちょうど1/5＝20%になるはず（外部選択肢の重みが0でない場合はその分減る）。");
}

// ===== B-2: 1社の相対的な販売力を0.5x〜10.0xに変化させたときのシェア =====
console.log("\n\n========== B-2: 1社の相対的な販売力(headcount)を変化させた場合のシェア ==========");
const BASE_HEADCOUNT = 80;
const MULTIPLIERS = [0.5, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0, 10.0];
console.log("倍率 | headcountA(丸め) | coverageA | capacityA(t) | allocatedA(t) | シェアA(%)");
for (const mult of MULTIPLIERS) {
  const h = Math.max(0, Math.round(BASE_HEADCOUNT * mult));
  const entries = [competitor("A", { salesForceHeadcount: h }), ...["B", "C", "D", "E"].map((id) => competitor(id))];
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, TARGET_DEMAND, params);
  const a = result.companies.find((c) => c.companyId === "A")!;
  const shareA = (unwrapUnit(a.allocatedQuantity) / unwrapUnit(TARGET_DEMAND)) * 100;
  console.log(
    `${mult.toString().padStart(5)}x | ${String(h).padStart(15)} | ${salesCoverageScore(h, params).toFixed(4).padStart(9)} | ` +
      `${unwrapUnit(processingCapacity(h, params)).toFixed(1).padStart(12)} | ${unwrapUnit(a.allocatedQuantity).toFixed(2).padStart(13)} | ${shareA.toFixed(3).padStart(9)}`
  );
}

// ===== B-3: 5%-35%領域の詳細（35%での不連続性の実証） =====
console.log("\n\n========== B-3: 5%〜35%領域の詳細（35%での不連続性） ==========");
console.log("headcountA | shareA(%) | Δshare(前刻みから) | 35%到達か");
let prevShare: number | null = null;
// headcountを細かく刻んで、シェアが5,10,...,35%付近をどう通過するかを見る
for (const h of [10, 20, 30, 40, 50, 60, 70, 80, 100, 130, 170, 220, 300, 500, 1000, 5000, 50000]) {
  const entries = [competitor("A", { salesForceHeadcount: h }), ...["B", "C", "D", "E"].map((id) => competitor(id))];
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, TARGET_DEMAND, params);
  const a = result.companies.find((c) => c.companyId === "A")!;
  const share = (unwrapUnit(a.allocatedQuantity) / unwrapUnit(TARGET_DEMAND)) * 100;
  const delta = prevShare === null ? NaN : share - prevShare;
  console.log(`${String(h).padStart(10)} | ${share.toFixed(4).padStart(9)} | ${(isNaN(delta) ? "-" : delta.toFixed(4)).padStart(18)} | ${share >= 34.999 ? "**35%到達・以後変化なし**" : ""}`);
  prevShare = share;
}

// ===== B-3b: 競合が弱い場合の5%〜35%領域の詳細（35%での不連続性、現実的な壁への到達） =====
console.log("\n\n========== B-3b: 競合他社が弱い場合の5%〜35%領域詳細（35%到達を実際に示す） ==========");
console.log("headcountA | shareA(%) | Δshare(前刻みから) | 35%到達か");
prevShare = null;
for (const h of [10, 20, 30, 40, 50, 60, 70, 80, 100, 130, 170, 220, 300, 500, 1000, 5000, 50000]) {
  const entries = [
    competitor("A", { salesForceHeadcount: h, desiredQuantity: hosoEqTons(1e9) }),
    ...["B", "C", "D", "E"].map((id) => competitor(id, { priceAdjustmentUsdPerHosoEqKg: WEAK_COMPETITOR_PRICE_ADJ, salesForceHeadcount: 0 })),
  ];
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, TARGET_DEMAND, params);
  const a = result.companies.find((c) => c.companyId === "A")!;
  const share = (unwrapUnit(a.allocatedQuantity) / unwrapUnit(TARGET_DEMAND)) * 100;
  const delta = prevShare === null ? NaN : share - prevShare;
  console.log(`${String(h).padStart(10)} | ${share.toFixed(4).padStart(9)} | ${(isNaN(delta) ? "-" : delta.toFixed(4)).padStart(18)} | ${share >= 34.999 ? "**35%到達・以後変化なし**" : ""}`);
  prevShare = share;
}
