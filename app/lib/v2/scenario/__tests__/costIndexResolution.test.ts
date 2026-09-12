// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1: Turn別指数の解決（中立性・補間・検証）

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONSTRUCTION_COST_POLICY,
  NEUTRAL_COST_INDEX,
  OPERATING_COST_INDEX_KEYS,
  resolveAllOperatingCostIndices,
  resolveConstructionCostIndex,
  resolveConstructionCostPolicy,
  resolveOperatingCostIndex,
  resolveRawPriceCaptureIndex,
} from "../costIndex";
import { interpolateKeyframeValue } from "../interpolation";
import { validateScenarioDefinition } from "../validation";
import { ALL_SCENARIO_DEFINITIONS } from "../definitions";
import { ScenarioDefinition, ScenarioValidationError } from "../types";

const BASE = ALL_SCENARIO_DEFINITIONS.find((d) => d.scenarioId === "baseline-v0.1")!;

function withSettings(overrides: Partial<ScenarioDefinition>): ScenarioDefinition {
  return { ...BASE, ...overrides };
}

test("COST-IDX-1: 何も宣言していないシナリオでは全指数が中立1.00", () => {
  for (const key of OPERATING_COST_INDEX_KEYS) {
    for (const turn of [1, 8, 16, 24, 32]) {
      assert.equal(resolveOperatingCostIndex(BASE, key, turn), NEUTRAL_COST_INDEX, `${key}@${turn}`);
    }
  }
  assert.equal(resolveRawPriceCaptureIndex(BASE, 24), NEUTRAL_COST_INDEX);
  assert.equal(resolveConstructionCostIndex(BASE, 24), NEUTRAL_COST_INDEX);
});

test("COST-IDX-2: 既存Scenarioはすべて legacy-requested-cost（建設費方式の既定）", () => {
  assert.equal(DEFAULT_CONSTRUCTION_COST_POLICY, "legacy-requested-cost");
  for (const d of ALL_SCENARIO_DEFINITIONS) {
    assert.equal(resolveConstructionCostPolicy(d), "legacy-requested-cost", d.scenarioId);
    assert.equal(d.operatingCostInflation, undefined, d.scenarioId);
    assert.equal(d.rawMarketPricing, undefined, d.scenarioId);
    assert.equal(d.constructionCostPolicy, undefined, d.scenarioId);
  }
});

test("COST-IDX-3: 宣言したキーだけが動き、他のキーは1.00のまま", () => {
  const d = withSettings({
    operatingCostInflation: {
      settingsId: "test",
      tracks: {
        sellingLogistics: {
          interpolation: "linear",
          keyframes: [
            { turn: 1, value: 1.0 },
            { turn: 21, value: 1.4 },
          ],
        },
      },
    },
  });
  assert.equal(resolveOperatingCostIndex(d, "sellingLogistics", 11), 1.2);
  for (const key of OPERATING_COST_INDEX_KEYS) {
    if (key === "sellingLogistics") continue;
    assert.equal(resolveOperatingCostIndex(d, key, 11), 1.0, key);
  }
});

test("COST-IDX-4: 補間規則は interpolateKeyframeValue と同一（二重定義していない）", () => {
  const keyframes = [
    { turn: 1, value: 1.0 },
    { turn: 24, value: 1.4 },
    { turn: 32, value: 1.56 },
  ];
  for (const interpolation of ["linear", "step"] as const) {
    const d = withSettings({
      operatingCostInflation: { settingsId: "test", tracks: { construction: { interpolation, keyframes } } },
    });
    for (const turn of [-5, 0, 1, 12, 24, 28, 32, 40]) {
      assert.equal(
        resolveConstructionCostIndex(d, turn),
        interpolateKeyframeValue(keyframes, interpolation, turn, "x"),
        `${interpolation}@${turn}`
      );
    }
  }
});

test("COST-IDX-5: 範囲外Turnは端点保持", () => {
  const d = withSettings({
    rawMarketPricing: {
      settingsId: "test",
      rawPriceCaptureIndex: {
        interpolation: "linear",
        keyframes: [
          { turn: 5, value: 1.0 },
          { turn: 25, value: 1.08 },
        ],
      },
    },
  });
  assert.equal(resolveRawPriceCaptureIndex(d, 1), 1.0);
  assert.equal(resolveRawPriceCaptureIndex(d, 5), 1.0);
  assert.equal(resolveRawPriceCaptureIndex(d, 32), 1.08);
});

test("COST-IDX-6: 0以下・非有限の指数は解決時に例外", () => {
  const d = withSettings({
    operatingCostInflation: {
      settingsId: "test",
      tracks: {
        adminFixed: {
          interpolation: "step",
          keyframes: [
            { turn: 1, value: 1.0 },
            { turn: 10, value: -1 },
          ],
        },
      },
    },
  });
  assert.throws(() => resolveOperatingCostIndex(d, "adminFixed", 12), ScenarioValidationError);
});

test("COST-IDX-7: validateScenarioDefinition が数表の不正を検出する", () => {
  const ok = withSettings({
    operatingCostInflation: {
      settingsId: "ok",
      tracks: {
        // 【受入前修正2】未指定(undefined)の track はスキップされる、という元々の意図を
        // 保ったまま「既知キー」で表現する。未知キー（旧: labor）は誤字を黙殺しないため
        // 拒否されるようになった（costIndexRuntimeValidation.test.ts COST-VAL-3 参照）。
        temporaryLabor: undefined,
        regularLabor: {
          interpolation: "linear",
          keyframes: [
            { turn: 1, value: 1.0 },
            { turn: 20, value: 1.3 },
          ],
        },
      } as never,
    },
  });
  assert.equal(validateScenarioDefinition(ok).valid, true);

  const badOrder = withSettings({
    operatingCostInflation: {
      settingsId: "bad",
      tracks: {
        regularLabor: {
          interpolation: "linear",
          keyframes: [
            { turn: 20, value: 1.3 },
            { turn: 1, value: 1.0 },
          ],
        },
      },
    },
  });
  assert.equal(validateScenarioDefinition(badOrder).valid, false);

  const badValue = withSettings({
    rawMarketPricing: {
      settingsId: "bad",
      rawPriceCaptureIndex: {
        interpolation: "linear",
        keyframes: [
          { turn: 1, value: 1.0 },
          { turn: 20, value: 0 },
        ],
      },
    },
  });
  assert.equal(validateScenarioDefinition(badValue).valid, false);
});

test("COST-IDX-8: resolveAllOperatingCostIndices が全キーを返す", () => {
  const all = resolveAllOperatingCostIndices(BASE, 17);
  assert.deepEqual(Object.keys(all).sort(), [...OPERATING_COST_INDEX_KEYS].sort());
});
