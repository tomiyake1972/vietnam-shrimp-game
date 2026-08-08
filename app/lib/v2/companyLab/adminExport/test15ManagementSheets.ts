// ShrimpX V2 — Test15 自社データブック: 管理会計＋意思決定ワーキングシート
//
// 【このファイルが作るもの】
//   1. 「固変分解」シート     … 市場×商品別の限界利益と、固定費の2区分表示
//   2. 「意思決定計算」シート … 次期意思決定を組み立てるためのワーキングシート
//   ＋ 製造原価計算書へ追記する管理会計セクション（調達・納入・期末在庫）
//
// 【計算の出どころ】数値ロジックは一切ここで作らない。managementAccountingModel.ts
// 経由でゲームエンジンの正式関数・パラメータだけを使う（固変分解＝CostRecord、
// 限界利益＝ContributionMarginReport、在庫評価＝完成品原価台帳、営業能力＝
// processingCapacity、労働負荷＝computeRequiredRegularHeadcount）。
//
// 【実績と入力と試算を混同しない】意思決定計算シートのセルは3種類に色分けする。
//   実績（水色）   … ゲームから取得した事実。編集しても実績は変わらない
//   入力（黄色）   … ユーザーが記入する計画値
//   数式（薄灰）   … 入力に反応して再計算されるExcel数式
// 数式は生成時の固定値にせず、必ずExcelの式として書き込む（指示 §7）。

import ExcelJS from "exceljs";

import type { CompanyExportPayload } from "../../../../../app/api/v2/exports/_lib/exportDto";
import { SALES_PARAMETERS_V1 } from "../../sales/parameters";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import {
  MARKETS,
  PRODUCTS,
  buildMarketProductMarginModel,
  effectiveTonsPerRegularWorker,
  laborIntensityByProduct,
  salesCapacityReference,
  summarizeRawProcurement,
  usdPerKg,
} from "./managementAccountingModel";

const FONT_NAME = "Yu Gothic";
const LABEL_FONT: Partial<ExcelJS.Font> = { name: FONT_NAME };
const BOLD_FONT: Partial<ExcelJS.Font> = { name: FONT_NAME, bold: true };
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
const USD_FMT = '$#,##0;($#,##0);"-"';
const USD_KG_FMT = '$#,##0.000;($#,##0.000);"-"';
const TON_FMT = '#,##0.00;(#,##0.00);"-"';
const PCT_FMT = '0.0%;(0.0%);"-"';

/** セルの役割を示す3色（指示 §4-1）。 */
const ACTUAL_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD6EAF8" } }; // 水色: ゲーム実データ
const INPUT_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } }; // 黄色: ユーザー入力
const FORMULA_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } }; // 薄灰: Excel数式
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "hair" },
  left: { style: "hair" },
  bottom: { style: "hair" },
  right: { style: "hair" },
};

type Role = "actual" | "input" | "formula";

function paint(cell: ExcelJS.Cell, role: Role, numFmt?: string): void {
  cell.fill = role === "actual" ? ACTUAL_FILL : role === "input" ? INPUT_FILL : FORMULA_FILL;
  cell.border = THIN_BORDER;
  cell.font = LABEL_FONT;
  if (numFmt) cell.numFmt = numFmt;
}

function header(ws: ExcelJS.Worksheet, values: readonly string[]): ExcelJS.Row {
  const row = ws.addRow([...values]);
  row.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = { name: FONT_NAME, bold: true, color: { argb: "FFFFFFFF" } };
    c.alignment = { vertical: "middle", wrapText: true };
  });
  return row;
}

function sectionTitle(ws: ExcelJS.Worksheet, text: string): void {
  const r = ws.addRow([text]);
  r.getCell(1).font = BOLD_FONT;
}

function noteRow(ws: ExcelJS.Worksheet, text: string): void {
  const r = ws.addRow([text]);
  r.getCell(1).font = LABEL_FONT;
  r.getCell(1).alignment = { wrapText: true, vertical: "top" };
}

/** 「－」を返す（値が無い／ゼロ除算）ことを一箇所に集約する。 */
const DASH = "－";
function orDash(v: number | undefined): number | string {
  return v === undefined || !Number.isFinite(v) ? DASH : v;
}

// =====================================================================
// A. 製造原価計算書へ追記する管理会計セクション
// =====================================================================

/**
 * 製造原価計算書の末尾へ、原料調達・商品別納入量・商品別期末在庫を追記する
 * （指示 §1-2 / §1-3 / §1-4）。既存の商品別製造原価セクション（§1-1 / §1-5）は
 * 既存実装のまま維持し、そこへ追加するだけ。
 */
