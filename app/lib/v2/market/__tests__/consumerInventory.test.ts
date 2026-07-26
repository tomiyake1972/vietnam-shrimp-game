// ShrimpX V2 — 消費国在庫・購買循環モデル（Phase 8F-1）テスト
//
// 実装指示 §15「必要なテスト」のうち、market/consumerInventory.ts の純粋関数
// レベルで検証できる項目をここでカバーする。companyLab配線・永続化・
// 32四半期シミュレーションレベルの検証は companyLab/__tests__/ 側を参照。

import { test } from "node:test";
import assert from "node:assert/strict";

import { period, nextPeriod } from "../../core/period";
import { hosoEqTons, unwrapUnit } from "../../core/units";
import { DemandMarketId, DemandMarketInput } from "../types";
import { DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1 } from "../destinationPricingParameters";
import {
  CONSUMER_MARKET_INVENTORY_PARAMETERS_V1,
  ConsumerMarketCarryState,
  ConsumerMarketInventoryParameters,
  buildInitialConsumerMarketCarryState,
  buildInitialConsumerMarketCarryStateTable,
  planConsumerMarketQuarter,
  planConsumerMarketQuarterTable,
  settleConsumerMarketQuarter,
  rollCarryStateForward,
  deriveMarketWeightsFromDesiredPurchase,
  computeActualPurchaseByMarket,
  deriveNextQuarterDestinationPriceCoefficients,
  computeBlendedMarketPriceIndex,
} from "../consumerInventory";

const P1 = period(2020, 1);

function demandInput(overrides: Partial<DemandMarketInput> = {}): DemandMarketInput {
  return {
    priorPeriodConsumption: hosoEqTons(1000),
    economicIndex: 1.0,
    populationGrowthRate: 0,
    ...overrides,
  };
}

function paramsFor(market: DemandMarketId): ConsumerMarketInventoryParameters {
  return CONSUMER_MARKET_INVENTORY_PARAMETERS_V1[market];
}

function initialCarry(market: DemandMarketId, input = demandInput()): ConsumerMarketCarryState {
  return buildInitialConsumerMarketCarryState(market, input, paramsFor(market));
}

// ---------------------------------------------------------------------
// 1. 在庫恒等式・非負性
// ---------------------------------------------------------------------

test("在庫恒等式: ending = opening + actual - realized が成立する（通常ケース）", () => {
  const params = paramsFor("US");
  const carry = initialCarry("US");
  const planning = planConsumerMarketQuarter(P1, carry, demandInput(), params);
  const actual = hosoEqTons(unwrapUnit(planning.desiredPurchaseTons) * 0.9);
  const record = settleConsumerMarketQuarter(planning, actual, params);
  const lhs = unwrapUnit(record.endingInventoryTons);
  const rhs = unwrapUnit(record.openingInventoryTons) + unwrapUnit(record.actualPurchaseTons) - unwrapUnit(record.realizedConsumptionTons);
  assert.ok(Math.abs(lhs - rhs) < 1e-6, `恒等式が成立しない: ending=${lhs} rhs=${rhs}`);
});

test("在庫恒等式: 供給不足で計画消費を賄えないとき、実現消費が縮小され在庫は負にならない", () => {
  const params = paramsFor("US");
  const carry = initialCarry("US", demandInput({ priorPeriodConsumption: hosoEqTons(1000) }));
  // 実購買量をゼロにし、期首在庫も極端に小さいケースを作る
  const tinyCarry: ConsumerMarketCarryState = { ...carry, openingInventoryTons: hosoEqTons(1) };
  const planningTiny = planConsumerMarketQuarter(P1, tinyCarry, demandInput(), params);
  const record = settleConsumerMarketQuarter(planningTiny, hosoEqTons(0), params);
  assert.ok(unwrapUnit(record.endingInventoryTons) >= 0, "在庫が負になっている");
  assert.ok(
    unwrapUnit(record.realizedConsumptionTons) <= unwrapUnit(planningTiny.openingInventoryTons) + 1e-6,
    "実現消費が利用可能量を超えている"
  );
  assert.ok(unwrapUnit(record.realizedConsumptionTons) < unwrapUnit(record.plannedConsumptionTons), "供給不足なのに計画消費が全量実現している");
});

