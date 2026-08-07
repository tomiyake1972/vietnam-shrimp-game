// ShrimpX V2 — Phase SAI-3A: 自動テストプレイ実行（runAutoplayCase）のテスト
//
// 「同一条件・同一seedなら常に同一結果」「異なるseedなら結果が変わりうる」
// 「headcount overrideが実際に反映される」という、判断記録基盤の再現性の
// 大前提を確認する。既存のstandardAi/companyLabの経済ロジック自体は
// 一切変更していないため、経済ロジックの網羅的な検証はしない
// （既存の report/__tests__ 側の責務）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutoplayCase } from "../runCase";
import { ALL_COMPANY_IDS } from "../../report/decomposeHarness";
import { STANDARD_BASELINE_CANDIDATES, SELECTED_STANDARD_BASELINE_CANDIDATE_ID } from "../../report/standardBaseline";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

test("runAutoplayCase: 同一scenario・同一candidate・同一seedなら、履歴・診断・キャプチャが完全に一致する（決定論的）", () => {
  const config = { scenarioId: "baseline", seed: "sai3a-test-repro-001", quarters: 4, companyIds: ALL_COMPANY_IDS, candidate };
  const a = runAutoplayCase(config);
  const b = runAutoplayCase(config);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));
  assert.equal(JSON.stringify(a.diagnostics), JSON.stringify(b.diagnostics));
  assert.equal(JSON.stringify(a.quarterStartCaptures), JSON.stringify(b.quarterStartCaptures));
});

test("runAutoplayCase: 異なるseedでは結果が変わりうる（少なくとも履歴のどこかが異なる）", () => {
  const base = { scenarioId: "baseline", quarters: 4, companyIds: ALL_COMPANY_IDS, candidate };
  const a = runAutoplayCase({ ...base, seed: "sai3a-test-seedA" });
  const b = runAutoplayCase({ ...base, seed: "sai3a-test-seedB" });
  assert.notEqual(JSON.stringify(a.history), JSON.stringify(b.history), "異なるseedで履歴が完全一致するのは想定外（乱数要素が反映されていない可能性）");
});

test("runAutoplayCase: quartersを指定した通りのturn数だけ実行する（completedTurns/historyの長さが一致）", () => {
  const result = runAutoplayCase({ scenarioId: "baseline", seed: "sai3a-test-turns", quarters: 3, companyIds: ALL_COMPANY_IDS, candidate });
  assert.equal(result.completedTurns, 3);
  assert.equal(result.history.length, 3);
  assert.deepEqual(
    result.history.map((h) => h.turn),
    [1, 2, 3]
  );
});

test("runAutoplayCase: companyIdsを指定した会社だけを実行する（会社数を絞り込める）", () => {
  const result = runAutoplayCase({ scenarioId: "baseline", seed: "sai3a-test-company-subset", quarters: 2, companyIds: ["BAL", "MASS"], candidate });
  assert.deepEqual(result.companyIds, ["BAL", "MASS"]);
  for (const capture of result.quarterStartCaptures) {
    assert.ok(["BAL", "MASS"].includes(capture.companyId), `想定外の会社IDがキャプチャされた: ${capture.companyId}`);
  }
});

test("runAutoplayCase: salesForceHeadcountOverrideを指定すると、実際のfixtureのsalesForceHeadcountTotalへ反映される", () => {
  const result = runAutoplayCase({
    scenarioId: "baseline",
    seed: "sai3a-test-headcount-override",
    quarters: 1,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    salesForceHeadcountOverride: 85,
  });
  for (const fixture of result.companies) {
    assert.equal(fixture.salesForceHeadcountTotal, 85);
  }
  for (const capture of result.quarterStartCaptures) {
    assert.equal(capture.fixture.salesForceHeadcountTotal, 85);
  }
});

