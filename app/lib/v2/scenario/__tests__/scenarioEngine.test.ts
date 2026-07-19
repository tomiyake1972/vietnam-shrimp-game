import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeScenario, getScenarioTurnInput, advanceScenarioTurn } from "../scenarioEngine";
import { unwrapUnit } from "../../core/units";
import { COUNTRY_IDS, DEMAND_MARKET_IDS } from "../../market/types";
import { testScenarioDefinition, testEvent, testTrend } from "./fixtures";

test("initializeScenario: currentTurn=1・turnHistory=[]で初期化される", () => {
  const state = initializeScenario(testScenarioDefinition(), "canonical", "seed-init");
  assert.equal(state.currentTurn, 1);
  assert.deepEqual(state.turnHistory, []);
  assert.equal(state.mode, "canonical");
});

test("initializeScenario: 不正な定義は例外を投げる", () => {
  assert.throws(() => initializeScenario(testScenarioDefinition({ durationTurns: 1 }), "canonical", "seed"));
});

test("initializeScenario: allowedModesに無いmodeを指定すると例外を投げる", () => {
  const definition = testScenarioDefinition({
    variationSettings: { allowedModes: ["canonical"], defaultMode: "canonical" },
  });
  assert.throws(() => initializeScenario(definition, "variation", "seed"));
});

test("getScenarioTurnInput: turnが1〜durationTurnsの範囲外なら例外", () => {
  const state = initializeScenario(testScenarioDefinition({ durationTurns: 24 }), "canonical", "seed");
  assert.throws(() => getScenarioTurnInput(state, 0));
  assert.throws(() => getScenarioTurnInput(state, 25));
  assert.doesNotThrow(() => getScenarioTurnInput(state, 1));
  assert.doesNotThrow(() => getScenarioTurnInput(state, 24));
});

test("getScenarioTurnInput: Year1 Q1（turn=1）は2015Q1になる（前史からの初期状態）", () => {
  const state = initializeScenario(testScenarioDefinition(), "canonical", "seed");
  const input = getScenarioTurnInput(state, 1);
  assert.equal(input.period, "2015Q1");
});

test("getScenarioTurnInput: turnが進むとPeriodも進む", () => {
  const state = initializeScenario(testScenarioDefinition({ durationTurns: 24 }), "canonical", "seed");
  assert.equal(getScenarioTurnInput(state, 4).period, "2015Q4");
  assert.equal(getScenarioTurnInput(state, 5).period, "2016Q1");
  assert.equal(getScenarioTurnInput(state, 24).period, "2020Q4");
});

test("全期間・全国・全市場でNaN/Infinity/負値が出力されない", () => {
  const definition = testScenarioDefinition({
    durationTurns: 24,
    scheduledEvents: [
      testEvent({
        eventId: "e1",
        targetCountries: ["EC", "VN"],
        startTurn: 5,
        effects: [
          { variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: -0.5 },
          { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: 1.5 },
        ],
      }),
    ],
    longTermTrends: [testTrend({ trendId: "t1", variable: "COUNTRY_CAPACITY", scope: { kind: "country", countryId: "IN" } })],
  });
  const state = initializeScenario(definition, "canonical", "seed-nan-check");

  for (let turn = 1; turn <= 24; turn++) {
    const input = getScenarioTurnInput(state, turn);
    for (const c of COUNTRY_IDS) {
      const cv = input.countries[c];
      for (const [key, value] of Object.entries(cv)) {
        if (typeof value === "number") {
          assert.ok(Number.isFinite(value), `${c}.${key} が有限数ではない: ${value}`);
        }
      }
      assert.ok(unwrapUnit(cv.production) >= 0);
    }
    for (const m of DEMAND_MARKET_IDS) {
      const mv = input.demandMarkets[m];
      assert.ok(Number.isFinite(mv.economicIndex));
      assert.ok(Number.isFinite(mv.populationGrowthRate));
      assert.ok(unwrapUnit(mv.priorPeriodConsumption) >= 0);
    }
    assert.ok(Number.isFinite(unwrapUnit(input.vietnamDomesticRawSupply)));
    assert.ok(Number.isFinite(unwrapUnit(input.pdVapDemand.pdDemand)));
    assert.ok(Number.isFinite(unwrapUnit(input.pdVapDemand.vapDemand)));
  }
});

