// ShrimpX V2 — 資金繰りモジュール 財務制限条項（Phase 8B-1）
//
// 最低自己資本比率・最大負債比率・最低利払能力・返済延滞の有無を判定する。
// 財務制限条項違反と実際の支払不能（延滞）は別状態として保持する
// （本モジュールは違反判定のみを行い、支払不能判定はliquidityClose.tsの
// financialHealth分類で別途行う）。

import { PeriodV2 } from "../core/period";
import { CompanyId } from "../sales/types";
import { FinancingParameters } from "./parameters";
import { CovenantCheckResult, CovenantThresholdCheck } from "./types";

export interface CovenantCheckInput {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly totalAssetsUsd: number;
  readonly totalLiabilitiesUsd: number;
  readonly totalEquityUsd: number;
  /** 直近四半期のEBITDA相当（営業利益＋減価償却）。 */
  readonly ebitdaLikeQuarterlyUsd: number;
  readonly interestExpenseQuarterlyUsd: number;
  /** 当期、期日到来した債務（利息・元本・買掛金）の一部が未払のまま残った。 */
  readonly hasArrearsThisPeriod: boolean;
}

export function checkCovenants(input: CovenantCheckInput, params: FinancingParameters): CovenantCheckResult {
  const c = params.covenant;
  const equityRatio = input.totalAssetsUsd > 0 ? input.totalEquityUsd / input.totalAssetsUsd : 0;
  const debtRatio = input.totalAssetsUsd > 0 ? input.totalLiabilitiesUsd / input.totalAssetsUsd : 1;
  const interestCoverage =
    input.interestExpenseQuarterlyUsd > params.epsilonUsd
      ? input.ebitdaLikeQuarterlyUsd / input.interestExpenseQuarterlyUsd
      : undefined; // 利息発生なしの場合は判定対象外

  const checks: CovenantThresholdCheck[] = [
    {
      name: "minEquityRatio",
      requiredValue: c.minEquityRatio,
      actualValue: equityRatio,
      breached: equityRatio < c.minEquityRatio,
    },
    {
      name: "maxDebtToAssetsRatio",
      requiredValue: c.maxDebtToAssetsRatio,
      actualValue: debtRatio,
      breached: debtRatio > c.maxDebtToAssetsRatio,
    },
    {
      name: "minInterestCoverageRatio",
      requiredValue: c.minInterestCoverageRatio,
      actualValue: interestCoverage ?? c.minInterestCoverageRatio,
      breached: interestCoverage !== undefined && interestCoverage < c.minInterestCoverageRatio,
    },
    {
      name: "noArrears",
      requiredValue: 0,
      actualValue: input.hasArrearsThisPeriod ? 1 : 0,
      breached: input.hasArrearsThisPeriod,
    },
  ];

  return {
    companyId: input.companyId,
    period: input.period,
    checks,
    anyBreach: checks.some((c2) => c2.breached),
  };
}
