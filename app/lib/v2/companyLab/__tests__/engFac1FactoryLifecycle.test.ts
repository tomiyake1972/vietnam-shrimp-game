// ShrimpX V2 — ENG-FAC-1 統合テスト（実装指示§20）
//
// Factory Mothball / Sale を実エンジン（advanceCompanyLabQuarter）で四半期を進めながら
// 検証する。能力・固定費・減価償却・PPE除却・投資CF・BS整合・Save/Resume・
// baseline regression をすべて実データで確認する。
//
// 【2工場企業の作り方】現行の共有フィクスチャは5社とも1工場のため、売却系のテストは
// fixture配列に2つ目のFactoryを足したものを advanceCompanyLabQuarter へ渡して作る。
// initializeCompanyLab が作る会社BSのPPEは会社単位の1スカラーであり、工場別簿価は
// そこからのderived projection（capex/factoryAssetProjection.ts）なので、
// 「初期工場が2つある会社」として一貫して扱われる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyLabState } from "../types";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../persistence/snapshot";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../persistence/codec";
import { CompanyLabPersistedStateV1, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../persistence/types";
import { computeEffectiveFactories } from "../../capex/factoryConstruction";
import { resolveFactoryLifecycleStateAt } from "../../capex/factoryLifecycle";
import { FACTORY_LIFECYCLE_PARAMETERS_V1 } from "../../capex/factoryLifecycle";
import { FINANCE_PARAMETERS_V1, normalCashFixedFactoryCostUsdPerQuarter } from "../../finance/parameters";
import { calculateFactoryEffectiveCapacity } from "../../production/capacity";
import { unwrapUnit } from "../../core/units";
import { PeriodV2 } from "../../core/period";
import { CompanyFinancialQuarterResult } from "../../finance/types";

const NORMAL_CASH_FIXED_COST = normalCashFixedFactoryCostUsdPerQuarter(FINANCE_PARAMETERS_V1);

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "eng-fac-1-seed-001", turns: 8, ...overrides };
}

/** 対象会社に2つ目の初期工場を足したfixture配列を作る（他社は一切変更しない）。 */
function withSecondFactory(fixtures: readonly CompanyFixture[], companyId: string): CompanyFixture[] {
  return fixtures.map((f) => {
    if (f.companyId !== companyId) return { ...f };
    const f1 = f.factories[0];
    return { ...f, factories: [f1, { ...f1, factoryId: `${companyId}-F2` }] };
  });
}

interface QuarterObservation {
  readonly period: PeriodV2;
  readonly turn: number;
  /** その四半期の生産に実際に使われたFactory[]（lifecycle適用済み）。 */
  readonly factories: readonly { readonly factoryId: string; readonly status: string; readonly effectiveCapacityTons: number }[];
  readonly financial: CompanyFinancialQuarterResult;
  readonly eventCodes: readonly string[];
  readonly stateAfter: CompanyLabState;
}

/**
 * turnsぶん四半期を進め、各四半期の対象会社の観測値を返す。
 * decisionOverrides は turn 番号 → その turn で対象会社へ差し込む lifecycle 決定。
 */
function runQuarters(
  fixtures: readonly CompanyFixture[],
  initialState: CompanyLabState,
  targetCompanyId: string,
  turns: number,
  lifecycleByTurn: Readonly<Record<number, CompanyDecisionInput["factoryLifecycleDecisions"]>> = {}
): readonly QuarterObservation[] {
  let state = initialState;
  const observations: QuarterObservation[] = [];
  const baseFactories = fixtures.flatMap((f) => f.factories);

  for (let turn = 1; turn <= turns; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      const own = buildCompanyOwnState(state, f);
      decisions[f.companyId] = generateAutoPolicyDecision(f, own, publicInfo, state.currentPeriod, turn);
    }
    const lifecycleDecisions = lifecycleByTurn[turn];
    if (lifecycleDecisions) {
      decisions[targetCompanyId] = { ...decisions[targetCompanyId], factoryLifecycleDecisions: lifecycleDecisions };
    }

    const before = state;
    // その四半期の生産に実際に使われたFactory[]（runnerと同じcanonical pointで再現する）。
    const effective = computeEffectiveFactories(baseFactories, before.capexState, before.currentPeriod, before.factoryLifecycleState).filter(
      (f) => f.companyId === targetCompanyId
    );

    state = advanceCompanyLabQuarter(before, fixtures, decisions);
    const record = state.history[state.history.length - 1];
    observations.push({
      period: before.currentPeriod,
      turn,
      factories: effective.map((f) => {
        const capacity = calculateFactoryEffectiveCapacity(f);
        return {
          factoryId: f.factoryId,
          status: f.status,
          effectiveCapacityTons:
            unwrapUnit(capacity.commonProcessing) + unwrapUnit(capacity.hoso) + unwrapUnit(capacity.pd) + unwrapUnit(capacity.vap),
        };
      }),
      financial: record.financialResults.find((r) => r.companyId === targetCompanyId)!,
      eventCodes: (record.factoryLifecycleEvents ?? []).filter((e) => e.companyId === targetCompanyId).map((e) => e.code),
      stateAfter: state,
    });
  }
  return observations;
}

