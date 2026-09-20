// ShrimpX V2 — Standard AI配当ポリシー（年間純利益ベース）の単体テスト
//
// 対象は decision/dividend.ts と、managementProfile.ts の dividendPropensityRatio。
//
// 【契約が変わった点】DIV-4時点の本モジュールは「直近確定四半期の純利益 × ratio」で
// 配当**金額**を決めていた。Q4の判断時に参照できる直近確定四半期は同年Q3なので、
// これは実質「Q3純利益 × ratio」だった。
//
// 年間純利益ベースの確定仕様では、配当金額はQ4決算後に
// 「同年度Q1〜Q4の純利益合計 × ratio − 同年度の既支払配当」で決まる。
// そのため本モジュールは**金額を決めない**。Q4時点で決めるのは
//   ・配当を検討してよいか（安全gate）
//   ・適用する配当性向とその出所
// だけであり、結果は annualSettlementIntent として返る。
//
// したがって DIV-FLOW-1〜5 / 9 / 11 / 13d の各testは「金額の検証」から
// 「policy判断（intentの有無と率）の検証」へ置き換えてある。
// 安全gate（Q4のみ・有限入力・財務健全性・Crisis・新規CAPEX・分配可能利益・現金）の
// 検証意図はそのまま残している。金額側の契約は
//   finance/__tests__/annualDividendSettlement.test.ts（CASE A〜F/J/K/L/O）
//   companyLab/simulation/__tests__/annualDividendEngine.test.ts（CASE G〜S）
// が担当する。

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

test("DIV-FLOW-1: Q4・healthy・gate通過なら、金額ではなく年間精算の意思（配当性向）を返す", () => {
  const result = build({ payoutRatio: 0.15 });
  assert.ok(result.annualSettlementIntent, "Q4・healthy・gate通過なら年間精算の意思が返るべき");
  assert.equal(result.annualSettlementIntent?.payoutRatio, 0.15);
  assert.equal(result.annualSettlementIntent?.payoutRatioSource, "STANDARD_AI");
  assert.ok(codes(result).includes("DIVIDEND_PROPOSED"));
  // 【金額を決めない】Turn開始時点の金額指定配当は行わない（年間精算はQ4決算後）。
  assert.equal(result.dividendDecision, undefined, "Standard AIはTurn開始時に金額指定配当をしない");
});

test("DIV-FLOW-1b: 実効配当性向がそのままintentへ渡る（丸め・改変をしない）", () => {
  for (const ratio of [0.1, 0.15, 0.2, 0.25]) {
    const result = build({ payoutRatio: ratio });
    assert.equal(result.annualSettlementIntent?.payoutRatio, ratio, `ratio=${ratio}: 率が改変されている`);
  }
});

test("DIV-FLOW-2: 直近四半期(Q3)が赤字でも、policy段階では止めない（判定は年間純利益へ移した）", () => {
  // 【旧契約との違い】旧Gate Eは「直近確定四半期の純利益が正」を要求していた。
  // 年間基準では「Q3赤字・年間黒字」の年度も配当対象になりうるため、
  // ここで打ち切らない。年間純利益<=0のときに目標0になる判定は
  // finance/annualDividend.ts 側（CASE B/C）が担当する。
  const result = build({ netIncome: -5_000_000, finance: financeState({ distributableEarnings: usd(200_000_000) }) });
  assert.ok(result.annualSettlementIntent, "Q3赤字だけを理由にpolicy段階で止めてはいけない");
  assert.ok(codes(result).includes("DIVIDEND_PROPOSED"));
});

test("DIV-FLOW-3: 直近四半期(Q3)が0でもpolicy段階では止めない（同上）", () => {
  const result = build({ netIncome: 0 });
  assert.ok(result.annualSettlementIntent);
});

test("DIV-FLOW-3b: 確定済み四半期損益がまだ無い（null）でもpolicy段階では止めない", () => {
  // 年度が揃わなければ年間精算側が settlement unavailable として支払わない（CASE L）。
  const result = build({ netIncome: null });
  assert.ok(result.annualSettlementIntent);
});

test("DIV-FLOW-3c: 配当性向0%なら年間精算の意思を持たない（明示0%＝配当しない）", () => {
  const result = build({ payoutRatio: 0 });
  assert.equal(result.annualSettlementIntent, undefined);
  assert.equal(result.dividendDecision, undefined);
  assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS"]);
});