export function appendManufacturingCostManagementSections(ws: ExcelJS.Worksheet, payload: CompanyExportPayload): void {
  ws.addRow([]);

  // --- §1-2 原料調達価格（調達元別） ---
  sectionTitle(ws, "V. 原料調達（全社。当期入庫ロットの調達元別内訳）");
  noteRow(
    ws,
    "原料ロットは会社単位のプールであり、「調達元 × 商品」の対応はゲームエンジン上で一意に追跡できません（どのロットがどの商品になったかは生産バッチの投入順序に依存します）。存在しない配賦を作らないため、調達情報は全社共通の情報として表示します。"
  );
  header(ws, ["調達元", "調達数量 (t)", "平均単価 (USD/kg)", "原料費総額 (USD)", "", ""]);

  const procurement = summarizeRawProcurement(payload.operations.rawMaterialLots.ending, payload.meta.period);
  const sourceLabel: Readonly<Record<string, string>> = {
    import: "輸入原料",
    aquaculture: "自社養殖",
    domesticPurchase: "国内調達",
  };
  for (const s of procurement.bySource) {
    const row = ws.addRow([sourceLabel[s.source] ?? s.source, s.quantityTons, orDash(s.averageUnitCostUsdPerKg), s.totalCostUsd]);
    row.getCell(1).font = LABEL_FONT;
    row.getCell(2).numFmt = TON_FMT;
    row.getCell(3).numFmt = USD_KG_FMT;
    row.getCell(4).numFmt = USD_FMT;
  }
  const totalRow = ws.addRow([
    "全調達合計 / 加重平均原料価格",
    procurement.totalQuantityTons,
    orDash(procurement.weightedAverageUnitCostUsdPerKg),
    procurement.totalCostUsd,
  ]);
  totalRow.getCell(1).font = BOLD_FONT;
  totalRow.getCell(2).numFmt = TON_FMT;
  totalRow.getCell(3).numFmt = USD_KG_FMT;
  totalRow.getCell(4).numFmt = USD_FMT;
  noteRow(ws, "加重平均原料価格 ＝ 総原料費 ÷ 総調達数量kg。調達数量が0の場合は「－」を表示します（NaN・Infinityは出しません）。");

  ws.addRow([]);

  // --- §1-3 商品別 納入量（成約ではなく実納入） ---
  sectionTitle(ws, "VI. 商品別 当期実納入数量");
  noteRow(ws, "成約数量ではなく、完成品在庫を実際に契約へ充当した数量（contractFulfillmentUsage）です。");
  header(ws, ["商品", "当期実納入数量 (t)", "", "", "", ""]);
  const deliveredByProduct = deliveredQuantityByProduct(payload);
  for (const p of PRODUCTS) {
    const row = ws.addRow([p.toUpperCase(), deliveredByProduct[p]]);
    row.getCell(1).font = LABEL_FONT;
    row.getCell(2).numFmt = TON_FMT;
  }
  const delTotal = ws.addRow(["合計", PRODUCTS.reduce((s, p) => s + deliveredByProduct[p], 0)]);
  delTotal.getCell(1).font = BOLD_FONT;
  delTotal.getCell(2).numFmt = TON_FMT;

  ws.addRow([]);

  // --- §1-4 商品別 期末製品在庫 ---
  sectionTitle(ws, "VII. 商品別 期末製品在庫（完成品原価台帳による評価）");
  noteRow(
    ws,
    "在庫評価は財務会計と同じ完成品原価台帳（ロット別実際原価）をそのまま集計しています。Excel用の別原価ロジックは使っていません。「加工費その他」には加工変動費・変動/固定労務費・ユーティリティ・工場固定費・減価償却の配賦が含まれます。"
  );
  header(ws, ["商品", "期末在庫数量 (t)", "原料費部分 (USD)", "加工費その他 (USD)", "在庫評価額合計 (USD)", ""]);
  const inv = payload.finishedGoodsInventoryByProduct;
  if (inv.length === 0) {
    noteRow(ws, "完成品原価台帳がAPI上に存在しないため、商品別の期末在庫評価を作成できません（データ未作成）。");
  } else {
    for (const p of PRODUCTS) {
      const e = inv.find((x) => x.product === p);
      const row = ws.addRow([
        p.toUpperCase(),
        e?.quantityTons ?? 0,
        e?.rawMaterialCostUsd ?? 0,
        e?.processingAndOtherCostUsd ?? 0,
        e?.totalValueUsd ?? 0,
      ]);
      row.getCell(1).font = LABEL_FONT;
      row.getCell(2).numFmt = TON_FMT;
      for (const c of [3, 4, 5]) row.getCell(c).numFmt = USD_FMT;
    }
    const invTotal = ws.addRow([
      "合計",
      inv.reduce((s, e) => s + e.quantityTons, 0),
      inv.reduce((s, e) => s + e.rawMaterialCostUsd, 0),
      inv.reduce((s, e) => s + e.processingAndOtherCostUsd, 0),
      inv.reduce((s, e) => s + e.totalValueUsd, 0),
    ]);
    invTotal.getCell(1).font = BOLD_FONT;
    invTotal.getCell(2).numFmt = TON_FMT;
    for (const c of [3, 4, 5]) invTotal.getCell(c).numFmt = USD_FMT;
    noteRow(ws, "在庫評価額合計 ＝ 原料費部分 ＋ 加工費その他。合計はBSの完成品在庫と一致します。");
  }
}

/** 当期の実納入数量を商品別に集計する（contractFulfillmentUsageをそのまま合計）。 */
export function deliveredQuantityByProduct(payload: CompanyExportPayload): Record<string, number> {
  const out: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const u of payload.contractFulfillmentUsage) {
    if (out[u.product] === undefined) continue;
    out[u.product] += u.quantity;
  }
  return out;
}

/** 当期の実納入数量を市場×商品別に集計する（契約IDで市場を引く）。 */
export function deliveredByMarketProduct(payload: CompanyExportPayload): Map<string, number> {
  const marketByContract = new Map<string, string>();
  for (const c of payload.salesContracts) marketByContract.set(c.contractId, c.market);
  const out = new Map<string, number>();
  for (const u of payload.contractFulfillmentUsage) {
    const market = marketByContract.get(u.contractId);
    if (!market) continue;
    const key = `${market}|${u.product}`;
    out.set(key, (out.get(key) ?? 0) + u.quantity);
  }
  return out;
}

// =====================================================================
// B. 「固変分解」シート
// =====================================================================

/**
 * 市場×商品別の採算性シート（指示 §3）。
 *
 * 【売上原価単価の扱い（§2-1）】ゲームエンジンの限界利益レポートは byProduct と
 * byMarket を別々に持ち、market × product の交差を保持していない。したがって
 * 売上原価単価は「商品別平均を全市場共通」で適用し、市場差は販売価格と
 * 市場別の変動販売費（物流費等）で表現する。これは指示どおりの扱いであり、
 * 存在しない交差配賦を作っていない。
 */
