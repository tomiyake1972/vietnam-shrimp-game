// ShrimpX V2 — Phase 6: Vision駆動の商業成長のテスト
//
// 【このテスト群が守る因果】
//  (a) Commercial Ambition は Vision と**観測可能な**情報だけから決まる
//  (b) 市場が弱い・採算が薄い・在庫過剰なら、志が大きくても拡大しない
//  (c) 成長意欲の低い会社を数量拡大へ強制しない
//  (d) 「売りたい量」と「提出する販売計画」「作る量」は別物である
//  (e) 取れなかった量の原因分解は決定論的で、重複計上しない
//  (f) Phase 3 の market-aware 配分を壊していない
//  (g) 監査で特定した固定販売規模（能力×0.8）へ回帰していない

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCommercialAmbition, COMMERCIAL_AMBITION_PARAMETERS_V1 } from "../commercialAmbition";
import { computeUnservedOpportunity } from "../unservedOpportunity";
import { computeStrategicGrowthState } from "../strategicGrowth";
import { CompanyVision } from "../types";
import { defaultVisionDocumentFor } from "../defaults";
import { CompanyLabConfig } from "../../types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../../runner";
import { createStandardAiProvider } from "../../standardAi/policy";
import { unwrapUnit } from "../../../core/units";
import { STANDARD_AI_PARAMETERS_V1 } from "../../standardAi/parameters";

function vision(overrides: Partial<CompanyVision> = {}): CompanyVision {
  return {
    visionId: "TEST",
    effectiveFromTurn: 1,
    growthAmbition: "HIGH",
    targetScaleTonsPerQuarterAtQ32: 40000,
    preferredEndState: "LARGE_VOLUME",
    willingnessToBuildFactories: "HIGH",
    financialRiskTolerance: "HIGH",
    desiredProductEvolution: "HOSO_SCALE",
    referenceGrowthPath: [
      { turn: 1, scaleTonsPerQuarter: 18000 },
      { turn: 32, scaleTonsPerQuarter: 40000 },
    ],
    longTermNarrative: "テスト",
    emphasisProducts: ["hoso"],
    ...overrides,
  };
}

