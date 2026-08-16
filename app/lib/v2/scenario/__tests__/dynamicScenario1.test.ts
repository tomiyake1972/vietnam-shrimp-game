// Dynamic Scenario 1 — シナリオ定義のテスト
//
// 検証の主眼:
//  1. News と effect 開始ターンの同期（予兆ニュースのターンで効果が厳密に0）
//  2. 原料の4局面（T1–4国内安 / T7–10輸入有利 / 主漁期国内安 / 端境期輸入有利）
//  3. 市場×商品構造（China は T24 まで Japan より小さい・Others の隠れ成長）
//  4. 既存5シナリオへ影響していないこと
//  5. プレイヤー向けシナリオ選択肢へ露出していないこと

import test from "node:test";
import assert from "node:assert/strict";

import { DYNAMIC_SCENARIO_1 } from "../definitions/dynamicScenario1";
import { DEVELOPMENT_SCENARIO_DEFINITIONS } from "../definitions";
import { ALL_SCENARIO_DEFINITIONS } from "../definitions";
import { DS1_NEWS_EFFECT_SYNC, DS1_INFORMATION_RELEASES, DS1_NEWS_SPECS, DS1_CN_HOSO_SPIKE_TURNS } from "../definitions/dynamicScenario1News";
import { DS1_REGIONAL_DEMAND_KEYFRAMES } from "../definitions/dynamicScenario1Parameters";
import { validateScenarioDefinition } from "../validation";
import { initializeScenario, getScenarioTurnInput } from "../scenarioEngine";
import { eventIntensityAtTurn } from "../eventEngine";
import { getAvailableInformation } from "../informationEngine";
import { resolveScenarioProductLifecycleParameters } from "../lifecycle";
import { computeMarketProductMix } from "../../market/productLifecycle";
import { calculateMarketQuarter, MARKET_PARAMETERS_V1 } from "../../market";
import { calculateLandedPrice } from "../../rawMaterials/imports";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../../rawMaterials/parameters";
import { toMarketQuarterInput } from "../marketAdapter";
import { COUNTRY_IDS, CountryId, DEMAND_MARKET_IDS } from "../../market/types";
import { unwrapUnit, usdPerHosoEqKg, hosoEqTons } from "../../core/units";
import { calculateExternalProcessorIntent } from "../../companyLab/externalDemand";
import { applyScenarioRequiredCapabilities } from "../../companyLab/runner";
import { BASELINE_SCENARIO } from "../definitions/baseline";
import { EXTERNAL_PROCESSOR_DEMAND_ASSUMPTIONS_V1, REFERENCE_WORLD_CONSUMPTION_TONS } from "../../companyLab/parameters";

const TURNS = DYNAMIC_SCENARIO_1.durationTurns;

test("DS1: 定義が検証を通る", () => {
  const result = validateScenarioDefinition(DYNAMIC_SCENARIO_1);
  assert.equal(result.valid, true, result.errors.join("\n"));
});

test("DS1: 32ターン通しで getScenarioTurnInput が例外なく値を返す", () => {
  const state = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "ds1-test");
  for (let turn = 1; turn <= TURNS; turn++) {
    const input = getScenarioTurnInput(state, turn);
    assert.equal(input.turn, turn);
    assert.ok(unwrapUnit(input.countries.VN.production) > 0, `turn ${turn}: VN production`);
  }
});

// ---------------------------------------------------------------------
// 1. News ↔ effect 同期
// ---------------------------------------------------------------------

test("DS1: 予兆ニュースのターンでは対応イベントの発現強度が厳密に0", () => {
  const state = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "ds1-test");
  for (const sync of DS1_NEWS_EFFECT_SYNC.filter((s) => s.leadQuarters > 0)) {
    const resolved = state.resolvedEvents.find((e) => e.source.eventId === sync.eventId);
    assert.ok(resolved, `event ${sync.eventId} が存在しない`);
    assert.equal(
      eventIntensityAtTurn(resolved, sync.newsTurn),
      0,
      `${sync.informationId}: turn ${sync.newsTurn} で ${sync.eventId} の強度が0でない（予兆のはずが既に効いている）`
    );
    assert.ok(
      eventIntensityAtTurn(resolved, sync.effectStartTurn) > 0,
      `${sync.informationId}: turn ${sync.effectStartTurn} で ${sync.eventId} がまだ発現していない`
    );
    assert.equal(sync.effectStartTurn - sync.newsTurn, sync.leadQuarters, `${sync.informationId}: leadQuarters が宣言と一致しない`);
  }
});

