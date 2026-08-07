// ShrimpX V2 — Phase SAI-3B-2: 経営KPIダッシュボード・グラフ拡充
//
// 【方針】ここでは新しい集計・新しい計算は一切行わない。aggregate.ts/
// buildAnalysis.tsがすでに組み立てたSai3bAnalysis（companyQuarterStats・
// marketShareStats・headcountDivergence等）を、会社別・市場別の時系列
// チャートへ変換するだけの表示層である（三宅さんの指示§9：KPI定義・
// データ抽出・集計・表示単位・グラフ種別・系列定義・色・タイトル・シート配置・
// 欠損値処理・比較方法を分離する）。
//
// 【KPI定義とグラフ生成を分離する軽量なレジストリ】CompanyQuarterKpiSpecが
// 「どのフィールドを・どの単位で・どのグラフ種別で・どの中央値/平均で表示するか」
// を1箇所にまとめており、writeWorkbook.tsへKPIごとの描画コードを直接ハード
// コードしない（三宅さんの指示§9）。ShrimpX固有の商品(hoso/pd/vap)・
// 市場(CN/US/EU/JP/OTHER)固有の概念は市場シェアシート側にのみ現れ、
// 会社×四半期の一般的なKPI（売上・利益・現金・借入・在庫等）はドメイン非依存の
// 構造で扱われる（docs/v2/reusable-analysis/kpi_catalog.md参照）。

import ExcelJS from "exceljs";
import { CompanyQuarterStatRow, HeadcountDivergenceRow, LoadedSai3aRun, MarketShareStatRow, Sai3bAnalysis, StatSummary } from "../schema";
import { ChartSeriesSpec, ChartSpec } from "./chartInjector";
import {
  applyFreezeAndFilter,
  BODY_FONT,
  CANONICAL_COMPANY_ORDER,
  columnLetter,
  companyColorHex,
  NOTE_FONT,
  QUANTITY_FORMAT,
  RATE_FORMAT,
  SUBHEADER_FILL,
  SUBHEADER_FONT,
  USD_FORMAT,
  writeHeaderRow,
} from "./styles";

export interface SheetChartResult {
  readonly sheetName: string;
  readonly specs: ChartSpec[];
}

type NumFormat = "usd" | "quantity" | "rate";
const NUM_FMT: Readonly<Record<NumFormat, string>> = { usd: USD_FORMAT, quantity: QUANTITY_FORMAT, rate: RATE_FORMAT };

function companiesForRun(run: LoadedSai3aRun): readonly string[] {
  const present = new Set<string>(run.manifest.companyIds);
  const ordered = CANONICAL_COMPANY_ORDER.filter((c) => present.has(c));
  const extra = Array.from(present).filter((c) => !CANONICAL_COMPANY_ORDER.includes(c)).sort();
  return [...ordered, ...extra];
}

function writeSubheader(ws: ExcelJS.Worksheet, text: string): number {
  const row = ws.addRow([text]);
  row.getCell(1).font = SUBHEADER_FONT;
  row.getCell(1).fill = SUBHEADER_FILL;
  return row.number;
}

function writeNote(ws: ExcelJS.Worksheet, text: string): void {
  const row = ws.addRow([text]);
  row.getCell(1).font = NOTE_FONT;
  row.getCell(1).alignment = { wrapText: true };
}

// ---------------------------------------------------------------------
// 会社×四半期KPIレジストリ（軽量版・§9）
// ---------------------------------------------------------------------

