// ShrimpX V2 — Standard AI Investment Portfolio Calibration（Phase PC-1）単体テスト
//
// 指示§38のPC1-1〜7に対応させる。本フェーズはparameterを一切変更しない監査
// フェーズであり、ここでテストするのは新規追加した2つの純粋analyticsモジュール
// （investmentPortfolio.ts・factoryUtilizationMilestones.ts）と、既存engineの
// 決定論性（PC1-7）のみ。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPEX_CATEGORY_BY_PROJECT_TYPE,
  buildCompanyCapexBreakdown,
  buildCompanyPortfolioTotals,
  computeInvestmentMixPercent,
} from "../investmentPortfolio";
import { computeUtilizationMilestones } from "../factoryUtilizationMilestones";
import { CAPITAL_PROJECT_TYPES } from "../../../capex/types";
import { advanceSimulationTurn, createSimulationSession } from "../../simulation/engine";

const AT = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------
// PC1-1: investment categories reconcile
// ---------------------------------------------------------------------

test("PC1-1: CAPEXカテゴリ分類はCapitalProjectTypeの全10種を過不足なく被覆し、カテゴリ別合計は総額と一致する", () => {
  const classifiedTypes = Object.keys(CAPEX_CATEGORY_BY_PROJECT_TYPE);
  assert.equal(classifiedTypes.length, CAPITAL_PROJECT_TYPES.length, "分類されたprojectType数がCAPITAL_PROJECT_TYPESと一致しない");
  for (const t of CAPITAL_PROJECT_TYPES) {
    assert.ok(classifiedTypes.includes(t), `${t}が分類対象から漏れている`);
  }

  const paidUsdByProjectType = {
    newFactoryConstruction: 40_000_000,
    commonProcessingExpansion: 5_000_000,
    hosoLineExpansion: 8_000_000,
    pdLineExpansion: 6_000_000,
    vapLineExpansion: 4_000_000,
    freezingPackagingExpansion: 3_000_000,
    coldStorageExpansion: 2_000_000,
    pdMechanization: 1_500_000,
    qualityControlEquipment: 900_000,
    environmentalEquipment: 700_000,
  };
  const breakdown = buildCompanyCapexBreakdown(paidUsdByProjectType);
  const expectedTotal = Object.values(paidUsdByProjectType).reduce((a, b) => a + b, 0);
  assert.equal(breakdown.totalCapexUsd, expectedTotal);
  assert.equal(breakdown.growthCapexUsd + breakdown.productivityCapexUsd + breakdown.qualityCapexUsd, breakdown.totalCapexUsd);
});

// ---------------------------------------------------------------------
// PC1-2: VAP development counted as OPEX not CAPEX
// ---------------------------------------------------------------------

test("PC1-2: VAP Product Development支出はCAPEX集計から常に独立しており、totalCapexUsdへ一切混入しない", () => {
  const paidUsdByProjectType = { newFactoryConstruction: 10_000_000, pdMechanization: 1_000_000 };
  const withoutVapDev = buildCompanyPortfolioTotals("MASS", paidUsdByProjectType, 0);
  const withVapDev = buildCompanyPortfolioTotals("MASS", paidUsdByProjectType, 2_000_000);

  assert.equal(withoutVapDev.capex.totalCapexUsd, withVapDev.capex.totalCapexUsd, "VAP Development支出の有無でCAPEX総額が変わってしまっている");
  assert.equal(withVapDev.vapProductDevelopmentOpexUsd, 2_000_000);
  assert.equal(withVapDev.totalInvestmentUsd, withVapDev.capex.totalCapexUsd + 2_000_000, "表示専用合算totalInvestmentUsdの計算が誤り");
  // CapitalProjectTypeの列挙にVAP Product Developmentに相当する値が存在しないことを型レベルの事実として確認
  // （存在すればCAPITAL_PROJECT_TYPESに含まれ、CAPEX分類の対象になってしまう）。
  assert.ok(!CAPITAL_PROJECT_TYPES.some((t) => t.toLowerCase().includes("vap") && t.toLowerCase().includes("develop")));
});

// ---------------------------------------------------------------------
// PC1-3: factory utilization milestone tracking
// ---------------------------------------------------------------------

test("PC1-3: 稼働率の時系列（順不同・欠測混在）から、閾値到達ターンを正しく検出する", () => {
  const series = [
    { turn: 30, utilization: 0.9 },
    { turn: 27, utilization: null },
    { turn: 28, utilization: 0.2 },
    { turn: 29, utilization: 0.55 },
  ];
  const milestones = computeUtilizationMilestones(series);
  assert.equal(milestones.first50PctUtilizationTurn, 29);
  assert.equal(milestones.first70PctUtilizationTurn, 30);
});

test("PC1-3b: 一度も稼働開始していない（全ターンnull）場合は両方null", () => {
  const series = [
    { turn: 25, utilization: null },
    { turn: 26, utilization: null },
  ];
  const milestones = computeUtilizationMilestones(series);
  assert.equal(milestones.first50PctUtilizationTurn, null);
  assert.equal(milestones.first70PctUtilizationTurn, null);
});

// ---------------------------------------------------------------------
// PC1-4: 50% utilization detection
// ---------------------------------------------------------------------

