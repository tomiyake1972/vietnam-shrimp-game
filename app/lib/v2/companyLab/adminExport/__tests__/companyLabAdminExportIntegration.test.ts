// ShrimpX V2 — Company Lab 管理者画面「分析データをエクスポート」機能 統合テスト
//
// companyLabAdminExportSource.ts（自己fetch＋Authorizationヘッダー組み立て）が、
// 実際のHTTPを介して既存Export APIハンドラー（handlers.ts）と正しく連携すること、
// 取得したJSONがZIPへそのまま格納されること、呼び出し前後でゲーム状態が一切
// 変化しないことを、実HTTPサーバー（Node http、ローカルloopback）を使って検証する。
//
// 【カバーする必須テスト】
//   - 正しいSTAGING_EXPORT_TOKENでのみ取得できる／不一致なら拒否する
//   - Export前後でゲーム状態が変化しない
//   - ZIP内の各JSONが既存Export APIレスポンス（handlers.ts直接呼び出し結果）と一致する

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import JSZip from "jszip";
import { createInMemoryCompanyLabStateRepository } from "../../persistence/repository";
import { createCompanyLabQuarterFlowService } from "../../application/companyLabQuarterFlowService";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";
import { buildInitialDraft } from "../../../../../v2/company-lab/decisionDraft";
import { CompanyLabApiDependencies } from "../../../../../api/v2/company-labs/_lib/dependencies";
import { handleCreateLab, handleProcessQuarter, handleSaveDraft, handleSubmitDraft } from "../../../../../api/v2/company-labs/_lib/handlers";
import { toReadOnlyCompanyLabRepository } from "../../persistence/readOnlyRepository";
import { handleExportAllCompaniesTurn, handleExportCompanyTurn, handleExportLabIndex, handleExportMarketTurn } from "../../../../../api/v2/exports/_lib/handlers";
import { fetchAllCompaniesTurnExport, fetchCompanyTurnExport, fetchLabIndex, fetchMarketTurnExport } from "../companyLabAdminExportSource";
import { buildCompanyLabAdminExportZip } from "../companyLabAdminExportZip";
import type { CompanyExportPayload } from "../../../../../api/v2/exports/_lib/exportDto";

const NOW = "2026-01-01T00:00:00.000Z";
const TEST_TOKEN = "integration-test-export-token-value";

function makeWritableDeps(): CompanyLabApiDependencies {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  return { repository, service };
}

function buildValidPlayerDraftBodyFor(companyId: string): unknown {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "admin-export-integration-seed", turns: 4 });
  const publicInfo = buildPublicMarketInfo(state);
  const fixture = fixtures.find((f) => f.companyId === companyId);
  if (!fixture) throw new Error(`テスト用フィクスチャに${companyId}が見つかりません`);
  const ownState = buildCompanyOwnState(state, fixture);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  return buildInitialDraft(fixture, autoDecision);
}

const VALID_PLAYER_DRAFT_BODY = buildValidPlayerDraftBodyFor("BAL");

async function setUpProcessedTurn1Lab(labId: string): Promise<CompanyLabApiDependencies> {
  const writableDeps = makeWritableDeps();
  await handleCreateLab(writableDeps, { scenarioId: "baseline", mode: "canonical", seed: "admin-export-integration-lab-seed", turns: 4, playerCompanyId: "BAL", labId }, NOW);
  const saveResult = await handleSaveDraft(writableDeps, labId, { draft: VALID_PLAYER_DRAFT_BODY }, NOW);
  assert.equal(saveResult.status, 200, JSON.stringify(saveResult.body));
  const submitResult = await handleSubmitDraft(writableDeps, labId, NOW);
  assert.equal(submitResult.status, 200, JSON.stringify(submitResult.body));
  const processResult = await handleProcessQuarter(writableDeps, labId, {}, NOW);
  assert.equal(processResult.status, 200, JSON.stringify(processResult.body));
  return writableDeps;
}

/**
 * companyLabAdminExportSource.tsが自己fetchする先を模した、実HTTPのローカルテスト
 * サーバー。既存のexportハンドラー（handlers.ts）をそのまま呼び出すだけの薄い
 * ディスパッチであり、認証（Bearerトークン比較）もこのテストファイル内だけの
 * 単純な文字列比較にしている（assertStagingExport自体のテストはstagingExport.test.ts側で
 * 別途カバー済みのため、ここでは「正しいヘッダーが実際に送られてくるか」だけを検証する）。
 */
function startTestExportServer(
  deps: { readOnlyRepository: ReturnType<typeof toReadOnlyCompanyLabRepository>; auditLog: { append: (entry: unknown) => Promise<void> } },
  expectedToken: string,
): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const authHeader = req.headers["authorization"] ?? "";
      const provided = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
      if (provided !== expectedToken) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "認証に失敗しました。" } }));
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const now = new Date().toISOString();
      const companyMatch = url.pathname.match(/^\/api\/v2\/exports\/company-labs\/([^/]+)\/turns\/([^/]+)\/companies\/([^/]+)$/);
      const marketMatch = url.pathname.match(/^\/api\/v2\/exports\/company-labs\/([^/]+)\/turns\/([^/]+)\/market$/);
      const allMatch = url.pathname.match(/^\/api\/v2\/exports\/company-labs\/([^/]+)\/turns\/([^/]+)$/);
      const indexMatch = url.pathname.match(/^\/api\/v2\/exports\/company-labs\/([^/]+)$/);

      let result: { status: number; body: unknown };
      if (companyMatch) {
        result = await handleExportCompanyTurn(deps as never, companyMatch[1], companyMatch[2], companyMatch[3], now);
      } else if (marketMatch) {
        result = await handleExportMarketTurn(deps as never, marketMatch[1], marketMatch[2], now);
      } else if (allMatch) {
        result = await handleExportAllCompaniesTurn(deps as never, allMatch[1], allMatch[2], now);
      } else if (indexMatch) {
        result = await handleExportLabIndex(deps as never, indexMatch[1], now);
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
        return;
      }
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

