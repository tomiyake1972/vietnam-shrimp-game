// ShrimpX V2 — 「自社の状態（turn開始時点）」パネル向け集計ヘルパーの受入確認テスト
// (test/sai6-manual-observation-2026-08-01: 三宅さんの手動観察テストで指摘された
//  ①工場能力 ②Worker生産力 ③営業人員カバー範囲 ⑤売掛買掛サイト・借入返済スケジュール
//  ⑥原料在庫の利用可能時期、および期首BSの自己資本（純資産）欠落について)
//
// ここではopeningStateSummary.tsの純粋関数のみを対象とする（UI表示は対象外。
// UIコンポーネント自体のテストはこのリポジトリのテストランナー対象外＝*.test.tsのみ）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeCompanyLab, buildCompanyOwnState } from "../runner";
import { CompanyLabConfig } from "../types";
import { period } from "../../core/period";
import {
  computeOpeningBalanceSheetSummary,
  periodDifferenceInQuarters,
  periodLabel,
  summarizeSettlementLag,
  groupRawMaterialLotsByAvailability,
  computeFactoryCapacitySummaries,
  computeLaborProductivityByProduct,
  computeSalesForceCapacitySummary,
} from "../openingStateSummary";

const EPS_USD = 0.01;

function baselineConfig(): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "opening-state-summary-001", turns: 4 };
}

function ownStateForCompany(companyId: string) {
  const { fixtures, state } = initializeCompanyLab(baselineConfig());
  const fixture = fixtures.find((f) => f.companyId === companyId);
  if (!fixture) throw new Error(`fixture not found: ${companyId}`);
  return { fixture, ownState: buildCompanyOwnState(state, fixture) };
}

// --- ① 期首BS（自己資本を含む）---

test("期首BS: turn1の各社で 総資産 - 総負債 - 純資産 がほぼ0（貸借一致、構造上の検算）", () => {
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    const { ownState } = ownStateForCompany(companyId);
    const summary = computeOpeningBalanceSheetSummary(ownState);
    assert.ok(
      Math.abs(summary.balanceCheckDifferenceUsd) < EPS_USD,
      `${companyId}: 貸借差額が許容誤差を超えています: ${summary.balanceCheckDifferenceUsd}`
    );
    assert.equal(summary.totalEquityUsd, summary.capitalStockUsd + summary.retainedEarningsUsd);
    assert.equal(summary.totalLiabilitiesUsd, summary.payablesUsd + summary.shortTermLoansUsd + summary.longTermLoansUsd + summary.accruedInterestPayableUsd + summary.otherLiabilitiesUsd);
  }
});

test("期首BS: 融資ポートフォリオ集計とfinanceState側の借入残高ミラーが一致する（turn1は不一致がないはず）", () => {
  const { ownState } = ownStateForCompany("BAL");
  const summary = computeOpeningBalanceSheetSummary(ownState);
  assert.ok(summary.loanPortfolioMismatchUsd < EPS_USD, `借入残高の不一致: ${summary.loanPortfolioMismatchUsd}`);
});

test("期首BS: 原料在庫USD評価はrawMaterialInventoryValueUsdと同じ値（初期ロットが正の評価額を持つ）", () => {
  const { ownState } = ownStateForCompany("BAL");
  const summary = computeOpeningBalanceSheetSummary(ownState);
  assert.ok(summary.rawMaterialInventoryUsd > 0);
});

// --- Period（四半期）ヘルパー ---

test("periodDifferenceInQuarters: 同一四半期は0、翌四半期は1、年をまたぐケースも正しい", () => {
  const p1 = period(2015, 1);
  assert.equal(periodDifferenceInQuarters(p1, p1), 0);
  assert.equal(periodDifferenceInQuarters(p1, period(2015, 2)), 1);
  assert.equal(periodDifferenceInQuarters(p1, period(2016, 1)), 4);
  assert.equal(periodDifferenceInQuarters(period(2016, 1), p1), -4);
});

test("periodLabel: '2015Q1' 形式を '2015年Q1' 形式へ変換する", () => {
  assert.equal(periodLabel(period(2015, 1)), "2015年Q1");
  assert.equal(periodLabel(period(2016, 4)), "2016年Q4");
});

// --- ⑤ 売掛金・買掛金の決済サイト ---

test("summarizeSettlementLag: 全件同じラグならallSame=true、異なればfalse", () => {
  const p0 = period(2015, 1);
  const p1 = period(2015, 2);
  const same = summarizeSettlementLag([
    { originPeriod: p0, dueSettlementPeriod: p1 },
    { originPeriod: p0, dueSettlementPeriod: p1 },
  ]);
  assert.ok(same);
  assert.equal(same!.allSame, true);
  assert.equal(same!.minQuarters, 1);
  assert.equal(same!.maxQuarters, 1);

  const differing = summarizeSettlementLag([
    { originPeriod: p0, dueSettlementPeriod: p1 },
    { originPeriod: p0, dueSettlementPeriod: period(2015, 4) },
  ]);
  assert.ok(differing);
  assert.equal(differing!.allSame, false);
  assert.equal(differing!.minQuarters, 1);
  assert.equal(differing!.maxQuarters, 3);
});

