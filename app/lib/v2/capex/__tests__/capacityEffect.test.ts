// ShrimpX V2 — 設備投資モジュール 操業効果（能力増加・固定保守費）単体テスト
// （Phase 8B-2B新設、Phase 8B-2Cで減価償却テストをcapex/__tests__/depreciation.test.tsへ分離）
//
// capex/capacityEffect.tsの純粋関数群を、finance/quarterClose.tsやcompanyLab/
// runner.tsを経由せず直接検証する。実装指示§10の必須テスト項目のうち、能力・
// 保守費の単体レベルの検証をここでまとめて行う（新規capex資産の減価償却は
// depreciation.test.ts、三表統合レベルの検証はcapexClose.test.tsで別途行う）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { Factory } from "../../production/types";
import { CapexParameters, CapexProjectTemplate } from "../parameters";
import { CapitalProject, CapitalProjectType, CapexState, CompanyCapexState, FutureCapacityEffectPlaceholder } from "../types";
import {
  applyCapexCapacityToFactories,
  computeCapacityEffectForCompany,
  computeCapexMaintenanceCostUsd,
  computeOperationalStartPeriod,
} from "../capacityEffect";

const EPS = 1e-6;

function makeProject(overrides: Partial<CapitalProject> & Pick<CapitalProject, "projectType">): CapitalProject {
  return {
    projectId: "P-1",
    companyId: "TEST",
    approvedBudgetUsd: 1_000_000,
    paymentSchedule: [{ stageIndex: 0, plannedRatio: 1 }],
    completedPaymentStagesCount: 1,
    cumulativePaidUsd: 1_000_000,
    elapsedConstructionQuartersWithPayment: 1,
    requiredConstructionQuarters: 1,
    status: "completed",
    proposedPeriod: period(2015, 1),
    approvedPeriod: period(2015, 1),
    completedPeriod: period(2015, 1),
    capitalizedAmountUsd: 1_000_000,
    priority: 1,
    lastDiagnosticReasons: [],
    ...overrides,
  };
}

function effect(overrides: Partial<FutureCapacityEffectPlaceholder> = {}): FutureCapacityEffectPlaceholder {
  return { readinessQuartersAfterCompletion: 0, ...overrides };
}

// ---------------------------------------------------------------------
// 1. 稼働開始四半期の算出（実装指示§3.2、ユーザー提示の具体例と一致）
// ---------------------------------------------------------------------

test("OS-1: readiness=0のとき、稼働開始四半期は完成四半期の翌四半期（例: 2016Q2完成→2016Q3）", () => {
  assert.equal(computeOperationalStartPeriod(period(2016, 2), 0), period(2016, 3));
});

test("OS-2: readiness=1のとき、稼働開始四半期はさらに1四半期後（例: 2016Q2完成→2016Q4）", () => {
  assert.equal(computeOperationalStartPeriod(period(2016, 2), 1), period(2016, 4));
});

test("OS-3: 年をまたぐ場合も正しく算出される（2015Q4完成・readiness=1 → 2016Q2）", () => {
  assert.equal(computeOperationalStartPeriod(period(2015, 4), 1), period(2016, 2));
});

// ---------------------------------------------------------------------
// 2. 能力増加（computeCapacityEffectForCompany）
// ---------------------------------------------------------------------