test("companyLabAdminExportSource ↔ 実HTTP経由のExportハンドラー: 正しいトークンで4種のデータを取得でき、handlers.ts直接呼び出しの結果と完全一致する", async () => {
  const labId = "admin-export-integration-lab";
  const writableDeps = await setUpProcessedTurn1Lab(labId);
  const auditEntries: unknown[] = [];
  const exportDeps = {
    readOnlyRepository: toReadOnlyCompanyLabRepository(writableDeps.repository),
    auditLog: { append: async (entry: unknown) => void auditEntries.push(entry) },
  };

  const { server, origin } = await startTestExportServer(exportDeps, TEST_TOKEN);
  const originalEnv = process.env.STAGING_EXPORT_TOKEN;
  process.env.STAGING_EXPORT_TOKEN = TEST_TOKEN;

  try {
    const stateBefore = await writableDeps.repository.loadCurrentState(labId);
    const historyBefore = await writableDeps.repository.loadHistoryEntry(labId, 1);

    const indexResult = await fetchLabIndex(origin, labId);
    assert.equal(indexResult.ok, true, JSON.stringify(indexResult));
    const companyResult = await fetchCompanyTurnExport(origin, labId, 1, "BAL");
    assert.equal(companyResult.ok, true, JSON.stringify(companyResult));
    const allResult = await fetchAllCompaniesTurnExport(origin, labId, 1);
    assert.equal(allResult.ok, true, JSON.stringify(allResult));
    const marketResult = await fetchMarketTurnExport(origin, labId, 1);
    assert.equal(marketResult.ok, true, JSON.stringify(marketResult));

    // handlers.tsを直接呼び出した結果（HTTPを経由しない）と、companyLabAdminExportSource経由で
    // 実HTTPを介して取得した結果が、generatedAt以外で完全一致すること。
    const directIndex = await handleExportLabIndex(exportDeps as never, labId, "2026-01-01T00:00:00.000Z");
    const directCompany = await handleExportCompanyTurn(exportDeps as never, labId, "1", "BAL", "2026-01-01T00:00:00.000Z");
    const directAll = await handleExportAllCompaniesTurn(exportDeps as never, labId, "1", "2026-01-01T00:00:00.000Z");
    const directMarket = await handleExportMarketTurn(exportDeps as never, labId, "1", "2026-01-01T00:00:00.000Z");

    const normalize = (body: unknown) => JSON.stringify(body, (key, value) => (key === "generatedAt" ? "<normalized>" : value));
    assert.equal(indexResult.ok && normalize(indexResult.data), normalize(directIndex.body));
    assert.equal(companyResult.ok && normalize(companyResult.data), normalize(directCompany.body));
    assert.equal(allResult.ok && normalize(allResult.data), normalize(directAll.body));
    assert.equal(marketResult.ok && normalize(marketResult.data), normalize(directMarket.body));

    // ZIPへ格納したJSONも、fetchで取得した内容とそのまま一致すること（別経路での加工・再計算をしていない）。
    if (indexResult.ok && companyResult.ok && allResult.ok && marketResult.ok) {
      const zipBuffer = await buildCompanyLabAdminExportZip({
        labId,
        turn: 1,
        companyId: "BAL",
        generatedAt: "2026-07-26T09:00:00.000Z",
        labIndexJson: indexResult.data,
        companyJson: companyResult.data as CompanyExportPayload,
        allCompaniesJson: allResult.data,
        marketJson: marketResult.data,
        includeExcel: false,
      });
      const zip = await JSZip.loadAsync(zipBuffer);
      const zippedCompanyJson = JSON.parse(await zip.file("BAL_company_admin-export-integration-lab_turn1.json")!.async("string"));
      assert.deepEqual(zippedCompanyJson, companyResult.data);
    }

    // Export前後でゲーム状態（現在状態・確定履歴）が一切変化していないこと。
    const stateAfter = await writableDeps.repository.loadCurrentState(labId);
    const historyAfter = await writableDeps.repository.loadHistoryEntry(labId, 1);
    assert.deepEqual(stateAfter, stateBefore);
    assert.deepEqual(historyAfter, historyBefore);

    // 誤ったトークンでは取得できないこと（正しいトークンでのみ成功する、の裏返し）。
    process.env.STAGING_EXPORT_TOKEN = "wrong-token-value";
    const wrongTokenResult = await fetchLabIndex(origin, labId);
    assert.equal(wrongTokenResult.ok, false);
  } finally {
    process.env.STAGING_EXPORT_TOKEN = originalEnv;
    server.close();
  }
});
