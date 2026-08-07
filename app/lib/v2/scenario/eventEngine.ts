// ShrimpX V2 — イベント発現・合成エンジン（Phase 2）
//
// イベントは基礎変数にのみ作用する（実装指示 §2・§7）。本ファイルは
// 「開始前は無効・ramp-upで立ち上がり・継続期間中は満額・終了後は段階的に
// 回復する」という発現曲線（calculateEventIntensity）と、複数イベントが
// 同じ (変数, 対象) に重複した場合の合成規則（composeEventEffects）を実装する。
//
// 合成規則（実装指示 §7「重複時の合成規則を定義し、文書化」に対応。
// docs/v2/SCENARIO_EVENT_ARCHITECTURE_v0.1.md にも同内容を記載する）:
//   - multiplicative効果: 全イベントの倍率を掛け合わせる
//     （例: -10%×2件 → 0.9 × 0.9 = 0.81、単純合算の-20%にはしない）。
//   - additivePoint効果: 全イベントのポイント差分を合算する
//     （例: 生残率 -18pt と -5pt が重なれば -23pt）。
//   - 最終値は必ずVARIABLE_DOMAINの範囲へclampする。

import { CountryId, DemandMarketId } from "../market/types";
import { RandomStream } from "../core/random";
import {
  ScenarioEvent,
  ResolvedScenarioEvent,
  ScenarioMode,
  ScenarioBaseVariable,
  VARIABLE_SCOPE,
  VARIABLE_DOMAIN,
} from "./types";

function clampNumber(value: number, min: number | undefined, max: number | undefined): number {
  let v = value;
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
}

/**
 * イベントの発現強度を [0,1] で返す。
 * relativeTurn = 現在のturn - resolvedStartTurn。
 *  - relativeTurn < 0: 未発生（0）
 *  - 0 <= relativeTurn < rampUpTurns: 線形に立ち上がる（rampUpTurns=0なら即100%）
 *  - rampUpTurns <= relativeTurn < rampUpTurns+durationTurns: 100%を維持
 *  - その後 recoveryTurns の間に線形に0へ回復する（recoveryTurns=0なら即0%）
 *  - それ以降: 0（完全に終了）
 */
export function calculateEventIntensity(
  rampUpTurns: number,
  durationTurns: number,
  recoveryTurns: number,
  relativeTurn: number
): number {
  if (relativeTurn < 0) return 0;
  if (relativeTurn < rampUpTurns) {
    return rampUpTurns > 0 ? relativeTurn / rampUpTurns : 1;
  }
  const durationEnd = rampUpTurns + durationTurns;
  if (relativeTurn < durationEnd) return 1;
  const recoveryEnd = durationEnd + recoveryTurns;
  if (relativeTurn < recoveryEnd) {
    const recoveryProgress = relativeTurn - durationEnd;
    return recoveryTurns > 0 ? 1 - recoveryProgress / recoveryTurns : 0;
  }
  return 0;
}

/** 指定turnにおける、このResolvedScenarioEventの発現強度。 */
export function eventIntensityAtTurn(event: ResolvedScenarioEvent, turn: number): number {
  const relativeTurn = turn - event.resolvedStartTurn;
  return calculateEventIntensity(
    event.resolvedRampUpTurns,
    event.resolvedDurationTurns,
    event.resolvedRecoveryTurns,
    relativeTurn
  );
}

// ---------------------------------------------------------------------
// Canonical / Variation modeでのイベント解決
// ---------------------------------------------------------------------

const MAGNITUDE_SCALE_MIN = 0.1;
const MAGNITUDE_SCALE_MAX = 3.0;

/**
 * シナリオ定義のイベント群を、モードに応じて「実際に使う」開始ターン・
 * 期間・強度へ解決する。
 *  - canonical: 定義どおり。randomStreamは一切消費しない
 *    （実装指示 §9「外生イベントの時期・強度・期間を固定」）。
 *  - variation: variationRangeで指定された範囲内でjitterを適用する。
 *    randomStreamの消費順序はイベント定義配列の順序に固定する（再現性）。
 */
