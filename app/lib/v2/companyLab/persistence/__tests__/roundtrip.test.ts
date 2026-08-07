// ShrimpX V2 — 会社ラボ永続化 ラウンドトリップテスト（Phase 8C-1 §8-2）
//
// 実際のシミュレーション（runRealQuartersWithAutoPolicy）で生成した現実的なデータを
// encode→decode（JSON文字列を経由）した結果が、意味的に完全一致することを確認する。
// §8-2で明示的に列挙されている中核エンティティ（契約バックログ・原料ロット・
// 完成品ロット・売掛金/買掛金・借入金/未払利息・設備投資案件・品質/信頼状態・
// シナリオ履歴/発火済みイベント・処理前/後スナップショット・CompanyQuarterRecord・
// ドラフト・CompanyFixture[]）を、実際に値を持つ状態で確認する。
//
// 【capexのin-construction案件について】5社自動方針（autoPolicy.ts）は常に
// capexDecision（新規提案）を空で返す仕様のため（companyLab/types.ts CompanyDecisionInput
// コメント参照）、自動方針だけを回しても実データとしてunderConstruction状態の
// CapitalProjectは自然には出現しない。ラウンドトリップ対象としての網羅性を確保する
// ため、本テストでは実エンジンの出力へ、テスト専用の建設中CapitalProjectを1件だけ
// 明示的に追加してから検証する（エンジンの計算結果を検証するテストではなく、
// コーデック・スキーマ検証の網羅性を確認するテストであるため、この追加は妥当）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../../core/units";
import { CapitalProject } from "../../../capex/types";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../codec";
import { validateCompanyLabQuarterHistoryEntry, validateCompanyLabDraftEnvelope } from "../schema";
import { CompanyLabDraftEnvelope, CompanyLabPersistedStateV1, CompanyLabRuntimeSnapshot, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../types";
import { runRealQuartersWithAutoPolicy, buildHistoryEntryFromQuarter, baseTestConfig, TEST_ENGINE_VERSION } from "./testHelpers";

const TURNS = 14;

function buildRealisticRun() {
  return runRealQuartersWithAutoPolicy(baseTestConfig({ turns: TURNS }), TURNS);
}

/**
 * 期待値側をJSON往復で正規化してから比較するためのヘルパー。
 * エンジンが生成する生のin-memoryオブジェクトは、任意フィールド（expiryPeriod等）を
 * 明示的に`undefined`値のキーとして持つことがあるが、JSON.stringifyはundefined値の
 * キー自体を出力せず、schema.ts側の復元も「値がundefinedでない場合だけキーを足す」
 * 条件付きスプレッドで統一している（意図的な設計。存在しないキーとundefined値の
 * キーはJSON上区別できないため）。したがって「decode(encode(x))が意味的にxと一致する」
 * ことを確認する本テストの目的においては、期待値側もJSON往復させてから比較するのが
 * 正しい（そうしないとNode assert.deepStrictEqualが本来無関係な差異を誤検出する）。
 */
function jsonNormalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function withSyntheticUnderConstructionProject(snapshot: CompanyLabRuntimeSnapshot): CompanyLabRuntimeSnapshot {
  const targetCompanyId = snapshot.capexState.companies[0].companyId;
  const synthetic: CapitalProject = {
    projectId: "synthetic-roundtrip-project-1",
    companyId: targetCompanyId as CapitalProject["companyId"],
    projectType: "hosoLineExpansion",
    approvedBudgetUsd: 1_200_000,
    paymentSchedule: [
      { stageIndex: 0, plannedRatio: 0.5 },
      { stageIndex: 1, plannedRatio: 0.5 },
    ],
    completedPaymentStagesCount: 1,
    cumulativePaidUsd: 600_000,
    elapsedConstructionQuartersWithPayment: 1,
    requiredConstructionQuarters: 4,
    status: "underConstruction",
    proposedPeriod: snapshot.currentPeriod as never,
    approvedPeriod: snapshot.currentPeriod as never,
    constructionStartedPeriod: snapshot.currentPeriod as never,
    priority: 0,
    lastDiagnosticReasons: ["synthetic test fixture for roundtrip coverage"],
  };
  return {
    ...snapshot,
    capexState: {
      companies: snapshot.capexState.companies.map((c) =>
        c.companyId === targetCompanyId ? { ...c, portfolio: { ...c.portfolio, projects: [...c.portfolio.projects, synthetic] } } : c
      ),
    },
  };
}

test("CompanyLabPersistedStateV1（現在状態、draftなし）をencode→decodeして完全一致する", () => {
  const { fixtures, quarters } = buildRealisticRun();
  const last = quarters[quarters.length - 1];
  const runtimeWithCapex = withSyntheticUnderConstructionProject({
    currentPeriod: last.stateAfter.currentPeriod,
    scenarioState: last.stateAfter.scenarioState,
    contracts: last.stateAfter.contracts,
    rawMaterialLots: last.stateAfter.rawMaterialLots,
    productionState: { currentPeriod: last.stateAfter.productionState.currentPeriod, finishedGoodsLots: last.stateAfter.productionState.finishedGoodsLots },
    lastQuarterActualProduction: last.stateAfter.lastQuarterActualProduction,
    qualityState: last.stateAfter.qualityState,
    financeState: last.stateAfter.financeState,
    financingState: last.stateAfter.financingState,
    capexState: last.stateAfter.capexState,
    workforceState: last.stateAfter.workforceState,
    consumerMarketState: last.stateAfter.consumerMarketState,
    salesForceHiringState: last.stateAfter.salesForceHiringState,
    isComplete: last.stateAfter.isComplete,
  });

  const stored: CompanyLabPersistedStateV1 = {
    schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
    engineVersion: TEST_ENGINE_VERSION,
    labId: "lab-roundtrip-001",
    config: last.stateAfter.config,
    fixtures,
    playerCompanyId: "BAL" as never,
    currentState: { runtime: runtimeWithCapex, lastProcessedTurnId: "turn-14", revision: 14 },
    draft: null,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-15T00:00:00.000Z" },
  };

  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(stored));

  // --- CompanyFixture[] ---
  assert.deepEqual(decoded.fixtures, jsonNormalize(fixtures));

  // --- 契約バックログ ---
  assert.ok(decoded.currentState.runtime.contracts.length > 0, "契約バックログが空では網羅テストにならない");
  assert.deepEqual(decoded.currentState.runtime.contracts, jsonNormalize(runtimeWithCapex.contracts));

  // --- 原料ロット（国内/輸入/養殖の混在を期待） ---
  const sources = new Set(decoded.currentState.runtime.rawMaterialLots.map((l) => l.source));
  assert.ok(sources.has("domestic") || sources.has("import") || sources.has("aquaculture"));
  assert.deepEqual(decoded.currentState.runtime.rawMaterialLots, jsonNormalize(runtimeWithCapex.rawMaterialLots));

  // --- 完成品ロット ---
  assert.deepEqual(decoded.currentState.runtime.productionState.finishedGoodsLots, jsonNormalize(runtimeWithCapex.productionState.finishedGoodsLots));

  // --- 財務（売掛金/買掛金） ---
  assert.deepEqual(decoded.currentState.runtime.financeState, jsonNormalize(runtimeWithCapex.financeState));

  // --- 資金繰り（借入金/未払利息） ---
  assert.deepEqual(decoded.currentState.runtime.financingState, jsonNormalize(runtimeWithCapex.financingState));
  const anyLoans = decoded.currentState.runtime.financingState.companies.some((c) => c.loanPortfolio.loans.length > 0);
  // 借入がゼロでも構造上のラウンドトリップは検証済みだが、少なくとも会社数は一致していることを確認する。
  assert.equal(decoded.currentState.runtime.financingState.companies.length, runtimeWithCapex.financingState.companies.length);
  void anyLoans;

  // --- 設備投資案件（建設中を含む） ---
  assert.deepEqual(decoded.currentState.runtime.capexState, jsonNormalize(runtimeWithCapex.capexState));
  const hasUnderConstruction = decoded.currentState.runtime.capexState.companies.some((c) => c.portfolio.projects.some((p) => p.status === "underConstruction"));
  assert.ok(hasUnderConstruction, "建設中設備投資案件のラウンドトリップが確認できていない");

  // --- 品質・信頼状態 ---
  assert.deepEqual(decoded.currentState.runtime.qualityState, jsonNormalize(runtimeWithCapex.qualityState));

  // --- シナリオ履歴・発火済みイベント ---
  assert.deepEqual(decoded.currentState.runtime.scenarioState.resolvedEvents, jsonNormalize(runtimeWithCapex.scenarioState.resolvedEvents));
  assert.deepEqual(decoded.currentState.runtime.scenarioState.turnHistory, jsonNormalize(runtimeWithCapex.scenarioState.turnHistory));

  // --- draftはnullのまま ---
  assert.equal(decoded.draft, null);
  assert.equal(decoded.currentState.revision, 14);
  assert.equal(decoded.currentState.lastProcessedTurnId, "turn-14");
});