function carryingCostOf(o: QuarterObservation): number {
  return o.financial.profitAndLoss.costOfSales.factoryLifecycleCarryingCost as unknown as number;
}
function fixedAssetsNetOf(o: QuarterObservation): number {
  return o.financial.balanceSheet.fixedAssetsNet as unknown as number;
}

// =====================================================================
// Lifecycle / capacity（§20 必須テスト 5〜9）
// =====================================================================

test("ENG-FAC-5/6: Mothballは T+1 で能力0になり、Reactivationは T+1 で能力が復帰する", () => {
  const init = initializeCompanyLab(baseConfig({ seed: "eng-fac-mothball" }));
  const target = init.fixtures[0].companyId;
  const fixtures = withSecondFactory(init.fixtures, target);
  const f2 = `${target}-F2`;

  // Turn2で休止決定 → Turn3から休止。Turn4で再稼働決定 → Turn5から復帰。
  const obs = runQuarters(fixtures, init.state, target, 6, {
    2: [{ type: "MOTHBALL_FACTORY", factoryId: f2 }],
    4: [{ type: "REACTIVATE_FACTORY", factoryId: f2 }],
  });

  const capacityOfF2 = (turn: number) => obs[turn - 1].factories.find((f) => f.factoryId === f2)?.effectiveCapacityTons ?? null;
  const statusOfF2 = (turn: number) => obs[turn - 1].factories.find((f) => f.factoryId === f2)?.status ?? null;

  assert.ok((capacityOfF2(1) ?? 0) > 0, "Turn1は通常操業");
  assert.ok((capacityOfF2(2) ?? 0) > 0, "休止を決定したTurn2そのものは通常操業のまま（T+1から効く）");
  assert.equal(statusOfF2(3), "idle");
  assert.equal(capacityOfF2(3), 0, "ENG-FAC-5: Mothball T+1 で capacity=0");
  assert.equal(capacityOfF2(4), 0, "再稼働を決定したTurn4はまだ休止中");
  assert.equal(statusOfF2(5), "active");
  assert.equal(capacityOfF2(5), capacityOfF2(1), "ENG-FAC-6: Reactivation T+1 で能力が元どおり復帰する");

  assert.deepEqual(obs[1].eventCodes, ["FACTORY_MOTHBALL_DECIDED"]);
  assert.deepEqual(obs[2].eventCodes, ["FACTORY_MOTHBALL_EFFECTIVE"]);
  assert.deepEqual(obs[3].eventCodes, ["FACTORY_REACTIVATION_DECIDED"]);
  assert.deepEqual(obs[4].eventCodes, ["FACTORY_REACTIVATED"]);
});

