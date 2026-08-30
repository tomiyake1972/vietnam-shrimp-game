// ShrimpX V2 — ENG-COMPANYLAB-RESUME-HISTORY-1
//
// resume 時に注入する確定履歴 record を直近1件 → 直近2件へ増やした変更の検証。
//
// 【なぜ2件必要か】resume 経路の history consumer のうち最長は buildPublicMarketInfo で、
//   - 市場×商品構成比 trend: history[length-1] と history[length-2] の差分
//   - buildObservedMarketDemand: history[length - LAG]（LAG = 2）
// がいずれも「末尾から2件目」を読む。1件だけ復元すると決定論的な基礎曲線へ
// フォールバックし、連続実行と異なる公開市場情報になる。
// 公開市場情報は Standard AI と Player 画面の双方が読む。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyId } from "../../../sales/types";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState } from "../../types";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";
import { generateStandardAiDecisionWithDiagnostics } from "../../standardAi/policy";
import { MARKET_DEMAND_OBSERVATION_LAG_QUARTERS } from "../../marketDemandObservation";
import { createInMemoryCompanyLabStateRepository, CompanyLabStateRepository } from "../../persistence/repository";
import { createCompanyLabQuarterFlowService } from "../companyLabQuarterFlowService";

const PLAYER_COMPANY_ID = "BAL" as CompanyId;
const NOW = "2026-01-01T00:00:00.000Z";

function cfg(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "rh-001", turns: 6, ...overrides } as CompanyLabConfig;
}

function autoDecisions(state: CompanyLabState, fixtures: ReturnType<typeof initializeCompanyLab>["fixtures"]) {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<CompanyId, CompanyDecisionInput> = {};
  for (const f of fixtures) decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
  return decisions;
}