// ---------------------------------------------------------------------
// 2. 価格反応の時差（購買が先、消費は遅れる）
// ---------------------------------------------------------------------

test("価格反応: 現在価格が平常より安いと、当四半期の希望購買量が増える", () => {
  const params = paramsFor("US");
  const carry = initialCarry("US");
  const normalPriceCarry: ConsumerMarketCarryState = {
    ...carry,
    priceHistoryUsdPerHosoEqKg: [params.normalPriceUsdPerHosoEqKg, params.normalPriceUsdPerHosoEqKg],
  };
  const cheapCarry: ConsumerMarketCarryState = {
    ...carry,
    priceHistoryUsdPerHosoEqKg: [params.normalPriceUsdPerHosoEqKg, params.normalPriceUsdPerHosoEqKg * 0.7],
  };
  const planningNormal = planConsumerMarketQuarter(P1, normalCarrySafe(normalPriceCarry), demandInput(), params);
  const planningCheap = planConsumerMarketQuarter(P1, cheapCarry, demandInput(), params);
  assert.ok(
    unwrapUnit(planningCheap.desiredPurchaseTons) > unwrapUnit(planningNormal.desiredPurchaseTons),
    "安値なのに希望購買量が増えていない"
  );
});

function normalCarrySafe(c: ConsumerMarketCarryState): ConsumerMarketCarryState {
  return c;
}

test("価格反応の時差: 当四半期の価格下落は、当四半期の計画消費にはまだ（弱くしか）反映されず、購買ほど強く反応しない", () => {
  const params = paramsFor("US");
  const carry = initialCarry("US");
  const cheapCarry: ConsumerMarketCarryState = {
    ...carry,
    priceHistoryUsdPerHosoEqKg: [params.normalPriceUsdPerHosoEqKg, params.normalPriceUsdPerHosoEqKg * 0.7],
  };
  const normalCarry: ConsumerMarketCarryState = {
    ...carry,
    priceHistoryUsdPerHosoEqKg: [params.normalPriceUsdPerHosoEqKg, params.normalPriceUsdPerHosoEqKg],
  };
  const planningCheap = planConsumerMarketQuarter(P1, cheapCarry, demandInput(), params);
  const planningNormal = planConsumerMarketQuarter(P1, normalCarry, demandInput(), params);

  const consumptionDeltaRatio = safeRatio(
    unwrapUnit(planningCheap.plannedConsumptionTons) - unwrapUnit(planningNormal.plannedConsumptionTons),
    unwrapUnit(planningNormal.plannedConsumptionTons)
  );
  const purchaseDeltaRatio = safeRatio(
    unwrapUnit(planningCheap.desiredPurchaseTons) - unwrapUnit(planningNormal.desiredPurchaseTons),
    unwrapUnit(planningNormal.desiredPurchaseTons)
  );
  // 直近の価格（history最後の要素）はconsumptionPriceLagQuartersぶん遡った
  // laggedPriceには反映されない（historyが2件しかないため）ので、消費側は
  // ほぼ無反応、購買側は即時に反応するはず。
  assert.ok(Math.abs(consumptionDeltaRatio) < 1e-9, `当期の消費が当期価格に反応してしまっている: ${consumptionDeltaRatio}`);
  assert.ok(purchaseDeltaRatio > 0, "購買が安値に反応していない");
});

