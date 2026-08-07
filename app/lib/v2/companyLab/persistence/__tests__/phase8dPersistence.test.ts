// ShrimpX V2 — Phase 8D 永続化テスト
//
// 実装指示§12のテスト項目のうち、次を担当する。
//   13. 永続化round-trip後もWorker・スペース・各能力・建設中案件が保持される
//   14. 旧schema（schemaVersion:1）の保存データを読み込める
//
// テスト側で計算式を再実装せず、実際のエンジンで進めた状態を
// encode → decode → restore して比較する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../../core/units";
import { resolveFactoryColdStorageCapacityTons } from "../../../production/coldStorage";
import { resolveFactoryTotalSpaceUnits } from "../../../production/factorySpace";
import { applyCapexCapacityToFactories, computeOperationalStartPeriod } from "../../../capex/capacityEffect";
import { CAPEX_PARAMETERS_V1 } from "../../../capex/parameters";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../codec";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../snapshot";
import { CompanyLabPersistedStateV1, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../types";
import { baseTestConfig, runRealQuartersWithAutoPolicy } from "./testHelpers";
import { buildInitialWorkforceState, deriveWorkforceStateFromDecisions } from "../../workforce";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";

const TURNS = 3;
const TEST_ENGINE_VERSION = "test-v2-companyLab-engine-8d";

function buildStored(runtime: ReturnType<typeof createCompanyLabRuntimeSnapshot>, fixtures: readonly unknown[], schemaVersion: number) {
  return {
    schemaVersion,
    engineVersion: TEST_ENGINE_VERSION,
    labId: "lab-phase8d-001",
    playerCompanyId: "BAL",
    config: baseTestConfig({ turns: TURNS }),
    fixtures,
    currentState: { runtime, revision: 3, lastProcessedTurnId: "turn-3" },
    draft: null,
    metadata: { createdAt: "2026-07-26T00:00:00.000Z", updatedAt: "2026-07-26T00:00:00.000Z" },
  } as unknown as CompanyLabPersistedStateV1;
}

// ---------------------------------------------------------------------
// テスト項目13: round-trip後もWorker・スペース・能力・建設中案件が保持される
// ---------------------------------------------------------------------

test("PS-1（必須13）: 永続化round-trip後も Worker総人数が保持される", () => {
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: TURNS }), TURNS);
  const last = quarters[quarters.length - 1];
  const runtime = createCompanyLabRuntimeSnapshot(last.stateAfter);

  assert.ok(runtime.workforceState.companies.length > 0, "スナップショットにWorker総人数が含まれていません");

  const stored = buildStored(runtime, fixtures, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION);
  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(stored));

  assert.deepEqual(
    JSON.parse(JSON.stringify(decoded.currentState.runtime.workforceState)),
    JSON.parse(JSON.stringify(runtime.workforceState)),
    "round-trip後にWorker総人数が変化しています"
  );

  const restored = restoreCompanyLabStateFromRuntimeSnapshot(stored.config, decoded.currentState.runtime, [last.record]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(restored.workforceState)),
    JSON.parse(JSON.stringify(last.stateAfter.workforceState))
  );
});

