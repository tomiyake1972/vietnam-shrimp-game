// ShrimpX V2 — 長期シナリオ・イベントモジュール エントリポイント（Phase 2）
//
// 画面・API・Redis保存・生成AIから独立した純粋なTypeScriptドメインモジュール。
// 想定される呼び出し方（実装指示 §13）:
//
//   const state = initializeScenario(definition, mode, randomSeed);
//   const turnInput = getScenarioTurnInput(state, state.currentTurn);
//   const marketInput = toMarketQuarterInput(turnInput, previousMarketContext);
//   const marketResult = calculateMarketQuarter(marketInput, MARKET_PARAMETERS_V1, randomStream);
//   const nextState = advanceScenarioTurn(state, { realizedMarketResult: marketResult });
//   const news = getAvailableInformation(state.definition.informationReleases, state.currentTurn, "public");

export * from "./types";
export * from "./validation";
export { assertSortedKeyframes, interpolateTrendValue } from "./interpolation";
export {
  calculateEventIntensity,
  eventIntensityAtTurn,
  resolveScenarioEvents,
  composeEventEffects,
  applyComposedEffect,
  activeEventIdsAtTurn,
} from "./eventEngine";
export type { EffectTargetId, ComposedVariableEffect } from "./eventEngine";
export { getAvailableInformation } from "./informationEngine";
export { initializeScenario, getScenarioTurnInput, advanceScenarioTurn } from "./scenarioEngine";
export { toMarketQuarterInput } from "./marketAdapter";
export { SCENARIO_ENGINE_PARAMETERS_V1 } from "./parameters";
export type { ScenarioEngineParameters } from "./parameters";
export {
  SCENARIO_PREHISTORY_BASELINE_V1,
  SCENARIO_INITIAL_STATE_OVERRIDES_V1,
  SCENARIO_VARIATION_SETTINGS_STANDARD,
  STANDARD_SCENARIO_DURATION_TURNS,
} from "./parameters";
export * from "./definitions";
