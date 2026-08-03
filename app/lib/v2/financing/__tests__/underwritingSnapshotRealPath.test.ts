// ShrimpX V2 — 与信スナップショットの実行経路接続テスト（資金繰り診断・2026-08-03）
//
// 【目的】financing/liquidityClose.tsに追加したobservation-onlyフック
// （setUnderwritingSnapshotObserver / setLoanRollForwardObserver）が
// (a) 本番の実行結果・RNG消費・意思決定・会社状態を一切変更しないこと、
// (b) 実際にcomputeBorrowingCapacityへ渡された入力から現行仕様で再計算すると
//     本番の実行結果と完全一致すること、
// (c) 候補計算・ロールフォワードが実際の実行経路に接続していること
// を、fixed-value FINDIAG-1..9（構造のcharacterization）とは別に、
// 実シミュレーション実行から検証する。

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CompanyLabConfig } from "../../companyLab/types";
import {
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
  STANDARD_BASELINE_CANDIDATES,
} from "../../companyLab/standardAi/report/standardBaseline";
import {
  ALL_COMPANY_IDS,
  initializeUnifiedCompanyLabFromTemplate,
  runFromInit,
} from "../../companyLab/standardAi/report/decomposeHarness";
import { generateStandardAiDecision } from "../../companyLab/standardAi/policy";
import {
  setUnderwritingSnapshotObserver,
  setLoanRollForwardObserver,
  UnderwritingSnapshot,
  LoanRollForwardSnapshot,
} from "../liquidityClose";
import { computeBorrowingCapacity } from "../borrowingCapacity";
import { FINANCING_PARAMETERS_V1 } from "../parameters";
import { periodToString } from "../../core/period";
import { CompanyId } from "../../sales/types";

const BASE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
const SEED = "sai3a-grid-001";
const TURNS = 8;

function runOnce(withObservers: boolean) {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: SEED, turns: TURNS };
  const uwSnapshots: UnderwritingSnapshot[] = [];
  const rfSnapshots: LoanRollForwardSnapshot[] = [];
  if (withObservers) {
    setUnderwritingSnapshotObserver((s) => uwSnapshots.push(s));
    setLoanRollForwardObserver((s) => rfSnapshots.push(s));
  }
  try {
    const initResult = initializeUnifiedCompanyLabFromTemplate(
      config,
      BASE.buildFixtureTemplate,
      BASE.financeFixtureTemplate,
      BASE.contractDefs,
      ALL_COMPANY_IDS
    );
    const result = runFromInit(initResult, generateStandardAiDecision);
    return { result, uwSnapshots, rfSnapshots };
  } finally {
    setUnderwritingSnapshotObserver(undefined);
    setLoanRollForwardObserver(undefined);
  }
}

function stableStringify(x: unknown): string {
  // history中のPeriodV2やUsd/Ton等のbrand型はプリミティブなので、JSON.stringifyの
  // キー順の揺れだけ気にすればよい。会社ID→turnの安定順で入っているためsortは不要。
  return JSON.stringify(x);
}

