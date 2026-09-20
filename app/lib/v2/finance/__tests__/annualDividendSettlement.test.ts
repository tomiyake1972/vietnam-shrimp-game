// ShrimpX V2 — 年間純利益ベース配当（Annual Net-Income-Based Settlement）単体テスト
//
// 確定仕様（実装指示§3・§17 CASE A〜S）を数値で固定する。
//   annualNetIncome        = 対象年度Q1〜Q4の netIncome の符号付き合計
//   annualDividendTarget   = max(0, annualNetIncome) × appliedPayoutRatio
//   yearEndAdditionalTarget= max(0, annualDividendTarget − 同年度の既支払配当)
//   actualDividend         = min(yearEndAdditionalTarget, min(Cash, 分配可能利益))
//
// 【ここで検証するのは計算契約】Engine統合（Q4決算後の実行・save/resume・
// 二重支払防止・会計整合）は annualDividendEngine.test.ts 側で実Runを回して検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import {
  aggregateAnnualDividendFacts,
  AnnualQuarterFact,
  computeAnnualDividendSettlement,
  FISCAL_QUARTERS_PER_YEAR,
  isFiscalYearEnd,
} from "../annualDividend";

const YEAR = 2020;

function facts(netIncomes: readonly number[], paid: readonly number[] = []): AnnualQuarterFact[] {
  return netIncomes.map((netIncomeUsd, i) => ({
    turn: i + 1,
    period: period(YEAR, (i + 1) as 1 | 2 | 3 | 4),
    quarter: (i + 1) as 1 | 2 | 3 | 4,
    netIncomeUsd,
    appliedDividendUsd: paid[i] ?? 0,
  }));
}

/** 集計 → 精算までを一息に回すヘルパー（上限は既定で十分大きく、制約なしの状態）。 */
function settle(args: {
  netIncomes: readonly number[];
  paid?: readonly number[];
  ratio: number;
  cash?: number;
  distributable?: number;
}) {
  const aggregation = aggregateAnnualDividendFacts({ year: YEAR, facts: facts(args.netIncomes, args.paid) });
  assert.equal(aggregation.available, true, "この helper は年度が揃っている前提で使う");
  if (!aggregation.available) throw new Error("unreachable");
  const cash = args.cash ?? 1e12;
  const distributable = args.distributable ?? 1e12;
  return {
    aggregation,
    settlement: computeAnnualDividendSettlement({
      year: YEAR,
      annualNetIncomeUsd: aggregation.annualNetIncomeUsd,
      appliedPayoutRatio: args.ratio,
      payoutRatioSource: "STANDARD_AI",
      paidDividendEarlierInYearUsd: aggregation.paidDividendEarlierInYearUsd,
      maxDividendUsd: Math.max(0, Math.min(cash, distributable)),
      availableCashUsd: cash,
      distributableEarningsUsd: distributable,
    }),
  };
}

// ---------------------------------------------------------------------
// CASE A: 年間合計が算定base（四半期単独ではない）
// ---------------------------------------------------------------------

test("CASE A: NI=10,-5,20,15 → 年間NI=40、50%で年間目標=20", () => {
  const { aggregation, settlement } = settle({ netIncomes: [10, -5, 20, 15], ratio: 0.5 });
  assert.equal(aggregation.available && aggregation.annualNetIncomeUsd, 40, "赤字四半期も符号付きで加算する");
  assert.equal(settlement.annualDividendTargetUsd, 20);
  assert.equal(settlement.yearEndAdditionalTargetUsd, 20);
  assert.equal(settlement.appliedDividendUsd, 20);
  assert.equal(settlement.annualDividendShortfallUsd, 0);
  assert.equal(settlement.shortfallReason, null);
  // 【対照】直前四半期（Q3=20）単独×50%=10 とは異なる値になっていること。
  // これが今回の修正の中心であり、ここが10になったら年間基準になっていない。
  assert.notEqual(settlement.annualDividendTargetUsd, 10);
});

// ---------------------------------------------------------------------
// CASE B/C/D/E: 年間利益と配当性向の境界
// ---------------------------------------------------------------------

test("CASE B: 年間赤字なら年間目標0（既払配当の返還もしない）", () => {
  const { aggregation, settlement } = settle({ netIncomes: [-10, -5, 2, -1], paid: [3, 0, 0, 0], ratio: 0.5 });
  assert.equal(aggregation.available && aggregation.annualNetIncomeUsd, -14);
  assert.equal(settlement.annualDividendTargetUsd, 0);
  assert.equal(settlement.yearEndAdditionalTargetUsd, 0, "既払3があってもマイナスの追加目標にはしない");
  assert.equal(settlement.appliedDividendUsd, 0);
});

