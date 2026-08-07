// ShrimpX V2 — 資金繰り診断: 通常融資の申請→承認→実行の全経路トレース
//
// 【目的】「通常審査を通った借入が一度も実行されない」現象の直接原因を特定する。
// 仮説を置かず、申請額・信用区分・借入余力の各上限・拘束条件・承認額・
// 実行額・緊急融資額を、実データで1社×1四半期ごとに出す。
//
// 【本スクリプトは診断専用】ゲームの挙動は一切変更しない。
//
// 使い方: npx tsx scripts/financingCreditDiagnosis.ts [--seeds N] [--turns N] [--csv]

import { CompanyId } from "../app/lib/v2/sales/types";
import { CompanyLabConfig } from "../app/lib/v2/companyLab/types";
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
import { unwrapUsd } from "../app/lib/v2/finance/types";
import { FINANCING_PARAMETERS_V1 } from "../app/lib/v2/financing/parameters";

const argOf = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};

const SEED_COUNT = argOf("--seeds", 3);
const TURNS = argOf("--turns", 8);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => `sai3a-grid-${String(i + 1).padStart(3, "0")}`);
const BASE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

export interface TraceRow {
  readonly seed: string;
  readonly companyId: CompanyId;
  readonly turn: number;
  // --- 申請 ---
  readonly requestedUsd: number;
  // --- 会社状態 ---
  readonly cashUsd: number;
  readonly receivablesUsd: number;
  readonly rawMaterialAvailableUsd: number;
  readonly rawMaterialInTransitUsd: number;
  readonly finishedGoodsUsd: number;
  /** 当期B/Sの原料在庫（利用可能+輸送中の合算。finance/BalanceSheetは分離を持たない）。参考値。 */
  readonly rawMaterialInventoryBsUsd: number;
  /** 当期B/Sの完成品在庫。参考値（引受は前期末値を使うため、前期行の値が引受時の実値に対応する）。 */
  readonly finishedGoodsInventoryBsUsd: number;
  readonly shortTermLoansUsd: number;
  readonly longTermLoansUsd: number;
  readonly totalEquityUsd: number;
  readonly ebitdaLikeUsd: number;
  // --- 信用 ---
  readonly creditTier: string;
  readonly creditScore: number;
  // --- 借入余力の内訳 ---
  readonly collateralBasedLimitUsd: number;
  /** computeBorrowingCapacity に実際に渡された ebitdaLikeQuarterlyUsd（前期営業利益＋前期減価償却）。 */
  readonly ebitdaLikeUsedForUnderwritingUsd: number;
  readonly earningsBasedLimitUsd: number;
  readonly creditTierCapUsd: number;
  readonly grossLimitUsd: number;
  readonly existingLoanBalanceUsd: number;
  readonly availableAdditionalCapacityUsd: number;
  readonly underwritingFrozen: boolean;
  readonly bindingConstraint: string;
  // --- 審査結果 ---
  readonly approvedUsd: number;
  readonly deniedUsd: number;
  readonly underwritingReasons: string;
  // --- 実行 ---
  readonly loanDrawUsd: number;
  readonly emergencyDrawUsd: number;
  readonly principalPaidCashUsd: number;
  readonly endingShortTermLoansUsd: number;
  readonly endingLongTermLoansUsd: number;
  // --- 健全性 ---
  readonly covenantBreach: boolean;
  readonly financialHealth: string;
  readonly paymentDefault: boolean;
}

/**
 * 【7時点トレース用】1行から、三宅さんが要求した7つの時点値を導出する。
 *
 * 設計上の事実（liquidityClose.ts:96-159 で確認済み）:
 *   planQuarterFinancing は prevFinanceState / prevFinancingState のみを受け取り、
 *   当期の実績（turnResult）は関数シグネチャ上そもそも渡せない。
 *   existingLoanBalance = fin.loanPortfolio.loans の元本合計（= 前期末時点の残高）。
 *   引受（underwriting）はこの「前期末残高」を「期首時点の残高」としてそのまま使う。
 *   つまり(1)前期末残高と(2)引受時点残高は、設計上ビットレベルで同一の値である
 *   （別々に動きうる2つの値ではなく、「前期末=期首」という単一の事実を指す）。
 *   このスクリプトが今期の元金返済(principalPaidCashUsd)を「引受後」に計上するため、
 *   (3)返済前残高も同じく(1)(2)と同一である。
 */