test("価格反応の時差: 価格下落から数四半期後に消費が緩やかに増える(価格が平常のままの対照シナリオと比較)", () => {
  const params = paramsFor("US"); // consumptionPriceLagQuarters = 1
  const carryBase = initialCarry("US");

  // 対照シナリオ: 価格はずっと平常のまま
  let carryNormal = carryBase;
  let pNormal = P1;
  let planningNormalAtSameTurn = planConsumerMarketQuarter(pNormal, carryNormal, demandInput(), params);
  for (let i = 0; i < 2; i++) {
    const record = settleConsumerMarketQuarter(planningNormalAtSameTurn, planningNormalAtSameTurn.desiredPurchaseTons, params);
    carryNormal = rollCarryStateForward(carryNormal, record, params.normalPriceUsdPerHosoEqKg);
    pNormal = nextPeriod(pNormal);
    planningNormalAtSameTurn = planConsumerMarketQuarter(pNormal, carryNormal, demandInput(), params);
  }

  // 価格下落シナリオ: Q1でだけ価格が下落し、その後は平常へ戻る
  let carryCheap = carryBase;
  let pCheap = P1;
  const planningQ1 = planConsumerMarketQuarter(pCheap, carryCheap, demandInput(), params);
  const recordQ1 = settleConsumerMarketQuarter(planningQ1, planningQ1.desiredPurchaseTons, params);
  carryCheap = rollCarryStateForward(carryCheap, recordQ1, params.normalPriceUsdPerHosoEqKg * 0.7); // Q1の価格が下落
  pCheap = nextPeriod(pCheap);
  const planningQ2 = planConsumerMarketQuarter(pCheap, carryCheap, demandInput(), params);
  const recordQ2 = settleConsumerMarketQuarter(planningQ2, planningQ2.desiredPurchaseTons, params);
  carryCheap = rollCarryStateForward(carryCheap, recordQ2, params.normalPriceUsdPerHosoEqKg); // Q2以降は平常に戻る
  pCheap = nextPeriod(pCheap);
  const planningQ3 = planConsumerMarketQuarter(pCheap, carryCheap, demandInput(), params);

  // 購買は下落した当四半期(Q1)にすでに反応済み(desiredPurchaseTons増加、別テストで確認済み)だが、
  // 消費は遅行し、数四半期後(Q3)になって初めて対照シナリオより増える。
  assert.ok(
    unwrapUnit(planningQ3.plannedConsumptionTons) > unwrapUnit(planningNormalAtSameTurn.plannedConsumptionTons),
    "価格下落から数四半期後の消費増加(遅行効果)が観測できない"
  );
});

function safeRatio(numerator: number, denominator: number): number {
  return Math.abs(denominator) < 1e-9 ? 0 : numerator / denominator;
}

// ---------------------------------------------------------------------
// 3. 在庫水準への反応
// ---------------------------------------------------------------------

test("在庫反応: 期首在庫が目標在庫を大きく上回ると（過剰在庫）、希望購買量は期待消費より少なくなる", () => {
  const params = paramsFor("US");
  const carry = initialCarry("US");
  const excessCarry: ConsumerMarketCarryState = {
    ...carry,
    openingInventoryTons: hosoEqTons(unwrapUnit(carry.openingInventoryTons) * 3),
  };
  const planning = planConsumerMarketQuarter(P1, excessCarry, demandInput(), params);
  assert.ok(
    unwrapUnit(planning.desiredPurchaseTons) < unwrapUnit(planning.plannedConsumptionTons),
    "過剰在庫なのに希望購買量が消費量を下回っていない"
  );
  assert.ok(planning.inventoryAdjustmentTons < 0, "過剰在庫なのに在庫調整量が負になっていない");
});

test("在庫反応: 期首在庫が目標在庫を大きく下回ると（不足）、希望購買量は期待消費より多くなる", () => {
  const params = paramsFor("US");
  const carry = initialCarry("US");
  const shortageCarry: ConsumerMarketCarryState = {
    ...carry,
    openingInventoryTons: hosoEqTons(unwrapUnit(carry.openingInventoryTons) * 0.2),
  };
  const planning = planConsumerMarketQuarter(P1, shortageCarry, demandInput(), params);
  assert.ok(
    unwrapUnit(planning.desiredPurchaseTons) > unwrapUnit(planning.plannedConsumptionTons),
    "在庫不足なのに希望購買量が消費量を上回っていない"
  );
  assert.ok(planning.inventoryAdjustmentTons > 0, "在庫不足なのに在庫調整量が正になっていない");
});

// ---------------------------------------------------------------------
// 4. 消費成長 → 目標在庫・購買の増加
// ---------------------------------------------------------------------

