// ShrimpX V2 — Test15 管理用Excel（GM/全社スコープ）統合テスト
//
// 実際のCompanyLabState（initializeCompanyLab → advanceCompanyLabQuarterを複数回、
// 現実的な意思決定で進めたもの）から、実際のExport DTO（buildAllCompaniesExportPayload）
// を経由し、実際のExcel生成（buildAllCompaniesExportExcelWorkbook）まで通す。
// 合成データ（syntheticExportPayload.ts）を使うテストとは別に、「本物の状態から
// 実際に生成すると落ちない・実際の計算値と一致する」ことを確認するのが目的。
//
// シナリオ:
//   - BAL: 標準工場の新設案件（newFactoryConstruction）を提案（着工中を想定）
//   - JPQ: 既存工場を対象にPD省人化投資（pdMechanization）を提案（進行中）
//   - MASS: 当期VAP商品開発費を$250,000（4段階の1つ）で投資
//   - 残り2社は自動方針のまま（比較対照）

import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";
import { createCompanyLabRuntimeSnapshot } from "../../persistence/snapshot";
import { CompanyLabQuarterHistoryEntry } from "../../persistence/types";
import { CompanyDecisionInput, CompanyFixture, CompanyLabState } from "../../types";
import { buildAllCompaniesExportPayload, buildCompanyExportPayload } from "../../../../../api/v2/exports/_lib/exportDto";
import { buildAllCompaniesExportExcelWorkbook, buildCompanyExportExcelWorkbook } from "../companyLabAdminExcelBuilder";
import type { CompanyId } from "../../../sales/types";

const TEST_CONFIG = { scenarioId: "baseline" as const, mode: "canonical" as const, seed: "test15-excel-integration-001", turns: 10 };

function buildDecisionsForQuarter(
  state: CompanyLabState,
  fixtures: readonly CompanyFixture[],
  turnIndex: number,
): Record<string, CompanyDecisionInput> {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const ownState = buildCompanyOwnState(state, f);
    const auto = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
    decisions[f.companyId] = auto;
  }

  // 1ターン目にだけ、3社の意思決定へTest15の新規項目を注入する。
  if (turnIndex === 0) {
    const bal = fixtures.find((f) => f.companyId === "BAL")!;
    decisions["BAL"] = {
      ...decisions["BAL"],
      capexDecision: {
        ...decisions["BAL"].capexDecision,
        newProjectProposals: [...decisions["BAL"].capexDecision.newProjectProposals, { projectType: "newFactoryConstruction" }],
      },
    };

    const jpq = fixtures.find((f) => f.companyId === "JPQ")!;
    const targetFactoryId = jpq.factories[0].factoryId;
    decisions["JPQ"] = {
      ...decisions["JPQ"],
      capexDecision: {
        ...decisions["JPQ"].capexDecision,
        newProjectProposals: [...decisions["JPQ"].capexDecision.newProjectProposals, { projectType: "pdMechanization", targetFactoryId }],
      },
    };

    decisions["MASS"] = { ...decisions["MASS"], vapProductDevelopmentSpendUsd: 250_000 };
  } else {
    // 以後のターンも同じVAP投資水準を継続する（1回だけの投資で終わらせない）。
    decisions["MASS"] = { ...decisions["MASS"], vapProductDevelopmentSpendUsd: 250_000 };
  }

  return decisions;
}

