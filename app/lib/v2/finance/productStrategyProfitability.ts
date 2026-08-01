// ShrimpX V2 — 商品戦略別 収益性比較レポート（feature/v2-product-strategy-economics）
//
// 【目的】3つの商品戦略（HOSO量産・PD自動化・VAP差別化）を、単純な「商品別限界利益率」
// だけで比較すると、加工度が高いほどトンあたり限界利益率が高く見えるVAPが常に
// 「最良の戦略」であるかのように誤解されうる。本モジュールは、その誤解を正すために、
// 既存の商品別限界利益（finance/types.ts ContributionMarginReport.byProduct）を
// 「投入資源（ワーカー・営業人員・設備能力）あたりの収益性」「戦略固有投資控除後の
// 利益」「全社ROIC・運転資本・在庫回転」まで展開し、各戦略の実質的な資本効率を
// 横並びで比較できるレポートを1つにまとめる。
//
// 【設計原則】
//   - 本モジュールは既存の財務決算結果（CompanyFinancialQuarterResult）・生産/販売の
//     実績値（WorkerAllocationEntry・CompanySalesPlanEntry・Factory）・設備投資の
//     四半期イベント（CapexProjectQuarterEvent）を読み取るだけの純粋関数であり、
//     販売量・生産量・価格・原価を一切再計算しない（finance/quarterClose.tsと
//     同じ設計原則を踏襲する）。
//   - closeFinancialQuarterのシグネチャ・戻り値には一切手を加えない、完全に
//     追加的（additive）なレポート生成関数として実装する。companyLab/runner.tsから
//     closeFinancialQuarter（および必要な生産・販売・設備投資の実績）の呼び出し後に
//     任意で呼び出せる（本ブランチでは配線コストとリスクを最小化するため、
//     runner.ts自体は変更していない。テストからのみ検証する）。
//   - 未接続（追跡不能）な金額は0で埋めず、明示的にnull/undefinedとして返す
//     （下記§8参照）。

import { PeriodV2 } from "../core/period";
import { Product } from "../market/types";
import { CompanyId } from "../sales/types";
import type { CompanySalesPlanEntry } from "../sales/types";
import type { Factory, WorkerAllocationEntry } from "../production/types";
import type { CapexProjectQuarterEvent, CapitalProjectType } from "../capex/types";
import type { FinanceParameters } from "./parameters";
import { CompanyFinanceState, CompanyFinancialQuarterResult, unwrapUsd } from "./types";
import type { CompanyQuarterBusinessActuals } from "./quarterClose";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
const EPSILON = 1e-9;

/** 分母が実質ゼロの場合はundefinedを返す（0除算・無意味な巨大値を防ぐ）。 */
function safeDivide(numerator: number, denominator: number): number | undefined {
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= EPSILON) return undefined;
  const v = numerator / denominator;
  return Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------
// 1. 入力
// ---------------------------------------------------------------------

/**
 * 1社・1四半期ぶんの本レポートへの入力。closeFinancialQuarterへ渡したactualsと
 * その戻り値（financialResult）に加え、生産・販売・設備投資の実績値のうち
 * closeFinancialQuarterが集約前に保持していた粒度（商品別・工場別）のデータを
 * そのまま渡す（companyLab/runner.tsが各モジュールから既に取得済みのデータの
 * 再利用であり、新たな実績データソースを作らない）。
 */
