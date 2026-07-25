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
import { AI_PROPOSAL_UNAVAILABLE_REASON, buildExportFinancialResult, ExportFinancialResult } from "../exportDto";
import type { ExportSalesContract } from "../exportDto";
import { CompanyFinancialQuarterResult } from "../../../../../lib/v2/finance/types";
import { COUNTRY_IDS } from "../../../../../lib/v2/market/types";

const NOW = "2026-01-01T00:00:00.000Z";
const GENERATED_AT = "2026-07-25T09:00:00.000Z";
const BALANCE_TOLERANCE_USD = 1;
/**
 * 数量（HOSO換算トン）の検算許容誤差。ロールフォワード（期首＋新規－履行＝期末）は
 * 保存済みの確定値をそのまま足し引きするだけなので、差異はIEEE754の丸め誤差のみ。
 */
const QUANTITY_TOLERANCE_TONS = 1e-6;

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
  const body = result.body as { financialResult: unknown; financingResult: unknown; capexResult: unknown; companySummary: unknown; salesContracts: unknown[] };
  assert.equal(body.financialResult, null);
  assert.equal(body.financingResult, null);
  assert.equal(body.capexResult, null);
  assert.equal(body.companySummary, null);
  assert.deepEqual(body.salesContracts, []);
});

// --- 【v1.1追加／v1.2（Phase 8C-3B §2）で拡張】成約明細(salesContracts)テスト ---

test("handleExportCompanyTurn: BAL社の成約明細(salesContracts)が、Repositoryの生データ(preProcessingStateSnapshot/postProcessingStateSnapshot.contracts)と数値・件数が一致する", async () => {
  const labId = "export-company-contracts-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const result = await handleExportCompanyTurn(deps, labId, "1", "BAL", GENERATED_AT);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as { salesContracts: ExportSalesContract[] };
  assert.ok(Array.isArray(body.salesContracts));

  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  const own = (companyId: string) => (c: { companyId: string }) => c.companyId === companyId;
  const beginning = rawEntry.preProcessingStateSnapshot.contracts.filter(own("BAL"));
  const ending = rawEntry.postProcessingStateSnapshot.contracts.filter(own("BAL"));
  assert.ok(ending.length > 0, "BAL社の契約が1件も生成されていない（テストシナリオの前提が崩れている）");

  // ロールフォワードは「期首 ∪ 当期新規 ∪ 期末」の和集合を1契約=1行として出力する。
  const expectedIds = new Set<string>([
    ...beginning.map((c) => c.contractId),
    ...ending.map((c) => c.contractId),
    ...rawEntry.record.salesRecord.newContracts.filter(own("BAL")).map((c) => c.contractId),
  ]);
  assert.equal(body.salesContracts.length, expectedIds.size);

  for (const rawContract of ending) {
    const dtoContract = body.salesContracts.find((c) => c.contractId === rawContract.contractId);
    assert.ok(dtoContract, `契約${rawContract.contractId}がDTOに見つからない`);
    assert.equal(dtoContract!.companyId, rawContract.companyId);
    assert.equal(dtoContract!.market, rawContract.market);
    assert.equal(dtoContract!.product, rawContract.product);
    assert.equal(dtoContract!.originalQuantity, rawContract.originalQuantity);
    // 期末残数量は postProcessingStateSnapshot の確定値をそのまま転記する（再計算しない）。
    assert.equal(dtoContract!.endingOutstandingQuantity, rawContract.outstandingQuantity);
    assert.equal(dtoContract!.unitPrice, rawContract.unitPrice);
    assert.equal(dtoContract!.status, rawContract.status);
    assert.equal(dtoContract!.existsAtEnd, true);
  }
});

// --- 【必須完了条件2】期首契約＋新規契約－履行＝期末契約が契約ID単位で追跡できること（§2・§10） ---

test("handleExportCompanyTurn: 契約ID単位で「期首残＋当期新規－当期履行＝期末残」が成立する", async () => {
  const labId = "export-contract-rollforward-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const result = await handleExportCompanyTurn(deps, labId, "1", "BAL", GENERATED_AT);
  assert.equal(result.status, 200);
  const body = result.body as { salesContracts: ExportSalesContract[] };
  assert.ok(body.salesContracts.length > 0);

  for (const c of body.salesContracts) {
    const difference =
      c.beginningOutstandingQuantity + c.newContractedQuantity - c.fulfilledQuantity - c.endingOutstandingQuantity;
    assert.ok(
      Math.abs(difference) < QUANTITY_TOLERANCE_TONS,
      `契約${c.contractId}のロールフォワードが一致しません（期首${c.beginningOutstandingQuantity}＋新規${c.newContractedQuantity}－履行${c.fulfilledQuantity}－期末${c.endingOutstandingQuantity}＝${difference}）`,
    );
  }

  // 当期新規成約は「期首に存在せず期末に存在する」契約として識別できること。
  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  const rawCreatedIds = new Set(
    rawEntry.record.salesRecord.newContracts.filter((c) => c.companyId === "BAL").map((c) => c.contractId),
  );
  const dtoNewIds = new Set(body.salesContracts.filter((c) => c.isNewThisQuarter).map((c) => c.contractId));
  assert.deepEqual([...dtoNewIds].sort(), [...rawCreatedIds].sort());
});