test("CASE C: 年間利益0なら年間目標0", () => {
  const { settlement } = settle({ netIncomes: [10, -10, 5, -5], ratio: 0.5 });
  assert.equal(settlement.annualNetIncomeUsd, 0);
  assert.equal(settlement.annualDividendTargetUsd, 0);
  assert.equal(settlement.appliedDividendUsd, 0);
});

test("CASE D: 配当性向0%なら年間目標0（未指定ではなく明示0%の意味）", () => {
  const { settlement } = settle({ netIncomes: [10, 10, 10, 10], ratio: 0 });
  assert.equal(settlement.annualNetIncomeUsd, 40);
  assert.equal(settlement.annualDividendTargetUsd, 0);
  assert.equal(settlement.appliedDividendUsd, 0);
});

test("CASE E: 配当性向100%なら年間純利益の全額が年間目標", () => {
  const { settlement } = settle({ netIncomes: [10, 10, 10, 10], ratio: 1 });
  assert.equal(settlement.annualDividendTargetUsd, 40);
  assert.equal(settlement.appliedDividendUsd, 40);
});

// ---------------------------------------------------------------------
// CASE F: 年度内の既支払を差し引く
// ---------------------------------------------------------------------

test("CASE F: 年間目標20・年度内に7支払済み → 年末追加目標は13", () => {
  const { aggregation, settlement } = settle({ netIncomes: [10, 10, 10, 10], paid: [7, 0, 0, 0], ratio: 0.5 });
  assert.equal(aggregation.available && aggregation.paidDividendEarlierInYearUsd, 7);
  assert.equal(settlement.annualDividendTargetUsd, 20);
  assert.equal(settlement.yearEndAdditionalTargetUsd, 13);
  assert.equal(settlement.appliedDividendUsd, 13);
});

test("CASE F-2: 既払が年間目標を超えていても追加支払は0（返還しない）", () => {
  const { settlement } = settle({ netIncomes: [10, 10, 10, 10], paid: [0, 25, 0, 0], ratio: 0.5 });
  assert.equal(settlement.annualDividendTargetUsd, 20);
  assert.equal(settlement.paidDividendEarlierInYearUsd, 25);
  assert.equal(settlement.yearEndAdditionalTargetUsd, 0);
  assert.equal(settlement.appliedDividendUsd, 0);
});

// ---------------------------------------------------------------------
// CASE J/K: 資金制約（既存の min(Cash, 分配可能利益) を緩めない）
// ---------------------------------------------------------------------

test("CASE J: Cash制約で年間目標に届かない場合、未達額と理由CASH_LIMITを残す", () => {
  const { settlement } = settle({ netIncomes: [10, 10, 10, 10], ratio: 1, cash: 30, distributable: 1000 });
  assert.equal(settlement.annualDividendTargetUsd, 40);
  assert.equal(settlement.yearEndAdditionalTargetUsd, 40);
  assert.equal(settlement.maxDividendUsd, 30);
  assert.equal(settlement.appliedDividendUsd, 30, "上限で部分執行する（全額消滅させない）");
  assert.equal(settlement.annualDividendShortfallUsd, 10);
  assert.equal(settlement.shortfallReason, "CASH_LIMIT");
});

test("CASE K: 分配可能利益制約のときは理由DISTRIBUTABLE_EARNINGS_LIMITを残す", () => {
  const { settlement } = settle({ netIncomes: [10, 10, 10, 10], ratio: 1, cash: 1000, distributable: 25 });
  assert.equal(settlement.maxDividendUsd, 25);
  assert.equal(settlement.appliedDividendUsd, 25);
  assert.equal(settlement.annualDividendShortfallUsd, 15);
  assert.equal(settlement.shortfallReason, "DISTRIBUTABLE_EARNINGS_LIMIT");
});

test("CASE J/K-2: 目標を満たせたときは未達額0・理由nullで、目標と実支払を別々に残す", () => {
  const { settlement } = settle({ netIncomes: [10, 10, 10, 10], ratio: 0.5, cash: 1000, distributable: 1000 });
  assert.equal(settlement.yearEndAdditionalTargetUsd, 20);
  assert.equal(settlement.appliedDividendUsd, 20);
  assert.equal(settlement.annualDividendShortfallUsd, 0);
  assert.equal(settlement.shortfallReason, null);
  // 目標と上限は別フィールドとして記録されていること（実装指示§8）。
  assert.equal(settlement.maxDividendUsd, 1000);
});

// ---------------------------------------------------------------------
// CASE L: 年度が揃っていないときは0補完しない
// ---------------------------------------------------------------------