function runQuarters(count: number): { readonly fixtures: readonly CompanyFixture[]; readonly entries: readonly CompanyLabQuarterHistoryEntry[] } {
  const { state: initialState, fixtures } = initializeCompanyLab(TEST_CONFIG);
  let state = initialState;
  const entries: CompanyLabQuarterHistoryEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (state.isComplete) break;
    const decisions = buildDecisionsForQuarter(state, fixtures, i);
    const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = nextState.history[nextState.history.length - 1];
    entries.push({
      turnId: `test15-excel-turn-${record.turn}`,
      turn: record.turn,
      period: record.period,
      engineVersion: "test-v2-companyLab-engine-test15-excel",
      schemaVersion: 1,
      preProcessingStateSnapshot: createCompanyLabRuntimeSnapshot(state),
      postProcessingStateSnapshot: createCompanyLabRuntimeSnapshot(nextState),
      playerSubmission: decisions[fixtures[0].companyId],
      otherCompaniesDecisions: fixtures.slice(1).map((f) => decisions[f.companyId]),
      record,
      processedAt: new Date().toISOString(),
    });
    state = nextState;
  }
  return { fixtures, entries };
}

test("Test15統合: 実際の複数四半期シミュレーション（新工場建設・PD省人化・VAP投資を含む）からExcelが例外なく生成される", async () => {
  const { fixtures, entries } = runQuarters(8);
  assert.ok(entries.length >= 8, "少なくとも8四半期は進行しているはず");
  const lastEntry = entries[entries.length - 1];

  const payload = buildAllCompaniesExportPayload({
    labId: "test15-excel-integration-lab",
    entry: lastEntry,
    companyIds: fixtures.map((f) => f.companyId),
    generatedAt: new Date().toISOString(),
    fixtures,
  });

  const buffer = await buildAllCompaniesExportExcelWorkbook(payload);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const sheetNames = wb.worksheets.map((ws) => ws.name);
  assert.ok(sheetNames.includes("生産・設備・労務"), "生産・設備・労務シートが存在する");
  assert.ok(sheetNames.includes("意思決定項目"), "意思決定項目シートが存在する");
  assert.ok(sheetNames.includes("StandardAI入力"), "StandardAI入力シートが存在する");
});

test("Test15統合: 生産・設備・労務シートのPD稼働率・実効PD係数が、実際の状態計算値と一致する（スポットチェック）", async () => {
  const { fixtures, entries } = runQuarters(8);
  const lastEntry = entries[entries.length - 1];
  const payload = buildAllCompaniesExportPayload({
    labId: "test15-excel-integration-lab",
    entry: lastEntry,
    companyIds: fixtures.map((f) => f.companyId),
    generatedAt: new Date().toISOString(),
    fixtures,
  });

  const jpqEntry = payload.companies.find((c) => c.companyId === "JPQ")!;
  const jpqFactoryId = fixtures.find((f) => f.companyId === "JPQ")!.factories[0].factoryId;
  const jpqPd = jpqEntry.processingCapacity?.pdMechanizationByFactory.find((p) => p.factoryId === jpqFactoryId);
  assert.ok(jpqPd, "JPQのPD省人化状況が存在する");

  const buffer = await buildAllCompaniesExportExcelWorkbook(payload);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet("生産・設備・労務")!;

  let found = false;
  ws.eachRow((row) => {
    if (row.getCell(1).value === "JPQ" && row.getCell(2).value === jpqFactoryId) {
      found = true;
      const utilCell = row.getCell(7).value;
      assert.equal(typeof utilCell === "number" ? utilCell : Number(utilCell), jpqPd!.previousQuarterPdUtilization);
    }
  });
  assert.ok(found, "シート内にJPQの当該工場の行が見つかる");

  // MASSのVAP商品開発費（意思決定項目シート）のスポットチェック。
  const decisionsWs = wb.getWorksheet("意思決定項目")!;
  let massVapFound = false;
  decisionsWs.eachRow((row) => {
    if (row.getCell(1).value === "MASS" && typeof row.getCell(2).value === "number") {
      massVapFound = true;
      assert.equal(row.getCell(2).value, 250_000);
    }
  });
  assert.ok(massVapFound, "MASSのVAP商品開発費の行が見つかる");
});