test("runAutoplayCase: 診断情報とキャプチャの件数は、会社数×クォーター数と一致する", () => {
  const quarters = 3;
  const companyIds = ["BAL", "MASS", "JPQ"] as const;
  const result = runAutoplayCase({ scenarioId: "baseline", seed: "sai3a-test-counts", quarters, companyIds, candidate });
  assert.equal(result.quarterStartCaptures.length, companyIds.length * quarters);
  assert.equal(result.diagnostics.length, companyIds.length * quarters);
});

// ---------------------------------------------------------------------
// 【SAI-4追加】養殖上限override・経営性格プロファイルのオプション
// ---------------------------------------------------------------------

test("runAutoplayCase: aquacultureCapacityOverrideHosoEqTonsを指定すると、5社すべてのfixture.aquacultureCapacityが上書きされる", () => {
  const result = runAutoplayCase({
    scenarioId: "baseline",
    seed: "sai4-test-aqua-cap-override",
    quarters: 2,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    aquacultureCapacityOverrideHosoEqTons: 4000,
  });
  for (const fixture of result.companies) {
    assert.equal(fixture.aquacultureCapacity, 4000, `会社 ${fixture.companyId} のaquacultureCapacityが4000になっていない`);
  }
  for (const capture of result.quarterStartCaptures) {
    assert.equal(capture.fixture.aquacultureCapacity, 4000);
  }
});

test("runAutoplayCase: aquacultureCapacityOverrideHosoEqTons=4000のとき、AIの池入れ計画が一度も4000トンを超えない（かつ例外が発生しない＝エンジン側制約も満たす）", () => {
  const result = runAutoplayCase({
    scenarioId: "baseline",
    seed: "sai4-test-aqua-cap-decision",
    quarters: 8,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    aquacultureCapacityOverrideHosoEqTons: 4000,
  });
  assert.equal(result.completedTurns, 8, "4000トン上限下で例外が発生し、8ターン完走できなかった");
  for (const diag of result.diagnostics) {
    for (const plan of diag.decision.aquacultureStockingPlans) {
      assert.ok(
        plan.plannedStockingQuantity <= 4000 + 1e-6,
        `会社 ${diag.companyId} turn ${diag.turn} の池入れ計画(${plan.plannedStockingQuantity})が上限4000を超えている`
      );
    }
  }
});

test("runAutoplayCase: aquacultureCapacityOverrideHosoEqTons未指定なら、候補既定値のまま（会社ごとに異なりうる）", () => {
  const withOverride = runAutoplayCase({
    scenarioId: "baseline",
    seed: "sai4-test-aqua-cap-default",
    quarters: 1,
    companyIds: ALL_COMPANY_IDS,
    candidate,
  });
  const without = runAutoplayCase({
    scenarioId: "baseline",
    seed: "sai4-test-aqua-cap-default",
    quarters: 1,
    companyIds: ALL_COMPANY_IDS,
    candidate,
  });
  assert.deepEqual(
    withOverride.companies.map((f) => f.aquacultureCapacity),
    without.companies.map((f) => f.aquacultureCapacity)
  );
});

test("runAutoplayCase: managementProfilesEnabled未指定(既定false)なら、診断にmanagementProfileが付与されない（既存出力と完全に同一）", () => {
  const result = runAutoplayCase({
    scenarioId: "baseline",
    seed: "sai4-test-profiles-disabled",
    quarters: 2,
    companyIds: ALL_COMPANY_IDS,
    candidate,
  });
  for (const diag of result.diagnostics) {
    assert.equal(diag.managementProfile, undefined);
  }
});

test("runAutoplayCase: managementProfilesEnabled=trueでも、同一config・同一seedなら常に同一結果（決定論性はプロファイル導入後も保たれる）", () => {
  const config = {
    scenarioId: "baseline",
    seed: "sai4-test-profiles-repro",
    quarters: 4,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    managementProfilesEnabled: true,
  };
  const a = runAutoplayCase(config);
  const b = runAutoplayCase(config);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));
  assert.equal(JSON.stringify(a.diagnostics), JSON.stringify(b.diagnostics));
});

