// ShrimpX V2 — AI Analysis Pack: ZIP の組み立て
//
// 【生成AIを呼ばない】ここまでのすべてが決定論的な記録出力である。
//
// 【秘密情報を含めない】この関数は Simulation Run の記録だけを入力に取り、
// 環境変数・トークン・接続情報のたぐいには一切触れない。
//
// 【既存ライブラリを使う】jszip / exceljs はどちらも既存の依存関係にある。

import JSZip from "jszip";
import { StoredSimulationRun } from "../persistence/types";
import { buildAiAnalysisPackContext } from "./context";
import { majorChangesToCsv } from "./changeLog";
import { buildRunSummaryMarkdown } from "./summary";
import { buildDataDictionaryMarkdown } from "./dataDictionary";
import { buildAnalysisWorkbook } from "./workbook";
import { AiAnalysisPackContext } from "./types";

/** 生成の進み具合。**実際の処理段階に対応する**（水増しの進捗は出さない）。 */
export type PackBuildStage = "preparing" | "buildingJson" | "buildingExcel" | "creatingZip" | "ready";

export interface BuildPackInput {
  readonly stored: StoredSimulationRun;
  /** metadata（ゲーム判断には使わない）。 */
  readonly exportedAt: string;
  readonly sourceBranch?: string;
  readonly sourceCommit?: string;
  readonly onStage?: (stage: PackBuildStage) => void;
}

export interface BuiltPack {
  readonly fileName: string;
  readonly blobParts: {
    readonly runSummaryMarkdown: string;
    readonly aiContextJson: string;
    readonly analysisWorkbook: ArrayBuffer;
    readonly changeLogCsv: string;
    readonly dataDictionaryMarkdown: string;
  };
  readonly zip: Uint8Array;
  readonly context: AiAnalysisPackContext;
  readonly sizes: {
    readonly jsonBytes: number;
    readonly workbookBytes: number;
    readonly zipBytes: number;
  };
}

/** ファイル名に使えない文字を落とす（ID そのものは JSON 内に残る）。 */
function safeFileNamePart(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, "-");
}

export function packFileName(simulationRunId: string): string {
  return `ShrimpX_Run_${safeFileNamePart(simulationRunId)}_AI_Analysis_Pack.zip`;
}

export async function buildAiAnalysisPack(input: BuildPackInput): Promise<BuiltPack> {
  const stage = input.onStage ?? (() => {});

  stage("preparing");
  const context = buildAiAnalysisPackContext({
    stored: input.stored,
    exportedAt: input.exportedAt,
    sourceBranch: input.sourceBranch,
    sourceCommit: input.sourceCommit,
  });

  stage("buildingJson");
  const aiContextJson = JSON.stringify(context, null, 1);
  const runSummaryMarkdown = buildRunSummaryMarkdown(context);
  const dataDictionaryMarkdown = buildDataDictionaryMarkdown(context);
  const changeLogCsv = majorChangesToCsv(context.majorChanges);

  stage("buildingExcel");
  const analysisWorkbook = await buildAnalysisWorkbook(context, input.stored.dataset);

  stage("creatingZip");
  const zipArchive = new JSZip();
  zipArchive.file("01_Run_Summary.md", runSummaryMarkdown);
  zipArchive.file("02_AI_Context.json", aiContextJson);
  zipArchive.file("03_Analysis.xlsx", analysisWorkbook);
  zipArchive.file("04_Event_Change_Log.csv", changeLogCsv);
  zipArchive.file("05_Data_Dictionary.md", dataDictionaryMarkdown);
  const zip = await zipArchive.generateAsync({ type: "uint8array", compression: "DEFLATE" });

  stage("ready");
  return {
    fileName: packFileName(input.stored.run.simulationRunId),
    blobParts: { runSummaryMarkdown, aiContextJson, analysisWorkbook, changeLogCsv, dataDictionaryMarkdown },
    zip,
    context,
    sizes: {
      jsonBytes: aiContextJson.length,
      workbookBytes: analysisWorkbook.byteLength,
      zipBytes: zip.byteLength,
    },
  };
}
