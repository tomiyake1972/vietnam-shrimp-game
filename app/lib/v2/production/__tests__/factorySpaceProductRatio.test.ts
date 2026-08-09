// ShrimpX V2 — Test16 最終調整: 商品別スペース係数の再設計
//
// 【守る因果】
//  (a) HOSO : PD : VAP の床面積負荷が 1 : 2 : 3 である
//      （＝同じ能力を積むのに、PDはHOSOの2倍、VAPは3倍の場所を要する）
//  (b) MASS は既存工場1棟の中で HOSO 12,000 → 24,000t まで積める
//  (c) 24,000t を超えては積めない（HOSO能力の明示上限）
//  (d) VAP集中は同じ工場スペースで積める能力が小さく、新工場が早く必要になる

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACTORY_SPACE_PARAMETERS_V1,
  computeProjectRequiredSpaceUnits,
  computeFactoryUsedSpaceUnits,
  resolveFactoryTotalSpaceUnits,
} from "../factorySpace";
import { MAX_HOSO_CAPACITY_TONS } from "../../capex/capacityEffect";
import { CAPEX_PARAMETERS_V1 } from "../../capex/parameters";
import { computeCandidateProjectSpaceUnits } from "../../capex/factorySpace";
import { initializeCompanyLab } from "../../companyLab/runner";
import { CompanyLabConfig } from "../../companyLab/types";
import { unwrapUnit } from "../../core/units";

const P = FACTORY_SPACE_PARAMETERS_V1;

function fixtures() {
  return initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "space-ratio-test", turns: 1 } as unknown as CompanyLabConfig).fixtures;
}

function primaryFactory(companyId: string) {
  const f = fixtures().find((x) => x.companyId === companyId)!;
  return f.factories[0];
}

/** 同じ能力量（1,000t）を積むのに要するスペース単位。比率の比較はこの正規化で行う。 */
function spacePer1000Tons(pool: "hoso" | "pd" | "vap"): number {
  return computeProjectRequiredSpaceUnits({ projectType: "hosoLineExpansion", targetPool: pool, capacityIncreaseTons: 1_000 }, P);
}

// ---------------------------------------------------------------------
// 1. 係数比率
// ---------------------------------------------------------------------

test("SPACE-1: HOSO/PD/VAPのスペース係数は 1 : 2 : 3", () => {
  const hoso = spacePer1000Tons("hoso");
  const pd = spacePer1000Tons("pd");
  const vap = spacePer1000Tons("vap");
  assert.equal(hoso, 1_000);
  assert.equal(pd / hoso, 2);
  assert.equal(vap / hoso, 3);
});

test("SPACE-6: 同じ能力増加なら PD は HOSO より多くスペースを使う", () => {
  assert.ok(spacePer1000Tons("pd") > spacePer1000Tons("hoso"));
});

test("SPACE-7: 同じ能力増加なら VAP は PD より多くスペースを使う", () => {
  assert.ok(spacePer1000Tons("vap") > spacePer1000Tons("pd"));
});

// ---------------------------------------------------------------------
// 2〜5. MASS が既存工場内で 12,000 → 24,000t へ到達できる
// ---------------------------------------------------------------------

/**
 * MASS の主工場について、HOSO増設を n 回入れたときの
 * 使用スペースと空きを求める（承認判定と同じ式を使う）。
 */
function massSpaceAfterHosoExpansions(count: number): { total: number; used: number; free: number; perProject: number } {
  const factory = primaryFactory("MASS");
  const total = resolveFactoryTotalSpaceUnits(factory, P);
  const baseUsed = computeFactoryUsedSpaceUnits(factory, P);
  const perProject = computeCandidateProjectSpaceUnits("hosoLineExpansion", CAPEX_PARAMETERS_V1, P);
  const used = baseUsed + perProject * count;
  return { total, used, free: total - used, perProject };
}

test("SPACE-2: MASS は HOSO 12,000 → 16,000（増設1回目）を既存工場内で実行できる", () => {
  const s = massSpaceAfterHosoExpansions(1);
  assert.ok(s.free >= 0, `1回目でスペース不足 free=${s.free}`);
  assert.equal(unwrapUnit(primaryFactory("MASS").hosoCapacity), 12_000);
});

test("SPACE-3: MASS は 16,000 → 20,000（増設2回目）も実行できる", () => {
  const s = massSpaceAfterHosoExpansions(2);
  assert.ok(s.free >= 0, `2回目でスペース不足 free=${s.free}`);
});

test("SPACE-4: MASS は 20,000 → 24,000（増設3回目）も実行できる＝上限まで既存工場内で到達可能", () => {
  const s = massSpaceAfterHosoExpansions(3);
  assert.ok(s.free >= 0, `3回目でスペース不足 free=${s.free} used=${s.used} total=${s.total}`);
  // 12,000 + 4,000×3 = 24,000 ＝ HOSO能力の明示上限。
  const increment = CAPEX_PARAMETERS_V1.templatesByType.hosoLineExpansion.futureCapacityEffect!.capacityIncreaseTonsPerQuarter!;
  assert.equal(12_000 + increment * 3, MAX_HOSO_CAPACITY_TONS);
});

