// ShrimpX V2 — Phase 6 §3 Commercial Growth Audit
//
// 「なぜ成長志向の会社が、成長する市場で販売数量を伸ばせないのか」を、
// コードを変更する前に実測で特定する。**推測値は出さない。**
//
// 追跡する pipeline:
//   TRUE MARKET DEMAND → OBSERVABLE DEMAND → ATTAINABLE DEMAND
//   → 制約前の希望販売量 → 営業工数制約後 → 提出販売計画
//   → 成約 → 納品 → 稼働率
//
// Standard AI をもう一度回すのではなく、**実際にゲームへ提出された判断そのもの**を
// 記録するため、decisionProvider を包んで観測・診断を拾う。

import fs from "node:fs";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../app/lib/v2/companyLab/runner";
import { CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { buildStandardAiObservation } from "../app/lib/v2/companyLab/standardAi/observation";
import { computePressureScores } from "../app/lib/v2/companyLab/standardAi/pressures";
import { buildStandardAiSalesPlans } from "../app/lib/v2/companyLab/standardAi/decision/sales";
import { STANDARD_AI_PARAMETERS_V1 } from "../app/lib/v2/companyLab/standardAi/parameters";
import { SALES_PARAMETERS_V1 } from "../app/lib/v2/sales/parameters";
import { sumProductAmount } from "../app/lib/v2/companyLab/standardAi/types";
import { unwrapUnit } from "../app/lib/v2/core/units";

const TURNS = Number(process.env.AUDIT_TURNS ?? 32);
const SHOW = (process.env.AUDIT_TURNS_SHOW ?? "1,8,16,24,32").split(",").map(Number);

interface AuditRow {
  turn: number;
  companyId: string;
  /** 自社の名目能力合計（3品目）。希望販売量の起点になっている疑いのある値。 */
  nominalCapacityTotal: number;
  effectiveCapacityTotal: number;
  /** 観測できた市場×商品の需要合計（2四半期遅行）。 */
  observableDemandTotal: number;
  /** 観測需要 × maximumSupplierShare の合計。 */
  attainableDemandTotal: number;
  /** うち期待貢献が正の分だけ（採算の取れる機会）。 */
  attainableProfitableTotal: number;
  /** 制約前の希望販売量（sales.ts の desiredByProduct）。 */
  desiredBeforeConstraints: number;
  /** 在庫上乗せ後・営業工数制約前（市場按分の入力）。 */
  plannedBeforeEffort: number;
  /** 営業工数制約後（realisticSalesByProduct）。 */
  salesEffortConstrained: number;
  /** 実際に提出した販売計画の合計。 */
  submittedSales: number;
  salesHeadcount: number;
  /** 当期成約。 */
  contracted: number;
  /** 当期納品。 */
  delivered: number;
  production: number;
  utilizationVsEffective: number;
}

const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "management-console-32q", turns: TURNS };
const rows: AuditRow[] = [];

const result = runCompanyLabWithAutoPolicyForAllCompanies(config, (fixture, ownState, publicInfo, period, turn) => {
  const observation = buildStandardAiObservation(fixture, ownState, publicInfo, period, turn);
  const pressures = computePressureScores(observation, fixture, STANDARD_AI_PARAMETERS_V1);
  // 実際に提出される販売計画と**同じ関数・同じ引数**で再現する（別ロジックを作らない）。
  const sales = buildStandardAiSalesPlans(fixture, observation, pressures, STANDARD_AI_PARAMETERS_V1, SALES_PARAMETERS_V1);

  const share = SALES_PARAMETERS_V1.maximumSupplierShare;
  let observableDemandTotal = 0;
  let attainableDemandTotal = 0;
  let attainableProfitableTotal = 0;
  for (const m of observation.markets) {
    for (const product of ["hoso", "pd", "vap"] as const) {
      const demand = m.observedDemandByProduct?.[product] ?? 0;
      if (demand <= 0) continue;
      observableDemandTotal += demand;
      attainableDemandTotal += demand * share;
      const price = m.referencePriceByProduct?.[product];
      const cost = observation.productEconomics.expectedProcessingCostUsdPerHosoEqKg[product];
      // 参照価格が未観測の turn は採算を判定できないため、採算つき機会には数えない
      // （推測で埋めない）。
      if (price !== undefined && price - cost > 0) attainableProfitableTotal += demand * share;
    }
  }

  const submitted = sales.salesPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
  rows.push({
    turn,
    companyId: fixture.companyId,
    nominalCapacityTotal: sumProductAmount({ ...observation.totalCapacityByProduct }),
    effectiveCapacityTotal: sumProductAmount({ ...observation.totalEffectiveCapacityByProduct }),
    observableDemandTotal,
    attainableDemandTotal,
    attainableProfitableTotal,
    desiredBeforeConstraints: sumProductAmount(sales.desiredByProduct),
    plannedBeforeEffort: sales.salesWishByMarketProduct.reduce((s, w) => s + w.desiredQuantityBeforeEffortConstraint, 0),
    salesEffortConstrained: sumProductAmount(sales.realisticSalesByProduct),
    submittedSales: submitted,
    salesHeadcount: observation.salesForceHeadcountTotal,
    contracted: 0,
    delivered: 0,
    production: 0,
    utilizationVsEffective: 0,
  });

  return generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn).decision;
});

