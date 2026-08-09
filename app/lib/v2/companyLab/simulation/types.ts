// ShrimpX V2 — 32Q Management Console: Simulation Run の型（Phase 1）
//
// 【このモジュールの位置づけ】
// Game Owner が 32Q（8年）を手動で高速に回すための実行単位を表す。
// **ゲームの計算そのものは一切ここに無い。** 通常ゲームと同じ
// initializeCompanyLab / buildCompanyOwnState / generateStandardAiDecisionWithDiagnostics /
// advanceCompanyLabQuarter を呼ぶだけで、fast-run 専用の簡易ロジックは作らない。

import { CompanyLabConfig, CompanyLabState, CompanyFixture } from "../types";

/** 標準の32Q（8年）。Management Console の既定実行長。 */
export const MANAGEMENT_CONSOLE_STANDARD_TURNS = 32;

/**
 * 実行が終わった理由。
 * 「途中で止めた」と「最後まで走った」と「失敗した」を混同しないために必ず記録する。
 */
export type SimulationStopReason =
  /** 要求ターン数を最後まで処理した。 */
  | "completed"
  /** Game Owner が STOP を押した（完了済みターンは保存済み）。 */
  | "stopped_by_user"
  /** ターン処理が例外で失敗した（失敗したターンは完了扱いにしない）。 */
  | "error"
  /** シナリオ側の上限（durationTurns）に到達した。 */
  | "scenario_end"
  /** まだ実行中。 */
  | "running";

/**
 * 32Qテストを再現するためのメタデータ。
 *
 * 【再現性】simulationRunId 以外のすべてが同じなら、同じ結果になる
 * （engine.ts が Date.now()・Math.random() をゲーム判断へ混ぜないため）。
 * startedAt / completedAt は metadata であり、判断には使わない。
 */
export interface SimulationRun {
  readonly simulationRunId: string;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly seed: string;
  readonly gameParameterVersion: string;
  readonly standardAiVersion: string;
  readonly strategyProfileVersion: string;
  /** 実行開始時点のターン番号（新規作成なら1）。 */
  readonly startingTurn: number;
  /** 要求されたターン数（1 / 4 / 32 等）。 */
  readonly requestedTurns: number;
  /** 実際に処理を完了したターン数。失敗したターンは含めない。 */
  readonly completedTurns: number;
  /** metadata（判断には使わない）。 */
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly stopReason: SimulationStopReason;
  /** stopReason==="error" のときの原因。 */
  readonly errorMessage: string | null;
  /** 失敗したターン番号（成功扱いにしない）。 */
  readonly failedAtTurn: number | null;
}

/** 実行中のセッション（状態 + fixtures + run メタデータ）。 */
export interface SimulationSession {
  readonly run: SimulationRun;
  readonly state: CompanyLabState;
  readonly fixtures: readonly CompanyFixture[];
  readonly config: CompanyLabConfig;
}

/** 1ターン進めた結果。 */
export interface SimulationTurnOutcome {
  readonly session: SimulationSession;
  /** このターンが実際に処理されたか（false ならシナリオ終端や失敗）。 */
  readonly advanced: boolean;
  readonly error: Error | null;
}
