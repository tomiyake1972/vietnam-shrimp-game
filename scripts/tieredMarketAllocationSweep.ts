// ShrimpX V2 — ENG-TIERED-MKT-1 price sweep（読み取り専用・診断のみ）
//
//   npx tsx scripts/tieredMarketAllocationSweep.ts
//   CASES=all npx tsx scripts/tieredMarketAllocationSweep.ts
//
// DS1/DS2/DS3 には一切触れない。検証fixture（sales/__tests__/tieredMarketAllocationFixture.ts）
// と同じ決定的入力を使い、価格 sweep に対する構造と単調性だけを出力する。

import { hosoEqTons, usdPerHosoEqKg } from "../app/lib/v2/core/units";
import { period } from "../app/lib/v2/core/period";
import { DemandMarketId, Product } from "../app/lib/v2/market/types";
import { allocateMarketProductTiered } from "../app/lib/v2/sales/tieredAllocation";
import { SALES_PARAMETERS_TIERED_FIXTURE_V0 } from "../app/lib/v2/sales/parameters";
import { CompanySalesPlanEntry } from "../app/lib/v2/sales/types";
import { score0to100 } from "../app/lib/v2/core/units";

const PERIOD = period(2020, 1);
const MARKETS: DemandMarketId[] = ["CN", "JP", "US", "EU"];
const PRODUCTS: Product[] = ["hoso", "pd", "vap"];
const QUALITIES = [50, 65, 80];
const PRICE_ADJUSTMENTS = [-2, -1, -0.5, 0, 0.5, 1, 2];
const REFERENCE_BY_PRODUCT: Record<Product, number> = { hoso: 4.12, pd: 4.85, vap: 6.82 };
const TARGET_DEMAND = 10_000;
const IDS = ["CO-A", "CO-B", "CO-C", "CO-D", "CO-E"];

type CaseName = "allCapsNonBinding" | "desiredBinding" | "deliverableBinding" | "salesCapacityBinding" | "competitorCapBinding";
const CASES: CaseName[] = ["allCapsNonBinding", "desiredBinding", "deliverableBinding", "salesCapacityBinding", "competitorCapBinding"];

function build(caseName: CaseName, market: DemandMarketId, product: Product, quality: number, adj: number) {
  const entries: CompanySalesPlanEntry[] = IDS.map((companyId, i) => {
    const isTarget = i === 0;
    const desired = caseName === "desiredBinding" && isTarget ? 400 : caseName === "competitorCapBinding" && !isTarget ? 150 : 5_000;
    const deliverable = caseName === "deliverableBinding" && isTarget ? 300 : undefined;
    return {
      companyId,
      market,
      product,
      desiredQuantity: hosoEqTons(desired),
      priceAdjustmentUsdPerHosoEqKg: isTarget ? adj : 0,
      salesForceHeadcount: 20,
      qualityReputation: score0to100(isTarget ? quality : 65),
      customerRelationship: score0to100(60),
      deliveryReliability: score0to100(60),
      salesBaseScore: score0to100(50),
      ...(product === "vap" ? { vapCapabilityScore: score0to100(isTarget ? quality : 65) } : {}),
      ...(deliverable !== undefined ? { approvedAllocationCap: hosoEqTons(deliverable) } : {}),
    };
  });
  const capacity =
    caseName === "salesCapacityBinding"
      ? new Map(IDS.map((id, i) => [`${id}::${market}`, i === 0 ? 350 * { hoso: 1, pd: 1.2, vap: 3 }[product] : 1e9]))
      : undefined;
  return { entries, capacity };
}

const rows: string[] = [];
rows.push(
  ["case", "market", "product", "quality", "adj", "tier", "unconstrained", "final", "marketShare%", "externalShare%", "bindingCap"].join("\t")
);
const runCases = process.env.CASES === "all" ? CASES : CASES;
for (const caseName of runCases) {
  for (const market of MARKETS) {
    for (const product of PRODUCTS) {
      for (const quality of QUALITIES) {
        for (const adj of PRICE_ADJUSTMENTS) {
          const { entries, capacity } = build(caseName, market, product, quality, adj);
          const out = allocateMarketProductTiered({
            market,
            product,
            period: PERIOD,
            entries,
            basePrice: usdPerHosoEqKg(REFERENCE_BY_PRODUCT[product]),
            targetDemand: hosoEqTons(TARGET_DEMAND),
            params: SALES_PARAMETERS_TIERED_FIXTURE_V0,
            salesCapacityByCompanyMarket: capacity,
          });
          const cap = out.diagnostics.companies.find((c) => c.companyId === "CO-A")!;
          const externalShare = (out.diagnostics.externalFinalAllocation / TARGET_DEMAND) * 100;
          for (const t of out.diagnostics.tiers) {
            const c = t.companies.find((x) => x.companyId === "CO-A")!;
            rows.push(
              [
                caseName, market, product, quality, adj.toFixed(2), t.tier,
                c.unconstrainedAllocation.toFixed(2), c.finalAllocation.toFixed(2),
                ((c.finalAllocation / t.tierDemand) * 100).toFixed(2),
                (( t.external.finalAllocation / t.tierDemand) * 100).toFixed(2),
                cap.bindingCap,
              ].join("\t")
            );
          }
          rows.push(
            [caseName, market, product, quality, adj.toFixed(2), "TOTAL",
             cap.unconstrainedAllocation.toFixed(2), cap.finalAllocation.toFixed(2),
             ((cap.finalAllocation / TARGET_DEMAND) * 100).toFixed(2), externalShare.toFixed(2), cap.bindingCap].join("\t")
          );
          const conserved = Math.abs(out.diagnostics.demandConservationResidual) < 1e-6;
          if (!conserved) throw new Error(`需要保存が崩れた: ${caseName}/${market}/${product}/${adj}`);
        }
      }
    }
  }
}
console.log(rows.join("\n"));
console.error(`rows=${rows.length - 1}（需要保存はすべてのケースで成立）`);
