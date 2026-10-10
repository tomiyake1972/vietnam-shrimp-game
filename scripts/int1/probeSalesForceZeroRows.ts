/**
 * 【UI-TRIAL-1 §2】確認画面の説明を実挙動に合わせるための実測。
 * 「販売数量が0の行でも営業配員を入力できる」場合、その配員が実際にどう提出されるかを
 * buildDecisionInputFromDraft（提出値を作る唯一の関数）で確かめる。推測しない。
 */
import { buildDecisionInputFromDraft, buildInitialDraft, summarizeSalesForceAllocation } from "../../app/v2/company-lab/decisionDraft";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../app/lib/v2/companyLab";
import { generateStandardAiDecision } from "../../app/lib/v2/companyLab/standardAi/policy";
import { validateSalesForceHeadcountBudget } from "../../app/lib/v2/sales/salesForce";

const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "probe-sf", turns: 6 });
const fixture = fixtures.find((f) => f.companyId === "BAL")!;
const ownState = buildCompanyOwnState(state, fixture);
const ai = generateStandardAiDecision(fixture, ownState, buildPublicMarketInfo(state), state.currentPeriod, 1);
const base = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);

function headcountByMarket(plans: readonly { market: string; salesForceHeadcount: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of plans) out[p.market] = p.salesForceHeadcount;
  return out;
}

const markets = Array.from(new Set(base.salesPlans.map((p) => p.market)));
console.log("# 市場一覧:", markets.join(", "));
console.log("# 下書きの配員:", JSON.stringify(headcountByMarket(base.salesPlans)));

// ケースA: CN市場の全商品の数量を0にする（配員は残す）
const a = {
  ...base,
  salesPlans: base.salesPlans.map((p) => (p.market === "CN" ? { ...p, desiredQuantity: 0, salesForceHeadcount: 9 } : p)),
};
const decA = buildDecisionInputFromDraft(a, fixture, state.currentPeriod);
console.log("\n## ケースA: CN の全商品が数量0・配員9人");
console.log("   下書き側の集計（画面表示）:", JSON.stringify(summarizeSalesForceAllocation(a.salesPlans, ownState.salesForceHiringState.headcount)));
console.log("   提出される salesPlans の行数:", decA.salesPlans.length, "（下書き", a.salesPlans.length, "行）");
console.log("   提出される市場:", Array.from(new Set(decA.salesPlans.map((p) => p.market))).join(", "));
console.log("   提出される配員:", JSON.stringify(headcountByMarket(decA.salesPlans as never)));
console.log("   → CN の配員9人は提出値に含まれるか:", Object.prototype.hasOwnProperty.call(headcountByMarket(decA.salesPlans as never), "CN"));

// ケースB: CN市場の1商品だけ数量>0（配員は同じ9人）
const b = {
  ...base,
  salesPlans: base.salesPlans.map((p) =>
    p.market === "CN" ? { ...p, desiredQuantity: p.product === "hoso" ? 100 : 0, salesForceHeadcount: 9 } : p
  ),
};
const decB = buildDecisionInputFromDraft(b, fixture, state.currentPeriod);
console.log("\n## ケースB: CN の HOSO だけ数量100・他0・配員9人");
console.log("   提出される CN の行数:", decB.salesPlans.filter((p) => p.market === "CN").length);
console.log("   提出される配員:", JSON.stringify(headcountByMarket(decB.salesPlans as never)));

// engine 側の予算検証が、提出値をどう数えるか
const available = ownState.salesForceHiringState.headcount;
// validateSalesForceHeadcountBudget は戻り値を返さず、違反時に例外を投げる。
for (const [label, dec] of [["A", decA], ["B", decB]] as const) {
  try {
    validateSalesForceHeadcountBudget(dec.salesPlans as never, available);
    console.log(`\n## engine の予算検証（ケース${label}・配分可能 ${available}人）: 通過（例外なし）`);
  } catch (e) {
    console.log(`\n## engine の予算検証（ケース${label}）: 例外`, e instanceof Error ? e.message : String(e));
  }
}

// 提出値から engine が数える「市場ごとに重複排除した合計」。
for (const [label, dec] of [["A", decA], ["B", decB]] as const) {
  const byMarket = new Map<string, number>();
  for (const p of dec.salesPlans) byMarket.set(p.market, p.salesForceHeadcount);
  const total = Array.from(byMarket.values()).reduce((s2, h) => s2 + h, 0);
  console.log(`   ケース${label}: engine が数える配員合計 = ${total}人`);
}
