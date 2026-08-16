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
import { generateStandardAiDecisionWithDiagnostics, StandardAiQuarterDiagnostics } from "../standardAi/policy";
import { resolveStandardAiProfileForMode } from "../standardAi/orientationProfile";
import { StandardAiDiagnosticEntry } from "../standardAi/reasonCodes";
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyLabState } from "../types";
import {
  CompanyLabVisionOverrides,
  CompanyVisionOverrideEntry,
  withCompanyVisionOverrideApplied,
  withCompanyVisionOverrideReset,
} from "../vision/overrides";
import { createCompanyLabRuntimeSnapshot } from "../persistence/snapshot";
import { computeEffectiveFactories } from "../../capex/factoryConstruction";
import { calculateFactoryEffectiveCapacity } from "../../production/capacity";
import { unwrapUnit } from "../../core/units";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import { STANDARD_AI_PARAMETERS_V1 } from "../standardAi/parameters";
import { STRATEGY_PROFILE_SCHEMA_VERSION } from "../strategyProfile/types";
import { CapacitySnapshot, CompanyControlMode, DecisionOwner, MANAGEMENT_CONSOLE_STANDARD_TURNS, SimulationRun, SimulationSession, SimulationTurnOutcome } from "./types";
import { extractAiTurnTrace } from "./analytics/aiTrace";
import {
  captureCapitalProjects,
  captureCommercialGrowth,
  captureCompanyStateSnapshot,
  captureSalesOrganization,
  captureScenarioEvents,
  captureStrategy,
  captureWorldTurn,
} from "./aiPack/capture";
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
  /** 【Phase 8・Game Setup】Setup画面で任意入力できるRun名・メモ。 */
  readonly runName?: string;
  /**
   * 【Phase 8・Game Setup】開始時点の会社別経営モード。省略時は全社 STANDARD_AI
   * （Setup画面を経由しない既存の呼び出し元・既存テストとの後方互換）。
   */
  readonly companyControlModes?: Readonly<Record<string, CompanyControlMode>>;
  /**
   * 【Management Console Vision Calibration・Setup画面】Run開始時点で適用する
   * Vision上書き（省略時=undefinedなら全社vision/defaults.tsの既定Visionのみを使う）。
   */
  readonly visionOverrides?: CompanyLabVisionOverrides;
  /**
   * 【Strategy Profile Quantification・Phase SP-Q1】未指定・"OFF"なら従来どおり
   * STANDARD_AI_PARAMETERS_V1（全社バイアスゼロ）のまま＝挙動不変。"ON"は
   * 会社別ManagementProfile/OrientationProfileを適用する（A/Bベンチマーク用）。
   */
  readonly standardAiProfileMode?: "OFF" | "ON";
  /**
   * 【Standard AI CE-3A新設・監査専用】Customer Trust Attribution controlled
   * ablation benchmark専用。省略時（undefined）は既存挙動と完全に同一。
   */
  readonly qualityEquipmentCapabilityDisabled?: boolean;
  /**
   * 【Standard AI Factory Activation・Phase FA-1新設・監査専用】Factory Activation
   * controlled ablation benchmark専用。省略時（undefined）は既存挙動と完全に同一。
   */
  readonly factoryActivationLaborFixDisabled?: boolean;
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
    visionOverrides: input.visionOverrides,
    standardAiProfileMode: input.standardAiProfileMode,
    qualityEquipmentCapabilityDisabled: input.qualityEquipmentCapabilityDisabled,
    factoryActivationLaborFixDisabled: input.factoryActivationLaborFixDisabled,
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
    companyControlModes: input.companyControlModes,
    runName: input.runName,
  };
  return {
    run,
    state,
    fixtures,
    config,
    aiTurnTraces: [],
    observedDemand: [],
    salesHeadcountByTurn: [],
    capacityByTurn: [],
    packCompanyTurns: [],
    packWorldTurns: [],
    latestQuarterPreProcessingSnapshot: null,
  };
}

/**
 * 【Management Console Vision Calibration・指示§12「Run開始後のVision編集」】
 * 実行中のRunに新しいVision override（Q32目標規模・任意でstrategicPosture）を
 * 適用した、新しいSimulationSessionを返す（純粋関数。既存sessionは変更しない）。
 *
 * 【指示§13「過去Turnをretroactive変更しない」】config.visionOverridesを更新する
 * だけで、既に確定した過去TurnのAI Pack capture（session.packCompanyTurns等）は
 * 一切書き換えない。以降のTurnがresolveCompanyVision経由でこのoverrideを読む。
 * 呼び出し側は必ずentry.effectiveFromTurnへ「次のTurn」を渡すこと
 * （過去Turnを渡しても、既に確定した過去のcaptureへは影響しない＝画面上「効いた
 * ように見えない」だけなので、UI側でnextTurn固定にする）。
 */
