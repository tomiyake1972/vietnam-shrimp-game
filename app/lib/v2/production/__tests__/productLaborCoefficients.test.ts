// ShrimpX V2 — 商品別労働係数とPD省人化の業務判断化（PDL-1〜PDL-20）
//
// 実装指示 §8 の必須テスト項目に対応する。数値の比較許容は既存慣例
// （厳密比較できるものは assert.equal、浮動小数は 1e-6〜1e-9 の絶対/相対許容）に従う。
//
// 【このテストが守るもの】
//  1. 商品別係数そのもの（機械化前後）
//  2. 機械化効果が**ちょうど1回だけ**適用されること
//  3. 「必要労働の理論削減」と「PL/CFに実際に現れる効果」が別物であること

import test from "node:test";
import assert from "node:assert/strict";

import {
  allocateWorkersToPlans,
  calculateLaborCapacityFromAssignedHeadcount,
  effectiveEfficiencyPerHeadTons,
  laborIntensityCoefficientFor,
  requiredHeadcountForQuantity,
  resolveLaborIntensityCoefficient,
  WorkerDemandItem,
} from "../labor";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "../parameters";
import { computeEffectivePdCoefficient, PD_MECHANIZATION_PARAMETERS_V1, reductionRatioAtFullMaturity } from "../../capex/pdMechanization";
import { computeRequiredRegularHeadcount } from "../../companyLab/workforce";
import { Product } from "../../market/types";
import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { Factory, FactoryEffectiveCapacity, WorkerAssignment } from "../types";

const P = PRODUCTION_PARAMETERS_V1;
const TOL = 1e-9;
const LOOSE_TOL = 1e-6;

// ---------------------------------------------------------------------
// テスト用フィクスチャ（既存 labor.test.ts と同じ構成）
// ---------------------------------------------------------------------

function makeFactory(overrides: Partial<Factory> = {}): Factory {
  return {
    factoryId: "F1",
    companyId: "C1",
    commonProcessingCapacity: hosoEqTons(1_000_000),
    hosoCapacity: hosoEqTons(1_000_000),
    pdCapacity: hosoEqTons(1_000_000),
    vapCapacity: hosoEqTons(1_000_000),
    freezingPackagingCapacity: hosoEqTons(1_000_000),
    coldStorageCapacity: hosoEqTons(1_000_000),
    ...overrides,
  } as Factory;
}

function capacityMapFor(factory: Factory): ReadonlyMap<string, FactoryEffectiveCapacity> {
  return new Map([
    [
      factory.factoryId,
      {
        factoryId: factory.factoryId,
        companyId: factory.companyId,
        commonProcessing: factory.commonProcessingCapacity,
        hoso: factory.hosoCapacity,
        pd: factory.pdCapacity,
        vap: factory.vapCapacity,
        freezingPackaging: factory.freezingPackagingCapacity,
        coldStorage: factory.coldStorageCapacity,
      } as FactoryEffectiveCapacity,
    ],
  ]);
}

function makeAssignment(overrides: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    factoryId: "F1",
    companyId: "C1",
    regularHeadcount: 1000,
    temporaryHeadcount: 0,
    skills: (["hoso", "pd", "vap"] as const).map((product) => ({ product, skillLevel: ratio(1) })),
    overtimeRate: ratio(0),
    attendanceRate: ratio(1),
    ...overrides,
  } as WorkerAssignment;
}

function demand(overrides: Partial<WorkerDemandItem> = {}): WorkerDemandItem {
  return {
    id: "d1",
    factoryId: "F1",
    companyId: "C1",
    product: "hoso",
    priority: 1,
    candidateQuantity: 100,
    ...overrides,
  } as WorkerDemandItem;
}

