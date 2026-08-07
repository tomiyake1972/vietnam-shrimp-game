// ShrimpX V2 — 資金繰りモジュール 銀行審査 テスト（Phase 8B-1）
//
// 対応する重要テスト: 15.承認額が申請額・限度額を超えない
// 加えて、信用区分停止時の全額否認、条項違反・延滞履歴による金利加算を確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { underwriteLoanApplication } from "../bankUnderwriting";
import { FINANCING_PARAMETERS_V1 } from "../parameters";
import { BorrowingCapacityResult, CovenantCheckResult, CreditScoreResult, FinancingRequestInput } from "../types";

const P1 = period(2015, 1);

function makeRequest(overrides: Partial<FinancingRequestInput> = {}): FinancingRequestInput {
  return {
    desiredAmountUsd: 10_000_000,
    desiredLoanType: "workingCapital",
    desiredTermQuarters: 4,
    desiredRepaymentMethod: "bulletAtMaturity",
    desiredPrepaymentUsd: 0,
    emergencyAcceptable: false,
    ...overrides,
  };
}

function makeCreditScore(tier: CreditScoreResult["tier"] = "B"): CreditScoreResult {
  return { companyId: "BAL", period: P1, score0to100: 70, tier, breakdown: [], reasons: [] };
}

function makeCapacity(overrides: Partial<BorrowingCapacityResult> = {}): BorrowingCapacityResult {
  return {
    companyId: "BAL",
    period: P1,
    collateralBasedLimitUsd: 20_000_000,
    earningsBasedLimitUsd: 20_000_000,
    creditTierCapUsd: 20_000_000,
    grossLimitUsd: 20_000_000,
    existingLoanBalanceUsd: 0,
    availableAdditionalCapacityUsd: 20_000_000,
    underwritingFrozen: false,
    constraints: [],
    bindingConstraint: "collateralBasedLimit",
    ...overrides,
  };
}

function makeCovenant(anyBreach = false): CovenantCheckResult {
  return { companyId: "BAL", period: P1, checks: [], anyBreach };
}

test("受入確認BU-1: 借入余力の範囲内の申請は全額承認され、否決額は0になる", () => {
  const decision = underwriteLoanApplication(
    "BAL",
    P1,
    makeRequest({ desiredAmountUsd: 10_000_000 }),
    makeCreditScore(),
    makeCapacity({ availableAdditionalCapacityUsd: 20_000_000 }),
    makeCovenant(),
    false,
    FINANCING_PARAMETERS_V1,
    "seed1"
  );
  assert.equal(decision.approvedAmountUsd, 10_000_000);
  assert.equal(decision.deniedAmountUsd, 0);
  assert.ok(decision.approvedLoanId);
});

test("受入確認BU-2: 申請額が借入限度額を超える場合、承認額は限度額でクリップされ、超過分は否決される", () => {
  const decision = underwriteLoanApplication(
    "BAL",
    P1,
    makeRequest({ desiredAmountUsd: 30_000_000 }),
    makeCreditScore(),
    makeCapacity({ availableAdditionalCapacityUsd: 12_000_000 }),
    makeCovenant(),
    false,
    FINANCING_PARAMETERS_V1,
    "seed2"
  );
  assert.equal(decision.approvedAmountUsd, 12_000_000);
  assert.equal(decision.deniedAmountUsd, 18_000_000);
  assert.ok(decision.approvedAmountUsd <= decision.requestedAmountUsd);
});

test("受入確認BU-3: 借入余力枠停止(underwritingFrozen)の場合は全額否認され、承認額は0になる", () => {
  const decision = underwriteLoanApplication(
    "MASS",
    P1,
    makeRequest({ desiredAmountUsd: 5_000_000 }),
    makeCreditScore("E"),
    makeCapacity({ underwritingFrozen: true, availableAdditionalCapacityUsd: 0 }),
    makeCovenant(),
    false,
    FINANCING_PARAMETERS_V1,
    "seed3"
  );
  assert.equal(decision.approvedAmountUsd, 0);
  assert.equal(decision.deniedAmountUsd, 5_000_000);
  assert.equal(decision.approvedLoanId, undefined);
});

test("受入確認BU-4: 希望借入額が0以下の場合は申請自体がないものとして扱われる", () => {
  const decision = underwriteLoanApplication(
    "BAL",
    P1,
    makeRequest({ desiredAmountUsd: 0 }),
    makeCreditScore(),
    makeCapacity(),
    makeCovenant(),
    false,
    FINANCING_PARAMETERS_V1,
    "seed4"
  );
  assert.equal(decision.requestedAmountUsd, 0);
  assert.equal(decision.approvedAmountUsd, 0);
  assert.equal(decision.deniedAmountUsd, 0);
});

test("受入確認BU-5: 財務制限条項違反があると、適用金利が違反なしの場合より高くなる", () => {
  const clean = underwriteLoanApplication("BAL", P1, makeRequest(), makeCreditScore(), makeCapacity(), makeCovenant(false), false, FINANCING_PARAMETERS_V1, "s5a");
  const breached = underwriteLoanApplication("BAL", P1, makeRequest(), makeCreditScore(), makeCapacity(), makeCovenant(true), false, FINANCING_PARAMETERS_V1, "s5b");
  assert.ok(breached.appliedAnnualRate > clean.appliedAnnualRate);
});

test("受入確認BU-6: 延滞履歴があると、適用金利が延滞履歴なしの場合より高くなる", () => {
  const noHistory = underwriteLoanApplication("BAL", P1, makeRequest(), makeCreditScore(), makeCapacity(), makeCovenant(), false, FINANCING_PARAMETERS_V1, "s6a");
  const withHistory = underwriteLoanApplication("BAL", P1, makeRequest(), makeCreditScore(), makeCapacity(), makeCovenant(), true, FINANCING_PARAMETERS_V1, "s6b");
  assert.ok(withHistory.appliedAnnualRate > noHistory.appliedAnnualRate);
});

test("受入確認BU-7: 承認額は常に申請額以下かつ借入限度額（availableAdditionalCapacityUsd）以下である（複数ケース）", () => {
  const cases = [
    { desired: 1_000_000, capacity: 5_000_000 },
    { desired: 5_000_000, capacity: 1_000_000 },
    { desired: 100_000_000, capacity: 0 },
    { desired: 0, capacity: 10_000_000 },
  ];
  for (const c of cases) {
    const decision = underwriteLoanApplication(
      "BAL",
      P1,
      makeRequest({ desiredAmountUsd: c.desired }),
      makeCreditScore(),
      makeCapacity({ availableAdditionalCapacityUsd: c.capacity }),
      makeCovenant(),
      false,
      FINANCING_PARAMETERS_V1,
      "s7"
    );
    assert.ok(decision.approvedAmountUsd <= c.desired + 0.001);
    assert.ok(decision.approvedAmountUsd <= c.capacity + 0.001);
  }
});
