// ShrimpX V2 — EXPORT-RUN-IDENTITY-1: exportRunIdentity.ts（全Export共有のRun Identity SSoT）のテスト
//
// test61監査で、AI Analysis Pack・Standard AI Audit・Company/GM Databook・manifest.json・
// lab_index.jsonのいずれにも実際に使用された販売市場モデルの識別情報が記録されていなかった
// ことが判明した。ここでは exportRunIdentity.ts（新設の唯一のSSoT）が、実際にEngineが
// 使用したSalesParameters（salesParametersFor、既存の唯一の計算箇所）と一致した値を
// 返すことを検証する。新しい市場配分・価格計算・財務計算は一切追加していない
// （既存のsalesParametersForをそのまま呼ぶだけ）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExportRunIdentityFromCompanyLabConfig, buildExportRunIdentityFromSimulationRun } from "../exportRunIdentity";
import { salesParametersFor } from "../runner";
import { CompanyLabConfig } from "../types";
import { SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1 } from "../../sales/parameters";

function cfg(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed: "export-run-identity-001", turns: 8, ...overrides };
}

const SIMULATION_RUN_FIELDS = {
  scenarioId: "baseline-v0.1",
  scenarioVersion: "scenario-v1",
  seed: "run-seed-001",
  requestedTurns: 32,
  completedTurns: 17,
};

test("EXPORT-RUN-IDENTITY-1: salesModelId=tiered-v200-candidate-v1を指定したRunでは、configured/resolvedの両方がtieredになる", () => {
  const identity = buildExportRunIdentityFromCompanyLabConfig(cfg({ salesModelId: "tiered-v200-candidate-v1" }), "scenario-v1", 3);
  assert.equal(identity.configuredSalesModelId, "tiered-v200-candidate-v1");
  assert.equal(identity.resolvedSalesModelId, "tiered-v200-candidate-v1");
});

test("EXPORT-RUN-IDENTITY-2: salesModelId未指定Runでは、configuredはnull、resolvedはlegacy-waterfall-v1になる（推測ではなく実際に解決された値）", () => {
  const identity = buildExportRunIdentityFromCompanyLabConfig(cfg(), "scenario-v1", 3);
  assert.equal(identity.configuredSalesModelId, null);
  assert.equal(identity.resolvedSalesModelId, "legacy-waterfall-v1");
});

test("EXPORT-RUN-IDENTITY-3a: salesParametersVersion（tiered）は、salesParametersFor(config)が実際に返す値と完全一致する", () => {
  const config = cfg({ salesModelId: "tiered-v200-candidate-v1" });
  const identity = buildExportRunIdentityFromCompanyLabConfig(config, "scenario-v1", 3);
  const actualParameters = salesParametersFor(config);
  assert.equal(identity.salesParametersVersion, actualParameters.parametersVersion);
  assert.equal(actualParameters.parametersVersion, SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1.parametersVersion);
});

test("EXPORT-RUN-IDENTITY-3b: salesParametersVersion（legacy・sai5フラグ組み合わせ）は、salesParametersFor(config)が実際に返す値と完全一致する", () => {
  for (const sai5 of [undefined, { salesBaseAccumulation: true }, { vapProductDevelopmentCompetitiveness: false as const }, { vapProductDevelopmentCompetitiveness: false as const, salesBaseAccumulation: true }]) {
    const config = cfg({ sai5 });
    const identity = buildExportRunIdentityFromCompanyLabConfig(config, "scenario-v1", 3);
    const actualParameters = salesParametersFor(config);
    assert.equal(identity.salesParametersVersion, actualParameters.parametersVersion, `sai5=${JSON.stringify(sai5)}のケースでparametersVersionが一致しない`);
    assert.equal(identity.resolvedSalesModelId, "legacy-waterfall-v1");
  }
});

test("EXPORT-RUN-IDENTITY-4: tiered RunだけtierParametersVersionが非nullで、legacy Runではnull（非該当）になる", () => {
  const tiered = buildExportRunIdentityFromCompanyLabConfig(cfg({ salesModelId: "tiered-v200-candidate-v1" }), "scenario-v1", 3);
  const legacy = buildExportRunIdentityFromCompanyLabConfig(cfg(), "scenario-v1", 3);
  assert.equal(tiered.tierParametersVersion, SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1.tieredMarketAllocation?.parametersVersion);
  assert.notEqual(tiered.tierParametersVersion, null);
  assert.equal(legacy.tierParametersVersion, null);
});

test("EXPORT-RUN-IDENTITY-5: scenarioId/seed/requestedTurns/completedTurnsはconfigからそのまま転記される（新しい値を作らない）", () => {
  const config = cfg({ scenarioId: "dynamic-scenario-1", seed: "my-seed-xyz", turns: 24 });
  const identity = buildExportRunIdentityFromCompanyLabConfig(config, "scenario-version-abc", 11);
  assert.equal(identity.scenarioId, "dynamic-scenario-1");
  assert.equal(identity.scenarioVersion, "scenario-version-abc");
  assert.equal(identity.seed, "my-seed-xyz");
  assert.equal(identity.requestedTurns, 24);
  assert.equal(identity.completedTurns, 11);
});

