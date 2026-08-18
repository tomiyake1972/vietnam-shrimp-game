// ShrimpX V2 — Standard AI 32Q Audit Workbook（実装指示§0〜§42）
//
// 【既存exportを壊さない（実装指示§31）】AI Analysis Pack（aiPack/）・
// Company Databook はどちらも無変更で残る。本モジュールは Standard AI 監査専用の
// 新しい単独ダウンロードであり、既存の生成物とはファイルも導線も別である。
//
// 【Management/Admin専用（実装指示§36）】5社横断の監査資料であるため、
// Player Workspaceからは呼ばない。導線はManagement Console / Game End画面のみ。

import { StoredSimulationRun } from "../persistence/types";
import { CompanyQuarterRecord } from "../../types";
import { buildStandardAiAuditWorkbookData } from "./rows";
import { buildStandardAiAuditWorkbook } from "./workbook";
import { StandardAiAuditWorkbookData } from "./types";

export { buildStandardAiAuditWorkbookData } from "./rows";
export { buildStandardAiAuditWorkbook } from "./workbook";
export { AUDIT_DATA_DICTIONARY } from "./dictionary";
export type { StandardAiAuditWorkbookData } from "./types";

/** ファイル名に使えない文字を落とす（IDそのものはWorkbook内に残す）。 */
function safeFileNamePart(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, "-");
}

/**
 * 実装指示§1のファイル名。
 *   COMPLETE: ShrimpX_StandardAI_Audit_{runId}_32Q.xlsx
 *   PARTIAL : ShrimpX_StandardAI_Audit_{runId}_Turn18_PARTIAL.xlsx
 * 「32Q」の部分はハードコードせず、実際に出力した最終Turn数を書く。
 */
export function standardAiAuditWorkbookFileName(simulationRunId: string, asOfTurn: number, status: "COMPLETE" | "PARTIAL"): string {
  const base = `ShrimpX_StandardAI_Audit_${safeFileNamePart(simulationRunId)}`;
  return status === "COMPLETE" ? `${base}_${asOfTurn}Q.xlsx` : `${base}_Turn${asOfTurn}_PARTIAL.xlsx`;
}

export interface BuiltStandardAiAuditWorkbook {
  readonly fileName: string;
  readonly workbook: ArrayBuffer;
  readonly data: StandardAiAuditWorkbookData;
  readonly bytes: number;
}

export async function buildStandardAiAuditExport(input: {
  readonly stored: StoredSimulationRun;
  readonly generatedAt: string;
  readonly asOfTurn?: number;
  /**
   * 【任意】呼び出し元が live session を持っている場合の確定履歴。
   * 保存済みRunのhistoryは容量のため直近数ターンへ間引かれているため、
   * これを渡すと全Turnの詳細シート・Turn別TSVが埋まる（rows.ts参照）。
   */
  readonly liveHistory?: readonly CompanyQuarterRecord[];
}): Promise<BuiltStandardAiAuditWorkbook> {
  const data = buildStandardAiAuditWorkbookData(input);
  const workbook = await buildStandardAiAuditWorkbook(data);
  return {
    fileName: standardAiAuditWorkbookFileName(data.meta.simulationRunId, data.meta.asOfTurn, data.meta.status),
    workbook,
    data,
    bytes: workbook.byteLength,
  };
}