test("DS1: 確報ニュースのターンでは対応イベントが既に発現している", () => {
  const state = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "ds1-test");
  for (const sync of DS1_NEWS_EFFECT_SYNC.filter((s) => s.leadQuarters === 0)) {
    const resolved = state.resolvedEvents.find((e) => e.source.eventId === sync.eventId);
    assert.ok(resolved, `event ${sync.eventId} が存在しない`);
    assert.ok(
      eventIntensityAtTurn(resolved, sync.newsTurn) > 0,
      `${sync.informationId}: turn ${sync.newsTurn} で ${sync.eventId} がまだ発現していない`
    );
  }
});

test("DS1: 同期表が参照する informationId / eventId が実在する", () => {
  const infoIds = new Set(DS1_INFORMATION_RELEASES.map((r) => r.informationId));
  const eventIds = new Set(DYNAMIC_SCENARIO_1.scheduledEvents.map((e) => e.eventId));
  for (const sync of DS1_NEWS_EFFECT_SYNC) {
    assert.ok(infoIds.has(sync.informationId), `informationId ${sync.informationId} が存在しない`);
    assert.ok(eventIds.has(sync.eventId), `eventId ${sync.eventId} が存在しない`);
  }
});

test("DS1: 全32ターンに1〜4件のNewsがある", () => {
  for (let turn = 1; turn <= TURNS; turn++) {
    const available = DS1_INFORMATION_RELEASES.filter((r) => r.availableFromTurn === turn);
    assert.ok(available.length >= 1, `turn ${turn} にNewsが無い`);
    // 原則1〜3件。重要ターンのみ4件まで許容する（読み切れない量にしない）。
    assert.ok(available.length <= 4, `turn ${turn} のNewsが4件を超える（${available.length}件）`);
  }
});

test("DS1: 未来のNewsは決して公開されない", () => {
  for (let turn = 1; turn <= TURNS; turn++) {
    for (const release of getAvailableInformation(DS1_INFORMATION_RELEASES, turn, "standard")) {
      assert.ok(release.availableFromTurn <= turn, `turn ${turn} で未来のNews ${release.informationId} が公開された`);
    }
  }
});

test("DS1: プレイヤー向けNewsに postGameTruth が混ざらない", () => {
  for (let turn = 1; turn <= TURNS; turn++) {
    for (const release of getAvailableInformation(DS1_INFORMATION_RELEASES, turn, "standard")) {
      assert.equal(release.postGameTruth, undefined, `${release.informationId} に postGameTruth が残っている`);
    }
  }
});

test("DS1: T32のNewsが終了を示唆しない（残りターン数を悟らせない）", () => {
  const t32 = DS1_INFORMATION_RELEASES.filter((r) => r.availableFromTurn === TURNS);
  assert.ok(t32.length > 0);
  for (const r of t32) {
    for (const forbidden of ["最終", "終了", "最後", "ラスト"]) {
      assert.ok(!r.headlineTemplate.includes(forbidden), `${r.informationId} が終了を示唆している: ${r.headlineTemplate}`);
    }
  }
});

// ---------------------------------------------------------------------
// 2. 原料の4局面
// ---------------------------------------------------------------------

/**
 * シナリオが生成する当該ターンの世界を、市場モジュールへそのまま通して
 * 国内原料価格と輸入着地コストを測る。
 *
 * 【買付意向の作り方】国内価格は「供給」だけでなく「買付意向 / 供給」の需給比で
 * 決まる。買付意向を当期供給に比例させてしまうと需給比が一定になり、季節的な
 * 供給変動が価格へ現れなくなる（＝測り方が現実と食い違う）。
 * そのため runner.ts と同じく、基準供給量にアンカーされた外部加工業者需要
 * （calculateExternalProcessorIntent）＋5社ぶんの代表値で組み立てる。
 * ここで新しい経済ロジックは作らず、既存の関数をそのまま使う。
 *
 * 会社ごとの意思決定は含まないため絶対値はゲーム本体と一致しないが、
 * 「国内と輸入のどちらが有利か」という比較には使える。
 */
const FIVE_COMPANY_INTENT_TONS = 80000;

