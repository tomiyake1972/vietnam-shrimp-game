// ShrimpX V2 — Player工場操作Phase 1: factoryOperationsViewModel.ts のテスト
//
// 新しい計算式を持たないことを確認する（既存Engine SSoTと同じ値になることの
// クロスチェック）。特にFAC-VM-7は、UIが候補として出す操作が既存の
// validateFactoryLifecycleDecision（唯一の正式判定）と矛盾しないことを保証する
// 回帰ガードである。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeCompanyLab, buildCompanyOwnState } from "../../../lib/v2/companyLab/runner";
import { CompanyFixture, CompanyLabConfig, CompanyLabState } from "../../../lib/v2/companyLab/types";
import { previousPeriod } from "../../../lib/v2/core/period";
import { unwrapUsd } from "../../../lib/v2/finance/types";
import { CAPEX_PARAMETERS_V1 } from "../../../lib/v2/capex";
import {
  FACTORY_LIFECYCLE_PARAMETERS_V1,
  FactoryLifecycleDecisionRecord,
  validateFactoryLifecycleDecision,
} from "../../../lib/v2/capex/factoryLifecycle";
import { computeFactoryAssetProjection } from "../../../lib/v2/capex/factoryAssetProjection";
import { FINANCE_PARAMETERS_V1, normalCashFixedFactoryCostUsdPerQuarter } from "../../../lib/v2/finance/parameters";
import { buildFactoryOperationsViewModel } from "../factoryOperationsViewModel";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed: "factory-vm-001", turns: 8, ...overrides };
}

function withSecondFactory(fixtures: readonly CompanyFixture[], companyId: string): CompanyFixture[] {
  return fixtures.map((f) => {
    if (f.companyId !== companyId) return { ...f };
    const f1 = f.factories[0];
    return { ...f, factories: [f1, { ...f1, factoryId: `${companyId}-F2` }] };
  });
}

function setup(companyId: string, decisions: readonly FactoryLifecycleDecisionRecord[] = []) {
  const init = initializeCompanyLab(baseConfig());
  const fixtures = withSecondFactory(init.fixtures, companyId);
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const state: CompanyLabState = { ...init.state, factoryLifecycleState: { companies: [{ companyId, decisions }] } };
  const ownState = buildCompanyOwnState(state, fixture);
  const turn = state.scenarioState.currentTurn;
  const vm = buildFactoryOperationsViewModel(fixture, ownState, state.currentPeriod, turn);
  return { state, fixture, ownState, vm, turn };
}

test("FAC-VM-1: OPERATINGの工場（2工場保有・未完了capexなし）は、休止と売却の両方が候補になる", () => {
  const companyId = "BAL";
  const { vm, fixture } = setup(companyId);
  const f2 = fixture.factories[1].factoryId;
  const row = vm.rows.find((r) => r.factoryId === f2)!;
  assert.equal(row.lifecycleStatus, "OPERATING");
  assert.deepEqual(new Set(row.availableActions), new Set(["MOTHBALL_FACTORY", "SELL_FACTORY"]));
});

test("FAC-VM-2: MOTHBALLEDの工場は、再稼働だけが候補になる", () => {
  const companyId = "MASS";
  const init = initializeCompanyLab(baseConfig());
  const fixtures = withSecondFactory(init.fixtures, companyId);
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const f2 = fixture.factories[1].factoryId;
  const decidedPeriod = previousPeriod(init.state.currentPeriod);
  const { vm } = setup(companyId, [{ factoryId: f2, type: "MOTHBALL_FACTORY", decidedPeriod }]);
  const row = vm.rows.find((r) => r.factoryId === f2)!;
  assert.equal(row.lifecycleStatus, "MOTHBALLED");
  assert.deepEqual(row.availableActions, ["REACTIVATE_FACTORY"]);
});

test("FAC-VM-3: SALE_PENDINGの工場は候補が無く、売却完了予定Turnが決定期+2Turnになる", () => {
  const companyId = "BAL";
  const init = initializeCompanyLab(baseConfig());
  const fixtures = withSecondFactory(init.fixtures, companyId);
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const f2 = fixture.factories[1].factoryId;
  const decidedPeriod = previousPeriod(init.state.currentPeriod);
  const { vm, turn } = setup(companyId, [{ factoryId: f2, type: "SELL_FACTORY", decidedPeriod }]);
  const row = vm.rows.find((r) => r.factoryId === f2)!;
  assert.equal(row.lifecycleStatus, "SALE_PENDING");
  assert.deepEqual(row.availableActions, []);
  assert.equal(row.saleCompletionTurn, turn + 1, "決定はTurn(turn-1)なので、決定期+2Turn=turn+1が売却完了予定");
});

test("FAC-VM-4【実装指示§7】: SOLDになった工場は一覧（rows）に含まれない", () => {
  const companyId = "BAL";
  const init = initializeCompanyLab(baseConfig());
  const fixtures = withSecondFactory(init.fixtures, companyId);
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const f2 = fixture.factories[1].factoryId;
  const decidedPeriod = previousPeriod(previousPeriod(init.state.currentPeriod));
  const { vm } = setup(companyId, [{ factoryId: f2, type: "SELL_FACTORY", decidedPeriod }]);
  assert.equal(
    vm.rows.find((r) => r.factoryId === f2),
    undefined
  );
  assert.ok(!vm.ownedFactoryIds.includes(f2));
});