test("消費成長: 景気拡大で消費が伸びると、目標在庫月数と希望購買量が(横ばいケースより)増える", () => {
  const params = paramsFor("US");
  const carry = initialCarry("US");
  const planningFlat = planConsumerMarketQuarter(P1, carry, demandInput({ economicIndex: 1.0 }), params);
  const planningGrowth = planConsumerMarketQuarter(P1, carry, demandInput({ economicIndex: 1.3 }), params);
  assert.ok(planningGrowth.consumptionGrowthRate > planningFlat.consumptionGrowthRate);
  assert.ok(
    planningGrowth.targetCoverageMonths > planningFlat.targetCoverageMonths,
    "消費成長で目標在庫月数が増えていない"
  );
  assert.ok(
    unwrapUnit(planningGrowth.desiredPurchaseTons) > unwrapUnit(planningFlat.desiredPurchaseTons),
    "消費成長で希望購買量が増えていない"
  );
  // 復元需要の存在: 一時的に希望購買量の増分が消費量の増分自体を上回る
  const consumptionDelta = unwrapUnit(planningGrowth.plannedConsumptionTons) - unwrapUnit(planningFlat.plannedConsumptionTons);
  const purchaseDelta = unwrapUnit(planningGrowth.desiredPurchaseTons) - unwrapUnit(planningFlat.desiredPurchaseTons);
  assert.ok(purchaseDelta > consumptionDelta, "復元需要(在庫積み増し)が消費増分を上回っていない");
});

// ---------------------------------------------------------------------
// 5. 希望購買量 vs 実購買量の区別
// ---------------------------------------------------------------------

test("希望購買量と実購買量は別概念であり、settleConsumerMarketQuarterは実購買量を使って在庫を更新する", () => {
  const params = paramsFor("US");
  const carry = initialCarry("US");
  const planning = planConsumerMarketQuarter(P1, carry, demandInput(), params);
  const desired = unwrapUnit(planning.desiredPurchaseTons);
  const actual = hosoEqTons(desired * 0.5); // 実際は半分しか調達できなかった
  const record = settleConsumerMarketQuarter(planning, actual, params);
  assert.ok(Math.abs(unwrapUnit(record.desiredPurchaseTons) - desired) < 1e-9);
  assert.ok(Math.abs(unwrapUnit(record.actualPurchaseTons) - desired * 0.5) < 1e-9);
  assert.notEqual(unwrapUnit(record.actualPurchaseTons), unwrapUnit(record.desiredPurchaseTons));
});

test("世界供給不足: 非VN原産国の輸出可能供給量が小さいと、市場合計の実購買量が希望購買量を下回る", () => {
  const weights: Readonly<Record<DemandMarketId, number>> = { CN: 0.2, US: 0.3, EU: 0.2, JP: 0.2, OTHER: 0.1 };
  const desired: Readonly<Record<DemandMarketId, ReturnType<typeof hosoEqTons>>> = {
    CN: hosoEqTons(500),
    US: hosoEqTons(500),
    EU: hosoEqTons(500),
    JP: hosoEqTons(500),
    OTHER: hosoEqTons(500),
  };
  const vnActual: Readonly<Record<DemandMarketId, ReturnType<typeof hosoEqTons>>> = {
    CN: hosoEqTons(50),
    US: hosoEqTons(50),
    EU: hosoEqTons(50),
    JP: hosoEqTons(50),
    OTHER: hosoEqTons(50),
  };
  const nonVnOrigins = [{ allocatedDemandTons: 2000, exportableSupplyTons: 50 }]; // 世界供給が極端に不足
  const actualByMarket = computeActualPurchaseByMarket(weights, desired, vnActual, nonVnOrigins);
  for (const market of Object.keys(desired) as DemandMarketId[]) {
    assert.ok(
      unwrapUnit(actualByMarket[market]) <= unwrapUnit(desired[market]) + 1e-9,
      `${market}: 実購買量が希望購買量を超えている`
    );
  }
  const totalActual = Object.values(actualByMarket).reduce((s, v) => s + unwrapUnit(v), 0);
  const totalDesired = Object.values(desired).reduce((s, v) => s + unwrapUnit(v), 0);
  assert.ok(totalActual < totalDesired, "世界供給不足なのに実購買量合計が希望購買量合計を下回っていない");
});