interface CompanyQuarterKpiSpec {
  readonly title: string;
  readonly format: NumFormat;
  readonly chartType: "bar" | "line";
  readonly note: string;
  readonly extract: (row: CompanyQuarterStatRow) => number | undefined;
  /**
   * Layer2（会社・seed比較表：平均・中央値・最小・最大・標準偏差・seed数・
   * defaultしたseed数）の元になる、そのKPIのStatSummary全体を返す関数
   * （三宅さんのご指摘（受入レビュー2回目）§1で追加）。多くのKPIは
   * `extract`が読んでいるのと同じStatSummaryフィールドをそのまま返すだけで
   * よい。H-5（運転資金の部分指標）のように、複数のStatSummaryのmedian同士の
   * 差分として計算される「合成KPI」は、個々のseedへ遡れないためLayer2の
   * 分布統計を正しく再構成できない。そのようなKPIはこのフィールドを省略し
   * （undefinedのまま）、Layer2側で「分布統計は算出不可」と明記して捏造を避ける。
   */
  readonly extractStat?: (row: CompanyQuarterStatRow) => StatSummary | undefined;
}

/**
 * 会社×四半期の1つのKPIについて、データ表（中央値のピボット表）＋会社別統計
 * （Layer2：平均/最小/最大・延べdefault seed数）を書き込み、対応するネイティブ
 * グラフのChartSpecを返す（値が1件も無ければテーブルを書かずnoteのみ残し、
 * undefinedを返す＝「現時点の出力データでは作成不能」の扱い）。
 */
function writeCompanyQuarterBlock(
  ws: ExcelJS.Worksheet,
  sheetName: string,
  run: LoadedSai3aRun,
  statsForRun: readonly CompanyQuarterStatRow[],
  companies: readonly string[],
  kpi: CompanyQuarterKpiSpec,
  chartAnchorCol: number
): ChartSpec | undefined {
  const turns = Array.from(new Set(statsForRun.map((s) => s.turn))).sort((a, b) => a - b);
  writeSubheader(ws, `${kpi.title}（run: ${run.runLabel}／営業人数${run.manifest.salesForceHeadcountTotal}人）`);
  writeNote(ws, kpi.note);

  if (turns.length === 0 || statsForRun.every((s) => kpi.extract(s) === undefined)) {
    writeNote(ws, "現時点の出力データでは作成不能（対応する値が1件も取得できませんでした）。");
    ws.addRow([]);
    return undefined;
  }

  const headerRowNumber = ws.rowCount + 1;
  writeHeaderRow(ws, ["quarter", ...companies]);
  const dataStartRow = headerRowNumber + 1;
  const periodByTurn = new Map<number, string>();
  for (const turn of turns) {
    const period = statsForRun.find((s) => s.turn === turn)?.period ?? `T${turn}`;
    periodByTurn.set(turn, period);
    const values: (string | number)[] = [period];
    for (const c of companies) {
      const s = statsForRun.find((x) => x.companyId === c && x.turn === turn);
      const v = s ? kpi.extract(s) : undefined;
      values.push(v ?? "");
    }
    const row = ws.addRow(values);
    row.getCell(1).font = BODY_FONT;
    companies.forEach((_, i) => {
      const cell = row.getCell(i + 2);
      cell.font = BODY_FONT;
      cell.numFmt = NUM_FMT[kpi.format];
    });
  }
  const dataEndRow = ws.rowCount;

  ws.addRow([]);
  // Layer2: 会社・seed比較表（seed横断の分布統計）。Layer1（直上のピボット表）は
  // 「turn×会社」を軸とした中央値のみの時系列表であるのに対し、Layer2は
  // 「turn×会社ごとに、その裏にあるseed群の分布そのもの」を見せる表であり、
  // 目的が異なる（三宅さんのご指摘（受入レビュー2回目）§1）。両者を明確に
  // 区別するため、専用のsubheaderを立てて視覚的にもLayer1と分離する。
  writeSubheader(ws, "Layer2: 会社・seed比較表（seed横断の分布統計）");
  if (!kpi.extractStat) {
    writeNote(
      ws,
      "このKPIは複数のStatSummary（例: 売掛金・買掛金それぞれの中央値）から算出される合成指標のため、" +
        "個々のseedへ遡って分布を再構成することができません。捏造を避けるため、Layer2の分布統計は" +
        "算出不可としています（平均・中央値等の欠測ではなく、定義上算出できないという意味です）。"
    );
  } else {
    const extractStat = kpi.extractStat;
    writeHeaderRow(ws, ["quarter", "会社", "平均", "中央値", "最小", "最大", "標準偏差", "seed数(n)", "defaultしたseed数"]);
    for (const turn of turns) {
      const period = periodByTurn.get(turn) ?? `T${turn}`;
      for (const c of companies) {
        const s = statsForRun.find((x) => x.companyId === c && x.turn === turn);
        const stat: StatSummary | undefined = s ? extractStat(s) : undefined;
        const row = ws.addRow([
          period,
          c,
          stat?.average ?? "",
          stat?.median ?? "",
          stat?.min ?? "",
          stat?.max ?? "",
          stat?.stddev ?? "",
          stat?.n ?? "",
          s?.defaultedSeedCount ?? "",
        ]);
        row.eachCell((cell, colNumber) => {
          cell.font = BODY_FONT;
          if (colNumber >= 3 && colNumber <= 7) cell.numFmt = NUM_FMT[kpi.format];
        });
      }
    }
  }
  ws.addRow([]);
  ws.addRow([]);

  const sheetRef = `'${sheetName}'`;
  const categoriesRef = `${sheetRef}!$A$${dataStartRow}:$A$${dataEndRow}`;
  const categories = turns.map((t) => periodByTurn.get(t) ?? `T${t}`);
  const series: ChartSeriesSpec[] = companies.map((c, i) => {
    const colLetter = columnLetter(i + 2);
    const values = turns.map((t) => {
      const s = statsForRun.find((x) => x.companyId === c && x.turn === t);
      return s ? kpi.extract(s) : undefined;
    });
    return {
      name: c,
      valuesRef: `${sheetRef}!$${colLetter}$${dataStartRow}:$${colLetter}$${dataEndRow}`,
      values,
      colorHex: companyColorHex(c),
    };
  });

  return {
    title: `${kpi.title}（${run.runLabel}）`,
    type: kpi.chartType,
    categoriesRef,
    categories,
    series,
    anchorCol: chartAnchorCol,
    anchorRow: Math.max(0, headerRowNumber - 3),
    widthCols: 10,
    heightRows: 15,
  };
}

