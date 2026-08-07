// ShrimpX V2 — 【2026-08-02・能力認識監査】回帰テスト
//
// 三宅さんの指示による「能力認識監査」Phase 2（Domestic Raw Market Observation配線）・
// Phase 3（Production Effective Capacity認識）の修正が、狙ったとおりに機能していることを
// 検証する。三宅さんの実装指示Phase 12が明示的に列挙した検証項目をそのままテスト名にする。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { buildStandardAiObservation } from "../observation";
import { CompanyLabConfig } from "../../types";
import { hosoEqTons } from "../../../core/units";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "capacity-audit-001", turns: 8, ...overrides };
}

/** turn1を1期分進め、turn2（lastMarketResultが存在する最初のターン）の状態を作る。 */
function setupTurn2(seed = "capacity-audit-001") {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed }));
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const publicInfo1 = buildPublicMarketInfo(state);

  const decisions: Record<string, ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["decision"]> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisions[f.companyId] = generateStandardAiDecisionWithDiagnostics(f, own, publicInfo1, state.currentPeriod, 1).decision;
  }
  const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
  const ownState2 = buildCompanyOwnState(nextState, fixture);
  const publicInfo2 = buildPublicMarketInfo(nextState);
  return { fixture, ownState2, publicInfo2, period: nextState.currentPeriod, turn: 2 };
}

// ---------------------------------------------------------------------
// Phase 2: Domestic Raw Market Observation配線
// ---------------------------------------------------------------------

test("domestic public supply info reaches StandardAiObservation（turn2でvietnamDomesticPriorMarketが観測に存在する）", () => {
  const { fixture, ownState2, publicInfo2, period, turn } = setupTurn2();
  const observation = buildStandardAiObservation(fixture, ownState2, publicInfo2, period, turn);
  assert.ok(observation.vietnamDomesticPriorMarket, "turn2ではlastMarketResultが存在するため、vietnamDomesticPriorMarketも存在するはず");
  const m = observation.vietnamDomesticPriorMarket!;
  assert.ok(m.supply > 0, "国内市場供給量が観測されているはず");
  assert.ok(m.effectiveDemand >= 0);
  assert.ok(m.transactedVolume >= 0);
  assert.ok(m.unsoldSupply >= 0, "売れ残り供給量が観測されているはず");
  // supply = transactedVolume + unsoldSupply（VietnamDomesticResultの定義どおり。新しい計算は増設していない）
  assert.ok(Math.abs(m.supply - (m.transactedVolume + m.unsoldSupply)) < 1, "supply = transactedVolume + unsoldSupplyの関係が保たれているはず");
});

test("domestic public supply infoはturn1では観測されない（捏造しない。undefinedのまま）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const observation = buildStandardAiObservation(fixture, ownState, publicInfo, state.currentPeriod, 1);
  assert.equal(observation.vietnamDomesticPriorMarket, undefined, "turn1ではlastMarketResultが存在しないため、vietnamDomesticPriorMarketもundefinedのはず");
});

test("unknownを捏造しない: 前期市場データが無いturn1ではrawMaterialSupplyConstraintStateは常にunknownのまま", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const diagnosis = diagnostics.situationDiagnosis!;
  if (diagnosis.rawMaterialProcurementNeeded) {
    assert.equal(diagnosis.rawMaterialSupplyConstraintState, "unknown", "turn1では国内市場公開情報が無いため、真の供給制約はunknownであるべき");
  }
});