test("PS-2（必須13）: 永続化round-trip後も 工場スペース総量・冷凍保管能力・各加工能力が保持される", () => {
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: TURNS }), TURNS);
  const last = quarters[quarters.length - 1];
  const runtime = createCompanyLabRuntimeSnapshot(last.stateAfter);
  const stored = buildStored(runtime, fixtures, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION);
  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(stored));

  // Factoryはfixtures側に保存されている（会社ごとの静的な工場定義）。
  for (const fixture of fixtures) {
    const decodedFixture = decoded.fixtures.find((f) => f.companyId === fixture.companyId)!;
    assert.ok(decodedFixture, `${fixture.companyId} のfixtureが復元されていません`);
    for (const factory of fixture.factories) {
      const decodedFactory = decodedFixture.factories.find((f) => f.factoryId === factory.factoryId)!;
      assert.ok(decodedFactory, `${factory.factoryId} が復元されていません`);
      assert.equal(unwrapUnit(decodedFactory.commonProcessingCapacity), unwrapUnit(factory.commonProcessingCapacity));
      assert.equal(unwrapUnit(decodedFactory.hosoCapacity), unwrapUnit(factory.hosoCapacity));
      assert.equal(unwrapUnit(decodedFactory.pdCapacity), unwrapUnit(factory.pdCapacity));
      assert.equal(unwrapUnit(decodedFactory.vapCapacity), unwrapUnit(factory.vapCapacity));
      assert.equal(unwrapUnit(decodedFactory.freezingPackagingCapacity), unwrapUnit(factory.freezingPackagingCapacity));
      assert.equal(
        resolveFactoryColdStorageCapacityTons(decodedFactory),
        resolveFactoryColdStorageCapacityTons(factory),
        "冷凍・冷蔵保管能力が保持されていません"
      );
      assert.equal(
        resolveFactoryTotalSpaceUnits(decodedFactory),
        resolveFactoryTotalSpaceUnits(factory),
        "工場スペース総量が保持されていません"
      );
    }
  }
});

test("PS-3（必須13）: 永続化round-trip後も 建設中の設備投資案件が保持される", () => {
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: TURNS }), TURNS);
  const last = quarters[quarters.length - 1];
  const runtime = createCompanyLabRuntimeSnapshot(last.stateAfter);

  // 自動方針は投資を提案しないため、建設中案件をテスト用に1件だけ足して網羅性を確保する
  // （既存のroundtrip.test.tsと同じ方針）。
  const targetCompanyId = runtime.capexState.companies[0].companyId;
  const withProject = {
    ...runtime,
    capexState: {
      companies: runtime.capexState.companies.map((c) =>
        c.companyId === targetCompanyId
          ? {
              ...c,
              portfolio: {
                ...c.portfolio,
                projects: [
                  ...c.portfolio.projects,
                  {
                    projectId: "phase8d-under-construction-1",
                    companyId: targetCompanyId,
                    projectType: "coldStorageExpansion" as const,
                    approvedBudgetUsd: 2_500_000,
                    paymentSchedule: [
                      { stageIndex: 0, plannedRatio: 0.5 },
                      { stageIndex: 1, plannedRatio: 0.5 },
                    ],
                    completedPaymentStagesCount: 1,
                    cumulativePaidUsd: 1_250_000,
                    elapsedConstructionQuartersWithPayment: 1,
                    requiredConstructionQuarters: 2,
                    status: "underConstruction" as const,
                    proposedPeriod: runtime.currentPeriod,
                    approvedPeriod: runtime.currentPeriod,
                    constructionStartedPeriod: runtime.currentPeriod,
                    priority: 1,
                    futureCapacityEffect: { targetProduct: "coldStorage" as const, capacityIncreaseTonsPerQuarter: 1_250, readinessQuartersAfterCompletion: 1 },
                    lastDiagnosticReasons: ["phase8d test fixture"],
                  },
                ],
              },
            }
          : c
      ),
    },
  };

  const stored = buildStored(withProject, fixtures, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION);
  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(stored));

  const decodedProjects = decoded.currentState.runtime.capexState.companies.find((c) => c.companyId === targetCompanyId)!.portfolio.projects;
  const project = decodedProjects.find((p) => p.projectId === "phase8d-under-construction-1");
  assert.ok(project, "建設中案件が保持されていません");
  assert.equal(project!.status, "underConstruction");
  assert.equal(project!.cumulativePaidUsd, 1_250_000);
  assert.equal(project!.futureCapacityEffect?.targetProduct, "coldStorage", "増強対象（保管能力）のスナップショットが保持されていません");
  assert.equal(project!.futureCapacityEffect?.capacityIncreaseTonsPerQuarter, 1_250);
});

// ---------------------------------------------------------------------
// テスト項目14: 旧schema（schemaVersion:1）の保存データを読み込める
// ---------------------------------------------------------------------

