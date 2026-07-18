// ShrimpX V2 — TurnPhase 状態機械（Phase 0B）
//
// 全体実装計画書 第3章のフェーズ表（P0〜P8）に対応する骨格。
// 前進のみ許可し、スキップ・後退・二重実行を拒否する純粋関数として実装する。
// スナップショット復元・管理者操作は本ファイルの遷移関数に混在させず、
// 将来のApplication層に委ねる（本ファイルはドメイン内の「通常の1手」のみを扱う）。

import { PeriodV2, nextPeriod } from "./period";

export class TurnPhaseTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnPhaseTransitionError";
  }
}

/** 全体実装計画書 第3章のターン内フェーズ（P0開幕〜P8決算）。 */
export type TurnPhase =
  | "P0_OPEN"
  | "P1_MARKET"
  | "P2_STRATEGY"
  | "P3_SALES"
  | "P4_PROCUREMENT"
  | "P5_OPERATIONS"
  | "P6_CLEAR"
  | "P7_EXECUTE"
  | "P8_CLOSE";

/** P0→P8の順序。配列のindexがそのまま前進順序になる。 */
export const TURN_PHASE_ORDER: readonly TurnPhase[] = [
  "P0_OPEN",
  "P1_MARKET",
  "P2_STRATEGY",
  "P3_SALES",
  "P4_PROCUREMENT",
  "P5_OPERATIONS",
  "P6_CLEAR",
  "P7_EXECUTE",
  "P8_CLOSE",
];

const PHASE_INDEX: ReadonlyMap<TurnPhase, number> = new Map(
  TURN_PHASE_ORDER.map((phase, i) => [phase, i])
);

/** 値がTurnPhaseとして妥当かどうかを判定する（型ガード）。 */
export function isValidTurnPhase(v: unknown): v is TurnPhase {
  return typeof v === "string" && PHASE_INDEX.has(v as TurnPhase);
}

function assertTurnPhase(v: unknown, label: string): asserts v is TurnPhase {
  if (!isValidTurnPhase(v)) {
    throw new TurnPhaseTransitionError(`${label} が不正なTurnPhaseです。受け取った値: ${JSON.stringify(v)}`);
  }
}

/** 現在のフェーズ・期からなる「通常の1手」の状態。 */
export interface TurnState {
  readonly period: PeriodV2;
  readonly phase: TurnPhase;
}

/**
 * 現在のTurnStateから次のフェーズへの遷移結果。
 * P8_CLOSEから遷移すると Period が1つ進み P0_OPEN に戻る（要件どおり）。
 */
export function advanceTurnPhase(current: TurnState): TurnState {
  assertTurnPhase(current.phase, "current.phase");
  const currentIndex = PHASE_INDEX.get(current.phase)!;

  if (current.phase === "P8_CLOSE") {
    return { period: nextPeriod(current.period), phase: "P0_OPEN" };
  }

  const nextIndex = currentIndex + 1;
  const nextPhase = TURN_PHASE_ORDER[nextIndex];
  return { period: current.period, phase: nextPhase };
}

/**
 * targetへの遷移が current から見て合法な「1手前進」かどうかを検証する純粋関数。
 * 不正な場合は例外を投げる（スキップ・後退・同一フェーズへの二重実行を拒否）。
 *
 * スナップショット復元・管理者による強制上書きはこの関数の対象外
 * （将来のApplication層が別経路で扱う）。
 */
export function assertLegalTurnPhaseTransition(current: TurnState, target: TurnState): void {
  assertTurnPhase(current.phase, "current.phase");
  assertTurnPhase(target.phase, "target.phase");

  const expected = advanceTurnPhase(current);
  const samePeriod = expected.period === target.period;
  const samePhase = expected.phase === target.phase;

  if (!samePeriod || !samePhase) {
    throw new TurnPhaseTransitionError(
      `不正なTurnPhase遷移です。現在: period=${current.period}, phase=${current.phase} / ` +
        `要求された遷移先: period=${target.period}, phase=${target.phase} / ` +
        `許可される唯一の遷移先: period=${expected.period}, phase=${expected.phase}`
    );
  }
}

/** P0_OPEN, 指定Periodから始まる初期TurnStateを作る。 */
export function initialTurnState(period: PeriodV2): TurnState {
  return { period, phase: "P0_OPEN" };
}