function measureProcurement(targetTurn: number) {
  const state = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "ds1-test");
  const priorFob = {} as Record<CountryId, number>;
  for (const c of COUNTRY_IDS) priorFob[c] = DYNAMIC_SCENARIO_1.prehistory.priorHosoFobPriceUsdPerKg[c];
  let priorDomesticPrice: number | undefined;

  let last!: ReturnType<typeof calculateMarketQuarter>;
  for (let turn = 1; turn <= targetTurn; turn++) {
    const scenarioInput = getScenarioTurnInput(state, turn);
    const worldDemandIndex =
      DEMAND_MARKET_IDS.reduce(
        (sum, m) => sum + unwrapUnit(scenarioInput.demandMarkets[m].priorPeriodConsumption) * scenarioInput.demandMarkets[m].economicIndex,
        0
      ) / REFERENCE_WORLD_CONSUMPTION_TONS;
    const externalIntent = unwrapUnit(
      calculateExternalProcessorIntent({ priorVietnamDomesticPrice: priorDomesticPrice, worldDemandIndex }, EXTERNAL_PROCESSOR_DEMAND_ASSUMPTIONS_V1)
    );
    const input = toMarketQuarterInput(scenarioInput, {
      priorHosoFobPrice: Object.fromEntries(COUNTRY_IDS.map((c) => [c, usdPerHosoEqKg(priorFob[c])])) as never,
      domesticProcurementIntent: hosoEqTons(externalIntent + FIVE_COMPANY_INTENT_TONS),
    });
    last = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, { next: () => 0.5 } as never);
    for (const c of COUNTRY_IDS) priorFob[c] = unwrapUnit(last.hosoPrices[c].price);
    priorDomesticPrice = unwrapUnit(last.vietnamDomestic.price);
  }

  const domestic = unwrapUnit(last.vietnamDomestic.price);
  const inLanded = unwrapUnit(calculateLandedPrice(last.hosoPrices.IN.price, "IN", RAW_MATERIALS_PARAMETERS_V1).landedPrice);
  const ecLanded = unwrapUnit(calculateLandedPrice(last.hosoPrices.EC.price, "EC", RAW_MATERIALS_PARAMETERS_V1).landedPrice);
  const cheapestImport = Math.min(inLanded, ecLanded);
  return { domestic, cheapestImport, gapRatio: (domestic - cheapestImport) / cheapestImport, result: last };
}

test("DS1: T1–4 は国内原料が輸入より明確に安い（成功体験を作る局面）", () => {
  for (const turn of [1, 2, 3, 4]) {
    const m = measureProcurement(turn);
    assert.ok(m.gapRatio < -0.1, `turn ${turn}: 国内 ${m.domestic.toFixed(3)} vs 輸入 ${m.cheapestImport.toFixed(3)} (${(m.gapRatio * 100).toFixed(1)}%)`);
  }
});

test("DS1: T6 はまだ国内の方が安い（予兆だけで実害が出ていない）", () => {
  const m = measureProcurement(6);
  assert.ok(m.gapRatio < 0, `turn 6: 国内 ${m.domestic.toFixed(3)} vs 輸入 ${m.cheapestImport.toFixed(3)}`);
});

test("DS1: T7–9 は輸入が有利になる（原料ショック）", () => {
  for (const turn of [7, 8, 9]) {
    const m = measureProcurement(turn);
    assert.ok(m.gapRatio > 0, `turn ${turn}: 国内 ${m.domestic.toFixed(3)} vs 輸入 ${m.cheapestImport.toFixed(3)} (${(m.gapRatio * 100).toFixed(1)}%)`);
  }
});

test("DS1: T7 ショックは国内原料の取引量も大きく減らす（価格だけでなく調達未達も起きる）", () => {
  const before = measureProcurement(5);
  const during = measureProcurement(8);
  const beforeVolume = unwrapUnit(before.result.vietnamDomestic.transactedVolume);
  const duringVolume = unwrapUnit(during.result.vietnamDomestic.transactedVolume);
  assert.ok(duringVolume < beforeVolume * 0.75, `取引量 ${beforeVolume.toFixed(0)} → ${duringVolume.toFixed(0)}`);
});

