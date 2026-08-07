// ShrimpX V2 — 2026-08-03 Phase B: Forward Unit Economics 診断モジュールのテスト
//
// 【目的】三宅さんの指示Section 12が要求するUnit Economics関連のテストカバレッジ
// （正しい定式化・原料源の出典明示・turn1でのnull処理・3区分分類・既存パラメータの
// そのままの再利用）を検証する。situationDiagnosis.tsやdecision/*.tsとは独立して
// 呼び出せる純関数であることを前提に、実際のcompanyLab runnerでturn1/turn2の
// StandardAiObservationを再構成して検証する（能力認識監査テストと同じ手法）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../policy";
import { buildStandardAiObservation } from "../../observation";
import { CompanyLabConfig } from "../../../types";
import { buildStandardAiUnitEconomics } from "../forwardUnitEconomics";
import { PRODUCTION_PARAMETERS_V1 } from "../../../../production/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../../../finance/parameters";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "unit-economics-001", turns: 8, ...overrides };
}

function setupTurn1And2(companyId = "BAL", seed = "unit-economics-001") {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed }));
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const ownState1 = buildCompanyOwnState(state, fixture);
  const publicInfo1 = buildPublicMarketInfo(state);
  const observation1 = buildStandardAiObservation(fixture, ownState1, publicInfo1, state.currentPeriod, 1);

  const decisions: Record<string, ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["decision"]> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisions[f.companyId] = generateStandardAiDecisionWithDiagnostics(f, own, publicInfo1, state.currentPeriod, 1).decision;
  }
  const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
  const ownState2 = buildCompanyOwnState(nextState, fixture);
  const publicInfo2 = buildPublicMarketInfo(nextState);
  const observation2 = buildStandardAiObservation(fixture, ownState2, publicInfo2, nextState.currentPeriod, 2);

  return { observation1, observation2 };
}

test("turn1では前期市場データが無いため、全エントリのreferenceSalesPriceUsdPerKgがnullで、profitabilityClassもnull（憶測しない）", () => {
  const { observation1 } = setupTurn1And2();
  const result = buildStandardAiUnitEconomics(observation1);
  assert.ok(result.entries.length > 0);
  for (const entry of result.entries) {
    assert.equal(entry.referenceSalesPriceUsdPerKg, null);
    assert.equal(entry.profitabilityClass, null);
    assert.equal(entry.dataQuality.hasMissingCriticalInput, true);
    assert.ok(entry.dataQuality.missingInputs.includes("referenceSalesPriceUsdPerKg"));
  }
});

test("turn2では市場データが観測され、referenceSalesPriceUsdPerKg・profitabilityClassが計算される（会社×市場×商品の全組み合わせぶん）", () => {
  const { observation2 } = setupTurn1And2();
  const result = buildStandardAiUnitEconomics(observation2);
  assert.equal(result.companyId, observation2.companyId);
  assert.equal(result.entries.length, observation2.markets.length * 3);
  const anyResolved = result.entries.some((e) => e.referenceSalesPriceUsdPerKg !== null);
  assert.ok(anyResolved, "turn2では少なくとも一部の市場×商品でreferenceSalesPriceUsdPerKgが観測されるはず");
});

test("貢献利益の定式化: contributionMarginUsdPerKg = referenceSalesPrice - rawMaterialCost - nonRawVariableCost（正しい定式化。加工費のみを引く簡略式ではない）", () => {
  const { observation2 } = setupTurn1And2();
  const result = buildStandardAiUnitEconomics(observation2);
  for (const entry of result.entries) {
    if (entry.contributionMarginUsdPerKg === null) continue;
    const expected = entry.referenceSalesPriceUsdPerKg! - entry.rawMaterialCostUsdPerKg! - entry.nonRawVariableCostUsdPerKg;
    assert.ok(Math.abs(entry.contributionMarginUsdPerKg - expected) < 1e-9);
  }
});

test("製造フルコスト = 変動費合計 + 配賦固定費。フルコストマージン = 参照売価 - 製造フルコスト", () => {
  const { observation2 } = setupTurn1And2();
  const result = buildStandardAiUnitEconomics(observation2);
  for (const entry of result.entries) {
    if (entry.manufacturingFullCostUsdPerKg === null) continue;
    const expectedFullCost = entry.totalVariableCostUsdPerKg! + entry.allocatedManufacturingFixedCostUsdPerKg;
    assert.ok(Math.abs(entry.manufacturingFullCostUsdPerKg - expectedFullCost) < 1e-9);
    const expectedMargin = entry.referenceSalesPriceUsdPerKg! - entry.manufacturingFullCostUsdPerKg;
    assert.ok(Math.abs(entry.manufacturingFullCostMarginUsdPerKg! - expectedMargin) < 1e-9);
  }
});

