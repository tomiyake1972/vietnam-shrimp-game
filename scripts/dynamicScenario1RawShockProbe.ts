#!/usr/bin/env -S npx tsx
// Dynamic Scenario 1 — Phase 1 audit: VN原料ショックの到達可能域の実測（read-only）。
//
// 「Turn7〜9で ベトナム国内原料 > India/Ecuador 輸入着地コスト を成立させられるか」
// を、既存の市場モジュール（hosoPricing / vietnamRawMarket / imports）をそのまま
// 使って測る。エンジンは一切変更しない。scenario から動かせる3レバー
//   (1) VN供給量（EXPORTABLE_SUPPLY / COUNTRY_CAPACITY / SURVIVAL_RATE）
//   (2) VN養殖コスト指数（AQUACULTURE_COST → 価格アンカー）
//   (3) 農家留保価格（vietnamFarmerEconomics）※現状はゲーム開始時固定
// の到達域を、単独・組み合わせで出力する。

import { createRandomStream } from "../app/lib/v2/core/random";
import { period } from "../app/lib/v2/core/period";
import { hosoEqTons, ratio, score0to100, usdPerHosoEqKg, unwrapUnit } from "../app/lib/v2/core/units";
import { calculateMarketQuarter, MARKET_PARAMETERS_V1 } from "../app/lib/v2/market";
import { COUNTRY_IDS, CountryId, DEMAND_MARKET_IDS, MarketQuarterInput } from "../app/lib/v2/market/types";
import { calculateLandedPrice } from "../app/lib/v2/rawMaterials/imports";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../app/lib/v2/rawMaterials/parameters";
import { SCENARIO_PREHISTORY_BASELINE_V1, SCENARIO_INITIAL_STATE_OVERRIDES_V1 } from "../app/lib/v2/scenario/parameters";

// baseline 32Q 実測（scripts/dynamicScenario1WorldAudit.ts）の平衡近傍を出発点にする。
const STEADY_FOB: Record<CountryId, number> = { EC: 4.30, IN: 3.80, ID: 3.70, VN: 3.94 };
const BASE_SUPPLY: Record<CountryId, number> = { EC: 557000, IN: 660000, ID: 354000, VN: 458000 };
const BASE_WORLD_CONSUMPTION = SCENARIO_PREHISTORY_BASELINE_V1.priorMarketConsumptionHosoEqTons;

interface Lever {
  readonly label: string;
  /** VN production multiplier（供給ショック）。 */
  readonly vnSupplyMult: number;
  /** VN aquacultureCostIndex（価格アンカー = 5.6 × これ）。 */
  readonly vnCostIndex: number;
  /** 国内買付意向 / 国内供給（需給逼迫度）。1.0超で買い手超過。 */
  readonly domesticIntentRatio: number;
  /** 農家留保価格の構成（未指定なら既定 2.25）。 */
  readonly farmerCost?: number;
  /** IN/EC の供給倍率（好漁・増産で輸入側を相対的に安くする narrative レバー）。 */
  readonly importSupplyMult?: number;
}

const LEVERS: readonly Lever[] = [
  { label: "BEFORE (baseline平衡)", vnSupplyMult: 1.0, vnCostIndex: 1.0, domesticIntentRatio: 0.85 },
  { label: "A: 供給 -20% のみ", vnSupplyMult: 0.8, vnCostIndex: 1.0, domesticIntentRatio: 1.0 },
  { label: "B: 供給 -35% のみ", vnSupplyMult: 0.65, vnCostIndex: 1.0, domesticIntentRatio: 1.1 },
  { label: "C: 供給 -35% + コスト指数 1.25", vnSupplyMult: 0.65, vnCostIndex: 1.25, domesticIntentRatio: 1.1 },
  { label: "D: 供給 -45% + コスト指数 1.40", vnSupplyMult: 0.55, vnCostIndex: 1.4, domesticIntentRatio: 1.2 },
  { label: "E: 供給 -35% + コスト1.25 + 農家原価 3.10", vnSupplyMult: 0.65, vnCostIndex: 1.25, domesticIntentRatio: 1.1, farmerCost: 3.1 },
  { label: "F: 供給 -45% + コスト1.40 + 農家原価 3.60", vnSupplyMult: 0.55, vnCostIndex: 1.4, domesticIntentRatio: 1.2, farmerCost: 3.6 },
  { label: "G: 供給 -30% + コスト1.25 + IN/EC +10%", vnSupplyMult: 0.7, vnCostIndex: 1.25, domesticIntentRatio: 1.1, importSupplyMult: 1.1 },
  { label: "H: 供給 -35% + コスト1.30 + IN/EC +15%", vnSupplyMult: 0.65, vnCostIndex: 1.3, domesticIntentRatio: 1.15, importSupplyMult: 1.15 },
  { label: "I: 供給 -40% + コスト1.35 + IN/EC +15%", vnSupplyMult: 0.6, vnCostIndex: 1.35, domesticIntentRatio: 1.15, importSupplyMult: 1.15 },
  { label: "J: 供給 -50% + コスト1.60 (上限探索)", vnSupplyMult: 0.5, vnCostIndex: 1.6, domesticIntentRatio: 1.3 },
  { label: "K: 供給 -50% + コスト1.90 (上限探索)", vnSupplyMult: 0.5, vnCostIndex: 1.9, domesticIntentRatio: 1.3 },
];