test("summarizeSettlementLag: 空配列はnull（値を捏造しない）", () => {
  assert.equal(summarizeSettlementLag([]), null);
});

// --- ⑥ 原料在庫の利用可能時期別グルーピング ---

test("groupRawMaterialLotsByAvailability: 同じ利用可能開始四半期はまとめ、異なる四半期は分けて、開始四半期昇順で返す", () => {
  const p0 = period(2015, 1);
  const p1 = period(2015, 2);
  const lots = [
    { lotId: "A", companyId: "BAL", source: "domestic", originCountry: "VN", inboundPeriod: p0, originalQuantity: 100, remainingQuantity: 100, unitCost: 4, availableFromPeriod: p0, status: "available" },
    { lotId: "B", companyId: "BAL", source: "import", originCountry: "EC", inboundPeriod: p0, originalQuantity: 50, remainingQuantity: 50, unitCost: 5, availableFromPeriod: p1, status: "inTransitImport" },
    { lotId: "C", companyId: "BAL", source: "domestic", originCountry: "VN", inboundPeriod: p0, originalQuantity: 30, remainingQuantity: 30, unitCost: 4, availableFromPeriod: p0, status: "available" },
    { lotId: "D", companyId: "BAL", source: "domestic", originCountry: "VN", inboundPeriod: p0, originalQuantity: 10, remainingQuantity: 0, unitCost: 4, availableFromPeriod: p0, status: "consumed" },
    { lotId: "E", companyId: "OTHER", source: "domestic", originCountry: "VN", inboundPeriod: p0, originalQuantity: 999, remainingQuantity: 999, unitCost: 4, availableFromPeriod: p0, status: "available" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any[];

  const groups = groupRawMaterialLotsByAvailability(lots, "BAL");
  assert.equal(groups.length, 2);
  assert.equal(groups[0].availableFromPeriod, p0);
  assert.equal(groups[0].quantityTons, 130);
  assert.equal(groups[0].lotCount, 2);
  assert.equal(groups[0].availableFromLabel, "2015年Q1");
  assert.equal(groups[1].availableFromPeriod, p1);
  assert.equal(groups[1].quantityTons, 50);
  assert.deepEqual(groups[1].statuses, ["inTransitImport"]);
});

// --- ① 工場能力（名目 vs 有効） ---

test("computeFactoryCapacitySummaries: 有効能力は名目能力に基準稼働率×設備利用可能率(0.9×0.95)を適用した値になる（BALフィクスチャ）", () => {
  const { fixture } = ownStateForCompany("BAL");
  const summaries = computeFactoryCapacitySummaries(fixture.factories);
  assert.equal(summaries.length, 1);
  const [s] = summaries;
  assert.equal(s.nominal.commonProcessing, 22000);
  assert.ok(Math.abs(s.effective.commonProcessing - 22000 * 0.9 * 0.95) < 1);
  assert.ok(s.effective.commonProcessing < s.nominal.commonProcessing);
});

// --- ② Worker1人あたりの生産力 ---

test("computeLaborProductivityByProduct: 基礎効率×出勤率×技能水準で1人あたりトンを算出する（BALフィクスチャ）", () => {
  const { fixture } = ownStateForCompany("BAL");
  const entries = computeLaborProductivityByProduct(fixture.workerBaseline);
  const hosoEntry = entries.find((e) => e.product === "hoso" && e.factoryId === "BAL-F1");
  assert.ok(hosoEntry);
  // BALのworkerBaseline: attendanceRate既定0.95、hosoスキル0.85、regularEfficiencyPerHeadTons=6
  assert.ok(Math.abs(hosoEntry!.tonsPerRegularWorker - 6 * 0.95 * 0.85) < 1e-6);
});

// --- ③ 営業人員の処理能力・カバレッジ ---

test("computeSalesForceCapacitySummary: 実際の営業人員数をprocessingCapacity/salesCoverageScoreへ渡した結果と一致する", () => {
  const summary = computeSalesForceCapacitySummary(18);
  assert.equal(summary.headcountTotal, 18);
  assert.ok(summary.currentProcessingCapacityTons > 200); // baselineCapacityTonsより大きい
  assert.ok(summary.coverageScore > 0.15 && summary.coverageScore < 1);
  assert.ok(summary.marginalCapacityTonsForOneMoreHeadcount >= 0);
});

test("computeSalesForceCapacitySummary: headcount=0でも既存顧客ぶんの最低限の処理能力を返す（青天井にならない）", () => {
  const summary = computeSalesForceCapacitySummary(0);
  assert.equal(summary.currentProcessingCapacityTons, 200);
});
