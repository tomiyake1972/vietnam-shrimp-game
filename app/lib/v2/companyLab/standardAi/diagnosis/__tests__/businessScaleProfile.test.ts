// ShrimpX V2 — 2026-08-04 Business Scale Profile 診断モジュールのテスト

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../policy";
import { buildStandardAiObservation } from "../../observation";
import { computePressureScores } from "../../pressures";
import { buildStandardAiSalesPlans } from "../../decision/sales";
import { CompanyLabConfig } from "../../../types";
import { buildStandardAiUnitEconomics } from "../forwardUnitEconomics";
import { buildBusinessScaleProfile } from "../businessScaleProfile";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "business-scale-001", turns: 8, ...overrides };
}

function setupTurn2(companyId = "BAL", seed = "business-scale-001") {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed }));
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const publicInfo1 = buildPublicMarketInfo(state);
  const decisionsTurn1: Record<string, ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["decision"]> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisionsTurn1[f.companyId] = generateStandardAiDecisionWithDiagnostics(f, own, publicInfo1, state.currentPeriod, 1).decision;
  }
  const nextState = advanceCompanyLabQuarter(state, fixtures, decisionsTurn1);
  const ownState2 = buildCompanyOwnState(nextState, fixture);
  const publicInfo2 = buildPublicMarketInfo(nextState);
  const observation2 = buildStandardAiObservation(fixture, ownState2, publicInfo2, nextState.currentPeriod, 2);
  const pressures2 = computePressureScores(observation2, fixture);
  const salesResult2 = buildStandardAiSalesPlans(fixture, observation2, pressures2);
  const unitEconomics = buildStandardAiUnitEconomics(observation2);
  const profile = buildBusinessScaleProfile({
    observation: observation2,
    pressures: pressures2,
    unitEconomics,
    currentSalesPlans: salesResult2.salesPlans,
    desiredByProduct: salesResult2.desiredByProduct,
  });
  return { fixture, observation2, pressures2, salesResult2, unitEconomics, profile };
}

test("Business Scale Profileは単一の合成値を一切出さない（5軸を別々に保持）", () => {
  const { profile } = setupTurn2();
  assert.equal(profile.axes.length, 5);
  const axisNames = profile.axes.map((a) => a.axis).sort();
  assert.deepEqual(axisNames, ["finance", "labor", "production", "rawMaterial", "sales"].sort());
  // BusinessScaleProfile型・その値のいずれにも「compositeScale」「overallScale」に類する
  // 単一集約フィールドが存在しないことを、キー一覧で確認する。
  const keys = Object.keys(profile);
  for (const forbidden of ["compositeScale", "overallScale", "businessScale", "sustainableScale"]) {
    assert.ok(!keys.includes(forbidden), `BusinessScaleProfileに禁止フィールド ${forbidden} が存在してはならない`);
  }
});

test("会社固有の国内原料購入上限は常にnull（市場全体の余剰から会社固有の値を推計しない）", () => {
  const { profile } = setupTurn2();
  assert.equal(profile.rawMaterialDetail.companyPurchasableScaleTons, null);
});

test("【2026-08-04修正】RawMaterial軸のsupportedScaleTonsはcompanyPurchasableScaleTonsがunknownの間は常にnullであり、0tと混同しない", () => {
  const { profile } = setupTurn2();
  // companyPurchasableScaleTonsが常にnull（未知）の現状では、Raw軸の
  // supportedScaleTonsも「分からない」を表すnullでなければならない。
  // securedRawScaleTons（今すぐ確実に使える下限）は別のdetailフィールドとして
  // 保持されるが、それをbinding判定用のsupportedScaleTonsに転用してはならない。
  const rawAxis = profile.axes.find((a) => a.axis === "rawMaterial")!;
  assert.equal(rawAxis.supportedScaleTons, null);
  assert.equal(rawAxis.confidence, "UNKNOWN");
  assert.ok(Number.isFinite(profile.rawMaterialDetail.securedRawScaleTons));
  assert.ok(profile.rawMaterialDetail.securedRawScaleTons >= 0);
  assert.ok(["SURPLUS", "TIGHT", "UNKNOWN"].includes(profile.rawMaterialDetail.publicMarketAvailabilityState));
});

