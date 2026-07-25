// ShrimpX V2 — 読み取り専用エクスポートAPI ハンドラー結合テスト
//
// NextRequest/NextResponseを一切使わず、handlers.tsの各関数をin-memory Repository
// （toReadOnlyCompanyLabRepositoryでラップ）＋実際のCompanyLabQuarterFlowServiceに対して
// 直接呼び出す（withExportApiContext・dependencies.ts＝実Redis接続は経由しない。
// 既存のapp/api/v2/company-labs/_lib/__tests__/handlers.test.tsと同じ方針）。
//
// 【カバーする必須テスト】
//   (6) 会社スコープAPIが他社の非公開情報を含まないこと
//   (8) 内部型の余分なフィールドがDTOへ自動混入しないこと
//   (11) 同一確定データの複数回取得でgeneratedAt以外が完全一致すること
//   (13) BS貸借一致・CF期末現金とBS現金の一致が、エクスポートDTO上でも成立すること
//   (5) 呼び出し前後でゲーム状態が不変であること（読み取り専用Repository経由での確認）

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryCompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { createCompanyLabQuarterFlowService } from "../../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../../../lib/v2/companyLab/autoPolicy";
import { buildInitialDraft } from "../../../../../v2/company-lab/decisionDraft";
import { CompanyLabApiDependencies } from "../../../company-labs/_lib/dependencies";
import { handleCreateLab, handleProcessQuarter, handleSaveDraft, handleSubmitDraft } from "../../../company-labs/_lib/handlers";
import { toReadOnlyCompanyLabRepository } from "../../../../../lib/v2/companyLab/persistence/readOnlyRepository";
import { CompanyLabExportApiDependencies } from "../dependencies";
import { CompanyLabExportLogEntry } from "../../../../../lib/v2/redis/companyLabExportAuditLog";
import { handleExportAllCompaniesTurn, handleExportCompanyTurn, handleExportLabIndex, handleExportMarketTurn } from "../handlers";
import { buildExportFinancialResult, ExportFinancialResult } from "../exportDto";
import { CompanyFinancialQuarterResult } from "../../../../../lib/v2/finance/types";

const NOW = "2026-01-01T00:00:00.000Z";
const GENERATED_AT = "2026-07-25T09:00:00.000Z";
const BALANCE_TOLERANCE_USD = 1;

function makeWritableDeps(): CompanyLabApiDependencies {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  return { repository, service };
}

function makeExportDeps(writableDeps: CompanyLabApiDependencies): { deps: CompanyLabExportApiDependencies; auditEntries: CompanyLabExportLogEntry[] } {
  const auditEntries: CompanyLabExportLogEntry[] = [];
  const deps: CompanyLabExportApiDependencies = {
    readOnlyRepository: toReadOnlyCompanyLabRepository(writableDeps.repository),
    auditLog: {
      async append(entry: CompanyLabExportLogEntry): Promise<void> {
        auditEntries.push(entry);
      },
    },
    appEnv: "staging",
  };
  return { deps, auditEntries };
}

function buildValidPlayerDraftBodyFor(companyId: string): unknown {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "export-handlers-draft-seed", turns: 4 });
  const publicInfo = buildPublicMarketInfo(state);
  const fixture = fixtures.find((f) => f.companyId === companyId);
  if (!fixture) throw new Error(`テスト用フィクスチャに${companyId}が見つかりません`);
  const ownState = buildCompanyOwnState(state, fixture);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  return buildInitialDraft(fixture, autoDecision);
}

const VALID_PLAYER_DRAFT_BODY = buildValidPlayerDraftBodyFor("BAL");

async function saveAndSubmitDraft(deps: CompanyLabApiDependencies, labId: string) {
  const saveResult = await handleSaveDraft(deps, labId, { draft: VALID_PLAYER_DRAFT_BODY }, NOW);
  assert.equal(saveResult.status, 200, JSON.stringify(saveResult.body));
  const submitResult = await handleSubmitDraft(deps, labId, NOW);
  assert.equal(submitResult.status, 200, JSON.stringify(submitResult.body));
}

async function processQuarter(deps: CompanyLabApiDependencies, labId: string) {
  const result = await handleProcessQuarter(deps, labId, {}, NOW);
  assert.equal(result.status, 200, JSON.stringify(result.body));
}

