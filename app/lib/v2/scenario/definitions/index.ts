// ShrimpX V2 — 代表5シナリオ バレルエクスポート（Phase 2、実装指示 §12）

export { BASELINE_SCENARIO } from "./baseline";
export { ECUADOR_EARLY_EXPANSION_SCENARIO } from "./ecuadorEarlyExpansion";
export { ECUADOR_DELAYED_EXPANSION_SCENARIO } from "./ecuadorDelayedExpansion";
export { GLOBAL_DISEASE_CRISIS_SCENARIO } from "./globalDiseaseCrisis";
export { GLOBAL_DEMAND_BOOM_SCENARIO } from "./globalDemandBoom";
export { DYNAMIC_SCENARIO_1 } from "./dynamicScenario1";

import { BASELINE_SCENARIO } from "./baseline";
import { ECUADOR_EARLY_EXPANSION_SCENARIO } from "./ecuadorEarlyExpansion";
import { ECUADOR_DELAYED_EXPANSION_SCENARIO } from "./ecuadorDelayedExpansion";
import { GLOBAL_DISEASE_CRISIS_SCENARIO } from "./globalDiseaseCrisis";
import { GLOBAL_DEMAND_BOOM_SCENARIO } from "./globalDemandBoom";
import { DYNAMIC_SCENARIO_1 } from "./dynamicScenario1";
import { ScenarioDefinition } from "../types";

/** 実装指示 §12で挙げられた5つの代表シナリオ一覧。 */
export const ALL_SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
  BASELINE_SCENARIO,
  ECUADOR_EARLY_EXPANSION_SCENARIO,
  ECUADOR_DELAYED_EXPANSION_SCENARIO,
  GLOBAL_DISEASE_CRISIS_SCENARIO,
  GLOBAL_DEMAND_BOOM_SCENARIO,
];

/**
 * 【開発中シナリオ】まだプレイヤー向けシナリオ選択肢へは出さないシナリオ。
 *
 * ALL_SCENARIO_DEFINITIONS（画面のシナリオセレクタが直接読む一覧）とは
 * 意図的に分離している。architecture / scenario modifier / News /
 * deterministic benchmark が揃うまで、研修・本番プレイの選択肢へ露出させない。
 *
 * benchmark スクリプトや CLI からは scenarioId を明示すれば解決できる
 * （industryLab/cli/scenarioAliases.ts の resolveScenarioDefinition が
 * この一覧も探索する）。正式公開時はこの配列から
 * ALL_SCENARIO_DEFINITIONS へ移すだけでよい。
 */
export const DEVELOPMENT_SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [DYNAMIC_SCENARIO_1];