export interface ProductStrategyProfitabilityInput {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  /** closeFinancialQuarterに渡したのと同じ当期実績（履行数量・原料在庫期首等の再利用）。 */
  readonly actuals: CompanyQuarterBusinessActuals;
  /** closeFinancialQuarterの戻り値（result側）。PL/BS/管理会計はここから再利用する。 */
  readonly financialResult: CompanyFinancialQuarterResult;
  /** 決算に使った当期の財務パラメータ（法人税率の再利用のため）。 */
  readonly financeParameters: FinanceParameters;
  /** 前四半期末の財務状態（期首完成品在庫の商品別内訳をfinishedGoodsCostLedgerから復元するため）。 */
  readonly prevFinanceState: CompanyFinanceState;
  /** 当四半期末の財務状態（期末完成品在庫の商品別内訳。closeFinancialQuarterのnextState）。 */
  readonly nextFinanceState: CompanyFinanceState;
  /** 当社・当四半期の商品別実配属ワーカー人数（production/allocation.tsの実績、全工場ぶん）。 */
  readonly workerAllocations: readonly WorkerAllocationEntry[];
  /** 当社・当四半期の商品別・市場別販売計画（営業人員配置の実績、全市場ぶん）。 */
  readonly salesPlanEntries: readonly CompanySalesPlanEntry[];
  /** 当社の工場一覧（商品別加工能力の集計に使う）。 */
  readonly factories: readonly Factory[];
  /** 当社・当四半期の設備投資案件イベント（PD機械化・品質保証投資の当期支払額の抽出に使う）。 */
  readonly capexEvents: readonly CapexProjectQuarterEvent[];
}

// ---------------------------------------------------------------------
// 2. 商品別レポート
// ---------------------------------------------------------------------

export interface ProductStrategyProfitabilityByProduct {
  readonly product: Product;
  /** 当期の履行数量（HOSO換算トン。fulfillmentUsageの商品別合計＝収益認識と同じ数量基準）。 */
  readonly tonsSold: number;
  /** 商品別限界利益（USD。ContributionMarginReport.byProductより。既存値の再利用）。 */
  readonly contributionMarginUsd: number;
  /**
   * §1 トンあたり限界利益（USD/HOSO換算トン）。
   *   = contributionMarginUsd ÷ tonsSold
   * tonsSold=0の場合はundefined（無意味な0除算を避ける）。
   */
  readonly contributionMarginPerTonUsd?: number;
  /** 当期この商品へ実配属された常用＋臨時ワーカー人数（WorkerAllocationEntryの合計）。 */
  readonly workerHeadcount: number;
  /**
   * §2 ワーカー1人あたり限界利益（USD/人）。
   *   = contributionMarginUsd ÷ workerHeadcount
   * workerHeadcount=0の場合はundefined。
   */
  readonly contributionMarginPerWorkerUsd?: number;
  /** 当期この商品へ配置された営業人員数（全市場合計、CompanySalesPlanEntry.salesForceHeadcountの合計）。 */
  readonly salesForceHeadcount: number;
  /**
   * §3 営業人員1人あたり限界利益（USD/人）。
   *   = contributionMarginUsd ÷ salesForceHeadcount
   * salesForceHeadcount=0の場合はundefined。
   */
  readonly contributionMarginPerSalespersonUsd?: number;
  /**
   * §4 この商品に帰属する設備能力単位（HOSO換算トン／四半期）。
   * 【定義（暫定・要校正、コメントで明示）】当社工場のうち稼働中(status==="active")の
   * 工場について、その商品専用の加工能力フィールド（hosoCapacity/pdCapacity/vapCapacity）
   * を単純合計する。commonProcessingCapacity（複数商品が共有する前処理能力）・
   * freezingPackagingCapacity（商品非依存の凍結包装能力）は、特定の商品へ一意に
   * 帰属させる自然な基準が無いため、本レポートの商品別設備能力単位には含めない
   * （実装指示「商品別に妥当な定義を置き、コメントで明示する」に対応する設計判断）。
   */
  readonly capacityUnitsHosoEqTons: number;
  /**
   * この商品に帰属する営業利益（USD）。
   * 【定義】contributionMarginUsd − directFixedCost（ContributionMarginByDimension.
   * directFixedCost、商品別に直接帰属できる固定費。既存の管理会計配賦をそのまま使う。
   * 商品へ配賦できない共通固定費はここに含めない＝厳密な全部原価PLの商品別営業利益
   * ではなく、財務会計へは一切影響しない管理会計上の「商品別貢献利益」であることに注意）。
   */
  readonly operatingProfitAttributableUsd: number;
  /**
   * §4 設備能力単位あたり利益（USD／HOSO換算トンの能力単位）。
   *   = operatingProfitAttributableUsd ÷ capacityUnitsHosoEqTons
   * capacityUnitsHosoEqTons=0の場合はundefined。
   */
  readonly profitPerCapacityUnitUsd?: number;
}