/** 素の必要人員（設備・原料の制約を挟まない純粋な労働逆算）。 */
function requiredHeadcount(product: Product, quantity: number, mechanizationLevel = 0, params: ProductionParameters = P): number {
  return requiredHeadcountForQuantity(
    quantity,
    effectiveEfficiencyPerHeadTons(params.labor.regularEfficiencyPerHeadTons, product, params, mechanizationLevel),
    1,
    1,
    0,
    params
  );
}

// ---------------------------------------------------------------------
// 1. 係数そのもの
// ---------------------------------------------------------------------

test("PDL-1: 未機械化の必要労働比が HOSO:PD = 1:1.8、HOSO:VAP = 1:3.0", () => {
  const hoso = requiredHeadcount("hoso", 1000);
  const pd = requiredHeadcount("pd", 1000);
  const vap = requiredHeadcount("vap", 1000);
  assert.ok(Math.abs(pd / hoso - 1.8) < TOL, `PD/HOSO = 1.8 のはず（実測 ${pd / hoso}）`);
  assert.ok(Math.abs(vap / hoso - 3.0) < TOL, `VAP/HOSO = 3.0 のはず（実測 ${vap / hoso}）`);
});

test("PDL-2: 機械化後の必要労働比が HOSO:PD:VAP = 1:1.2:2.6", () => {
  const hoso = requiredHeadcount("hoso", 1000, 1);
  const pd = requiredHeadcount("pd", 1000, 1);
  const vap = requiredHeadcount("vap", 1000, 1);
  assert.ok(Math.abs(pd / hoso - 1.2) < TOL, `PD/HOSO = 1.2 のはず（実測 ${pd / hoso}）`);
  assert.ok(Math.abs(vap / hoso - 2.6) < TOL, `VAP/HOSO = 2.6 のはず（実測 ${vap / hoso}）`);
});

test("PDL-3: 同じPD数量に必要な労働が機械化で33.3%減る", () => {
  const before = requiredHeadcount("pd", 1000);
  const after = requiredHeadcount("pd", 1000, 1);
  const reduction = 1 - after / before;
  assert.ok(Math.abs(reduction - 1 / 3) < TOL, `削減率は1/3のはず（実測 ${reduction}）`);
  // capex側が公開する削減率と完全に一致する（別々の数値を持たない）。
  assert.ok(Math.abs(reductionRatioAtFullMaturity() - reduction) < TOL);
});

test("PDL-4: 同じ労働で作れるPDが機械化で50%増える", () => {
  const factory = makeFactory();
  const assignment = makeAssignment({ regularHeadcount: 100 });
  const before = calculateLaborCapacityFromAssignedHeadcount(100, 0, 1, 1, 0, unwrapUnit(factory.pdCapacity), P, "pd", 0);
  const after = calculateLaborCapacityFromAssignedHeadcount(100, 0, 1, 1, 0, unwrapUnit(factory.pdCapacity), P, "pd", 1);
  void assignment;
  assert.ok(Math.abs(after / before - 1.5) < TOL, `同じ人手で1.5倍のPDを作れるはず（実測 ${after / before}）`);
});

test("PDL-5: VAPの必要労働は機械化で13.3%減る（前工程の殻剥き共通化ぶんのみ）", () => {
  const before = requiredHeadcount("vap", 1000);
  const after = requiredHeadcount("vap", 1000, 1);
  const reduction = 1 - after / before;
  assert.ok(Math.abs(reduction - (1 - 2.6 / 3.0)) < TOL, `削減率は 1 − 2.6/3.0 のはず（実測 ${reduction}）`);
  assert.ok(reduction > 0.13 && reduction < 0.14, `13.3%前後のはず（実測 ${reduction}）`);
  // PDの削減率のほうが必ず大きい。
  assert.ok(reduction < 1 / 3, "VAPの削減率はPD(33.3%)より小さい");
});

test("PDL-6: HOSOの必要労働は機械化で一切変わらない", () => {
  for (const level of [0, 0.25, 0.5, 0.75, 1]) {
    assert.equal(requiredHeadcount("hoso", 1000, level), requiredHeadcount("hoso", 1000, 0), `level=${level} でHOSOが変化した`);
    assert.equal(resolveLaborIntensityCoefficient("hoso", level, P), 1.0);
  }
});

