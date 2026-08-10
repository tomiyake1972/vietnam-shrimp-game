// ShrimpX V2 — Phase 6D-1: 修正A（既存CAPEX提案のスペース実現可能性）
// ＋ 修正B（Sustainable Scale の binding capacity 統一）テスト
//
// 【背景（Phase 6D 監査で確認した2つのbug）】
//   A. capex.ts は既存増設を提案する前にスペースを確認しておらず、
//      承認ゲートで却下され続ける実行不能な提案を毎四半期繰り返していた。
//      その「提案が存在する」という事実だけが decision/newFactory.ts の
//      Gate G（EXISTING_EXPANSION_FIRST）を通じて新工場判断を無期限に block した。
//   B. targetScale.ts の currentSustainableScaleTons は
//      「商品別ラインの合計」だけを使い、min(ライン計, 共通前処理) を取らなかった。
//      decision/newFactory.ts の Gate H は既に min を使っており SSoT が割れていた。
//
// 【今回変更していないもの】New Factory の閾値（0.75/0.95/1.15/3,000/0.3/圧力段階）・
// factory cost・factory capacity・lead time・worker productivity・sales capacity・
// market・competitiveness・Scenario。

import test from "node:test";
import assert from "node:assert/strict";

import { buildStandardAiCapexDecision } from "../decision/capex";
import { computeTargetScaleBand } from "../targetScale";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { STANDARD_AI_STRATEGIC_INTENT_V1 } from "../strategicIntent";
import { computeCandidateProjectSpaceUnits } from "../../../capex/factorySpace";
import { CAPEX_PARAMETERS_V1 } from "../../../capex/parameters";
import { StandardAiObservation } from "../types";
import { PressureScores } from "../pressures";
import { CompanyFixture, CompanyLabConfig } from "../../types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../../runner";
import { createStandardAiProvider } from "../policy";

const fixture = {
  companyId: "BAL",
  productEconomics: {
    expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 },
    premiumEconomics: {
      pd: {
        expectedVariableProcessingCostUsdPerHosoEqKg: 0.17,
        allocatedFixedCostUsdPerHosoEqKg: 0.15,
        sellingAndLogisticsCostUsdPerHosoEqKg: 0.05,
        targetMarginUsdPerHosoEqKg: 0.15,
        avoidableVariableProcessingCostUsdPerHosoEqKg: 0.17,
        incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.03,
        minimumContributionMarginUsdPerHosoEqKg: 0.05,
      },
      vap: {
        expectedVariableProcessingCostUsdPerHosoEqKg: 0.43,
        allocatedFixedCostUsdPerHosoEqKg: 0.35,
        sellingAndLogisticsCostUsdPerHosoEqKg: 0.1,
        targetMarginUsdPerHosoEqKg: 0.3,
        avoidableVariableProcessingCostUsdPerHosoEqKg: 0.43,
        incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.06,
        minimumContributionMarginUsdPerHosoEqKg: 0.1,
      },
    },
  },
} as unknown as CompanyFixture;

/** commonProcessingExpansion 相当のボトルネックを作る合成observation（スペースだけ差し替え可能）。 */
function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    period: "2015Q6",
    turn: 6,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 5000,
    rawMaterialPipeline: 0,
    factories: [],
    totalCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    totalCommonProcessingCapacity: 20000,
    totalEffectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    totalEffectiveCommonProcessingCapacity: 20000,
    totalEffectiveFreezingPackagingCapacity: 30000,
    aquacultureCapacity: 4000,
    salesForceHeadcountTotal: 60,
    procurementHeadcountTotal: 12,
    lastQuarterEquipmentUtilizationRate: 0.95,
    lastQuarterLaborUtilizationRate: 0.85,
    // 共通前処理が持続的にボトルネック（実績19,000 / 能力20,000 = 95%）。
    lastQuarterActualProductionByProduct: { hoso: 12000, pd: 5000, vap: 2000 },
    markets: [],
    marketPremiumByProduct: { pd: 1.0, vap: 3.0 },
    vietnamDomesticPriorPrice: 4.0,
    lastHosoPriceVn: 5.0,
    productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 } },
    cashUsd: 200_000_000,
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 600,
    receivablesDueThisPeriodUsd: 0,
    receivablesNotYetDueUsd: 0,
    payablesDueThisPeriodUsd: 0,
    payablesNotYetDueUsd: 0,
    existingLoanInterestUsdThisQuarterEstimate: 0,
    existingLoanScheduledPrincipalDueUsdThisQuarterEstimate: 0,
    activeCapexProjectTargets: new Set(),
    suspendedCapexProjectIds: [],
    qualityScoreByProduct: {},
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
    factorySpaceTotalUnits: 100_000,
    factorySpaceUsedUnits: 99_600,
    factorySpaceRemainingUnits: 400, // commonProcessingExpansion(560units)には不足
    ...overrides,
  } as unknown as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
  return {
    contractFulfillmentPressure: 0,
    finishedGoodsExcessRatioByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialInventoryPosition: 5000,
    cashPressure: 0,
    borrowingPressure: 0.1,
    equipmentUtilizationLastQuarter: 0.95,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.85,
    targetMinimumCashUsd: 10_000_000,
    ...overrides,
  } as unknown as PressureScores;
}