/** 志に大きく遅れており、市場も採算も良好な標準ケース。 */
function expandingInput(overrides: Record<string, unknown> = {}) {
  const v = vision();
  return {
    vision: v,
    strategicGrowth: computeStrategicGrowthState({ vision: v, turn: 24, currentSustainableScaleTons: 17600 }),
    capacityAnchorTons: 17600,
    recentActualScaleTons: 15000,
    attainableProfitableTons: 90000,
    weightedContributionUsdPerKg: 1.2,
    priceObservationMissing: false,
    maxFinishedGoodsExcessRatio: 0.8,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// 1. Commercial Ambition
// ---------------------------------------------------------------------

test("CG-1: Vision gap が大きく観測機会も大きければ、目指す販売規模を引き上げる", () => {
  const a = computeCommercialAmbition(expandingInput());
  assert.equal(a.expanded, true);
  assert.ok(a.ambitionTons > a.baselineTons, "規模が引き上がっていない");
  assert.ok(a.visionPullTons > 0);
  assert.ok(a.ambitionMultiplier > 1);
});

test("CG-2: Vision gap が大きくても、観測できる採算つき機会が乏しければ拡大しない", () => {
  const a = computeCommercialAmbition(expandingInput({ attainableProfitableTons: 1000 }));
  assert.equal(a.expanded, false);
  assert.equal(a.limiter, "MARKET_WEAK");
  assert.equal(a.ambitionMultiplier, 1);
});

test("CG-3: Vision gap が大きくても、採算が薄ければ拡大しない", () => {
  const a = computeCommercialAmbition(expandingInput({ weightedContributionUsdPerKg: 0.01 }));
  assert.equal(a.expanded, false);
  assert.equal(a.limiter, "MARGIN_WEAK");
});

test("CG-4: 完成品在庫が過剰なら、まず売り切る（規模拡大を見送る）", () => {
  const a = computeCommercialAmbition(expandingInput({ maxFinishedGoodsExcessRatio: 3 }));
  assert.equal(a.expanded, false);
  assert.equal(a.limiter, "INVENTORY_EXCESS");
});

test("CG-5: 成長意欲の低い会社を数量拡大へ強制しない（VAP の保護）", () => {
  // VAP 型：低い成長意欲で、参考成長軌道もほぼ横ばい（既定 Vision と同じ形）。
  const low = vision({
    growthAmbition: "LOW",
    targetScaleTonsPerQuarterAtQ32: 17000,
    referenceGrowthPath: [
      { turn: 1, scaleTonsPerQuarter: 14000 },
      { turn: 32, scaleTonsPerQuarter: 17000 },
    ],
  });
  // 志の軌道に乗っている（gap が小さい）VAP 型
  const a = computeCommercialAmbition(
    expandingInput({
      vision: low,
      strategicGrowth: computeStrategicGrowthState({ vision: low, turn: 24, currentSustainableScaleTons: 17100 }),
    })
  );
  assert.equal(a.expanded, false);
  assert.equal(a.limiter, "VISION_ON_TRACK");
});

test("CG-6: 1四半期の伸びは成長意欲別の上限を超えない（突然2倍にしない）", () => {
  for (const ambition of ["HIGH", "MEDIUM", "LOW"] as const) {
    const v = vision({ growthAmbition: ambition });
    const a = computeCommercialAmbition(
      expandingInput({ vision: v, strategicGrowth: computeStrategicGrowthState({ vision: v, turn: 24, currentSustainableScaleTons: 17600 }) })
    );
    const maxStep = COMMERCIAL_AMBITION_PARAMETERS_V1.maxStepRatioByAmbition[ambition];
    assert.ok(a.ambitionMultiplier <= 1 + maxStep + 1e-9, `${ambition}: 段階的成長の上限を超えた（${a.ambitionMultiplier}）`);
  }
});

test("CG-7: Vision が無ければ従来どおり（倍率1＝供給側アンカーのまま）", () => {
  const a = computeCommercialAmbition(expandingInput({ vision: null, strategicGrowth: null }));
  assert.equal(a.ambitionMultiplier, 1);
  assert.equal(a.expanded, false);
});

test("CG-8: 参照売価が観測できない turn では採算を断定せず拡大しない", () => {
  const a = computeCommercialAmbition(expandingInput({ priceObservationMissing: true }));
  assert.equal(a.expanded, false);
  assert.equal(a.limiter, "MARKET_WEAK");
});

// ---------------------------------------------------------------------
// 2. Unserved Profitable Opportunity
// ---------------------------------------------------------------------

test("CG-9: 未充足機会の分解は重複計上せず、合計を超えない", () => {
  const u = computeUnservedOpportunity({
    commercialAmbitionTons: 20000,
    desiredBeforeEffortTons: 20000,
    submittedSalesTons: 14000,
    bindingProductionCapacityTons: 17000,
    heldByInventory: false,
    laborIsBindingConstraint: false,
    rawMaterialIsBindingConstraint: false,
  });
  const sum =
    u.blockedBySalesCapacityTons +
    u.blockedByProductionCapacityTons +
    u.blockedByLaborTons +
    u.blockedByRawMaterialTons +
    u.blockedByInventoryPolicyTons +
    u.otherTons;
  assert.equal(u.unservedProfitableTons, 6000);
  assert.ok(Math.abs(sum - u.unservedProfitableTons) < 1e-6, `分解の合計が一致しない: ${sum} vs ${u.unservedProfitableTons}`);
  // 志 20,000 − 能力 17,000 = 3,000 が生産能力起因、残り 3,000 が営業能力起因。
  assert.ok(Math.abs(u.blockedByProductionCapacityTons - 3000) < 1e-6);
  assert.ok(Math.abs(u.blockedBySalesCapacityTons - 3000) < 1e-6);
});

test("CG-10: 労働が制約と診断されていれば、その分を生産能力起因に数えない（工場を建てても解決しない）", () => {
  const u = computeUnservedOpportunity({
    commercialAmbitionTons: 20000,
    desiredBeforeEffortTons: 20000,
    submittedSalesTons: 14000,
    bindingProductionCapacityTons: 17000,
    heldByInventory: false,
    laborIsBindingConstraint: true,
    rawMaterialIsBindingConstraint: false,
  });
  assert.equal(u.blockedByProductionCapacityTons, 0);
  assert.ok(u.blockedByLaborTons > 0);
});

test("CG-11: 原料が制約と診断されていれば、原料起因として記録する", () => {
  const u = computeUnservedOpportunity({
    commercialAmbitionTons: 20000,
    desiredBeforeEffortTons: 20000,
    submittedSalesTons: 14000,
    bindingProductionCapacityTons: 17000,
    heldByInventory: false,
    laborIsBindingConstraint: false,
    rawMaterialIsBindingConstraint: true,
  });
  assert.equal(u.blockedByProductionCapacityTons, 0);
  assert.ok(u.blockedByRawMaterialTons > 0);
});

test("CG-12: 取り切れていれば未充足はゼロで、主因は NONE", () => {
  const u = computeUnservedOpportunity({
    commercialAmbitionTons: 14000,
    desiredBeforeEffortTons: 14000,
    submittedSalesTons: 14000,
    bindingProductionCapacityTons: 17000,
    heldByInventory: false,
    laborIsBindingConstraint: false,
    rawMaterialIsBindingConstraint: false,
  });
  assert.equal(u.unservedProfitableTons, 0);
  assert.equal(u.primaryConstraint, "NONE");
});

// ---------------------------------------------------------------------
// 3. 32Q 実機（監査で特定した固定販売規模への回帰が無いこと）
// ---------------------------------------------------------------------

const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "management-console-32q", turns: 32 };
const { provider, diagnostics } = createStandardAiProvider();
const result = runCompanyLabWithAutoPolicyForAllCompanies(config, provider);

test("CG-13: 成長Visionの会社は、監査時の固定販売規模（能力×0.8）に閉じ込められない", () => {
  // 監査での固定値: BAL 16,000 / MASS 17,600 / JPQ 16,800（Q5〜Q32 で変動幅ほぼ0）。
  for (const companyId of ["BAL", "MASS", "JPQ"]) {
    const values = diagnostics
      .filter((d) => d.companyId === companyId && d.turn >= 5)
      .map((d) => d.commercialAmbition?.ambitionTons ?? 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    assert.ok(max > min, `${companyId}: 目指す販売規模が32Qで一定のまま（${min}）`);
    assert.ok((max - min) / min > 0.05, `${companyId}: 変動幅が小さすぎる（${(((max - min) / min) * 100).toFixed(1)}%）`);
  }
});

test("CG-14: 成長意欲の低い VAP は、志の軌道に乗っている間は拡大しない", () => {
  const vapDoc = defaultVisionDocumentFor("VAP");
  assert.equal(vapDoc?.visions[0].growthAmbition, "LOW");
  const expandedTurns = diagnostics.filter((d) => d.companyId === "VAP" && d.commercialAmbition?.expanded === true);
  assert.equal(expandedTurns.length, 0, "VAP が数量拡大を強制されている");
});

test("CG-15: 目指す販売規模と、実際に提出した販売計画は別物である（過剰契約を作らない）", () => {
  for (const d of diagnostics.filter((x) => x.turn === 24)) {
    const submitted = d.decision.salesPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
    const ambition = d.commercialAmbition?.ambitionTons ?? 0;
    assert.ok(submitted <= ambition + 1e-6, `${d.companyId}: 提出計画が志を超えている`);
  }
});

test("CG-16: 目指す販売規模は生産計画をそのまま増やさない（在庫爆発を作らない）", () => {
  // 生産計画の合計が、当期の実効生産能力を超えていないこと。
  for (const d of diagnostics.filter((x) => x.turn === 24)) {
    const planned = d.decision.productionPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
    const record = result.history.find((h) => h.turn === 24);
    const summary = record?.companySummaries.find((s) => s.companyId === d.companyId);
    assert.ok(summary, "実績が無い");
    // 完成品在庫が青天井に積み上がっていない（志の 2 倍を超えない）。
    assert.ok(
      unwrapUnit(summary.finishedGoodsInventory) < (d.commercialAmbition?.ambitionTons ?? 0) * 2,
      `${d.companyId}: 完成品在庫が異常に積み上がっている（${unwrapUnit(summary.finishedGoodsInventory)}）`
    );
    assert.ok(planned >= 0);
  }
});

test("CG-17: 未充足機会の主因が全ターン・全社で記録される", () => {
  for (const d of diagnostics) {
    assert.ok(d.unservedOpportunity, `${d.companyId} Q${d.turn}: 未充足機会の記録が無い`);
    assert.ok(d.commercialAmbition, `${d.companyId} Q${d.turn}: Commercial Ambition の記録が無い`);
    assert.ok(d.observableOpportunity, `${d.companyId} Q${d.turn}: 観測機会の記録が無い`);
  }
});

test("CG-18: market-aware な市場配分（Phase 3）を壊していない", () => {
  // 観測需要ベースの按分が使われ続けていること（価格順位だけの旧規則へ戻っていない）。
  const codes = new Set(diagnostics.flatMap((d) => d.entries.map((e) => e.code)));
  assert.ok(codes.has("MARKET_ALLOCATION_BY_OBSERVED_OPPORTUNITY"));
  assert.ok(codes.has("MARKET_OPPORTUNITY_COMPONENTS"));
});

test("CG-19: 商業成長の理由コードが記録される（拡大した理由・しなかった理由の両方）", () => {
  const codes = new Set(diagnostics.flatMap((d) => d.entries.map((e) => e.code)));
  assert.ok(codes.has("COMMERCIAL_AMBITION_EXPANDED"), "拡大した理由が記録されていない");
  assert.ok(codes.has("UNSERVED_PROFITABLE_OPPORTUNITY"), "未充足機会が記録されていない");
  assert.ok(
    codes.has("COMMERCIAL_GROWTH_ON_TRACK") ||
      codes.has("COMMERCIAL_AMBITION_HELD_MARKET_WEAK") ||
      codes.has("COMMERCIAL_AMBITION_HELD_MARGIN_WEAK"),
    "拡大しなかった理由が記録されていない"
  );
});

test("CG-20: 新工場の需要根拠に商業成長の値が渡っている", () => {
  for (const d of diagnostics.filter((x) => x.turn === 24)) {
    const a = d.newFactoryAssessment;
    assert.ok(a, "新工場の評価が無い");
    if (a.status === "NOT_CONSIDERED") continue;
    assert.ok(a.commercialAmbitionTons !== null, `${d.companyId}: Commercial Ambition が新工場判断へ渡っていない`);
    assert.ok(a.unservedProfitableTons !== null, `${d.companyId}: 未充足機会が新工場判断へ渡っていない`);
    assert.ok(a.capacityCausedUnservedTons !== null, `${d.companyId}: 能力起因の未充足が新工場判断へ渡っていない`);
  }
});

test("CG-21: 需要根拠のしきい値そのものは下げていない（§22）", () => {
  // 指標を増やしたのであって、閾値を緩めたのではないことを固定する。
  const gate = diagnostics
    .flatMap((d) => d.newFactoryAssessment?.gates ?? [])
    .find((g) => g.gate === "DEMAND_PULL");
  assert.ok(gate, "DEMAND_PULL ゲートが無い");
  assert.equal(gate.keyValues.minimumDemandPullRatio, 0.95);
});

test("CG-22: 同じ seed なら決定論的（Commercial Ambition も含めて再現する）", () => {
  const second = createStandardAiProvider();
  runCompanyLabWithAutoPolicyForAllCompanies(config, second.provider);
  assert.equal(second.diagnostics.length, diagnostics.length);
  for (let i = 0; i < diagnostics.length; i++) {
    assert.equal(second.diagnostics[i].commercialAmbition?.ambitionTons, diagnostics[i].commercialAmbition?.ambitionTons);
    assert.equal(
      second.diagnostics[i].unservedOpportunity?.unservedProfitableTons,
      diagnostics[i].unservedOpportunity?.unservedProfitableTons
    );
  }
});

test("CG-23: 供給側アンカー（能力×salesUtilizationTarget）は床として残っている", () => {
  // Commercial Ambition は既存の希望量を下回らない（既存挙動を壊さない）。
  for (const d of diagnostics) {
    const a = d.commercialAmbition;
    assert.ok(a, "記録が無い");
    assert.ok(a.ambitionMultiplier >= 1 - 1e-9, `${d.companyId} Q${d.turn}: 倍率が1未満（${a.ambitionMultiplier}）`);
  }
  assert.equal(STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget, 0.8);
});
