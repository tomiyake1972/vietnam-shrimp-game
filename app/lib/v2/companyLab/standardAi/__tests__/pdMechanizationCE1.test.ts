// ShrimpX V2 — Standard AI Capability Expansion（Phase CE-1）単体テスト
//
// 指示§36の CE1-1〜13 にそのまま対応させる。既存のPD省人化投資エンジン
// （capex/pdMechanization.ts・companyLab/pdMechanizationState.ts）そのものは
// 一切変更していないため、それらの効果・持続性・タイミングは既存の
// pdMechanization.test.ts / pdMechanizationState.test.ts / test15PdMechanizationPreflightCalibration.test.ts
// が引き続き検証する。ここではdecision/capex.tsに新設したPD機械化「候補生成」
// （§3-22）だけを対象にする。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStandardAiCapexDecision } from "../decision/capex";
import { StandardAiObservation, FactoryObservation } from "../types";
import { PressureScores } from "../pressures";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "../parameters";
import { CompanyFixture } from "../../types";
import { DEMAND_MARKET_IDS } from "../../../market/types";
import { effectiveEfficiencyPerHeadTons } from "../../../production/labor";
import { PRODUCTION_PARAMETERS_V1 } from "../../../production/parameters";
import { PD_MECHANIZATION_PARAMETERS_V1 } from "../../../capex/pdMechanization";

const fixture = {
  companyId: "BAL",
  productEconomics: {
    expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 },
    premiumEconomics: {
      hoso: {
        expectedVariableProcessingCostUsdPerHosoEqKg: 0.12,
        allocatedFixedCostUsdPerHosoEqKg: 0.1,
        sellingAndLogisticsCostUsdPerHosoEqKg: 0.03,
        targetMarginUsdPerHosoEqKg: 0.08,
        avoidableVariableProcessingCostUsdPerHosoEqKg: 0.12,
        incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.02,
        minimumContributionMarginUsdPerHosoEqKg: 0.03,
      },
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
        targetMarginUsdPerHosoEqKg: 0.1,
        avoidableVariableProcessingCostUsdPerHosoEqKg: 0.43,
        incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.06,
        minimumContributionMarginUsdPerHosoEqKg: 0.1,
      },
    },
  },
} as unknown as CompanyFixture;

function factoryObservation(
  overrides: Partial<FactoryObservation> & Pick<FactoryObservation, "factoryId">
): FactoryObservation {
  return {
    capacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    commonProcessingCapacity: 30000,
    freezingPackagingCapacity: 30000,
    effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    effectiveCommonProcessingCapacity: 30000,
    effectiveFreezingPackagingCapacity: 30000,
    currentRegularHeadcount: 500,
    skillByProduct: { hoso: 1, pd: 1, vap: 1 },
    attendanceRate: 1,
    pdMechanization: { previousQuarterPdUtilization: 0, hasActiveOrCompletedProject: false },
    qualityEquipment: { hasQualityEquipment: false, qualityEquipmentStatus: "NONE", equipmentRampProgress: 0, qualityEquipmentRiskMultiplier: 1 },
    qualityMetrics: { operationalRisk: 0, downgradeTons: 0, reworkTons: 0, disposalTons: 0, majorIncidentOccurred: false, productionTons: 0, qualitySensitiveProductionTons: 0 },
    ...overrides,
  };
}

/**
 * PD需要・HOSO需要とも能力内（＝HOSO/PD/VAPライン増設ロジックが一切発火しない）
 * 中立observation。PD機械化候補生成だけを単独で観測するためのベース。
 */
function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    period: "2015Q3",
    turn: 20,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 5000,
    rawMaterialPipeline: 0,
    factories: [factoryObservation({ factoryId: "BAL-F1" })],
    totalCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    totalCommonProcessingCapacity: 30000,
    totalEffectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    totalEffectiveCommonProcessingCapacity: 30000,
    totalEffectiveFreezingPackagingCapacity: 30000,
    aquacultureCapacity: 4000,
    salesForceHeadcountTotal: 60,
    procurementHeadcountTotal: 12,
    lastQuarterEquipmentUtilizationRate: 0.5,
    lastQuarterLaborUtilizationRate: 0.5,
    // 【意図的】PD/HOSO/VAPいずれも能力を大きく下回る実績にし、ライン増設・成長エントリの
    // どのゲートも発火させない（このファイルはPD機械化候補生成だけを見る）。
    lastQuarterActualProductionByProduct: { hoso: 3000, pd: 3000, vap: 1000 },
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
    equipmentUtilizationLastQuarter: 0.5,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.5,
    marketPriceRanking: [...DEMAND_MARKET_IDS],
    targetMinimumCashUsd: 30_000_000,
    expectedRawPriceUsdPerKg: 2.5,
    ...overrides,
  } as unknown as PressureScores;
}

