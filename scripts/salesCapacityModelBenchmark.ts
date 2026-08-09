// ShrimpX V2 — Phase 6B §8〜§11 営業能力モデル比較ベンチマーク
//
// **正式モデルは決め打ちしない**（#04 §16）。Control / Case A / Case B / Case C を
// 同一 baseline・同一 seed・5社×32Q で回し、比較材料だけを出す。

import { SALES_PARAMETERS_V1, SalesParameters } from "../app/lib/v2/sales/parameters";
import { CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../app/lib/v2/companyLab/runner";
import { createStandardAiProvider } from "../app/lib/v2/companyLab/standardAi/policy";

const TURNS = Number(process.env.MODEL_TURNS ?? 32);
import { SalesCapacityModel, companySalesOrganizationCapacity, marketFragmentationFactor } from "../app/lib/v2/sales/salesCapacityModel";
import { processingCapacity } from "../app/lib/v2/sales/salesForce";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { Product } from "../app/lib/v2/market/types";

const n = (v: number, w = 7) => Math.round(v).toLocaleString().padStart(w);

// ---------------------------------------------------------------------
// 候補モデル（#04 §2）
// ---------------------------------------------------------------------

/** Case A: 現行構造（市場単位）のまま、曲線パラメータだけ再校正。 */
function caseAParams(effort: Readonly<Record<Product, number>>): SalesParameters {
  return {
    ...SALES_PARAMETERS_V1,
    salesForce: {
      ...SALES_PARAMETERS_V1.salesForce,
      // 市場あたり20〜36人という現実的な人数帯で伸びるよう半飽和点を下げ、
      // 上限は据え置く（市場単位のまま到達可能にする最小変更）。
      capacitySaturationHeadcount: 18,
      capacityMaxIncrementTons: 24_000,
    },
    salesEffortCoefficients: effort,
  };
}

/** Case B: 会社全体で1回だけ能力を求め、市場へ配分する。 */
function caseBParams(effort: Readonly<Record<Product, number>>, model?: Partial<SalesCapacityModel>): SalesParameters {
  return {
    ...SALES_PARAMETERS_V1,
    salesEffortCoefficients: effort,
    salesCapacityModel: {
      kind: "companyWide",
      companyBaselineCapacityTons: 1_000,
      companyCapacityMaxIncrementTons: 95_000,
      companyCapacitySaturationHeadcount: 190,
      fragmentationPenaltyPerExtraMarket: 0,
      fragmentationFloor: 1,
      ...model,
    },
  };
}

/** Case C: Case B ＋ 市場展開の非効率（5市場で 0.88 倍）。 */
function caseCParams(effort: Readonly<Record<Product, number>>): SalesParameters {
  return caseBParams(effort, {
    kind: "companyWideWithFragmentation",
    fragmentationPenaltyPerExtraMarket: 0.03,
    fragmentationFloor: 0.85,
  });
}

const V1: Readonly<Record<Product, number>> = { hoso: 1.0, pd: 1.2, vap: 3.0 };
const V2: Readonly<Record<Product, number>> = { hoso: 1.0, pd: 1.2, vap: 2.0 };
const V3: Readonly<Record<Product, number>> = { hoso: 1.0, pd: 1.25, vap: 1.75 };

const CANDIDATES: readonly { readonly name: string; readonly params: SalesParameters }[] = [
  { name: "Control (現行)", params: SALES_PARAMETERS_V1 },
  { name: "Case A + V1", params: caseAParams(V1) },
  { name: "Case B + V1", params: caseBParams(V1) },
  { name: "Case B + V2", params: caseBParams(V2) },
  { name: "Case C + V1", params: caseCParams(V1) },
  { name: "Case C + V2", params: caseCParams(V2) },
  { name: "Case C + V3", params: caseCParams(V3) },
];

// ---------------------------------------------------------------------
// §10 Growth ladder（シミュレーション不要・能力式だけで出せる）
// ---------------------------------------------------------------------

/** 商品構成別の 1t あたり営業工数。 */
const MIXES: readonly { readonly name: string; readonly share: Readonly<Record<Product, number>> }[] = [
  { name: "HOSO中心", share: { hoso: 0.7, pd: 0.2, vap: 0.1 } },
  { name: "PD中心", share: { hoso: 0.2, pd: 0.6, vap: 0.2 } },
  { name: "VAP中心", share: { hoso: 0.2, pd: 0.2, vap: 0.6 } },
  { name: "mixed", share: { hoso: 0.4, pd: 0.35, vap: 0.25 } },
];

function effortPerTon(effort: Readonly<Record<Product, number>>, share: Readonly<Record<Product, number>>): number {
  return (["hoso", "pd", "vap"] as const).reduce((s, p) => s + effort[p] * share[p], 0);
}

/** その候補が headcount 人で処理できる実売トン数（5市場・需要比例配分を前提）。 */
function sellableTons(params: SalesParameters, headcount: number, mixShare: Readonly<Record<Product, number>>, marketCount = 5): number {
  const perTon = effortPerTon(params.salesEffortCoefficients, mixShare);
  const model = params.salesCapacityModel;
  let effortCapacity: number;
  if (!model || model.kind === "perMarket") {
    // 市場単位: 需要比例配分なので、均等展開時は headcount/marketCount 人ずつ。
    const perMarket = Math.floor(headcount / marketCount);
    effortCapacity = marketCount * unwrapUnit(processingCapacity(perMarket, params));
  } else {
    effortCapacity = companySalesOrganizationCapacity(headcount, model) * marketFragmentationFactor(marketCount, model);
  }
  return effortCapacity / perTon;
}

console.log("=== Phase 6B 営業能力モデル比較（baseline / seed=management-console-32q）===\n");

console.log("【§10 Growth ladder: 各モデルが処理できる実売トン/四半期（5市場展開）】");
console.log("  目安: 60人→15〜18k / 100人→25〜30k / 130人→30〜35k / 160〜180人→40k級\n");
for (const mix of MIXES) {
  console.log(`  --- ${mix.name} ---`);
  console.log("  モデル                60人     100人     130人     160人     180人");
  for (const c of CANDIDATES) {
    const cells = [60, 100, 130, 160, 180].map((h) => n(sellableTons(c.params, h, mix.share), 9)).join("");
    console.log(`  ${c.name.padEnd(16)}${cells}`);
  }
  console.log("");
}


// ---------------------------------------------------------------------
// §8〜§9 32Q マルチ候補ベンチマーク
// ---------------------------------------------------------------------

interface CompanyOutcome {
  hc: number;
  ambition: number;
  submitted: number;
  contracted: number;
  production: number;
  utilization: number;
  unserved: number;
  capacityCaused: number;
  primary: string;
  newFactory: string;
  cash: number;
  operatingProfit: number;
  factoryCount: number;
}

function runCandidate(name: string, salesParams: SalesParameters) {
  const config: CompanyLabConfig = {
    scenarioId: "baseline",
    mode: "canonical",
    seed: "management-console-32q",
    turns: TURNS,
    salesParamsOverride: salesParams === SALES_PARAMETERS_V1 ? undefined : salesParams,
  };
  const { provider, diagnostics } = createStandardAiProvider({ salesParams });
  const result = runCompanyLabWithAutoPolicyForAllCompanies(config, provider);
  const last = result.history[result.history.length - 1];

  const byCompany = new Map<string, CompanyOutcome>();
  for (const d of diagnostics.filter((x) => x.turn === TURNS)) {
    const s = last?.companySummaries.find((c) => c.companyId === d.companyId);
    const fin = last?.financialResults.find((f) => f.companyId === d.companyId);
    const hcByMarket = new Map<string, number>();
    for (const p of d.decision.salesPlans) hcByMarket.set(p.market, p.salesForceHeadcount);
    byCompany.set(d.companyId, {
      hc: [...hcByMarket.values()].reduce((a, b) => a + b, 0),
      ambition: d.commercialAmbition?.ambitionTons ?? 0,
      submitted: d.decision.salesPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0),
      contracted: s ? unwrapUnit(s.newContractedQuantity) : 0,
      production: s ? unwrapUnit(s.hosoProduced) + unwrapUnit(s.pdProduced) + unwrapUnit(s.vapProduced) : 0,
      utilization: s ? unwrapUnit(s.equipmentUtilizationRate) : 0,
      unserved: d.unservedOpportunity?.unservedProfitableTons ?? 0,
      capacityCaused: d.unservedOpportunity?.blockedByProductionCapacityTons ?? 0,
      primary: d.unservedOpportunity?.primaryConstraint ?? "-",
      newFactory: d.newFactoryAssessment?.status ?? "-",
      cash: fin ? Number((fin as unknown as { balanceSheet?: { cash?: number } }).balanceSheet?.cash ?? 0) : 0,
      operatingProfit: fin ? Number((fin as unknown as { profitAndLoss?: { operatingProfit?: number } }).profitAndLoss?.operatingProfit ?? 0) : 0,
      factoryCount: d.newFactoryAssessment ? 1 : 1,
    });
  }

  const bottleneckLate = new Map<string, number>();
  for (const d of diagnostics.filter((x) => x.turn >= TURNS - 7)) {
    const key = d.unservedOpportunity?.primaryConstraint ?? "NONE";
    bottleneckLate.set(key, (bottleneckLate.get(key) ?? 0) + 1);
  }

  return {
    name,
    byCompany,
    diagnostics,
    result,
    totalContracts: last?.companySummaries.reduce((s, c) => s + unwrapUnit(c.newContractedQuantity), 0) ?? 0,
    totalDemand: last?.salesRecord.allocations.reduce((s, a) => s + unwrapUnit(a.targetDemand), 0) ?? 0,
    newFactoryProposals: diagnostics.filter((d) => d.newFactoryAssessment?.status === "READY_TO_BUILD").length,
    bottleneckLate,
  };
}