test("PS-4（必須14）: workforceStateを持たない旧schema（schemaVersion:1）の保存データを読み込める", () => {
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: TURNS }), TURNS);
  const last = quarters[quarters.length - 1];
  const runtime = createCompanyLabRuntimeSnapshot(last.stateAfter);

  // Phase 8D以前の保存データを再現する: schemaVersion:1、workforceStateキー自体が無い。
  const legacyStored = buildStored(runtime, fixtures, 1) as unknown as Record<string, unknown>;
  const legacyRuntime = { ...(legacyStored.currentState as Record<string, unknown>) } as Record<string, unknown>;
  const runtimeWithoutWorkforce = { ...(legacyRuntime.runtime as Record<string, unknown>) };
  delete runtimeWithoutWorkforce.workforceState;
  legacyRuntime.runtime = runtimeWithoutWorkforce;
  legacyStored.currentState = legacyRuntime;

  const json = JSON.stringify(legacyStored);
  assert.ok(!json.includes("workforceState"), "テスト前提: 旧データにworkforceStateが含まれていないこと");

  // 例外を投げずに読み込めること（マイグレーション処理は不要）。
  const decoded = decodeCompanyLabPersistedState(json);
  assert.equal(decoded.schemaVersion, 1, "旧バージョン番号がそのまま保持される");
  assert.deepEqual(decoded.currentState.runtime.workforceState, { companies: [] }, "既定値（空）として復元されること");

  // 確定履歴があれば、そこに保存済みの意思決定から実際の人数を復元する（推測値は作らない）。
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, [last.record]);
  const expected = deriveWorkforceStateFromDecisions(last.record.decisions);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.workforceState)), JSON.parse(JSON.stringify(expected)));
  assert.ok(restored.workforceState.companies.length > 0, "履歴からWorker総人数が復元されていません");
});

test("PS-5（必須14）: 履歴も無い旧データでも例外にならず、会社単位でfixtureの基準人数へフォールバックできる", () => {
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: 1 }), 1);
  const first = quarters[0];
  const runtime = createCompanyLabRuntimeSnapshot(first.stateBefore);

  const legacyStored = buildStored(runtime, fixtures, 1) as unknown as Record<string, unknown>;
  const legacyCurrent = { ...(legacyStored.currentState as Record<string, unknown>) };
  const runtimeWithoutWorkforce = { ...(legacyCurrent.runtime as Record<string, unknown>) };
  delete runtimeWithoutWorkforce.workforceState;
  legacyCurrent.runtime = runtimeWithoutWorkforce;
  legacyStored.currentState = legacyCurrent;

  const decoded = decodeCompanyLabPersistedState(JSON.stringify(legacyStored));
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, []);
  assert.deepEqual(restored.workforceState, { companies: [] }, "履歴が無ければ空のまま（勝手な値を作らない）");

  // 会社単位のフォールバックは fixture の基準人数と一致する。
  const fallback = buildInitialWorkforceState(fixtures);
  assert.ok(fallback.companies.length === fixtures.length);
  for (const company of fallback.companies) {
    const fixture = fixtures.find((f) => f.companyId === company.companyId)!;
    for (const factory of company.factories) {
      const baseline = fixture.workerBaseline.find((b) => b.factoryId === factory.factoryId)!;
      assert.equal(factory.regularHeadcount, baseline.regularHeadcount);
    }
  }
});

test("PS-6: 現行スキーマのバージョン番号が6へ上がっており、1〜5のデータも受け付ける（営業人員の減員・退職金forward-port続きで三宅さんの明示指示によりv5→v6。CompanyLabRuntimeSnapshotの構造自体は変更なし）", () => {
  assert.equal(CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION, 6);
});

// ---------------------------------------------------------------------
// 追補（指示4・5）: coldStorageExpansion の新旧効果が、保存・復元を経ても保たれる
// ---------------------------------------------------------------------

