// ShrimpX V2 — B: 営業人員headcountのend-to-end本番トレース（動的・Standard AI駆動）
// 三宅さんovernight指示Part B（2026-08-04夜間）への対応。
//
// 【方法】standardBaseline.ts「moderate-pressure」（8Q基準として確定済みの
// 標準初期条件、salesForceHeadcountTotal=80）の初期fixtureのうち
// salesForceHeadcountTotalのみを差し替え、他は一切変更しないまま、8四半期を
// Standard AI（generateStandardAiDecision、本番の意思決定ロジック・無改変）で
// 実際に再シミュレーションする。既存のpdLaborInitialDebtReductionCompare.ts
// （財務ブランチ）と同じ「本番再シミュレーション」方法論をheadcountに適用した。
//
// 【本スクリプトは診断専用・observation-onlyのみ】production coreコード
// （sales/salesForce.ts・standardAi/*・autoPolicy.ts等）は一切変更しない。
// company-lab harness（decomposeHarness.ts）が既に返す
// result.history[].companySummaries / financialResults / financingResults /
// salesRecord をそのまま読むだけであり、新たな観測フックの追加も不要
// （これらは全てPhase 8Aまでに既存で公開されているデータ）。
//
// 【B-3: Standard AIの他の意思決定によるcascade（交絡）の扱い】本スクリプトは
// Standard AI駆動のため「動的（他の意思決定も内生的に変わりうる）」比較である。
// B-1のallocation段階の純粋な因果関係は別スクリプト
// （b1IsolatedAllocationTrace.ts）で、Standard AIを一切介さず
// allocateMarketProduct等の実コードを直接呼ぶことで厳密に分離している。
// 本スクリプトは「headcountを変えた場合に実際にゲーム全体でどう波及するか」
// という、動的な現実の挙動を測定する（B-4〜B-7が要求するproduction/
// raw material/財務への波及は、動的トレースでしか観測できないため）。
//
// 使い方: npx tsx scripts/b4DynamicHeadcountTrace.ts [--seeds N]

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
import { unwrapUnit } from "../app/lib/v2/core/units";
import { PeriodV2 } from "../app/lib/v2/core/period";

const BASE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
// moderate-pressure標準初期条件の確定値（standardBaseline.ts）はheadcount=80。CASES[0]がこの値を使う。

const argOf = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const SEED_COUNT = argOf("--seeds", 3);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => `sai3a-grid-${String(i + 1).padStart(3, "0")}`);
const TARGET_COMPANY = "BAL"; // 5社は同一seed・同一turnで完全に同一数値（本セッション既報告のとおり）

interface HeadcountCase {
  readonly label: string;
  readonly headcount: number;
}
// baseline/+10%/+25%/+50%/+100%を、整数headcountへ丸めて採用。
const CASES: readonly HeadcountCase[] = [
  { label: "baseline(80人)", headcount: 80 },
  { label: "+10%(88人)", headcount: 88 },
  { label: "+25%(100人)", headcount: 100 },
  { label: "+50%(120人)", headcount: 120 },
  { label: "+100%(160人)", headcount: 160 },
];

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function fmtR(n: number, digits = 3): string {
  return n.toFixed(digits);
}

interface QuarterMetrics {
  readonly turn: number;
  readonly period: string;
  readonly newContractedQuantity: number;
  readonly newContractedAveragePrice: number;
  readonly fulfilledQuantity: number;
  readonly overdueQuantity: number;
  readonly rawMaterialShortfall: number;
  readonly equipmentShortfall: number;
  readonly laborShortfall: number;
  readonly equipmentUtilizationRate: number;
  readonly laborUtilizationRate: number;
  readonly netRevenue: number;
  readonly grossProfit: number;
  readonly operatingProfit: number;
  readonly cash: number;
  readonly accountsReceivable: number;
  readonly shortTermLoans: number;
  readonly longTermLoans: number;
  readonly negativeEquity: boolean;
  readonly cashShortfall: boolean;
}

function periodOf(turn: number): string {
  const startYear = 2015;
  const q = ((turn - 1) % 4) + 1;
  const year = startYear + Math.floor((turn - 1) / 4);
  return `${year}Q${q}`;
}

