// ShrimpX V2 — 産地別PD/VAP加工能力の時間発展（加工品市場進化 §a）のテスト
//
// PCE-1〜PCE-10。パラメータ単体の性質（カーブ・検証・シード変動の有界性）と、
// 実際のシナリオ→市場パイプラインを通した「物語の弧」の両方を検証する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyProcessingCapacityEvolutionToMarketInput,
  assertProcessingCapacityParametersValid,
  computeProcessingCapacityRatios,
  deriveProcessingCapacityVariation,
  PROCESSED_PRODUCTS,
  PROCESSING_CAPACITY_EVOLUTION_PARAMETERS_V1,
  processingCapacityRatio,
  ProcessingCapacityEvolutionParameters,
} from "../processingCapacityEvolution";
import { initializeScenario, getScenarioTurnInput } from "../../scenario/scenarioEngine";
import { toMarketQuarterInput } from "../../scenario/marketAdapter";
import { BASELINE_SCENARIO } from "../../scenario/definitions";
import { PreviousMarketContext } from "../../scenario/types";
import { calculateMarketQuarter } from "../index";
import { MARKET_PARAMETERS_V1 } from "../parameters";
import { createRandomStream } from "../../core/random";
import { COUNTRY_IDS, MarketQuarterInput } from "../types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { applyLifecycleDemandToMarketInput, computeMarketProductMix } from "../productLifecycle";

const PARAMS = PROCESSING_CAPACITY_EVOLUTION_PARAMETERS_V1;

function previousMarketContext(): PreviousMarketContext {
  const priorHosoFobPrice = {} as Record<string, ReturnType<typeof usdPerHosoEqKg>>;
  for (const c of COUNTRY_IDS) priorHosoFobPrice[c] = usdPerHosoEqKg(5.0);
  return {
    priorHosoFobPrice: priorHosoFobPrice as PreviousMarketContext["priorHosoFobPrice"],
    domesticProcurementIntent: hosoEqTons(40000),
  };
}

/** ライフサイクルON＋加工能力進化ONで1四半期分の市場結果を求める（characterizationと同じ順序）。 */
function runEvolvedMarketQuarter(turn: number, seed?: string) {
  const state = initializeScenario(BASELINE_SCENARIO, "canonical", "processed-market-evolution-characterization");
  const base = toMarketQuarterInput(getScenarioTurnInput(state, turn), previousMarketContext());
  const lifecycleAdjusted = applyLifecycleDemandToMarketInput(base, computeMarketProductMix(turn));
  const ratios = computeProcessingCapacityRatios(turn, PARAMS, seed ? deriveProcessingCapacityVariation(seed, PARAMS) : undefined);
  const input: MarketQuarterInput = applyProcessingCapacityEvolutionToMarketInput(lifecycleAdjusted, ratios);
  const result = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream(`processed-market-evolution-${turn}`));
  const hoso = unwrapUnit(result.hosoPrices.VN.price);
  return {
    result,
    ratios,
    pdUtilization: result.pdPremium.globalUtilization,
    vapUtilization: result.vapPremium.globalUtilization,
    /** VN HOSO価格に対するPDプレミアム比率（＝プレミアムの厚み。価格水準の影響を除いた指標）。 */
    pdPremiumRatio: (unwrapUnit(result.pdPremium.byCountry.VN.finalPrice) - hoso) / hoso,
    vapPremiumRatio: (unwrapUnit(result.vapPremium.byCountry.VN.finalPrice) - hoso) / hoso,
  };
}

// ---------------------------------------------------------------------
// パラメータ・カーブ単体
// ---------------------------------------------------------------------

test("PCE-1: 既定パラメータが健全性検証を通る（VAP参入はPD参入より遅い、成熟比率≥初期比率）", () => {
  assert.doesNotThrow(() => assertProcessingCapacityParametersValid(PARAMS));
  for (const country of COUNTRY_IDS) {
    const config = PARAMS.byCountry[country];
    assert.ok(
      config.vap.entryStartTurn >= config.pd.entryStartTurn,
      `${country}: VAP参入(${config.vap.entryStartTurn})はPD参入(${config.pd.entryStartTurn})以降であるべき`
    );
  }
});

test("PCE-2: 不正なパラメータは明示的に例外になる", () => {
  const broken = (patch: (p: ProcessingCapacityEvolutionParameters) => ProcessingCapacityEvolutionParameters) =>
    () => assertProcessingCapacityParametersValid(patch(PARAMS));

  assert.throws(
    broken((p) => ({ ...p, byCountry: { ...p.byCountry, EC: { ...p.byCountry.EC, pd: { ...p.byCountry.EC.pd, matureRatio: 0.01 } } } })),
    /matureRatio/
  );
  assert.throws(
    broken((p) => ({ ...p, byCountry: { ...p.byCountry, EC: { ...p.byCountry.EC, vap: { ...p.byCountry.EC.vap, entryStartTurn: 2 } } } })),
    /VAP参入turn/
  );
  assert.throws(broken((p) => ({ ...p, maxRampSpeedVariation: 1.5 })), /変動幅/);
});

