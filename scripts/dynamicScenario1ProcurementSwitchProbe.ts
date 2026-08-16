#!/usr/bin/env -S npx tsx
// Dynamic Scenario 1 — Phase 1/2 audit: T13以降の「調達切替」構造の到達域（read-only）。
//
// 指示 §16〜§17 が要求するのは
//   - Ecuador 中心の global 増産で輸入が競争力を持つ
//   - VN 国内原料は「常に高い」ではなく年間で乱高下し、
//     安いTurnは VN < import、高いTurnは import 有利
// という状態。既存市場モジュールをそのまま使って、この2条件を同時に満たす
// (VNコスト指数, EC/INコスト指数, VN稼働率) の組み合わせを実測する。
// エンジンは一切変更しない。

import { period } from "../app/lib/v2/core/period";
import { hosoEqTons, ratio, score0to100, usdPerHosoEqKg, unwrapUnit } from "../app/lib/v2/core/units";
import { calculateMarketQuarter, MARKET_PARAMETERS_V1 } from "../app/lib/v2/market";
import { COUNTRY_IDS, CountryId, DEMAND_MARKET_IDS, MarketQuarterInput } from "../app/lib/v2/market/types";
import { calculateLandedPrice } from "../app/lib/v2/rawMaterials/imports";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../app/lib/v2/rawMaterials/parameters";
import { SCENARIO_PREHISTORY_BASELINE_V1, SCENARIO_INITIAL_STATE_OVERRIDES_V1 } from "../app/lib/v2/scenario/parameters";

const BASE_CAPACITY: Record<CountryId, number> = { EC: 761246, IN: 899654, ID: 484429, VN: 622837 }; // = supply / (0.85*0.85)
const BASE_WORLD_CONSUMPTION = SCENARIO_PREHISTORY_BASELINE_V1.priorMarketConsumptionHosoEqTons;
const STEADY_FOB: Record<CountryId, number> = { EC: 4.30, IN: 3.80, ID: 3.70, VN: 3.94 };

interface Config {
  readonly label: string;
  readonly vnCostIndex: number;
  readonly importCostIndex: number; // EC/IN の養殖コスト指数
  readonly ecCapacityMult: number;
  readonly inCapacityMult: number;
  readonly vnUtilization: number; // VN の季節稼働率
  readonly domesticIntentRatio: number;
  /**
   * 加工輸出費用 + 必要利益（買付上限 = VN_FOB × recovery − これ）。
   * ScenarioInitialStateOverrides.vietnamProcessingEconomics から設定可能。
   * 既定は 0.85 + 0.25 = 1.10。
   */
  readonly processingCostPlusMargin?: number;
}