export interface SevenPointTrace {
  readonly turn: number;
  /** (1) 前期末時点のST+LT残高 */
  readonly priorQuarterEndBalanceUsd: number;
  /** (2) 今期の引受(underwriting)時点でexistingLoanBalanceとして実際に渡された値 */
  readonly underwritingTimeBalanceUsd: number;
  /** (3) 今期の元金返済が行われる前の残高（設計上、引受は返済前に行われるため(2)と同値） */
  readonly preRepaymentBalanceUsd: number;
  /** (4) 今期実行された通常融資額 */
  readonly normalLoanDrawUsd: number;
  /** (5) 今期実行された緊急融資額 */
  readonly emergencyLoanDrawUsd: number;
  /** (6) 今期の元金返済額 */
  readonly principalRepaidUsd: number;
  /** (7) 今期末時点のST+LT残高 */
  readonly quarterEndBalanceUsd: number;
}

export function toSevenPointTrace(rows: readonly TraceRow[]): readonly SevenPointTrace[] {
  const sorted = [...rows].sort((a, b) => a.turn - b.turn);
  return sorted.map((r) => ({
    turn: r.turn,
    priorQuarterEndBalanceUsd: r.existingLoanBalanceUsd,
    underwritingTimeBalanceUsd: r.existingLoanBalanceUsd,
    preRepaymentBalanceUsd: r.existingLoanBalanceUsd,
    normalLoanDrawUsd: r.loanDrawUsd,
    emergencyLoanDrawUsd: r.emergencyDrawUsd,
    principalRepaidUsd: r.principalPaidCashUsd,
    quarterEndBalanceUsd: r.endingShortTermLoansUsd + r.endingLongTermLoansUsd,
  }));
}

/**
 * 【Phase A grid の再現用】初期財務фикスチャの上書き。
 *
 * 重要: shortTermLoans / longTermLoans は「借入枠」ではなく**既存の借入残高**である
 * （financing/initialPortfolio.ts が1対1でLoanRecordへ写し、
 *  borrowingCapacity の existingLoanBalance になる）。したがってこれを増やすと
 * 追加借入可能額 = max(0, grossLimit − existingLoanBalance) は**減る**。
 */
export interface FinanceFixtureOverride {
  readonly label: string;
  readonly cash?: number;
  readonly shortTermLoans?: number;
  readonly longTermLoans?: number;
}