// --- 【§2】契約時想定原価スナップショット(costSnapshot) ---

test("handleExportCompanyTurn: salesContractsのcostSnapshotが、保存済みの契約時想定原価と一致する", async () => {
  const labId = "export-contract-cost-snapshot-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  const rawWithSnapshot = rawEntry.postProcessingStateSnapshot.contracts.find(
    (c) => c.companyId === "BAL" && c.costSnapshot !== undefined,
  );
  assert.ok(rawWithSnapshot, "costSnapshotを持つBAL社の契約が存在するはず（§2の対象データ）");

  const result = await handleExportCompanyTurn(deps, labId, "1", "BAL", GENERATED_AT);
  const body = result.body as { salesContracts: ExportSalesContract[] };
  const dto = body.salesContracts.find((c) => c.contractId === rawWithSnapshot!.contractId);
  assert.ok(dto);
  assert.ok(dto!.costSnapshot, "costSnapshotがDTOへ出力されていません");
  assert.equal(
    dto!.costSnapshot!.expectedRawMaterialPriceUsdPerHosoEqKg,
    rawWithSnapshot!.costSnapshot!.expectedRawMaterialPriceUsdPerHosoEqKg,
  );
  assert.equal(
    dto!.costSnapshot!.expectedProcessingCostUsdPerHosoEqKg,
    rawWithSnapshot!.costSnapshot!.expectedProcessingCostUsdPerHosoEqKg,
  );
  assert.equal(
    dto!.costSnapshot!.minimumAcceptablePriceUsdPerHosoEqKg,
    rawWithSnapshot!.costSnapshot!.minimumAcceptablePriceUsdPerHosoEqKg,
  );
  assert.equal(
    dto!.costSnapshot!.expectedContributionMarginUsdPerHosoEqKg,
    rawWithSnapshot!.costSnapshot!.expectedContributionMarginUsdPerHosoEqKg,
  );
});

// --- 【§3】市場別×商品別の販売明細 ---

test("handleExportCompanyTurn: 市場別×商品別の成約配分(marketProductAllocations)が、保存済みsalesRecord.allocationsと一致する", async () => {
  const labId = "export-sales-detail-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  const rawAllocations = rawEntry.record.salesRecord.allocations;
  assert.ok(rawAllocations.length > 0, "salesRecord.allocationsが空（テストシナリオの前提が崩れている）");

  const result = await handleExportCompanyTurn(deps, labId, "1", "BAL", GENERATED_AT);
  const body = result.body as {
    marketProductAllocations: {
      market: string;
      product: string;
      basePrice: number;
      targetDemand: number;
      companies: { companyId: string; askPrice: number; allocatedQuantity: number }[];
    }[];
    salesPlans: { companyId: string; market: string; product: string; desiredQuantity: number }[];
  };
  assert.equal(body.marketProductAllocations.length, rawAllocations.length);

  for (const rawAllocation of rawAllocations) {
    const dto = body.marketProductAllocations.find(
      (a) => a.market === rawAllocation.market && a.product === rawAllocation.product,
    );
    assert.ok(dto, `${rawAllocation.market}×${rawAllocation.product}の配分がDTOに見つからない`);
    // 公開情報（基準価格・対象需要）は会社スコープでもそのまま出力する。
    assert.equal(dto!.basePrice, rawAllocation.basePrice);
    assert.equal(dto!.targetDemand, rawAllocation.targetDemand);
    // 会社別の内訳は対象会社ぶんだけへ絞り込む。
    assert.ok(dto!.companies.every((c) => c.companyId === "BAL"));
    const rawOwn = rawAllocation.companies.find((c) => c.companyId === "BAL");
    if (rawOwn) {
      assert.equal(dto!.companies.length, 1);
      assert.equal(dto!.companies[0].askPrice, rawOwn.askPrice);
      assert.equal(dto!.companies[0].allocatedQuantity, rawOwn.allocatedQuantity);
    }
  }

  // 販売計画も市場別×商品別に、対象会社ぶんだけ出力される。
  assert.ok(body.salesPlans.length > 0);
  assert.ok(body.salesPlans.every((p) => p.companyId === "BAL"));
});

