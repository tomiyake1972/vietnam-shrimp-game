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
  readonly shortTermLoansUsd: number;
  readonly longTermLoansUsd: number;
  readonly totalEquityUsd: number;
  readonly ebitdaLikeUsd: number;
  // --- 信用 ---
  readonly creditTier: string;
  readonly creditScore: number;
  // --- 借入余力の内訳 ---
  readonly collateralBasedLimitUsd: number;
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
  readonly endingShortTermLoansUsd: number;
  readonly endingLongTermLoansUsd: number;
  // --- 健全性 ---
  readonly covenantBreach: boolean;
  readonly financialHealth: string;
  readonly paymentDefault: boolean;
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
        shortTermLoansUsd: unwrapUsd(fin.balanceSheet.shortTermLoans),
        longTermLoansUsd: unwrapUsd(fin.balanceSheet.longTermLoans),
        totalEquityUsd: unwrapUsd(fin.balanceSheet.totalEquity),
        ebitdaLikeUsd: unwrapUsd(fin.profitAndLoss.operatingProfit),
        creditTier: fcg.creditScore.tier,
        creditScore: fcg.creditScore.score0to100,
        collateralBasedLimitUsd: cap.collateralBasedLimitUsd,
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
  for (const r of sample) {
    console.log(
      `\n--- turn ${r.turn} (${r.financialHealth}${r.paymentDefault ? "・支払不能" : ""}) ---\n` +
        `  申請額              : ${fmt(r.requestedUsd)}\n` +
        `  現金                : ${fmt(r.cashUsd)}\n` +
        `  売掛金              : ${fmt(r.receivablesUsd)}\n` +
        `  短期借入 / 長期借入  : ${fmt(r.shortTermLoansUsd)} / ${fmt(r.longTermLoansUsd)}\n` +
        `  純資産              : ${fmt(r.totalEquityUsd)}\n` +
        `  営業利益(EBITDA代理) : ${fmt(r.ebitdaLikeUsd)}\n` +
        `  信用区分 / スコア    : ${r.creditTier} / ${r.creditScore.toFixed(1)}\n` +
        `  担保ベース上限       : ${fmt(r.collateralBasedLimitUsd)}\n` +
        `  収益ベース上限       : ${fmt(r.earningsBasedLimitUsd)}\n` +
        `  信用区分×自己資本上限 : ${fmt(r.creditTierCapUsd)}\n` +
        `  → grossLimit        : ${fmt(r.grossLimitUsd)}\n` +
        `  既存借入残高         : ${fmt(r.existingLoanBalanceUsd)}\n` +
        `  → 追加借入可能額     : ${fmt(r.availableAdditionalCapacityUsd)}  (frozen=${r.underwritingFrozen}, binding=${r.bindingConstraint})\n` +
        `  承認額 / 否決額      : ${fmt(r.approvedUsd)} / ${fmt(r.deniedUsd)}\n` +
        `  審査理由            : ${r.underwritingReasons}\n` +
        `  実行(通常/緊急)      : ${fmt(r.loanDrawUsd)} / ${fmt(r.emergencyDrawUsd)}\n` +
        `  期末短期/長期借入    : ${fmt(r.endingShortTermLoansUsd)} / ${fmt(r.endingLongTermLoansUsd)}\n` +
        `  財務制限条項違反     : ${r.covenantBreach}`
    );
  }

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

import { FINANCING_PARAMETERS_V1, FinancingParameters } from "../app/lib/v2/financing/parameters";
import { computeBorrowingCapacity } from "../app/lib/v2/financing/borrowingCapacity";

/** 実データから採取した、代表的な会社状態（上のトレースの実測値）。 */
const REPRESENTATIVE_STATES = [
  { label: "turn1 健全(tier B・初期)", receivables: 45_600_000, rawAvail: 12_000_000, rawTransit: 0, fg: 1_500_000, ebitdaQ: 0, equity: 100_327_709, debt: 57_000_000, tier: "B" as const },
  { label: "turn3 健全(tier B・現金悪化)", receivables: 58_925_631, rawAvail: 14_000_000, rawTransit: 0, fg: 2_000_000, ebitdaQ: 3_400_000, equity: 109_030_429, debt: 53_700_000, tier: "B" as const },
  { label: "turn5 緊急融資発動(tier A)", receivables: 44_324_321, rawAvail: 13_000_000, rawTransit: 0, fg: 1_800_000, ebitdaQ: 4_200_000, equity: 111_511_931, debt: 50_400_000, tier: "A" as const },
];

function capacityUnder(params: FinancingParameters, s: (typeof REPRESENTATIVE_STATES)[number]) {
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

  console.log("=== 候補4: 標準初期条件の既存債務を下げた場合（fixture変更・上の --variants 実測より）===");
  console.log("  既存債務 57,000,000（現行）: 3シード×8Q×5社で 申請105 / 承認44 / 緊急15 / 承認総額 264,175,616");
  console.log("  既存債務 28,500,000（半減）: 同条件で           申請 75 / 承認75 / 緊急 0 / 承認総額 391,543,766");
}