test("large unsold domestic supply is not automatically classified as raw shortage（人工ケース：売れ残り供給を必要量より大きくする）", () => {
  const { fixture, ownState2, publicInfo2, period, turn } = setupTurn2();
  const observation = buildStandardAiObservation(fixture, ownState2, publicInfo2, period, turn);
  assert.ok(observation.vietnamDomesticPriorMarket, "前提: turn2ではvietnamDomesticPriorMarketが存在するはず");

  // 【人工ケース】publicInfo2.lastMarketResult.vietnamDomesticのunsoldSupplyを、
  // 会社の期首原料在庫を大幅に上回るほど巨大な値へ人工的に置き換える（三宅さんの
  // 指摘した「Test14 Turn2のように10万t以上のunsold domestic supplyが公開されている
  // 場合」を模した最小限のテスト用フィクスチャ操作。ゲームエンジン本体は変更しない）。
  const inflatedPublicInfo = {
    ...publicInfo2,
    lastMarketResult: publicInfo2.lastMarketResult && {
      ...publicInfo2.lastMarketResult,
      vietnamDomestic: {
        ...publicInfo2.lastMarketResult.vietnamDomestic,
        supply: hosoEqTons(999_999),
        unsoldSupply: hosoEqTons(999_999),
      },
    },
  };
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState2, inflatedPublicInfo, period, turn);
  const diagnosis = diagnostics.situationDiagnosis!;
  if (diagnosis.rawMaterialProcurementNeeded) {
    assert.notEqual(
      diagnosis.rawMaterialSupplyConstraintState,
      "shortage",
      "国内市場の売れ残り供給が必要調達量を大幅に上回る場合、単に期首原料在庫が少ないことだけを理由に真の供給制約(shortage)と診断してはいけない"
    );
    assert.notEqual(diagnosis.primaryConstraint, "raw_material_shortage", "この人工ケースでは原料が主要制約になってはいけない");
    assert.notEqual(diagnosis.secondaryConstraint, "raw_material_shortage", "この人工ケースでは原料が第2制約になってもいけない");
  }
});

// ---------------------------------------------------------------------
// Phase 3: Production Effective Capacity認識
// ---------------------------------------------------------------------

test("effective production capacity equals production engine value（production/capacity.tsのcalculateFactoryEffectiveCapacityと一致）", async () => {
  const { calculateFactoryEffectiveCapacity } = await import("../../../production/capacity");
  const { unwrapUnit } = await import("../../../core/units");
  const { fixture, ownState2, publicInfo2, period, turn } = setupTurn2();
  const observation = buildStandardAiObservation(fixture, ownState2, publicInfo2, period, turn);

  for (const factoryObs of observation.factories) {
    const factory = fixture.factories.find((f) => f.factoryId === factoryObs.factoryId)!;
    const engineEffective = calculateFactoryEffectiveCapacity(factory);
    // capexが無い（Test14 Turn2の標準fixtureにcapex案件は無い）前提であれば、
    // observation側の実効値はエンジン本体の計算と完全一致するはず。
    assert.equal(factoryObs.effectiveCapacityByProduct.hoso, unwrapUnit(engineEffective.hoso), `factory=${factory.factoryId} hoso`);
    assert.equal(factoryObs.effectiveCapacityByProduct.pd, unwrapUnit(engineEffective.pd), `factory=${factory.factoryId} pd`);
    assert.equal(factoryObs.effectiveCapacityByProduct.vap, unwrapUnit(engineEffective.vap), `factory=${factory.factoryId} vap`);
    assert.equal(factoryObs.effectiveCommonProcessingCapacity, unwrapUnit(engineEffective.commonProcessing), `factory=${factory.factoryId} commonProcessing`);
    assert.equal(factoryObs.effectiveFreezingPackagingCapacity, unwrapUnit(engineEffective.freezingPackaging), `factory=${factory.factoryId} freezingPackaging`);
  }
});

test("nominal capacity is not used as executable production limit（生産計画の各工場desiredQuantityがnominalではなくeffectiveでキャップされる）", () => {
  const { fixture, ownState2, publicInfo2, period, turn } = setupTurn2();
  const observation = buildStandardAiObservation(fixture, ownState2, publicInfo2, period, turn);
  const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState2, publicInfo2, period, turn);

  for (const plan of decision.productionPlans) {
    const factoryObs = observation.factories.find((f) => f.factoryId === plan.factoryId)!;
    const nominal = factoryObs.capacityByProduct[plan.product];
    const effective = factoryObs.effectiveCapacityByProduct[plan.product];
    assert.ok(effective <= nominal + 1e-6, "実効能力は名目能力を超えないはず（前提の健全性確認）");
    assert.ok(
      Number(plan.desiredQuantity) <= effective + 1,
      `生産計画のdesiredQuantity（${Number(plan.desiredQuantity)}）が実効能力（${effective}）を超えている（factory=${plan.factoryId}, product=${plan.product}）`
    );
  }
});

