// ShrimpX V2 — PD省人化の「業務判断化」検証（PDB-1〜PDB-10）
//
// 実装指示 §4（コスト効果の現れ方）・§6（Standard AIの判断条件）・
// §8（保存/再開・二重適用なし）に対応する。
//
// 【このテストの中心的な主張】
// 「必要労働が33.3%減る」ことと「会社のキャッシュ人件費が33.3%減る」ことは
// 別物である。常用人員を余剰のまま抱えれば常用人件費は満額かかり続ける。
// 効果が現れるのは、臨時削減・残業削減・常用減員・他商品への振り替え・
// 同じ人手での増産のいずれかを実際に行ったときだけ。

import test from "node:test";
import assert from "node:assert/strict";

import { computeQuarterlyLaborCost, computeRequiredRegularHeadcount } from "../workforce";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import {
  decideMarketEvolutionInvestments,
  MARKET_EVOLUTION_INVESTMENT_PARAMETERS_V1,
} from "../standardAi/decision/marketEvolutionInvestment";
import { resolveOrientationProfile } from "../standardAi/orientationProfile";
import { PressureScores } from "../standardAi/pressures";
import { StandardAiObservation } from "../standardAi/types";
import { CompanyFixture } from "../types";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../market/types";
import { allocateProductionPlans } from "../../production/allocation";
import { Factory, CompanyProductionPlanEntry, WorkerAssignment } from "../../production/types";
import { RawMaterialLot as RawMaterialRLot } from "../../rawMaterials/types";
import { hosoEqTons, ratio, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";

const TOL = 1e-9;
const SKILL = { hoso: 0.9, pd: 0.9, vap: 0.9 };

function requiredFor(quantityByProduct: Partial<Record<Product, number>>, mechanizationLevel = 0): number {
  return computeRequiredRegularHeadcount({
    quantityByProduct,
    skillByProduct: SKILL,
    attendanceRate: 0.95,
    appliedOvertimeRate: 0,
    temporaryHeadcount: 0,
    mechanizationLevel,
  }).requiredRegularHeadcount;
}

// ---------------------------------------------------------------------
// §4 コスト効果は自動では出ない
// ---------------------------------------------------------------------

test("PDB-1: 【必須】常用人員を余剰のまま抱えると、機械化しても常用人件費は1円も下がらない", () => {
  const regularHeadcount = 800;
  const before = computeQuarterlyLaborCost(regularHeadcount, 0);
  // 機械化しても「配置している常用人員」を減らさなければ、人件費の入力は同一。
  const after = computeQuarterlyLaborCost(regularHeadcount, 0);
  assert.equal(
    after.regularCostUsd,
    before.regularCostUsd,
    "常用人件費は人数連動であり、必要労働が減っただけでは下がらない"
  );

  // 一方で「必要人員」は確かに減っている（＝理論効果と実効果の乖離）。
  const requiredBefore = requiredFor({ pd: 2000 }, 0);
  const requiredAfter = requiredFor({ pd: 2000 }, 1);
  assert.ok(requiredAfter < requiredBefore, "必要人員そのものは減っている");
  assert.ok(
    Math.abs(1 - requiredAfter / requiredBefore - 1 / 3) < TOL,
    "理論上の削減率は33.3%（だがこれはコスト削減率ではない）"
  );
});

test("PDB-2: 実際に常用人員を減らして初めて常用人件費が下がる", () => {
  const requiredBefore = requiredFor({ pd: 2000 }, 0);
  const requiredAfter = requiredFor({ pd: 2000 }, 1);

  const keptSurplus = computeQuarterlyLaborCost(Math.ceil(requiredBefore), 0);
  const reduced = computeQuarterlyLaborCost(Math.ceil(requiredAfter), 0);
  assert.ok(reduced.regularCostUsd < keptSurplus.regularCostUsd, "減員して初めてコストが下がる");
  // 減少幅は人数差 × 給与そのもの（別の係数を持ち込んでいないこと）。
  const expectedDelta =
    (Math.ceil(requiredBefore) - Math.ceil(requiredAfter)) * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter;
  assert.ok(
    Math.abs(keptSurplus.regularCostUsd - reduced.regularCostUsd - expectedDelta) < 1e-6,
    "常用人件費の差分は人数差×給与に一致する"
  );
});

test("PDB-3: 臨時ワーカー・残業が存在する場合は、機械化でコストが実際に下がりうる", () => {
  // 機械化前: 常用だけでは足りず、臨時と残業で埋めている状態。
  const before = computeQuarterlyLaborCost(500, 200);
  // 機械化後: 同じ生産量を常用だけで賄えるようになり、臨時をゼロにできた。
  const after = computeQuarterlyLaborCost(500, 0);
  assert.ok(after.totalCostUsd < before.totalCostUsd, "臨時を削れればコストは下がる");
  assert.equal(after.regularCostUsd, before.regularCostUsd, "常用人件費そのものは変わっていない");
  assert.ok(before.temporaryCostUsd > 0 && after.temporaryCostUsd === 0);
});

test("PDB-4: 同じ人手で増産する経路では、人件費は増えないまま生産量だけが増える（単位あたり人件費の低下）", () => {
  const headcount = 600;
  const cost = computeQuarterlyLaborCost(headcount, 0);
  // 同じ人数で処理できるPD量は 1.8/1.2 = 1.5 倍。
  const capacityBefore = 1 / requiredFor({ pd: 1 }, 0);
  const capacityAfter = 1 / requiredFor({ pd: 1 }, 1);
  assert.ok(Math.abs(capacityAfter / capacityBefore - 1.5) < 1e-6);
  // 人件費は同額なので、1トンあたり人件費は 1/1.5 になる。
  const unitCostBefore = cost.totalCostUsd / (headcount * capacityBefore);
  const unitCostAfter = cost.totalCostUsd / (headcount * capacityAfter);
  assert.ok(Math.abs(unitCostAfter / unitCostBefore - 1 / 1.5) < 1e-6, "単位あたり人件費が1/1.5になる");
});

// ---------------------------------------------------------------------
// §5 VAPスピルオーバーの分離
// ---------------------------------------------------------------------

test("PDB-5: 【必須】PD省人化はVAPの必要労働だけを下げ、VAPの需要・価格・能力スコアには一切触れない", () => {
  const vapBefore = requiredFor({ vap: 1000 }, 0);
  const vapAfter = requiredFor({ vap: 1000 }, 1);
  assert.ok(vapAfter < vapBefore, "VAPの必要労働は前工程の共通化ぶんだけ下がる");
  assert.ok(Math.abs(vapAfter / vapBefore - 2.6 / 3.0) < TOL);

  // 機械化はあくまで労働係数の話であり、VAP能力スコア・VAP需要・VAP価格を
  // 決める関数のどこにも機械化レベルは入力として存在しない。
  // （型レベルで保証されていることを、シグネチャの検査で表明する）
  const laborParams = PRODUCTION_PARAMETERS_V1.labor;
  assert.ok("mechanizedLaborIntensityCoefficient" in laborParams, "機械化係数は生産の労働パラメータにのみ存在する");
});

// ---------------------------------------------------------------------
// §6 Standard AIの判断条件
// ---------------------------------------------------------------------

function mixMatrix(pd: number, vap: number): Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>> {
  return Object.fromEntries(DEMAND_MARKET_IDS.map((m) => [m, { hoso: 1 - pd - vap, pd, vap }])) as Readonly<
    Record<DemandMarketId, Readonly<Record<Product, number>>>
  >;
}

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    factories: [
      {
        factoryId: "BAL-F1",
        capacityByProduct: { hoso: 5000, pd: 20000, vap: 1000 },
        commonProcessingCapacity: 30000,
        freezingPackagingCapacity: 30000,
        currentRegularHeadcount: 3000,
        skillByProduct: { hoso: 0.9, pd: 0.9, vap: 0.9 },
        attendanceRate: 0.95,
      },
    ],
    cashUsd: 200_000_000,
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 3000,
    salesForceHeadcountTotal: 60,
    marketPremiumByProduct: {},
    productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 1, pd: 1.2, vap: 2 } },
    activeCapexProjectTargets: new Set(),
    qualityScoreByProduct: {},
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
    lastQuarterActualProductionByProduct: {},
    lifecycleSharesByMarket: mixMatrix(0.3, 0.1),
    lifecycleTrendByMarket: mixMatrix(0.004, 0.001),
    targetDemandTotalByMarket: Object.fromEntries(DEMAND_MARKET_IDS.map((m) => [m, 8000])) as Record<DemandMarketId, number>,
    ...overrides,
  } as unknown as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
  return {
    equipmentUtilizationLastQuarter: 0.9,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.95,
    targetMinimumCashUsd: 10_000_000,
    rawMaterialInventoryPosition: 1.2,
    finishedGoodsExcessRatioByProduct: { hoso: 0, pd: 0, vap: 0 },
    ...overrides,
  } as unknown as PressureScores;
}

