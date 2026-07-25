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
import type { CompanyExportPayload } from "../../../../api/v2/exports/_lib/exportDto";

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
  for (const [label, value] of rows) {
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

function writeSalesContractsSheet(wb: ExcelJS.Workbook, salesContracts: CompanyExportPayload["salesContracts"]): void {
  const ws = wb.addWorksheet("Sales Contracts");
  ws.columns = [{ width: 22 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 16 }];
  writeHeaderRow(ws, ["契約ID", "市場", "商品", "成約四半期", "納期", "当初数量", "未履行数量", "単価(USD/kg)", "ステータス"]);
  if (salesContracts.length === 0) {
    const row = ws.addRow(["このターン・会社の契約は0件です（成約なし、またはAPI未対応バージョン）"]);
    row.getCell(1).font = LABEL_FONT;
    return;
  }
  for (const c of salesContracts) {
    const row = ws.addRow([c.contractId, c.market, c.product, c.contractedPeriod, c.dueDate, c.originalQuantity, c.outstandingQuantity, c.unitPrice, c.status]);
    row.getCell(1).font = VALUE_FONT;
    row.getCell(6).numFmt = "#,##0.00";
    row.getCell(7).numFmt = "#,##0.00";
    row.getCell(8).numFmt = "$#,##0.0000";
  }
}

/**
 * Export API（会社スコープ）JSONだけを入力として、Meta/PL/BS/CF/Financing/Capex/
 * Sales Contractsの7シート構成のExcelワークブックを組み立て、Bufferとして返す。
 */
export async function buildCompanyExportExcelWorkbook(payload: CompanyExportPayload): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ShrimpX V2 Company Lab — Export API (自動生成)";
  wb.created = new Date(payload.meta.generatedAt);

  writeMetaSheet(wb, payload);
  if (payload.financialResult) {
    writePlSheet(wb, payload.financialResult);
    const bsCashRowNumber = writeBsSheet(wb, payload.financialResult);
    writeCfSheet(wb, payload.financialResult, bsCashRowNumber);
  } else {
    const plWs = wb.addWorksheet("PL");
    plWs.addRow(["このターン・会社の財務結果はAPI上に存在しません（データ未作成）"]);
    wb.addWorksheet("BS").addRow(["このターン・会社の財務結果はAPI上に存在しません（データ未作成）"]);
    wb.addWorksheet("CF").addRow(["このターン・会社の財務結果はAPI上に存在しません（データ未作成）"]);
  }
  writeFinancingSheet(wb, payload.financingResult);
  writeCapexSheet(wb, payload.capexResult);
  writeSalesContractsSheet(wb, payload.salesContracts);

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
