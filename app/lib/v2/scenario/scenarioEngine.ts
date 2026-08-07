// ShrimpX V2 — シナリオ進行エンジン（Phase 2）
//
// initializeScenario / getScenarioTurnInput / advanceScenarioTurn を提供する。
// 本ファイルは「トレンド（無ければ既定値）→ イベント合成効果を適用 → 変数域へ
// clamp」という一貫したパイプラインで、シナリオ定義から各ターンの基礎変数
// （ScenarioTurnInput）を導出する純粋関数群である。価格は一切計算しない
// （実装指示 §2）。
//
// production の導出式（疾病による生残率低下が供給見通しを増やさないことを
// 保証する。実装指示 §15 テスト要件）:
//   production = capacity(turn) × utilization(turn) × survivalRate(turn) × productivity(turn)
// ただし EXPORTABLE_SUPPLY に明示的なLongTermTrendが定義されている場合は、
// その値（＋EXPORTABLE_SUPPLY自体への効果）を直接採用する
// （ScenarioBaseVariable定義コメント「能力等からの導出を上書きしたい場合の
// 直接指定用」）。

import { createRandomStream } from "../core/random";
import { PeriodV2, period } from "../core/period";
import { HosoEqTons, hosoEqTons, ratio, score0to100, usdPerHosoEqKg, unwrapUnit } from "../core/units";
import { COUNTRY_IDS, DEMAND_MARKET_IDS, CountryId, DemandMarketId } from "../market/types";
import {
  ScenarioDefinition,
  ScenarioMode,
  ScenarioState,
  ScenarioTurnInput,
  ScenarioTurnCountryVariables,
  ScenarioTurnMarketVariables,
  ScenarioTurnFeedback,
  ScenarioTurnRecord,
  ScenarioBaseVariable,
  LongTermTrend,
  ScenarioValidationError,
} from "./types";
import { assertValidScenarioDefinition } from "./validation";
import { interpolateTrendValue } from "./interpolation";
import {
  resolveScenarioEvents,
  composeEventEffects,
  applyComposedEffect,
  activeEventIdsAtTurn,
  ComposedVariableEffect,
} from "./eventEngine";
import { SCENARIO_ENGINE_PARAMETERS_V1, ScenarioEngineParameters } from "./parameters";

// ---------------------------------------------------------------------
// トレンドのルックアップ（(変数, スコープ) → LongTermTrend）
// ---------------------------------------------------------------------

function scopeKeyForCountry(countryId: CountryId): string {
  return `country:${countryId}`;
}
function scopeKeyForMarket(marketId: DemandMarketId): string {
  return `market:${marketId}`;
}
const GLOBAL_SCOPE_KEY = "global";

function buildTrendIndex(trends: readonly LongTermTrend[]): ReadonlyMap<string, LongTermTrend> {
  const map = new Map<string, LongTermTrend>();
  for (const trend of trends) {
    const scopeKey =
      trend.scope.kind === "country"
        ? scopeKeyForCountry(trend.scope.countryId)
        : trend.scope.kind === "market"
          ? scopeKeyForMarket(trend.scope.marketId)
          : GLOBAL_SCOPE_KEY;
    map.set(`${trend.variable}:${scopeKey}`, trend);
  }
  return map;
}