export function collectTrace(seed: string, override?: FinanceFixtureOverride): readonly TraceRow[] {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns: TURNS };
  const financeTemplate = override
    ? {
        ...BASE.financeFixtureTemplate,
        ...(override.cash !== undefined ? { cash: override.cash } : {}),
        ...(override.shortTermLoans !== undefined ? { shortTermLoans: override.shortTermLoans } : {}),
        ...(override.longTermLoans !== undefined ? { longTermLoans: override.longTermLoans } : {}),
      }
    : BASE.financeFixtureTemplate;
  const initResult = initializeUnifiedCompanyLabFromTemplate(
    config,
    BASE.buildFixtureTemplate,
    financeTemplate,
    BASE.contractDefs,
    ALL_COMPANY_IDS
  );
  const result = runFromInit(initResult, generateStandardAiDecision);

  const rows: TraceRow[] = [];
  for (const record of result.history) {
    for (const companyId of ALL_COMPANY_IDS) {
      const fcg = record.financingResults.find((f) => f.companyId === companyId);
      const fin = record.financialResults.find((f) => f.companyId === companyId);
      if (!fcg || !fin) continue;
      const cap = fcg.borrowingCapacity;
      const uw = fcg.underwriting;
      const limitOf = (name: string) => cap.constraints.find((c) => c.name === name)?.limitUsd ?? 0;
      rows.push({
        seed,
        companyId,
        turn: record.turn,
        requestedUsd: uw.requestedAmountUsd,
        cashUsd: unwrapUsd(fin.balanceSheet.cash),
        receivablesUsd: unwrapUsd(fin.balanceSheet.accountsReceivable),
        rawMaterialAvailableUsd: 0,
        rawMaterialInTransitUsd: 0,
        finishedGoodsUsd: 0,
        rawMaterialInventoryBsUsd: unwrapUsd(fin.balanceSheet.rawMaterialInventory),
        finishedGoodsInventoryBsUsd: unwrapUsd(fin.balanceSheet.finishedGoodsInventory),
        shortTermLoansUsd: unwrapUsd(fin.balanceSheet.shortTermLoans),
        longTermLoansUsd: unwrapUsd(fin.balanceSheet.longTermLoans),
        totalEquityUsd: unwrapUsd(fin.balanceSheet.totalEquity),
        ebitdaLikeUsd: unwrapUsd(fin.profitAndLoss.operatingProfit),
        creditTier: fcg.creditScore.tier,
        creditScore: fcg.creditScore.score0to100,
        collateralBasedLimitUsd: cap.collateralBasedLimitUsd,
        // earningsBasedLimitUsd = ebitdaLikeQuarterlyUsd(前期営業利益+前期減価償却) × earningsMultiple
        // (borrowingCapacity.ts:53) なので、実際に渡されたebitdaLikeは逆算で復元できる
        // （BorrowingCapacityResultはebitdaLikeそのものを公開していないため）。
        ebitdaLikeUsedForUnderwritingUsd: cap.earningsBasedLimitUsd / FINANCING_PARAMETERS_V1.borrowingCapacity.earningsMultiple,
        earningsBasedLimitUsd: cap.earningsBasedLimitUsd,
        creditTierCapUsd: cap.creditTierCapUsd,
        grossLimitUsd: cap.grossLimitUsd,
        existingLoanBalanceUsd: limitOf("existingLoanBalance"),
        availableAdditionalCapacityUsd: cap.availableAdditionalCapacityUsd,
        underwritingFrozen: cap.underwritingFrozen,
        bindingConstraint: cap.bindingConstraint,
        approvedUsd: uw.approvedAmountUsd,
        deniedUsd: uw.deniedAmountUsd,
        underwritingReasons: uw.reasons.join(" / "),
        loanDrawUsd: fcg.loanDrawUsd,
        emergencyDrawUsd: fcg.emergencyLoan ? fcg.emergencyLoan.approvedUsd : 0,
        principalPaidCashUsd: fcg.principalPaidCashUsd,
        endingShortTermLoansUsd: fcg.endingShortTermLoansUsd,
        endingLongTermLoansUsd: fcg.endingLongTermLoansUsd,
        covenantBreach: fcg.covenant.anyBreach,
        financialHealth: fcg.financialHealth.primary,
        paymentDefault: fcg.financialHealth.paymentDefault,
      });
    }
  }
  return rows;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Phase A grid の各点が使っていた初期財務条件（既存借入残高が主軸）。 */
export const GRID_VARIANTS: readonly FinanceFixtureOverride[] = [
  { label: "BASE(=P0-current) 現金20M 債務57M", cash: 20_000_000, shortTermLoans: 24_000_000, longTermLoans: 33_000_000 },
  { label: "P3/P4      現金35M 債務70M", cash: 35_000_000, shortTermLoans: 30_000_000, longTermLoans: 40_000_000 },
  { label: "R1〜R6     現金42M 債務84M", cash: 42_000_000, shortTermLoans: 36_000_000, longTermLoans: 48_000_000 },
  { label: "P5/P6/P7   現金60M 債務95M", cash: 60_000_000, shortTermLoans: 40_000_000, longTermLoans: 55_000_000 },
  { label: "【対照】現金60M・債務は据置57M", cash: 60_000_000, shortTermLoans: 24_000_000, longTermLoans: 33_000_000 },
  { label: "【対照】現金20M・債務を半減28M", cash: 20_000_000, shortTermLoans: 12_000_000, longTermLoans: 16_500_000 },
];

