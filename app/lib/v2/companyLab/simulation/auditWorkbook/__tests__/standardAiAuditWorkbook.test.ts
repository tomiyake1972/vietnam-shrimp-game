// ShrimpX V2 — Standard AI 32Q Audit Workbook のテスト（実装指示§37 SAI-AUDIT-XLSX-1〜18）
//
// 生成AIも実APIも呼ばない。実際に32Qのシミュレーションを回し、その保存済みRunから
// Workbookを組み立てて中身を検証する（fixtureで作った偽データではなく実データ）。

import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { advanceSimulationTurns, createSimulationSession } from "../../engine";
import { buildDatasetFromSession } from "../../analytics/dataset";
import { buildResumePayload } from "../../persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRun } from "../../persistence/types";
import { buildStandardAiAuditExport, buildStandardAiAuditWorkbookData, standardAiAuditWorkbookFileName, AUDIT_DATA_DICTIONARY } from "../index";
import { CompanyQuarterRecord } from "../../../types";

const AT = "2026-08-18T00:00:00.000Z";
const EXPECTED_COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;

interface Built {
  readonly stored: StoredSimulationRun;
  readonly liveHistory: readonly CompanyQuarterRecord[];
}

/** 32Qを1回だけ実行し、以降のテストで使い回す（同じ実行を何度も回さない）。 */
let cached32Q: Built | null = null;
function build(turns: number): Built {
  if (turns === 32 && cached32Q) return cached32Q;
  let session = createSimulationSession({
    simulationRunId: `audit-test-${turns}q`,
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: turns,
    startedAt: AT,
  });
  session = advanceSimulationTurns({ session, turns, timestamp: AT });
  const built: Built = {
    stored: {
      schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
      run: session.run,
      dataset: buildDatasetFromSession(session),
      packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
      resumePayload: buildResumePayload(session, {}, {}),
      savedAt: AT,
    },
    liveHistory: session.state.history,
  };
  if (turns === 32) cached32Q = built;
  return built;
}

function data(turns = 32) {
  const built = build(turns);
  return buildStandardAiAuditWorkbookData({ stored: built.stored, generatedAt: AT, liveHistory: built.liveHistory });
}

test("SAI-AUDIT-XLSX-1: 32Qのfull workbookが生成でき、全19シートが揃っている", async () => {
  const built = build(32);
  const exported = await buildStandardAiAuditExport({ stored: built.stored, generatedAt: AT, liveHistory: built.liveHistory });
  assert.ok(exported.bytes > 0, "workbookが空である");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.workbook);
  const names = workbook.worksheets.map((s) => s.name);
  for (const expected of [
    "00_README",
    "01_RUN_SUMMARY",
    "02_COMPANY_SUMMARY",
    "03_TURN_KPI",
    "04_STANDARD_AI_DECISIONS",
    "05_DECISION_DIAGNOSTICS",
    "06_SALES_DETAIL",
    "07_PRODUCTION_DETAIL",
    "08_PROCUREMENT_DETAIL",
    "09_WORKFORCE_DETAIL",
    "10_CAPEX_DETAIL",
    "11_FINANCE_DETAIL",
    "12_BACKLOG_DETAIL",
    "13_MARKET_DETAIL",
    "14_DIVIDEND_DETAIL",
    "15_FACTORY_CAPACITY",
    "16_FINAL_RESULTS",
    "17_DATA_DICTIONARY",
    "18_EVENT_LOG",
    "19_AI_PROFILE_VISION",
  ]) {
    assert.ok(names.includes(expected), `${expected} シートが無い（実際: ${names.join(", ")}）`);
  }
});

test("SAI-AUDIT-XLSX-2: 5社（BAL/MASS/JPQ/VAP/CONSV）がすべて含まれる", () => {
  const d = data();
  for (const companyId of EXPECTED_COMPANIES) {
    assert.ok(d.meta.companyIds.includes(companyId), `${companyId} が meta に無い`);
    assert.ok(d.companySummary.some((r) => r.companyId === companyId), `${companyId} が 02_COMPANY_SUMMARY に無い`);
    assert.ok(d.turnKpi.some((r) => r.companyId === companyId), `${companyId} が 03_TURN_KPI に無い`);
  }
});

