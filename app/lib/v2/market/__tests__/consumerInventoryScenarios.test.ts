// ShrimpX V2 — 消費国在庫・購買循環モデル（Phase 8F-1）シナリオ検証
//
// 実装指示 §16「シナリオ検証」に対応する。単体テスト（consumerInventory.test.ts）
// とは別に、市場1つぶんのconsumerInventory.tsの純粋関数を32四半期連続で回し、
// 「消費・在庫・購買がどう動くか」という定性的なふるまいを数値の推移として
// 固定する。既存シナリオ定義（scenario/）を無理に加工してこの4条件を作るのではなく、
// テストが直接、狙った入力（価格履歴・期首在庫・景気指数・実購買量）を
// 制御することで、各シナリオの前提条件をそのまま再現する。
//
// 【禁止事項】本テストの中で在庫・購買・価格の計算式を再実装しない
// （すべてplanConsumerMarketQuarter/settleConsumerMarketQuarter/
// rollCarryStateForwardをそのまま呼ぶ）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { period, nextPeriod, PeriodV2 } from "../../core/period";
import { hosoEqTons, unwrapUnit } from "../../core/units";
import { DemandMarketInput } from "../types";
import {
  CONSUMER_MARKET_INVENTORY_PARAMETERS_V1,
  ConsumerMarketCarryState,
  ConsumerMarketQuarterRecord,
  buildInitialConsumerMarketCarryState,
  planConsumerMarketQuarter,
  rollCarryStateForward,
  settleConsumerMarketQuarter,
} from "../consumerInventory";

const QUARTERS = 32;
const MARKET = "US" as const; // USは価格反応が大きく、シナリオの定性的な形が見やすいため代表市場として使う。
const PARAMS = CONSUMER_MARKET_INVENTORY_PARAMETERS_V1[MARKET];

function flatDemandInput(overrides: Partial<DemandMarketInput> = {}): DemandMarketInput {
  return {
    priorPeriodConsumption: hosoEqTons(1000),
    economicIndex: 1.0,
    populationGrowthRate: 0,
    ...overrides,
  };
}

/** 1市場ぶんの32四半期連続実行の結果（各四半期のplanning前・確定記録を並べたもの）。 */
interface QuarterlyTrace {
  readonly period: PeriodV2;
  readonly record: ConsumerMarketQuarterRecord;
  readonly desiredPurchaseTons: number;
  readonly actualPurchaseTons: number;
  readonly plannedConsumptionTons: number;
  readonly realizedConsumptionTons: number;
  readonly inventoryCoverageMonths: number;
  readonly purchasePressureIndex: number;
}

/**
 * 32四半期を、四半期ごとの価格履歴上書き・実購買量決定関数を受け取って実行する
 * 汎用ランナー。シナリオごとの違いは、この2つのフック関数だけで表現する
 * （計算式自体はconsumerInventory.tsの既存関数を呼ぶだけ）。
 */
function runScenario(
  initialCarry: ConsumerMarketCarryState,
  demandInputForQuarter: (turn: number) => DemandMarketInput,
  actualPurchaseDecider: (desiredPurchaseTons: number, turn: number) => number,
  nextQuarterPriceDecider: (planning: ReturnType<typeof planConsumerMarketQuarter>, turn: number) => number
): readonly QuarterlyTrace[] {
  let carry = initialCarry;
  let p = period(2020, 1);
  const trace: QuarterlyTrace[] = [];
  for (let turn = 1; turn <= QUARTERS; turn++) {
    const demandInput = demandInputForQuarter(turn);
    const planning = planConsumerMarketQuarter(p, carry, demandInput, PARAMS);
    const actualPurchase = actualPurchaseDecider(unwrapUnit(planning.desiredPurchaseTons), turn);
    const record = settleConsumerMarketQuarter(planning, hosoEqTons(Math.max(0, actualPurchase)), PARAMS);
    const nextPrice = nextQuarterPriceDecider(planning, turn);
    carry = rollCarryStateForward(carry, record, nextPrice);
    trace.push({
      period: p,
      record,
      desiredPurchaseTons: unwrapUnit(record.desiredPurchaseTons),
      actualPurchaseTons: unwrapUnit(record.actualPurchaseTons),
      plannedConsumptionTons: unwrapUnit(record.plannedConsumptionTons),
      realizedConsumptionTons: unwrapUnit(record.realizedConsumptionTons),
      inventoryCoverageMonths: record.inventoryCoverageMonths,
      purchasePressureIndex: record.purchasePressureIndex,
    });
    p = nextPeriod(p);
  }
  return trace;
}

