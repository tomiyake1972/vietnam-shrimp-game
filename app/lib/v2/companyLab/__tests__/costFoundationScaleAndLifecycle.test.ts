// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1 受入前修正1:
// 規模の経済・工場状態の「動的」テスト
//
// 【このファイルが既存テストと違う点】
// financeParametersForTurn.test.ts は FinanceParameters の乗算・キー・型だけを見る
// 静的テストであり、costFoundationRegression.test.ts は指数1.00（中立）での
// 非回帰しか見ていない。ここでは実エンジン（advanceCompanyLabQuarter）で四半期を
// 進め、finance / capex / factory lifecycle の正規計算経路を通した実測値で
//   ・工場数と稼働率が単位固定費へどう効くか
//   ・factoryFixed 指数を適用しても会社間の順位が保たれるか
//   ・mothball / sale pending / 売却完了が指数適用下でも仕様どおり動くか
// を検証する。すべて Turn 経過を含む状態遷移として確認する。
//
// 【工場数の作り方】新しい fixture ファイルは作らない。既存 baseline fixture の
// 1社に対して、同一スペックの2つ目の工場を配列へ足したものを
// advanceCompanyLabQuarter へ渡す（engFac1FactoryLifecycle.test.ts と同じ方式）。

import test from "node:test";
import assert from "node:assert/strict";

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyLabState } from "../types";
import { computeEffectiveFactories } from "../../capex/factoryConstruction";
import { calculateFactoryEffectiveCapacity } from "../../production/capacity";
import { FACTORY_LIFECYCLE_PARAMETERS_V1 } from "../../capex/factoryLifecycle";
import { FINANCE_PARAMETERS_V1, normalCashFixedFactoryCostUsdPerQuarter } from "../../finance/parameters";
import { resolveOperatingCostIndex } from "../../scenario/costIndex";
import { ScenarioDefinition } from "../../scenario/types";
import { unwrapUnit } from "../../core/units";

const NORMAL_CASH_FIXED_COST = normalCashFixedFactoryCostUsdPerQuarter(FINANCE_PARAMETERS_V1);
const TARGET = "BAL";
const SECOND_FACTORY_ID = `${TARGET}-F2`;

function baseConfig(): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "cost-foundation-scale-001", turns: 8 };
}

/** 対象会社に同一スペックの2つ目の工場を足す（他社は一切変更しない）。 */
function withSecondFactory(fixtures: readonly CompanyFixture[], companyId: string): CompanyFixture[] {
  return fixtures.map((f) => {
    if (f.companyId !== companyId) return { ...f };
    const first = f.factories[0];
    return { ...f, factories: [first, { ...first, factoryId: SECOND_FACTORY_ID }] };
  });
}

/** factoryFixed 指数だけを宣言したシナリオ定義（既存Scenario正本は変更しない）。 */
function withFactoryFixedIndex(definition: ScenarioDefinition, value: number): ScenarioDefinition {
  return {
    ...definition,
    operatingCostInflation: {
      settingsId: `scale-test-factoryFixed-${value}`,
      tracks: {
        factoryFixed: { interpolation: "step", keyframes: [{ turn: 1, value }, { turn: 99, value }] },
      },
    },
  };
}

interface Observation {
  readonly turn: number;
  readonly factoryCount: number;
  readonly statuses: readonly string[];
  readonly producedTons: number;
  readonly equipmentUtilization: number;
  /** 稼働率の分母と同じ能力（production/loadMetrics.ts が使う commonProcessing）の会社合計。 */
  readonly processingCapacityTons: number;
  /** Engine公式の固定製造費（正社員労務費＋工場固定費＋固定ユーティリティ＋減価償却）。 */
  readonly fixedManufacturingCost: number;
  readonly carryingCost: number;
  readonly eventCodes: readonly string[];
}