function summarize(rows: readonly TraceRow[]) {
  const applied = rows.filter((r) => r.requestedUsd > 0);
  const approved = rows.filter((r) => r.approvedUsd > 0);
  return {
    applied: applied.length,
    approved: approved.length,
    frozen: rows.filter((r) => r.underwritingFrozen).length,
    emergency: rows.filter((r) => r.emergencyDrawUsd > 0).length,
    defaults: rows.filter((r) => r.paymentDefault).length,
    approvedUsd: approved.reduce((s, r) => s + r.approvedUsd, 0),
    emergencyUsd: rows.reduce((s, r) => s + r.emergencyDrawUsd, 0),
    meanGrossLimit: rows.reduce((s, r) => s + r.grossLimitUsd, 0) / rows.length,
    meanExistingDebt: rows.reduce((s, r) => s + r.existingLoanBalanceUsd, 0) / rows.length,
  };
}

if (process.argv.includes("--variants")) {
  console.log(`=== 初期財務条件別の通常融資の承認状況（${SEEDS.length}シード × ${TURNS}四半期 × 5社）===`);
  console.log("【注】shortTermLoans/longTermLoans は借入枠ではなく既存借入残高である。\n");
  console.log("条件                              | 申請 | 承認 | 凍結 | 緊急 | 破綻 | 平均grossLimit | 平均既存債務 | 承認総額");
  console.log("----------------------------------|------|------|------|------|------|----------------|--------------|------------");
  for (const v of GRID_VARIANTS) {
    const rows: TraceRow[] = [];
    for (const seed of SEEDS) rows.push(...collectTrace(seed, v));
    const s = summarize(rows);
    console.log(
      `${v.label.padEnd(33)} | ${String(s.applied).padStart(4)} | ${String(s.approved).padStart(4)} | ${String(s.frozen).padStart(4)} | ` +
        `${String(s.emergency).padStart(4)} | ${String(s.defaults).padStart(4)} | ${fmt(s.meanGrossLimit).padStart(14)} | ` +
        `${fmt(s.meanExistingDebt).padStart(12)} | ${fmt(s.approvedUsd).padStart(10)}`
    );
  }
  process.exit(0);
}

/** --params 用に、代表3ケースのtraceを外側スコープへ引き渡す（手入力を避けるため）。 */
let sampleForParams: readonly TraceRow[] = [];

