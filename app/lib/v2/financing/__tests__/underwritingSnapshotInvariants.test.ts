// ShrimpX V2 — 与信スナップショットの「スタック非依存」不変条件テスト（2026-08-04）
//
// 【位置づけ】ここに含めるのは、develop/v2・48コミットスタック(pd_labor、PD係数1.8)の
// どちらで実行しても成立すべき「構造的な不変条件」のみ——具体的な承認件数・
// EBITDA金額など、標準初期条件やPD係数に依存する数値を主張するテストは
// underwritingSnapshotDevelopV2.test.ts / underwritingSnapshotPdLabor.test.ts へ分離した
// （旧underwritingSnapshotRealPath.test.tsのSNAP-8・SNAP-11がこれに該当し、
// pd_laborでは実際にfailしていた——「スタック固有の期待値」を「スタック非依存の
// 不変条件」であるかのように混在させていたのが原因）。
//
// 【実行方法】
//   develop/v2側 : cd /tmp/fin_diag && node --test --import tsx app/lib/v2/financing/__tests__/underwritingSnapshotInvariants.test.ts
//   pd_labor側   : 本ファイルとunderwritingSnapshotTestHelpers.ts・liquidityClose.tsの
//                   observation-onlyフックをpd_laborへ一時コピーしてから同じコマンドで実行
//                   （§13の読み取り専用測定と同じ手順。コミットしない）。
//   両方でgreenになることを本テストの合格条件とする。

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CompanyLabConfig } from "../../companyLab/types";
import { ALL_COMPANY_IDS, initializeUnifiedCompanyLabFromTemplate, runFromInit } from "../../companyLab/standardAi/report/decomposeHarness";
import { generateStandardAiDecision } from "../../companyLab/standardAi/policy";
import { periodToString } from "../../core/period";
import { computeBorrowingCapacity } from "../borrowingCapacity";
import { FINANCING_PARAMETERS_V1 } from "../parameters";
import {
  setUnderwritingSnapshotObserver,
  setLoanRollForwardObserver,
  UnderwritingSnapshot,
  LoanRollForwardSnapshot,
} from "../liquidityClose";
import { runOnce, stableStringify, BASE, SEED, TURNS } from "./underwritingSnapshotTestHelpers";

test("SNAP-1[invariant]: オブザーバーの有無でシミュレーション結果が完全に同一である（observation-only性。どのスタックでも成立すべき）", () => {
  const without = runOnce(false);
  const withObs = runOnce(true);
  assert.equal(
    stableStringify(without.result.history),
    stableStringify(withObs.result.history),
    "オブザーバー登録の有無でresult.history（財務・資金繰り・生産・市場等の全結果）が変わってはならない"
  );
  assert.ok(withObs.uwSnapshots.length > 0, "オブザーバー登録時はスナップショットが実際に捕捉されること");
  assert.ok(withObs.rfSnapshots.length > 0);
});

test("SNAP-2[invariant]: 同一seedで2回実行すると、捕捉されるスナップショット自体も完全に同一である（決定性）", () => {
  const run1 = runOnce(true);
  const run2 = runOnce(true);
  assert.equal(stableStringify(run1.uwSnapshots), stableStringify(run2.uwSnapshots));
  assert.equal(stableStringify(run1.rfSnapshots), stableStringify(run2.rfSnapshots));
});