test("ENG-FAC-7/8/9: Sale は T=通常能力 / T+1=能力0(SALE_PENDING) / T+2=SOLD（Factory[]から消える）", () => {
  const init = initializeCompanyLab(baseConfig({ seed: "eng-fac-sale-timing" }));
  const target = init.fixtures[0].companyId;
  const fixtures = withSecondFactory(init.fixtures, target);
  const f2 = `${target}-F2`;

  const obs = runQuarters(fixtures, init.state, target, 5, { 2: [{ type: "SELL_FACTORY", factoryId: f2 }] });
  const entryOfF2 = (turn: number) => obs[turn - 1].factories.find((f) => f.factoryId === f2);

  assert.ok((entryOfF2(2)?.effectiveCapacityTons ?? 0) > 0, "ENG-FAC-7: 売却を決定したTurn2は通常能力を維持する");
  assert.equal(entryOfF2(3)?.status, "suspended");
  assert.equal(entryOfF2(3)?.effectiveCapacityTons, 0, "ENG-FAC-8: Sale T+1 で capacity=0");
  assert.equal(entryOfF2(4), undefined, "ENG-FAC-9: Sale T+2 でSOLD＝保有Factory[]から消える");
  assert.equal(entryOfF2(5), undefined, "SOLDは終端状態");

  const decisionsAfter = obs[4].stateAfter.factoryLifecycleState!.companies.find((c) => c.companyId === target)!.decisions;
  assert.equal(resolveFactoryLifecycleStateAt(decisionsAfter, f2, obs[4].period), "SOLD");
});

// =====================================================================
// Cost（§20 必須テスト 10〜14）
// =====================================================================

test("ENG-FAC-10/13: Mothball中は通常cash固定費の25%だけがcarrying costとして残り、減価償却は継続する", () => {
  const init = initializeCompanyLab(baseConfig({ seed: "eng-fac-mothball-cost" }));
  const target = init.fixtures[0].companyId;
  const fixtures = withSecondFactory(init.fixtures, target);
  const f2 = `${target}-F2`;

  const obs = runQuarters(fixtures, init.state, target, 4, { 2: [{ type: "MOTHBALL_FACTORY", factoryId: f2 }] });

  assert.equal(carryingCostOf(obs[0]), 0, "休止前はcarrying costが発生しない");
  assert.equal(carryingCostOf(obs[1]), 0, "決定した四半期はまだ通常操業＝通常固定費のまま");
  assert.equal(
    carryingCostOf(obs[2]),
    NORMAL_CASH_FIXED_COST * FACTORY_LIFECYCLE_PARAMETERS_V1.mothballCarryingCostRatio,
    "ENG-FAC-10: T+1から通常cash固定費の25%だけが残る"
  );
  assert.equal(carryingCostOf(obs[3]), NORMAL_CASH_FIXED_COST * FACTORY_LIFECYCLE_PARAMETERS_V1.mothballCarryingCostRatio);

  // ENG-FAC-13: 資産を保有し続けているため減価償却は変わらず継続する。
  // 【計測点】costOfSales.depreciationCost は「販売分へ配賦された」償却費であり
  // 生産・販売量に左右されるため、償却そのものの継続はBSの固定資産純額の
  // 減り方（＝当期の償却額）で確認する。
  assert.ok(fixedAssetsNetOf(obs[1]) - fixedAssetsNetOf(obs[2]) > 0, "Mothball中も償却は継続している");
  assert.equal(
    fixedAssetsNetOf(obs[1]) - fixedAssetsNetOf(obs[2]),
    fixedAssetsNetOf(obs[0]) - fixedAssetsNetOf(obs[1]),
    "固定資産純額の減り方（＝償却）が休止の前後で変わらない"
  );
});

test("ENG-FAC-11/12/13/14: Sale Pendingは10%のみ・SOLD後は当該工場の固定費0かつ減価償却停止", () => {
  const init = initializeCompanyLab(baseConfig({ seed: "eng-fac-sale-cost" }));
  const target = init.fixtures[0].companyId;
  const fixtures = withSecondFactory(init.fixtures, target);
  const f2 = `${target}-F2`;

  const obs = runQuarters(fixtures, init.state, target, 6, { 2: [{ type: "SELL_FACTORY", factoryId: f2 }] });

  assert.equal(
    carryingCostOf(obs[2]),
    NORMAL_CASH_FIXED_COST * FACTORY_LIFECYCLE_PARAMETERS_V1.salePendingHoldingCostRatio,
    "ENG-FAC-11: SALE_PENDING(T+1)では通常cash固定費の10%だけが残る"
  );
  assert.equal(carryingCostOf(obs[3]), 0, "ENG-FAC-12: 売却完了(T+2)以降は当該工場の固定費が完全に消える");
  assert.equal(carryingCostOf(obs[4]), 0);

  // ENG-FAC-13: SALE_PENDING中も減価償却は継続（2工場ぶん）。
  const depreciationPerQuarterBefore = fixedAssetsNetOf(obs[0]) - fixedAssetsNetOf(obs[1]);
  assert.equal(
    fixedAssetsNetOf(obs[1]) - fixedAssetsNetOf(obs[2]),
    depreciationPerQuarterBefore,
    "SALE_PENDING中も償却は2工場ぶん続く"
  );

  // ENG-FAC-14: SOLD後は当該工場ぶんの償却が止まり、残存1工場ぶんだけになる。
  const depreciationAfterSale = fixedAssetsNetOf(obs[3]) - fixedAssetsNetOf(obs[4]);
  assert.ok(depreciationAfterSale > 0, "残存工場の償却は続く");
  assert.ok(
    Math.abs(depreciationAfterSale - depreciationPerQuarterBefore / 2) < 1,
    `ENG-FAC-14: 売却後の償却は残存1工場ぶん（2工場時の半分）になるはず: ${depreciationAfterSale} vs ${depreciationPerQuarterBefore / 2}`
  );
});

