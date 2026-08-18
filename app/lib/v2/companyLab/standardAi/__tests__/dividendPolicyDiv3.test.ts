// ShrimpX V2 — Phase DIV-3: Standard AI配当ポリシーの単体テスト
//
// 対象は decision/dividend.ts（基準配当ルール）と、managementProfile.ts へ追加した
// dividendPropensityRatio（プロファイル別の配当性向バイアス）である。
// 検証項目は DIV-3 設計提案 §6-4 の要求どおり:
//   1. 基準配当ルールの各条件（healthy / 当期CAPEX新規提案 / distributableEarnings）
//   2. プロファイル別バイアスの適用
//   3. 既存Player配当ロジック（finance/dividend.ts）との非干渉
//      = AIの要求額は必ずresolveDividendDecisionで受理される（rejectedにならない）

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStandardAiDividendDecision } from "../decision/dividend";
import {
  MANAGEMENT_PROFILES,
  MANAGEMENT_PROFILE_BY_COMPANY_ID,
  MAX_BIAS_RATIO,
  deriveStandardAiParameters,
  resolveManagementProfileParameters,
} from "../managementProfile";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { CompanyFinanceState, usd } from "../../../finance/types";
import { computeMaxDividendUsd, resolveDividendDecision } from "../../../finance/dividend";
import { FinancialHealthTier } from "../../../financing/types";

function financeState(overrides: Partial<CompanyFinanceState> = {}): CompanyFinanceState {
  return {
    companyId: "TEST",
    cash: usd(30_000_000),
    receivables: [],
    payables: [],
    otherCurrentAssets: usd(0),
    fixedAssetsGross: usd(40_000_000),
    accumulatedDepreciation: usd(0),
    shortTermLoans: usd(0),
    longTermLoans: usd(0),
    otherLiabilities: usd(0),
    capitalStock: usd(30_000_000),
    // game-start時点の残差を含む既存retainedEarnings。配当可能額の判定には使わない。
    retainedEarnings: usd(50_000_000),
    distributableEarnings: usd(10_000_000),
    finishedGoodsCostLedger: [],
    ...overrides,
  };
}

function build(args: {
  finance?: CompanyFinanceState;
  health?: FinancialHealthTier | null;
  capexCount?: number;
  payoutRatio?: number;
}) {
  return buildStandardAiDividendDecision({
    companyId: "TEST",
    financeState: args.finance ?? financeState(),
    lastQuarterFinancialHealthTier: args.health === undefined ? "healthy" : args.health,
    newCapexProposalCount: args.capexCount ?? 0,
    params:
      args.payoutRatio === undefined
        ? STANDARD_AI_PARAMETERS_V1
        : { ...STANDARD_AI_PARAMETERS_V1, dividendBasePayoutRatio: args.payoutRatio },
  });
}

function codes(result: ReturnType<typeof build>): string[] {
  return result.diagnostics.map((d) => d.code);
}

// ---------------------------------------------------------------------
// 1. 基準配当ルールの各条件
// ---------------------------------------------------------------------

test("DIV-3: 3条件をすべて満たすと、分配可能利益×基準配当性向を配当する", () => {
  const result = build({});
  assert.ok(result.dividendDecision, "配当が生成されるべき");
  assert.equal(result.dividendDecision?.dividendAmountUsd, 10_000_000 * STANDARD_AI_PARAMETERS_V1.dividendBasePayoutRatio);
  assert.ok(codes(result).includes("DIVIDEND_PROPOSED"));
});

for (const tier of ["watch", "stressed", "covenantBreach", "paymentArrears", "insolvent", "paymentDefault"] as const) {
  test(`DIV-3: financialHealth.primary="${tier}"（healthy以外）では配当しない`, () => {
    const result = build({ health: tier });
    assert.equal(result.dividendDecision, undefined);
    assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_NOT_HEALTHY"]);
  });
}

test("DIV-3: 財務健全性が未確定（null、Turn1等）では安全側に倒して配当しない", () => {
  const result = build({ health: null });
  assert.equal(result.dividendDecision, undefined);
  assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_NOT_HEALTHY"]);
});