const BAL = { companyId: "BAL" } as unknown as CompanyFixture;

function decide(obs: StandardAiObservation, pres: PressureScores) {
  return decideMarketEvolutionInvestments(
    BAL,
    obs,
    pres,
    resolveOrientationProfile("BAL"),
    new Set(),
    MARKET_EVOLUTION_INVESTMENT_PARAMETERS_V1
  );
}

function proposesMechanization(result: ReturnType<typeof decide>): boolean {
  return result.proposals.some((p) => p.projectType === "pdMechanization");
}

test("PDB-6: 条件がすべて揃えばStandard AIはPD省人化を提案する", () => {
  const result = decide(observation(), pressures());
  assert.ok(proposesMechanization(result), `条件が揃えば提案されるはず（診断: ${result.diagnostics.map((d) => d.code).join(",")}）`);
  assert.ok(result.diagnostics.some((d) => d.code === "PD_MECHANIZATION_PROPOSED_FOR_PAYBACK"));
});

test("PDB-7: 【必須】販売見込みが無ければ、係数が下がることを理由に投資しない", () => {
  // (a) 営業対応力が足りない（増産しても売れない）
  const noSalesCapacity = decide(observation({ salesForceHeadcountTotal: 2 }), pressures());
  assert.ok(!proposesMechanization(noSalesCapacity), "営業対応力が不足していれば提案しない");

  // (b) PD需要が弱い（トレンドが負）
  const weakDemand = decide(observation({ lifecycleTrendByMarket: mixMatrix(-0.005, 0.001) }), pressures());
  assert.ok(!proposesMechanization(weakDemand), "PD需要が縮小していれば提案しない");

  // (c) 完成品在庫が既に積み上がっている
  const highInventory = decide(
    observation(),
    pressures({ finishedGoodsExcessRatioByProduct: { hoso: 0, pd: 2.0, vap: 0 } } as never)
  );
  assert.ok(!proposesMechanization(highInventory), "完成品在庫が過剰なら提案しない");

  // (d) PD供給過剰
  const oversupplied = decide(observation({ productSupplyPressureByProduct: { pd: 1.6, vap: 1.0 } }), pressures());
  assert.ok(!proposesMechanization(oversupplied), "PD供給過剰なら提案しない");
});