function assertNoNaNOrInfinity(trace: readonly QuarterlyTrace[]): void {
  for (const t of trace) {
    for (const [key, value] of Object.entries(t)) {
      if (typeof value === "number") {
        assert.ok(Number.isFinite(value), `${t.period} ${key} が有限でない: ${value}`);
      }
    }
  }
}

// ---------------------------------------------------------------------
// シナリオA: 安値による復元購買（低価格 → 購買先行 → 在庫積み増し → 消費が遅れて増加 → 過剰化で購買抑制）
// ---------------------------------------------------------------------

test("シナリオA: 価格下落 → 購買が先に増える → 在庫が積み上がる → 消費が遅れて増える → 過剰在庫化で購買が抑制される", () => {
  const initialCarry = buildInitialConsumerMarketCarryState(MARKET, flatDemandInput(), PARAMS);
  // 四半期1の決算直後から、価格が平常の60%まで下落し、以後ずっとその水準を維持する
  // （「安値が続く」ことで、購買→在庫→消費の遅行連鎖を明確に観測する）。
  // rollCarryStateForwardで四半期1の直後に追記されるため、価格下落の影響は
  // 四半期2のplanConsumerMarketQuarterから観測できる（四半期1自体は平常価格のまま）。
  const cheapPrice = PARAMS.normalPriceUsdPerHosoEqKg * 0.6;
  const trace = runScenario(
    initialCarry,
    () => flatDemandInput(),
    (desired) => desired, // 実購買量=希望購買量（世界供給は常に十分という単純化）
    () => cheapPrice
  );
  assertNoNaNOrInfinity(trace);

  // (1) 価格下落が反映された直後(四半期3〜5、インデックス2〜4)は、購買圧力指数が
  //     正になり、希望購買量が計画消費を上回る（四半期2は価格反応の1四半期目で
  //     まだ弱いため、確実に反映されている四半期3以降を「序盤」の判定対象にする）。
  const earlyPressure = trace.slice(2, 5).map((t) => t.purchasePressureIndex);
  assert.ok(earlyPressure.every((p) => p > 0), `序盤の購買圧力が正になっていない: ${JSON.stringify(earlyPressure)}`);

  // (2) 在庫が序盤で積み上がる（在庫月数が序盤で増加傾向）。
  const coverageEarly = trace.slice(0, 8).map((t) => t.inventoryCoverageMonths);
  assert.ok(coverageEarly[coverageEarly.length - 1] > coverageEarly[0], `在庫月数が序盤で積み上がっていない: ${JSON.stringify(coverageEarly)}`);

  // (3) 消費は購買より遅れて増える: 価格下落が反映された四半期2の購買増加率は、
  //     同じ四半期2の消費増加率より大きい（購買は当期の価格に即座に反応するが、
  //     消費は1四半期遅れた価格を見るため、この時点ではまだ反応していない）。
  const flatConsumption = trace[0].plannedConsumptionTons; // 参考: 価格下落前の消費水準
  const turn2ConsumptionGrowth = (trace[1].plannedConsumptionTons - flatConsumption) / flatConsumption;
  const turn2PurchaseGrowth = (trace[1].desiredPurchaseTons - flatConsumption) / flatConsumption;
  assert.ok(
    turn2PurchaseGrowth > turn2ConsumptionGrowth,
    `購買の反応が消費より早いという遅行構造が観測できない（購買${turn2PurchaseGrowth} 消費${turn2ConsumptionGrowth}）`
  );

  // (4) 終盤は在庫が過剰化し、購買圧力指数が序盤より低下する（積み増しが一巡し抑制がかかる）。
  const latePressure = trace.slice(-6).map((t) => t.purchasePressureIndex);
  const avgEarly = earlyPressure.reduce((s, v) => s + v, 0) / earlyPressure.length;
  const avgLate = latePressure.reduce((s, v) => s + v, 0) / latePressure.length;
  assert.ok(avgLate < avgEarly, `終盤の購買圧力が序盤より抑制されていない（序盤平均${avgEarly} 終盤平均${avgLate}）`);
});