test("DS1: T13 以降は主漁期に国内が安く、端境期に国内が割高へ振れる（調達タイミング判断）", () => {
  // Q3 = 主漁期（稼働率1.00）、Q1 = 端境期（稼働率0.62）。
  // T27–28 は好況期のベトナム疾病イベントが重なる四半期なので、
  // 「季節だけ」を見るこのテストの対象からは外す（疾病で主漁期が高くなるのは
  // 設計どおりの挙動であり、別のテストで確認する）。
  const peakTurns = [15, 19, 23, 31].filter((t) => t <= TURNS);
  const leanTurns = [13, 17, 21, 25, 29].filter((t) => t <= TURNS);

  const peakGaps = peakTurns.map((t) => measureProcurement(t).gapRatio);
  const leanGaps = leanTurns.map((t) => measureProcurement(t).gapRatio);

  // 主漁期は必ず国内が安い
  for (let i = 0; i < peakTurns.length; i++) {
    assert.ok(peakGaps[i] < -0.05, `主漁期 turn ${peakTurns[i]}: gap ${(peakGaps[i] * 100).toFixed(1)}% が十分に国内有利でない`);
  }
  // 端境期は主漁期の最悪値より必ず国内が割高側へ振れる（季節変動が効いている）
  const worstPeak = Math.max(...peakGaps);
  for (let i = 0; i < leanTurns.length; i++) {
    assert.ok(
      leanGaps[i] > worstPeak,
      `端境期 turn ${leanTurns[i]}: gap ${(leanGaps[i] * 100).toFixed(1)}% が主漁期の最悪値 ${(worstPeak * 100).toFixed(1)}% を上回らない`
    );
  }
  // 複数の端境期で輸入が明確に有利になる（調達切替が現実の判断になる）
  const crossings = leanGaps.filter((g) => g > 0).length;
  assert.ok(crossings >= 2, `端境期に輸入有利となるターンが${crossings}件しかない: ${leanGaps.map((g) => (g * 100).toFixed(1)).join(", ")}%`);
});

test("DS1: 好況期のベトナム疾病（T27–28）は主漁期であっても輸入を有利にする", () => {
  const m = measureProcurement(27);
  assert.ok(m.gapRatio > 0, `turn 27: 国内 ${m.domestic.toFixed(3)} vs 輸入 ${m.cheapestImport.toFixed(3)} (${(m.gapRatio * 100).toFixed(1)}%)`);
});

// ---------------------------------------------------------------------
// 3. 市場×商品の構造
// ---------------------------------------------------------------------

function structuralDemand(turn: number, market: (typeof DEMAND_MARKET_IDS)[number], product: "hoso" | "pd" | "vap"): number {
  const state = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "ds1-test");
  const scenarioInput = getScenarioTurnInput(state, turn);
  const mix = computeMarketProductMix(turn, resolveScenarioProductLifecycleParameters(DYNAMIC_SCENARIO_1));
  return unwrapUnit(scenarioInput.demandMarkets[market].priorPeriodConsumption) * mix[market][product];
}

test("DS1: China の PD/VAP は T24 まで Japan より小さい（指示 §14）", () => {
  for (const turn of [1, 8, 16, 20, 24]) {
    assert.ok(
      structuralDemand(turn, "CN", "pd") < structuralDemand(turn, "JP", "pd"),
      `turn ${turn}: CN PD ${structuralDemand(turn, "CN", "pd").toFixed(0)} >= JP PD ${structuralDemand(turn, "JP", "pd").toFixed(0)}`
    );
    assert.ok(
      structuralDemand(turn, "CN", "vap") < structuralDemand(turn, "JP", "vap"),
      `turn ${turn}: CN VAP ${structuralDemand(turn, "CN", "vap").toFixed(0)} >= JP VAP ${structuralDemand(turn, "JP", "vap").toFixed(0)}`
    );
  }
});

test("DS1: China の PD/VAP は T25 以降に急成長し T32 で Japan を大きく超える", () => {
  assert.ok(structuralDemand(32, "CN", "pd") > structuralDemand(32, "JP", "pd") * 2, "T32 CN PD");
  assert.ok(structuralDemand(32, "CN", "vap") > structuralDemand(32, "JP", "vap"), "T32 CN VAP");
  // T24 → T32 で大きく伸びる
  assert.ok(structuralDemand(32, "CN", "pd") > structuralDemand(24, "CN", "pd") * 3, "CN PD の成長倍率");
});

