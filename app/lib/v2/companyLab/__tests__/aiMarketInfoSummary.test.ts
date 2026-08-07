// ShrimpX V2 — 「AIが見ている市場情報」パネル向け 集計・ラベル付けヘルパーの受入確認テスト
// (test/sai6-manual-observation-2026-08-01: 三宅さんの3回目の手動観察テストで指摘された
//  「市場レベルの価格・需要・需要トレンドが画面のどこにも出ていない」への対応)

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { CompanyLabConfig, Sai5FeatureFlags } from "../types";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { buildCompanyOwnState } from "../runner";
import {
  LIFECYCLE_TREND_THRESHOLD,
  SUPPLY_PRESSURE_BAND,
  buildLifecycleTrendRows,
  buildSupplyPressureRows,
  classifyLifecycleTrend,
  classifySupplyPressure,
} from "../aiMarketInfoSummary";

function config(seed: string, turns: number, sai5?: Sai5FeatureFlags): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed, turns, ...(sai5 ? { sai5 } : {}) };
}

// --- 閾値ラベリング（純粋な数値判定） ---

test("classifyLifecycleTrend: 閾値(0.005)を超えると成長/縮小、範囲内は横ばい", () => {
  assert.equal(classifyLifecycleTrend(0.02), "growing");
  assert.equal(classifyLifecycleTrend(-0.02), "shrinking");
  assert.equal(classifyLifecycleTrend(0.002), "flat");
  assert.equal(classifyLifecycleTrend(-0.002), "flat");
  assert.equal(classifyLifecycleTrend(LIFECYCLE_TREND_THRESHOLD + 0.0001), "growing");
  assert.equal(classifyLifecycleTrend(LIFECYCLE_TREND_THRESHOLD), "flat");
});

test("classifySupplyPressure: 1.0±0.1の帯の外は過剰/不足、内は均衡", () => {
  assert.equal(classifySupplyPressure(1.3), "oversupply");
  assert.equal(classifySupplyPressure(0.7), "undersupply");
  assert.equal(classifySupplyPressure(1.02), "balanced");
  assert.equal(classifySupplyPressure(1 + SUPPLY_PRESSURE_BAND + 0.001), "oversupply");
  assert.equal(classifySupplyPressure(1 + SUPPLY_PRESSURE_BAND), "balanced");
});

// --- ライフサイクルトレンド行の展開（実エンジン出力に対して） ---

test("buildLifecycleTrendRows: 5市場×3商品=15行を返し、各市場でhoso+pd+vapのトレンド合計がほぼ0（行和=1という制約の残差整合性）", () => {
  const ALL_ON: Sai5FeatureFlags = { productLifecycle: true };
  const { state: initial, fixtures } = initializeCompanyLab(config("ai-market-info-lifecycle", 4, ALL_ON));

  // turn1では前四半期が無いためoutlook自体がundefined。turn2以降で初めて設定される
  // （既存の情報境界規約。runner.ts buildPublicMarketInfoのコメント参照）。
  const decisionsByCompanyId: Record<string, ReturnType<typeof generateAutoPolicyDecision>> = {};
  const publicInfo1 = buildPublicMarketInfo(initial);
  for (const f of fixtures) {
    const ownState = buildCompanyOwnState(initial, f);
    decisionsByCompanyId[f.companyId] = generateAutoPolicyDecision(f, ownState, publicInfo1, initial.currentPeriod, 1);
  }
  const afterTurn1 = advanceCompanyLabQuarter(initial, fixtures, decisionsByCompanyId);

  const decisionsByCompanyId2: Record<string, ReturnType<typeof generateAutoPolicyDecision>> = {};
  const publicInfo2 = buildPublicMarketInfo(afterTurn1);
  for (const f of fixtures) {
    const ownState = buildCompanyOwnState(afterTurn1, f);
    decisionsByCompanyId2[f.companyId] = generateAutoPolicyDecision(f, ownState, publicInfo2, afterTurn1.currentPeriod, 2);
  }
  const afterTurn2 = advanceCompanyLabQuarter(afterTurn1, fixtures, decisionsByCompanyId2);

  const publicInfo3 = buildPublicMarketInfo(afterTurn2);
  assert.ok(publicInfo3.productLifecycleOutlook, "turn3の意思決定時点ではproductLifecycleOutlookが設定されているべき");
  const rows = buildLifecycleTrendRows(publicInfo3.productLifecycleOutlook!);
  assert.equal(rows.length, 15);

  const byMarket = new Map<string, number>();
  for (const r of rows) {
    byMarket.set(r.market, (byMarket.get(r.market) ?? 0) + r.trendValue);
  }
  for (const [market, sum] of byMarket) {
    assert.ok(Math.abs(sum) < 1e-9, `${market}: 市場内のトレンド合計が0から乖離しています(${sum})`);
  }
});

test("buildLifecycleTrendRows: turn1（前四半期なし）ではproductLifecycleOutlookがundefined（捏造しない既存境界を維持）", () => {
  const ALL_ON: Sai5FeatureFlags = { productLifecycle: true };
  const { state } = initializeCompanyLab(config("ai-market-info-lifecycle-turn1", 4, ALL_ON));
  const publicInfo = buildPublicMarketInfo(state);
  assert.equal(publicInfo.productLifecycleOutlook, undefined);
});

test("buildLifecycleTrendRows: config.sai5.productLifecycle無効時はoutlook自体がundefined", () => {
  const { state } = initializeCompanyLab(config("ai-market-info-lifecycle-off", 4));
  const publicInfo = buildPublicMarketInfo(state);
  assert.equal(publicInfo.productLifecycleOutlook, undefined);
});

// --- 供給圧力行の展開 ---

test("buildSupplyPressureRows: pd/vapの2行を返し、値そのものはengine出力をそのまま転記する（再計算しない）", () => {
  const outlook = { pd: 1.25, vap: 0.85 };
  const rows = buildSupplyPressureRows(outlook);
  assert.equal(rows.length, 2);
  const pdRow = rows.find((r) => r.product === "pd");
  const vapRow = rows.find((r) => r.product === "vap");
  assert.equal(pdRow?.value, 1.25);
  assert.equal(pdRow?.label, "oversupply");
  assert.equal(vapRow?.value, 0.85);
  assert.equal(vapRow?.label, "undersupply");
});
