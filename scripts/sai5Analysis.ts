#!/usr/bin/env -S npx tsx
// ShrimpX V2 — Phase SAI-5G: A/B比較・因果分析の実行スクリプト
//
// 同一の初期条件・同一seed群で、SAI-5の各機能フラグをON/OFFした複数configを
// 実行し、§13E（A/B比較）・§8-9（分析成果物・受入判定観点）の集計を
// 機械可読(JSON/CSV)＋人間可読(markdown)でartifacts/sai5/へ出力する。
//
// 【注記】市場別・商品別の構成比は「成約量ベース」（marketAllocationTraceの
// allocatedQuantity）を主とし、参考として「販売計画数量ベース」
// （salesQuantityTraceのfinalPlannedQuantity）も併記する。実現販売数量
// （履行・納品）は市場×商品粒度では存在しないため使用しない（捏造回避）。

import * as fs from "node:fs";
import * as path from "node:path";
import { runAutoplayCase, AutoplayCaseConfig } from "../app/lib/v2/companyLab/standardAi/autoplay/runCase";
import { buildAutoplayCaseLogs } from "../app/lib/v2/companyLab/standardAi/autoplay/buildLog";
import { ALL_COMPANY_IDS } from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";
import {
  STANDARD_BASELINE_CANDIDATES,
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
} from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import { unwrapUnit } from "../app/lib/v2/core/units";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
const SEEDS_8 = Array.from({ length: 8 }, (_, i) => `sai5-ab-${String(i + 1).padStart(3, "0")}`);
const SEEDS_12 = Array.from({ length: 12 }, (_, i) => `sai5-ab-${String(i + 1).padStart(3, "0")}`);
const MARKETS = ["CN", "US", "EU", "JP", "OTHER"] as const;
const PRODUCTS = ["hoso", "pd", "vap"] as const;

type FlagSet = Partial<
  Pick<
    AutoplayCaseConfig,
    | "managementProfilesEnabled"
    | "marketProductOrientationEnabled"
    | "heterogeneousInitialConditionsEnabled"
    | "productLifecycleEnabled"
    | "salesBaseAccumulationEnabled"
    | "supplyPremiumFeedbackEnabled"
    | "standardAiCapexEnabled"
  >
>;

const ALL_ON: FlagSet = {
  managementProfilesEnabled: true,
  marketProductOrientationEnabled: true,
  heterogeneousInitialConditionsEnabled: true,
  productLifecycleEnabled: true,
  salesBaseAccumulationEnabled: true,
  supplyPremiumFeedbackEnabled: true,
  standardAiCapexEnabled: true,
};

interface ConfigSpec {
  readonly id: string;
  readonly label: string;
  readonly flags: FlagSet;
  readonly seeds: readonly string[];
  readonly quarters: number;
}

const CONFIGS: readonly ConfigSpec[] = [
  { id: "control", label: "control（全機能OFF=identical-standard）", flags: {}, seeds: SEEDS_8, quarters: 8 },
  { id: "profilesOnly", label: "SAI-4経営性格のみ", flags: { managementProfilesEnabled: true }, seeds: SEEDS_8, quarters: 8 },
  { id: "orientationOnly", label: "市場・商品志向のみ(5A)", flags: { marketProductOrientationEnabled: true }, seeds: SEEDS_8, quarters: 8 },
  { id: "lifecycleOnly", label: "商品ライフサイクルのみ(5C)", flags: { productLifecycleEnabled: true }, seeds: SEEDS_8, quarters: 8 },
  { id: "salesBaseOnly", label: "営業基盤蓄積のみ(5D)", flags: { salesBaseAccumulationEnabled: true, marketProductOrientationEnabled: true }, seeds: SEEDS_8, quarters: 8 },
  { id: "feedbackOnly", label: "供給→プレミアムのみ(5E)", flags: { supplyPremiumFeedbackEnabled: true }, seeds: SEEDS_8, quarters: 8 },
  { id: "heterogeneousInitOnly", label: "異質初期条件のみ(5B)", flags: { heterogeneousInitialConditionsEnabled: true }, seeds: SEEDS_8, quarters: 8 },
  {
    id: "aiCapexStack",
    label: "AI設備投資(5F)+志向+ライフサイクル+フィードバック",
    flags: {
      marketProductOrientationEnabled: true,
      productLifecycleEnabled: true,
      supplyPremiumFeedbackEnabled: true,
      standardAiCapexEnabled: true,
    },
    seeds: SEEDS_8,
    quarters: 8,
  },
  { id: "allOn8q", label: "全機能ON・8四半期・12seed", flags: ALL_ON, seeds: SEEDS_12, quarters: 8 },
  { id: "allOn32q", label: "全機能ON・32四半期・4seed（長期）", flags: ALL_ON, seeds: SEEDS_8.slice(0, 4), quarters: 32 },
];