test("SAI-AUDIT-XLSX-3: 03_TURN_KPI が 5社 × 32Turn = 160行になる", () => {
  const d = data();
  assert.equal(d.turnKpi.length, 160);
  for (const companyId of EXPECTED_COMPANIES) {
    const turns = d.turnKpi.filter((r) => r.companyId === companyId).map((r) => r.turn).sort((a, b) => a - b);
    assert.deepEqual(turns, Array.from({ length: 32 }, (_, i) => i + 1), `${companyId} のTurnが1〜32で揃っていない`);
  }
});

test("SAI-AUDIT-XLSX-4: Standard AIの意思決定が全ドメインぶん出力される", () => {
  const d = data();
  assert.ok(d.decisions.length > 0);
  const domains = new Set(d.decisions.map((r) => r.decisionDomain));
  for (const domain of ["SALES", "PRODUCTION", "PROCUREMENT", "WORKFORCE", "FINANCE", "DIVIDEND"]) {
    assert.ok(domains.has(domain as never), `decisionDomain=${domain} の行が無い`);
  }
  // 全社・全Turnで最低1件は意思決定行がある。
  for (const companyId of EXPECTED_COMPANIES) {
    for (const turn of [1, 16, 32]) {
      assert.ok(d.decisions.some((r) => r.companyId === companyId && r.turn === turn), `${companyId} turn${turn} の意思決定行が無い`);
    }
  }
});

test("SAI-AUDIT-XLSX-5: reasonCode が診断シートへ出力される（severity付き）", () => {
  const d = data();
  const withCode = d.diagnostics.filter((r) => r.reasonCode !== "");
  assert.ok(withCode.length > 0, "reasonCode を持つ診断行が1件も無い");
  assert.ok(new Set(withCode.map((r) => r.reasonCode)).size >= 20, "reasonCode の種類が少なすぎる（診断が失われている疑い）");
  assert.ok(withCode.some((r) => ["info", "warning", "critical"].includes(r.severity)), "severity が復元できていない");
  // AIの診断とEngineの実績は必ず別sourceとして区別できる。
  const sources = new Set(d.diagnostics.map((r) => r.source));
  assert.ok(sources.has("STANDARD_AI_TRACE"), "STANDARD_AI_TRACE の行が無い");
});

test("SAI-AUDIT-XLSX-6: proposal と actual が別カラムとして保持される", () => {
  const d = data();
  const salesPlans = d.decisions.filter((r) => r.decisionType === "SALES_PLAN_BY_MARKET_PRODUCT");
  assert.ok(salesPlans.length > 0);
  // 「提案 != 実績」が実際に発生している行が存在する（構造だけでなく意味的に分離している）。
  assert.ok(
    salesPlans.some((r) => r.proposedValue !== null && r.actualAppliedValue !== null && Math.abs(r.proposedValue - r.actualAppliedValue) > 1),
    "提案量と成約量が1件も乖離していない（proposal/actualが同じ値を書いている疑い）"
  );
  assert.ok(salesPlans.some((r) => r.wasModified === "TRUE"), "wasModified=TRUE の行が無い");
});

test("SAI-AUDIT-XLSX-7: P&L の値がエンジンの確定値に一致する（Excel側で作らない）", () => {
  const built = build(32);
  const d = data();
  const record = built.liveHistory.find((r) => r.turn === 20);
  assert.ok(record, "turn20 の確定記録が無い");
  for (const companyId of EXPECTED_COMPANIES) {
    const fin: (typeof record.financialResults)[number] | undefined = record!.financialResults.find((f) => f.companyId === companyId);
    const row = d.finance.find((r) => r.companyId === companyId && r.turn === 20);
    assert.ok(fin && row, `${companyId} turn20 の財務行が無い`);
    assert.equal(row!.netRevenueUsd, Number(fin!.profitAndLoss.netRevenue));
    assert.equal(row!.operatingProfitUsd, Number(fin!.profitAndLoss.operatingProfit));
    assert.equal(row!.netIncomeUsd, Number(fin!.profitAndLoss.netIncome));
    assert.equal(row!.operatingCashFlowUsd, Number(fin!.cashFlow.operatingCashFlow));
    // interest-bearing debt と totalLiabilities を取り違えていない。
    const kpi = d.turnKpi.find((r) => r.companyId === companyId && r.turn === 20);
    assert.equal(kpi!.totalLiabilitiesUsd, Number(fin!.balanceSheet.totalLiabilities));
  }
});