/** 1シートぶんの複数KPIブロックをrunごとに縦積みで書き込む共通処理。 */
function writeKpiBlocksSheet(wb: ExcelJS.Workbook, sheetName: string, analysis: Sai3bAnalysis, kpis: readonly CompanyQuarterKpiSpec[]): SheetChartResult {
  const ws = wb.addWorksheet(sheetName);
  ws.columns = [{ width: 14 }, ...Array.from({ length: 6 }, () => ({ width: 16 }))];
  const specs: ChartSpec[] = [];
  const chartAnchorCol = 8;

  for (const run of analysis.loadedRuns) {
    const companies = companiesForRun(run);
    const statsForRun = analysis.companyQuarterStats.filter((s) => s.runLabel === run.runLabel);
    for (const kpi of kpis) {
      const spec = writeCompanyQuarterBlock(ws, sheetName, run, statsForRun, companies, kpi, chartAnchorCol);
      if (spec) specs.push(spec);
    }
  }
  applyFreezeAndFilter(ws, 1, 1);
  return { sheetName, specs };
}

// ---------------------------------------------------------------------
// 2. 売上・数量推移（A・B）
// ---------------------------------------------------------------------

const SALES_QUANTITY_KPIS: readonly CompanyQuarterKpiSpec[] = [
  {
    title: "A. 会社別売上高推移",
    format: "usd",
    chartType: "bar",
    note: "単位: USD（純売上、seed横断の中央値）。同一営業人数条件・同一シナリオ内での比較。",
    extract: (r) => r.netRevenueUsd.median,
    extractStat: (r) => r.netRevenueUsd,
  },
  {
    title: "B. 会社別販売数量推移（市場配分ベースの実績）",
    format: "quantity",
    chartType: "bar",
    note:
      "単位: HOSO換算トン（seed横断の中央値）。market-allocation-trace.csv由来の、市場清算で実際に配分を得た数量" +
      "（実績に相当）。これはengineへ提出された「最終計画数量」（wish後の計画値。四半期業績シートのfinalPlannedSalesQuantityTotal）" +
      "とは異なる値であり、実績と計画を混同しないよう別集計にしている。market-allocation-trace.csvを含まない古いrunでは作成不能。",
    extract: (r) => r.actualSalesQuantityHosoEqTons.median,
    extractStat: (r) => r.actualSalesQuantityHosoEqTons,
  },
];