test("入力のdefinition・stateは変更しない", () => {
  const definition = testScenarioDefinition({ durationTurns: 24 });
  const definitionBefore = JSON.parse(JSON.stringify(definition));
  const state = initializeScenario(definition, "canonical", "seed");
  const stateBefore = JSON.parse(JSON.stringify(state));

  getScenarioTurnInput(state, 10);
  advanceScenarioTurn(state, { externalProducerResponses: [{ countryId: "VN", stockingAdjustmentRatio: 1.1, rationale: "test" }] });

  assert.deepEqual(JSON.parse(JSON.stringify(definition)), definitionBefore);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), stateBefore);
});

test("疾病による生残率低下は供給見通し（production）を増やさない", () => {
  const withoutDisease = initializeScenario(testScenarioDefinition({ durationTurns: 24 }), "canonical", "seed-a");
  const withDisease = initializeScenario(
    testScenarioDefinition({
      durationTurns: 24,
      scheduledEvents: [
        testEvent({
          eventId: "disease",
          targetCountries: ["VN"],
          startTurn: 5,
          durationTurns: 3,
          rampUpTurns: 0,
          recoveryTurns: 0,
          effects: [{ variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: -0.18 }],
        }),
      ],
    }),
    "canonical",
    "seed-a"
  );

  const baseline = unwrapUnit(getScenarioTurnInput(withoutDisease, 6).countries.VN.production);
  const withEvent = unwrapUnit(getScenarioTurnInput(withDisease, 6).countries.VN.production);
  assert.ok(withEvent < baseline, `疾病発生時のproductionは基準より小さいはず: ${withEvent} < ${baseline}`);
});

test("供給拡大イベント（稼働率+）は対象国のproductionを減らさない", () => {
  const withoutExpansion = initializeScenario(testScenarioDefinition({ durationTurns: 24 }), "canonical", "seed-b");
  const withExpansion = initializeScenario(
    testScenarioDefinition({
      durationTurns: 24,
      scheduledEvents: [
        testEvent({
          eventId: "expansion",
          eventType: "CAPACITY_EXPANSION",
          targetCountries: ["EC"],
          startTurn: 5,
          durationTurns: 15,
          rampUpTurns: 0,
          recoveryTurns: 0,
          effects: [{ variable: "UTILIZATION_RATE", mode: "additivePoint", magnitude: 0.05 }],
        }),
      ],
    }),
    "canonical",
    "seed-b"
  );

  const baseline = unwrapUnit(getScenarioTurnInput(withoutExpansion, 6).countries.EC.production);
  const withEvent = unwrapUnit(getScenarioTurnInput(withExpansion, 6).countries.EC.production);
  assert.ok(withEvent >= baseline, `供給拡大イベント適用時のproductionは基準以上のはず: ${withEvent} >= ${baseline}`);

  // 他国（対象外）のproductionは変化しない
  const baselineOther = unwrapUnit(getScenarioTurnInput(withoutExpansion, 6).countries.IN.production);
  const withEventOther = unwrapUnit(getScenarioTurnInput(withExpansion, 6).countries.IN.production);
  assert.equal(withEventOther, baselineOther);
});

test("需要拡大イベントは対象市場のpriorPeriodConsumptionを減らさない", () => {
  const withoutBoom = initializeScenario(testScenarioDefinition({ durationTurns: 24 }), "canonical", "seed-c");
  const withBoom = initializeScenario(
    testScenarioDefinition({
      durationTurns: 24,
      scheduledEvents: [
        testEvent({
          eventId: "boom",
          eventType: "DEMAND_SHOCK",
          targetCountries: [],
          targetMarkets: ["CN"],
          startTurn: 5,
          durationTurns: 15,
          rampUpTurns: 0,
          recoveryTurns: 0,
          effects: [{ variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: 1.15 }],
        }),
      ],
    }),
    "canonical",
    "seed-c"
  );

  const baseline = unwrapUnit(getScenarioTurnInput(withoutBoom, 6).demandMarkets.CN.priorPeriodConsumption);
  const withEvent = unwrapUnit(getScenarioTurnInput(withBoom, 6).demandMarkets.CN.priorPeriodConsumption);
  assert.ok(withEvent >= baseline);
});