// --- 実績（成約・納品・生産）を確定履歴から埋める ---
for (const record of result.history) {
  for (const summary of record.companySummaries) {
    const row = rows.find((r) => r.turn === record.turn && r.companyId === summary.companyId);
    if (!row) continue;
    row.contracted = unwrapUnit(summary.newContractedQuantity);
    row.delivered = unwrapUnit(summary.fulfilledQuantity);
    row.production = unwrapUnit(summary.hosoProduced) + unwrapUnit(summary.pdProduced) + unwrapUnit(summary.vapProduced);
    row.utilizationVsEffective = row.effectiveCapacityTotal > 0 ? row.production / row.effectiveCapacityTotal : 0;
  }
}

const n = (v: number, w = 7) => Math.round(v).toLocaleString().padStart(w);

console.log("=== Phase 6 Commercial Growth Audit（baseline / seed=management-console-32q）===\n");

console.log("【A】制約前の希望販売量は何から決まっているか");
console.log("  desiredBeforeConstraints と 名目能力×0.8 を比較する（一致すれば需要非依存の供給側アンカー）\n");
console.log("  Q  会社   名目能力  ×0.8      希望販売  差    観測需要  獲得可能  採算つき");
for (const turn of SHOW) {
  for (const r of rows.filter((x) => x.turn === turn)) {
    const anchor = r.nominalCapacityTotal * STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget;
    console.log(
      `  ${String(r.turn).padStart(2)} ${r.companyId.padEnd(6)}${n(r.nominalCapacityTotal)} ${n(anchor)} ${n(r.desiredBeforeConstraints)} ${n(
        r.desiredBeforeConstraints - anchor,
        5
      )} ${n(r.observableDemandTotal, 9)} ${n(r.attainableDemandTotal, 9)} ${n(r.attainableProfitableTotal, 9)}`
    );
  }
  console.log("");
}

console.log("【B】pipeline 各段での目減り（1社の 32Q 全体像は下の CSV を参照）\n");
console.log("  Q  会社   希望(制約前) 在庫上乗せ後 営業制約後  提出計画   成約     納品     生産   稼働率  営業人数");
for (const turn of SHOW) {
  for (const r of rows.filter((x) => x.turn === turn)) {
    console.log(
      `  ${String(r.turn).padStart(2)} ${r.companyId.padEnd(6)}${n(r.desiredBeforeConstraints, 9)} ${n(r.plannedBeforeEffort, 11)} ${n(
        r.salesEffortConstrained,
        10
      )} ${n(r.submittedSales, 9)} ${n(r.contracted, 8)} ${n(r.delivered, 8)} ${n(r.production, 7)} ${(r.utilizationVsEffective * 100)
        .toFixed(1)
        .padStart(6)}% ${String(r.salesHeadcount).padStart(6)}`
    );
  }
  console.log("");
}

console.log("【C】希望販売量の固定性（会社ごとの Q5〜Q32 の最小・最大・変動幅）\n");
for (const companyId of [...new Set(rows.map((r) => r.companyId))]) {
  const values = rows.filter((r) => r.companyId === companyId && r.turn >= 5).map((r) => r.desiredBeforeConstraints);
  const min = Math.min(...values);
  const max = Math.max(...values);
  console.log(`  ${companyId.padEnd(6)} min ${n(min)}  max ${n(max)}  幅 ${n(max - min, 6)}（${(((max - min) / min) * 100).toFixed(1)}%）`);
}

console.log("\n【D】提出計画 vs 成約（市場で負けているのか、そもそも出していないのか）\n");
console.log("  会社   Σ提出計画   Σ成約     成約/提出   Σ獲得可能(採算つき)  提出/獲得可能");
for (const companyId of [...new Set(rows.map((r) => r.companyId))]) {
  const rs = rows.filter((r) => r.companyId === companyId);
  const submitted = rs.reduce((s, r) => s + r.submittedSales, 0);
  const contracted = rs.reduce((s, r) => s + r.contracted, 0);
  const attainable = rs.reduce((s, r) => s + r.attainableProfitableTotal, 0);
  console.log(
    `  ${companyId.padEnd(6)}${n(submitted, 10)} ${n(contracted, 9)} ${((contracted / submitted) * 100).toFixed(1).padStart(9)}% ${n(
      attainable,
      20
    )} ${((submitted / attainable) * 100).toFixed(1).padStart(12)}%`
  );
}

if (process.env.AUDIT_CSV) {
  const header = Object.keys(rows[0]).join(",");
  const body = rows.map((r) => Object.values(r).join(",")).join("\n");
  fs.writeFileSync(process.env.AUDIT_CSV, `${header}\n${body}\n`);
  console.log(`\nCSV: ${process.env.AUDIT_CSV}`);
}