// ---------------------------------------------------------------------
// 3. 戦略固有投資控除後利益（§8）
// ---------------------------------------------------------------------

/**
 * 戦略固有投資の当期$支出額と、それを営業利益から控除した後の利益。
 *
 * 【追跡可能な2つ】PD自動化（pdMechanization）とVAP差別化のうち品質保証投資
 * （qualityControlEquipment）は、capex/（CapitalProject）に案件・支払実績が
 * 存在するため、当四半期に実際に支払われた金額（CapexProjectQuarterEvent.
 * paymentSucceededUsd、projectType別）をそのまま抽出できる。
 *
 * 【追跡不能な2つ、明示的にnull】調達スケール戦略（procurementScaleState.ts）と
 * VAP商品開発戦略（productDevelopmentState.ts）は、いずれも行動スコア
 * （0〜100等）だけを状態として持ち、ゲーム内のどの意思決定入力（companyLab/types.ts
 * CompanyDecisionInput）にもUSD建ての投資額フィールドが存在しない。
 * productDevelopmentState.tsのadvanceProductDevelopmentStateはinvestmentAmountByCompanyUsd
 * という引数を受け取れる設計になっているが、2026-08-01時点でこの関数自体が
 * companyLab/runner.ts等どこからも呼び出されておらず（意思決定パイプラインに
 * 未配線）、実際に埋まる$金額の情報源が存在しない。procurementScaleState.tsには
 * そもそも$引数自体が無い。よって、この2つを0として扱うと「投資していない」
 * という誤った事実を捏造することになるため、意図的にnullを返し、UI側で
 * 「N/A（未接続）」と表示できるようにする。
 */
export interface StrategyInvestmentDeductionReport {
  /** PD自動化（pdMechanization案件）の当期支払額（USD）。案件が無ければ0。 */
  readonly pdMechanizationSpendUsd: number;
  /** VAP差別化・品質保証投資（qualityControlEquipment案件）の当期支払額（USD）。案件が無ければ0。 */
  readonly qualityAssuranceInvestmentSpendUsd: number;
  /** 調達スケール戦略（procurementScaleState）の当期投資額。ゲーム内に$情報源が無いためnull固定。 */
  readonly procurementRelationshipSpendUsd: null;
  /** VAP商品開発戦略（productDevelopmentState）の当期投資額。意思決定パイプライン未配線のためnull固定。 */
  readonly vapProductDevelopmentSpendUsd: null;
  /** 追跡可能な2項目の合計（= pdMechanizationSpendUsd + qualityAssuranceInvestmentSpendUsd）。 */
  readonly trackedStrategyInvestmentSpendUsd: number;
  /**
   * 営業利益 − 追跡可能な戦略固有投資支出。
   * 【未追跡分は控除しない】procurementRelationshipSpendUsd・vapProductDevelopmentSpendUsdが
   * nullのため、本フィールドは「追跡できている投資だけを控除した利益」であり、
   * 完全な「全戦略投資控除後利益」ではない（isComplete=falseの場合に明示）。
   */
  readonly operatingProfitAfterTrackedStrategyInvestmentUsd: number;
  /** true = 4戦略すべての投資額が追跡できており、上記が完全な控除後利益であることを意味する。 */
  readonly isComplete: boolean;
}

// ---------------------------------------------------------------------
// 4. 全社レベルレポート（ROIC・運転資本・在庫回転）
// ---------------------------------------------------------------------

export interface ProductStrategyProfitabilityReport {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly byProduct: readonly ProductStrategyProfitabilityByProduct[];
  readonly strategyInvestmentDeduction: StrategyInvestmentDeductionReport;

