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
import type {
  AllCompaniesExportPayload,
  CompanyExportPayload,
  ExportCompanyDecision,
  ExportCompanyDecisionInfo,
  ExportCompanySummary,
} from "../../../../api/v2/exports/_lib/exportDto";

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
      writeHeaderRow(ws, ["新規案件種別", "希望投資額(USD)", "優先順位", "", "", "", "", ""]);
      for (const p of cx.newProjectProposals) {
        const row = ws.addRow([p.projectType, p.requestedBudgetUsd ?? "（標準額）", p.priority ?? "（提案順）"]);
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
  writeCompanySummarySheet(wb, payload.companySummary);
  writeProcessingCapacitySheet(wb, payload.processingCapacity);
  writeSalesContractsSheet(wb, payload.salesContracts);
  writeSalesDetailSheet(wb, payload);
  writeMarketSheet(wb, payload.market);
  writeDecisionsSheet(wb, payload.decisionInfo);

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
export async function buildAllCompaniesExportExcelWorkbook(payload: AllCompaniesExportPayload): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ShrimpX V2 Company Lab — Export API (自動生成・GM用)";
  wb.created = new Date(payload.meta.generatedAt);

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
  for (const [label, value] of metaRows) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = LABEL_FONT;
    row.getCell(2).font = VALUE_FONT;
  }

  // 会社ごとに独立したシートを作る（1シートへ混ぜると、どの社の行かが読み取りにくいため）。
  for (const company of payload.companies) {
    writeProcessingCapacitySheet(wb, company.processingCapacity, `Capacity_${company.companyId}`);
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