export function writeFixedVariableAnalysisSheet(wb: ExcelJS.Workbook, payload: CompanyExportPayload): void {
  const ws = wb.addWorksheet("固変分解");
  ws.columns = [
    { width: 8 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 15 }, { width: 16 },
    { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 17 }, { width: 16 },
    { width: 13 }, { width: 16 }, { width: 17 },
    { width: 15 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 16 },
  ];

  const financial = payload.financialResult;
  if (!financial) {
    ws.addRow(["このターン・会社の財務結果がAPI上に存在しないため、固変分解を作成できません（データ未作成）"]).getCell(1).font = LABEL_FONT;
    return;
  }

  const model = buildMarginModel(payload);

  const scopeLabel = payload.meta.scope.kind === "company" ? payload.meta.scope.companyId : "";
  sectionTitle(ws, `固変分解（Turn ${payload.meta.turn} / ${payload.meta.period} / ${scopeLabel}）`);
  noteRow(
    ws,
    "限界利益 ＝ 売上高 − 変動費。変動費・固定費の区分はゲームエンジンの費用分類（finance/quarterClose.ts の CostRecord.fixedPortion / variablePortion）をそのまま使っています。Excel側で分類を変更していません。常用Workerの固定人件費・工場固定費・減価償却・本社固定費・固定販管費は限界利益の計算から除外しています。"
  );
  noteRow(
    ws,
    "売上原価単価は商品別平均を全市場共通で適用しています（例: PDの平均売上原価が $8.10/kg なら US-PD も JP-PD も同じ）。市場差は販売価格と市場別の変動販売費（物流費等）に現れます。"
  );
  ws.addRow([]);

  // --- §3-1 市場×商品別明細 ---
  header(ws, [
    "Turn", "Market", "Product", "販売数量(t)", "販売単価(USD/kg)", "売上高(USD)",
    "売上原価単価(USD/kg)", "売上原価(USD)", "変動費単価(USD/kg)", "変動費(USD)",
    "限界利益単価(USD/kg)", "限界利益(USD)", "限界利益率", "売上総利益(USD)", "売上総利益(USD/kg)",
    // 【試作ブック踏襲】市場の大きさと自社の立ち位置を並べて見るための公開情報。
    "対象需要(t)", "外部流出(t)", "販売希望量(t)", "価格調整(USD/kg)", "提示価格(USD/kg)",
  ]);

  const firstDetailRow = ws.rowCount + 1;
  for (const r of model.rows) {
    // 公開の市場情報（対象需要・外部流出）と、自社の提示（希望量・価格調整・提示価格）。
    const alloc = payload.marketProductAllocations.find((a) => a.market === r.market && a.product === r.product);
    const plan = payload.salesPlans.find((p) => p.market === r.market && p.product === r.product);
    const askPrice =
      alloc && plan ? alloc.basePrice + plan.priceAdjustmentUsdPerHosoEqKg : alloc ? alloc.basePrice : undefined;
    const row = ws.addRow([
      payload.meta.turn, r.market, r.product.toUpperCase(),
      r.quantityTons, orDash(r.sellingPriceUsdPerKg), r.netRevenueUsd,
      orDash(r.cogsUnitUsdPerKg), orDash(r.cogsAmountUsd),
      orDash(r.variableCostUnitUsdPerKg), r.variableCostAmountUsd,
      orDash(r.contributionMarginUnitUsdPerKg), r.contributionMarginUsd,
      orDash(r.contributionMarginRatio), orDash(r.grossProfitUsd), orDash(r.grossProfitUnitUsdPerKg),
      orDash(alloc?.targetDemand), orDash(alloc?.externalOptionQuantity),
      orDash(plan?.desiredQuantity), orDash(plan?.priceAdjustmentUsdPerHosoEqKg), orDash(askPrice),
    ]);
    row.getCell(4).numFmt = TON_FMT;
    for (const c of [5, 7, 9, 11, 15, 19, 20]) row.getCell(c).numFmt = USD_KG_FMT;
    for (const c of [6, 8, 10, 12, 14]) row.getCell(c).numFmt = USD_FMT;
    for (const c of [16, 17, 18]) row.getCell(c).numFmt = TON_FMT;
    row.getCell(13).numFmt = PCT_FMT;
  }
  const lastDetailRow = ws.rowCount;

  ws.addRow([]);

  // --- §3-3 商品別合計 / 全社合計 ---
  sectionTitle(ws, "商品別集計");
  header(ws, ["", "", "Product", "販売数量(t)", "", "売上高(USD)", "", "", "", "変動費(USD)", "", "限界利益(USD)", "限界利益率", "直接固定費(USD)", ""]);
  for (const agg of model.byProduct) {
    const upper = agg.product.toUpperCase();
    const row = ws.addRow([
      "", "", upper,
      // 明細をSUMIFSで集計する（Excel上でも計算関係を追えるようにする）。
      { formula: `SUMIFS(D${firstDetailRow}:D${lastDetailRow},C${firstDetailRow}:C${lastDetailRow},"${upper}")` },
      "",
      { formula: `SUMIFS(F${firstDetailRow}:F${lastDetailRow},C${firstDetailRow}:C${lastDetailRow},"${upper}")` },
      "", "", "",
      { formula: `SUMIFS(J${firstDetailRow}:J${lastDetailRow},C${firstDetailRow}:C${lastDetailRow},"${upper}")` },
      "",
      { formula: `SUMIFS(L${firstDetailRow}:L${lastDetailRow},C${firstDetailRow}:C${lastDetailRow},"${upper}")` },
      { formula: `IF(F${ws.rowCount + 1}=0,"${DASH}",L${ws.rowCount + 1}/F${ws.rowCount + 1})` },
      agg.directFixedCostUsd,
      "",
    ]);
    row.getCell(3).font = BOLD_FONT;
    row.getCell(4).numFmt = TON_FMT;
    for (const c of [6, 10, 12, 14]) row.getCell(c).numFmt = USD_FMT;
    row.getCell(13).numFmt = PCT_FMT;
  }
  const companyRow = ws.addRow([
    "", "", "全社合計",
    { formula: `SUM(D${firstDetailRow}:D${lastDetailRow})` }, "",
    { formula: `SUM(F${firstDetailRow}:F${lastDetailRow})` }, "", "", "",
    { formula: `SUM(J${firstDetailRow}:J${lastDetailRow})` }, "",
    { formula: `SUM(L${firstDetailRow}:L${lastDetailRow})` },
    { formula: `IF(F${ws.rowCount + 1}=0,"${DASH}",L${ws.rowCount + 1}/F${ws.rowCount + 1})` },
    "", "",
  ]);
  companyRow.getCell(3).font = BOLD_FONT;
  companyRow.getCell(4).numFmt = TON_FMT;
  for (const c of [6, 10, 12]) companyRow.getCell(c).numFmt = USD_FMT;
  companyRow.getCell(13).numFmt = PCT_FMT;

  noteRow(
    ws,
    "商品別・全社合計は明細をSUMIFS／SUMで集計しています（Excel上で計算関係を追えるようにするため）。直接固定費は限界利益レポートの byProduct[].directFixedCost をそのまま転記しています（限界利益の計算には含みません）。"
  );

  ws.addRow([]);

  // --- 市場別集計（試作ブックの「市場別」ブロック相当。エンジンのbyMarketをそのまま使う） ---
  sectionTitle(ws, "市場別集計");
  header(ws, ["", "Market", "", "販売数量(t)", "", "売上高(USD)", "", "", "", "変動費(USD)", "", "限界利益(USD)", "限界利益率", "", ""]);
  for (const market of MARKETS) {
    const dim = financial.contributionMargin.byMarket.find((m) => m.key === market);
    const row = ws.addRow([
      "", market, "",
      { formula: `SUMIFS(D${firstDetailRow}:D${lastDetailRow},B${firstDetailRow}:B${lastDetailRow},"${market}")` },
      "",
      { formula: `SUMIFS(F${firstDetailRow}:F${lastDetailRow},B${firstDetailRow}:B${lastDetailRow},"${market}")` },
      "", "", "",
      { formula: `SUMIFS(J${firstDetailRow}:J${lastDetailRow},B${firstDetailRow}:B${lastDetailRow},"${market}")` },
      "",
      { formula: `SUMIFS(L${firstDetailRow}:L${lastDetailRow},B${firstDetailRow}:B${lastDetailRow},"${market}")` },
      dim?.contributionMarginRatio ?? DASH,
      "", "",
    ]);
    row.getCell(2).font = BOLD_FONT;
    row.getCell(4).numFmt = TON_FMT;
    for (const c of [6, 10, 12]) row.getCell(c).numFmt = USD_FMT;
    row.getCell(13).numFmt = PCT_FMT;
  }
  noteRow(ws, "市場別の直接固定費配賦はゲームエンジン側で未実装のため（byMarket[].directFixedCostは常に0）、市場別の営業利益は表示していません。配賦していないものを配賦したように見せないためです。");

  ws.addRow([]);

  // --- §3-2 固定費（2区分） ---
  sectionTitle(ws, "固定費（限界利益の計算には含めない）");
  header(ws, ["区分", "勘定", "金額(USD)", "", "", "", "", "", "", "", "", "", "", "", ""]);
  for (const r of model.fixedCosts.inCostOfSales) {
    const row = ws.addRow(["A. 売上原価に含まれる固定費", r.account, r.amountUsd]);
    row.getCell(3).numFmt = USD_FMT;
  }
  const cogsFixedTotal = ws.addRow(["A. 小計（固定COGS）", "", model.fixedCosts.inCostOfSalesTotalUsd]);
  cogsFixedTotal.getCell(1).font = BOLD_FONT;
  cogsFixedTotal.getCell(3).numFmt = USD_FMT;

  for (const r of model.fixedCosts.inSellingGeneralAdmin) {
    const row = ws.addRow(["B. 販管費に含まれる固定費", r.account, r.amountUsd]);
    row.getCell(3).numFmt = USD_FMT;
  }
  const sgaFixedTotal = ws.addRow(["B. 小計（固定SG&A）", "", model.fixedCosts.inSellingGeneralAdminTotalUsd]);
  sgaFixedTotal.getCell(1).font = BOLD_FONT;
  sgaFixedTotal.getCell(3).numFmt = USD_FMT;

  const fixedTotal = ws.addRow(["固定費合計 (A + B)", "", model.fixedCosts.totalUsd]);
  fixedTotal.getCell(1).font = BOLD_FONT;
  fixedTotal.getCell(3).numFmt = USD_FMT;

  if (Math.abs(model.commonVariableCostUsd) > 1e-9) {
    const cv = ws.addRow(["（参考）商品別へ配賦していない共通変動費", "", model.commonVariableCostUsd]);
    cv.getCell(3).numFmt = USD_FMT;
    noteRow(ws, "共通変動費（原料の期限切れ廃棄損等）は商品別へ恣意的に配賦していません。Σ(商品別限界利益) ＝ 全社限界利益 ＋ 共通変動費 が成り立ちます。");
  }
}

