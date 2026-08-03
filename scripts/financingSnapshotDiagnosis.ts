// ShrimpX V2 — 資金繰り診断（同一時点スナップショット版・2026-08-03）
//
// 【背景】前回診断（scripts/financingCreditDiagnosis.ts）は、B/S行やExcel出力を
// 目視して手入力・手再構成した値で候補比較を行っていたため、三宅さんの手計算と
// 食い違う結果を出していた（候補1・turn3が誤って0）。
//
// 【このスクリプトの立場】computeBorrowingCapacity へ実際に渡された入力オブジェクトを
// （financing/liquidityClose.ts に追加した observation-only フック経由で）その場で
// そのまま捕捉し、それ以外の値（B/S表示・Excel出力・前turn行からの再構成）を
// 一切混ぜない。同一時点の値だけで候補計算を行う。
//
// 【観測フックの安全性】financing/liquidityClose.ts の
// setUnderwritingSnapshotObserver / setLoanRollForwardObserver は、
// オブザーバー未登録時（デフォルト）は既存コードと完全に同一の処理しか行わない。
// 本スクリプトが登録するコールバックは値を読み取るだけで、RNG消費・会社状態・
// 意思決定を一切変更しない（証明: __tests__/observationOnlyIntegrity.test.ts）。
//
// 使い方: npx tsx scripts/financingSnapshotDiagnosis.ts [--seeds N] [--turns N] [--stack develop|pdlabor]

import { CompanyId } from "../app/lib/v2/sales/types";
import { CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import { PeriodV2, periodToString } from "../app/lib/v2/core/period";
import {
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
  STANDARD_BASELINE_CANDIDATES,
} from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import {
  ALL_COMPANY_IDS,
  initializeUnifiedCompanyLabFromTemplate,
  runFromInit,
} from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";
import { generateStandardAiDecision } from "../app/lib/v2/companyLab/standardAi/policy";
import {
  setUnderwritingSnapshotObserver,
  setLoanRollForwardObserver,
  UnderwritingSnapshot,
  LoanRollForwardSnapshot,
} from "../app/lib/v2/financing/liquidityClose";
import { computeBorrowingCapacity, BorrowingCapacityInput } from "../app/lib/v2/financing/borrowingCapacity";
import { FINANCING_PARAMETERS_V1, FinancingParameters } from "../app/lib/v2/financing/parameters";

const argOf = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const SEED_COUNT = argOf("--seeds", 3);
const TURNS = argOf("--turns", 8);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => `sai3a-grid-${String(i + 1).padStart(3, "0")}`);
const BASE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// ---------------------------------------------------------------------
// 1. 同一時点スナップショットの捕捉
// ---------------------------------------------------------------------

/** 1社×1turnぶんの「与信スナップショット」と「ローン残高ロールフォワード」を1つに束ねたもの。 */
export interface CombinedSnapshot {
  readonly seed: string;
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly periodKey: string;
  readonly turn: number;
  readonly underwriting: UnderwritingSnapshot;
  readonly rollForward: LoanRollForwardSnapshot;
}

/**
 * 1回のシミュレーション実行から、observation-onlyフック経由で
 * 与信スナップショット・ロールフォワードスナップショットをそのまま捕捉し、
 * companyId×period で1対1に結合する。
 *
 * 【同一時点の保証】liquidityClose.tsの実装事実（コメント参照）により、
 * planQuarterFinancing と closeQuarterWithFinancing は同一ターン内で
 * companyLab/runner.tsから同一の prevFinancingState 参照を渡されて呼ばれる
 * （runner.ts:867,1238、どちらも同一の state.financingState.companies から
 * 同一ターン内で再取得。両呼び出しの間でこの配列は変更されない）。
 * したがって companyId×period でのjoinは、同一の引受判断・同一の残高遷移を
 * 指す1対1対応になる。
 */
