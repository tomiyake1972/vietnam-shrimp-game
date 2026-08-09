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
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyLabState } from "../types";
import { computeEffectiveFactories } from "../../capex/factoryConstruction";
import { calculateFactoryEffectiveCapacity } from "../../production/capacity";
import { unwrapUnit } from "../../core/units";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import { STANDARD_AI_PARAMETERS_V1 } from "../standardAi/parameters";
import { STRATEGY_PROFILE_SCHEMA_VERSION } from "../strategyProfile/types";
import { CapacitySnapshot, MANAGEMENT_CONSOLE_STANDARD_TURNS, SimulationRun, SimulationSession, SimulationTurnOutcome } from "./types";
import { extractAiTurnTrace } from "./analytics/aiTrace";
import { captureCapitalProjects, captureCompanyStateSnapshot, captureScenarioEvents, captureStrategy, captureWorldTurn } from "./aiPack/capture";
import type { ObservedDemandSnapshot } from "./analytics/dataset";
import type { PublicMarketInfo } from "../types";

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
  return { run, state, fixtures, config, aiTurnTraces: [], observedDemand: [], salesHeadcountByTurn: [], capacityByTurn: [], packCompanyTurns: [], packWorldTurns: [] };
}

/**
 * そのターン終了時点の会社別実効能力を拾う。
 * **能力の計算式をここへ書き直さない** — 既存の
 * computeEffectiveFactories / calculateFactoryEffectiveCapacity をそのまま通す。
 */
function captureCapacities(turn: number, state: CompanyLabState, fixtures: readonly CompanyFixture[]): readonly CapacitySnapshot[] {
  return fixtures.map((fixture) => {
    const capexForCompany = state.capexState.companies.find((c) => c.companyId === fixture.companyId);
    const effective = capexForCompany
      ? computeEffectiveFactories(fixture.factories, { companies: [capexForCompany] }, state.currentPeriod)
      : fixture.factories;
    const totals = effective.reduce(
      (acc, f) => {
        const c = calculateFactoryEffectiveCapacity(f);
        return {
          hoso: acc.hoso + unwrapUnit(c.hoso),
          pd: acc.pd + unwrapUnit(c.pd),
          vap: acc.vap + unwrapUnit(c.vap),
          commonProcessing: acc.commonProcessing + unwrapUnit(c.commonProcessing),
        };
      },
      { hoso: 0, pd: 0, vap: 0, commonProcessing: 0 }
    );
    return { turn, companyId: fixture.companyId, ...totals };
  });
}

/**
 * そのターンに実際に公開されていた観測需要を記録用に切り出す。
 * **再計算はしない** — buildPublicMarketInfo が既に構築した値をそのまま写すだけ。
 * 観測需要が未設定（旧スナップショット由来等）のターンは記録を作らない（0で埋めない）。
 */
function captureObservedDemand(turn: number, publicInfo: PublicMarketInfo): ObservedDemandSnapshot | null {
  const observed = publicInfo.observedMarketDemand;
  if (!observed) return null;
  return {
    turn,
    sourceTurn: observed.sourceQuarter,
    entries: observed.entries.map((e) => ({ market: e.market, observedDemandByProduct: e.observedDemandByProduct })),
  };
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
    const turnTraces = [];
    /** 【Vision駆動の戦略成長】その四半期の志・戦略ギャップ・新工場判断（会社別）。 */
    const strategyByCompany = new Map<string, ReturnType<typeof captureStrategy>>();
    for (const fixture of session.fixtures) {
      const ownState = buildCompanyOwnState(session.state, fixture);
      const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(
        fixture,
        ownState,
        publicInfo,
        session.state.currentPeriod,
        turn
      );
      decisions[fixture.companyId] = decision;
      // 【追加の計算をしない】diagnostics は上の1回の呼び出しで既に作られている値であり、
      // トレース記録のために Standard AI をもう一度回すことはない。
      turnTraces.push(extractAiTurnTrace(diagnostics));
      strategyByCompany.set(fixture.companyId, captureStrategy(diagnostics));
    }
    // 【AI Analysis Pack】期首状態は「当期処理前」に撮る（処理後では期首にならない）。
    const beginningStates = new Map(session.fixtures.map((f) => [f.companyId, captureCompanyStateSnapshot(session.state, f)]));

    const nextState = advanceCompanyLabQuarter(session.state, session.fixtures, decisions);
    const observedSnapshot = captureObservedDemand(turn, publicInfo);

    const packCompanyTurns = session.fixtures.map((f) => ({
      turn,
      companyId: f.companyId,
      beginningState: beginningStates.get(f.companyId) as ReturnType<typeof captureCompanyStateSnapshot>,
      endingState: captureCompanyStateSnapshot(nextState, f),
      capitalProjects: captureCapitalProjects(nextState, f.companyId),
      strategy: strategyByCompany.get(f.companyId) as ReturnType<typeof captureStrategy>,
    }));
    const finalizedRecord = nextState.history[nextState.history.length - 1];
    const packWorldTurn = finalizedRecord
      ? captureWorldTurn(
          turn,
          finalizedRecord,
          observedSnapshot
            ? {
                entries: observedSnapshot.entries,
                sourceTurn: observedSnapshot.sourceTurn,
                lagQuarters: publicInfo.observedMarketDemand?.observationLagQuarters ?? null,
                vietnamDomesticPriorPrice: publicInfo.vietnamDomesticPriorPrice ?? null,
              }
            : null,
          captureScenarioEvents(session.state, turn)
        )
      : null;
    const completedTurns = session.run.completedTurns + 1;
    const reachedRequested = completedTurns >= session.run.requestedTurns;
    return {
      session: {
        ...session,
        state: nextState,
        aiTurnTraces: [...session.aiTurnTraces, ...turnTraces],
        observedDemand: observedSnapshot ? [...session.observedDemand, observedSnapshot] : session.observedDemand,
        // 【時点に注意】採用・減員は次の四半期から反映される規約のため、
        // 当期の市場別配置と突き合わせるべきなのは「当期に配分可能だった人数」＝
        // 当期処理**前**の値である。処理後の値を使うと、採用した四半期だけ
        // 配置合計と総人数が食い違って見えてしまう。
        salesHeadcountByTurn: [
          ...session.salesHeadcountByTurn,
          ...session.fixtures.map((f) => ({
            turn,
            companyId: f.companyId,
            headcount:
              session.state.salesForceHiringState?.companies.find((c) => c.companyId === f.companyId)?.headcount ??
              f.salesForceHeadcountTotal,
          })),
        ],
        capacityByTurn: [...session.capacityByTurn, ...captureCapacities(turn, nextState, session.fixtures)],
        packCompanyTurns: [...session.packCompanyTurns, ...packCompanyTurns],
        packWorldTurns: packWorldTurn ? [...session.packWorldTurns, packWorldTurn] : session.packWorldTurns,
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
