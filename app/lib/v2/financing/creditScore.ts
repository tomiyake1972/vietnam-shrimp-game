// ShrimpX V2 — 資金繰りモジュール 銀行信用スコア（Phase 8B-1）
//
// 【銀行は未来を知らない】本関数への入力は必ず「前四半期末までに確定した」
// 財務状態・財務結果・返済履歴・顧客信頼度である（当期の市場結果・当期の
// 生産実績は一切渡さない設計。呼び出し側liquidityClose.tsのコメント参照）。
// 純粋関数として、内訳（各要素の正規化スコア・加重寄与・理由）を返す。

import { PeriodV2 } from "../core/period";
import { CompanyId } from "../sales/types";
import { CompanyFinanceState, CompanyFinancialQuarterResult } from "../finance/types";
import { FinancingParameters } from "./parameters";
import { CompanyFinancingHistory, CreditScoreBreakdownItem, CreditScoreResult, CreditTier } from "./types";

export interface CreditScoreInput {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  /** 前四半期末の財務状態（当期首時点で銀行が参照できる最新状態）。 */
  readonly financeState: CompanyFinanceState;
  /** 前四半期の財務結果（PL/BS/CF）。ゲーム開始直後の1ターン目はundefined。 */
  readonly priorQuarterResult?: CompanyFinancialQuarterResult;
  readonly financingHistory: CompanyFinancingHistory;
  /** 前四半期末までの市場別顧客信頼・納期信頼性の単純平均（0〜100）。データがなければundefined。 */
  readonly customerTrustAvg?: number;
  readonly deliveryReliabilityAvg?: number;
}

const EPS = 1;

/** value を [badAt, goodAt] の範囲で0〜100へ線形正規化する（badAt>goodAtなら逆方向でも成立）。 */
function normalizeLinear(value: number, badAt: number, goodAt: number): number {
  if (goodAt === badAt) return 50;
  const t = (value - badAt) / (goodAt - badAt);
  return Math.max(0, Math.min(100, t * 100));
}

function tierFromScore(score: number, params: FinancingParameters): CreditTier {
  const th = params.creditScore.tierThresholds;
  if (score >= th.A) return "A";
  if (score >= th.B) return "B";
  if (score >= th.C) return "C";
  if (score >= th.D) return "D";
  return "E";
}