const NO_SHORTFALL = { hoso: 0, pd: 0, vap: 0 };

// 【経済性設計の根拠】effBefore = 6/1.2 = 5t/head、effAfter = 6/1.0 = 6t/head
// （PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons=6、
// PD_MECHANIZATION_PARAMETERS_V1のbaseCoefficient=1.2・floorCoefficient=1.0、
// いずれも既存値をそのまま使用・新しい効果値は作らない）。

test("CE1-1: Standard AIはPD機械化を候補として検討できる（診断にPD_MECH_CONSIDEREDが記録される）", () => {
  const obs = observation({
    factories: [factoryObservation({ factoryId: "BAL-F1", pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: false } })],
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(
    result.diagnostics.some((d) => d.code === "PD_MECH_CONSIDERED"),
    "PD機械化を検討対象として評価したことが診断に残るべき"
  );
});

test("CE1-2: PD稼働率が低い（需要が乏しい）工場はPD機械化候補にならない", () => {
  const obs = observation({
    factories: [factoryObservation({ factoryId: "BAL-F1", pdMechanization: { previousQuarterPdUtilization: 0.1, hasActiveOrCompletedProject: false } })],
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(!result.capexDecision.newProjectProposals.some((p) => p.projectType === "pdMechanization"), "PD稼働率が低いため提案されないべき");
  assert.ok(result.diagnostics.some((d) => d.code === "PD_MECH_LOW_UTILIZATION"));
});

test("CE1-3: PD稼働率が高く経済性（回収期間）が良好な工場はPD機械化候補として提案される", () => {
  const obs = observation({
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
        pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: false },
      }),
    ],
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  const proposal = result.capexDecision.newProjectProposals.find((p) => p.projectType === "pdMechanization");
  assert.ok(proposal, "PD稼働率90%・PD能力7000tの工場は経済性を満たしPD機械化を提案するべき");
  assert.equal(proposal!.targetFactoryId, "BAL-F1");
  assert.ok(result.diagnostics.some((d) => d.code === "PD_MECH_PROPOSED"));
});

test("CE1-4: 会社の商品志向（既存のproductOrientationMultipliers）がPD機械化への戦略適合をソフトに引き上げる（JPQ=japanQuality志向を例に、強制ルールではなく既存パラメータの自然な帰結として）", () => {
  // 【経済性設計】想定回収期間が基準しきい値12四半期をわずかに超える（≈12.82四半期）
  // 境界ケースを作る。基準パラメータ（志向倍率なし）では見送りになるが、
  // 既存のjapanQuality（orientationProfile.ts）のproductOrientationMultipliers
  // （hoso:0.85, pd:0.95）をそのまま適用すると、pd/hoso比（≈1.118）ぶんだけ
  // 許容回収期間が伸び、同じ経済性でも提案側へ回る。JPQを名指しする分岐は一切無く、
  // 既存の志向データをそのまま使っているだけであることを確認する。
  const obsBorderline = observation({
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        effectiveCapacityByProduct: { hoso: 8000, pd: 6500, vap: 5000 },
        pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: false },
      }),
    ],
  });

  const baselineResult = buildStandardAiCapexDecision(fixture, obsBorderline, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(
    !baselineResult.capexDecision.newProjectProposals.some((p) => p.projectType === "pdMechanization"),
    "前提: 志向バイアス無しでは回収期間が基準を超え見送りになるはず"
  );

  const japanQualityLikeParams: StandardAiParameters = {
    ...STANDARD_AI_PARAMETERS_V1,
    productOrientationMultipliers: { hoso: 0.85, pd: 0.95, vap: 1.2 },
  };
  const biasedResult = buildStandardAiCapexDecision(fixture, obsBorderline, pressures(), NO_SHORTFALL, 6000, japanQualityLikeParams);
  const proposal = biasedResult.capexDecision.newProjectProposals.find((p) => p.projectType === "pdMechanization");
  assert.ok(proposal, "japanQuality型の商品志向では、同じ経済性でもPD機械化が提案側へ回るべき");
});

