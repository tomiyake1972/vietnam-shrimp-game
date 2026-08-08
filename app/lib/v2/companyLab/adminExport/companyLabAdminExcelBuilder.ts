// ShrimpX V2 — Company Lab 管理者画面「分析データをエクスポート」機能 Excel生成
//
// 【三宅さんの指示への対応】「Excel生成を同時に実装する場合も、取得済みExport JSON
// だけを入力元とし、RedisやRepositoryを別経路で参照しないでください。」
// 本モジュールは CompanyExportPayload（Export APIの会社スコープレスポンスの型。
// exportDto.tsから型だけをimportし、Redis・Repositoryへの参照は一切持たない）を
// 唯一の入力とし、シートを組み立てる。/tmp/export_demo/build_export_excel.py
// （Python版プロトタイプ、合成データで動作確認済み）と同じシート構成・同じ
// 検算式のロジックをexceljsへ移植したもの。

import ExcelJS from "exceljs";
import {
  appendManufacturingCostManagementSections,
  writeDecisionWorksheetSheet,
  writeFixedVariableAnalysisSheet,
} from "./test15ManagementSheets";
import { execFileSync } from "node:child_process";
import type {
  AllCompaniesExportPayload,
  CompanyExportPayload,
  ExportCompanyDecision,
  ExportCompanyDecisionInfo,
  ExportCompanySummary,
} from "../../../../api/v2/exports/_lib/exportDto";
import { CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../persistence/types";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import { PD_MECHANIZATION_PARAMETERS_V1 } from "../../capex/pdMechanization";
import { PRODUCT_DEVELOPMENT_PARAMETERS_V1 } from "../productDevelopmentState";
import { CAPEX_PARAMETERS_V1 } from "../../capex";

/**
 * 【Test15新設】「ゲーム情報」行（Meta系シートへ追加する共通の項目）。
 * branch/commitはビルド時点の実行環境（git）からの取得を試みるだけの補助情報であり、
 * ラボの状態（Redis・Repository）は一切参照しない（既存の「Export API JSONのみが
 * 入力元」という設計方針とは独立の、静的なビルド／パラメータ情報）。取得できない
 * 場合は例外を投げずに「未取得」を書く（このモジュール全体の「値が無ければ0や
 * 推測値で埋めない」方針と同じ）。
 */
function buildGameInfoRows(): readonly (readonly [string, string | number])[] {
  const branchName = tryGitCommand(["rev-parse", "--abbrev-ref", "HEAD"]);
  const commitHash = tryGitCommand(["rev-parse", "HEAD"]);
  return [
    ["branch（実行環境のgitブランチ名。取得できない場合は未取得）", branchName ?? "未取得"],
    ["commitHash（実行環境のHEADコミットハッシュ。取得できない場合は未取得）", commitHash ?? "未取得"],
    ["永続化スキーマバージョン (CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION)", CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION],
    ["労働集約度係数パラメータバージョン (production/parameters.ts)", PRODUCTION_PARAMETERS_V1.parametersVersion],
    ["設備投資パラメータバージョン (capex/parameters.ts)", CAPEX_PARAMETERS_V1.parametersVersion],
    ["PD省人化投資パラメータバージョン (capex/pdMechanization.ts)", PD_MECHANIZATION_PARAMETERS_V1.parametersVersion],
    ["VAP商品開発パラメータバージョン (companyLab/productDevelopmentState.ts)", PRODUCT_DEVELOPMENT_PARAMETERS_V1.parametersVersion],
  ];
}

function tryGitCommand(args: readonly string[]): string | undefined {
  try {
    const out = execFileSync("git", args as string[], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

const FONT_NAME = "Arial";
const HEADER_FONT: Partial<ExcelJS.Font> = { name: FONT_NAME, bold: true, color: { argb: "FFFFFFFF" } };
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
const LABEL_FONT: Partial<ExcelJS.Font> = { name: FONT_NAME };
const VALUE_FONT: Partial<ExcelJS.Font> = { name: FONT_NAME };
const CHECK_FONT: Partial<ExcelJS.Font> = { name: FONT_NAME, bold: true };
const USD_FORMAT = '$#,##0;($#,##0);"-"';

function writeHeaderRow(ws: ExcelJS.Worksheet, values: readonly string[]): void {
  const row = ws.addRow(values);
  row.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.alignment = { horizontal: "center" };
  });
}

function writeMetaSheet(wb: ExcelJS.Workbook, payload: CompanyExportPayload): void {
  const ws = wb.addWorksheet("Meta");
  ws.columns = [{ width: 30 }, { width: 60 }];
  writeHeaderRow(ws, ["項目", "値"]);
  const meta = payload.meta;
  const rows: readonly [string, string | number][] = [
    ["schemaVersion", meta.schemaVersion],
    ["generatedAt（このZIP/Excelを生成した時刻）", meta.generatedAt],
    ["labId", meta.labId],
    ["turn", meta.turn],
    ["period", meta.period],
    ["engineVersion", meta.engineVersion],
    ["dataStatus", meta.dataStatus],
    ["scope", JSON.stringify(meta.scope)],
    ["データ入力元", "Export API JSON のみ（Redis・Repository・画面表示値は一切参照していません）"],
  ];
  for (const [label, value] of [...rows, ...buildGameInfoRows()]) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = LABEL_FONT;
    row.getCell(2).font = VALUE_FONT;
  }
}

function writePlSheet(wb: ExcelJS.Workbook, financial: NonNullable<CompanyExportPayload["financialResult"]>): void {
  const ws = wb.addWorksheet("PL");
  ws.columns = [{ width: 42 }, { width: 20 }];
  writeHeaderRow(ws, ["科目", "金額(USD)"]);
  const pl = financial.profitAndLoss;
  const cos = pl.costOfSales;

  const grossRevenueRow = ws.addRow(["売上高 (grossRevenue)", pl.grossRevenue]);
  const qualityDeductionRow = ws.addRow(["品質関連売上控除 (qualitySalesDeduction)", -pl.qualitySalesDeduction]);
  const netRevenueRow = ws.addRow(["純売上高 (netRevenue)", null]);

  const costLabels: readonly [string, number][] = [
    ["─ 原料費 (rawMaterialCost)", cos.rawMaterialCost],
    ["─ 加工費 (processingCost)", cos.processingCost],
    ["─ 労務費 (laborCost)", cos.laborCost],
    ["─ 工場固定費 (factoryFixedCost)", cos.factoryFixedCost],
    ["─ 再加工費 (reworkCost)", cos.reworkCost],
    ["─ 廃棄損 (discardLoss)", cos.discardLoss],
    ["─ 未吸収固定製造費 (unabsorbedFixedManufacturingCost)", cos.unabsorbedFixedManufacturingCost],
    ["─ 遊休労務費 (idleLaborCost)", cos.idleLaborCost],
    ["─ 設備保守費 (capexMaintenanceCost)", cos.capexMaintenanceCost],
  ];
  const costRows = costLabels.map(([label, value]) => ws.addRow([label, -value]));

  const totalCostRow = ws.addRow(["売上原価合計 (totalCostOfSales)", null]);
  const grossProfitRow = ws.addRow(["売上総利益 (grossProfit)", null]);
  const sgaRow = ws.addRow(["販売費及び一般管理費 (sellingGeneralAdmin)", -pl.sellingGeneralAdmin]);
  const operatingProfitRow = ws.addRow(["営業利益 (operatingProfit)", null]);
  const interestRow = ws.addRow(["支払利息 (interestExpense)", -pl.interestExpense]);
  const preTaxRow = ws.addRow(["税引前利益 (profitBeforeTax)", null]);
  const taxRow = ws.addRow(["法人税 (incomeTax)", -pl.incomeTax]);
  const netIncomeRow = ws.addRow(["当期純利益 (netIncome)", null]);

  netRevenueRow.getCell(2).value = { formula: `B${grossRevenueRow.number}+B${qualityDeductionRow.number}` };
  totalCostRow.getCell(2).value = { formula: `SUM(B${costRows[0].number}:B${costRows[costRows.length - 1].number})` };
  grossProfitRow.getCell(2).value = { formula: `B${netRevenueRow.number}+B${totalCostRow.number}` };
  operatingProfitRow.getCell(2).value = { formula: `B${grossProfitRow.number}+B${sgaRow.number}` };
  preTaxRow.getCell(2).value = { formula: `B${operatingProfitRow.number}+B${interestRow.number}` };
  netIncomeRow.getCell(2).value = { formula: `B${preTaxRow.number}+B${taxRow.number}` };

  const jsonNetIncomeRow = ws.addRow(["API JSON上のnetIncome（突合用）", pl.netIncome]);
  const diffRow = ws.addRow(["差分（=0であること）", null]);
  diffRow.getCell(2).value = { formula: `B${netIncomeRow.number}-B${jsonNetIncomeRow.number}` };
  jsonNetIncomeRow.getCell(1).font = CHECK_FONT;
  diffRow.getCell(1).font = CHECK_FONT;

  for (const row of [grossRevenueRow, qualityDeductionRow, netRevenueRow, ...costRows, totalCostRow, grossProfitRow, sgaRow, operatingProfitRow, interestRow, preTaxRow, taxRow, netIncomeRow, jsonNetIncomeRow, diffRow]) {
    if (!row.getCell(1).font) row.getCell(1).font = LABEL_FONT;
    row.getCell(2).font = VALUE_FONT;
    row.getCell(2).numFmt = USD_FORMAT;
  }
}

function writeBsSheet(wb: ExcelJS.Workbook, financial: NonNullable<CompanyExportPayload["financialResult"]>): number {
  const ws = wb.addWorksheet("BS");
  ws.columns = [{ width: 32 }, { width: 20 }];
  writeHeaderRow(ws, ["科目", "金額(USD)"]);
  const bs = financial.balanceSheet;

  const cashRow = ws.addRow(["現金 (cash)", bs.cash]);
  const arRow = ws.addRow(["売掛金 (accountsReceivable)", bs.accountsReceivable]);
  const rawMatRow = ws.addRow(["原料在庫 (rawMaterialInventory)", bs.rawMaterialInventory]);
  const fgRow = ws.addRow(["完成品在庫 (finishedGoodsInventory)", bs.finishedGoodsInventory]);
  const otherCaRow = ws.addRow(["その他流動資産 (otherCurrentAssets)", bs.otherCurrentAssets]);
  const fixedAssetsRow = ws.addRow(["固定資産純額 (fixedAssetsNet)", bs.fixedAssetsNet]);
  const cipRow = ws.addRow(["建設中勘定 (constructionInProgress)", bs.constructionInProgress]);
  const totalAssetsRow = ws.addRow(["資産合計 (totalAssets)", null]);

  const apRow = ws.addRow(["買掛金 (accountsPayable)", bs.accountsPayable]);
  const stLoansRow = ws.addRow(["短期借入金 (shortTermLoans)", bs.shortTermLoans]);
  const ltLoansRow = ws.addRow(["長期借入金 (longTermLoans)", bs.longTermLoans]);
  const accruedIntRow = ws.addRow(["未払利息 (accruedInterestPayable)", bs.accruedInterestPayable]);
  const otherLiabRow = ws.addRow(["その他負債 (otherLiabilities)", bs.otherLiabilities]);
  const totalLiabRow = ws.addRow(["負債合計 (totalLiabilities)", null]);

  const capitalRow = ws.addRow(["資本金 (capitalStock)", bs.capitalStock]);
  const retainedRow = ws.addRow(["利益剰余金 (retainedEarnings)", bs.retainedEarnings]);
  const totalEquityRow = ws.addRow(["純資産合計 (totalEquity)", null]);
  const totalLiabEquityRow = ws.addRow(["負債・純資産合計 (totalLiabilitiesAndEquity)", null]);

  totalAssetsRow.getCell(2).value = { formula: `SUM(B${cashRow.number}:B${cipRow.number})` };
  totalLiabRow.getCell(2).value = { formula: `SUM(B${apRow.number}:B${otherLiabRow.number})` };
  totalEquityRow.getCell(2).value = { formula: `B${capitalRow.number}+B${retainedRow.number}` };
  totalLiabEquityRow.getCell(2).value = { formula: `B${totalLiabRow.number}+B${totalEquityRow.number}` };

  const balanceCheckRow = ws.addRow(["貸借差額（資産合計－負債純資産合計。0近傍であること）", null]);
  balanceCheckRow.getCell(2).value = { formula: `B${totalAssetsRow.number}-B${totalLiabEquityRow.number}` };
  const jsonBalanceDiffRow = ws.addRow(["API JSON上のbalanceDifference（突合用）", bs.balanceDifference]);
  balanceCheckRow.getCell(1).font = CHECK_FONT;
  jsonBalanceDiffRow.getCell(1).font = CHECK_FONT;

  for (const row of [cashRow, arRow, rawMatRow, fgRow, otherCaRow, fixedAssetsRow, cipRow, totalAssetsRow, apRow, stLoansRow, ltLoansRow, accruedIntRow, otherLiabRow, totalLiabRow, capitalRow, retainedRow, totalEquityRow, totalLiabEquityRow, balanceCheckRow, jsonBalanceDiffRow]) {
    if (!row.getCell(1).font) row.getCell(1).font = LABEL_FONT;
    row.getCell(2).font = VALUE_FONT;
    row.getCell(2).numFmt = USD_FORMAT;
  }

  return cashRow.number;
}

function writeCfSheet(wb: ExcelJS.Workbook, financial: NonNullable<CompanyExportPayload["financialResult"]>, bsCashRowNumber: number): void {
  const ws = wb.addWorksheet("CF");
  ws.columns = [{ width: 38 }, { width: 20 }];
  writeHeaderRow(ws, ["科目", "金額(USD)"]);
  const cf = financial.cashFlow;
  const od = cf.operatingDirect;

  const receiptsRow = ws.addRow(["顧客からの回収 (receiptsFromCustomers)", od.receiptsFromCustomers]);
  const rawMatPayRow = ws.addRow(["原料仕入支払 (paymentsForRawMaterials)", od.paymentsForRawMaterials]);
  const mfgPayRow = ws.addRow(["製造費支払 (paymentsForManufacturing)", od.paymentsForManufacturing]);
  const sgaPayRow = ws.addRow(["販管費支払 (paymentsForSellingGeneralAdmin)", od.paymentsForSellingGeneralAdmin]);
  const intPaidRow = ws.addRow(["支払利息 (interestPaid)", od.interestPaid]);
  const taxPaidRow = ws.addRow(["法人税支払 (incomeTaxPaid)", od.incomeTaxPaid]);
  const operatingCfRow = ws.addRow(["営業活動によるCF (operatingCashFlow)", null]);
  const investingCfRow = ws.addRow(["投資活動によるCF (investingCashFlow)", cf.investingCashFlow]);
  const financingCfRow = ws.addRow(["財務活動によるCF (financingCashFlow)", cf.financingCashFlow]);
  const netChangeRow = ws.addRow(["現金増減 (netCashChange)", null]);
  const openingCashRow = ws.addRow(["期首現金 (openingCash)", cf.openingCash]);
  const closingCashRow = ws.addRow(["期末現金 (closingCash)", null]);

  operatingCfRow.getCell(2).value = { formula: `SUM(B${receiptsRow.number}:B${taxPaidRow.number})` };
  netChangeRow.getCell(2).value = { formula: `B${operatingCfRow.number}+B${investingCfRow.number}+B${financingCfRow.number}` };
  closingCashRow.getCell(2).value = { formula: `B${openingCashRow.number}+B${netChangeRow.number}` };

  const jsonClosingCashRow = ws.addRow(["API JSON上のclosingCash（突合用）", cf.closingCash]);
  const bsCashRefRow = ws.addRow(["BSシートのcash（突合用。CF期末現金と一致すべき）", null]);
  bsCashRefRow.getCell(2).value = { formula: `BS!B${bsCashRowNumber}` };
  const diffRow = ws.addRow(["差分（CF期末現金－BS現金。0近傍であること）", null]);
  diffRow.getCell(2).value = { formula: `B${closingCashRow.number}-B${bsCashRefRow.number}` };
  const directIndirectRow = ws.addRow(["直接法/間接法CFOの差額（API JSON, directIndirectDifference）", cf.directIndirectDifference]);

  for (const row of [jsonClosingCashRow, bsCashRefRow, diffRow, directIndirectRow]) {
    row.getCell(1).font = CHECK_FONT;
  }
  for (const row of [receiptsRow, rawMatPayRow, mfgPayRow, sgaPayRow, intPaidRow, taxPaidRow, operatingCfRow, investingCfRow, financingCfRow, netChangeRow, openingCashRow, closingCashRow, jsonClosingCashRow, bsCashRefRow, diffRow, directIndirectRow]) {
    if (!row.getCell(1).font) row.getCell(1).font = LABEL_FONT;
    row.getCell(2).font = VALUE_FONT;
    row.getCell(2).numFmt = USD_FORMAT;
  }
}

function writeFinancingSheet(wb: ExcelJS.Workbook, financing: CompanyExportPayload["financingResult"]): void {
  const ws = wb.addWorksheet("Financing");
  ws.columns = [{ width: 44 }, { width: 24 }];
  writeHeaderRow(ws, ["項目", "値"]);
  if (!financing) {
    const row = ws.addRow(["このターン・会社の資金繰り結果はAPI上に存在しません（データ未作成）"]);
    row.getCell(1).font = LABEL_FONT;
    return;
  }
  const rows: readonly [string, string | number | boolean][] = [
    ["信用スコア (creditScore.score0to100)", financing.creditScore.score0to100],
    ["信用区分 (creditScore.tier)", financing.creditScore.tier],
    ["借入限度額合計 (borrowingCapacity.grossLimitUsd)", financing.borrowingCapacity.grossLimitUsd],
    ["既存借入残高 (borrowingCapacity.existingLoanBalanceUsd)", financing.borrowingCapacity.existingLoanBalanceUsd],
    ["追加借入可能額 (borrowingCapacity.availableAdditionalCapacityUsd)", financing.borrowingCapacity.availableAdditionalCapacityUsd],
    ["新規融資停止中か (borrowingCapacity.underwritingFrozen)", financing.borrowingCapacity.underwritingFrozen],
    ["─ 申請額 (underwriting.requestedAmountUsd)", financing.underwriting.requestedAmountUsd],
    ["─ 承認額 (underwriting.approvedAmountUsd)", financing.underwriting.approvedAmountUsd],
    ["─ 否決額 (underwriting.deniedAmountUsd)", financing.underwriting.deniedAmountUsd],
    ["─ 適用年率 (underwriting.appliedAnnualRate)", financing.underwriting.appliedAnnualRate],
    ["─ 否決・承認理由 (underwriting.reasons)", financing.underwriting.reasons.join("; ") || "(なし)"],
    ["コベナンツ違反あり (covenant.anyBreach)", financing.covenant.anyBreach],
    ["当期発生利息 (interestAccrualUsd)", financing.interestAccrualUsd],
    ["当期現金支払利息 (interestPaidCashUsd)", financing.interestPaidCashUsd],
    ["当期予定元本返済 (scheduledPrincipalDueUsd)", financing.scheduledPrincipalDueUsd],
    ["当期現金元本返済 (principalPaidCashUsd)", financing.principalPaidCashUsd],
    ["延滞件数 (arrearsEvents件数)", financing.arrearsEvents.length],
    ["財務状態 (financialHealth.primary)", financing.financialHealth.primary],
    ["債務超過か (financialHealth.insolvent)", financing.financialHealth.insolvent],
    ["期末短期借入金 (endingShortTermLoansUsd)", financing.endingShortTermLoansUsd],
    ["期末長期借入金 (endingLongTermLoansUsd)", financing.endingLongTermLoansUsd],
  ];
  for (const [label, value] of rows) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = LABEL_FONT;
    row.getCell(2).font = VALUE_FONT;
    if (typeof value === "number") row.getCell(2).numFmt = USD_FORMAT;
  }
}