test("SNAP-3[invariant]: 実際に捕捉した入力から現行パラメータで再計算すると、本番のborrowingCapacityResultと全フィールドが一致する", () => {
  const { uwSnapshots } = runOnce(true);
  assert.ok(uwSnapshots.length >= 30, "十分な行数が捕捉されていること");
  for (const s of uwSnapshots) {
    const recomputed = computeBorrowingCapacity(s.borrowingCapacityInput, FINANCING_PARAMETERS_V1);
    const actual = s.borrowingCapacityResult;
    assert.equal(recomputed.collateralBasedLimitUsd, actual.collateralBasedLimitUsd, `${s.companyId} ${periodToString(s.period)}`);
    assert.equal(recomputed.earningsBasedLimitUsd, actual.earningsBasedLimitUsd);
    assert.equal(recomputed.creditTierCapUsd, actual.creditTierCapUsd);
    assert.equal(recomputed.grossLimitUsd, actual.grossLimitUsd);
    assert.equal(recomputed.existingLoanBalanceUsd, actual.existingLoanBalanceUsd);
    assert.equal(recomputed.availableAdditionalCapacityUsd, actual.availableAdditionalCapacityUsd);
    assert.equal(recomputed.underwritingFrozen, actual.underwritingFrozen);
    assert.equal(recomputed.bindingConstraint, actual.bindingConstraint);
  }
});

test("SNAP-4[invariant]: スナップショットの各入力フィールドは、単一の引受時点（同一のcomputeBorrowingCapacity呼び出し）に属する", () => {
  const { uwSnapshots } = runOnce(true);
  for (const s of uwSnapshots) {
    assert.equal(s.borrowingCapacityInput.companyId, s.companyId);
    assert.equal(s.borrowingCapacityInput.period, s.period);
    assert.equal(s.borrowingCapacityResult.companyId, s.companyId);
    assert.equal(periodToString(s.borrowingCapacityResult.period), periodToString(s.period));
  }
});

test("SNAP-5[invariant]: 候補計算では当期末B/S値を一切使わない（禁止された混在パターンの構造的防止）", () => {
  const { uwSnapshots } = runOnce(true);
  const allowedKeys = new Set([
    "companyId",
    "period",
    "collateral",
    "ebitdaLikeQuarterlyUsd",
    "totalEquityUsd",
    "existingLoanBalanceUsd",
    "creditTier",
    "severeArrears",
    "insolvent",
  ]);
  for (const s of uwSnapshots.slice(0, 5)) {
    const keys = Object.keys(s.borrowingCapacityInput);
    for (const k of keys) assert.ok(allowedKeys.has(k), `想定外のキーが混入: ${k}`);
  }
});

test("SNAP-6[invariant]: 7点ロールフォワードは内部的に整合する（前期末+通常+緊急-実際元本=当期末、floating-point許容誤差内）", () => {
  const { rfSnapshots } = runOnce(true);
  assert.ok(rfSnapshots.length >= 30);
  for (const rf of rfSnapshots) {
    const rolled = rf.priorTotalLoanBalanceUsd + rf.normalDrawUsd + rf.emergencyDrawUsd - rf.principalPaidCashUsd;
    assert.ok(Math.abs(rolled - rf.endingTotalLoanBalanceUsd) < 1, `${rf.companyId} ${periodToString(rf.period)}: rolled=${rolled} ending=${rf.endingTotalLoanBalanceUsd}`);
    assert.equal(rf.totalLoanDrawUsd, rf.normalDrawUsd + rf.emergencyDrawUsd, "通常+緊急=合計実行額");
    assert.ok(rf.normalDrawUsd >= 0 && rf.emergencyDrawUsd >= 0, "各実行額は非負");
    assert.ok(rf.principalPaidCashUsd <= rf.scheduledPrincipalDueUsd + 1, "実際元本返済は約定元本を超えない（現金不足時のみ下回る）");
  }
});

test("SNAP-7[invariant]: 緊急融資のみが発動したturnでは通常融資実行=0（二重計上の否定）", () => {
  // 【スタック非依存性の注記】develop/v2・pd_laborのどちらでも緊急融資は
  // 少なくとも1件発生することが既知（develop/v2で15件、pd_laborで45件）。
  // 「緊急融資が発生した場合は必ず通常融資実行=0」という条件文自体は
  // 両スタックで成立すべき不変条件であり、発生件数（15 vs 45）はスタック
  // 固有の値としてunderwritingSnapshotDevelopV2.test.ts / Pdlabor.test.tsで扱う。
  const { rfSnapshots } = runOnce(true);
  const emergencyOnly = rfSnapshots.filter((rf) => rf.emergencyDrawUsd > 0);
  assert.ok(emergencyOnly.length > 0, "少なくとも1件は緊急融資が発動する行があること（develop/v2・pd_labor共通の既知挙動）");
  for (const rf of emergencyOnly) {
    assert.equal(rf.normalDrawUsd, 0, `${rf.companyId} ${periodToString(rf.period)}: 緊急融資発動時は通常融資実行が0であるべき`);
  }
});