async function setUpProcessedTurn1Lab(labId: string): Promise<CompanyLabApiDependencies> {
  const writableDeps = makeWritableDeps();
  await handleCreateLab(writableDeps, { scenarioId: "baseline", mode: "canonical", seed: "export-handlers-seed", turns: 4, playerCompanyId: "BAL", labId }, NOW);
  await saveAndSubmitDraft(writableDeps, labId);
  await processQuarter(writableDeps, labId);
  return writableDeps;
}

function assertFinancialIntegrity(label: string, financialResult: ExportFinancialResult) {
  assert.ok(
    Math.abs(financialResult.balanceSheet.balanceDifference) < BALANCE_TOLERANCE_USD,
    `${label}: BSの貸借差額が許容誤差を超えています（${financialResult.balanceSheet.balanceDifference}）`,
  );
  assert.ok(
    Math.abs(financialResult.cashFlow.closingCash - financialResult.balanceSheet.cash) < BALANCE_TOLERANCE_USD,
    `${label}: CF期末現金とBS現金が一致しません（CF=${financialResult.cashFlow.closingCash}, BS=${financialResult.balanceSheet.cash}）`,
  );
  assert.ok(
    Math.abs(financialResult.cashFlow.directIndirectDifference) < BALANCE_TOLERANCE_USD,
    `${label}: CF直接法・間接法の差額が許容誤差を超えています（${financialResult.cashFlow.directIndirectDifference}）`,
  );
}

// -------------------------------------------------------------------
// handleExportLabIndex
// -------------------------------------------------------------------

test("handleExportLabIndex: 作成済みturn一覧・playerCompanyIdを返す", async () => {
  const labId = "export-index-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const result = await handleExportLabIndex(deps, labId, GENERATED_AT);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as { labId: string; playerCompanyId: string; availableTurns: number[]; latestProcessedTurn: number | null; dataStatus: string };
  assert.equal(body.labId, labId);
  assert.equal(body.playerCompanyId, "BAL");
  assert.deepEqual(body.availableTurns, [1]);
  assert.equal(body.latestProcessedTurn, 1);
  assert.equal(body.dataStatus, "confirmed");
});

test("handleExportLabIndex: 存在しないlabIdは404（LAB_NOT_FOUND）を返す", async () => {
  const writableDeps = makeWritableDeps();
  const { deps } = makeExportDeps(writableDeps);
  const result = await handleExportLabIndex(deps, "__no_such_lab__", GENERATED_AT);
  assert.equal(result.status, 404);
});

// -------------------------------------------------------------------
// handleExportCompanyTurn（会社スコープ）
// -------------------------------------------------------------------

test("handleExportCompanyTurn: BAL社ぶんのfinancialResult/financingResult/capexResult/companySummaryを返し、Repositoryの生データと数値が完全一致する（再計算なし）", async () => {
  const labId = "export-company-turn-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const result = await handleExportCompanyTurn(deps, labId, "1", "BAL", GENERATED_AT);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as {
    meta: { companyId?: string; scope: { kind: string; companyId?: string } };
    financialResult: ExportFinancialResult;
    financingResult: unknown;
    capexResult: unknown;
    companySummary: unknown;
  };

  assert.equal(body.meta.scope.kind, "company");
  assert.equal(body.meta.scope.companyId, "BAL");
  assert.ok(body.financialResult);
  assert.ok(body.financingResult);
  assert.ok(body.capexResult);
  assert.ok(body.companySummary);
  assert.equal(body.financialResult.companyId, "BAL");

  assertFinancialIntegrity("BAL turn1", body.financialResult);

  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  const rawFinancial = rawEntry.record.financialResults.find((r) => r.companyId === "BAL");
  assert.ok(rawFinancial);
  assert.equal(body.financialResult.profitAndLoss.netIncome, rawFinancial?.profitAndLoss.netIncome);
  assert.equal(body.financialResult.balanceSheet.cash, rawFinancial?.balanceSheet.cash);
  assert.equal(body.financialResult.cashFlow.closingCash, rawFinancial?.cashFlow.closingCash);
});

// --- 必須テスト(6): 会社スコープAPIへの他社非公開情報の混入がないこと ---

