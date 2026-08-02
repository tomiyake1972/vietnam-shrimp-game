// ShrimpX V2 — 会社×工場のPD稼働率・PD省人化投資の状態（Test15新設）テスト
//
// 対応する要求事項:
//   - Factory単位PD稼働率の永続化・取得（新規ゲーム・移行直後・実績なしは
//     initialPdUtilizationRatio=0.0）
//   - 「前四半期末までの値」だけを読み、当四半期の実績を遡及させない
//     （タイミング規約の構造的証明）
//   - Factory単位・案件単位の独立性（あるFactoryの省人化が他Factoryへ波及しない）
//   - buildPdCoefficientOverridesByFactoryは稼働開始済み案件だけを対象とする

import { test } from "node:test";
import assert from "node:assert/strict";
import { period, nextPeriod } from "../../core/period";
import { hosoEqTons, ratio, usdM, usdPerHosoEqKg } from "../../core/units";
import { Factory, ProductionBatch } from "../../production/types";
import { CapexState, CapitalProject } from "../../capex/types";
import { PD_MECHANIZATION_PARAMETERS_V1 } from "../../capex/pdMechanization";
import {
  buildInitialPdMechanizationState,
  buildPdCoefficientOverridesByFactory,
  computeCurrentQuarterPdUtilizationByFactory,
  deriveNextPdMechanizationState,
  findPreviousQuarterPdUtilization,
  PdMechanizationState,
} from "../pdMechanizationState";

const P1 = period(2020, 1);
const P2 = nextPeriod(P1);
const P3 = nextPeriod(P2);
const P4 = nextPeriod(P3);
const P5 = nextPeriod(P4);

function makeFactory(overrides: Partial<Factory> = {}): Factory {
  return {
    factoryId: "F1",
    companyId: "C1",
    status: "active",
    commonProcessingCapacity: hosoEqTons(1000),
    hosoCapacity: hosoEqTons(1000),
    pdCapacity: hosoEqTons(1000),
    vapCapacity: hosoEqTons(1000),
    freezingPackagingCapacity: hosoEqTons(1000),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
    ...overrides,
  };
}

function makeBatch(overrides: Partial<ProductionBatch> = {}): ProductionBatch {
  return {
    batchId: "PB-1",
    companyId: "C1",
    factoryId: "F1",
    product: "pd",
    period: P1,
    rawMaterialConsumed: [{ lotId: "RM-1", quantity: hosoEqTons(100), unitCost: usdPerHosoEqKg(5), originCountry: "VN" }],
    rawMaterialConsumedTotal: hosoEqTons(625),
    finishedGoodsQuantity: hosoEqTons(500),
    processingLoss: hosoEqTons(125),
    rawMaterialCost: usdM(0.5),
    baseProcessingCost: usdM(0.03),
    capacityUtilizationIndex: ratio(1),
    shortfallQuantity: hosoEqTons(0),
    shortfallReasons: [],
    ...overrides,
  };
}

function makePdMechanizationProject(overrides: Partial<CapitalProject> = {}): CapitalProject {
  return {
    projectId: "PROJ-1",
    companyId: "C1",
    projectType: "pdMechanization",
    approvedBudgetUsd: 2_500_000,
    paymentSchedule: [
      { stageIndex: 0, plannedRatio: 0.4 },
      { stageIndex: 1, plannedRatio: 0.6 },
    ],
    completedPaymentStagesCount: 2,
    cumulativePaidUsd: 2_500_000,
    elapsedConstructionQuartersWithPayment: 2,
    requiredConstructionQuarters: 2,
    status: "completed",
    proposedPeriod: P1,
    approvedPeriod: P1,
    completedPeriod: P1,
    capitalizedAmountUsd: 2_500_000,
    targetFactoryId: "F1",
    futureCapacityEffect: { capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 1 },
    lastDiagnosticReasons: [],
    priority: 0,
    ...overrides,
  };
}

function capexStateWithProjects(projects: readonly CapitalProject[]): CapexState {
  return { companies: [{ companyId: "C1", portfolio: { companyId: "C1", projects }, nextProjectSequence: projects.length + 1 }] };
}

