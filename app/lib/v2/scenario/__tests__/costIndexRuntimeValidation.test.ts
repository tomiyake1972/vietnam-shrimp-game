// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1 受入前修正2:
// Scenario runtime validation（不正policy・未知キー・不正interpolationの拒否）
//
// 【なぜ型だけでは足りないか】ScenarioDefinition は JSON 由来の runtime 入力
// （保存Runの復元・外部数表・診断ハーネス）としても組み立てられる。TypeScript の型は
// その経路では効かず、しかも解決側は次のように「黙って既定へ落ちる」実装になっている。
//   - resolveProjectBudget は "indexed-required-cost-v1" 以外をすべて legacy 扱い
//   - resolveOperatingCostIndex は OperatingCostIndexKey でしか tracks を引かない
//   - interpolateKeyframeValue は "step" 以外をすべて linear 扱い
// いずれも「宣言したのに効かないRun」を生むため、validation で拒否する。

import test from "node:test";
import assert from "node:assert/strict";

import { validateScenarioDefinition } from "../validation";
import { ALL_SCENARIO_DEFINITIONS } from "../definitions";
import { CONSTRUCTION_COST_POLICY_IDS, OPERATING_COST_INDEX_KEYS } from "../costIndex";
import { TREND_INTERPOLATIONS, isTrendInterpolation } from "../interpolation";
import { ScenarioDefinition } from "../types";

const BASE = ALL_SCENARIO_DEFINITIONS.find((d) => d.scenarioId === "baseline-v0.1")!;

/** 検証を通る正常な数表（2点以上・turn昇順・値>0）。 */
const OK_TRACK = { interpolation: "linear" as const, keyframes: [{ turn: 1, value: 1.0 }, { turn: 32, value: 1.2 }] };

function withOverrides(overrides: Record<string, unknown>): ScenarioDefinition {
  return { ...BASE, ...overrides } as ScenarioDefinition;
}

test("COST-VAL-1: constructionCostPolicy の不正値を拒否する（legacyへ黙ってフォールバックしない）", () => {
  for (const bad of ["indexed-required-cost", "legacy", "INDEXED-REQUIRED-COST-V1", "", "v1", 1, null]) {
    const result = validateScenarioDefinition(withOverrides({ constructionCostPolicy: bad }));
    assert.equal(result.valid, false, `${JSON.stringify(bad)} が受理されてしまった`);
    assert.ok(
      result.errors.some((e) => e.includes("constructionCostPolicy")),
      `${JSON.stringify(bad)} のエラーメッセージが constructionCostPolicy を含まない: ${result.errors.join(" / ")}`
    );
  }
});

test("COST-VAL-2: constructionCostPolicy は正規の2値と未指定だけを受理する", () => {
  assert.deepEqual([...CONSTRUCTION_COST_POLICY_IDS], ["legacy-requested-cost", "indexed-required-cost-v1"]);
  for (const good of CONSTRUCTION_COST_POLICY_IDS) {
    const result = validateScenarioDefinition(withOverrides({ constructionCostPolicy: good }));
    assert.equal(result.valid, true, `${good} が拒否された: ${result.errors.join(" / ")}`);
  }
  // 未指定（undefined）は既定 legacy-requested-cost として扱われるため受理する。
  assert.equal(validateScenarioDefinition(withOverrides({ constructionCostPolicy: undefined })).valid, true);
});

test("COST-VAL-3: operatingCostInflation.tracks の未知キーを拒否する（誤字を黙殺しない）", () => {
  for (const badKey of ["sellingLogistic", "regular_labor", "factoryFixedCost", "rawPriceCaptureIndex", "unknown"]) {
    const result = validateScenarioDefinition(
      withOverrides({ operatingCostInflation: { settingsId: "t", tracks: { [badKey]: OK_TRACK } } })
    );
    assert.equal(result.valid, false, `未知キー ${badKey} が受理されてしまった`);
    assert.ok(
      result.errors.some((e) => e.includes("未知の指数キー") && e.includes(badKey)),
      `${badKey} のエラーメッセージが不十分: ${result.errors.join(" / ")}`
    );
  }
});