// ---------------------------------------------------------------------
// シナリオB: 在庫調整（初期在庫過剰 → 購買が消費を下回り続ける → 在庫が目標へ収束 → 調整終了後に購買が回復）
// ---------------------------------------------------------------------

test("シナリオB: 初期在庫が目標を大きく上回る → 購買が消費を下回り続ける → 在庫が目標へ収束する → 調整終了後に購買が回復する", () => {
  const baseCarry = buildInitialConsumerMarketCarryState(MARKET, flatDemandInput(), PARAMS);
  // 期首在庫を目標水準の3倍にした過剰在庫状態からスタートする。
  const excessCarry: ConsumerMarketCarryState = {
    ...baseCarry,
    openingInventoryTons: hosoEqTons(unwrapUnit(baseCarry.openingInventoryTons) * 3),
  };
  const trace = runScenario(
    excessCarry,
    () => flatDemandInput(), // 消費水準は変えない(景気・価格を平常のまま維持)
    (desired) => desired,
    () => PARAMS.normalPriceUsdPerHosoEqKg
  );
  assertNoNaNOrInfinity(trace);

  // (1) 序盤は、希望購買量が計画消費を下回り続ける(過剰在庫の吐き出し)。
  const earlyRatios = trace.slice(0, 4).map((t) => t.desiredPurchaseTons / t.plannedConsumptionTons);
  assert.ok(earlyRatios.every((r) => r < 1), `序盤の購買が消費を下回っていない: ${JSON.stringify(earlyRatios)}`);

  // (2) 在庫月数が目標在庫月数へ収束し、発散しない。目標在庫月数自体は季節性
  //     （四半期ごとのseasonalMultiplierByQuarter）によって四半期ごとに微小に
  //     変動するため、収束後も季節性ぶんの小さな残差振動が残る（発散ではない）。
  //     そのため、(a) 序盤で乖離が大きく縮小すること、(b) 収束後の終盤では
  //     乖離が季節性の残差程度の小さな範囲に収まり続けること、の2点で確認する。
  const gapToTarget = trace.map((t) => Math.abs(t.record.inventoryCoverageMonths - t.record.targetCoverageMonths));
  const initialGap = gapToTarget[0];
  const midGap = gapToTarget[7]; // 8四半期目時点
  assert.ok(midGap < initialGap * 0.3, `序盤で在庫の目標乖離が十分縮小していない（初期${initialGap} 8期目${midGap}）`);
  const tailGaps = gapToTarget.slice(-8);
  assert.ok(
    tailGaps.every((g) => g < initialGap * 0.15),
    `終盤（収束後）の乖離が季節性の残差振動の範囲を超えて拡大している: ${JSON.stringify(tailGaps)}`
  );

  // (3) 調整完了後(終盤)は、購買/消費比が1に近づく(過剰在庫の吐き出しが終わり購買が回復する)。
  const lateRatios = trace.slice(-4).map((t) => t.desiredPurchaseTons / t.plannedConsumptionTons);
  const avgEarlyRatio = earlyRatios.reduce((s, v) => s + v, 0) / earlyRatios.length;
  const avgLateRatio = lateRatios.reduce((s, v) => s + v, 0) / lateRatios.length;
  assert.ok(avgLateRatio > avgEarlyRatio, `調整終了後に購買が回復していない（序盤比${avgEarlyRatio} 終盤比${avgLateRatio}）`);
  assert.ok(Math.abs(avgLateRatio - 1) < Math.abs(avgEarlyRatio - 1), "終盤の購買/消費比が1に近づいていない");
});