for (const c of CASES) {
  console.log(`\n\n========== headcount=${c.headcount}（${c.label}） ==========`);

  for (const seed of SEEDS) {
    const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns: 8 };
    const buildFixtureTemplate = (sp: PeriodV2) => ({ ...BASE.buildFixtureTemplate(sp), salesForceHeadcountTotal: c.headcount });
    const init = initializeUnifiedCompanyLabFromTemplate(config, buildFixtureTemplate, BASE.financeFixtureTemplate, BASE.contractDefs, ALL_COMPANY_IDS);
    const result = runFromInit(init, generateStandardAiDecision);

    const metrics: QuarterMetrics[] = [];
    for (const rec of result.history) {
      const summary = rec.companySummaries.find((s) => s.companyId === TARGET_COMPANY);
      const fin = rec.financialResults.find((f) => f.companyId === TARGET_COMPANY);
      if (!summary || !fin) continue;
      metrics.push({
        turn: rec.turn,
        period: periodOf(rec.turn),
        newContractedQuantity: unwrapUnit(summary.newContractedQuantity),
        newContractedAveragePrice: summary.newContractedAveragePrice,
        fulfilledQuantity: unwrapUnit(summary.fulfilledQuantity),
        overdueQuantity: unwrapUnit(summary.overdueQuantity),
        rawMaterialShortfall: unwrapUnit(summary.rawMaterialShortfall),
        equipmentShortfall: unwrapUnit(summary.equipmentShortfall),
        laborShortfall: unwrapUnit(summary.laborShortfall),
        equipmentUtilizationRate: unwrapUnit(summary.equipmentUtilizationRate),
        laborUtilizationRate: unwrapUnit(summary.laborUtilizationRate),
        netRevenue: unwrapUsd(fin.profitAndLoss.netRevenue),
        grossProfit: unwrapUsd(fin.profitAndLoss.grossProfit),
        operatingProfit: unwrapUsd(fin.profitAndLoss.operatingProfit),
        cash: unwrapUsd(fin.balanceSheet.cash),
        accountsReceivable: unwrapUsd(fin.balanceSheet.accountsReceivable),
        shortTermLoans: unwrapUsd(fin.balanceSheet.shortTermLoans),
        longTermLoans: unwrapUsd(fin.balanceSheet.longTermLoans),
        negativeEquity: fin.negativeEquity,
        cashShortfall: fin.cashShortfall,
      });
    }

    console.log(`\n--- ${seed}・${TARGET_COMPANY}社（他4社は同一seed内で同一数値） ---`);
    console.log(
      "turn | 新規成約量(t) | 平均単価 | 履行量(t) | 延滞量(t) | 原料不足(t) | 設備稼働率 | 労働稼働率 | 純売上 | 粗利 | 営業利益 | 現金 | 短期+長期債務"
    );
    for (const m of metrics) {
      console.log(
        `${String(m.turn).padStart(4)} | ${fmt(m.newContractedQuantity).padStart(13)} | ${fmtR(m.newContractedAveragePrice).padStart(8)} | ` +
          `${fmt(m.fulfilledQuantity).padStart(9)} | ${fmt(m.overdueQuantity).padStart(9)} | ${fmt(m.rawMaterialShortfall).padStart(11)} | ` +
          `${fmtR(m.equipmentUtilizationRate).padStart(10)} | ${fmtR(m.laborUtilizationRate).padStart(10)} | ${fmt(m.netRevenue).padStart(12)} | ` +
          `${fmt(m.grossProfit).padStart(12)} | ${fmt(m.operatingProfit).padStart(12)} | ${fmt(m.cash).padStart(12)} | ${fmt(m.shortTermLoans + m.longTermLoans).padStart(14)}`
      );
    }

    const total = (key: keyof QuarterMetrics) => metrics.reduce((s, m) => s + (m[key] as number), 0);
    console.log(
      `  [8Q累計] 新規成約量=${fmt(total("newContractedQuantity"))}t  純売上=${fmt(total("netRevenue"))}  粗利=${fmt(total("grossProfit"))}  ` +
        `営業利益=${fmt(total("operatingProfit"))}  延滞量=${fmt(total("overdueQuantity"))}t  原料不足累計=${fmt(total("rawMaterialShortfall"))}t`
    );
    console.log(`  [turn8末] 現金=${fmt(metrics[metrics.length - 1]?.cash ?? NaN)}  債務超過発生=${metrics.some((m) => m.negativeEquity)}  資金不足発生=${metrics.some((m) => m.cashShortfall)}`);
  }
}