/**
 * 保存された案件を1件だけ差し込んだランタイムスナップショットを作る。
 * 完成済み・readiness=1 の設定にし、稼働開始四半期がスナップショットの
 * 現在四半期より後になるようにして「完成しても稼働前」から検証を始められるようにする。
 */
function withStoredProject(
  runtime: ReturnType<typeof createCompanyLabRuntimeSnapshot>,
  companyId: string,
  project: Record<string, unknown>
) {
  return {
    ...runtime,
    capexState: {
      companies: runtime.capexState.companies.map((c) =>
        c.companyId === companyId ? { ...c, portfolio: { ...c.portfolio, projects: [...c.portfolio.projects, project] } } : c
      ),
    },
  } as unknown as ReturnType<typeof createCompanyLabRuntimeSnapshot>;
}

test("PS-7（追補4）: Phase 8D以前に承認された coldStorageExpansion は、旧保存形式（schemaVersion:1）からの読込み・復元を経ても、稼働開始時に従来どおり凍結・包装処理能力を増やす", () => {
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: TURNS }), TURNS);
  const last = quarters[quarters.length - 1];
  const runtime = createCompanyLabRuntimeSnapshot(last.stateAfter);
  const companyId = runtime.capexState.companies[0].companyId;
  const completedPeriod = runtime.currentPeriod;

  // Phase 8D以前に承認された案件は、承認時スナップショットとして
  // targetProduct: "freezingPackaging" / 500t を保持している。
  const legacyProject = {
    projectId: "legacy-cold-storage-1",
    companyId,
    projectType: "coldStorageExpansion",
    approvedBudgetUsd: 2_500_000,
    paymentSchedule: [
      { stageIndex: 0, plannedRatio: 0.5 },
      { stageIndex: 1, plannedRatio: 0.5 },
    ],
    completedPaymentStagesCount: 2,
    cumulativePaidUsd: 2_500_000,
    elapsedConstructionQuartersWithPayment: 2,
    requiredConstructionQuarters: 2,
    status: "completed",
    proposedPeriod: completedPeriod,
    approvedPeriod: completedPeriod,
    constructionStartedPeriod: completedPeriod,
    completedPeriod,
    capitalizedAmountUsd: 2_500_000,
    priority: 1,
    futureCapacityEffect: { targetProduct: "freezingPackaging", capacityIncreaseTonsPerQuarter: 500, readinessQuartersAfterCompletion: 1 },
    lastDiagnosticReasons: ["legacy fixture: approved before Phase 8D"],
  };

  // 旧保存形式を再現する: schemaVersion:1、workforceStateキーごと無し。
  const stored = buildStored(withStoredProject(runtime, companyId, legacyProject), fixtures, 1) as unknown as Record<string, unknown>;
  const current = { ...(stored.currentState as Record<string, unknown>) };
  const runtimeObj = { ...(current.runtime as Record<string, unknown>) };
  delete runtimeObj.workforceState;
  current.runtime = runtimeObj;
  stored.currentState = current;
  const json = JSON.stringify(stored);
  assert.ok(!json.includes("workforceState"), "テスト前提: 旧データにworkforceStateが無いこと");

  // 保存 → 読込み → 復元。
  const decoded = decodeCompanyLabPersistedState(json);
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, [last.record]);

  const project = restored.capexState.companies
    .find((c) => c.companyId === companyId)!
    .portfolio.projects.find((p) => p.projectId === "legacy-cold-storage-1")!;
  assert.ok(project, "旧案件が復元されていません");
  assert.equal(project.futureCapacityEffect?.targetProduct, "freezingPackaging", "承認時スナップショットが書き換わっています");
  assert.equal(project.futureCapacityEffect?.capacityIncreaseTonsPerQuarter, 500);

  const baseFactories = fixtures.find((f) => f.companyId === companyId)!.factories;
  const baseFactory = baseFactories[0];

  // 完成四半期時点ではまだ稼働前（readiness=1）。
  const atCompletion = applyCapexCapacityToFactories(baseFactories, restored.capexState, completedPeriod);
  assert.equal(
    unwrapUnit(atCompletion[0].freezingPackagingCapacity),
    unwrapUnit(baseFactory.freezingPackagingCapacity),
    "完成四半期そのものでは、まだ能力は増えないはず"
  );

  // 稼働開始四半期（完成の翌四半期 ＋ readiness 1 ＝ 2四半期後）から増える。
  const operationalStart = computeOperationalStartPeriod(completedPeriod, 1);
  const atOperationalStart = applyCapexCapacityToFactories(baseFactories, restored.capexState, operationalStart);
  assert.ok(
    Math.abs(unwrapUnit(atOperationalStart[0].freezingPackagingCapacity) - (unwrapUnit(baseFactory.freezingPackagingCapacity) + 500)) < 1e-6,
    `旧案件は従来どおり凍結・包装処理能力を+500t/四半期するはず（実際: ${unwrapUnit(atOperationalStart[0].freezingPackagingCapacity)}）`
  );
  // 保管能力のほうは増えない（旧案件の効果はフロー側のみ）。
  assert.equal(
    resolveFactoryColdStorageCapacityTons(atOperationalStart[0]),
    resolveFactoryColdStorageCapacityTons(baseFactory),
    "旧案件が保管能力まで増やしてしまっています"
  );
});