test("PDL-7: 機械化レベルは線形補間され、範囲外はclampされる", () => {
  assert.equal(resolveLaborIntensityCoefficient("pd", 0, P), 1.8);
  assert.equal(resolveLaborIntensityCoefficient("pd", 1, P), 1.2);
  assert.ok(Math.abs(resolveLaborIntensityCoefficient("pd", 0.5, P) - 1.5) < TOL);
  assert.equal(resolveLaborIntensityCoefficient("pd", -1, P), 1.8, "負のレベルは未機械化として扱う");
  assert.equal(resolveLaborIntensityCoefficient("pd", 2, P), 1.2, "1超のレベルは完全成熟として扱う");
  assert.ok(Math.abs(resolveLaborIntensityCoefficient("vap", 0.5, P) - 2.8) < TOL, "VAPも同じ線形補間");
});

// ---------------------------------------------------------------------
// 2. 【最重要】機械化効果がちょうど1回だけ適用されること
// ---------------------------------------------------------------------

test("PDL-8: 【二重適用の検出】生産エンジンを通した実効労働能力が、係数から直接計算した理論値と厳密に一致する", () => {
  // 二重適用が起きていれば、実効能力は理論値の (1.8/1.2)^2 倍などになり一致しない。
  const factory = makeFactory();
  const assignment = makeAssignment({ regularHeadcount: 60 });
  const levels = new Map([["F1", 1.0]]);

  for (const product of ["hoso", "pd", "vap"] as const) {
    const result = allocateWorkersToPlans(
      [demand({ id: product, product, candidateQuantity: 1_000_000, priority: 1 })],
      [assignment],
      capacityMapFor(factory),
      P,
      levels
    );
    const engineCapacity = unwrapUnit(result.entries[0].laborCapacity);
    // 理論値: 配置人数 × (基準効率 ÷ 機械化後係数)。係数を1回だけ適用する。
    const theoretical =
      result.entries[0].assignedRegularHeadcount *
      (P.labor.regularEfficiencyPerHeadTons / P.labor.mechanizedLaborIntensityCoefficient[product]);
    assert.ok(
      Math.abs(engineCapacity - theoretical) < 0.01,
      `${product}: エンジンの実効能力(${engineCapacity})が理論値(${theoretical})と一致しない＝係数が二重適用されている可能性`
    );
  }
});

test("PDL-9: 【二重適用の検出】必要人員の見積り（workforce.ts）と生産エンジンの逆算が完全に一致する", () => {
  // 見積り経路と実生産経路で別々の式に分岐していれば、ここがずれる。
  const factory = makeFactory();
  const quantity = 500;
  for (const level of [0, 0.5, 1]) {
    for (const product of ["hoso", "pd", "vap"] as const) {
      const estimate = computeRequiredRegularHeadcount({
        quantityByProduct: { [product]: quantity } as Partial<Record<Product, number>>,
        skillByProduct: { hoso: 1, pd: 1, vap: 1 },
        attendanceRate: 1,
        appliedOvertimeRate: 0,
        temporaryHeadcount: 0,
        mechanizationLevel: level,
      }).requiredRegularHeadcount;

      // 生産エンジン側: その人数をちょうど配置すれば、希望量ちょうどを処理できるはず。
      const engineCapacity = calculateLaborCapacityFromAssignedHeadcount(
        estimate,
        0,
        1,
        1,
        0,
        unwrapUnit(factory.pdCapacity),
        P,
        product,
        level
      );
      assert.ok(
        Math.abs(engineCapacity - quantity) < LOOSE_TOL,
        `level=${level} ${product}: 見積り人数${estimate}で処理できる量(${engineCapacity})が希望量(${quantity})と一致しない`
      );
    }
  }
});

