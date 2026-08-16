// ShrimpX V2 — シナリオ由来の市場×商品ライフサイクル解決（Dynamic Scenario 1）
//
// 「市場の長期構造（どの市場でHOSO/PD/VAPがいつ立ち上がるか）はシナリオの管轄」
// という整理に基づき、ScenarioDefinition.productLifecycleOverrides を市場モジュールの
// 既定パラメータへ適用した実効パラメータを返す唯一の入口。
//
// 【なぜ独立ファイルか】
//  - market/productLifecycle.ts に置くと市場モジュールがシナリオ型へ依存してしまう
//    （依存方向は scenario → market の一方向に保つ）。
//  - 解決結果を参照する場所が複数ある（ターン処理・観測需要の公開・営業基盤の
//    成熟度係数・期初情報画面）。同じ turn で別々の構成比が使われると、
//    プレイヤーへ見せる情報と実際の需要がズレるため、入口を1つに固定する。

import { ProductLifecycleParameters, PRODUCT_LIFECYCLE_PARAMETERS_V1, resolveProductLifecycleParameters } from "../market/productLifecycle";
import { ScenarioDefinition } from "./types";

/**
 * 解決結果のキャッシュ。ScenarioDefinition は不変オブジェクトなので、
 * 参照が同じなら結果も同じ。ターンごとに再構築・再検証しないための最適化であり、
 * 計算結果そのものには影響しない（純粋関数のメモ化）。
 */
const resolvedCache = new WeakMap<ScenarioDefinition, ProductLifecycleParameters>();

/**
 * シナリオ定義に対する実効ライフサイクルパラメータを返す。
 * 上書きを持たないシナリオでは PRODUCT_LIFECYCLE_PARAMETERS_V1 そのもの
 * （同一参照）を返すため、既存挙動と完全に一致する。
 */
export function resolveScenarioProductLifecycleParameters(definition: ScenarioDefinition): ProductLifecycleParameters {
  const overrides = definition.productLifecycleOverrides;
  if (overrides === undefined) return PRODUCT_LIFECYCLE_PARAMETERS_V1;
  const cached = resolvedCache.get(definition);
  if (cached !== undefined) return cached;
  const resolved = resolveProductLifecycleParameters(PRODUCT_LIFECYCLE_PARAMETERS_V1, overrides);
  resolvedCache.set(definition, resolved);
  return resolved;
}