test("Test15統合: 監査専用情報の漏洩防止 — StandardAI入力シート/Standard AIの実際の入力型に、将来四半期・シナリオ真値・非公開ground truth系のフィールドが一切含まれない", async () => {
  const { fixtures, entries } = runQuarters(8);
  const lastEntry = entries[entries.length - 1];
  const payload = buildAllCompaniesExportPayload({
    labId: "test15-excel-integration-lab",
    entry: lastEntry,
    companyIds: fixtures.map((f) => f.companyId),
    generatedAt: new Date().toISOString(),
    fixtures,
  });

  // Standard AIの実際の入力（generateAutoPolicyDecisionへ渡した現物のownState/publicInfo）を
  // 独立に組み立て直し、そのJSON表現に禁止キーが含まれないことを確認する。
  // （このテストはExcelの文言だけでなく、実際にAIへ渡る値そのものを検査する）
  const forbiddenKeyPatterns = [
    /trueDemand/i,
    /groundTruth/i,
    /futureShock/i,
    /futureEvent/i,
    /nextQuarterShock/i,
    /scenarioSeed/i,
    /hiddenSeed/i,
    /trueScenario/i,
    /trueProbability/i,
    /answerKey/i,
  ];

  // ラボ生成時点のstateから、autoPolicyへ実際に渡る入力一式を再構成する。
  const { state: initialState, fixtures: initFixtures } = initializeCompanyLab(TEST_CONFIG);
  const publicInfo = buildPublicMarketInfo(initialState);
  const ownStates = initFixtures.map((f) => buildCompanyOwnState(initialState, f));

  const allKeys = new Set<string>();
  const collectKeys = (obj: unknown): void => {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      for (const v of obj) collectKeys(v);
      return;
    }
    if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        allKeys.add(k);
        collectKeys(v);
      }
    }
  };
  collectKeys(publicInfo);
  for (const os of ownStates) collectKeys(os);

  for (const key of allKeys) {
    for (const pattern of forbiddenKeyPatterns) {
      assert.ok(!pattern.test(key), `Standard AIへの実際の入力（PublicMarketInfo/CompanyOwnState）に禁止キー"${key}"が含まれてはならない`);
    }
  }

  // StandardAI入力シート自体の文字列表現にも同じ禁止パターンが出現しないことを確認する
  // （このシートが監査専用情報のUI上のリーク経路になっていないことの確認）。
  const buffer = await buildAllCompaniesExportExcelWorkbook(payload);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet("StandardAI入力")!;
  const cellTexts: string[] = [];
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      if (typeof cell.value === "string") cellTexts.push(cell.value);
    });
  });
  const joined = cellTexts.join("\n");
  for (const pattern of forbiddenKeyPatterns) {
    assert.ok(!pattern.test(joined), `StandardAI入力シートの文言に禁止パターン ${pattern} が出現してはならない`);
  }
});

// =====================================================================
// 【Test15】Company Lab画面からのExcelダウンロード機能の追加テスト
//
// 実際の複数四半期シミュレーションから、自社ブック（16シート）・業界比較ブック（10シート）を
// 生成し、生成物を読み直して検証する。実行が重いため、シミュレーションは
// buildOnce() で1回だけ回して全テストで使い回す（既存テストと同じ方針）。
// =====================================================================

const EXPECTED_COMPANY_SHEETS = [
  "Meta", "PL", "製造原価計算書", "BS", "CF", "Financing", "Capex", "Company Summary",
  "Processing Capacity", "Sales Contracts", "生データ_成約明細", "販売数量分析",
  "Sales Detail", "Market", "Decisions", "推移サマリー",
] as const;

const EXPECTED_INDUSTRY_SHEETS = [
  "00_凡例", "01_全社比較", "02_市場シェア", "03_全社の意思決定", "04_Turn推移",
  "Meta", "生産・設備・労務", "意思決定項目", "StandardAI入力",
] as const;

let cachedRun: ReturnType<typeof runQuarters> | null = null;
function sharedRun(): ReturnType<typeof runQuarters> {
  if (!cachedRun) cachedRun = runQuarters(8);
  return cachedRun;
}