test("PC1-4: 稼働率がちょうど50%に到達したターンを検出する（境界値含む）", () => {
  const series = [
    { turn: 25, utilization: 0.3 },
    { turn: 26, utilization: 0.5 },
    { turn: 27, utilization: 0.6 },
  ];
  const milestones = computeUtilizationMilestones(series);
  assert.equal(milestones.first50PctUtilizationTurn, 26, "ちょうど50%のターンを検出できていない");
});

test("PC1-4b: 50%へ一度も到達しない場合はnull（70%到達の有無に関わらず）", () => {
  const series = [
    { turn: 25, utilization: 0.1 },
    { turn: 26, utilization: 0.3 },
    { turn: 27, utilization: 0.49 },
  ];
  const milestones = computeUtilizationMilestones(series);
  assert.equal(milestones.first50PctUtilizationTurn, null);
});

// ---------------------------------------------------------------------
// PC1-5: 70% utilization detection
// ---------------------------------------------------------------------

test("PC1-5: 稼働率が70%に到達したターンを、50%到達ターンと独立に検出する", () => {
  const series = [
    { turn: 25, utilization: 0.55 },
    { turn: 26, utilization: 0.68 },
    { turn: 27, utilization: 0.71 },
  ];
  const milestones = computeUtilizationMilestones(series);
  assert.equal(milestones.first50PctUtilizationTurn, 25);
  assert.equal(milestones.first70PctUtilizationTurn, 27);
});

test("PC1-5b: 70%へ到達した後に稼働率が下がっても、初回到達ターンは保持される", () => {
  const series = [
    { turn: 25, utilization: 0.75 },
    { turn: 26, utilization: 0.4 },
    { turn: 27, utilization: 0.3 },
  ];
  const milestones = computeUtilizationMilestones(series);
  assert.equal(milestones.first70PctUtilizationTurn, 25, "初回到達ターンではなく直近値を見てしまっている");
});

// ---------------------------------------------------------------------
// PC1-6: company portfolio totals
// ---------------------------------------------------------------------

test("PC1-6: 会社別Portfolio合計・構成比（%）が正しく計算される", () => {
  const totals = buildCompanyPortfolioTotals(
    "JPQ",
    { newFactoryConstruction: 30_000_000, pdMechanization: 5_000_000, qualityControlEquipment: 5_000_000 },
    10_000_000
  );
  assert.equal(totals.capex.growthCapexUsd, 30_000_000);
  assert.equal(totals.capex.productivityCapexUsd, 5_000_000);
  assert.equal(totals.capex.qualityCapexUsd, 5_000_000);
  assert.equal(totals.capex.totalCapexUsd, 40_000_000);
  assert.equal(totals.totalInvestmentUsd, 50_000_000);

  const mix = computeInvestmentMixPercent(totals);
  assert.equal(mix.growthCapexPercent, 60);
  assert.equal(mix.productivityCapexPercent, 10);
  assert.equal(mix.qualityCapexPercent, 10);
  assert.equal(mix.vapProductDevelopmentPercent, 20);
  assert.equal(mix.growthCapexPercent + mix.productivityCapexPercent + mix.qualityCapexPercent + mix.vapProductDevelopmentPercent, 100);
});

test("PC1-6b: 投資が一切無い会社では0除算せず全項目0%になる", () => {
  const totals = buildCompanyPortfolioTotals("CONSV", {}, 0);
  const mix = computeInvestmentMixPercent(totals);
  assert.equal(mix.growthCapexPercent, 0);
  assert.equal(mix.productivityCapexPercent, 0);
  assert.equal(mix.qualityCapexPercent, 0);
  assert.equal(mix.vapProductDevelopmentPercent, 0);
});

// ---------------------------------------------------------------------
// PC1-7: deterministic benchmark
// ---------------------------------------------------------------------

function runShort(seed: string) {
  let session = createSimulationSession({
    simulationRunId: `pc1-determinism-${seed}`,
    scenarioId: "baseline",
    seed,
    requestedTurns: 8,
    startedAt: AT,
    standardAiProfileMode: "ON",
  });
  for (let i = 0; i < 8; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) throw new Error(`turn advance failed: ${outcome.error}`);
    session = outcome.session;
  }
  return session;
}

test("PC1-7: 同一seed・同一パラメータで2回実行しても、Portfolio集計に使う値（CAPEX支払・VAP Development支出・稼働率）が完全一致する", () => {
  const a = runShort("pc1-det-seed");
  const b = runShort("pc1-det-seed");

  const fingerprint = (session: ReturnType<typeof runShort>) =>
    session.state.history
      .flatMap((record) =>
        record.capexResults.flatMap((c) =>
          c.events.map((e) => `${record.turn}:${c.companyId}:${e.projectType}:${e.statusAfter}:${e.paymentSucceededUsd.toFixed(6)}`)
        )
      )
      .join("|") +
    "##" +
    session.packCompanyTurns
      .map(
        (t) =>
          `${t.turn}:${t.companyId}:${t.strategy.vapProductDevelopment?.proposedSpendUsd ?? "null"}:${(t.strategy.factoryActivation ?? [])
            .map((f) => `${f.factoryId}:${f.utilization}`)
            .join(",")}`
      )
      .join("|");

  assert.equal(fingerprint(a), fingerprint(b));
});