/** 実エンジンで turns 四半期進め、対象会社の観測値を返す。 */
function run(
  fixtures: readonly CompanyFixture[],
  initialState: CompanyLabState,
  turns: number,
  options: {
    readonly factoryFixedIndex?: number;
    readonly lifecycleByTurn?: Readonly<Record<number, CompanyDecisionInput["factoryLifecycleDecisions"]>>;
  } = {}
): readonly Observation[] {
  let state = initialState;
  if (options.factoryFixedIndex !== undefined) {
    state = {
      ...state,
      scenarioState: {
        ...state.scenarioState,
        definition: withFactoryFixedIndex(state.scenarioState.definition, options.factoryFixedIndex),
      },
    } as CompanyLabState;
  }
  const baseFactories = fixtures.flatMap((f) => f.factories);
  const observations: Observation[] = [];

  for (let turn = 1; turn <= turns; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      decisions[f.companyId] = generateAutoPolicyDecision(
        f,
        buildCompanyOwnState(state, f),
        publicInfo,
        state.currentPeriod,
        turn
      );
    }
    const lifecycle = options.lifecycleByTurn?.[turn];
    if (lifecycle) decisions[TARGET] = { ...decisions[TARGET], factoryLifecycleDecisions: lifecycle };

    const before = state;
    // その四半期の生産に実際に使われたFactory[]（runnerと同じ導出点）。
    const effective = computeEffectiveFactories(
      baseFactories,
      before.capexState,
      before.currentPeriod,
      before.factoryLifecycleState
    ).filter((f) => f.companyId === TARGET);

    state = advanceCompanyLabQuarter(before, fixtures, decisions);
    const record = state.history[state.history.length - 1];
    const summary = record.companySummaries.find((s) => s.companyId === TARGET)!;
    const financial = record.financialResults.find((r) => r.companyId === TARGET)!;

    observations.push({
      turn,
      factoryCount: effective.length,
      statuses: effective.map((f) => f.status),
      producedTons:
        unwrapUnit(summary.hosoProduced) + unwrapUnit(summary.pdProduced) + unwrapUnit(summary.vapProduced),
      equipmentUtilization: unwrapUnit(summary.equipmentUtilizationRate),
      processingCapacityTons: effective.reduce(
        (sum, f) => sum + unwrapUnit(calculateFactoryEffectiveCapacity(f).commonProcessing),
        0
      ),
      fixedManufacturingCost: Number(financial.contributionMargin.fixedManufacturingCost),
      carryingCost: Number(
        (financial.profitAndLoss.costOfSales as unknown as { factoryLifecycleCarryingCost: number })
          .factoryLifecycleCarryingCost ?? 0
      ),
      eventCodes: (record.factoryLifecycleEvents ?? [])
        .filter((e) => e.companyId === TARGET)
        .map((e) => e.code),
    });
  }
  return observations;
}

/** 1工場版と2工場版を同一seed・同一Turn数で走らせて突き合わせる。 */
function runPair(turns: number, factoryFixedIndex?: number) {
  const single = initializeCompanyLab(baseConfig());
  const lean = run(single.fixtures, initializeCompanyLab(baseConfig()).state, turns, { factoryFixedIndex });

  const dual = initializeCompanyLab(baseConfig());
  const heavyFixtures = withSecondFactory(dual.fixtures, TARGET);
  const heavy = run(heavyFixtures, initializeCompanyLab(baseConfig()).state, turns, { factoryFixedIndex });

  return { lean, heavy };
}

// =====================================================================
// 規模の経済（要求1〜3）
// =====================================================================

test("DYN-SCALE-1: 同じ総生産量なら、工場数が多く低稼働の会社の単位固定費が高い", () => {
  const { lean, heavy } = runPair(3);

  for (const turn of [1, 2, 3]) {
    const a = lean[turn - 1];
    const b = heavy[turn - 1];
    assert.equal(a.factoryCount, 1, `T${turn} lean の工場数`);
    assert.equal(b.factoryCount, 2, `T${turn} heavy の工場数`);

    // 2工場側は稼働率が低い（同じ需要に対して能力だけが倍になっているため）。
    assert.ok(
      b.equipmentUtilization < a.equipmentUtilization,
      `T${turn} 稼働率: heavy ${b.equipmentUtilization} < lean ${a.equipmentUtilization} のはず`
    );

    // 「同じ総生産量なら」を満たすため、両者に共通の生産量 Q で単位固定費を比べる。
    // 固定製造費は生産量に依存しないので、この比較は Q の取り方によらず成立する。
    const commonQ = Math.min(a.producedTons, b.producedTons);
    assert.ok(commonQ > 0, `T${turn} 生産量が0`);
    const unitLean = a.fixedManufacturingCost / commonQ;
    const unitHeavy = b.fixedManufacturingCost / commonQ;
    assert.ok(
      unitHeavy > unitLean,
      `T${turn} 単位固定費: heavy ${unitHeavy.toFixed(1)} > lean ${unitLean.toFixed(1)} のはず`
    );

    // 差は「工場1つぶんの通常cash固定費」ちょうどであること（指数1.00時）。
    assert.ok(
      Math.abs(b.fixedManufacturingCost - a.fixedManufacturingCost - NORMAL_CASH_FIXED_COST) <= 1,
      `T${turn} 固定製造費の差 ${(b.fixedManufacturingCost - a.fixedManufacturingCost).toFixed(0)} が ` +
        `NORMAL_CASH_FIXED_COST ${NORMAL_CASH_FIXED_COST} と一致しない`
    );
  }
});

