// ShrimpX V2 — A-8: 緊急融資の拡充集計（三宅さんovernight指示Part A・A-8への対応）
//
// 【前提】標準5社は同一seed・同一turnで完全に同一数値（§19-1aで確認済み）。
// 本集計は「5社複製込みの生値」を基本としつつ、複製を除いた「独立サンプル
// （1社×3シード×8四半期=24点）」ベースの集計も併記する。
//
// 使い方: npx tsx scripts/a8EmergencyLoanAggregation.ts [--pd-labor] [--seeds N]

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
const argOf = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const SEED_COUNT = argOf("--seeds", 3);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => `sai3a-grid-${String(i + 1).padStart(3, "0")}`);
const stackLabel = process.argv.includes("--pd-labor") ? "pd_labor(48コミットスタック)" : "develop/v2";

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

const allRf: LoanRollForwardSnapshot[] = [];
for (const seed of SEEDS) {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns: 8 };
  const rf: LoanRollForwardSnapshot[] = [];
  setLoanRollForwardObserver((s) => rf.push(s));
  const init = initializeUnifiedCompanyLabFromTemplate(config, BASE.buildFixtureTemplate, BASE.financeFixtureTemplate, BASE.contractDefs, ALL_COMPANY_IDS);
  const result = runFromInit(init, generateStandardAiDecision);
  setLoanRollForwardObserver(undefined);
  allRf.push(...rf.map((s) => ({ ...s, __seed: seed } as LoanRollForwardSnapshot & { __seed: string })));
  void result;
}

const withSeed = allRf as (LoanRollForwardSnapshot & { __seed: string })[];
const emergencyEvents = withSeed.filter((s) => s.emergencyDrawUsd > 0);

console.log(`\n========== A-8 緊急融資 拡充集計: ${stackLabel}・${SEEDS.length}シード×5社×8四半期=${withSeed.length}行 ==========\n`);

// 全体集計（5社複製込み）
const grandTotal = emergencyEvents.reduce((s, e) => s + e.emergencyDrawUsd, 0);
console.log(`[全体（5社複製込みの生値）]`);
console.log(`  緊急融資イベント数: ${emergencyEvents.length} / ${withSeed.length}行`);
console.log(`  緊急融資総額(grand total): ${fmt(grandTotal)}`);
console.log(`  1社1シードあたり平均（総額÷(シード数×5社)）: ${fmt(grandTotal / (SEEDS.length * 5))}`);

// 独立サンプルベース（BAL社のみ＝5社の代表）
const balOnly = withSeed.filter((s) => s.companyId === "BAL");
const balEmergency = balOnly.filter((s) => s.emergencyDrawUsd > 0);
console.log(`\n[独立サンプルのみ（BAL社代表、5倍複製を除く。${SEEDS.length}シード×8四半期=${balOnly.length}行）]`);
console.log(`  緊急融資イベント数: ${balEmergency.length} / ${balOnly.length}行`);
console.log(`  緊急融資総額（独立サンプルの合算。上記grand totalの1/5と一致するはず）: ${fmt(balEmergency.reduce((s, e) => s + e.emergencyDrawUsd, 0))}`);
console.log(`  grand total ÷ 5 = ${fmt(grandTotal / 5)}  ${Math.abs(grandTotal / 5 - balEmergency.reduce((s, e) => s + e.emergencyDrawUsd, 0)) < 1 ? "[OK: 一致（5社完全複製の確認）]" : "[不一致——複製仮定の再検証が必要]"}`);

// turn別内訳（独立サンプルベース）
console.log(`\n[turn別内訳（独立サンプル、${SEEDS.length}シード合算）]`);
console.log("turn | イベント数 | 実行額合計 | 実行額平均(発動turnのみ)");
for (let t = 1; t <= 8; t++) {
  const startYear = 2015;
  const q = ((t - 1) % 4) + 1;
  const year = startYear + Math.floor((t - 1) / 4);
  const period = `${year}Q${q}`;
  const rows = balOnly.filter((s) => periodToString(s.period) === period && s.emergencyDrawUsd > 0);
  const total = rows.reduce((s, r) => s + r.emergencyDrawUsd, 0);
  console.log(`${String(t).padStart(4)} | ${String(rows.length).padStart(10)} | ${fmt(total).padStart(12)} | ${rows.length > 0 ? fmt(total / rows.length).padStart(20) : "N/A".padStart(20)}`);
}

// seed別内訳
console.log(`\n[シード別内訳（独立サンプル・BAL社代表）]`);
for (const seed of SEEDS) {
  const rows = balOnly.filter((s) => (s as LoanRollForwardSnapshot & { __seed: string }).__seed === seed && s.emergencyDrawUsd > 0);
  const total = rows.reduce((s, r) => s + r.emergencyDrawUsd, 0);
  console.log(`  ${seed}: イベント数=${rows.length}  実行額合計=${fmt(total)}`);
}

// 最大/最小/中央値（発動turnのみ、独立サンプル）
const amounts = balEmergency.map((e) => e.emergencyDrawUsd).sort((a, b) => a - b);
if (amounts.length > 0) {
  const median = amounts.length % 2 === 1 ? amounts[(amounts.length - 1) / 2] : (amounts[amounts.length / 2 - 1] + amounts[amounts.length / 2]) / 2;
  console.log(`\n[最大/最小/中央値（発動turnのみ・独立サンプル・n=${amounts.length}）]`);
  console.log(`  最大: ${fmt(amounts[amounts.length - 1])}  最小: ${fmt(amounts[0])}  中央値: ${fmt(median)}`);
}

// 緊急融資ゼロの会社数（5社の代表としてBALのみ追っているため、ここでは「seedのうち緊急融資が一度も発動しなかったseed数」を報告）
const seedsWithZeroEmergency = SEEDS.filter((seed) => balOnly.filter((s) => (s as LoanRollForwardSnapshot & { __seed: string }).__seed === seed).every((s) => s.emergencyDrawUsd === 0));
console.log(`\n[緊急融資が一度も発動しなかったシード数]: ${seedsWithZeroEmergency.length} / ${SEEDS.length}（5社は同一seed内で全社同一のため、これは「緊急融資が発動しなかった会社数(5社換算)」にも等しい）`);

// 会社別内訳の詳細確認（"5社完全同一"仮定の検証）
console.log(`\n[会社別内訳（複製仮定の検証）]`);
for (const cid of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
  const rows = withSeed.filter((s) => s.companyId === cid && s.emergencyDrawUsd > 0);
  const total = rows.reduce((s, r) => s + r.emergencyDrawUsd, 0);
  console.log(`  ${cid}: イベント数=${rows.length}  実行額合計=${fmt(total)}`);
}

// 会社別・シード別の詳細（"完全同一"仮定への影響を精査）
console.log(`\n[会社別×シード別 詳細（"BAL/MASSはJPQ/VAP/CONSVと異なる"かどうかの検証）]`);
for (const seed of SEEDS) {
  console.log(`  --- ${seed} ---`);
  for (const cid of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    const rows = withSeed.filter((s) => s.companyId === cid && (s as LoanRollForwardSnapshot & { __seed: string }).__seed === seed && s.emergencyDrawUsd > 0);
    const total = rows.reduce((s, r) => s + r.emergencyDrawUsd, 0);
    console.log(`    ${cid}: イベント数=${rows.length}  実行額合計=${fmt(total)}`);
  }
}
