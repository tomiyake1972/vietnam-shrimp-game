// ShrimpX V2 — 前期PL（費用内訳）のビューモデル
//
// 【背景】Overview の業績には純売上・営業利益・純利益しか出ておらず、
// コスト構造を学ぶゲームなのにプレイヤーが費用を逆算するしかなかった
// （2026-11 テストプレイ指摘）。
//
// 【推計しない】ここに新しい計算式は無い。エンジンが確定させた
// CompanyFinancialQuarterReport の値を読み、表示の順に並べ替えるだけである。
// 唯一の算術は
//   (a) 同じ区分の確定値どうしの足し算（例: 営業人件費 = salesForceSalary + salesForceSeverance）
//   (b) 内訳の合計と確定合計の差を「その他（差分）」として明示すること
// の2つで、どちらも新しい前提を置いていない。差分はエンジンが内訳として
// 持っていない費目があることを隠さないために出す（勝手に按分しない）。
//
// 【合計の一致】ladder（純売上 → 売上原価 → 売上総利益 → 販管費 → 営業利益 →
// 営業外 → 当期純利益）の各段は、すべてPLの確定値そのものである。内訳の合計が
// その段と一致することは __tests__/profitAndLossBreakdown.test.ts で保証する。

import { CompanyFinancialQuarterResult, CostAccount, unwrapUsd } from "../../lib/v2/finance/types";

/** 1行ぶんの表示。amountUsd が null の項目は「未実装」として出す。 */
export interface ProfitAndLossRow {
  readonly key: string;
  readonly label: string;
  /** エンジンが値を持っていない費目は null（画面は「未実装」と表示する）。 */
  readonly amountUsd: number | null;
  /** 小計・合計行（太字で出す）。 */
  readonly emphasis?: boolean;
  /** その段の利益率（売上総利益率・営業利益率）。該当しない行では undefined。 */
  readonly marginRatio?: number;
  /** 1段下げて表示する内訳行。 */
  readonly indent?: boolean;
  readonly note?: string;
}

export interface PerKilogramMetric {
  readonly key: string;
  readonly label: string;
  /** 販売数量が渡されない場合は null（「未実装」ではなく「算定不可」）。 */
  readonly valueUsdPerKg: number | null;
}

export interface ProfitAndLossBreakdown {
  readonly rows: readonly ProfitAndLossRow[];
  readonly perKilogram: readonly PerKilogramMetric[];
  /** エンジンが内訳として持っていない費目（画面に「未実装」と出すもの）。 */
  readonly unavailableItems: readonly string[];
  /** 検算用。表示には使わない。 */
  readonly totals: {
    readonly netRevenueUsd: number;
    readonly totalCostOfSalesUsd: number;
    readonly grossProfitUsd: number;
    readonly sellingGeneralAdminUsd: number;
    readonly operatingProfitUsd: number;
    readonly netIncomeUsd: number;
  };
}

function sumCostRecords(result: CompanyFinancialQuarterResult, accounts: readonly CostAccount[]): number {
  return result.costRecords
    .filter((r) => accounts.includes(r.account))
    .reduce((sum, r) => sum + unwrapUsd(r.fixedPortion) + unwrapUsd(r.variablePortion), 0);
}

export interface BuildProfitAndLossBreakdownInput {
  readonly result: CompanyFinancialQuarterResult;
  /**
   * 当四半期に履行（販売）した数量（HOSO換算トン）。エンジンの確定値
   * （CompanyQuarterSummary.fulfilledQuantity）をそのまま渡す。
   * 渡されない呼び出し元では kgあたり指標を「算定不可」にする。
   */
  readonly soldQuantityHosoEqTons?: number;
}