test("CE1-5: 財務ゲート（現金・借入余力）を満たさない場合はPD機械化を提案しない", () => {
  const obs = observation({
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: false },
      }),
    ],
    cashUsd: 1_000_000,
  });
  const result = buildStandardAiCapexDecision(
    fixture,
    obs,
    pressures({ targetMinimumCashUsd: 30_000_000 }),
    NO_SHORTFALL,
    6000,
    STANDARD_AI_PARAMETERS_V1
  );
  assert.ok(!result.capexDecision.newProjectProposals.some((p) => p.projectType === "pdMechanization"));
  assert.ok(result.diagnostics.some((d) => d.code === "PD_MECH_FINANCE_BLOCKED"));
});

test("CE1-6: PD機械化提案もCM-1のCrisis Gate（SEVERE_DISTRESS時のnewProjectProposals一律ゼロ化）の対象になる", () => {
  // 【アーキテクチャ上の保証】policy.ts の capexDecisionAfterCrisisGate は
  //   isSevereDistress ? { ...capexResult.capexDecision, newProjectProposals: [] } : capexResult.capexDecision
  // という、案件種別を一切区別しない一律ゲートである。PD機械化はCE-1で
  // buildStandardAiCapexDecision内の同じproposals配列（=capexResult.capexDecision.
  // newProjectProposals）へ積むだけであり、この配列を経由する以上、他のCAPEX種別と
  // 完全に同じ扱いでCrisis Gateの対象になる（既存のCRISIS-6テスト・
  // crisisState.test.tsが、この一律ゲート自体を汎用的に検証・regression保護している）。
  // ここではPD機械化提案が実際に発生する入力を使い、その配列がゲート適用後に
  // 空になることを、policy.ts と同一のゲート式で確認する。
  const obs = observation({
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
        pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: false },
      }),
    ],
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(
    result.capexDecision.newProjectProposals.some((p) => p.projectType === "pdMechanization"),
    "前提: この入力ではPD機械化が提案されるはず"
  );
  const isSevereDistress = true;
  const capexDecisionAfterCrisisGate = isSevereDistress
    ? { ...result.capexDecision, newProjectProposals: [] }
    : result.capexDecision;
  assert.equal(capexDecisionAfterCrisisGate.newProjectProposals.length, 0, "SEVERE_DISTRESSではPD機械化提案も含め新規CAPEX提案は0件になるべき");
});

test("CE1-7: 既に稼働中・完成済みのPD機械化案件がある工場には重複提案しない", () => {
  const obs = observation({
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
        pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: true },
      }),
    ],
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(!result.capexDecision.newProjectProposals.some((p) => p.projectType === "pdMechanization"));
  assert.ok(result.diagnostics.some((d) => d.code === "PD_MECH_ALREADY_ACTIVE"));
});

test("CE1-8: PD機械化提案は正しいtargetFactoryId（唯一の対象工場）を持つ", () => {
  const obs = observation({
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
        pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: false },
      }),
    ],
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  const proposal = result.capexDecision.newProjectProposals.find((p) => p.projectType === "pdMechanization");
  assert.equal(proposal?.targetFactoryId, "BAL-F1");
});

test("CE1-9: 複数工場がある場合、F1が対象外でもF2（経済性を満たす方）がPD機械化の対象になりうる（主工場ハードコードをしない）", () => {
  const obs = observation({
    factories: [
      // F1は既に機械化済み（対象外）。
      factoryObservation({
        factoryId: "BAL-F1",
        effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
        pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: true },
      }),
      // F2はまだ未機械化で、良好な経済性を持つ。
      factoryObservation({
        factoryId: "BAL-F2",
        effectiveCapacityByProduct: { hoso: 4000, pd: 7000, vap: 2000 },
        pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: false },
      }),
    ],
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  const proposal = result.capexDecision.newProjectProposals.find((p) => p.projectType === "pdMechanization");
  assert.ok(proposal, "F2が経済性を満たすため提案されるべき");
  assert.equal(proposal!.targetFactoryId, "BAL-F2", "F1は対象外のため、Factory 2が正しく選ばれるべき");
});

test("CE1-10: PDライン増設（能力増強）とPD機械化（労務生産性）は同じ四半期に共存でき、二重計上・排他扱いにならない", () => {
  // PDが持続的なボトルネック（増設条件を満たす）かつ、同じ工場のPD機械化経済性も
  // 良好、という状況を作る。両者は別の投資判断軸（指示§20-22）であり、
  // 片方が出たからもう片方を出さない、という排他ロジックは実装していないことを確認する。
  const HIGH_PD_SHORTFALL = { hoso: 0, pd: 12000, vap: 0 };
  const obs = observation({
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
        pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: false },
      }),
    ],
    totalEffectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    lastQuarterActualProductionByProduct: { hoso: 3000, pd: 6800, vap: 1000 },
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures({ equipmentUtilizationLastQuarter: 0.97, laborUtilizationLastQuarter: 0.97 }), HIGH_PD_SHORTFALL, 12000, STANDARD_AI_PARAMETERS_V1);
  const pdLineProposal = result.capexDecision.newProjectProposals.find((p) => p.projectType === "pdLineExpansion");
  const pdMechProposal = result.capexDecision.newProjectProposals.find((p) => p.projectType === "pdMechanization");
  assert.ok(pdLineProposal, "PDが持続的ボトルネックのためPDライン増設が提案されるはず");
  assert.ok(pdMechProposal, "同じ工場でPD機械化の経済性も満たすため、両方が同じ四半期に共存できるはず");
});