test("PDL-10: 【二重適用の検出】capex側のcomputeEffectivePdCoefficientと正典の写像が同じ値を返す", () => {
  for (const level of [0, 0.1, 0.33, 0.5, 0.75, 1]) {
    assert.equal(
      computeEffectivePdCoefficient(level, PD_MECHANIZATION_PARAMETERS_V1),
      resolveLaborIntensityCoefficient("pd", level, P),
      `level=${level}: capex側と正典側で値が異なる＝2つの写像が併存している`
    );
  }
});

test("PDL-11: 機械化レベルは工場単位で独立に効き、他工場へ波及しない", () => {
  const factoryA = makeFactory({ factoryId: "FA" });
  const factoryB = makeFactory({ factoryId: "FB" });
  const capacities = new Map([...capacityMapFor(factoryA), ...capacityMapFor(factoryB)]);
  const assignments = [makeAssignment({ factoryId: "FA" }), makeAssignment({ factoryId: "FB" })];
  const levels = new Map([["FA", 1.0]]); // FAだけ機械化

  const result = allocateWorkersToPlans(
    [
      demand({ id: "a", factoryId: "FA", product: "pd", candidateQuantity: 1_000_000 }),
      demand({ id: "b", factoryId: "FB", product: "pd", candidateQuantity: 1_000_000 }),
    ],
    assignments,
    capacities,
    P,
    levels
  );
  const a = result.entries.find((e) => e.factoryId === "FA")!;
  const b = result.entries.find((e) => e.factoryId === "FB")!;
  assert.ok(
    Math.abs(unwrapUnit(a.laborCapacity) / unwrapUnit(b.laborCapacity) - 1.5) < 1e-4,
    `機械化した工場だけが1.5倍になるはず（実測 ${unwrapUnit(a.laborCapacity) / unwrapUnit(b.laborCapacity)}）`
  );
});

// ---------------------------------------------------------------------
// 3. 労働不足下の実生産・優先度
// ---------------------------------------------------------------------

test("PDL-12: 労働不足の状況で、機械化前後の実生産量が変わる", () => {
  const factory = makeFactory();
  // 人手を絞り、労働が明確に律速になる状況を作る。
  const assignment = makeAssignment({ regularHeadcount: 10 });
  const demands = [demand({ id: "pd", product: "pd", candidateQuantity: 100_000, priority: 1 })];

  const before = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory), P, new Map());
  const after = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory), P, new Map([["F1", 1.0]]));

  const beforeTons = unwrapUnit(before.entries[0].laborCapacity);
  const afterTons = unwrapUnit(after.entries[0].laborCapacity);
  assert.ok(afterTons > beforeTons, `機械化後のほうが多く作れるはず（${beforeTons} → ${afterTons}）`);
  assert.ok(Math.abs(afterTons / beforeTons - 1.5) < 1e-3, `増加率は1.5倍のはず（丸め誤差込み。実測 ${afterTons / beforeTons}）`);
});

test("PDL-13: 労働が不足するとき、生産優先度が商品別のワーカー配分へ反映される", () => {
  const factory = makeFactory();
  const assignment = makeAssignment({ regularHeadcount: 20 }); // 全部は賄えない人数
  const demands = [
    demand({ id: "hoso", product: "hoso", candidateQuantity: 10_000, priority: 1 }),
    demand({ id: "pd", product: "pd", candidateQuantity: 10_000, priority: 2 }),
  ];
  const result = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory), P, new Map());
  const hoso = result.entries.find((e) => e.product === "hoso")!;
  const pd = result.entries.find((e) => e.product === "pd")!;
  assert.ok(
    hoso.assignedRegularHeadcount > pd.assignedRegularHeadcount,
    `優先度1のHOSOへ先に配分されるはず（HOSO=${hoso.assignedRegularHeadcount} PD=${pd.assignedRegularHeadcount}）`
  );

  // 優先度を逆転させると配分も逆転する。
  const reversed = allocateWorkersToPlans(
    [
      demand({ id: "hoso", product: "hoso", candidateQuantity: 10_000, priority: 2 }),
      demand({ id: "pd", product: "pd", candidateQuantity: 10_000, priority: 1 }),
    ],
    [assignment],
    capacityMapFor(factory),
    P,
    new Map()
  );
  const pdFirst = reversed.entries.find((e) => e.product === "pd")!;
  assert.ok(pdFirst.assignedRegularHeadcount > pd.assignedRegularHeadcount, "優先度を上げたPDへより多く配分される");
});

