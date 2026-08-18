// ShrimpX V2 — Phase DIV-4: Standard AI配当ポリシー（Flow-Based Annual）の単体テスト
//
// 対象は decision/dividend.ts（当期純利益基準・年1回の基準配当ルール）と、
// managementProfile.ts の dividendPropensityRatio（プロファイル別配当性向バイアス）。
// 検証項目は実装指示§16のDIV-FLOW-1〜15に対応する（各testの先頭に対応IDを記す）。

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
import { period, PeriodV2 } from "../../../core/period";
import { StandardAiCrisisState } from "../crisisState";

const Q1 = period(2020, 1);
const Q2 = period(2020, 2);
const Q3 = period(2020, 3);
const Q4 = period(2020, 4);

/** 当期純利益（既定 20M USD）に対する既定payoutRatioでの基準配当額。 */
const DEFAULT_NET_INCOME_USD = 20_000_000;

function financeState(overrides: Partial<CompanyFinanceState> = {}): CompanyFinanceState {
  return {
    companyId: "TEST",
    cash: usd(300_000_000),
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
    retainedEarnings: usd(500_000_000),
    distributableEarnings: usd(200_000_000),
    finishedGoodsCostLedger: [],
    ...overrides,
  };
}

function build(args: {
  finance?: CompanyFinanceState;
  period?: PeriodV2;
  netIncome?: number | null;
  health?: FinancialHealthTier | null;
  crisis?: StandardAiCrisisState;
  capexCount?: number;
  payoutRatio?: number;
}) {
  return buildStandardAiDividendDecision({
    companyId: "TEST",
    period: args.period ?? Q4,
    financeState: args.finance ?? financeState(),
    currentQuarterNetIncomeUsd: args.netIncome === undefined ? DEFAULT_NET_INCOME_USD : args.netIncome,
    netIncomeSourcePeriod: Q3,
    lastQuarterFinancialHealthTier: args.health === undefined ? "healthy" : args.health,
    crisisState: args.crisis ?? "NORMAL",
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
// DIV-FLOW-1〜5: 配当額の算定base（flow）と上限（stock）の分離
// ---------------------------------------------------------------------

test("DIV-FLOW-1: 当期純利益が正なら、当期純利益×payoutRatioを配当する（累計利益は算定baseに使わない）", () => {
  const result = build({ payoutRatio: 0.15 });
  assert.ok(result.dividendDecision, "Q4・healthy・黒字なら配当されるべき");
  assert.equal(result.baseDividendUsd, DEFAULT_NET_INCOME_USD * 0.15);
  assert.equal(result.dividendDecision?.dividendAmountUsd, DEFAULT_NET_INCOME_USD * 0.15);
  assert.ok(codes(result).includes("DIVIDEND_PROPOSED"));
});

test("DIV-FLOW-1b(§14): 配当額 / 当期純利益 が effective payout ratio と一致する（クランプ時を除く）", () => {
  for (const ratio of [0.1, 0.15, 0.2, 0.25]) {
    const result = build({ payoutRatio: ratio });
    const applied = result.dividendDecision?.dividendAmountUsd ?? 0;
    assert.ok(applied < result.maxDividendUsd, "この検証はクランプが効いていない前提");
    assert.ok(
      Math.abs(applied / result.currentQuarterNetIncomeUsd - ratio) < 1e-12,
      `ratio=${ratio}: 実効配当性向が一致しない（${applied / result.currentQuarterNetIncomeUsd}）`
    );
  }
});

test("DIV-FLOW-2: 当期純利益が赤字なら配当0（累計分配可能利益が潤沢でも取り崩さない）", () => {
  const result = build({ netIncome: -5_000_000, finance: financeState({ distributableEarnings: usd(200_000_000) }) });
  assert.equal(result.dividendDecision, undefined);
  assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS"]);
});

test("DIV-FLOW-3: 当期純利益が0なら配当0", () => {
  const result = build({ netIncome: 0 });
  assert.equal(result.dividendDecision, undefined);
  assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS"]);
});

test("DIV-FLOW-3b: 確定済み四半期損益がまだ無い（null、Turn1等）なら配当0", () => {
  const result = build({ netIncome: null });
  assert.equal(result.dividendDecision, undefined);
  assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS"]);
});

test("DIV-FLOW-4: distributableEarningsは算定baseではなく上限として働く", () => {
  // 同じ当期純利益・同じpayoutRatioで、累計分配可能利益だけを10倍にしても
  // 配当額は変わらない（＝算定baseではない）。
  const small = build({ finance: financeState({ distributableEarnings: usd(50_000_000) }), payoutRatio: 0.15 });
  const large = build({ finance: financeState({ distributableEarnings: usd(500_000_000) }), payoutRatio: 0.15 });
  assert.equal(small.dividendDecision?.dividendAmountUsd, large.dividendDecision?.dividendAmountUsd);

  // 一方、分配可能利益が基準配当額を下回るときは、そこまで縮小される（＝上限として働く）。
  const capped = build({ finance: financeState({ distributableEarnings: usd(1_000_000) }), payoutRatio: 0.15 });
  assert.equal(capped.baseDividendUsd, DEFAULT_NET_INCOME_USD * 0.15);
  assert.equal(capped.dividendDecision?.dividendAmountUsd, 1_000_000);
  assert.ok(codes(capped).includes("DIVIDEND_LIMITED_BY_DISTRIBUTABLE_EARNINGS"));
});

test("DIV-FLOW-5: 配当額はcomputeMaxDividendUsd（min(現金, 分配可能利益)）でクランプされる", () => {
  const finance = financeState({ cash: usd(400_000), distributableEarnings: usd(200_000_000) });
  const result = build({ finance, payoutRatio: 0.15 });
  assert.equal(result.maxDividendUsd, computeMaxDividendUsd(finance));
  assert.equal(result.maxDividendUsd, 400_000);
  assert.equal(result.dividendDecision?.dividendAmountUsd, 400_000);
  assert.ok(codes(result).includes("DIVIDEND_LIMITED_BY_MAX"));
  // 現金が上限を決めている場合は、分配可能利益起因のコードは付かない。
  assert.ok(!codes(result).includes("DIVIDEND_LIMITED_BY_DISTRIBUTABLE_EARNINGS"));
});

test("DIV-FLOW-5b: 現金0・分配可能利益0いずれでも配当しない（Gate F/G）", () => {
  assert.equal(build({ finance: financeState({ cash: usd(0) }) }).dividendDecision, undefined);
  assert.equal(build({ finance: financeState({ distributableEarnings: usd(0) }) }).dividendDecision, undefined);
});

// ---------------------------------------------------------------------
// DIV-FLOW-6〜9: 年1回（Q4のみ）の配当判定
// ---------------------------------------------------------------------

for (const [id, p] of [
  ["DIV-FLOW-6", Q1],
  ["DIV-FLOW-7", Q2],
  ["DIV-FLOW-8", Q3],
] as const) {
  test(`${id}: ${p} は年度末ではないため配当を検討しない（他条件をすべて満たしていてもskip）`, () => {
    const result = build({ period: p });
    assert.equal(result.dividendDecision, undefined);
    assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_NOT_ANNUAL_PERIOD"]);
  });
}

test("DIV-FLOW-9: Q4は配当検討対象（同一条件でQ1〜Q3はskip・Q4のみ配当）", () => {
  assert.ok(build({ period: Q4 }).dividendDecision, "Q4では配当されるべき");
  for (const p of [Q1, Q2, Q3]) assert.equal(build({ period: p }).dividendDecision, undefined);
});

test("DIV-FLOW-9b: Q4で見送った年度は翌Q1へ繰り越されない（Q1は無条件でskip）", () => {
  // Q4を赤字でskipした翌年Q1は、黒字・healthy・上限十分でも必ずskipされる。
  const skippedQ4 = build({ period: Q4, netIncome: -1 });
  assert.equal(skippedQ4.dividendDecision, undefined);
  const nextQ1 = build({ period: period(2021, 1), netIncome: DEFAULT_NET_INCOME_USD });
  assert.equal(nextQ1.dividendDecision, undefined);
  assert.deepEqual(codes(nextQ1), ["DIVIDEND_SKIPPED_NOT_ANNUAL_PERIOD"]);
});

test("DIV-FLOW-9c: 年度末判定は既存PeriodV2表現だけから決まる（新規stateを持たない＝同一入力で常に同一結果）", () => {
  const a = build({});
  const b = build({});
  assert.deepEqual(a.dividendDecision, b.dividendDecision);
  assert.deepEqual(codes(a), codes(b));
});

// ---------------------------------------------------------------------
// DIV-FLOW-10・11: Q4でも他ゲートで止まる
// ---------------------------------------------------------------------

for (const tier of ["watch", "stressed", "covenantBreach", "paymentArrears", "insolvent", "paymentDefault"] as const) {
  test(`DIV-FLOW-10: Q4でもfinancialHealth.primary="${tier}"なら配当しない`, () => {
    const result = build({ health: tier });
    assert.equal(result.dividendDecision, undefined);
    assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_NOT_HEALTHY"]);
  });
}

test("DIV-FLOW-10b: Q4でも財務健全性が未確定（null）なら安全側に倒して配当しない", () => {
  const result = build({ health: null });
  assert.equal(result.dividendDecision, undefined);
  assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_NOT_HEALTHY"]);
});

for (const crisis of ["LIQUIDITY_STRESS", "SEVERE_DISTRESS"] as const) {
  test(`DIV-FLOW-10c: Q4・healthyでもCrisis State="${crisis}"なら配当しない`, () => {
    const result = build({ crisis });
    assert.equal(result.dividendDecision, undefined);
    assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_CRISIS"]);
  });
}

test("DIV-FLOW-11: Q4でも当期に新規CAPEX提案が1件でもあれば配当しない", () => {
  const result = build({ capexCount: 1 });
  assert.equal(result.dividendDecision, undefined);
  assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_CAPEX_PLANNED"]);
  // 提案0件へ戻せば同じ財務状態で配当が復活する（CAPEX条件だけが効いていること）。
  assert.ok(build({ capexCount: 0 }).dividendDecision);
});

test("DIV-FLOW-11b: payoutRatio=0（配当ポリシーOFF）ではQ4でも配当しない", () => {
  assert.equal(build({ payoutRatio: 0 }).dividendDecision, undefined);
});

// ---------------------------------------------------------------------
// DIV-FLOW-12・14: Player/game-commonロジックとの分離
// ---------------------------------------------------------------------

test("DIV-FLOW-12: PlayerはQ4以外でも配当できる（年1回制約はStandard AI提案生成側だけの規則）", () => {
  const finance = financeState({ cash: usd(50_000_000), distributableEarnings: usd(30_000_000) });
  for (const p of [Q1, Q2, Q3, Q4]) {
    // Standard AIはQ1〜Q3では提案しない。
    if (p !== Q4) assert.equal(build({ period: p, finance }).dividendDecision, undefined);
    // 一方、game-commonのresolveDividendDecisionはPeriodを引数に取らず、
    // どの四半期でもPlayerの配当要求をそのまま受理する。
    const resolution = resolveDividendDecision({ dividendAmountUsd: 10_000_000 }, finance);
    assert.equal(resolution.rejected, false);
    assert.equal(resolution.appliedUsd, 10_000_000);
  }
});

test("DIV-FLOW-14: AIが要求する配当額は、Playerと同じresolveDividendDecisionで必ず受理される（拒否されない）", () => {
  const cases: CompanyFinanceState[] = [
    financeState(),
    financeState({ cash: usd(400_000), distributableEarnings: usd(200_000_000) }),
    financeState({ cash: usd(200_000_000), distributableEarnings: usd(1) }),
    financeState({ cash: usd(1), distributableEarnings: usd(1) }),
  ];
  for (const finance of cases) {
    const result = build({ finance, payoutRatio: 0.25 });
    const resolution = resolveDividendDecision(result.dividendDecision, finance);
    assert.equal(resolution.rejected, false, `拒否されてはならない: ${JSON.stringify(result.dividendDecision)}`);
    assert.equal(resolution.appliedUsd, result.dividendDecision?.dividendAmountUsd ?? 0);
  }
});

test("DIV-FLOW-14b: game-commonのcomputeMaxDividendUsdの定義（min(Cash, 分配可能利益)）は変更されていない", () => {
  assert.equal(computeMaxDividendUsd(financeState({ cash: usd(3), distributableEarnings: usd(7) })), 3);
  assert.equal(computeMaxDividendUsd(financeState({ cash: usd(7), distributableEarnings: usd(3) })), 3);
  assert.equal(computeMaxDividendUsd(financeState({ cash: usd(-5), distributableEarnings: usd(3) })), 0);
});

// ---------------------------------------------------------------------
// DIV-FLOW-13: プロファイル別バイアス
// ---------------------------------------------------------------------

test("DIV-FLOW-13: dividendPropensityRatioは5プロファイルすべてで許容範囲(±MAX_BIAS_RATIO)内", () => {
  for (const profile of Object.values(MANAGEMENT_PROFILES)) {
    assert.ok(
      Math.abs(profile.dividendPropensityRatio) <= MAX_BIAS_RATIO + 1e-9,
      `${profile.id}のdividendPropensityRatio(${profile.dividendPropensityRatio})が許容範囲を超えている`
    );
  }
});

test("DIV-FLOW-13b: balanced(A社)とopportunistic(E社)はバイアスなし、conservativeは高め、growth/valueAddedは低め", () => {
  const base = STANDARD_AI_PARAMETERS_V1.dividendBasePayoutRatio;
  const ratioOf = (id: keyof typeof MANAGEMENT_PROFILES) =>
    deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, MANAGEMENT_PROFILES[id]).params.dividendBasePayoutRatio;

  assert.ok(ratioOf("conservative") > base, "conservativeは再投資よりCashを配る性格（配当性向を上げる）");
  assert.ok(ratioOf("growth") < base, "growthは再投資優先（配当性向を下げる）");
  assert.ok(ratioOf("valueAdded") < base, "valueAddedは再投資優先（配当性向を下げる）");
  // 設計提案が符号方向を明示している3社にだけバイアスを置く（根拠の無い値を発明しない）。
  assert.equal(ratioOf("balanced"), base);
  assert.equal(ratioOf("opportunistic"), base);
});

test("DIV-FLOW-13c: バイアスは診断（appliedBiasItems）へも基準値→バイアス後として記録される", () => {
  const { appliedBiasItems } = deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, MANAGEMENT_PROFILES.conservative);
  const item = appliedBiasItems.find((i) => i.field === "dividendBasePayoutRatio");
  assert.ok(item, "dividendBasePayoutRatioのバイアス項目が記録されるべき");
  assert.equal(item?.baseValue, STANDARD_AI_PARAMETERS_V1.dividendBasePayoutRatio);
  assert.equal(item?.ratio, MANAGEMENT_PROFILES.conservative.dividendPropensityRatio);
});

test("DIV-FLOW-13d: 同じ財務状態・同じ当期純利益でも、会社（プロファイル）によって配当額に差が出る", () => {
  const finance = financeState();
  const amountFor = (companyId: "CONSV" | "BAL" | "MASS") => {
    const { params } = resolveManagementProfileParameters(companyId);
    return build({ finance, payoutRatio: params.dividendBasePayoutRatio }).dividendDecision?.dividendAmountUsd ?? 0;
  };
  assert.ok(amountFor("CONSV") > amountFor("BAL"), "CONSV(conservative)の配当額はBAL(balanced)より大きいはず");
  assert.ok(amountFor("MASS") < amountFor("BAL"), "MASS(growth)の配当額はBAL(balanced)より小さいはず");
});

test("DIV-FLOW-13e: 5社すべてのプロファイルにdividendPropensityRatioが定義されている", () => {
  for (const companyId of Object.keys(MANAGEMENT_PROFILE_BY_COMPANY_ID) as (keyof typeof MANAGEMENT_PROFILE_BY_COMPANY_ID)[]) {
    const { profile } = resolveManagementProfileParameters(companyId);
    assert.equal(typeof profile.dividendPropensityRatio, "number");
  }
});