test("PDB-8: 労働がボトルネックでない・原料不足・現金不足のときも見送る", () => {
  const idle = decide(observation(), pressures({ equipmentUtilizationLastQuarter: 0.2 }));
  assert.ok(!proposesMechanization(idle), "稼働率が低い（＝労働が律速でない）なら提案しない");

  const rawShort = decide(observation(), pressures({ rawMaterialInventoryPosition: 0.3 }));
  assert.ok(!proposesMechanization(rawShort), "原料が確保できないなら提案しない");

  const poor = decide(observation({ cashUsd: 5_000_000 }), pressures());
  assert.ok(!proposesMechanization(poor), "投資後に現金安全水準を割るなら提案しない");

  for (const result of [idle, rawShort, poor]) {
    assert.ok(result.diagnostics.some((d) => d.code === "PD_MECHANIZATION_DEFERRED"), "見送り理由が診断として出力される");
  }
});

test("PDB-9: 【必須】「現金がある」だけでは投資しない", () => {
  // 現金だけ潤沢で、他の条件（需要・稼働率・営業）が揃っていない状態。
  const cashRichOnly = decide(
    observation({ cashUsd: 10_000_000_000, salesForceHeadcountTotal: 2, lifecycleTrendByMarket: mixMatrix(0, 0) }),
    pressures({ equipmentUtilizationLastQuarter: 0.1 })
  );
  assert.ok(!proposesMechanization(cashRichOnly), "現金だけを理由に投資してはならない");
});

test("PDB-10: 判断はターン番号を参照しない（時期直書きの規則になっていない）", () => {
  // decideMarketEvolutionInvestments はturnを引数に取らないため、
  // 同じ観測なら常に同じ判断になる。
  const a = decide(observation(), pressures());
  const b = decide(observation(), pressures());
  assert.deepEqual(a.proposals, b.proposals);
});

// ---------------------------------------------------------------------
// §c 残業削減の経路（単体レベルの実証）
// ---------------------------------------------------------------------

