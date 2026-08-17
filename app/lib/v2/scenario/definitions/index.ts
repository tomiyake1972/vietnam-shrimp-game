// ShrimpX V2 — 代表5シナリオ バレルエクスポート（Phase 2、実装指示 §12）

export { BASELINE_SCENARIO } from "./baseline";
export { ECUADOR_EARLY_EXPANSION_SCENARIO } from "./ecuadorEarlyExpansion";
export { ECUADOR_DELAYED_EXPANSION_SCENARIO } from "./ecuadorDelayedExpansion";
export { GLOBAL_DISEASE_CRISIS_SCENARIO } from "./globalDiseaseCrisis";
export { GLOBAL_DEMAND_BOOM_SCENARIO } from "./globalDemandBoom";
export { DYNAMIC_SCENARIO_1 } from "./dynamicScenario1";
export { DYNAMIC_SCENARIO_2 } from "./dynamicScenario2";

import { BASELINE_SCENARIO } from "./baseline";
import { ECUADOR_EARLY_EXPANSION_SCENARIO } from "./ecuadorEarlyExpansion";
import { ECUADOR_DELAYED_EXPANSION_SCENARIO } from "./ecuadorDelayedExpansion";
import { GLOBAL_DISEASE_CRISIS_SCENARIO } from "./globalDiseaseCrisis";
import { GLOBAL_DEMAND_BOOM_SCENARIO } from "./globalDemandBoom";
import { DYNAMIC_SCENARIO_1 } from "./dynamicScenario1";
import { DYNAMIC_SCENARIO_2 } from "./dynamicScenario2";
import { ScenarioDefinition } from "../types";

/**
 * ラボ作成画面のシナリオ選択肢が読む一覧。
 *
 * 【Dynamic Scenario 1 について】Testplay 実施の判断により選択可能にしている。
 * タイトルに "— Development" を付けており、まだ正式な production シナリオでは
 * ないことが選択時に分かるようにしてある（production の既定シナリオは
 * 従来どおり baseline のまま変えていない）。
 */
export const ALL_SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
  BASELINE_SCENARIO,
  ECUADOR_EARLY_EXPANSION_SCENARIO,
  ECUADOR_DELAYED_EXPANSION_SCENARIO,
  GLOBAL_DISEASE_CRISIS_SCENARIO,
  GLOBAL_DEMAND_BOOM_SCENARIO,
  DYNAMIC_SCENARIO_1,
  DYNAMIC_SCENARIO_2,
];

/**
 * 【開発中シナリオ】まだプレイヤー向けシナリオ選択肢へは出さないシナリオ。
 *
 * ALL_SCENARIO_DEFINITIONS（画面のシナリオセレクタが直接読む一覧）とは
 * 意図的に分離しておくための枠。scenarioId を明示した benchmark スクリプト・
 * CLI からのみ到達させたいシナリオをここへ置く
 * （industryLab/cli/scenarioAliases.ts の resolveScenarioDefinition が
 * この一覧も探索する）。
 *
 * Dynamic Scenario 1 は Testplay 実施の判断により
 * ALL_SCENARIO_DEFINITIONS へ移したため、現在この一覧は空。
 */
export const DEVELOPMENT_SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [];