test("DIV-3: 当期に新規CAPEX提案が1件でもあれば配当しない（投資と株主還元を同時に行わない）", () => {
  const result = build({ capexCount: 1 });
  assert.equal(result.dividendDecision, undefined);
  assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_CAPEX_PLANNED"]);

  // 提案0件へ戻せば同じ財務状態で配当が復活する（CAPEX条件だけが効いていること）。
  const restored = build({ capexCount: 0 });
  assert.ok(restored.dividendDecision);
});

for (const distributable of [0, -1_000_000]) {
  test(`DIV-3: distributableEarnings=${distributable}（正でない）では配当しない`, () => {
    const result = build({ finance: financeState({ distributableEarnings: usd(distributable) }) });
    assert.equal(result.dividendDecision, undefined);
    assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_NO_DISTRIBUTABLE_EARNINGS"]);
  });
}

test("DIV-3: retainedEarningsが潤沢でもdistributableEarningsが0なら配当しない（初期利益剰余金の即時配当を防ぐ）", () => {
  const result = build({
    finance: financeState({ retainedEarnings: usd(500_000_000), distributableEarnings: usd(0) }),
  });
  assert.equal(result.dividendDecision, undefined);
});

// ---------------------------------------------------------------------
// 2. 上限クランプ（Playerと同じcomputeMaxDividendUsd）
// ---------------------------------------------------------------------

test("DIV-3: 現金が不足する局面では、配当額がmin(現金, 分配可能利益)へクランプされる", () => {
  // 基準配当額（分配可能利益×性向）が必ず現金を上回るよう、payoutRatioを明示して
  // 現在のdividendBasePayoutRatioの既定値に依存しないようにする。
  const finance = financeState({ cash: usd(100_000), distributableEarnings: usd(10_000_000) });
  const result = build({ finance, payoutRatio: 0.1 });
  assert.equal(result.maxDividendUsd, computeMaxDividendUsd(finance));
  assert.equal(result.maxDividendUsd, 100_000);
  assert.equal(result.baseDividendUsd, 1_000_000);
  assert.equal(result.dividendDecision?.dividendAmountUsd, 100_000);
  assert.ok(codes(result).includes("DIVIDEND_LIMITED_BY_MAX"));
});

test("DIV-3: 現金が0なら（分配可能利益が正でも）配当しない", () => {
  const result = build({ finance: financeState({ cash: usd(0), distributableEarnings: usd(10_000_000) }) });
  assert.equal(result.dividendDecision, undefined);
});

test("DIV-3: dividendBasePayoutRatio=0（配当ポリシーOFF）ではどの状態でも配当しない", () => {
  const result = build({ payoutRatio: 0 });
  assert.equal(result.dividendDecision, undefined);
});

// ---------------------------------------------------------------------
// 3. 既存Player配当ロジックとの非干渉
// ---------------------------------------------------------------------

test("DIV-3: AIが要求する配当額は、Playerと同じresolveDividendDecisionで必ず受理される（拒否されない）", () => {
  const cases: CompanyFinanceState[] = [
    financeState(),
    financeState({ cash: usd(500_000), distributableEarnings: usd(10_000_000) }),
    financeState({ cash: usd(10_000_000), distributableEarnings: usd(1) }),
    financeState({ cash: usd(1), distributableEarnings: usd(1) }),
  ];
  for (const finance of cases) {
    const result = build({ finance });
    const resolution = resolveDividendDecision(result.dividendDecision, finance);
    assert.equal(resolution.rejected, false, `拒否されてはならない: ${JSON.stringify(result.dividendDecision)}`);
    assert.equal(resolution.appliedUsd, result.dividendDecision?.dividendAmountUsd ?? 0);
  }
});

test("DIV-3: finance/dividend.tsのcomputeMaxDividendUsdの定義そのもの（min(Cash, 分配可能利益)）は変更されていない", () => {
  assert.equal(computeMaxDividendUsd(financeState({ cash: usd(3), distributableEarnings: usd(7) })), 3);
  assert.equal(computeMaxDividendUsd(financeState({ cash: usd(7), distributableEarnings: usd(3) })), 3);
  assert.equal(computeMaxDividendUsd(financeState({ cash: usd(-5), distributableEarnings: usd(3) })), 0);
});

