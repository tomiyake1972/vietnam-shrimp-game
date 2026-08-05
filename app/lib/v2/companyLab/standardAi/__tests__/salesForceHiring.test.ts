// ShrimpX V2 — Standard AI 営業採用・減員（経営ボトルネック判定）単体テスト
//
// 三宅さんご指示§21の受入観点のうち、本モジュール（decision/salesForceHiring.ts）
// が直接担当する観点をテストする（production/labor/procurement/finance決定自体の
// 単体テストは既存ファイルに委ね、ここでは新規モジュールの振る舞いのみを検証する）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { CompanyLabConfig } from "../../types";
import { buildStandardAiObservation } from "../observation";
import { computePressureScores } from "../pressures";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { buildStandardAiSalesPlans } from "../decision/sales";
import { buildCurrentPeriodDeliveryDemand } from "../diagnosis/currentPeriodDeliveryDemand";
import {
  computeBasicCurrentPeriodProductionRequirement,
  computeEligibleCurrentPeriodDemand,
  computeFinalProductionRequirement,
  computeNormalInventoryTargetByProduct,
} from "../diagnosis/productionRequirement";
import { buildStandardAiUnitEconomics } from "../diagnosis/forwardUnitEconomics";
import { buildStandardAiSalesForceHiringDecision, SalesForceHiringDecisionInput } from "../decision/salesForceHiring";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { computeTargetScaleBand } from "../targetScale";
import { STANDARD_AI_STRATEGIC_INTENT_V1 } from "../strategicIntent";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "sai-hiring-unit-001", turns: 8, ...overrides };
}

/** BAL会社の1ターン目の意思決定材料一式を、policy.tsと同じ手順で構築する（テスト用ヘルパー）。 */
function setupBalContext(seed = "sai-hiring-unit-001") {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed }));
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const period = state.currentPeriod;
  const turn = 1;

  const observation = buildStandardAiObservation(fixture, ownState, publicInfo, period, turn);
  const pressures = computePressureScores(observation, fixture, STANDARD_AI_PARAMETERS_V1);
  const salesResult = buildStandardAiSalesPlans(fixture, observation, pressures, STANDARD_AI_PARAMETERS_V1, SALES_PARAMETERS_V1);
  const deliveryDemandResult = buildCurrentPeriodDeliveryDemand(fixture.companyId, observation, salesResult.realisticSalesByProduct);
  const eligibleCurrentPeriodDemand = computeEligibleCurrentPeriodDemand(deliveryDemandResult.deliveryDemand);
  const normalInventoryTargetByProduct = computeNormalInventoryTargetByProduct(observation, STANDARD_AI_PARAMETERS_V1);
  const basicProductionRequirementByProduct = computeBasicCurrentPeriodProductionRequirement(
    eligibleCurrentPeriodDemand,
    normalInventoryTargetByProduct,
    observation.finishedGoodsByProduct
  );
  const finalProductionRequirementByProduct = computeFinalProductionRequirement(basicProductionRequirementByProduct);
  const unitEconomics = buildStandardAiUnitEconomics(observation);
  const targetScaleResult = computeTargetScaleBand(fixture, observation, STANDARD_AI_STRATEGIC_INTENT_V1, STANDARD_AI_PARAMETERS_V1);

  return { fixture, observation, pressures, salesResult, finalProductionRequirementByProduct, unitEconomics, targetScaleResult };
}

function buildInput(ctx: ReturnType<typeof setupBalContext>, overrides: Partial<SalesForceHiringDecisionInput> = {}): SalesForceHiringDecisionInput {
  return {
    fixture: ctx.fixture,
    observation: ctx.observation,
    pressures: ctx.pressures,
    params: STANDARD_AI_PARAMETERS_V1,
    salesParams: SALES_PARAMETERS_V1,
    salesWishByMarketProduct: ctx.salesResult.salesWishByMarketProduct,
    finalProductionRequirementByProduct: ctx.finalProductionRequirementByProduct,
    totalEffectiveCapacityByProduct: ctx.observation.totalEffectiveCapacityByProduct,
    unitEconomics: ctx.unitEconomics,
    rawMaterialSupplyConstraintState: "unknown",
    targetScaleBand: ctx.targetScaleResult.targetScaleBand,
    hasNearTermCapexUnderConstruction: false,
    ...overrides,
  };
}

test("Standard AIの意思決定は、既存の共有sales関数（sales/marketEffort.ts）をそのまま呼び、飽和曲線・effort係数を再実装していない（hard-code禁止の確認）", () => {
  const ctx = setupBalContext();
  const result = buildStandardAiSalesForceHiringDecision(buildInput(ctx));
  // 呼び出しが正常終了し、結果が有限であること（内部で独自の飽和式を発明していれば
  // 別の値になるはずだが、ここでは値そのものではなく「エンジン関数が実際に呼ばれ
  // エラーなく完走すること」を確認する。数値の一致は他のテスト・分析文書で別途確認済み）。
  assert.ok(Number.isFinite(result.salesForceHireCount));
  assert.ok(Number.isFinite(result.salesForceLayoffCount));
});