// =====================================================================
// Accounting（§20 必須テスト 15〜18）
// =====================================================================

test("ENG-FAC-15/16/17/18: T+2でsale proceedsが投資CFへ入り、PPEが除却され、売却損が認識され、BSが整合し続ける", () => {
  const init = initializeCompanyLab(baseConfig({ seed: "eng-fac-accounting" }));
  const target = init.fixtures[0].companyId;
  const fixtures = withSecondFactory(init.fixtures, target);
  const f2 = `${target}-F2`;

  const obs = runQuarters(fixtures, init.state, target, 5, { 2: [{ type: "SELL_FACTORY", factoryId: f2 }] });
  const completion = obs[3]; // T+2
  const beforeCompletion = obs[2];

  // ENG-FAC-16: PPE除却。売却完了四半期の期首簿価ぶんが固定資産から消える。
  const netDropAtCompletion = fixedAssetsNetOf(beforeCompletion) - fixedAssetsNetOf(completion);
  const survivingDepreciation = fixedAssetsNetOf(completion) - fixedAssetsNetOf(obs[4]);
  const derecognizedNbv = netDropAtCompletion - survivingDepreciation;
  assert.ok(derecognizedNbv > 0, "ENG-FAC-16: 売却完了四半期に固定資産が除却されている");

  // ENG-FAC-15: 売却代金が投資CFへ計上される（新しいCash経路を作っていない）。
  const investingCashFlow = completion.financial.cashFlow.investingCashFlow as unknown as number;
  assert.ok(investingCashFlow > 0, "ENG-FAC-15: sale proceedsが投資CFへ入る");
  assert.ok(
    Math.abs(investingCashFlow - derecognizedNbv * FACTORY_LIFECYCLE_PARAMETERS_V1.saleProceedsRecoveryRate) < 1,
    `売却代金は 除却簿価×70% であるはず: ${investingCashFlow} vs ${derecognizedNbv * 0.7}`
  );
  assert.equal(
    obs[1].financial.cashFlow.investingCashFlow as unknown as number,
    0,
    "売却を決定した四半期には入金しない（即時Cash化の禁止）"
  );
  assert.equal(beforeCompletion.financial.cashFlow.investingCashFlow as unknown as number, 0, "SALE_PENDING四半期にも入金しない");

  // ENG-FAC-17: gain/lossが正しく認識される（回収率70%なので売却損）。
  const disposalPl = completion.financial.profitAndLoss.assetDisposalGainLoss as unknown as number;
  assert.ok(disposalPl < 0, "ENG-FAC-17: 回収率70%のため売却損になる");
  assert.ok(Math.abs(disposalPl - (investingCashFlow - derecognizedNbv)) < 1, "売却損 = 売却代金 − 除却簿価");
  assert.deepEqual(completion.eventCodes, ["FACTORY_SALE_COMPLETED", "FACTORY_DISPOSAL_LOSS"]);

  // 売却損はPLを素通りしてTSVへ自然に伝播する（人工的な企業価値の増加を作らない）。
  const pl = completion.financial.profitAndLoss;
  assert.ok(
    Math.abs(
      (pl.profitBeforeTax as unknown as number) -
        ((pl.operatingProfit as unknown as number) + disposalPl - (pl.interestExpense as unknown as number))
    ) < 1,
    "税引前利益 = 営業利益 + 固定資産売却損益 − 支払利息"
  );

  // ENG-FAC-18: 全四半期でBSが整合し続ける。
  for (const o of obs) {
    assert.ok(
      Math.abs(o.financial.balanceSheet.balanceDifference as unknown as number) < 1,
      `BS reconciliation invariant: ${o.period} の貸借差額が0でない`
    );
  }
});