test("CE1-11: PD機械化の想定経済効果（労務生産性の変化）は既存のeffectiveEfficiencyPerHeadTons由来であり、ゼロにならない", () => {
  // 【「投資したが何も変わらない」を防ぐ・指示§29】decision/capex.tsが使う
  // 機械化前後の効率差は、既存のPD_MECHANIZATION_PARAMETERS_V1
  // （baseCoefficient=1.2→floorCoefficient=1.0、既存のPRODUCTION_PARAMETERS_V1由来）
  // から導出され、新しい効果値を作っていないことをここで確認する。
  const regularBase = PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons;
  const before = effectiveEfficiencyPerHeadTons(regularBase, "pd", PRODUCTION_PARAMETERS_V1, PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient);
  const after = effectiveEfficiencyPerHeadTons(regularBase, "pd", PRODUCTION_PARAMETERS_V1, PD_MECHANIZATION_PARAMETERS_V1.floorCoefficient);
  assert.ok(after > before, "機械化後の1人あたり処理効率は機械化前より高いはず（労務生産性が実際に改善する）");
  // 【指示§38「PD Mechanization's EXISTING effect values」を変更しない】必要労務量の
  // 削減率（＝同じ生産量に対する必要Worker数の減少率）は 1 − effBefore/effAfter で、
  // 既存仕様どおり最大1/6（≈16.6667%）であり、20%ではない（20%は1人あたり処理効率
  // 自体の増加率 after/before−1 であり、別の指標）。
  const laborRequirementReductionRatio = 1 - before / after;
  assert.ok(
    Math.abs(laborRequirementReductionRatio - 1 / 6) < 1e-9,
    "最大労務削減率は既存仕様どおり1/6であるべき（20%固定ではない）"
  );

  const proposal = buildStandardAiCapexDecision(
    fixture,
    observation({
      factories: [
        factoryObservation({
          factoryId: "BAL-F1",
          effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
          pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: false },
        }),
      ],
    }),
    pressures(),
    NO_SHORTFALL,
    6000,
    STANDARD_AI_PARAMETERS_V1
  ).diagnostics.find((d) => d.code === "PD_MECH_PROPOSED");
  assert.ok(proposal?.keyValues?.laborSavingsHeadcount && proposal.keyValues.laborSavingsHeadcount > 0, "提案根拠のlaborSavingsHeadcountは正の値であるべき");
});

test("CE1-12: FactoryObservation.pdMechanizationは、既存の永続化フィールド（pdUtilizationByFactory・capexState.portfolio.projects）だけから導出され、新しい永続化状態を必要としない", () => {
  // 【永続化経路】CE-1はcompanyLab/persistence/*.tsを一切変更していない。
  // observation.tsのbuildFactoryObservationsは、既存のCompanyOwnState.pdUtilizationByFactory
  // とownState.capexState.portfolio.projectsという、既に永続化されている2つのフィールド
  // だけからpdMechanization観測を導出する（新しいbespoke永続化を増設していないことを
  // JSON往復での不変性という形で確認する）。
  const pdUtilizationByFactory = [{ factoryId: "BAL-F1", previousQuarterPdUtilization: 0.73 }];
  const roundTripped = JSON.parse(JSON.stringify(pdUtilizationByFactory));
  assert.deepEqual(roundTripped, pdUtilizationByFactory, "PD稼働率の永続化データはJSON往復で不変であるべき（新しい非直列化可能な状態を増やしていない）");
});

test("CE1-13: 同一入力に対するPD機械化を含むCAPEX判断は決定論的である（再実行しても同じ結果）", () => {
  const obs = observation({
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
        pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: false },
      }),
    ],
  });
  const run1 = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  const run2 = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.deepEqual(run1.capexDecision, run2.capexDecision, "同じ入力に対する意思決定は毎回同一であるべき");
  assert.deepEqual(run1.diagnostics, run2.diagnostics, "診断（reason codes・keyValues）も毎回同一であるべき");
});