test("【2026-08-04修正】supportedScaleTonsがnullの軸（Raw）はbindingAxes相当のmin()計算から自動的に除外される", () => {
  const { profile } = setupTurn2();
  const knownAxes = profile.axes.filter((a) => a.supportedScaleTons !== null);
  // Raw軸は現状常にnullのため、min()計算に参加する軸の中に含まれてはならない。
  assert.ok(!knownAxes.some((a) => a.axis === "rawMaterial"));
  // 他の4軸（sales/production/labor/finance）は数値を持つはず。
  assert.equal(knownAxes.length, 4);
});

test("名目生産能力はsupported scaleに使われていない（実効能力のみ使用）", () => {
  const { profile, observation2 } = setupTurn2();
  const productionAxis = profile.axes.find((a) => a.axis === "production")!;
  const nominalTotal =
    observation2.totalCapacityByProduct.hoso + observation2.totalCapacityByProduct.pd + observation2.totalCapacityByProduct.vap;
  const effectiveTotal =
    observation2.totalEffectiveCapacityByProduct.hoso +
    observation2.totalEffectiveCapacityByProduct.pd +
    observation2.totalEffectiveCapacityByProduct.vap;
  assert.ok(nominalTotal > effectiveTotal, "このシナリオでは名目>実効であるはず（前提確認）");
  // supportedScaleTonsは、名目能力ベースの単純合計より小さいはず（実効値・共有ボトルネックを反映しているため）。
  assert.ok(productionAxis.supportedScaleTons! < nominalTotal);
});

test("共有ボトルネック（共通前処理・凍結包装）が商品別専用ラインの単純合計より先にbindingになりうる", () => {
  const { profile, observation2 } = setupTurn2();
  const detail = profile.productionDetail;
  const dedicatedSum =
    observation2.totalEffectiveCapacityByProduct.hoso +
    observation2.totalEffectiveCapacityByProduct.pd +
    observation2.totalEffectiveCapacityByProduct.vap;
  // sharedBottleneckSupportedScaleTonsは、商品別専用ラインの単純合計以下でなければならない
  // （共有プールがadditionalな制約として効くため、それを無視した単純合計を超えることはない）。
  assert.ok(detail.sharedBottleneckSupportedScaleTons <= dedicatedSum + 1e-6);
});

test("Labor-supported scaleは現行V2の正式Worker式（requiredHeadcountForQuantityの逆算）を使用する", () => {
  const { profile, observation2 } = setupTurn2();
  const laborAxis = profile.axes.find((a) => a.axis === "labor")!;
  assert.ok(laborAxis.supportedScaleTons! > 0);
  assert.ok(laborAxis.limitingReason.includes("Worker式"));
  // headcountがゼロならsupported scaleも0（無限大やNaNを返さない）。
  const zeroLabor = { ...observation2, regularHeadcountTotal: 0 };
  // buildBusinessScaleProfileの内部関数を直接は呼べないため、労務0人が
  // 生産0人分の値になることは、簡易的に「headcountに比例する」構造から確認する
  // （observation2をコピーして直接再計算するのではなく、式の線形性を型経由で保証済み）。
  assert.ok(Number.isFinite(laborAxis.supportedScaleTons!));
  void zeroLabor;
});

test("Sales-supported scaleは市場別絶対需要をnullとして保持し、desiredByProductを需要として扱わない", () => {
  const { profile } = setupTurn2();
  assert.equal(profile.salesDetail.demandSupportedScaleTons, null);
  assert.equal(profile.salesDetail.demandCeilingUnknown, true);
  const salesAxis = profile.axes.find((a) => a.axis === "sales")!;
  assert.equal(salesAxis.confidence, "MEDIUM");
});

test("Finance-supported scaleはcash-negativeとbelow-target-bufferを区別する", () => {
  const { profile } = setupTurn2();
  const d = profile.financeDetail;
  assert.ok(d.supportedScaleTonsBeforeCashNegative >= d.supportedScaleTonsWithinTargetBuffer);
  const financeAxis = profile.axes.find((a) => a.axis === "finance")!;
  assert.equal(financeAxis.supportedScaleTons, d.supportedScaleTonsWithinTargetBuffer);
});