/** Service 経由で turn を進めつつ、各 turn の resume 時 restoredState.history を記録する。 */
async function runServicePath(labId: string, config: CompanyLabConfig, turns: number) {
  const repository: CompanyLabStateRepository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  await service.createLab({ labId, config, playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
  const injected: Array<readonly number[]> = [];
  const publicInfos: unknown[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const turnId = `turn-${turn}`;
    await service.saveDraft({ labId, turnId, draftBody: { note: turnId }, now: NOW });
    await service.submitDraft({ labId, turnId, now: NOW });
    const result = await service.processQuarter({
      labId,
      turnId,
      lockToken: `lock-${turn}`,
      now: NOW,
      decisionsProvider: (args) => {
        // 復元された history の中身（turn 番号列）と公開市場情報を記録する。
        injected.push(args.restoredState.history.map((r) => r.turn));
        publicInfos.push(JSON.parse(JSON.stringify(args.publicInfo)));
        return autoDecisions(args.restoredState, args.fixtures);
      },
    });
    assert.equal(result.status, "processed");
  }
  return { repository, injected, publicInfos };
}

// =====================================================================

test("RH-1: 履歴0件（turn 1）は空配列を注入する", async () => {
  const { injected } = await runServicePath("lab-rh-1", cfg(), 1);
  assert.deepEqual(injected[0], []);
});

test("RH-2: 履歴1件（turn 2）は1件だけ注入する", async () => {
  const { injected } = await runServicePath("lab-rh-2", cfg(), 2);
  assert.deepEqual(injected[1], [1]);
});

test("RH-3: 履歴2件（turn 3）は2件注入する", async () => {
  const { injected } = await runServicePath("lab-rh-3", cfg(), 3);
  assert.deepEqual(injected[2], [1, 2]);
});

test("RH-4: 履歴3件以上でも最新2件だけ注入する（全履歴をロードしない）", async () => {
  const { injected } = await runServicePath("lab-rh-4", cfg(), 6);
  assert.deepEqual(injected[3], [2, 3]);
  assert.deepEqual(injected[4], [3, 4]);
  assert.deepEqual(injected[5], [4, 5]);
  for (const turns of injected) assert.ok(turns.length <= 2, `注入件数が2件を超えている: ${turns.join(",")}`);
});

test("RH-5: 注入順序は古い → 新しい", async () => {
  const { injected } = await runServicePath("lab-rh-5", cfg(), 6);
  for (const turns of injected) {
    for (let i = 1; i < turns.length; i++) assert.ok(turns[i] > turns[i - 1], `順序が古い→新しいでない: ${turns.join(",")}`);
  }
  // 末尾が常に「直前の turn」であること（consumer は末尾を直近として読む）。
  injected.forEach((turns, i) => {
    if (turns.length > 0) assert.equal(turns[turns.length - 1], i, `turn ${i + 1} の注入末尾が直前 turn でない`);
  });
  // 観測ラグの前提（末尾からの相対位置で引く）も固定する。
  assert.equal(MARKET_DEMAND_OBSERVATION_LAG_QUARTERS, 2);
});

test("RH-6: buildPublicMarketInfo が連続実行と resume で一致する", async () => {
  const TURNS = 6;
  // 経路A: 連続実行の各 turn 開始時点の公開情報
  const init = initializeCompanyLab(cfg({ turns: TURNS }));
  let state: CompanyLabState = init.state;
  const continuous: unknown[] = [];
  for (let turn = 1; turn <= TURNS; turn++) {
    continuous.push(JSON.parse(JSON.stringify(buildPublicMarketInfo(state))));
    state = advanceCompanyLabQuarter(state, init.fixtures, autoDecisions(state, init.fixtures));
  }
  // 経路B: Service 経由（毎 turn resume）
  const { publicInfos } = await runServicePath("lab-rh-6", cfg({ turns: TURNS }), TURNS);
  assert.deepEqual(publicInfos, continuous);
});

test("RH-10: AutoPolicy の既存挙動は変わらない（連続実行 = Service 経路）", async () => {
  const TURNS = 6;
  const init = initializeCompanyLab(cfg({ turns: TURNS }));
  let state: CompanyLabState = init.state;
  const records: unknown[] = [];
  for (let turn = 1; turn <= TURNS; turn++) {
    state = advanceCompanyLabQuarter(state, init.fixtures, autoDecisions(state, init.fixtures));
    records.push(JSON.parse(JSON.stringify(state.history[state.history.length - 1])));
  }
  const { repository } = await runServicePath("lab-rh-10", cfg({ turns: TURNS }), TURNS);
  for (let turn = 1; turn <= TURNS; turn++) {
    const entry = await repository.loadHistoryEntry("lab-rh-10", turn);
    assert.deepEqual(JSON.parse(JSON.stringify(entry.record)), records[turn - 1], `turn ${turn}`);
  }
});

// --- Standard AI equivalence（RH-7 / RH-8 / RH-9 / RH-11 / RH-12） -----------

function aiDecisions(state: CompanyLabState, fixtures: ReturnType<typeof initializeCompanyLab>["fixtures"]) {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<CompanyId, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    decisions[f.companyId] = generateStandardAiDecisionWithDiagnostics(
      f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn
    ).decision;
  }
  return decisions;
}

async function standardAiEquivalence(labId: string, config: CompanyLabConfig, turns: number) {
  // 経路A: 連続実行
  const init = initializeCompanyLab(config);
  let state: CompanyLabState = init.state;
  const continuousRecords: unknown[] = [];
  const continuousDecisions: unknown[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const d = aiDecisions(state, init.fixtures);
    continuousDecisions.push(JSON.parse(JSON.stringify(d)));
    state = advanceCompanyLabQuarter(state, init.fixtures, d);
    continuousRecords.push(JSON.parse(JSON.stringify(state.history[state.history.length - 1])));
  }
  // 経路B: Service 経由（毎 turn 保存・復元＝実運用と同じ）
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  await service.createLab({ labId, config, playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
  const resumedDecisions: unknown[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const turnId = `turn-${turn}`;
    await service.saveDraft({ labId, turnId, draftBody: { note: turnId }, now: NOW });
    await service.submitDraft({ labId, turnId, now: NOW });
    await service.processQuarter({
      labId, turnId, lockToken: `lock-${turn}`, now: NOW,
      decisionsProvider: (args) => {
        const d = aiDecisions(args.restoredState, args.fixtures);
        resumedDecisions.push(JSON.parse(JSON.stringify(d)));
        return d;
      },
    });
  }
  assert.deepEqual(resumedDecisions, continuousDecisions, "Standard AI の意思決定が resume で変わっている");
  for (let turn = 1; turn <= turns; turn++) {
    const entry = await repository.loadHistoryEntry(labId, turn);
    assert.deepEqual(JSON.parse(JSON.stringify(entry.record)), continuousRecords[turn - 1], `turn ${turn} の記録が一致しない`);
  }
  return { repository };
}

test("RH-7: Standard AI baseline で resume 前後が完全一致", async () => {
  await standardAiEquivalence("lab-rh-7", cfg({ turns: 6 }), 6);
});

test("RH-8: Standard AI DS1 で resume 前後が完全一致", async () => {
  await standardAiEquivalence("lab-rh-8", cfg({ scenarioId: "dynamic-scenario-1", turns: 6 }), 6);
});

test("RH-9: Standard AI DS2 で resume 前後が完全一致", async () => {
  await standardAiEquivalence("lab-rh-9", cfg({ scenarioId: "dynamic-scenario-2", turns: 6 }), 6);
});

test("RH-11: tiered salesModelId でも resume 前後が完全一致し、モデル設定が保持される", async () => {
  const config = cfg({ salesModelId: "tiered-v200-candidate-v1", turns: 6 });
  const { repository } = await standardAiEquivalence("lab-rh-11", config, 6);
  const stored = await repository.loadCurrentState("lab-rh-11");
  assert.equal(stored.config.salesModelId, "tiered-v200-candidate-v1");
  // tiered 配分が使われている（競争力ウェイトが正規化シェア＝全社合計 ≤ 1）
  const entry = await repository.loadHistoryEntry("lab-rh-11", 6);
  for (const a of entry.record.salesRecord.allocations) {
    assert.ok(a.companies.reduce((s, c) => s + c.competitivenessWeight, 0) <= 1 + 1e-9, `${a.market}/${a.product} が tiered でない`);
  }
});

test("RH-12: DS1 の effective sai5（requiredCapabilities）が resume 後も保持される", async () => {
  const config = cfg({ scenarioId: "dynamic-scenario-1", salesModelId: "tiered-v200-candidate-v1", turns: 4 });
  const { repository } = await standardAiEquivalence("lab-rh-12", config, 4);
  const stored = await repository.loadCurrentState("lab-rh-12");
  assert.equal(stored.config.sai5?.productLifecycle, true);
  assert.equal(stored.config.sai5?.supplyPremiumFeedback, true);
  assert.equal(stored.config.sai5?.salesBaseAccumulation, true);
  assert.equal(stored.config.salesModelId, "tiered-v200-candidate-v1");
});