test("進行中ドラフト（submittedAt=null）を含むCompanyLabPersistedStateV1をラウンドトリップできる", () => {
  const { fixtures, quarters } = buildRealisticRun();
  const last = quarters[quarters.length - 1];
  const draft: CompanyLabDraftEnvelope = {
    labId: "lab-roundtrip-002",
    period: last.stateAfter.currentPeriod,
    turnId: "turn-15",
    revision: 0,
    draft: { salesPlans: [{ market: "japanRetail", product: "vap", askPrice: 12.3 }] },
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T01:00:00.000Z",
    submittedAt: null,
  };
  const fixedStored: CompanyLabPersistedStateV1 = {
    schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
    engineVersion: TEST_ENGINE_VERSION,
    labId: "lab-roundtrip-002",
    config: last.stateAfter.config,
    fixtures,
    playerCompanyId: "BAL" as never,
    currentState: {
      runtime: {
        currentPeriod: last.stateAfter.currentPeriod,
        scenarioState: last.stateAfter.scenarioState,
        contracts: last.stateAfter.contracts,
        rawMaterialLots: last.stateAfter.rawMaterialLots,
        productionState: { currentPeriod: last.stateAfter.productionState.currentPeriod, finishedGoodsLots: last.stateAfter.productionState.finishedGoodsLots },
        lastQuarterActualProduction: last.stateAfter.lastQuarterActualProduction,
        qualityState: last.stateAfter.qualityState,
        financeState: last.stateAfter.financeState,
        financingState: last.stateAfter.financingState,
        capexState: last.stateAfter.capexState,
        workforceState: last.stateAfter.workforceState,
        consumerMarketState: last.stateAfter.consumerMarketState,
        salesForceHiringState: last.stateAfter.salesForceHiringState,
        isComplete: last.stateAfter.isComplete,
      },
      revision: 14,
    },
    draft,
    metadata: { createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T01:00:00.000Z" },
  };

  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(fixedStored));
  assert.notEqual(decoded.draft, null);
  assert.deepEqual(decoded.draft, jsonNormalize(draft));
  assert.equal(decoded.draft?.submittedAt, null);
});