test("SAI-AUDIT-XLSX-8: backlog が dueStatus で分離され、overdue と混同されない", () => {
  const d = data();
  for (const row of d.backlog) {
    assert.ok(["OVERDUE", "DUE_THIS_TURN", "FUTURE_DUE"].includes(row.dueStatus));
    assert.ok((row.outstandingHosoEqTons ?? 0) > 0, "残高0の行を出力してはいけない");
    assert.ok(row.contractCount > 0);
  }
  // 03_TURN_KPI 側でも backlog と overdue が別カラムであり、healthy forward が導出できる。
  const kpi = d.turnKpi.find((r) => r.totalBacklogHosoEqTons !== null && r.overdueBacklogHosoEqTons !== null);
  assert.ok(kpi, "backlog/overdue が両方揃った行が無い");
  assert.equal(kpi!.healthyForwardBacklogHosoEqTons, Math.max(0, (kpi!.totalBacklogHosoEqTons ?? 0) - (kpi!.overdueBacklogHosoEqTons ?? 0)));
});

test("SAI-AUDIT-XLSX-9: CAPEX 案件が projectType つきで出力される", () => {
  const d = data();
  assert.ok(d.capex.length > 0, "CAPEX案件が1件も無い");
  for (const row of d.capex) {
    assert.ok(row.projectId !== "", "projectId が空");
    assert.ok(row.projectType !== "", "projectType が空");
    assert.ok(EXPECTED_COMPANIES.includes(row.companyId as never), `未知の companyId: ${row.companyId}`);
  }
  // enum をそのまま出す（勝手なラベルへ変換しない）。
  const knownTypes = new Set([
    "hosoLineExpansion",
    "pdLineExpansion",
    "vapLineExpansion",
    "coldStorageExpansion",
    "qualityControlEquipment",
    "environmentalEquipment",
    "commonProcessingExpansion",
    "freezingPackagingExpansion",
    "newFactoryConstruction",
    "pdMechanization",
  ]);
  for (const row of d.capex) assert.ok(knownTypes.has(row.projectType), `未知の projectType: ${row.projectType}`);
});

test("SAI-AUDIT-XLSX-10: DIV-4 の配当診断が出力される（年1回・flow基準が追える）", () => {
  const d = data();
  assert.equal(d.dividend.length, 160, "会社×Turnの配当行が揃っていない");
  const q4Rows = d.dividend.filter((r) => r.isAnnualEvaluationPeriod === "TRUE");
  assert.equal(q4Rows.length, 5 * 8, "Q4行が5社×8年度ぶん無い");
  // 実際に配当された行では、当期純利益（flow）が基準として記録されている。
  const paid = d.dividend.filter((r) => (r.appliedDividendUsd ?? 0) > 0);
  assert.ok(paid.length > 0, "配当が1件も出力されていない");
  for (const row of paid) {
    assert.equal(row.isAnnualEvaluationPeriod, "TRUE", "Q4以外で配当が記録されている");
    assert.ok(row.netIncomeUsd !== null, "配当行に当期純利益（算定base）が無い");
    assert.ok(row.effectivePayoutRatio !== null, "effectivePayoutRatio が無い");
    assert.ok(row.maxDividendUsd !== null, "maxDividendUsd が無い");
  }
});

test("SAI-AUDIT-XLSX-11: 最終 TSV が evaluation service の値と一致する", async () => {
  const d = data();
  const { computeAllCompaniesEvaluationSnapshot } = await import("../../../evaluation/evaluationSemantics");
  const expected = computeAllCompaniesEvaluationSnapshot(build(32).liveHistory, EXPECTED_COMPANIES as never, 32);
  assert.equal(d.finalResults.length, 5);
  for (const snapshot of expected) {
    const row = d.finalResults.find((r) => r.companyId === snapshot.companyId);
    assert.ok(row, `${snapshot.companyId} の最終結果が無い`);
    assert.equal(row!.totalShareholderValueUsd, snapshot.totalShareholderValueUsd);
    assert.equal(row!.currentCompanyValueUsd, snapshot.currentCompanyValue.currentCompanyValueUsd);
    assert.equal(row!.currentDividendValueUsd, snapshot.currentDividendValueUsd);
    assert.equal(row!.shareholderValueModelVersion, "tsv-dcf-v1");
  }
  // rank は TSV 降順。
  const ranked = [...d.finalResults].filter((r) => r.rank !== null).sort((a, b) => (a.rank as number) - (b.rank as number));
  for (let i = 1; i < ranked.length; i++) {
    assert.ok((ranked[i - 1].totalShareholderValueUsd ?? -Infinity) >= (ranked[i].totalShareholderValueUsd ?? -Infinity), "rank が TSV 降順になっていない");
  }
});

