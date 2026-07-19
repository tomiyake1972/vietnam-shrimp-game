// テスト用の共通フィクスチャ。*.test.ts に一致しないため node:test には
// 拾われない（package.json のテストglob: app/lib/**/__tests__/**/*.test.ts）。

import { hosoEqTons, usdPerHosoEqKg, ratio, score0to100, unwrapUnit } from "../../core/units";
import { period } from "../../core/period";
import {
  CountryId,
  COUNTRY_IDS,
  DemandMarketId,
  DEMAND_MARKET_IDS,
  CountrySupplyInput,
  DemandMarketInput,
  MarketQuarterInput,
  VietnamDomesticInput,
  PdVapDemandInput,
} from "../types";

const BASE_HOSO_PRICE: Readonly<Record<CountryId, number>> = { EC: 4.7, IN: 5.25, ID: 5.45, VN: 5.6 };

// 世界供給合計の目標値と、市場価格形成モジュール仕様書 v0.2 §16の簡易世界影響度
// （EC45/IN25/VN18/ID12）に比例した国別生産量。この比率で生産量を配分すると、
// 「国別需要配分 = 世界需要 × 同じ重み」を使うMarket Openingの下で、
// 世界需給が均衡していれば国別の需給圧力もほぼゼロになる（＝どのテストも
// 特定の国が常時キャップに張り付いた状態から始まらない、クリーンな基準点）。
const WORLD_SUPPLY_TARGET = 160000;
const WORLD_INFLUENCE_WEIGHT: Readonly<Record<CountryId, number>> = { EC: 0.45, IN: 0.25, VN: 0.18, ID: 0.12 };
const BASE_EXPORT_CAPACITY_RATIO = 0.8;
const BASE_PRODUCTION: Readonly<Record<CountryId, number>> = COUNTRY_IDS.reduce(
  (acc, c) => ({ ...acc, [c]: (WORLD_SUPPLY_TARGET * WORLD_INFLUENCE_WEIGHT[c]) / BASE_EXPORT_CAPACITY_RATIO }),
  {} as Record<CountryId, number>
);

export function baseCountryInput(
  country: CountryId,
  overrides?: Partial<CountrySupplyInput>
): CountrySupplyInput {
  return {
    production: hosoEqTons(BASE_PRODUCTION[country]),
    exportCapacityRatio: ratio(BASE_EXPORT_CAPACITY_RATIO),
    aquacultureCostIndex: 1.0,
    priorAquacultureCostIndex: 1.0,
    qualityScore: score0to100(50),
    reliabilityScore: score0to100(70),
    pdProcessingCapacity: hosoEqTons(15000),
    vapProcessingCapacity: hosoEqTons(5000),
    ...overrides,
  };
}

/**
 * 5市場合計の需要が WORLD_SUPPLY_TARGET とほぼ一致するよう、
 * economicIndex=1.0・populationGrowthRate=0（成長なし）を既定値とする
 * 均衡基準点。個々のテストはeconomicIndex/populationGrowthRate/production等を
 * 上書きして特定方向のショックだけを発生させる。
 */
export function baseDemandMarketInput(overrides?: Partial<DemandMarketInput>): DemandMarketInput {
  return {
    priorPeriodConsumption: hosoEqTons(WORLD_SUPPLY_TARGET / DEMAND_MARKET_IDS.length),
    economicIndex: 1.0,
    populationGrowthRate: 0,
    ...overrides,
  };
}

export function baseVietnamDomesticInput(overrides?: Partial<VietnamDomesticInput>): VietnamDomesticInput {
  return {
    domesticRawSupply: hosoEqTons(30000),
    domesticProcurementIntent: hosoEqTons(30000),
    trailingAverageDomesticPurchase: hosoEqTons(28000),
    hosoEqRecoveryRatio: ratio(1.0),
    processingExportCostUsdPerKg: usdPerHosoEqKg(0.8),
    requiredMarginUsdPerKg: usdPerHosoEqKg(0.3),
    ...overrides,
  };
}

export function basePdVapDemandInput(overrides?: Partial<PdVapDemandInput>): PdVapDemandInput {
  return {
    pdDemand: hosoEqTons(40000),
    vapDemand: hosoEqTons(15000),
    ...overrides,
  };
}

/**
 * 世界全体でおおむね需給が均衡するように調整した基準入力。
 * 4か国 × exportableSupply(=production×0.8) の合計と、5市場の需要合計が
 * 近い値になるよう production を調整している（極端な供給過剰・不足の
 * ベースラインにならないようにするため。個々のテストは、この基準値から
 * 特定の入力だけを変更して比較する）。
 */
export function baseMarketQuarterInput(
  overrides?: Partial<MarketQuarterInput>
): MarketQuarterInput {
  const countries = {} as Record<CountryId, CountrySupplyInput>;
  for (const c of COUNTRY_IDS) {
    countries[c] = baseCountryInput(c);
  }

  const demandMarkets = {} as Record<DemandMarketId, DemandMarketInput>;
  for (const m of DEMAND_MARKET_IDS) {
    demandMarkets[m] = baseDemandMarketInput();
  }

  const priorHosoFobPrice = {} as Record<CountryId, ReturnType<typeof usdPerHosoEqKg>>;
  for (const c of COUNTRY_IDS) {
    priorHosoFobPrice[c] = usdPerHosoEqKg(BASE_HOSO_PRICE[c]);
  }

  return {
    period: period(2015, 1),
    priorHosoFobPrice,
    countries,
    demandMarkets,
    vietnamDomestic: baseVietnamDomesticInput(),
    pdVapDemand: basePdVapDemandInput(),
    ...overrides,
  };
}

export function withCountryOverride(
  input: MarketQuarterInput,
  country: CountryId,
  overrides: Partial<CountrySupplyInput>
): MarketQuarterInput {
  return {
    ...input,
    countries: {
      ...input.countries,
      [country]: { ...input.countries[country], ...overrides },
    },
  };
}

export function withAllCountriesOverride(
  input: MarketQuarterInput,
  overrides: Partial<CountrySupplyInput>
): MarketQuarterInput {
  const countries = {} as Record<CountryId, CountrySupplyInput>;
  for (const c of COUNTRY_IDS) {
    countries[c] = { ...input.countries[c], ...overrides };
  }
  return { ...input, countries };
}

/** 全4か国の生産量を一律 factor 倍する（比率は保ったまま供給ショックを作る）。 */
export function scaleAllCountriesProduction(input: MarketQuarterInput, factor: number): MarketQuarterInput {
  const countries = {} as Record<CountryId, CountrySupplyInput>;
  for (const c of COUNTRY_IDS) {
    const current = input.countries[c];
    countries[c] = { ...current, production: hosoEqTons(unwrapUnit(current.production) * factor) };
  }
  return { ...input, countries };
}