/** 限界利益モデルを payload から組み立てる（固変分解シートと意思決定計算で共用）。 */
function buildMarginModel(payload: CompanyExportPayload) {
  const financial = payload.financialResult!;
  const cm = financial.contributionMargin;
  const delivered = deliveredByMarketProduct(payload);

  // 市場×商品の納入数量と売上高。売上高は納入数量 × 成約単価（契約から引く）。
  const priceByKey = new Map<string, { revenue: number; quantity: number }>();
  const contractById = new Map(payload.salesContracts.map((c) => [c.contractId, c]));
  for (const u of payload.contractFulfillmentUsage) {
    const c = contractById.get(u.contractId);
    if (!c) continue;
    const key = `${c.market}|${u.product}`;
    const bucket = priceByKey.get(key) ?? { revenue: 0, quantity: 0 };
    bucket.revenue += u.quantity * 1000 * c.unitPrice;
    bucket.quantity += u.quantity;
    priceByKey.set(key, bucket);
  }

  const sales = [...delivered.entries()].map(([key, quantityTons]) => {
    const [market, product] = key.split("|");
    return { market, product, quantityTons, netRevenueUsd: priceByKey.get(key)?.revenue ?? 0 };
  });

  // 商品別の売上原価単価（売上原価 ÷ 納入数量）。全市場共通で使う（§2-1）。
  const producedCogsUnit: Partial<Record<string, number>> = {};
  const deliveredTotals = deliveredQuantityByProduct(payload);
  for (const p of PRODUCTS) {
    const dim = cm.byProduct.find((x) => x.key === p);
    if (!dim) continue;
    // 売上原価＝変動費＋その商品へ配賦された直接固定費（全部原価ベース）。
    const cogs = dim.variableCost + dim.directFixedCost;
    const unit = usdPerKg(cogs, deliveredTotals[p] ?? 0);
    if (unit !== undefined) producedCogsUnit[p] = unit;
  }

  return buildMarketProductMarginModel({
    sales,
    byProduct: cm.byProduct,
    byMarket: cm.byMarket,
    productCogsUnitUsdPerKg: producedCogsUnit,
    costRecords: financial.costRecords,
    commonVariableCostUsd: cm.commonVariableCost,
  });
}

// =====================================================================
// C. 「意思決定計算」シート
// =====================================================================

/** 意思決定計算シートで使う市場の表示名（ゲーム側IDと対応づけて表示する）。 */
const MARKET_LABELS: readonly { readonly id: string; readonly label: string }[] = [
  { id: "US", label: "USA" },
  { id: "JP", label: "Japan" },
  { id: "EU", label: "EU" },
  { id: "CN", label: "China" },
  { id: "OTHER", label: "Asia / Other" },
];

/**
 * 次期意思決定のワーキングシート（指示 §4）。実績帳票ではない。
 *
 * 設備投資は対象外（指示どおり）。ユーザーが黄色セルへ数字を入れると、
 * 販売希望量合計・必要営業人数・予定期末在庫／受注残・必要Worker・
 * 必要原料量・不足・予定原料費がExcel数式で再計算される。
 */