test("SAI-AUDIT-XLSX-12: Data Dictionary が存在し、単位と出所が書かれている", () => {
  assert.ok(AUDIT_DATA_DICTIONARY.length > 0);
  for (const entry of AUDIT_DATA_DICTIONARY) {
    assert.ok(entry.sheetName !== "" && entry.fieldName !== "");
    assert.ok(entry.unit !== "", `${entry.fieldName} に unit が無い`);
    assert.ok(entry.source !== "", `${entry.fieldName} に source が無い`);
    assert.ok(entry.description !== "", `${entry.fieldName} に description が無い`);
  }
  // AIが誤読しやすい区別が明記されている。
  const notes = AUDIT_DATA_DICTIONARY.map((entry) => entry.semanticNotes).join(" ");
  assert.match(notes, /Not equivalent to overdue/);
  assert.match(notes, /interest-bearing debt/);
  assert.match(notes, /Different metric from laborUtilizationRatio/);
});

test("SAI-AUDIT-XLSX-13: README が存在し、重要な意味論とAI向け指示を含む", async () => {
  const built = build(32);
  const exported = await buildStandardAiAuditExport({ stored: built.stored, generatedAt: AT, liveHistory: built.liveHistory });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.workbook);
  const readme = workbook.getWorksheet("00_README");
  assert.ok(readme, "00_README が無い");
  const text: string[] = [];
  readme!.eachRow((row) => row.eachCell((cell) => text.push(String(cell.value ?? ""))));
  const joined = text.join("\n");
  assert.match(joined, /One Turn = one quarter/);
  assert.match(joined, /Backlog is NOT overdue/);
  assert.match(joined, /Use source fields directly/);
  assert.match(joined, /Do not infer missing values/);
  assert.match(joined, /A blank cell means unavailable or not applicable/);
  for (const companyId of EXPECTED_COMPANIES) assert.ok(joined.includes(companyId), `README に ${companyId} が無い`);
});

test("SAI-AUDIT-XLSX-14: legacy run（packCapture・resumePayload無し）でも失敗せず、欠損を明示する", async () => {
  const built = build(4);
  const legacy: StoredSimulationRun = { schemaVersion: 1, run: built.stored.run, dataset: built.stored.dataset, savedAt: AT };
  const d = buildStandardAiAuditWorkbookData({ stored: legacy, generatedAt: AT });
  assert.ok(d.meta.missingDataNotes.length > 0, "欠損の申告が無い");
  assert.ok(d.meta.missingDataNotes.some((n) => n.includes("packCapture")), "packCapture の欠損が申告されていない");
  // それでも dataset 由来のKPIは出る（exportそのものは失敗しない）。
  assert.equal(d.turnKpi.length, 5 * 4);
  assert.equal(d.profileVision.length, 0, "packCapture が無いのに Vision 行が作られている（捏造）");
  // packCapture が無くても、dataset.investmentTrace から CAPEX 案件だけは復元できる
  // （degradeであって捏造ではない。projectId/projectType は engine の記録そのもの）。
  for (const row of d.capex) {
    assert.ok(row.projectId !== "" && row.projectType !== "");
    assert.equal(row.targetFactoryId, "", "packCapture が無いのに対象工場が埋まっている（捏造）");
  }
  // Excel生成まで到達する。
  const exported = await buildStandardAiAuditExport({ stored: legacy, generatedAt: AT });
  assert.ok(exported.bytes > 0);
});

test("SAI-AUDIT-XLSX-15: 途中Turnのexportは PARTIAL としてファイル名・statusに現れる", () => {
  const built = build(32);
  const d = buildStandardAiAuditWorkbookData({ stored: built.stored, generatedAt: AT, liveHistory: built.liveHistory, asOfTurn: 18 });
  assert.equal(d.meta.status, "PARTIAL");
  assert.equal(d.meta.asOfTurn, 18);
  assert.equal(d.turnKpi.length, 5 * 18);
  assert.ok(d.turnKpi.every((r) => r.turn <= 18), "asOfTurn より後のTurnが混ざっている");
  assert.equal(standardAiAuditWorkbookFileName("run-x", 18, "PARTIAL"), "ShrimpX_StandardAI_Audit_run-x_Turn18_PARTIAL.xlsx");
  assert.equal(standardAiAuditWorkbookFileName("run-x", 32, "COMPLETE"), "ShrimpX_StandardAI_Audit_run-x_32Q.xlsx");
});