function buildCompanyPayloadFor(entry: CompanyLabQuarterHistoryEntry, fixtures: readonly CompanyFixture[], companyId: string) {
  return buildCompanyExportPayload({
    labId: "test15-excel-integration-lab",
    companyId: companyId as CompanyId,
    entry,
    generatedAt: new Date().toISOString(),
    fixtures,
  });
}

function buildAllPayloadFor(entry: CompanyLabQuarterHistoryEntry, fixtures: readonly CompanyFixture[]) {
  return buildAllCompaniesExportPayload({
    labId: "test15-excel-integration-lab",
    entry,
    companyIds: fixtures.map((f) => f.companyId),
    generatedAt: new Date().toISOString(),
    fixtures,
  });
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

function cellText(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const v = ws.getRow(row).getCell(col).value as unknown;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && v !== null && "formula" in (v as Record<string, unknown>)) return `=${(v as { formula: string }).formula}`;
  return String(v);
}

function findRowByLabel(ws: ExcelJS.Worksheet, label: string): number | null {
  for (let r = 1; r <= ws.rowCount; r++) {
    if (cellText(ws, r, 1).startsWith(label)) return r;
  }
  return null;
}

test("Test15 Excel: 自社データブックが生成でき、再読込でき、期待16シートがすべて存在する", async () => {
  const { fixtures, entries } = sharedRun();
  const lastEntry = entries[entries.length - 1];
  const payload = buildCompanyPayloadFor(lastEntry, fixtures, "BAL");
  const history = entries.map((e) => ({
    turn: e.turn,
    period: String(e.period),
    payload: buildCompanyPayloadFor(e, fixtures, "BAL"),
  }));

  const buffer = await buildCompanyExportExcelWorkbook(payload, history);
  const wb = await loadWorkbook(buffer);
  const names = wb.worksheets.map((ws) => ws.name);
  for (const expected of EXPECTED_COMPANY_SHEETS) {
    assert.ok(names.includes(expected), `自社ブックに「${expected}」シートが存在するはず（実際: ${names.join(", ")}）`);
  }
  assert.equal(EXPECTED_COMPANY_SHEETS.length, 16, "自社ブックの期待シート数は16");
});

test("Test15 Excel: 業界比較ブックが生成でき、参考4シート＋Turn推移＋既存5シートの計10シートが存在する", async () => {
  const { fixtures, entries } = sharedRun();
  const lastEntry = entries[entries.length - 1];
  const payload = buildAllPayloadFor(lastEntry, fixtures);
  const history = entries.map((e) => ({ turn: e.turn, period: String(e.period), payload: buildAllPayloadFor(e, fixtures) }));

  const buffer = await buildAllCompaniesExportExcelWorkbook(payload, history);
  const wb = await loadWorkbook(buffer);
  const names = wb.worksheets.map((ws) => ws.name);
  for (const expected of EXPECTED_INDUSTRY_SHEETS) {
    assert.ok(names.includes(expected), `業界比較ブックに「${expected}」シートが存在するはず（実際: ${names.join(", ")}）`);
  }
  // Capacity_<会社ID> が5社ぶん出る（既存5シートのうちの1つ）。
  const capacitySheets = names.filter((n) => n.startsWith("Capacity_"));
  assert.equal(capacitySheets.length, fixtures.length, "会社数ぶんのCapacityシートが出る");
  assert.equal(names.length, EXPECTED_INDUSTRY_SHEETS.length + fixtures.length, "参考4＋Turn推移1＋既存（Meta/生産・設備・労務/意思決定項目/StandardAI入力）4＋Capacity5＝合計10相当");
});