test("CAP-1: 投資承認直後（approved）は能力効果なし", () => {
  const p = makeProject({ projectType: "hosoLineExpansion", status: "approved", completedPeriod: undefined, capitalizedAmountUsd: undefined, futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const r = computeCapacityEffectForCompany([p], period(2015, 2));
  assert.equal(r.hoso, 0);
});

test("CAP-2: 建設中（underConstruction）は能力効果なし", () => {
  const p = makeProject({ projectType: "hosoLineExpansion", status: "underConstruction", completedPeriod: undefined, capitalizedAmountUsd: undefined, futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const r = computeCapacityEffectForCompany([p], period(2015, 4));
  assert.equal(r.hoso, 0);
});

test("CAP-3: 完成四半期そのもの（completedPeriod===period）は能力効果なし（稼働開始は必ず翌期以降）", () => {
  const p = makeProject({ projectType: "hosoLineExpansion", completedPeriod: period(2015, 2), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const r = computeCapacityEffectForCompany([p], period(2015, 2));
  assert.equal(r.hoso, 0);
});

test("CAP-4: readiness=0なら翌四半期から能力が増加する", () => {
  const p = makeProject({ projectType: "hosoLineExpansion", completedPeriod: period(2015, 2), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500, readinessQuartersAfterCompletion: 0 }) });
  assert.equal(computeCapacityEffectForCompany([p], period(2015, 3)).hoso, 500);
  // それ以降の四半期でも継続する（減価償却と異なり打ち切りが無い）。
  assert.equal(computeCapacityEffectForCompany([p], period(2020, 1)).hoso, 500);
});

test("CAP-5: readiness=1ならさらに1四半期後から増加する（readiness=0の翌四半期はまだ増加しない）", () => {
  const p = makeProject({ projectType: "vapLineExpansion", completedPeriod: period(2015, 2), futureCapacityEffect: effect({ targetProduct: "vap", capacityIncreaseTonsPerQuarter: 250, readinessQuartersAfterCompletion: 1 }) });
  assert.equal(computeCapacityEffectForCompany([p], period(2015, 3)).vap, 0);
  assert.equal(computeCapacityEffectForCompany([p], period(2015, 4)).vap, 250);
});

test("CAP-6: HOSO案件はHOSO能力だけを増加させる（他のプールは無変化）", () => {
  const p = makeProject({ projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const r = computeCapacityEffectForCompany([p], period(2015, 3));
  assert.equal(r.hoso, 500);
  assert.equal(r.pd, 0);
  assert.equal(r.vap, 0);
  assert.equal(r.commonProcessing, 0);
  assert.equal(r.freezingPackaging, 0);
});

test("CAP-7: PD案件はPD能力だけ、VAP案件はVAP能力だけを増加させる", () => {
  const pd = makeProject({ projectId: "P-PD", projectType: "pdLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "pd", capacityIncreaseTonsPerQuarter: 350 }) });
  const vap = makeProject({ projectId: "P-VAP", projectType: "vapLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "vap", capacityIncreaseTonsPerQuarter: 250 }) });
  const r = computeCapacityEffectForCompany([pd, vap], period(2015, 3));
  assert.equal(r.pd, 350);
  assert.equal(r.vap, 250);
  assert.equal(r.hoso, 0);
});

test("CAP-8: 共通前処理案件（commonProcessingExpansion）はcommon能力だけを増加させ、HOSO/PD/VAPライン増設からはcommon能力が増加しない（実装指示§3.1のボトルネック独立性）", () => {
  const common = makeProject({ projectId: "P-COMMON", projectType: "commonProcessingExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "commonProcessing", capacityIncreaseTonsPerQuarter: 700 }) });
  const hoso = makeProject({ projectId: "P-HOSO", projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const r = computeCapacityEffectForCompany([common, hoso], period(2015, 3));
  assert.equal(r.commonProcessing, 700);
  assert.equal(r.hoso, 500);
});

test("CAP-9: cold storage案件はfreezing/packaging能力だけを増加させる", () => {
  const p = makeProject({ projectType: "coldStorageExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "freezingPackaging", capacityIncreaseTonsPerQuarter: 500 }) });
  const r = computeCapacityEffectForCompany([p], period(2015, 3));
  assert.equal(r.freezingPackaging, 500);
  assert.equal(r.commonProcessing, 0);
});

test("CAP-10: QC・環境設備は完成・稼働開始済みでも生産能力を一切増加させない", () => {
  const qc = makeProject({ projectId: "P-QC", projectType: "qualityControlEquipment", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ capacityIncreaseTonsPerQuarter: 0 }) });
  const env = makeProject({ projectId: "P-ENV", projectType: "environmentalEquipment", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ capacityIncreaseTonsPerQuarter: 0 }) });
  const r = computeCapacityEffectForCompany([qc, env], period(2020, 1));
  // 【Phase 8D-5】coldStorage（冷凍・冷蔵保管能力＝ストック）をプールへ追加したため、期待値にも含める。
  assert.deepEqual(r, { commonProcessing: 0, hoso: 0, pd: 0, vap: 0, freezingPackaging: 0, coldStorage: 0 });
});

test("CAP-11: 複数案件の効果は累積する（同一プールへの2件のHOSO投資）", () => {
  const a = makeProject({ projectId: "P-A", projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const b = makeProject({ projectId: "P-B", projectType: "hosoLineExpansion", completedPeriod: period(2015, 2), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const r = computeCapacityEffectForCompany([a, b], period(2016, 1));
  assert.equal(r.hoso, 1000);
});

test("CAP-12: 取消済み（cancelled）案件は能力効果を持たない", () => {
  const p = makeProject({ projectType: "hosoLineExpansion", status: "cancelled", completedPeriod: undefined, capitalizedAmountUsd: undefined, cumulativePaidUsd: 0, cancelledPeriod: period(2015, 2), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const r = computeCapacityEffectForCompany([p], period(2020, 1));
  assert.equal(r.hoso, 0);
});

// ---------------------------------------------------------------------
// 3. Factory再構成（applyCapexCapacityToFactories）
// ---------------------------------------------------------------------

function factory(overrides: Partial<Factory> & Pick<Factory, "factoryId" | "companyId">): Factory {
  const zero = hosoEqTons(0);
  return {
    status: "active",
    commonProcessingCapacity: zero,
    hosoCapacity: zero,
    pdCapacity: zero,
    vapCapacity: zero,
    freezingPackagingCapacity: zero,
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
    ...overrides,
  };
}

function capexStateWith(companyId: string, projects: readonly CapitalProject[]): CompanyCapexState {
  return { companyId, portfolio: { companyId, projects }, nextProjectSequence: projects.length + 1 };
}

test("FAC-1: 他社の設備能力へは一切影響しない", () => {
  const balFactory = factory({ factoryId: "BAL-F1", companyId: "BAL", hosoCapacity: hosoEqTons(10_000) });
  const massFactory = factory({ factoryId: "MASS-F1", companyId: "MASS", hosoCapacity: hosoEqTons(30_000) });
  const balProject = makeProject({ companyId: "BAL", projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const capexState: CapexState = { companies: [capexStateWith("BAL", [balProject]), capexStateWith("MASS", [])] };
  const result = applyCapexCapacityToFactories([balFactory, massFactory], capexState, period(2015, 3));
  const bal = result.find((f) => f.companyId === "BAL")!;
  const mass = result.find((f) => f.companyId === "MASS")!;
  assert.equal(unwrapUnit(bal.hosoCapacity), 10_500);
  assert.equal(unwrapUnit(mass.hosoCapacity), 30_000, "MASSの能力はBALの投資の影響を受けてはならない");
});

test("FAC-2: 元のFactory fixtureオブジェクトはmutationされない（新しいオブジェクトが返る、元の値は不変）", () => {
  const original = factory({ factoryId: "BAL-F1", companyId: "BAL", hosoCapacity: hosoEqTons(10_000) });
  const originalHosoCapacityValue = unwrapUnit(original.hosoCapacity);
  const project = makeProject({ companyId: "BAL", projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const capexState: CapexState = { companies: [capexStateWith("BAL", [project])] };
  const result = applyCapexCapacityToFactories([original], capexState, period(2015, 3));
  assert.equal(unwrapUnit(original.hosoCapacity), originalHosoCapacityValue, "元のfixtureオブジェクトの値が変化してはならない");
  assert.notEqual(result[0], original, "戻り値は新しいオブジェクトであるべき（同一参照ではない）");
  assert.equal(unwrapUnit(result[0].hosoCapacity), 10_500);
});

test("FAC-3: 能力効果が無い会社の工場はそのまま（同一参照）返される", () => {
  const massFactory = factory({ factoryId: "MASS-F1", companyId: "MASS", hosoCapacity: hosoEqTons(30_000) });
  const capexState: CapexState = { companies: [capexStateWith("MASS", [])] };
  const result = applyCapexCapacityToFactories([massFactory], capexState, period(2015, 3));
  assert.equal(result[0], massFactory);
});

test("FAC-4: 複数プールへの効果が同時に正しく反映される（共通前処理＋HOSO＋冷凍包装）", () => {
  const balFactory = factory({
    factoryId: "BAL-F1",
    companyId: "BAL",
    commonProcessingCapacity: hosoEqTons(22_000),
    hosoCapacity: hosoEqTons(10_000),
    freezingPackagingCapacity: hosoEqTons(20_000),
  });
  const common = makeProject({ projectId: "P-C", companyId: "BAL", projectType: "commonProcessingExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "commonProcessing", capacityIncreaseTonsPerQuarter: 700 }) });
  const hoso = makeProject({ projectId: "P-H", companyId: "BAL", projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const cold = makeProject({ projectId: "P-CS", companyId: "BAL", projectType: "coldStorageExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "freezingPackaging", capacityIncreaseTonsPerQuarter: 500 }) });
  const capexState: CapexState = { companies: [capexStateWith("BAL", [common, hoso, cold])] };
  const result = applyCapexCapacityToFactories([balFactory], capexState, period(2015, 3));
  assert.equal(unwrapUnit(result[0].commonProcessingCapacity), 22_700);
  assert.equal(unwrapUnit(result[0].hosoCapacity), 10_500);
  assert.equal(unwrapUnit(result[0].freezingPackagingCapacity), 20_500);
});

// ---------------------------------------------------------------------
// 4. 複数工場CAPEX Targeting（targetFactoryId）
// ---------------------------------------------------------------------

test("CAPEX-FAC-1: targetFactoryId未指定の従来案件は、単一Factory企業では従来どおりその唯一のFactoryへ適用される", () => {
  const f1 = factory({ factoryId: "BAL-F1", companyId: "BAL", hosoCapacity: hosoEqTons(10_000) });
  const p = makeProject({ companyId: "BAL", projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const capexState: CapexState = { companies: [capexStateWith("BAL", [p])] };
  const result = applyCapexCapacityToFactories([f1], capexState, period(2015, 3));
  assert.equal(unwrapUnit(result[0].hosoCapacity), 10_500);
});

test("CAPEX-FAC-3: targetFactoryIdを指定すれば、共通前処理能力の増強は第2工場だけに適用される（第1工場は不変）", () => {
  const f1 = factory({ factoryId: "BAL-F1", companyId: "BAL", commonProcessingCapacity: hosoEqTons(30_000) });
  const f2 = factory({ factoryId: "BAL-F2", companyId: "BAL", commonProcessingCapacity: hosoEqTons(22_000) });
  const p = makeProject({
    companyId: "BAL",
    projectType: "commonProcessingExpansion",
    completedPeriod: period(2015, 1),
    futureCapacityEffect: effect({ targetProduct: "commonProcessing", capacityIncreaseTonsPerQuarter: 4_000 }),
    targetFactoryId: "BAL-F2",
  });
  const capexState: CapexState = { companies: [capexStateWith("BAL", [p])] };
  const result = applyCapexCapacityToFactories([f1, f2], capexState, period(2015, 3));
  const r1 = result.find((f) => f.factoryId === "BAL-F1")!;
  const r2 = result.find((f) => f.factoryId === "BAL-F2")!;
  assert.equal(unwrapUnit(r1.commonProcessingCapacity), 30_000, "F1は不変でなければならない");
  assert.equal(unwrapUnit(r2.commonProcessingCapacity), 26_000, "F2だけに増強が反映される");
});

test("CAPEX-FAC-4: targetFactoryIdを指定すれば、冷凍・包装能力の増強も指定Factoryだけに適用される", () => {
  const f1 = factory({ factoryId: "BAL-F1", companyId: "BAL", freezingPackagingCapacity: hosoEqTons(20_000) });
  const f2 = factory({ factoryId: "BAL-F2", companyId: "BAL", freezingPackagingCapacity: hosoEqTons(15_000) });
  const p = makeProject({
    companyId: "BAL",
    projectType: "coldStorageExpansion",
    completedPeriod: period(2015, 1),
    futureCapacityEffect: effect({ targetProduct: "freezingPackaging", capacityIncreaseTonsPerQuarter: 500 }),
    targetFactoryId: "BAL-F2",
  });
  const capexState: CapexState = { companies: [capexStateWith("BAL", [p])] };
  const result = applyCapexCapacityToFactories([f1, f2], capexState, period(2015, 3));
  assert.equal(unwrapUnit(result.find((f) => f.factoryId === "BAL-F1")!.freezingPackagingCapacity), 20_000);
  assert.equal(unwrapUnit(result.find((f) => f.factoryId === "BAL-F2")!.freezingPackagingCapacity), 15_500);
});

test("CAPEX-FAC-5/6/7: HOSO・PD・VAPライン増強もそれぞれ指定Factoryだけに適用される", () => {
  const f1 = factory({ factoryId: "BAL-F1", companyId: "BAL", hosoCapacity: hosoEqTons(8_000), pdCapacity: hosoEqTons(7_000), vapCapacity: hosoEqTons(5_000) });
  const f2 = factory({ factoryId: "BAL-F2", companyId: "BAL", hosoCapacity: hosoEqTons(4_000), pdCapacity: hosoEqTons(3_000), vapCapacity: hosoEqTons(2_000) });
  const hoso = makeProject({ projectId: "P-H", companyId: "BAL", projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 400 }), targetFactoryId: "BAL-F2" });
  const pd = makeProject({ projectId: "P-P", companyId: "BAL", projectType: "pdLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "pd", capacityIncreaseTonsPerQuarter: 300 }), targetFactoryId: "BAL-F2" });
  const vap = makeProject({ projectId: "P-V", companyId: "BAL", projectType: "vapLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "vap", capacityIncreaseTonsPerQuarter: 200 }), targetFactoryId: "BAL-F2" });
  const capexState: CapexState = { companies: [capexStateWith("BAL", [hoso, pd, vap])] };
  const result = applyCapexCapacityToFactories([f1, f2], capexState, period(2015, 3));
  const r1 = result.find((f) => f.factoryId === "BAL-F1")!;
  const r2 = result.find((f) => f.factoryId === "BAL-F2")!;
  assert.equal(unwrapUnit(r1.hosoCapacity), 8_000);
  assert.equal(unwrapUnit(r1.pdCapacity), 7_000);
  assert.equal(unwrapUnit(r1.vapCapacity), 5_000);
  assert.equal(unwrapUnit(r2.hosoCapacity), 4_400);
  assert.equal(unwrapUnit(r2.pdCapacity), 3_300);
  assert.equal(unwrapUnit(r2.vapCapacity), 2_200);
});

test("CAPEX-FAC-11: 別々のFactoryへ同時に提案された案件は、それぞれ独立して自分のFactoryだけに反映される", () => {
  const f1 = factory({ factoryId: "BAL-F1", companyId: "BAL", commonProcessingCapacity: hosoEqTons(30_000) });
  const f2 = factory({ factoryId: "BAL-F2", companyId: "BAL", commonProcessingCapacity: hosoEqTons(22_000) });
  const p1 = makeProject({ projectId: "P-1", companyId: "BAL", projectType: "commonProcessingExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "commonProcessing", capacityIncreaseTonsPerQuarter: 700 }), targetFactoryId: "BAL-F1" });
  const p2 = makeProject({ projectId: "P-2", companyId: "BAL", projectType: "commonProcessingExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "commonProcessing", capacityIncreaseTonsPerQuarter: 4_000 }), targetFactoryId: "BAL-F2" });
  const capexState: CapexState = { companies: [capexStateWith("BAL", [p1, p2])] };
  const result = applyCapexCapacityToFactories([f1, f2], capexState, period(2015, 3));
  assert.equal(unwrapUnit(result.find((f) => f.factoryId === "BAL-F1")!.commonProcessingCapacity), 30_700);
  assert.equal(unwrapUnit(result.find((f) => f.factoryId === "BAL-F2")!.commonProcessingCapacity), 26_000);
});

test("CAPEX-FAC-15: targetFactoryId未指定のlegacy案件は主工場（factoryId先頭）へ寄せられる（既存挙動を壊さない）", () => {
  const f1 = factory({ factoryId: "BAL-F1", companyId: "BAL", hosoCapacity: hosoEqTons(8_000) });
  const f2 = factory({ factoryId: "BAL-F2", companyId: "BAL", hosoCapacity: hosoEqTons(4_000) });
  const legacy = makeProject({ companyId: "BAL", projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const capexState: CapexState = { companies: [capexStateWith("BAL", [legacy])] };
  const result = applyCapexCapacityToFactories([f1, f2], capexState, period(2015, 3));
  assert.equal(unwrapUnit(result.find((f) => f.factoryId === "BAL-F1")!.hosoCapacity), 8_500, "targetFactoryId未指定分は主工場（先頭factoryId）へ");
  assert.equal(unwrapUnit(result.find((f) => f.factoryId === "BAL-F2")!.hosoCapacity), 4_000, "F2は影響を受けない");
});

// ---------------------------------------------------------------------
// 4. 固定保守費（computeCapexMaintenanceCostUsd）
// ---------------------------------------------------------------------
// 新規capex資産の減価償却（建物・機械コンポーネント別定額法）の単体テストは
// capex/__tests__/depreciation.test.tsへ分離した（Phase 8B-2C）。

function testParams(maintenanceRatePerQuarter: number, readinessQuartersAfterCompletion = 0): CapexParameters {
  const tmpl = (projectType: CapitalProjectType): CapexProjectTemplate => ({
    projectType,
    displayName: "test",
    standardBudgetUsd: 1_000_000,
    standardConstructionQuarters: 1,
    paymentRatios: [1],
    assetCategory: "productionEquipment",
    postCompletionReadinessQuarters: readinessQuartersAfterCompletion,
    buildingRatio: 0.5,
    machineryRatio: 0.5,
    maintenanceRatePerQuarter,
    futureCapacityEffect: { readinessQuartersAfterCompletion },
  });
  const types: CapitalProjectType[] = [
    "hosoLineExpansion",
    "pdLineExpansion",
    "vapLineExpansion",
    "coldStorageExpansion",
    "qualityControlEquipment",
    "environmentalEquipment",
    "commonProcessingExpansion",
  ];
  const templatesByType = Object.fromEntries(types.map((t) => [t, tmpl(t)])) as Record<CapitalProjectType, CapexProjectTemplate>;
  return {
    parametersVersion: "test",
    templatesByType,
    minimumCashReserveUsd: 0,
    maxConcurrentActiveProjectsPerCompany: 99,
    epsilonUsd: 0.01,
    componentUsefulLifeQuarters: { building: 100, machinery: 40 },
  };
}

test("MAINT-1: 稼働開始前は保守費0", () => {
  const params = testParams(0.01);
  const p = makeProject({ projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: 1_000_000, futureCapacityEffect: effect() });
  assert.equal(computeCapexMaintenanceCostUsd([p], params, period(2015, 1)), 0);
});

test("MAINT-2: 稼働開始後は capitalizedAmountUsd × maintenanceRatePerQuarter が発生する", () => {
  const params = testParams(0.01);
  const p = makeProject({ projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: 1_000_000, futureCapacityEffect: effect() });
  const m = computeCapexMaintenanceCostUsd([p], params, period(2015, 2));
  assert.ok(Math.abs(m - 10_000) < EPS);
});

test("MAINT-3: 減価償却の耐用年数を超えた遠い将来でも保守費は継続して発生する（減価償却とは異なり打ち切られない。減価償却自体の打ち切り検証はdepreciation.test.tsのDEP-*が担う）", () => {
  const params = testParams(0.01);
  const p = makeProject({ projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: 1_000_000, futureCapacityEffect: effect() });
  const farFuture = period(2035, 1); // componentUsefulLifeQuarters.building(100)を超えるほど遠い将来
  assert.ok(Math.abs(computeCapexMaintenanceCostUsd([p], params, farFuture) - 10_000) < EPS, "保守費は耐用年数を超えても継続するはず");
});

test("MAINT-4: 複数案件の保守費は合算される", () => {
  const params = testParams(0.01);
  const a = makeProject({ projectId: "A", projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: 1_000_000, futureCapacityEffect: effect() });
  const b = makeProject({ projectId: "B", projectType: "vapLineExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: 2_000_000, futureCapacityEffect: effect() });
  const total = computeCapexMaintenanceCostUsd([a, b], params, period(2015, 2));
  assert.ok(Math.abs(total - (10_000 + 20_000)) < EPS);
});

test("MAINT-5: 建設中・取消済みは保守費0", () => {
  const params = testParams(0.01);
  const underConstruction = makeProject({ projectType: "hosoLineExpansion", status: "underConstruction", completedPeriod: undefined, capitalizedAmountUsd: undefined, futureCapacityEffect: effect() });
  const cancelled = makeProject({ projectType: "vapLineExpansion", status: "cancelled", completedPeriod: undefined, capitalizedAmountUsd: undefined, cumulativePaidUsd: 0, cancelledPeriod: period(2015, 1), futureCapacityEffect: effect() });
  assert.equal(computeCapexMaintenanceCostUsd([underConstruction, cancelled], params, period(2020, 1)), 0);
});
