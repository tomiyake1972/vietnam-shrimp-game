// ShrimpX V2 — 資金繰りモジュール 銀行信用スコア テスト（Phase 8B-1）
//
// 対応する重要テスト: 1.健全企業のスコアが高い 2.営業CF悪化で低下する
// 3.債務超過で低下する 4.延滞履歴で低下する 5.顧客信頼・納期信頼性が反映される
// 6.未来の実績を参照しない 7.内訳合計が最終スコアと一致する
// 8.0〜100の範囲を超えない

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { CompanyFinanceState, usd } from "../../finance/types";
import { computeCreditScore } from "../creditScore";
import { FINANCING_PARAMETERS_V1 } from "../parameters";
import { CompanyFinancingHistory } from "../types";

const P1 = period(2015, 1);

function makeFinanceState(overrides: Partial<CompanyFinanceState> = {}): CompanyFinanceState {
  return {
    companyId: "TEST",
    cash: usd(10_000_000),
    receivables: [],
    payables: [],
    otherCurrentAssets: usd(0),
    fixedAssetsGross: usd(40_000_000),
    accumulatedDepreciation: usd(0),
    shortTermLoans: usd(5_000_000),
    longTermLoans: usd(5_000_000),
    otherLiabilities: usd(0),
    capitalStock: usd(30_000_000),
    retainedEarnings: usd(10_000_000),
    finishedGoodsCostLedger: [],
    ...overrides,
  };
}

function makeHistory(overrides: Partial<CompanyFinancingHistory> = {}): CompanyFinancingHistory {
  return {
    consecutiveArrearsQuarters: 0,
    consecutiveCovenantBreachQuarters: 0,
    totalOnTimeRepaymentEventsCount: 4,
    totalArrearsEventsCount: 0,
    totalEmergencyLoanDrawsCount: 0,
    ...overrides,
  };
}

test("受入確認CS-1: 健全企業（高い自己資本比率・低い負債比率・延滞なし）は信用スコアが高くAまたはBに分類される", () => {
  const result = computeCreditScore(
    { companyId: "BAL", period: P1, financeState: makeFinanceState(), financingHistory: makeHistory(), customerTrustAvg: 85, deliveryReliabilityAvg: 90 },
    FINANCING_PARAMETERS_V1
  );
  assert.ok(result.score0to100 >= 65, `健全企業のスコアが低すぎる: ${result.score0to100}`);
  assert.ok(result.tier === "A" || result.tier === "B");
});

test("受入確認CS-2: 前期営業CFが悪化するとスコアが健全時より低下する", () => {
  const healthy = computeCreditScore({ companyId: "BAL", period: P1, financeState: makeFinanceState(), financingHistory: makeHistory() }, FINANCING_PARAMETERS_V1);
  const priorQuarterResultBad = {
    profitAndLoss: { grossRevenue: usd(10_000_000), netIncome: usd(-1_000_000), operatingProfit: usd(-500_000), interestExpense: usd(200_000) },
    cashFlow: { operatingCashFlow: usd(-3_000_000) },
    manufacturingCost: { depreciationCost: usd(100_000) },
    contributionMargin: { totalFixedCost: usd(2_000_000) },
    balanceSheet: { rawMaterialInventory: usd(0), finishedGoodsInventory: usd(0) },
  } as unknown as import("../../finance/types").CompanyFinancialQuarterResult;
  const stressed = computeCreditScore(
    { companyId: "BAL", period: P1, financeState: makeFinanceState(), priorQuarterResult: priorQuarterResultBad, financingHistory: makeHistory() },
    FINANCING_PARAMETERS_V1
  );
  assert.ok(stressed.score0to100 < healthy.score0to100, `営業CF悪化後もスコアが下がっていない: ${stressed.score0to100} vs ${healthy.score0to100}`);
});

test("受入確認CS-3: 純資産がマイナス（債務超過）になるとスコアが低下し、理由に明記される", () => {
  const solvent = computeCreditScore({ companyId: "MASS", period: P1, financeState: makeFinanceState(), financingHistory: makeHistory() }, FINANCING_PARAMETERS_V1);
  const insolventState = makeFinanceState({ retainedEarnings: usd(-80_000_000), cash: usd(-40_000_000) });
  const badPriorResult = {
    profitAndLoss: { grossRevenue: usd(30_000_000), netIncome: usd(-10_000_000), operatingProfit: usd(-8_000_000), interestExpense: usd(1_000_000) },
    cashFlow: { operatingCashFlow: usd(-12_000_000) },
    manufacturingCost: { depreciationCost: usd(500_000) },
    contributionMargin: { totalFixedCost: usd(5_000_000) },
    balanceSheet: { rawMaterialInventory: usd(0), finishedGoodsInventory: usd(0) },
  } as unknown as import("../../finance/types").CompanyFinancialQuarterResult;
  const insolvent = computeCreditScore(
    { companyId: "MASS", period: P1, financeState: insolventState, priorQuarterResult: badPriorResult, financingHistory: makeHistory() },
    FINANCING_PARAMETERS_V1
  );
  assert.ok(insolvent.score0to100 < solvent.score0to100);
  assert.ok(insolvent.reasons.some((r) => r.includes("債務超過")));
  assert.ok(insolvent.tier === "D" || insolvent.tier === "E", `債務超過かつ業績悪化の会社が信用区分${insolvent.tier}（D/E想定）`);
});