test("SAI-AUDIT-XLSX-16: Player 側の画面・モジュールから全社監査Workbookへ到達できない", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  // Player Workspace 系のファイルが audit workbook を import していないこと。
  const playerDir = path.join(process.cwd(), "app/v2/management/player");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && fs.readFileSync(full, "utf8").includes("auditWorkbook")) offenders.push(full);
    }
  };
  walk(playerDir);
  assert.deepEqual(offenders, [], `Player側から監査Workbookを参照している: ${offenders.join(", ")}`);
  // company-lab の PLAYER ルートも同様。
  const labOffenders: string[] = [];
  const labDir = path.join(process.cwd(), "app/v2/company-lab");
  const walkLab = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkLab(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && fs.readFileSync(full, "utf8").includes("auditWorkbook")) labOffenders.push(full);
    }
  };
  walkLab(labDir);
  assert.deepEqual(labOffenders, [], `Company Lab PLAYER 経路から監査Workbookを参照している: ${labOffenders.join(", ")}`);
});

test("SAI-AUDIT-XLSX-17: Management Console から Standard AI 監査Excelをダウンロードできる導線がある", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const console_ = fs.readFileSync(path.join(process.cwd(), "app/v2/management/components/ManagementConsole.tsx"), "utf8");
  assert.match(console_, /StandardAiAuditWorkbookButton/, "Management Console にボタンが配置されていない");
  const button = fs.readFileSync(path.join(process.cwd(), "app/v2/management/components/StandardAiAuditWorkbookButton.tsx"), "utf8");
  assert.match(button, /Standard AI分析Excel/, "ボタン文言が指示どおりでない");
  assert.match(button, /5社×32TurnのStandard AI判断ログと業績推移をAI分析向け形式で出力します/, "説明文が指示どおりでない");
  assert.match(button, /export-standard-ai-audit/, "testIdが無い");
  // 既存のAI Analysis Pack導線を壊していない。
  assert.match(console_, /ExportPackButton/, "既存の AI Analysis Pack ボタンが消えている");
});

test("SAI-AUDIT-XLSX-18: 生成した .xlsx が実際に開け、各シートが単一ヘッダー行＋データ行になっている", async () => {
  const built = build(32);
  const exported = await buildStandardAiAuditExport({ stored: built.stored, generatedAt: AT, liveHistory: built.liveHistory });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.workbook);
  for (const sheet of workbook.worksheets) {
    assert.ok(sheet.rowCount >= 1, `${sheet.name} が空`);
    // Row1 が単一ヘッダー行であり、空文字ヘッダーが無い。
    const header = sheet.getRow(1).values as unknown[];
    const headerCells = header.slice(1).map((v) => String(v ?? ""));
    assert.ok(headerCells.length > 0, `${sheet.name} にヘッダーが無い`);
    assert.ok(headerCells.every((h) => h !== ""), `${sheet.name} に空のヘッダー列がある`);
    // merged cell を使っていない（AI-readable設計）。
    assert.equal(Object.keys((sheet as unknown as { _merges?: Record<string, unknown> })._merges ?? {}).length, 0, `${sheet.name} に結合セルがある`);
    // 先頭行固定が付いている。
    assert.ok((sheet.views ?? []).some((v) => v.state === "frozen"), `${sheet.name} の先頭行が固定されていない`);
  }
  // 数値セルに単位文字列を混ぜていない（"$62.5M" のような値を書かない）。
  const kpi = workbook.getWorksheet("03_TURN_KPI");
  assert.ok(kpi);
  const revenueColumnIndex = (kpi!.getRow(1).values as unknown[]).findIndex((v) => v === "revenueUsd");
  assert.ok(revenueColumnIndex > 0);
  let checked = 0;
  kpi!.eachRow((row, rowNumber) => {
    if (rowNumber === 1 || checked > 50) return;
    const cell = row.getCell(revenueColumnIndex).value;
    if (cell === null || cell === undefined) return;
    assert.equal(typeof cell, "number", `revenueUsd に数値以外が入っている: ${String(cell)}`);
    checked++;
  });
  assert.ok(checked > 0, "revenueUsd の数値セルを1つも検査できなかった");
});