test("Test15 Excel: MetaのlabId・turn・companyIdが指定どおりで、他社の非公開情報が自社ブックに混入しない", async () => {
  const { fixtures, entries } = sharedRun();
  const lastEntry = entries[entries.length - 1];
  const payload = buildCompanyPayloadFor(lastEntry, fixtures, "BAL");
  const buffer = await buildCompanyExportExcelWorkbook(payload, []);
  const wb = await loadWorkbook(buffer);

  const meta = wb.getWorksheet("Meta")!;
  const labRow = findRowByLabel(meta, "labId");
  assert.ok(labRow, "MetaにlabId行がある");
  assert.equal(cellText(meta, labRow!, 2), "test15-excel-integration-lab");
  const turnRow = findRowByLabel(meta, "turn");
  assert.equal(cellText(meta, turnRow!, 2), String(lastEntry.turn));
  const scopeRow = findRowByLabel(meta, "scope");
  assert.ok(cellText(meta, scopeRow!, 2).includes("BAL"), "scopeが対象会社BALである");

  // 自社ブックのどのシートにも他社IDが現れないこと（スコープ隔離の回帰テスト）。
  // 会社ID "VAP" だけは商品区分名のVAP（VAP商品開発・VAP生産量等）と綴りが完全に衝突し、
  // 単純な文字列走査では商品名を他社IDとして誤検知する。会社スコープの隔離は
  // CompanyExportPayload / AllCompaniesExportPayload という別型で構造的に保証されており
  // （会社別ブック側から全社ペイロードへ到達できない）、このテキスト走査はその補助的な
  // 二重確認にすぎないため、衝突するIDだけを対象外にする。
  const otherCompanyIds = fixtures
    .map((f) => f.companyId)
    .filter((id) => id !== "BAL" && id !== "VAP");
  for (const ws of wb.worksheets) {
    for (let r = 1; r <= ws.rowCount; r++) {
      for (let c = 1; c <= Math.min(ws.columnCount, 20); c++) {
        const text = cellText(ws, r, c);
        for (const other of otherCompanyIds) {
          assert.ok(!text.split(/\W/).includes(other), `自社ブックのシート「${ws.name}」(${r},${c})に他社ID「${other}」が混入している: ${text}`);
        }
      }
    }
  }
});

test("Test15 Excel: 業界比較ブックの01_全社比較に5社ぶんの列が出て、値がExport payloadと一致する", async () => {
  const { fixtures, entries } = sharedRun();
  const lastEntry = entries[entries.length - 1];
  const payload = buildAllPayloadFor(lastEntry, fixtures);
  const buffer = await buildAllCompaniesExportExcelWorkbook(payload, []);
  const wb = await loadWorkbook(buffer);
  const ws = wb.getWorksheet("01_全社比較")!;

  const headerRow = findRowByLabel(ws, "指標");
  assert.ok(headerRow, "ヘッダー行がある");
  const sortedIds = [...payload.companies].map((c) => c.companyId).sort();
  for (const [i, id] of sortedIds.entries()) {
    assert.equal(cellText(ws, headerRow!, i + 2), id, `${i + 1}列目の会社IDが一致する`);
  }
  assert.equal(sortedIds.length, 5, "5社比較が5社ぶん出る");

  // 純売上高の値がpayloadと一致する（数値の突合）。
  const netRevenueRow = findRowByLabel(ws, "純売上高");
  assert.ok(netRevenueRow, "純売上高行がある");
  for (const [i, id] of sortedIds.entries()) {
    const expected = payload.companies.find((c) => c.companyId === id)!.financialResult?.profitAndLoss.netRevenue;
    const actual: unknown = ws.getRow(netRevenueRow!).getCell(i + 2).value;
    if (expected === undefined || expected === null) {
      assert.equal(actual, "－", "値が無いセルは0ではなく「－」");
    } else {
      assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-6, `${id}の純売上高がpayloadと一致する`);
    }
  }
});