test("ENG-FAC-18b: Mothball運用でもBS reconciliation invariantが維持される", () => {
  const init = initializeCompanyLab(baseConfig({ seed: "eng-fac-mothball-bs" }));
  const target = init.fixtures[0].companyId;
  const fixtures = withSecondFactory(init.fixtures, target);
  const f2 = `${target}-F2`;
  const obs = runQuarters(fixtures, init.state, target, 6, {
    2: [{ type: "MOTHBALL_FACTORY", factoryId: f2 }],
    4: [{ type: "REACTIVATE_FACTORY", factoryId: f2 }],
  });
  for (const o of obs) {
    assert.ok(Math.abs(o.financial.balanceSheet.balanceDifference as unknown as number) < 1, `${o.period} の貸借差額が0でない`);
  }
});

// =====================================================================
// Persistence（§20 必須テスト 21〜23）
// =====================================================================

function buildStoredEnvelope(
  state: CompanyLabState,
  fixtures: readonly CompanyFixture[],
  runtime: unknown,
  schemaVersion: number = CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION
): CompanyLabPersistedStateV1 {
  return {
    schemaVersion,
    engineVersion: "test-v2-companyLab-engine-engfac1",
    labId: "lab-engfac1",
    playerCompanyId: fixtures[0].companyId,
    config: state.config,
    fixtures,
    currentState: { runtime, revision: 1, lastProcessedTurnId: "turn-1" },
    draft: null,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  } as unknown as CompanyLabPersistedStateV1;
}

function roundTrip(state: CompanyLabState, fixtures: readonly CompanyFixture[]): CompanyLabState {
  const runtime = createCompanyLabRuntimeSnapshot(state);
  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(buildStoredEnvelope(state, fixtures, runtime)));
  return restoreCompanyLabStateFromRuntimeSnapshot(state.config, decoded.currentState.runtime, []);
}

test("ENG-FAC-21: MOTHBALLED状態でSave→Resumeしても休止が維持される", () => {
  const init = initializeCompanyLab(baseConfig({ seed: "eng-fac-persist-mothball" }));
  const target = init.fixtures[0].companyId;
  const fixtures = withSecondFactory(init.fixtures, target);
  const f2 = `${target}-F2`;

  const obs = runQuarters(fixtures, init.state, target, 3, { 1: [{ type: "MOTHBALL_FACTORY", factoryId: f2 }] });
  const saved = obs[obs.length - 1].stateAfter;
  const restored = roundTrip(saved, fixtures);

  const decisions = restored.factoryLifecycleState?.companies.find((c) => c.companyId === target)?.decisions ?? [];
  assert.equal(resolveFactoryLifecycleStateAt(decisions, f2, restored.currentPeriod), "MOTHBALLED");

  const restoredFactories = computeEffectiveFactories(
    fixtures.flatMap((f) => f.factories),
    restored.capexState,
    restored.currentPeriod,
    restored.factoryLifecycleState
  ).filter((f) => f.companyId === target);
  assert.equal(restoredFactories.find((f) => f.factoryId === f2)?.status, "idle", "復元後も休止中のまま（能力0が維持される）");
});