test("handleExportCompanyTurn: 会社スコープのレスポンスに他社のfinancialResults配列やotherCompaniesDecisionsが一切含まれない", async () => {
  const labId = "export-company-leak-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  const otherCompanyId = rawEntry.record.financialResults.find((r) => r.companyId !== "BAL")?.companyId;
  assert.ok(otherCompanyId, "BAL以外の会社の財務結果が存在するはず（比較対象として必要）");
  const otherFinancial = rawEntry.record.financialResults.find((r) => r.companyId === otherCompanyId);
  assert.ok(otherFinancial);

  const result = await handleExportCompanyTurn(deps, labId, "1", "BAL", GENERATED_AT);
  assert.equal(result.status, 200);
  const serialized = JSON.stringify(result.body);

  // 他社固有の一意な数値（純利益）が、BALスコープのレスポンスへ紛れ込んでいないこと。
  assert.equal(serialized.includes(String(otherFinancial?.profitAndLoss.netIncome)), false);
  // otherCompaniesDecisions・全社配列（financialResults・financingResults・capexResults）
  // というキー自体が、会社スコープのレスポンスへそもそも存在しないこと。
  assert.equal(serialized.includes("otherCompaniesDecisions"), false);
  assert.equal(serialized.includes("financialResults"), false);
  assert.equal(serialized.includes("financingResults"), false);
  assert.equal(serialized.includes("capexResults"), false);
  assert.equal(serialized.includes(String(otherCompanyId)), false);
});

test("handleExportCompanyTurn: 存在しない会社IDはnull項目を返す（400/500にせず、空データとして正常応答する）", async () => {
  const labId = "export-company-missing-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const result = await handleExportCompanyTurn(deps, labId, "1", "__no_such_company__", GENERATED_AT);
  assert.equal(result.status, 200);
  const body = result.body as { financialResult: unknown; financingResult: unknown; capexResult: unknown; companySummary: unknown };
  assert.equal(body.financialResult, null);
  assert.equal(body.financingResult, null);
  assert.equal(body.capexResult, null);
  assert.equal(body.companySummary, null);
});

test("handleExportCompanyTurn: 存在しないturnは404（HISTORY_ENTRY_NOT_FOUND）を返す", async () => {
  const labId = "export-company-noturn-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const result = await handleExportCompanyTurn(deps, labId, "99", "BAL", GENERATED_AT);
  assert.equal(result.status, 404);
});

test("handleExportCompanyTurn: turnが1未満・数値でない場合は400を返す", async () => {
  const labId = "export-company-badturn-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const result1 = await handleExportCompanyTurn(deps, labId, "0", "BAL", GENERATED_AT);
  assert.equal(result1.status, 400);
  const result2 = await handleExportCompanyTurn(deps, labId, "abc", "BAL", GENERATED_AT);
  assert.equal(result2.status, 400);
});

// -------------------------------------------------------------------
// handleExportAllCompaniesTurn（全社スコープ・GMフルスコープのみ）
// -------------------------------------------------------------------

test("handleExportAllCompaniesTurn: 全社ぶんの結果と市場結果を返す", async () => {
  const labId = "export-all-companies-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  const expectedCompanyCount = rawEntry.record.financialResults.length;

  const result = await handleExportAllCompaniesTurn(deps, labId, "1", GENERATED_AT);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as { meta: { scope: { kind: string } }; companies: { companyId: string }[]; market: unknown };
  assert.equal(body.meta.scope.kind, "allCompanies");
  assert.equal(body.companies.length, expectedCompanyCount);
  assert.ok(body.market);
  const balEntry = body.companies.find((c) => c.companyId === "BAL");
  assert.ok(balEntry);
});

// -------------------------------------------------------------------
// handleExportMarketTurn（市場結果・公開情報のみ）
// -------------------------------------------------------------------

test("handleExportMarketTurn: 市場結果を返し、会社固有の非公開情報を含まない", async () => {
  const labId = "export-market-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const result = await handleExportMarketTurn(deps, labId, "1", GENERATED_AT);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes("companySummaries"), false);
  assert.equal(serialized.includes("financialResults"), false);
});

// --- 必須テスト(11): 同一確定データの複数回取得でgeneratedAt以外が完全一致すること ---

