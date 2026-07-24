// ShrimpX V2 — 会社ラボ 保存・復元後処理の完全一致回帰テスト（Phase 8C-2 §4）
//
// 【本Phaseの最重要要件の検証】
//   経路A（中断なし）: initializeCompanyLab → advanceCompanyLabQuarterを連続実行。
//   経路B（毎四半期ごとに保存・復元）: Application Service経由でラボを作成し、
//     各四半期でdraft保存→提出→processQuarter（内部で、保存済みruntime snapshot＋
//     直近確定履歴エントリのrecordからCompanyLabStateを復元してからエンジンを実行）。
//
//   同じ初期状態・同じ意思決定・同じ乱数条件（seed）のもとで、両経路の結果が
//   「意味のある状態全体」で完全一致することを確認する。turn 2以降のrunnerは
//   直近履歴から前四半期の市場価格・工場負荷・ベトナム国内前期価格を参照するため、
//   直近履歴の注入が欠けていれば、この完全一致は必ず崩れる（＝本テストが
//   静かな挙動乖離の回帰を検出する）。
//
//   比較は各四半期ごとに、CompanyLabRuntimeSnapshot全体（contracts・rawMaterialLots・
//   productionState・qualityState・financeState・financingState・capexState・
//   scenarioState等の全フィールド）と、確定履歴のCompanyQuarterRecord全体を
//   JSON正規化のうえdeepStrictEqualで行う（主要項目だけの近似比較はしない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyId } from "../../../sales/types";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState } from "../../types";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";
import { createCompanyLabRuntimeSnapshot } from "../../persistence/snapshot";
import { createInMemoryCompanyLabStateRepository, CompanyLabStateRepository } from "../../persistence/repository";
import { createCompanyLabStateRepository } from "../../persistence/redisRepository";
import { createFakeCompanyLabRedisClient } from "../../../redis/__tests__/fakeCompanyLabRedisClient";
import { createCompanyLabQuarterFlowService, CompanyLabDecisionsProvider } from "../companyLabQuarterFlowService";
import { CompanyLabCompletedError } from "../../persistence/errors";

const PLAYER_COMPANY_ID = "BAL" as CompanyId;
const NOW = "2026-01-01T00:00:00.000Z";
const TURNS = 4;

function config(): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "resume-equivalence-001", turns: TURNS };
}

function jsonNormalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** 全社を自動方針で動かす意思決定（経路A・経路Bで完全に同じロジック・同じ入力になる）。 */
function buildAutoDecisions(state: CompanyLabState, fixtures: ReturnType<typeof initializeCompanyLab>["fixtures"]): Record<CompanyId, CompanyDecisionInput> {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<CompanyId, CompanyDecisionInput> = {};
  for (const fixture of fixtures) {
    const ownState = buildCompanyOwnState(state, fixture);
    decisions[fixture.companyId] = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
  }
  return decisions;
}

const providerForServicePath: CompanyLabDecisionsProvider = ({ restoredState, fixtures }) => buildAutoDecisions(restoredState, fixtures);

async function runEquivalence(label: string, repo: CompanyLabStateRepository) {
  const service = createCompanyLabQuarterFlowService({ repository: repo });
  const labId = `lab-equivalence-${label}`;

  // --- 経路A: 中断なしの連続実行 ---
  const { state: initialState, fixtures } = initializeCompanyLab(config());
  let stateA = initialState;
  const pathASnapshots: unknown[] = [];
  const pathARecords: unknown[] = [];
  for (let turn = 1; turn <= TURNS; turn++) {
    const decisions = buildAutoDecisions(stateA, fixtures);
    stateA = advanceCompanyLabQuarter(stateA, fixtures, decisions);
    pathASnapshots.push(jsonNormalize(createCompanyLabRuntimeSnapshot(stateA)));
    pathARecords.push(jsonNormalize(stateA.history[stateA.history.length - 1]));
  }

  // --- 経路B: 毎四半期ごとに保存・復元（Application Service経由） ---
  await service.createLab({ labId, config: config(), now: NOW });
  for (let turn = 1; turn <= TURNS; turn++) {
    const turnId = `turn-${turn}`;
    await service.saveDraft({ labId, turnId, draftBody: { note: turnId }, now: NOW });
    await service.submitDraft({ labId, turnId, now: NOW });
    const result = await service.processQuarter({
      labId,
      turnId,
      lockToken: `lock-${turn}`,
      now: NOW,
      playerCompanyId: PLAYER_COMPANY_ID,
      decisionsProvider: providerForServicePath,
    });
    assert.equal(result.status, "processed");

    // --- 四半期ごとの完全一致比較 ---
    const current = await repo.loadCurrentState(labId);
    assert.deepEqual(
      jsonNormalize(current.currentState.runtime),
      pathASnapshots[turn - 1],
      `turn ${turn}: 保存・復元経路の処理後状態が、中断なし経路と一致しません`
    );
    const entry = await repo.loadHistoryEntry(labId, turn);
    assert.deepEqual(jsonNormalize(entry.record), pathARecords[turn - 1], `turn ${turn}: 保存・復元経路のCompanyQuarterRecordが、中断なし経路と一致しません`);
    // 処理前スナップショットは「前四半期の処理後状態」（turn 1は初期状態）と一致する
    if (turn >= 2) {
      assert.deepEqual(jsonNormalize(entry.preProcessingStateSnapshot), pathASnapshots[turn - 2], `turn ${turn}: 処理前スナップショットが前四半期の処理後状態と一致しません`);
    }
  }

  // --- 最終状態: isComplete・履歴数・完了後の拒否も一致 ---
  const finalCurrent = await repo.loadCurrentState(labId);
  assert.equal(finalCurrent.currentState.runtime.isComplete, stateA.isComplete);
  assert.equal(stateA.isComplete, true, "turns=4のラボはturn 4で完了するはず");
  assert.deepEqual(await repo.loadHistoryIndex(labId), [1, 2, 3, 4]);
  await assert.rejects(
    () =>
      service.processQuarter({
        labId,
        turnId: "turn-5",
        lockToken: "lock-5",
        now: NOW,
        playerCompanyId: PLAYER_COMPANY_ID,
        decisionsProvider: providerForServicePath,
      }),
    CompanyLabCompletedError
  );
}

test("中断なし連続実行と、毎四半期の保存・復元を挟んだ実行が完全一致する（in-memory Repository）", async () => {
  await runEquivalence("in-memory", createInMemoryCompanyLabStateRepository());
});

test("中断なし連続実行と、毎四半期の保存・復元を挟んだ実行が完全一致する（Redis Repository＝JSON往復・スキーマ検証込み）", async () => {
  await runEquivalence("redis", createCompanyLabStateRepository({ client: createFakeCompanyLabRedisClient(), appEnv: "staging" }));
});