  /**
   * §5 ROIC（投下資本利益率）。
   *   NOPAT = operatingProfit × (1 − effectiveTaxRate)
   *   effectiveTaxRate = financeParameters.finance.incomeTaxRate
   *     （PL上のincomeTaxが実際に使っているのと同じ税率をそのまま再利用する。
   *      quarterClose.tsは常にこの税率×max(0,profitBeforeTax)で法人税を計算するため、
   *      税引前赤字四半期でも「税率」自体はこの定数のままとする）。
   *   investedCapital = totalEquity + shortTermLoans + longTermLoans
   *     （= 自己資本＋有利子負債。BalanceSheetに既存のフィールドのみを使う、
   *      標準的な投下資本の定義の1つ。実装指示に従いここで明示する）。
   *   ROIC = NOPAT ÷ investedCapital
   * investedCapitalが実質ゼロ以下の場合はundefined。
   */
  readonly nopatUsd: number;
  readonly investedCapitalUsd: number;
  readonly roic?: number;

  /**
   * §6 必要運転資本（運転資本、現金除く）。
   *   = (accountsReceivable + rawMaterialInventory + finishedGoodsInventory + otherCurrentAssets)
   *     − (accountsPayable + otherLiabilities)
   * 【定義の根拠】現金は運転資本の管理対象外とする一般的な「オペレーティング
   * ワーキングキャピタル」の定義を採用する（現金は資金繰り・財務活動の結果であり、
   * 事業運営そのものが必要とする資本ではないため）。負債側は、shortTermLoans/
   * longTermLoansのような有利子負債（financing側の意思決定の結果）を除き、
   * 営業活動から自然に発生する buyer/supplier 側の残高（accountsPayable・
   * otherLiabilities）だけを差し引く（investedCapitalの有利子負債側と二重に
   * 扱わないための整合的な選択）。
   */
  readonly requiredWorkingCapitalUsd: number;

  /**
   * §7 在庫回転（会社レベル）。
   *   原料在庫回転 = 当期原料費（costOfSales.rawMaterialCost） ÷ 平均原料在庫
   *     （= (期首原料在庫 + 期末原料在庫) ÷ 2、actuals.rawMaterialInventoryBeginUsd/
   *      balanceSheet.rawMaterialInventoryを使う）
   *   完成品在庫回転 = 当期売上原価合計（totalCostOfSales） ÷ 平均完成品在庫
   *     （= (期首完成品在庫 + 期末完成品在庫) ÷ 2、prevFinanceState/nextFinanceStateの
   *      finishedGoodsCostLedger残高合計から算出）
   * 【会社レベルにとどめる理由】売上原価（costOfSales）は正社員固定労務費・工場固定費・
   * 減価償却等の商品共通固定費を含む全部原価計算ベースの会社合計値であり、
   * finance/quarterClose.ts側に商品別への正式な全部原価COGS内訳が存在しない
   * （商品別に存在するのは変動費ベースのContributionMarginByDimension.variableCostのみ）。
   * 実装指示「商品別に妥当なら商品別、そうでなければ会社レベル」に従い、正確な
   * 全部原価ベースの商品別分解ができないため、恣意的な配賦を避けて会社レベルの
   * 指標として報告する。ただし期末完成品在庫の商品別内訳（在庫水準そのもの）は
   * byProductFinishedGoodsInventoryUsdとして参考情報を別途提供する。
   * 平均在庫が実質ゼロの場合はundefined。
   */
  readonly rawMaterialInventoryTurnover?: number;
  readonly finishedGoodsInventoryTurnover?: number;
  /** 参考情報: 期末完成品在庫の商品別内訳（USD、finishedGoodsCostLedgerから算出）。 */
  readonly byProductFinishedGoodsInventoryUsd: readonly { readonly product: Product; readonly amountUsd: number }[];
}

// ---------------------------------------------------------------------
// 5. 実装本体
// ---------------------------------------------------------------------

const PD_MECHANIZATION_TYPE: CapitalProjectType = "pdMechanization";
const QUALITY_CONTROL_EQUIPMENT_TYPE: CapitalProjectType = "qualityControlEquipment";