// ---------------------------------------------------------------------
// 1. 初期値・実績なしの扱い（新規ゲーム・移行直後・そのFactory未実績）
// ---------------------------------------------------------------------

test("PDST-1: 初期状態（buildInitialPdMechanizationState）は空で、どのFactoryもinitialPdUtilizationRatio(0.0)を返す", () => {
  const state = buildInitialPdMechanizationState();
  assert.equal(state.entries.length, 0);
  assert.equal(findPreviousQuarterPdUtilization(state, "F1"), PD_MECHANIZATION_PARAMETERS_V1.initialPdUtilizationRatio);
  assert.equal(PD_MECHANIZATION_PARAMETERS_V1.initialPdUtilizationRatio, 0.0);
});

test("PDST-2: stateがundefined（移行直後・古いラボ）でも例外を投げず、initialPdUtilizationRatioへフォールバックする", () => {
  assert.equal(findPreviousQuarterPdUtilization(undefined, "F1"), 0.0);
});

test("PDST-3: 実績が一度も無いFactory（Task2の新設Factory初回PD四半期を含む）は、今期の実績を代用せずinitialPdUtilizationRatioを返す", () => {
  const state: PdMechanizationState = { entries: [{ factoryId: "OTHER-F", companyId: "C1", previousQuarterPdUtilization: 0.9 }] };
  assert.equal(findPreviousQuarterPdUtilization(state, "F1"), 0.0);
});

// ---------------------------------------------------------------------
// 2. Factory単位PD稼働率の算出（単位一貫性: post-yield同士）
// ---------------------------------------------------------------------

test("PDST-4: computeCurrentQuarterPdUtilizationByFactoryは、finishedGoodsQuantity（歩留まり適用後）÷有効能力（歩留まり適用後）で算出する", () => {
  const factory = makeFactory({ pdCapacity: hosoEqTons(1000), baseUtilizationRate: ratio(1), equipmentAvailabilityRate: ratio(1) });
  const batch = makeBatch({ finishedGoodsQuantity: hosoEqTons(500), rawMaterialConsumedTotal: hosoEqTons(625), processingLoss: hosoEqTons(125) });
  const result = computeCurrentQuarterPdUtilizationByFactory([factory], [batch]);
  assert.ok(Math.abs((result.get("F1") ?? -1) - 0.5) < 1e-9, `実際: ${result.get("F1")}`);
});

test("PDST-5: HOSO/VAPバッチはPD稼働率の算出に混入しない（product='pd'のみ集計）", () => {
  const factory = makeFactory();
  const batches = [
    makeBatch({ batchId: "PB-HOSO", product: "hoso", finishedGoodsQuantity: hosoEqTons(900) }),
    makeBatch({ batchId: "PB-PD", product: "pd", finishedGoodsQuantity: hosoEqTons(300) }),
    makeBatch({ batchId: "PB-VAP", product: "vap", finishedGoodsQuantity: hosoEqTons(200) }),
  ];
  const result = computeCurrentQuarterPdUtilizationByFactory([factory], batches);
  assert.ok(Math.abs((result.get("F1") ?? -1) - 0.3) < 1e-9, `実際: ${result.get("F1")}`);
});

test("PDST-6: 稼働率0（非activeなFactoryなど有効能力0）のときは0を返す（0除算しない）", () => {
  const factory = makeFactory({ status: "idle" });
  const batch = makeBatch({ finishedGoodsQuantity: hosoEqTons(500) });
  const result = computeCurrentQuarterPdUtilizationByFactory([factory], [batch]);
  assert.equal(result.get("F1"), 0);
});

// ---------------------------------------------------------------------
// 3. 状態の繰り越し（deriveNextPdMechanizationState）
// ---------------------------------------------------------------------