test("DYN-SCALE-2: 増設後に十分な増産がある会社では、単位固定費を引き下げる余地がある", () => {
  const { lean, heavy } = runPair(3);
  const a = lean[0];
  const b = heavy[0];

  // 能力は稼働率から逆算しない。会社の equipmentUtilizationRate は工場別稼働率の
  // 加重平均（production/loadMetrics.ts:143）であり、produced/util は会社合計能力に
  // ならないため、稼働率の分母と同じ commonProcessing を正規経路から合計する。
  const leanCapacity = a.processingCapacityTons;
  const heavyCapacity = b.processingCapacityTons;
  assert.ok(
    heavyCapacity > leanCapacity * 1.5,
    `2工場の能力 ${heavyCapacity.toFixed(0)} は1工場 ${leanCapacity.toFixed(0)} の1.5倍超のはず`
  );

  // 2工場側が「1工場側と同じ単位固定費」に並ぶために必要な生産量。
  const leanUnitFixed = a.fixedManufacturingCost / a.producedTons;
  const breakEvenTons = b.fixedManufacturingCost / leanUnitFixed;

  // その生産量が2工場側の能力内に収まっていれば、増産で単位固定費を下げる余地がある。
  assert.ok(
    breakEvenTons < heavyCapacity,
    `追いつくのに必要な生産量 ${breakEvenTons.toFixed(0)}t が2工場の能力 ${heavyCapacity.toFixed(0)}t を超えている`
  );

  // 能力いっぱいまで増産できた場合の単位固定費は、1工場側の実績を下回る。
  const heavyUnitFixedAtCapacity = b.fixedManufacturingCost / heavyCapacity;
  assert.ok(
    heavyUnitFixedAtCapacity < leanUnitFixed,
    `満稼働時の単位固定費 ${heavyUnitFixedAtCapacity.toFixed(1)} が1工場実績 ${leanUnitFixed.toFixed(1)} を下回らない`
  );
});

test("DYN-SCALE-3: factoryFixed指数を両社へ同じ倍率で適用しても会社間の順位が変わらない", () => {
  const INDEX = 1.3;
  const neutral = runPair(3);
  const indexed = runPair(3, INDEX);

  for (const turn of [1, 2, 3]) {
    const a0 = neutral.lean[turn - 1];
    const b0 = neutral.heavy[turn - 1];
    const a1 = indexed.lean[turn - 1];
    const b1 = indexed.heavy[turn - 1];

    // 指数は両社の固定製造費を押し上げる。
    assert.ok(a1.fixedManufacturingCost > a0.fixedManufacturingCost, `T${turn} lean が上がっていない`);
    assert.ok(b1.fixedManufacturingCost > b0.fixedManufacturingCost, `T${turn} heavy が上がっていない`);

    // 差は「工場1つぶん × 指数」ちょうど。
    assert.ok(
      Math.abs(b1.fixedManufacturingCost - a1.fixedManufacturingCost - NORMAL_CASH_FIXED_COST * INDEX) <= 1,
      `T${turn} 指数適用後の差が NORMAL×${INDEX} と一致しない`
    );

    // 順位（2工場側の単位固定費が高い）は指数の有無で変わらない。
    const q0 = Math.min(a0.producedTons, b0.producedTons);
    const q1 = Math.min(a1.producedTons, b1.producedTons);
    assert.ok(b0.fixedManufacturingCost / q0 > a0.fixedManufacturingCost / q0, `T${turn} 中立時の順位`);
    assert.ok(b1.fixedManufacturingCost / q1 > a1.fixedManufacturingCost / q1, `T${turn} 指数適用時の順位`);
  }

  // 指数そのものが宣言どおりに解決されていること（解決経路の確認）。
  const definition = withFactoryFixedIndex(initializeCompanyLab(baseConfig()).state.scenarioState.definition, INDEX);
  for (const turn of [1, 8, 32]) {
    assert.equal(resolveOperatingCostIndex(definition, "factoryFixed", turn), INDEX, `turn=${turn}`);
    assert.equal(resolveOperatingCostIndex(definition, "adminFixed", turn), 1.0, `turn=${turn} 他キーは中立`);
  }
});

