// ShrimpX V2 — Phase 6B §3〜§14 Sales Capacity Audit
//
// 「市場には需要があり、会社ももっと売りたいのに、なぜ営業能力が足りないのか」
// を実測で切り分ける。**推定は使わない** — 必要人数は既存の営業工数関数
// （sales/marketEffort.ts・sales/salesForce.ts）をそのまま使って求める。

import { CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../app/lib/v2/companyLab/runner";
import { createStandardAiProvider } from "../app/lib/v2/companyLab/standardAi/policy";
import { SALES_PARAMETERS_V1 } from "../app/lib/v2/sales/parameters";
import { processingCapacity } from "../app/lib/v2/sales/salesForce";
import { allocateHeadcountAcrossMarkets, computeMarketSalesEffort, salesEffortWeightedQuantity } from "../app/lib/v2/sales/marketEffort";
import { DemandMarketId, Product } from "../app/lib/v2/market/types";
import { unwrapUnit } from "../app/lib/v2/core/units";

const TURNS = Number(process.env.SALES_TURNS ?? 32);
const SHOW = (process.env.SALES_SHOW ?? "1,4,8,12,16,20,24,28,32").split(",").map(Number);
const P = SALES_PARAMETERS_V1;

const n = (v: number, w = 7) => Math.round(v).toLocaleString().padStart(w);

// ---------------------------------------------------------------------
// 0. パラメータそのものの sanity（§9〜§11。ここでは変更しない）
// ---------------------------------------------------------------------
console.log("=== Phase 6B Sales Capacity Audit ===\n");
console.log("【営業1人あたりの処理能力（sales/salesForce.ts の processingCapacity）】");
console.log(`  式: capacity(h) = ${P.salesForce.baselineCapacityTons} + ${P.salesForce.capacityMaxIncrementTons} × h/(h+${P.salesForce.capacitySaturationHeadcount})  ※**市場ごと**に適用`);
console.log(`  営業工数係数: HOSO ${P.salesEffortCoefficients.hoso} / PD ${P.salesEffortCoefficients.pd} / VAP ${P.salesEffortCoefficients.vap}\n`);
console.log("  市場あたり人数 →  市場の処理能力  1人あたり限界能力");
for (const h of [0, 5, 10, 15, 20, 25, 30, 40, 60]) {
  const cap = unwrapUnit(processingCapacity(h, P));
  const marginal = h === 0 ? 0 : cap - unwrapUnit(processingCapacity(h - 1, P));
  console.log(`  ${String(h).padStart(4)} 人        ${n(cap)} 工数t   ${n(marginal, 6)} 工数t`);
}

// ---------------------------------------------------------------------
// 必要人数（既存関数だけを使う。推定しない）
// ---------------------------------------------------------------------

/**
 * 希望販売量（市場×商品）を営業工数制約なしで処理するのに必要な総人数。
 * 実際の配分関数 allocateHeadcountAcrossMarkets と市場別工数関数を使い、
 * 「どの市場も縮小されない」最小の総人数を1人刻みで探す。
 */
function requiredHeadcountFor(desiredByMarketProduct: ReadonlyMap<DemandMarketId, Record<Product, number>>): number {
  const marketsWithDemand = [...desiredByMarketProduct.entries()].filter(([, byProduct]) =>
    salesEffortWeightedQuantity(byProduct, P) > 1e-6
  );
  if (marketsWithDemand.length === 0) return 0;
  const effortDemandByMarket = new Map(marketsWithDemand.map(([m, byProduct]) => [m, salesEffortWeightedQuantity(byProduct, P)]));

  for (let total = 0; total <= 5000; total++) {
    const allocation = allocateHeadcountAcrossMarkets(total, effortDemandByMarket);
    const anyConstrained = marketsWithDemand.some(
      ([market, byProduct]) => computeMarketSalesEffort(allocation.get(market) ?? 0, byProduct, P).isConstrained
    );
    if (!anyConstrained) return total;
  }
  return -1; // 到達不能（5,000人でも足りない）
}

const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "management-console-32q", turns: TURNS };
const { provider, diagnostics } = createStandardAiProvider();
const result = runCompanyLabWithAutoPolicyForAllCompanies(config, provider);

interface Row {
  turn: number;
  companyId: string;
  ambition: number;
  submitted: number;
  currentHc: number;
  requiredHc: number;
  hireCount: number;
  layoffCount: number;
  salesCapacity: number;
  usedCapacity: number;
  effortPerTon: number;
  effortShare: { hoso: number; pd: number; vap: number };
  allocationLoss: number;
  reasons: string[];
}