test("正式提出済みドラフト（submittedAt=ISO文字列）をラウンドトリップできる", () => {
  const raw = {
    labId: "lab-x",
    period: "2026Q1",
    turnId: "turn-3",
    revision: 2,
    draft: { note: "submitted" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    submittedAt: "2026-01-02T00:00:00.000Z",
  };
  const validated = validateCompanyLabDraftEnvelope(raw, "$");
  const roundTripped = validateCompanyLabDraftEnvelope(JSON.parse(JSON.stringify(validated)), "$");
  assert.deepEqual(roundTripped, validated);
  assert.equal(roundTripped.submittedAt, "2026-01-02T00:00:00.000Z");
});

test("CompanyLabQuarterHistoryEntry（処理前/処理後スナップショット・CompanyQuarterRecordを含む）をラウンドトリップできる", () => {
  const { fixtures, quarters } = buildRealisticRun();
  // 中盤のターンを選ぶ（初期状態に近すぎず、契約・原料・生産の実績データが十分蓄積された時点）。
  const quarter = quarters[Math.floor(quarters.length / 2)];
  const entry = buildHistoryEntryFromQuarter(fixtures, quarter, "turn-mid", "2026-03-01T00:00:00.000Z");

  const json = JSON.stringify(entry);
  const parsed = JSON.parse(json);
  const decoded = validateCompanyLabQuarterHistoryEntry(parsed, "$");

  assert.equal(decoded.turn, entry.turn);
  assert.equal(decoded.period, entry.period);
  assert.equal(decoded.turnId, entry.turnId);
  assert.deepEqual(decoded.preProcessingStateSnapshot, jsonNormalize(entry.preProcessingStateSnapshot));
  assert.deepEqual(decoded.postProcessingStateSnapshot, jsonNormalize(entry.postProcessingStateSnapshot));
  assert.deepEqual(decoded.playerSubmission, jsonNormalize(entry.playerSubmission));
  assert.deepEqual(decoded.otherCompaniesDecisions, jsonNormalize(entry.otherCompaniesDecisions));
  assert.equal(decoded.record.turn, entry.record.turn);
  assert.deepEqual(decoded.record.companySummaries, jsonNormalize(entry.record.companySummaries));
  assert.deepEqual(decoded.record.financialResults, jsonNormalize(entry.record.financialResults));
  assert.deepEqual(decoded.record.financingResults, jsonNormalize(entry.record.financingResults));
  assert.deepEqual(decoded.record.capexResults, jsonNormalize(entry.record.capexResults));
  assert.deepEqual(decoded.record.newFinishedGoodsLots, jsonNormalize(entry.record.newFinishedGoodsLots));

  // 処理前と処理後で、原料在庫量など何かしらの数値が変化していること（本当に別時点のスナップショットであることの確認）。
  const preLotsQty = decoded.preProcessingStateSnapshot.rawMaterialLots.reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
  const postLotsQty = decoded.postProcessingStateSnapshot.rawMaterialLots.reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
  assert.notEqual(preLotsQty, postLotsQty, "処理前後で原料在庫が全く変化していないのは不自然（テストデータの妥当性チェック）");
});