// =====================================================================
// 工場状態の動的遷移（要求4〜6）
// =====================================================================

test("DYN-LIFECYCLE-4: mothballはT+1で能力が外れ、固定費基準額の25%がcarrying costとして残る（指数適用時も同じ比率）", () => {
  const INDEX = 1.3;
  const init = initializeCompanyLab(baseConfig());
  const fixtures = withSecondFactory(init.fixtures, TARGET);
  const obs = run(fixtures, initializeCompanyLab(baseConfig()).state, 5, {
    factoryFixedIndex: INDEX,
    lifecycleByTurn: { 2: [{ type: "MOTHBALL_FACTORY", factoryId: SECOND_FACTORY_ID }] },
  });

  // T1: 決定前。2工場とも稼働。
  assert.equal(obs[0].factoryCount, 2);
  assert.equal(obs[0].carryingCost, 0);
  // T2: 決定した四半期。効果はまだ出ない（T+1発効）。
  assert.deepEqual(obs[1].eventCodes, ["FACTORY_MOTHBALL_DECIDED"]);
  assert.equal(obs[1].carryingCost, 0);
  assert.equal(obs[1].fixedManufacturingCost, obs[0].fixedManufacturingCost);
  // T3: 発効。休止工場は生産に使われず、固定製造費が工場1つぶん×指数だけ減る。
  assert.deepEqual(obs[2].eventCodes, ["FACTORY_MOTHBALL_EFFECTIVE"]);
  assert.ok(obs[2].statuses.includes("idle"), `休止工場のstatus: ${obs[2].statuses.join(",")}`);
  assert.ok(
    Math.abs(obs[1].fixedManufacturingCost - obs[2].fixedManufacturingCost - NORMAL_CASH_FIXED_COST * INDEX) <= 1,
    `固定製造費の減少が NORMAL×${INDEX} と一致しない`
  );

  // carrying cost は「指数適用後の通常cash固定費 × 25%」。
  const expected = NORMAL_CASH_FIXED_COST * INDEX * FACTORY_LIFECYCLE_PARAMETERS_V1.mothballCarryingCostRatio;
  for (const turn of [3, 4, 5]) {
    assert.ok(
      Math.abs(obs[turn - 1].carryingCost - expected) <= 1,
      `T${turn} carrying ${obs[turn - 1].carryingCost.toFixed(0)} が期待 ${expected.toFixed(0)} と一致しない`
    );
  }
  assert.equal(FACTORY_LIFECYCLE_PARAMETERS_V1.mothballCarryingCostRatio, 0.25);
});

test("DYN-LIFECYCLE-5: sale pendingは10%のみ残り、T+2の売却完了で工場が消えてcarrying costも0になる（指数適用時も同じ比率）", () => {
  const INDEX = 1.3;
  const init = initializeCompanyLab(baseConfig());
  const fixtures = withSecondFactory(init.fixtures, TARGET);
  const obs = run(fixtures, initializeCompanyLab(baseConfig()).state, 5, {
    factoryFixedIndex: INDEX,
    lifecycleByTurn: { 2: [{ type: "SELL_FACTORY", factoryId: SECOND_FACTORY_ID }] },
  });

  // T2: 売却決定。まだ2工場とも稼働し、carrying costは発生しない。
  assert.deepEqual(obs[1].eventCodes, ["FACTORY_SALE_DECIDED"]);
  assert.equal(obs[1].factoryCount, 2);
  assert.equal(obs[1].carryingCost, 0);

  // T3: 操業停止（SALE_PENDING）。保有はしているので工場数は2のまま、10%だけ残る。
  assert.deepEqual(obs[2].eventCodes, ["FACTORY_SALE_OPERATION_STOPPED"]);
  assert.equal(obs[2].factoryCount, 2);
  assert.ok(obs[2].statuses.includes("suspended"), `売却待ちのstatus: ${obs[2].statuses.join(",")}`);
  const expectedPending =
    NORMAL_CASH_FIXED_COST * INDEX * FACTORY_LIFECYCLE_PARAMETERS_V1.salePendingHoldingCostRatio;
  assert.ok(
    Math.abs(obs[2].carryingCost - expectedPending) <= 1,
    `T3 carrying ${obs[2].carryingCost.toFixed(0)} が期待 ${expectedPending.toFixed(0)} と一致しない`
  );
  assert.equal(FACTORY_LIFECYCLE_PARAMETERS_V1.salePendingHoldingCostRatio, 0.1);

  // T4: 売却完了。Factory[]から消え、carrying costも固定費も無くなる。
  assert.ok(obs[3].eventCodes.includes("FACTORY_SALE_COMPLETED"), obs[3].eventCodes.join(","));
  assert.equal(obs[3].factoryCount, 1);
  assert.equal(obs[3].carryingCost, 0);
  // 減価償却も止まるため、固定製造費は SALE_PENDING 時よりさらに下がる。
  assert.ok(
    obs[3].fixedManufacturingCost < obs[2].fixedManufacturingCost,
    `T4 固定製造費 ${obs[3].fixedManufacturingCost} が T3 ${obs[2].fixedManufacturingCost} 以上`
  );
  // T5も維持される（一過性でないこと）。
  assert.equal(obs[4].factoryCount, 1);
  assert.equal(obs[4].carryingCost, 0);
});