test("PCE-3: 加工能力比率は単調非減少で、初期比率から成熟比率の範囲に収まる", () => {
  for (const country of COUNTRY_IDS) {
    for (const product of PROCESSED_PRODUCTS) {
      const curve = PARAMS.byCountry[country][product];
      let previous = -Infinity;
      for (let turn = 1; turn <= 32; turn += 1) {
        const ratio = processingCapacityRatio(curve, turn, 0, 1, PARAMS);
        assert.ok(ratio >= previous - 1e-12, `${country}.${product} turn=${turn}: 比率が減少した（${previous} → ${ratio}）`);
        assert.ok(ratio >= curve.initialRatio - 1e-12, `${country}.${product} turn=${turn}: 初期比率を下回った`);
        assert.ok(ratio <= curve.matureRatio + 1e-12, `${country}.${product} turn=${turn}: 成熟比率を上回った`);
        previous = ratio;
      }
    }
  }
});

test("PCE-4: 序盤はベトナムが圧倒的な加工優位を持ち、終盤には他産地が追い上げる", () => {
  const early = computeProcessingCapacityRatios(1, PARAMS);
  const late = computeProcessingCapacityRatios(32, PARAMS);

  // turn1: VNのPD加工比率はEC/IN/IDのいずれよりも大きい（EC比では10倍以上）。
  for (const country of ["EC", "IN", "ID"] as const) {
    assert.ok(early.VN.pd > early[country].pd, `turn1: VN.pd(${early.VN.pd}) > ${country}.pd(${early[country].pd})`);
    assert.ok(early.VN.vap > early[country].vap, `turn1: VN.vap > ${country}.vap`);
  }
  assert.ok(early.VN.pd / early.EC.pd >= 10, `turn1: VNのPD優位はEC比10倍以上（実測 ${early.VN.pd / early.EC.pd}倍）`);

  // turn32: ECのPD加工比率はturn1から大きく拡大し、VNに肉薄する。
  assert.ok(late.EC.pd / early.EC.pd >= 5, `turn32: ECのPD加工比率はturn1比5倍以上（実測 ${late.EC.pd / early.EC.pd}倍）`);
  assert.ok(late.EC.pd / late.VN.pd >= 0.8, `turn32: ECのPD加工比率はVNの8割以上まで接近する（実測 ${late.EC.pd / late.VN.pd}）`);

  // VAPは追い上げが限定的（＝終盤の競争軸がVAPへ移る根拠）。
  assert.ok(late.EC.vap / late.VN.vap < 0.5, `turn32: ECのVAP加工比率はVNの半分未満（実測 ${late.EC.vap / late.VN.vap}）`);
});

test("PCE-5: シード変動は参入時期・ランプ速度のみを動かし、参入そのものは必ず起きる", () => {
  const seeds = ["seed-a", "seed-b", "seed-c", "lab-2026-01", "テスト16"];
  for (const seed of seeds) {
    const variation = deriveProcessingCapacityVariation(seed, PARAMS);
    for (const country of COUNTRY_IDS) {
      for (const product of PROCESSED_PRODUCTS) {
        const shift = variation.entryTurnShiftByCountryProduct![country]![product]!;
        const speed = variation.rampSpeedMultiplierByCountryProduct![country]![product]!;
        assert.ok(Math.abs(shift) <= PARAMS.maxEntryTurnShift, `${seed} ${country}.${product}: シフトが上限外（${shift}）`);
        assert.ok(
          speed >= 1 - PARAMS.maxRampSpeedVariation - 1e-12 && speed <= 1 + PARAMS.maxRampSpeedVariation + 1e-12,
          `${seed} ${country}.${product}: ランプ倍率が上限外（${speed}）`
        );
      }
    }
    // どのシードでも、turn32時点でECのPD加工参入は必ず完了に近い水準へ到達する。
    const late = computeProcessingCapacityRatios(32, PARAMS, variation);
    assert.ok(
      late.EC.pd >= PARAMS.byCountry.EC.pd.matureRatio * 0.9,
      `${seed}: turn32でECのPD参入が成熟比率の9割へ到達しない（実測 ${late.EC.pd}）`
    );
  }
  // 同じシードからは常に同じ結果（決定論）。
  assert.deepEqual(deriveProcessingCapacityVariation("seed-a", PARAMS), deriveProcessingCapacityVariation("seed-a", PARAMS));
});

test("PCE-6: 生産量そのものは変更されず、加工能力だけが置き換わる", () => {
  const state = initializeScenario(BASELINE_SCENARIO, "canonical", "pce-6");
  const base = toMarketQuarterInput(getScenarioTurnInput(state, 20), previousMarketContext());
  const ratios = computeProcessingCapacityRatios(20, PARAMS);
  const applied = applyProcessingCapacityEvolutionToMarketInput(base, ratios);

  for (const country of COUNTRY_IDS) {
    assert.equal(
      unwrapUnit(applied.countries[country].production),
      unwrapUnit(base.countries[country].production),
      `${country}: 生産量が変わってはならない`
    );
    const production = unwrapUnit(base.countries[country].production);
    assert.ok(
      Math.abs(unwrapUnit(applied.countries[country].pdProcessingCapacity) - production * ratios[country].pd) < 1e-6,
      `${country}: PD加工能力 = 生産量×比率`
    );
    assert.ok(
      Math.abs(unwrapUnit(applied.countries[country].vapProcessingCapacity) - production * ratios[country].vap) < 1e-6,
      `${country}: VAP加工能力 = 生産量×比率`
    );
  }
  // 需要側・価格側の入力は一切触らない。
  assert.deepEqual(applied.demandMarkets, base.demandMarkets);
  assert.deepEqual(applied.pdVapDemand, base.pdVapDemand);
  assert.deepEqual(applied.priorHosoFobPrice, base.priorHosoFobPrice);
});