function writeCapexSheet(wb: ExcelJS.Workbook, capex: CompanyExportPayload["capexResult"]): void {
  const ws = wb.addWorksheet("Capex");
  ws.columns = [{ width: 44 }, { width: 24 }];
  writeHeaderRow(ws, ["項目", "値"]);
  if (!capex) {
    const row = ws.addRow(["このターン・会社の設備投資結果はAPI上に存在しません（データ未作成）"]);
    row.getCell(1).font = LABEL_FONT;
    return;
  }
  const rows: readonly [string, number][] = [
    ["当期設備投資充当可能現金 (cashAvailableForCapexUsd)", capex.cashAvailableForCapexUsd],
    ["当期現金支払合計 (totalPaidThisQuarterUsd)", capex.totalPaidThisQuarterUsd],
    ["当期完成・固定資産振替額 (completedProjectsTransferUsd)", capex.completedProjectsTransferUsd],
    ["期末建設中勘定残高 (endingConstructionInProgressUsd)", capex.endingConstructionInProgressUsd],
    ["却下された新規提案件数 (rejectedProposals件数)", capex.rejectedProposals.length],
    ["当期の案件イベント件数 (events件数)", capex.events.length],
  ];
  for (const [label, value] of rows) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = LABEL_FONT;
    row.getCell(2).font = VALUE_FONT;
    row.getCell(2).numFmt = USD_FORMAT;
  }
  if (capex.rejectedProposals.length > 0) {
    const headerRow = ws.addRow(["却下理由一覧"]);
    headerRow.getCell(1).font = CHECK_FONT;
    for (const p of capex.rejectedProposals) {
      const row = ws.addRow([`${p.projectType} (希望予算 ${p.requestedBudgetUsd.toLocaleString()})`, p.reasons.join("; ")]);
      row.getCell(1).font = LABEL_FONT;
      row.getCell(2).font = VALUE_FONT;
    }
  }
}

/**
 * 【test/sai6-manual-observation-2026-08-01 で追加】この会社・四半期の会社サマリー
 * （受注残・在庫・稼働率等のKPI）シート。手動観察テストで「四半期実行後のKPI」を
 * 一覧で確認できるようにするためのもの。CompanyExportPayload.companySummary
 * （ExportCompanySummary、既存のDTO。exportDto.ts参照）をそのまま転記するだけで、
 * 値の再計算は一切行わない。
 */
function writeCompanySummarySheet(wb: ExcelJS.Workbook, companySummary: CompanyExportPayload["companySummary"]): void {
  const ws = wb.addWorksheet("Company Summary");
  ws.columns = [{ width: 42 }, { width: 20 }];
  writeHeaderRow(ws, ["項目", "値"]);
  if (!companySummary) {
    const row = ws.addRow(["このターン・会社の会社サマリーはAPI上に存在しません（データ未作成）"]);
    row.getCell(1).font = LABEL_FONT;
    return;
  }
  const s: ExportCompanySummary = companySummary;

  const sectionRow = (title: string): void => {
    const row = ws.addRow([title]);
    row.getCell(1).font = CHECK_FONT;
  };
  const writeRows = (rows: readonly (readonly [string, string | number | null])[]): void => {
    for (const [label, value] of rows) {
      const row = ws.addRow([label, value]);
      row.getCell(1).font = LABEL_FONT;
      row.getCell(2).font = VALUE_FONT;
      if (typeof value === "number") row.getCell(2).numFmt = "#,##0.0000";
    }
  };

  sectionRow("受注・契約履行（受注残）");
  writeRows([
    ["当期新規成約数量(t)", s.newContractedQuantity],
    ["当期新規成約平均単価(USD/kg)", s.newContractedAveragePrice],
    ["当期履行数量(t)", s.fulfilledQuantity],
    ["期末受注残(未履行契約数量、t)", s.outstandingQuantity],
    ["うち延滞数量(t)", s.overdueQuantity],
  ]);

  sectionRow("原料調達・原料在庫");
  writeRows([
    ["国内買付数量(t)", s.domesticPurchaseQuantity],
    ["国内買付価格(USD/kg)", s.domesticPurchasePrice],
    ["輸入中数量(t)", s.importInTransitQuantity],
    ["輸入到着数量(t)", s.importArrivedQuantity],
    ["自社養殖池入れ数量(t)", s.aquacultureGrowingQuantity],
    ["自社養殖収穫数量(t)", s.aquacultureHarvestedQuantity],
    ["期末原料在庫(t)", s.rawMaterialInventory],
  ]);

  sectionRow("生産・完成品在庫");
  writeRows([
    ["HOSO生産量(t)", s.hosoProduced],
    ["PD生産量(t)", s.pdProduced],
    ["VAP生産量(t)", s.vapProduced],
    ["期末完成品在庫(t)", s.finishedGoodsInventory],
  ]);

  sectionRow("工場能力・人員・稼働率");
  writeRows([
    ["原料不足による生産機会損失(t)", s.rawMaterialShortfall],
    ["設備能力不足による生産機会損失(t)", s.equipmentShortfall],
    ["労働力不足による生産機会損失(t)", s.laborShortfall],
    ["設備稼働率", s.equipmentUtilizationRate],
    ["労働稼働率", s.laborUtilizationRate],
    ["残業率", s.overtimeRate],
    ["臨時ワーカー比率", s.temporaryWorkerShare],
  ]);

  sectionRow("品質・納期");
  writeRows([
    ["格下げ数量(t)", s.downgradeQuantity],
    ["再加工数量(t)", s.reworkQuantity],
    ["廃棄数量(t)", s.discardQuantity],
    ["重大事故件数", s.majorIncidentCount],
    ["納期遵守率", s.onTimeDeliveryRate],
  ]);

  if (s.qualityScoreByProduct.length > 0) {
    sectionRow("商品別品質スコア（当期末時点）");
    for (const v of s.qualityScoreByProduct) writeRows([[v.product, v.value]]);
  }
  if (s.operationalRiskByProduct.length > 0) {
    sectionRow("商品別操業リスク（当期）");
    for (const v of s.operationalRiskByProduct) writeRows([[v.product, v.value]]);
  }
  if (s.customerTrustByMarket.length > 0) {
    sectionRow("市場別顧客信頼（当期末時点）");
    for (const v of s.customerTrustByMarket) writeRows([[v.market, v.value]]);
  }
  if (s.deliveryReliabilityByMarket.length > 0) {
    sectionRow("市場別納期信頼性（当期末時点）");
    for (const v of s.deliveryReliabilityByMarket) writeRows([[v.market, v.value]]);
  }
  if (s.rampWarnings.length > 0) {
    sectionRow("無理な増産の警告（工場×商品）");
    writeHeaderRow(ws, ["工場", "商品", "増産ストレス", "", "", "", "", ""]);
    for (const w of s.rampWarnings) {
      const row = ws.addRow([w.factoryId, w.product, w.productionRampStress]);
      row.eachCell((cell) => {
        if (!cell.font) cell.font = VALUE_FONT;
      });
      row.getCell(3).numFmt = "0.0000";
    }
  }
  if (s.reasonCodes.length > 0) {
    sectionRow("当期の理由コード（この会社ぶん）");
    writeHeaderRow(ws, ["コード", "会社", "説明", "", "", "", "", ""]);
    for (const r of s.reasonCodes) {
      const row = ws.addRow([r.code, r.companyId, r.message]);
      row.eachCell((cell) => {
        if (!cell.font) cell.font = VALUE_FONT;
      });
    }
  }
}

/**
 * 【test/sai6-manual-observation-2026-08-01 で追加】この会社・四半期の提出意思決定
 * （§6 のうち、Standard AIまたはプレイヤーが実際に提出した8領域の意思決定）シート。
 * CompanyExportPayload.decisionInfo（既存のDTO、exportDto.ts / decisionDto.ts参照）を
 * そのまま転記するだけで、値の再計算は一切行わない。
 *
 * 【スコープ】会社別ブックの入力（CompanyExportPayload）は対象会社1社ぶんのdecisionInfo
 * しか持たないため、このシートには他社の意思決定は構造上入り得ない。
 */
function writeDecisionsSheet(wb: ExcelJS.Workbook, decisionInfo: ExportCompanyDecisionInfo): void {
  const ws = wb.addWorksheet("Decisions");
  ws.columns = [{ width: 30 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 40 }];

  const sectionRow = (title: string): void => {
    const row = ws.addRow([title]);
    row.getCell(1).font = CHECK_FONT;
  };
  const noteRow = (text: string): void => {
    const row = ws.addRow([text]);
    row.getCell(1).font = LABEL_FONT;
  };

  noteRow(`このシートは対象会社の提出意思決定です（isPlayerCompany=${decisionInfo.isPlayerCompany ? "プレイヤー会社" : "AI会社（Standard AI）"}）。`);
  ws.addRow([]);

  function writeDecision(decision: ExportCompanyDecision): void {
    sectionRow("① 販売計画（市場別×商品別）");
    writeHeaderRow(ws, ["市場", "商品", "希望量(t)", "価格調整(USD/kg)", "営業人員(人)", "", "", ""]);
    for (const p of decision.salesPlans) {
      const row = ws.addRow([p.market, p.product, p.desiredQuantity, p.priceAdjustmentUsdPerHosoEqKg, p.salesForceHeadcount]);
      row.eachCell((cell) => {
        if (!cell.font) cell.font = VALUE_FONT;
      });
    }
    if (decision.salesPlans.length === 0) noteRow("販売計画は0件です。");
    ws.addRow([]);

    sectionRow("② 原料調達（国内買付・輸入・自社養殖）");
    const dp = decision.domesticPurchasePlan;
    writeHeaderRow(ws, ["項目", "値", "", "", "", "", "", ""]);
    for (const [label, value] of [
      ["国内買付希望量(t)", dp.desiredQuantity],
      ["国内買付価格調整(USD/kg)", dp.priceAdjustmentUsdPerHosoEqKg],
      ["調達人員(人)", dp.procurementHeadcount],
    ] as readonly [string, number][]) {
      const row = ws.addRow([label, value]);
      row.getCell(1).font = LABEL_FONT;
      row.getCell(2).font = VALUE_FONT;
    }
    if (decision.importOrders.length > 0) {
      writeHeaderRow(ws, ["輸入元国", "発注量(t)", "リード期間(四半期)", "上限着地価格(USD/kg)", "", "", "", ""]);
      for (const o of decision.importOrders) {
        const row = ws.addRow([o.originCountry, o.orderedQuantity, o.leadTimeTurns ?? "－", o.maxLandedPriceUsdPerHosoEqKg ?? "－"]);
        row.eachCell((cell) => {
          if (!cell.font) cell.font = VALUE_FONT;
        });
      }
    } else {
      noteRow("輸入発注は0件です。");
    }
    if (decision.aquacultureStockingPlans.length > 0) {
      writeHeaderRow(ws, ["池入れ予定生産量(t)", "養殖強度", "バイオセキュリティ水準", "収穫予定四半期", "", "", "", ""]);
      for (const a of decision.aquacultureStockingPlans) {
        const row = ws.addRow([a.plannedStockingQuantity, a.aquacultureIntensity, a.bioSecurityLevel, a.harvestPeriod ?? "－"]);
        row.eachCell((cell) => {
          if (!cell.font) cell.font = VALUE_FONT;
        });
      }
    } else {
      noteRow("自社養殖の池入れ計画は0件です。");
    }
    ws.addRow([]);

    sectionRow("③ 生産計画（工場別×商品別）");
    writeHeaderRow(ws, ["工場", "商品", "希望量(t)", "優先順位", "", "", "", ""]);
    for (const p of decision.productionPlans) {
      const row = ws.addRow([p.factoryId, p.product, p.desiredQuantity, p.priority]);
      row.eachCell((cell) => {
        if (!cell.font) cell.font = VALUE_FONT;
      });
    }
    if (decision.productionPlans.length === 0) noteRow("生産計画は0件です。");
    ws.addRow([]);

    sectionRow("④ 人員配置（工場別・雇用/採用に相当）");
    writeHeaderRow(ws, ["工場", "正規人員(人)", "臨時人員(人)", "残業率", "出勤可能率", "", "", ""]);
    for (const w of decision.workerAssignments) {
      const row = ws.addRow([w.factoryId, w.regularHeadcount, w.temporaryHeadcount, w.overtimeRate, w.attendanceRate]);
      row.eachCell((cell) => {
        if (!cell.font) cell.font = VALUE_FONT;
      });
    }
    if (decision.workerAssignments.length === 0) noteRow("人員配置は0件です。");
    ws.addRow([]);

    sectionRow("⑤ 資金調達希望");
    const fr = decision.financingRequest;
    for (const [label, value] of [
      ["希望借入額(USD)", fr.desiredAmountUsd],
      ["希望借入種別", fr.desiredLoanType],
      ["希望借入期間(四半期)", fr.desiredTermQuarters],
      ["希望返済方法", fr.desiredRepaymentMethod],
      ["任意期限前返済希望額(USD)", fr.desiredPrepaymentUsd],
      ["緊急融資許容", fr.emergencyAcceptable ? "許容" : "－"],
    ] as readonly [string, string | number | boolean][]) {
      const row = ws.addRow([label, value]);
      row.getCell(1).font = LABEL_FONT;
      row.getCell(2).font = VALUE_FONT;
    }
    ws.addRow([]);

    sectionRow("⑥ 設備投資の意思決定");
    const cx = decision.capexDecision;
    if (cx.newProjectProposals.length > 0) {
      writeHeaderRow(ws, ["新規案件種別", "対象工場ID(pdMechanizationのみ)", "希望投資額(USD)", "優先順位", "", "", "", ""]);
      for (const p of cx.newProjectProposals) {
        const row = ws.addRow([p.projectType, p.targetFactoryId ?? "－", p.requestedBudgetUsd ?? "（標準額）", p.priority ?? "（提案順）"]);
        row.eachCell((cell) => {
          if (!cell.font) cell.font = VALUE_FONT;
        });
      }
    } else {
      noteRow("新規設備投資の提案は0件です。");
    }
    noteRow(`取消希望案件ID: ${cx.cancelProjectIds.join(", ") || "(なし)"}`);
    noteRow(`再開希望案件ID: ${cx.resumeProjectIds.join(", ") || "(なし)"}`);
    ws.addRow([]);

    sectionRow("⑦ 【Test15新設】VAP商品開発費");
    const vapRow = ws.addRow(["今四半期のVAP商品開発費(USD)", decision.vapProductDevelopmentSpendUsd]);
    vapRow.getCell(1).font = LABEL_FONT;
    vapRow.getCell(2).font = VALUE_FONT;
    vapRow.getCell(2).numFmt = USD_FORMAT;
    ws.addRow([]);
  }

  if (decisionInfo.submission) {
    sectionRow("提出意思決定（このターン・この会社が実際に提出し、四半期処理へ使われた内容）");
    writeDecision(decisionInfo.submission);
  } else {
    noteRow("この会社の提出意思決定はAPI上に存在しません（データ未作成）。");
    ws.addRow([]);
  }

  sectionRow("Standard AI提案（四半期実行前のAI提案。提出内容と異なる場合のみ意味を持つ）");
  if (decisionInfo.aiProposal) {
    writeDecision(decisionInfo.aiProposal);
  } else {
    noteRow(decisionInfo.aiProposalUnavailableReason ?? "AI提案は保存されていません。");
  }

  if (decisionInfo.reasonCodes.length > 0) {
    sectionRow("当期の理由コード（この会社ぶん）");
    writeHeaderRow(ws, ["コード", "会社", "説明", "", "", "", "", ""]);
    for (const r of decisionInfo.reasonCodes) {
      const row = ws.addRow([r.code, r.companyId, r.message]);
      row.eachCell((cell) => {
        if (!cell.font) cell.font = VALUE_FONT;
      });
    }
  }
}