// --- 【§4】市場結果の全17項目 ---

test("handleExportCompanyTurn: 市場結果に国別HOSO価格・PD/VAPプレミアム・ベトナム国内原料市場が含まれ、保存値と一致する", async () => {
  const labId = "export-market-detail-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  const rawMarket = rawEntry.record.marketResult;

  const result = await handleExportCompanyTurn(deps, labId, "1", "BAL", GENERATED_AT);
  const body = result.body as {
    market: {
      hosoPricesByCountry: { country: string; price: number; priorPrice: number; changeRatio: number; exportableSupply: number; allocatedDemand: number; utilizationRatio: number; drivers: string[] }[];
      vietnamDomestic: { price: number; buyingCeiling: number; farmerReservationPrice: number; unsoldSupply: number; imbalance: number };
      pdPremium: { basePremium: number; byCountry: { country: string; finalPrice: number }[] };
      vapPremium: { basePremium: number; byCountry: { country: string; finalPrice: number }[] };
      globalDrivers: string[];
    };
  };

  assert.deepEqual(body.market.hosoPricesByCountry.map((h) => h.country), [...COUNTRY_IDS]);
  for (const country of COUNTRY_IDS) {
    const dto = body.market.hosoPricesByCountry.find((h) => h.country === country);
    const raw = rawMarket.hosoPrices[country];
    assert.ok(dto);
    assert.equal(dto!.price, raw.price);
    assert.equal(dto!.priorPrice, raw.priorPrice);
    assert.equal(dto!.changeRatio, raw.changeRatio);
    assert.equal(dto!.exportableSupply, raw.exportableSupply);
    assert.equal(dto!.allocatedDemand, raw.allocatedDemand);
    assert.equal(dto!.utilizationRatio, raw.utilizationRatio);
    assert.deepEqual(dto!.drivers, [...raw.drivers]);
  }

  assert.equal(body.market.vietnamDomestic.price, rawMarket.vietnamDomestic.price);
  assert.equal(body.market.vietnamDomestic.buyingCeiling, rawMarket.vietnamDomestic.buyingCeiling);
  assert.equal(body.market.vietnamDomestic.farmerReservationPrice, rawMarket.vietnamDomestic.farmerReservationPrice);
  assert.equal(body.market.vietnamDomestic.unsoldSupply, rawMarket.vietnamDomestic.unsoldSupply);
  assert.equal(body.market.vietnamDomestic.imbalance, rawMarket.vietnamDomestic.imbalance);

  assert.equal(body.market.pdPremium.basePremium, rawMarket.pdPremium.basePremium);
  assert.equal(body.market.vapPremium.basePremium, rawMarket.vapPremium.basePremium);
  for (const country of COUNTRY_IDS) {
    assert.equal(
      body.market.pdPremium.byCountry.find((c) => c.country === country)!.finalPrice,
      rawMarket.pdPremium.byCountry[country].finalPrice,
    );
    assert.equal(
      body.market.vapPremium.byCountry.find((c) => c.country === country)!.finalPrice,
      rawMarket.vapPremium.byCountry[country].finalPrice,
    );
  }
  assert.deepEqual(body.market.globalDrivers, [...rawMarket.globalDrivers]);
});

// --- 【§5】品質・生産・原料の明細 ---