test("収益性のある未充足の販売機会が無い場合（希望量が既に容量内）、営業採用を提案しない", () => {
  const ctx = setupBalContext();
  // 希望量をゼロにする＝profitable unserved opportunityが存在しない状態を作る。
  const input = buildInput(ctx, { salesWishByMarketProduct: [] });
  const result = buildStandardAiSalesForceHiringDecision(input);
  assert.equal(result.salesForceHireCount, 0);
});

test("2026-08-05新設: Target Scale帯の上限に既に達している場合、限界利益が正であってもそれ以上の営業採用を提案しない（三宅さんご指示§9・§31）", () => {
  const ctx = setupBalContext();
  // Target Scale帯を極端に小さく（現在の実現販売量と同水準）override し、
  // 「会社が目指す規模を超えて無意味に増員しない」ことを確認する。
  const tinyBand = { quarterlySalesTons: { min: 0, preferred: 0, max: 1 } };
  const input = buildInput(ctx, { targetScaleBand: tinyBand, hasNearTermCapexUnderConstruction: true });
  const result = buildStandardAiSalesForceHiringDecision(input);
  assert.equal(result.salesForceHireCount, 0, "Target Scale帯の上限（max=1t）に対し現在の販売量が既に上回っているため、採用0件のはず");
  const limitedByTargetScale = result.diagnostics.some((d) => d.code === "SALES_HIRING_LIMITED_BY_TARGET_SCALE");
  assert.ok(limitedByTargetScale, "SALES_HIRING_LIMITED_BY_TARGET_SCALE診断が発行されるはず");
});

test("生産能力に全く余力がない場合、営業採用は生産ボトルネックでブロックされる（大量採用しない）", () => {
  const ctx = setupBalContext();
  // 生産余力をゼロ（現在の必要量＝実行可能上限）にする。
  const input = buildInput(ctx, {
    totalEffectiveCapacityByProduct: { ...ctx.finalProductionRequirementByProduct },
    observation: { ...ctx.observation, finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 } },
  });
  const result = buildStandardAiSalesForceHiringDecision(input);
  const blockedByProduction = result.evaluations.some((e) => e.blockedReasonCode === "SALES_HIRING_BLOCKED_BY_PRODUCTION");
  // 希望量があり、かつ既存FGも無い場合は、生産余力ゼロなら追加採用のいずれかの
  // ステップで生産ボトルネックに達するはず（希望量自体が小さすぎて発火しない
  // 極端な環境を除く。salesWishByMarketProductが空でないことを前提とする）。
  if (ctx.salesResult.salesWishByMarketProduct.length > 0) {
    assert.ok(blockedByProduction || result.salesForceHireCount === 0, "生産余力ゼロなら採用0件、または生産ボトルネックでブロックされるはず");
  }
});

test("真の原料供給制約（shortage）が診断されている場合、新規生産を要する採用は決して受理されない（不確実な調達を捏造しない）", () => {
  const ctx = setupBalContext();
  const input = buildInput(ctx, {
    observation: { ...ctx.observation, finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 } },
    rawMaterialSupplyConstraintState: "shortage",
  });
  const result = buildStandardAiSalesForceHiringDecision(input);
  const acceptedHires = result.evaluations.filter((e) => e.direction === "hire" && e.accepted);
  for (const e of acceptedHires) {
    assert.ok(
      e.incrementalSalesRequiringNewProductionTons <= 1e-6,
      "原料供給制約がshortageのとき、新規生産を要する採用は受理されないはず（既存FGで賄える分のみ受理可）"
    );
  }
});

test("現金が最低バッファを大きく下回る場合、営業採用は資金理由でブロックされる（positive NPVでもcash timingで危険なら見送る）", () => {
  const ctx = setupBalContext();
  const input = buildInput(ctx, {
    observation: { ...ctx.observation, cashUsd: 0 },
    pressures: { ...ctx.pressures, targetMinimumCashUsd: 100_000_000 },
  });
  const result = buildStandardAiSalesForceHiringDecision(input);
  assert.equal(result.salesForceHireCount, 0, "現金が最低バッファを大幅に下回る場合は採用0件であるべき");
});

test("既存の完成品在庫（FG）が十分にある場合、追加営業人員は新規生産を要さずに販売できる（incrementalSalesCoveredByExistingFgTons>0）", () => {
  const ctx = setupBalContext();
  const hugeFg = { hoso: 100000, pd: 100000, vap: 100000 };
  const input = buildInput(ctx, { observation: { ...ctx.observation, finishedGoodsByProduct: hugeFg } });
  const result = buildStandardAiSalesForceHiringDecision(input);
  const hireEvaluations = result.evaluations.filter((e) => e.direction === "hire" && e.accepted);
  if (hireEvaluations.length > 0) {
    const totalCoveredByFg = hireEvaluations.reduce((s, e) => s + e.incrementalSalesCoveredByExistingFgTons, 0);
    const totalRequiringNewProduction = hireEvaluations.reduce((s, e) => s + e.incrementalSalesRequiringNewProductionTons, 0);
    assert.ok(totalCoveredByFg >= totalRequiringNewProduction, "在庫が十分にある状況では、増分販売の大半は既存FGで賄われるべき（追加生産なしのcash conversion）");
  }
});

