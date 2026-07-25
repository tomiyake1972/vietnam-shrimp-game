// ShrimpX V2 — companyLabAdminExcelBuilder.ts のテスト
//
// 合成データ（Export API JSON形状のオブジェクトをテスト内で直接組み立てたもの）を
// 唯一の入力として、シート構成・検算式が正しく組み立てられることを検証する。
// このモジュールはRedis・Repositoryを一切importしていない（tscで確認済み）ため、
// 「Excelの唯一の入力がExport JSONであること」は型レベルでも保証されている。

import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildCompanyExportExcelWorkbook } from "../companyLabAdminExcelBuilder";
import type { CompanyExportPayload } from "../../../../../api/v2/exports/_lib/exportDto";
import type { PeriodV2 } from "../../../core/period";

const PERIOD_2015Q1 = "2015Q1" as PeriodV2;

function buildSyntheticPayload(overrides: Partial<CompanyExportPayload> = {}): CompanyExportPayload {
  const base: CompanyExportPayload = {
    meta: {
      schemaVersion: 1,
      generatedAt: "2026-07-26T00:00:00.000Z",
      labId: "synthetic-lab",
      turn: 1,
      period: PERIOD_2015Q1,
      engineVersion: "test-engine",
      dataStatus: "confirmed",
      scope: { kind: "company", companyId: "BAL" },
    },
    financialResult: {
      companyId: "BAL",
      period: PERIOD_2015Q1,
      profitAndLoss: {
        companyId: "BAL",
        period: PERIOD_2015Q1,
        grossRevenue: 1000,
        qualitySalesDeduction: 10,
        netRevenue: 990,
        costOfSales: {
          rawMaterialCost: 300,
          processingCost: 100,
          laborCost: 80,
          factoryFixedCost: 60,
          reworkCost: 5,
          discardLoss: 3,
          unabsorbedFixedManufacturingCost: 0,
          idleLaborCost: 2,
          capexMaintenanceCost: 0,
        },
        totalCostOfSales: 550,
        grossProfit: 440,
        sellingGeneralAdmin: 100,
        operatingProfit: 340,
        interestExpense: 10,
        profitBeforeTax: 330,
        incomeTax: 30,
        netIncome: 300,
      },
      balanceSheet: {
        companyId: "BAL",
        period: PERIOD_2015Q1,
        cash: 500,
        accountsReceivable: 200,
        rawMaterialInventory: 100,
        finishedGoodsInventory: 100,
        otherCurrentAssets: 50,
        fixedAssetsNet: 800,
        constructionInProgress: 0,
        totalAssets: 1750,
        accountsPayable: 150,
        shortTermLoans: 100,
        longTermLoans: 200,
        accruedInterestPayable: 0,
        otherLiabilities: 50,
        totalLiabilities: 500,
        capitalStock: 900,
        retainedEarnings: 350,
        totalEquity: 1250,
        totalLiabilitiesAndEquity: 1750,
        balanceDifference: 0,
      },
      cashFlow: {
        companyId: "BAL",
        period: PERIOD_2015Q1,
        operatingDirect: {
          receiptsFromCustomers: 900,
          paymentsForRawMaterials: -300,
          paymentsForManufacturing: -180,
          paymentsForSellingGeneralAdmin: -100,
          interestPaid: -10,
          incomeTaxPaid: -30,
        },
        operatingCashFlow: 280,
        investingCashFlow: -50,
        financingCashFlow: 20,
        netCashChange: 250,
        openingCash: 250,
        closingCash: 500,
        indirectReconciliation: {
          netIncome: 300,
          depreciationAddback: 50,
          increaseInReceivables: -20,
          increaseInPayables: 10,
          increaseInInventory: -60,
          increaseInAccruedInterestPayable: 0,
          operatingCashFlowIndirect: 280,
        },
        directIndirectDifference: 0,
      },
      cashShortfall: false,
      cashShortfallAmount: 0,
      negativeEquity: false,
    },
    financingResult: null,
    capexResult: null,
    companySummary: null,
  };
  return { ...base, ...overrides };
}

test("buildCompanyExportExcelWorkbook: Meta/PL/BS/CF/Financing/Capexの6シートを生成する", async () => {
  const payload = buildSyntheticPayload();
  const buffer = await buildCompanyExportExcelWorkbook(payload);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  assert.deepEqual(
    wb.worksheets.map((ws) => ws.name),
    ["Meta", "PL", "BS", "CF", "Financing", "Capex"],
  );
});

test("buildCompanyExportExcelWorkbook: PLシートは入力値をそのまま転記し、合計行は数式で組み立てる（ハードコードしない）", async () => {
  const payload = buildSyntheticPayload();
  const buffer = await buildCompanyExportExcelWorkbook(payload);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const pl = wb.getWorksheet("PL");
  assert.ok(pl);

  const grossRevenueRow = pl!.getRow(2);
  assert.equal(grossRevenueRow.getCell(1).value, "売上高 (grossRevenue)");
  assert.equal(grossRevenueRow.getCell(2).value, 1000);

  // 純売上高・売上原価合計・売上総利益・営業利益・税引前利益・当期純利益は、いずれもハードコード値
  // ではなく数式（他セルの参照）として書かれていること。
  let formulaCellCount = 0;
  pl!.eachRow((row) => {
    const cell = row.getCell(2);
    if (cell.value && typeof cell.value === "object" && "formula" in cell.value) {
      formulaCellCount += 1;
    }
  });
  assert.ok(formulaCellCount >= 6, `PLシートの数式セル数が少なすぎます（${formulaCellCount}件）`);
});

test("buildCompanyExportExcelWorkbook: BSシートの資産合計・負債合計・純資産合計・貸借差額は数式で組み立てる", async () => {
  const payload = buildSyntheticPayload();
  const buffer = await buildCompanyExportExcelWorkbook(payload);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const bs = wb.getWorksheet("BS");
  assert.ok(bs);

  let foundBalanceCheckFormula = false;
  bs!.eachRow((row) => {
    const label = row.getCell(1).value;
    if (typeof label === "string" && label.includes("貸借差額")) {
      const value = row.getCell(2).value;
      assert.ok(value && typeof value === "object" && "formula" in value, "貸借差額はSUM/差引の数式であるべき（ハードコード値ではない）");
      foundBalanceCheckFormula = true;
    }
  });
  assert.ok(foundBalanceCheckFormula, "貸借差額の検算行が見つかりません");
});

test("buildCompanyExportExcelWorkbook: CFシートはBSシートのcashセルを参照する式で期末現金の一致を検算する", async () => {
  const payload = buildSyntheticPayload();
  const buffer = await buildCompanyExportExcelWorkbook(payload);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const cf = wb.getWorksheet("CF");
  assert.ok(cf);

  let foundCrossSheetReference = false;
  cf!.eachRow((row) => {
    const value = row.getCell(2).value;
    if (value && typeof value === "object" && "formula" in value && typeof value.formula === "string" && value.formula.includes("BS!")) {
      foundCrossSheetReference = true;
    }
  });
  assert.ok(foundCrossSheetReference, "CFシートにBSシートを参照する検算式が見つかりません");
});

test("buildCompanyExportExcelWorkbook: financialResultがnullの場合でもクラッシュせず、PL/BS/CFシートに未作成の旨を表示する", async () => {
  const payload = buildSyntheticPayload({ financialResult: null });
  const buffer = await buildCompanyExportExcelWorkbook(payload);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const pl = wb.getWorksheet("PL");
  assert.ok(pl);
  const firstDataRow = pl!.getRow(1);
  assert.ok(String(firstDataRow.getCell(1).value).includes("存在しません"));
});