test("DS1: China は T1〜24 を通じて HOSO 中心の市場であり続ける", () => {
  for (const turn of [1, 8, 16, 24]) {
    const hoso = structuralDemand(turn, "CN", "hoso");
    const pd = structuralDemand(turn, "CN", "pd");
    const vap = structuralDemand(turn, "CN", "vap");
    assert.ok(hoso > (pd + vap) * 5, `turn ${turn}: CN HOSO ${hoso.toFixed(0)} が PD+VAP ${(pd + vap).toFixed(0)} の5倍を下回る`);
  }
});

test("DS1: Japan の VAP は T7 以降に成長する", () => {
  assert.ok(structuralDemand(16, "JP", "vap") > structuralDemand(6, "JP", "vap") * 2, "JP VAP T6→T16");
});

test("DS1: Others の PD/VAP は T16 まで小規模、T17〜20 で大きく成長する（隠れた機会）", () => {
  const vapT16 = structuralDemand(16, "OTHER", "vap");
  const vapT20 = structuralDemand(20, "OTHER", "vap");
  const pdT16 = structuralDemand(16, "OTHER", "pd");
  const pdT20 = structuralDemand(20, "OTHER", "pd");
  assert.ok(vapT20 > vapT16 * 3, `OTHER VAP T16 ${vapT16.toFixed(0)} → T20 ${vapT20.toFixed(0)}`);
  assert.ok(pdT20 > pdT16 * 1.3, `OTHER PD T16 ${pdT16.toFixed(0)} → T20 ${pdT20.toFixed(0)}`);
});

test("DS1: T17〜20 は主要4市場の構造需要が落ち、Others は落ちない", () => {
  const state = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "ds1-test");
  const at = (turn: number, market: (typeof DEMAND_MARKET_IDS)[number]) =>
    unwrapUnit(getScenarioTurnInput(state, turn).demandMarkets[market].priorPeriodConsumption);
  for (const market of ["CN", "US", "EU", "JP"] as const) {
    assert.ok(at(18, market) < at(15, market), `${market}: T15 ${at(15, market).toFixed(0)} → T18 ${at(18, market).toFixed(0)}`);
  }
  assert.ok(at(18, "OTHER") > at(15, "OTHER"), `OTHER: T15 ${at(15, "OTHER").toFixed(0)} → T18 ${at(18, "OTHER").toFixed(0)}`);
});

test("DS1: 需要ショック期の景気指数は水準として読める（複利にならない）", () => {
  const state = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "ds1-test");
  // T17〜20 の景気指数はショック倍率 0.65 が乗った水準であり、ターンを追うごとに
  // 累積して落ち続けることはない（T20 が T17 より極端に低くならない）。
  const idx = (turn: number) => getScenarioTurnInput(state, turn).demandMarkets.US.economicIndex;
  assert.ok(idx(20) > idx(17) * 0.9, `T17 ${idx(17).toFixed(3)} → T20 ${idx(20).toFixed(3)} が累積的に落ちている`);
});

// ---------------------------------------------------------------------
// 4. 既存シナリオへの非影響 / 露出制御
// ---------------------------------------------------------------------

test("DS1: プレイヤー向けシナリオ一覧（ALL_SCENARIO_DEFINITIONS）には含まれない", () => {
  assert.ok(
    !ALL_SCENARIO_DEFINITIONS.some((d) => d.scenarioId === DYNAMIC_SCENARIO_1.scenarioId),
    "開発中シナリオがプレイヤー向け選択肢へ露出している"
  );
  assert.ok(DEVELOPMENT_SCENARIO_DEFINITIONS.some((d) => d.scenarioId === DYNAMIC_SCENARIO_1.scenarioId));
});

test("DS1: 既存5シナリオは productLifecycleOverrides も structuralDemandAnchor も持たない", () => {
  for (const definition of ALL_SCENARIO_DEFINITIONS) {
    assert.equal(definition.productLifecycleOverrides, undefined, definition.scenarioId);
    assert.equal(definition.structuralDemandAnchor, undefined, definition.scenarioId);
  }
});

test("DS1: canonical mode は乱数を消費しない（完全再現性）", () => {
  const a = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "seed-a");
  const b = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "seed-b");
  assert.deepEqual(
    a.resolvedEvents.map((e) => [e.resolvedStartTurn, e.resolvedDurationTurns, e.resolvedMagnitudeScale]),
    b.resolvedEvents.map((e) => [e.resolvedStartTurn, e.resolvedDurationTurns, e.resolvedMagnitudeScale])
  );
});

