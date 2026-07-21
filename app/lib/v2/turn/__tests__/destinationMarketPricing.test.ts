// ShrimpX V2 — ターン・オーケストレーターにおける商品×仕向市場の参照価格差別化
// （Phase 8P-0A）の接続テスト。turn/runner.ts の runTurn が
// input.parameters?.destinationMarketPricing を正しく受け取り、
// sales/runner.ts のadvanceSalesQuarterへ伝播することを検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { runIndustrySimulation } from "../../industryLab/simulationRunner";
import { runTurn } from "../runner";
import { TurnOrchestratorInput } from "../types";
import { hosoEqTons, unwrapUnit } from "../../core/units";
import { DEMAND_MARKET_IDS, Product } from "../../market/types";
import { CompanySalesPlanEntry } from "../../sales/types";
import { DomesticPurchasePlanEntry } from "../../rawMaterials/types";
import {
  DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1,
  DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1,
} from "../../market/destinationPricingParameters";

const COMPANIES = ["C1"];
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function industryQuarters(turns: number, seed = "destination-pricing-turn-fixture") {
  return runIndustrySimulation({ scenarioId: "baseline-v0.1", mode: "canonical", seed, turns }).quarters;
}

/** 1社が5市場すべてへ、同一の価格調整(0)・同一の販売希望量で提案する固定入力。 */
function buildSalesPlansAllMarkets(): CompanySalesPlanEntry[] {
  const plans: CompanySalesPlanEntry[] = [];
  for (const companyId of COMPANIES) {
    for (const market of DEMAND_MARKET_IDS) {
      for (const product of PRODUCTS) {
        plans.push({
          companyId,
          market,
          product,
          desiredQuantity: hosoEqTons(300),
          priceAdjustmentUsdPerHosoEqKg: 0,
          salesForceHeadcount: 5,
        });
      }
    }
  }
  return plans;
}

function buildDomesticPlans(): DomesticPurchasePlanEntry[] {
  return COMPANIES.map((companyId) => ({
    companyId,
    desiredQuantity: hosoEqTons(400),
    priceAdjustmentUsdPerHosoEqKg: 0,
    procurementHeadcount: 5,
  }));
}

function baseInput(quarter: ReturnType<typeof industryQuarters>[number], seed: string): TurnOrchestratorInput {
  return {
    currentPeriod: quarter.marketInput.period,
    marketInput: quarter.marketInput,
    scenarioVariables: { diseasePressure: quarter.scenarioTurnInput.countries.VN.diseasePressure },
    salesPlans: buildSalesPlansAllMarkets(),
    domesticPurchaseIntentSource: {
      type: "companyPlans",
      plans: buildDomesticPlans(),
    },
    importOrders: [],
    aquacultureStockingPlans: [],
    existingContracts: [],
    existingLots: [],
    seed,
  };
}

test("中立係数（NEUTRAL_V1を明示指定）では、同一会社・同一商品の提示価格(askPrice)が全5市場で厳密に一致する", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], "seed-neutral");

  const resultExplicitNeutral = runTurn({ ...input, parameters: { destinationMarketPricing: DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1 } });

  for (const product of PRODUCTS) {
    const askPrices = DEMAND_MARKET_IDS.map((market) => {
      const alloc = resultExplicitNeutral.salesRecord.allocations.find((a) => a.market === market && a.product === product);
      const company = alloc?.companies.find((c) => c.companyId === "C1");
      return company ? unwrapUnit(company.askPrice) : undefined;
    }).filter((v): v is number => v !== undefined);
    assert.ok(askPrices.length > 0, `product=${product} の配分が見つからない`);
    const first = askPrices[0];
    for (const p of askPrices) {
      assert.ok(Math.abs(p - first) < 1e-6, `product=${product}: 市場間で提示価格が異なる（中立係数のはずが ${askPrices.join(",")}）`);
    }
  }
});