export function applyVisionOverrideToSession(
  session: SimulationSession,
  companyId: string,
  entry: CompanyVisionOverrideEntry
): SimulationSession {
  const nextOverrides = withCompanyVisionOverrideApplied(session.state.config.visionOverrides, companyId, entry);
  return {
    ...session,
    config: { ...session.config, visionOverrides: nextOverrides },
    state: { ...session.state, config: { ...session.state.config, visionOverrides: nextOverrides } },
  };
}

/** 【指示§11「Reset to Default」】ある会社のRun内override（全履歴）を取り除く。 */
export function resetVisionOverrideForSessionCompany(session: SimulationSession, companyId: string): SimulationSession {
  const nextOverrides = withCompanyVisionOverrideReset(session.state.config.visionOverrides, companyId);
  return {
    ...session,
    config: { ...session.config, visionOverrides: nextOverrides },
    state: { ...session.state, config: { ...session.state.config, visionOverrides: nextOverrides } },
  };
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
 * 【Strategy Profile Quantification・Phase SP-Q1・指示§25】mode="ON"でバイアスが
 * 実際に適用された場合のみ、診断ストリーム（StandardAiQuarterDiagnostics.entries）へ
 * 1件PROFILE_BIAS_APPLIEDを追記する（policy.ts側の意思決定ロジックには一切触れず、
 * engine.ts側で診断を合成するだけ）。「base値→bias後値」の対応表そのものは
 * diagnostics.managementProfile.appliedBiasItems（createStandardAiProviderが既に
 * 生成する。baselineDecisionとの突き合わせも含む）で監査できるため、ここでは
 * AI Trace上で目に留まる要約エントリを1件加えるだけにとどめる。
 */
function appendProfileDiagnosticEntry(diagnostics: StandardAiQuarterDiagnostics): StandardAiQuarterDiagnostics {
  const mp = diagnostics.managementProfile;
  if (!mp || mp.appliedBiasItems.length === 0) return diagnostics;
  const entry: StandardAiDiagnosticEntry = {
    code: "PROFILE_BIAS_APPLIED",
    domain: "profile",
    companyId: diagnostics.companyId,
    severity: "info",
    keyValues: { appliedBiasItemCount: mp.appliedBiasItems.length },
    message: `Profile「${mp.profileId}」を適用し、${mp.appliedBiasItems.length}件のパラメータへバイアスを反映した。`,
  };
  return { ...diagnostics, entries: [...diagnostics.entries, entry] };
}

/**
 * ちょうど1ターンだけ進める。通常ゲームと同じ経路だけを通る。
 *
 * 失敗した場合は state を一切変更せず（前のターンまでの状態を保つ）、
 * completedTurns も増やさない。**失敗したターンを成功扱いにしない。**
 *
 * 【Phase 7・Manual Override】playerDecisions は companyId をキーに、その会社の
 * 当ターン意思決定を Standard AI ではなくプレイヤー入力で置き換える。渡された
 * すべての会社について Standard AI の意思決定（＝参考用の診断・トレース記録）は
 * 従来どおり計算する（将来の AI Recommendation 表示のための構造を残すため）が、
 * 実際にエンジンへ渡す意思決定だけを差し替える。playerDecisions に無い会社は
 * 従来どおり Standard AI の意思決定をそのまま使う。
 */
export function advanceSimulationTurn(
  session: SimulationSession,
  completedAt: string,
  playerDecisions?: Readonly<Record<string, CompanyDecisionInput>>
): SimulationTurnOutcome {
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
    /** 【Phase 6C】その四半期の商業成長の因果と営業組織（会社別）。 */
    const diagnosticsByCompany = new Map<string, ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["diagnostics"]>();
    const decisionOwnerByCompany = new Map<string, DecisionOwner>();
    for (const fixture of session.fixtures) {
      const ownState = buildCompanyOwnState(session.state, fixture);
      /**
       * 【Strategy Profile Quantification・Phase SP-Q1・指示§4/§5】既存の
       * ManagementProfile（SAI-4）・CompanyOrientationProfile（SAI-5A）を、唯一の
       * SSoT resolveStandardAiProfileForMode 経由で会社ID単位に解決する。
       * mode未指定（=config.standardAiProfileMode省略）は"OFF"扱いとなり、
       * STANDARD_AI_PARAMETERS_V1をそのまま返す＝従来のparams=undefined
       * フォールバックとビット単位で同値（回帰の基準、指示§27）。
       */
      const profileResolution = resolveStandardAiProfileForMode(fixture.companyId, session.state.config.standardAiProfileMode);
      // 【Standard AI CE-3A新設・監査専用】config.qualityEquipmentCapabilityDisabled
      // がtrueのときだけ、Quality Equipment候補生成を無効化するablation paramsを
      // 使う。省略時は必ずprofileResolution.paramsそのまま（既存挙動と完全に同一）。
      const effectiveParams = {
        ...profileResolution.params,
        ...(session.state.config.qualityEquipmentCapabilityDisabled ? { qualityEquipmentCapabilityEnabled: false } : {}),
        ...(session.state.config.factoryActivationLaborFixDisabled ? { factoryActivationLaborFixEnabled: false } : {}),
      };
      const { decision: aiDecision, diagnostics: rawDiagnostics } = generateStandardAiDecisionWithDiagnostics(
        fixture,
        ownState,
        publicInfo,
        session.state.currentPeriod,
        turn,
        effectiveParams,
        undefined,
        session.state.config.visionOverrides
      );
      /**
       * 【指示§25】バイアスが1件でも適用されている場合のみ、基準パラメータ
       * （STANDARD_AI_PARAMETERS_V1）でも同一入力を評価し、「base決定→bias後決定」を
       * 突き合わせられるようにする（createStandardAiProviderの既存ロジックと同じ、
       * 純粋関数の再呼び出しのみ。ゲーム状態・他四半期への影響はゼロ）。
       */
      const baselineDecision =
        profileResolution.appliedBiasItems.length > 0
          ? generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, session.state.currentPeriod, turn, STANDARD_AI_PARAMETERS_V1).decision
          : undefined;
      const diagnostics = appendProfileDiagnosticEntry(
        profileResolution.mode === "OFF"
          ? rawDiagnostics
          : {
              ...rawDiagnostics,
              managementProfile: { profileId: profileResolution.profileId, appliedBiasItems: profileResolution.appliedBiasItems, baselineDecision },
            }
      );
      const playerDecision = playerDecisions?.[fixture.companyId];
      decisions[fixture.companyId] = playerDecision ?? aiDecision;
      decisionOwnerByCompany.set(fixture.companyId, playerDecision ? "PLAYER" : "STANDARD_AI");
      // 【追加の計算をしない】diagnostics は上の1回の呼び出しで既に作られている値であり、
      // トレース記録のために Standard AI をもう一度回すことはない（PLAYER会社でも、
      // 参考用の Standard AI 診断はそのまま記録する＝実際の意思決定には使わない）。
      turnTraces.push(extractAiTurnTrace(diagnostics));
      strategyByCompany.set(fixture.companyId, captureStrategy(diagnostics, profileResolution));
      diagnosticsByCompany.set(fixture.companyId, diagnostics);
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
      // 【Phase 6C】商業成長の因果は、当期の確定サマリー（成約・納品・生産）と
      // 突き合わせて初めて完成するため、advanceCompanyLabQuarter の後に組み立てる。
      commercialGrowth: captureCommercialGrowth(
        diagnosticsByCompany.get(f.companyId)!,
        nextState.history[nextState.history.length - 1]?.companySummaries.find((c) => c.companyId === f.companyId),
        diagnosticsByCompany
          .get(f.companyId)!
          .decision.productionPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0)
      ),
      salesOrganization: captureSalesOrganization(diagnosticsByCompany.get(f.companyId)!),
      decisionOwner: decisionOwnerByCompany.get(f.companyId) ?? "STANDARD_AI",
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
        // 【Phase 9・PLAYER Databook】このターンの「処理直前」の状態（＝session.stateが
        // まだ書き換わっていない、advanceCompanyLabQuarter呼び出し前の値）を、直近1ターン
        // ぶんだけ保持する（履歴として積み増さない）。
        latestQuarterPreProcessingSnapshot: createCompanyLabRuntimeSnapshot(session.state),
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