export function writeSalesQuantitySheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): SheetChartResult {
  return writeKpiBlocksSheet(wb, "売上・数量推移", analysis, SALES_QUANTITY_KPIS);
}

// ---------------------------------------------------------------------
// 4. 利益・採算推移（D）
// ---------------------------------------------------------------------

const PROFITABILITY_KPIS: readonly CompanyQuarterKpiSpec[] = [
  {
    title: "D-1. 会社別売上総利益推移",
    format: "usd",
    chartType: "bar",
    note: "単位: USD（seed横断の中央値）。",
    extract: (r) => r.grossProfitUsd.median,
    extractStat: (r) => r.grossProfitUsd,
  },
  {
    title: "D-2. 会社別粗利益率推移",
    format: "rate",
    chartType: "line",
    note: "粗利益÷売上（seed横断の中央値）。金額と%を同一グラフに混在させないため、D-1（金額）とは別グラフにしている。",
    extract: (r) => r.grossMarginRate.median,
    extractStat: (r) => r.grossMarginRate,
  },
  {
    title: "D-3. 会社別営業利益推移",
    format: "usd",
    chartType: "bar",
    note: "単位: USD（seed横断の中央値）。",
    extract: (r) => r.operatingProfitUsd.median,
    extractStat: (r) => r.operatingProfitUsd,
  },
  {
    title: "D-4. 会社別純利益推移",
    format: "usd",
    chartType: "bar",
    note: "単位: USD（seed横断の中央値）。",
    extract: (r) => r.netIncomeUsd.median,
    extractStat: (r) => r.netIncomeUsd,
  },
];

export function writeProfitabilitySheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): SheetChartResult {
  return writeKpiBlocksSheet(wb, "利益・採算推移", analysis, PROFITABILITY_KPIS);
}

// ---------------------------------------------------------------------
// 5. 資金繰り・財務推移（E・F・G）
// ---------------------------------------------------------------------

const CASH_FINANCE_KPIS: readonly CompanyQuarterKpiSpec[] = [
  {
    title: "E. 会社別期末現金残高推移",
    format: "usd",
    chartType: "line",
    note: "単位: USD（seed横断の中央値）。マイナス値も実額のまま表示（負の現金＝債務超過の目安）。default発生turnは会社別統計の「延べdefault seed-quarter数」欄で把握できる。",
    extract: (r) => r.closingCashUsd.median,
    extractStat: (r) => r.closingCashUsd,
  },
  {
    title: "F-1. 会社別営業キャッシュフロー推移",
    format: "usd",
    chartType: "bar",
    note: "単位: USD（seed横断の中央値）。現金残高（水準）とキャッシュフロー（増減）は別概念のため、E（水準）とは別グラフにしている。",
    extract: (r) => r.operatingCashFlowUsd.median,
    extractStat: (r) => r.operatingCashFlowUsd,
  },
  {
    title: "F-2. 会社別投資キャッシュフロー推移",
    format: "usd",
    chartType: "bar",
    note: "単位: USD（seed横断の中央値）。",
    extract: (r) => r.investingCashFlowUsd.median,
    extractStat: (r) => r.investingCashFlowUsd,
  },
  {
    title: "F-3. 会社別財務キャッシュフロー推移",
    format: "usd",
    chartType: "bar",
    note: "単位: USD（seed横断の中央値）。",
    extract: (r) => r.financingCashFlowUsd.median,
    extractStat: (r) => r.financingCashFlowUsd,
  },
  {
    title: "G-1. 会社別短期借入推移",
    format: "usd",
    chartType: "bar",
    note: "単位: USD（seed横断の中央値、期末残高）。",
    extract: (r) => r.shortTermLoansUsd.median,
    extractStat: (r) => r.shortTermLoansUsd,
  },
  {
    title: "G-2. 会社別長期借入推移",
    format: "usd",
    chartType: "bar",
    note: "単位: USD（seed横断の中央値、期末残高）。",
    extract: (r) => r.longTermLoansUsd.median,
    extractStat: (r) => r.longTermLoansUsd,
  },
  {
    title: "G-3. 会社別追加融資余力推移",
    format: "usd",
    chartType: "line",
    note: "単位: USD（seed横断の中央値、期末値）。0付近まで下がるとunderwriting frozenに近いことを示す（Default_信用_警告シート参照）。",
    extract: (r) => r.availableAdditionalCapacityUsd.median,
    extractStat: (r) => r.availableAdditionalCapacityUsd,
  },
];

