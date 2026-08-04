// ShrimpX V2 — 資金繰り診断: 担保構成要素別の内訳(A-3)と、本番の実際の緊急融資
// 不足額(A-4)を、四半期ごとに追う（三宅さん指示・2026-08-04 overnight task Part A）。
//
// 【A-3】これまでのトレース（pdLaborCapacityCycleTrace.ts）はcollateralBasedLimitUsdの
// 合算値のみを見ており、「担保上限自体がPD係数1.8下で既存債務と同じペースで縮小し
// 続ける」ことは確認したが、どの構成要素（売掛金・原料在庫(使用可能)・原料在庫(輸送中)・
// 完成品在庫）が縮小を主導しているかは未確認だった。UnderwritingSnapshot.borrowingCapacityInput.collateral
// には既にこの4値が格納されている（追加の観測フックは不要、分析が未実施だっただけ）。
//
// 【A-4】これまでの緊急融資「不足額」表示は診断スクリプト側の近似
// （scheduledPrincipal + scheduledInterest - normalDraw）であり、本番の実際の変数
// shortfallBeforeEmergency（= max(0, fullAccruedInterest + scheduledPrincipalDue
// - max(0, availableForDebtServiceBeforeEmergency))）とは別物だった。今回
// liquidityClose.tsのLoanRollForwardSnapshotへ shortfallBeforeEmergencyUsd /
// cashBeforeEmergencyDecisionUsd / emergencyCapUsd を追加観測項目として捕捉できる
// ようにした（observation-onlyの追加、ゲーム挙動は不変。SNAP-1で確認済み）。
// 本スクリプトはその実測値を使う。
//
// 【本番挙動には一切影響しない】observation-onlyフックのみ使用。
// develop/v2・pd_labor両方で相対importのみのため、そのままpd_laborへ一時コピー
// して実行できる（実行後は必ずgit checkout --で復元・git status clean確認）。
//
// 使い方: npx tsx scripts/pdLaborComponentAndShortfallTrace.ts [--seeds N]

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

const BASE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

const argOf = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const SEED_COUNT = argOf("--seeds", 3);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => `sai3a-grid-${String(i + 1).padStart(3, "0")}`);
const TARGET_COMPANY = "BAL"; // 5社は同一seed・同一turnで完全に同一数値（確認済み・§18注記と同じ理由）

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function periodOf(turn: number): string {
  const startYear = 2015;
  const q = ((turn - 1) % 4) + 1;
  const year = startYear + Math.floor((turn - 1) / 4);
  return `${year}Q${q}`;
}

for (const seed of SEEDS) {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns: 8 };
  const uw: UnderwritingSnapshot[] = [];
  const rf: LoanRollForwardSnapshot[] = [];
  setUnderwritingSnapshotObserver((s) => uw.push(s));
  setLoanRollForwardObserver((s) => rf.push(s));
  const init = initializeUnifiedCompanyLabFromTemplate(config, BASE.buildFixtureTemplate, BASE.financeFixtureTemplate, BASE.contractDefs, ALL_COMPANY_IDS);
  runFromInit(init, generateStandardAiDecision);
  setUnderwritingSnapshotObserver(undefined);
  setLoanRollForwardObserver(undefined);

  console.log(`\n\n========== A-3 担保構成要素の内訳: seed=${seed}・会社=${TARGET_COMPANY} ==========`);
  console.log("turn | 売掛金 | 原料在庫(使用可) | 原料在庫(輸送中) | 完成品在庫 | 掛目後: 売掛金分 | 原料(使用可)分 | 原料(輸送中)分 | 完成品分 | 担保上限合計");
  console.log("-".repeat(190));
  const RH = 0.7, RA = 0.4, RT = 0.15, FG = 0.3; // parameters.ts の掛目（既知の生値、production再掲）
  for (let t = 1; t <= 8; t++) {
    const s = uw.find((x) => x.companyId === TARGET_COMPANY && periodToString(x.period) === periodOf(t));
    if (!s) continue;
    const c = s.borrowingCapacityInput.collateral;
    console.log(
      `${String(t).padStart(4)} | ${fmt(c.receivablesUsd).padStart(12)} | ${fmt(c.rawMaterialAvailableUsd).padStart(16)} | ` +
        `${fmt(c.rawMaterialInTransitUsd).padStart(16)} | ${fmt(c.finishedGoodsUsd).padStart(11)} | ` +
        `${fmt(c.receivablesUsd * RH).padStart(16)} | ${fmt(c.rawMaterialAvailableUsd * RA).padStart(14)} | ` +
        `${fmt(c.rawMaterialInTransitUsd * RT).padStart(14)} | ${fmt(c.finishedGoodsUsd * FG).padStart(10)} | ` +
        `${fmt(s.borrowingCapacityResult.collateralBasedLimitUsd).padStart(14)}`
    );
  }

  console.log(`\n---------- A-4 緊急融資: 本番の実測不足額(shortfallBeforeEmergencyUsd) と 診断スクリプト旧近似 の比較: seed=${seed}・会社=${TARGET_COMPANY} ----------`);
  console.log("turn | Pass1後現金 | 本番shortfallBeforeEmergency | 緊急融資枠上限 | 緊急融資実行 | 旧近似(元本+利息-通常融資) | 差分(本番-旧近似)");
  console.log("-".repeat(160));
  for (let t = 1; t <= 8; t++) {
    const r = rf.find((x) => x.companyId === TARGET_COMPANY && periodToString(x.period) === periodOf(t));
    if (!r) continue;
    const oldApprox = Math.max(0, r.scheduledPrincipalDueUsd + r.scheduledInterestDueUsd - r.normalDrawUsd);
    const diff = r.shortfallBeforeEmergencyUsd - oldApprox;
    console.log(
      `${String(t).padStart(4)} | ${fmt(r.cashBeforeEmergencyDecisionUsd).padStart(12)} | ${fmt(r.shortfallBeforeEmergencyUsd).padStart(28)} | ` +
        `${fmt(r.emergencyCapUsd).padStart(14)} | ${fmt(r.emergencyDrawUsd).padStart(12)} | ${fmt(oldApprox).padStart(26)} | ${fmt(diff).padStart(18)}`
    );
  }
}