const NEEDED = { hoso: 15000, pd: 7000, vap: 3000 };

function capex(obs: StandardAiObservation, pr: PressureScores) {
  return buildStandardAiCapexDecision(fixture, obs, pr, NEEDED, 25000, STANDARD_AI_PARAMETERS_V1);
}

// ---------------------------------------------------------------------
// A. スペース不足のCAPEXを提案しない
// ---------------------------------------------------------------------

test("Phase6D1-A: 必要スペースが残スペースを上回る既存増設候補は提案しない", () => {
  const requiredUnits = computeCandidateProjectSpaceUnits("commonProcessingExpansion", CAPEX_PARAMETERS_V1);
  assert.ok(requiredUnits > 400, "テストの前提: commonProcessingExpansionの必要スペースは400units超");
  const r = capex(observation({ factorySpaceRemainingUnits: 400 }), pressures());
  assert.ok(
    !r.capexDecision.newProjectProposals.some((p) => p.projectType === "commonProcessingExpansion"),
    "スペース不足の候補が提案されている"
  );
  const spaceEntry = r.diagnostics.find(
    (d) => d.code === "CAPEX_DEFERRED_INSUFFICIENT_SPACE" && d.decisionSummary?.startsWith("commonProcessingExpansion")
  );
  assert.ok(spaceEntry, "スペース不足の理由コードが記録されていない");
  assert.equal(spaceEntry?.keyValues?.requiredSpaceUnits, requiredUnits);
});

test("Phase6D1-A2: スペースが十分なら従来どおり提案する（増設そのものを禁止しない）", () => {
  const requiredUnits = computeCandidateProjectSpaceUnits("commonProcessingExpansion", CAPEX_PARAMETERS_V1);
  // 全候補（hoso/pd/vapライン増設＋共通前処理）が実行可能なだけの十分なスペースを与える。
  const r = capex(observation({ factorySpaceRemainingUnits: 4000 + 700 + 750 + requiredUnits + 1000 }), pressures());
  assert.ok(r.capexDecision.newProjectProposals.some((p) => p.projectType === "commonProcessingExpansion"));
  assert.ok(
    !r.diagnostics.some(
      (d) => d.code === "CAPEX_DEFERRED_INSUFFICIENT_SPACE" && d.decisionSummary?.startsWith("commonProcessingExpansion")
    )
  );
});

test("Phase6D1-A3: 観測にスペースの概念が無い（テスト用合成observation等）場合は既存挙動を維持する", () => {
  const obs = observation();
  delete (obs as unknown as { factorySpaceRemainingUnits?: number }).factorySpaceRemainingUnits;
  const r = capex(obs, pressures());
  // 捏造しない: スペースを検証していない呼び出し元では、常に十分（無限大）として扱う。
  assert.ok(r.capexDecision.newProjectProposals.some((p) => p.projectType === "commonProcessingExpansion"));
});

// ---------------------------------------------------------------------
// B. スペース不足の候補は新工場のEXISTING_EXPANSION_FIRSTをblockしない
// ---------------------------------------------------------------------

test("Phase6D1-B: existingExpansionProposedThisQuarter は、スペース不足で提案されなかった候補を含まない", () => {
  const r = capex(observation({ factorySpaceRemainingUnits: 400 }), pressures());
  // 【SSoT】policy.ts は existingExpansionProposedThisQuarter を
  // capexDecision.newProjectProposals.length > 0 から導出する。
  // スペース不足の候補は proposals に入らないため、この判定は自動的に false になる。
  assert.equal(r.capexDecision.newProjectProposals.length, 0, "実行不能な候補以外に提案がないこと（テストの前提）");
});