export function writeDecisionWorksheetSheet(wb: ExcelJS.Workbook, payload: CompanyExportPayload): void {
  const ws = wb.addWorksheet("意思決定計算");
  ws.columns = [
    { width: 30 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 15 },
    { width: 15 }, { width: 16 }, { width: 16 }, { width: 18 },
  ];

  const salesRef = salesCapacityReference(SALES_PARAMETERS_V1);
  const laborIntensity = laborIntensityByProduct(PRODUCTION_PARAMETERS_V1);
  const tonsPerWorker = effectiveTonsPerRegularWorker(PRODUCTION_PARAMETERS_V1);

  // --- 見出しと凡例 ---
  sectionTitle(ws, `意思決定計算ワーキングシート（Turn ${payload.meta.turn} / ${payload.meta.period} の次期計画用）`);
  noteRow(ws, "これは実績帳票ではなく、次の1四半期の意思決定を組み立てるためのワーキングシートです。黄色のセルへ数字を入れると、灰色のセルが自動計算されます。");
  const legend = ws.addRow(["凡例:", "ゲーム実データ", "ユーザー入力", "Excel数式", "", "", "", "", ""]);
  legend.getCell(1).font = BOLD_FONT;
  paint(legend.getCell(2), "actual");
  paint(legend.getCell(3), "input");
  paint(legend.getCell(4), "formula");
  noteRow(ws, "水色＝ゲームから取得した事実（編集しても実績は変わりません）／黄色＝あなたが記入する計画値／薄灰＝入力に反応して再計算される数式です。");
  ws.addRow([]);

  // --- AIコメント欄（§4-10。新しいAPI呼び出しはしない） ---
  writeAiCommentSection(ws, payload);
  ws.addRow([]);

  // --- §4-2 販売計画 ---
  sectionTitle(ws, "1. 販売計画（市場別）");
  noteRow(
    ws,
    `必要営業人数は、ゲームエンジンの営業能力カーブ（baseline ${salesRef.baselineCapacityTons}t ＋ 上限増分 ${salesRef.capacityMaxIncrementTons}t × h/(h+${salesRef.capacitySaturationHeadcount})）と営業工数係数（HOSO ${salesRef.effortCoefficients.hoso} / PD ${salesRef.effortCoefficients.pd} / VAP ${salesRef.effortCoefficients.vap}）から逆算した参考値です。前期実績および現在の営業能力パラメータに基づく参考必要人数であり、市場競争・価格・CTS等により実際の成約は異なります。成約を保証する人数ではありません。`
  );
  header(ws, [
    "市場", "配置予定営業人数", "HOSO希望(t)", "PD希望(t)", "VAP希望(t)",
    "市場計(t)", "必要営業工数", "必要営業人数(参考)", "配置との差異",
  ]);

  const marketFirstRow = ws.rowCount + 1;
  for (const m of MARKET_LABELS) {
    const r = ws.rowCount + 1;
    const row = ws.addRow([
      `${m.label} (${m.id})`,
      null, null, null, null,
      { formula: `SUM(C${r}:E${r})` },
      // 必要営業工数 = Σ 数量 × 営業工数係数（係数はエンジンのパラメータをそのまま埋め込む）
      { formula: `C${r}*${salesRef.effortCoefficients.hoso}+D${r}*${salesRef.effortCoefficients.pd}+E${r}*${salesRef.effortCoefficients.vap}` },
      // 必要営業人数 = 飽和カーブの逆関数 h = k*E/(baseline+M-E)（E<baseline+M のとき）
      {
        formula:
          `IF(G${r}<=${salesRef.baselineCapacityTons},0,` +
          `IF(G${r}>=${salesRef.baselineCapacityTons + salesRef.capacityMaxIncrementTons},"${DASH}",` +
          `CEILING(${salesRef.capacitySaturationHeadcount}*(G${r}-${salesRef.baselineCapacityTons})/(${salesRef.baselineCapacityTons + salesRef.capacityMaxIncrementTons}-G${r}),1)))`,
      },
      { formula: `IF(ISNUMBER(H${r}),B${r}-H${r},"${DASH}")` },
    ]);
    paint(row.getCell(1), "actual");
    for (const c of [2, 3, 4, 5]) paint(row.getCell(c), "input", c === 2 ? "#,##0" : TON_FMT);
    paint(row.getCell(6), "formula", TON_FMT);
    paint(row.getCell(7), "formula", TON_FMT);
    paint(row.getCell(8), "formula", "#,##0");
    paint(row.getCell(9), "formula", "#,##0");
  }
  const marketLastRow = ws.rowCount;
  const totalRowNum = ws.rowCount + 1;
  const salesTotalRow = ws.addRow([
    "全市場合計",
    { formula: `SUM(B${marketFirstRow}:B${marketLastRow})` },
    { formula: `SUM(C${marketFirstRow}:C${marketLastRow})` },
    { formula: `SUM(D${marketFirstRow}:D${marketLastRow})` },
    { formula: `SUM(E${marketFirstRow}:E${marketLastRow})` },
    { formula: `SUM(F${marketFirstRow}:F${marketLastRow})` },
    { formula: `SUM(G${marketFirstRow}:G${marketLastRow})` },
    { formula: `SUM(H${marketFirstRow}:H${marketLastRow})` },
    { formula: `B${totalRowNum}-H${totalRowNum}` },
  ]);
  salesTotalRow.getCell(1).font = BOLD_FONT;
  for (let c = 2; c <= 9; c++) paint(salesTotalRow.getCell(c), "formula", c === 2 || c >= 8 ? "#,##0" : TON_FMT);

  const currentSalesForce = payload.decisionInfo.submission?.salesPlans
    ? uniqueSalesHeadcount(payload.decisionInfo.submission!.salesPlans)
    : undefined;
  const shRow = ws.addRow(["（参考）当期の配置営業人員合計", currentSalesForce ?? DASH]);
  shRow.getCell(1).font = LABEL_FONT;
  paint(shRow.getCell(2), "actual", "#,##0");

  // 【試作ブック踏襲】営業の新規雇用は当期に配分できる人数へは加算されない
  // （companyLab/salesForceHiring.ts の規約）ため、配置とは別枠の入力にする。
  const hireRow = ws.rowCount + 1;
  const hRow = ws.addRow(["【入力】営業 新規採用人数（次期以降に配分可能）", null]);
  paint(hRow.getCell(1), "input");
  paint(hRow.getCell(2), "input", "#,##0");
  const afterHireRow = ws.addRow([
    "採用後の営業人員合計（次期の配分可能人数）",
    { formula: `IF(ISNUMBER(B${hireRow}),${currentSalesForce ?? 0}+B${hireRow},"${DASH}")` },
  ]);
  paint(afterHireRow.getCell(1), "formula");
  paint(afterHireRow.getCell(2), "formula", "#,##0");

  ws.addRow([]);

  // --- §4-4 / §4-5 生産計画・予定期末在庫 ---
  writeProductionPlanSection(ws, payload, totalRowNum, tonsPerWorker, laborIntensity);

  ws.addRow([]);

  // --- §4-7 原料調達計画 ---
  writeRawProcurementPlanSection(ws, payload);

  ws.addRow([]);

  // --- §4-8 / §4-9 その他の意思決定 ---
  writeOtherDecisionsSection(ws, payload);
}

/** 市場ごとに重複排除した営業人員合計（同一市場の3商品行は同じチームを共有する）。 */
function uniqueSalesHeadcount(plans: readonly { readonly market: string; readonly salesForceHeadcount: number }[]): number {
  const byMarket = new Map<string, number>();
  for (const p of plans) byMarket.set(p.market, p.salesForceHeadcount);
  return [...byMarket.values()].reduce((s, v) => s + v, 0);
}