/**
 * 契約ロールフォワード明細（期首残高＋当期新規－当期履行＝期末残高）。
 *
 * 期首・新規・履行・期末はいずれも確定履歴の別々の保存値をそのまま転記したもので
 * あり（preProcessingStateSnapshot.contracts / salesRecord.newContracts /
 * fulfillmentPlan.explicitInstructions / postProcessingStateSnapshot.contracts）、
 * 検算差異列と金額列はExcel数式で組む＝JSON側の値を再計算しない。
 */
function writeSalesContractsSheet(wb: ExcelJS.Workbook, salesContracts: CompanyExportPayload["salesContracts"]): void {
  const ws = wb.addWorksheet("Sales Contracts");
  ws.columns = [
    { width: 24 }, { width: 8 }, { width: 8 }, { width: 8 }, { width: 12 }, { width: 10 },
    { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 15 },
    { width: 14 }, { width: 18 }, { width: 17 }, { width: 15 }, { width: 10 }, { width: 10 },
    { width: 17 }, { width: 17 }, { width: 17 }, { width: 17 },
  ];
  writeHeaderRow(ws, [
    "契約ID", "会社", "市場", "商品", "成約四半期", "納期",
    "当初数量(t)", "期首残(t)", "当期新規(t)", "当期履行(t)", "期末残(t)", "検算差異(=0)",
    "単価(USD/kg)", "期末残金額相当(USD)", "期末ステータス", "期首ステータス", "当期新規", "期末延滞",
    "契約時想定原料単価", "契約時想定加工費", "最低許容価格", "契約時想定限界利益",
  ]);
  if (salesContracts.length === 0) {
    const row = ws.addRow(["このターン・会社の契約は0件です（期首残高・当期新規成約ともにありません）"]);
    row.getCell(1).font = LABEL_FONT;
    return;
  }
  const firstDataRowNumber = ws.rowCount + 1;
  for (const c of salesContracts) {
    const row = ws.addRow([
      c.contractId, c.companyId, c.market, c.product, c.contractedPeriod, c.dueDate,
      c.originalQuantity, c.beginningOutstandingQuantity, c.newContractedQuantity, c.fulfilledQuantity, c.endingOutstandingQuantity, null,
      c.unitPrice, null, c.status, c.statusAtBeginning ?? "－", c.isNewThisQuarter ? "はい" : "－", c.isOverdueAtEnd ? "延滞" : "－",
      c.costSnapshot ? c.costSnapshot.expectedRawMaterialPriceUsdPerHosoEqKg : null,
      c.costSnapshot ? c.costSnapshot.expectedProcessingCostUsdPerHosoEqKg : null,
      c.costSnapshot ? c.costSnapshot.minimumAcceptablePriceUsdPerHosoEqKg : null,
      c.costSnapshot ? c.costSnapshot.expectedContributionMarginUsdPerHosoEqKg : null,
    ]);
    const r = row.number;
    // 期首 + 新規 - 履行 - 期末 = 0（契約ID単位のロールフォワード検算）。
    row.getCell(12).value = { formula: `H${r}+I${r}-J${r}-K${r}` };
    // 期末残数量(HOSO換算トン) × 単価(USD/kg) × 1000kg/t。
    row.getCell(14).value = { formula: `K${r}*M${r}*1000` };
    row.eachCell((cell) => {
      if (!cell.font) cell.font = VALUE_FONT;
    });
    for (const col of [7, 8, 9, 10, 11, 12]) row.getCell(col).numFmt = "#,##0.00";
    row.getCell(13).numFmt = "$#,##0.0000";
    row.getCell(14).numFmt = USD_FORMAT;
    for (const col of [19, 20, 21, 22]) row.getCell(col).numFmt = "$#,##0.0000";
  }
  const lastDataRowNumber = ws.rowCount;

  const totalRow = ws.addRow(["合計"]);
  totalRow.getCell(1).font = CHECK_FONT;
  for (const col of ["G", "H", "I", "J", "K", "N"]) {
    const cell = totalRow.getCell(col);
    cell.value = { formula: `SUM(${col}${firstDataRowNumber}:${col}${lastDataRowNumber})` };
    cell.font = CHECK_FONT;
    cell.numFmt = col === "N" ? USD_FORMAT : "#,##0.00";
  }
  const checkRow = ws.addRow(["検算差異の絶対値合計（0であること）"]);
  checkRow.getCell(1).font = CHECK_FONT;
  checkRow.getCell(2).value = { formula: `SUMPRODUCT(ABS(L${firstDataRowNumber}:L${lastDataRowNumber}))` };
  checkRow.getCell(2).font = CHECK_FONT;
  checkRow.getCell(2).numFmt = "#,##0.0000";
}

/**
 * 市場別×商品別の販売明細（§3）。販売計画（希望量・提示価格調整・営業人員）と
 * 成約配分結果（基準価格・対象需要・成約量）を突き合わせ、成約できなかった数量と
 * 成約金額はExcel数式で算出する。
 */
function writeSalesDetailSheet(wb: ExcelJS.Workbook, payload: CompanyExportPayload): void {
  const ws = wb.addWorksheet("Sales Detail");
  ws.columns = [
    { width: 8 }, { width: 8 }, { width: 14 }, { width: 15 }, { width: 15 }, { width: 15 },
    { width: 13 }, { width: 15 }, { width: 15 }, { width: 13 }, { width: 15 }, { width: 18 },
    { width: 14 }, { width: 17 },
  ];
  writeHeaderRow(ws, [
    "市場", "商品", "基準価格(USD/kg)", "対象需要(t)", "外部流出(t)", "販売希望量(t)",
    "価格調整(USD/kg)", "提示価格(USD/kg)", "営業人員(人)", "成約量(t)", "未成約量(t)", "成約金額相当(USD)",
    "カバレッジ", "競争力ウェイト",
  ]);
  const planKey = (market: string, product: string): string => `${market} ${product}`;
  const planByKey = new Map(payload.salesPlans.map((p) => [planKey(p.market, p.product), p]));
  let rowCount = 0;
  for (const allocation of payload.marketProductAllocations) {
    // 会社スコープのペイロードでは companies[] は対象会社1件のみへ絞り込まれている。
    const own = allocation.companies[0] ?? null;
    const plan = planByKey.get(planKey(allocation.market, allocation.product)) ?? null;
    if (!own && !plan) continue;
    const row = ws.addRow([
      allocation.market, allocation.product, allocation.basePrice, allocation.targetDemand, allocation.externalOptionQuantity,
      plan ? plan.desiredQuantity : null,
      plan ? plan.priceAdjustmentUsdPerHosoEqKg : null,
      own ? own.askPrice : null,
      plan ? plan.salesForceHeadcount : null,
      own ? own.allocatedQuantity : null,
      null, null,
      own ? own.coverageScore : null,
      own ? own.competitivenessWeight : null,
    ]);
    const r = row.number;
    // 未成約量 = 販売希望量 - 成約量。成約金額相当 = 成約量(t) × 提示価格(USD/kg) × 1000。
    row.getCell(11).value = { formula: `IF(F${r}="","",F${r}-J${r})` };
    row.getCell(12).value = { formula: `IF(OR(H${r}="",J${r}=""),"",J${r}*H${r}*1000)` };
    row.eachCell((cell) => {
      if (!cell.font) cell.font = VALUE_FONT;
    });
    for (const col of [3, 7, 8]) row.getCell(col).numFmt = "$#,##0.0000";
    for (const col of [4, 5, 6, 10, 11]) row.getCell(col).numFmt = "#,##0.00";
    row.getCell(12).numFmt = USD_FORMAT;
    for (const col of [13, 14]) row.getCell(col).numFmt = "0.0000";
    rowCount += 1;
  }
  if (rowCount === 0) {
    const row = ws.addRow(["このターン・会社の販売計画および成約配分は0件です"]);
    row.getCell(1).font = LABEL_FONT;
  }
}

/** 公開市場情報（§4）。会社別の非公開情報を一切含まない。 */
function writeMarketSheet(wb: ExcelJS.Workbook, market: CompanyExportPayload["market"]): void {
  const ws = wb.addWorksheet("Market");
  ws.columns = [{ width: 36 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 60 }];

  const sectionRow = (label: string): void => {
    const row = ws.addRow([label]);
    row.getCell(1).font = CHECK_FONT;
  };

  writeHeaderRow(ws, ["項目", "値", "", "", "", "", "備考"]);
  for (const [label, value] of [
    ["期(period)", market.period],
    ["パラメータ版(parametersVersion)", market.parametersVersion],
    ["世界供給量(HOSO換算t)", market.worldSupply],
    ["世界需要量(HOSO換算t)", market.worldDemand],
    ["世界需給バランス", market.worldSupplyDemandBalance],
    ["世界共通の価格ドライバー", market.globalDrivers.join("; ") || "－"],
  ] as readonly [string, string | number][]) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = LABEL_FONT;
    row.getCell(2).font = VALUE_FONT;
    if (typeof value === "number") row.getCell(2).numFmt = "#,##0.0000";
  }

  ws.addRow([]);
  sectionRow("国別HOSO価格（FOB, USD/HOSO換算kg）");
  writeHeaderRow(ws, ["国", "当期価格", "前期価格", "価格変化率", "国内需給圧力", "世界需給圧力", "ドライバー"]);
  for (const hp of market.hosoPricesByCountry) {
    const row = ws.addRow([hp.country, hp.price, hp.priorPrice, hp.changeRatio, hp.localPressure, hp.worldPressure, hp.drivers.join("; ") || "－"]);
    row.eachCell((cell) => {
      if (!cell.font) cell.font = VALUE_FONT;
    });
    for (const col of [2, 3]) row.getCell(col).numFmt = "$#,##0.0000";
    for (const col of [4, 5, 6]) row.getCell(col).numFmt = "0.0000";
  }
  writeHeaderRow(ws, ["国", "輸出可能供給量(t)", "配分需要(t)", "稼働率", "適用ショック", "", ""]);
  for (const hp of market.hosoPricesByCountry) {
    const row = ws.addRow([hp.country, hp.exportableSupply, hp.allocatedDemand, hp.utilizationRatio, hp.shockApplied]);
    row.eachCell((cell) => {
      if (!cell.font) cell.font = VALUE_FONT;
    });
    for (const col of [2, 3]) row.getCell(col).numFmt = "#,##0.00";
    for (const col of [4, 5]) row.getCell(col).numFmt = "0.0000";
  }

  ws.addRow([]);
  sectionRow("ベトナム国内未凍結原料市場");
  const vd = market.vietnamDomestic;
  for (const [label, value, fmt] of [
    ["国内原料価格(USD/HOSO換算kg)", vd.price, "$#,##0.0000"],
    ["理論買付上限(USD/HOSO換算kg)", vd.buyingCeiling, "$#,##0.0000"],
    ["農家留保価格(USD/HOSO換算kg)", vd.farmerReservationPrice, "$#,##0.0000"],
    ["国内供給量(t)", vd.supply, "#,##0.00"],
    ["実効需要(t)", vd.effectiveDemand, "#,##0.00"],
    ["取引成立量(t)", vd.transactedVolume, "#,##0.00"],
    ["未販売供給量(t)", vd.unsoldSupply, "#,##0.00"],
    ["国内需給バランス", vd.imbalance, "0.0000"],
  ] as readonly [string, number, string][]) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = LABEL_FONT;
    row.getCell(2).font = VALUE_FONT;
    row.getCell(2).numFmt = fmt;
  }
  for (const [label, value] of [
    ["最低引取ルール適用", vd.minimumOfftakeApplied ? "適用" : "－"],
    ["留保価格適用", vd.reservationPriceApplied ? "適用" : "－"],
    ["数量割当発生", vd.quantityRationed ? "発生" : "－"],
    ["国内市場ドライバー", vd.drivers.join("; ") || "－"],
  ] as readonly [string, string][]) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = LABEL_FONT;
    row.getCell(2).font = VALUE_FONT;
  }

  for (const premium of [market.pdPremium, market.vapPremium]) {
    ws.addRow([]);
    sectionRow(`${premium.product.toUpperCase()}プレミアム`);
    for (const [label, value, fmt] of [
      ["世界需要(t)", premium.globalDemand, "#,##0.00"],
      ["世界加工能力(t)", premium.globalCapacity, "#,##0.00"],
      ["世界稼働率", premium.globalUtilization, "0.0000"],
      ["ベースプレミアム(USD/HOSO換算kg)", premium.basePremium, "$#,##0.0000"],
    ] as readonly [string, number, string][]) {
      const row = ws.addRow([label, value]);
      row.getCell(1).font = LABEL_FONT;
      row.getCell(2).font = VALUE_FONT;
      row.getCell(2).numFmt = fmt;
    }
    writeHeaderRow(ws, ["国", "プレミアム", "最終価格", "品質調整", "能力稼働率", "", "ドライバー"]);
    for (const bc of premium.byCountry) {
      const row = ws.addRow([bc.country, bc.premium, bc.finalPrice, bc.qualityAdjustment, bc.capacityUtilization, "", premium.drivers.join("; ") || "－"]);
      row.eachCell((cell) => {
        if (!cell.font) cell.font = VALUE_FONT;
      });
      for (const col of [2, 3, 4]) row.getCell(col).numFmt = "$#,##0.0000";
      row.getCell(5).numFmt = "0.0000";
    }
  }
}