test("COST-VAL-3b: 未知キーは値が undefined でも拒否する（既知キーの undefined はスキップして受理）", () => {
  // 「宣言しなかった」ことを undefined で表す書き方は既知キーでのみ許す。
  // 未知キーが undefined で置かれているのは綴り違いの兆候なので拒否する。
  const unknownUndefined = validateScenarioDefinition(
    withOverrides({ operatingCostInflation: { settingsId: "t", tracks: { labor: undefined } } })
  );
  assert.equal(unknownUndefined.valid, false);
  assert.ok(unknownUndefined.errors.some((e) => e.includes("未知の指数キー") && e.includes("labor")));

  const knownUndefined = validateScenarioDefinition(
    withOverrides({
      operatingCostInflation: { settingsId: "t", tracks: { temporaryLabor: undefined, regularLabor: OK_TRACK } },
    })
  );
  assert.equal(knownUndefined.valid, true, knownUndefined.errors.join(" / "));
});

test("COST-VAL-4: 既知キーはすべて受理され、未知キーと同時に宣言しても既知キー側の検証は続く", () => {
  const tracks: Record<string, unknown> = {};
  for (const key of OPERATING_COST_INDEX_KEYS) tracks[key] = OK_TRACK;
  assert.equal(
    validateScenarioDefinition(withOverrides({ operatingCostInflation: { settingsId: "t", tracks } })).valid,
    true
  );

  // 未知キー1件 ＋ 既知キーだが数表が不正（キーフレーム1点）1件 → エラーは2件出る。
  const mixed = validateScenarioDefinition(
    withOverrides({
      operatingCostInflation: {
        settingsId: "t",
        tracks: {
          unknownKey: OK_TRACK,
          factoryFixed: { interpolation: "linear", keyframes: [{ turn: 1, value: 1.0 }] },
        },
      },
    })
  );
  assert.equal(mixed.valid, false);
  assert.ok(mixed.errors.some((e) => e.includes("未知の指数キー")), mixed.errors.join(" / "));
  assert.ok(mixed.errors.some((e) => e.includes("factoryFixed")), mixed.errors.join(" / "));
});

test("COST-VAL-5: 費用指数の interpolation が linear / step 以外なら拒否する", () => {
  assert.deepEqual([...TREND_INTERPOLATIONS], ["linear", "step"]);
  for (const bad of ["Linear", "STEP", "smooth", "", 0, null, undefined]) {
    const result = validateScenarioDefinition(
      withOverrides({
        operatingCostInflation: {
          settingsId: "t",
          tracks: { factoryFixed: { interpolation: bad, keyframes: OK_TRACK.keyframes } },
        },
      })
    );
    assert.equal(result.valid, false, `interpolation=${JSON.stringify(bad)} が受理されてしまった`);
    assert.ok(
      result.errors.some((e) => e.includes("interpolation")),
      `${JSON.stringify(bad)} のエラーメッセージが interpolation を含まない: ${result.errors.join(" / ")}`
    );
  }
});

test("COST-VAL-6: rawMarketPricing.rawPriceCaptureIndex の interpolation も同じ基準で拒否する", () => {
  const result = validateScenarioDefinition(
    withOverrides({
      rawMarketPricing: {
        settingsId: "t",
        rawPriceCaptureIndex: { interpolation: "ease-in", keyframes: OK_TRACK.keyframes },
      },
    })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("rawMarketPricing.rawPriceCaptureIndex") && e.includes("interpolation")));
});

test("COST-VAL-7: longTermTrend の interpolation も同じ基準で拒否する（同一の補間規則を共有しているため）", () => {
  const trend = BASE.longTermTrends[0];
  assert.ok(trend !== undefined, "baseline に longTermTrend が1件も無い");
  const result = validateScenarioDefinition(
    withOverrides({ longTermTrends: [{ ...trend, interpolation: "cubic" }, ...BASE.longTermTrends.slice(1)] })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes(trend.trendId) && e.includes("interpolation")), result.errors.join(" / "));
});

test("COST-VAL-8: 既存Scenarioは全て検証を通る（偽陽性を作っていない）", () => {
  for (const d of ALL_SCENARIO_DEFINITIONS) {
    const result = validateScenarioDefinition(d);
    assert.equal(result.valid, true, `${d.scenarioId} が拒否された: ${result.errors.join(" / ")}`);
    for (const trend of d.longTermTrends) {
      assert.ok(isTrendInterpolation(trend.interpolation), `${d.scenarioId}/${trend.trendId}`);
    }
  }
});
