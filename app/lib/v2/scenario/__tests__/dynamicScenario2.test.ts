// ShrimpX V2 — Dynamic Scenario 2（Phase 2A: MASS 初期借入 40M）のテスト
//
// 守りたいこと。
//  (a) DS2 が選択肢に出る／DS1 は残っていて中身も変わっていない。
//  (b) DS2 の MASS だけ初期借入が 40M で、他社・他シナリオは共有フィクスチャのまま。
//  (c) 借入を下げても初期BSの貸借は一致する（利益剰余金が残差で吸収する）。
//  (d) DS2 は世界の側（イベント・News・VAP構造・需要）を DS1 から継承している。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeCompanyLab } from "../../companyLab/runner";
import { DYNAMIC_SCENARIO_1 } from "../definitions/dynamicScenario1";
import { DYNAMIC_SCENARIO_2 } from "../definitions/dynamicScenario2";
import { BASELINE_SCENARIO } from "../definitions/baseline";
import { ALL_SCENARIO_DEFINITIONS } from "../definitions";
import { DS2_MASS_TOTAL_DEBT_USD } from "../definitions/dynamicScenario2Parameters";
import { INITIAL_FINANCE_FIXTURES_V1, buildInitialCompanyFinanceState } from "../../finance/initialState";
import { PeriodV2 } from "../../core/period";

const P0 = "Y1Q1" as unknown as PeriodV2;

function debtOf(scenarioId: string, companyId: string): number {
  const { state } = initializeCompanyLab({ scenarioId, mode: "canonical", seed: "ds2-test", turns: 8 });
  const fin = state.financeState.companies.find((c) => c.companyId === companyId);
  assert.ok(fin, `${companyId} の初期財務が無い`);
  return Number(fin.shortTermLoans) + Number(fin.longTermLoans);
}

// ---------------------------------------------------------------------
// シナリオの存在と DS1 の不変性
// ---------------------------------------------------------------------

test("DS2-1: Dynamic Scenario 2 が選択肢に含まれ、DS1 も残っている", () => {
  const ids = ALL_SCENARIO_DEFINITIONS.map((d) => d.scenarioId);
  assert.ok(ids.includes(DYNAMIC_SCENARIO_2.scenarioId), "DS2 が一覧にある");
  assert.ok(ids.includes(DYNAMIC_SCENARIO_1.scenarioId), "DS1 も残っている");
  assert.notEqual(DYNAMIC_SCENARIO_2.scenarioId, DYNAMIC_SCENARIO_1.scenarioId);
  // 画面で見分けられること。
  assert.ok(DYNAMIC_SCENARIO_2.title.includes("Dynamic Scenario 2"));
  assert.ok(DYNAMIC_SCENARIO_1.title.includes("Dynamic Scenario 1"));
});

test("DS2-2: DS1 は初期借入の宣言を持たない（DS1 の挙動は変わっていない）", () => {
  assert.equal(DYNAMIC_SCENARIO_1.initialCompanyDebtUsd, undefined);
  assert.equal(BASELINE_SCENARIO.initialCompanyDebtUsd, undefined);
});

// ---------------------------------------------------------------------
// MASS の初期借入
// ---------------------------------------------------------------------

test("DS2-3: DS2 の MASS 初期借入は 40M（DS1 は 80M のまま）", () => {
  assert.equal(debtOf(DYNAMIC_SCENARIO_2.scenarioId, "MASS"), DS2_MASS_TOTAL_DEBT_USD);
  assert.equal(debtOf(DYNAMIC_SCENARIO_1.scenarioId, "MASS"), 80_000_000);
  assert.equal(debtOf(BASELINE_SCENARIO.scenarioId, "MASS"), 80_000_000);
});

test("DS2-4: MASS 以外の4社の初期借入は DS2 でも共有フィクスチャのまま", () => {
  for (const companyId of ["BAL", "JPQ", "VAP", "CONSV"]) {
    const shared = INITIAL_FINANCE_FIXTURES_V1.find((f) => f.companyId === companyId);
    assert.ok(shared);
    assert.equal(debtOf(DYNAMIC_SCENARIO_2.scenarioId, companyId), shared.shortTermLoans + shared.longTermLoans, companyId);
  }
});

test("DS2-5: MASS の借入以外の初期財務項目は変わらない（現金・売掛金・固定資産・資本金）", () => {
  const shared = INITIAL_FINANCE_FIXTURES_V1.find((f) => f.companyId === "MASS");
  assert.ok(shared);
  const bs = buildInitialCompanyFinanceState("MASS", [], P0, { shortTermLoans: 17_500_000, longTermLoans: 22_500_000 });
  assert.equal(Number(bs.cash), shared.cash);
  assert.equal(Number(bs.capitalStock), shared.capitalStock);
  assert.equal(Number(bs.otherCurrentAssets), shared.otherCurrentAssets);
  assert.equal(Number(bs.fixedAssetsGross), shared.fixedAssetsGross);
  assert.equal(Number(bs.shortTermLoans), 17_500_000);
  assert.equal(Number(bs.longTermLoans), 22_500_000);
});

