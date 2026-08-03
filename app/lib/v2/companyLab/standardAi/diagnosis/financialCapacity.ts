// ShrimpX V2 — 2026-08-03 Phase E: Financial Capacity 診断モジュール（診断専用）
//
// 【目的】借入意思決定そのものはまだ作らない。ある経営プラン（生産・調達・労務・
// 設備投資の候補案）を実行した場合に、当期の資金余力（quarter-level liquidity
// headroom）がどうなるかを診断する。既存のfinanceルール（finance/parameters.ts・
// financing/loanSchedule.ts）を必ず再利用し、新しい原価・金利・回収ルールは作らない。
//
// 【ARの扱い（最重要）】帳簿上の売掛金残高全体を当期使える現金として扱っては
// ならない。ReceivableRecord.dueSettlementPeriod（既存の回収サイトルール、
// arCollectionQuarters=1相当が既に反映された値）が当期と一致するものだけを
// 「当期確実な現金化」（certain inflow）として使う（observation.ts側で既に
// receivablesDueThisPeriodUsd/receivablesNotYetDueUsdへ分離済み）。
//
// 【APの扱い】輸入原料の買掛金（PayableRecord、apImportPaymentQuarters=1）も
// 同様に、dueSettlementPeriodが当期のものだけをこの四半期の現金支出として扱う。
// したがって「当期新規の輸入発注」自体は、当期の現金には影響しない
// （買掛金として繰り越され、次期の決済で現金化する）。この診断では、当期の
// 輸入関連キャッシュアウトは「当期決済期日を迎える既存買掛金」だけであり、
// 当期新規に発注する輸入量そのものの代金は含めない（含めると二重の誤りになる:
// 実際の現金支出タイミングより早く計上してしまう）。
//
// 【未知の値は推測しない】
//   - 養殖原料の投入コスト: StandardAiObservationにはまだ会社別の養殖原価
//     パラメータが露出していない（Phase Bのforward unit economicsと同じ結論）。
//     したがってaquacultureRelatedCashOutUsdは常にnull。
//   - 追加借入可能額（availableBorrowingHeadroomUsd）: 信用スコア・EBITDA・
//     担保USD評価等の複数の未配線入力を要求するため、observation.ts側で
//     既にundefinedとして返している値をそのまま転記する（近似しない）。

import { PRODUCTION_PARAMETERS_V1 } from "../../../production/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../../finance/parameters";
import { ProductAmount, StandardAiObservation } from "../types";
import { PressureScores } from "../pressures";

const PRODUCTS: readonly ("hoso" | "pd" | "vap")[] = ["hoso", "pd", "vap"];

/** ある経営プラン候補（生産・調達・労務・設備投資）。呼び出し元が候補案として渡す。 */
export interface StandardAiFinancialCapacityPlanInput {
  readonly productionByProductTons: ProductAmount;
  readonly totalSalesTonsThisQuarter: number;
  readonly domesticProcurementTons: number;
  readonly domesticRawPriceUsdPerKgOverride?: number; // 未指定ならobservation.vietnamDomesticPriorPriceを使う
  readonly importProcurementTons: number;
  readonly importRawPriceUsdPerKgOverride?: number; // 未指定ならobservation.lastHosoPriceVnを参考値として使う
  readonly temporaryWorkerCount: number;
  readonly overtimeRateAvg: number; // 0〜overtimeRateCap
  readonly plannedCapexCashOutUsd: number; // 当期の設備投資キャッシュアウト（未指定なら0。capexエンジンの支払スケジュールは複製しない）
  readonly plannedNewBorrowingUsd: number; // 当期の新規借入希望額（未指定なら0）
  readonly plannedVoluntaryPrepaymentUsd: number; // 当期の任意期限前返済額（未指定なら0）
}

export function zeroFinancialCapacityPlan(): StandardAiFinancialCapacityPlanInput {
  return {
    productionByProductTons: { hoso: 0, pd: 0, vap: 0 },
    totalSalesTonsThisQuarter: 0,
    domesticProcurementTons: 0,
    importProcurementTons: 0,
    temporaryWorkerCount: 0,
    overtimeRateAvg: 0,
    plannedCapexCashOutUsd: 0,
    plannedNewBorrowingUsd: 0,
    plannedVoluntaryPrepaymentUsd: 0,
  };
}

export type LiquidityWarning = "SUFFICIENT" | "BELOW_TARGET_BUFFER" | "NEGATIVE_CASH_PROJECTED";

export interface StandardAiFinancialCapacityResult {
  readonly companyId: string;

  readonly openingCashUsd: number;
  readonly receivablesDueThisPeriodUsd: number; // 当期確実な現金化（ARコレクションタイミング反映済み）
  readonly receivablesNotYetDueUsd: number; // 参考値（まだ現金化されない）