function sumTons(actuals: CompanyQuarterBusinessActuals, product: Product): number {
  return actuals.fulfillmentUsage.filter((u) => u.product === product).reduce((s, u) => s + u.quantityTons, 0);
}

function sumWorkerHeadcount(workerAllocations: readonly WorkerAllocationEntry[], product: Product): number {
  return workerAllocations
    .filter((w) => w.product === product)
    .reduce((s, w) => s + w.assignedRegularHeadcount + w.assignedTemporaryHeadcount, 0);
}

function sumSalesForceHeadcount(salesPlanEntries: readonly CompanySalesPlanEntry[], product: Product): number {
  return salesPlanEntries.filter((e) => e.product === product).reduce((s, e) => s + e.salesForceHeadcount, 0);
}

function sumCapacityUnits(factories: readonly Factory[], product: Product): number {
  return factories
    .filter((f) => f.status === "active")
    .reduce((s, f) => {
      const cap = product === "hoso" ? f.hosoCapacity : product === "pd" ? f.pdCapacity : f.vapCapacity;
      return s + (cap as unknown as number);
    }, 0);
}

function sumFinishedGoodsInventoryByProduct(state: CompanyFinanceState, product: Product): number {
  return state.finishedGoodsCostLedger
    .filter((e) => e.product === product)
    .reduce((s, e) => {
      const totalUnitCost =
        e.unitCost.rawMaterialPerTon +
        e.unitCost.processingPerTon +
        e.unitCost.laborVariablePerTon +
        e.unitCost.utilityVariablePerTon +
        e.unitCost.laborFixedPerTon +
        e.unitCost.factoryFixedPerTon +
        e.unitCost.utilityFixedPerTon +
        e.unitCost.depreciationPerTon;
      return s + e.remainingQuantity * totalUnitCost;
    }, 0);
}

function sumFinishedGoodsInventoryTotal(state: CompanyFinanceState): number {
  return PRODUCTS.reduce((s, p) => s + sumFinishedGoodsInventoryByProduct(state, p), 0);
}

/**
 * 1社・1四半期ぶんの商品戦略別収益性比較レポートを算出する。
 * closeFinancialQuarterの計算結果・実績データを読み取るだけの純粋関数であり、
 * PL/BS/CF/管理会計の数値には一切影響しない（追加的なレポート生成のみ）。
 */