test("FAC-VM-5【最低1工場ルールのUIヒント】: 1工場しか保有していない会社は、その工場のSELL_FACTORYが候補に出ない", () => {
  const init = initializeCompanyLab(baseConfig());
  const fixture = init.fixtures.find((f) => f.companyId === "BAL")!; // 2つ目の工場を足さない（既定の1工場のまま）
  const ownState = buildCompanyOwnState(init.state, fixture);
  const vm = buildFactoryOperationsViewModel(fixture, ownState, init.state.currentPeriod, init.state.scenarioState.currentTurn);
  const row = vm.rows.find((r) => r.factoryId === fixture.factories[0].factoryId)!;
  assert.equal(row.lifecycleStatus, "OPERATING");
  assert.deepEqual(row.availableActions, ["MOTHBALL_FACTORY"], "最後の1工場はMothballはできるがSellはUI候補から外れる");
});

test("FAC-VM-6: 未完了のCapital Projectがある工場は、SELL_FACTORYが候補に出ずhasActiveCapexProject=trueになる", () => {
  const companyId = "BAL";
  const init = initializeCompanyLab(baseConfig());
  const fixtures = withSecondFactory(init.fixtures, companyId);
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const f2 = fixture.factories[1].factoryId;
  const state: CompanyLabState = {
    ...init.state,
    factoryLifecycleState: { companies: [{ companyId, decisions: [] }] },
    capexState: {
      companies: init.state.capexState.companies.map((c) =>
        c.companyId === companyId
          ? {
              ...c,
              portfolio: {
                ...c.portfolio,
                projects: [
                  ...c.portfolio.projects,
                  {
                    projectId: "TEST-CAPEX-1",
                    companyId,
                    projectType: "commonProcessingExpansion" as const,
                    status: "approved" as const,
                    targetFactoryId: f2,
                    proposedPeriod: init.state.currentPeriod,
                    approvedPeriod: init.state.currentPeriod,
                    approvedBudgetUsd: 100_000,
                    paymentSchedule: [],
                    completedPaymentStagesCount: 0,
                    cumulativePaidUsd: 0,
                    requiredConstructionQuarters: 2,
                    elapsedConstructionQuartersWithPayment: 0,
                    priority: 1,
                    lastDiagnosticReasons: [],
                  },
                ],
              },
            }
          : c
      ),
    },
  };
  const ownState = buildCompanyOwnState(state, fixture);
  const vm = buildFactoryOperationsViewModel(fixture, ownState, state.currentPeriod, state.scenarioState.currentTurn);
  const row = vm.rows.find((r) => r.factoryId === f2)!;
  assert.equal(row.hasActiveCapexProject, true);
  assert.deepEqual(row.availableActions, ["MOTHBALL_FACTORY"]);
});

test("FAC-VM-7【回帰ガード】: UIが候補として出す全操作は、既存validateFactoryLifecycleDecisionが実際に受理する", () => {
  const companyId = "BAL";
  const { vm, fixture, state } = setup(companyId);
  const activeProjectFactoryIds: string[] = [];
  for (const row of vm.rows) {
    for (const type of row.availableActions) {
      assert.doesNotThrow(
        () =>
          validateFactoryLifecycleDecision(
            { type, factoryId: row.factoryId },
            { ownedFactoryIds: vm.ownedFactoryIds, decisions: [], period: state.currentPeriod, activeProjectFactoryIds }
          ),
        `${row.factoryId}への${type}は既存validateFactoryLifecycleDecisionでも受理されるはず`
      );
    }
  }
  assert.ok(fixture.companyId === companyId);
});

test("FAC-VM-8【会計一致】: 帳簿価額・見込代金・見込損益・休止費用は既存Engine関数を直接呼んだ結果と一致する", () => {
  const companyId = "BAL";
  const { vm, fixture, state, ownState } = setup(companyId);
  const f2 = fixture.factories[1].factoryId;
  const row = vm.rows.find((r) => r.factoryId === f2)!;

  const projection = computeFactoryAssetProjection({
    baselineFactories: fixture.factories,
    projects: ownState.capexState.portfolio.projects,
    lifecycleDecisions: [],
    period: state.currentPeriod,
    companyFixedAssetsGrossUsd: unwrapUsd(ownState.financeState.fixedAssetsGross),
    companyAccumulatedDepreciationUsd: unwrapUsd(ownState.financeState.accumulatedDepreciation),
    financeParams: FINANCE_PARAMETERS_V1,
    capexParams: CAPEX_PARAMETERS_V1,
  });
  const expectedNbv = projection.get(f2)!.netBookValueUsd;
  assert.equal(row.netBookValueUsd, expectedNbv);
  assert.equal(row.estimatedSaleProceedsUsd, expectedNbv * FACTORY_LIFECYCLE_PARAMETERS_V1.saleProceedsRecoveryRate);
  assert.equal(row.estimatedDisposalGainLossUsd, row.estimatedSaleProceedsUsd - expectedNbv);

  const normalCost = normalCashFixedFactoryCostUsdPerQuarter(FINANCE_PARAMETERS_V1);
  assert.equal(row.mothballCarryingCostUsdPerQuarter, normalCost * FACTORY_LIFECYCLE_PARAMETERS_V1.mothballCarryingCostRatio);
  assert.equal(row.reactivationCostUsd, FACTORY_LIFECYCLE_PARAMETERS_V1.reactivationCostUsd);
});