  readonly expectedDomesticRawProcurementCashOutUsd: number;
  /** 当期の現金支出（既存買掛金の決済のみ。当期新規発注分は含まない＝次期決済）。 */
  readonly expectedImportCashOutUsd: number;
  /** 参考値（現金支出ではない）: 当期新規に発注した輸入原料の代金（次期決済の買掛金として発生）。 */
  readonly newImportOrdersCreatingFuturePayableUsd: number;
  /** 【捏造しない】養殖原料コストは観測に存在しないため常にnull。 */
  readonly aquacultureRelatedCashOutUsd: null;

  readonly manufacturingCashOutUsd: number;
  readonly regularLaborCashOutUsd: number;
  readonly temporaryOvertimeCashOutUsd: number;
  readonly sgaCashOutUsd: number;
  readonly capexCashOutUsd: number;

  readonly interestCashOutUsd: number;
  readonly principalRepaymentCashOutUsd: number;

  readonly projectedCashBeforeFinancingUsd: number;

  readonly existingBorrowingUsd: number;
  readonly availableBorrowingHeadroomUsd: number | null;
  readonly projectedCashAfterPlannedFinancingUsd: number;

  /** quarter-level liquidity headroom = projectedCashAfterPlannedFinancing - targetMinimumCashUsd。
   *  【明示】四半期末時点の目安であり、四半期内の日次最低残高を示すものではない（捏造しない）。 */
  readonly quarterLevelLiquidityHeadroomUsd: number;
  readonly liquidityWarning: LiquidityWarning;

  readonly dataQuality: {
    readonly aquacultureCostUnavailableNote: string;
    readonly borrowingHeadroomUnavailableNote: string;
    readonly liquidityHeadroomIsQuarterLevelNote: string;
  };
}

const AQUACULTURE_NOTE =
  "養殖原料の投入コストは、現行のStandardAiObservationに会社別のパラメータが露出していないため計算していない（常にnull。憶測しない）。" +
  "実際の養殖関連現金支出が存在する場合、projectedCashBeforeFinancingUsdはその分過大評価される可能性がある（既知の不完全性として明示する）。";
const BORROWING_HEADROOM_NOTE =
  "追加借入可能額は、financing/borrowingCapacity.tsが要求する信用スコア・EBITDA相当・担保USD評価等の入力が" +
  "現時点でStandardAiObservationに配線されていないため、常にnull（近似しない）。";
const LIQUIDITY_HEADROOM_NOTE =
  "この値は四半期末時点（決算処理後）の目安であり、四半期内の日次・週次の最低現金残高（intra-quarter minimum）を" +
  "示すものではない。四半期内に一時的にこれより現金が下振れする可能性は、この診断の範囲外である。";

