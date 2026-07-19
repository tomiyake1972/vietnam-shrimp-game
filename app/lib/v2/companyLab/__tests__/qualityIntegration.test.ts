// ShrimpX V2 — Phase 7A 会社ラボ統合テスト（品質・顧客信頼・納期信頼性）
//
// 対応する受入条件:
//   20. 前期の品質・信頼・納期だけが次期成約へ影響する（今期の品質結果を今期の
//       成約へ遡及適用しない）
//   24. 全スコア・比率・数量が有限かつ範囲内
//   25. 5シナリオ×canonical/variation×32ターン完走
//   26. 同一シードの完全再現性
//   27（一部）: 既存の会社ラボ回帰確認（runner.test.tsの既存テストが本ファイルの
//       追加によって壊れていないことは`npm test`で確認する）

import { test } from "node:test";
import assert from "node:assert/strict";
import { score0to100, unwrapUnit } from "../../core/units";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab, runCompanyLabWithAutoPolicyForAllCompanies } from "../runner";
import { CompanyLabConfig, CompanyLabState } from "../types";

const EPSILON = 1e-6;
const ALL_SCENARIOS = [
  "baseline-v0.1",
  "global-demand-boom-v0.1",
  "ecuador-early-expansion-v0.1",
  "ecuador-delayed-expansion-v0.1",
  "global-disease-crisis-v0.1",
];

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed: "quality-integration-001", turns: 8, ...overrides };
}

function runAllAuto(config: CompanyLabConfig) {
  return runCompanyLabWithAutoPolicyForAllCompanies(config, generateAutoPolicyDecision);
}

// --- 20: 前期の品質・信頼・納期だけが次期成約へ影響する ---

test("20: buildCompanyOwnStateはstate.qualityState（当期処理前=前期末時点の状態）をそのまま返す", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];

  // 初期状態（まだ1ターンも進んでいない）では、baselineOperationalQuality・neutralScoreの
  // はず。ここへ意図的に非中立な値を注入し、buildCompanyOwnStateがその値をそのまま
  // 返すこと（当期分の再計算をしないこと）を確認する。
  const injectedState: CompanyLabState = {
    ...state,
    qualityState: {
      qualityByCompanyProduct: state.qualityState.qualityByCompanyProduct.map((s) =>
        s.companyId === fixture.companyId && s.product === "hoso" ? { ...s, qualityScore: score0to100(33.3) } : s
      ),
      trustByCompanyMarket: state.qualityState.trustByCompanyMarket,
      rampHistory: state.qualityState.rampHistory,
    },
  };

  const ownState = buildCompanyOwnState(injectedState, fixture);
  assert.equal(unwrapUnit(ownState.qualityScoreByProduct.hoso!), 33.3, "buildCompanyOwnStateはstate.qualityStateの値をそのまま(再計算せず)使う");
});

test("20b: turn2の意思決定に使われるownStateは、turn1終了時点(qualityStateAfter)の値と厳密に一致し、turn2自身のqualityStateAfterとは異なりうる（1ターン遅れて反映される）", () => {
  // runCompanyLabWithAutoPolicyForAllCompaniesの内部ループ（buildCompanyOwnState→
  // decisionProvider→advanceCompanyLabQuarterの順）を、本テストでも手動で1ステップずつ
  // 再現し、「turn2の意思決定生成時に実際に渡されるownState」を直接捕捉する。
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig({ turns: 3 }));
  const fixture = fixtures[0];

  // turn1: 意思決定→適用
  const publicInfo1 = buildPublicMarketInfo(state0);
  const decisions1: Record<string, ReturnType<typeof generateAutoPolicyDecision>> = {};
  for (const f of fixtures) {
    decisions1[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state0, f), publicInfo1, state0.currentPeriod, state0.scenarioState.currentTurn);
  }
  const state1 = advanceCompanyLabQuarter(state0, fixtures, decisions1);

  // turn2の意思決定生成時に実際に使われるownStateを直接捕捉する。
  const ownStateForTurn2 = buildCompanyOwnState(state1, fixture);

  // 捕捉したownStateは、turn1完了直後のqualityStateAfter(=state1.qualityState)と厳密に一致する。
  for (const [product, score] of Object.entries(ownStateForTurn2.qualityScoreByProduct)) {
    const expected = state1.qualityState.qualityByCompanyProduct.find((s) => s.companyId === fixture.companyId && s.product === product);
    assert.ok(expected);
    assert.equal(unwrapUnit(score!), unwrapUnit(expected!.qualityScore), `product=${product}: turn2のownStateはturn1終了時点の値と一致するはず`);
  }

  // turn2を実際に進め、turn2終了時点のqualityStateAfterを取得する。
  const publicInfo2 = buildPublicMarketInfo(state1);
  const decisions2: Record<string, ReturnType<typeof generateAutoPolicyDecision>> = {};
  for (const f of fixtures) {
    decisions2[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state1, f), publicInfo2, state1.currentPeriod, state1.scenarioState.currentTurn);
  }
  const state2 = advanceCompanyLabQuarter(state1, fixtures, decisions2);

  // turn2で実際に生産があった商品は品質スコアが更新されるため、ownStateForTurn2
  // （turn1終了時点）とstate2.qualityState（turn2終了時点）は、生産があった商品については
  // 一般に異なる値になる（「今期の品質結果を今期の成約へ遡及適用しない」の直接証拠——
  // turn2の成約に使われたのはstate1由来の値であり、state2由来の値ではない）。
  let foundDifference = false;
  for (const s of state2.qualityState.qualityByCompanyProduct) {
    if (s.companyId !== fixture.companyId) continue;
    const before = ownStateForTurn2.qualityScoreByProduct[s.product];
    if (before !== undefined && Math.abs(unwrapUnit(before) - unwrapUnit(s.qualityScore)) > 1e-6) {
      foundDifference = true;
    }
  }
  assert.ok(foundDifference, "turn2で生産・更新があった商品では、turn1終了時点の値とturn2終了時点の値が異なるはず（品質は毎期更新されている）");
});