test("PS-8（追補5）: Phase 8D以降の新規 coldStorageExpansion は、保存・復元後も冷凍・冷蔵保管能力だけを増やし、凍結・包装処理能力を増やさない", () => {
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: TURNS }), TURNS);
  const last = quarters[quarters.length - 1];
  const runtime = createCompanyLabRuntimeSnapshot(last.stateAfter);
  const companyId = runtime.capexState.companies[0].companyId;
  const completedPeriod = runtime.currentPeriod;

  // 新規案件は、現行テンプレートの承認時スナップショット（保管1,250t）を持つ。
  const template = CAPEX_PARAMETERS_V1.templatesByType.coldStorageExpansion;
  assert.equal(template.futureCapacityEffect.targetProduct, "coldStorage", "前提: 現行テンプレートは保管を対象とすること");
  const newProject = {
    projectId: "new-cold-storage-1",
    companyId,
    projectType: "coldStorageExpansion",
    approvedBudgetUsd: template.standardBudgetUsd,
    paymentSchedule: template.paymentRatios.map((plannedRatio, stageIndex) => ({ stageIndex, plannedRatio })),
    completedPaymentStagesCount: template.paymentRatios.length,
    cumulativePaidUsd: template.standardBudgetUsd,
    elapsedConstructionQuartersWithPayment: template.standardConstructionQuarters,
    requiredConstructionQuarters: template.standardConstructionQuarters,
    status: "completed",
    proposedPeriod: completedPeriod,
    approvedPeriod: completedPeriod,
    constructionStartedPeriod: completedPeriod,
    completedPeriod,
    capitalizedAmountUsd: template.standardBudgetUsd,
    priority: 1,
    futureCapacityEffect: template.futureCapacityEffect,
    lastDiagnosticReasons: ["phase8d fixture: approved after Phase 8D"],
  };

  const stored = buildStored(withStoredProject(runtime, companyId, newProject), fixtures, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION);
  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(stored));
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, [last.record]);

  const project = restored.capexState.companies
    .find((c) => c.companyId === companyId)!
    .portfolio.projects.find((p) => p.projectId === "new-cold-storage-1")!;
  assert.equal(project.futureCapacityEffect?.targetProduct, "coldStorage");
  assert.equal(project.futureCapacityEffect?.capacityIncreaseTonsPerQuarter, 1_250);

  const baseFactories = fixtures.find((f) => f.companyId === companyId)!.factories;
  const baseFactory = baseFactories[0];

  const operationalStart = computeOperationalStartPeriod(completedPeriod, template.postCompletionReadinessQuarters);
  const atOperationalStart = applyCapexCapacityToFactories(baseFactories, restored.capexState, operationalStart);

  assert.ok(
    Math.abs(resolveFactoryColdStorageCapacityTons(atOperationalStart[0]) - (resolveFactoryColdStorageCapacityTons(baseFactory) + 1_250)) < 1e-6,
    `新規案件は保管能力を+1,250t（同時保管量）するはず（実際: ${resolveFactoryColdStorageCapacityTons(atOperationalStart[0])}）`
  );
  assert.equal(
    unwrapUnit(atOperationalStart[0].freezingPackagingCapacity),
    unwrapUnit(baseFactory.freezingPackagingCapacity),
    "新規案件が凍結・包装処理能力（フロー）まで増やしてしまっています"
  );
});