test("PDST-7: deriveNextPdMechanizationStateは、当四半期に算出された値をFactoryごとに保存し、factoryId昇順にソートする", () => {
  const factories = [makeFactory({ factoryId: "F2", companyId: "C1" }), makeFactory({ factoryId: "F1", companyId: "C1" })];
  const current = new Map([
    ["F1", 0.4],
    ["F2", 0.7],
  ]);
  const next = deriveNextPdMechanizationState(undefined, factories, current);
  assert.deepEqual(
    next.entries.map((e) => e.factoryId),
    ["F1", "F2"]
  );
  assert.equal(next.entries.find((e) => e.factoryId === "F1")!.previousQuarterPdUtilization, 0.4);
  assert.equal(next.entries.find((e) => e.factoryId === "F2")!.previousQuarterPdUtilization, 0.7);
});

test("PDST-8: 当四半期に算出できなかったFactory（生産計画に含まれないなど）は、前四半期までの値をそのまま据え置く（0へリセットしない）", () => {
  const previous: PdMechanizationState = { entries: [{ factoryId: "F1", companyId: "C1", previousQuarterPdUtilization: 0.6 }] };
  const factories = [makeFactory({ factoryId: "F1" })];
  const current = new Map<string, number>(); // 今期は算出できなかった
  const next = deriveNextPdMechanizationState(previous, factories, current);
  assert.equal(next.entries.find((e) => e.factoryId === "F1")!.previousQuarterPdUtilization, 0.6);
});

// ---------------------------------------------------------------------
// 4. タイミング規約: 「前四半期末までの値」だけを読み、当四半期実績を遡及しない
// ---------------------------------------------------------------------

test("PDST-9（タイミング証明）: buildPdCoefficientOverridesByFactoryは、渡されたpdMechanizationState（前四半期末までの値）だけを読む。今期の実績が別途どれだけ高くても、それは今期のoverride計算には一切影響しない", () => {
  const project = makePdMechanizationProject({ completedPeriod: P1 }); // readiness=1 → 稼働開始P3
  const capexState = capexStateWithProjects([project]);

  // 前四半期末までの稼働率は低い(0.1)。今期（P4）の実績が仮に0.99だったとしても、
  // 今期のoverride算出はこの「前四半期末までの値」しか読まないことを検証する。
  const lowPriorState: PdMechanizationState = { entries: [{ factoryId: "F1", companyId: "C1", previousQuarterPdUtilization: 0.1 }] };
  const highPriorState: PdMechanizationState = { entries: [{ factoryId: "F1", companyId: "C1", previousQuarterPdUtilization: 0.99 }] };

  // P4 = 稼働開始(P3)の1四半期後 → adoptionRampProgress=0.5
  const overridesLow = buildPdCoefficientOverridesByFactory(capexState, lowPriorState, P4);
  const overridesHigh = buildPdCoefficientOverridesByFactory(capexState, highPriorState, P4);

  assert.notEqual(overridesLow.get("F1"), overridesHigh.get("F1"), "前四半期末の稼働率が異なれば、当四半期のoverrideも異なるはず（＝実際にその値を読んでいる証拠）");
  // mechanizationLevel = 0.5 × 0.1 = 0.05 → coefficient = 1.8 - 0.6×0.05 = 1.77
  assert.ok(Math.abs((overridesLow.get("F1") ?? -1) - (1.8 - (1.8 - 1.2) * 0.05)) < 1e-9);
  // mechanizationLevel = 0.5 × 0.99 = 0.495 → coefficient = 1.8 - 0.6×0.495 = 1.503
  assert.ok(Math.abs((overridesHigh.get("F1") ?? -1) - (1.8 - (1.8 - 1.2) * 0.495)) < 1e-9);
});

test("PDST-10（タイミング証明・稼働開始前）: 竣工直後・操業準備期間中（稼働開始前）はまだoverrideが発生しない（0%扱いではなく、そもそもマップに現れない＝base係数のまま）", () => {
  const project = makePdMechanizationProject({ completedPeriod: P1 }); // 稼働開始 = P3
  const capexState = capexStateWithProjects([project]);
  const priorState: PdMechanizationState = { entries: [{ factoryId: "F1", companyId: "C1", previousQuarterPdUtilization: 0.9 }] };

  const overridesAtP2 = buildPdCoefficientOverridesByFactory(capexState, priorState, P2); // 完成の翌四半期(P2)はまだ操業準備中
  assert.equal(overridesAtP2.has("F1"), false, "稼働開始前はoverrideマップに現れない");

  const overridesAtP3 = buildPdCoefficientOverridesByFactory(capexState, priorState, P3); // 稼働開始四半期そのもの（ランプ0四半期目）
  assert.ok(overridesAtP3.has("F1"));
  // 稼働開始四半期そのもの（quartersSinceActivation=0）はランプ進捗0% → 係数はbaseCoefficientのまま。
  assert.equal(overridesAtP3.get("F1"), 1.8);
});

