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
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../codec";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../snapshot";
import { CompanyLabPersistedStateV1, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../types";
import { baseTestConfig, runRealQuartersWithAutoPolicy } from "./testHelpers";
import { buildInitialWorkforceState, deriveWorkforceStateFromDecisions } from "../../workforce";

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

test("PS-6: 現行スキーマのバージョン番号が2へ上がっており、1のデータも受け付ける", () => {
  assert.equal(CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION, 2);
});