// ===== 8Q累計・3シード平均のケース間比較・限界効果（B-6） =====
// （上のループ内では逐次出力のみだったため、ここで同じロジックを再実行して集計する）
interface CaseAgg {
  readonly headcount: number;
  readonly label: string;
  readonly avgNewContractedQuantity: number;
  readonly avgNetRevenue: number;
  readonly avgGrossProfit: number;
  readonly avgOperatingProfit: number;
  readonly avgRawMaterialShortfall: number;
  readonly avgEndCash: number;
  readonly personnelCost8Q: number;
}
const aggResults: CaseAgg[] = [];
for (const c of CASES) {
  let sumContracted = 0,
    sumRevenue = 0,
    sumGross = 0,
    sumOperating = 0,
    sumShortfall = 0,
    sumEndCash = 0;
  for (const seed of SEEDS) {
    const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns: 8 };
    const buildFixtureTemplate = (sp: PeriodV2) => ({ ...BASE.buildFixtureTemplate(sp), salesForceHeadcountTotal: c.headcount });
    const init = initializeUnifiedCompanyLabFromTemplate(config, buildFixtureTemplate, BASE.financeFixtureTemplate, BASE.contractDefs, ALL_COMPANY_IDS);
    const result = runFromInit(init, generateStandardAiDecision);
    let contracted = 0,
      revenue = 0,
      gross = 0,
      operating = 0,
      shortfall = 0,
      endCash = 0;
    for (const rec of result.history) {
      const summary = rec.companySummaries.find((s) => s.companyId === TARGET_COMPANY);
      const fin = rec.financialResults.find((f) => f.companyId === TARGET_COMPANY);
      if (!summary || !fin) continue;
      contracted += unwrapUnit(summary.newContractedQuantity);
      revenue += unwrapUsd(fin.profitAndLoss.netRevenue);
      gross += unwrapUsd(fin.profitAndLoss.grossProfit);
      operating += unwrapUsd(fin.profitAndLoss.operatingProfit);
      shortfall += unwrapUnit(summary.rawMaterialShortfall);
      endCash = unwrapUsd(fin.balanceSheet.cash);
    }
    sumContracted += contracted;
    sumRevenue += revenue;
    sumGross += gross;
    sumOperating += operating;
    sumShortfall += shortfall;
    sumEndCash += endCash;
  }
  const n = SEEDS.length;
  const SALES_SALARY_PER_QUARTER = 8000; // finance/parameters.ts salesForceSalaryUsdPerQuarter
  aggResults.push({
    headcount: c.headcount,
    label: c.label,
    avgNewContractedQuantity: sumContracted / n,
    avgNetRevenue: sumRevenue / n,
    avgGrossProfit: sumGross / n,
    avgOperatingProfit: sumOperating / n,
    avgRawMaterialShortfall: sumShortfall / n,
    avgEndCash: sumEndCash / n,
    personnelCost8Q: c.headcount * SALES_SALARY_PER_QUARTER * 8,
  });
}

console.log("\n\n========== B-6: ケース間サマリ（3シード平均・8Q累計）＋限界効果 ==========");
console.log("headcount | 平均新規成約量(t) | 平均純売上 | 平均粗利 | 平均営業利益 | 平均原料不足(t) | turn8末平均現金 | 8Q人件費(概算)");
for (const a of aggResults) {
  console.log(
    `${String(a.headcount).padStart(9)} | ${fmt(a.avgNewContractedQuantity).padStart(17)} | ${fmt(a.avgNetRevenue).padStart(11)} | ` +
      `${fmt(a.avgGrossProfit).padStart(9)} | ${fmt(a.avgOperatingProfit).padStart(12)} | ${fmt(a.avgRawMaterialShortfall).padStart(15)} | ` +
      `${fmt(a.avgEndCash).padStart(15)} | ${fmt(a.personnelCost8Q).padStart(13)}`
  );
}

console.log("\n[限界効果（前のケースからの差分、Δheadcount単位）]");
console.log("区間 | Δheadcount | Δ新規成約量(t) | Δ粗利 | Δ営業利益 | Δ人件費 | Δ粗利/人 | Δ営業利益/人 | 粗利で人件費を回収できているか");
for (let i = 1; i < aggResults.length; i++) {
  const prev = aggResults[i - 1];
  const cur = aggResults[i];
  const dH = cur.headcount - prev.headcount;
  const dContracted = cur.avgNewContractedQuantity - prev.avgNewContractedQuantity;
  const dGross = cur.avgGrossProfit - prev.avgGrossProfit;
  const dOperating = cur.avgOperatingProfit - prev.avgOperatingProfit;
  const dCost = cur.personnelCost8Q - prev.personnelCost8Q;
  console.log(
    `${prev.headcount}→${cur.headcount} | ${String(dH).padStart(10)} | ${fmt(dContracted).padStart(14)} | ${fmt(dGross).padStart(10)} | ` +
      `${fmt(dOperating).padStart(10)} | ${fmt(dCost).padStart(9)} | ${fmt(dGross / dH).padStart(9)} | ${fmt(dOperating / dH).padStart(11)} | ` +
      `${dGross > dCost ? "YES（粗利増分>人件費増分）" : "NO（粗利増分<人件費増分）"}`
  );
}