test("Test15 Excel: 推移サマリー・04_Turn推移のTurn列が昇順に並ぶ", async () => {
  const { fixtures, entries } = sharedRun();
  const lastEntry = entries[entries.length - 1];

  const companyHistory = entries.map((e) => ({ turn: e.turn, period: String(e.period), payload: buildCompanyPayloadFor(e, fixtures, "BAL") }));
  const companyWb = await loadWorkbook(await buildCompanyExportExcelWorkbook(buildCompanyPayloadFor(lastEntry, fixtures, "BAL"), companyHistory));
  const trend = companyWb.getWorksheet("推移サマリー")!;
  const trendHeader = findRowByLabel(trend, "指標")!;
  const companyTurns: number[] = [];
  for (let c = 2; c <= trend.columnCount; c++) {
    const m = /^Turn (\d+)$/.exec(cellText(trend, trendHeader, c));
    if (m) companyTurns.push(Number(m[1]));
  }
  assert.ok(companyTurns.length >= 2, "複数Turnが並ぶ");
  assert.deepEqual(companyTurns, [...companyTurns].sort((a, b) => a - b), "推移サマリーのTurn列が昇順");

  const allHistory = entries.map((e) => ({ turn: e.turn, period: String(e.period), payload: buildAllPayloadFor(e, fixtures) }));
  const gmWb = await loadWorkbook(await buildAllCompaniesExportExcelWorkbook(buildAllPayloadFor(lastEntry, fixtures), allHistory));
  const gmTrend = gmWb.getWorksheet("04_Turn推移")!;
  const gmHeader = findRowByLabel(gmTrend, "指標")!;
  const gmTurns: number[] = [];
  for (let c = 3; c <= gmTrend.columnCount; c++) {
    const m = /^Turn (\d+)$/.exec(cellText(gmTrend, gmHeader, c));
    if (m) gmTurns.push(Number(m[1]));
  }
  assert.deepEqual(gmTurns, [...gmTurns].sort((a, b) => a - b), "04_Turn推移のTurn列が昇順");
});

test("Test15 Excel: 製造原価計算書のkg単価 = 製造原価合計 ÷ 製造数量kg であり、生産数量0でもNaN/Infinityにならない", async () => {
  const { fixtures, entries } = sharedRun();
  const lastEntry = entries[entries.length - 1];
  const payload = buildCompanyPayloadFor(lastEntry, fixtures, "BAL");
  const buffer = await buildCompanyExportExcelWorkbook(payload, []);
  const wb = await loadWorkbook(buffer);
  const ws = wb.getWorksheet("製造原価計算書")!;

  const qtyRow = findRowByLabel(ws, "生産数量")!;
  const totalRow = findRowByLabel(ws, "商品別 製造原価合計")!;
  const unitRow = findRowByLabel(ws, "　うち kgあたり製造原価")!;

  for (const col of [2, 3, 4]) {
    const qty = Number(ws.getRow(qtyRow).getCell(col).value ?? 0);
    const unitCell = ws.getRow(unitRow).getCell(col).value;
    if (qty <= 0) {
      assert.equal(typeof unitCell, "string", "生産数量0の商品のkg単価は文字列（「－」）である");
      continue;
    }
    assert.equal(typeof unitCell, "number", "生産数量>0の商品のkg単価は数値である");
    const unit = unitCell as number;
    assert.ok(Number.isFinite(unit), "kg単価が有限（NaN/Infinityでない）");
    // 合計行はExcel数式なので、期待値はpayloadから独立に再計算して突合する。
    const totalFormula = ws.getRow(totalRow).getCell(col).value;
    assert.ok(typeof totalFormula === "object" && totalFormula !== null, "製造原価合計はExcel数式である");
    // kg単価 × 数量kg が、加工費+ユーティリティ+直接固定費の合計と一致すること。
    const mc = payload.financialResult!.manufacturingCost;
    const summary = payload.companySummary!;
    const produced = [summary.hosoProduced, summary.pdProduced, summary.vapProduced];
    const totalProduced = produced.reduce((s, v) => s + v, 0);
    const idx = col - 2;
    const base = totalProduced > 0 ? (mc.hosoProcessingCost * produced[idx]) / totalProduced : 0;
    const additional = idx === 1 ? mc.pdAdditionalProcessingCost : idx === 2 ? mc.vapAdditionalProcessingCost : 0;
    const utility = totalProduced > 0 ? (mc.utilityVariableCost * produced[idx]) / totalProduced : 0;
    const key = ["hoso", "pd", "vap"][idx];
    const directFixed = payload.financialResult!.contributionMargin.byProduct.find((d) => d.key === key)?.directFixedCost ?? 0;
    const expectedTotal = base + additional + utility + directFixed;
    assert.ok(Math.abs(unit * qty * 1000 - expectedTotal) < 1e-3, `kg単価×数量kgが製造原価合計と一致する（${key}）`);
  }
});