test("DS1: 構造需要トレンドの keyframe は全市場で単調な turn 昇順", () => {
  for (const market of DEMAND_MARKET_IDS) {
    const kfs = DS1_REGIONAL_DEMAND_KEYFRAMES[market];
    for (let i = 1; i < kfs.length; i++) {
      assert.ok(kfs[i][0] > kfs[i - 1][0], `${market} keyframe ${i}`);
    }
  }
});


// ---------------------------------------------------------------------
// 5. 必要機能の宣言（Console 等でフラグ設定漏れが起きても世界が変わらないこと）
// ---------------------------------------------------------------------

const BASE_CONFIG = { scenarioId: "x", mode: "canonical", seed: "s", turns: 32 } as const;

test("DS1: 必要機能を宣言しており、呼び出し側が未設定でも有効になる", () => {
  const merged = applyScenarioRequiredCapabilities(BASE_CONFIG, DYNAMIC_SCENARIO_1);
  assert.equal(merged.sai5?.productLifecycle, true);
  assert.equal(merged.sai5?.supplyPremiumFeedback, true);
  assert.equal(merged.sai5?.salesBaseAccumulation, true);
});

test("宣言を持たないシナリオでは config がそのまま返る（同一参照＝既存挙動と一致）", () => {
  assert.equal(applyScenarioRequiredCapabilities(BASE_CONFIG, BASELINE_SCENARIO), BASE_CONFIG);
});

test("シナリオ宣言は、呼び出し側が明示的に有効化した機能を無効化できない", () => {
  const withExtra = { ...BASE_CONFIG, sai5: { vapProductDevelopmentCompetitiveness: false, productLifecycle: true } } as const;
  const merged = applyScenarioRequiredCapabilities(withExtra, DYNAMIC_SCENARIO_1);
  // 呼び出し側の設定は保持される
  assert.equal(merged.sai5?.vapProductDevelopmentCompetitiveness, false);
  // シナリオが必要とする機能は有効
  assert.equal(merged.sai5?.productLifecycle, true);
  assert.equal(merged.sai5?.supplyPremiumFeedback, true);
});

test("DS1: productLifecycleOverrides を持つなら productLifecycle の宣言が必須（設定漏れ防止）", () => {
  // 上書きを持ちながら機能宣言が無いと、世界一律の固定構成比で走ってしまう。
  // この不整合を定義追加時に必ず検出する。
  for (const definition of [DYNAMIC_SCENARIO_1, ...DEVELOPMENT_SCENARIO_DEFINITIONS, ...ALL_SCENARIO_DEFINITIONS]) {
    if (definition.productLifecycleOverrides !== undefined) {
      assert.equal(
        definition.requiredCapabilities?.productLifecycle,
        true,
        `${definition.scenarioId}: productLifecycleOverrides があるのに productLifecycle を宣言していない`
      );
    }
  }
});


// ---------------------------------------------------------------------
// 6. News 本文の品質（プレイヤーが読む記事としての最低条件）
// ---------------------------------------------------------------------

test("News: 全記事に本文がある", () => {
  for (const r of DS1_INFORMATION_RELEASES) {
    assert.ok(r.body !== undefined && r.body.length > 0, `${r.informationId} に本文が無い`);
  }
});

test("News: 本文の分量が記事クラスの目安に収まっている", () => {
  // #04 指示の目安: major 250–450字 / normal 150–300字 / background 100–220字。
  // 厳密な制限ではないため、上下に少し余裕を持たせて「明らかな逸脱」だけを検出する。
  const BOUNDS: Record<string, readonly [number, number]> = {
    major: [230, 520],
    normal: [140, 340],
    background: [90, 240],
  };
  for (const spec of DS1_NEWS_SPECS) {
    const [min, max] = BOUNDS[spec.scale];
    const len = spec.body.length;
    assert.ok(len >= min, `${spec.id}(${spec.scale}): 本文が短すぎる ${len}字 < ${min}字`);
    assert.ok(len <= max, `${spec.id}(${spec.scale}): 本文が長すぎる ${len}字 > ${max}字`);
  }
});

test("News: 見出しと本文に重複がない（言い換えただけの記事を作らない）", () => {
  const headlines = new Set<string>();
  const bodies = new Set<string>();
  for (const spec of DS1_NEWS_SPECS) {
    assert.ok(!headlines.has(spec.headline), `見出しが重複: ${spec.headline}`);
    assert.ok(!bodies.has(spec.body), `本文が重複: ${spec.id}`);
    headlines.add(spec.headline);
    bodies.add(spec.body);
  }
});