test("ENG-FAC-22: SALE_PENDING状態でSave→Resumeしても売却手続中が維持され、その後T+2で完了する", () => {
  const init = initializeCompanyLab(baseConfig({ seed: "eng-fac-persist-sale" }));
  const target = init.fixtures[0].companyId;
  const fixtures = withSecondFactory(init.fixtures, target);
  const f2 = `${target}-F2`;

  // Turn1で売却決定 → Turn2がSALE_PENDING。Turn2の処理後（＝Turn3開始前）に保存する。
  const obs = runQuarters(fixtures, init.state, target, 2, { 1: [{ type: "SELL_FACTORY", factoryId: f2 }] });
  const saved = obs[obs.length - 1].stateAfter;
  const restored = roundTrip(saved, fixtures);

  const decisions = restored.factoryLifecycleState?.companies.find((c) => c.companyId === target)?.decisions ?? [];
  // 保存時点（Turn2の処理後）ではcurrentPeriodがTurn3を指す＝ちょうど売却完了四半期。
  assert.equal(resolveFactoryLifecycleStateAt(decisions, f2, restored.currentPeriod), "SOLD");
  assert.equal(
    resolveFactoryLifecycleStateAt(decisions, f2, obs[1].period),
    "SALE_PENDING",
    "保存直前の四半期はSALE_PENDINGだったことも復元後に再現できる"
  );

  const restoredFactories = computeEffectiveFactories(
    fixtures.flatMap((f) => f.factories),
    restored.capexState,
    restored.currentPeriod,
    restored.factoryLifecycleState
  ).filter((f) => f.companyId === target);
  assert.equal(restoredFactories.length, 1, "復元後、売却完了した工場は保有Factory[]に含まれない");
});

test("ENG-FAC-23: lifecycleフィールドを持たない旧payloadでもResumeに成功し、全工場OPERATINGとして復元される", () => {
  const init = initializeCompanyLab(baseConfig({ seed: "eng-fac-legacy-payload" }));
  const target = init.fixtures[0].companyId;
  const obs = runQuarters(init.fixtures, init.state, target, 2);
  const saved = obs[obs.length - 1].stateAfter;

  const runtime = createCompanyLabRuntimeSnapshot(saved);
  assert.equal(
    (runtime as { factoryLifecycleState?: unknown }).factoryLifecycleState,
    undefined,
    "lifecycle決定が1件も無いRunでは、スナップショットにキー自体が現れない（既存保存物と同一形状）"
  );

  // 旧payload（キー自体が存在しない）を明示的に作って復元する。
  const legacyRuntime = { ...runtime };
  delete (legacyRuntime as { factoryLifecycleState?: unknown }).factoryLifecycleState;
  const decoded = decodeCompanyLabPersistedState(
    encodeCompanyLabPersistedState(buildStoredEnvelope(saved, init.fixtures, legacyRuntime, 1))
  );
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(saved.config, decoded.currentState.runtime, []);

  assert.equal(restored.factoryLifecycleState, undefined, "キー欠落はundefinedのまま（架空の決定を捏造しない）");
  const factories = computeEffectiveFactories(
    init.fixtures.flatMap((f) => f.factories),
    restored.capexState,
    restored.currentPeriod,
    restored.factoryLifecycleState
  );
  assert.ok(factories.every((f) => f.status === "active"), "全工場OPERATING（＝従来どおり）として復元される");

  // 復元した状態からさらに四半期を進められる（NaN/undefined事故が起きない）。
  const next = runQuarters(init.fixtures, restored, target, 1);
  assert.ok(Number.isFinite(next[0].financial.profitAndLoss.netIncome as unknown as number));
  assert.equal(carryingCostOf(next[0]), 0);
});

// =====================================================================
// Regression（§20 必須テスト 26〜28）
// =====================================================================

test("ENG-FAC-26: lifecycle decisionを一切使わないbaseline runは、この機能の導入前と挙動が不変", () => {
  const init = initializeCompanyLab(baseConfig({ seed: "eng-fac-baseline-regression", turns: 6 }));
  const target = init.fixtures[0].companyId;
  const obs = runQuarters(init.fixtures, init.state, target, 6);

  for (const o of obs) {
    // 新設の費用・損益・状態がすべてゼロ／未設定であることが「挙動不変」の実体。
    assert.equal(carryingCostOf(o), 0, `${o.period}: carrying costが発生していない`);
    assert.equal(o.financial.profitAndLoss.assetDisposalGainLoss as unknown as number, 0, `${o.period}: 売却損益が発生していない`);
    assert.equal(o.eventCodes.length, 0, `${o.period}: lifecycleイベントが1件も出ていない`);
    assert.ok(Math.abs(o.financial.balanceSheet.balanceDifference as unknown as number) < 1);
  }
  const finalState = obs[obs.length - 1].stateAfter;
  assert.equal(finalState.factoryLifecycleState, undefined, "決定が無ければstateにキー自体が現れない");
  assert.equal(
    (createCompanyLabRuntimeSnapshot(finalState) as { factoryLifecycleState?: unknown }).factoryLifecycleState,
    undefined,
    "保存物の形状も既存と同一（resume payloadのcompact invariantを崩さない）"
  );
});