export function collectSnapshots(seed: string): readonly CombinedSnapshot[] {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns: TURNS };

  const underwritingSnapshots: UnderwritingSnapshot[] = [];
  const rollForwardSnapshots: LoanRollForwardSnapshot[] = [];
  setUnderwritingSnapshotObserver((s) => underwritingSnapshots.push(s));
  setLoanRollForwardObserver((s) => rollForwardSnapshots.push(s));
  try {
    const initResult = initializeUnifiedCompanyLabFromTemplate(
      config,
      BASE.buildFixtureTemplate,
      BASE.financeFixtureTemplate,
      BASE.contractDefs,
      ALL_COMPANY_IDS
    );
    runFromInit(initResult, generateStandardAiDecision);
  } finally {
    // 【必須】他のスクリプト・テストへ副作用を残さないよう、実行後に必ず解除する。
    setUnderwritingSnapshotObserver(undefined);
    setLoanRollForwardObserver(undefined);
  }

  const uwByKey = new Map<string, UnderwritingSnapshot>();
  for (const s of underwritingSnapshots) uwByKey.set(`${s.companyId}|${periodToString(s.period)}`, s);

  const combined: CombinedSnapshot[] = [];
  for (const rf of rollForwardSnapshots) {
    const key = `${rf.companyId}|${periodToString(rf.period)}`;
    const uw = uwByKey.get(key);
    if (!uw) continue; // 与信判断が行われなかった行（理論上は発生しないはずだが、防御的にスキップ）
    combined.push({ seed, companyId: rf.companyId, period: rf.period, periodKey: key, turn: 0, underwriting: uw, rollForward: rf });
  }
  // turn番号を、company別にperiod昇順で振り直す（表示用。判定ロジックには使わない）。
  const byCompany = new Map<CompanyId, CombinedSnapshot[]>();
  for (const c of combined) {
    if (!byCompany.has(c.companyId)) byCompany.set(c.companyId, []);
    byCompany.get(c.companyId)!.push(c);
  }
  const withTurn: CombinedSnapshot[] = [];
  for (const rows of byCompany.values()) {
    rows.sort((a, b) => periodToString(a.period).localeCompare(periodToString(b.period)));
    rows.forEach((r, i) => withTurn.push({ ...r, turn: i + 1 }));
  }
  return withTurn;
}

// ---------------------------------------------------------------------
// 2. 同一時点検証: 現行パラメータでスナップショットから再計算し、
//    実行結果（borrowingCapacityResult）と完全一致することを確認する。
// ---------------------------------------------------------------------

export interface ReconciliationResult {
  readonly matches: boolean;
  readonly mismatches: readonly string[];
}

const EPS = 1e-6;
function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));
}