// ---------------------------------------------------------------------
// シナリオC: 消費成長（景気改善 → 消費増加 → 期待消費・目標在庫の増加 → 一時的に復元購買が消費増加分自体を上回る）
// ---------------------------------------------------------------------

test("シナリオC: 景気改善が続く → 消費が増加する → 期待消費・目標在庫が増加する → 一時的に復元購買が消費増加分を上回る", () => {
  const initialCarry = buildInitialConsumerMarketCarryState(MARKET, flatDemandInput(), PARAMS);
  const trace = runScenario(
    initialCarry,
    () => flatDemandInput({ economicIndex: 1.15 }), // 四半期1から持続的な景気拡大
    (desired) => desired,
    () => PARAMS.normalPriceUsdPerHosoEqKg
  );
  assertNoNaNOrInfinity(trace);

  // (1) 消費成長率が序盤で正になる。
  const earlyGrowth = trace.slice(0, 3).map((t) => t.record.consumptionGrowthRate);
  assert.ok(earlyGrowth.every((g) => g > 0), `景気拡大なのに消費成長率が正になっていない: ${JSON.stringify(earlyGrowth)}`);

  // (2) 目標在庫月数が、横ばいケース(景気指数1.0)より高くなる(復元需要の発生)。
  const flatTrace = runScenario(
    initialCarry,
    () => flatDemandInput({ economicIndex: 1.0 }),
    (desired) => desired,
    () => PARAMS.normalPriceUsdPerHosoEqKg
  );
  for (let i = 0; i < 3; i++) {
    assert.ok(
      trace[i].record.targetCoverageMonths > flatTrace[i].record.targetCoverageMonths,
      `turn${i + 1}: 景気拡大なのに目標在庫月数が横ばいケース以下（拡大${trace[i].record.targetCoverageMonths} 横ばい${flatTrace[i].record.targetCoverageMonths}）`
    );
  }

  // (3) 序盤、購買量の増加分が消費量自体の増加分を上回る(在庫積み増し需要の存在)。
  for (let i = 0; i < 3; i++) {
    const consumptionDelta = trace[i].plannedConsumptionTons - flatTrace[i].plannedConsumptionTons;
    const purchaseDelta = trace[i].desiredPurchaseTons - flatTrace[i].desiredPurchaseTons;
    assert.ok(
      purchaseDelta > consumptionDelta,
      `turn${i + 1}: 復元購買(在庫積み増し)が消費増加分を上回っていない（購買差分${purchaseDelta} 消費差分${consumptionDelta}）`
    );
  }
});

// ---------------------------------------------------------------------
// シナリオD: 世界供給不足（供給不足 → 実購買量が抑制される → 在庫月数が低下する → 次期の購買圧力・価格上昇要因になる）
// ---------------------------------------------------------------------

