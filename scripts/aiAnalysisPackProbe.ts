// ShrimpX V2 — AI Analysis Pack: 32Q実機での生成時間・サイズ実測と内容確認
//
// 「答えを export 時に作る」のではなく、答えるための記録が Pack にあることを確認する。

import fs from "node:fs";
import path from "node:path";
import { advanceSimulationTurns, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { buildDatasetFromSession } from "../app/lib/v2/companyLab/simulation/analytics/dataset";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRun } from "../app/lib/v2/companyLab/simulation/persistence/types";
import { buildAiAnalysisPack } from "../app/lib/v2/companyLab/simulation/aiPack/pack";

const AT = "2026-01-01T00:00:00.000Z";
const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;

const runStart = process.hrtime.bigint();
let session = createSimulationSession({
  simulationRunId: "probe-32q",
  scenarioId: "baseline",
  seed: "management-console-32q",
  requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
  startedAt: AT,
});
session = advanceSimulationTurns({ session, turns: MANAGEMENT_CONSOLE_STANDARD_TURNS, timestamp: AT });
const runMs = Number(process.hrtime.bigint() - runStart) / 1e6;

const stored: StoredSimulationRun = {
  schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
  run: session.run,
  dataset: buildDatasetFromSession(session),
  packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
  savedAt: AT,
};

const storedBytes = Buffer.byteLength(JSON.stringify(stored), "utf8");
const captureBytes = Buffer.byteLength(JSON.stringify(stored.packCapture), "utf8");

async function main() {
const packStart = process.hrtime.bigint();
const pack = await buildAiAnalysisPack({ stored, exportedAt: AT, sourceBranch: "feature/v2-32q-management-console", sourceCommit: "local-probe" });
const packMs = Number(process.hrtime.bigint() - packStart) / 1e6;

console.log("=== ShrimpX AI Analysis Pack 実測 ===");
console.log(`32Q 実行時間            : ${runMs.toFixed(0)} ms`);
console.log(`Pack 生成時間           : ${packMs.toFixed(0)} ms`);
console.log("");
console.log(`保存物（run+dataset+capture）: ${kb(storedBytes)}`);
console.log(`  うち packCapture           : ${kb(captureBytes)}`);
console.log("");
console.log(`02_AI_Context.json      : ${kb(pack.sizes.jsonBytes)}`);
console.log(`03_Analysis.xlsx        : ${kb(pack.sizes.workbookBytes)}`);
console.log(`01_Run_Summary.md       : ${kb(Buffer.byteLength(pack.blobParts.runSummaryMarkdown, "utf8"))}`);
console.log(`04_Event_Change_Log.csv : ${kb(Buffer.byteLength(pack.blobParts.changeLogCsv, "utf8"))}`);
console.log(`05_Data_Dictionary.md   : ${kb(Buffer.byteLength(pack.blobParts.dataDictionaryMarkdown, "utf8"))}`);
console.log(`ZIP 合計                : ${kb(pack.sizes.zipBytes)}`);
console.log(`ファイル名              : ${pack.fileName}`);

// --- 実機テスト §59: 答えるための記録があるか ---
const ctx = pack.context;
const anyCompany = Object.values(ctx.companies)[0];
const newFactoryEvents = Object.values(ctx.companies).flatMap((c) => c.turns.flatMap((t) => t.execution.capexEvents.filter((e) => e.projectType === "newFactoryConstruction")));
const capexReasonCodes = new Set(Object.values(ctx.companies).flatMap((c) => c.turns.flatMap((t) => t.diagnosis.reasonCodes.map((r) => r.code))));
const spaceRemaining = anyCompany.turns[anyCompany.turns.length - 1].endingState.factorySpaceRemainingUnits;

console.log("");
console.log("=== §59 調査可能性チェック ===");
console.log(`Q1 新工場建設イベント件数        : ${newFactoryEvents.length}`);
console.log(`   Standard AI が提案しうる種別  : ${ctx.standardAiProposableCapexTypes.join(", ")}`);
console.log(`   ゲーム側に存在する種別        : ${ctx.gameCapexTypes.length} 種`);
console.log(`Q2 能力不足（律速）記録あり      : ${ctx.companies[anyCompany.companyId].turns.some((t) => t.diagnosis.commercialBottleneck !== null)}`);
console.log(`Q3 投資検討の理由コード          : ${[...capexReasonCodes].filter((c) => c.startsWith("CAPEX")).join(", ") || "(なし)"}`);
console.log(`Q4/Q5 期末 現金 / 工場スペース残 : ${anyCompany.turns[anyCompany.turns.length - 1].endingState.cashUsd} / ${spaceRemaining}`);
console.log(`Q6 商品別採算の記録              : ${anyCompany.turns[0].financialResult.productEconomics.length} 商品`);
console.log(`Q7 営業人員の変化ログ件数        : ${ctx.majorChanges.filter((c) => c.metric === "SALES_HEADCOUNT").length}`);
console.log(`Q8 市場価格の変化ログ件数        : ${ctx.majorChanges.filter((c) => c.metric.endsWith("_PRICE")).length}`);
console.log(`Q9 律速遷移の記録件数            : ${ctx.majorChanges.filter((c) => c.metric === "PRIMARY_BOTTLENECK").length}`);
console.log(`Q10 会社サマリー                 : ${ctx.companySummaries.length} 社`);
console.log(`World turns 記録                : ${ctx.world.turns.length}`);
console.log(`majorChanges 合計               : ${ctx.majorChanges.length}`);

// --- 秘密情報が混ざっていないこと ---
const secrets = ["STAGING_ADMIN_TOKEN", "KV_REST_API", "ANTHROPIC", "Bearer ", "sk-", "shrimpx_company_lab_ui_session"];
const haystack = pack.blobParts.aiContextJson + pack.blobParts.runSummaryMarkdown + pack.blobParts.changeLogCsv + pack.blobParts.dataDictionaryMarkdown;
const leaked = secrets.filter((s) => haystack.includes(s));
console.log("");
console.log(`秘密情報の混入                  : ${leaked.length === 0 ? "なし" : leaked.join(", ")}`);

const outDir = process.env.PACK_OUT_DIR;
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, pack.fileName), pack.zip);
  fs.writeFileSync(path.join(outDir, "01_Run_Summary.md"), pack.blobParts.runSummaryMarkdown);
  console.log(`\n出力先: ${outDir}`);
}
}

void main();