export function reconcile(snapshot: CombinedSnapshot, params: FinancingParameters = FINANCING_PARAMETERS_V1): ReconciliationResult {
  const recomputed = computeBorrowingCapacity(snapshot.underwriting.borrowingCapacityInput, params);
  const actual = snapshot.underwriting.borrowingCapacityResult;
  const mismatches: string[] = [];
  const fields: (keyof typeof actual)[] = [
    "collateralBasedLimitUsd",
    "earningsBasedLimitUsd",
    "creditTierCapUsd",
    "grossLimitUsd",
    "existingLoanBalanceUsd",
    "availableAdditionalCapacityUsd",
    "underwritingFrozen",
    "bindingConstraint",
  ];
  for (const f of fields) {
    const rv = recomputed[f];
    const av = actual[f];
    const eq = typeof rv === "number" && typeof av === "number" ? approxEq(rv, av) : rv === av;
    if (!eq) mismatches.push(`${f}: recomputed=${rv} actual=${av}`);
  }
  return { matches: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------
// 3. 用語の統一
//    grossLimit = min(max(collateral, earnings), tierCap) はmax()なので、
//    「collateral > earnings」は「担保上限を基準として採用した」であって
//    「担保が絞っている」ではない。「拘束条件(binding constraint)」という
//    語は、実際に上限を縮める側（tierCap、または既存債務控除）にのみ使う。
// ---------------------------------------------------------------------

export function describeGrossLimitBasis(r: { collateralBasedLimitUsd: number; earningsBasedLimitUsd: number; grossLimitUsd: number; creditTierCapUsd: number }): string {
  const assetOrEarnings = Math.max(r.collateralBasedLimitUsd, r.earningsBasedLimitUsd);
  const basis = r.collateralBasedLimitUsd >= r.earningsBasedLimitUsd ? "担保ベース値" : "収益ベース値";
  const tierCapBinding = r.creditTierCapUsd <= assetOrEarnings + 1;
  return tierCapBinding
    ? `grossLimitの基準として${basis}が選ばれたが、実際に絞っているのは区分×資本上限(tierCap)である`
    : `grossLimitの基準として${basis}が選ばれ、tierCapはそれを絞っていない（assetOrEarnings <= tierCap）`;
}

if (process.argv[1] && process.argv[1].endsWith("financingSnapshotDiagnosis.ts") && !process.argv.includes("--no-main")) {
  const all: CombinedSnapshot[] = [];
  for (const seed of SEEDS) all.push(...collectSnapshots(seed));

  console.log(`=== 同一時点スナップショット捕捉（${SEEDS.length}シード × ${TURNS}四半期 × 5社 = ${all.length}行）===\n`);

  console.log("【同一時点検証: 現行パラメータで再計算し、実行結果と完全一致するか】");
  let allMatch = true;
  for (const s of all) {
    const r = reconcile(s);
    if (!r.matches) {
      allMatch = false;
      console.log(`  不一致: ${s.seed} ${s.companyId} turn${s.turn}: ${r.mismatches.join(", ")}`);
    }
  }
  console.log(allMatch ? `  全${all.length}行で完全一致（floating-point許容誤差内）。` : "  上記の不一致あり。");

  console.log("\n【代表ケースの選定】");
  const findA = all.find(
    (s) => !s.underwriting.borrowingCapacityResult.underwritingFrozen && !s.underwriting.borrowingCapacityInput.insolvent && !s.underwriting.borrowingCapacityInput.severeArrears && s.underwriting.borrowingCapacityResult.availableAdditionalCapacityUsd < 1
  );
  const findB = all.find((s) => s.rollForward.priorTotalLoanBalanceUsd - s.rollForward.endingTotalLoanBalanceUsd > 10_000_000);
  const findC = all.find((s) => s.rollForward.emergencyDrawUsd > 0 && s.rollForward.normalDrawUsd === 0);
  const findD = all.find((s) => s.underwriting.underwriting.approvedAmountUsd > 0 && s.underwriting.requestedAmountUsd > 0);

  const cases = [
    ["A(健全・余力ほぼ0)", findA],
    ["B(返済で残高が大きく変動)", findB],
    ["C(緊急融資発動)", findC],
    ["D(通常融資が承認される)", findD],
  ] as const;

  for (const [label, s] of cases) {
    if (!s) {
      console.log(`  ${label}: 条件に合致する行なし`);
      continue;
    }
    const cap = s.underwriting.borrowingCapacityResult;
    const rf = s.rollForward;
    console.log(
      `\n  --- ${label}: ${s.seed} ${s.companyId} turn${s.turn} (${periodToString(s.period)}) ---\n` +
        `    信用区分=${s.underwriting.creditScore.tier}\n` +
        `    担保上限=${fmt(cap.collateralBasedLimitUsd)} 収益上限=${fmt(cap.earningsBasedLimitUsd)} tierCap=${fmt(cap.creditTierCapUsd)}\n` +
        `    grossLimit=${fmt(cap.grossLimitUsd)}（${describeGrossLimitBasis(cap)}）\n` +
        `    既存残高(引受時)=${fmt(cap.existingLoanBalanceUsd)} 追加借入可能額=${fmt(cap.availableAdditionalCapacityUsd)} frozen=${cap.underwritingFrozen}\n` +
        `    申請額=${fmt(s.underwriting.requestedAmountUsd)} 承認額=${fmt(s.underwriting.underwriting.approvedAmountUsd)} 否決額=${fmt(s.underwriting.underwriting.deniedAmountUsd)}\n` +
        `    審査理由=${s.underwriting.underwriting.reasons.join(" / ")}\n` +
        `    --- 7点ロールフォワード ---\n` +
        `    (1)(2)(3)前期末=引受時=返済前: ST=${fmt(rf.priorShortTermLoansUsd)} LT=${fmt(rf.priorLongTermLoansUsd)} 計=${fmt(rf.priorTotalLoanBalanceUsd)}\n` +
        `    (4)通常融資実行=${fmt(rf.normalDrawUsd)}\n` +
        `    (5)緊急融資実行=${fmt(rf.emergencyDrawUsd)}\n` +
        `    合計実行額=${fmt(rf.totalLoanDrawUsd)}（内訳確認: 通常+緊急=${fmt(rf.normalDrawUsd + rf.emergencyDrawUsd)}）\n` +
        `    約定元本=${fmt(rf.scheduledPrincipalDueUsd)} 実際元本返済(6)=${fmt(rf.principalPaidCashUsd)} 約定利息=${fmt(rf.scheduledInterestDueUsd)} 実際利息支払=${fmt(rf.interestPaidCashUsd)}\n` +
        `    (7)当期末: ST=${fmt(rf.endingShortTermLoansUsd)} LT=${fmt(rf.endingLongTermLoansUsd)} 計=${fmt(rf.endingTotalLoanBalanceUsd)}\n` +
        `    検算: 前期末+通常+緊急-実際元本 = ${fmt(rf.priorTotalLoanBalanceUsd + rf.normalDrawUsd + rf.emergencyDrawUsd - rf.principalPaidCashUsd)} (当期末と一致すべき: ${fmt(rf.endingTotalLoanBalanceUsd)})`
    );
  }

  if (process.argv.includes("--candidates")) {
    printCandidateComparison(all);
  }
}

// ---------------------------------------------------------------------
// 4. 候補比較（同一スナップショットのみを使用。**いずれも採用しない**）
// ---------------------------------------------------------------------

function printCandidateComparison(all: readonly CombinedSnapshot[]) {
  const base = FINANCING_PARAMETERS_V1;
  const sample = all.filter((s) => s.seed === SEEDS[0] && s.companyId === "BAL" && [1, 3, 5].includes(s.turn));

  console.log("\n=== 候補2: earningsMultiple 比較（現行2.0 / 4.0 / 6.0 / 8.0）※同一スナップショットのみ使用 ===");
  for (const s of sample) {
    const input: BorrowingCapacityInput = s.underwriting.borrowingCapacityInput;
    console.log(`\n--- turn${s.turn}（既存債務 ${fmt(input.existingLoanBalanceUsd)}, EBITDA代理=${fmt(input.ebitdaLikeQuarterlyUsd)}）---`);
    for (const m of [2.0, 4.0, 6.0, 8.0]) {
      const params = { ...base, borrowingCapacity: { ...base.borrowingCapacity, earningsMultiple: m } };
      const r = computeBorrowingCapacity(input, params);
      console.log(
        `  mult=${m.toFixed(1)} | 担保=${fmt(r.collateralBasedLimitUsd)} 収益=${fmt(r.earningsBasedLimitUsd)} tierCap=${fmt(r.creditTierCapUsd)} ` +
          `grossLimit=${fmt(r.grossLimitUsd)} available=${fmt(r.availableAdditionalCapacityUsd)}`
      );
    }
  }

  console.log("\n=== 候補5: grossLimit=min(max(担保,収益,tierCap×w), tierCap) 比較（w=0.25/0.50/0.75/1.00）===");
  for (const s of sample) {
    const input = s.underwriting.borrowingCapacityInput;
    const r = computeBorrowingCapacity(input, base);
    console.log(`\n--- turn${s.turn}（既存債務 ${fmt(input.existingLoanBalanceUsd)}）---`);
    console.log(`  担保=${fmt(r.collateralBasedLimitUsd)} 収益=${fmt(r.earningsBasedLimitUsd)} tierCap=${fmt(r.creditTierCapUsd)}`);
    for (const w of [0.25, 0.5, 0.75, 1.0]) {
      const tierCapW = r.creditTierCapUsd * w;
      const maxResult = Math.max(r.collateralBasedLimitUsd, r.earningsBasedLimitUsd, tierCapW);
      const grossLimit5 = Math.min(maxResult, r.creditTierCapUsd); // 候補5はtierCapを外側minとして維持する
      const available5 = Math.max(0, grossLimit5 - input.existingLoanBalanceUsd);
      console.log(`  w=${w.toFixed(2)} | tierCap×w=${fmt(tierCapW)} max()=${fmt(maxResult)} grossLimit=${fmt(grossLimit5)} available=${fmt(available5)}`);
    }
  }
}