// ---------------------------------------------------------------------
// C. 却下され続ける再提案をしない（32Q実測）
// ---------------------------------------------------------------------

test("Phase6D1-C: baseline 32Qで、スペース不足によるengine却下（rejectedProposals）が同一会社×同一種別で無限に続かない", () => {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "management-console-32q", turns: 32 };
  const { provider } = createStandardAiProvider();
  const result = runCompanyLabWithAutoPolicyForAllCompanies(config, provider);

  const rejectionsByCompanyType = new Map<string, number[]>();
  for (const h of result.history) {
    for (const c of h.capexResults) {
      for (const rp of c.rejectedProposals) {
        const key = `${c.companyId}::${rp.projectType}`;
        const arr = rejectionsByCompanyType.get(key) ?? [];
        arr.push(h.turn);
        rejectionsByCompanyType.set(key, arr);
      }
    }
  }
  for (const [key, turns] of rejectionsByCompanyType) {
    assert.ok(
      turns.length < 8,
      `${key}: ${turns.length}四半期連続で却下され続けている（Phase 6B/6C以前は最大10回連続だった）: ${turns.join(",")}`
    );
  }
});

// ---------------------------------------------------------------------
// D. sustainable scale = min(line total, common)
// ---------------------------------------------------------------------

test("Phase6D1-D: currentSustainableScaleTons は min(商品別ライン合計, 共通前処理能力) と一致する", () => {
  const obs = observation({
    totalEffectiveCapacityByProduct: { hoso: 17100, pd: 7439, vap: 4916 }, // 計 29,455（JPQ実測を再現）
    totalEffectiveCommonProcessingCapacity: 26249,
    lastQuarterActualProductionByProduct: { hoso: 14794, pd: 6436, vap: 4253 },
  });
  const result = computeTargetScaleBand(fixture, obs, STANDARD_AI_STRATEGIC_INTENT_V1, STANDARD_AI_PARAMETERS_V1);
  assert.equal(result.currentSustainableScaleTons, 26249, "ライン計29,455ではなく共通前処理26,249を使うこと");
});

test("Phase6D1-D2: 共通前処理がライン合計より大きい会社では、従来どおりライン合計が sustainable になる", () => {
  const obs = observation({
    totalEffectiveCapacityByProduct: { hoso: 8000, pd: 5000, vap: 3000 }, // 計 16,000
    totalEffectiveCommonProcessingCapacity: 25000,
    lastQuarterActualProductionByProduct: { hoso: 7000, pd: 4000, vap: 2000 },
  });
  const result = computeTargetScaleBand(fixture, obs, STANDARD_AI_STRATEGIC_INTENT_V1, STANDARD_AI_PARAMETERS_V1);
  assert.equal(result.currentSustainableScaleTons, 16000);
});

// ---------------------------------------------------------------------
// E. JPQ fixtureで誤ったonTrack判定を再現しない
// ---------------------------------------------------------------------

test("Phase6D1-E: JPQ Q32相当のfixtureで、修正前は誤ってonTrackだった状態が正しくgrowth pressureへ分類される", () => {
  const obs = observation({
    totalEffectiveCapacityByProduct: { hoso: 17100, pd: 7439, vap: 4916 },
    totalEffectiveCommonProcessingCapacity: 26249,
    lastQuarterActualProductionByProduct: { hoso: 14794, pd: 6436, vap: 4253 },
  });
  const targetScale = computeTargetScaleBand(fixture, obs, STANDARD_AI_STRATEGIC_INTENT_V1, STANDARD_AI_PARAMETERS_V1);
  // Vision参考規模30,000に対し、修正前は29,455（ライン計）でgap=1.8%=LOW=onTrackだった。
  // 修正後は26,249（binding）でgap=12.5%となり、LOWの帯を抜ける。
  const visionReference = 30000;
  const gapRatio = (visionReference - targetScale.currentSustainableScaleTons) / visionReference;
  assert.ok(gapRatio > 0.05, `修正後のgapRatio(${gapRatio.toFixed(3)})はMODERATE以上の帯に入ること`);
});

// ---------------------------------------------------------------------
// F〜H / K. baseline 32Qでの会社別判断（統合確認）
// ---------------------------------------------------------------------