test("イベント開始前は効果が一切適用されない", () => {
  const withoutDisease = initializeScenario(testScenarioDefinition({ durationTurns: 24 }), "canonical", "seed-d");
  const withDisease = initializeScenario(
    testScenarioDefinition({
      durationTurns: 24,
      scheduledEvents: [
        testEvent({
          eventId: "disease",
          targetCountries: ["VN"],
          startTurn: 10,
          rampUpTurns: 2,
          effects: [{ variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: -0.3 }],
        }),
      ],
    }),
    "canonical",
    "seed-d"
  );

  for (const turn of [1, 5, 9]) {
    const baseline = unwrapUnit(getScenarioTurnInput(withoutDisease, turn).countries.VN.production);
    const withEvent = unwrapUnit(getScenarioTurnInput(withDisease, turn).countries.VN.production);
    assert.equal(withEvent, baseline, `turn=${turn}ではイベント開始前なので同一のはず`);
  }
});

test("canonicalモード: 同じシードなら常に同じturnInputになる（再現性）", () => {
  const definition = testScenarioDefinition({ durationTurns: 24 });
  const stateA = initializeScenario(definition, "canonical", "seed-repro");
  const stateB = initializeScenario(definition, "canonical", "seed-repro");
  assert.deepEqual(getScenarioTurnInput(stateA, 12), getScenarioTurnInput(stateB, 12));
});

test("variationモード: 同じシードなら常に同じturnInputになる", () => {
  const definition = testScenarioDefinition({
    durationTurns: 24,
    scheduledEvents: [
      testEvent({
        variationRange: { startTurnJitter: 2, magnitudeJitterRatio: 0.2 },
      }),
    ],
  });
  const stateA = initializeScenario(definition, "variation", "seed-variation-repro");
  const stateB = initializeScenario(definition, "variation", "seed-variation-repro");
  assert.deepEqual(getScenarioTurnInput(stateA, 12), getScenarioTurnInput(stateB, 12));
});

test("variationモード: 異なるシードでは許容範囲内で結果が変わりうる", () => {
  const definition = testScenarioDefinition({
    durationTurns: 24,
    scheduledEvents: [
      testEvent({
        startTurn: 6,
        variationRange: { startTurnJitter: 3, magnitudeJitterRatio: 0.4 },
      }),
    ],
  });
  const seeds = ["v1", "v2", "v3", "v4", "v5"];
  const productions = seeds.map((s) => {
    const state = initializeScenario(definition, "variation", s);
    return unwrapUnit(getScenarioTurnInput(state, 8).countries.VN.production);
  });
  const anyDiffers = productions.some((p) => p !== productions[0]);
  assert.ok(anyDiffers, "異なるシードでは少なくとも1つ結果が変わるはず");
});

test("advanceScenarioTurn: currentTurnを1つ進め、フィードバックをturnHistoryへ記録する", () => {
  const state = initializeScenario(testScenarioDefinition({ durationTurns: 24 }), "canonical", "seed");
  const feedback = { externalProducerResponses: [{ countryId: "EC" as const, stockingAdjustmentRatio: 1.05, rationale: "test" }] };
  const next = advanceScenarioTurn(state, feedback);
  assert.equal(next.currentTurn, 2);
  assert.equal(next.turnHistory.length, 1);
  assert.equal(next.turnHistory[0].turn, 1);
  assert.deepEqual(next.turnHistory[0].feedback, feedback);
  // 元のstateは変更されない
  assert.equal(state.currentTurn, 1);
  assert.equal(state.turnHistory.length, 0);
});

test("advanceScenarioTurn: 最終ターンに到達済みの場合は例外を投げる", () => {
  let state = initializeScenario(testScenarioDefinition({ durationTurns: 20 }), "canonical", "seed");
  for (let i = 0; i < 19; i++) {
    state = advanceScenarioTurn(state);
  }
  assert.equal(state.currentTurn, 20);
  assert.throws(() => advanceScenarioTurn(state));
});

test("JSON直列化・復元してもturnInputの再現性が保たれる", () => {
  const definition = testScenarioDefinition({
    durationTurns: 24,
    scheduledEvents: [testEvent({ variationRange: { startTurnJitter: 2 } })],
  });
  const state = initializeScenario(definition, "variation", "seed-json");
  const restored = JSON.parse(JSON.stringify(state));

  const original = getScenarioTurnInput(state, 10);
  const afterRoundTrip = getScenarioTurnInput(restored, 10);
  assert.deepEqual(JSON.parse(JSON.stringify(original)), JSON.parse(JSON.stringify(afterRoundTrip)));
});