export function computeProductStrategyProfitabilityReport(
  input: ProductStrategyProfitabilityInput
): ProductStrategyProfitabilityReport {
  const { actuals, financialResult, financeParameters, prevFinanceState, nextFinanceState, workerAllocations, salesPlanEntries, factories, capexEvents } =
    input;

  const cmByProduct = new Map(financialResult.contributionMargin.byProduct.map((d) => [d.key as Product, d]));

  const byProduct: ProductStrategyProfitabilityByProduct[] = PRODUCTS.map((product) => {
    const cm = cmByProduct.get(product);
    const contributionMarginUsd = cm ? unwrapUsd(cm.contributionMargin) : 0;
    const directFixedCostUsd = cm ? unwrapUsd(cm.directFixedCost) : 0;
    const tonsSold = sumTons(actuals, product);
    const workerHeadcount = sumWorkerHeadcount(workerAllocations, product);
    const salesForceHeadcount = sumSalesForceHeadcount(salesPlanEntries, product);
    const capacityUnitsHosoEqTons = sumCapacityUnits(factories, product);
    const operatingProfitAttributableUsd = contributionMarginUsd - directFixedCostUsd;

    return {
      product,
      tonsSold,
      contributionMarginUsd,
      contributionMarginPerTonUsd: safeDivide(contributionMarginUsd, tonsSold),
      workerHeadcount,
      contributionMarginPerWorkerUsd: safeDivide(contributionMarginUsd, workerHeadcount),
      salesForceHeadcount,
      contributionMarginPerSalespersonUsd: safeDivide(contributionMarginUsd, salesForceHeadcount),
      capacityUnitsHosoEqTons,
      operatingProfitAttributableUsd,
      profitPerCapacityUnitUsd: safeDivide(operatingProfitAttributableUsd, capacityUnitsHosoEqTons),
    };
  });

  // --- §8: 戦略固有投資控除後利益 ---
  const pdMechanizationSpendUsd = capexEvents
    .filter((e) => e.projectType === PD_MECHANIZATION_TYPE)
    .reduce((s, e) => s + e.paymentSucceededUsd, 0);
  const qualityAssuranceInvestmentSpendUsd = capexEvents
    .filter((e) => e.projectType === QUALITY_CONTROL_EQUIPMENT_TYPE)
    .reduce((s, e) => s + e.paymentSucceededUsd, 0);
  const trackedStrategyInvestmentSpendUsd = pdMechanizationSpendUsd + qualityAssuranceInvestmentSpendUsd;
  const operatingProfitUsd = unwrapUsd(financialResult.profitAndLoss.operatingProfit);
  const strategyInvestmentDeduction: StrategyInvestmentDeductionReport = {
    pdMechanizationSpendUsd,
    qualityAssuranceInvestmentSpendUsd,
    procurementRelationshipSpendUsd: null,
    vapProductDevelopmentSpendUsd: null,
    trackedStrategyInvestmentSpendUsd,
    operatingProfitAfterTrackedStrategyInvestmentUsd: operatingProfitUsd - trackedStrategyInvestmentSpendUsd,
    isComplete: false,
  };

  // --- §5: ROIC ---
  const bs = financialResult.balanceSheet;
  const investedCapitalUsd = unwrapUsd(bs.totalEquity) + unwrapUsd(bs.shortTermLoans) + unwrapUsd(bs.longTermLoans);
  const effectiveTaxRate = financeParameters.finance.incomeTaxRate;
  const nopatUsd = operatingProfitUsd * (1 - effectiveTaxRate);
  const roic = safeDivide(nopatUsd, investedCapitalUsd);

  // --- §6: 必要運転資本 ---
  const requiredWorkingCapitalUsd =
    unwrapUsd(bs.accountsReceivable) +
    unwrapUsd(bs.rawMaterialInventory) +
    unwrapUsd(bs.finishedGoodsInventory) +
    unwrapUsd(bs.otherCurrentAssets) -
    (unwrapUsd(bs.accountsPayable) + unwrapUsd(bs.otherLiabilities));

  // --- §7: 在庫回転（会社レベル） ---
  const avgRawMaterialInventoryUsd = (actuals.rawMaterialInventoryBeginUsd + unwrapUsd(bs.rawMaterialInventory)) / 2;
  const rawMaterialInventoryTurnover = safeDivide(
    unwrapUsd(financialResult.profitAndLoss.costOfSales.rawMaterialCost),
    avgRawMaterialInventoryUsd
  );
  const beginFinishedGoodsInventoryUsd = sumFinishedGoodsInventoryTotal(prevFinanceState);
  const endFinishedGoodsInventoryUsd = sumFinishedGoodsInventoryTotal(nextFinanceState);
  const avgFinishedGoodsInventoryUsd = (beginFinishedGoodsInventoryUsd + endFinishedGoodsInventoryUsd) / 2;
  const finishedGoodsInventoryTurnover = safeDivide(
    unwrapUsd(financialResult.profitAndLoss.totalCostOfSales),
    avgFinishedGoodsInventoryUsd
  );
  const byProductFinishedGoodsInventoryUsd = PRODUCTS.map((product) => ({
    product,
    amountUsd: sumFinishedGoodsInventoryByProduct(nextFinanceState, product),
  }));

  return {
    companyId: input.companyId,
    period: input.period,
    byProduct,
    strategyInvestmentDeduction,
    nopatUsd,
    investedCapitalUsd,
    roic,
    requiredWorkingCapitalUsd,
    rawMaterialInventoryTurnover,
    finishedGoodsInventoryTurnover,
    byProductFinishedGoodsInventoryUsd,
  };
}
