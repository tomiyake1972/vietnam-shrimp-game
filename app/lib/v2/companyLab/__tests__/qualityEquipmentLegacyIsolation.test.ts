// ShrimpX V2 — TIERED-MKT-P1D §12 legacy mode 隔離（runner レベル）
//
// 品質管理設備の「市場評価」直接ボーナスは tiered market 正式候補の検証用にのみ
// 接続する。legacyWaterfall の成約配分は 1bit も変わらないことを、同一 state に
// 完成済み qualityControlEquipment 案件を注入した対照実験で固定する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { period as makePeriod, toYearQuarter } from "../../core/period";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState } from "../types";
import { CapitalProject } from "../../capex/types";
import { SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1 } from "../../sales/parameters";
import { unwrapUnit } from "../../core/units";

/** 完成済み・フルランプ到達済みの品質管理設備案件を state.capexState へ注入する。 */
function withQualityEquipment(state: CompanyLabState, companyId: string, factoryId: string): CompanyLabState {
  const yq = toYearQuarter(state.currentPeriod);
  const completed = makePeriod(yq.year - 1, yq.quarter); // 4Q前に完成＝当期はフルランプ
  const project = {
    projectId: "QE-TEST-1",
    companyId,
    projectType: "qualityControlEquipment",
    approvedBudgetUsd: 1_000_000,
    paymentSchedule: [],
    completedPaymentStagesCount: 2,
    cumulativePaidUsd: 1_000_000,
    elapsedConstructionQuartersWithPayment: 2,
    requiredConstructionQuarters: 2,
    status: "completed",
    proposedPeriod: completed,
    approvedPeriod: completed,
    completedPeriod: completed,
    capitalizedAmountUsd: 1_000_000,
    targetFactoryId: factoryId,
    futureCapacityEffect: { capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 },
    lastDiagnosticReasons: [],
    priority: 1,
  } as unknown as CapitalProject;
  return {
    ...state,
    capexState: {
      ...state.capexState,
      companies: state.capexState.companies.map((c) =>
        c.companyId === companyId ? { ...c, portfolio: { ...c.portfolio, projects: [...c.portfolio.projects, project] } } : c
      ),
    },
  };
}

function runOneQuarter(tiered: boolean, withEquipment: boolean) {
  const config = {
    scenarioId: "baseline",
    mode: "canonical",
    seed: "qe-isolation",
    turns: 2,
    ...(tiered ? { salesParamsOverride: SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1 } : {}),
  } as CompanyLabConfig;
  const init = initializeCompanyLab(config);
  const target = init.fixtures[0];
  let state: CompanyLabState = withEquipment ? withQualityEquipment(init.state, target.companyId, target.factories[0].factoryId) : init.state;
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of init.fixtures) {
    decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, 1);
  }
  state = advanceCompanyLabQuarter(state, init.fixtures, decisions);
  return state.history[state.history.length - 1];
}

const allocationKey = (record: ReturnType<typeof runOneQuarter>) =>
  JSON.stringify(
    record.salesRecord.allocations.map((a) => ({
      market: a.market,
      product: a.product,
      external: unwrapUnit(a.externalOptionQuantity),
      companies: a.companies.map((c) => [c.companyId, unwrapUnit(c.allocatedQuantity), c.competitivenessWeight]),
    }))
  );

// =====================================================================

test("P1D-QE-11: legacy mode では品質設備 direct bonus が成約配分へ一切入らない", () => {
  assert.equal(allocationKey(runOneQuarter(false, true)), allocationKey(runOneQuarter(false, false)));
});

test("P1D-QE-12: tiered mode では同じ設備が成約配分へ効く（対照実験が空振りでない）", () => {
  assert.notEqual(allocationKey(runOneQuarter(true, true)), allocationKey(runOneQuarter(true, false)));
});
