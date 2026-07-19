// ShrimpX V2 — 代表5シナリオ バレルエクスポート（Phase 2、実装指示 §12）

export { BASELINE_SCENARIO } from "./baseline";
export { ECUADOR_EARLY_EXPANSION_SCENARIO } from "./ecuadorEarlyExpansion";
export { ECUADOR_DELAYED_EXPANSION_SCENARIO } from "./ecuadorDelayedExpansion";
export { GLOBAL_DISEASE_CRISIS_SCENARIO } from "./globalDiseaseCrisis";
export { GLOBAL_DEMAND_BOOM_SCENARIO } from "./globalDemandBoom";

import { BASELINE_SCENARIO } from "./baseline";
import { ECUADOR_EARLY_EXPANSION_SCENARIO } from "./ecuadorEarlyExpansion";
import { ECUADOR_DELAYED_EXPANSION_SCENARIO } from "./ecuadorDelayedExpansion";
import { GLOBAL_DISEASE_CRISIS_SCENARIO } from "./globalDiseaseCrisis";
import { GLOBAL_DEMAND_BOOM_SCENARIO } from "./globalDemandBoom";
import { ScenarioDefinition } from "../types";

/** 実装指示 §12で挙げられた5つの代表シナリオ一覧。 */
export const ALL_SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
  BASELINE_SCENARIO,
  ECUADOR_EARLY_EXPANSION_SCENARIO,
  ECUADOR_DELAYED_EXPANSION_SCENARIO,
  GLOBAL_DISEASE_CRISIS_SCENARIO,
  GLOBAL_DEMAND_BOOM_SCENARIO,
];