test("シナリオD: 世界供給が希望購買量に対して不足し続ける → 実購買量が抑制される → 在庫月数が低下する → 購買圧力の高まりが次期の価格係数に反映される", () => {
  const initialCarry = buildInitialConsumerMarketCarryState(MARKET, flatDemandInput(), PARAMS);
  // 実購買量を、希望購買量の50%までしか調達できない(世界供給不足)固定ケース。
  const trace = runScenario(
    initialCarry,
    () => flatDemandInput(),
    (desired) => desired * 0.5,
    () => PARAMS.normalPriceUsdPerHosoEqKg
  );
  assertNoNaNOrInfinity(trace);

  // (1) 実購買量が常に希望購買量を下回る(供給不足が実際に反映されている)。
  for (const t of trace) {
    assert.ok(t.actualPurchaseTons < t.desiredPurchaseTons - 1e-6, `${t.period}: 実購買量が希望購買量を下回っていない`);
  }

  // (2) 在庫月数が序盤から終盤にかけて低下する(供給不足の蓄積)。
  const coverageEarly = trace[0].inventoryCoverageMonths;
  const coverageLate = trace[trace.length - 1].inventoryCoverageMonths;
  assert.ok(coverageLate < coverageEarly, `在庫月数が低下していない（序盤${coverageEarly} 終盤${coverageLate}）`);

  // (3) 在庫逼迫が続くことで、購買圧力指数が序盤より終盤で高くなる（次期の価格係数を
  //     押し上げる要因になる。deriveNextQuarterDestinationPriceCoefficientsは
  //     別テスト（consumerInventory.test.ts）でこの指数から価格が上がることを確認済み）。
  const pressureEarly = trace[0].purchasePressureIndex;
  const pressureLate = trace[trace.length - 1].purchasePressureIndex;
  assert.ok(pressureLate > pressureEarly, `購買圧力が終盤にかけて高まっていない（序盤${pressureEarly} 終盤${pressureLate}）`);
});

// ---------------------------------------------------------------------
// 共通: 全シナリオでの安定性(発散・NaN/Infinityなし)の再確認
// ---------------------------------------------------------------------

test("4シナリオいずれも32四半期完走し、在庫・消費・購買のいずれも非負かつ有限である", () => {
  const scenarios: Array<{
    name: string;
    carry: ConsumerMarketCarryState;
    demand: (turn: number) => DemandMarketInput;
    actual: (desired: number, turn: number) => number;
    price: (planning: ReturnType<typeof planConsumerMarketQuarter>, turn: number) => number;
  }> = [
    {
      name: "A",
      carry: buildInitialConsumerMarketCarryState(MARKET, flatDemandInput(), PARAMS),
      demand: () => flatDemandInput(),
      actual: (d) => d,
      price: (_p, turn) => (turn === 1 ? PARAMS.normalPriceUsdPerHosoEqKg : PARAMS.normalPriceUsdPerHosoEqKg * 0.6),
    },
    {
      name: "B",
      carry: (() => {
        const c = buildInitialConsumerMarketCarryState(MARKET, flatDemandInput(), PARAMS);
        return { ...c, openingInventoryTons: hosoEqTons(unwrapUnit(c.openingInventoryTons) * 3) };
      })(),
      demand: () => flatDemandInput(),
      actual: (d) => d,
      price: () => PARAMS.normalPriceUsdPerHosoEqKg,
    },
    {
      name: "C",
      carry: buildInitialConsumerMarketCarryState(MARKET, flatDemandInput(), PARAMS),
      demand: () => flatDemandInput({ economicIndex: 1.15 }),
      actual: (d) => d,
      price: () => PARAMS.normalPriceUsdPerHosoEqKg,
    },
    {
      name: "D",
      carry: buildInitialConsumerMarketCarryState(MARKET, flatDemandInput(), PARAMS),
      demand: () => flatDemandInput(),
      actual: (d) => d * 0.5,
      price: () => PARAMS.normalPriceUsdPerHosoEqKg,
    },
  ];
  for (const s of scenarios) {
    const trace = runScenario(s.carry, s.demand, s.actual, s.price);
    assert.equal(trace.length, QUARTERS, `シナリオ${s.name}: ${QUARTERS}四半期完走しない`);
    assertNoNaNOrInfinity(trace);
    for (const t of trace) {
      assert.ok(t.record.endingInventoryTons >= 0 || unwrapUnit(t.record.endingInventoryTons) >= 0, `シナリオ${s.name} ${t.period}: 在庫が負`);
      assert.ok(t.realizedConsumptionTons >= 0, `シナリオ${s.name} ${t.period}: 消費が負`);
      assert.ok(t.actualPurchaseTons >= 0, `シナリオ${s.name} ${t.period}: 購買が負`);
    }
  }
});