// ---------------------------------------------------------------------
// 4. プロファイル別バイアスの適用
// ---------------------------------------------------------------------

test("DIV-3: dividendPropensityRatioは5プロファイルすべてで許容範囲(±MAX_BIAS_RATIO)内", () => {
  for (const profile of Object.values(MANAGEMENT_PROFILES)) {
    assert.ok(
      Math.abs(profile.dividendPropensityRatio) <= MAX_BIAS_RATIO + 1e-9,
      `${profile.id}のdividendPropensityRatio(${profile.dividendPropensityRatio})が許容範囲を超えている`
    );
  }
});

test("DIV-3: balanced(A社)はdividendBasePayoutRatioもバイアスなし（基準値と完全一致）", () => {
  const { params } = deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, MANAGEMENT_PROFILES.balanced);
  assert.equal(params.dividendBasePayoutRatio, STANDARD_AI_PARAMETERS_V1.dividendBasePayoutRatio);
});

test("DIV-3: 経営性格の物語どおりの符号（conservativeは高め、growth/valueAdded/opportunisticは低め）", () => {
  const base = STANDARD_AI_PARAMETERS_V1.dividendBasePayoutRatio;
  const ratioOf = (id: keyof typeof MANAGEMENT_PROFILES) =>
    deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, MANAGEMENT_PROFILES[id]).params.dividendBasePayoutRatio;

  assert.ok(ratioOf("conservative") > base, "conservativeは再投資よりCashを配る性格（配当性向を上げる）");
  assert.ok(ratioOf("growth") < base, "growthは再投資優先（配当性向を下げる）");
  assert.ok(ratioOf("valueAdded") < base, "valueAddedは再投資優先（配当性向を下げる）");
  // balanced / opportunistic は配当性向バイアスを持たない（設計提案が符号方向を
  // 明示している3社にだけバイアスを置く＝根拠の無い値を発明しない）。
  assert.equal(ratioOf("balanced"), base);
  assert.equal(ratioOf("opportunistic"), base);
});

test("DIV-3: バイアスは診断（appliedBiasItems）へも基準値→バイアス後として記録される", () => {
  const { appliedBiasItems } = deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, MANAGEMENT_PROFILES.conservative);
  const item = appliedBiasItems.find((i) => i.field === "dividendBasePayoutRatio");
  assert.ok(item, "dividendBasePayoutRatioのバイアス項目が記録されるべき");
  assert.equal(item?.baseValue, STANDARD_AI_PARAMETERS_V1.dividendBasePayoutRatio);
  assert.equal(item?.ratio, MANAGEMENT_PROFILES.conservative.dividendPropensityRatio);
});

test("DIV-3: 同じ財務状態でも、会社（プロファイル）によって配当額に差が出る", () => {
  const finance = financeState();
  const amountFor = (companyId: "CONSV" | "BAL" | "MASS") => {
    const { params } = resolveManagementProfileParameters(companyId);
    return build({ finance, payoutRatio: params.dividendBasePayoutRatio }).dividendDecision?.dividendAmountUsd ?? 0;
  };
  const consv = amountFor("CONSV");
  const bal = amountFor("BAL");
  const mass = amountFor("MASS");
  assert.ok(consv > bal, "CONSV(conservative)の配当額はBAL(balanced)より大きいはず");
  assert.ok(mass < bal, "MASS(growth)の配当額はBAL(balanced)より小さいはず");
});

test("DIV-3: 5社すべてのプロファイルにdividendPropensityRatioが定義されている（未定義のまま残さない）", () => {
  for (const companyId of Object.keys(MANAGEMENT_PROFILE_BY_COMPANY_ID) as (keyof typeof MANAGEMENT_PROFILE_BY_COMPANY_ID)[]) {
    const { profile } = resolveManagementProfileParameters(companyId);
    assert.equal(typeof profile.dividendPropensityRatio, "number");
  }
});