// 【Commit B（実装指示 §12・8P-0Aの初期係数投入）に伴うテスト前提の更新について】
// このテストは元々、Commit A（構造実装のみ・CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTSが
// NEUTRAL_V1を指す段階）で書かれ、「destinationMarketPricing省略時の既定」と
// 「NEUTRAL_V1明示指定」を同一のテストで一括検証していた。Commit Bで
// CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTSの参照先をINITIAL_V1へ切り替えた
// ことで、「省略時の既定」は意図どおりINITIAL_V1（市場ごとに価格が異なる）へ
// 挙動が変わったため、上のテストから「省略時デフォルト」の検証を分離し、
// 下の新しいテストとして「省略時は明示的にINITIAL_V1と同じ結果になる」ことを
// 検証する形に更新した。これは既存の業務ロジック・制約を弱める変更ではなく、
// Commit Bで意図どおりに変化した「デフォルト値の参照先」というテスト前提を
// 実装指示どおりに追随させただけであることを、ここに明示的に開示する。
test("destinationMarketPricing省略時の既定は、CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS（Commit B時点ではINITIAL_V1）と厳密に同じ結果になる", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], "seed-default-matches-current");

  const resultDefault = runTurn(input);
  const resultExplicitInitial = runTurn({ ...input, parameters: { destinationMarketPricing: DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1 } });

  for (const product of PRODUCTS) {
    for (const market of DEMAND_MARKET_IDS) {
      const priceIn = (result: ReturnType<typeof runTurn>) => {
        const alloc = result.salesRecord.allocations.find((a) => a.market === market && a.product === product);
        const company = alloc?.companies.find((c) => c.companyId === "C1");
        return company ? unwrapUnit(company.askPrice) : undefined;
      };
      const d = priceIn(resultDefault);
      const e = priceIn(resultExplicitInitial);
      assert.equal(d, e, `${market}/${product}: 省略時デフォルトとINITIAL_V1明示指定の提示価格が一致しない`);
    }
  }
});

test("初期係数（INITIAL_V1）では、同一会社・同一商品でも市場によって提示価格(askPrice)が異なり、JPが最も高くCNまたはOTHERが最も低い", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], "seed-initial");
  const result = runTurn({ ...input, parameters: { destinationMarketPricing: DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1 } });

  const vapPriceByMarket = new Map<string, number>();
  for (const market of DEMAND_MARKET_IDS) {
    const alloc = result.salesRecord.allocations.find((a) => a.market === market && a.product === "vap");
    const company = alloc?.companies.find((c) => c.companyId === "C1");
    if (company) vapPriceByMarket.set(market, unwrapUnit(company.askPrice));
  }
  assert.equal(vapPriceByMarket.size, DEMAND_MARKET_IDS.length);

  const sorted = [...vapPriceByMarket.entries()].sort((a, b) => a[1] - b[1]);
  assert.equal(sorted[sorted.length - 1][0], "JP", `VAP提示価格が最も高いのはJPのはず（実際: ${JSON.stringify(sorted)}）`);
  assert.equal(sorted[0][0], "CN", `VAP提示価格が最も低いのはCNのはず（実際: ${JSON.stringify(sorted)}）`);

  // 価格全体への単純乗算ではないため、市場間の価格差はHOSO単体よりVAPのほうが大きいはず
  // （VAP係数のレンジ(0.85-1.25)がHOSO基礎係数のレンジ(0.98-1.02)より広いため）。
  const hosoPriceByMarket = new Map<string, number>();
  for (const market of DEMAND_MARKET_IDS) {
    const alloc = result.salesRecord.allocations.find((a) => a.market === market && a.product === "hoso");
    const company = alloc?.companies.find((c) => c.companyId === "C1");
    if (company) hosoPriceByMarket.set(market, unwrapUnit(company.askPrice));
  }
  const hosoValues = [...hosoPriceByMarket.values()];
  const vapValues = [...vapPriceByMarket.values()];
  const hosoSpread = Math.max(...hosoValues) - Math.min(...hosoValues);
  const vapSpread = Math.max(...vapValues) - Math.min(...vapValues);
  assert.ok(vapSpread > hosoSpread, `VAPの市場間価格差(${vapSpread})がHOSOの市場間価格差(${hosoSpread})以下になっている`);
});

test("destinationMarketPricing省略時は、市場・パラメータ変更を除きこれまでと同じ入力オブジェクトを一切変更しない", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], "seed-purity");
  const before = JSON.stringify(input);
  runTurn(input);
  assert.equal(JSON.stringify(input), before);
});