function runBaseline32Q() {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "management-console-32q", turns: 32 };
  const { provider, diagnostics } = createStandardAiProvider();
  const result = runCompanyLabWithAutoPolicyForAllCompanies(config, provider);
  return { result, diagnostics };
}

test("Phase6D1-F: MASS は2工場を保有した状態で、Q32時点で3工場目を不合理に提案しない", () => {
  const { diagnostics } = runBaseline32Q();
  const massQ32 = diagnostics.find((d) => d.turn === 32 && d.companyId === "MASS");
  assert.ok(massQ32?.newFactoryAssessment);
  assert.notEqual(massQ32?.newFactoryAssessment?.status, "READY_TO_BUILD");
  assert.notEqual(massQ32?.newFactoryAssessment?.status, "CONSIDERING");
});

test("Phase6D1-G: CONSV は既存工場スペースに余地があり、Existing Space First の性質を維持する", () => {
  const { diagnostics } = runBaseline32Q();
  const consvQ32 = diagnostics.find((d) => d.turn === 32 && d.companyId === "CONSV");
  const spaceGate = consvQ32?.newFactoryAssessment?.gates.find((g) => g.gate === "EXISTING_SPACE_FIRST");
  // CONSVはVISION_GROWTH_GAP/GROWTH_PRESSUREまでしか評価が進まない（MONITORING）ため
  // EXISTING_SPACE_FIRSTは未到達で構わないが、到達した場合は残スペースが閾値超であること。
  if (spaceGate) {
    assert.ok(spaceGate.keyValues.factorySpaceRemainingUnits > spaceGate.keyValues.existingSpaceSufficientUnits);
  }
});

test("Phase6D1-H: VAP は志の範囲内（onTrack）のままである", () => {
  const { diagnostics } = runBaseline32Q();
  const vapQ32 = diagnostics.find((d) => d.turn === 32 && d.companyId === "VAP");
  assert.equal(vapQ32?.strategicGrowth?.onTrack, true);
  assert.equal(vapQ32?.newFactoryAssessment?.status, "NOT_CONSIDERED");
});

// ---------------------------------------------------------------------
// I / J. Sales Hiring / Commercial Commitment への波及がないこと
// ---------------------------------------------------------------------

test("Phase6D1-I: Sales Hiring の主要診断フィールドは32Q全ターンで有限値のまま壊れない", () => {
  const { diagnostics } = runBaseline32Q();
  for (const d of diagnostics) {
    const h = d.salesHiring;
    if (!h) continue;
    assert.ok(Number.isFinite(h.currentHeadcount));
    assert.ok(Number.isFinite(h.requiredHeadcount));
    assert.ok(h.currentHeadcount >= 0);
  }
});

test("Phase6D1-J: Commercial Commitment（提出量の上限）は32Q全ターンで有限・非負のまま壊れない", () => {
  const { diagnostics } = runBaseline32Q();
  for (const d of diagnostics) {
    const c = d.commercialCommitment;
    if (!c) continue;
    assert.ok(Number.isFinite(c.submissionTargetTons));
    assert.ok(c.submissionTargetTons >= 0);
  }
});

// ---------------------------------------------------------------------
// K. 決定論
// ---------------------------------------------------------------------

test("Phase6D1-K: baseline 32Qを2回実行すると、New Factory assessment・sustainable scaleが完全に一致する", () => {
  const a = runBaseline32Q();
  const b = runBaseline32Q();
  const fingerprint = (r: ReturnType<typeof runBaseline32Q>) =>
    r.diagnostics
      .map(
        (d) =>
          `${d.turn}:${d.companyId}:${d.newFactoryAssessment?.status}:${d.strategicGrowth?.currentSustainableScaleTons.toFixed(3)}`
      )
      .join("|");
  assert.equal(fingerprint(a), fingerprint(b));
});

// ---------------------------------------------------------------------
// L. Analysis Pack（gate keyValuesにスペース情報が残ること）
// ---------------------------------------------------------------------

test("Phase6D1-L: 新工場のEXISTING_EXPANSION_FIRSTゲートのkeyValuesに、当期の既存増設提案有無が残る", () => {
  const { diagnostics } = runBaseline32Q();
  const bal = diagnostics.find((d) => d.turn === 20 && d.companyId === "BAL");
  const gate = bal?.newFactoryAssessment?.gates.find((g) => g.gate === "EXISTING_EXPANSION_FIRST");
  if (gate) {
    assert.ok("existingExpansionProposed" in gate.keyValues);
  }
});