test("非VN原産国の供給が在庫更新へ含まれる: VNの実購買がゼロでも、非VN原産国の供給があれば実購買量は正になる", () => {
  const weights: Readonly<Record<DemandMarketId, number>> = { CN: 0.2, US: 0.2, EU: 0.2, JP: 0.2, OTHER: 0.2 };
  const desired: Readonly<Record<DemandMarketId, ReturnType<typeof hosoEqTons>>> = {
    CN: hosoEqTons(1000),
    US: hosoEqTons(1000),
    EU: hosoEqTons(1000),
    JP: hosoEqTons(1000),
    OTHER: hosoEqTons(1000),
  };
  const vnActualZero: Readonly<Record<DemandMarketId, ReturnType<typeof hosoEqTons>>> = {
    CN: hosoEqTons(0),
    US: hosoEqTons(0),
    EU: hosoEqTons(0),
    JP: hosoEqTons(0),
    OTHER: hosoEqTons(0),
  };
  const nonVnOrigins = [
    { allocatedDemandTons: 3000, exportableSupplyTons: 3000 },
    { allocatedDemandTons: 1000, exportableSupplyTons: 1000 },
  ];
  const actualByMarket = computeActualPurchaseByMarket(weights, desired, vnActualZero, nonVnOrigins);
  for (const market of Object.keys(desired) as DemandMarketId[]) {
    assert.ok(unwrapUnit(actualByMarket[market]) > 0, `${market}: 非VN供給国からの実購買量がゼロのまま`);
  }
});

// ---------------------------------------------------------------------
// 6. 市場別ウェイト
// ---------------------------------------------------------------------

test("市場別ウェイト: 希望購買量の構成比どおりに正規化され、合計が1になる", () => {
  const params = CONSUMER_MARKET_INVENTORY_PARAMETERS_V1;
  const table = buildInitialConsumerMarketCarryStateTable(
    { CN: demandInput(), US: demandInput({ priorPeriodConsumption: hosoEqTons(2000) }), EU: demandInput(), JP: demandInput(), OTHER: demandInput() },
    params
  );
  const planning = planConsumerMarketQuarterTable(
    P1,
    table,
    { CN: demandInput(), US: demandInput({ priorPeriodConsumption: hosoEqTons(2000) }), EU: demandInput(), JP: demandInput(), OTHER: demandInput() },
    params
  );
  const weights = deriveMarketWeightsFromDesiredPurchase(planning);
  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `市場別ウェイトの合計が1でない: ${total}`);
  assert.ok(weights.US > weights.CN, "前期消費量が大きいUSのウェイトがCNより大きくなっていない");
});

// ---------------------------------------------------------------------
// 7. 価格形成への接続（購買圧力主因・在庫逼迫は補助）
// ---------------------------------------------------------------------

function fixedRecord(overrides: Partial<{ purchasePressureIndex: number; inventoryTightnessIndex: number }> = {}) {
  const params = paramsFor("US");
  const carry = initialCarry("US");
  const planning = planConsumerMarketQuarter(P1, carry, demandInput(), params);
  const record = settleConsumerMarketQuarter(planning, planning.desiredPurchaseTons, params);
  return { ...record, ...overrides };
}

test("価格形成: 購買圧力指数が高いほど、次四半期の仕向市場価格係数が(ベース比で)上がる", () => {
  const params = CONSUMER_MARKET_INVENTORY_PARAMETERS_V1;
  const lowPressureRecord = fixedRecord({ purchasePressureIndex: 0.02, inventoryTightnessIndex: 0 });
  const highPressureRecord = fixedRecord({ purchasePressureIndex: 0.3, inventoryTightnessIndex: 0 });
  const records = (r: typeof lowPressureRecord) => ({ CN: r, US: r, EU: r, JP: r, OTHER: r });
  const lowCoeff = deriveNextQuarterDestinationPriceCoefficients(records(lowPressureRecord), DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1, params);
  const highCoeff = deriveNextQuarterDestinationPriceCoefficients(records(highPressureRecord), DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1, params);
  assert.ok(
    highCoeff.US.baseValueCoefficient > lowCoeff.US.baseValueCoefficient,
    "購買圧力が高いのに価格係数が上がっていない"
  );
});

test("価格形成: 在庫過剰（在庫逼迫度が負）は、価格に下押し圧力として働く", () => {
  const params = CONSUMER_MARKET_INVENTORY_PARAMETERS_V1;
  const balancedRecord = fixedRecord({ purchasePressureIndex: 0, inventoryTightnessIndex: 0 });
  const excessRecord = fixedRecord({ purchasePressureIndex: 0, inventoryTightnessIndex: -0.5 });
  const records = (r: typeof balancedRecord) => ({ CN: r, US: r, EU: r, JP: r, OTHER: r });
  const balancedCoeff = deriveNextQuarterDestinationPriceCoefficients(records(balancedRecord), DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1, params);
  const excessCoeff = deriveNextQuarterDestinationPriceCoefficients(records(excessRecord), DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1, params);
  assert.ok(
    excessCoeff.US.baseValueCoefficient < balancedCoeff.US.baseValueCoefficient,
    "在庫過剰なのに価格へ下押し圧力が働いていない"
  );
});

