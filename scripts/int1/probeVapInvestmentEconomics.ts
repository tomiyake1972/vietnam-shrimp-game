/**
 * 【VAP設備投資の割高さを実測する】
 *
 * 「VAP設備の投資が割高」という見立てを、カタログの単価だけでなく
 * engine 自身が計算する投資回収で確かめる。
 *
 * 測るもの
 *   1. 案件種別ごとの 投資額 / 追加能力 / 能力1tあたり単価
 *   2. 同じ案件の engine 算出値（限界利益 USD/t・増分CF USD/四半期・回収年数）
 *      → 画面の投資カードが出しているものと同一（investmentPlanningViewModel）
 *   3. 32Turn 実行後の実績: 商品別の販売量・売上・平均単価と、VAP能力の使われ方
 *
 * 研修で使う条件（dynamic-scenario-2 / tiered-v200-crowding-v1 / 全社Standard AI）
 * をそのまま使い、新しいseedや条件を勝手に決めない。
 * 共有DBへは接続しない。ゲーム計算は一切変更しない（読み取りのみ）。
 */
import { advanceSimulationTurns, createSimulationSession } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../app/lib/v2/companyLab/runner";
import { generateStandardAiDecision } from "../../app/lib/v2/companyLab/standardAi/policy";
import { buildInitialDraft } from "../../app/v2/company-lab/decisionDraft";
import { buildDecisionStudioViewModel } from "../../app/v2/company-lab/decisionStudioViewModel";
import { capexUnitCostUsdPerCapacityTon } from "../../app/v2/company-lab/investmentPlanningViewModel";
import { CAPEX_PARAMETERS_V1 } from "../../app/lib/v2/capex/parameters";
import { CAPITAL_PROJECT_TYPES } from "../../app/lib/v2/capex/types";
import type { CapitalProjectType } from "../../app/lib/v2/capex/types";
import { unwrapUnit } from "../../app/lib/v2/core/units";
import { unwrapUsd } from "../../app/lib/v2/finance/types";
import type { SimulationSession } from "../../app/lib/v2/companyLab/simulation/types";

const TS_AT = "2026-10-07T00:00:00.000Z";
const SCENARIO = "dynamic-scenario-2";
const SEED = "management-console-32q";
const MODEL = "tiered-v200-crowding-v1" as const;
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;