/**
 * 工場の加工能力シート。プレイヤーからの指摘「頂いているエクセルの中には、工場の
 * 現時点の加工能力が入っていません。各加工能力と、現在追加中（つまり設備投資を
 * 意思決定してこれから加わる能力）がわかるように出力してください」への対応。
 *
 * 【再計算しない】APIの保存済み確定値（当初の能力・稼働開始済み投資による増加・
 * 現時点の能力・実効能力・案件別の増加量）をそのまま書き写す。
 *   - 「当初＋増加＝現時点」の検算はE列のExcel数式（=B+C-D、0になるべき値）で行う。
 *   - 能力プール別の「現在追加中」合計は、下の案件明細に対するSUMIFで求める
 *     （TypeScript側で合計を作り込まず、プレイヤーが明細と突き合わせられるようにする）。
 */
function writeProcessingCapacitySheet(
  wb: ExcelJS.Workbook,
  capacity: CompanyExportPayload["processingCapacity"],
  sheetName: string = "Processing Capacity"
): void {
  const ws = wb.addWorksheet(sheetName);
  ws.columns = [{ width: 20 }, { width: 16 }, { width: 22 }, { width: 20 }, { width: 14 }, { width: 20 }, { width: 16 }, { width: 54 }];

  if (!capacity) {
    const row = ws.addRow(["工場の加工能力はこのExport JSONに含まれていません（fixturesを渡さない経路で生成されたJSONです）"]);
    row.getCell(1).font = LABEL_FONT;
    return;
  }

  const sectionRow = (title: string): void => {
    const row = ws.addRow([title]);
    row.getCell(1).font = CHECK_FONT;
  };

  const asOf = ws.addRow(["対象四半期（当期処理直後・次期の意思決定が前提とする能力）", capacity.asOfPeriod]);
  asOf.getCell(1).font = LABEL_FONT;
  asOf.getCell(2).font = VALUE_FONT;
  const companyRow = ws.addRow(["会社", capacity.companyId]);
  companyRow.getCell(1).font = LABEL_FONT;
  companyRow.getCell(2).font = VALUE_FONT;
  ws.addRow([]);

  // --- 1. 能力プール別（会社合計） ---
  sectionRow("能力プール別（会社合計・トン/四半期）");
  writeHeaderRow(ws, [
    "能力",
    "当初の能力",
    "稼働開始済み投資による増加",
    "現時点の能力（名目）",
    "検算(B+C-D)",
    "現時点の能力（実効）",
    "現在追加中",
    "能力の説明",
  ]);
  const totalRowNumbers: { readonly poolKey: string; readonly rowNumber: number }[] = [];
  for (const pool of capacity.companyTotals) {
    const row = ws.addRow([
      pool.poolLabel,
      pool.baseNominalTons,
      pool.addedByOperationalCapexTons,
      pool.currentNominalTons,
      { formula: `B${ws.rowCount + 1}+C${ws.rowCount + 1}-D${ws.rowCount + 1}` },
      pool.currentEffectiveTons,
      null,
      pool.poolDescription,
    ]);
    row.eachCell((cell) => {
      if (!cell.font) cell.font = VALUE_FONT;
    });
    for (const col of [2, 3, 4, 5, 6, 7]) row.getCell(col).numFmt = "#,##0.00";
    totalRowNumbers.push({ poolKey: pool.poolKey, rowNumber: row.number });
  }
  const noteRow1 = ws.addRow([
    "「名目」は工場の設計能力、「実効」は名目×基準稼働率×設備利用可能率です。「現在追加中」はまだ現時点の能力に含まれていません（稼働開始四半期に達した時点でC列へ移ります）。",
  ]);
  noteRow1.getCell(1).font = LABEL_FONT;
  ws.addRow([]);

  // --- 2. 工場別（現時点の名目能力） ---
  sectionRow("工場別の現時点の能力（名目・トン/四半期）");
  const poolLabels = capacity.companyTotals.map((p) => p.poolLabel);
  writeHeaderRow(ws, ["工場", "状態", ...poolLabels, "基準稼働率", "設備利用可能率", "投資反映先"]);
  for (const factory of capacity.factories) {
    const row = ws.addRow([
      factory.factoryId,
      factory.status,
      ...factory.pools.map((p) => p.currentNominalTons),
      factory.baseUtilizationRate,
      factory.equipmentAvailabilityRate,
      factory.receivesCapexCapacity ? "反映先" : "－",
    ]);
    row.eachCell((cell) => {
      if (!cell.font) cell.font = VALUE_FONT;
    });
    for (let col = 3; col < 3 + factory.pools.length; col++) row.getCell(col).numFmt = "#,##0.00";
    row.getCell(3 + factory.pools.length).numFmt = "0.0000";
    row.getCell(4 + factory.pools.length).numFmt = "0.0000";
  }
  ws.addRow([]);

  // --- 3. 現在追加中の案件明細 ---
  sectionRow("現在追加中の能力（設備投資を意思決定済み・まだ能力へ未反映）");
  writeHeaderRow(ws, [
    "案件",
    "対象能力",
    "増加量(t/四半期)",
    "状態",
    "工期(四半期)",
    "支払を伴う経過四半期",
    "完成四半期",
    "能力へ反映される四半期 / 承認額 / 支払済 / 未払予定",
  ]);
  const pendingFirstRow = ws.rowCount + 1;
  for (const project of capacity.pendingProjects) {
    const row = ws.addRow([
      project.projectTypeDisplayName,
      project.targetPoolLabel ?? "－",
      project.capacityIncreaseTonsPerQuarter,
      project.displayStatusLabel,
      project.requiredConstructionQuarters,
      project.elapsedConstructionQuartersWithPayment,
      project.completionPeriod === null ? "－" : project.isCompletionEstimate ? `${project.completionPeriod}（見込）` : project.completionPeriod,
      `${project.operationalStartPeriod ?? "完成後に確定"} / ${formatUsdText(project.approvedBudgetUsd)} / ${formatUsdText(project.cumulativePaidUsd)} / ${formatUsdText(project.remainingScheduledPaymentUsd)}`,
    ]);
    row.eachCell((cell) => {
      if (!cell.font) cell.font = VALUE_FONT;
    });
    row.getCell(3).numFmt = "#,##0.00";
  }
  const pendingLastRow = ws.rowCount;

  // 能力プール別の「現在追加中」合計をSUMIFで埋める（明細が0件のときは0）。
  for (const { poolKey, rowNumber } of totalRowNumbers) {
    const label = capacity.companyTotals.find((p) => p.poolKey === poolKey)?.poolLabel ?? poolKey;
    const cell = ws.getRow(rowNumber).getCell(7);
    cell.value =
      capacity.pendingProjects.length === 0
        ? 0
        : { formula: `SUMIF($B$${pendingFirstRow}:$B$${pendingLastRow},"${label}",$C$${pendingFirstRow}:$C$${pendingLastRow})` };
    cell.numFmt = "#,##0.00";
    cell.font = VALUE_FONT;
  }

  if (capacity.pendingProjects.length === 0) {
    const row = ws.addRow(["現在追加中の加工能力はありません（能力を増やす設備投資が進行中でない状態です）"]);
    row.getCell(1).font = LABEL_FONT;
  }
  const noteRow2 = ws.addRow([
    "能力が増えるのは「完成した四半期」ではなく「能力へ反映される四半期（稼働開始四半期）」からです。完成前の案件は完成時期そのものが確定していないため、反映四半期は完成後に確定します。",
  ]);
  noteRow2.getCell(1).font = LABEL_FONT;
  ws.addRow([]);

  // --- 【Test15新設】工場別PD省人化投資の状況 ---
  sectionRow("【Test15新設】工場別PD省人化投資の状況");
  writeHeaderRow(ws, ["工場", "前四半期PD稼働率", "稼働中案件ID", "mechanizationLevel", "実効PD係数", "基準PD係数(1.2)", "削減率", "備考"]);
  for (const pd of capacity.pdMechanizationByFactory) {
    const row = ws.addRow([
      pd.factoryId,
      pd.previousQuarterPdUtilization,
      pd.activeProjectId ?? "－",
      pd.mechanizationLevel ?? "－",
      pd.effectivePdCoefficient ?? "－",
      pd.basePdCoefficient,
      pd.reductionRatio ?? "－",
      pd.activeProjectId === null ? "稼働中の投資案件はありません（基準係数のまま）" : "",
    ]);
    row.eachCell((cell) => {
      if (!cell.font) cell.font = VALUE_FONT;
    });
    row.getCell(2).numFmt = "0.0000";
    if (typeof pd.mechanizationLevel === "number") row.getCell(4).numFmt = "0.0000";
    if (typeof pd.effectivePdCoefficient === "number") row.getCell(5).numFmt = "0.0000";
    if (typeof pd.reductionRatio === "number") row.getCell(7).numFmt = "0.0000";
  }
  ws.addRow([]);

  writeCapacityRateAndForecastSections(ws, capacity);
}

/**
 * 「名目能力 → 実効能力」の計算過程と、現在の生産計画・優先度に基づく処理見込みを書く。
 *
 * 【再計算しない】値はすべてExport JSONのforecastブロック（＝意思決定画面と同じ
 * processingForecastViewModel＝生産処理エンジンの純粋関数 allocateProductionPlans /
 * calculateFactoryEffectiveCapacity の出力）をそのまま書き写す。ここで配分計算や
 * 実効率の計算をしない（画面とExcelで値が食い違わないようにするため）。
 *   - 「名目×実効率＝実効能力」の検算はE列のExcel数式で行う。
 *   - 「希望量−処理見込み＝未処理見込み」の検算もExcel数式で行う。
 *
 * 【禁止事項】
 *   - 全プールが一律85.5%等と決め打ちしない（プールごとのeffectiveRateを書く）。
 *   - コードに存在しない補正要因を追加しない（factorsに入っているものだけを書く）。
 *   - 見込みを確定結果として書かない（見出しと注意書きを必ず出す）。
 *   - 値が無い箇所を0で埋めない（nullは「－」）。
 */
function writeCapacityRateAndForecastSections(ws: ExcelJS.Worksheet, capacity: NonNullable<CompanyExportPayload["processingCapacity"]>): void {
  const forecast = capacity.forecast;
  const sectionRow = (title: string): void => {
    const row = ws.addRow([title]);
    row.getCell(1).font = CHECK_FONT;
  };

  // --- 4. 名目能力 → 実効能力の計算過程 ---
  sectionRow(`名目能力 → 実効能力の計算（会社合計）: ${forecast.effectiveCapacityFormulaText}`);
  writeHeaderRow(ws, ["能力プール", "名目能力", "実効率", "実効能力", "検算(B*C-D)", "主な補正理由", "", ""]);
  for (const row of forecast.companyRateTable.rows) {
    const r = ws.addRow([
      row.poolLabel,
      row.nominalTons,
      row.effectiveRate ?? "－",
      row.effectiveTons,
      { formula: `B${ws.rowCount + 1}*C${ws.rowCount + 1}-D${ws.rowCount + 1}` },
      row.correctionNote,
      null,
      null,
    ]);
    r.eachCell((cell) => {
      if (!cell.font) cell.font = VALUE_FONT;
    });
    for (const col of [2, 4, 5]) r.getCell(col).numFmt = "#,##0.00";
    r.getCell(3).numFmt = "0.0000";
  }
  const factors = forecast.companyRateTable.rows[0]?.factors ?? [];
  if (factors.length > 0) {
    sectionRow("実効率を構成する補正要因（生産処理エンジンに実在するものだけ）");
    writeHeaderRow(ws, ["補正要因", "値", "", "", "", "", "", ""]);
    for (const factor of factors) {
      const r = ws.addRow([factor.label, factor.value]);
      r.getCell(1).font = LABEL_FONT;
      r.getCell(2).font = VALUE_FONT;
      r.getCell(2).numFmt = "0.0000";
    }
    const productRow = ws.addRow([
      "積（＝実効率）",
      forecast.companyRateTable.rows[0]?.factorsProduct ?? "－",
    ]);
    productRow.getCell(1).font = CHECK_FONT;
    productRow.getCell(2).font = VALUE_FONT;
    productRow.getCell(2).numFmt = "0.0000";
    const noteRow = ws.addRow([
      "実効率を構成する補正要因はこの2つだけです（人員充足率・保守状態・設備立ち上がり・品質リスクといった補正は現在のエンジンに存在しません）。人員の制約は実効能力ではなく、処理見込みの段階⑤（有効労働能力）で別に効きます。実効能力はエンジン側で小数2桁へ丸められるため、C列の実効率は「実効能力÷名目能力」として書き出しています。",
    ]);
    noteRow.getCell(1).font = LABEL_FONT;
  }
  ws.addRow([]);

  // --- 5. 現在の入力に基づく処理見込み ---
  sectionRow(`${forecast.headingText}（確定結果ではありません）`);
  const priorityNote = ws.addRow([forecast.priorityRuleText]);
  priorityNote.getCell(1).font = LABEL_FONT;
  const orderNote = ws.addRow([`能力が適用される順序: ${forecast.constraintOrderTexts.join(" → ")}`]);
  orderNote.getCell(1).font = LABEL_FONT;
  const yieldNote = ws.addRow([forecast.yieldApplicationText]);
  yieldNote.getCell(1).font = LABEL_FONT;
  const rawRow = ws.addRow(["見込み計算に使った利用可能原料在庫(t)", forecast.availableRawMaterialTons]);
  rawRow.getCell(1).font = LABEL_FONT;
  rawRow.getCell(2).font = VALUE_FONT;
  rawRow.getCell(2).numFmt = "#,##0.00";

  writeHeaderRow(ws, [
    "工場 / 商品",
    "生産希望量(t)",
    "優先度",
    "商品別名目能力(t)",
    "商品別実効能力(t)",
    "処理見込み量(t)",
    "未処理見込み量(t)",
    "制約となった能力（主因＋補足要因）",
  ]);
  if (forecast.rows.length === 0) {
    const row = ws.addRow(["この会社の当期の生産計画には、生産希望量が0より大きい行がありません（0で埋めていません）"]);
    row.getCell(1).font = LABEL_FONT;
  }
  for (const row of forecast.rows) {
    const r = ws.addRow([
      `${row.factoryId} / ${row.product.toUpperCase()}`,
      row.desiredTons,
      row.priority,
      row.productNominalCapacityTons,
      row.productEffectiveCapacityTons,
      row.forecastProcessedTons,
      row.forecastUnprocessedTons,
      row.constraintSummary,
    ]);
    r.eachCell((cell) => {
      if (!cell.font) cell.font = VALUE_FONT;
    });
    for (const col of [2, 4, 5, 6, 7]) r.getCell(col).numFmt = "#,##0.00";
  }
  const checkRow = ws.addRow(["検算: 希望量合計 − 処理見込み合計 − 未処理見込み合計（0になるべき値）"]);
  checkRow.getCell(1).font = CHECK_FONT;
  if (forecast.rows.length > 0) {
    // checkRow を追加した直後なので ws.rowCount は checkRow の行番号。
    // 明細行は (checkRow - 件数) 〜 (checkRow - 1)。
    const first = ws.rowCount - forecast.rows.length;
    const last = ws.rowCount - 1;
    const cell = checkRow.getCell(2);
    cell.value = { formula: `SUM(B${first}:B${last})-SUM(F${first}:F${last})-SUM(G${first}:G${last})` };
    cell.numFmt = "#,##0.00";
    cell.font = VALUE_FONT;
  }

  // 不足の内訳（主因と補足要因を区別した文章。エンジンが返した順序どおり）。
  const rowsWithConstraints = forecast.rows.filter((r) => r.constraintSentences.length > 0 || r.priorityNote !== null);
  if (rowsWithConstraints.length > 0) {
    sectionRow("能力不足の内訳（主因と補足要因）");
    writeHeaderRow(ws, ["工場 / 商品", "区分", "説明", "", "", "", "", ""]);
    for (const row of rowsWithConstraints) {
      row.constraintSentences.forEach((sentence, idx) => {
        const r = ws.addRow([`${row.factoryId} / ${row.product.toUpperCase()}`, idx === 0 ? "主因" : "補足要因", sentence]);
        r.eachCell((cell) => {
          if (!cell.font) cell.font = VALUE_FONT;
        });
      });
      if (row.priorityNote !== null) {
        const r = ws.addRow([`${row.factoryId} / ${row.product.toUpperCase()}`, "優先度の影響", row.priorityNote]);
        r.eachCell((cell) => {
          if (!cell.font) cell.font = VALUE_FONT;
        });
      }
    }
  }

  for (const text of forecast.caveatTexts) {
    const r = ws.addRow([text]);
    r.getCell(1).font = LABEL_FONT;
  }
  const forecastNote = ws.addRow([
    "この表の処理見込みは、優先度を変えると変わります（優先度を上げた商品は商品別実効能力まで先に処理され、その結果として他商品の処理見込みが減ります）。固定値ではありません。",
  ]);
  forecastNote.getCell(1).font = LABEL_FONT;
}