interface CompanyMetrics {
  cumulativeRevenueUsd: number;
  cumulativeOperatingProfitUsd: number;
  finalCashUsd: number;
  defaultCount: number;
  contractedByMarket: Record<string, number>;
  contractedByProduct: Record<string, number>;
  plannedByMarket: Record<string, number>;
  plannedByProduct: Record<string, number>;
  capexProposals: number;
  capexProposalsByType: Record<string, number>;
}

function emptyCompanyMetrics(): CompanyMetrics {
  return {
    cumulativeRevenueUsd: 0,
    cumulativeOperatingProfitUsd: 0,
    finalCashUsd: 0,
    defaultCount: 0,
    contractedByMarket: {},
    contractedByProduct: {},
    plannedByMarket: {},
    plannedByProduct: {},
    capexProposals: 0,
    capexProposalsByType: {},
  };
}

function add(rec: Record<string, number>, key: string, v: number): void {
  rec[key] = (rec[key] ?? 0) + v;
}

function runConfig(spec: ConfigSpec) {
  const perCompany = new Map<string, CompanyMetrics>(ALL_COMPANY_IDS.map((id) => [id, emptyCompanyMetrics()]));
  const premiumByTurn: { pd: number[][]; vap: number[][] } = { pd: [], vap: [] };
  const supplyPressureByTurn: { pd: number[][]; vap: number[][] } = { pd: [], vap: [] };
  const premiumMultiplierByTurn: { pd: number[][]; vap: number[][] } = { pd: [], vap: [] };
  let maxAquacultureWish = 0;
  let firstDivergenceTurn: number | undefined;
  let completedCases = 0;
  let errorCases = 0;

  for (const seed of spec.seeds) {
    let result;
    try {
      result = runAutoplayCase({ scenarioId: "baseline", seed, quarters: spec.quarters, companyIds: ALL_COMPANY_IDS, candidate, ...spec.flags });
    } catch (e) {
      errorCases += 1;
      console.error(`[${spec.id}] seed=${seed} でエラー:`, e instanceof Error ? e.message : e);
      continue;
    }
    completedCases += 1;
    const logs = buildAutoplayCaseLogs(result);

    for (const row of logs.caseSummaryRows) {
      const m = perCompany.get(row.companyId)!;
      m.cumulativeRevenueUsd += row.cumulativeRevenueUsd;
      m.cumulativeOperatingProfitUsd += row.cumulativeOperatingProfitUsd;
      m.finalCashUsd += row.finalCashUsd;
      if (row.paymentDefaultEverByRequestedTurns) m.defaultCount += 1;
    }
    for (const e of logs.marketAllocationTrace) {
      const m = perCompany.get(e.companyId);
      if (!m) continue;
      add(m.contractedByMarket, e.market, e.allocatedQuantityHosoEqTons);
      add(m.contractedByProduct, e.product, e.allocatedQuantityHosoEqTons);
    }
    for (const e of logs.salesQuantityTrace) {
      const m = perCompany.get(e.companyId)!;
      add(m.plannedByMarket, e.market, e.finalPlannedQuantity);
      add(m.plannedByProduct, e.product, e.finalPlannedQuantity);
    }
    for (const d of result.diagnostics) {
      const m = perCompany.get(d.companyId)!;
      m.capexProposals += d.decision.capexDecision.newProjectProposals.length;
      for (const p of d.decision.capexDecision.newProjectProposals) add(m.capexProposalsByType, p.projectType, 1);
      for (const plan of d.decision.aquacultureStockingPlans) {
        maxAquacultureWish = Math.max(maxAquacultureWish, unwrapUnit(plan.plannedStockingQuantity));
      }
    }
    // プレミアム・供給圧力の推移（seed横断でturnごとに収集）
    result.history.forEach((h, i) => {
      (premiumByTurn.pd[i] ??= []).push(unwrapUnit(h.marketResult.pdPremium.byCountry.VN.premium));
      (premiumByTurn.vap[i] ??= []).push(unwrapUnit(h.marketResult.vapPremium.byCountry.VN.premium));
      if (h.sai5MarketEvolution) {
        (supplyPressureByTurn.pd[i] ??= []).push(h.sai5MarketEvolution.supplyPressureByProduct.pd);
        (supplyPressureByTurn.vap[i] ??= []).push(h.sai5MarketEvolution.supplyPressureByProduct.vap);
        (premiumMultiplierByTurn.pd[i] ??= []).push(h.sai5MarketEvolution.appliedPremiumRatioMultipliers.pd);
        (premiumMultiplierByTurn.vap[i] ??= []).push(h.sai5MarketEvolution.appliedPremiumRatioMultipliers.vap);
      }
    });
    // 5社の市場別販売構成が最初に分岐したturn
    for (const h of result.history) {
      const vectors = new Set<string>();
      for (const companyId of ALL_COMPANY_IDS) {
        const byMarket: Record<string, number> = {};
        for (const d of result.diagnostics.filter((d) => d.companyId === companyId && d.turn === h.turn)) {
          for (const p of d.decision.salesPlans) add(byMarket, p.market, Math.round(unwrapUnit(p.desiredQuantity) * 100));
        }
        vectors.add(JSON.stringify(byMarket));
      }
      if (vectors.size > 1) {
        if (firstDivergenceTurn === undefined || h.turn < firstDivergenceTurn) firstDivergenceTurn = h.turn;
        break;
      }
    }
  }

  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const caseCount = completedCases;
  const share = (rec: Record<string, number>, keys: readonly string[]): Record<string, number> => {
    const total = keys.reduce((s, k) => s + (rec[k] ?? 0), 0);
    return Object.fromEntries(keys.map((k) => [k, total > 0 ? (rec[k] ?? 0) / total : 0]));
  };

  const companies = ALL_COMPANY_IDS.map((id) => {
    const m = perCompany.get(id)!;
    return {
      companyId: id,
      avgCumulativeRevenueUsd: caseCount > 0 ? m.cumulativeRevenueUsd / caseCount : 0,
      avgCumulativeOperatingProfitUsd: caseCount > 0 ? m.cumulativeOperatingProfitUsd / caseCount : 0,
      avgFinalCashUsd: caseCount > 0 ? m.finalCashUsd / caseCount : 0,
      defaultCount: m.defaultCount,
      contractedMarketShareOfOwn: share(m.contractedByMarket, MARKETS),
      contractedProductShareOfOwn: share(m.contractedByProduct, PRODUCTS),
      plannedMarketShareOfOwn: share(m.plannedByMarket, MARKETS),
      plannedProductShareOfOwn: share(m.plannedByProduct, PRODUCTS),
      contractedByMarket: m.contractedByMarket,
      contractedByProduct: m.contractedByProduct,
      capexProposals: m.capexProposals,
      capexProposalsByType: m.capexProposalsByType,
    };
  });

  // 市場ごとの5社内シェア（成約量ベース）
  const fiveCompanyShareByMarket: Record<string, Record<string, number>> = {};
  for (const market of MARKETS) {
    const totals = ALL_COMPANY_IDS.map((id) => perCompany.get(id)!.contractedByMarket[market] ?? 0);
    const sum = totals.reduce((s, v) => s + v, 0);
    fiveCompanyShareByMarket[market] = Object.fromEntries(ALL_COMPANY_IDS.map((id, i) => [id, sum > 0 ? totals[i] / sum : 0]));
  }
  const fiveCompanyShareByProduct: Record<string, Record<string, number>> = {};
  for (const product of PRODUCTS) {
    const totals = ALL_COMPANY_IDS.map((id) => perCompany.get(id)!.contractedByProduct[product] ?? 0);
    const sum = totals.reduce((s, v) => s + v, 0);
    fiveCompanyShareByProduct[product] = Object.fromEntries(ALL_COMPANY_IDS.map((id, i) => [id, sum > 0 ? totals[i] / sum : 0]));
  }

  const totalCases = caseCount * ALL_COMPANY_IDS.length;
  const totalDefaults = companies.reduce((s, c) => s + c.defaultCount, 0);
  return {
    id: spec.id,
    label: spec.label,
    flags: spec.flags,
    seeds: spec.seeds.length,
    quarters: spec.quarters,
    completedCases: caseCount,
    errorCases,
    defaultRate: totalCases > 0 ? totalDefaults / totalCases : 0,
    avgCumulativeRevenueUsd: companies.reduce((s, c) => s + c.avgCumulativeRevenueUsd, 0) / ALL_COMPANY_IDS.length,
    avgCumulativeOperatingProfitUsd: companies.reduce((s, c) => s + c.avgCumulativeOperatingProfitUsd, 0) / ALL_COMPANY_IDS.length,
    avgFinalCashUsd: companies.reduce((s, c) => s + c.avgFinalCashUsd, 0) / ALL_COMPANY_IDS.length,
    maxAquacultureWishHosoEqTons: maxAquacultureWish,
    firstDivergenceTurn: firstDivergenceTurn ?? null,
    medianVnPremiumByTurn: {
      pd: premiumByTurn.pd.map(median),
      vap: premiumByTurn.vap.map(median),
    },
    medianSupplyPressureByTurn: {
      pd: supplyPressureByTurn.pd.map(median),
      vap: supplyPressureByTurn.vap.map(median),
    },
    medianPremiumMultiplierByTurn: {
      pd: premiumMultiplierByTurn.pd.map(median),
      vap: premiumMultiplierByTurn.vap.map(median),
    },
    companies,
    fiveCompanyShareByMarket,
    fiveCompanyShareByProduct,
  };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function musd(v: number): string {
  return `${(v / 1e6).toFixed(1)}M`;
}

function main() {
  const outDir = path.resolve(process.cwd(), "artifacts/sai5/ab-comparison");
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const spec of CONFIGS) {
    console.log(`実行中: ${spec.id} (${spec.seeds.length} seeds × ${spec.quarters}Q)...`);
    const t0 = Date.now();
    const r = runConfig(spec);
    console.log(`  完了 (${((Date.now() - t0) / 1000).toFixed(1)}s): 完走${r.completedCases}/${spec.seeds.length} seeds, エラー${r.errorCases}, default率${pct(r.defaultRate)}`);
    results.push(r);
  }

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ generator: "scripts/sai5Analysis.ts", results }, null, 2));

  // 人間可読サマリー
  const lines: string[] = [];
  lines.push("# SAI-5 A/B比較サマリー");
  lines.push("");
  lines.push("同一seed群・同一初期条件（フラグ差のみ）。構成比は**成約量ベース**（marketAllocationTraceのallocatedQuantity）。");
  lines.push("");
  lines.push("## 経営指標（config横並び）");
  lines.push("");
  lines.push("| config | seeds×Q | default率 | 平均累計売上 | 平均累計営業利益 | 平均期末現金 | 最大養殖希望(t) | 分岐開始turn |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const r of results) {
    lines.push(
      `| ${r.id} | ${r.seeds}×${r.quarters} | ${pct(r.defaultRate)} | ${musd(r.avgCumulativeRevenueUsd)} | ${musd(r.avgCumulativeOperatingProfitUsd)} | ${musd(r.avgFinalCashUsd)} | ${r.maxAquacultureWishHosoEqTons.toFixed(0)} | ${r.firstDivergenceTurn ?? "-"} |`
    );
  }
  lines.push("");
  for (const r of results) {
    lines.push(`## ${r.id} — ${r.label}`);
    lines.push("");
    lines.push("| 会社 | 累計売上 | 累計営業利益 | 期末現金 | default | 市場構成(成約) | 商品構成(成約) | capex提案 |");
    lines.push("|---|---:|---:|---:|---:|---|---|---:|");
    for (const c of r.companies) {
      const mkt = MARKETS.map((m) => `${m}:${pct(c.contractedMarketShareOfOwn[m])}`).join(" ");
      const prd = PRODUCTS.map((p) => `${p}:${pct(c.contractedProductShareOfOwn[p])}`).join(" ");
      lines.push(
        `| ${c.companyId} | ${musd(c.avgCumulativeRevenueUsd)} | ${musd(c.avgCumulativeOperatingProfitUsd)} | ${musd(c.avgFinalCashUsd)} | ${c.defaultCount} | ${mkt} | ${prd} | ${c.capexProposals} |`
      );
    }
    lines.push("");
    lines.push("市場別の5社内シェア（成約量ベース）:");
    lines.push("");
    lines.push(`| 市場 | ${ALL_COMPANY_IDS.join(" | ")} |`);
    lines.push(`|---|${ALL_COMPANY_IDS.map(() => "---:").join("|")}|`);
    for (const market of MARKETS) {
      lines.push(`| ${market} | ${ALL_COMPANY_IDS.map((id) => pct(r.fiveCompanyShareByMarket[market][id])).join(" | ")} |`);
    }
    lines.push("");
    lines.push("商品別の5社内シェア（成約量ベース）:");
    lines.push("");
    lines.push(`| 商品 | ${ALL_COMPANY_IDS.join(" | ")} |`);
    lines.push(`|---|${ALL_COMPANY_IDS.map(() => "---:").join("|")}|`);
    for (const product of PRODUCTS) {
      lines.push(`| ${product} | ${ALL_COMPANY_IDS.map((id) => pct(r.fiveCompanyShareByProduct[product][id])).join(" | ")} |`);
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(outDir, "summary.md"), lines.join("\n"));
  console.log(`出力: ${outDir}/summary.json, summary.md`);
}

main();