test("受入確認CS-4: 延滞履歴（連続延滞四半期数）が多いほどスコアが低下する", () => {
  const noArrears = computeCreditScore({ companyId: "MASS", period: P1, financeState: makeFinanceState(), financingHistory: makeHistory() }, FINANCING_PARAMETERS_V1);
  const withArrears = computeCreditScore(
    { companyId: "MASS", period: P1, financeState: makeFinanceState(), financingHistory: makeHistory({ consecutiveArrearsQuarters: 2, totalArrearsEventsCount: 3 }) },
    FINANCING_PARAMETERS_V1
  );
  assert.ok(withArrears.score0to100 < noArrears.score0to100);
});

test("受入確認CS-5: 顧客信頼・納期信頼性が高いほどスコアが上がり、低いほど下がる", () => {
  const highTrust = computeCreditScore(
    { companyId: "JPQ", period: P1, financeState: makeFinanceState(), financingHistory: makeHistory(), customerTrustAvg: 95, deliveryReliabilityAvg: 95 },
    FINANCING_PARAMETERS_V1
  );
  const lowTrust = computeCreditScore(
    { companyId: "JPQ", period: P1, financeState: makeFinanceState(), financingHistory: makeHistory(), customerTrustAvg: 20, deliveryReliabilityAvg: 20 },
    FINANCING_PARAMETERS_V1
  );
  assert.ok(highTrust.score0to100 > lowTrust.score0to100);
});

test("受入確認CS-6: 信用スコア計算は当期の実績（未来）を一切受け取れない（関数シグネチャに当期actualsを渡す引数が存在しない）", () => {
  // 型システム上、CreditScoreInputにはfinanceState（前期末）・priorQuarterResult（前期）・
  // financingHistory（過去累計）しかなく、当期のCompanyQuarterBusinessActualsを
  // 渡すフィールドが存在しない。本テストはその契約をコンパイル時の型として保証しており、
  // 実行時にも「渡していないこと」を確認する意味で、同一のprevFinanceStateに対し
  // 呼び出しを2回行っても結果が変わらないこと（純粋関数・副作用なし）を確認する。
  const a = computeCreditScore({ companyId: "BAL", period: P1, financeState: makeFinanceState(), financingHistory: makeHistory() }, FINANCING_PARAMETERS_V1);
  const b = computeCreditScore({ companyId: "BAL", period: P1, financeState: makeFinanceState(), financingHistory: makeHistory() }, FINANCING_PARAMETERS_V1);
  assert.deepEqual(a, b);
});

test("受入確認CS-7: 内訳（breakdown）の加重寄与合計が最終スコアと一致する", () => {
  const result = computeCreditScore(
    { companyId: "BAL", period: P1, financeState: makeFinanceState(), financingHistory: makeHistory(), customerTrustAvg: 70, deliveryReliabilityAvg: 70 },
    FINANCING_PARAMETERS_V1
  );
  const weightSum = result.breakdown.reduce((s, b) => s + b.weight, 0);
  const contributionSum = result.breakdown.reduce((s, b) => s + b.weightedContribution, 0);
  assert.ok(Math.abs(contributionSum / weightSum - result.score0to100) < 0.01);
});

test("受入確認CS-8: 信用スコアは0〜100の範囲を超えない（極端な入力でも同様）", () => {
  const extremelyBad = computeCreditScore(
    {
      companyId: "MASS",
      period: P1,
      financeState: makeFinanceState({ retainedEarnings: usd(-500_000_000), cash: usd(-500_000_000), shortTermLoans: usd(300_000_000), longTermLoans: usd(300_000_000) }),
      financingHistory: makeHistory({ consecutiveArrearsQuarters: 10, totalArrearsEventsCount: 20, totalOnTimeRepaymentEventsCount: 0 }),
      customerTrustAvg: 0,
      deliveryReliabilityAvg: 0,
    },
    FINANCING_PARAMETERS_V1
  );
  assert.ok(extremelyBad.score0to100 >= 0 && extremelyBad.score0to100 <= 100);

  const extremelyGood = computeCreditScore(
    {
      companyId: "BAL",
      period: P1,
      financeState: makeFinanceState({ shortTermLoans: usd(0), longTermLoans: usd(0), cash: usd(100_000_000), retainedEarnings: usd(100_000_000) }),
      financingHistory: makeHistory({ totalOnTimeRepaymentEventsCount: 20 }),
      customerTrustAvg: 100,
      deliveryReliabilityAvg: 100,
    },
    FINANCING_PARAMETERS_V1
  );
  assert.ok(extremelyGood.score0to100 >= 0 && extremelyGood.score0to100 <= 100);
});