test("PDL-14: 機械化はHOSOの実生産量を変えない（労働不足下でも）", () => {
  const factory = makeFactory();
  const assignment = makeAssignment({ regularHeadcount: 10 });
  const demands = [demand({ id: "hoso", product: "hoso", candidateQuantity: 100_000, priority: 1 })];
  const before = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory), P, new Map());
  const after = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory), P, new Map([["F1", 1.0]]));
  assert.equal(unwrapUnit(after.entries[0].laborCapacity), unwrapUnit(before.entries[0].laborCapacity));
});

// ---------------------------------------------------------------------
// 4. 係数のパラメータ化（コード編集なしの感度分析）
// ---------------------------------------------------------------------

/** 感度分析用に係数だけを差し替えたパラメータを作る（コードを書き換えずに検証できること）。 */
export function withLaborCoefficients(
  base: Readonly<Record<Product, number>>,
  mechanized: Readonly<Record<Product, number>>,
  params: ProductionParameters = P
): ProductionParameters {
  return {
    ...params,
    labor: { ...params.labor, laborIntensityCoefficient: base, mechanizedLaborIntensityCoefficient: mechanized },
  };
}

test("PDL-15: 係数はパラメータ経由で差し替えでき、計算結果がそれに追随する（感度分析の前提）", () => {
  const conservative = withLaborCoefficients({ hoso: 1.0, pd: 1.6, vap: 3.0 }, { hoso: 1.0, pd: 1.2, vap: 2.7 });
  const strong = withLaborCoefficients({ hoso: 1.0, pd: 2.0, vap: 3.2 }, { hoso: 1.0, pd: 1.2, vap: 2.6 });

  const reductionOf = (params: ProductionParameters, product: Product) =>
    1 - requiredHeadcount(product, 1000, 1, params) / requiredHeadcount(product, 1000, 0, params);

  assert.ok(Math.abs(reductionOf(conservative, "pd") - (1 - 1.2 / 1.6)) < TOL);
  assert.ok(Math.abs(reductionOf(strong, "pd") - (1 - 1.2 / 2.0)) < TOL);
  assert.ok(reductionOf(strong, "pd") > reductionOf(P, "pd"), "強設定のほうがPDの削減余地が大きい");
  assert.ok(reductionOf(conservative, "pd") < reductionOf(P, "pd"), "保守設定のほうが削減余地が小さい");
  // 係数は判断ロジックに埋め込まれておらず、パラメータの差し替えだけで挙動が変わる。
  assert.equal(laborIntensityCoefficientFor("pd", conservative), 1.6);
});

test("PDL-16: 旧実装相当（両側とも旧値）を再現でき、旧削減率16.67%に戻る", () => {
  const legacy = withLaborCoefficients({ hoso: 1.0, pd: 1.2, vap: 3.0 }, { hoso: 1.0, pd: 1.0, vap: 3.0 });
  const reduction = 1 - requiredHeadcount("pd", 1000, 1, legacy) / requiredHeadcount("pd", 1000, 0, legacy);
  assert.ok(Math.abs(reduction - 1 / 6) < TOL, `旧実装の削減率は1/6のはず（実測 ${reduction}）`);
  // 旧実装ではVAPに一切効かなかった。
  assert.equal(requiredHeadcount("vap", 1000, 1, legacy), requiredHeadcount("vap", 1000, 0, legacy));
});
