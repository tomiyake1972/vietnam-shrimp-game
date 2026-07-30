// ShrimpX V2 — Phase SAI-4: 標準AI異質5社（経営性格プロファイル・養殖上限4,000トン）
// の統合テスト
//
// 三宅さんの追加条件5「自動テストでは少なくとも財務・設備能力・人員/営業能力・
// 品質/信用・在庫/債権債務・利用可能情報・養殖能力4,000トンが全社同一であることを
// 明示的に確認する」と、実装指示§9「E社の安定性テスト（四半期ごとの配分の乱高下が
// 無いこと）」を扱う。プロファイルそのものの値の単体検証は
// standardAi/__tests__/managementProfile.test.ts 側の責務。

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutoplayCase } from "../runCase";
import { ALL_COMPANY_IDS } from "../../report/decomposeHarness";
import { STANDARD_BASELINE_CANDIDATES, SELECTED_STANDARD_BASELINE_CANDIDATE_ID } from "../../report/standardBaseline";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

/**
 * 会社ID・会社名・アーキタイプ・説明文・工場ID・原料ロットIDなど、「競争能力では
 * ない識別情報」（三宅さんの追加条件5）を再帰的に取り除いた上でJSON化する。
 * これらのキーは会社ごとに異なることが前提の識別子であり、実質的な初期条件の
 * 同一性判定には含めない。
 */
const IDENTIFIER_KEYS = new Set([
  "companyId",
  "factoryId",
  "lotId",
  "displayName",
  "archetype",
  "description",
  // 【会社IDを内部に埋め込んだ複合識別子】値そのものは全社同一でも、
  // "SC-STD-2014Q4-CN-hoso-BAL-0" のように会社IDを文字列内に含むため、
  // 単純なJSON文字列比較では別物に見えてしまう。中身（quantity・price等）は
  // 他のキーで既に比較しているため、識別子自体は同一性判定から除外する。
  "contractId",
  "loanId",
  "id",
]);

function stripIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIdentifiers);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (IDENTIFIER_KEYS.has(k)) continue;
      out[k] = stripIdentifiers(v);
    }
    return out;
  }
  return value;
}

test("SAI-4: 5社は、会社ID・会社名・適用プロファイル等の識別情報以外、初期条件(財務・設備能力・人員/営業能力・品質/信用・在庫/債権債務・利用可能情報・養殖能力4,000トン)が完全に同一", () => {
  const result = runAutoplayCase({
    scenarioId: "baseline",
    seed: "sai4-test-identical-initial-conditions",
    quarters: 1,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    aquacultureCapacityOverrideHosoEqTons: 4000,
    managementProfilesEnabled: true,
  });

  const turn1Captures = result.quarterStartCaptures.filter((c) => c.turn === 1);
  assert.equal(turn1Captures.length, 5);

  // 養殖能力4,000トン（追加条件2・5で明記された項目）を明示的に確認する。
  for (const capture of turn1Captures) {
    assert.equal(capture.fixture.aquacultureCapacity, 4000, `会社 ${capture.companyId} の養殖能力が4,000トンになっていない`);
  }

  const [reference, ...rest] = turn1Captures;
  const referenceFixture = JSON.stringify(stripIdentifiers(reference.fixture));
  // 【設備能力・人員/営業能力】fixture全体（工場能力・ワーカー技能・養殖能力・
  // 商品経済性等）を比較。
  const referenceOwnState = JSON.stringify(stripIdentifiers(reference.ownState));
  // 【財務・品質/信用・在庫/債権債務・利用可能情報】ownState全体
  // （financeState・qualityScoreByProduct・customerTrustByMarket・
  // rawMaterialLots・finishedGoodsLots等）を比較。
  const referencePublicInfo = JSON.stringify(stripIdentifiers(reference.publicInfo));

  for (const capture of rest) {
    assert.equal(
      JSON.stringify(stripIdentifiers(capture.fixture)),
      referenceFixture,
      `会社 ${capture.companyId} のfixture（設備能力・人員/営業能力等）が基準会社(${reference.companyId})と異なる`
    );
    assert.equal(
      JSON.stringify(stripIdentifiers(capture.ownState)),
      referenceOwnState,
      `会社 ${capture.companyId} のownState（財務・品質/信用・在庫/債権債務等）が基準会社(${reference.companyId})と異なる`
    );
    assert.equal(
      JSON.stringify(stripIdentifiers(capture.publicInfo)),
      referencePublicInfo,
      `会社 ${capture.companyId} のpublicInfo（利用可能情報）が基準会社(${reference.companyId})と異なる`
    );
  }
});