function formatUsdText(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * Export API（会社スコープ）JSONだけを入力として、Meta/PL/BS/CF/Financing/Capex/
 * Company Summary/Processing Capacity/Sales Contracts/Sales Detail/Market/Decisionsの
 * 12シート構成のExcelワークブックを組み立て、Bufferとして返す。会社スコープの
 * ペイロードだけを入力とするため、他社の非公開情報は構造上ここへ入り得ない。
 *
 * 【test/sai6-manual-observation-2026-08-01 で追加】Company Summary（受注残・在庫・
 * 稼働率等のKPI）・Decisions（Standard AI/プレイヤーの提出意思決定・AI提案・理由コード）の
 * 2シートを追加した。いずれも既存のCompanyExportPayload（companySummary・decisionInfo）を
 * そのまま転記するだけで、新しいデータ収集・値の再計算は一切行っていない。
 */
export async function buildCompanyExportExcelWorkbook(
  payload: CompanyExportPayload,
  history?: readonly CompanyTurnHistoryEntry[]
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ShrimpX V2 Company Lab — Export API (自動生成)";
  wb.created = new Date(payload.meta.generatedAt);

  writeMetaSheet(wb, payload);
  if (payload.financialResult) {
    writePlSheet(wb, payload.financialResult);
    // 【Test15】製造原価計算書はPLの直後（参考ブックと同じ位置）。
    writeManufacturingCostSheet(wb, payload);
    // 【Test15管理会計】製造原価計算書の直後に固変分解（市場×商品別の採算性）。
    writeFixedVariableAnalysisSheet(wb, payload);
    const bsCashRowNumber = writeBsSheet(wb, payload.financialResult);
    writeCfSheet(wb, payload.financialResult, bsCashRowNumber);
  } else {
    const plWs = wb.addWorksheet("PL");
    plWs.addRow(["このターン・会社の財務結果はAPI上に存在しません（データ未作成）"]);
    writeManufacturingCostSheet(wb, payload);
    writeFixedVariableAnalysisSheet(wb, payload);
    wb.addWorksheet("BS").addRow(["このターン・会社の財務結果はAPI上に存在しません（データ未作成）"]);
    wb.addWorksheet("CF").addRow(["このターン・会社の財務結果はAPI上に存在しません（データ未作成）"]);
  }
  writeFinancingSheet(wb, payload.financingResult);
  writeCapexSheet(wb, payload.capexResult);
  writeCompanySummarySheet(wb, payload.companySummary);
  writeProcessingCapacitySheet(wb, payload.processingCapacity);
  writeSalesContractsSheet(wb, payload.salesContracts);
  // 【Test15】生データ_成約明細 → 販売数量分析 の順（後者が前者をSUMIFSで参照する）。
  writeRawAllocationDetailSheet(wb, payload);
  writeSalesVolumeAnalysisSheet(wb, payload);
  writeSalesDetailSheet(wb, payload);
  writeMarketSheet(wb, payload.market);
  writeDecisionsSheet(wb, payload.decisionInfo);
  // 【Test15管理会計】Decisionsの直後に、次期意思決定のワーキングシート。
  writeDecisionWorksheetSheet(wb, payload);
  // 【Test15】Turn履歴。historyが渡されない呼び出し経路（既存のZIP生成等）でも
  // シート自体は必ず作り、「履歴が取得できなかった」旨を書く（シート数を安定させる）。
  writeCompanyTrendSheet(wb, history ?? []);

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * GMブック（全社スコープ）。全5社の加工能力と、各社の「現在の入力に基づく処理見込み」を
 * 1冊で確認できるようにする（三宅さんの指示：会社別ブックでは自社のみ、GMブックでは全5社）。
 *
 * 【スコープ隔離】本関数の入力は AllCompaniesExportPayload（GMフルスコープでのみ生成される
 * ペイロード）だけ。会社別ブック（buildCompanyExportExcelWorkbook）とは入力型が別で、
 * 会社別ブック側からは全社ペイロードへ到達できない（型上、混在し得ない）。
 * ファイルとしても別名で出力し、1冊に混ぜない。
 *
 * 【再計算しない】各社の値は Export JSON の processingCapacity（＝意思決定画面と同じ
 * processingForecastViewModel の出力）をそのまま書き写す。ここで配分計算をしない。
 */
export async function buildAllCompaniesExportExcelWorkbook(
  payload: AllCompaniesExportPayload,
  history?: readonly AllCompaniesTurnHistoryEntry[]
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ShrimpX V2 Company Lab — Export API (自動生成・GM用)";
  wb.created = new Date(payload.meta.generatedAt);

  // 【Test15】参考GMブック（Sample Test13_GM分析ブック）の4シートを先頭へ置く。
  // 既存の5シート（Meta / Capacity_各社 / 生産・設備・労務 / 意思決定項目 / StandardAI入力）は
  // Test15の投資機能（PD省人化・VAP開発・工場建設）の確認手段なので削除せず後段に残す。
  writeGmLegendSheet(wb, payload);
  writeGmCrossCompanySheet(wb, payload);
  writeGmMarketShareSheet(wb, payload);
  writeGmAllDecisionsSheet(wb, payload);
  writeGmTurnTrendSheet(wb, history ?? []);

  const ws = wb.addWorksheet("Meta");
  ws.columns = [{ width: 34 }, { width: 60 }];
  writeHeaderRow(ws, ["項目", "値"]);
  const metaRows: readonly [string, string | number][] = [
    ["schemaVersion", payload.meta.schemaVersion],
    ["generatedAt（このExcelを生成した時刻）", payload.meta.generatedAt],
    ["labId", payload.meta.labId],
    ["turn", payload.meta.turn],
    ["period", payload.meta.period],
    ["engineVersion", payload.meta.engineVersion],
    ["dataStatus", payload.meta.dataStatus],
    ["scope", JSON.stringify(payload.meta.scope)],
    ["収録会社", payload.companies.map((c) => c.companyId).join(", ")],
    ["用途", "GM用。全社の加工能力と処理見込みを確認するためのブックです（会社別ブックとは別ファイルです）"],
    ["データ入力元", "Export API JSON（全社スコープ）のみ。Redis・Repository・画面表示値は参照していません"],
  ];
  for (const [label, value] of [...metaRows, ...buildGameInfoRows()]) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = LABEL_FONT;
    row.getCell(2).font = VALUE_FONT;
  }

  // 会社ごとに独立したシートを作る（1シートへ混ぜると、どの社の行かが読み取りにくいため）。
  for (const company of payload.companies) {
    writeProcessingCapacitySheet(wb, company.processingCapacity, `Capacity_${company.companyId}`);
  }

  writeProductionFacilitiesLaborSheet(wb, payload.companies);
  writeAllCompaniesDecisionsSheet(wb, payload.decisionInfo);
  writeStandardAiInputSheet(wb, payload);

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * 【Test15新設】「生産・設備・労務」シート。全社・全工場を1シートへ機械可読な形（会社ID・
 * 工場ID・案件IDを列として持つ）で並べる（会社別タブに分けると集計・フィルタしにくいため、
 * このシートだけはあえてフラットな一覧にする）。
 *
 * 【再計算しない】能力・稼働率・PD省人化投資の状況は、すべて processingCapacityDto.ts の
 * buildExportProcessingCapacity（意思決定画面と同一の導出）が返した値をそのまま書き写す。
 */
function writeProductionFacilitiesLaborSheet(wb: ExcelJS.Workbook, companies: AllCompaniesExportPayload["companies"]): void {
  const ws = wb.addWorksheet("生産・設備・労務");
  ws.columns = [
    { width: 12 }, { width: 14 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 12 },
    { width: 12 }, { width: 12 }, { width: 14 }, { width: 16 }, { width: 20 }, { width: 16 }, { width: 16 }, { width: 16 },
  ];

  const noteRow = ws.addRow([
    "工場別の現時点の加工能力（名目）・PD稼働率・PD省人化投資の状況を、会社ID・工場ID・案件IDつきで一覧化したシートです。processingCapacity（意思決定画面と同一の導出）をそのまま転記しています。",
  ]);
  noteRow.getCell(1).font = LABEL_FONT;
  ws.addRow([]);

  // --- 工場別能力・PD稼働率・PD省人化 ---
  writeHeaderRow(ws, [
    "会社ID", "工場ID", "状態", "HOSO能力(t)", "PD能力(t)", "VAP能力(t)",
    "前四半期PD稼働率", "稼働中PD省人化案件ID", "mechanizationLevel", "実効PD係数", "基準PD係数(1.2)",
    "削減率", "", "",
  ]);
  for (const company of companies) {
    const capacity = company.processingCapacity;
    if (!capacity) continue;
    for (const factory of capacity.factories) {
      const pd = capacity.pdMechanizationByFactory.find((p) => p.factoryId === factory.factoryId);
      const poolTon = (poolKey: string) => factory.pools.find((p) => p.poolKey === poolKey)?.currentNominalTons ?? 0;
      const row = ws.addRow([
        company.companyId,
        factory.factoryId,
        factory.status,
        poolTon("hoso"),
        poolTon("pd"),
        poolTon("vap"),
        pd?.previousQuarterPdUtilization ?? "未取得",
        pd?.activeProjectId ?? "－",
        pd?.mechanizationLevel ?? "－",
        pd?.effectivePdCoefficient ?? "－",
        pd?.basePdCoefficient ?? "－",
        pd?.reductionRatio ?? "－",
      ]);
      row.eachCell((cell) => {
        if (!cell.font) cell.font = VALUE_FONT;
      });
      for (const col of [4, 5, 6]) row.getCell(col).numFmt = "#,##0.00";
      if (typeof pd?.previousQuarterPdUtilization === "number") row.getCell(7).numFmt = "0.0000";
      if (typeof pd?.mechanizationLevel === "number") row.getCell(9).numFmt = "0.0000";
      if (typeof pd?.effectivePdCoefficient === "number") row.getCell(10).numFmt = "0.0000";
      if (typeof pd?.reductionRatio === "number") row.getCell(12).numFmt = "0.0000";
    }
  }
  ws.addRow([]);

  // --- 現在追加中の設備投資案件（新工場建設・PD省人化含む、全案件種別を機械可読に） ---
  const sectionRow = ws.addRow(["現在追加中の設備投資案件（案件IDつき、全案件種別）"]);
  sectionRow.getCell(1).font = CHECK_FONT;
  writeHeaderRow(ws, [
    "会社ID", "案件ID", "案件種別", "状態", "対象能力", "増加量(t/四半期)", "工期(四半期)",
    "経過四半期(支払を伴う)", "完成四半期", "能力反映四半期", "承認額(USD)", "支払済(USD)", "未払予定(USD)", "",
  ]);
  for (const company of companies) {
    const capacity = company.processingCapacity;
    if (!capacity) continue;
    for (const project of capacity.pendingProjects) {
      const row = ws.addRow([
        company.companyId,
        project.projectId,
        project.projectType,
        project.displayStatusLabel,
        project.targetPoolLabel ?? "－",
        project.capacityIncreaseTonsPerQuarter,
        project.requiredConstructionQuarters,
        project.elapsedConstructionQuartersWithPayment,
        project.completionPeriod === null ? "－" : project.isCompletionEstimate ? `${project.completionPeriod}（見込）` : project.completionPeriod,
        project.operationalStartPeriod ?? "完成後に確定",
        project.approvedBudgetUsd,
        project.cumulativePaidUsd,
        project.remainingScheduledPaymentUsd,
      ]);
      row.eachCell((cell) => {
        if (!cell.font) cell.font = VALUE_FONT;
      });
      for (const col of [6, 11, 12, 13]) row.getCell(col).numFmt = USD_FORMAT;
      row.getCell(6).numFmt = "#,##0.00";
    }
  }
}

/**
 * 【Test15新設】「意思決定項目」シート（全社版）。VAP商品開発費・設備投資提案
 * （対象工場IDを含む）を会社ID列つきでフラットに並べる。
 * AI提案（aiProposals）はDecisions側と同じ理由で未保存のため、その旨のみ記す
 * （推測値で埋めない）。
 */
function writeAllCompaniesDecisionsSheet(wb: ExcelJS.Workbook, decisionInfo: AllCompaniesExportPayload["decisionInfo"]): void {
  const ws = wb.addWorksheet("意思決定項目");
  ws.columns = [{ width: 14 }, { width: 24 }, { width: 20 }, { width: 16 }, { width: 14 }, { width: 40 }];

  writeHeaderRow(ws, ["会社ID", "今四半期のVAP商品開発費(USD)", "", "", "", ""]);
  for (const d of decisionInfo.submissions) {
    const row = ws.addRow([d.companyId, d.vapProductDevelopmentSpendUsd]);
    row.getCell(1).font = VALUE_FONT;
    row.getCell(2).font = VALUE_FONT;
    row.getCell(2).numFmt = USD_FORMAT;
  }
  ws.addRow([]);

  const sectionRow = ws.addRow(["設備投資の新規提案（新工場建設・PD省人化を含む全案件種別）"]);
  sectionRow.getCell(1).font = CHECK_FONT;
  writeHeaderRow(ws, ["会社ID", "案件種別", "対象工場ID(pdMechanizationのみ)", "希望投資額(USD)", "優先順位", ""]);
  for (const d of decisionInfo.submissions) {
    for (const p of d.capexDecision.newProjectProposals) {
      const row = ws.addRow([d.companyId, p.projectType, p.targetFactoryId ?? "－", p.requestedBudgetUsd ?? "（標準額）", p.priority ?? "（提案順）"]);
      row.eachCell((cell) => {
        if (!cell.font) cell.font = VALUE_FONT;
      });
    }
  }
  ws.addRow([]);

  const aiSectionRow = ws.addRow(["Standard AI提案（三宅判断との比較用）"]);
  aiSectionRow.getCell(1).font = CHECK_FONT;
  const aiNote = ws.addRow([decisionInfo.aiProposalUnavailableReason ?? "AI提案が保存されています（下記参照）。"]);
  aiNote.getCell(1).font = LABEL_FONT;
}

/**
 * 【Test15新設】「StandardAI入力」シート。Standard AI（autoPolicy.ts
 * generateAutoPolicyDecision）が実際に受け取る入力の型は
 * (fixture: CompanyFixture, ownState: CompanyOwnState, publicInfo: PublicMarketInfo, period, turn)
 * のみであり、将来四半期の情報・シナリオの真の確率分布・非公開のground truthは
 * いずれの型にも一切含まれない（companyLab/types.ts参照）。本シートはその実際の
 * 入力に対応するフィールドだけを転記する（監査専用の「シナリオ監査」情報は
 * 本シートには一切含まれない。両者が別の型・別の生成経路であることは
 * companyLabAdminExportSource.test.ts / companyLabAdminExcelBuilder.test.ts の
 * 監査情報リーク防止テストで確認している）。
 *
 * 【Test15の新規フィールドについて】pdUtilizationByFactory・vapProductDevelopmentScore
 * はCompanyOwnStateにはすでに存在する（companyLab/runner.ts buildCompanyOwnState）が、
 * autoPolicy.ts（Standard AI）の判断ロジックはまだこの2フィールドを一切参照していない
 * （#05のStandard AI改修待ち）。本シートはその状態を「未参照」として明示し、
 * 参照していないのに参照しているかのような入力値を書かない。
 */
function writeStandardAiInputSheet(wb: ExcelJS.Workbook, payload: AllCompaniesExportPayload): void {
  const ws = wb.addWorksheet("StandardAI入力");
  ws.columns = [{ width: 40 }, { width: 60 }];

  const noteRow = ws.addRow([
    "Standard AIの入力型は (fixture, ownState: CompanyOwnState, publicInfo: PublicMarketInfo, period, turn) のみです。" +
      "将来四半期・シナリオ真値・非公開グラウンドトゥルースはいずれの型にも存在しません。",
  ]);
  noteRow.getCell(1).font = LABEL_FONT;
  ws.addRow([]);

  writeHeaderRow(ws, ["会社ID", "公開市場情報・自社状態のうち実際にStandard AIへ渡る値"]);
  for (const company of payload.companies) {
    const row = ws.addRow([company.companyId, ""]);
    row.getCell(1).font = CHECK_FONT;
    const summary = company.companySummary;
    if (summary) {
      for (const [label, value] of [
        ["品質スコア(hoso/pd/vap)", summary.qualityScoreByProduct.map((q) => `${q.product}:${q.value ?? "－"}`).join(" / ")],
        ["顧客信頼(市場別)", summary.customerTrustByMarket.map((c) => `${c.market}:${c.value ?? "－"}`).join(" / ")],
        ["納期信頼性(市場別)", summary.deliveryReliabilityByMarket.map((c) => `${c.market}:${c.value ?? "－"}`).join(" / ")],
        ["期末原料在庫(t)", summary.rawMaterialInventory],
        ["期末完成品在庫(t)", summary.finishedGoodsInventory],
      ] as readonly [string, string | number][]) {
        const r = ws.addRow([`  ${label}`, value]);
        r.getCell(1).font = LABEL_FONT;
        r.getCell(2).font = VALUE_FONT;
      }
    }
    const noteRow2 = ws.addRow([
      "  【Test15】前四半期PD稼働率・VAP商品開発スコア",
      "Standard AIはまだ本項目を参照していない（#05対応待ち）",
    ]);
    noteRow2.getCell(1).font = LABEL_FONT;
    noteRow2.getCell(2).font = VALUE_FONT;
  }
  ws.addRow([]);
  const marketNoteRow = ws.addRow([
    "市場情報（公開情報のみ）は「Market」相当のデータをそのまま参照してください。本シートは会社別state部分の抜粋です。",
  ]);
  marketNoteRow.getCell(1).font = LABEL_FONT;
}

// =====================================================================
// 【Test15】追加シート群
//
// 参考ブック（BAL_Test14_turn2_databook.xlsx / Sample Test13_GM分析ブック_turn4.xlsx）の
// シート構成・列順・数式を踏襲して実装する。これらの参考ブックはPython/openpyxlで
// 後処理して作られていたため、同じ内容をこのTypeScript側の生成器へ取り込み、
// ゲーム画面から直接ダウンロードできるようにする。
//
// 【この追加分がやらないこと】
//   - Export JSON に存在しない値を推測・按分しない。商品別に配賦ルールが存在しない
//     費目は「共通費・商品別非配賦」として明示し、商品列を空欄のままにする。
//   - 数量0での除算をしない（kg単価は safeUnitCostPerKg 経由でのみ算出する）。
// =====================================================================

/**
 * kgあたり単価 = 金額 ÷ (トン数 × 1000)。
 * トン数が0・負・非有限のときは undefined を返す（NaN/Infinityをシートへ書かない）。
 */
function safeUnitCostPerKg(totalUsd: number, quantityTons: number): number | undefined {
  if (!Number.isFinite(totalUsd) || !Number.isFinite(quantityTons) || quantityTons <= 0) return undefined;
  const kg = quantityTons * 1000;
  if (kg <= 0) return undefined;
  const v = totalUsd / kg;
  return Number.isFinite(v) ? v : undefined;
}

const PRODUCT_KEYS = ["hoso", "pd", "vap"] as const;
type ProductKey = (typeof PRODUCT_KEYS)[number];

/**
 * 【Test15新規】製造原価計算書シート。
 *
 * 商品別（HOSO/PD/VAP）に「製造数量(t)・製造原価合計(USD)・製造原価(USD/kg)」を必ず出す
 * （三宅さんの指示B-2）。内訳のうち商品別に帰属・配賦できるものだけを商品列へ書き、
 * Export APIに商品別内訳が存在しない費目（材料費・遊休労務費・臨時工費・残業費・再加工費）は
 * 勝手に按分せず「IV. 共通費（商品別非配賦）」として会社合計のみを書く。
 */
function writeManufacturingCostSheet(wb: ExcelJS.Workbook, payload: CompanyExportPayload): void {
  const ws = wb.addWorksheet("製造原価計算書");
  ws.columns = [{ width: 62 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 20 }, { width: 18 }];

  const financial = payload.financialResult;
  const summary = payload.companySummary;
  if (!financial || !summary) {
    ws.addRow(["このターン・会社の財務結果または会社サマリーがAPI上に存在しないため、商品別製造原価を作成できません（データ未作成）"]).getCell(1).font = LABEL_FONT;
    // 商品別製造原価が作れなくても、調達・納入・期末在庫は独立に取得できるため必ず出す。
    appendManufacturingCostManagementSections(ws, payload);
    return;
  }
  const mc = financial.manufacturingCost;
  if (!mc) {
    ws.addRow(["このターン・会社の製造原価内訳（manufacturingCost）がAPI上に存在しません（データ未作成）"]).getCell(1).font = LABEL_FONT;
    appendManufacturingCostManagementSections(ws, payload);
    return;
  }

  const producedByProduct: Readonly<Record<ProductKey, number>> = {
    hoso: summary.hosoProduced,
    pd: summary.pdProduced,
    vap: summary.vapProduced,
  };
  const totalProduced = PRODUCT_KEYS.reduce((s, p) => s + producedByProduct[p], 0);

  writeHeaderRow(ws, ["科目", "HOSO", "PD", "VAP", "共通（商品別非配賦）", "会社合計"]);

  const qtyRow = ws.addRow(["生産数量 (t)", producedByProduct.hoso, producedByProduct.pd, producedByProduct.vap, null, totalProduced]);
  qtyRow.getCell(1).font = LABEL_FONT;
  for (const c of [2, 3, 4, 6]) qtyRow.getCell(c).numFmt = "#,##0.00";

  ws.addRow([]);

  // --- I. 加工費 ---
  ws.addRow(["I. 加工費（Processing Cost）"]).getCell(1).font = CHECK_FONT;
  // HOSO基礎相当加工費は全商品へ同一単価で適用され、生産量比で配賦される
  // （原価計算エンジンのルール。ここで按分率を発明していない）。
  const baseProcessingByProduct = PRODUCT_KEYS.map((p) =>
    totalProduced > 0 ? (mc.hosoProcessingCost * producedByProduct[p]) / totalProduced : 0
  );
  const baseRow = ws.addRow([
    "HOSO基礎相当加工費（全商品へ同一単価。生産量比で配賦）",
    baseProcessingByProduct[0],
    baseProcessingByProduct[1],
    baseProcessingByProduct[2],
    null,
    mc.hosoProcessingCost,
  ]);
  const addRow = ws.addRow([
    "PD/VAP追加加工費（商品へ直接帰属）",
    0,
    mc.pdAdditionalProcessingCost,
    mc.vapAdditionalProcessingCost,
    null,
    mc.pdAdditionalProcessingCost + mc.vapAdditionalProcessingCost,
  ]);
  const processingTotalRow = ws.addRow(["加工費合計 (I)", null, null, null, null, null]);
  for (const col of [2, 3, 4, 6]) {
    const L = colLetter(col);
    processingTotalRow.getCell(col).value = { formula: `${L}${baseRow.number}+${L}${addRow.number}` };
  }
  processingTotalRow.font = CHECK_FONT;

  // --- II. ユーティリティ変動費 ---
  ws.addRow([]);
  ws.addRow(["II. ユーティリティ変動費（全商品へ同一単価。生産量比で配賦）"]).getCell(1).font = CHECK_FONT;
  const utilityByProduct = PRODUCT_KEYS.map((p) =>
    totalProduced > 0 ? (mc.utilityVariableCost * producedByProduct[p]) / totalProduced : 0
  );
  const utilityRow = ws.addRow([
    "ユーティリティ変動費 (II)",
    utilityByProduct[0],
    utilityByProduct[1],
    utilityByProduct[2],
    null,
    mc.utilityVariableCost,
  ]);

  // --- III. 配賦済み直接固定費 ---
  ws.addRow([]);
  ws.addRow([
    "III. 配賦済み直接固定費（労務費生産分は実配属人数比、工場固定費等は加工度ウェイト付き数量比。エンジンの配賦結果をそのまま転記）",
  ]).getCell(1).font = CHECK_FONT;
  const byProduct = financial.contributionMargin?.byProduct ?? [];
  const directFixedByProduct = PRODUCT_KEYS.map((p) => byProduct.find((d) => d.key === p)?.directFixedCost ?? 0);
  const directFixedRow = ws.addRow([
    "配賦済み直接固定費 (III)",
    directFixedByProduct[0],
    directFixedByProduct[1],
    directFixedByProduct[2],
    null,
    directFixedByProduct.reduce((s, v) => s + v, 0),
  ]);

  // --- 商品別 製造原価合計・kg単価 ---
  ws.addRow([]);
  const productTotalRow = ws.addRow(["商品別 製造原価合計 (I+II+III)", null, null, null, null, null]);
  for (const col of [2, 3, 4, 6]) {
    const L = colLetter(col);
    productTotalRow.getCell(col).value = {
      formula: `${L}${processingTotalRow.number}+${L}${utilityRow.number}+${L}${directFixedRow.number}`,
    };
  }
  productTotalRow.font = CHECK_FONT;

  // kg単価は必ず「製造原価合計 ÷ (製造数量t × 1000)」。生産数量0の商品は「－」を書く
  // （safeUnitCostPerKgがundefinedを返すため、NaN・Infinityがセルへ入ることはない）。
  // 数式ではなく実数値を書くのは、生成後のブックを読み直すだけで単価を検証できるようにするため。
  const productTotalsUsd = PRODUCT_KEYS.map(
    (p, i) => baseProcessingByProduct[i] + (p === "pd" ? mc.pdAdditionalProcessingCost : p === "vap" ? mc.vapAdditionalProcessingCost : 0) + utilityByProduct[i] + directFixedByProduct[i]
  );
  const unitRow = ws.addRow(["　うち kgあたり製造原価 (USD/kg)", null, null, null, null, null]);
  for (const [idx, col] of [2, 3, 4].entries()) {
    const unit = safeUnitCostPerKg(productTotalsUsd[idx], producedByProduct[PRODUCT_KEYS[idx]]);
    if (unit === undefined) {
      unitRow.getCell(col).value = "－（生産数量0のため算出不可）";
    } else {
      unitRow.getCell(col).value = unit;
      unitRow.getCell(col).numFmt = "0.0000";
    }
  }
  const totalUnit = safeUnitCostPerKg(
    productTotalsUsd.reduce((s, v) => s + v, 0),
    totalProduced
  );
  if (totalUnit === undefined) {
    unitRow.getCell(6).value = "－（生産数量0のため算出不可）";
  } else {
    unitRow.getCell(6).value = totalUnit;
    unitRow.getCell(6).numFmt = "0.0000";
  }

  // --- IV. 共通費（商品別非配賦） ---
  ws.addRow([]);
  ws.addRow(["IV. 共通費（Export APIに商品別内訳が存在しないため、按分せず会社合計のみ表示）"]).getCell(1).font = CHECK_FONT;
  const commonRows: readonly (readonly [string, number])[] = [
    ["材料費－国内 (domesticRawMaterialCost)", mc.domesticRawMaterialCost],
    ["材料費－輸入 (importedRawMaterialCost)", mc.importedRawMaterialCost],
    ["材料費－養殖 (aquacultureRawMaterialCost)", mc.aquacultureRawMaterialCost],
    ["遊休労務費 (idleLaborCost)：エンジンの設計上、どの商品にも配賦しない", mc.idleLaborCost],
    ["臨時工費 (temporaryWorkerCost)", mc.temporaryWorkerCost],
    ["残業費 (overtimeCost)", mc.overtimeCost],
    ["再加工費 (reworkCost)", mc.reworkCost],
  ];
  const commonFirstRow = ws.rowCount + 1;
  for (const [label, value] of commonRows) {
    const r = ws.addRow([label, null, null, null, value, null]);
    r.getCell(1).font = LABEL_FONT;
    r.getCell(5).numFmt = USD_FORMAT;
  }
  const commonLastRow = ws.rowCount;
  const commonTotalRow = ws.addRow(["共通費合計 (IV)", null, null, null, null, null]);
  commonTotalRow.getCell(5).value = { formula: `SUM(E${commonFirstRow}:E${commonLastRow})` };
  commonTotalRow.font = CHECK_FONT;

  // --- 当期総製造費用と検算 ---
  ws.addRow([]);
  const grandTotalRow = ws.addRow(["当期総製造費用（Σ商品別合計 ＋ 共通費合計）", null, null, null, null, null]);
  grandTotalRow.getCell(6).value = { formula: `F${productTotalRow.number}+E${commonTotalRow.number}` };
  grandTotalRow.font = CHECK_FONT;

  const referenceTotal =
    mc.domesticRawMaterialCost + mc.importedRawMaterialCost + mc.aquacultureRawMaterialCost +
    mc.idleLaborCost + mc.temporaryWorkerCost + mc.overtimeCost + mc.reworkCost +
    mc.hosoProcessingCost + mc.pdAdditionalProcessingCost + mc.vapAdditionalProcessingCost +
    mc.utilityVariableCost + directFixedByProduct.reduce((s, v) => s + v, 0);
  const refRow = ws.addRow(["参照値（同じ費目をExport JSONから独立に再集計）", null, null, null, null, referenceTotal]);
  refRow.getCell(6).numFmt = USD_FORMAT;
  const diffRow = ws.addRow(["差額（0であることを確認）", null, null, null, null, null]);
  diffRow.getCell(6).value = { formula: `F${grandTotalRow.number}-F${refRow.number}` };
  diffRow.font = CHECK_FONT;

  for (const col of [2, 3, 4, 5, 6]) {
    ws.getColumn(col).numFmt = ws.getColumn(col).numFmt ?? USD_FORMAT;
  }

  ws.addRow([]);
  const note = ws.addRow([
    "注記: 加工費・ユーティリティ変動費は「全商品へ同一の$/t単価を適用し、生産量比で配賦する」という原価計算エンジン（finance/quarterClose.ts）のルールに基づいて配賦しています（推計ではありません）。配賦済み直接固定費は同エンジンのcontributionMargin.byProduct[].directFixedCostをそのまま転記しています。材料費・遊休労務費・臨時工費・残業費・再加工費は、Export API（/api/v2/exports/**）が商品別内訳を公開していないため、按分せず共通費として表示しています。kgあたり製造原価は必ず「製造原価合計 ÷ (製造数量t × 1000)」で算出し、生産数量0の商品は「－」と表示します（NaN・Infinityを書きません）。",
  ]);
  note.getCell(1).font = LABEL_FONT;
  note.getCell(1).alignment = { wrapText: true, vertical: "top" };

  // 【Test15管理会計】原料調達（調達元別）・商品別実納入量・商品別期末在庫評価を追記する。
  appendManufacturingCostManagementSections(ws, payload);
}

/** 1始まりの列番号をExcelの列記号（A, B, ... AA）へ変換する。 */
function colLetter(col: number): string {
  let n = col;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * 【Test15新規】生データ_成約明細シート。参考ブックの16列構成をそのまま踏襲する。
 * 販売数量分析シートがこのシートをSUMIFSで参照するため、列位置は変更しないこと。
 */
function writeRawAllocationDetailSheet(wb: ExcelJS.Workbook, payload: CompanyExportPayload): void {
  const ws = wb.addWorksheet("生データ_成約明細");
  ws.columns = [
    { width: 8 }, { width: 8 }, { width: 15 }, { width: 15 }, { width: 14 }, { width: 14 },
    { width: 14 }, { width: 15 }, { width: 12 }, { width: 13 }, { width: 13 }, { width: 18 },
    { width: 12 }, { width: 14 }, { width: 11 }, { width: 11 },
  ];
  writeHeaderRow(ws, [
    "市場", "商品", "基準価格(USD/kg)", "対象需要(t)", "外部流出(t)", "販売希望量(t)",
    "価格調整(USD/kg)", "提示価格(USD/kg)", "営業人員(人)", "成約量(t)", "未成約量(t)", "成約金額相当(USD)",
    "カバレッジ", "競争力ウェイト", "成約率", "シェア",
  ]);
  const planByKey = new Map(payload.salesPlans.map((p) => [`${p.market} ${p.product}`, p]));
  let rowCount = 0;
  for (const allocation of payload.marketProductAllocations) {
    const own = allocation.companies[0] ?? null;
    const plan = planByKey.get(`${allocation.market} ${allocation.product}`) ?? null;
    if (!own && !plan) continue;
    const row = ws.addRow([
      allocation.market, allocation.product, allocation.basePrice, allocation.targetDemand, allocation.externalOptionQuantity,
      plan ? plan.desiredQuantity : null,
      plan ? plan.priceAdjustmentUsdPerHosoEqKg : null,
      own ? own.askPrice : null,
      plan ? plan.salesForceHeadcount : null,
      own ? own.allocatedQuantity : null,
      null, null,
      own ? own.coverageScore : null,
      own ? own.competitivenessWeight : null,
      null, null,
    ]);
    const r = row.number;
    row.getCell(11).value = { formula: `IF(F${r}="","",F${r}-J${r})` };
    row.getCell(12).value = { formula: `IF(OR(H${r}="",J${r}=""),"",J${r}*H${r}*1000)` };
    // 成約率＝成約量÷販売希望量、シェア＝成約量÷対象需要。分母0のときは空欄。
    row.getCell(15).value = { formula: `IF(OR(F${r}="",F${r}=0),"",J${r}/F${r})` };
    row.getCell(16).value = { formula: `IF(OR(D${r}="",D${r}=0),"",J${r}/D${r})` };
    for (const col of [3, 7, 8]) row.getCell(col).numFmt = "$#,##0.0000";
    for (const col of [4, 5, 6, 10, 11]) row.getCell(col).numFmt = "#,##0.00";
    row.getCell(12).numFmt = USD_FORMAT;
    for (const col of [13, 14, 15, 16]) row.getCell(col).numFmt = "0.0000";
    rowCount += 1;
  }
  if (rowCount === 0) {
    ws.addRow(["このターン・会社の販売計画および成約配分は0件です"]).getCell(1).font = LABEL_FONT;
  }
}

/**
 * 【Test15新規】販売数量分析シート。生データ_成約明細をSUMIFSで市場×商品へ集計する。
 * Excelネイティブのピボットテーブルではなく数式による集計表（参考ブックと同じ方式。
 * 生データ側へ行を足しても列全体参照が自動で拾うため再集計操作が要らない）。
 */
function writeSalesVolumeAnalysisSheet(wb: ExcelJS.Workbook, payload: CompanyExportPayload): void {
  const ws = wb.addWorksheet("販売数量分析");
  ws.columns = [{ width: 16 }, { width: 16 }, { width: 16 }, { width: 15 }, { width: 13 }, { width: 14 }];

  const markets: string[] = [];
  for (const a of payload.marketProductAllocations) {
    if (!markets.includes(a.market)) markets.push(a.market);
  }

  ws.addRow(["市場×商品ごとの販売数量分析（生データ_成約明細シートをSUMIFSで集計）"]).getCell(1).font = CHECK_FONT;
  ws.addRow([]);
  writeHeaderRow(ws, ["行ラベル", "対象需要(t)", "販売希望量(t)", "成約量(t)", "市場シェア", "成約成功率"]);

  const SRC = "生データ_成約明細";
  const marketTotalRows: number[] = [];
  for (const market of markets) {
    const marketRow = ws.addRow([market, null, null, null, null, null]);
    marketRow.font = CHECK_FONT;
    const marketRowNumber = marketRow.number;
    marketTotalRows.push(marketRowNumber);

    const productRowNumbers: number[] = [];
    for (const product of PRODUCT_KEYS) {
      const pr = ws.addRow([`  ${product}`, null, null, null, null, null]);
      const n = pr.number;
      productRowNumbers.push(n);
      // 対象需要・販売希望量・成約量を、市場（A列）と商品（B列）でSUMIFS集計する。
      pr.getCell(2).value = { formula: `SUMIFS('${SRC}'!$D:$D,'${SRC}'!$A:$A,$A${marketRowNumber},'${SRC}'!$B:$B,"${product}")` };
      pr.getCell(3).value = { formula: `SUMIFS('${SRC}'!$F:$F,'${SRC}'!$A:$A,$A${marketRowNumber},'${SRC}'!$B:$B,"${product}")` };
      pr.getCell(4).value = { formula: `SUMIFS('${SRC}'!$J:$J,'${SRC}'!$A:$A,$A${marketRowNumber},'${SRC}'!$B:$B,"${product}")` };
      pr.getCell(5).value = { formula: `IF(B${n}=0,"",D${n}/B${n})` };
      pr.getCell(6).value = { formula: `IF(C${n}=0,"",D${n}/C${n})` };
      for (const col of [2, 3, 4]) pr.getCell(col).numFmt = "#,##0.00";
      for (const col of [5, 6]) pr.getCell(col).numFmt = "0.0000";
    }
    const first = productRowNumbers[0];
    const last = productRowNumbers[productRowNumbers.length - 1];
    for (const col of [2, 3, 4]) {
      marketRow.getCell(col).value = { formula: `SUM(${colLetter(col)}${first}:${colLetter(col)}${last})` };
      marketRow.getCell(col).numFmt = "#,##0.00";
    }
    marketRow.getCell(5).value = { formula: `IF(B${marketRowNumber}=0,"",D${marketRowNumber}/B${marketRowNumber})` };
    marketRow.getCell(6).value = { formula: `IF(C${marketRowNumber}=0,"",D${marketRowNumber}/C${marketRowNumber})` };
    for (const col of [5, 6]) marketRow.getCell(col).numFmt = "0.0000";
  }

  if (marketTotalRows.length > 0) {
    const grand = ws.addRow(["総計", null, null, null, null, null]);
    const gn = grand.number;
    for (const col of [2, 3, 4]) {
      const L = colLetter(col);
      grand.getCell(col).value = { formula: marketTotalRows.map((r) => `${L}${r}`).join("+") };
      grand.getCell(col).numFmt = "#,##0.00";
    }
    grand.getCell(5).value = { formula: `IF(B${gn}=0,"",D${gn}/B${gn})` };
    grand.getCell(6).value = { formula: `IF(C${gn}=0,"",D${gn}/C${gn})` };
    for (const col of [5, 6]) grand.getCell(col).numFmt = "0.0000";
    grand.font = CHECK_FONT;
  } else {
    ws.addRow(["集計対象の成約明細が0件です"]).getCell(1).font = LABEL_FONT;
  }

  ws.addRow([]);
  const note = ws.addRow([
    "注記: Excelネイティブのピボットテーブルではなく、SUMIFS数式による集計表です。生データ_成約明細シートに行を追加した場合も、列全体参照（$D:$D等）が自動的に拾うため再集計の操作は不要です。分母が0の比率は空欄になります（ゼロ除算エラーを出しません）。",
  ]);
  note.getCell(1).font = LABEL_FONT;
  note.getCell(1).alignment = { wrapText: true, vertical: "top" };
}

// ---------------------------------------------------------------------
// 【Test15】Turn履歴（推移サマリー / 04_Turn推移）
// ---------------------------------------------------------------------

/** 会社スコープの履歴1件（Turn別のExport JSON）。turn昇順で渡すこと。 */
export interface CompanyTurnHistoryEntry {
  readonly turn: number;
  readonly period: string;
  readonly payload: CompanyExportPayload;
}

/** 全社スコープの履歴1件（Turn別のExport JSON）。turn昇順で渡すこと。 */
export interface AllCompaniesTurnHistoryEntry {
  readonly turn: number;
  readonly period: string;
  readonly payload: AllCompaniesExportPayload;
}

/** 推移シートで横比較するKPIの定義（1行ぶん）。値が取れないturnはnull（0で埋めない）。 */
interface TrendMetric {
  readonly label: string;
  readonly numFmt: string;
  readonly pick: (p: CompanyExportPayload) => number | null;
}

const TREND_METRICS: readonly TrendMetric[] = [
  { label: "【損益】純売上高", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.profitAndLoss.netRevenue ?? null },
  { label: "【損益】売上原価", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.profitAndLoss.totalCostOfSales ?? null },
  { label: "【損益】売上総利益", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.profitAndLoss.grossProfit ?? null },
  { label: "【損益】営業利益", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.profitAndLoss.operatingProfit ?? null },
  { label: "【損益】当期純利益", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.profitAndLoss.netIncome ?? null },
  { label: "【損益】うち遊休労務費", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.profitAndLoss.costOfSales.idleLaborCost ?? null },
  { label: "【BS】期末現金", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.balanceSheet.cash ?? null },
  { label: "【BS】売掛金", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.balanceSheet.accountsReceivable ?? null },
  { label: "【BS】原料在庫(簿価)", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.balanceSheet.rawMaterialInventory ?? null },
  { label: "【BS】完成品在庫(簿価)", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.balanceSheet.finishedGoodsInventory ?? null },
  { label: "【BS】固定資産純額", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.balanceSheet.fixedAssetsNet ?? null },
  { label: "【BS】建設中勘定", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.balanceSheet.constructionInProgress ?? null },
  { label: "【BS】総資産", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.balanceSheet.totalAssets ?? null },
  { label: "【BS】短期借入金", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.balanceSheet.shortTermLoans ?? null },
  { label: "【BS】長期借入金", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.balanceSheet.longTermLoans ?? null },
  { label: "【BS】純資産", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.balanceSheet.totalEquity ?? null },
  { label: "【CF】営業CF", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.cashFlow.operatingCashFlow ?? null },
  { label: "【CF】投資CF", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.cashFlow.investingCashFlow ?? null },
  { label: "【CF】財務CF", numFmt: USD_FORMAT, pick: (p) => p.financialResult?.cashFlow.financingCashFlow ?? null },
  { label: "【資金】信用スコア", numFmt: "0.00", pick: (p) => p.financingResult?.creditScore.score0to100 ?? null },
  { label: "【資金】追加借入可能額", numFmt: USD_FORMAT, pick: (p) => p.financingResult?.borrowingCapacity.availableAdditionalCapacityUsd ?? null },
  { label: "【営業】新規成約数量(t)", numFmt: "#,##0.00", pick: (p) => p.companySummary?.newContractedQuantity ?? null },
  { label: "【営業】新規成約平均価格(USD/kg)", numFmt: "0.0000", pick: (p) => p.companySummary?.newContractedAveragePrice ?? null },
  { label: "【営業】納品数量(t)", numFmt: "#,##0.00", pick: (p) => p.companySummary?.fulfilledQuantity ?? null },
  { label: "【営業】期末受注残(t)", numFmt: "#,##0.00", pick: (p) => p.companySummary?.outstandingQuantity ?? null },
  { label: "【生産】HOSO生産量(t)", numFmt: "#,##0.00", pick: (p) => p.companySummary?.hosoProduced ?? null },
  { label: "【生産】PD生産量(t)", numFmt: "#,##0.00", pick: (p) => p.companySummary?.pdProduced ?? null },
  { label: "【生産】VAP生産量(t)", numFmt: "#,##0.00", pick: (p) => p.companySummary?.vapProduced ?? null },
  { label: "【生産】期末完成品在庫(t)", numFmt: "#,##0.00", pick: (p) => p.companySummary?.finishedGoodsInventory ?? null },
  { label: "【原料】期末原料在庫(t)", numFmt: "#,##0.00", pick: (p) => p.companySummary?.rawMaterialInventory ?? null },
  { label: "【原料】国内買付数量(t)", numFmt: "#,##0.00", pick: (p) => p.companySummary?.domesticPurchaseQuantity ?? null },
  { label: "【稼働】設備稼働率", numFmt: "0.0000", pick: (p) => p.companySummary?.equipmentUtilizationRate ?? null },
  { label: "【稼働】労働稼働率", numFmt: "0.0000", pick: (p) => p.companySummary?.laborUtilizationRate ?? null },
  { label: "【稼働】原料不足による機会損失(t)", numFmt: "#,##0.00", pick: (p) => p.companySummary?.rawMaterialShortfall ?? null },
  { label: "【稼働】設備能力不足による機会損失(t)", numFmt: "#,##0.00", pick: (p) => p.companySummary?.equipmentShortfall ?? null },
  { label: "【稼働】労働力不足による機会損失(t)", numFmt: "#,##0.00", pick: (p) => p.companySummary?.laborShortfall ?? null },
];

/**
 * 【Test15新規】推移サマリーシート（自社ブック）。
 * 行＝KPI、列＝Turn。Turn別の明細シートを増殖させず、時系列を1シートへまとめる。
 * historyが空（履歴が取得できなかった）場合でも例外を投げず、その旨の行だけを書く。
 */
function writeCompanyTrendSheet(wb: ExcelJS.Workbook, history: readonly CompanyTurnHistoryEntry[]): void {
  const ws = wb.addWorksheet("推移サマリー");
  const sorted = [...history].sort((a, b) => a.turn - b.turn);
  ws.columns = [{ width: 38 }, ...sorted.map(() => ({ width: 18 }))];

  if (sorted.length === 0) {
    ws.addRow(["Turn履歴が取得できなかったため、推移サマリーを作成できません（このシートは空です。他のシートは通常どおり利用できます）"]).getCell(1).font = LABEL_FONT;
    return;
  }

  writeHeaderRow(ws, ["指標", ...sorted.map((h) => `Turn ${h.turn}`)]);
  const periodRow = ws.addRow(["期(period)", ...sorted.map((h) => h.period)]);
  periodRow.getCell(1).font = LABEL_FONT;

  for (const metric of TREND_METRICS) {
    const row = ws.addRow([metric.label, ...sorted.map((h) => metric.pick(h.payload))]);
    row.getCell(1).font = LABEL_FONT;
    for (let i = 0; i < sorted.length; i++) {
      const cell = row.getCell(i + 2);
      if (cell.value === null || cell.value === undefined) cell.value = "－";
      else cell.numFmt = metric.numFmt;
    }
  }

  ws.addRow([]);
  const note = ws.addRow([
    "注記: 行＝指標、列＝Turn（昇順）です。値が存在しないTurnは「－」と表示し、0で埋めていません。各Turnの値は、そのTurnのExport API JSONをそのまま転記したものです（このシートで再計算していません）。",
  ]);
  note.getCell(1).font = LABEL_FONT;
  note.getCell(1).alignment = { wrapText: true, vertical: "top" };
}

// ---------------------------------------------------------------------
// 【Test15】GM分析ブック 参考4シート（00_凡例 / 01_全社比較 / 02_市場シェア / 03_全社の意思決定）
// ---------------------------------------------------------------------

/** 01_全社比較で使うKPI（全社横並び）。値が無ければnull。 */
interface CrossCompanyMetric {
  readonly label: string;
  readonly numFmt: string;
  readonly pick: (c: AllCompaniesExportPayload["companies"][number]) => number | string | null;
}

const CROSS_COMPANY_SECTIONS: readonly { readonly heading: string; readonly metrics: readonly CrossCompanyMetric[] }[] = [
  {
    heading: "損益（USD）",
    metrics: [
      { label: "純売上高", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.profitAndLoss.netRevenue ?? null },
      { label: "売上原価", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.profitAndLoss.totalCostOfSales ?? null },
      { label: "売上総利益", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.profitAndLoss.grossProfit ?? null },
      { label: "販管費", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.profitAndLoss.sellingGeneralAdmin ?? null },
      { label: "営業利益", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.profitAndLoss.operatingProfit ?? null },
      { label: "当期純利益", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.profitAndLoss.netIncome ?? null },
      { label: "うち遊休労務費", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.profitAndLoss.costOfSales.idleLaborCost ?? null },
    ],
  },
  {
    heading: "財務（USD）",
    metrics: [
      { label: "期末現金", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.balanceSheet.cash ?? null },
      { label: "総資産", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.balanceSheet.totalAssets ?? null },
      { label: "純資産", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.balanceSheet.totalEquity ?? null },
      { label: "短期借入金", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.balanceSheet.shortTermLoans ?? null },
      { label: "長期借入金", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.balanceSheet.longTermLoans ?? null },
      { label: "営業CF", numFmt: USD_FORMAT, pick: (c) => c.financialResult?.cashFlow.operatingCashFlow ?? null },
      { label: "信用スコア", numFmt: "0.00", pick: (c) => c.financingResult?.creditScore.score0to100 ?? null },
      { label: "信用区分", numFmt: "@", pick: (c) => c.financingResult?.creditScore.tier ?? null },
      { label: "追加借入可能額", numFmt: USD_FORMAT, pick: (c) => c.financingResult?.borrowingCapacity.availableAdditionalCapacityUsd ?? null },
    ],
  },
  {
    heading: "営業・生産（トン）",
    metrics: [
      { label: "新規成約数量", numFmt: "#,##0.00", pick: (c) => c.companySummary?.newContractedQuantity ?? null },
      { label: "新規成約平均価格(USD/kg)", numFmt: "0.0000", pick: (c) => c.companySummary?.newContractedAveragePrice ?? null },
      { label: "納品数量", numFmt: "#,##0.00", pick: (c) => c.companySummary?.fulfilledQuantity ?? null },
      { label: "期末受注残", numFmt: "#,##0.00", pick: (c) => c.companySummary?.outstandingQuantity ?? null },
      { label: "HOSO生産量", numFmt: "#,##0.00", pick: (c) => c.companySummary?.hosoProduced ?? null },
      { label: "PD生産量", numFmt: "#,##0.00", pick: (c) => c.companySummary?.pdProduced ?? null },
      { label: "VAP生産量", numFmt: "#,##0.00", pick: (c) => c.companySummary?.vapProduced ?? null },
      { label: "期末原料在庫(即時利用可)", numFmt: "#,##0.00", pick: (c) => c.companySummary?.rawMaterialInventory ?? null },
      { label: "期末完成品在庫", numFmt: "#,##0.00", pick: (c) => c.companySummary?.finishedGoodsInventory ?? null },
      { label: "設備稼働率", numFmt: "0.0000", pick: (c) => c.companySummary?.equipmentUtilizationRate ?? null },
      { label: "VAP商品開発スコア", numFmt: "0.00", pick: (c) => c.vapProductDevelopmentScore },
    ],
  },
];

/** 00_凡例シート（GMブックの先頭。取扱注意の警告を必ず出す）。 */
function writeGmLegendSheet(wb: ExcelJS.Workbook, payload: AllCompaniesExportPayload): void {
  const ws = wb.addWorksheet("00_凡例");
  ws.columns = [{ width: 120 }];
  const title = ws.addRow(["GM（ゲームマスター）用 分析ブック — 取扱注意"]);
  title.getCell(1).font = { ...CHECK_FONT, size: 14 };
  ws.addRow([]);
  const warn = ws.addRow(["このブックには全5社の非公開の意思決定が含まれます。プレイヤーへ配布しないでください。"]);
  warn.getCell(1).font = { ...CHECK_FONT, color: { argb: "FFC00000" } };
  ws.addRow([]);
  ws.addRow([`ラボ: ${payload.meta.labId}　／　対象: Turn ${payload.meta.turn}（${payload.meta.period}）　／　エンジン版: ${payload.meta.engineVersion}`]);
  ws.addRow([`Export生成日時(UTC): ${payload.meta.generatedAt}`]);
  ws.addRow([`収録会社: ${payload.companies.map((c) => c.companyId).join(", ")}`]);
  ws.addRow([]);
  ws.addRow(["「－」… データなし（0ではありません）。値が存在しない項目を0で埋めていません。"]);
  ws.addRow(["データ入力元: Export API JSON（全社スコープ）のみ。Redis・Repository・画面表示値は参照していません。"]);
  ws.addRow([]);
  ws.addRow(["シート構成: 00_凡例 / 01_全社比較 / 02_市場シェア / 03_全社の意思決定 / 04_Turn推移 / Meta / Capacity_各社 / 生産・設備・労務 / 意思決定項目 / StandardAI入力"]);
}

/** 01_全社比較シート（行＝指標、列＝会社）。 */
function writeGmCrossCompanySheet(wb: ExcelJS.Workbook, payload: AllCompaniesExportPayload): void {
  const ws = wb.addWorksheet("01_全社比較");
  const companies = [...payload.companies].sort((a, b) => a.companyId.localeCompare(b.companyId));
  ws.columns = [{ width: 32 }, ...companies.map(() => ({ width: 20 }))];

  ws.addRow([`全社比較（${payload.meta.period}・Turn ${payload.meta.turn}）`]).getCell(1).font = { ...CHECK_FONT, size: 13 };
  ws.addRow([]);
  writeHeaderRow(ws, ["指標", ...companies.map((c) => c.companyId)]);

  for (const section of CROSS_COMPANY_SECTIONS) {
    const head = ws.addRow([section.heading]);
    head.getCell(1).font = CHECK_FONT;
    const sectionRowNumbers = new Map<string, number>();
    for (const metric of section.metrics) {
      const row = ws.addRow([metric.label, ...companies.map((c) => metric.pick(c))]);
      row.getCell(1).font = LABEL_FONT;
      sectionRowNumbers.set(metric.label, row.number);
      for (let i = 0; i < companies.length; i++) {
        const cell = row.getCell(i + 2);
        if (cell.value === null || cell.value === undefined) cell.value = "－";
        else if (metric.numFmt !== "@") cell.numFmt = metric.numFmt;
      }
    }
    // 損益セクションだけ、利益率をExcel数式として追加する（参考ブックと同じ）。
    if (section.heading.startsWith("損益")) {
      const netRevenueRow = sectionRowNumbers.get("純売上高");
      const grossProfitRow = sectionRowNumbers.get("売上総利益");
      const operatingProfitRow = sectionRowNumbers.get("営業利益");
      if (netRevenueRow && grossProfitRow && operatingProfitRow) {
        for (const [label, numeratorRow] of [
          ["　売上総利益率", grossProfitRow],
          ["　営業利益率", operatingProfitRow],
        ] as const) {
          const r = ws.addRow([label]);
          r.getCell(1).font = LABEL_FONT;
          for (let i = 0; i < companies.length; i++) {
            const L = colLetter(i + 2);
            r.getCell(i + 2).value = { formula: `IF(OR(${L}${netRevenueRow}="－",${L}${netRevenueRow}=0),"－",${L}${numeratorRow}/${L}${netRevenueRow})` };
            r.getCell(i + 2).numFmt = "0.00%";
          }
        }
      }
    }
    ws.addRow([]);
  }
}

/** 02_市場シェアシート（市場×商品×会社の成約結果。全社の提示価格・競争力を含む）。 */
function writeGmMarketShareSheet(wb: ExcelJS.Workbook, payload: AllCompaniesExportPayload): void {
  const ws = wb.addWorksheet("02_市場シェア");
  ws.columns = [
    { width: 8 }, { width: 8 }, { width: 10 }, { width: 16 }, { width: 16 }, { width: 16 },
    { width: 14 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 13 }, { width: 18 },
  ];
  ws.addRow([`市場×商品ごとの5社成約結果（${payload.meta.period}・Turn ${payload.meta.turn}）`]).getCell(1).font = { ...CHECK_FONT, size: 13 };
  writeHeaderRow(ws, [
    "市場", "商品", "会社", "基準価格(USD/kg)", "提示価格(USD/kg)", "対象需要(t)",
    "外部流出(t)", "営業処理能力(t)", "競争力ウェイト", "成約数量(t)", "5社合計(t)", "5社内シェア", "需要に対する取り込み率",
  ]);

  let rowCount = 0;
  for (const allocation of payload.marketProductAllocations) {
    const total = allocation.companies.reduce((s, c) => s + c.allocatedQuantity, 0);
    const sortedCompanies = [...allocation.companies].sort((a, b) => a.companyId.localeCompare(b.companyId));
    for (const c of sortedCompanies) {
      const row = ws.addRow([
        allocation.market, allocation.product, c.companyId,
        allocation.basePrice, c.askPrice, allocation.targetDemand, allocation.externalOptionQuantity,
        c.processingCapacity, c.competitivenessWeight, c.allocatedQuantity, total, null, null,
      ]);
      const r = row.number;
      row.getCell(12).value = { formula: `IF(K${r}=0,"－",J${r}/K${r})` };
      row.getCell(13).value = { formula: `IF(F${r}=0,"－",J${r}/F${r})` };
      for (const col of [4, 5]) row.getCell(col).numFmt = "$#,##0.0000";
      for (const col of [6, 7, 8, 10, 11]) row.getCell(col).numFmt = "#,##0.00";
      for (const col of [9, 12, 13]) row.getCell(col).numFmt = "0.0000";
      rowCount += 1;
    }
  }
  if (rowCount === 0) {
    ws.addRow(["このターンの成約配分は0件です"]).getCell(1).font = LABEL_FONT;
  }
}

/** 03_全社の意思決定シート（営業計画／生産計画／人員配置。非公開情報）。 */
function writeGmAllDecisionsSheet(wb: ExcelJS.Workbook, payload: AllCompaniesExportPayload): void {
  const ws = wb.addWorksheet("03_全社の意思決定");
  ws.columns = [{ width: 10 }, { width: 14 }, { width: 10 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 20 }];

  const submissions = [...payload.decisionInfo.submissions].sort((a, b) => a.companyId.localeCompare(b.companyId));

  ws.addRow([`全社の営業計画（${payload.meta.period}）※非公開情報`]).getCell(1).font = { ...CHECK_FONT, size: 13 };
  writeHeaderRow(ws, ["会社", "市場", "商品", "販売希望量(t)", "価格調整(USD/kg)", "営業人数"]);
  let salesRows = 0;
  for (const s of submissions) {
    const plans = [...s.salesPlans].sort((a, b) => a.market.localeCompare(b.market) || a.product.localeCompare(b.product));
    for (const p of plans) {
      const row = ws.addRow([s.companyId, p.market, p.product, p.desiredQuantity, p.priceAdjustmentUsdPerHosoEqKg, p.salesForceHeadcount]);
      row.getCell(4).numFmt = "#,##0.00";
      row.getCell(5).numFmt = "0.0000";
      salesRows += 1;
    }
  }
  if (salesRows === 0) ws.addRow(["営業計画が0件です"]).getCell(1).font = LABEL_FONT;

  ws.addRow([]);
  ws.addRow([]);
  ws.addRow([`全社の生産計画（${payload.meta.period}）※非公開情報`]).getCell(1).font = { ...CHECK_FONT, size: 13 };
  writeHeaderRow(ws, ["会社", "工場", "商品", "希望生産量(t)", "優先度"]);
  let productionRows = 0;
  for (const s of submissions) {
    const plans = [...s.productionPlans].sort((a, b) => a.factoryId.localeCompare(b.factoryId) || a.product.localeCompare(b.product));
    for (const p of plans) {
      const row = ws.addRow([s.companyId, p.factoryId, p.product, p.desiredQuantity, p.priority]);
      row.getCell(4).numFmt = "#,##0.00";
      productionRows += 1;
    }
  }
  if (productionRows === 0) ws.addRow(["生産計画が0件です"]).getCell(1).font = LABEL_FONT;

  ws.addRow([]);
  ws.addRow([]);
  ws.addRow([`全社の人員配置（${payload.meta.period}）※非公開情報`]).getCell(1).font = { ...CHECK_FONT, size: 13 };
  writeHeaderRow(ws, ["会社", "工場", "正社員(人)", "臨時工(人)", "残業率", "出勤率"]);
  let workerRows = 0;
  for (const s of submissions) {
    const assignments = [...s.workerAssignments].sort((a, b) => a.factoryId.localeCompare(b.factoryId));
    for (const w of assignments) {
      const row = ws.addRow([s.companyId, w.factoryId, w.regularHeadcount, w.temporaryHeadcount, w.overtimeRate, w.attendanceRate]);
      for (const col of [5, 6]) row.getCell(col).numFmt = "0.0000";
      workerRows += 1;
    }
  }
  if (workerRows === 0) ws.addRow(["人員配置が0件です"]).getCell(1).font = LABEL_FONT;
}

/** 04_Turn推移シート（KPIごとに 行＝会社、列＝Turn）。 */
function writeGmTurnTrendSheet(wb: ExcelJS.Workbook, history: readonly AllCompaniesTurnHistoryEntry[]): void {
  const ws = wb.addWorksheet("04_Turn推移");
  const sorted = [...history].sort((a, b) => a.turn - b.turn);
  ws.columns = [{ width: 30 }, { width: 10 }, ...sorted.map(() => ({ width: 18 }))];

  if (sorted.length === 0) {
    ws.addRow(["Turn履歴が取得できなかったため、Turn推移を作成できません（このシートは空です。他のシートは通常どおり利用できます）"]).getCell(1).font = LABEL_FONT;
    return;
  }

  const companyIds = Array.from(new Set(sorted.flatMap((h) => h.payload.companies.map((c) => c.companyId)))).sort();

  ws.addRow(["Turn推移（KPIごとに 行＝会社、列＝Turn）"]).getCell(1).font = { ...CHECK_FONT, size: 13 };
  ws.addRow([]);
  writeHeaderRow(ws, ["指標", "会社", ...sorted.map((h) => `Turn ${h.turn}`)]);

  for (const section of CROSS_COMPANY_SECTIONS) {
    for (const metric of section.metrics) {
      for (const companyId of companyIds) {
        const row = ws.addRow([
          metric.label,
          companyId,
          ...sorted.map((h) => {
            const c = h.payload.companies.find((x) => x.companyId === companyId);
            return c ? metric.pick(c) : null;
          }),
        ]);
        row.getCell(1).font = LABEL_FONT;
        for (let i = 0; i < sorted.length; i++) {
          const cell = row.getCell(i + 3);
          if (cell.value === null || cell.value === undefined) cell.value = "－";
          else if (metric.numFmt !== "@") cell.numFmt = metric.numFmt;
        }
      }
    }
  }

  ws.addRow([]);
  const note = ws.addRow([
    "注記: 各Turnの値は、そのTurnのExport API JSON（全社スコープ）をそのまま転記したものです。値が存在しないTurn・会社は「－」と表示し、0で埋めていません。",
  ]);
  note.getCell(1).font = LABEL_FONT;
}