/**
 * 生産計画・予定期末在庫／受注残・Worker計画（§4-4 / §4-5 / §4-6）。
 *
 * 【受注→納入タイミング（§10の調査結果）】
 * ゲームの標準リードタイムは1四半期（sales/parameters.ts standardLeadTimeTurns=1）で、
 * 当期成約の契約は納期が翌期になる。ただし履行計画（production/fulfillment.ts
 * planContractFulfillment）は納期で対象を絞らず、完成品在庫がある限り納期の早い順に
 * 充当するため、**当期成約分も当期中に納入され得る**（実測: 在庫が足りる限り
 * 当期成約の100%が当期中に履行された）。
 * したがって当期の納入対象は次の2つに分かれる。
 *   A. 期首成約残 … 納期が当期。未履行なら期末に延滞となる（必須）
 *   B. 当期新規成約 … 納期は翌期。当期に納入してもよいが、翌期でも延滞にならない（任意）
 * 混同しないよう、シート上で別々の行に分けて表示する。
 */
function writeProductionPlanSection(
  ws: ExcelJS.Worksheet,
  payload: CompanyExportPayload,
  salesTotalRowNum: number,
  tonsPerWorker: Readonly<Record<string, number>>,
  laborIntensity: Readonly<Record<string, number>>
): void {
  sectionTitle(ws, "2. 生産計画・予定期末在庫（商品別）");
  noteRow(
    ws,
    "【受注→納入のタイミング】ゲームの標準リードタイムは1四半期で、当期に成約した契約の納期は翌期です。ただし履行処理は納期で対象を絞らず、完成品在庫がある限り納期の早い順に充当するため、当期成約分も当期中に納入できます。混同を避けるため「A. 期首成約残（納期は当期。未履行なら延滞）」と「B. 新規販売希望（納期は翌期。当期納入は任意）」を分けて表示しています。"
  );
  header(ws, ["項目", "HOSO", "PD", "VAP", "合計", "", "", "", ""]);

  const backlog = beginningBacklogByProduct(payload);
  const fg = payload.finishedGoodsInventoryByProduct;
  const capacity = payload.processingCapacity;

  const addActualRow = (label: string, values: readonly (number | string)[], fmt: string) => {
    const r = ws.rowCount + 1;
    const row = ws.addRow([label, ...values, { formula: `SUM(B${r}:D${r})` }]);
    paint(row.getCell(1), "actual");
    for (const c of [2, 3, 4]) paint(row.getCell(c), "actual", fmt);
    paint(row.getCell(5), "formula", fmt);
    return r;
  };

  const backlogRow = addActualRow("A. 期首成約残（納期=当期・必須）", PRODUCTS.map((p) => backlog[p] ?? 0), TON_FMT);
  const openingFgRow = addActualRow(
    "期首製品在庫",
    PRODUCTS.map((p) => fg.find((e) => e.product === p)?.quantityTons ?? 0),
    TON_FMT
  );
  addActualRow(
    "実効設備能力（参考）",
    PRODUCTS.map((p) => effectiveCapacityFor(capacity, p)),
    TON_FMT
  );
  const laborRow = addActualRow("Worker 1人あたり実効処理量(t)", PRODUCTS.map((p) => tonsPerWorker[p]), "#,##0.00");
  const intRow = ws.addRow(["労働集約度係数（参考）", laborIntensity.hoso, laborIntensity.pd, laborIntensity.vap, ""]);
  paint(intRow.getCell(1), "actual");
  for (const c of [2, 3, 4]) paint(intRow.getCell(c), "actual", "#,##0.00");

  // 【試作ブック踏襲】1トンあたりに必要なWorker数（上の実効処理量の逆数）。
  const perTonRow = ws.rowCount + 1;
  const ptRow2 = ws.addRow([
    "トン当たり必要Worker数（参考）",
    { formula: `IF(B${laborRow}=0,"${DASH}",1/B${laborRow})` },
    { formula: `IF(C${laborRow}=0,"${DASH}",1/C${laborRow})` },
    { formula: `IF(D${laborRow}=0,"${DASH}",1/D${laborRow})` },
    "",
  ]);
  paint(ptRow2.getCell(1), "formula");
  for (const c of [2, 3, 4]) paint(ptRow2.getCell(c), "formula", "#,##0.000");
  void perTonRow;

  // B. 新規販売希望（販売計画セクションから自動参照）
  const newDemandRow = ws.rowCount + 1;
  const ndRow = ws.addRow([
    "B. 新規販売希望（納期=翌期・当期納入は任意）",
    { formula: `C${salesTotalRowNum}` },
    { formula: `D${salesTotalRowNum}` },
    { formula: `E${salesTotalRowNum}` },
    { formula: `SUM(B${newDemandRow}:D${newDemandRow})` },
  ]);
  paint(ndRow.getCell(1), "formula");
  for (const c of [2, 3, 4, 5]) paint(ndRow.getCell(c), "formula", TON_FMT);

  const maxDeliveryRow = ws.rowCount + 1;
  const mdRow = ws.addRow([
    "当期の最大納入対象数量 (A + B)",
    { formula: `B${backlogRow}+B${newDemandRow}` },
    { formula: `C${backlogRow}+C${newDemandRow}` },
    { formula: `D${backlogRow}+D${newDemandRow}` },
    { formula: `SUM(B${maxDeliveryRow}:D${maxDeliveryRow})` },
  ]);
  paint(mdRow.getCell(1), "formula");
  for (const c of [2, 3, 4, 5]) paint(mdRow.getCell(c), "formula", TON_FMT);

  // ユーザー入力: 生産予定数量（空欄で生成する）
  const productionRow = ws.rowCount + 1;
  const pRow = ws.addRow(["【入力】生産予定数量", null, null, null, { formula: `SUM(B${productionRow}:D${productionRow})` }]);
  paint(pRow.getCell(1), "input");
  for (const c of [2, 3, 4]) paint(pRow.getCell(c), "input", TON_FMT);
  paint(pRow.getCell(5), "formula", TON_FMT);

  // 供給可能量 = 期首在庫 + 予定生産
  const supplyRow = ws.rowCount + 1;
  const sRow = ws.addRow([
    "供給可能量（期首在庫＋予定生産）",
    { formula: `B${openingFgRow}+B${productionRow}` },
    { formula: `C${openingFgRow}+C${productionRow}` },
    { formula: `D${openingFgRow}+D${productionRow}` },
    { formula: `SUM(B${supplyRow}:D${supplyRow})` },
  ]);
  paint(sRow.getCell(1), "formula");
  for (const c of [2, 3, 4, 5]) paint(sRow.getCell(c), "formula", TON_FMT);

  // 予定納入 = MIN(供給可能量, 納入対象)
  const plannedDeliveryRow = ws.rowCount + 1;
  const pdRow = ws.addRow([
    "予定納入数量",
    { formula: `MIN(B${supplyRow},B${maxDeliveryRow})` },
    { formula: `MIN(C${supplyRow},C${maxDeliveryRow})` },
    { formula: `MIN(D${supplyRow},D${maxDeliveryRow})` },
    { formula: `SUM(B${plannedDeliveryRow}:D${plannedDeliveryRow})` },
  ]);
  paint(pdRow.getCell(1), "formula");
  for (const c of [2, 3, 4, 5]) paint(pdRow.getCell(c), "formula", TON_FMT);

  // 予定期末在庫 = MAX(0, 供給 - 納入対象) / 予定期末受注残 = MAX(0, 納入対象 - 供給)
  // 在庫と受注残が同時に正数にならない形にする（指示 §4-5）。
  const endingFgRow = ws.rowCount + 1;
  const efRow = ws.addRow([
    "予定期末製品在庫",
    { formula: `MAX(0,B${supplyRow}-B${maxDeliveryRow})` },
    { formula: `MAX(0,C${supplyRow}-C${maxDeliveryRow})` },
    { formula: `MAX(0,D${supplyRow}-D${maxDeliveryRow})` },
    { formula: `SUM(B${endingFgRow}:D${endingFgRow})` },
  ]);
  paint(efRow.getCell(1), "formula");
  for (const c of [2, 3, 4, 5]) paint(efRow.getCell(c), "formula", TON_FMT);

  const endingBacklogRow = ws.rowCount + 1;
  const ebRow = ws.addRow([
    "予定期末受注残",
    { formula: `MAX(0,B${maxDeliveryRow}-B${supplyRow})` },
    { formula: `MAX(0,C${maxDeliveryRow}-C${supplyRow})` },
    { formula: `MAX(0,D${maxDeliveryRow}-D${supplyRow})` },
    { formula: `SUM(B${endingBacklogRow}:D${endingBacklogRow})` },
  ]);
  paint(ebRow.getCell(1), "formula");
  for (const c of [2, 3, 4, 5]) paint(ebRow.getCell(c), "formula", TON_FMT);
  noteRow(ws, "供給可能量が納入対象を上回れば期末在庫、下回れば期末受注残になります（両方が同時に正数にはなりません）。");

  ws.addRow([]);

  // --- §4-6 Worker計画 ---
  sectionTitle(ws, "3. Worker計画");
  noteRow(
    ws,
    "必要Worker数は、ゲームエンジンの商品別労働集約度（HOSO:PD:VAP＝1.0:1.2:3.0 を反映した実効処理量）から逆算しています。Excel側で別の生産性を定義していません。"
  );
  header(ws, ["項目", "HOSO", "PD", "VAP", "合計", "", "", "", ""]);

  const requiredWorkerRow = ws.rowCount + 1;
  const rwRow = ws.addRow([
    "予定生産に必要なWorker数",
    { formula: `IF(B${laborRow}=0,"${DASH}",CEILING(B${productionRow}/B${laborRow},1))` },
    { formula: `IF(C${laborRow}=0,"${DASH}",CEILING(C${productionRow}/C${laborRow},1))` },
    { formula: `IF(D${laborRow}=0,"${DASH}",CEILING(D${productionRow}/D${laborRow},1))` },
    { formula: `SUM(B${requiredWorkerRow}:D${requiredWorkerRow})` },
  ]);
  paint(rwRow.getCell(1), "formula");
  for (const c of [2, 3, 4, 5]) paint(rwRow.getCell(c), "formula", "#,##0");

  const openingWorkers = currentRegularWorkers(payload);
  const owRow = ws.rowCount + 1;
  const oRow = ws.addRow(["期首Worker人数（常用）", "", "", "", openingWorkers ?? DASH]);
  paint(oRow.getCell(1), "actual");
  paint(oRow.getCell(5), "actual", "#,##0");

  const deltaRow = ws.rowCount + 1;
  const dRow = ws.addRow(["【入力】Worker増減人数", "", "", "", null]);
  paint(dRow.getCell(1), "input");
  paint(dRow.getCell(5), "input", "#,##0");

  const afterRow = ws.rowCount + 1;
  const aRow = ws.addRow(["増減後 予定Worker人数", "", "", "", { formula: `E${owRow}+E${deltaRow}` }]);
  paint(aRow.getCell(1), "formula");
  paint(aRow.getCell(5), "formula", "#,##0");

  const gapRow = ws.addRow(["Worker 余剰(+) / 不足(−) 人数", "", "", "", { formula: `E${afterRow}-E${requiredWorkerRow}` }]);
  paint(gapRow.getCell(1), "formula");
  paint(gapRow.getCell(5), "formula", "#,##0");
  noteRow(ws, `期首 ${openingWorkers ?? DASH} 人 → 増減後の予定人数（E${afterRow}）を並べて比較できます。`);
}