test("EXPORT-RUN-IDENTITY-6a【後方互換・Simulation Run系】: configが取得可能なら、Company Lab系と同じsalesModel識別値を返す", () => {
  const config = cfg({ salesModelId: "tiered-v200-candidate-v1" });
  const fromConfig = buildExportRunIdentityFromCompanyLabConfig(config, "scenario-v1", 17);
  const fromSimulationRun = buildExportRunIdentityFromSimulationRun(SIMULATION_RUN_FIELDS, config);
  assert.equal(fromSimulationRun.configuredSalesModelId, fromConfig.configuredSalesModelId);
  assert.equal(fromSimulationRun.resolvedSalesModelId, fromConfig.resolvedSalesModelId);
  assert.equal(fromSimulationRun.salesParametersVersion, fromConfig.salesParametersVersion);
  assert.equal(fromSimulationRun.tierParametersVersion, fromConfig.tierParametersVersion);
  // scenarioId/seed等はSimulationRun側の値（run固有）を使う。
  assert.equal(fromSimulationRun.scenarioId, SIMULATION_RUN_FIELDS.scenarioId);
  assert.equal(fromSimulationRun.completedTurns, SIMULATION_RUN_FIELDS.completedTurns);
});

test("EXPORT-RUN-IDENTITY-6b【後方互換・新フィールドが無い過去保存Run】: configが取得不能（resumePayload無しの旧schemaVersion保存物）でも、例外を投げずsalesModel関連フィールドがすべてnull（legacyと決めつけない）を返す", () => {
  const identity = buildExportRunIdentityFromSimulationRun(SIMULATION_RUN_FIELDS, undefined);
  assert.equal(identity.configuredSalesModelId, null);
  assert.equal(identity.resolvedSalesModelId, null);
  assert.equal(identity.salesParametersVersion, null);
  assert.equal(identity.tierParametersVersion, null);
  // scenarioId等のRun自体の識別情報は、configの有無に関わらず引き続き取得できる。
  assert.equal(identity.scenarioId, SIMULATION_RUN_FIELDS.scenarioId);
  assert.equal(identity.scenarioVersion, SIMULATION_RUN_FIELDS.scenarioVersion);
  assert.equal(identity.seed, SIMULATION_RUN_FIELDS.seed);
  assert.equal(identity.requestedTurns, SIMULATION_RUN_FIELDS.requestedTurns);
  assert.equal(identity.completedTurns, SIMULATION_RUN_FIELDS.completedTurns);
});

test("EXPORT-RUN-IDENTITY-7【非persisted override】: salesParamsOverrideが効いている場合（実際のExportでは到達しない診断専用経路）は、推測でlegacy/tieredのどちらかに決めつけずnullを返す", () => {
  const config = cfg({ salesParamsOverride: salesParametersFor(cfg({ salesModelId: "tiered-v200-candidate-v1" })) });
  const identity = buildExportRunIdentityFromCompanyLabConfig(config, "scenario-v1", 3);
  assert.equal(identity.resolvedSalesModelId, null);
  assert.equal(identity.salesParametersVersion, null);
  assert.equal(identity.tierParametersVersion, null);
});

test("EXPORT-RUN-IDENTITY-8: sourceCommit/sourceBranchはNEXT_PUBLIC_SOURCE_COMMIT/BRANCH環境変数から取得し、未設定ならUNKNOWN（捏造しない）", () => {
  const originalCommit = process.env.NEXT_PUBLIC_SOURCE_COMMIT;
  const originalBranch = process.env.NEXT_PUBLIC_SOURCE_BRANCH;
  try {
    delete process.env.NEXT_PUBLIC_SOURCE_COMMIT;
    delete process.env.NEXT_PUBLIC_SOURCE_BRANCH;
    const unset = buildExportRunIdentityFromCompanyLabConfig(cfg(), "scenario-v1", 1);
    assert.equal(unset.sourceCommit, "UNKNOWN");
    assert.equal(unset.sourceBranch, "UNKNOWN");

    process.env.NEXT_PUBLIC_SOURCE_COMMIT = "abc1234";
    process.env.NEXT_PUBLIC_SOURCE_BRANCH = "feature/v2-export-run-identity-1";
    const withEnv = buildExportRunIdentityFromCompanyLabConfig(cfg(), "scenario-v1", 1);
    assert.equal(withEnv.sourceCommit, "abc1234");
    assert.equal(withEnv.sourceBranch, "feature/v2-export-run-identity-1");
  } finally {
    if (originalCommit === undefined) delete process.env.NEXT_PUBLIC_SOURCE_COMMIT;
    else process.env.NEXT_PUBLIC_SOURCE_COMMIT = originalCommit;
    if (originalBranch === undefined) delete process.env.NEXT_PUBLIC_SOURCE_BRANCH;
    else process.env.NEXT_PUBLIC_SOURCE_BRANCH = originalBranch;
  }
});