function usd(n: number | undefined): string {
  return n === undefined ? "—" : `$${Math.round(n).toLocaleString("en-US")}`;
}
function num(n: number | undefined, digits = 1): string {
  return n === undefined ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function newSession(runId: string): SimulationSession {
  const modes = Object.fromEntries(COMPANIES.map((c) => [c, "STANDARD_AI" as const]));
  return createSimulationSession({
    simulationRunId: runId,
    scenarioId: SCENARIO,
    seed: SEED,
    requestedTurns: 32,
    startedAt: TS_AT,
    sourceCommit: "VAP-PROBE",
    companyControlModes: modes,
    salesModelId: MODEL,
  });
}

/** 1. カタログの単価（engineの定数そのもの）。 */
function reportCatalogUnitCost(): void {
  console.log("## 1. カタログの単価（capex/parameters.ts の定数）");
  console.log("");
  console.log("案件種別                      投資額        追加能力(t/Q)   能力1tあたり");
  const rows: { type: CapitalProjectType; unit: number | undefined }[] = [];
  for (const type of CAPITAL_PROJECT_TYPES) {
    const tpl = CAPEX_PARAMETERS_V1.templatesByType[type];
    const cap = tpl.futureCapacityEffect.capacityIncreaseTonsPerQuarter ?? 0;
    const unit = capexUnitCostUsdPerCapacityTon(tpl.standardBudgetUsd, cap);
    rows.push({ type, unit });
    console.log(
      `${tpl.displayName.padEnd(22)} ${usd(tpl.standardBudgetUsd).padStart(12)} ${(cap > 0 ? num(cap, 0) : "—").padStart(14)} ${(unit === undefined ? "—" : `${usd(unit)} / t`).padStart(16)}`
    );
  }
  const vap = rows.find((r) => r.type === "vapLineExpansion")?.unit;
  const hoso = rows.find((r) => r.type === "hosoLineExpansion")?.unit;
  const pd = rows.find((r) => r.type === "pdLineExpansion")?.unit;
  console.log("");
  if (vap !== undefined && hoso !== undefined && pd !== undefined) {
    console.log(`VAP は HOSO の ${(vap / hoso).toFixed(1)} 倍、PD の ${(vap / pd).toFixed(1)} 倍の単価。`);
  }
  console.log("");
}

/** 2. engine が計算する投資回収（画面の投資カードと同じ値）。 */
function reportPayback(session: SimulationSession, turnLabel: string, companyId: string): void {
  const state = session.state;
  const fixture = session.fixtures.find((f) => f.companyId === companyId);
  if (!fixture) return;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const ai = generateStandardAiDecision(fixture, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  const vm = buildDecisionStudioViewModel({ fixture, ownState, draft, period: state.currentPeriod });

  console.log(`### ${turnLabel} / ${companyId}`);
  console.log("案件種別                  限界利益(USD/t)  増分CF(USD/Q)      回収年数  算定不能の理由");
  for (const card of vm.planning.investmentCards) {
    const p = card.payback;
    const tpl = CAPEX_PARAMETERS_V1.templatesByType[card.projectType];
    const reason = p.isComputable ? "" : (p.notComputableReason ?? "（理由の記録なし）");
    console.log(
      `${tpl.displayName.padEnd(20)} ${num(p.contributionMarginUsdPerTon, 0).padStart(14)} ${num(p.incrementalCashFlowUsdPerQuarter, 0).padStart(16)} ${(p.paybackYears === undefined ? "—" : p.paybackYears.toFixed(1)).padStart(9)}  ${reason}`
    );
  }
  console.log("");
}

/** 3. 32Turn 実行後の、商品別の実績。 */
function reportProductOutcomes(session: SimulationSession): void {
  const history = session.state.history;
  console.log("## 3. 32Turn 実行後の商品別実績（全社合計）");
  console.log("");
  const products = ["hoso", "pd", "vap"] as const;
  const totals: Record<string, { tons: number; revenue: number }> = { hoso: { tons: 0, revenue: 0 }, pd: { tons: 0, revenue: 0 }, vap: { tons: 0, revenue: 0 } };
  for (const record of history) {
    // CompanyQuarterRecord は「その四半期の全社ぶん」を持つ（契約自体が companyId を持つ）。
    for (const contract of record.salesRecord.newContracts) {
      const product = String(contract.product);
      if (!(product in totals)) continue;
      const tons = unwrapUnit(contract.originalQuantity);
      const price = unwrapUnit(contract.unitPrice);
      totals[product].tons += tons;
      totals[product].revenue += tons * 1000 * price;
    }
  }
  console.log("商品   販売量(t)        売上(USD)          平均単価(USD/kg)");
  for (const p of products) {
    const t = totals[p];
    const avg = t.tons > 0 ? t.revenue / (t.tons * 1000) : undefined;
    console.log(`${p.toUpperCase().padEnd(6)} ${num(t.tons, 0).padStart(12)} ${usd(t.revenue).padStart(18)} ${(avg === undefined ? "—" : avg.toFixed(2)).padStart(18)}`);
  }
  console.log("");
  console.log("（この四半期に新しく結ばれた契約の数量×単価。既存契約の履行分は含まない。）");
  console.log("");

  // --- 商品別の限界利益（管理会計。engineが四半期ごとに出している正本） ---
  console.log("## 4. 商品別の限界利益（32Turn合計・全社合計）");
  console.log("");
  const cm: Record<string, { revenue: number; variable: number; margin: number }> = {
    hoso: { revenue: 0, variable: 0, margin: 0 },
    pd: { revenue: 0, variable: 0, margin: 0 },
    vap: { revenue: 0, variable: 0, margin: 0 },
  };
  for (const record of history) {
    for (const fin of record.financialResults) {
      for (const row of fin.contributionMargin.byProduct) {
        const key = String(row.key).toLowerCase();
        if (!(key in cm)) continue;
        cm[key].revenue += unwrapUsd(row.netRevenue);
        cm[key].variable += unwrapUsd(row.variableCost);
        cm[key].margin += unwrapUsd(row.contributionMargin);
      }
    }
  }
  console.log("商品   純売上(USD)        変動費(USD)        限界利益(USD)      限界利益率  限界利益(USD/t)");
  const marginPerTon: Record<string, number | undefined> = {};
  for (const p of products) {
    const c = cm[p];
    const tons = totals[p].tons;
    const ratio = c.revenue > 0 ? c.margin / c.revenue : undefined;
    const perTon = tons > 0 ? c.margin / tons : undefined;
    marginPerTon[p] = perTon;
    console.log(
      `${p.toUpperCase().padEnd(6)} ${usd(c.revenue).padStart(18)} ${usd(c.variable).padStart(18)} ${usd(c.margin).padStart(18)} ${(ratio === undefined ? "—" : `${(ratio * 100).toFixed(1)}%`).padStart(11)} ${(perTon === undefined ? "—" : usd(perTon)).padStart(16)}`
    );
  }
  console.log("");

  // --- 能力1tあたり投資額 ÷ 年間限界利益 ＝ 回収年数相当 ---
  console.log("## 5. 能力1tを買う費用が、何年ぶんの限界利益にあたるか");
  console.log("");
  console.log("（能力1tあたり投資額 ÷（限界利益 USD/t × 4四半期）。フル稼働を前提にした上限の良さであり、");
  console.log("  実際には他の制約で稼働しないぶん、これより悪くなる。）");
  console.log("");
  console.log("案件種別                  単価(USD/t)   限界利益(USD/t/Q)   年あたり    回収年数相当");
  const lineByProduct: Record<string, CapitalProjectType> = { hoso: "hosoLineExpansion", pd: "pdLineExpansion", vap: "vapLineExpansion" };
  for (const p of products) {
    const type = lineByProduct[p];
    const tpl = CAPEX_PARAMETERS_V1.templatesByType[type];
    const unit = capexUnitCostUsdPerCapacityTon(tpl.standardBudgetUsd, tpl.futureCapacityEffect.capacityIncreaseTonsPerQuarter ?? 0);
    const perTon = marginPerTon[p];
    const perYear = perTon === undefined ? undefined : perTon * 4;
    const years = unit !== undefined && perYear !== undefined && perYear > 0 ? unit / perYear : undefined;
    console.log(
      `${tpl.displayName.padEnd(20)} ${(unit === undefined ? "—" : usd(unit)).padStart(12)} ${(perTon === undefined ? "—" : usd(perTon)).padStart(18)} ${(perYear === undefined ? "—" : usd(perYear)).padStart(12)} ${(years === undefined ? "—" : `${years.toFixed(1)} 年`).padStart(14)}`
    );
  }
  console.log("");
}

function main(): void {
  console.log("# VAP設備投資の割高さ — 実測");
  console.log(`# scenario=${SCENARIO} / seed=${SEED} / salesModelId=${MODEL} / 全社Standard AI / 32Turn`);
  console.log("# 条件は run32TurnRegression.ts の Run A と同一（新しいseed・条件を決めていない）");
  console.log("");

  reportCatalogUnitCost();

  console.log("## 2. engine が計算する投資回収（画面の投資カードと同じ値）");
  console.log("");
  // Turn1時点（前四半期の実績が無いため算定不能になる項目がある）
  reportPayback(newSession("vap-probe-t1"), "Turn 1", "BAL");

  const after8 = advanceSimulationTurns({ session: newSession("vap-probe-8"), turns: 8, timestamp: TS_AT, sourceCommit: "VAP-PROBE" });
  reportPayback(after8, "Turn 9（8Turn進行後）", "BAL");
  reportPayback(after8, "Turn 9（8Turn進行後）", "VAP");

  const after20 = advanceSimulationTurns({ session: newSession("vap-probe-20"), turns: 20, timestamp: TS_AT, sourceCommit: "VAP-PROBE" });
  reportPayback(after20, "Turn 21（20Turn進行後）", "BAL");
  reportPayback(after20, "Turn 21（20Turn進行後）", "VAP");

  const after32 = advanceSimulationTurns({ session: newSession("vap-probe-32"), turns: 32, timestamp: TS_AT, sourceCommit: "VAP-PROBE" });
  console.log(`（32Turn 実行: completedTurns=${after32.run.completedTurns} / stopReason=${after32.run.stopReason}）`);
  console.log("");
  reportProductOutcomes(after32);
}

main();