export function resolveScenarioEvents(
  events: readonly ScenarioEvent[],
  mode: ScenarioMode,
  randomStream: RandomStream
): readonly ResolvedScenarioEvent[] {
  return events.map((event) => {
    if (mode === "canonical" || !event.variationRange) {
      return {
        source: event,
        resolvedStartTurn: event.startTurn,
        resolvedDurationTurns: event.durationTurns,
        resolvedRampUpTurns: event.rampUpTurns,
        resolvedRecoveryTurns: event.recoveryTurns,
        resolvedMagnitudeScale: 1,
      };
    }

    const range = event.variationRange;
    const startJitter =
      range.startTurnJitter !== undefined
        ? Math.round((randomStream.next() * 2 - 1) * range.startTurnJitter)
        : 0;
    const magnitudeJitter =
      range.magnitudeJitterRatio !== undefined
        ? 1 + (randomStream.next() * 2 - 1) * range.magnitudeJitterRatio
        : 1;
    const durationJitter =
      range.durationJitterTurns !== undefined
        ? Math.round((randomStream.next() * 2 - 1) * range.durationJitterTurns)
        : 0;
    const recoveryJitter =
      range.recoveryJitterTurns !== undefined
        ? Math.round((randomStream.next() * 2 - 1) * range.recoveryJitterTurns)
        : 0;

    return {
      source: event,
      resolvedStartTurn: Math.max(1, event.startTurn + startJitter),
      resolvedDurationTurns: Math.max(1, event.durationTurns + durationJitter),
      resolvedRampUpTurns: event.rampUpTurns,
      resolvedRecoveryTurns: Math.max(0, event.recoveryTurns + recoveryJitter),
      resolvedMagnitudeScale: clampNumber(magnitudeJitter, MAGNITUDE_SCALE_MIN, MAGNITUDE_SCALE_MAX),
    };
  });
}

// ---------------------------------------------------------------------
// 効果の合成
// ---------------------------------------------------------------------

export type EffectTargetId = CountryId | DemandMarketId | "GLOBAL";

export interface ComposedVariableEffect {
  readonly variable: ScenarioBaseVariable;
  readonly targetId: EffectTargetId;
  readonly multiplicativeFactor: number;
  readonly additivePointDelta: number;
  readonly contributingEventIds: readonly string[];
}

function composedKey(variable: ScenarioBaseVariable, targetId: EffectTargetId): string {
  return `${variable}:${targetId}`;
}

function targetsForEffect(event: ScenarioEvent, variable: ScenarioBaseVariable): readonly EffectTargetId[] {
  const scope = VARIABLE_SCOPE[variable];
  if (scope === "country") return event.targetCountries;
  if (scope === "market") return event.targetMarkets;
  return ["GLOBAL"];
}

/**
 * 指定turnにおいて有効な全イベントの効果を、(変数, 対象) ごとに合成する。
 * 強度が0（未発生・完全終了）のイベントは寄与しない。入力の resolvedEvents は変更しない。
 */
export function composeEventEffects(
  resolvedEvents: readonly ResolvedScenarioEvent[],
  turn: number
): ReadonlyMap<string, ComposedVariableEffect> {
  const result = new Map<string, ComposedVariableEffect>();

  for (const resolved of resolvedEvents) {
    const intensity = eventIntensityAtTurn(resolved, turn);
    if (intensity <= 0) continue;

    for (const effect of resolved.source.effects) {
      const targets = targetsForEffect(resolved.source, effect.variable);
      for (const targetId of targets) {
        const key = composedKey(effect.variable, targetId);
        const existing = result.get(key) ?? {
          variable: effect.variable,
          targetId,
          multiplicativeFactor: 1,
          additivePointDelta: 0,
          contributingEventIds: [],
        };

        if (effect.mode === "multiplicative") {
          // 強度・シナリオ強度スケールは「1からの乖離」にだけ適用する
          // （magnitude=1.08で強度0.5なら1.04。倍率が1に近いほど自然な挙動になる）。
          const deviation = (effect.magnitude - 1) * intensity * resolved.resolvedMagnitudeScale;
          result.set(key, {
            ...existing,
            multiplicativeFactor: existing.multiplicativeFactor * (1 + deviation),
            contributingEventIds: [...existing.contributingEventIds, resolved.source.eventId],
          });
        } else {
          const delta = effect.magnitude * intensity * resolved.resolvedMagnitudeScale;
          result.set(key, {
            ...existing,
            additivePointDelta: existing.additivePointDelta + delta,
            contributingEventIds: [...existing.contributingEventIds, resolved.source.eventId],
          });
        }
      }
    }
  }

  return result;
}

/** 基準値に合成済み効果を適用し、変数の定義域へclampする。 */
export function applyComposedEffect(
  baseValue: number,
  variable: ScenarioBaseVariable,
  composed: ComposedVariableEffect | undefined
): number {
  const domain = VARIABLE_DOMAIN[variable];
  if (!composed) return clampNumber(baseValue, domain.min, domain.max);
  const withMultiplicative = baseValue * composed.multiplicativeFactor;
  const withAdditive = withMultiplicative + composed.additivePointDelta;
  return clampNumber(withAdditive, domain.min, domain.max);
}

/** 指定turnで何らかの強度(>0)で発現している全イベントIDの一覧。 */
export function activeEventIdsAtTurn(resolvedEvents: readonly ResolvedScenarioEvent[], turn: number): readonly string[] {
  return resolvedEvents
    .filter((e) => eventIntensityAtTurn(e, turn) > 0)
    .map((e) => e.source.eventId);
}