export function computeCreditScore(input: CreditScoreInput, params: FinancingParameters): CreditScoreResult {
  const fs = input.financeState;
  const w = params.creditScore.weights;
  const items: CreditScoreBreakdownItem[] = [];

  const totalAssets =
    (fs.cash as number) +
    fs.receivables.reduce((s, r) => s + (r.amount as number), 0) +
    (fs.otherCurrentAssets as number) +
    ((fs.fixedAssetsGross as number) - (fs.accumulatedDepreciation as number)) +
    (input.priorQuarterResult ? (input.priorQuarterResult.balanceSheet.rawMaterialInventory as number) : 0) +
    (input.priorQuarterResult ? (input.priorQuarterResult.balanceSheet.finishedGoodsInventory as number) : 0);
  const totalLiabilities =
    fs.payables.reduce((s, p) => s + (p.amount as number), 0) +
    (fs.shortTermLoans as number) +
    (fs.longTermLoans as number) +
    (fs.otherLiabilities as number);
  const totalEquity = (fs.capitalStock as number) + (fs.retainedEarnings as number);

  // --- 1. 現金ランウェイ（現金 ÷ 直近四半期の固定費水準。四半期数で正規化） ---
  const fixedCostQuarterly = input.priorQuarterResult ? (input.priorQuarterResult.contributionMargin.totalFixedCost as number) : undefined;
  const cashRunwayQuarters = fixedCostQuarterly !== undefined && fixedCostQuarterly > EPS ? (fs.cash as number) / fixedCostQuarterly : undefined;
  const cashRunwayScore = cashRunwayQuarters === undefined ? params.creditScore.neutralInitialScore : normalizeLinear(cashRunwayQuarters, -0.5, 2);
  items.push({
    factor: "cashRunway",
    weight: w.cashRunway,
    normalizedScore0to100: cashRunwayScore,
    weightedContribution: cashRunwayScore * w.cashRunway,
    note: cashRunwayQuarters === undefined ? "前期実績なし（中立値）" : `現金${(fs.cash as number).toFixed(0)} / 固定費${fixedCostQuarterly!.toFixed(0)} ≈ ${cashRunwayQuarters.toFixed(2)}四半期分`,
  });

  // --- 2. 営業CF（対売上比） ---
  const priorRevenue = input.priorQuarterResult ? (input.priorQuarterResult.profitAndLoss.grossRevenue as number) : undefined;
  const ocfRatio =
    input.priorQuarterResult && priorRevenue !== undefined && priorRevenue > EPS
      ? (input.priorQuarterResult.cashFlow.operatingCashFlow as number) / priorRevenue
      : undefined;
  const ocfScore = ocfRatio === undefined ? params.creditScore.neutralInitialScore : normalizeLinear(ocfRatio, -0.15, 0.15);
  items.push({
    factor: "operatingCashFlow",
    weight: w.operatingCashFlow,
    normalizedScore0to100: ocfScore,
    weightedContribution: ocfScore * w.operatingCashFlow,
    note: ocfRatio === undefined ? "前期実績なし（中立値）" : `営業CF/売上高 ${(ocfRatio * 100).toFixed(1)}%`,
  });

  // --- 3. 収益性（純利益率） ---
  const netMargin =
    input.priorQuarterResult && priorRevenue !== undefined && priorRevenue > EPS
      ? (input.priorQuarterResult.profitAndLoss.netIncome as number) / priorRevenue
      : undefined;
  const profitabilityScore = netMargin === undefined ? params.creditScore.neutralInitialScore : normalizeLinear(netMargin, -0.15, 0.1);
  items.push({
    factor: "profitability",
    weight: w.profitability,
    normalizedScore0to100: profitabilityScore,
    weightedContribution: profitabilityScore * w.profitability,
    note: netMargin === undefined ? "前期実績なし（中立値）" : `純利益率 ${(netMargin * 100).toFixed(1)}%`,
  });

  // --- 4. 利払能力（営業利益+減価償却 ÷ 支払利息発生額） ---
  const priorInterest = input.priorQuarterResult ? (input.priorQuarterResult.profitAndLoss.interestExpense as number) : undefined;
  const ebitdaLike = input.priorQuarterResult
    ? (input.priorQuarterResult.profitAndLoss.operatingProfit as number) + (input.priorQuarterResult.manufacturingCost.depreciationCost as number)
    : undefined;
  const interestCoverage =
    priorInterest !== undefined && ebitdaLike !== undefined ? (priorInterest > EPS ? ebitdaLike / priorInterest : ebitdaLike > 0 ? 10 : 0) : undefined;
  const interestCoverageScore = interestCoverage === undefined ? params.creditScore.neutralInitialScore : normalizeLinear(interestCoverage, 0, 4);
  items.push({
    factor: "interestCoverage",
    weight: w.interestCoverage,
    normalizedScore0to100: interestCoverageScore,
    weightedContribution: interestCoverageScore * w.interestCoverage,
    note: interestCoverage === undefined ? "前期実績なし（中立値）" : `利払能力（EBITDA相当/支払利息） ${interestCoverage.toFixed(2)}倍`,
  });

  // --- 5. レバレッジ（負債比率。低いほど良い） ---
  const debtRatio = totalAssets > EPS ? totalLiabilities / totalAssets : 1;
  const leverageScore = normalizeLinear(debtRatio, 1.0, 0.4);
  items.push({
    factor: "leverage",
    weight: w.leverage,
    normalizedScore0to100: leverageScore,
    weightedContribution: leverageScore * w.leverage,
    note: `負債比率 ${(debtRatio * 100).toFixed(1)}%（総資産${totalAssets.toFixed(0)}に対する総負債${totalLiabilities.toFixed(0)}）`,
  });

  // --- 6. 自己資本比率 ---
  const equityRatio = totalAssets > EPS ? totalEquity / totalAssets : 0;
  const equityRatioScore = normalizeLinear(equityRatio, 0, 0.4);
  items.push({
    factor: "equityRatio",
    weight: w.equityRatio,
    normalizedScore0to100: equityRatioScore,
    weightedContribution: equityRatioScore * w.equityRatio,
    note: `自己資本比率 ${(equityRatio * 100).toFixed(1)}%`,
  });

  // --- 7. 返済実績 ---
  const h = input.financingHistory;
  const totalEvents = h.totalOnTimeRepaymentEventsCount + h.totalArrearsEventsCount;
  const trackRecordScore = totalEvents === 0 ? params.creditScore.neutralInitialScore : (h.totalOnTimeRepaymentEventsCount / totalEvents) * 100;
  items.push({
    factor: "repaymentTrackRecord",
    weight: w.repaymentTrackRecord,
    normalizedScore0to100: trackRecordScore,
    weightedContribution: trackRecordScore * w.repaymentTrackRecord,
    note: totalEvents === 0 ? "返済履歴なし（中立値）" : `期日どおり返済${h.totalOnTimeRepaymentEventsCount}件 / 延滞${h.totalArrearsEventsCount}件`,
  });

  // --- 8. 延滞履歴（連続延滞四半期数が少ないほど良い） ---
  const arrearsScore = Math.max(0, 100 - h.consecutiveArrearsQuarters * 30);
  items.push({
    factor: "arrearsHistory",
    weight: w.arrearsHistory,
    normalizedScore0to100: arrearsScore,
    weightedContribution: arrearsScore * w.arrearsHistory,
    note: `連続延滞四半期数 ${h.consecutiveArrearsQuarters}`,
  });

  // --- 9. 顧客信頼・納期信頼性 ---
  const trustAvail = input.customerTrustAvg !== undefined && input.deliveryReliabilityAvg !== undefined;
  const trustScore = trustAvail ? (input.customerTrustAvg! + input.deliveryReliabilityAvg!) / 2 : params.creditScore.neutralInitialScore;
  items.push({
    factor: "customerTrustAndDelivery",
    weight: w.customerTrustAndDelivery,
    normalizedScore0to100: trustScore,
    weightedContribution: trustScore * w.customerTrustAndDelivery,
    note: trustAvail ? `顧客信頼${input.customerTrustAvg!.toFixed(1)}・納期信頼性${input.deliveryReliabilityAvg!.toFixed(1)}の平均` : "データなし（中立値）",
  });

  const weightSum = items.reduce((s, it) => s + it.weight, 0);
  const rawScore = items.reduce((s, it) => s + it.weightedContribution, 0) / (weightSum > 0 ? weightSum : 1);
  const score0to100 = Math.max(0, Math.min(100, rawScore));
  const tier = tierFromScore(score0to100, params);

  const reasons: string[] = [];
  if (totalEquity < 0) reasons.push("債務超過のため信用スコアが大きく低下している。");
  if (h.consecutiveArrearsQuarters > 0) reasons.push(`連続${h.consecutiveArrearsQuarters}四半期の延滞履歴が信用スコアを押し下げている。`);
  if (debtRatio > 0.85) reasons.push("負債比率が高水準。");
  if (ocfRatio !== undefined && ocfRatio < 0) reasons.push("前期の営業キャッシュフローがマイナス。");

  return {
    companyId: input.companyId,
    period: input.period,
    score0to100,
    tier,
    breakdown: items,
    reasons,
  };
}