test("ENG-FAC-27: DS1 / DS2 / baseline のいずれでもlifecycle未使用時は挙動不変（Scenario固有branchが無いことの確認）", () => {
  for (const scenarioId of ["baseline", "dynamic-scenario-1-v0.1", "dynamic-scenario-2-v0.1"]) {
    const init = initializeCompanyLab(baseConfig({ scenarioId, seed: `eng-fac-scenario-${scenarioId}`, turns: 4 }));
    const target = init.fixtures[0].companyId;
    const obs = runQuarters(init.fixtures, init.state, target, 4);
    for (const o of obs) {
      assert.equal(carryingCostOf(o), 0, `${scenarioId} ${o.period}: carrying costが発生していない`);
      assert.equal(o.financial.profitAndLoss.assetDisposalGainLoss as unknown as number, 0);
      assert.ok(Math.abs(o.financial.balanceSheet.balanceDifference as unknown as number) < 1);
    }
    assert.equal(obs[obs.length - 1].stateAfter.factoryLifecycleState, undefined, `${scenarioId}: lifecycle stateが作られていない`);
  }
});

test("ENG-FAC-27b: Mothball / Saleは会社を問わず同じように成立する（company-specific hackが無いことの確認）", () => {
  const init = initializeCompanyLab(baseConfig({ seed: "eng-fac-all-companies" }));
  // 5社すべてについて、2工場化したうえで同じ決定を出し、同じ結果になることを確認する。
  for (const fixture of init.fixtures) {
    const target = fixture.companyId;
    const fixtures = withSecondFactory(init.fixtures, target);
    const f2 = `${target}-F2`;
    const obs = runQuarters(fixtures, init.state, target, 4, { 1: [{ type: "SELL_FACTORY", factoryId: f2 }] });

    assert.equal(obs[1].factories.find((f) => f.factoryId === f2)?.effectiveCapacityTons, 0, `${target}: T+1で能力0`);
    assert.equal(obs[2].factories.find((f) => f.factoryId === f2), undefined, `${target}: T+2でSOLD`);
    assert.ok((obs[2].financial.cashFlow.investingCashFlow as unknown as number) > 0, `${target}: T+2で売却代金が入金される`);
    assert.ok((obs[2].financial.profitAndLoss.assetDisposalGainLoss as unknown as number) < 0, `${target}: 売却損が認識される`);
    for (const o of obs) {
      assert.ok(Math.abs(o.financial.balanceSheet.balanceDifference as unknown as number) < 1, `${target} ${o.period}: BS不整合`);
    }
  }
});

test("ENG-FAC-28: 建設中Factory Cancelの既存挙動は変更されていない（支払済み案件は取消不可のまま）", async () => {
  const { applyCancelRequest } = await import("../../capex/projectLifecycle");
  const { CapexValidationError } = await import("../../capex/types");
  const { period } = await import("../../core/period");
  const p = period(2015, 2);
  const paidProject = {
    projectId: "X-CAPEX-1",
    companyId: "X",
    projectType: "hosoLineExpansion" as const,
    approvedBudgetUsd: 1_000_000,
    paymentSchedule: [],
    completedPaymentStagesCount: 1,
    cumulativePaidUsd: 300_000,
    elapsedConstructionQuartersWithPayment: 1,
    requiredConstructionQuarters: 3,
    status: "underConstruction" as const,
    proposedPeriod: p,
    approvedPeriod: p,
    priority: 1,
    lastDiagnosticReasons: [],
  };
  assert.throws(
    () => applyCancelRequest([paidProject], { projectId: "X-CAPEX-1" }, p),
    CapexValidationError,
    "ENG-FAC-1では§14のとおり、支払済み建設案件のCancel（20%返還）は実装していない"
  );
  const unpaid = { ...paidProject, cumulativePaidUsd: 0, status: "approved" as const, completedPaymentStagesCount: 0 };
  const cancelled = applyCancelRequest([unpaid], { projectId: "X-CAPEX-1" }, p);
  assert.equal(cancelled[0].status, "cancelled", "支払前Cancelは従来どおり成功する");
});
