// ShrimpX V2 — Phase SAI-5: 市場進化モデルの統合テスト
//
// 各機能フラグ（productLifecycle / salesBaseAccumulation / supplyPremiumFeedback /
// orientation / heterogeneousInitial / aiCapex）の (a) OFF時の完全後方互換、
// (b) ON時の完走・有限性・決定論性、(c) 方向性を、実際のrunAutoplayCase実行で
// 検証する。個々のモジュール単体の性質はそれぞれの__tests__側の責務。

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutoplayCase, AutoplayCaseConfig } from "../runCase";
import { ALL_COMPANY_IDS } from "../../report/decomposeHarness";
import { STANDARD_BASELINE_CANDIDATES, SELECTED_STANDARD_BASELINE_CANDIDATE_ID } from "../../report/standardBaseline";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

function baseConfig(seed: string, quarters: number, overrides: Partial<AutoplayCaseConfig> = {}): AutoplayCaseConfig {
  return { scenarioId: "baseline", seed, quarters, companyIds: ALL_COMPANY_IDS, candidate, ...overrides };
}

function assertAllFinite(value: unknown, path = "root"): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} が有限数ではありません（${value}）`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertAllFinite(v, `${path}.${k}`);
  }
}

// ---------------------------------------------------------------------
// SAI-5C: 市場別の商品ライフサイクル
// ---------------------------------------------------------------------

test("SAI-5C統合: productLifecycle無効時は従来と完全に同一（後方互換）", () => {
  const off1 = runAutoplayCase(baseConfig("sai5c-backcompat", 2));
  const off2 = runAutoplayCase(baseConfig("sai5c-backcompat", 2, { productLifecycleEnabled: false }));
  assert.equal(JSON.stringify(off1.history), JSON.stringify(off2.history));
});

test("SAI-5C統合: productLifecycle有効時、8四半期完走・全数値有限・同一seedで完全再現", () => {
  const config = baseConfig("sai5c-on-repro", 8, { productLifecycleEnabled: true });
  const a = runAutoplayCase(config);
  assert.equal(a.completedTurns, 8);
  assertAllFinite(a.history.map((h) => h.companySummaries));
  const b = runAutoplayCase(config);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));
  assert.equal(JSON.stringify(a.diagnostics), JSON.stringify(b.diagnostics));
});

test("SAI-5C統合: 有効時は無効時と市場結果が実際に変わる（世界VAP需要が初期は小さくなる）", () => {
  const off = runAutoplayCase(baseConfig("sai5c-effect", 2));
  const on = runAutoplayCase(baseConfig("sai5c-effect", 2, { productLifecycleEnabled: true }));
  const offVap = off.history[0].marketResult.vapPremium.globalDemand as unknown as number;
  const onVap = on.history[0].marketResult.vapPremium.globalDemand as unknown as number;
  assert.ok(onVap < offVap, `ライフサイクル有効時の初期世界VAP需要(${onVap})が従来(${offVap})より小さくない`);
});

test("SAI-5C統合: AIはturn2以降にライフサイクル公開トレンドを観測できる（turn1は前期が無いためundefined）", () => {
  const on = runAutoplayCase(baseConfig("sai5c-outlook", 3, { productLifecycleEnabled: true }));
  const turn1 = on.quarterStartCaptures.find((c) => c.turn === 1)!;
  const turn2 = on.quarterStartCaptures.find((c) => c.turn === 2)!;
  const turn3 = on.quarterStartCaptures.find((c) => c.turn === 3)!;
  assert.equal(turn1.publicInfo.productLifecycleOutlook, undefined);
  assert.ok(turn2.publicInfo.productLifecycleOutlook, "turn2でライフサイクル公開トレンドが観測できない");
  // turn3の公開シェア＝turn2に適用された構成比（前期の実際、当期の先読みではない）
  const outlook3 = turn3.publicInfo.productLifecycleOutlook!;
  assert.ok(outlook3.sharesByMarket.JP.vap >= turn2.publicInfo.productLifecycleOutlook!.sharesByMarket.JP.vap, "公開シェアが時間とともに進んでいない");
  // 無効時のrunでは一切付与されない
  const off = runAutoplayCase(baseConfig("sai5c-outlook", 2));
  for (const c of off.quarterStartCaptures) {
    assert.equal(c.publicInfo.productLifecycleOutlook, undefined);
  }
});