test("News: 記事IDが一意である", () => {
  const ids = new Set<string>();
  for (const spec of DS1_NEWS_SPECS) {
    assert.ok(!ids.has(spec.id), `IDが重複: ${spec.id}`);
    ids.add(spec.id);
  }
});

test("News: 内部パラメータ・将来の答えを本文へ書いていない", () => {
  // シナリオ内部の用語や、将来の効果を断定する表現が本文へ漏れていないか。
  const FORBIDDEN = [
    "倍率", "magnitude", "accelStart", "pullStrength", "productLifecycle",
    "シナリオ", "ターン", "turn", "来期は必ず", "確実に上昇", "確実に下落",
    "signalStrength", "hiddenImportance",
  ];
  for (const spec of DS1_NEWS_SPECS) {
    for (const word of FORBIDDEN) {
      assert.ok(!spec.body.includes(word), `${spec.id}: 本文に "${word}" が含まれる`);
      assert.ok(!spec.headline.includes(word), `${spec.id}: 見出しに "${word}" が含まれる`);
    }
  }
});

test("News: 予兆記事が将来を断定していない", () => {
  const ASSERTIVE = ["будет", "必ず", "間違いなく", "決まった", "確定した"];
  for (const spec of DS1_NEWS_SPECS.filter((s) => s.isRumor)) {
    for (const word of ASSERTIVE) {
      assert.ok(!spec.body.includes(word), `${spec.id}（予兆記事）が断定表現 "${word}" を含む`);
    }
  }
});

test("News: signal class が strong だけに偏っていない（noise が混ざっている）", () => {
  const counts = { strong: 0, weak: 0, background: 0 };
  for (const spec of DS1_NEWS_SPECS) counts[spec.signalClass] += 1;
  const total = DS1_NEWS_SPECS.length;
  assert.ok(counts.background >= total * 0.15, `background が少なすぎる: ${counts.background}/${total}`);
  assert.ok(counts.strong <= total * 0.7, `strong に偏りすぎ: ${counts.strong}/${total}`);
  assert.ok(counts.weak >= 5, `weak signal が少なすぎる: ${counts.weak}`);
});

test("News: 内部メタデータがプレイヤー向け InformationRelease へ漏れていない", () => {
  for (const r of DS1_INFORMATION_RELEASES) {
    const keys = Object.keys(r);
    for (const leaked of ["signalClass", "scale", "market", "product", "origin", "scenarioRelevance", "futureEffectTurn"]) {
      assert.ok(!keys.includes(leaked), `${r.informationId}: ${leaked} が公開データへ漏れている`);
    }
  }
});

test("News: China HOSO スパイクは全ターンぶん記事がある", () => {
  for (const turn of DS1_CN_HOSO_SPIKE_TURNS) {
    const article = DS1_NEWS_SPECS.find((s) => s.turn === turn && s.market === "CN" && s.product === "hoso");
    assert.ok(article, `turn ${turn} の China HOSO スパイク記事が無い`);
    // 「行けば儲かる」と読ませないため、他産地の動きを必ず併記する。
    assert.ok(
      article.body.includes("中国向け出荷が増えている") || article.body.includes("中国向け出荷増加"),
      `turn ${turn}: 他産地の動きへの言及が無い`
    );
  }
});

test("News: Others の隠れた機会を数字で明かしていない", () => {
  const othersArticles = DS1_NEWS_SPECS.filter((s) => s.market === "OTHER");
  assert.ok(othersArticles.length >= 4, `Others 関連記事が少なすぎる: ${othersArticles.length}`);
  for (const spec of othersArticles) {
    for (const word of ["急成長", "倍増", "4倍", "3倍", "%増"]) {
      assert.ok(!spec.body.includes(word), `${spec.id}: Others の成長を露骨に書いている（"${word}"）`);
      assert.ok(!spec.headline.includes(word), `${spec.id}: 見出しが露骨（"${word}"）`);
    }
  }
});

test("News: China premiumization を数字で予告していない", () => {
  for (const spec of DS1_NEWS_SPECS.filter((s) => s.market === "CN")) {
    for (const word of ["4倍", "急拡大する見込み", "来期から", "倍増"]) {
      assert.ok(!spec.body.includes(word), `${spec.id}: China の将来を断定的に書いている（"${word}"）`);
    }
  }
});
