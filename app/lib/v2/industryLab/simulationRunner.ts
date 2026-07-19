// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） シミュレーションランナー
//
// シナリオ選択 → シナリオ初期化 → 当期シナリオ入力生成 → 市場入力へ変換 →
// 市場・価格形成計算 → 当期結果を履歴へ保存 → 市場結果をScenarioTurnFeedbackへ
// 渡す → 次四半期へ進む、という実装指示 §3 のパイプラインを実装する純粋関数群。
//
// Redis・API Route・外部サービスには一切依存しない（実装指示 §11）。
// 市場・シナリオモジュールへは、それぞれの安全な公開口（"../market"・
// "../scenario"）からのみアクセスし、app/lib/v2/index.ts の一括importは
// 使わない（Redis関連モジュールが将来増えても本ファイルには影響しないため）。

import { periodToString } from "../core/period";
import { hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../core/units";
import { createRandomStream } from "../core/random";
import { COUNTRY_IDS, CountryId, MarketQuarterResult } from "../market/types";
import { calculateMarketQuarter, MARKET_PARAMETERS_V1 } from "../market";
import {
  ScenarioDefinition,
  ScenarioTurnInput,
  ScenarioTurnFeedback,
  ResolvedScenarioEvent,
  PreviousMarketContext,
  initializeScenario,
  getScenarioTurnInput,
  advanceScenarioTurn,
  getAvailableInformation,
  toMarketQuarterInput,
  eventIntensityAtTurn,
  ALL_SCENARIO_DEFINITIONS,
} from "../scenario";
import { INDUSTRY_LAB_ASSUMPTIONS_V1, IndustryLabAssumptions } from "./assumptions";
import {
  IndustrySimulationConfig,
  IndustrySimulationState,
  IndustrySimulationResult,
  IndustryQuarterRecord,
  ActiveScenarioEvent,
  ScenarioEventPhase,
  IndustrySimulationError,
} from "./types";

const MIN_TURNS = 1;

/** scenarioIdから5つの代表シナリオ定義を検索する。見つからなければ例外。 */
export function findScenarioDefinition(scenarioId: string): ScenarioDefinition {
  const definition = ALL_SCENARIO_DEFINITIONS.find((d) => d.scenarioId === scenarioId);
  if (!definition) {
    throw new IndustrySimulationError(
      `scenarioId "${scenarioId}" に一致するシナリオ定義が見つかりません。利用可能なシナリオ: ${ALL_SCENARIO_DEFINITIONS.map((d) => d.scenarioId).join(", ")}`
    );
  }
  return definition;
}

/**
 * シミュレーションを初期化する。ScenarioDefinitionの検証（validateScenarioDefinition経由）は
 * initializeScenario内部で行われる。configそのものは変更しない。
 */
export function initializeIndustrySimulation(config: IndustrySimulationConfig): IndustrySimulationState {
  const definition = findScenarioDefinition(config.scenarioId);
  if (!Number.isInteger(config.turns) || config.turns < MIN_TURNS || config.turns > definition.durationTurns) {
    throw new IndustrySimulationError(
      `turns は${MIN_TURNS}〜${definition.durationTurns}（シナリオ"${definition.scenarioId}"のdurationTurns）の整数である必要があります。受け取った値: ${config.turns}`
    );
  }

  const scenarioState = initializeScenario(definition, config.mode, config.seed);

  return {
    config,
    scenarioDefinition: definition,
    scenarioState,
    quarters: [],
    isComplete: false,
  };
}

/** イベントの現在の発現段階を判定する（eventEngine.calculateEventIntensityと同じ境界を使う）。 */
function determineEventPhase(resolved: ResolvedScenarioEvent, turn: number): ScenarioEventPhase {
  const relativeTurn = turn - resolved.resolvedStartTurn;
  if (relativeTurn < 0) return "beforeStart";
  if (relativeTurn < resolved.resolvedRampUpTurns) return "rampUp";
  const durationEnd = resolved.resolvedRampUpTurns + resolved.resolvedDurationTurns;
  if (relativeTurn < durationEnd) return "active";
  const recoveryEnd = durationEnd + resolved.resolvedRecoveryTurns;
  if (relativeTurn < recoveryEnd) return "recovering";
  return "ended";
}

function buildActiveEvents(resolvedEvents: readonly ResolvedScenarioEvent[], turn: number): readonly ActiveScenarioEvent[] {
  return resolvedEvents.map((resolved) => ({
    eventId: resolved.source.eventId,
    eventType: resolved.source.eventType,
    targetCountries: resolved.source.targetCountries,
    targetMarkets: resolved.source.targetMarkets,
    resolvedStartTurn: resolved.resolvedStartTurn,
    phase: determineEventPhase(resolved, turn),
    intensity: eventIntensityAtTurn(resolved, turn),
    effects: resolved.source.effects,
    hiddenDescription: resolved.source.hiddenDescription,
  }));
}

function priorHosoFobPriceFromPrehistory(
  definition: ScenarioDefinition
): PreviousMarketContext["priorHosoFobPrice"] {
  const result = {} as Record<CountryId, ReturnType<typeof usdPerHosoEqKg>>;
  for (const c of COUNTRY_IDS) {
    result[c] = usdPerHosoEqKg(definition.prehistory.priorHosoFobPriceUsdPerKg[c]);
  }
  return result;
}

function priorHosoFobPriceFromLastQuarter(lastResult: MarketQuarterResult): PreviousMarketContext["priorHosoFobPrice"] {
  const result = {} as Record<CountryId, ReturnType<typeof usdPerHosoEqKg>>;
  for (const c of COUNTRY_IDS) {
    result[c] = lastResult.hosoPrices[c].price;
  }
  return result;
}

/**
 * 当期のPreviousMarketContextを組み立てる（実装指示 §5）。
 *  - ターン1: シナリオ前史の前期HOSO価格・初期国内調達希望量をそのまま使う
 *    （すでにシナリオモジュールが用意している値であり、ここでの新規暫定値ではない）。
 *  - ターン2以降: 前期価格は前四半期の実際の市場結果から、国内調達希望量は
 *    「直近実績の移動平均 × 仮置き比率」（IndustryLabAssumptions）から求める。
 */
function buildPreviousMarketContext(
  state: IndustrySimulationState,
  turn: number,
  scenarioTurnInput: ScenarioTurnInput,
  assumptions: IndustryLabAssumptions
): PreviousMarketContext {
  if (turn === 1) {
    return {
      priorHosoFobPrice: priorHosoFobPriceFromPrehistory(state.scenarioDefinition),
      domesticProcurementIntent: hosoEqTons(
        Math.max(0, state.scenarioDefinition.initialStateOverrides.initialDomesticProcurementIntentHosoEqTons)
      ),
    };
  }

  const lastQuarter = state.quarters[state.quarters.length - 1];
  if (!lastQuarter) {
    throw new IndustrySimulationError(`turn=${turn}: 直前の四半期の実績が見つかりません（内部不整合）。`);
  }

  return {
    priorHosoFobPrice: priorHosoFobPriceFromLastQuarter(lastQuarter.marketResult),
    domesticProcurementIntent: hosoEqTons(
      Math.max(
        0,
        unwrapUnit(scenarioTurnInput.vietnamTrailingAverageDomesticPurchase) *
          assumptions.domesticProcurementIntentToTrailingAverageRatio
      )
    ),
  };
}

/** turn毎に固有かつ再現可能な市場ショック用の乱数シードを導出する。 */
function deriveMarketRandomSeed(baseSeed: string, turn: number): string {
  return `${baseSeed}::market::turn${turn}`;
}

/**
 * シミュレーションを1四半期分だけ進める。入力のstateは変更せず、新しいstateを返す。
 * すでにisComplete=trueの場合は例外を投げる。
 */
export function advanceIndustrySimulation(state: IndustrySimulationState): IndustrySimulationState {
  if (state.isComplete) {
    throw new IndustrySimulationError(
      `シミュレーションはすでに完了しています（${state.quarters.length}四半期分の実績があります）。これ以上advanceIndustrySimulationは呼べません。`
    );
  }

  const turn = state.scenarioState.currentTurn;
  const assumptions = state.config.assumptions ?? INDUSTRY_LAB_ASSUMPTIONS_V1;

  const scenarioTurnInput = getScenarioTurnInput(state.scenarioState, turn);
  const previousMarketContext = buildPreviousMarketContext(state, turn, scenarioTurnInput, assumptions);
  const marketInput = toMarketQuarterInput(scenarioTurnInput, previousMarketContext);
  const marketResult = calculateMarketQuarter(
    marketInput,
    MARKET_PARAMETERS_V1,
    createRandomStream(deriveMarketRandomSeed(state.config.seed, turn))
  );

  const releases = state.scenarioDefinition.informationReleases;
  const record: IndustryQuarterRecord = {
    turn,
    periodLabel: periodToString(scenarioTurnInput.period),
    scenarioTurnInput,
    marketInput,
    marketResult,
    activeEvents: buildActiveEvents(state.scenarioState.resolvedEvents, turn),
    publicInformation: getAvailableInformation(releases, turn, "public"),
    standardInformation: getAvailableInformation(releases, turn, "standard"),
    advancedInformation: getAvailableInformation(releases, turn, "advanced"),
    gmInformation: getAvailableInformation(releases, turn, "gm"),
  };

  const feedback: ScenarioTurnFeedback = { realizedMarketResult: marketResult };

  // シナリオ自体の最終ターン（definition.durationTurns）にすでに到達している場合、
  // advanceScenarioTurnはこれ以上呼べない（例外を投げる）ため、その場合は
  // scenarioStateを進めずに終了する。
  const canAdvanceWithinScenario = turn < state.scenarioDefinition.durationTurns;
  const nextScenarioState = canAdvanceWithinScenario
    ? advanceScenarioTurn(state.scenarioState, feedback)
    : state.scenarioState;

  const quarters = [...state.quarters, record];
  const isComplete = turn >= state.config.turns || !canAdvanceWithinScenario;

  return {
    ...state,
    scenarioState: nextScenarioState,
    quarters,
    isComplete,
  };
}

/** シミュレーションを最後まで一括実行する。 */
export function runIndustrySimulation(config: IndustrySimulationConfig): IndustrySimulationResult {
  let state = initializeIndustrySimulation(config);
  while (!state.isComplete) {
    state = advanceIndustrySimulation(state);
  }
  return { config: state.config, quarters: state.quarters };
}
