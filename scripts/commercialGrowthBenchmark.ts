// ShrimpX V2 — Phase 6 §42〜§44 ベンチマーク
//
// Vision → Commercial Ambition → 提出販売計画 → 成約 → 生産 → 稼働率 →
// 未充足機会（原因分解）→ 新工場判断 を、会社×ターンで実測する。

import { CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../app/lib/v2/companyLab/runner";
import { createStandardAiProvider } from "../app/lib/v2/companyLab/standardAi/policy";
import { unwrapUnit } from "../app/lib/v2/core/units";

const TURNS = Number(process.env.BENCH_TURNS ?? 32);
const SHOW = (process.env.BENCH_SHOW ?? "1,8,16,24,32").split(",").map(Number);

const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "management-console-32q", turns: TURNS };
const { provider, diagnostics } = createStandardAiProvider();
const result = runCompanyLabWithAutoPolicyForAllCompanies(config, provider);

const summaryOf = (turn: number, companyId: string) =>
  result.history.find((h) => h.turn === turn)?.companySummaries.find((s) => s.companyId === companyId);

const n = (v: number | null | undefined, w = 7) => (v === null || v === undefined ? "－".padStart(w) : Math.round(v).toLocaleString().padStart(w));

console.log("=== Phase 6 ベンチマーク（baseline / seed=management-console-32q）===\n");
console.log("  Q 会社   Vision参考  Ambition  提出計画   成約    生産  稼働率  未充足  能力起因 主因            新工場");
for (const turn of SHOW) {
  for (const d of diagnostics.filter((x) => x.turn === turn)) {
    const s = summaryOf(turn, d.companyId);
    const produced = s ? unwrapUnit(s.hosoProduced) + unwrapUnit(s.pdProduced) + unwrapUnit(s.vapProduced) : 0;
    const submitted = d.decision.salesPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
    const util = unwrapUnit(s?.equipmentUtilizationRate ?? (0 as never));
    console.log(
      `  ${String(turn).padStart(2)} ${d.companyId.padEnd(6)}${n(d.strategicGrowth?.visionTargetScaleAtCurrentTurn, 9)} ${n(
        d.commercialAmbition?.ambitionTons,
        9
      )} ${n(submitted, 9)} ${n(s ? unwrapUnit(s.newContractedQuantity) : null, 8)} ${n(produced, 7)} ${(util * 100)
        .toFixed(1)
        .padStart(6)}% ${n(d.unservedOpportunity?.unservedProfitableTons, 7)} ${n(
        d.unservedOpportunity?.blockedByProductionCapacityTons,
        8
      )} ${(d.unservedOpportunity?.primaryConstraint ?? "－").padEnd(16)}${d.newFactoryAssessment?.status ?? "－"}`
    );
  }
  console.log("");
}

console.log("【Commercial Ambition の固定性（Q5〜Q32）】");
for (const companyId of [...new Set(diagnostics.map((d) => d.companyId))]) {
  const vals = diagnostics.filter((d) => d.companyId === companyId && d.turn >= 5).map((d) => d.commercialAmbition?.ambitionTons ?? 0);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  console.log(`  ${companyId.padEnd(6)} min ${n(min)}  max ${n(max)}  幅 ${n(max - min, 6)}（${(((max - min) / min) * 100).toFixed(1)}%）`);
}

console.log("\n【市場全体】");
console.log("  Q   5社成約合計   TRUE需要   5社シェア");
for (const turn of SHOW) {
  const record = result.history.find((h) => h.turn === turn);
  if (!record) continue;
  const contracted = record.companySummaries.reduce((s, c) => s + unwrapUnit(c.newContractedQuantity), 0);
  const demand = record.salesRecord.allocations.reduce((s, a) => s + unwrapUnit(a.targetDemand), 0);
  console.log(`  ${String(turn).padStart(2)} ${n(contracted, 12)} ${n(demand, 10)} ${((contracted / demand) * 100).toFixed(1).padStart(9)}%`);
}

const proposals = diagnostics.filter((d) => d.newFactoryAssessment?.status === "READY_TO_BUILD");
console.log(`\n【新工場】提案ターン数: ${proposals.length}`);
for (const p of proposals.slice(0, 20)) console.log(`  Q${p.turn} ${p.companyId}`);