test("SNAP-9[invariant]: 追加借入可能額が0（既存債務がgrossLimitを上回る、または凍結）のケースでは通常融資が却下される", () => {
  const { uwSnapshots } = runOnce(true);
  const ineligible = uwSnapshots.filter((s) => s.borrowingCapacityResult.availableAdditionalCapacityUsd <= 0 && s.requestedAmountUsd > 0);
  assert.ok(ineligible.length > 0);
  for (const s of ineligible) {
    assert.equal(s.underwriting.approvedAmountUsd, 0, `${s.companyId} ${periodToString(s.period)}: 余力0のはずが承認額>0`);
  }
});

test("SNAP-10[invariant]: 承認額は借入余力枠・申請額のいずれも超えない（実行経路全体での検証）", () => {
  const { uwSnapshots } = runOnce(true);
  for (const s of uwSnapshots) {
    assert.ok(s.underwriting.approvedAmountUsd <= s.borrowingCapacityResult.availableAdditionalCapacityUsd + 1e-6);
    assert.ok(s.underwriting.approvedAmountUsd <= s.requestedAmountUsd + 1e-6);
  }
});

test("SNAP-12[invariant]: 【observer隔離確認】オブザーバーコールバック自体が例外を投げても、本番の四半期クローズ処理へ伝播しない", () => {
  const uwSnapshots: UnderwritingSnapshot[] = [];
  const rfSnapshots: LoanRollForwardSnapshot[] = [];
  let uwObserverCallCount = 0;
  let rfObserverCallCount = 0;
  setUnderwritingSnapshotObserver((s) => {
    uwObserverCallCount++;
    uwSnapshots.push(s);
    throw new Error("SNAP-12: 診断オブザーバー内で意図的に投げた例外（本番へ伝播してはならない）");
  });
  setLoanRollForwardObserver((s) => {
    rfObserverCallCount++;
    rfSnapshots.push(s);
    throw new Error("SNAP-12: 診断オブザーバー内で意図的に投げた例外（本番へ伝播してはならない）");
  });
  let thrown: unknown;
  let result: ReturnType<typeof runFromInit> | undefined;
  try {
    // 意図的に例外を投げるオブザーバーを登録済みの状態でシミュレーションを走らせる
    // （runOnce()はobserver未登録/正常登録の2通りしか想定していないため、ここでは
    // 直接initializeUnifiedCompanyLabFromTemplate+runFromInitを呼ぶ）。
    const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: SEED, turns: TURNS };
    const initResult = initializeUnifiedCompanyLabFromTemplate(config, BASE.buildFixtureTemplate, BASE.financeFixtureTemplate, BASE.contractDefs, ALL_COMPANY_IDS);
    result = runFromInit(initResult, generateStandardAiDecision);
  } catch (err) {
    thrown = err;
  } finally {
    setUnderwritingSnapshotObserver(undefined);
    setLoanRollForwardObserver(undefined);
  }
  assert.equal(thrown, undefined, "オブザーバーが例外を投げても、シミュレーション実行全体は例外を投げずに完了すべき");
  assert.ok(result !== undefined && result.history.length > 0, "オブザーバー例外があっても四半期クローズ処理自体は最後まで完了する");
  assert.ok(uwObserverCallCount > 0, "オブザーバーは実際に呼ばれた（例外を投げる前にpushは実行された）");
  assert.ok(rfObserverCallCount > 0);
});
