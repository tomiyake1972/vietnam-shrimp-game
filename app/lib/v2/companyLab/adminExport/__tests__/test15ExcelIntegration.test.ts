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
import { buildAllCompaniesExportPayload } from "../../../../../api/v2/exports/_lib/exportDto";
import { buildAllCompaniesExportExcelWorkbook } from "../companyLabAdminExcelBuilder";

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