test("3区分採算分類: フルコストマージン>0はFULLY_PROFITABLE、貢献利益>0かつフルコストマージン<=0はCONTRIBUTION_POSITIVE_ONLY、貢献利益<=0はUNECONOMIC_NEW_SALES相当", () => {
  const { observation2 } = setupTurn1And2();
  const result = buildStandardAiUnitEconomics(observation2);
  for (const entry of result.entries) {
    if (entry.profitabilityClass === null) continue;
    if (entry.manufacturingFullCostMarginUsdPerKg! > 0) {
      assert.equal(entry.profitabilityClass, "FULLY_PROFITABLE");
    } else if (entry.contributionMarginUsdPerKg! > 0) {
      assert.equal(entry.profitabilityClass, "CONTRIBUTION_POSITIVE_ONLY");
    } else {
      assert.equal(entry.profitabilityClass, "UNECONOMIC");
    }
  }
});

test("許容原料価格: contributionAffordableRawPriceUsdPerKgちょうどの原料費なら貢献利益がほぼゼロになる（逆算の整合性）", () => {
  const { observation2 } = setupTurn1And2();
  const result = buildStandardAiUnitEconomics(observation2);
  for (const entry of result.entries) {
    if (entry.contributionAffordableRawPriceUsdPerKg === null) continue;
    const impliedContributionMargin = entry.referenceSalesPriceUsdPerKg! - entry.contributionAffordableRawPriceUsdPerKg - entry.nonRawVariableCostUsdPerKg;
    assert.ok(Math.abs(impliedContributionMargin) < 1e-9);
  }
});

test("原料費の出典: 主原料費はdomesticReferencePrice（国内参照価格）のみを採用し、養殖原価は常にnull（捏造しない）", () => {
  const { observation2 } = setupTurn1And2();
  const result = buildStandardAiUnitEconomics(observation2);
  for (const entry of result.entries) {
    assert.equal(entry.rawMaterialCostBySourceUsdPerKg.aquaculture, null);
    if (entry.rawMaterialCostUsdPerKg !== null) {
      assert.equal(entry.dataQuality.rawMaterialCostSource, "domesticReferencePrice");
      assert.equal(entry.rawMaterialCostUsdPerKg, entry.rawMaterialCostBySourceUsdPerKg.domestic);
    }
  }
});

test("原料以外の変動費は、production/finance両パラメータファイルの既存値をそのまま再利用している（新しい原価パラメータを作っていない）", () => {
  const { observation2 } = setupTurn1And2();
  const result = buildStandardAiUnitEconomics(observation2);
  const hosoEqKgPerTon = PRODUCTION_PARAMETERS_V1.cost.hosoEqKgPerTon;
  const expectedByProduct = {
    hoso:
      (PRODUCTION_PARAMETERS_V1.cost.baseProcessingCostUsdPerTon.hoso +
        FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityVariableUsdPerTon +
        FINANCE_PARAMETERS_V1.sellingGeneralAdmin.sellingLogisticsUsdPerTon) /
      hosoEqKgPerTon,
    pd:
      (PRODUCTION_PARAMETERS_V1.cost.baseProcessingCostUsdPerTon.pd +
        FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityVariableUsdPerTon +
        FINANCE_PARAMETERS_V1.sellingGeneralAdmin.sellingLogisticsUsdPerTon) /
      hosoEqKgPerTon,
    vap:
      (PRODUCTION_PARAMETERS_V1.cost.baseProcessingCostUsdPerTon.vap +
        FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityVariableUsdPerTon +
        FINANCE_PARAMETERS_V1.sellingGeneralAdmin.sellingLogisticsUsdPerTon) /
      hosoEqKgPerTon,
  };
  for (const entry of result.entries) {
    assert.ok(Math.abs(entry.nonRawVariableCostUsdPerKg - expectedByProduct[entry.product]) < 1e-9);
  }
});

test("配賦固定費: 商品別配賦係数(HOSO1.0/PD1.5/VAP2.4)の比が、配賦固定費/kgの比に反映される（VAPが最も高く、HOSOが最も低い）", () => {
  const { observation2 } = setupTurn1And2();
  const result = buildStandardAiUnitEconomics(observation2);
  const byProduct = { hoso: 0, pd: 0, vap: 0 };
  for (const entry of result.entries) {
    byProduct[entry.product] = entry.allocatedManufacturingFixedCostUsdPerKg;
  }
  assert.ok(byProduct.vap > byProduct.pd);
  assert.ok(byProduct.pd > byProduct.hoso);
  assert.ok(byProduct.hoso > 0);
});

test("市場×商品の全組み合わせで会社IDが一致し、他社データが混入しない（構造的な不変条件）", () => {
  const { observation2 } = setupTurn1And2("MASS");
  const result = buildStandardAiUnitEconomics(observation2);
  for (const entry of result.entries) {
    assert.equal(entry.companyId, "MASS");
  }
});

test("dataQuality.fixedCostAllocationNoteは常に非空文字列（簡略化の明示を省略しない）", () => {
  const { observation2 } = setupTurn1And2();
  const result = buildStandardAiUnitEconomics(observation2);
  for (const entry of result.entries) {
    assert.ok(entry.dataQuality.fixedCostAllocationNote.length > 0);
  }
});