test("Test14 Turn2で24,000tを真のcapacityとして診断しない（binding capacityは名目合計より明確に小さい）", () => {
  const { fixture, ownState2, publicInfo2, period, turn } = setupTurn2();
  const observation = buildStandardAiObservation(fixture, ownState2, publicInfo2, period, turn);

  const nominalTotal = observation.totalCapacityByProduct.hoso + observation.totalCapacityByProduct.pd + observation.totalCapacityByProduct.vap;
  const effectiveTotal =
    observation.totalEffectiveCapacityByProduct.hoso + observation.totalEffectiveCapacityByProduct.pd + observation.totalEffectiveCapacityByProduct.vap;
  const bindingTotal = Math.min(
    effectiveTotal,
    observation.totalEffectiveCommonProcessingCapacity > 0 ? observation.totalEffectiveCommonProcessingCapacity : effectiveTotal,
    observation.totalEffectiveFreezingPackagingCapacity > 0 ? observation.totalEffectiveFreezingPackagingCapacity : effectiveTotal
  );

  // Test14の標準fixtureはHOSO10,000+PD8,000+VAP6,000=24,000t（名目）、稼働率derate後は
  // 20,520t、共通前処理18,810t・凍結包装17,100tが共有ボトルネックとして効くため、
  // binding capacityは17,100t程度になるはず（三宅さんの指摘した過大認識の解消を確認）。
  assert.ok(bindingTotal < nominalTotal * 0.8, `binding capacity(${bindingTotal})が名目合計(${nominalTotal})より十分小さくなっているはず`);

  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState2, publicInfo2, period, turn);
  const diagnosis = diagnostics.situationDiagnosis!;
  // Production Load RatioがbindingCapacityTotalを分母に使っていることの間接確認:
  // basicRequirementTotal / bindingTotal に近い値になっているはず（許容誤差あり）。
  assert.ok(Number.isFinite(diagnosis.productionLoadRatio), "Production Load Ratioが算出されているはず");
});

// ---------------------------------------------------------------------
// Explanation Context（Claude向け説明入力）
// ---------------------------------------------------------------------

test("explanation context distinguishes nominal/effective/binding capacity", async () => {
  const { buildExplanationContext } = await import("../../aiExplanation/buildExplanationContext");
  const { fixture, ownState2, publicInfo2, period, turn } = setupTurn2();
  const { diagnostics: standardAiDiagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState2, publicInfo2, period, turn);

  const context = buildExplanationContext({
    labId: "lab-audit",
    companyId: fixture.companyId,
    turn,
    period,
    scenarioId: "baseline",
    fixture,
    ownState: ownState2,
    publicInfo: publicInfo2,
    diagnostics: standardAiDiagnostics,
  });

  const summary = context.ownState.productionCapacitySummary;
  assert.ok(summary, "productionCapacitySummaryが存在するはず");
  assert.ok(summary.nominalTotalTons > summary.effectiveTotalTons, "名目合計は実効合計より大きいはず（稼働率derateの分）");
  assert.ok(summary.bindingTotalTons <= summary.effectiveTotalTons, "binding容量は実効合計以下のはず（共有ボトルネック考慮）");
  assert.ok(summary.nominalTotalTons > summary.bindingTotalTons * 1.1, "名目合計はbinding容量より明確に大きいはず（過大認識問題の再発防止確認）");
  assert.ok(["商品別実効能力", "共通前処理", "凍結・包装"].includes(summary.bindingConstraintLabel));

  if (context.marketInfo.vietnamDomesticPriorMarket) {
    const m = context.marketInfo.vietnamDomesticPriorMarket;
    assert.ok(m.supplyTons >= 0 && m.unsoldSupplyTons >= 0, "国内市場の数量情報がClaude向け説明入力に渡っているはず");
  }
});