export function writeCashFinanceSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): SheetChartResult {
  return writeKpiBlocksSheet(wb, "資金繰り・財務推移", analysis, CASH_FINANCE_KPIS);
}

// ---------------------------------------------------------------------
// 6. 在庫・運転資金推移（H）
// ---------------------------------------------------------------------

const INVENTORY_WORKING_CAPITAL_KPIS: readonly CompanyQuarterKpiSpec[] = [
  {
    title: "H-1. 会社別原料在庫推移",
    format: "quantity",
    chartType: "line",
    note: "単位: HOSO換算トン（seed横断の中央値、期末値）。",
    extract: (r) => r.rawMaterialInventoryHosoEqTons.median,
    extractStat: (r) => r.rawMaterialInventoryHosoEqTons,
  },
  {
    title: "H-2. 会社別製品在庫推移",
    format: "quantity",
    chartType: "line",
    note: "単位: HOSO換算トン（seed横断の中央値、期末値）。",
    extract: (r) => r.finishedGoodsInventoryHosoEqTons.median,
    extractStat: (r) => r.finishedGoodsInventoryHosoEqTons,
  },
  {
    title: "H-3. 会社別売掛金推移（期首時点）",
    format: "usd",
    chartType: "line",
    note: "単位: USD（seed横断の中央値、四半期「開始」時点。期末残高はSAI-3Aの出力に含まれていないため取得できない）。",
    extract: (r) => r.accountsReceivableUsdAtStart.median,
    extractStat: (r) => r.accountsReceivableUsdAtStart,
  },
  {
    title: "H-4. 会社別買掛金推移（期首時点）",
    format: "usd",
    chartType: "line",
    note: "単位: USD（seed横断の中央値、四半期「開始」時点。期末残高は取得できない）。",
    extract: (r) => r.accountsPayableUsdAtStart.median,
    extractStat: (r) => r.accountsPayableUsdAtStart,
  },
  {
    title: "H-5.（参考・一部作成可能）運転資金の部分指標（在庫除く、期首AR-AP）",
    format: "usd",
    chartType: "line",
    note:
      "定義: 運転資金の部分指標 = 期首売掛金 − 期首買掛金（USD建て）。原料・製品在庫はUSD評価額がSAI-3Aの出力に" +
      "含まれていないため（トン単位の物理数量のみ）、標準的な「運転資金＝売掛金＋在庫−買掛金」の完全な金額ベース算出は" +
      "現時点の出力データでは作成不能。在庫の推移はH-1・H-2（物理数量）を別途参照すること。",
    extract: (r) => {
      const ar = r.accountsReceivableUsdAtStart.median;
      const ap = r.accountsPayableUsdAtStart.median;
      return ar !== undefined && ap !== undefined ? ar - ap : undefined;
    },
  },
];

export function writeInventoryWorkingCapitalSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): SheetChartResult {
  return writeKpiBlocksSheet(wb, "在庫・運転資金推移", analysis, INVENTORY_WORKING_CAPITAL_KPIS);
}

