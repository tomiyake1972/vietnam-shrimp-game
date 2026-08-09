// ShrimpX V2 — 32Q Management Console: シミュレーション実行（Phase 1）
//
// 【最重要の設計方針】
// **fast-run 専用の簡易計算ロジックを作らない。**
// 1ターンの処理は、通常ゲームとまったく同じ以下の経路だけを通る。
//
//   buildPublicMarketInfo
//     → buildCompanyOwnState（会社ごと）
//     → generateStandardAiDecisionWithDiagnostics（会社ごと）
//     → advanceCompanyLabQuarter（環境進化・生産・財務クローズを含む）
//
// 4 Turns / 32 Turns は、この1ターン処理を単純に繰り返すだけである。
// 「まとめて計算する近道」は存在しない。
//
// 【決定論性】
// このモジュールは Date.now() / Math.random() を**ゲーム判断へ渡さない**。
// startedAt / completedAt は metadata としてのみ受け取る（引数で注入する）。
// 同じ config・同じ開始状態なら、何度実行しても同じ履歴になる。
//
// 【STOP の扱い】
// 各ターンの処理**前**に shouldStop を確認する。処理途中で中断することはない。
// したがって completedTurns は常に「最後まで処理し終えたターン数」であり、
// 中途半端な状態が保存されることはない。

import {
  advanceCompanyLabQuarter,
  buildCompanyOwnState,
  buildPublicMarketInfo,
  initializeCompanyLab,
} from "../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../standardAi/policy";
import { CompanyDecisionInput, CompanyLabConfig } from "../types";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import { STANDARD_AI_PARAMETERS_V1 } from "../standardAi/parameters";
import { STRATEGY_PROFILE_SCHEMA_VERSION } from "../strategyProfile/types";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS, SimulationRun, SimulationSession, SimulationTurnOutcome } from "./types";

/** ゲームパラメータの版（再現性の記録用。複数モジュールの版を連結する）。 */
export function resolveGameParameterVersion(): string {
  return `${PRODUCTION_PARAMETERS_V1.parametersVersion}+${FINANCE_PARAMETERS_V1.parametersVersion}`;
}

/**
 * Standard AI の版。
 * StandardAiParameters に版番号フィールドが無いため、再現性に効く主要パラメータから
 * 決定論的な指紋を作る（存在しないフィールドを捏造しない）。
 */
export function resolveStandardAiVersion(): string {
  const p = STANDARD_AI_PARAMETERS_V1;
  return [
    "standardAi",
    `sustained=${p.capexSustainedUtilizationThreshold}`,
    `capexGate=${p.capexCashGateMode}:${p.capexCostSafetyRatio}`,
    `importMix=${p.importMixRatio}`,
    `rawTarget=${p.rawMaterialTargetQuarters}`,
  ].join("/");
}

export interface CreateSimulationSessionInput {
  readonly simulationRunId: string;
  readonly scenarioId: string;
  readonly seed: string;
  /** 実行したいターン数（既定32）。 */
  readonly requestedTurns?: number;
  /** metadata 用のタイムスタンプ。ゲーム判断には使わない。 */
  readonly startedAt: string;
}

/**
 * 新しいシミュレーションセッションを作る。
 * config.turns には要求ターン数をそのまま渡すため、32Q連続実行がそのまま行える
 * （シナリオ側の STANDARD_SCENARIO_DURATION_TURNS も32であり、整合している）。
 */
export function createSimulationSession(input: CreateSimulationSessionInput): SimulationSession {
  const requestedTurns = input.requestedTurns ?? MANAGEMENT_CONSOLE_STANDARD_TURNS;
  const config: CompanyLabConfig = {
    scenarioId: input.scenarioId,
    mode: "canonical",
    seed: input.seed,
    turns: requestedTurns,
  };
  const { state, fixtures } = initializeCompanyLab(config);
  const run: SimulationRun = {
    simulationRunId: input.simulationRunId,
    scenarioId: input.scenarioId,
    scenarioVersion: state.scenarioState.definition.version,
    seed: input.seed,
    gameParameterVersion: resolveGameParameterVersion(),
    standardAiVersion: resolveStandardAiVersion(),
    strategyProfileVersion: STRATEGY_PROFILE_SCHEMA_VERSION,
    startingTurn: state.scenarioState.currentTurn,
    requestedTurns,
    completedTurns: 0,
    startedAt: input.startedAt,
    completedAt: null,
    stopReason: "running",
    errorMessage: null,
    failedAtTurn: null,
  };
  return { run, state, fixtures, config };
}

/**
 * ちょうど1ターンだけ進める。通常ゲームと同じ経路だけを通る。
 *
 * 失敗した場合は state を一切変更せず（前のターンまでの状態を保つ）、
 * completedTurns も増やさない。**失敗したターンを成功扱いにしない。**
 */
export function advanceSimulationTurn(session: SimulationSession, completedAt: string): SimulationTurnOutcome {
  if (session.state.isComplete) {
    return {
      session: { ...session, run: { ...session.run, stopReason: "scenario_end", completedAt } },
      advanced: false,
      error: null,
    };
  }

  const turn = session.state.scenarioState.currentTurn;
  try {
    const publicInfo = buildPublicMarketInfo(session.state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const fixture of session.fixtures) {
      const ownState = buildCompanyOwnState(session.state, fixture);
      const { decision } = generateStandardAiDecisionWithDiagnostics(
        fixture,
        ownState,
        publicInfo,
        session.state.currentPeriod,
        turn
      );
      decisions[fixture.companyId] = decision;
    }
    const nextState = advanceCompanyLabQuarter(session.state, session.fixtures, decisions);
    const completedTurns = session.run.completedTurns + 1;
    const reachedRequested = completedTurns >= session.run.requestedTurns;
    return {
      session: {
        ...session,
        state: nextState,
        run: {
          ...session.run,
          completedTurns,
          stopReason: reachedRequested ? "completed" : nextState.isComplete ? "scenario_end" : "running",
          completedAt: reachedRequested || nextState.isComplete ? completedAt : null,
        },
      },
      advanced: true,
      error: null,
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return {
      // 状態は進めない。completedTurns も増やさない。
      session: {
        ...session,
        run: {
          ...session.run,
          stopReason: "error",
          errorMessage: error.message,
          failedAtTurn: turn,
          completedAt,
        },
      },
      advanced: false,
      error,
    };
  }
}

export interface AdvanceManyInput {
  readonly session: SimulationSession;
  /** 進めたいターン数。 */
  readonly turns: number;
  /** 各ターンの処理**前**に呼ばれる。true を返すとそこで停止する。 */
  readonly shouldStop?: () => boolean;
  /** metadata 用のタイムスタンプ。 */
  readonly timestamp: string;
}

/**
 * 指定ターン数だけ進める。1 Turn / 4 Turns / 32 Turns はすべてこの関数を通る
 * （ターン数が違うだけで、処理内容はまったく同じ）。
 */
export function advanceSimulationTurns(input: AdvanceManyInput): SimulationSession {
  let session = input.session;
  for (let i = 0; i < input.turns; i++) {
    if (input.shouldStop?.()) {
      return { ...session, run: { ...session.run, stopReason: "stopped_by_user", completedAt: input.timestamp } };
    }
    if (session.state.isComplete) {
      return { ...session, run: { ...session.run, stopReason: "scenario_end", completedAt: input.timestamp } };
    }
    const outcome = advanceSimulationTurn(session, input.timestamp);
    session = outcome.session;
    if (!outcome.advanced) return session;
  }
  return session;
}
