// ShrimpX V2 — Test16: 短期運転資金（working capital）の必要額計算
//
// 【なぜ必要か（2026-08-09・原料調達監査）】
// 従来の資金繰り判断は
//   desiredAmountUsd = max(0, 最低現金バッファ − 手元現金)
// だけであり、**原料を買うのに資金が要るという事実が借入判断の入力ですらなかった**。
//
// その結果、実測（docs/standard_ai/TEST16_RAW_PROCUREMENT_AUDIT.md）では
//   ・国内調達の資金ゲートが 35/40 四半期で binding
//   ・うち 17 四半期は借入申請ゼロ、かつ借入余力が残っていた
//   ・うち 14 四半期は、その余力だけで未充足額を全額賄えた
//   ・CONSVは毎期 30〜47M USD の余力を遊ばせたまま原料を買い負けていた
// という状態になっていた。
//
// 【このモジュールの責務】
// 「原料を買い、加工し、輸出して売掛金を回収する」という短期の資金循環を、
// 1四半期＋次四半期の範囲で見積もり、不足額（working capital gap）を返す。
// **長期のキャッシュフロー予測モデルは作らない**（指示D3）。
//
// 【捏造しない】
//   ・給与・買掛・利息・元本は、いずれも既存の唯一の情報源をそのまま使う
//     （FINANCE_PARAMETERS_V1 / observation の実データ）。
//   ・借入可能枠（availableBorrowingHeadroomUsd）は observation 上で意図的に
//     undefined（types.ts に理由が明記されている）。ここで近似値を作らない。
//     実際にいくら借りられるかは financing エンジンの審査が決める。

import { FINANCE_PARAMETERS_V1, FinanceParameters } from "../../../finance/parameters";
import { FINANCING_PARAMETERS_V1, FinancingParameters } from "../../../financing/parameters";
import { StandardAiObservation } from "../types";

/**
 * 前期の国内原料価格が観測できない場合（turn1等）の代替単価。
 * companyLab/runner.ts の fallbackExpectedDomesticPriceUsdPerKg および
 * autoPolicy.ts の DEFAULT_EXPECTED_RAW_PRICE_USD_PER_KG と同じ値。
 */
export const FALLBACK_EXPECTED_DOMESTIC_PRICE_USD_PER_KG = 2.5;

/** 調達計画のうち、資金需要の見積もりに必要な部分だけを受け取る。 */
export interface ProcurementCashPlanInput {
  /** 当期の国内買付希望量（トン）。当期に現金決済される。 */
  readonly domesticDesiredQuantityTons: number;
  /** 当期に発注する輸入量（トン）。買掛を経由するため現金化は先の四半期。 */
  readonly importOrderedQuantityTons: number;
}

export interface WorkingCapitalAssessment {
  // --- 資金需要 ---
  /** 当期の国内買付に要する現金（＝資金ゲートが計算するのと同じ式）。 */
  readonly plannedDomesticRawProcurementCostUsd: number;
  /** 当期発注ぶんの輸入原料コスト（次四半期以降の支払予定）。 */
  readonly plannedImportRawProcurementCostUsd: number;
  /** 上記2つの合計＝原料調達必要額。 */
  readonly plannedRawProcurementCostUsd: number;
  /** 人件費（正社員・営業・調達）。 */
  readonly payrollUsd: number;
  /** 当期決済予定の買掛金（過去の輸入原料等）。 */
  readonly payablesDueUsd: number;
  /** 当期の予定利息＋予定元本返済。 */
  readonly debtServiceUsd: number;
  /** 上記すべての合計＝近い将来の営業資金需要。 */
  readonly nearTermOperatingCashNeedsUsd: number;

  // --- 資金供給 ---
  readonly cashOnHandUsd: number;
  /** 当期が決済予定期の売掛金（＝当期に現金化される見込み）。 */
  readonly expectedArCollectionUsd: number;
  readonly minimumCashBufferUsd: number;

  // --- 資金ゲートの制約 ---
  /**
   * 国内買付に充当できる手元現金（＝現金 × domesticPurchaseCashAllocationRatio）。
   * 残りは賃金等の最優先支払へ確保される。
   */
  readonly cashUsableForDomesticProcurementUsd: number;
  /**
   * 国内買付の資金不足額（＝国内買付コスト − 上記）。
   * **現金総額が潤沢でも、この額は借入で埋めないと買付量が削られる。**
   */
  readonly domesticProcurementFundingGapUsd: number;

  // --- 結果 ---
  /** 全体の資金過不足（needs + buffer − cash − inflows）。負なら余剰。 */
  readonly overallCashGapUsd: number;
  /** 上記2つの大きい方。実際に借入で埋めるべき額の基準。 */
  readonly projectedWorkingCapitalGapUsd: number;
  /** 借入で埋めるべき額（gapの正の部分）。 */
  readonly economicallyDesiredBorrowingUsd: number;
}