test("PS-9（追補4・5）: 旧案件と新案件が同じ会社に併存しても、保存・復元後にそれぞれの対象能力だけが増える", () => {
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: TURNS }), TURNS);
  const last = quarters[quarters.length - 1];
  const runtime = createCompanyLabRuntimeSnapshot(last.stateAfter);
  const companyId = runtime.capexState.companies[0].companyId;
  const completedPeriod = runtime.currentPeriod;

  const common = {
    companyId,
    projectType: "coldStorageExpansion",
    approvedBudgetUsd: 2_500_000,
    paymentSchedule: [
      { stageIndex: 0, plannedRatio: 0.5 },
      { stageIndex: 1, plannedRatio: 0.5 },
    ],
    completedPaymentStagesCount: 2,
    cumulativePaidUsd: 2_500_000,
    elapsedConstructionQuartersWithPayment: 2,
    requiredConstructionQuarters: 2,
    status: "completed",
    proposedPeriod: completedPeriod,
    approvedPeriod: completedPeriod,
    constructionStartedPeriod: completedPeriod,
    completedPeriod,
    capitalizedAmountUsd: 2_500_000,
    priority: 1,
    lastDiagnosticReasons: [],
  };

  let withProjects = withStoredProject(runtime, companyId, {
    ...common,
    projectId: "mixed-legacy",
    futureCapacityEffect: { targetProduct: "freezingPackaging", capacityIncreaseTonsPerQuarter: 500, readinessQuartersAfterCompletion: 1 },
  });
  withProjects = withStoredProject(withProjects, companyId, {
    ...common,
    projectId: "mixed-new",
    futureCapacityEffect: { targetProduct: "coldStorage", capacityIncreaseTonsPerQuarter: 1_250, readinessQuartersAfterCompletion: 1 },
  });

  const stored = buildStored(withProjects, fixtures, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION);
  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(stored));
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, [last.record]);

  const baseFactories = fixtures.find((f) => f.companyId === companyId)!.factories;
  const baseFactory = baseFactories[0];
  const operationalStart = computeOperationalStartPeriod(completedPeriod, 1);
  const after = applyCapexCapacityToFactories(baseFactories, restored.capexState, operationalStart);

  assert.ok(
    Math.abs(unwrapUnit(after[0].freezingPackagingCapacity) - (unwrapUnit(baseFactory.freezingPackagingCapacity) + 500)) < 1e-6,
    "旧案件ぶんの凍結・包装処理能力の増加が正しくありません"
  );
  assert.ok(
    Math.abs(resolveFactoryColdStorageCapacityTons(after[0]) - (resolveFactoryColdStorageCapacityTons(baseFactory) + 1_250)) < 1e-6,
    "新案件ぶんの保管能力の増加が正しくありません"
  );
});

// ---------------------------------------------------------------------
// 営業人員の追加採用（forward-port）: 永続化round-trip・旧schema後方互換
// ---------------------------------------------------------------------