/** 期首（当四半期処理前）の未履行契約残を商品別に集計する。 */
function beginningBacklogByProduct(payload: CompanyExportPayload): Record<string, number> {
  const out: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const c of payload.salesContracts) {
    if (out[c.product] === undefined) continue;
    out[c.product] += c.beginningOutstandingQuantity;
  }
  return out;
}

/** 商品別の実効設備能力（processingCapacityが無ければ0を返さず「－」相当の0にしない）。 */
function effectiveCapacityFor(capacity: CompanyExportPayload["processingCapacity"], product: string): number | string {
  if (!capacity) return DASH;
  const byProduct = capacity as unknown as Record<string, unknown>;
  const key = `${product}Capacity`;
  const v = byProduct[key];
  return typeof v === "number" && Number.isFinite(v) ? v : DASH;
}

/** 当期の常用Worker配置人数（意思決定から読む）。 */
function currentRegularWorkers(payload: CompanyExportPayload): number | undefined {
  const assignments = payload.decisionInfo.submission?.workerAssignments;
  if (!assignments || assignments.length === 0) return undefined;
  return assignments.reduce((s, a) => s + (a.regularHeadcount ?? 0), 0);
}

/** §4-7 原料調達計画。 */
function writeRawProcurementPlanSection(ws: ExcelJS.Worksheet, payload: CompanyExportPayload): void {
  sectionTitle(ws, "4. 原料調達計画");
  const procurement = summarizeRawProcurement(payload.operations.rawMaterialLots.ending, payload.meta.period);
  noteRow(
    ws,
    "必要原料量は、ゲームの原料換算（HOSO換算トン基準・歩留まり1.00）に従い、予定生産数量の合計と同量として計算しています。参考単価は当期の調達実績（調達元別の加重平均）です。買付価格は意思決定項目なので、価格欄も入力できるようにしています。"
  );
  header(ws, ["調達元", "【入力】調達予定数量(t)", "【入力】予定単価(USD/kg)", "予定原料費(USD)", "参考: 当期実績単価(USD/kg)", "", "", "", ""]);

  const sources: readonly { readonly key: string; readonly label: string }[] = [
    { key: "aquaculture", label: "自社養殖 投入予定" },
    { key: "domesticPurchase", label: "国内原料 調達予定" },
    { key: "import", label: "輸入原料 調達予定" },
  ];
  const firstSourceRow = ws.rowCount + 1;
  for (const s of sources) {
    const r = ws.rowCount + 1;
    const actual = procurement.bySource.find((x) => x.source === s.key);
    const row = ws.addRow([
      s.label,
      null,
      null,
      { formula: `B${r}*1000*C${r}` },
      actual?.averageUnitCostUsdPerKg === undefined ? DASH : actual.averageUnitCostUsdPerKg,
    ]);
    paint(row.getCell(1), "actual");
    paint(row.getCell(2), "input", TON_FMT);
    paint(row.getCell(3), "input", USD_KG_FMT);
    paint(row.getCell(4), "formula", USD_FMT);
    paint(row.getCell(5), "actual", USD_KG_FMT);
  }
  const lastSourceRow = ws.rowCount;
  const planTotalRow = ws.rowCount + 1;
  const ptRow = ws.addRow([
    "調達予定合計",
    { formula: `SUM(B${firstSourceRow}:B${lastSourceRow})` },
    { formula: `IF(B${planTotalRow}=0,"${DASH}",D${planTotalRow}/(B${planTotalRow}*1000))` },
    { formula: `SUM(D${firstSourceRow}:D${lastSourceRow})` },
    "",
  ]);
  ptRow.getCell(1).font = BOLD_FONT;
  for (const c of [2, 3, 4]) paint(ptRow.getCell(c), "formula", c === 2 ? TON_FMT : c === 3 ? USD_KG_FMT : USD_FMT);
  noteRow(ws, "加重平均予定原料単価 ＝ 予定原料費合計 ÷ 調達予定数量kg（数量0のときは「－」）。");

  // 必要原料量と過不足（生産計画セクションの生産予定合計を参照する）
  const productionTotalCell = findProductionTotalCell(ws);
  const needRow = ws.rowCount + 1;
  const nRow = ws.addRow(["必要原料量（＝予定生産合計）", { formula: productionTotalCell }, "", "", ""]);
  paint(nRow.getCell(1), "formula");
  paint(nRow.getCell(2), "formula", TON_FMT);

  const gapRow = ws.addRow([
    "原料 余剰(+) / 不足(−)",
    { formula: `B${planTotalRow}-B${needRow}` },
    "", "", "",
  ]);
  paint(gapRow.getCell(1), "formula");
  paint(gapRow.getCell(2), "formula", TON_FMT);
}

