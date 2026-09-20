// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1: Turn別指数の解決（唯一のSSoT）
//
// 【この1ファイルが指数解決の正典である】会社費用単価・建設費・原料価格捕捉の
// いずれについても、「そのTurnの指数がいくつか」を決めるのはここだけである。
// finance / capex / market の各モジュールは、この関数の戻り値を受け取るだけで
// 自前の補間・自前の既定値を持たない。
//
// 【補間規則を二重定義しない】キーフレーム補間は interpolation.ts の
// interpolateKeyframeValue（LongTermTrend と同一実装）へ委譲する。
//
// 【未指定は必ず 1.00】シナリオが何も宣言していない場合、すべての指数は
// 中立値 1.00 になる。呼び出し側は 1.00 のとき現行と完全に同一の計算になる
// ように実装する責務を負う（finance/parameters.ts・capex・market 各所参照）。

import { interpolateKeyframeValue } from "./interpolation";
import {
  ConstructionCostPolicyId,
  CostIndexTrack,
  OperatingCostIndexKey,
  ScenarioDefinition,
  ScenarioValidationError,
} from "./types";

/** 指数の中立値。この値のとき、すべての適用先は現行の計算と完全に一致する。 */
export const NEUTRAL_COST_INDEX = 1.0;

/** 建設費算定方式の既定（Scenario未指定時）。 */
export const DEFAULT_CONSTRUCTION_COST_POLICY: ConstructionCostPolicyId = "legacy-requested-cost";

/**
 * 【ENG-DS2-COST-FOUNDATION-1】建設費算定方式の全列挙（この1箇所が正典）。
 *
 * resolveProjectBudget は "indexed-required-cost-v1" 以外をすべて legacy 扱いにするため、
 * 綴り違いの policy は **黙って legacy へ落ちる**（指数を効かせたつもりで効かないRunが
 * 生まれる）。validation 側がこの列挙で弾く。
 */
export const CONSTRUCTION_COST_POLICY_IDS: readonly ConstructionCostPolicyId[] = [
  "legacy-requested-cost",
  "indexed-required-cost-v1",
];

/** operatingCostInflation で宣言できるキーの全列挙（診断・テストの網羅性確認用）。 */
export const OPERATING_COST_INDEX_KEYS: readonly OperatingCostIndexKey[] = [
  "sellingLogistics",
  "regularLabor",
  "temporaryLabor",
  "factoryFixed",
  "factoryUtilityVariable",
  "adminFixed",
  "qualityAssurance",
  "construction",
];

function resolveTrack(track: CostIndexTrack | undefined, turn: number, label: string): number {
  if (track === undefined) return NEUTRAL_COST_INDEX;
  const value = interpolateKeyframeValue(track.keyframes, track.interpolation, turn, label);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ScenarioValidationError(`${label}: 指数は0より大きい有限数である必要があります。turn=${turn} 値=${value}`);
  }
  return value;
}

/**
 * 会社P&L費用単価・建設費のTurn別指数を解決する。
 * 宣言が無いキー・宣言そのものが無いシナリオでは必ず 1.00 を返す。
 */
export function resolveOperatingCostIndex(
  definition: ScenarioDefinition,
  key: OperatingCostIndexKey,
  turn: number
): number {
  const settings = definition.operatingCostInflation;
  if (settings === undefined) return NEUTRAL_COST_INDEX;
  return resolveTrack(settings.tracks[key], turn, `operatingCostInflation(${settings.settingsId}).${key}`);
}

/** 全キーぶんの指数を一度に解決する（TurnEconomicsProjection・診断用）。 */
export function resolveAllOperatingCostIndices(
  definition: ScenarioDefinition,
  turn: number
): Readonly<Record<OperatingCostIndexKey, number>> {
  const result = {} as Record<OperatingCostIndexKey, number>;
  for (const key of OPERATING_COST_INDEX_KEYS) {
    result[key] = resolveOperatingCostIndex(definition, key, turn);
  }
  return result;
}

/**
 * ベトナム国内原料市場の価格捕捉指数を解決する。
 * 宣言が無ければ 1.00（＝需給乗数の基準値を一切動かさない）。
 */
export function resolveRawPriceCaptureIndex(definition: ScenarioDefinition, turn: number): number {
  const settings = definition.rawMarketPricing;
  if (settings === undefined) return NEUTRAL_COST_INDEX;
  return resolveTrack(settings.rawPriceCaptureIndex, turn, `rawMarketPricing(${settings.settingsId}).rawPriceCaptureIndex`);
}

/** 建設費指数（operatingCostInflation の "construction" トラック）。 */
export function resolveConstructionCostIndex(definition: ScenarioDefinition, turn: number): number {
  return resolveOperatingCostIndex(definition, "construction", turn);
}

/** 建設費算定方式。未指定時は必ず "legacy-requested-cost"。 */
export function resolveConstructionCostPolicy(definition: ScenarioDefinition): ConstructionCostPolicyId {
  return definition.constructionCostPolicy ?? DEFAULT_CONSTRUCTION_COST_POLICY;
}
