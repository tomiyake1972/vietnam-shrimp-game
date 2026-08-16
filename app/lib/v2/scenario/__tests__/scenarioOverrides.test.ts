// Dynamic Scenario 1 — Scenario override 機構のテスト
//
// 検証の主眼は「上書きを持たないシナリオが既存挙動と完全に一致すること」。
// 長期構造をシナリオへ移す変更が、既存5シナリオ・並行開発中のbenchmarkへ
// 一切影響しないことを構造的に担保する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  PRODUCT_LIFECYCLE_PARAMETERS_V1,
  computeMarketProductMix,
  resolveProductLifecycleParameters,
  ProductLifecycleOverrides,
} from "../../market/productLifecycle";
import { applyStructuralDemandAnchor } from "../../market/consumerInventory";
import { resolveScenarioProductLifecycleParameters } from "../lifecycle";
import { validateScenarioDefinition } from "../validation";
import { BASELINE_SCENARIO } from "../definitions/baseline";
import { ScenarioDefinition } from "../types";

// ---------------------------------------------------------------------
// productLifecycleOverrides
// ---------------------------------------------------------------------

test("上書き未指定なら base をそのまま返す（同一参照＝既存挙動と構造的に一致）", () => {
  assert.equal(resolveProductLifecycleParameters(PRODUCT_LIFECYCLE_PARAMETERS_V1, undefined), PRODUCT_LIFECYCLE_PARAMETERS_V1);
  assert.equal(resolveProductLifecycleParameters(PRODUCT_LIFECYCLE_PARAMETERS_V1, {}), PRODUCT_LIFECYCLE_PARAMETERS_V1);
});

test("productLifecycleOverridesを持たないシナリオは市場モジュール既定値を使う", () => {
  assert.equal(resolveScenarioProductLifecycleParameters(BASELINE_SCENARIO), PRODUCT_LIFECYCLE_PARAMETERS_V1);
});

test("既存5シナリオの構成比は全32ターンで従来値と完全一致する", () => {
  for (let turn = 1; turn <= 32; turn++) {
    const viaScenario = computeMarketProductMix(turn, resolveScenarioProductLifecycleParameters(BASELINE_SCENARIO));
    const viaDefault = computeMarketProductMix(turn);
    assert.deepEqual(viaScenario, viaDefault, `turn ${turn}`);
  }
});

test("部分上書き: 指定したフィールドだけが変わり、他は基準値を保つ", () => {
  const overrides: ProductLifecycleOverrides = { CN: { pd: { initialShare: 0.05, accelStartTurn: 25 } } };
  const resolved = resolveProductLifecycleParameters(PRODUCT_LIFECYCLE_PARAMETERS_V1, overrides);

  assert.equal(resolved.byMarket.CN.pd.initialShare, 0.05);
  assert.equal(resolved.byMarket.CN.pd.accelStartTurn, 25);
  // 指定しなかったフィールドは基準値のまま
  assert.equal(resolved.byMarket.CN.pd.matureShare, PRODUCT_LIFECYCLE_PARAMETERS_V1.byMarket.CN.pd.matureShare);
  // 指定しなかった商品・市場は基準値のまま
  assert.deepEqual(resolved.byMarket.CN.vap, PRODUCT_LIFECYCLE_PARAMETERS_V1.byMarket.CN.vap);
  assert.deepEqual(resolved.byMarket.JP, PRODUCT_LIFECYCLE_PARAMETERS_V1.byMarket.JP);
});

test("上書きは PRODUCT_LIFECYCLE_PARAMETERS_V1 を破壊しない", () => {
  const before = JSON.parse(JSON.stringify(PRODUCT_LIFECYCLE_PARAMETERS_V1));
  resolveProductLifecycleParameters(PRODUCT_LIFECYCLE_PARAMETERS_V1, { CN: { pd: { initialShare: 0.01 } }, JP: { vap: { matureShare: 0.4 } } });
  assert.deepEqual(JSON.parse(JSON.stringify(PRODUCT_LIFECYCLE_PARAMETERS_V1)), before);
});