const RUN: readonly { readonly name: string; readonly params: SalesParameters }[] = [
  { name: "Control", params: SALES_PARAMETERS_V1 },
  { name: "CaseA+V1", params: caseAParams(V1) },
  { name: "CaseB+V1", params: caseBParams(V1) },
  { name: "CaseC+V2", params: caseCParams(V2) },
  { name: "CaseC+V3", params: caseCParams(V3) },
];

const outcomes = RUN.map((c) => runCandidate(c.name, c.params));

console.log("【§1 32Q結果（Q32時点）】");
console.log("  モデル      会社  営業HC Ambition 提出計画    成約     生産 稼働率  未充足 能力起因 主因            新工場");
for (const o of outcomes) {
  for (const [companyId, v] of [...o.byCompany].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(
      `  ${o.name.padEnd(10)} ${companyId.padEnd(6)}${String(v.hc).padStart(6)} ${n(v.ambition, 8)} ${n(v.submitted, 8)} ${n(v.contracted, 8)} ${n(
        v.production,
        8
      )} ${(v.utilization * 100).toFixed(0).padStart(5)}% ${n(v.unserved, 7)} ${n(v.capacityCaused, 8)} ${v.primary.padEnd(16)}${v.newFactory}`
    );
  }
  console.log("");
}