test("SPACE-5: 24,000tを超えるHOSO能力は、スペースに余裕があっても能力上限で頭打ちになる", () => {
  assert.equal(MAX_HOSO_CAPACITY_TONS, 24_000);

  // 【この設計が正しい形である理由】
  // 4回目の増設はスペース上は入る（空きが残っている）。それでもHOSO能力が
  // 24,000tを超えないのは、capacityEffect 側の明示上限が効いているためである。
  // 「スペースが偶然足りないから止まる」のではなく「能力上限で止まる」という
  // 意図した歯止めになっていることを確認する。
  const s = massSpaceAfterHosoExpansions(4);
  assert.ok(s.free >= 0, `4回目がスペース不足で止まっている（上限が歯止めになっていない） free=${s.free}`);

  // 能力側の頭打ちを実データで確認する。
  const factory = primaryFactory("MASS");
  const increment = CAPEX_PARAMETERS_V1.templatesByType.hosoLineExpansion.futureCapacityEffect!.capacityIncreaseTonsPerQuarter!;
  const nominalAfter4 = unwrapUnit(factory.hosoCapacity) + increment * 4;
  assert.ok(nominalAfter4 > MAX_HOSO_CAPACITY_TONS, "4回増設しても上限を超えない設定になっている（テストの前提が崩れている）");
  // 上限の適用そのものは capex/__tests__/hosoCapacityCap.test.ts で検証済み。
  // ここでは「スペースではなく能力上限が歯止めになっている」ことだけを確認する。
  assert.ok(
    unwrapUnit(factory.hosoCapacity) + increment * 3 === MAX_HOSO_CAPACITY_TONS,
    "3回で上限へちょうど到達する設計になっていない"
  );
});

// ---------------------------------------------------------------------
// 8. VAP集中は新工場需要が早く発生する
// ---------------------------------------------------------------------

test("SPACE-8: 同じ空きスペースで積める能力は VAP が HOSO の1/3であり、新工場が早く必要になる", () => {
  const factory = primaryFactory("VAP");
  const total = resolveFactoryTotalSpaceUnits(factory, P);
  const free = total - computeFactoryUsedSpaceUnits(factory, P);

  // 空きスペースをすべて使ったときに積める能力（トン）。
  const hosoTons = free / P.spaceUnitsPerCapacityTon.hoso;
  const vapTons = free / P.spaceUnitsPerCapacityTon.vap;

  assert.ok(Math.abs(hosoTons / vapTons - 3) < 1e-9, `HOSOとVAPで積める能力の比が3倍でない (${hosoTons / vapTons})`);
  assert.ok(vapTons < hosoTons, "VAPの方が積める能力が小さくなっていない");

  // VAP増設案件（+250t）換算で何件入るか。HOSO増設（+4,000t）と比べ、
  // 積み上がる能力が小さいうちにスペースを使い切る＝新工場が早く要る。
  const vapPerProject = computeCandidateProjectSpaceUnits("vapLineExpansion", CAPEX_PARAMETERS_V1, P);
  const hosoPerProject = computeCandidateProjectSpaceUnits("hosoLineExpansion", CAPEX_PARAMETERS_V1, P);
  const vapCapacityBeforeFull = Math.floor(free / vapPerProject) * 250;
  const hosoCapacityBeforeFull = Math.floor(free / hosoPerProject) * 4_000;
  assert.ok(
    vapCapacityBeforeFull < hosoCapacityBeforeFull,
    `VAP集中の方が先にスペースを使い切っていない vap=${vapCapacityBeforeFull} hoso=${hosoCapacityBeforeFull}`
  );
});

// ---------------------------------------------------------------------
// 9. 既存capex会計への影響がないこと
// ---------------------------------------------------------------------

test("SPACE-9: スペース係数の変更は投資額・工期・能力増分に影響しない（capex会計は不変）", () => {
  const t = CAPEX_PARAMETERS_V1.templatesByType;
  assert.equal(t.hosoLineExpansion.standardBudgetUsd, 8_000_000);
  assert.equal(t.hosoLineExpansion.futureCapacityEffect!.capacityIncreaseTonsPerQuarter, 4_000);
  assert.equal(t.hosoLineExpansion.standardConstructionQuarters, 1);
  assert.equal(t.pdLineExpansion.futureCapacityEffect!.capacityIncreaseTonsPerQuarter, 350);
  assert.equal(t.vapLineExpansion.futureCapacityEffect!.capacityIncreaseTonsPerQuarter, 250);
  // スペースは承認可否の判定にのみ使われ、金額・償却には現れない。
  assert.equal(P.fixedSpaceUnitsByProjectType.qualityControlEquipment, 600);
  assert.equal(P.fixedSpaceUnitsByProjectType.environmentalEquipment, 900);
});

test("SPACE-10: 総スペースは基礎能力から決定論的に導出され、保存を必須にしない（migration不要）", () => {
  // Factory.totalFactorySpaceUnits を持たない既存ラボでも、基礎能力から
  // 同じ値が再現される（永続化データの移行が要らない構造であることの確認）。
  const factory = primaryFactory("MASS");
  const a = resolveFactoryTotalSpaceUnits(factory, P);
  const b = resolveFactoryTotalSpaceUnits(factory, P);
  assert.equal(a, b, "同じ入力から同じ総量が再現されない（決定論的でない）");

  // 明示値を持たない工場では、基礎能力 × (1 + 余裕率) で導出される。
  // これにより Phase 8D 以前に作成された既存ラボもそのまま読み込め、
  // 永続化データの移行が不要である。
  const withoutExplicit = { ...factory, totalFactorySpaceUnits: undefined };
  assert.ok(
    Math.abs(resolveFactoryTotalSpaceUnits(withoutExplicit, P) - computeFactoryUsedSpaceUnits(withoutExplicit, P) * (1 + P.defaultSpaceHeadroomRatio)) < 1e-9
  );
});
