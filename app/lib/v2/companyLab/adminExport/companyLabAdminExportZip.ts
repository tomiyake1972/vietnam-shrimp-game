// ShrimpX V2 — Company Lab 管理者画面「分析データをエクスポート」機能 ZIP組み立て
//
// companyLabAdminExportSource.ts が取得したExport API JSON（4種）と、
// companyLabAdminExcelBuilder.ts が生成したExcelだけを入力として、ZIPを組み立てる。
// Redis・Repositoryへは一切アクセスしない（importしていないことがtsc上で確認できる）。
// ZIP内には、STAGING_EXPORT_TOKEN・Authorizationヘッダーの値・Redis内部キー名・
// 生のRepository構造体などを一切含めない（manifest含め、含める項目をすべて
// 明示的に列挙している）。

import JSZip from "jszip";
import type { AllCompaniesExportPayload, CompanyExportPayload } from "../../../../api/v2/exports/_lib/exportDto";
import { buildAllCompaniesExportExcelWorkbook, buildCompanyExportExcelWorkbook } from "./companyLabAdminExcelBuilder";

export interface CompanyLabAdminExportManifestEntry {
  readonly file: string;
  readonly sourceApiPath: string | null;
  readonly description: string;
}

export interface CompanyLabAdminExportManifest {
  readonly generatedAt: string;
  readonly labId: string;
  readonly turn: number;
  readonly companyId: string;
  readonly generatedBy: string;
  readonly note: string;
  readonly entries: readonly CompanyLabAdminExportManifestEntry[];
}

export interface BuildExportZipInput {
  readonly labId: string;
  readonly turn: number;
  readonly companyId: string;
  readonly generatedAt: string;
  readonly labIndexJson: unknown;
  readonly companyJson: CompanyExportPayload;
  readonly allCompaniesJson: unknown;
  /**
   * GMブック（全社Excel）の入力。会社別ブックとは入力型・出力ファイルが別で、混在させない。
   * 型が確定していない呼び出し経路では省略でき、その場合GMブックを生成しない
   * （推測値で埋めたGMブックを作らないため）。
   */
  readonly gmExcelPayload?: AllCompaniesExportPayload;
  readonly marketJson: unknown;
  readonly includeExcel: boolean;
}

function jsonFileName(prefix: string, labId: string, turn: number): string {
  return `${prefix}_${labId}_turn${turn}.json`;
}

export async function buildCompanyLabAdminExportZip(input: BuildExportZipInput): Promise<Buffer> {
  const zip = new JSZip();

  const labIndexFile = "lab_index.json";
  const companyFile = jsonFileName(`${input.companyId}_company`, input.labId, input.turn);
  const allCompaniesFile = jsonFileName("all_companies", input.labId, input.turn);
  const marketFile = jsonFileName("market", input.labId, input.turn);
  const excelFile = `${input.companyId}_${input.labId}_turn${input.turn}_databook.xlsx`;

  zip.file(labIndexFile, JSON.stringify(input.labIndexJson, null, 2));
  zip.file(companyFile, JSON.stringify(input.companyJson, null, 2));
  zip.file(allCompaniesFile, JSON.stringify(input.allCompaniesJson, null, 2));
  zip.file(marketFile, JSON.stringify(input.marketJson, null, 2));

  const entries: CompanyLabAdminExportManifestEntry[] = [
    { file: labIndexFile, sourceApiPath: `/api/v2/exports/company-labs/${input.labId}`, description: "ラボindex（作成済みturn一覧・playerCompanyId等）" },
    {
      file: companyFile,
      sourceApiPath: `/api/v2/exports/company-labs/${input.labId}/turns/${input.turn}/companies/${input.companyId}`,
      description: `${input.companyId}社のTurn${input.turn}確定データ（PL/BS/CF・資金繰り・設備投資・サマリー）`,
    },
    { file: allCompaniesFile, sourceApiPath: `/api/v2/exports/company-labs/${input.labId}/turns/${input.turn}`, description: `Turn${input.turn}の全社確定データ` },
    { file: marketFile, sourceApiPath: `/api/v2/exports/company-labs/${input.labId}/turns/${input.turn}/market`, description: `Turn${input.turn}の市場結果（公開情報）` },
  ];

  if (input.includeExcel) {
    const excelBuffer = await buildCompanyExportExcelWorkbook(input.companyJson);
    zip.file(excelFile, excelBuffer);
    entries.push({
      file: excelFile,
      sourceApiPath: null,
      description: `${companyFile}のみを入力として生成した経営データブック（Meta/PL/BS/CF/Financing/Capex/Company Summary/Processing Capacity/Sales Contracts/Sales Detail/Market/Decisionsの12シート）`,
    });

    // GMブックは会社別ブックと別ファイルとして出力する（1冊に混ぜない）。
    if (input.gmExcelPayload) {
      const gmExcelFile = `${input.labId}_turn${input.turn}_gm_databook.xlsx`;
      const gmBuffer = await buildAllCompaniesExportExcelWorkbook(input.gmExcelPayload);
      zip.file(gmExcelFile, gmBuffer);
      entries.push({
        file: gmExcelFile,
        sourceApiPath: null,
        description: `${allCompaniesFile}のみを入力として生成したGM用データブック（全社の加工能力と処理見込み）`,
      });
    }
  }

  const manifest: CompanyLabAdminExportManifest = {
    generatedAt: input.generatedAt,
    labId: input.labId,
    turn: input.turn,
    companyId: input.companyId,
    generatedBy: "Company Lab 管理者画面「分析データをエクスポート」機能",
    note: "このZIP内の各JSONは、読み取り専用Export API（/api/v2/exports/**）のレスポンスをそのまま保存したものです。トークン・Authorizationヘッダー・Redis内部キー等は一切含まれていません。",
    entries,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return buffer;
}