// --- 24: 全スコア・比率・数量が有限かつ範囲内 ---

test("24: すべてのスコア・比率・数量が有限であり、期待される範囲に収まる（重大事故を誘発しやすい高負荷シードを含む）", () => {
  for (const seed of ["range-check-001", "range-check-002", "range-check-003"]) {
    const result = runAllAuto(baseConfig({ seed, turns: 16 }));
    for (const record of result.history) {
      for (const adj of record.qualityAdjustments) {
        for (const v of [
          adj.risk.utilizationStress,
          adj.risk.overtimeStress,
          adj.risk.temporaryWorkerStress,
          adj.risk.complexityStress,
          adj.risk.rawMaterialAgeStress,
          adj.risk.productionRampStress,
          adj.risk.operationalRisk,
        ]) {
          assert.ok(Number.isFinite(v) && v >= -EPSILON && v <= 1 + EPSILON, `risk factor out of range: ${v}`);
        }
        assert.ok(Number.isFinite(adj.outcome.nonConformanceRatio) && adj.outcome.nonConformanceRatio >= 0);
        assert.ok(Number.isFinite(adj.outcome.discardRatio) && adj.outcome.discardRatio >= 0);
        const saleable = unwrapUnit(adj.outcome.saleableRecoveryRatio);
        assert.ok(Number.isFinite(saleable) && saleable >= 0.9 - 1e-6 && saleable <= 1 + 1e-6, `saleableRecoveryRatio out of range: ${saleable}`);
        const observedQuality = unwrapUnit(adj.outcome.observedQualityScore);
        assert.ok(Number.isFinite(observedQuality) && observedQuality >= 0 && observedQuality <= 100);
        assert.ok(Number.isFinite(adj.outcome.majorIncident.severity) && adj.outcome.majorIncident.severity >= 0 && adj.outcome.majorIncident.severity <= 1);
        assert.ok(unwrapUnit(adj.adjustedFinishedGoodsQuantity) >= -EPSILON);
        assert.ok(unwrapUnit(adj.adjustedFinishedGoodsQuantity) <= unwrapUnit(adj.originalFinishedGoodsQuantity) + EPSILON);
        assert.ok(unwrapUnit(adj.discardQuantity) >= -EPSILON);
      }
      for (const s of record.companySummaries) {
        for (const v of Object.values(s.qualityScoreByProduct)) {
          if (v === undefined) continue;
          assert.ok(Number.isFinite(unwrapUnit(v)) && unwrapUnit(v) >= 0 && unwrapUnit(v) <= 100);
        }
        for (const v of Object.values(s.customerTrustByMarket)) {
          if (v === undefined) continue;
          assert.ok(Number.isFinite(unwrapUnit(v)) && unwrapUnit(v) >= 0 && unwrapUnit(v) <= 100);
        }
        for (const v of Object.values(s.deliveryReliabilityByMarket)) {
          if (v === undefined) continue;
          assert.ok(Number.isFinite(unwrapUnit(v)) && unwrapUnit(v) >= 0 && unwrapUnit(v) <= 100);
        }
        assert.ok(unwrapUnit(s.downgradeQuantity) >= -EPSILON);
        assert.ok(unwrapUnit(s.reworkQuantity) >= -EPSILON);
        assert.ok(unwrapUnit(s.discardQuantity) >= -EPSILON);
        assert.ok(Number.isFinite(s.majorIncidentCount) && s.majorIncidentCount >= 0);
        if (s.onTimeDeliveryRate !== undefined) {
          assert.ok(Number.isFinite(s.onTimeDeliveryRate) && s.onTimeDeliveryRate >= -1e-6 && s.onTimeDeliveryRate <= 100 + 1e-6);
        }
      }
      for (const lot of record.newFinishedGoodsLots) {
        if (!lot.qualityInfo) continue;
        assert.ok(Number.isFinite(unwrapUnit(lot.qualityInfo.qualityScore)));
        assert.ok(Number.isFinite(unwrapUnit(lot.qualityInfo.downgradeRatio)));
      }
    }
  }
});

