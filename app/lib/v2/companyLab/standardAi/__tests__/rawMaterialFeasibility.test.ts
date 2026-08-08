// ShrimpX V2 — SAI-T1: 生産計画の原料調達可能性ガードの回帰テスト
//
// 【背景】Training Harness baseline（32Q×10seed）で、資金が枯渇したMASSが
// 原料在庫0のまま29,070トンの生産計画を立て続け、その架空の計画から逆算した
// 必要人員を根拠に「worker_shortage」と自己診断し、常用2,100人・臨時735人を
// 20四半期保持したまま生産量0を続けた（遊休労務費が資金枯渇をさらに悪化させる
// 正のフィードバック）。decision/production.ts は設備能力と販売需要だけで
// 生産計画を決めており、「その原料を実際に入手できるか」を一切見ていなかった。
//
// 【このテストが固定する性質】
//   1. 資金・原料ともに枯渇した会社は、入手不能な量の生産計画を立てない。
//   2. 資金・原料に余裕のある会社の計画は、このガードによって縮まない
//      （＝健全な会社の挙動を巻き添えにしない）。
//   3. 縮小したときは必ず理由コードで説明される（沈黙して縮めない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { usd } from "../../../finance/types";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateStandardAiDecision, generateStandardAiDecisionWithDiagnostics } from "../policy";
import { CompanyDecisionInput, CompanyLabConfig, CompanyOwnState } from "../../types";

function config(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "sai-t1-raw-feasibility-001", turns: 8, ...overrides };
}

/**
 * 前四半期の市場結果（＝国内参考価格）が観測に存在する状態を作る。turn1では
 * vietnamDomesticPriorPriceが未観測となり、このガードは意図的に無効なので、
 * 1四半期進めてから評価する。
 */
function setupAfterFirstQuarter(companyId: string) {
  const { state, fixtures } = initializeCompanyLab(config());
  const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    decisionsByCompanyId[f.companyId] = generateStandardAiDecision(
      f,
      buildCompanyOwnState(state, f),
      buildPublicMarketInfo(state),
      state.currentPeriod,
      1
    );
  }
  const advanced = advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  return {
    fixture,
    ownState: buildCompanyOwnState(advanced, fixture),
    publicInfo: buildPublicMarketInfo(advanced),
    period: advanced.currentPeriod,
    turn: 2,
  };
}

/** turn1相当（前四半期の市場結果が存在しない＝国内参考価格が未観測）の状態。 */
function setupTurn1(companyId: string) {
  const { state, fixtures } = initializeCompanyLab(config());
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  return {
    fixture,
    ownState: buildCompanyOwnState(state, fixture),
    publicInfo: buildPublicMarketInfo(state),
    period: state.currentPeriod,
    turn: 1,
  };
}

/** 資金も原料も枯渇した状態（Training Harnessで実際に観測されたMASSの状態）を作る。 */
function starved(ownState: CompanyOwnState): CompanyOwnState {
  return {
    ...ownState,
    rawMaterialLots: [],
    financeState: {
      ...ownState.financeState,
      cash: usd(0),
      receivables: [],
      payables: [],
    },
  };
}

test("SAI-T1: 資金・原料ともに枯渇した会社は、入手不能な規模の生産計画を立てない", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupAfterFirstQuarter("MASS");
  const healthy = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const broke = generateStandardAiDecisionWithDiagnostics(fixture, starved(ownState), publicInfo, period, turn);

  const total = (d: typeof healthy) => d.decision.productionPlans.reduce((s, p) => s + Number(p.desiredQuantity), 0);
  const healthyTotal = total(healthy);
  const brokeTotal = total(broke);

  assert.ok(healthyTotal > 0, "前提: 通常状態では正の生産計画が立つ");
  assert.ok(
    brokeTotal < healthyTotal,
    `資金・原料が枯渇した状態の生産計画（${brokeTotal.toFixed(1)}t）は、通常状態（${healthyTotal.toFixed(1)}t）より小さくなければならない`
  );
});

test("SAI-T1: 生産計画を縮小したときは必ず理由コードで説明する（沈黙して縮めない）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupAfterFirstQuarter("MASS");
  const broke = generateStandardAiDecisionWithDiagnostics(fixture, starved(ownState), publicInfo, period, turn);
  const codes = broke.diagnostics.entries.map((d) => d.code);
  assert.ok(
    codes.includes("PRODUCTION_LIMITED_BY_RAW_MATERIAL_FEASIBILITY"),
    `縮小理由コードが出力されていない（出力されたコード: ${codes.join(", ")}）`
  );
});

test("SAI-T1: 資金・原料に余裕のある会社の生産計画は、このガードで縮まない", () => {
  for (const companyId of ["BAL", "CONSV", "JPQ"]) {
    const { fixture, ownState, publicInfo, period, turn } = setupAfterFirstQuarter(companyId);
    const result = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
    const codes = result.diagnostics.entries.map((d) => d.code);
    assert.ok(
      !codes.includes("PRODUCTION_LIMITED_BY_RAW_MATERIAL_FEASIBILITY"),
      `${companyId}: 初期状態（資金・原料に余裕あり）でガードが発火してはならない`
    );
  }
});

test("SAI-T1: turn1（国内参考価格が未観測）ではガードを適用しない（観測に無い値で判断しない）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupTurn1("MASS");
  const result = generateStandardAiDecisionWithDiagnostics(fixture, starved(ownState), publicInfo, period, turn);
  const codes = result.diagnostics.entries.map((d) => d.code);
  assert.ok(
    !codes.includes("PRODUCTION_LIMITED_BY_RAW_MATERIAL_FEASIBILITY"),
    "参考価格が観測できないturn1では、原料調達可能性を推測して計画を縮めてはならない"
  );
});