if (process.argv[1] && process.argv[1].endsWith("financingCreditDiagnosis.ts")) {
  const all: TraceRow[] = [];
  for (const seed of SEEDS) all.push(...collectTrace(seed));

  console.log(`=== 通常融資の申請→承認→実行トレース（${SEEDS.length}シード × ${TURNS}四半期 × 5社 = ${all.length}行）===\n`);

  const applied = all.filter((r) => r.requestedUsd > 0);
  const approved = all.filter((r) => r.approvedUsd > 0);
  const frozen = all.filter((r) => r.underwritingFrozen);
  const emergency = all.filter((r) => r.emergencyDrawUsd > 0);

  console.log("【集計】");
  console.log(`  申請あり（requested>0）      : ${applied.length} / ${all.length}`);
  console.log(`  承認あり（approved>0）      : ${approved.length} / ${all.length}`);
  console.log(`  審査凍結（frozen）          : ${frozen.length} / ${all.length}`);
  console.log(`  緊急融資実行                : ${emergency.length} / ${all.length}`);
  console.log(`  申請総額                    : ${fmt(applied.reduce((s, r) => s + r.requestedUsd, 0))} USD`);
  console.log(`  承認総額                    : ${fmt(approved.reduce((s, r) => s + r.approvedUsd, 0))} USD`);
  console.log(`  緊急融資総額                : ${fmt(emergency.reduce((s, r) => s + r.emergencyDrawUsd, 0))} USD`);

  console.log("\n【申請があったのに承認0だった行の、拘束条件の内訳】");
  const deniedRows = applied.filter((r) => r.approvedUsd <= 0);
  const byBinding = new Map<string, number>();
  for (const r of deniedRows) byBinding.set(r.bindingConstraint, (byBinding.get(r.bindingConstraint) ?? 0) + 1);
  for (const [k, v] of [...byBinding.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(22)}: ${v} 件`);
  }

  console.log("\n【申請があったのに承認0だった行の、信用区分の内訳】");
  const byTier = new Map<string, number>();
  for (const r of deniedRows) byTier.set(r.creditTier, (byTier.get(r.creditTier) ?? 0) + 1);
  for (const [k, v] of [...byTier.entries()].sort()) console.log(`  区分 ${k}: ${v} 件`);

  console.log("\n【turn別の申請・承認・凍結・緊急】");
  console.log("turn | 申請件数 | 承認件数 | 凍結件数 | 緊急件数 | 申請総額        | 承認総額 | 緊急総額");
  console.log("-----|----------|----------|----------|----------|-----------------|----------|----------------");
  for (let t = 1; t <= TURNS; t++) {
    const rows = all.filter((r) => r.turn === t);
    const a = rows.filter((r) => r.requestedUsd > 0);
    const ap = rows.filter((r) => r.approvedUsd > 0);
    const fz = rows.filter((r) => r.underwritingFrozen);
    const em = rows.filter((r) => r.emergencyDrawUsd > 0);
    console.log(
      `${String(t).padStart(4)} | ${String(a.length).padStart(8)} | ${String(ap.length).padStart(8)} | ${String(fz.length).padStart(8)} | ` +
        `${String(em.length).padStart(8)} | ${fmt(a.reduce((s, r) => s + r.requestedUsd, 0)).padStart(15)} | ` +
        `${fmt(ap.reduce((s, r) => s + r.approvedUsd, 0)).padStart(8)} | ${fmt(em.reduce((s, r) => s + r.emergencyDrawUsd, 0)).padStart(14)}`
    );
  }

  console.log("\n【代表3ケースの詳細トレース（seed1・BAL）】");
  const sample = all.filter((r) => r.seed === SEEDS[0] && r.companyId === "BAL");
  sampleForParams = sample;
  for (const r of sample) {
    console.log(
      `\n--- turn ${r.turn} (${r.financialHealth}${r.paymentDefault ? "・支払不能" : ""}) ---\n` +
        `  申請額              : ${fmt(r.requestedUsd)}\n` +
        `  現金                : ${fmt(r.cashUsd)}\n` +
        `  売掛金              : ${fmt(r.receivablesUsd)}\n` +
        `  短期借入 / 長期借入 (当期B/S) : ${fmt(r.shortTermLoansUsd)} / ${fmt(r.longTermLoansUsd)}\n` +
        `  純資産              : ${fmt(r.totalEquityUsd)}\n` +
        `  営業利益(当期・参考) : ${fmt(r.ebitdaLikeUsd)}\n` +
        `  引受で実際に使われたEBITDA代理(前期営業利益+前期減価償却) : ${fmt(r.ebitdaLikeUsedForUnderwritingUsd)}\n` +
        `  信用区分 / スコア    : ${r.creditTier} / ${r.creditScore.toFixed(1)}\n` +
        `  担保ベース上限       : ${fmt(r.collateralBasedLimitUsd)}\n` +
        `  収益ベース上限       : ${fmt(r.earningsBasedLimitUsd)}\n` +
        `  信用区分×自己資本上限 : ${fmt(r.creditTierCapUsd)}\n` +
        `  → grossLimit        : ${fmt(r.grossLimitUsd)}\n` +
        `  既存借入残高(引受時=前期末) : ${fmt(r.existingLoanBalanceUsd)}\n` +
        `  → 追加借入可能額     : ${fmt(r.availableAdditionalCapacityUsd)}  (frozen=${r.underwritingFrozen}, binding=${r.bindingConstraint})\n` +
        `  承認額 / 否決額      : ${fmt(r.approvedUsd)} / ${fmt(r.deniedUsd)}\n` +
        `  審査理由            : ${r.underwritingReasons}\n` +
        `  実行(通常/緊急)      : ${fmt(r.loanDrawUsd)} / ${fmt(r.emergencyDrawUsd)}\n` +
        `  今期元金返済額       : ${fmt(r.principalPaidCashUsd)}\n` +
        `  期末短期/長期借入    : ${fmt(r.endingShortTermLoansUsd)} / ${fmt(r.endingLongTermLoansUsd)}\n` +
        `  財務制限条項違反     : ${r.covenantBreach}`
    );
  }

  console.log("\n【7時点トレース（seed1・BAL）— 三宅さん指定の7列】");
  console.log(
    "turn | (1)前期末残高    | (2)引受時渡引数残高 | (3)返済前残高    | (4)通常融資実行 | (5)緊急融資実行 | (6)元金返済    | (7)当期末残高"
  );
  console.log(
    "-----|------------------|----------------------|------------------|------------------|------------------|-----------------|------------------"
  );
  for (const s of toSevenPointTrace(sample)) {
    console.log(
      `${String(s.turn).padStart(4)} | ${fmt(s.priorQuarterEndBalanceUsd).padStart(16)} | ${fmt(s.underwritingTimeBalanceUsd).padStart(20)} | ` +
        `${fmt(s.preRepaymentBalanceUsd).padStart(16)} | ${fmt(s.normalLoanDrawUsd).padStart(16)} | ${fmt(s.emergencyLoanDrawUsd).padStart(16)} | ` +
        `${fmt(s.principalRepaidUsd).padStart(15)} | ${fmt(s.quarterEndBalanceUsd).padStart(16)}`
    );
  }
  console.log(
    "\n【注】(1)(2)(3)が全turnで同一値になっているのは表の誤りではない。planQuarterFinancing(liquidityClose.ts:96-159)は\n" +
      "prevFinanceState/prevFinancingStateのみを受け取り、当期の実績(turnResult)は関数シグネチャ上そもそも渡せない設計。\n" +
      "existingLoanBalance = fin.loanPortfolio.loans の元本合計 = 前期末残高、そのままunderwritingへ渡され、\n" +
      "かつ元金返済(principalPaidCash)は引受確定後に発生するため、(1)=(2)=(3)は「別々の値がたまたま一致」ではなく、\n" +
      "設計上単一の値である。turn(N)の(7)当期末残高 は turn(N+1)の(1)(2)(3)と一致する（例: turn4の(7)=52,050,000 = turn5の(1)(2)(3)）。"
  );

  if (process.argv.includes("--csv")) {
    const keys = Object.keys(all[0]) as (keyof TraceRow)[];
    console.log("\n=== CSV ===");
    console.log(keys.join(","));
    for (const r of all) console.log(keys.map((k) => String(r[k]).replace(/,/g, ";")).join(","));
  }
}

// ---------------------------------------------------------------------
// パラメータ候補の比較（**採用しない**。数値を出すだけ）
// ---------------------------------------------------------------------

import { FinancingParameters } from "../app/lib/v2/financing/parameters";
import { computeBorrowingCapacity } from "../app/lib/v2/financing/borrowingCapacity";

/**
 * 【前回報告からの是正】REPRESENTATIVE_STATESは前回、トレース出力を目視して手入力した
 * 推測値だった（ebitdaQ=3,400,000等）。これが実際に引受(underwriting)へ渡された値と
 * 一致しない — 三宅さんが指摘した候補1矛盾（手計算で約4,570万USDになるはずが
 * スクリプトは0を出力）の主因（原因(c)）である。今回は同じ1回のライブ実行(`all`)から
 * 直接組み立て、手入力を一切行わない。
 *
 * 担保の内訳（原料在庫・完成品在庫）は、引受が「期首時点＝前四半期末の値」を使う設計
 * （financing/companyLabAdapter.ts:6-12のコメント参照）に合わせ、対象turnの1つ前の行の
 * B/S値を使う。turn1のみ「1つ前」が存在しない（シミュレーション開始時点の初期状態）ため、
 * turn1自身の行の値で近似する（=既知の近似。原料在庫の輸送中(inTransit)分はこの
 * ベースラインfixtureでは初期ロットが全てavailableのため0と仮定）。
 */
function buildRepresentativeStateFromTrace(rows: readonly TraceRow[], turn: number, label: string) {
  const row = rows.find((r) => r.turn === turn);
  if (!row) throw new Error(`turn ${turn} の行が見つからない`);
  const priorRow = rows.find((r) => r.turn === turn - 1);
  const collateralSourceRow = priorRow ?? row; // turn1は自行で近似（上記コメント参照）
  return {
    label: `${label}（turn${turn}実測、担保はturn${priorRow ? turn - 1 : turn}のB/Sを使用${priorRow ? "" : "=近似"}）`,
    receivables: collateralSourceRow.receivablesUsd,
    rawAvail: collateralSourceRow.rawMaterialInventoryBsUsd,
    rawTransit: 0,
    fg: collateralSourceRow.finishedGoodsInventoryBsUsd,
    ebitdaQ: row.ebitdaLikeUsedForUnderwritingUsd,
    equity: row.totalEquityUsd,
    debt: row.existingLoanBalanceUsd,
    tier: row.creditTier as "A" | "B" | "C" | "D" | "E",
    // 検算用: このstateから現行パラメータで再計算したavailableAdditionalCapacityUsdが
    // 実際のトレース行のavailableAdditionalCapacityUsdと一致するはずである。
    referenceAvailableUsd: row.availableAdditionalCapacityUsd,
    referenceGrossLimitUsd: row.grossLimitUsd,
  };
}

function capacityUnder(params: FinancingParameters, s: ReturnType<typeof buildRepresentativeStateFromTrace>) {
  return computeBorrowingCapacity(
    {
      companyId: "BAL",
      period: "2026-Q1" as never,
      collateral: { receivablesUsd: s.receivables, rawMaterialAvailableUsd: s.rawAvail, rawMaterialInTransitUsd: s.rawTransit, finishedGoodsUsd: s.fg },
      ebitdaLikeQuarterlyUsd: s.ebitdaQ,
      totalEquityUsd: s.equity,
      existingLoanBalanceUsd: s.debt,
      creditTier: s.tier,
      severeArrears: false,
      insolvent: false,
    },
    params
  );
}

if (process.argv.includes("--params")) {
  const REPRESENTATIVE_STATES = [
    buildRepresentativeStateFromTrace(sampleForParams, 1, "turn1 健全(初期)"),
    buildRepresentativeStateFromTrace(sampleForParams, 3, "turn3 健全(現金悪化)"),
    buildRepresentativeStateFromTrace(sampleForParams, 5, "turn5 緊急融資発動"),
  ];

  console.log("\n=== 検算: 上のREPRESENTATIVE_STATESを現行パラメータで再計算し、実トレース行と一致するか確認 ===");
  for (const s of REPRESENTATIVE_STATES) {
    const r = capacityUnder(FINANCING_PARAMETERS_V1, s);
    const matchGross = Math.abs(r.grossLimitUsd - s.referenceGrossLimitUsd) < 1;
    const matchAvail = Math.abs(r.availableAdditionalCapacityUsd - s.referenceAvailableUsd) < 1;
    console.log(
      `  ${s.label} : grossLimit再計算=${fmt(r.grossLimitUsd)} 実測=${fmt(s.referenceGrossLimitUsd)} [${matchGross ? "一致" : "不一致"}] / ` +
        `available再計算=${fmt(r.availableAdditionalCapacityUsd)} 実測=${fmt(s.referenceAvailableUsd)} [${matchAvail ? "一致" : "不一致"}]`
    );
  }

  const base = FINANCING_PARAMETERS_V1;
  const candidates: { readonly label: string; readonly params: FinancingParameters }[] = [
    { label: "現行", params: base },
    {
      label: "候補1 earningsMultiple 2.0→8.0(=年間EBITDA×2)",
      params: { ...base, borrowingCapacity: { ...base.borrowingCapacity, earningsMultiple: 8.0 } },
    },
    {
      label: "候補2 掛目引上げ(売掛0.7→0.85/原料0.4→0.55/製品0.3→0.45)",
      params: {
        ...base,
        borrowingCapacity: { ...base.borrowingCapacity, receivablesHaircut: 0.85, rawMaterialInventoryHaircut: 0.55, finishedGoodsInventoryHaircut: 0.45 },
      },
    },
    {
      label: "候補3 候補1と候補2の併用",
      params: {
        ...base,
        borrowingCapacity: {
          ...base.borrowingCapacity,
          earningsMultiple: 8.0,
          receivablesHaircut: 0.85,
          rawMaterialInventoryHaircut: 0.55,
          finishedGoodsInventoryHaircut: 0.45,
        },
      },
    },
  ];

  console.log("=== 借入余力のパラメータ候補比較（**いずれも採用しない**。数値の提示のみ）===");
  console.log("【注】候補4（初期債務の引下げ）はパラメータではなく標準初期条件fixtureの変更なので別枠。\n");
  for (const s of REPRESENTATIVE_STATES) {
    console.log(`--- ${s.label}  （既存債務 ${fmt(s.debt)}）---`);
    console.log("  候補                                                  | 担保上限     | 収益上限     | 区分×資本上限 | grossLimit  | 追加借入可能額");
    console.log("  ------------------------------------------------------|--------------|--------------|---------------|-------------|---------------");
    for (const c of candidates) {
      const r = capacityUnder(c.params, s);
      console.log(
        `  ${c.label.padEnd(53)} | ${fmt(r.collateralBasedLimitUsd).padStart(12)} | ${fmt(r.earningsBasedLimitUsd).padStart(12)} | ` +
          `${fmt(r.creditTierCapUsd).padStart(13)} | ${fmt(r.grossLimitUsd).padStart(11)} | ${fmt(r.availableAdditionalCapacityUsd).padStart(13)}`
      );
    }
    console.log("");
  }

  // -------------------------------------------------------------------
  // 候補5: grossLimit = max(collateral, earnings, tierCap×w)
  // computeBorrowingCapacity自体は変更しない（本番コード不可触）ので、
  // 現行(base)パラメータでの担保上限・収益上限・区分×資本上限の3値を使い、
  // この診断スクリプト内だけで別式を計算する（採用しない。数値提示のみ）。
  // -------------------------------------------------------------------
  console.log("=== 候補5: grossLimit = max(collateral, earnings, tierCap×w)（**採用しない**。数値提示のみ）===");
  console.log("【注】現行式は grossLimit = min(max(collateral, earnings), tierCap)。候補5は自己資本を積極的に使う代替式。\n");
  const W_VALUES = [0.5, 0.75, 1.0];
  for (const s of REPRESENTATIVE_STATES) {
    const base_r = capacityUnder(base, s);
    console.log(`--- ${s.label}  （既存債務 ${fmt(s.debt)}）---`);
    console.log(
      `  担保上限=${fmt(base_r.collateralBasedLimitUsd)} 収益上限(現行倍率2.0)=${fmt(base_r.earningsBasedLimitUsd)} 区分×資本上限(tierCap)=${fmt(base_r.creditTierCapUsd)}`
    );
    console.log("  w    | tierCap×w      | grossLimit(候補5)  | 追加借入可能額(候補5)");
    console.log("  -----|----------------|--------------------|------------------------");
    for (const w of W_VALUES) {
      const tierCapW = base_r.creditTierCapUsd * w;
      const grossLimit5 = Math.max(base_r.collateralBasedLimitUsd, base_r.earningsBasedLimitUsd, tierCapW);
      const available5 = Math.max(0, grossLimit5 - s.debt);
      console.log(`  ${w.toFixed(2)} | ${fmt(tierCapW).padStart(14)} | ${fmt(grossLimit5).padStart(18)} | ${fmt(available5).padStart(22)}`);
    }
    console.log("");
  }

  console.log("=== 候補4: 標準初期条件の既存債務を下げた場合（fixture変更・上の --variants 実測より）===");
  console.log("  既存債務 57,000,000（現行）: 3シード×8Q×5社で 申請105 / 承認44 / 緊急15 / 承認総額 264,175,616");
  console.log("  既存債務 28,500,000（半減）: 同条件で           申請 75 / 承認75 / 緊急 0 / 承認総額 391,543,766");
}