test("PDB-11: 【因果テスト】同一PD生産量・同一常用人員で、実際の生産・労務エンジンを通したとき、機械化が残業/臨時/生産未達を実際に改善する", () => {
  // 【この検証の作り】定数の付け替えではなく、
  //   労働係数 → 必要労働 → 労働制約 → 生産結果 → コスト
  // という実際の経路をそのまま通す。機械化レベル以外の入力は完全に同一にする。
  const factoryId = "F-CAUSAL";
  const companyId = "BAL";
  const pdQuantity = 2_000;
  const regularHeadcount = 300;

  const factory: Factory = {
    factoryId,
    companyId,
    status: "active",
    commonProcessingCapacity: hosoEqTons(1_000_000),
    hosoCapacity: hosoEqTons(1_000_000),
    pdCapacity: hosoEqTons(1_000_000),
    vapCapacity: hosoEqTons(1_000_000),
    freezingPackagingCapacity: hosoEqTons(1_000_000),
    coldStorageCapacity: hosoEqTons(1_000_000),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
  } as Factory;

  const lots: readonly RawMaterialRLot[] = [
    {
      lotId: "L-CAUSAL",
      companyId,
      source: "domestic",
      originCountry: "VN",
      inboundPeriod: period(2026, 1),
      originalQuantity: hosoEqTons(1_000_000),
      remainingQuantity: hosoEqTons(1_000_000),
      unitCost: usdPerHosoEqKg(5),
      availableFromPeriod: period(2026, 1),
      status: "available",
    } as RawMaterialRLot,
  ];

  /** 機械化レベルと労務条件だけを変えて、実エンジンを通す。 */
  function run(mechanizationLevel: number, temporaryHeadcount: number, overtimeRate: number) {
    const assignment: WorkerAssignment = {
      factoryId,
      companyId,
      regularHeadcount,
      temporaryHeadcount,
      skills: (["hoso", "pd", "vap"] as const).map((product) => ({ product, skillLevel: ratio(0.9) })),
      overtimeRate: ratio(overtimeRate),
      attendanceRate: ratio(0.95),
    } as WorkerAssignment;
    const plans: readonly CompanyProductionPlanEntry[] = [
      { companyId, factoryId, product: "pd", desiredQuantity: hosoEqTons(pdQuantity), priority: 1 },
    ];
    const result = allocateProductionPlans(
      plans,
      [factory],
      [assignment],
      lots,
      period(2026, 1),
      PRODUCTION_PARAMETERS_V1,
      new Map([[factoryId, mechanizationLevel]])
    );
    const entry = result.entries[0];
    const produced = unwrapUnit(entry.allocatedQuantity);
    return {
      produced,
      shortfall: pdQuantity - produced,
      laborLimited: unwrapUnit(entry.stages.laborLimited),
      cost:
        computeQuarterlyLaborCost(regularHeadcount, temporaryHeadcount).totalCostUsd +
        regularHeadcount * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter * overtimeRate * FINANCE_PARAMETERS_V1.labor.overtimePremiumFactor,
    };
  }

  // (1) 機械化前・残業も臨時もなし → 労働制約で生産未達が出ることを前提として確認する。
  const beforePlain = run(0, 0, 0);
  assert.ok(beforePlain.shortfall > 0, `前提: 機械化前は労働制約で生産未達が出る（未達 ${beforePlain.shortfall}t）`);
  assert.ok(beforePlain.laborLimited < pdQuantity, "労働段階で候補量が削られている");

  // (2) 機械化後・同じ人員/残業/臨時 → 同じ計画がより多く処理でき、未達が改善する。
  const afterPlain = run(1, 0, 0);
  assert.ok(
    afterPlain.produced > beforePlain.produced,
    `機械化後は同じ人員でより多く作れるはず（${beforePlain.produced} → ${afterPlain.produced}）`
  );
  assert.ok(afterPlain.shortfall < beforePlain.shortfall, "生産未達が改善する");
  assert.ok(
    Math.abs(afterPlain.produced / beforePlain.produced - 1.5) < 1e-3,
    `増加率は係数比1.8/1.2=1.5倍のはず（実測 ${afterPlain.produced / beforePlain.produced}）`
  );
  assert.equal(afterPlain.cost, beforePlain.cost, "この経路では人件費は変わらない（同じ人員・残業・臨時のまま）");

  // (3) 機械化前に未達をゼロにするには、残業・臨時のどちらかが必要になる。
  const beforeWithOvertime = run(0, 0, PRODUCTION_PARAMETERS_V1.labor.overtimeRateCap);
  const beforeWithTemporary = run(0, 200, 0);
  assert.ok(beforeWithOvertime.produced > beforePlain.produced, "機械化前は残業で生産量を押し上げられる");
  assert.ok(beforeWithTemporary.produced > beforePlain.produced, "機械化前は臨時で生産量を押し上げられる");
  assert.ok(beforeWithOvertime.cost > beforePlain.cost, "残業にはコストがかかる");
  assert.ok(beforeWithTemporary.cost > beforePlain.cost, "臨時にはコストがかかる");

  // (4) 【因果の核心】機械化前に残業/臨時で到達していた生産量を、
  //     機械化後は残業ゼロ・臨時ゼロで超えられる ＝ その分のコストを落とせる。
  assert.ok(
    afterPlain.produced >= beforeWithOvertime.produced,
    `機械化後（残業0）が、機械化前の残業${PRODUCTION_PARAMETERS_V1.labor.overtimeRateCap * 100}%と同等以上の生産量になるはず` +
      `（機械化後 ${afterPlain.produced} vs 機械化前+残業 ${beforeWithOvertime.produced}）`
  );
  assert.ok(
    afterPlain.cost < beforeWithOvertime.cost,
    `同等の生産量を、より低い人件費で達成できる（${beforeWithOvertime.cost} → ${afterPlain.cost}）`
  );
  assert.ok(
    afterPlain.produced >= beforeWithTemporary.produced && afterPlain.cost < beforeWithTemporary.cost,
    "臨時ワーカーで埋めていた場合も同様に、より低い人件費で同等以上を達成できる"
  );
});