test("Test15 Excel: 同一payloadから2回生成すると、シート名・セル内容が完全に一致する（決定論性）", async () => {
  const { fixtures, entries } = sharedRun();
  const lastEntry = entries[entries.length - 1];
  const payload = buildCompanyPayloadFor(lastEntry, fixtures, "BAL");

  const wbA = await loadWorkbook(await buildCompanyExportExcelWorkbook(payload, []));
  const wbB = await loadWorkbook(await buildCompanyExportExcelWorkbook(payload, []));
  assert.deepEqual(
    wbA.worksheets.map((w) => w.name),
    wbB.worksheets.map((w) => w.name),
    "シート名が一致する"
  );
  for (const wsA of wbA.worksheets) {
    const wsB = wbB.getWorksheet(wsA.name)!;
    assert.equal(wsA.rowCount, wsB.rowCount, `シート「${wsA.name}」の行数が一致する`);
    for (let r = 1; r <= wsA.rowCount; r++) {
      for (let c = 1; c <= Math.min(wsA.columnCount, 16); c++) {
        assert.equal(cellText(wsA, r, c), cellText(wsB, r, c), `シート「${wsA.name}」(${r},${c})の内容が一致する`);
      }
    }
  }
});

test("Test15 Excel: 財務結果がnullのペイロードでも例外を投げず、シート構成を保ったまま生成できる（Excel生成失敗がゲーム進行を壊さない）", async () => {
  const { fixtures, entries } = sharedRun();
  const lastEntry = entries[entries.length - 1];
  const base = buildCompanyPayloadFor(lastEntry, fixtures, "BAL");
  // 財務結果・会社サマリーが欠けた状態を人工的に作る（データ未作成のturnを想定）。
  const degraded = { ...base, financialResult: null, companySummary: null, processingCapacity: null };

  const buffer = await buildCompanyExportExcelWorkbook(degraded, []);
  const wb = await loadWorkbook(buffer);
  const names = wb.worksheets.map((ws) => ws.name);
  for (const expected of EXPECTED_COMPANY_SHEETS) {
    assert.ok(names.includes(expected), `欠損時でも「${expected}」シートは存在する`);
  }
  const mcSheet = wb.getWorksheet("製造原価計算書")!;
  assert.ok(cellText(mcSheet, 1, 1).includes("存在しない"), "製造原価計算書には欠損である旨が書かれる（0で埋めない）");
});

test("Test15 Excel: 販売数量分析のSUMIFSが生データ_成約明細シートを正しく参照している", async () => {
  const { fixtures, entries } = sharedRun();
  const lastEntry = entries[entries.length - 1];
  const payload = buildCompanyPayloadFor(lastEntry, fixtures, "BAL");
  const wb = await loadWorkbook(await buildCompanyExportExcelWorkbook(payload, []));
  const ws = wb.getWorksheet("販売数量分析")!;

  let sumifsCount = 0;
  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 2; c <= 4; c++) {
      const text = cellText(ws, r, c);
      if (text.startsWith("=SUMIFS(")) {
        assert.ok(text.includes("生データ_成約明細"), "SUMIFSが生データ_成約明細シートを参照している");
        sumifsCount += 1;
      }
    }
  }
  assert.ok(sumifsCount > 0, "SUMIFS数式が少なくとも1件ある");
});