test("価格形成: 極端な購買圧力・在庫逼迫の組み合わせでも、1四半期の価格調整幅はmaxQuarterlyPriceAdjustmentRatioでclampされ暴騰・暴落しない", () => {
  const params = CONSUMER_MARKET_INVENTORY_PARAMETERS_V1;
  const extremeRecord = fixedRecord({ purchasePressureIndex: 5, inventoryTightnessIndex: -1 });
  const records = { CN: extremeRecord, US: extremeRecord, EU: extremeRecord, JP: extremeRecord, OTHER: extremeRecord };
  const coeff = deriveNextQuarterDestinationPriceCoefficients(records, DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1, params);
  for (const market of Object.keys(coeff) as DemandMarketId[]) {
    const base = DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1[market];
    const ratio = coeff[market].baseValueCoefficient / base.baseValueCoefficient - 1;
    assert.ok(Math.abs(ratio) <= params[market].maxQuarterlyPriceAdjustmentRatio + 1e-9, `${market}: 価格調整幅がclampを超えている: ${ratio}`);
  }
});

test("既存の固定構造は残る: 仕向市場価格係数の動的調整は既存のbaseCoefficientsを書き換えず、乗算で上乗せするだけ", () => {
  const params = CONSUMER_MARKET_INVENTORY_PARAMETERS_V1;
  const before = JSON.stringify(DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1);
  const record = fixedRecord({ purchasePressureIndex: 0.2, inventoryTightnessIndex: 0.1 });
  const records = { CN: record, US: record, EU: record, JP: record, OTHER: record };
  deriveNextQuarterDestinationPriceCoefficients(records, DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1, params);
  assert.equal(JSON.stringify(DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1), before, "baseCoefficientsが変更されてしまっている");
});

// ---------------------------------------------------------------------
// 8. 市場別の性格の違い（重複ロジックなし・共通関数＋パラメータのみ）
// ---------------------------------------------------------------------

test("市場別の性格: 同一の値下がりでもCNの方がJPより購買反応が大きい(purchasePriceElasticityの違いを反映)", () => {
  const cnParams = paramsFor("CN");
  const jpParams = paramsFor("JP");
  const cnCarryNormal = initialCarry("CN");
  const jpCarryNormal = initialCarry("JP");
  const cnCarryCheap: ConsumerMarketCarryState = {
    ...cnCarryNormal,
    priceHistoryUsdPerHosoEqKg: [cnParams.normalPriceUsdPerHosoEqKg, cnParams.normalPriceUsdPerHosoEqKg * 0.7],
  };
  const jpCarryCheap: ConsumerMarketCarryState = {
    ...jpCarryNormal,
    priceHistoryUsdPerHosoEqKg: [jpParams.normalPriceUsdPerHosoEqKg, jpParams.normalPriceUsdPerHosoEqKg * 0.7],
  };
  const cnNormalPlan = planConsumerMarketQuarter(P1, cnCarryNormal, demandInput(), cnParams);
  const cnCheapPlan = planConsumerMarketQuarter(P1, cnCarryCheap, demandInput(), cnParams);
  const jpNormalPlan = planConsumerMarketQuarter(P1, jpCarryNormal, demandInput(), jpParams);
  const jpCheapPlan = planConsumerMarketQuarter(P1, jpCarryCheap, demandInput(), jpParams);

  const cnDeltaRatio = safeRatio(
    unwrapUnit(cnCheapPlan.desiredPurchaseTons) - unwrapUnit(cnNormalPlan.desiredPurchaseTons),
    unwrapUnit(cnNormalPlan.desiredPurchaseTons)
  );
  const jpDeltaRatio = safeRatio(
    unwrapUnit(jpCheapPlan.desiredPurchaseTons) - unwrapUnit(jpNormalPlan.desiredPurchaseTons),
    unwrapUnit(jpNormalPlan.desiredPurchaseTons)
  );
  assert.ok(cnDeltaRatio > jpDeltaRatio, `CNの購買反応がJPより大きくなっていない: CN=${cnDeltaRatio} JP=${jpDeltaRatio}`);
});

