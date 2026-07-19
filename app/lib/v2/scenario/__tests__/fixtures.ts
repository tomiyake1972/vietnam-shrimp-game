// テスト用の共通フィクスチャ。*.test.ts に一致しないため node:test には
// 拾われない（package.json のテストglob）。

import { CountryId, COUNTRY_IDS, DemandMarketId, DEMAND_MARKET_IDS } from "../../market/types";
import {
  ScenarioDefinition,
  ScenarioPrehistory,
  ScenarioInitialStateOverrides,
  ScenarioVariationSettings,
  ScenarioEvent,
  LongTermTrend,
} from "../types";

function recordFor<T>(ids: readonly string[], value: T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const id of ids) out[id] = value;
  return out;
}

export function testPrehistory(overrides?: Partial<ScenarioPrehistory>): ScenarioPrehistory {
  return {
    lengthYears: 3,
    priorHosoFobPriceUsdPerKg: recordFor(COUNTRY_IDS, 5.0) as Readonly<Record<CountryId, number>>,
    priorVietnamDomesticPriceUsdPerKg: 4.8,
    priorWorldDemandTrendNote: "テスト用の前史メモ",
    priorMarketConsumptionHosoEqTons: recordFor(DEMAND_MARKET_IDS, 100000) as Readonly<Record<DemandMarketId, number>>,
    countryAquacultureCostIndex: recordFor(COUNTRY_IDS, 1.0) as Readonly<Record<CountryId, number>>,
    countrySupplyHosoEqTons: recordFor(COUNTRY_IDS, 200000) as Readonly<Record<CountryId, number>>,
    growingInventoryHosoEqTons: recordFor(COUNTRY_IDS, 50000) as Readonly<Record<CountryId, number>>,
    frozenInventoryHosoEqTons: recordFor(COUNTRY_IDS, 20000) as Readonly<Record<CountryId, number>>,
    farmerExpectedPriceUsdPerKg: recordFor(COUNTRY_IDS, 4.9) as Readonly<Record<CountryId, number>>,
    carriedOverEvents: [],
    ...overrides,
  };
}

export function testInitialStateOverrides(
  overrides?: Partial<ScenarioInitialStateOverrides>
): ScenarioInitialStateOverrides {
  return {
    vietnamProcessingEconomics: {
      hosoYieldRatio: 0.6,
      processingExportCostUsdPerKg: 0.8,
      requiredMarginUsdPerKg: 0.25,
    },
    vietnamTrailingAverageDomesticPurchaseHosoEqTons: 40000,
    initialDomesticProcurementIntentHosoEqTons: 42000,
    ...overrides,
  };
}

export function testVariationSettings(overrides?: Partial<ScenarioVariationSettings>): ScenarioVariationSettings {
  return { allowedModes: ["canonical", "variation"], defaultMode: "canonical", ...overrides };
}

/** 最小限の妥当なScenarioDefinition。個々のテストはoverridesで差分だけ与える。 */
export function testScenarioDefinition(overrides?: Partial<ScenarioDefinition>): ScenarioDefinition {
  return {
    scenarioId: "test-scenario",
    version: "0.0.1",
    title: "テストシナリオ",
    durationTurns: 24,
    publicBackground: "テスト用の公開背景説明。",
    gmDescription: "テスト用のGM向け説明。",
    postGameExplanation: "テスト用のゲーム終了後説明。",
    prehistory: testPrehistory(),
    initialStateOverrides: testInitialStateOverrides(),
    longTermTrends: [],
    scheduledEvents: [],
    informationReleases: [],
    variationSettings: testVariationSettings(),
    ...overrides,
  };
}

export function testEvent(overrides?: Partial<ScenarioEvent>): ScenarioEvent {
  return {
    eventId: "test-event",
    eventType: "DISEASE_OUTBREAK",
    targetCountries: ["VN"],
    targetMarkets: [],
    startTurn: 5,
    durationTurns: 3,
    rampUpTurns: 1,
    recoveryTurns: 2,
    hiddenDescription: "テスト用イベント",
    effects: [{ variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: -0.1 }],
    informationReleaseIds: [],
    ...overrides,
  };
}

export function testTrend(overrides?: Partial<LongTermTrend>): LongTermTrend {
  return {
    trendId: "test-trend",
    variable: "COUNTRY_CAPACITY",
    scope: { kind: "country", countryId: "VN" },
    interpolation: "linear",
    keyframes: [
      { turn: 1, value: 100000 },
      { turn: 24, value: 120000 },
    ],
    ...overrides,
  };
}