// ---------------------------------------------------------------------
// E社（機会追求・速い反応型、JPQ）の安定性テスト
// ---------------------------------------------------------------------
//
// 実装指示§9「E社に既存パラメータ選択だけでは表現できない反応の速さを無理に
// 新規状態管理で実装しない」「四半期ごとの配分が乱高下（振り子的挙動）しない
// こと」を確認する。しきい値0.6（60%）は、複数seedでの実測値（最大約23%の
// 四半期間変化率）に十分な余裕を持たせた値であり、明らかな振り子的挙動
// （前四半期比で数倍に跳ねる等）だけを検出する意図（テストのflaky化を避ける）。
const E_COMPANY_STABILITY_SEEDS = [
  "sai4-e-stability-001",
  "sai4-e-stability-002",
  "sai4-e-stability-003",
  "sai4-e-stability-004",
  "sai4-e-stability-005",
];
const MAX_QUARTER_OVER_QUARTER_RATIO = 0.6;

function quarterOverQuarterRatios(series: readonly number[]): number[] {
  const ratios: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    if (prev <= 1e-6) continue;
    ratios.push(Math.abs(series[i] - prev) / prev);
  }
  return ratios;
}

for (const seed of E_COMPANY_STABILITY_SEEDS) {
  test(`SAI-4: E社(JPQ, opportunistic)は8四半期にわたり配分が乱高下しない（seed=${seed}）`, () => {
    const result = runAutoplayCase({
      scenarioId: "baseline",
      seed,
      quarters: 8,
      companyIds: ALL_COMPANY_IDS,
      candidate,
      managementProfilesEnabled: true,
    });

    const diags = result.diagnostics.filter((d) => d.companyId === "JPQ").sort((a, b) => a.turn - b.turn);
    assert.equal(diags.length, 8);

    const stockingSeries = diags.map((d) => d.decision.aquacultureStockingPlans.reduce((s, p) => s + p.plannedStockingQuantity, 0));
    const desiredSalesSeries = diags.map((d) => d.decision.salesPlans.reduce((s, p) => s + p.desiredQuantity, 0));
    const productionSeries = diags.map((d) => d.decision.productionPlans.reduce((s, p) => s + p.desiredQuantity, 0));

    for (const [label, series] of [
      ["養殖池入れ計画", stockingSeries],
      ["販売希望数量", desiredSalesSeries],
      ["生産計画", productionSeries],
    ] as const) {
      const ratios = quarterOverQuarterRatios(series);
      for (let i = 0; i < ratios.length; i++) {
        assert.ok(
          ratios[i] <= MAX_QUARTER_OVER_QUARTER_RATIO,
          `E社(JPQ)の${label}が turn ${i + 1}→${i + 2} で${(ratios[i] * 100).toFixed(1)}%変化しており、` +
            `振り子的挙動の疑いがある（許容: ${MAX_QUARTER_OVER_QUARTER_RATIO * 100}%以下、系列: ${series.map((v) => v.toFixed(1)).join(", ")}）`
        );
      }
    }
  });
}

test("SAI-4: managementProfile.baselineDecisionは、appliedBiasItemsが1件以上ある会社・四半期でのみ設定される", () => {
  const result = runAutoplayCase({
    scenarioId: "baseline",
    seed: "sai4-test-baseline-decision-presence",
    quarters: 2,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    managementProfilesEnabled: true,
  });
  for (const diag of result.diagnostics) {
    const mp = diag.managementProfile;
    assert.ok(mp, `会社 ${diag.companyId} の診断にmanagementProfileが付与されていない`);
    if (mp!.appliedBiasItems.length > 0) {
      assert.ok(mp!.baselineDecision, `会社 ${diag.companyId} はバイアスありなのにbaselineDecisionが計算されていない`);
    } else {
      assert.equal(mp!.baselineDecision, undefined, `会社 ${diag.companyId} はバイアスなしなのにbaselineDecisionが計算されている（無駄な二重計算）`);
    }
  }
});