test("handleExportCompanyTurn: 商品別品質スコア・市場別顧客信頼・生産バッチ・原料ロットが出力され、対象会社ぶんだけへ絞り込まれる", async () => {
  const labId = "export-operations-detail-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const result = await handleExportCompanyTurn(deps, labId, "1", "BAL", GENERATED_AT);
  const body = result.body as {
    operations: {
      qualityState: {
        qualityByCompanyProduct: { companyId: string; product: string; qualityScore: number }[];
        trustByCompanyMarket: { companyId: string; market: string; customerTrustScore: number }[];
        rampHistory: { companyId: string }[];
      };
      productionBatches: { companyId: string; batchId: string; finishedGoodsQuantity: number }[];
      productionAllocation: { entries: { companyId: string }[] };
      factoryLoadMetrics: { companyId: string }[];
      companyLoadMetrics: { companyId: string }[];
      rawMaterialRequirements: { companyId: string }[];
      domesticPurchaseAllocation: { marketPrice: number; companies: { companyId: string }[] };
      rawMaterialLots: { beginning: { companyId: string }[]; ending: { companyId: string }[] };
      finishedGoodsLots: { beginning: { companyId: string }[]; produced: { companyId: string }[]; ending: { companyId: string }[] };
      qualityAdjustments: { companyId: string }[];
      deliveryObservations: { companyId: string }[];
    };
  };
  const ops = body.operations;

  // §5の12項目のうち、会社別に持つものはすべてBAL社ぶんだけであること（§6のスコープ隔離）。
  const companyScopedArrays: readonly (readonly { companyId: string }[])[] = [
    ops.qualityState.qualityByCompanyProduct,
    ops.qualityState.trustByCompanyMarket,
    ops.qualityState.rampHistory,
    ops.qualityAdjustments,
    ops.deliveryObservations,
    ops.productionBatches,
    ops.productionAllocation.entries,
    ops.factoryLoadMetrics,
    ops.companyLoadMetrics,
    ops.rawMaterialRequirements,
    ops.domesticPurchaseAllocation.companies,
    ops.rawMaterialLots.beginning,
    ops.rawMaterialLots.ending,
    ops.finishedGoodsLots.beginning,
    ops.finishedGoodsLots.produced,
    ops.finishedGoodsLots.ending,
  ];
  for (const rows of companyScopedArrays) {
    assert.ok(rows.every((r) => r.companyId === "BAL"), `他社のcompanyIdが混入しています: ${JSON.stringify(rows.map((r) => r.companyId))}`);
  }

  // 中身が空でないこと（「空データ説明だけ」ではなく実際の明細が展開されていること＝§7-4）。
  assert.ok(ops.qualityState.qualityByCompanyProduct.length > 0, "商品別品質スコアが空です");
  assert.ok(ops.qualityState.trustByCompanyMarket.length > 0, "市場別顧客信頼が空です");
  assert.ok(ops.productionBatches.length > 0, "生産バッチ明細が空です");
  assert.ok(ops.productionAllocation.entries.length > 0, "生産配分が空です");
  assert.ok(ops.companyLoadMetrics.length > 0, "会社別稼働実績が空です");
  assert.ok(ops.rawMaterialLots.ending.length > 0, "原料ロットの期末状態が空です");

  // 国内買付市場の公開情報（市場価格）は会社スコープでも保存値のまま出力する。
  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  assert.equal(ops.domesticPurchaseAllocation.marketPrice, rawEntry.record.domesticAllocation.marketPrice);
});

// --- 【§6】意思決定内容（会社スコープ／GMスコープ） ---

test("handleExportCompanyTurn: 会社スコープのdecisionInfoは対象会社の提出意思決定のみを持ち、他社の意思決定を含まない", async () => {
  const labId = "export-decision-company-scope-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const result = await handleExportCompanyTurn(deps, labId, "1", "BAL", GENERATED_AT);
  const body = result.body as {
    decisionInfo: {
      isPlayerCompany: boolean;
      submission: { companyId: string; salesPlans: { companyId: string }[]; financingRequest: { desiredAmountUsd: number } } | null;
      aiProposal: unknown;
      diffFromAiProposal: unknown;
      aiProposalUnavailableReason: string | null;
      reasonCodes: { companyId: string }[];
    };
  };
  const info = body.decisionInfo;
  assert.equal(info.isPlayerCompany, true);
  assert.ok(info.submission, "対象会社の提出意思決定が出力されていません");
  assert.equal(info.submission!.companyId, "BAL");
  assert.ok(info.submission!.salesPlans.every((p) => p.companyId === "BAL"));
  assert.ok(info.reasonCodes.every((r) => r.companyId === "BAL"));

  // 提出額は確定履歴の保存値と一致する（再計算・推測をしない）。
  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  const rawDecision = rawEntry.record.decisions.find((d) => d.companyId === "BAL");
  assert.ok(rawDecision);
  assert.equal(info.submission!.financingRequest.desiredAmountUsd, rawDecision!.financingRequest.desiredAmountUsd);

  // AI提案は確定履歴に未保存であるため null＋理由文（推測値を実績として補完しない＝§9）。
  assert.equal(info.aiProposal, null);
  assert.equal(info.diffFromAiProposal, null);
  assert.equal(info.aiProposalUnavailableReason, AI_PROPOSAL_UNAVAILABLE_REASON);

  // 会社スコープのレスポンス本文に、他社の意思決定を示すキーが一切現れない。
  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes("otherCompaniesDecisions"), false);
  assert.equal(serialized.includes("submissions"), false);
  assert.equal(serialized.includes("playerSubmission"), false);
});