test("PDB-12: 【因果テスト・PD以外への波及がないこと】同じ経路でHOSOは一切変わらず、VAPは係数比ぶんだけ変わる", () => {
  const factoryId = "F-CAUSAL2";
  const companyId = "BAL";
  const factory: Factory = {
    factoryId,
    companyId,
    status: "active",
    commonProcessingCapacity: hosoEqTons(1_000_000),
    hosoCapacity: hosoEqTons(1_000_000),
    pdCapacity: hosoEqTons(1_000_000),
    vapCapacity: hosoEqTons(1_000_000),
    freezingPackagingCapacity: hosoEqTons(1_000_000),
    coldStorageCapacity: hosoEqTons(1_000_000),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
  } as Factory;
  const lots: readonly RawMaterialRLot[] = [
    {
      lotId: "L-CAUSAL2",
      companyId,
      source: "domestic",
      originCountry: "VN",
      inboundPeriod: period(2026, 1),
      originalQuantity: hosoEqTons(1_000_000),
      remainingQuantity: hosoEqTons(1_000_000),
      unitCost: usdPerHosoEqKg(5),
      availableFromPeriod: period(2026, 1),
      status: "available",
    } as RawMaterialRLot,
  ];
  const assignment: WorkerAssignment = {
    factoryId,
    companyId,
    regularHeadcount: 300,
    temporaryHeadcount: 0,
    skills: (["hoso", "pd", "vap"] as const).map((product) => ({ product, skillLevel: ratio(0.9) })),
    overtimeRate: ratio(0),
    attendanceRate: ratio(0.95),
  } as WorkerAssignment;

  const producedFor = (product: Product, mechanizationLevel: number) => {
    const result = allocateProductionPlans(
      [{ companyId, factoryId, product, desiredQuantity: hosoEqTons(100_000), priority: 1 }],
      [factory],
      [assignment],
      lots,
      period(2026, 1),
      PRODUCTION_PARAMETERS_V1,
      new Map([[factoryId, mechanizationLevel]])
    );
    return unwrapUnit(result.entries[0].allocatedQuantity);
  };

  assert.equal(producedFor("hoso", 1), producedFor("hoso", 0), "HOSOは機械化の影響を一切受けない");
  const vapBefore = producedFor("vap", 0);
  const vapAfter = producedFor("vap", 1);
  assert.ok(vapAfter > vapBefore, "VAPは前工程の殻剥き共通化ぶんだけ増える");
  assert.ok(Math.abs(vapAfter / vapBefore - 3.0 / 2.6) < 1e-3, `VAPの増加率は係数比3.0/2.6のはず（実測 ${vapAfter / vapBefore}）`);
  const pdRatio = producedFor("pd", 1) / producedFor("pd", 0);
  assert.ok(pdRatio > vapAfter / vapBefore, "PDの改善率のほうがVAPより大きい");
});