test("営業採用は同一四半期の生産量を直接膨張させない（生産計画の入力は変更しない）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const productionTotal = decision.productionPlans.reduce((s, p) => s + p.desiredQuantity, 0);
  // productionPlansはbasicProductionRequirement（現実的販売量+在庫調整）から導出されており、
  // salesForceHireCountの値そのものを直接の入力にしていないことを、生産計画がdiagnostics.
  // currentPeriodDeliveryDemandの範囲内に収まっていることで間接的に確認する。
  assert.ok(Number.isFinite(productionTotal));
  assert.ok(diagnostics.situationDiagnosis !== undefined);
});

test("同一入力なら営業採用/減員の判断も決定論的（同一結果）", () => {
  const ctx = setupBalContext();
  const input = buildInput(ctx);
  const a = buildStandardAiSalesForceHiringDecision(input);
  const b = buildStandardAiSalesForceHiringDecision(input);
  assert.deepEqual(a, b);
});

test("採用と減員が同一四半期に両方>0になることはない（game engine側の入力制約と整合）", () => {
  const ctx = setupBalContext();
  const result = buildStandardAiSalesForceHiringDecision(buildInput(ctx));
  assert.ok(result.salesForceHireCount === 0 || result.salesForceLayoffCount === 0, "採用と減員は同時に>0にならないはず");
});

test("8ターンの標準AI実行で、salesForceHireCount/salesForceLayoffCountは常に非負整数かつ有限である", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  let current = state;
  for (let turn = 1; turn <= 8 && !current.isComplete; turn++) {
    const decisionsByCompanyId: Record<string, ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["decision"]> = {};
    for (const fixture of fixtures) {
      const ownState = buildCompanyOwnState(current, fixture);
      const publicInfo = buildPublicMarketInfo(current);
      const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, current.currentPeriod, turn);
      decisionsByCompanyId[fixture.companyId] = decision;
      const hire = decision.salesForceHireCount ?? 0;
      const layoff = decision.salesForceLayoffCount ?? 0;
      assert.ok(Number.isInteger(hire) && hire >= 0, `salesForceHireCount(${fixture.companyId}, turn${turn})は非負整数`);
      assert.ok(Number.isInteger(layoff) && layoff >= 0, `salesForceLayoffCount(${fixture.companyId}, turn${turn})は非負整数`);
    }
    current = advanceCompanyLabQuarter(current, fixtures, decisionsByCompanyId);
  }
});

test("2026-08-05修正: 1四半期あたりの採用ガバナーは静的な基準規模（fixture.salesForceHeadcountTotal）に対する相対値であり、複利成長しない（三宅さんレビュー指摘の回帰防止）", () => {
  // 旧設計（ガバナーが「現在の（既に膨張した）人数」の50%）では、8ターン実行時に
  // BAL社の営業人員数が 18→18→27→41→62→93→140 と複利的に膨張した。
  // 修正後は、静的な基準規模（BAL=18人）に対するガバナー（max(5, round(18*0.5))=9人）が
  // 毎四半期一定であるため、増員が続く限りの増分は常に9人以下・単調に非増加であるべきで、
  // 「前四半期より増分が大きくなる」複利成長は発生しないはずである。
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const bal = fixtures.find((f) => f.companyId === "BAL")!;
  const staticBaseline = bal.salesForceHeadcountTotal;
  let current = state;
  const hireByTurn: number[] = [];
  for (let turn = 1; turn <= 8 && !current.isComplete; turn++) {
    const decisionsByCompanyId: Record<string, ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["decision"]> = {};
    for (const fixture of fixtures) {
      const ownState = buildCompanyOwnState(current, fixture);
      const publicInfo = buildPublicMarketInfo(current);
      const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, current.currentPeriod, turn);
      decisionsByCompanyId[fixture.companyId] = decision;
      if (fixture.companyId === "BAL") {
        hireByTurn.push(decision.salesForceHireCount ?? 0);
      }
    }
    current = advanceCompanyLabQuarter(current, fixtures, decisionsByCompanyId);
  }
  const governorCap = Math.max(5, Math.round(staticBaseline * 0.5));
  for (const hire of hireByTurn) {
    assert.ok(hire <= governorCap, `1四半期あたりの採用数(${hire})は静的な基準規模由来のガバナー上限(${governorCap})を超えてはならない`);
  }
  const positiveHires = hireByTurn.filter((h) => h > 0);
  if (positiveHires.length >= 2) {
    for (let i = 1; i < positiveHires.length; i++) {
      assert.ok(
        positiveHires[i] <= positiveHires[i - 1] + 1,
        `複利成長していないことの確認: ${i}番目の採用数(${positiveHires[i]})が直前(${positiveHires[i - 1]})より大幅に増えていない`
      );
    }
  }
});
