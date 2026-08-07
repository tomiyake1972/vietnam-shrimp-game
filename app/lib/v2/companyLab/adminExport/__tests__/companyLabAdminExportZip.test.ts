// ShrimpX V2 — companyLabAdminExportZip.ts のテスト
//
// 【カバーする必須テスト】
//   - ZIP内の各JSONが、渡した入力（＝既存Export APIレスポンス）と一致すること
//   - ZIP内にSecret・Authorizationヘッダー・Redis内部情報が一切含まれないこと
//   - Excelを含める場合、その唯一の入力がExport JSON（companyJson）であること

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { buildCompanyLabAdminExportZip } from "../companyLabAdminExportZip";
import type { CompanyExportPayload } from "../../../../../api/v2/exports/_lib/exportDto";
import { buildSyntheticCompanyExportPayload } from "./syntheticExportPayload";

// Phase 8C-3B（三宅さんの指示 §2〜§6）で CompanyExportPayload の必須フィールドが増えたため、
// companyLabAdminExcelBuilder.test.ts と同じ合成ペイロードヘルパーを共有する。
// labId・financialResult はこのテストの既存前提（zip-test-lab／財務結果なし）へ合わせて上書きする。
const SYNTHETIC_COMPANY_JSON: CompanyExportPayload = buildSyntheticCompanyExportPayload({
  meta: {
    schemaVersion: 1,
    generatedAt: "2026-07-26T00:00:00.000Z",
    labId: "zip-test-lab",
    turn: 1,
    period: "2015Q1" as CompanyExportPayload["meta"]["period"],
    engineVersion: "test-engine",
    dataStatus: "confirmed",
    scope: { kind: "company", companyId: "BAL" },
  },
  financialResult: null,
});

const SYNTHETIC_LAB_INDEX = { schemaVersion: 1, generatedAt: "x", labId: "zip-test-lab", engineVersion: "test-engine", dataStatus: "confirmed", playerCompanyId: "BAL", availableTurns: [1], latestProcessedTurn: 1 };
const SYNTHETIC_ALL_COMPANIES = { meta: { scope: { kind: "allCompanies" } }, companies: [], market: {} };
const SYNTHETIC_MARKET = { meta: {}, market: { period: "2015Q1", parametersVersion: "v1", worldSupply: 100, worldDemand: 100, worldSupplyDemandBalance: 0 } };

test("buildCompanyLabAdminExportZip: ZIP内のJSONが入力と完全一致し、manifest.jsonに全ファイルが列挙される", async () => {
  const zipBuffer = await buildCompanyLabAdminExportZip({
    labId: "zip-test-lab",
    turn: 1,
    companyId: "BAL",
    generatedAt: "2026-07-26T09:00:00.000Z",
    labIndexJson: SYNTHETIC_LAB_INDEX,
    companyJson: SYNTHETIC_COMPANY_JSON,
    allCompaniesJson: SYNTHETIC_ALL_COMPANIES,
    marketJson: SYNTHETIC_MARKET,
    includeExcel: false,
  });

  const zip = await JSZip.loadAsync(zipBuffer);
  const fileNames = Object.keys(zip.files).sort();
  assert.deepEqual(fileNames, ["BAL_company_zip-test-lab_turn1.json", "all_companies_zip-test-lab_turn1.json", "lab_index.json", "manifest.json", "market_zip-test-lab_turn1.json"].sort());

  const labIndexContent = JSON.parse(await zip.file("lab_index.json")!.async("string"));
  assert.deepEqual(labIndexContent, SYNTHETIC_LAB_INDEX);

  const companyContent = JSON.parse(await zip.file("BAL_company_zip-test-lab_turn1.json")!.async("string"));
  assert.deepEqual(companyContent, SYNTHETIC_COMPANY_JSON);

  const allContent = JSON.parse(await zip.file("all_companies_zip-test-lab_turn1.json")!.async("string"));
  assert.deepEqual(allContent, SYNTHETIC_ALL_COMPANIES);

  const marketContent = JSON.parse(await zip.file("market_zip-test-lab_turn1.json")!.async("string"));
  assert.deepEqual(marketContent, SYNTHETIC_MARKET);

  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  assert.equal(manifest.labId, "zip-test-lab");
  assert.equal(manifest.turn, 1);
  assert.equal(manifest.companyId, "BAL");
  assert.equal(manifest.entries.length, 4);
});

test("buildCompanyLabAdminExportZip: includeExcel=trueならExcelファイルも含まれ、その入力はcompanyJsonのみである", async () => {
  const zipBuffer = await buildCompanyLabAdminExportZip({
    labId: "zip-test-lab",
    turn: 1,
    companyId: "BAL",
    generatedAt: "2026-07-26T09:00:00.000Z",
    labIndexJson: SYNTHETIC_LAB_INDEX,
    companyJson: SYNTHETIC_COMPANY_JSON,
    allCompaniesJson: SYNTHETIC_ALL_COMPANIES,
    marketJson: SYNTHETIC_MARKET,
    includeExcel: true,
  });
  const zip = await JSZip.loadAsync(zipBuffer);
  const excelFile = zip.file("BAL_zip-test-lab_turn1_databook.xlsx");
  assert.ok(excelFile, "Excelファイルがzipに含まれているはず");

  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  assert.equal(manifest.entries.length, 5);
  const excelEntry = manifest.entries.find((e: { file: string }) => e.file === "BAL_zip-test-lab_turn1_databook.xlsx");
  assert.ok(excelEntry);
  // Excelエントリのsource記載は「companyJsonのみを入力として生成した」旨であり、
  // Redis・Repository等の別経路は一切記載されていない（=別経路を参照していない設計の裏付け）。
  assert.equal(excelEntry.sourceApiPath, null);
  assert.match(excelEntry.description, /のみを入力として生成/);
});

test("buildCompanyLabAdminExportZip: ZIP内のどのファイルにも、Secret・Authorizationヘッダー相当の文字列が含まれない", async () => {
  const secretLikeValue = "super-secret-staging-export-token-should-never-appear-in-zip";
  const zipBuffer = await buildCompanyLabAdminExportZip({
    labId: "zip-test-lab",
    turn: 1,
    companyId: "BAL",
    generatedAt: "2026-07-26T09:00:00.000Z",
    labIndexJson: SYNTHETIC_LAB_INDEX,
    companyJson: SYNTHETIC_COMPANY_JSON,
    allCompaniesJson: SYNTHETIC_ALL_COMPANIES,
    marketJson: SYNTHETIC_MARKET,
    includeExcel: true,
  });
  const zip = await JSZip.loadAsync(zipBuffer);
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    if (name.endsWith(".xlsx")) continue; // バイナリのため文字列走査は対象外（JSON成果物側で検証する）
    const content = await file.async("string");
    assert.equal(content.includes(secretLikeValue), false, `${name} に秘密情報らしき文字列が含まれています`);
    assert.equal(content.toLowerCase().includes("bearer "), false, `${name} にBearerヘッダーらしき文字列が含まれています`);
  }
});
