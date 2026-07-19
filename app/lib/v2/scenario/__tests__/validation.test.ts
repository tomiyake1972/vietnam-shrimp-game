import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScenarioDefinition, assertValidScenarioDefinition } from "../validation";
import { testScenarioDefinition, testEvent, testTrend, testPrehistory } from "./fixtures";

test("最小限の妥当なScenarioDefinitionは検証を通る", () => {
  const result = validateScenarioDefinition(testScenarioDefinition());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("durationTurnsが20〜40の範囲外なら不正", () => {
  assert.equal(validateScenarioDefinition(testScenarioDefinition({ durationTurns: 19 })).valid, false);
  assert.equal(validateScenarioDefinition(testScenarioDefinition({ durationTurns: 41 })).valid, false);
  assert.equal(validateScenarioDefinition(testScenarioDefinition({ durationTurns: 32 })).valid, true);
});

test("イベントIDの重複は不正", () => {
  const result = validateScenarioDefinition(
    testScenarioDefinition({
      scheduledEvents: [testEvent({ eventId: "dup" }), testEvent({ eventId: "dup" })],
    })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("重複")));
});

test("informationReleaseIdsが存在しないリリースを参照していれば不正", () => {
  const result = validateScenarioDefinition(
    testScenarioDefinition({
      scheduledEvents: [testEvent({ informationReleaseIds: ["nonexistent"] })],
    })
  );
  assert.equal(result.valid, false);
});

test("informationRelease.relatedEventIdが存在しないイベントを参照していれば不正", () => {
  const result = validateScenarioDefinition(
    testScenarioDefinition({
      informationReleases: [
        {
          informationId: "info-1",
          relatedEventId: "nonexistent-event",
          availableFromTurn: 1,
          informationLevel: "public",
          headlineTemplate: "h",
          structuredFacts: [],
          isRumor: false,
        },
      ],
    })
  );
  assert.equal(result.valid, false);
});

test("informationRelease.revisionOfが存在しないリリースを参照していれば不正", () => {
  const result = validateScenarioDefinition(
    testScenarioDefinition({
      informationReleases: [
        {
          informationId: "info-1",
          revisionOf: "nonexistent-info",
          availableFromTurn: 1,
          informationLevel: "public",
          headlineTemplate: "h",
          structuredFacts: [],
          isRumor: false,
        },
      ],
    })
  );
  assert.equal(result.valid, false);
});

test("estimateRangeのlowがhighを上回っていれば不正（逆転範囲）", () => {
  const result = validateScenarioDefinition(
    testScenarioDefinition({
      informationReleases: [
        {
          informationId: "info-1",
          availableFromTurn: 1,
          informationLevel: "public",
          headlineTemplate: "h",
          structuredFacts: [],
          isRumor: false,
          estimateRange: { low: 10, high: 5 },
        },
      ],
    })
  );
  assert.equal(result.valid, false);
});

test("イベントのstartTurnがシナリオのdurationTurnsを超えていれば不正", () => {
  const result = validateScenarioDefinition(
    testScenarioDefinition({ durationTurns: 20, scheduledEvents: [testEvent({ startTurn: 25 })] })
  );
  assert.equal(result.valid, false);
});

test("イベントのtargetCountriesに不正な国コードがあれば不正", () => {
  const result = validateScenarioDefinition(
    testScenarioDefinition({
      scheduledEvents: [testEvent({ targetCountries: ["XX" as never] })],
    })
  );
  assert.equal(result.valid, false);
});

test("multiplicative効果のmagnitudeが0以下なら不正", () => {
  const result = validateScenarioDefinition(
    testScenarioDefinition({
      scheduledEvents: [testEvent({ effects: [{ variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: 0 }] })],
    })
  );
  assert.equal(result.valid, false);
});

test("キーフレームが2点未満の長期トレンドは不正", () => {
  const result = validateScenarioDefinition(
    testScenarioDefinition({ longTermTrends: [testTrend({ keyframes: [{ turn: 1, value: 1 }] })] })
  );
  assert.equal(result.valid, false);
});

test("前史の供給量・在庫量が負なら不正", () => {
  const result = validateScenarioDefinition(
    testScenarioDefinition({
      prehistory: testPrehistory({ countrySupplyHosoEqTons: { EC: -1, IN: 1, ID: 1, VN: 1 } }),
    })
  );
  assert.equal(result.valid, false);
});

test("前史のlengthYearsが2〜4の範囲外なら不正", () => {
  const result = validateScenarioDefinition(testScenarioDefinition({ prehistory: testPrehistory({ lengthYears: 1 }) }));
  assert.equal(result.valid, false);
});

test("assertValidScenarioDefinition: 不正な定義は例外を投げる", () => {
  assert.throws(() => assertValidScenarioDefinition(testScenarioDefinition({ durationTurns: 5 })));
});

test("assertValidScenarioDefinition: 妥当な定義は例外を投げない", () => {
  assert.doesNotThrow(() => assertValidScenarioDefinition(testScenarioDefinition()));
});

test("入力のdefinitionは変更しない", () => {
  const definition = testScenarioDefinition();
  const before = JSON.parse(JSON.stringify(definition));
  validateScenarioDefinition(definition);
  assert.deepEqual(JSON.parse(JSON.stringify(definition)), before);
});