test("handleExportAllCompaniesTurn: GMスコープのdecisionInfoは全5社の提出意思決定と全社の警告を収録する", async () => {
  const labId = "export-decision-gm-scope-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  const rawCompanyIds = [...rawEntry.record.decisions.map((d) => d.companyId)].sort();

  const result = await handleExportAllCompaniesTurn(deps, labId, "1", GENERATED_AT);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as {
    decisionInfo: {
      playerCompanyId: string;
      submissions: { companyId: string }[];
      playerSubmission: { companyId: string };
      otherCompaniesDecisions: { companyId: string }[];
      aiProposals: unknown[];
      aiProposalUnavailableReason: string | null;
      reasonCodes: { companyId: string }[];
    };
    operations: { companyLoadMetrics: { companyId: string }[] };
    marketProductAllocations: { companies: { companyId: string }[] }[];
  };

  assert.equal(body.decisionInfo.playerCompanyId, "BAL");
  assert.deepEqual(body.decisionInfo.submissions.map((s) => s.companyId), rawCompanyIds);
  assert.equal(body.decisionInfo.playerSubmission.companyId, "BAL");
  assert.equal(body.decisionInfo.otherCompaniesDecisions.length, rawEntry.otherCompaniesDecisions.length);
  assert.equal(body.decisionInfo.otherCompaniesDecisions.some((d) => d.companyId === "BAL"), false);
  assert.deepEqual(body.decisionInfo.aiProposals, []);
  assert.equal(body.decisionInfo.aiProposalUnavailableReason, AI_PROPOSAL_UNAVAILABLE_REASON);

  // GMスコープは全社ぶんの明細を持つ（会社スコープと異なり絞り込まない）。
  const loadMetricCompanyIds = [...new Set(body.operations.companyLoadMetrics.map((m) => m.companyId))].sort();
  assert.deepEqual(loadMetricCompanyIds, rawCompanyIds);
  const allocationCompanyIds = new Set(body.marketProductAllocations.flatMap((a) => a.companies.map((c) => c.companyId)));
  assert.ok(allocationCompanyIds.size > 1, "GMスコープの成約配分に複数社が含まれていません");
});

test("handleExportAllCompaniesTurn: 同一確定データを複数回取得しても、generatedAt以外は完全に一致する", async () => {
  const labId = "export-gm-idempotent-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const result1 = await handleExportAllCompaniesTurn(deps, labId, "1", "2026-07-25T09:00:00.000Z");
  const result2 = await handleExportAllCompaniesTurn(deps, labId, "1", "2026-07-25T10:30:00.000Z");
  assert.equal(result1.status, 200);
  assert.equal(result2.status, 200);

  const normalize = (body: unknown) => JSON.stringify(body, (key, value) => (key === "generatedAt" ? "<normalized>" : value));
  assert.equal(normalize(result1.body), normalize(result2.body));
});

test("handleExportCompanyTurn: BAL社スコープのsalesContractsに他社の契約が一切含まれない", async () => {
  const labId = "export-company-contracts-leak-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const { deps } = makeExportDeps(writableDeps);

  const rawEntry = await writableDeps.repository.loadHistoryEntry(labId, 1);
  const otherCompanyContract = rawEntry.postProcessingStateSnapshot.contracts.find((c) => c.companyId !== "BAL");
  assert.ok(otherCompanyContract, "BAL以外の会社の契約が存在するはず（比較対象として必要）");

  const result = await handleExportCompanyTurn(deps, labId, "1", "BAL", GENERATED_AT);
  assert.equal(result.status, 200);
  const body = result.body as { salesContracts: { contractId: string; companyId: string }[] };
  assert.equal(
    body.salesContracts.some((c) => c.contractId === otherCompanyContract?.contractId),
    false,
  );
  assert.ok(body.salesContracts.every((c) => c.companyId === "BAL"));
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
  const body = result.body as { meta: { scope: { kind: string } }; companies: { companyId: string; salesContracts: { contractId: string; companyId: string }[] }[]; market: unknown };
  assert.equal(body.meta.scope.kind, "allCompanies");
  assert.equal(body.companies.length, expectedCompanyCount);
  assert.ok(body.market);
  const balEntry = body.companies.find((c) => c.companyId === "BAL");
  assert.ok(balEntry);
  assert.ok(Array.isArray(balEntry?.salesContracts));
  assert.ok(balEntry?.salesContracts.every((c) => c.companyId === "BAL"));
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