/**
 * 短期運転資金の必要額を評価する。
 *
 * 【国内買付コストの式】
 * financing/liquidityClose.ts の computeProcurementConstraint が
 *   plannedCashNeedUsd = 数量(t) × 1000 × 期待国内価格(USD/kg)
 * で資金ゲートを掛けてくる。AIが見積もる額はこれと**同じ式**でなければ、
 * 「自分が受ける制約の大きさ」を取り違える。したがって同じ式を使う。
 *
 * 【輸入の扱い（二重計上を避ける）】
 * 輸入は買掛（apImportPaymentQuarters）を経由するため、当期発注ぶんは
 * 当期の現金支出にならない。一方、過去に発注したぶんは payablesDueThisPeriodUsd
 * として当期の支出に現れる。したがって
 *   ・当期発注ぶん  → 次四半期の需要として計上（指示D3の「current + next turn」）
 *   ・過去発注ぶん  → payablesDueUsd として計上
 * とし、同じ金額を二度数えない。
 */
export function assessWorkingCapitalNeed(
  observation: StandardAiObservation,
  procurement: ProcurementCashPlanInput,
  minimumCashBufferUsd: number,
  financeParams: FinanceParameters = FINANCE_PARAMETERS_V1,
  financingParams: FinancingParameters = FINANCING_PARAMETERS_V1
): WorkingCapitalAssessment {
  // turn1等で前期価格が無い場合の代替値。資金ゲート（companyLab/runner.ts の
  // fallbackExpectedDomesticPriceUsdPerKg）・autoPolicy.ts と同じ値を使い、
  // AIの見積もりと実際に掛かる制約の前提を一致させる。
  const domesticPriceUsdPerKg =
    observation.vietnamDomesticPriorPrice !== undefined && observation.vietnamDomesticPriorPrice > 1e-9
      ? observation.vietnamDomesticPriorPrice
      : FALLBACK_EXPECTED_DOMESTIC_PRICE_USD_PER_KG;

  const plannedDomesticRawProcurementCostUsd = Math.max(0, procurement.domesticDesiredQuantityTons) * 1000 * domesticPriceUsdPerKg;
  // 輸入の単価は着地価格（運賃・関税・保険）を含むが、AIは発注時点でその内訳を
  // 観測していない。国内価格を代理指標として使い、過小評価しないようにする。
  const plannedImportRawProcurementCostUsd = Math.max(0, procurement.importOrderedQuantityTons) * 1000 * domesticPriceUsdPerKg;
  const plannedRawProcurementCostUsd = plannedDomesticRawProcurementCostUsd + plannedImportRawProcurementCostUsd;

  const payrollUsd =
    observation.regularHeadcountTotal * financeParams.labor.regularWorkerSalaryUsdPerQuarter +
    observation.salesForceHeadcountTotal * financeParams.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter +
    observation.procurementHeadcountTotal * financeParams.sellingGeneralAdmin.procurementSalaryUsdPerQuarter;

  const payablesDueUsd = observation.payablesDueThisPeriodUsd;
  const debtServiceUsd =
    observation.existingLoanInterestUsdThisQuarterEstimate + observation.existingLoanScheduledPrincipalDueUsdThisQuarterEstimate;

  const nearTermOperatingCashNeedsUsd = plannedRawProcurementCostUsd + payrollUsd + payablesDueUsd + debtServiceUsd;

  const cashOnHandUsd = observation.cashUsd;
  const expectedArCollectionUsd = observation.receivablesDueThisPeriodUsd;

  const overallCashGapUsd =
    nearTermOperatingCashNeedsUsd + minimumCashBufferUsd - cashOnHandUsd - expectedArCollectionUsd;

  // 【資金ゲートを織り込む】financing/liquidityClose.ts の computeProcurementConstraint は
  //   利用可能流動性 = max(0, 前期末現金) × domesticPurchaseCashAllocationRatio + 承認融資
  // で国内買付を按分する。**現金総額が潤沢でも、その一定割合しか買付へ回せない**
  // （残りは賃金等の最優先支払へ確保される、というのがこのパラメータの趣旨）。
  //
  // したがって「全体では資金が足りている」だけでは買付量は守れない。
  // 借入は100%が利用可能流動性へ加算されるため、不足分は借入で埋められる。
  // これを見ないと、現金を潤沢に持ったまま原料を買い負ける（実測でCONSVが該当）。
  const cashUsableForDomesticProcurementUsd =
    Math.max(0, cashOnHandUsd) * financingParams.liquidity.domesticPurchaseCashAllocationRatio;
  const domesticProcurementFundingGapUsd =
    plannedDomesticRawProcurementCostUsd - cashUsableForDomesticProcurementUsd;

  const projectedWorkingCapitalGapUsd = Math.max(overallCashGapUsd, domesticProcurementFundingGapUsd);

  return {
    cashUsableForDomesticProcurementUsd,
    domesticProcurementFundingGapUsd,
    overallCashGapUsd,
    plannedDomesticRawProcurementCostUsd,
    plannedImportRawProcurementCostUsd,
    plannedRawProcurementCostUsd,
    payrollUsd,
    payablesDueUsd,
    debtServiceUsd,
    nearTermOperatingCashNeedsUsd,
    cashOnHandUsd,
    expectedArCollectionUsd,
    minimumCashBufferUsd,
    projectedWorkingCapitalGapUsd,
    economicallyDesiredBorrowingUsd: Math.max(0, projectedWorkingCapitalGapUsd),
  };
}