export function buildStandardAiFinancialCapacity(
  observation: StandardAiObservation,
  pressures: PressureScores,
  plan: StandardAiFinancialCapacityPlanInput
): StandardAiFinancialCapacityResult {
  const hosoEqKgPerTon = PRODUCTION_PARAMETERS_V1.cost.hosoEqKgPerTon;

  const domesticRawPriceUsdPerKg = plan.domesticRawPriceUsdPerKgOverride ?? observation.vietnamDomesticPriorPrice ?? null;
  const importRawPriceUsdPerKg = plan.importRawPriceUsdPerKgOverride ?? observation.lastHosoPriceVn ?? null;

  const expectedDomesticRawProcurementCashOutUsd =
    domesticRawPriceUsdPerKg === null ? 0 : plan.domesticProcurementTons * hosoEqKgPerTon * domesticRawPriceUsdPerKg;
  const newImportOrdersCreatingFuturePayableUsd =
    importRawPriceUsdPerKg === null ? 0 : plan.importProcurementTons * hosoEqKgPerTon * importRawPriceUsdPerKg;
  // 【AP timing】当期の輸入キャッシュアウトは、既に決済期日を迎えている既存買掛金のみ
  // （observation.payablesDueThisPeriodUsd。当期新規発注分はここに含めない）。
  const expectedImportCashOutUsd = observation.payablesDueThisPeriodUsd;

  const totalProductionTons = PRODUCTS.reduce((s, p) => s + Math.max(0, plan.productionByProductTons[p]), 0);
  const numberOfFactories = observation.factories.length;
  const manufacturingCashOutUsd =
    numberOfFactories * (FINANCE_PARAMETERS_V1.manufacturing.factoryFixedCostUsdPerQuarter + FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityFixedUsdPerQuarter) +
    totalProductionTons * FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityVariableUsdPerTon +
    PRODUCTS.reduce((s, p) => s + Math.max(0, plan.productionByProductTons[p]) * PRODUCTION_PARAMETERS_V1.cost.baseProcessingCostUsdPerTon[p], 0);

  const regularLaborCashOutUsd = observation.regularHeadcountTotal * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter;
  const temporaryOvertimeCashOutUsd =
    plan.temporaryWorkerCount * FINANCE_PARAMETERS_V1.labor.temporaryWorkerCostUsdPerQuarter +
    observation.regularHeadcountTotal *
      FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter *
      Math.max(0, plan.overtimeRateAvg) *
      FINANCE_PARAMETERS_V1.labor.overtimePremiumFactor;

  const sgaCashOutUsd =
    observation.salesForceHeadcountTotal * FINANCE_PARAMETERS_V1.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter +
    observation.procurementHeadcountTotal * FINANCE_PARAMETERS_V1.sellingGeneralAdmin.procurementSalaryUsdPerQuarter +
    FINANCE_PARAMETERS_V1.sellingGeneralAdmin.adminFixedUsdPerQuarter +
    Math.max(0, plan.totalSalesTonsThisQuarter) * FINANCE_PARAMETERS_V1.sellingGeneralAdmin.sellingLogisticsUsdPerTon;

  const capexCashOutUsd = plan.plannedCapexCashOutUsd;
  const interestCashOutUsd = observation.existingLoanInterestUsdThisQuarterEstimate;
  const principalRepaymentCashOutUsd = observation.existingLoanScheduledPrincipalDueUsdThisQuarterEstimate;

  const projectedCashBeforeFinancingUsd =
    observation.cashUsd +
    observation.receivablesDueThisPeriodUsd -
    expectedDomesticRawProcurementCashOutUsd -
    expectedImportCashOutUsd -
    manufacturingCashOutUsd -
    regularLaborCashOutUsd -
    temporaryOvertimeCashOutUsd -
    sgaCashOutUsd -
    capexCashOutUsd -
    interestCashOutUsd -
    principalRepaymentCashOutUsd;

  const projectedCashAfterPlannedFinancingUsd =
    projectedCashBeforeFinancingUsd + plan.plannedNewBorrowingUsd - plan.plannedVoluntaryPrepaymentUsd;

  const quarterLevelLiquidityHeadroomUsd = projectedCashAfterPlannedFinancingUsd - pressures.targetMinimumCashUsd;
  let liquidityWarning: LiquidityWarning;
  if (projectedCashAfterPlannedFinancingUsd < 0) liquidityWarning = "NEGATIVE_CASH_PROJECTED";
  else if (quarterLevelLiquidityHeadroomUsd < 0) liquidityWarning = "BELOW_TARGET_BUFFER";
  else liquidityWarning = "SUFFICIENT";

  return {
    companyId: observation.companyId,
    openingCashUsd: observation.cashUsd,
    receivablesDueThisPeriodUsd: observation.receivablesDueThisPeriodUsd,
    receivablesNotYetDueUsd: observation.receivablesNotYetDueUsd,
    expectedDomesticRawProcurementCashOutUsd,
    expectedImportCashOutUsd,
    newImportOrdersCreatingFuturePayableUsd,
    aquacultureRelatedCashOutUsd: null,
    manufacturingCashOutUsd,
    regularLaborCashOutUsd,
    temporaryOvertimeCashOutUsd,
    sgaCashOutUsd,
    capexCashOutUsd,
    interestCashOutUsd,
    principalRepaymentCashOutUsd,
    projectedCashBeforeFinancingUsd,
    existingBorrowingUsd: observation.existingLoanBalanceUsd,
    availableBorrowingHeadroomUsd: observation.availableBorrowingHeadroomUsd ?? null,
    projectedCashAfterPlannedFinancingUsd,
    quarterLevelLiquidityHeadroomUsd,
    liquidityWarning,
    dataQuality: {
      aquacultureCostUnavailableNote: AQUACULTURE_NOTE,
      borrowingHeadroomUnavailableNote: BORROWING_HEADROOM_NOTE,
      liquidityHeadroomIsQuarterLevelNote: LIQUIDITY_HEADROOM_NOTE,
    },
  };
}

/** 規模シナリオ分析用: productionByProductTonsの合計を指定スケール（トン）へ均等スケールした簡易プラン生成。 */
export function scaledProductionPlan(
  baseMixRatio: ProductAmount,
  totalTons: number,
  overrides: Partial<StandardAiFinancialCapacityPlanInput> = {}
): StandardAiFinancialCapacityPlanInput {
  const mixTotal = PRODUCTS.reduce((s, p) => s + Math.max(0, baseMixRatio[p]), 0);
  const productionByProductTons: ProductAmount =
    mixTotal <= 1e-9
      ? { hoso: 0, pd: 0, vap: 0 }
      : {
          hoso: (Math.max(0, baseMixRatio.hoso) / mixTotal) * totalTons,
          pd: (Math.max(0, baseMixRatio.pd) / mixTotal) * totalTons,
          vap: (Math.max(0, baseMixRatio.vap) / mixTotal) * totalTons,
        };
  return {
    ...zeroFinancialCapacityPlan(),
    productionByProductTons,
    totalSalesTonsThisQuarter: totalTons,
    domesticProcurementTons: totalTons, // 単純化: 生産トン数=原料調達トン数（HOSO換算）と仮定する診断専用の近似
    ...overrides,
  };
}