function trendValueOrDefault(
  trendIndex: ReadonlyMap<string, LongTermTrend>,
  variable: ScenarioBaseVariable,
  scopeKey: string,
  turn: number,
  fallback: number
): number {
  const trend = trendIndex.get(`${variable}:${scopeKey}`);
  return trend ? interpolateTrendValue(trend, turn) : fallback;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
function clampRange(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------
// ターン → Period（Year1 Q1 = 2015Q1。実装指示 §5「ゲーム開始は2015年」の
// 既存V1/V2慣習を踏襲）。
// ---------------------------------------------------------------------

function turnToPeriod(turn: number): PeriodV2 {
  const year = 2015 + Math.floor((turn - 1) / 4);
  const quarter = ((turn - 1) % 4) + 1;
  return period(year, quarter);
}

// ---------------------------------------------------------------------
// 養殖コスト指数（AQUACULTURE_COST × FEED_ENERGY_LABOR_COST乗数）。
// priorAquacultureCostIndex算出のため、任意のturnに対して呼べる形にする。
// ---------------------------------------------------------------------

function computeAquacultureCostIndex(
  definition: ScenarioDefinition,
  trendIndex: ReadonlyMap<string, LongTermTrend>,
  composed: ReadonlyMap<string, ComposedVariableEffect>,
  params: ScenarioEngineParameters,
  country: CountryId,
  turn: number
): number {
  const sk = scopeKeyForCountry(country);

  const baseCost = trendValueOrDefault(
    trendIndex,
    "AQUACULTURE_COST",
    sk,
    turn,
    definition.prehistory.countryAquacultureCostIndex[country]
  );
  const costWithEffect = applyComposedEffect(baseCost, "AQUACULTURE_COST", composed.get(`AQUACULTURE_COST:${country}`));

  const baseFeedEnergyLabor = trendValueOrDefault(
    trendIndex,
    "FEED_ENERGY_LABOR_COST",
    sk,
    turn,
    params.defaultFeedEnergyLaborCostMultiplier
  );
  const feedEnergyLaborWithEffect = applyComposedEffect(
    baseFeedEnergyLabor,
    "FEED_ENERGY_LABOR_COST",
    composed.get(`FEED_ENERGY_LABOR_COST:${country}`)
  );

  return Math.max(0, costWithEffect * feedEnergyLaborWithEffect);
}

// ---------------------------------------------------------------------
// 国別変数
// ---------------------------------------------------------------------

function backSolvedCapacityFallback(
  definition: ScenarioDefinition,
  params: ScenarioEngineParameters,
  country: CountryId
): number {
  const denom = params.defaultUtilizationRate * params.defaultSurvivalRate * params.defaultProductivity;
  const priorSupply = definition.prehistory.countrySupplyHosoEqTons[country];
  return denom > 0 ? priorSupply / denom : priorSupply;
}

function computeCountryVariables(
  definition: ScenarioDefinition,
  trendIndex: ReadonlyMap<string, LongTermTrend>,
  composed: ReadonlyMap<string, ComposedVariableEffect>,
  composedPrior: ReadonlyMap<string, ComposedVariableEffect> | undefined,
  params: ScenarioEngineParameters,
  country: CountryId,
  turn: number
): ScenarioTurnCountryVariables {
  const sk = scopeKeyForCountry(country);
  const effect = (variable: ScenarioBaseVariable): ComposedVariableEffect | undefined =>
    composed.get(`${variable}:${country}`);

  const capacityFallback = backSolvedCapacityFallback(definition, params, country);
  const capacity = applyComposedEffect(
    trendValueOrDefault(trendIndex, "COUNTRY_CAPACITY", sk, turn, capacityFallback),
    "COUNTRY_CAPACITY",
    effect("COUNTRY_CAPACITY")
  );
  const utilization = applyComposedEffect(
    trendValueOrDefault(trendIndex, "UTILIZATION_RATE", sk, turn, params.defaultUtilizationRate),
    "UTILIZATION_RATE",
    effect("UTILIZATION_RATE")
  );
  const survivalRate = applyComposedEffect(
    trendValueOrDefault(trendIndex, "SURVIVAL_RATE", sk, turn, params.defaultSurvivalRate),
    "SURVIVAL_RATE",
    effect("SURVIVAL_RATE")
  );
  const productivity = applyComposedEffect(
    trendValueOrDefault(trendIndex, "PRODUCTIVITY", sk, turn, params.defaultProductivity),
    "PRODUCTIVITY",
    effect("PRODUCTIVITY")
  );
  const diseasePressure = applyComposedEffect(
    trendValueOrDefault(trendIndex, "DISEASE_PRESSURE", sk, turn, params.defaultDiseasePressure),
    "DISEASE_PRESSURE",
    effect("DISEASE_PRESSURE")
  );
  const exportEligibilityRate = applyComposedEffect(
    trendValueOrDefault(trendIndex, "EXPORT_ELIGIBILITY_RATE", sk, turn, params.defaultExportEligibilityRate),
    "EXPORT_ELIGIBILITY_RATE",
    effect("EXPORT_ELIGIBILITY_RATE")
  );
  const qualityScoreRaw = applyComposedEffect(
    trendValueOrDefault(trendIndex, "QUALITY_SCORE", sk, turn, params.defaultQualityScore),
    "QUALITY_SCORE",
    effect("QUALITY_SCORE")
  );
  const reliabilityScoreRaw = applyComposedEffect(
    trendValueOrDefault(trendIndex, "SUPPLY_RELIABILITY", sk, turn, params.defaultReliabilityScore),
    "SUPPLY_RELIABILITY",
    effect("SUPPLY_RELIABILITY")
  );
  const logisticsCapacityRatio = applyComposedEffect(
    trendValueOrDefault(trendIndex, "LOGISTICS_CAPACITY", sk, turn, params.defaultLogisticsCapacityRatio),
    "LOGISTICS_CAPACITY",
    effect("LOGISTICS_CAPACITY")
  );
  const tradeRestrictionSeverity = applyComposedEffect(
    trendValueOrDefault(trendIndex, "TRADE_RESTRICTION", sk, turn, params.defaultTradeRestrictionSeverity),
    "TRADE_RESTRICTION",
    effect("TRADE_RESTRICTION")
  );

  const stockingVolumeFallback = capacity * utilization;
  const stockingVolume = applyComposedEffect(
    trendValueOrDefault(trendIndex, "STOCKING_VOLUME", sk, turn, stockingVolumeFallback),
    "STOCKING_VOLUME",
    effect("STOCKING_VOLUME")
  );

  const aquacultureCostIndex = computeAquacultureCostIndex(definition, trendIndex, composed, params, country, turn);
  const priorAquacultureCostIndex =
    turn > 1 && composedPrior
      ? computeAquacultureCostIndex(definition, trendIndex, composedPrior, params, country, turn - 1)
      : definition.prehistory.countryAquacultureCostIndex[country];

  const explicitSupplyTrend = trendIndex.get(`EXPORTABLE_SUPPLY:${sk}`);
  const productionRaw = explicitSupplyTrend
    ? applyComposedEffect(
        interpolateTrendValue(explicitSupplyTrend, turn),
        "EXPORTABLE_SUPPLY",
        effect("EXPORTABLE_SUPPLY")
      )
    : capacity * utilization * survivalRate * productivity;

  const pdCapacityFallback = productionRaw * params.defaultPdCapacityRatioOfProduction;
  const vapCapacityFallback = productionRaw * params.defaultVapCapacityRatioOfProduction;
  const pdProcessingCapacity = applyComposedEffect(
    trendValueOrDefault(trendIndex, "PD_PROCESSING_CAPACITY", sk, turn, pdCapacityFallback),
    "PD_PROCESSING_CAPACITY",
    effect("PD_PROCESSING_CAPACITY")
  );
  const vapProcessingCapacity = applyComposedEffect(
    trendValueOrDefault(trendIndex, "VAP_PROCESSING_CAPACITY", sk, turn, vapCapacityFallback),
    "VAP_PROCESSING_CAPACITY",
    effect("VAP_PROCESSING_CAPACITY")
  );

  // FROZEN_INVENTORYはグローバルスコープの基礎変数。国別prehistory基準値に
  // 世界共通の合成効果（倍率・加算）を同一に適用する簡略化
  // （国別の在庫積み上げロジックは将来モジュールのスコープ。§3参照）。
  const frozenInventoryBase = definition.prehistory.frozenInventoryHosoEqTons[country];
  const frozenInventoryAdjusted = applyComposedEffect(
    frozenInventoryBase,
    "FROZEN_INVENTORY",
    composed.get("FROZEN_INVENTORY:GLOBAL")
  );

  const growingInventoryBase = definition.prehistory.growingInventoryHosoEqTons[country];
  const farmerExpectedPriceBase = definition.prehistory.farmerExpectedPriceUsdPerKg[country];

  return {
    countryId: country,

    production: hosoEqTons(Math.max(0, productionRaw)),
    exportCapacityRatio: ratio(clamp01(exportEligibilityRate)),
    aquacultureCostIndex,
    priorAquacultureCostIndex,
    qualityScore: score0to100(clampRange(qualityScoreRaw, 0, 100)),
    reliabilityScore: score0to100(clampRange(reliabilityScoreRaw, 0, 100)),
    pdProcessingCapacity: hosoEqTons(Math.max(0, pdProcessingCapacity)),
    vapProcessingCapacity: hosoEqTons(Math.max(0, vapProcessingCapacity)),

    survivalRate: ratio(clamp01(survivalRate)),
    diseasePressure: ratio(clamp01(diseasePressure)),
    stockingVolume: hosoEqTons(Math.max(0, stockingVolume)),
    growingInventory: hosoEqTons(Math.max(0, growingInventoryBase)),
    frozenInventory: hosoEqTons(Math.max(0, frozenInventoryAdjusted)),
    farmerExpectedPriceUsdPerKg: usdPerHosoEqKg(Math.max(0, farmerExpectedPriceBase)),
    logisticsCapacityRatio: ratio(clamp01(logisticsCapacityRatio)),
    tradeRestrictionSeverity: ratio(clamp01(tradeRestrictionSeverity)),
  };
}

// ---------------------------------------------------------------------
// 需要市場別変数
// ---------------------------------------------------------------------

function computeMarketVariables(
  definition: ScenarioDefinition,
  trendIndex: ReadonlyMap<string, LongTermTrend>,
  composed: ReadonlyMap<string, ComposedVariableEffect>,
  params: ScenarioEngineParameters,
  market: DemandMarketId,
  turn: number
): ScenarioTurnMarketVariables {
  const sk = scopeKeyForMarket(market);
  const effect = (variable: ScenarioBaseVariable): ComposedVariableEffect | undefined =>
    composed.get(`${variable}:${market}`);

  const regionalDemand = applyComposedEffect(
    trendValueOrDefault(
      trendIndex,
      "REGIONAL_DEMAND",
      sk,
      turn,
      definition.prehistory.priorMarketConsumptionHosoEqTons[market]
    ),
    "REGIONAL_DEMAND",
    effect("REGIONAL_DEMAND")
  );
  const economicIndex = applyComposedEffect(
    trendValueOrDefault(trendIndex, "ECONOMIC_INDEX", sk, turn, params.defaultEconomicIndex),
    "ECONOMIC_INDEX",
    effect("ECONOMIC_INDEX")
  );
  const consumptionGrowth = applyComposedEffect(
    trendValueOrDefault(trendIndex, "CONSUMPTION_GROWTH", sk, turn, params.defaultConsumptionGrowthRate),
    "CONSUMPTION_GROWTH",
    effect("CONSUMPTION_GROWTH")
  );

  return {
    marketId: market,
    priorPeriodConsumption: hosoEqTons(Math.max(0, regionalDemand)),
    economicIndex,
    populationGrowthRate: consumptionGrowth,
  };
}

// ---------------------------------------------------------------------
// ベトナム国内買付のトレーリング平均（実現フィードバックの蓄積があれば
// それを使い、無ければ初期値を使う。実装指示 §11「前ターンから次ターンへの
// フィードバック」の最小限の実装）。
// ---------------------------------------------------------------------

function computeTrailingDomesticPurchase(
  state: ScenarioState,
  turn: number,
  params: ScenarioEngineParameters
): HosoEqTons {
  const window = params.domesticPurchaseTrailingWindowTurns;
  const samples: number[] = [];
  for (const record of state.turnHistory) {
    if (record.turn >= turn) continue;
    const effectiveDemand = record.feedback?.realizedMarketResult?.vietnamDomestic.effectiveDemand;
    if (effectiveDemand !== undefined) samples.push(unwrapUnit(effectiveDemand));
  }
  const recentSamples = samples.slice(-window);
  if (recentSamples.length === 0) {
    return hosoEqTons(Math.max(0, state.definition.initialStateOverrides.vietnamTrailingAverageDomesticPurchaseHosoEqTons));
  }
  const avg = recentSamples.reduce((a, b) => a + b, 0) / recentSamples.length;
  return hosoEqTons(Math.max(0, avg));
}

// ---------------------------------------------------------------------
// 公開関数
// ---------------------------------------------------------------------

/**
 * ScenarioDefinitionを検証し、イベントをmodeに応じて解決した初期状態を作る。
 * canonicalモード、またはvariationRangeを持たないイベントはrandomStreamを
 * 一切消費しない（実装指示 §9「外生イベントの時期・強度・期間を固定」）。
 */
export function initializeScenario(
  definition: ScenarioDefinition,
  mode: ScenarioMode,
  randomSeed: string
): ScenarioState {
  assertValidScenarioDefinition(definition);
  if (!definition.variationSettings.allowedModes.includes(mode)) {
    throw new ScenarioValidationError(
      `シナリオ(${definition.scenarioId})はmode="${mode}"を許可していません。許可されているmode: ${definition.variationSettings.allowedModes.join(", ")}`
    );
  }

  const randomStream = createRandomStream(randomSeed);
  const resolvedEvents = resolveScenarioEvents(definition.scheduledEvents, mode, randomStream);

  return {
    definition,
    mode,
    randomSeed,
    currentTurn: 1,
    resolvedEvents,
    turnHistory: [],
  };
}

/**
 * 指定ターンの基礎変数一式を返す。stateそのものは変更しない（純粋関数）。
 * turnはシナリオのdurationTurns範囲内である必要がある
 * （currentTurnとの前後関係は問わない。turnHistoryに記録された実現
 * フィードバックの範囲でのみ過去の実現値を参照する）。
 */
export function getScenarioTurnInput(state: ScenarioState, turn: number): ScenarioTurnInput {
  const { definition } = state;
  if (!Number.isInteger(turn) || turn < 1 || turn > definition.durationTurns) {
    throw new ScenarioValidationError(
      `turn は1〜${definition.durationTurns}の整数である必要があります。受け取った値: ${turn}`
    );
  }

  const params = SCENARIO_ENGINE_PARAMETERS_V1;
  const trendIndex = buildTrendIndex(definition.longTermTrends);
  const composed = composeEventEffects(state.resolvedEvents, turn);
  const composedPrior = turn > 1 ? composeEventEffects(state.resolvedEvents, turn - 1) : undefined;

  const countries = {} as Record<CountryId, ScenarioTurnCountryVariables>;
  for (const country of COUNTRY_IDS) {
    countries[country] = computeCountryVariables(definition, trendIndex, composed, composedPrior, params, country, turn);
  }

  const demandMarkets = {} as Record<DemandMarketId, ScenarioTurnMarketVariables>;
  for (const market of DEMAND_MARKET_IDS) {
    demandMarkets[market] = computeMarketVariables(definition, trendIndex, composed, params, market, turn);
  }

  const totalConsumption = DEMAND_MARKET_IDS.reduce(
    (sum, m) => sum + unwrapUnit(demandMarkets[m].priorPeriodConsumption),
    0
  );
  const pdDemand = hosoEqTons(Math.max(0, totalConsumption * params.pdDemandShareOfTotalConsumption));
  const vapDemand = hosoEqTons(Math.max(0, totalConsumption * params.vapDemandShareOfTotalConsumption));

  return {
    turn,
    period: turnToPeriod(turn),
    countries,
    demandMarkets,
    vietnamDomesticRawSupply: countries.VN.production,
    vietnamTrailingAverageDomesticPurchase: computeTrailingDomesticPurchase(state, turn, params),
    vietnamProcessingEconomics: definition.initialStateOverrides.vietnamProcessingEconomics,
    ...(definition.initialStateOverrides.vietnamFarmerEconomics !== undefined
      ? { vietnamFarmerEconomics: definition.initialStateOverrides.vietnamFarmerEconomics }
      : {}),
    pdVapDemand: { pdDemand, vapDemand },
    activeEventIds: activeEventIdsAtTurn(state.resolvedEvents, turn),
  };
}

/**
 * ターンを1つ進め、フィードバックをturnHistoryへ記録した新しいScenarioStateを返す。
 * 入力のstateは変更しない。すでに最終ターンに到達している場合は例外を投げる。
 */
export function advanceScenarioTurn(state: ScenarioState, feedback?: ScenarioTurnFeedback): ScenarioState {
  if (state.currentTurn >= state.definition.durationTurns) {
    throw new ScenarioValidationError(
      `シナリオ(${state.definition.scenarioId})はすでに最終ターン(${state.definition.durationTurns})に到達しています。advanceScenarioTurnはこれ以上呼べません。`
    );
  }
  const record: ScenarioTurnRecord = { turn: state.currentTurn, feedback };
  return {
    ...state,
    currentTurn: state.currentTurn + 1,
    turnHistory: [...state.turnHistory, record],
  };
}