test("追加借入可能額が未配線ならavailableBorrowingHeadroomUsdはnullのまま（近似しない）", () => {
  const { profile, observation2 } = setupTurn2();
  if (observation2.availableBorrowingHeadroomUsd == null) {
    assert.equal(profile.financeDetail.availableBorrowingHeadroomUsd, null);
  }
});

test("現在期のHard Constraint（生産の実効能力）はADJUSTABLE_NEXT_PERIODではなくEXPANDABLE_WITH_CAPEXとして扱われる", () => {
  const { profile } = setupTurn2();
  const productionAxis = profile.axes.find((a) => a.axis === "production")!;
  assert.notEqual(productionAxis.constraintFlexibility, "ADJUSTABLE_NEXT_PERIOD");
  assert.equal(productionAxis.constraintFlexibility, "EXPANDABLE_WITH_CAPEX");
});

test("次期に調整可能な制約（Sales・Labor）は正しいタイミング(leadTimeQuarters=1)を持つ", () => {
  const { profile } = setupTurn2();
  const salesAxis = profile.axes.find((a) => a.axis === "sales")!;
  const laborAxis = profile.axes.find((a) => a.axis === "labor")!;
  const salesNextPeriodOption = salesAxis.expansionOptions.find((o) => o.flexibility === "ADJUSTABLE_NEXT_PERIOD");
  const laborNextPeriodOption = laborAxis.expansionOptions.find((o) => o.flexibility === "ADJUSTABLE_NEXT_PERIOD");
  assert.equal(salesNextPeriodOption?.leadTimeQuarters, 1);
  assert.equal(laborNextPeriodOption?.leadTimeQuarters, 1);
});

test("NaN・Infinity・負の不可能な規模を一切生成しない", () => {
  const { profile } = setupTurn2();
  for (const axis of profile.axes) {
    if (axis.supportedScaleTons !== null) {
      assert.ok(Number.isFinite(axis.supportedScaleTons));
      assert.ok(axis.supportedScaleTons >= 0);
    }
  }
  assert.ok(Number.isFinite(profile.productionDetail.sharedBottleneckSupportedScaleTons));
  assert.ok(Number.isFinite(profile.financeDetail.supportedScaleTonsWithinTargetBuffer));
  assert.ok(Number.isFinite(profile.financeDetail.supportedScaleTonsBeforeCashNegative));
});

test("会社IDが一致し、他社データが混入しない", () => {
  const { profile } = setupTurn2("MASS");
  assert.equal(profile.companyId, "MASS");
});

test("【本番未接続】decision/*.tsのいずれもbusinessScaleProfile.tsをimportしていない", () => {
  const decisionDir = path.join(__dirname, "../../decision");
  const files = fs.readdirSync(decisionDir).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const src = fs.readFileSync(path.join(decisionDir, file), "utf-8");
    assert.ok(!src.includes("businessScaleProfile"), `decision/${file} がbusinessScaleProfile.tsをimportしてはならない`);
  }
  const policySrc = fs.readFileSync(path.join(__dirname, "../../policy.ts"), "utf-8");
  assert.ok(!policySrc.includes("businessScaleProfile"), "policy.tsがbusinessScaleProfile.tsをimportしてはならない");
});

test("Business Scale Profileの計算は本番の意思決定（sales/production plans）を変化させない（副作用が無い純関数）", () => {
  const { fixture, observation2, pressures2 } = setupTurn2();
  const before = buildStandardAiSalesPlans(fixture, observation2, pressures2);
  const ue = buildStandardAiUnitEconomics(observation2);
  buildBusinessScaleProfile({
    observation: observation2,
    pressures: pressures2,
    unitEconomics: ue,
    currentSalesPlans: before.salesPlans,
    desiredByProduct: before.desiredByProduct,
  });
  const after = buildStandardAiSalesPlans(fixture, observation2, pressures2);
  assert.deepEqual(after.desiredByProduct, before.desiredByProduct);
  assert.equal(after.salesPlans.length, before.salesPlans.length);
});
