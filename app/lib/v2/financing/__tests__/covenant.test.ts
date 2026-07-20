// ShrimpX V2 — 資金繰りモジュール 財務制限条項 テスト（Phase 8B-1）
//
// 財務制限条項違反（covenant breach）は実際の支払不能（延滞）とは別状態であることを確認する。
// 最低自己資本比率・最大負債比率・最低利払能力・延滞の有無、それぞれが単独で違反判定を
// トリガーできることと、健全な入力では違反がゼロになることを検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { checkCovenants, CovenantCheckInput } from "../covenant";
import { FINANCING_PARAMETERS_V1 } from "../parameters";

const P1 = period(2015, 1);

function makeInput(overrides: Partial<CovenantCheckInput> = {}): CovenantCheckInput {
  return {
    companyId: "BAL",
    period: P1,
    totalAssetsUsd: 100_000_000,
    totalLiabilitiesUsd: 40_000_000,
    totalEquityUsd: 60_000_000,
    ebitdaLikeQuarterlyUsd: 10_000_000,
    interestExpenseQuarterlyUsd: 1_000_000,
    hasArrearsThisPeriod: false,
    ...overrides,
  };
}

test("受入確認CV-1: 自己資本比率・負債比率・利払能力・延滞のいずれも健全なら違反はない", () => {
  const result = checkCovenants(makeInput(), FINANCING_PARAMETERS_V1);
  assert.equal(result.anyBreach, false);
  assert.ok(result.checks.every((c) => !c.breached));
});

test("受入確認CV-2: 自己資本比率が最低ラインを下回ると minEquityRatio が単独で違反になる", () => {
  const result = checkCovenants(makeInput({ totalEquityUsd: 5_000_000 }), FINANCING_PARAMETERS_V1);
  const check = result.checks.find((c) => c.name === "minEquityRatio");
  assert.ok(check?.breached);
  assert.equal(result.anyBreach, true);
});

test("受入確認CV-3: 負債比率が最大ラインを超えると maxDebtToAssetsRatio が違反になる", () => {
  const result = checkCovenants(makeInput({ totalLiabilitiesUsd: 95_000_000, totalEquityUsd: 5_000_000 }), FINANCING_PARAMETERS_V1);
  const check = result.checks.find((c) => c.name === "maxDebtToAssetsRatio");
  assert.ok(check?.breached);
});

test("受入確認CV-4: 利払能力（EBITDA/利息）が最低ラインを下回ると minInterestCoverageRatio が違反になる", () => {
  const result = checkCovenants(makeInput({ ebitdaLikeQuarterlyUsd: 500_000, interestExpenseQuarterlyUsd: 2_000_000 }), FINANCING_PARAMETERS_V1);
  const check = result.checks.find((c) => c.name === "minInterestCoverageRatio");
  assert.ok(check?.breached);
});

test("受入確認CV-5: 利息発生がほぼゼロの場合は利払能力チェックを違反としない（判定対象外）", () => {
  const result = checkCovenants(makeInput({ interestExpenseQuarterlyUsd: 0 }), FINANCING_PARAMETERS_V1);
  const check = result.checks.find((c) => c.name === "minInterestCoverageRatio");
  assert.equal(check?.breached, false);
});

test("受入確認CV-6: 当期に延滞があった場合は noArrears が単独で違反になる（自己資本・負債比率が健全でも）", () => {
  const result = checkCovenants(makeInput({ hasArrearsThisPeriod: true }), FINANCING_PARAMETERS_V1);
  const check = result.checks.find((c) => c.name === "noArrears");
  assert.ok(check?.breached);
  assert.equal(result.anyBreach, true);
  // 延滞という別事象が、自己資本比率チェック自体を汚染しないこと（別状態として保持される）。
  const equityCheck = result.checks.find((c) => c.name === "minEquityRatio");
  assert.equal(equityCheck?.breached, false);
});

test("受入確認CV-7: 財務制限条項違反(covenant breach)と延滞(arrears)は別々のチェック項目であり、一方だけが真になり得る", () => {
  // 自己資本は健全だが延滞のみあるケース。
  const arrearsOnly = checkCovenants(makeInput({ hasArrearsThisPeriod: true }), FINANCING_PARAMETERS_V1);
  assert.equal(arrearsOnly.checks.find((c) => c.name === "minEquityRatio")?.breached, false);
  assert.equal(arrearsOnly.checks.find((c) => c.name === "noArrears")?.breached, true);

  // 自己資本比率のみ違反、延滞なしのケース。
  const equityOnly = checkCovenants(makeInput({ totalEquityUsd: 1_000_000, hasArrearsThisPeriod: false }), FINANCING_PARAMETERS_V1);
  assert.equal(equityOnly.checks.find((c) => c.name === "minEquityRatio")?.breached, true);
  assert.equal(equityOnly.checks.find((c) => c.name === "noArrears")?.breached, false);
});