// ---------------------------------------------------------------------
// 3. 市場別シェア推移（C）— 会社×四半期の一般パターンとは別構造
// （市場ごとに1グラフ。全市場・全系列を1枚に詰め込まない）。
// ---------------------------------------------------------------------

export function writeMarketShareSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): SheetChartResult {
  const sheetName = "市場シェア推移";
  const ws = wb.addWorksheet(sheetName);
  ws.columns = [{ width: 14 }, ...Array.from({ length: 6 }, () => ({ width: 16 }))];
  const specs: ChartSpec[] = [];
  const chartAnchorCol = 8;

  if (analysis.marketShareStats.length === 0) {
    writeNote(
      ws,
      "現時点の出力データでは作成不能: market-allocation-trace.csvを含むrunがありません" +
        "（SAI-3B-2より前に生成されたrunディレクトリを読み込んだ可能性）。"
    );
    return { sheetName, specs };
  }

  writeNote(
    ws,
    "quantityShare = 自社の配分数量（商品を問わず合算） ÷ 同一run×seed×turn×市場で実際に配分エントリを持つ全社の配分数量合計" +
      "（外部オプション枠externalOptionQuantityは含まない）。売上ベースのシェア（revenueShare）は市場別の実現収益がSAI-3Aの" +
      "出力に含まれておらず、価格からの逆算は捏造になるため意図的に提供しない（数量シェアのみ）。5社が揃っていない市場×turnは" +
      "会社別統計の「参加社数」欄で分かるようにしており、無理に100%へ補正していない。"
  );

  for (const run of analysis.loadedRuns) {
    const statsForRun = analysis.marketShareStats.filter((s) => s.runLabel === run.runLabel);
    if (statsForRun.length === 0) {
      writeSubheader(ws, `市場別シェア推移（run: ${run.runLabel}）`);
      writeNote(ws, "このrunにはmarket-allocation-trace.csvがありません。現時点の出力データでは作成不能。");
      ws.addRow([]);
      continue;
    }
    const companies = companiesForRun(run);
    const markets = Array.from(new Set(statsForRun.map((s) => s.market))).sort();

    for (const market of markets) {
      const marketStats = statsForRun.filter((s) => s.market === market);
      const turns = Array.from(new Set(marketStats.map((s) => s.turn))).sort((a, b) => a - b);

      writeSubheader(ws, `市場別シェア推移: ${market}市場（run: ${run.runLabel}／営業人数${run.manifest.salesForceHeadcountTotal}人）`);
      const headerRowNumber = ws.rowCount + 1;
      writeHeaderRow(ws, ["quarter", ...companies, "参加社数(5社中)"]);
      const dataStartRow = headerRowNumber + 1;
      const periodByTurn = new Map<number, string>();
      for (const turn of turns) {
        const rowsAtTurn = marketStats.filter((s) => s.turn === turn);
        const period = rowsAtTurn[0]?.period ?? `T${turn}`;
        periodByTurn.set(turn, period);
        const participantCount = new Set(rowsAtTurn.map((s) => s.companyId)).size;
        const values: (string | number)[] = [period];
        for (const c of companies) {
          const s = rowsAtTurn.find((x) => x.companyId === c);
          values.push(s?.quantityShareMedian ?? "");
        }
        values.push(participantCount);
        const row = ws.addRow(values);
        row.getCell(1).font = BODY_FONT;
        companies.forEach((_, i) => {
          const cell = row.getCell(i + 2);
          cell.font = BODY_FONT;
          cell.numFmt = RATE_FORMAT;
        });
        row.getCell(companies.length + 2).font = BODY_FONT;
      }
      const dataEndRow = ws.rowCount;
      ws.addRow([]);
      ws.addRow([]);

      const sheetRef = `'${sheetName}'`;
      const categoriesRef = `${sheetRef}!$A$${dataStartRow}:$A$${dataEndRow}`;
      const categories = turns.map((t) => periodByTurn.get(t) ?? `T${t}`);
      const series: ChartSeriesSpec[] = companies.map((c, i) => {
        const colLetter = columnLetter(i + 2);
        const values = turns.map((t) => marketStats.find((x) => x.companyId === c && x.turn === t)?.quantityShareMedian);
        return {
          name: c,
          valuesRef: `${sheetRef}!$${colLetter}$${dataStartRow}:$${colLetter}$${dataEndRow}`,
          values,
          colorHex: companyColorHex(c),
        };
      });

      specs.push({
        title: `${market}市場 数量シェア推移（${run.runLabel}）`,
        type: "line",
        categoriesRef,
        categories,
        series,
        anchorCol: chartAnchorCol,
        anchorRow: Math.max(0, headerRowNumber - 2),
        widthCols: 10,
        heightRows: 15,
      });
    }
  }

  applyFreezeAndFilter(ws, 1, 1);
  return { sheetName, specs };
}