export function buildProfitAndLossBreakdown(input: BuildProfitAndLossBreakdownInput): ProfitAndLossBreakdown {
  const { result } = input;
  const pl = result.profitAndLoss;
  const cos = pl.costOfSales;
  const mfg = result.manufacturingCost;
  const quality = result.qualityLoss;

  const netRevenue = unwrapUsd(pl.netRevenue);
  const totalCostOfSales = unwrapUsd(pl.totalCostOfSales);
  const grossProfit = unwrapUsd(pl.grossProfit);
  const sga = unwrapUsd(pl.sellingGeneralAdmin);
  const operatingProfit = unwrapUsd(pl.operatingProfit);
  const netIncome = unwrapUsd(pl.netIncome);

  const unavailable: string[] = [];

  // --- 売上原価の内訳（すべて PL の costOfSales の確定値。合計 = totalCostOfSales） ---
  const costOfSalesRows: ProfitAndLossRow[] = [
    { key: "cos-raw", label: "原料費（販売分）", amountUsd: unwrapUsd(cos.rawMaterialCost), indent: true },
    { key: "cos-processing", label: "加工費（販売分）", amountUsd: unwrapUsd(cos.processingCost), indent: true },
    { key: "cos-labor", label: "Worker人件費（販売分）", amountUsd: unwrapUsd(cos.laborCost), indent: true },
    { key: "cos-factory-fixed", label: "製造固定費・減価償却（販売分）", amountUsd: unwrapUsd(cos.factoryFixedCost), indent: true },
    { key: "cos-rework", label: "品質ロス: 再加工費", amountUsd: unwrapUsd(cos.reworkCost), indent: true },
    { key: "cos-discard", label: "品質ロス: 廃棄損", amountUsd: unwrapUsd(cos.discardLoss), indent: true },
    { key: "cos-unabsorbed", label: "未吸収固定製造費", amountUsd: unwrapUsd(cos.unabsorbedFixedManufacturingCost), indent: true },
    { key: "cos-idle-labor", label: "遊休労務費", amountUsd: unwrapUsd(cos.idleLaborCost), indent: true },
    { key: "cos-capex-maintenance", label: "設備保守費（投資設備）", amountUsd: unwrapUsd(cos.capexMaintenanceCost), indent: true },
    { key: "cos-factory-lifecycle", label: "工場維持費（休止・売却待ち）", amountUsd: unwrapUsd(cos.factoryLifecycleCarryingCost), indent: true },
  ];

  /**
   * 原料費の国内買付／輸入／自社養殖の別は、エンジンでは「当期に発生した製造原価」
   * （ManufacturingCostBreakdown）としてのみ確定しており、「販売分に含まれる原料費」
   * （CostOfSalesBreakdown.rawMaterialCost）には内訳が無い。在庫を挟むため両者は一致しない。
   * 勝手に按分すると推計になるため、発生ベースであることを明記して別掲する。
   */
  const rawMaterialIncurredRows: ProfitAndLossRow[] = [
    { key: "mfg-domestic", label: "国内買付", amountUsd: unwrapUsd(mfg.domesticRawMaterialCost), indent: true },
    { key: "mfg-import", label: "輸入", amountUsd: unwrapUsd(mfg.importedRawMaterialCost), indent: true },
    { key: "mfg-aquaculture", label: "自社養殖", amountUsd: unwrapUsd(mfg.aquacultureRawMaterialCost), indent: true },
  ];
  const laborIncurredRows: ProfitAndLossRow[] = [
    { key: "mfg-regular", label: "正規", amountUsd: unwrapUsd(mfg.regularLaborCost), indent: true },
    { key: "mfg-temporary", label: "臨時", amountUsd: unwrapUsd(mfg.temporaryWorkerCost), indent: true },
    { key: "mfg-overtime", label: "残業", amountUsd: unwrapUsd(mfg.overtimeCost), indent: true },
  ];

  // --- 販管費の内訳（コスト記録の確定値を勘定科目で束ねるだけ） ---
  const sgaSalesForce = sumCostRecords(result, ["salesForceSalary", "salesForceSeverance"]);
  const sgaLogistics = sumCostRecords(result, ["sellingLogistics"]);
  const sgaProcurement = sumCostRecords(result, ["procurementSalary"]);
  const sgaAdmin = sumCostRecords(result, ["adminFixed"]);
  const sgaResidual = sga - (sgaSalesForce + sgaLogistics + sgaProcurement + sgaAdmin);
  const sgaRows: ProfitAndLossRow[] = [
    { key: "sga-salesforce", label: "営業人件費（退職金を含む）", amountUsd: sgaSalesForce, indent: true },
    { key: "sga-logistics", label: "物流・輸出費用", amountUsd: sgaLogistics, indent: true },
    { key: "sga-procurement", label: "調達人件費", amountUsd: sgaProcurement, indent: true },
    { key: "sga-admin", label: "一般管理固定費", amountUsd: sgaAdmin, indent: true },
  ];
  if (Math.abs(sgaResidual) > 0.005) {
    sgaRows.push({
      key: "sga-residual",
      label: "その他（内訳に現れない差分）",
      amountUsd: sgaResidual,
      indent: true,
      note: "コスト記録の勘定科目に分類されていない販管費です。",
    });
  }

  /**
   * 商品別（HOSO/PD/VAP）の純売上は、エンジンが確定値として持っていない
   * （PL も ContributionMarginReport も会社合計のみ）。画面で販売数量×単価を
   * 掛けて作ると推計になるため、未実装として出す。
   */
  unavailable.push("純売上高の商品別内訳（HOSO/PD/VAP）");

  const rows: ProfitAndLossRow[] = [
    { key: "net-revenue", label: "純売上高", amountUsd: netRevenue, emphasis: true },
    {
      key: "gross-deduction",
      label: "（うち格落ち等の売上控除）",
      amountUsd: unwrapUsd(pl.qualitySalesDeduction),
      indent: true,
      note: "売上高から差し引かれた品質関連の控除額です。",
    },
    { key: "revenue-by-product", label: "純売上高の商品別内訳（HOSO/PD/VAP）", amountUsd: null, indent: true },
    { key: "cost-of-sales", label: "売上原価 合計", amountUsd: totalCostOfSales, emphasis: true },
    ...costOfSalesRows,
    {
      key: "raw-incurred-heading",
      label: "（参考）当期に発生した原料費の内訳 — 発生ベース",
      amountUsd: unwrapUsd(mfg.domesticRawMaterialCost) + unwrapUsd(mfg.importedRawMaterialCost) + unwrapUsd(mfg.aquacultureRawMaterialCost),
      note: "在庫を挟むため、上の「原料費（販売分）」とは一致しません。",
    },
    ...rawMaterialIncurredRows,
    {
      key: "labor-incurred-heading",
      label: "（参考）当期に発生したWorker人件費の内訳 — 発生ベース",
      amountUsd: unwrapUsd(mfg.regularLaborCost) + unwrapUsd(mfg.temporaryWorkerCost) + unwrapUsd(mfg.overtimeCost),
      note: "在庫を挟むため、上の「Worker人件費（販売分）」とは一致しません。",
    },
    ...laborIncurredRows,
    {
      key: "depreciation-incurred",
      label: "（参考）当期の減価償却費 — 発生ベース",
      amountUsd: sumCostRecords(result, ["depreciation"]),
      note: "売上原価の「製造固定費・減価償却（販売分）」に配賦されている分を含みます。",
    },
    {
      key: "quality-loss-total",
      label: "（参考）当期の品質ロス合計 — 発生ベース",
      amountUsd:
        unwrapUsd(quality.qualityDiscardLoss) +
        unwrapUsd(quality.rawMaterialExpiryLoss) +
        unwrapUsd(quality.finishedGoodsWriteOffLoss) +
        unwrapUsd(quality.reworkCost) +
        unwrapUsd(quality.downgradeSalesDeduction),
      note: "格下げ・再加工・廃棄・期限切れの合計です。",
    },
    {
      key: "gross-profit",
      label: "売上総利益",
      amountUsd: grossProfit,
      emphasis: true,
      marginRatio: netRevenue !== 0 ? grossProfit / netRevenue : undefined,
    },
    { key: "sga", label: "販売費及び一般管理費", amountUsd: sga, emphasis: true },
    ...sgaRows,
    {
      key: "operating-profit",
      label: "営業利益",
      amountUsd: operatingProfit,
      emphasis: true,
      marginRatio: netRevenue !== 0 ? operatingProfit / netRevenue : undefined,
    },
    { key: "interest", label: "営業外: 支払利息", amountUsd: unwrapUsd(pl.interestExpense), indent: true },
    { key: "asset-disposal", label: "営業外: 固定資産売却損益", amountUsd: unwrapUsd(pl.assetDisposalGainLoss), indent: true },
    { key: "profit-before-tax", label: "税引前利益", amountUsd: unwrapUsd(pl.profitBeforeTax), emphasis: true },
    { key: "income-tax", label: "法人税", amountUsd: unwrapUsd(pl.incomeTax), indent: true },
    { key: "net-income", label: "当期純利益", amountUsd: netIncome, emphasis: true },
  ];

  // --- kgあたり指標 ---
  const soldTons = input.soldQuantityHosoEqTons;
  const soldKg = soldTons !== undefined && soldTons > 0 ? soldTons * 1000 : undefined;
  const perKg = (value: number): number | null => (soldKg === undefined ? null : value / soldKg);
  const perKilogram: readonly PerKilogramMetric[] = [
    { key: "price", label: "平均販売単価", valueUsdPerKg: perKg(netRevenue) },
    { key: "raw", label: "kgあたり原料費（販売分）", valueUsdPerKg: perKg(unwrapUsd(cos.rawMaterialCost)) },
    {
      key: "fixed",
      label: "kgあたり固定費（製造固定費・減価償却＋未吸収＋遊休労務）",
      valueUsdPerKg: perKg(unwrapUsd(cos.factoryFixedCost) + unwrapUsd(cos.unabsorbedFixedManufacturingCost) + unwrapUsd(cos.idleLaborCost)),
    },
    { key: "operating", label: "kgあたり営業利益", valueUsdPerKg: perKg(operatingProfit) },
  ];
  if (soldKg === undefined) unavailable.push("kgあたり指標（当四半期の販売数量が画面へ渡されていないため算定不可）");

  return {
    rows,
    perKilogram,
    unavailableItems: unavailable,
    totals: {
      netRevenueUsd: netRevenue,
      totalCostOfSalesUsd: totalCostOfSales,
      grossProfitUsd: grossProfit,
      sellingGeneralAdminUsd: sga,
      operatingProfitUsd: operatingProfit,
      netIncomeUsd: netIncome,
    },
  };
}