test("不正な上書き（matureShare < initialShare）は解決時に例外になる", () => {
  assert.throws(() => resolveProductLifecycleParameters(PRODUCT_LIFECYCLE_PARAMETERS_V1, { JP: { vap: { matureShare: 0.01 } } }));
});

test("不正な上書き（HOSOシェアが残らない）は解決時に例外になる", () => {
  assert.throws(() =>
    resolveProductLifecycleParameters(PRODUCT_LIFECYCLE_PARAMETERS_V1, { JP: { pd: { matureShare: 0.6 }, vap: { matureShare: 0.4 } } })
  );
});

test("validateScenarioDefinition が不正な productLifecycleOverrides を検出する", () => {
  const broken: ScenarioDefinition = { ...BASELINE_SCENARIO, productLifecycleOverrides: { JP: { vap: { matureShare: 0.01 } } } };
  const result = validateScenarioDefinition(broken);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("productLifecycleOverrides")), result.errors.join(" / "));
});

test("妥当な productLifecycleOverrides は検証を通る", () => {
  const ok: ScenarioDefinition = {
    ...BASELINE_SCENARIO,
    productLifecycleOverrides: { CN: { pd: { initialShare: 0.05, accelStartTurn: 25 }, vap: { initialShare: 0.008, accelStartTurn: 25 } } },
  };
  assert.equal(validateScenarioDefinition(ok).valid, true);
});

// ---------------------------------------------------------------------
// structuralDemandAnchor
// ---------------------------------------------------------------------

test("アンカー未指定なら前期実現消費をそのまま返す（従来挙動）", () => {
  assert.equal(applyStructuralDemandAnchor(50_000, undefined), 50_000);
});

test("pullStrength=0 は従来挙動と同じ", () => {
  assert.equal(applyStructuralDemandAnchor(50_000, { structuralConsumptionTons: 90_000, pullStrength: 0 }), 50_000);
});

test("pullStrength=1 は構造需要をそのまま基準にする（供給不足の記憶を持ち越さない）", () => {
  assert.equal(applyStructuralDemandAnchor(50_000, { structuralConsumptionTons: 90_000, pullStrength: 1 }), 90_000);
});

test("中間の pullStrength は構造需要へ向けて部分的に引き戻す", () => {
  assert.equal(applyStructuralDemandAnchor(50_000, { structuralConsumptionTons: 90_000, pullStrength: 0.5 }), 70_000);
});

test("アンカーは下向きにも働く（構造需要より実現が多ければ引き下げる＝一方向の下駄ではない）", () => {
  assert.equal(applyStructuralDemandAnchor(120_000, { structuralConsumptionTons: 90_000, pullStrength: 1 }), 90_000);
});

test("繰り返し適用しても構造需要より上振れ・下振れが累積しない（発散しない）", () => {
  let consumption = 10_000;
  for (let i = 0; i < 40; i++) {
    // 毎期「供給不足で実現が7割に落ちる」を模擬しても、アンカーが構造水準へ戻す。
    consumption = applyStructuralDemandAnchor(consumption * 0.7, { structuralConsumptionTons: 90_000, pullStrength: 1 });
  }
  assert.equal(consumption, 90_000);
});

test("pullStrength=1 でも 0.7 倍の供給不足が1期だけなら翌期に構造水準へ戻る", () => {
  const afterShortfall = applyStructuralDemandAnchor(90_000 * 0.7, { structuralConsumptionTons: 90_000, pullStrength: 1 });
  assert.equal(afterShortfall, 90_000);
});

test("validateScenarioDefinition が範囲外の pullStrength を検出する", () => {
  for (const pullStrength of [-0.1, 1.5, Number.NaN]) {
    const broken: ScenarioDefinition = { ...BASELINE_SCENARIO, structuralDemandAnchor: { pullStrength } };
    const result = validateScenarioDefinition(broken);
    assert.equal(result.valid, false, `pullStrength=${pullStrength}`);
    assert.ok(result.errors.some((e) => e.includes("structuralDemandAnchor")));
  }
});