// ---------------------------------------------------------------------
// 5. Factory単位の独立性
// ---------------------------------------------------------------------

test("PDST-11（独立性）: あるFactory(F1)のPD省人化投資は、別Factory(F2)の実効PD係数に一切影響しない", () => {
  const project = makePdMechanizationProject({ targetFactoryId: "F1", completedPeriod: P1 });
  const capexState = capexStateWithProjects([project]);
  const priorState: PdMechanizationState = {
    entries: [
      { factoryId: "F1", companyId: "C1", previousQuarterPdUtilization: 1.0 },
      { factoryId: "F2", companyId: "C1", previousQuarterPdUtilization: 1.0 },
    ],
  };
  const overrides = buildPdCoefficientOverridesByFactory(capexState, priorState, P5); // 十分先の四半期でフルランプ
  assert.ok(overrides.has("F1"));
  assert.equal(overrides.has("F2"), false, "F2にはPD省人化投資が無いためoverrideは発生しない");
});

test("PDST-12（独立性）: 2つのFactory(F1・F2)がそれぞれ独立にPD省人化投資を持つとき、互いの稼働率・進捗の違いがもう一方の係数に混線しない", () => {
  const projectF1 = makePdMechanizationProject({ projectId: "P-F1", targetFactoryId: "F1", completedPeriod: P1 });
  const projectF2 = makePdMechanizationProject({ projectId: "P-F2", targetFactoryId: "F2", completedPeriod: P1 });
  const capexState = capexStateWithProjects([projectF1, projectF2]);
  const priorState: PdMechanizationState = {
    entries: [
      { factoryId: "F1", companyId: "C1", previousQuarterPdUtilization: 0.2 },
      { factoryId: "F2", companyId: "C1", previousQuarterPdUtilization: 0.9 },
    ],
  };
  const overrides = buildPdCoefficientOverridesByFactory(capexState, priorState, P5); // フルランプ済み
  const coefF1 = overrides.get("F1")!;
  const coefF2 = overrides.get("F2")!;
  assert.notEqual(coefF1, coefF2, "稼働率が異なれば係数も異なるはず");
  // フルランプ（level=稼働率そのもの）: F1 = 1.8-0.6×0.2、F2 = 1.8-0.6×0.9
  assert.ok(Math.abs(coefF1 - (1.8 - (1.8 - 1.2) * 0.2)) < 1e-9);
  assert.ok(Math.abs(coefF2 - (1.8 - (1.8 - 1.2) * 0.9)) < 1e-9);
});

test("PDST-13: HOSO/VAPにはbuildPdCoefficientOverridesByFactoryの効果が一切及ばない（マップのキーはFactoryIdのみで商品別ではなく、labor.ts側でPD以外には適用されない設計）", () => {
  // このモジュール自体はFactory単位の「PD係数」しか生成しない（HOSO/VAP用の
  // overrideは存在しない）。マップの値はproduction/labor.tsのallocateWorkersToPlansで
  // product==='pd'のときだけ参照される（labor.ts参照）。ここではマップの形状のみ検証する。
  const project = makePdMechanizationProject({ completedPeriod: P1 });
  const capexState = capexStateWithProjects([project]);
  const priorState: PdMechanizationState = { entries: [{ factoryId: "F1", companyId: "C1", previousQuarterPdUtilization: 1.0 }] };
  const overrides = buildPdCoefficientOverridesByFactory(capexState, priorState, P5);
  assert.equal(overrides.size, 1, "マップにはFactoryIdだけが入り、商品別エントリは存在しない");
});