// ---------------------------------------------------------------------
// パイプライン統合: 物語の弧
// ---------------------------------------------------------------------

test("PCE-7: 【CHAR-5の反転】PD世界稼働率が終盤に低下し、プレーンPDプレミアムが圧縮される", () => {
  const early = runEvolvedMarketQuarter(1);
  const mid = runEvolvedMarketQuarter(12);
  const late = runEvolvedMarketQuarter(32);

  // 監査時点（加工能力進化なし）は turn1 0.4633 → turn32 0.6998 と**上昇**していた。
  assert.ok(
    late.pdUtilization < early.pdUtilization,
    `PD世界稼働率は終盤に低下すべき（turn1=${early.pdUtilization} turn32=${late.pdUtilization}）`
  );
  assert.ok(
    late.pdUtilization < mid.pdUtilization,
    `PD世界稼働率は中盤ピークから終盤へ低下すべき（turn12=${mid.pdUtilization} turn32=${late.pdUtilization}）`
  );
  // プレミアムの厚み（HOSO価格比）も圧縮される。
  assert.ok(
    late.pdPremiumRatio < early.pdPremiumRatio * 0.9,
    `PDプレミアム比率は終盤に1割以上圧縮されるべき（turn1=${early.pdPremiumRatio} turn32=${late.pdPremiumRatio}）`
  );
});

test("PCE-8: VAPは終盤も逼迫が続き、競争軸がPDからVAPへ移る", () => {
  const early = runEvolvedMarketQuarter(1);
  const late = runEvolvedMarketQuarter(32);

  assert.ok(
    late.vapUtilization > early.vapUtilization,
    `VAP世界稼働率は終盤に上昇すべき（turn1=${early.vapUtilization} turn32=${late.vapUtilization}）`
  );
  assert.ok(late.vapUtilization > 1, `turn32のVAP世界稼働率は1を超える（能力逼迫。実測 ${late.vapUtilization}）`);

  // VAPプレミアムとPDプレミアムの差が、序盤より終盤のほうが大きい＝軸の移動。
  const earlyGap = early.vapPremiumRatio / early.pdPremiumRatio;
  const lateGap = late.vapPremiumRatio / late.pdPremiumRatio;
  assert.ok(lateGap > earlyGap, `VAP/PDプレミアム比は終盤に拡大すべき（turn1=${earlyGap} turn32=${lateGap}）`);
  assert.ok(lateGap >= earlyGap * 1.5, `軸移動として意味のある拡大幅（1.5倍以上）であるべき（実測 ${lateGap / earlyGap}倍）`);
});

test("PCE-9: エクアドルのPD加工参入が理由コードとして発火する", () => {
  const early = runEvolvedMarketQuarter(1);
  const late = runEvolvedMarketQuarter(24);
  assert.ok(
    !early.result.pdPremium.drivers.includes("ECUADOR_PD_CAPACITY_EXPANSION"),
    "序盤はエクアドルPD参入の理由コードが立たない"
  );
  assert.ok(
    late.result.pdPremium.drivers.includes("ECUADOR_PD_CAPACITY_EXPANSION"),
    `終盤はエクアドルPD参入の理由コードが立つ（実測 ${late.result.pdPremium.drivers.join(",")}）`
  );
  assert.ok(
    late.result.pdPremium.drivers.includes("PROCESSING_CAPACITY_OVERSUPPLY"),
    "終盤は加工能力過剰の理由コードも立つ（プレミアム圧縮の説明可能性）"
  );
});

test("PCE-10: 物語の弧はシードによらず成立する（時期と鋭さだけが変わる）", () => {
  for (const seed of ["seed-a", "seed-b", "seed-c", "lab-2026-01"]) {
    const early = runEvolvedMarketQuarter(1, seed);
    const late = runEvolvedMarketQuarter(32, seed);
    assert.ok(late.pdUtilization < early.pdUtilization, `${seed}: PD稼働率の終盤低下が成立しない`);
    assert.ok(late.pdPremiumRatio < early.pdPremiumRatio, `${seed}: PDプレミアム圧縮が成立しない`);
    assert.ok(late.vapUtilization > early.vapUtilization, `${seed}: VAP稼働率の終盤上昇が成立しない`);
    assert.ok(
      late.vapPremiumRatio / late.pdPremiumRatio > early.vapPremiumRatio / early.pdPremiumRatio,
      `${seed}: VAPへの軸移動が成立しない`
    );
  }
});
