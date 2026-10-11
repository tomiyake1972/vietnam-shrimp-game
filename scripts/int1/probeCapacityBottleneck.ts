/**
 * 【■4の検証】「加工能力は一度もボトルネックにならない」のか、
 * それとも「決定時点の在庫だけで見ているから、そう見える」だけなのか。
 *
 * processingForecastViewModel.ts:495 にこう書かれている:
 *   「原料在庫は『現時点の在庫』で計算しています。当期の国内買付・輸入到着ぶんは、
 *     四半期処理の中で買付・入庫が確定してから原料在庫へ加わるため、
 *     この見込みには含まれていません（実際の処理量は増える可能性があります）。」
 *
 * そこで、手元の原料在庫を増やした場合にボトルネックが移るかを実測する。
 * 移るなら「原料は買えば解消する」が正しく、加工能力は条件次第で効く。
 * ゲーム計算は変更せず、view model への入力だけを変えて見る。
 */
import { advanceSimulationTurns, createSimulationSession } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildCompanyOwnState } from "../../app/lib/v2/companyLab/runner";
import { buildPublicMarketInfo } from "../../app/lib/v2/companyLab";
import { generateStandardAiDecision } from "../../app/lib/v2/companyLab/standardAi/policy";
import { buildInitialDraft } from "../../app/v2/company-lab/decisionDraft";
import { buildDecisionStudioViewModel } from "../../app/v2/company-lab/decisionStudioViewModel";
import { hosoEqTons, unwrapUnit } from "../../app/lib/v2/core/units";
import type { SimulationSession } from "../../app/lib/v2/companyLab/simulation/types";
import type { CompanyOwnState } from "../../app/lib/v2/companyLab/types";

const TS_AT = "2026-10-07T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;

function newSession(): SimulationSession {
  return createSimulationSession({
    simulationRunId: "bottleneck-probe",
    scenarioId: "dynamic-scenario-2",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: TS_AT,
    sourceCommit: "BOTTLENECK-PROBE",
    companyControlModes: Object.fromEntries(COMPANIES.map((c) => [c, "STANDARD_AI" as const])),
    salesModelId: "tiered-v200-crowding-v1",
  });
}

/** 原料在庫だけを倍にした ownState を作る（他は一切変えない）。 */
function withScaledRawMaterial(ownState: CompanyOwnState, factor: number): CompanyOwnState {
  return {
    ...ownState,
    rawMaterialLots: ownState.rawMaterialLots.map((lot) => ({
      ...lot,
      originalQuantity: hosoEqTons(unwrapUnit(lot.originalQuantity) * factor),
      remainingQuantity: hosoEqTons(unwrapUnit(lot.remainingQuantity) * factor),
    })),
  };
}

function reasonFor(ownState: CompanyOwnState, session: SimulationSession, companyId: string): string {
  const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
  const publicInfo = buildPublicMarketInfo(session.state);
  const ai = generateStandardAiDecision(fixture, ownState, publicInfo, session.state.currentPeriod, session.state.scenarioState.currentTurn);
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  const vm = buildDecisionStudioViewModel({ fixture, ownState, draft, period: session.state.currentPeriod });
  const card = vm.planning.investmentCards.find((c) => c.projectType === "vapLineExpansion");
  const p = card?.payback;
  if (p === undefined) return "（カードが見つからない）";
  if (p.isComputable) {
    return `算定できる: 増分CF ${Math.round(p.incrementalCashFlowUsdPerQuarter ?? 0).toLocaleString("en-US")} USD/Q / 回収 ${p.paybackYears?.toFixed(1) ?? "—"} 年`;
  }
  return `算定不能: ${p.notComputableReason ?? "（理由なし）"}`;
}

function main(): void {
  console.log("# 加工能力はボトルネックになり得るか（VAPライン増設のカードで見る）");
  console.log("# 変えるのは「手元の原料在庫」だけ。ゲーム計算・意思決定は変更しない。");
  console.log("");

  const session = advanceSimulationTurns({ session: newSession(), turns: 8, timestamp: TS_AT, sourceCommit: "BOTTLENECK-PROBE" });
  for (const companyId of ["BAL", "VAP"]) {
    const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
    const base = buildCompanyOwnState(session.state, fixture);
    const onHand = base.rawMaterialLots.reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
    console.log(`## ${companyId}（Turn 9時点 / 手元の原料在庫 ${Math.round(onHand).toLocaleString("en-US")} t）`);
    for (const factor of [1, 2, 5, 10, 50]) {
      const scaled = factor === 1 ? base : withScaledRawMaterial(base, factor);
      console.log(`   在庫 ×${String(factor).padStart(2)} : ${reasonFor(scaled, session, companyId)}`);
    }
    console.log("");
  }
}

main();
