/**
 * 【UI-CLARITY-1 A-8】Turn1の市場参照価格を入れたことによる影響の実測。
 *
 * A-8は「Turn1の市場基準価格を画面に出す」変更だが、情報境界の原則により
 * 同じ値を Standard AI にも渡す。Standard AI の Turn1 入力が変わる＝ゲーム結果が
 * 変わるため、変更前後で同じ比較を行って差を実測する必要がある。
 *
 * このスクリプトは単独では「前後」を出せない（前の状態のコードを持っていない）。
 * 使い方は、変更後のworktreeと、変更前のcommitをcheckoutした一時worktreeの
 * 両方で同じコマンドを実行し、出力を比較する。
 *
 * 出力:
 *   [1] Turn1にStandard AIが見る市場×商品参照価格（変更前は「未提供」）
 *   [2] Turn1のStandard AI販売計画（5社×市場×商品の希望量・価格調整）の要約
 *   [3] 32Turn（全社Standard AI・dynamic-scenario-2・seed management-console-32q）の最終指標
 *
 * Scenario指数・費用曲線・AI判断ロジック・価格エンジンの式は変更していない。
 */
import { advanceSimulationTurns, createSimulationSession } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../app/lib/v2/companyLab/standardAi/policy";
// 変更前のcommitではこの関数はexportされていない（export追加もA-8の変更の一部）。
// 同じスクリプトを変更前のworktreeでも動かすため、存在しない場合は「未提供」とする。
import * as observationModule from "../../app/lib/v2/companyLab/standardAi/observation";
import { DEMAND_MARKET_IDS } from "../../app/lib/v2/market/types";
import { unwrapUsd } from "../../app/lib/v2/finance/types";
import { unwrapUnit } from "../../app/lib/v2/core/units";
import type { SimulationSession } from "../../app/lib/v2/companyLab/simulation/types";
import type { DemandMarketId, Product } from "../../app/lib/v2/market/types";

const TS_AT = "2026-10-11T00:00:00.000Z";
const SCENARIO = "dynamic-scenario-2";
const SEED = "management-console-32q";
const MODEL = "tiered-v200-crowding-v1" as const;
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
const M = (n: number) => (n / 1e6).toFixed(2);

function newSession(runId: string): SimulationSession {
  const modes = Object.fromEntries(COMPANIES.map((c) => [c, "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">;
  return createSimulationSession({
    simulationRunId: runId,
    scenarioId: SCENARIO,
    seed: SEED,
    requestedTurns: 32,
    startedAt: TS_AT,
    sourceCommit: "A8-PROBE",
    companyControlModes: modes,
    salesModelId: MODEL,
  });
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------- [1]
section("[1] Turn1にStandard AIが見る市場×商品参照価格（USD/kg）");
const referencePricesFn = (observationModule as Record<string, unknown>).referencePricesByMarketProduct;
const aiView =
  typeof referencePricesFn === "function"
    ? (referencePricesFn as (r: undefined) => Record<string, Record<Product, number>> | undefined)(undefined)
    : undefined;
if (aiView === undefined) {
  console.log("未提供（この版ではTurn1に参照価格が無い）");
} else {
  console.log(["市場", ...PRODUCTS.map((p) => p.toUpperCase())].map((h) => h.padStart(9)).join(""));
  for (const market of DEMAND_MARKET_IDS) {
    const row = aiView[market];
    console.log([market, ...PRODUCTS.map((p) => (row ? row[p].toFixed(3) : "－"))].map((c) => c.padStart(9)).join(""));
  }
}

// ---------------------------------------------------------------- [2]
section("[2] Turn1のStandard AI販売計画（希望量t / 価格調整$/kgの数量加重平均）");
{
  const session = newSession("a8-probe-turn1");
  console.log(["会社", "総希望量t", ...PRODUCTS.map((p) => `${p}:t`), "調整加重平均", "市場数"].map((h) => h.padStart(12)).join(""));
  for (const companyId of COMPANIES) {
    const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
    const ownState = buildCompanyOwnState(session.state, fixture);
    const decision = generateStandardAiDecisionWithDiagnostics(
      fixture,
      ownState,
      buildPublicMarketInfo(session.state),
      session.state.currentPeriod,
      session.state.scenarioState.currentTurn
    ).decision;
    let total = 0;
    let adjWeighted = 0;
    const byProduct: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
    const markets = new Set<DemandMarketId>();
    for (const plan of decision.salesPlans) {
      const tons = unwrapUnit(plan.desiredQuantity) as number;
      if (tons <= 0) continue;
      total += tons;
      byProduct[plan.product] += tons;
      adjWeighted += tons * plan.priceAdjustmentUsdPerHosoEqKg;
      markets.add(plan.market);
    }
    console.log(
      [
        companyId,
        Math.round(total).toLocaleString(),
        ...PRODUCTS.map((p) => Math.round(byProduct[p]).toLocaleString()),
        total > 0 ? (adjWeighted / total).toFixed(4) : "0",
        String(markets.size),
      ]
        .map((c) => c.padStart(12))
        .join("")
    );
  }
}

// ---------------------------------------------------------------- [3]
section("[3] 32Turn 全社Standard AI 最終指標（$M・t）");
{
  const final = advanceSimulationTurns({ session: newSession("a8-probe-32q"), turns: 32, timestamp: TS_AT, sourceCommit: "A8-PROBE" });
  const last = final.state.history[final.state.history.length - 1];
  console.log(`実行Turn数: ${final.state.history.length}`);
  console.log(["会社", "自己資本$M", "現金$M", "有利子負債$M", "累積純利益$M", "累積純売上$M"].map((h) => h.padStart(14)).join(""));
  let equitySum = 0;
  let niSum = 0;
  let revSum = 0;
  for (const companyId of COMPANIES) {
    const fr = last.financialResults.find((f) => f.companyId === companyId)!;
    let ni = 0;
    let rev = 0;
    for (const record of final.state.history) {
      const f = record.financialResults.find((x) => x.companyId === companyId);
      if (!f) continue;
      ni += unwrapUsd(f.profitAndLoss.netIncome);
      rev += unwrapUsd(f.profitAndLoss.netRevenue);
    }
    const equity = unwrapUsd(fr.balanceSheet.totalEquity);
    equitySum += equity;
    niSum += ni;
    revSum += rev;
    console.log(
      [
        companyId,
        M(equity),
        M(unwrapUsd(fr.balanceSheet.cash)),
        M(unwrapUsd(fr.balanceSheet.shortTermLoans) + unwrapUsd(fr.balanceSheet.longTermLoans)),
        M(ni),
        M(rev),
      ]
        .map((c) => c.padStart(14))
        .join("")
    );
  }
  console.log(["5社合計", M(equitySum), "", "", M(niSum), M(revSum)].map((c) => c.padStart(14)).join(""));

  let fulfilled = 0;
  let newContracted = 0;
  for (const record of final.state.history) {
    for (const c of record.companySummaries) {
      fulfilled += unwrapUnit(c.fulfilledQuantity) as number;
      newContracted += unwrapUnit(c.newContractedQuantity) as number;
    }
  }
  console.log(`累積履行量 ${Math.round(fulfilled).toLocaleString()} t / 累積新規成約量 ${Math.round(newContracted).toLocaleString()} t`);
}