// ---------------------------------------------------------------------
// 1. 経営ダッシュボード（ランディングページ：最新四半期スナップショット＋ナビゲーション）
// ---------------------------------------------------------------------

const DASHBOARD_SHEET_ORDER: readonly string[] = [
  "全体サマリー",
  "売上・数量推移",
  "市場シェア推移",
  "利益・採算推移",
  "資金繰り・財務推移",
  "在庫・運転資金推移",
];

export function writeExecutiveDashboardSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): SheetChartResult {
  const sheetName = "経営ダッシュボード";
  const ws = wb.addWorksheet(sheetName);
  ws.columns = [{ width: 20 }, ...Array.from({ length: 6 }, () => ({ width: 16 }))];
  const specs: ChartSpec[] = [];

  writeHeaderRow(ws, ["ShrimpX V2 経営ダッシュボード", "", "", "", "", "", ""]);
  writeNote(
    ws,
    "5秒で状況を把握するための入口ページ。詳細は下記シートを参照（Excelのシートタブから移動、またはこの下のリンク）。" +
      "値はいずれもseed横断の中央値（外れ値・defaultケースの影響を受けにくくするため。README「集計単位に関する注意」参照）。"
  );
  ws.addRow([]);

  writeSubheader(ws, "詳細シートへのナビゲーション");
  for (const name of DASHBOARD_SHEET_ORDER) {
    const row = ws.addRow([name]);
    const cell = row.getCell(1);
    cell.value = { text: `▶ ${name}`, hyperlink: `#'${name}'!A1` } as ExcelJS.CellHyperlinkValue;
    cell.font = { ...BODY_FONT, color: { argb: "FF0563C1" }, underline: true };
  }
  ws.addRow([]);

  for (const run of analysis.loadedRuns) {
    const companies = companiesForRun(run);
    const statsForRun = analysis.companyQuarterStats.filter((s) => s.runLabel === run.runLabel);
    const maxTurn = Math.max(0, ...statsForRun.map((s) => s.turn));
    if (maxTurn === 0) continue;
    const latestRows = statsForRun.filter((s) => s.turn === maxTurn);
    const latestPeriod = latestRows[0]?.period ?? `T${maxTurn}`;
    const dashboardRow = analysis.dashboard.find((d) => d.runLabel === run.runLabel);

    writeSubheader(ws, `最新四半期スナップショット（run: ${run.runLabel}／営業人数${run.manifest.salesForceHeadcountTotal}人／${latestPeriod}時点）`);
    if (dashboardRow) {
      const kv = ws.addRow([
        "default率(ケース単位)",
        dashboardRow.paymentDefaultRateByCase,
        "総売上(USD)",
        dashboardRow.totalRevenueUsd,
        "総営業利益(USD)",
        dashboardRow.totalOperatingProfitUsd,
      ]);
      kv.getCell(2).numFmt = RATE_FORMAT;
      kv.getCell(4).numFmt = USD_FORMAT;
      kv.getCell(6).numFmt = USD_FORMAT;
      kv.eachCell((cell) => (cell.font = BODY_FONT));
    }

    const headerRowNumber = ws.rowCount + 1;
    writeHeaderRow(ws, ["会社", "売上(USD,中央値)", "粗利益率(中央値)", "営業利益(USD,中央値)", "期末現金(USD,中央値)", "短期+長期借入(USD,中央値)"]);
    const dataStartRow = headerRowNumber + 1;
    for (const c of companies) {
      const s = latestRows.find((x) => x.companyId === c);
      const loans = s && s.shortTermLoansUsd.median !== undefined && s.longTermLoansUsd.median !== undefined ? s.shortTermLoansUsd.median + s.longTermLoansUsd.median : undefined;
      const row = ws.addRow([c, s?.netRevenueUsd.median ?? "", s?.grossMarginRate.median ?? "", s?.operatingProfitUsd.median ?? "", s?.closingCashUsd.median ?? "", loans ?? ""]);
      row.getCell(2).numFmt = USD_FORMAT;
      row.getCell(3).numFmt = RATE_FORMAT;
      row.getCell(4).numFmt = USD_FORMAT;
      row.getCell(5).numFmt = USD_FORMAT;
      row.getCell(6).numFmt = USD_FORMAT;
      row.eachCell((cell) => (cell.font = BODY_FONT));
    }
    const dataEndRow = ws.rowCount;
    ws.addRow([]);
    ws.addRow([]);

    const sheetRef = `'${sheetName}'`;
    const categoriesRef = `${sheetRef}!$A$${dataStartRow}:$A$${dataEndRow}`;
    const categories = companies.slice();
    const values = companies.map((c) => latestRows.find((x) => x.companyId === c)?.netRevenueUsd.median);
    specs.push({
      title: `最新四半期(${latestPeriod})会社別売上（${run.runLabel}）`,
      type: "bar",
      categoriesRef,
      categories,
      series: [
        {
          name: "売上(USD)",
          valuesRef: `${sheetRef}!$B$${dataStartRow}:$B$${dataEndRow}`,
          values,
        },
      ],
      anchorCol: 8,
      anchorRow: Math.max(0, headerRowNumber - 4),
      widthCols: 10,
      heightRows: 15,
    });
  }

  if (analysis.headcountDivergence.length > 0) {
    writeSubheader(ws, "80/85/90人比較: 最初に乖離が始まった四半期（要約）");
    writeNote(ws, "原因の特定・断定は行わない機械的検出（相対乖離率が閾値を超えた最初のturn）。詳細は80_85_90人比較シート参照。");
    const headerRowNumber = ws.rowCount + 1;
    writeHeaderRow(ws, ["会社", "seed", "最初に乖離したturn", "乖離したKPI", "閾値"]);
    for (const d of analysis.headcountDivergence) {
      const row = ws.addRow([d.companyId, d.seed, d.firstDivergingTurn ?? "(乖離なし)", d.firstDivergingKpi ?? "", d.divergenceThreshold]);
      row.getCell(5).numFmt = RATE_FORMAT;
      row.eachCell((cell) => (cell.font = BODY_FONT));
    }
    void headerRowNumber;
  }

  applyFreezeAndFilter(ws, 1, 1);
  return { sheetName, specs };
}

/** SAI-3B-2の6ダッシュボードシートをすべて書き込み、各シートのChartSpecを返す。
 *  経営ダッシュボードのナビゲーションが参照する順（DASHBOARD_SHEET_ORDER）と
 *  一致させて追加する。 */
export function writeAllDashboardSheets(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): readonly SheetChartResult[] {
  const results: SheetChartResult[] = [];
  results.push(writeExecutiveDashboardSheet(wb, analysis));
  results.push(writeSalesQuantitySheet(wb, analysis));
  results.push(writeMarketShareSheet(wb, analysis));
  results.push(writeProfitabilitySheet(wb, analysis));
  results.push(writeCashFinanceSheet(wb, analysis));
  results.push(writeInventoryWorkingCapitalSheet(wb, analysis));
  return results;
}
