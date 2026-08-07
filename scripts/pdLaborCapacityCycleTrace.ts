// ShrimpX V2 — 資金繰り診断: 与信能力が回復しないサイクルを四半期ごとに追う（三宅さん指示・2026-08-04 step4）
//
// 【目的】48コミットスタック(PD係数1.8)で「通常融資の承認可能額が8四半期を通じて
// 一度も回復しない」現象を、単発の集計ではなく「EBITDA代理→営業CF→緊急融資の発動
// （理由と金額）→期末債務→翌turnの借入余力の各構成要素→承認有無」という
// 四半期単位のビジネスサイクルとして数値で追う。
//
// 【本スクリプトは診断専用】financing/liquidityClose.tsのobservation-onlyフックを
// 使うのみで、ゲームの挙動は一切変更しない。
//
// 【develop/v2・pd_laborの両方で実行可能】相対importのみを使用しているため、
// このファイルをそのままpd_laborへ一時コピーして実行できる（§13と同じ手順。
// pd_laborへはコミットしない）。
//
// 使い方: npx tsx scripts/pdLaborCapacityCycleTrace.ts [--seeds N]

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
import { periodToString } from "../app/lib/v2/core/period";
import { unwrapUsd } from "../app/lib/v2/finance/types";

const BASE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

const argOf = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const SEED_COUNT = argOf("--seeds", 3);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => `sai3a-grid-${String(i + 1).padStart(3, "0")}`);

/**
 * 【5社は同一テンプレートのクローン】標準baselineの5社（BAL/MASS/JPQ/VAP/CONSV）は
 * buildUnifiedFixturesFromTemplateで同一テンプレートから複製され、per-company
 * overrideを渡していないため、同一seed・同一turnでは全社が完全に同一の数値になる
 * （実行して確認済み）。そのため「代表的な会社」の多様性はseed間の違いとして
 * 現れる。本スクリプトはBAL社（＝同一seed内の他4社と同一）を代表として扱う。
 */
const TARGET_COMPANY = "BAL";

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

for (const seed of SEEDS) {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns: 8 };
  const uw: UnderwritingSnapshot[] = [];
  const rf: LoanRollForwardSnapshot[] = [];
  setUnderwritingSnapshotObserver((s) => uw.push(s));
  setLoanRollForwardObserver((s) => rf.push(s));
  const init = initializeUnifiedCompanyLabFromTemplate(config, BASE.buildFixtureTemplate, BASE.financeFixtureTemplate, BASE.contractDefs, ALL_COMPANY_IDS);
  const result = runFromInit(init, generateStandardAiDecision);
  setUnderwritingSnapshotObserver(undefined);
  setLoanRollForwardObserver(undefined);

  const companyId = TARGET_COMPANY;
  console.log(`\n\n========== 代表ケース: seed=${seed}・会社=${companyId}（同一seed内の他4社は完全に同一数値） ==========`);
  console.log(
    "turn | 引受用EBITDA代理 | 営業CF(当期) | 通常融資実行 | 緊急融資実行 | 緊急融資理由(不足額) | 期末ST+LT債務 | 次turn担保上限 | 次turn収益上限 | 次turn tierCap | 次turn余力 | 次turn承認額"
  );
  console.log("-".repeat(220));
  for (let t = 1; t <= 8; t++) {
    const period = periodOf(t);
    const nextPeriod = periodOf(t + 1);
    const s = uw.find((x) => x.companyId === companyId && periodToString(x.period) === period);
    const r = rf.find((x) => x.companyId === companyId && periodToString(x.period) === period);
    const record = result.history.find((h) => h.turn === t);
    const fin = record?.financialResults.find((f) => f.companyId === companyId);
    const nextS = uw.find((x) => x.companyId === companyId && periodToString(x.period) === nextPeriod);
    if (!s || !r) continue;
    const opCf = fin ? unwrapUsd(fin.cashFlow.operatingCashFlow) : NaN;
    const shortfall = r.emergencyDrawUsd > 0 ? "不足=" + fmt(Math.max(0, r.scheduledPrincipalDueUsd + r.scheduledInterestDueUsd - r.normalDrawUsd)) : "-";
    console.log(
      `${String(t).padStart(4)} | ${fmt(s.borrowingCapacityInput.ebitdaLikeQuarterlyUsd).padStart(16)} | ${fmt(opCf).padStart(12)} | ` +
        `${fmt(r.normalDrawUsd).padStart(12)} | ${fmt(r.emergencyDrawUsd).padStart(12)} | ${shortfall.padStart(20)} | ` +
        `${fmt(r.endingTotalLoanBalanceUsd).padStart(14)} | ` +
        `${nextS ? fmt(nextS.borrowingCapacityResult.collateralBasedLimitUsd).padStart(14) : "N/A".padStart(14)} | ` +
        `${nextS ? fmt(nextS.borrowingCapacityResult.earningsBasedLimitUsd).padStart(14) : "N/A".padStart(14)} | ` +
        `${nextS ? fmt(nextS.borrowingCapacityResult.creditTierCapUsd).padStart(14) : "N/A".padStart(14)} | ` +
        `${nextS ? fmt(nextS.borrowingCapacityResult.availableAdditionalCapacityUsd).padStart(10) : "N/A".padStart(10)} | ` +
        `${nextS ? fmt(nextS.underwriting.approvedAmountUsd).padStart(10) : "N/A".padStart(10)}`
    );
  }
}

function periodOf(turn: number): string {
  // 標準baselineの起点はINITIAL_PERIOD_V2 = 2015Q1。
  const startYear = 2015;
  const q = ((turn - 1) % 4) + 1;
  const year = startYear + Math.floor((turn - 1) / 4);
  return `${year}Q${q}`;
}