test("PS-SFH-1: 永続化round-trip後も、採用予定人数を反映した営業人員総数（会社別）が保持される（BAL 18人→採用6人→24人）", () => {
  const { state, fixtures } = initializeCompanyLab(baseTestConfig({ turns: 1 }));
  const balFixture = fixtures.find((f) => f.companyId === "BAL")!;
  const publicInfo = buildPublicMarketInfo(state);
  const decisionsByCompanyId: Record<string, ReturnType<typeof generateAutoPolicyDecision>> = {};
  for (const f of fixtures) {
    const base = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, 1);
    decisionsByCompanyId[f.companyId] = f.companyId === "BAL" ? { ...base, salesForceHireCount: 6 } : base;
  }
  const stateAfter = advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
  const record = stateAfter.history[stateAfter.history.length - 1];

  const balHeadcountAfter = buildCompanyOwnState(stateAfter, balFixture).salesForceHiringState.headcount;
  assert.equal(balHeadcountAfter, 24, "テスト前提: 採用6人ぶんが次期に反映されていること");

  const runtime = createCompanyLabRuntimeSnapshot(stateAfter);
  assert.ok(runtime.salesForceHiringState.companies.length > 0, "スナップショットに営業人員総数が含まれていません");

  const stored = buildStored(runtime, fixtures, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION);
  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(stored));

  assert.deepEqual(
    JSON.parse(JSON.stringify(decoded.currentState.runtime.salesForceHiringState)),
    JSON.parse(JSON.stringify(runtime.salesForceHiringState)),
    "round-trip後に営業人員総数が変化しています"
  );

  const restored = restoreCompanyLabStateFromRuntimeSnapshot(stored.config, decoded.currentState.runtime, [record]);
  assert.equal(
    buildCompanyOwnState(restored, balFixture).salesForceHiringState.headcount,
    24,
    "round-trip後もBALの営業人員総数24人が保持されていること"
  );
});

test("PS-SFH-2: salesForceHiringStateを持たない旧schema（この機能導入前）の保存データを読み込める。履歴の有無に関わらず会社単位でfixtureの基準人数へフォールバックする", () => {
  const { fixtures, quarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: TURNS }), TURNS);
  const last = quarters[quarters.length - 1];
  const runtime = createCompanyLabRuntimeSnapshot(last.stateAfter);

  // この機能導入前の保存データを再現する: salesForceHiringStateキー自体が無い。
  const legacyStored = buildStored(runtime, fixtures, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION - 1) as unknown as Record<string, unknown>;
  const legacyCurrent = { ...(legacyStored.currentState as Record<string, unknown>) };
  const runtimeWithoutSalesForceHiring = { ...(legacyCurrent.runtime as Record<string, unknown>) };
  delete runtimeWithoutSalesForceHiring.salesForceHiringState;
  legacyCurrent.runtime = runtimeWithoutSalesForceHiring;
  legacyStored.currentState = legacyCurrent;

  const json = JSON.stringify(legacyStored);
  assert.ok(!json.includes("salesForceHiringState"), "テスト前提: 旧データにsalesForceHiringStateが含まれていないこと");

  // 例外を投げずに読み込めること（マイグレーション処理は不要）。
  const decoded = decodeCompanyLabPersistedState(json);
  assert.deepEqual(decoded.currentState.runtime.salesForceHiringState, { companies: [] }, "既定値（空）として復元されること");

  // この機能自体が今回新設されたものであり、それ以前のどの四半期にも「採用」という
  // 意思決定は存在し得なかったため、workforceStateと異なり履歴からの積算は行わない
  // （積算しても結果は0のまま＝会社単位のフォールバックと完全に一致するため不要）。
  const restoredWithHistory = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, [last.record]);
  assert.deepEqual(restoredWithHistory.salesForceHiringState, { companies: [] });
  for (const f of fixtures) {
    assert.equal(buildCompanyOwnState(restoredWithHistory, f).salesForceHiringState.headcount, f.salesForceHeadcountTotal);
  }

  // 履歴が無い場合も同様にフォールバックする。
  const restoredWithoutHistory = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, []);
  assert.deepEqual(restoredWithoutHistory.salesForceHiringState, { companies: [] });
  for (const f of fixtures) {
    assert.equal(buildCompanyOwnState(restoredWithoutHistory, f).salesForceHiringState.headcount, f.salesForceHeadcountTotal);
  }
});
