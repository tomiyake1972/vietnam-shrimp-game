// ShrimpX V2 — Phase 6C 完成ベンチマーク（#05 §20〜§22）
//
// 正式営業能力モデル（会社営業組織モデル v1 ＝ ベンチマーク呼称 "Case B + V1"）で
// baseline / seed=management-console-32q / 5社×32Q を回し、
// Q1/Q8/Q16/Q24/Q32 の会社別実態と、multi-seed 頑健性を出す。
//
// **パラメータの上書きは一切しない**（既定＝正式モデルをそのまま使う）。

import { CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../app/lib/v2/companyLab/runner";
import { createStandardAiProvider, StandardAiQuarterDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { unwrapUsd } from "../app/lib/v2/finance/types";
import { SALES_PARAMETERS_V1 } from "../app/lib/v2/sales/parameters";

const TURNS = Number(process.env.P6C_TURNS ?? 32);
const SHOW = [1, 8, 16, 24, 32].filter((t) => t <= TURNS);
const COMPANIES = ["BAL", "CONSV", "JPQ", "MASS", "VAP"];

const n = (v: number | null | undefined, w = 7) => (v === null || v === undefined ? "－".padStart(w) : Math.round(v).toLocaleString().padStart(w));
const pct = (v: number | null | undefined, w = 5) => (v === null || v === undefined ? "－".padStart(w) : `${(v * 100).toFixed(0).padStart(w - 1)}%`);
const musd = (v: number, w = 8) => (v / 1e6).toFixed(1).padStart(w);

function run(seed: string) {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns: TURNS };
  const { provider, diagnostics } = createStandardAiProvider();
  return { result: runCompanyLabWithAutoPolicyForAllCompanies(config, provider), diagnostics };
}

console.log("=== Phase 6C 完成ベンチマーク（正式営業能力モデル＝会社営業組織モデル v1）===\n");
console.log("【モデル定義（sales/salesCapacityModel.ts）】");
const model = SALES_PARAMETERS_V1.salesCapacityModel!;
console.log(`  kind: ${model.kind}`);
console.log(
  `  capacity(h) = ${model.companyBaselineCapacityTons.toLocaleString()} + ${model.companyCapacityMaxIncrementTons.toLocaleString()} × h/(h+${model.companyCapacitySaturationHeadcount})  工数t/Q`
);
console.log(`  fragmentation penalty: ${model.fragmentationPenaltyPerExtraMarket}（正式モデルでは適用しない）`);
console.log(
  `  営業工数係数: HOSO ${SALES_PARAMETERS_V1.salesEffortCoefficients.hoso} / PD ${SALES_PARAMETERS_V1.salesEffortCoefficients.pd} / VAP ${SALES_PARAMETERS_V1.salesEffortCoefficients.vap}（切替で変更していない）\n`
);

const main = run("management-console-32q");

// ---------------------------------------------------------------------
// §20 Q1/Q8/Q16/Q24/Q32 の会社別実態
// ---------------------------------------------------------------------

function diagAt(diagnostics: readonly StandardAiQuarterDiagnostics[], turn: number, companyId: string) {
  return diagnostics.find((d) => d.turn === turn && d.companyId === companyId);
}

console.log("【§20 Q1/Q8/Q16/Q24/Q32 会社別実態】");
console.log(
  "  Q 会社   Vision参考 Ambition Commit  提出   成約   生産 営業HC 必要HC 稼働率 未充足 主因            工場 新工場   売上M 営業利益M  現金M  借入M"
);
for (const turn of SHOW) {
  const record = main.result.history.find((h) => h.turn === turn);
  for (const companyId of COMPANIES) {
    const d = diagAt(main.diagnostics, turn, companyId);
    const s = record?.companySummaries.find((c) => c.companyId === companyId);
    const f = record?.financialResults.find((c) => c.companyId === companyId);
    if (!d || !s || !f) continue;
    const submitted = d.decision.salesPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
    const production = unwrapUnit(s.hosoProduced) + unwrapUnit(s.pdProduced) + unwrapUnit(s.vapProduced);
    const hc = [...new Map(d.decision.salesPlans.map((p) => [p.market, p.salesForceHeadcount])).values()].reduce((a, b) => a + b, 0);
    const factories = new Set((record?.factoryLoadMetrics ?? []).filter((x) => x.companyId === companyId).map((x) => x.factoryId)).size;
    console.log(
      `  ${String(turn).padStart(2)} ${companyId.padEnd(6)}${n(d.strategicGrowth?.visionTargetScaleAtCurrentTurn, 10)} ${n(
        d.commercialAmbition?.ambitionTons,
        8
      )} ${n(d.commercialCommitment?.submissionTargetTons, 6)} ${n(submitted, 6)} ${n(unwrapUnit(s.newContractedQuantity), 6)} ${n(
        production,
        6
      )} ${String(hc).padStart(6)} ${String(d.salesHiring?.requiredHeadcount ?? "-").padStart(6)} ${pct(unwrapUnit(s.equipmentUtilizationRate), 6)} ${n(
        d.unservedOpportunity?.unservedProfitableTons,
        6
      )} ${(d.unservedOpportunity?.primaryConstraint ?? "-").padEnd(16)}${String(factories).padStart(4)} ${(
        d.newFactoryAssessment?.status ?? "-"
      ).padEnd(8)}${musd(unwrapUsd(f.profitAndLoss.netRevenue))}${musd(unwrapUsd(f.profitAndLoss.operatingProfit), 10)}${musd(
        unwrapUsd(f.balanceSheet.cash)
      )}${musd(unwrapUsd(f.balanceSheet.shortTermLoans) + unwrapUsd(f.balanceSheet.longTermLoans))}`
    );
  }
  console.log("");
}

// ---------------------------------------------------------------------
// §22 生産能力制約・能力起因の未充足・新工場ゲート
// ---------------------------------------------------------------------

console.log("【§22 生産能力が制約になった四半期と、能力起因の未充足】");
console.log("  会社   PRODUCTION_CAPACITY主因のQ数  能力起因未充足の累計  新工場の最終状態  止まったゲート");
for (const companyId of COMPANIES) {
  const rows = main.diagnostics.filter((d) => d.companyId === companyId);
  const productionBound = rows.filter((d) => d.unservedOpportunity?.primaryConstraint === "PRODUCTION_CAPACITY").length;
  const capacityCaused = rows.reduce((sum, d) => sum + (d.unservedOpportunity?.blockedByProductionCapacityTons ?? 0), 0);
  const last = rows[rows.length - 1];
  const failed = last?.newFactoryAssessment?.gates.find((g) => !g.passed);
  console.log(
    `  ${companyId.padEnd(6)}${String(productionBound).padStart(26)} ${n(capacityCaused, 20)}  ${(last?.newFactoryAssessment?.status ?? "-").padEnd(17)}${
      failed?.gate ?? (last?.newFactoryAssessment ? "(全通過)" : "-")
    }`
  );
}

console.log("\n【直近8Qの成長制約の内訳（5社合計）】");
{
  const counts = new Map<string, number>();
  for (const d of main.diagnostics.filter((x) => x.turn > TURNS - 8)) {
    const key = d.unservedOpportunity?.primaryConstraint ?? "NONE";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)} 件  ${k}`);
}

// ---------------------------------------------------------------------
// §21 multi-seed 頑健性
// ---------------------------------------------------------------------

console.log("\n【§21 multi-seed 頑健性（5seed × 32Q）】");
console.log("  seed                    累計営業利益M 最小現金M 生産0のQ数 期末在庫t 期末借入M 5社成約t 転換率");
for (const seed of ["management-console-32q", "phase6c-regression", "seed-a", "seed-b", "seed-c"]) {
  const r = seed === "management-console-32q" ? main : run(seed);
  let cumulativeOperatingProfit = 0;
  let minimumCash = Infinity;
  let zeroProduction = 0;
  for (const h of r.result.history) {
    for (const f of h.financialResults) {
      cumulativeOperatingProfit += unwrapUsd(f.profitAndLoss.operatingProfit);
      minimumCash = Math.min(minimumCash, unwrapUsd(f.balanceSheet.cash));
    }
    for (const c of h.companySummaries) {
      if (unwrapUnit(c.hosoProduced) + unwrapUnit(c.pdProduced) + unwrapUnit(c.vapProduced) <= 0) zeroProduction += 1;
    }
  }
  const last = r.result.history[r.result.history.length - 1];
  const inventory = last.companySummaries.reduce((s, c) => s + unwrapUnit(c.finishedGoodsInventory), 0);
  const debt = last.financialResults.reduce((s, f) => s + unwrapUsd(f.balanceSheet.shortTermLoans) + unwrapUsd(f.balanceSheet.longTermLoans), 0);
  const contracts = last.companySummaries.reduce((s, c) => s + unwrapUnit(c.newContractedQuantity), 0);
  const submitted = r.diagnostics
    .filter((d) => d.turn === TURNS)
    .reduce((s, d) => s + d.decision.salesPlans.reduce((x, p) => x + unwrapUnit(p.desiredQuantity), 0), 0);
  console.log(
    `  ${seed.padEnd(24)}${musd(cumulativeOperatingProfit, 12)}${musd(minimumCash, 10)}${String(zeroProduction).padStart(11)} ${n(
      inventory,
      9
    )}${musd(debt, 10)} ${n(contracts, 8)} ${pct(submitted > 0 ? contracts / submitted : null, 6)}`
  );
}

// ---------------------------------------------------------------------
// 営業採用の説明可能性（#05 §6 の実測）
// ---------------------------------------------------------------------

console.log("\n【営業採用0の理由内訳（理由コードなしが0件であること）】");
{
  const counts = new Map<string, number>();
  let zero = 0;
  let missing = 0;
  for (const d of main.diagnostics) {
    const h = d.salesHiring;
    if (!h || h.actualHireCount > 0) continue;
    zero += 1;
    if (!h.zeroHireReason) missing += 1;
    else counts.set(h.zeroHireReason, (counts.get(h.zeroHireReason) ?? 0) + 1);
  }
  console.log(`  採用0の会社×四半期: ${zero} / ${main.diagnostics.length}   理由コードなし: ${missing}`);
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)} 件  ${k}`);
}