function buildInput(lever: Lever, priorFob: Record<CountryId, number>): MarketQuarterInput {
  const countries: Record<string, MarketQuarterInput["countries"][CountryId]> = {};
  for (const c of COUNTRY_IDS) {
    const importMult = c === "IN" || c === "EC" ? lever.importSupplyMult ?? 1 : 1;
    const prod = BASE_SUPPLY[c] * (c === "VN" ? lever.vnSupplyMult : importMult);
    const cost = c === "VN" ? lever.vnCostIndex : 1.0;
    countries[c] = {
      production: hosoEqTons(prod),
      exportCapacityRatio: ratio(0.9),
      aquacultureCostIndex: cost,
      priorAquacultureCostIndex: cost,
      qualityScore: score0to100(60),
      reliabilityScore: score0to100(60),
      pdProcessingCapacity: hosoEqTons(prod * 0.3),
      vapProcessingCapacity: hosoEqTons(prod * 0.1),
    };
  }
  const demandMarkets: Record<string, MarketQuarterInput["demandMarkets"]["CN"]> = {};
  for (const m of DEMAND_MARKET_IDS) {
    demandMarkets[m] = { priorPeriodConsumption: hosoEqTons(BASE_WORLD_CONSUMPTION[m]), economicIndex: 1.0, populationGrowthRate: 0 };
  }
  const vnSupply = BASE_SUPPLY.VN * lever.vnSupplyMult;
  const econ = SCENARIO_INITIAL_STATE_OVERRIDES_V1.vietnamProcessingEconomics;
  return {
    period: period(2015, 1),
    priorHosoFobPrice: Object.fromEntries(COUNTRY_IDS.map((c) => [c, usdPerHosoEqKg(priorFob[c])])) as MarketQuarterInput["priorHosoFobPrice"],
    countries: countries as MarketQuarterInput["countries"],
    demandMarkets: demandMarkets as MarketQuarterInput["demandMarkets"],
    vietnamDomestic: {
      domesticRawSupply: hosoEqTons(vnSupply),
      domesticProcurementIntent: hosoEqTons(vnSupply * lever.domesticIntentRatio),
      trailingAverageDomesticPurchase: hosoEqTons(vnSupply * 0.85),
      hosoEqRecoveryRatio: ratio(econ.hosoEqRecoveryRatio),
      processingExportCostUsdPerKg: usdPerHosoEqKg(econ.processingExportCostUsdPerKg),
      requiredMarginUsdPerKg: usdPerHosoEqKg(econ.requiredMarginUsdPerKg),
      ...(lever.farmerCost !== undefined
        ? { farmerEconomics: { farmingCostUsdPerHosoEqKg: lever.farmerCost, diseaseRiskAllowanceUsdPerHosoEqKg: 0.15, minimumFarmerMarginUsdPerHosoEqKg: 0.2 } }
        : {}),
    },
    pdVapDemand: { pdDemand: hosoEqTons(300000), vapDemand: hosoEqTons(120000) },
  };
}

console.log("# VN原料ショック 到達可能域（既存市場モジュールでの実測・エンジン無改変）");
console.log("# ショック持続を3四半期（価格の四半期変動上限±20%を3回まで許容）とみなし、収束値を出す。");
console.log(
  ["lever", "VN_fob", "VN_ceiling", "farmerResrv", "VN_domestic", "IN_landed", "EC_landed", "VN>IN?", "VN取引量", "未売却", "spread制約"].join("\t")
);

for (const lever of LEVERS) {
  // 同じショックを3四半期継続適用し、価格の四半期変動上限の下で到達する水準を見る。
  const fob = { ...STEADY_FOB };
  let last: ReturnType<typeof calculateMarketQuarter> | undefined;
  for (let q = 0; q < 3; q++) {
    // 決定論的に評価するため、市場ショックが常に 0 になる乱数列（next()=0.5）を使う。
    const stream = { next: () => 0.5 } as ReturnType<typeof createRandomStream>;
    last = calculateMarketQuarter(buildInput(lever, fob), MARKET_PARAMETERS_V1, stream);
    for (const c of COUNTRY_IDS) fob[c] = unwrapUnit(last.hosoPrices[c].price);
  }
  const r = last!;
  const inLanded = unwrapUnit(calculateLandedPrice(r.hosoPrices.IN.price, "IN", RAW_MATERIALS_PARAMETERS_V1).landedPrice);
  const ecLanded = unwrapUnit(calculateLandedPrice(r.hosoPrices.EC.price, "EC", RAW_MATERIALS_PARAMETERS_V1).landedPrice);
  const vnDom = unwrapUnit(r.vietnamDomestic.price);
  console.log(
    [
      lever.label,
      unwrapUnit(r.hosoPrices.VN.price).toFixed(3),
      unwrapUnit(r.vietnamDomestic.buyingCeiling).toFixed(3),
      unwrapUnit(r.vietnamDomestic.farmerReservationPrice).toFixed(3),
      vnDom.toFixed(3),
      inLanded.toFixed(3),
      ecLanded.toFixed(3),
      vnDom > inLanded ? "YES" : "no",
      Math.round(unwrapUnit(r.vietnamDomestic.transactedVolume)),
      Math.round(unwrapUnit(r.vietnamDomestic.unsoldSupply)),
      r.hosoPrices.VN.drivers.includes("COUNTRY_PRICE_SPREAD_BOUNDED") ? "BOUND" : "-",
    ].join("\t")
  );
}