// ---------------------------------------------------------------------
// 9. 状態の往復（永続化を想定した純粋なシリアライズ）
// ---------------------------------------------------------------------

test("carry state はJSONへシリアライズ・デシリアライズしても全フィールドが保たれる", () => {
  const carry = initialCarry("JP");
  const roundTripped = JSON.parse(JSON.stringify(carry)) as ConsumerMarketCarryState;
  assert.deepEqual(roundTripped, carry);
});

test("初期状態は同じ入力から決定論的に導出される(乱数を使わない)", () => {
  const a = buildInitialConsumerMarketCarryStateTable({ CN: demandInput(), US: demandInput(), EU: demandInput(), JP: demandInput(), OTHER: demandInput() });
  const b = buildInitialConsumerMarketCarryStateTable({ CN: demandInput(), US: demandInput(), EU: demandInput(), JP: demandInput(), OTHER: demandInput() });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------
// 10. 境界値・安定性
// ---------------------------------------------------------------------

test("境界値: 前期消費ゼロ・需要ショックゼロでもNaN/Infinityが発生しない", () => {
  const params = paramsFor("US");
  const carry = initialCarry("US", demandInput({ priorPeriodConsumption: hosoEqTons(0) }));
  const planning = planConsumerMarketQuarter(P1, carry, demandInput({ priorPeriodConsumption: hosoEqTons(0) }), params, 0);
  assertAllFinite(planning);
  const record = settleConsumerMarketQuarter(planning, hosoEqTons(0), params);
  assertAllFinite(record);
});

test("境界値: 極端な供給不足(実購買量ゼロ・在庫ゼロ)でもNaN/Infinityが発生しない", () => {
  const params = paramsFor("CN");
  const carry: ConsumerMarketCarryState = { ...initialCarry("CN"), openingInventoryTons: hosoEqTons(0) };
  const planning = planConsumerMarketQuarter(P1, carry, demandInput(), params);
  const record = settleConsumerMarketQuarter(planning, hosoEqTons(0), params);
  assertAllFinite(record);
  assert.equal(unwrapUnit(record.endingInventoryTons), 0);
});

test("32四半期連続シミュレーション: 在庫・消費・購買が発散せず、NaN/Infinity/負値が発生しない", () => {
  const params = paramsFor("US");
  let carry = initialCarry("US");
  let p = P1;
  const inventoryHistory: number[] = [];
  for (let i = 0; i < 32; i++) {
    const planning = planConsumerMarketQuarter(p, carry, demandInput(), params);
    assertAllFinite(planning);
    // 実購買量は希望購買量の90%が調達できたと仮定(安定した供給ケース)
    const actual = hosoEqTons(unwrapUnit(planning.desiredPurchaseTons) * 0.9);
    const record = settleConsumerMarketQuarter(planning, actual, params);
    assertAllFinite(record);
    assert.ok(unwrapUnit(record.endingInventoryTons) >= 0, `turn ${i}: 在庫が負`);
    assert.ok(unwrapUnit(record.realizedConsumptionTons) >= 0, `turn ${i}: 消費が負`);
    inventoryHistory.push(unwrapUnit(record.endingInventoryTons));
    carry = rollCarryStateForward(carry, record, params.normalPriceUsdPerHosoEqKg);
    p = nextPeriod(p);
  }
  const maxInventory = Math.max(...inventoryHistory);
  const initialInventory = inventoryHistory[0];
  assert.ok(maxInventory < initialInventory * 20, "在庫が一方向に発散している可能性がある");
});

function assertAllFinite(value: unknown, path = "value"): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} が有限でない: ${value}`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertAllFinite(v, `${path}.${k}`);
  }
}

// ---------------------------------------------------------------------
// 11. 市場価格指数の混合
// ---------------------------------------------------------------------

test("市場価格指数: 商品ミックスの重みで加重平均される", () => {
  const idx = computeBlendedMarketPriceIndex({ hoso: 4, pd: 5, vap: 6 }, { hoso: 1, pd: 1, vap: 0 });
  assert.ok(Math.abs(idx - 4.5) < 1e-9);
});