console.log("【市場全体（Q32）・新工場・直近8Qの主因】");
console.log("  モデル      5社成約  TRUE需要 5社シェア 新工場提案 直近8Qの主因内訳");
for (const o of outcomes) {
  const share = o.totalDemand > 0 ? (o.totalContracts / o.totalDemand) * 100 : 0;
  const b = [...o.bottleneckLate].sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`  ${o.name.padEnd(10)}${n(o.totalContracts, 9)} ${n(o.totalDemand, 9)} ${share.toFixed(1).padStart(8)}% ${String(o.newFactoryProposals).padStart(10)} ${b}`);
}

console.log("\n【§2 営業HC推移（Q1/Q8/Q16/Q24/Q32）】");
for (const o of outcomes) {
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    const path = [1, 8, 16, 24, 32].map((t) => {
      const d = o.diagnostics.find((x) => x.turn === t && x.companyId === companyId);
      if (!d) return "-";
      const hc = new Map<string, number>();
      for (const p of d.decision.salesPlans) hc.set(p.market, p.salesForceHeadcount);
      return String([...hc.values()].reduce((a, b) => a + b, 0)).padStart(5);
    }).join("");
    console.log(`  ${o.name.padEnd(10)} ${companyId.padEnd(6)}${path}`);
  }
  console.log("");
}

console.log("【§3 市場別営業配置の意味（Q24 BAL・配置人数と成約）】");
for (const o of outcomes) {
  const d = o.diagnostics.find((x) => x.turn === 24 && x.companyId === "BAL");
  if (!d) continue;
  const hc = new Map<string, number>();
  const desired = new Map<string, number>();
  for (const p of d.decision.salesPlans) {
    hc.set(p.market, p.salesForceHeadcount);
    desired.set(p.market, (desired.get(p.market) ?? 0) + unwrapUnit(p.desiredQuantity));
  }
  const cells = [...hc.keys()].sort().map((m) => `${m}:${hc.get(m)}人/${Math.round(desired.get(m) ?? 0)}t`).join("  ");
  console.log(`  ${o.name.padEnd(10)} ${cells}`);
}