test("DIV-FLOW-4: distributableEarningsは配当性向を左右しない（算定baseではない）", () => {
  // 累計分配可能利益を10倍にしても、policy段階で決まる配当性向は変わらない。
  const small = build({ finance: financeState({ distributableEarnings: usd(50_000_000) }), payoutRatio: 0.15 });
  const large = build({ finance: financeState({ distributableEarnings: usd(500_000_000) }), payoutRatio: 0.15 });
  assert.equal(small.annualSettlementIntent?.payoutRatio, large.annualSettlementIntent?.payoutRatio);
  // 上限としての役割（min(Cash, 分配可能利益)）は年間精算側で効く（CASE K）。
});

test("DIV-FLOW-5: 配当可能上限は従来どおりcomputeMaxDividendUsdで算出される", () => {
  const finance = financeState({ cash: usd(400_000), distributableEarnings: usd(200_000_000) });
  const result = build({ finance, payoutRatio: 0.15 });
  assert.equal(result.maxDividendUsd, computeMaxDividendUsd(finance));
  assert.equal(result.maxDividendUsd, 400_000);
  // 実際のクランプは年間精算側（CASE J）。ここでは上限の算出経路が変わっていないことだけを固定する。
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

test("DIV-FLOW-9: Q4のみが年間精算の検討対象（同一条件でQ1〜Q3はskip）", () => {
  assert.ok(build({ period: Q4 }).annualSettlementIntent, "Q4では年間精算の意思が返るべき");
  for (const p of [Q1, Q2, Q3]) assert.equal(build({ period: p }).annualSettlementIntent, undefined);
});

test("DIV-FLOW-9b: Q4で見送った年度は翌Q1へ繰り越されない（Q1は無条件でskip）", () => {
  // Crisis等でQ4をskipした翌年Q1は、healthy・上限十分でも必ずskipされる。
  const skippedQ4 = build({ period: Q4, crisis: "SEVERE_DISTRESS" });
  assert.equal(skippedQ4.annualSettlementIntent, undefined);
  const nextQ1 = build({ period: period(2021, 1), netIncome: DEFAULT_NET_INCOME_USD });
  assert.equal(nextQ1.annualSettlementIntent, undefined);
  assert.deepEqual(codes(nextQ1), ["DIVIDEND_SKIPPED_NOT_ANNUAL_PERIOD"]);
});

test("DIV-FLOW-9c: 年度末判定は既存PeriodV2表現だけから決まる（新規stateを持たない＝同一入力で常に同一結果）", () => {
  const a = build({});
  const b = build({});
  assert.deepEqual(a.annualSettlementIntent, b.annualSettlementIntent);
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

test("DIV-FLOW-11: Q4でも当期に新規CAPEX提案が1件でもあれば年間精算を行わない", () => {
  const result = build({ capexCount: 1 });
  assert.equal(result.annualSettlementIntent, undefined);
  assert.deepEqual(codes(result), ["DIVIDEND_SKIPPED_CAPEX_PLANNED"]);
  // 提案0件へ戻せば同じ財務状態で年間精算の意思が復活する（CAPEX条件だけが効いていること）。
  assert.ok(build({ capexCount: 0 }).annualSettlementIntent);
});

test("DIV-FLOW-11b: payoutRatio=0（配当ポリシーOFF）ではQ4でも年間精算を行わない", () => {
  assert.equal(build({ payoutRatio: 0 }).annualSettlementIntent, undefined);
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

test("DIV-FLOW-13d: 同じ財務状態でも、会社（プロファイル）によって年間精算に使う配当性向に差が出る", () => {
  // 【旧契約からの変更】以前は「配当額」で比較していたが、policy段階では金額を
  // 決めなくなったため、実際に年間精算へ渡される配当性向で比較する。
  // 同じ年間純利益に対して配当額の大小関係は配当性向の大小関係と一致するため、
  // プロファイル差が配当へ効くという検証意図は変わっていない。
  const finance = financeState();
  const ratioFor = (companyId: "CONSV" | "BAL" | "MASS") => {
    const { params } = resolveManagementProfileParameters(companyId);
    return build({ finance, payoutRatio: params.dividendBasePayoutRatio }).annualSettlementIntent?.payoutRatio ?? 0;
  };
  assert.ok(ratioFor("CONSV") > ratioFor("BAL"), "CONSV(conservative)の配当性向はBAL(balanced)より高いはず");
  assert.ok(ratioFor("MASS") < ratioFor("BAL"), "MASS(growth)の配当性向はBAL(balanced)より低いはず");
});

test("DIV-FLOW-13e: 5社すべてのプロファイルにdividendPropensityRatioが定義されている", () => {
  for (const companyId of Object.keys(MANAGEMENT_PROFILE_BY_COMPANY_ID) as (keyof typeof MANAGEMENT_PROFILE_BY_COMPANY_ID)[]) {
    const { profile } = resolveManagementProfileParameters(companyId);
    assert.equal(typeof profile.dividendPropensityRatio, "number");
  }
});
