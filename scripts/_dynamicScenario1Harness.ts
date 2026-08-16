// Dynamic Scenario 1 — benchmark 共通ハーネス（read-only）
//
// 【なぜ Management Console の createSimulationSession を使わないか】
// console の 32Q 実行は CompanyLabConfig.sai5 を設定しない。そのため
// 市場×商品ライフサイクル（SAI-5C）が無効になり、シナリオの
// productLifecycleOverrides が結果に反映されない（世界一律の固定商品構成比に
// フォールバックする）。Dynamic Scenario 1 は市場別の商品構成の時間変化を
// 前提にしているため、benchmark ではこのフラグを明示して同じ turn 処理を回す。
//
// 【ゲームロジックは変更しない】initializeCompanyLab / buildCompanyOwnState /
// generateStandardAiDecisionWithDiagnostics / advanceCompanyLabQuarter という
// 通常ゲームとまったく同じ関数を、同じ順序で呼ぶだけ。fast-run 専用の簡易
// ロジックは作らない（simulation/engine.ts と同じ方針）。

import {
  advanceCompanyLabQuarter,
  buildCompanyOwnState,
  buildPublicMarketInfo,
  initializeCompanyLab,
} from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyLabState, Sai5FeatureFlags } from "../app/lib/v2/companyLab/types";

/** Dynamic Scenario 1 の前提となる機能フラグ。 */
export const DS1_SAI5_FLAGS: Sai5FeatureFlags = {
  productLifecycle: true,
  supplyPremiumFeedback: true,
  salesBaseAccumulation: true,
};

/**
 * 会社ごとの意思決定を benchmark 側から差し替えるためのフック。
 * counterfactual（「1社だけ China HOSO へ張る」等）を作るために使う。
 * 返した decision がそのままエンジンへ渡る。undefined を返すと Standard AI の
 * 決定をそのまま使う。
 */
export type DecisionOverride = (input: {
  readonly turn: number;
  readonly fixture: CompanyFixture;
  readonly aiDecision: CompanyDecisionInput;
  readonly state: CompanyLabState;
}) => CompanyDecisionInput | undefined;

export interface RunResult {
  readonly state: CompanyLabState;
  readonly fixtures: readonly CompanyFixture[];
  readonly completedTurns: number;
  readonly error: string | null;
}

export function runCompanyLab(options: {
  readonly scenarioId: string;
  readonly seed: string;
  readonly turns: number;
  readonly sai5?: Sai5FeatureFlags;
  readonly decisionOverride?: DecisionOverride;
}): RunResult {
  const config: CompanyLabConfig = {
    scenarioId: options.scenarioId,
    mode: "canonical",
    seed: options.seed,
    turns: options.turns,
    ...(options.sai5 !== undefined ? { sai5: options.sai5 } : {}),
  };
  const { state: initialState, fixtures } = initializeCompanyLab(config);
  let state = initialState;
  let completedTurns = 0;

  for (let i = 0; i < options.turns; i++) {
    const turn = state.scenarioState.currentTurn;
    try {
      const publicInfo = buildPublicMarketInfo(state);
      const decisions: Record<string, CompanyDecisionInput> = {};
      for (const fixture of fixtures) {
        const ownState = buildCompanyOwnState(state, fixture);
        const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, turn);
        decisions[fixture.companyId] = options.decisionOverride?.({ turn, fixture, aiDecision: decision, state }) ?? decision;
      }
      state = advanceCompanyLabQuarter(state, fixtures, decisions);
      completedTurns += 1;
    } catch (e) {
      return { state, fixtures, completedTurns, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { state, fixtures, completedTurns, error: null };
}
