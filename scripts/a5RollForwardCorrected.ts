// ShrimpX V2 — A-5: 7点ロールフォワード（通常/緊急分離・A-4の実測値で再構成）
// 三宅さんovernight指示Part A・A-5への対応（2026-08-04）。
//
// 【7点】(1)前期末債務 (2)当期開始債務(=1と同一設計) (3)通常融資実行後
// (4)緊急融資実行後 (5)元本返済前 (6)元本返済後 (7)当期末債務
// 【本番の実際の処理順（closeQuarterWithFinancing読解に基づく）】
//   (1)(2) prevFinancingState.loanPortfolio.loans の元本合計（ST/LT内訳）
//   (3) 通常融資(normalDrawUsd)実行 — Pass1相当。緊急融資はまだ含まない
//   (4) 緊急融資(emergencyDrawUsd)実行（shortfallBeforeEmergency判定後）
//   (5) 元本返済前 = (1)+(3)+(4)（=totalLoanDrawUsd込みの残高、返済前）
//   (6) 元本返済後 = (5) - principalPaidCashUsd（実際に現金支払われた元本のみ。
//       scheduledPrincipalDueUsdとの差が延滞・繰越になる）
//   (7) 当期末債務 = endingShortTermLoansUsd + endingLongTermLoansUsd
//       （(6)と一致するはず。突合はこのスクリプトの主目的）
//
// 【A-4適用】旧版(§18-2)は緊急融資の「理由(不足額)」を近似値で表示していたが、
// 本表は実測のshortfallBeforeEmergencyUsdを使う。
//
// 使い方: npx tsx scripts/a5RollForwardCorrected.ts [--pd-labor]

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
import { setLoanRollForwardObserver, LoanRollForwardSnapshot } from "../app/lib/v2/financing/liquidityClose";
import { periodToString } from "../app/lib/v2/core/period";

const BASE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
const TARGET_COMPANY = "BAL";
const SEED = "sai3a-grid-001";

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function periodOf(turn: number): string {
  const startYear = 2015;
  const q = ((turn - 1) % 4) + 1;
  const year = startYear + Math.floor((turn - 1) / 4);
  return `${year}Q${q}`;
}

const stackLabel = process.argv.includes("--pd-labor") ? "pd_labor(48コミットスタック)" : "develop/v2";
const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: SEED, turns: 8 };
const rf: LoanRollForwardSnapshot[] = [];
setLoanRollForwardObserver((s) => rf.push(s));
const init = initializeUnifiedCompanyLabFromTemplate(config, BASE.buildFixtureTemplate, BASE.financeFixtureTemplate, BASE.contractDefs, ALL_COMPANY_IDS);
runFromInit(init, generateStandardAiDecision);
setLoanRollForwardObserver(undefined);

console.log(`\n========== A-5 7点ロールフォワード（通常/緊急分離・実測shortfall使用）: ${stackLabel}・seed=${SEED}・会社=${TARGET_COMPANY} ==========\n`);

for (let t = 1; t <= 8; t++) {
  const r = rf.find((x) => x.companyId === TARGET_COMPANY && periodToString(x.period) === periodOf(t));
  if (!r) continue;
  const p1 = r.priorTotalLoanBalanceUsd; // (1)(2)
  const p3 = p1 + r.normalDrawUsd; // (3) 通常融資実行後
  const p4 = p3 + r.emergencyDrawUsd; // (4) 緊急融資実行後
  const p5 = p4; // (5) 元本返済前 = (4)と同一（返済はまだ反映されていない）
  const p6 = p5 - r.principalPaidCashUsd; // (6) 元本返済後
  const p7 = r.endingTotalLoanBalanceUsd; // (7) 当期末
  const gap = p6 - p7;
  console.log(`--- turn ${t} ---`);
  console.log(`  (1)(2) 前期末=当期開始債務: ${fmt(p1)} (ST=${fmt(r.priorShortTermLoansUsd)}+LT=${fmt(r.priorLongTermLoansUsd)})`);
  console.log(`  (3) 通常融資実行後: ${fmt(p3)}  [通常融資実行額=${fmt(r.normalDrawUsd)}]`);
  console.log(
    `  (4) 緊急融資実行後: ${fmt(p4)}  [緊急融資実行額=${fmt(r.emergencyDrawUsd)}` +
      (r.emergencyDrawUsd > 0
        ? `／実測不足額shortfallBeforeEmergency=${fmt(r.shortfallBeforeEmergencyUsd)}／緊急融資枠上限=${fmt(r.emergencyCapUsd)}／Pass1後現金=${fmt(r.cashBeforeEmergencyDecisionUsd)}]`
        : `]`)
  );
  console.log(`  (5) 元本返済前: ${fmt(p5)}  [scheduledPrincipalDue=${fmt(r.scheduledPrincipalDueUsd)}／scheduledInterestDue=${fmt(r.scheduledInterestDueUsd)}]`);
  console.log(`  (6) 元本返済後: ${fmt(p6)}  [実際に現金支払われた元本principalPaidCash=${fmt(r.principalPaidCashUsd)}／利息現金支払interestPaidCash=${fmt(r.interestPaidCashUsd)}]`);
  console.log(`  (7) 当期末債務(本番の実値): ${fmt(p7)} (ST=${fmt(r.endingShortTermLoansUsd)}+LT=${fmt(r.endingLongTermLoansUsd)})`);
  console.log(`  突合: (6)-(7) = ${fmt(gap)}  ${Math.abs(gap) < 1 ? "[OK: 完全一致]" : "[要根本原因調査: 不一致]"}`);
  console.log("");
}