test("handleExportCompanyTurn: 同一確定データを複数回取得しても、generatedAt以外は完全に一致する", async () => {
  const labId = "export-idempotent-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const result1 = await handleExportCompanyTurn(deps, labId, "1", "BAL", "2026-07-25T09:00:00.000Z");
  const result2 = await handleExportCompanyTurn(deps, labId, "1", "BAL", "2026-07-25T10:30:00.000Z");
  assert.equal(result1.status, 200);
  assert.equal(result2.status, 200);

  const body1 = result1.body as { meta: { generatedAt: string } };
  const body2 = result2.body as { meta: { generatedAt: string } };
  assert.notEqual(body1.meta.generatedAt, body2.meta.generatedAt);

  const normalize = (body: unknown) => JSON.stringify(body, (key, value) => (key === "generatedAt" ? "<normalized>" : value));
  assert.equal(normalize(result1.body), normalize(result2.body));
});

// --- 必須テスト(5): 呼び出し前後でゲーム状態が不変であること ---

test("handleExportCompanyTurn: 複数回呼び出してもゲーム状態（loadCurrentState/loadHistoryEntryの結果）が変化しない", async () => {
  const labId = "export-state-unchanged-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const stateBefore = await writableDeps.repository.loadCurrentState(labId);
  const historyBefore = await writableDeps.repository.loadHistoryEntry(labId, 1);

  await handleExportCompanyTurn(deps, labId, "1", "BAL", GENERATED_AT);
  await handleExportAllCompaniesTurn(deps, labId, "1", GENERATED_AT);
  await handleExportMarketTurn(deps, labId, "1", GENERATED_AT);
  await handleExportLabIndex(deps, labId, GENERATED_AT);

  const stateAfter = await writableDeps.repository.loadCurrentState(labId);
  const historyAfter = await writableDeps.repository.loadHistoryEntry(labId, 1);

  assert.deepEqual(stateAfter, stateBefore, "エクスポートAPI呼び出し後もラボの現在状態が変化してはならない");
  assert.deepEqual(historyAfter, historyBefore, "エクスポートAPI呼び出し後も確定履歴が変化してはならない");
});

// --- 必須テスト(8): 内部型の余分なフィールドがDTOへ自動混入しないこと ---

test("buildExportFinancialResult: 内部型に余分なフィールドが追加されても、DTOには許可した項目だけが含まれる", async () => {
  const labId = "export-dto-allowlist-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  const rawFinancial = rawEntry.record.financialResults.find((r) => r.companyId === "BAL");
  assert.ok(rawFinancial);

  // 【意図的な模擬】将来CompanyFinancialQuarterResultへ新しいフィールド
  // （例: 内部監査用のsecretInternalDebugField）が追加されたケースを模擬する。
  // buildExportFinancialResultはフィールドを1つずつ列挙して組み立てるため、
  // このような追加フィールドは戻り値へ一切現れないはずである。
  const tampered = { ...(rawFinancial as CompanyFinancialQuarterResult), secretInternalDebugField: "should-never-leak-to-export-api" } as CompanyFinancialQuarterResult;

  const dto = buildExportFinancialResult(tampered);
  const serialized = JSON.stringify(dto);
  assert.equal(serialized.includes("secretInternalDebugField"), false);
  assert.equal(serialized.includes("should-never-leak-to-export-api"), false);
  // 意図的にv1スコープ外とした内部専用フィールドも、そのまま漏れていないことを確認する。
  assert.equal(serialized.includes("manufacturingCost"), false);
  assert.equal(serialized.includes("qualityLoss"), false);
  assert.equal(serialized.includes("costRecords"), false);
  assert.equal(serialized.includes("contributionMargin"), false);
  assert.equal(serialized.includes("absorptionVariableReconciliation"), false);
});

// --- 必須テスト(9)の一部: 監査ログにトークン・Authorizationヘッダー相当の情報が残らないこと（ハンドラー経由での確認） ---

test("handleExportCompanyTurn呼び出し自体はhandlers.ts層では監査ログへ書き込まない（withExportApiContext層の責務であることの確認）", async () => {
  const labId = "export-no-direct-audit-write-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps, auditEntries } = makeExportDeps(writableDeps);

  await handleExportCompanyTurn(deps, labId, "1", "BAL", GENERATED_AT);
  // handlers.ts の各 handleExportXxx は auditLog.append を直接呼ばない
  // （withExportApiContext.ts が呼び出し前後で一元的に記録する設計）。
  assert.equal(auditEntries.length, 0);
});