const rows: Row[] = [];
for (const d of diagnostics) {
  const desiredByMarketProduct = new Map<DemandMarketId, Record<Product, number>>();
  for (const w of d.salesWishByMarketProduct) {
    if (!desiredByMarketProduct.has(w.market)) desiredByMarketProduct.set(w.market, { hoso: 0, pd: 0, vap: 0 });
    desiredByMarketProduct.get(w.market)![w.product] += w.desiredQuantityBeforeEffortConstraint;
  }

  const totalWish = [...desiredByMarketProduct.values()].reduce((s, b) => s + b.hoso + b.pd + b.vap, 0);
  const totalEffort = [...desiredByMarketProduct.values()].reduce((s, b) => s + salesEffortWeightedQuantity(b, P), 0);
  const effortByProduct = { hoso: 0, pd: 0, vap: 0 };
  for (const b of desiredByMarketProduct.values()) {
    for (const p of ["hoso", "pd", "vap"] as const) effortByProduct[p] += P.salesEffortCoefficients[p] * b[p];
  }

  const currentHc = d.decision.salesPlans.length > 0 ? d.decision.salesPlans[0].salesForceHeadcount : 0;
  // 会社の実在人数は、市場ごとに重複排除した配分の合計。
  const byMarket = new Map<DemandMarketId, number>();
  for (const p of d.decision.salesPlans) byMarket.set(p.market, p.salesForceHeadcount);
  const actualTotalHc = [...byMarket.values()].reduce((s, v) => s + v, 0);
  void currentHc;

  // 市場配分による能力ロス: 各市場の能力合計 − 実際に使われた工数
  let salesCapacity = 0;
  let usedCapacity = 0;
  for (const [market, headcount] of byMarket) {
    salesCapacity += unwrapUnit(processingCapacity(headcount, P));
    const byProduct = desiredByMarketProduct.get(market) ?? { hoso: 0, pd: 0, vap: 0 };
    usedCapacity += Math.min(unwrapUnit(processingCapacity(headcount, P)), salesEffortWeightedQuantity(byProduct, P));
  }

  rows.push({
    turn: d.turn,
    companyId: d.companyId,
    ambition: d.commercialAmbition?.ambitionTons ?? 0,
    submitted: d.decision.salesPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0),
    currentHc: actualTotalHc,
    requiredHc: requiredHeadcountFor(desiredByMarketProduct),
    hireCount: d.decision.salesForceHireCount ?? 0,
    layoffCount: d.decision.salesForceLayoffCount ?? 0,
    salesCapacity,
    usedCapacity,
    effortPerTon: totalWish > 0 ? totalEffort / totalWish : 0,
    effortShare: {
      hoso: totalEffort > 0 ? effortByProduct.hoso / totalEffort : 0,
      pd: totalEffort > 0 ? effortByProduct.pd / totalEffort : 0,
      vap: totalEffort > 0 ? effortByProduct.vap / totalEffort : 0,
    },
    allocationLoss: salesCapacity - usedCapacity,
    reasons: d.entries.filter((e) => e.code.startsWith("SALES_HIRING") || e.code.startsWith("SALES_LAYOFF") || e.code === "SALES_FORCE_EXCESS_CAPACITY").map((e) => e.code),
  });
}

console.log("\n【§11 初期状態（Q1）: 60人で何を処理できるか】");
console.log("  会社   希望販売  工数換算  1t あたり工数  営業人数  営業能力  必要人数  不足");
for (const r of rows.filter((x) => x.turn === 1)) {
  console.log(
    `  ${r.companyId.padEnd(6)}${n(r.submitted)} ${n(r.usedCapacity)} ${r.effortPerTon.toFixed(2).padStart(11)}  ${String(r.currentHc).padStart(8)} ${n(
      r.salesCapacity,
      9
    )} ${String(r.requiredHc).padStart(9)} ${String(r.requiredHc - r.currentHc).padStart(5)}`
  );
}

console.log("\n【§12 商品構成が必要工数へ与える影響（Q16）】");
console.log("  会社   HOSO工数%  PD工数%  VAP工数%  1t あたり工数");
for (const r of rows.filter((x) => x.turn === 16)) {
  console.log(
    `  ${r.companyId.padEnd(6)}${(r.effortShare.hoso * 100).toFixed(1).padStart(9)}% ${(r.effortShare.pd * 100).toFixed(1).padStart(7)}% ${(
      r.effortShare.vap * 100
    )
      .toFixed(1)
      .padStart(8)}% ${r.effortPerTon.toFixed(2).padStart(13)}`
  );
}

console.log("\n【§6 32Q Headcount Path】");
console.log("  Q  会社   Ambition  提出計画  現在人数 必要人数  不足  採用  営業能力  使用能力 配分ロス  採用の理由コード");
for (const turn of SHOW) {
  for (const r of rows.filter((x) => x.turn === turn)) {
    console.log(
      `  ${String(r.turn).padStart(2)} ${r.companyId.padEnd(6)}${n(r.ambition, 9)} ${n(r.submitted, 9)} ${String(r.currentHc).padStart(8)} ${String(
        r.requiredHc
      ).padStart(8)} ${String(r.requiredHc - r.currentHc).padStart(5)} ${String(r.hireCount).padStart(5)} ${n(r.salesCapacity, 9)} ${n(
        r.usedCapacity,
        9
      )} ${n(r.allocationLoss, 8)}  ${r.reasons.join(",")}`
    );
  }
  console.log("");
}

console.log("【§7 required > current なのに採用0だったターンの理由】");
const blocked = rows.filter((r) => r.requiredHc > r.currentHc && r.hireCount === 0);
const reasonCounts = new Map<string, number>();
for (const r of blocked) {
  const key = r.reasons.length > 0 ? r.reasons.join(",") : "(理由コードなし)";
  reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
}
console.log(`  該当ターン数: ${blocked.length} / ${rows.length}`);
for (const [reason, count] of [...reasonCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)} 件  ${reason}`);
}

console.log("\n【§9 工場1つ分を売るのに必要な営業人数】");
console.log("  会社  実効生産能力  必要営業人数(その量を売るため)  1人あたり実効販売量");
for (const companyId of [...new Set(rows.map((r) => r.companyId))]) {
  const r32 = rows.find((r) => r.companyId === companyId && r.turn === 32)!;
  const perPerson = r32.currentHc > 0 ? r32.submitted / r32.currentHc : 0;
  console.log(`  ${companyId.padEnd(6)}${n(r32.ambition, 11)} ${String(r32.requiredHc).padStart(28)} ${n(perPerson, 20)}`);
}
void result;