// --- 25: 5シナリオ×canonical/variation×32ターン完走 ---

test("25: 5シナリオ × canonical/variation × 32ターンをすべて完走する", () => {
  for (const scenarioId of ALL_SCENARIOS) {
    for (const mode of ["canonical", "variation"] as const) {
      const result = runAllAuto(baseConfig({ scenarioId, mode, seed: `sweep-${scenarioId}-${mode}`, turns: 32 }));
      assert.equal(result.history.length, 32, `${scenarioId}/${mode}`);
      assert.equal(result.companies.length, 5, `${scenarioId}/${mode}`);
      // 品質状態が最終ターンまで蓄積されている(空でない)ことを確認する。
      const lastRecord = result.history[result.history.length - 1];
      assert.ok(lastRecord.qualityStateAfter.qualityByCompanyProduct.length > 0, `${scenarioId}/${mode}`);
      assert.ok(lastRecord.qualityStateAfter.trustByCompanyMarket.length > 0, `${scenarioId}/${mode}`);
    }
  }
});

// --- 26: 同一シードの完全再現性 ---

test("26: 同一シード・同一設定・同一意思決定であれば品質・信頼・納期を含め完全に同じ結果になる", () => {
  const resultA = runAllAuto(baseConfig({ seed: "quality-determinism-001", turns: 12 }));
  const resultB = runAllAuto(baseConfig({ seed: "quality-determinism-001", turns: 12 }));
  assert.equal(JSON.stringify(resultA.history), JSON.stringify(resultB.history));

  // qualityAdjustments・qualityStateAfterも個別に明示的に比較する（JSON全体一致だけに
  // 頼らず、品質関連フィールドが確実に含まれていることを確認する）。
  for (let i = 0; i < resultA.history.length; i++) {
    assert.deepEqual(resultA.history[i].qualityAdjustments, resultB.history[i].qualityAdjustments, `turn=${i + 1}`);
    assert.deepEqual(resultA.history[i].qualityStateAfter, resultB.history[i].qualityStateAfter, `turn=${i + 1}`);
  }
});

test("26b: 重大事故が発生しうる高負荷シードでも決定論性が保たれる", () => {
  const resultA = runAllAuto(baseConfig({ seed: "quality-determinism-incident-001", turns: 20 }));
  const resultB = runAllAuto(baseConfig({ seed: "quality-determinism-incident-001", turns: 20 }));
  assert.equal(JSON.stringify(resultA.history), JSON.stringify(resultB.history));
});

// --- 補足: 少なくとも1件は重大事故が発生する実行が存在することを確認する（構造として機能していること） ---

test("十分な数のシード・ターンを試せば、少なくとも1件は重大事故が発生する（構造上機能していることの確認）", () => {
  let foundIncident = false;
  for (let i = 0; i < 20 && !foundIncident; i++) {
    const result = runAllAuto(baseConfig({ seed: `incident-search-${i}`, turns: 32 }));
    for (const record of result.history) {
      if (record.qualityAdjustments.some((a) => a.outcome.majorIncident.occurred)) {
        foundIncident = true;
        break;
      }
    }
  }
  assert.ok(foundIncident, "20シード×32ターンの範囲で重大事故が1件も発生しなかった（確率設定または配線に問題がある可能性）");
});