/** 生産予定合計セルの参照を返す（「【入力】生産予定数量」行のE列）。 */
function findProductionTotalCell(ws: ExcelJS.Worksheet): string {
  let target = "";
  ws.eachRow((row, rowNumber) => {
    const v = row.getCell(1).value;
    if (typeof v === "string" && v.startsWith("【入力】生産予定数量")) target = `E${rowNumber}`;
  });
  return target === "" ? "0" : target;
}

/** §4-8 / §4-9 その他の意思決定欄。 */
function writeOtherDecisionsSection(ws: ExcelJS.Worksheet, payload: CompanyExportPayload): void {
  sectionTitle(ws, "5. その他の次期意思決定（設備投資は対象外）");
  header(ws, ["項目", "当期の実績・設定", "【入力】次期の計画", "備考", "", "", "", "", ""]);

  const submission = payload.decisionInfo.submission;
  const priorityByProduct = new Map<string, number>();
  for (const p of submission?.productionPlans ?? []) priorityByProduct.set(p.product, p.priority);

  const rows: readonly { readonly label: string; readonly actual: number | string; readonly note: string }[] = [
    { label: "生産優先順位 HOSO", actual: priorityByProduct.get("hoso") ?? DASH, note: "1が最優先。未履行契約のある商品が優先される" },
    { label: "生産優先順位 PD", actual: priorityByProduct.get("pd") ?? DASH, note: "" },
    { label: "生産優先順位 VAP", actual: priorityByProduct.get("vap") ?? DASH, note: "" },
    { label: "国内買付 提示価格調整 (USD/kg)", actual: submission?.domesticPurchasePlan?.priceAdjustmentUsdPerHosoEqKg ?? DASH, note: "参照価格に対する上乗せ／値引き" },
    { label: "臨時Worker人数", actual: (submission?.workerAssignments ?? []).reduce((s, a) => s + (a.temporaryHeadcount ?? 0), 0), note: "常用より効率は低いが即時利用可能" },
    { label: "残業率", actual: Math.max(0, ...(submission?.workerAssignments ?? []).map((a) => a.overtimeRate ?? 0)), note: "上限あり。超過分は効率が逓減する" },
    { label: "借入希望額 (USD)", actual: submission?.financingRequest?.desiredAmountUsd ?? DASH, note: "審査により減額・否決されることがある" },
    { label: "期限前返済希望額 (USD)", actual: submission?.financingRequest?.desiredPrepaymentUsd ?? DASH, note: "" },
    { label: "VAP商品開発費 (USD)", actual: submission?.vapProductDevelopmentSpendUsd ?? DASH, note: "" },
  ];
  for (const r of rows) {
    const row = ws.addRow([r.label, r.actual, null, r.note]);
    paint(row.getCell(1), "actual");
    paint(row.getCell(2), "actual");
    paint(row.getCell(3), "input");
    row.getCell(4).font = LABEL_FONT;
  }
  noteRow(ws, "市場別の販売価格・営業配分は上の「1. 販売計画」で入力してください。設備投資は今回のシートの対象外です。");
}

/**
 * §4-10 AIコメント欄。
 *
 * 【新しいAPI呼び出しはしない】生成AI・Claude API・外部APIへの呼び出しは一切追加せず、
 * Export payload に既に存在する Standard AI の診断情報（理由コード・ボトルネック）を
 * 人が読める形へ整形するだけ。十分なデータが無い場合はその旨を明示する。
 */
function writeAiCommentSection(ws: ExcelJS.Worksheet, payload: CompanyExportPayload): void {
  sectionTitle(ws, "AIコメント（当期のStandard AI診断より）");
  // Export payload に既に存在する当期の理由コード（Standard AI・エンジンの診断）だけを使う。
  const entries = payload.decisionInfo.reasonCodes;
  if (entries.length === 0) {
    noteRow(ws, "AIコメント: 現在Export可能な診断情報なし");
    return;
  }
  // 同じ理由コードの重複を除き、先頭10件までを簡潔に並べる。
  const seen = new Set<string>();
  let shown = 0;
  for (const e of entries) {
    if (seen.has(e.code) || shown >= 10) continue;
    seen.add(e.code);
    shown += 1;
    noteRow(ws, `・[${e.code}] ${e.message}`);
  }
}