test("DYN-LIFECYCLE-6: 上記が Turn 経過を含む状態遷移として一本の run で観測できる", () => {
  const INDEX = 1.2;
  const init = initializeCompanyLab(baseConfig());
  const fixtures = withSecondFactory(init.fixtures, TARGET);
  // 1本のrunの中で 稼働 → 休止 → 再稼働 まで遷移させる。
  const obs = run(fixtures, initializeCompanyLab(baseConfig()).state, 6, {
    factoryFixedIndex: INDEX,
    lifecycleByTurn: {
      2: [{ type: "MOTHBALL_FACTORY", factoryId: SECOND_FACTORY_ID }],
      4: [{ type: "REACTIVATE_FACTORY", factoryId: SECOND_FACTORY_ID }],
    },
  });

  const mothballed = NORMAL_CASH_FIXED_COST * INDEX * FACTORY_LIFECYCLE_PARAMETERS_V1.mothballCarryingCostRatio;
  assert.equal(obs[0].carryingCost, 0, "T1 稼働中");
  assert.deepEqual(obs[1].eventCodes, ["FACTORY_MOTHBALL_DECIDED"], "T2 休止決定");
  assert.deepEqual(obs[2].eventCodes, ["FACTORY_MOTHBALL_EFFECTIVE"], "T3 休止発効");
  assert.ok(Math.abs(obs[2].carryingCost - mothballed) <= 1, "T3 carrying 25%");
  assert.deepEqual(obs[3].eventCodes, ["FACTORY_REACTIVATION_DECIDED"], "T4 再稼働決定");
  // T4 は「まだ休止中の25%」に加えて、再稼働コスト（1工場あたり定額・決定四半期に現金支出）が乗る。
  // 【仕様の確認事項】reactivationCostUsd は FinanceParameters の費用単価ではなく
  // FACTORY_LIFECYCLE_PARAMETERS_V1 側の定額であり、factoryFixed 指数の対象外である。
  // ここではその現行仕様をそのまま固定する（本修正で挙動は変えていない）。
  assert.ok(
    Math.abs(obs[3].carryingCost - (mothballed + FACTORY_LIFECYCLE_PARAMETERS_V1.reactivationCostUsd)) <= 1,
    `T4 carrying ${obs[3].carryingCost.toFixed(0)} が 休止25% ${mothballed.toFixed(0)} + 再稼働コスト ` +
      `${FACTORY_LIFECYCLE_PARAMETERS_V1.reactivationCostUsd} と一致しない`
  );
  assert.equal(FACTORY_LIFECYCLE_PARAMETERS_V1.reactivationCostUsd, 500_000);
  assert.deepEqual(obs[4].eventCodes, ["FACTORY_REACTIVATED"], "T5 再稼働発効");
  assert.equal(obs[4].carryingCost, 0, "T5 carrying が消える");
  // 再稼働で固定製造費が休止前の水準へ戻る。
  assert.ok(
    Math.abs(obs[4].fixedManufacturingCost - obs[0].fixedManufacturingCost) <= 1,
    `T5 固定製造費 ${obs[4].fixedManufacturingCost} が T1 ${obs[0].fixedManufacturingCost} へ戻っていない`
  );
  assert.equal(obs[5].carryingCost, 0, "T6 も維持");
});