// ---------------------------------------------------------------------
// 貸借一致
// ---------------------------------------------------------------------

test("DS2-6: 借入を下げても初期BSの貸借は一致する（利益剰余金が残差で吸収）", () => {
  // 原料在庫は保有ロットから都度算出される（CompanyFinanceState が値として持たない）ため、
  // ここではロット無し＝原料在庫0で、上書きあり／なしの両方の貸借一致を確かめる。
  const cases: readonly (Parameters<typeof buildInitialCompanyFinanceState>[3] | undefined)[] = [
    undefined,
    { shortTermLoans: 17_500_000, longTermLoans: 22_500_000 },
  ];
  for (const override of cases) {
    for (const shared of INITIAL_FINANCE_FIXTURES_V1) {
      const bs = buildInitialCompanyFinanceState(shared.companyId, [], P0, override);
      const receivables = bs.receivables.reduce((sum, r) => sum + Number(r.amount), 0);
      const payables = bs.payables.reduce((sum, r) => sum + Number(r.amount), 0);
      const assets = Number(bs.cash) + receivables + Number(bs.otherCurrentAssets) + Number(bs.fixedAssetsGross) - Number(bs.accumulatedDepreciation);
      const liabilities = Number(bs.shortTermLoans) + Number(bs.longTermLoans) + Number(bs.otherLiabilities) + payables;
      const equity = Number(bs.capitalStock) + Number(bs.retainedEarnings);
      assert.ok(
        Math.abs(assets - (liabilities + equity)) < 1,
        `${shared.companyId} (override=${override ? "あり" : "なし"}): 資産 ${assets} ≠ 負債+純資産 ${liabilities + equity}`
      );
    }
  }
});

test("DS2-7: MASS の利益剰余金は借入を下げたぶんだけ増える（他の項目で調整していない）", () => {
  const base = buildInitialCompanyFinanceState("MASS", [], P0);
  const reduced = buildInitialCompanyFinanceState("MASS", [], P0, { shortTermLoans: 17_500_000, longTermLoans: 22_500_000 });
  const delta = Number(reduced.retainedEarnings) - Number(base.retainedEarnings);
  assert.ok(Math.abs(delta - 40_000_000) < 1, `利益剰余金の増分が借入削減額と一致すること: ${delta}`);
});

// ---------------------------------------------------------------------
// 世界の側の継承
// ---------------------------------------------------------------------

test("DS2-8: DS2 は世界の側（イベント・News・需要・VAP構造）を DS1 から継承している", () => {
  assert.deepEqual(DYNAMIC_SCENARIO_2.scheduledEvents, DYNAMIC_SCENARIO_1.scheduledEvents);
  assert.deepEqual(DYNAMIC_SCENARIO_2.informationReleases, DYNAMIC_SCENARIO_1.informationReleases);
  assert.deepEqual(DYNAMIC_SCENARIO_2.longTermTrends, DYNAMIC_SCENARIO_1.longTermTrends);
  assert.deepEqual(DYNAMIC_SCENARIO_2.productLifecycleOverrides, DYNAMIC_SCENARIO_1.productLifecycleOverrides);
  assert.deepEqual(DYNAMIC_SCENARIO_2.structuralDemandAnchor, DYNAMIC_SCENARIO_1.structuralDemandAnchor);
  assert.deepEqual(DYNAMIC_SCENARIO_2.initialCompanyVapCapacityTons, DYNAMIC_SCENARIO_1.initialCompanyVapCapacityTons);
  assert.equal(DYNAMIC_SCENARIO_2.vapCapacitySignal, DYNAMIC_SCENARIO_1.vapCapacitySignal);
  assert.equal(DYNAMIC_SCENARIO_2.durationTurns, DYNAMIC_SCENARIO_1.durationTurns);
});

test("DS2-9: DS2 のベトナム5社の初期VAP設備は DS1 と同じ（VAP構造を戻していない）", () => {
  const { fixtures } = initializeCompanyLab({ scenarioId: DYNAMIC_SCENARIO_2.scenarioId, mode: "canonical", seed: "vap", turns: 8 });
  const vap = Object.fromEntries(fixtures.map((f) => [f.companyId, f.factories.reduce((s, fac) => s + Number(fac.vapCapacity), 0)]));
  assert.deepEqual(vap, { BAL: 1500, MASS: 1500, JPQ: 1500, VAP: 2000, CONSV: 1500 });
});
