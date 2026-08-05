import { allocateMarketProduct } from "../app/lib/v2/sales/allocation";
import { salesCoverageScore, processingCapacity } from "../app/lib/v2/sales/salesForce";
import { SALES_PARAMETERS_V1 } from "../app/lib/v2/sales/parameters";
import { CompanySalesPlanEntry } from "../app/lib/v2/sales/types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../app/lib/v2/core/units";
import { period } from "../app/lib/v2/core/period";
import * as fs from "fs";

const P1 = period(2015, 1);
const BASE_PRICE = usdPerHosoEqKg(4.5);
const params = SALES_PARAMETERS_V1;
const TARGET_DEMAND = hosoEqTons(10000);

function competitor(companyId: string, overrides: Partial<CompanySalesPlanEntry> = {}): CompanySalesPlanEntry {
  return {
    companyId, market: "CN", product: "hoso",
    desiredQuantity: hosoEqTons(100000),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 80,
    ...overrides,
  };
}

// CSV1: B-2 headcount multiplier -> share
let csv1 = "multiplier,headcount,coverageScore,processingCapacityTons,allocatedTons,sharePercent\n";
const MULTIPLIERS = [0.5, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0, 10.0];
for (const mult of MULTIPLIERS) {
  const h = Math.max(0, Math.round(80 * mult));
  const entries = [competitor("A", { salesForceHeadcount: h }), ...["B", "C", "D", "E"].map((id) => competitor(id))];
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, TARGET_DEMAND, params);
  const a = result.companies.find((c) => c.companyId === "A")!;
  const share = (unwrapUnit(a.allocatedQuantity) / unwrapUnit(TARGET_DEMAND)) * 100;
  csv1 += `${mult},${h},${salesCoverageScore(h, params).toFixed(6)},${unwrapUnit(processingCapacity(h, params)).toFixed(2)},${unwrapUnit(a.allocatedQuantity).toFixed(2)},${share.toFixed(4)}\n`;
}
fs.writeFileSync("analysis_output/b2_headcount_multiplier_share.csv", csv1);

// CSV2: B-3 / B-3b headcount fine-grain
const HS = [10, 20, 30, 40, 50, 60, 70, 80, 100, 130, 170, 220, 300, 500, 1000, 5000, 50000];
const WEAK = unwrapUnit(BASE_PRICE) * (params.maxAskPriceRatioOfBase - 1);
let csv2 = "headcount,share_normal_percent,share_weak_competitor_percent\n";
for (const h of HS) {
  const entriesNormal = [competitor("A", { salesForceHeadcount: h }), ...["B", "C", "D", "E"].map((id) => competitor(id))];
  const rN = allocateMarketProduct("CN", "hoso", P1, entriesNormal, BASE_PRICE, TARGET_DEMAND, params);
  const shareN = (unwrapUnit(rN.companies.find((c) => c.companyId === "A")!.allocatedQuantity) / unwrapUnit(TARGET_DEMAND)) * 100;

  const entriesWeak = [
    competitor("A", { salesForceHeadcount: h, desiredQuantity: hosoEqTons(1e9) }),
    ...["B", "C", "D", "E"].map((id) => competitor(id, { priceAdjustmentUsdPerHosoEqKg: WEAK, salesForceHeadcount: 0 })),
  ];
  const rW = allocateMarketProduct("CN", "hoso", P1, entriesWeak, BASE_PRICE, TARGET_DEMAND, params);
  const shareW = (unwrapUnit(rW.companies.find((c) => c.companyId === "A")!.allocatedQuantity) / unwrapUnit(TARGET_DEMAND)) * 100;
  csv2 += `${h},${shareN.toFixed(4)},${shareW.toFixed(4)}\n`;
}
fs.writeFileSync("analysis_output/b3_hardcap_discontinuity.csv", csv2);

console.log("CSV files written.");
console.log(csv1);
console.log(csv2);
