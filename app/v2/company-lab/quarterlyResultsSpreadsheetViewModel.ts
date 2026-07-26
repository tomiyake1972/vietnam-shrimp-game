// ShrimpX V2 — Phase 8G §6 四半期結果のスプレッドシート型UI 表示用データ層
//
// 【このファイルが存在する理由】
//   プレイヤー画面の「履歴」節は、これまでturn番号・期・処理日時しか出さない
//   軽量な一覧（CompanyLabHistoryEntrySummaryDto）だけだった。四半期を横断して
//   自社の主要指標を一望できる表（スプレッドシート型）が無かったため、既に
//   確定済みのCompanyQuarterRecord（プレイヤー画面ではloadHistoryPageの戻り値
//   entry.recordから、GM/dev統合テスト画面ではlabState.historyから、いずれも
//   追加のRepositoryアクセス・追加計算なしにそのまま渡せる）から、自社ぶんの
//   既存確定値だけを抜き出して1行1四半期の表データへ整形する。
//
// 【計算ロジックを一切持たない】
//   ここで扱う値はすべて、CompanyQuarterSummary（会社ラボエンジン）と
//   CompanyFinancialQuarterResult（finance/quarterClose.ts）が既に確定・
//   永続化済みの値をcompanyIdで抽出するだけであり、新しい指標・比率・
//   係数をここで計算することは一切ない（financialViewSelectors.tsの
//   extractCompanyFinancialResultと同じ「抽出のみ」の設計方針）。
//
// 【情報開示レベル】
//   CompanyQuarterRecordは全5社ぶんのcompanySummaries・financialResultsを
//   含む全社データだが、この関数は指定した1社（プレイヤー会社）ぶんの
//   summary・financialResultだけを抽出して返す。他社データはこの関数の
//   戻り値に一切含まれない（GM専用データの漏洩防止。既存のplayerSummary・
//   extractCompanyFinancialResultと同じ会社スコープの絞り込み）。

import { CompanyId } from "../../lib/v2/sales/types";
import { CompanyQuarterRecord } from "../../lib/v2/companyLab/types";
import { unwrapUnit } from "../../lib/v2/core/units";
import { extractCompanyFinancialResult } from "./play/_lib/financialViewSelectors";

/** 1四半期・1社ぶんの、スプレッドシート表示用の行データ。単位はいずれも既存フォーマッタ側で付与する。 */
export interface QuarterlyResultsSpreadsheetRow {
  readonly turn: number;
  readonly period: string;

  // --- CompanyQuarterSummaryから抽出（既存フィールドそのまま） ---
  readonly newContractedQuantity: number;
  readonly newContractedAveragePrice: number;
  readonly fulfilledQuantity: number;
  readonly outstandingQuantity: number;
  readonly overdueQuantity: number;
  readonly domesticPurchaseQuantity: number;
  readonly domesticPurchasePrice: number;
  readonly importInTransitQuantity: number;
  readonly importArrivedQuantity: number;
  readonly rawMaterialInventory: number;
  readonly hosoProduced: number;
  readonly pdProduced: number;
  readonly vapProduced: number;
  readonly finishedGoodsInventory: number;
  readonly equipmentUtilizationRate: number;
  readonly laborUtilizationRate: number;

  // --- CompanyFinancialQuarterResultから抽出（見つからなければnull。捏造しない） ---
  readonly netRevenue: number | null;
  readonly operatingProfit: number | null;
  readonly netIncome: number | null;
  readonly closingCash: number | null;
}

/**
 * 既に確定済みのCompanyQuarterRecord配列（呼び出し側で追加取得・追加計算をしていない
 * 前提）から、指定会社ぶんのスプレッドシート行を組み立てる。会社の四半期サマリー
 * （companySummaries）が見つからないレコード（本来は起こらないはずの防御的ケース）は
 * その四半期を読み飛ばす（0埋め・捏造はしない）。
 */
export function buildQuarterlyResultsSpreadsheetRows(
  records: readonly CompanyQuarterRecord[],
  companyId: CompanyId
): readonly QuarterlyResultsSpreadsheetRow[] {
  const rows: QuarterlyResultsSpreadsheetRow[] = [];
  for (const record of records) {
    const summary = record.companySummaries.find((s) => s.companyId === companyId);
    if (!summary) continue;
    const financialResult = extractCompanyFinancialResult(record, companyId);

    rows.push({
      turn: record.turn,
      period: String(record.period),
      newContractedQuantity: unwrapUnit(summary.newContractedQuantity),
      newContractedAveragePrice: summary.newContractedAveragePrice,
      fulfilledQuantity: unwrapUnit(summary.fulfilledQuantity),
      outstandingQuantity: unwrapUnit(summary.outstandingQuantity),
      overdueQuantity: unwrapUnit(summary.overdueQuantity),
      domesticPurchaseQuantity: unwrapUnit(summary.domesticPurchaseQuantity),
      domesticPurchasePrice: summary.domesticPurchasePrice,
      importInTransitQuantity: unwrapUnit(summary.importInTransitQuantity),
      importArrivedQuantity: unwrapUnit(summary.importArrivedQuantity),
      rawMaterialInventory: unwrapUnit(summary.rawMaterialInventory),
      hosoProduced: unwrapUnit(summary.hosoProduced),
      pdProduced: unwrapUnit(summary.pdProduced),
      vapProduced: unwrapUnit(summary.vapProduced),
      finishedGoodsInventory: unwrapUnit(summary.finishedGoodsInventory),
      equipmentUtilizationRate: unwrapUnit(summary.equipmentUtilizationRate),
      laborUtilizationRate: unwrapUnit(summary.laborUtilizationRate),
      // Usd（finance/types.ts）はcore/units.tsのBrand<number,B>とは別のブランド機構のため、
      // unwrapUnitではなくnumberへ直接代入する（Usdはnumberとの交差型なので安全に代入できる）。
      netRevenue: financialResult ? financialResult.profitAndLoss.netRevenue : null,
      operatingProfit: financialResult ? financialResult.profitAndLoss.operatingProfit : null,
      netIncome: financialResult ? financialResult.profitAndLoss.netIncome : null,
      closingCash: financialResult ? financialResult.cashFlow.closingCash : null,
    });
  }
  return rows;
}