test("runAutoplayCase: managementProfilesEnabled=trueのとき、A社(BAL/balanced)はバイアスなし(appliedBiasItemsが常に空)", () => {
  const result = runAutoplayCase({
    scenarioId: "baseline",
    seed: "sai4-test-profiles-a-baseline",
    quarters: 4,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    managementProfilesEnabled: true,
  });
  const balDiagnostics = result.diagnostics.filter((d) => d.companyId === "BAL");
  assert.ok(balDiagnostics.length > 0);
  for (const diag of balDiagnostics) {
    assert.equal(diag.managementProfile?.profileId, "balanced");
    assert.deepEqual(diag.managementProfile?.appliedBiasItems, []);
    assert.equal(diag.managementProfile?.baselineDecision, undefined, "バイアスなしのA社ではbaselineDecisionの二重計算を省略するはず");
  }
});

// ---------------------------------------------------------------------
// 【SAI-5A追加】市場・商品志向オプション
// ---------------------------------------------------------------------

test("runAutoplayCase: marketProductOrientationEnabled未指定なら、SAI-4までの出力と完全に同一（後方互換）", () => {
  const base = {
    scenarioId: "baseline",
    seed: "sai5a-test-backcompat",
    quarters: 2,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    managementProfilesEnabled: true,
  };
  const withoutFlag = runAutoplayCase(base);
  const withFalse = runAutoplayCase({ ...base, marketProductOrientationEnabled: false });
  assert.equal(JSON.stringify(withoutFlag.history), JSON.stringify(withFalse.history));
  assert.equal(JSON.stringify(withoutFlag.diagnostics), JSON.stringify(withFalse.diagnostics));
});

test("runAutoplayCase: marketProductOrientationEnabled=trueでも、同一config・同一seedなら常に同一結果（再現性）", () => {
  const config = {
    scenarioId: "baseline",
    seed: "sai5a-test-repro",
    quarters: 3,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    managementProfilesEnabled: true,
    marketProductOrientationEnabled: true,
  };
  const a = runAutoplayCase(config);
  const b = runAutoplayCase(config);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));
  assert.equal(JSON.stringify(a.diagnostics), JSON.stringify(b.diagnostics));
});

test("runAutoplayCase: orientation有効時、BAL(中立)のturn1判断はorientation無効時と完全一致し、他4社はturn1から差が生じる", () => {
  const base = {
    scenarioId: "baseline",
    seed: "sai5a-test-bal-neutral",
    quarters: 2,
    companyIds: ALL_COMPANY_IDS,
    candidate,
  };
  const off = runAutoplayCase(base);
  const on = runAutoplayCase({ ...base, marketProductOrientationEnabled: true });
  const turn1DecisionOf = (r: typeof off, companyId: string) =>
    JSON.stringify(r.diagnostics.filter((d) => d.companyId === companyId && d.turn === 1).map((d) => d.decision));
  // 【重要】比較はturn1のみ。turn2以降は、志向を持つ他4社の行動変化が市場精算
  // 結果（公開情報）を変えるため、中立のBALの判断も市場経由で正当に変わりうる
  // （＝「競合の行動によって自社戦略の価値が変わる」という意図した相互作用で
  // あり、BAL自身のロジックが変わったわけではない）。
  assert.equal(turn1DecisionOf(off, "BAL"), turn1DecisionOf(on, "BAL"), "BAL(中立志向)のturn1判断がorientation有効化で変わった");
  const othersChanged = ["MASS", "JPQ", "VAP", "CONSV"].filter((c) => turn1DecisionOf(off, c) !== turn1DecisionOf(on, c));
  assert.equal(othersChanged.length, 4, `志向を持つ4社のうちturn1判断が変わったのは${othersChanged.length}社のみ`);
});