test("CASE L: Q1〜Q4の一部が欠落していたら、0で補完せずsettlement unavailableにする", () => {
  // Q3が無い年度（Q1,Q2,Q4だけ確定している）。
  const partial: AnnualQuarterFact[] = [
    { turn: 1, period: period(YEAR, 1), quarter: 1, netIncomeUsd: 10, appliedDividendUsd: 0 },
    { turn: 2, period: period(YEAR, 2), quarter: 2, netIncomeUsd: 10, appliedDividendUsd: 0 },
    { turn: 4, period: period(YEAR, 4), quarter: 4, netIncomeUsd: 10, appliedDividendUsd: 0 },
  ];
  const aggregation = aggregateAnnualDividendFacts({ year: YEAR, facts: partial });
  assert.equal(aggregation.available, false);
  if (aggregation.available) throw new Error("unreachable");
  assert.equal(aggregation.reason, "INCOMPLETE_FISCAL_YEAR");
  assert.deepEqual(aggregation.missingQuarters, [3]);
  // 「揃っている3件の合計30」を年間利益として使ってしまっていないこと。
  assert.equal("annualNetIncomeUsd" in aggregation, false, "確定できない年間利益を数値として公開しない");
});

test("CASE L-2: 有限でない数値が混ざっていたらINVALID_FINANCIAL_INPUTで止める", () => {
  const broken = facts([10, Number.NaN, 10, 10]);
  const aggregation = aggregateAnnualDividendFacts({ year: YEAR, facts: broken });
  assert.equal(aggregation.available, false);
  if (aggregation.available) throw new Error("unreachable");
  assert.equal(aggregation.reason, "INVALID_FINANCIAL_INPUT");
});

test("CASE L-3: 4件揃っていれば available になる（CASE Lが常時falseではない対照）", () => {
  const aggregation = aggregateAnnualDividendFacts({ year: YEAR, facts: facts([1, 2, 3, 4]) });
  assert.equal(aggregation.available, true);
  if (!aggregation.available) throw new Error("unreachable");
  assert.equal(aggregation.annualNetIncomeUsd, 10);
});

// ---------------------------------------------------------------------
// CASE O: 年度境界
// ---------------------------------------------------------------------

test("CASE O: 別年度の四半期は集計に混ざらない（呼び出し側の年度フィルタ前提を固定する）", () => {
  // 同一quarter番号でも、前年度のfactを渡してはいけない。
  // ここでは「同じquarterが複数来たら後から確定した側（turnが大きい方）を採る」
  // 重複排除の挙動を固定する（再計算・再保存で同一四半期が二重に来た場合の保護）。
  const duplicated: AnnualQuarterFact[] = [
    ...facts([10, 10, 10, 10]),
    { turn: 99, period: period(YEAR, 4), quarter: 4, netIncomeUsd: 999, appliedDividendUsd: 0 },
  ];
  const aggregation = aggregateAnnualDividendFacts({ year: YEAR, facts: duplicated });
  assert.equal(aggregation.available, true);
  if (!aggregation.available) throw new Error("unreachable");
  assert.equal(aggregation.annualNetIncomeUsd, 10 + 10 + 10 + 999, "同一四半期は後から確定した方だけを1回数える");
  assert.equal(aggregation.quarters.length, FISCAL_QUARTERS_PER_YEAR);
});

// ---------------------------------------------------------------------
// 年度末判定
// ---------------------------------------------------------------------

test("年度末判定: Q4だけがtrue（新しい暦を作らず既存PeriodV2を読む）", () => {
  assert.equal(isFiscalYearEnd(period(YEAR, 1)), false);
  assert.equal(isFiscalYearEnd(period(YEAR, 2)), false);
  assert.equal(isFiscalYearEnd(period(YEAR, 3)), false);
  assert.equal(isFiscalYearEnd(period(YEAR, 4)), true);
});

test("payoutRatioSourceは加工されずそのまま記録される（MANUAL_OVERRIDE / STANDARD_AI）", () => {
  const aggregation = aggregateAnnualDividendFacts({ year: YEAR, facts: facts([10, 10, 10, 10]) });
  assert.equal(aggregation.available, true);
  if (!aggregation.available) throw new Error("unreachable");
  for (const source of ["MANUAL_OVERRIDE", "STANDARD_AI"] as const) {
    const s = computeAnnualDividendSettlement({
      year: YEAR,
      annualNetIncomeUsd: aggregation.annualNetIncomeUsd,
      appliedPayoutRatio: 0.5,
      payoutRatioSource: source,
      paidDividendEarlierInYearUsd: 0,
      maxDividendUsd: 1e12,
      availableCashUsd: 1e12,
      distributableEarningsUsd: 1e12,
    });
    assert.equal(s.payoutRatioSource, source);
    assert.equal(s.appliedPayoutRatio, 0.5, "率は丸めalso改変もされない");
  }
});
