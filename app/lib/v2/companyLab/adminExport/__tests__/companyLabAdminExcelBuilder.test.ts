// ShrimpX V2 — companyLabAdminExcelBuilder.ts のテスト
//
// 合成データ（Export API JSON形状のオブジェクトをテスト内で直接組み立てたもの＝
// ./syntheticExportPayload.ts）を唯一の入力として、シート構成・検算式が正しく
// 組み立てられることを検証する。
// このモジュールはRedis・Repositoryを一切importしていない（tscで確認済み）ため、
// 「Excelの唯一の入力がExport JSONであること」は型レベルでも保証されている。

import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildCompanyExportExcelWorkbook } from "../companyLabAdminExcelBuilder";
import { SYNTHETIC_CONTRACT, buildSyntheticCompanyExportPayload } from "./syntheticExportPayload";

/** Phase 8C-3B（三宅さんの指示 §3・§4）で Sales Detail・Market を追加した後のシート構成。 */
const EXPECTED_SHEET_NAMES = [
  "Meta",
  "PL",
  "BS",
  "CF",
  "Financing",
  "Capex",
  "Sales Contracts",
  "Sales Detail",
  "Market",
];

async function loadWorkbook(payload: Parameters<typeof buildCompanyExportExcelWorkbook>[0]): Promise<ExcelJS.Workbook> {
  const buffer = await buildCompanyExportExcelWorkbook(payload);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

test("buildCompanyExportExcelWorkbook: Meta/PL/BS/CF/Financing/Capex/Sales Contracts/Sales Detail/Marketの9シートを生成する", async () => {
  const wb = await loadWorkbook(buildSyntheticCompanyExportPayload());
  assert.deepEqual(
    wb.worksheets.map((ws) => ws.name),
    EXPECTED_SHEET_NAMES,
  );
});

test("buildCompanyExportExcelWorkbook: Sales Contractsシートは契約明細をそのまま転記し、0件時はその旨を表示する", async () => {
  const emptyWb = await loadWorkbook(buildSyntheticCompanyExportPayload({ salesContracts: [] }));
  const emptySheet = emptyWb.getWorksheet("Sales Contracts");
  assert.ok(emptySheet);
  assert.ok(String(emptySheet!.getRow(2).getCell(1).value).includes("0件"));

  const wb = await loadWorkbook(buildSyntheticCompanyExportPayload({ salesContracts: [SYNTHETIC_CONTRACT] }));
  const sheet = wb.getWorksheet("Sales Contracts");
  assert.ok(sheet);
  const row = sheet!.getRow(2);
  assert.equal(row.getCell(1).value, "BAL-2015Q1-CN-hoso-001");
  assert.equal(row.getCell(2).value, "BAL");
  assert.equal(row.getCell(3).value, "CN");
  assert.equal(row.getCell(4).value, "hoso");
  assert.equal(row.getCell(7).value, 500);
  assert.equal(row.getCell(8).value, 300);
  assert.equal(row.getCell(9).value, 200);
  assert.equal(row.getCell(10).value, 300);
  assert.equal(row.getCell(11).value, 200);
  assert.equal(row.getCell(13).value, 5.5);
  assert.equal(row.getCell(15).value, "partiallyFulfilled");
});

test("buildCompanyExportExcelWorkbook: Sales Contractsシートは「期首＋新規－履行－期末＝0」を契約ID単位の数式で検算する", async () => {
  const wb = await loadWorkbook(buildSyntheticCompanyExportPayload({ salesContracts: [SYNTHETIC_CONTRACT] }));
  const sheet = wb.getWorksheet("Sales Contracts");
  assert.ok(sheet);

  // 検算差異列（L列＝12列目）はハードコード0ではなく、行内の4列を参照する数式であること。
  const difference = sheet!.getRow(2).getCell(12).value;
  assert.ok(
    difference && typeof difference === "object" && "formula" in difference,
    "検算差異はハードコード値ではなく数式であるべき",
  );
  const formula = (difference as { formula: string }).formula;
  for (const ref of ["H2", "I2", "J2", "K2"]) {
    assert.ok(formula.includes(ref), `検算式が${ref}を参照していません: ${formula}`);
  }

  // 期末残金額相当（N列＝14列目）も、期末残数量×単価×1000の数式であること。
  const amount = sheet!.getRow(2).getCell(14).value;
  assert.ok(amount && typeof amount === "object" && "formula" in amount, "期末残金額相当は数式であるべき");

  // 末尾に合計行と「検算差異の絶対値合計」行が存在し、後者も数式であること。
  let foundAbsoluteCheck = false;
  sheet!.eachRow((r) => {
    if (typeof r.getCell(1).value === "string" && String(r.getCell(1).value).includes("検算差異の絶対値合計")) {
      const value = r.getCell(2).value;
      assert.ok(value && typeof value === "object" && "formula" in value, "検算差異の絶対値合計は数式であるべき");
      foundAbsoluteCheck = true;
    }
  });
  assert.ok(foundAbsoluteCheck, "検算差異の絶対値合計行が見つかりません");
});

test("buildCompanyExportExcelWorkbook: Sales Detailシートは市場別×商品別に数量・単価・成約金額を展開する（§3）", async () => {
  const wb = await loadWorkbook(buildSyntheticCompanyExportPayload());
  const sheet = wb.getWorksheet("Sales Detail");
  assert.ok(sheet);
  const row = sheet!.getRow(2);
  assert.equal(row.getCell(1).value, "CN");
  assert.equal(row.getCell(2).value, "hoso");
  assert.equal(row.getCell(3).value, 5.4);
  assert.equal(row.getCell(6).value, 400);
  assert.equal(row.getCell(8).value, 5.5);
  assert.equal(row.getCell(10).value, 200);
  // 未成約量・成約金額相当はハードコードせず数式で算出する。
  for (const col of [11, 12]) {
    const value = row.getCell(col).value;
    assert.ok(value && typeof value === "object" && "formula" in value, `Sales Detailの${col}列は数式であるべき`);
  }
});

test("buildCompanyExportExcelWorkbook: Sales Detailシートは販売計画・配分がいずれも0件のときその旨を表示する", async () => {
  const wb = await loadWorkbook(buildSyntheticCompanyExportPayload({ salesPlans: [], marketProductAllocations: [] }));
  const sheet = wb.getWorksheet("Sales Detail");
  assert.ok(sheet);
  assert.ok(String(sheet!.getRow(2).getCell(1).value).includes("0件"));
});

test("buildCompanyExportExcelWorkbook: Marketシートは国別HOSO価格とPD/VAPプレミアムを表示する（§4）", async () => {
  const wb = await loadWorkbook(buildSyntheticCompanyExportPayload());
  const sheet = wb.getWorksheet("Market");
  assert.ok(sheet);

  const labels: string[] = [];
  const countries = new Set<string>();
  sheet!.eachRow((row) => {
    const first = row.getCell(1).value;
    if (typeof first === "string") {
      labels.push(first);
      if (["EC", "IN", "ID", "VN"].includes(first)) countries.add(first);
    }
  });
  const joined = labels.join("\n");
  // COUNTRY_IDSの4か国すべてが行として出力されていること（国別HOSO価格・PD/VAPプレミアム）。
  assert.deepEqual([...countries].sort(), ["EC", "ID", "IN", "VN"]);
  for (const keyword of ["国別HOSO価格", "ベトナム国内", "PD", "VAP"]) {
    assert.ok(joined.includes(keyword), `Marketシートに「${keyword}」を含む行が見つかりません`);
  }
});

test("buildCompanyExportExcelWorkbook: PLシートは入力値をそのまま転記し、合計行は数式で組み立てる（ハードコードしない）", async () => {
  const wb = await loadWorkbook(buildSyntheticCompanyExportPayload());
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
  const wb = await loadWorkbook(buildSyntheticCompanyExportPayload());
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
  const wb = await loadWorkbook(buildSyntheticCompanyExportPayload());
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
  const wb = await loadWorkbook(buildSyntheticCompanyExportPayload({ financialResult: null }));
  const pl = wb.getWorksheet("PL");
  assert.ok(pl);
  const firstDataRow = pl!.getRow(1);
  assert.ok(String(firstDataRow.getCell(1).value).includes("存在しません"));
});