function buildInput(cfg: Config, priorFob: Record<CountryId, number>): MarketQuarterInput {
  const countries: Record<string, MarketQuarterInput["countries"][CountryId]> = {};
  const util: Record<CountryId, number> = { EC: 0.85, IN: 0.85, ID: 0.85, VN: cfg.vnUtilization };
  const capMult: Record<CountryId, number> = { EC: cfg.ecCapacityMult, IN: cfg.inCapacityMult, ID: 1, VN: 1 };
  const cost: Record<CountryId, number> = { EC: cfg.importCostIndex, IN: cfg.importCostIndex, ID: 1.0, VN: cfg.vnCostIndex };
  let vnProd = 0;
  for (const c of COUNTRY_IDS) {
    const prod = BASE_CAPACITY[c] * capMult[c] * util[c] * 0.85; // capacity × utilization × survival(0.85) × productivity(1)
    if (c === "VN") vnProd = prod;
    countries[c] = {
      production: hosoEqTons(prod),
      exportCapacityRatio: ratio(0.9),
      aquacultureCostIndex: cost[c],
      priorAquacultureCostIndex: cost[c],
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
  const econ = SCENARIO_INITIAL_STATE_OVERRIDES_V1.vietnamProcessingEconomics;
  return {
    period: period(2015, 1),
    priorHosoFobPrice: Object.fromEntries(COUNTRY_IDS.map((c) => [c, usdPerHosoEqKg(priorFob[c])])) as MarketQuarterInput["priorHosoFobPrice"],
    countries: countries as MarketQuarterInput["countries"],
    demandMarkets: demandMarkets as MarketQuarterInput["demandMarkets"],
    vietnamDomestic: {
      domesticRawSupply: hosoEqTons(vnProd),
      domesticProcurementIntent: hosoEqTons(vnProd * cfg.domesticIntentRatio),
      trailingAverageDomesticPurchase: hosoEqTons(vnProd * 0.85),
      hosoEqRecoveryRatio: ratio(econ.hosoEqRecoveryRatio),
      processingExportCostUsdPerKg: usdPerHosoEqKg(
        cfg.processingCostPlusMargin !== undefined ? cfg.processingCostPlusMargin - econ.requiredMarginUsdPerKg : econ.processingExportCostUsdPerKg
      ),
      requiredMarginUsdPerKg: usdPerHosoEqKg(econ.requiredMarginUsdPerKg),
    },
    pdVapDemand: { pdDemand: hosoEqTons(300000), vapDemand: hosoEqTons(120000) },
  };
}

function run(cfg: Config, quarters = 6) {
  const fob = { ...STEADY_FOB };
  let last!: ReturnType<typeof calculateMarketQuarter>;
  for (let q = 0; q < quarters; q++) {
    last = calculateMarketQuarter(buildInput(cfg, fob), MARKET_PARAMETERS_V1, { next: () => 0.5 } as never);
    for (const c of COUNTRY_IDS) fob[c] = unwrapUnit(last.hosoPrices[c].price);
  }
  const inLanded = unwrapUnit(calculateLandedPrice(last.hosoPrices.IN.price, "IN", RAW_MATERIALS_PARAMETERS_V1).landedPrice);
  const ecLanded = unwrapUnit(calculateLandedPrice(last.hosoPrices.EC.price, "EC", RAW_MATERIALS_PARAMETERS_V1).landedPrice);
  const vnDom = unwrapUnit(last.vietnamDomestic.price);
  const cheapest = Math.min(inLanded, ecLanded);
  return {
    vnFob: unwrapUnit(last.hosoPrices.VN.price),
    vnDom,
    inLanded,
    ecLanded,
    gapPct: ((vnDom - cheapest) / cheapest) * 100,
    bound: last.hosoPrices.VN.drivers.includes("COUNTRY_PRICE_SPREAD_BOUNDED"),
  };
}

const CONFIGS: readonly Config[] = [
  // --- T1〜T12 相当（VN 有利を維持する参照点） ---
  { label: "T1-4 参照 (VNコスト0.94/豊漁)", vnCostIndex: 0.94, importCostIndex: 1.0, ecCapacityMult: 1.0, inCapacityMult: 1.0, vnUtilization: 0.9, domesticIntentRatio: 0.9 },
  { label: "T5-6 参照 (中立)", vnCostIndex: 1.0, importCostIndex: 1.0, ecCapacityMult: 1.0, inCapacityMult: 1.0, vnUtilization: 0.85, domesticIntentRatio: 0.95 },

  // --- T13〜T24 構造転換: EC/IN 増産 + VN コスト上昇 ---
  { label: "S1: EC+15% IN+8%, VNコスト1.15, 稼働0.85", vnCostIndex: 1.15, importCostIndex: 0.95, ecCapacityMult: 1.15, inCapacityMult: 1.08, vnUtilization: 0.85, domesticIntentRatio: 1.0 },
  { label: "S2: EC+20% IN+10%, VNコスト1.25, 稼働0.85", vnCostIndex: 1.25, importCostIndex: 0.92, ecCapacityMult: 1.2, inCapacityMult: 1.1, vnUtilization: 0.85, domesticIntentRatio: 1.0 },
  { label: "S3: EC+25% IN+12%, VNコスト1.35, 稼働0.85", vnCostIndex: 1.35, importCostIndex: 0.9, ecCapacityMult: 1.25, inCapacityMult: 1.12, vnUtilization: 0.85, domesticIntentRatio: 1.0 },

  // --- S2 構造の上での VN 季節変動（安いTurn / 高いTurn） ---
  { label: "S2 + 豊漁Q3 (稼働1.00, 意向0.85)", vnCostIndex: 1.25, importCostIndex: 0.92, ecCapacityMult: 1.2, inCapacityMult: 1.1, vnUtilization: 1.0, domesticIntentRatio: 0.85 },
  { label: "S2 + 端境期Q1 (稼働0.68, 意向1.20)", vnCostIndex: 1.25, importCostIndex: 0.92, ecCapacityMult: 1.2, inCapacityMult: 1.1, vnUtilization: 0.68, domesticIntentRatio: 1.2 },
  { label: "S3 + 豊漁Q3 (稼働1.00, 意向0.85)", vnCostIndex: 1.35, importCostIndex: 0.9, ecCapacityMult: 1.25, inCapacityMult: 1.12, vnUtilization: 1.0, domesticIntentRatio: 0.85 },
  { label: "S3 + 端境期Q1 (稼働0.68, 意向1.20)", vnCostIndex: 1.35, importCostIndex: 0.9, ecCapacityMult: 1.25, inCapacityMult: 1.12, vnUtilization: 0.68, domesticIntentRatio: 1.2 },

  // --- 加工経済（Scenario の initialStateOverrides から設定可能）を絞った場合 ---
  { label: "P0.60 T1-4豊漁", vnCostIndex: 0.94, importCostIndex: 1.0, ecCapacityMult: 1.0, inCapacityMult: 1.0, vnUtilization: 0.9, domesticIntentRatio: 0.9, processingCostPlusMargin: 0.6 },
  { label: "P0.60 S2 通常Q", vnCostIndex: 1.25, importCostIndex: 0.92, ecCapacityMult: 1.2, inCapacityMult: 1.1, vnUtilization: 0.85, domesticIntentRatio: 1.0, processingCostPlusMargin: 0.6 },
  { label: "P0.60 S2 豊漁Q3", vnCostIndex: 1.25, importCostIndex: 0.92, ecCapacityMult: 1.2, inCapacityMult: 1.1, vnUtilization: 1.0, domesticIntentRatio: 0.85, processingCostPlusMargin: 0.6 },
  { label: "P0.60 S2 端境期Q1", vnCostIndex: 1.25, importCostIndex: 0.92, ecCapacityMult: 1.2, inCapacityMult: 1.1, vnUtilization: 0.68, domesticIntentRatio: 1.2, processingCostPlusMargin: 0.6 },
  { label: "P0.60 S3 端境期Q1", vnCostIndex: 1.35, importCostIndex: 0.9, ecCapacityMult: 1.25, inCapacityMult: 1.12, vnUtilization: 0.68, domesticIntentRatio: 1.2, processingCostPlusMargin: 0.6 },
  { label: "P0.45 S2 豊漁Q3", vnCostIndex: 1.25, importCostIndex: 0.92, ecCapacityMult: 1.2, inCapacityMult: 1.1, vnUtilization: 1.0, domesticIntentRatio: 0.85, processingCostPlusMargin: 0.45 },
  { label: "P0.45 S2 端境期Q1", vnCostIndex: 1.25, importCostIndex: 0.92, ecCapacityMult: 1.2, inCapacityMult: 1.1, vnUtilization: 0.68, domesticIntentRatio: 1.2, processingCostPlusMargin: 0.45 },
  { label: "P0.45 T1-4豊漁", vnCostIndex: 0.94, importCostIndex: 1.0, ecCapacityMult: 1.0, inCapacityMult: 1.0, vnUtilization: 0.9, domesticIntentRatio: 0.9, processingCostPlusMargin: 0.45 },
  { label: "P0.45 T7 ショック(供給-50%,コスト1.60)", vnCostIndex: 1.6, importCostIndex: 1.0, ecCapacityMult: 1.0, inCapacityMult: 1.0, vnUtilization: 0.6, domesticIntentRatio: 1.3, processingCostPlusMargin: 0.45 },
];

console.log("# T13以降の調達切替構造 — 到達域の実測（エンジン無改変・6四半期収束値）");
console.log(["config", "VN_fob", "VN_domestic", "IN着地", "EC着地", "VN−最安輸入", "調達判断", "spread"].join("\t"));
for (const cfg of CONFIGS) {
  const r = run(cfg);
  console.log(
    [
      cfg.label,
      r.vnFob.toFixed(3),
      r.vnDom.toFixed(3),
      r.inLanded.toFixed(3),
      r.ecLanded.toFixed(3),
      (r.gapPct >= 0 ? "+" : "") + r.gapPct.toFixed(1) + "%",
      r.gapPct > 0 ? "**輸入有利**" : "国内有利",
      r.bound ? "BOUND" : "-",
    ].join("\t")
  );
}
