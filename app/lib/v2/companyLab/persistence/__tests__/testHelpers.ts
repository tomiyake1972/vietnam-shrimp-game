// ShrimpX V2 — 会社ラボ永続化テスト共通ヘルパー（Phase 8C-1）
//
// テスト専用。本ファイル自体は"*.test.ts"ではないため、npm testのファイル探索
// パターン（tsx --test "app/lib/**/__tests__/**/*.test.ts" ...）には含まれず、
// 各テストファイルからimportされるだけの純粋なヘルパーとして扱われる。
//
// 実際のadvanceCompanyLabQuarter・generateAutoPolicyDecisionを使って、会社ラボの
// 本物のシミュレーションを複数四半期分進め、各四半期の「処理前state」「処理後state」
// 「その四半期の意思決定一式」「CompanyQuarterRecord」を集めた配列を返す。
// ラウンドトリップテスト（§8-2）・原子コミットのRepository契約テスト（§8-3）・
// 40四半期保存容量測定（§9）のいずれもここを土台にする。

import { CompanyId } from "../../../sales/types";
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyLabState, CompanyQuarterRecord } from "../../types";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";
import { createCompanyLabRuntimeSnapshot } from "../snapshot";
import { CompanyLabQuarterHistoryEntry } from "../types";

/** シナリオ"baseline"のdurationTurnsは32（scenario/parameters.tsのSTANDARD_SCENARIO_DURATION_TURNS）。
 * ユーザー指示は40四半期分の測定を求めているが、既存エンジンのシナリオ長は32が上限であるため、
 * 実エンジンで到達できるのは最大32四半期まで（§9完了報告で正直に報告する）。 */
export const MAX_REAL_ENGINE_TURNS_FOR_BASELINE_SCENARIO = 32;

export function baseTestConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "persistence-test-seed-001", turns: MAX_REAL_ENGINE_TURNS_FOR_BASELINE_SCENARIO, ...overrides };
}

export interface GeneratedQuarter {
  readonly stateBefore: CompanyLabState;
  readonly stateAfter: CompanyLabState;
  readonly decisionsByCompanyId: Readonly<Record<CompanyId, CompanyDecisionInput>>;
  readonly record: CompanyQuarterRecord;
}

export interface GeneratedRun {
  readonly fixtures: readonly CompanyFixture[];
  readonly quarters: readonly GeneratedQuarter[];
}

/**
 * 実際のadvanceCompanyLabQuarterを使って、5社自動方針でcount四半期分（またはシナリオが
 * 完了するまで）進める。各四半期の処理前・処理後CompanyLabStateをそのまま保持して返す
 * （createCompanyLabRuntimeSnapshotへ渡すのは呼び出し側の責務とする。本ヘルパーは
 * スナップショット生成前の生のCompanyLabStateを提供するだけに徹し、テストごとに
 * 異なる用途（ラウンドトリップ・容量測定・原子コミット入力組み立て）へ使い回せるようにする）。
 */
export function runRealQuartersWithAutoPolicy(config: CompanyLabConfig, count: number): GeneratedRun {
  const { state: initialState, fixtures } = initializeCompanyLab(config);
  let state = initialState;
  const quarters: GeneratedQuarter[] = [];
  for (let i = 0; i < count; i++) {
    if (state.isComplete) break;
    const publicInfo = buildPublicMarketInfo(state);
    const decisionsByCompanyId: Record<CompanyId, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      const ownState = buildCompanyOwnState(state, f);
      decisionsByCompanyId[f.companyId] = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
    }
    const stateBefore = state;
    const stateAfter = advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
    const record = stateAfter.history[stateAfter.history.length - 1];
    quarters.push({ stateBefore, stateAfter, decisionsByCompanyId, record });
    state = stateAfter;
  }
  return { fixtures, quarters };
}

const TEST_ENGINE_VERSION = "test-v2-companyLab-engine-8c1";
const TEST_SCHEMA_VERSION = 1;

/**
 * 1四半期ぶんのGeneratedQuarterから、実際に保存する形のCompanyLabQuarterHistoryEntryを
 * 組み立てる（§2-2の必須フィールド一式）。fixtures[0]を「プレイヤー会社」とみなし、
 * 残り4社をotherCompaniesDecisionsとする（本Phaseは5社競争の同時対応自体は対象外だが、
 * テストデータとしては現実的な形にする）。
 */
export function buildHistoryEntryFromQuarter(
  fixtures: readonly CompanyFixture[],
  quarter: GeneratedQuarter,
  turnId: string,
  processedAt: string
): CompanyLabQuarterHistoryEntry {
  const playerCompanyId = fixtures[0].companyId;
  const preProcessingStateSnapshot = createCompanyLabRuntimeSnapshot(quarter.stateBefore);
  const postProcessingStateSnapshot = createCompanyLabRuntimeSnapshot(quarter.stateAfter);
  return {
    turnId,
    turn: quarter.record.turn,
    period: quarter.record.period,
    engineVersion: TEST_ENGINE_VERSION,
    schemaVersion: TEST_SCHEMA_VERSION,
    preProcessingStateSnapshot,
    postProcessingStateSnapshot,
    playerSubmission: quarter.decisionsByCompanyId[playerCompanyId],
    otherCompaniesDecisions: fixtures.slice(1).map((f) => quarter.decisionsByCompanyId[f.companyId]),
    record: quarter.record,
    processedAt,
  };
}

export { TEST_ENGINE_VERSION, TEST_SCHEMA_VERSION };