test("SNAP-1: 【observation-only確認】オブザーバーの有無でシミュレーション結果が完全に同一である（同一seed）", () => {
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

test("SNAP-2: 【決定性確認】同一seedで2回実行すると、捕捉されるスナップショット自体も完全に同一である", () => {
  const run1 = runOnce(true);
  const run2 = runOnce(true);
  assert.equal(stableStringify(run1.uwSnapshots), stableStringify(run2.uwSnapshots));
  assert.equal(stableStringify(run1.rfSnapshots), stableStringify(run2.rfSnapshots));
});

test("SNAP-3: 【同一時点の完全一致】実際に捕捉した入力から現行パラメータで再計算すると、本番のborrowingCapacityResultと全フィールドが一致する", () => {
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

test("SNAP-4: スナップショットの各入力フィールドは、単一の引受時点（同一のcomputeBorrowingCapacity呼び出し）に属する（構造的保証の確認）", () => {
  // borrowingCapacityInputはliquidityClose.ts内で1つのconstとして組み立てられ、
  // computeBorrowingCapacityへそのまま渡され、同じ参照がオブザーバーへも渡される
  // （scripts/financingSnapshotDiagnosis.ts collectSnapshotsのコメント参照）。
  // ここでは「捕捉したinputとresultのcompanyId/periodが一致する」ことで
  // 混線がないことを確認する（別turn・別社の値が紛れ込んでいないことの検証）。
  const { uwSnapshots } = runOnce(true);
  for (const s of uwSnapshots) {
    assert.equal(s.borrowingCapacityInput.companyId, s.companyId);
    assert.equal(s.borrowingCapacityInput.period, s.period);
    assert.equal(s.borrowingCapacityResult.companyId, s.companyId);
    assert.equal(periodToString(s.borrowingCapacityResult.period), periodToString(s.period));
  }
});

test("SNAP-5: 候補計算では当期末B/S値を一切使わない（禁止された混在パターンの構造的防止）", () => {
  // borrowingCapacityInputの型そのものが「引受時点で銀行が参照してよい値」の
  // 集合として閉じている（当期の生産・市場実績を表すフィールドを持たない）。
  // ここではキー集合を固定し、当期実績由来のキーが将来紛れ込んでいないことを保証する。
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

test("SNAP-6: 7点ロールフォワードは内部的に整合する（前期末+通常+緊急-実際元本=当期末、floating-point許容誤差内）", () => {
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

test("SNAP-7: 緊急融資のみが発動したturnでは通常融資実行=0（二重計上の否定）", () => {
  const { rfSnapshots } = runOnce(true);
  const emergencyOnly = rfSnapshots.filter((rf) => rf.emergencyDrawUsd > 0);
  assert.ok(emergencyOnly.length > 0, "少なくとも1件は緊急融資が発動する行があること（standard baselineの既知挙動）");
  for (const rf of emergencyOnly) {
    assert.equal(rf.normalDrawUsd, 0, `${rf.companyId} ${periodToString(rf.period)}: 緊急融資発動時は通常融資実行が0であるべき`);
  }
});

test("SNAP-8: 健全fixtureは通常融資が承認される（承認経路が実際の実行系列を通して生きていることの確認）", () => {
  const { uwSnapshots } = runOnce(true);
  const approved = uwSnapshots.filter((s) => s.underwriting.approvedAmountUsd > 0);
  assert.ok(approved.length > 0, "standard baseline実行中に少なくとも1件は通常融資が承認されること");
});

test("SNAP-9: 与信が凍結される、または既存債務がgrossLimitを上回るケースでは通常融資が却下される", () => {
  const { uwSnapshots } = runOnce(true);
  const ineligible = uwSnapshots.filter((s) => s.borrowingCapacityResult.availableAdditionalCapacityUsd <= 0 && s.requestedAmountUsd > 0);
  assert.ok(ineligible.length > 0);
  for (const s of ineligible) {
    assert.equal(s.underwriting.approvedAmountUsd, 0, `${s.companyId} ${periodToString(s.period)}: 余力0のはずが承認額>0`);
  }
});

test("SNAP-10: 承認額は借入余力枠・申請額のいずれも超えない（実行経路全体での検証）", () => {
  const { uwSnapshots } = runOnce(true);
  for (const s of uwSnapshots) {
    assert.ok(s.underwriting.approvedAmountUsd <= s.borrowingCapacityResult.availableAdditionalCapacityUsd + 1e-6);
    assert.ok(s.underwriting.approvedAmountUsd <= s.requestedAmountUsd + 1e-6);
  }
});

test("SNAP-11: turn3・BAL社の同一スナップショットから、earningsMultiple=8.0で再計算すると三宅さんの手計算(約99.403344M / 約45.703344M)と一致する", () => {
  const { uwSnapshots } = runOnce(true);
  const turn3Rows = uwSnapshots.filter((s) => periodToString(s.period) === "2015Q3" && s.companyId === ("BAL" as CompanyId));
  assert.equal(turn3Rows.length, 1, "turn3(2015Q3)のBAL行が1件だけ捕捉されること");
  const s = turn3Rows[0];
  const params = { ...FINANCING_PARAMETERS_V1, borrowingCapacity: { ...FINANCING_PARAMETERS_V1.borrowingCapacity, earningsMultiple: 8.0 } };
  const r = computeBorrowingCapacity(s.borrowingCapacityInput, params);
  assert.equal(Math.round(r.earningsBasedLimitUsd), 99_403_344);
  assert.equal(Math.round(r.grossLimitUsd), 99_403_344);
  assert.equal(Math.round(r.availableAdditionalCapacityUsd), 45_703_344);
});
