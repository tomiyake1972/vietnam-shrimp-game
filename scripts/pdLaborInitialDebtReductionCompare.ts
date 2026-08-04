// ShrimpX V2 — 初期債務削減(候補1)を、develop/v2と同じ「本番再シミュレーション」
// 手法で48コミットスタック(PD係数1.8)上に適用した比較（三宅さん指示・2026-08-04 step4 Task C）
//
// 【方法論】financingCreditDiagnosis.tsのcollectTraceと同じ考え方——
// 初期fixtureのshortTermLoans/longTermLoansを実際に削減した上で、
// initializeUnifiedCompanyLabFromTemplateからrunFromInitまで8四半期分を
// turnごとに実際に再シミュレーションする（静的スナップショット再計算ではない）。
//
// 【本スクリプトは診断専用】financing/liquidityClose.tsのobservation-onlyフックを
// 使うのみで、ゲームの挙動は一切変更しない。標準初期条件のfixture自体は
// このスクリプトの実行中だけ一時的に変更した値を使うのであり、
// standardBaseline.tsの定義自体は変更しない。
//
// 【develop/v2・pd_laborの両方で実行可能】相対importのみを使用。
// pd_laborへは一時コピーして実行し、コミットしない（§13と同じ手順）。
//
// 使い方: npx tsx scripts/pdLaborInitialDebtReductionCompare.ts [--seeds N]

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
import {
  setUnderwritingSnapshotObserver,
  setLoanRollForwardObserver,
  UnderwritingSnapshot,
  LoanRollForwardSnapshot,
} from "../app/lib/v2/financing/liquidityClose";

const BASE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

const argOf = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const SEED_COUNT = argOf("--seeds", 3);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => `sai3a-grid-${String(i + 1).padStart(3, "0")}`);

interface Variant {
  readonly label: string;
  readonly pct: number;
}
const VARIANTS: readonly Variant[] = [
  { label: "0%（現行baseline）", pct: 0 },
  { label: "-20%", pct: 0.2 },
  { label: "-30%", pct: 0.3 },
  { label: "-40%", pct: 0.4 },
];

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

for (const v of VARIANTS) {
  const shortTermLoans = Math.round(BASE.financeFixtureTemplate.shortTermLoans * (1 - v.pct));
  const longTermLoans = Math.round(BASE.financeFixtureTemplate.longTermLoans * (1 - v.pct));
  const totalDebt = shortTermLoans + longTermLoans;

  const allUw: UnderwritingSnapshot[] = [];
  const allRf: LoanRollForwardSnapshot[] = [];
  let firstApprovalTurn: number | null = null;
  let anyDefault = false;
  let anyInsolvent = false;

  for (const seed of SEEDS) {
    const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns: 8 };
    const uw: UnderwritingSnapshot[] = [];
    const rf: LoanRollForwardSnapshot[] = [];
    setUnderwritingSnapshotObserver((s) => uw.push(s));
    setLoanRollForwardObserver((s) => rf.push(s));
    const financeTemplate = { ...BASE.financeFixtureTemplate, shortTermLoans, longTermLoans };
    const init = initializeUnifiedCompanyLabFromTemplate(config, BASE.buildFixtureTemplate, financeTemplate, BASE.contractDefs, ALL_COMPANY_IDS);
    const result = runFromInit(init, generateStandardAiDecision);
    setUnderwritingSnapshotObserver(undefined);
    setLoanRollForwardObserver(undefined);
    allUw.push(...uw);
    allRf.push(...rf);
    for (const rec of result.history) {
      for (const fin of rec.financialResults) {
        if (fin.negativeEquity) anyInsolvent = true;
      }
      for (const fr of rec.financingResults) {
        if (fr.financialHealth.paymentDefault) anyDefault = true;
      }
    }
  }

  const sortedPeriods = [...new Set(allUw.map((s) => String(s.period)))].sort();
  const periodToTurn = new Map(sortedPeriods.map((p, i) => [p, i + 1]));
  for (const s of allUw) {
    if (s.underwriting.approvedAmountUsd > 0) {
      const turn = periodToTurn.get(String(s.period))!;
      if (firstApprovalTurn === null || turn < firstApprovalTurn) firstApprovalTurn = turn;
    }
  }

  const totalEmergency = allRf.reduce((s, r) => s + r.emergencyDrawUsd, 0);
  const zeroCapacityRows = allUw.filter((s) => s.borrowingCapacityResult.availableAdditionalCapacityUsd <= 0).length;
  const eligible = allUw.filter((s) => s.requestedAmountUsd > 0).length;
  const approvedRows = allUw.filter((s) => s.underwriting.approvedAmountUsd > 0).length;
  const approvalRate = eligible > 0 ? (approvedRows / eligible) * 100 : 0;

  console.log(`\n=== 条件: ${v.label}（短期${fmt(shortTermLoans)}+長期${fmt(longTermLoans)}=債務${fmt(totalDebt)}）===`);
  console.log(`  初回承認turn: ${firstApprovalTurn ?? "8Q以内に一度も承認なし"}`);
  console.log(`  緊急融資総額(${SEEDS.length}シード合算): ${fmt(totalEmergency)}`);
  console.log(`  余力ゼロの行数: ${zeroCapacityRows} / ${allUw.length}`);
  console.log(`  支払不能(paymentDefault)発生: ${anyDefault}`);
  console.log(`  債務超過(negativeEquity)発生: ${anyInsolvent}`);
  console.log(`  承認率: ${approvedRows}/${eligible} = ${approvalRate.toFixed(1)}%`);
}
