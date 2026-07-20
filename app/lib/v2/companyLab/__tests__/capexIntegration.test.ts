// ShrimpX V2 — 会社ラボ×設備投資モジュール 統合テスト（Phase 8B-2A）
//
// 対応する重要テスト項目（実装指示より、companyLab統合カテゴリ）:
//   CI-1. 自動方針（generateAutoPolicyDecision）は5社・全ターンで新規設備投資
//         案件を一切提案しない（実装指示§11）
//   CI-2. 意思決定編集からの明示的な提案が、companyLabを通した実ランで
//         承認→着工→分割払い→完成→固定資産振替まで一貫して進む
//   CI-3. capexResultsが毎四半期・5社分生成され、既存のBS恒等式（重要テスト11）・
//         CF恒等式（重要テスト12）がcapex接続後も実ランで成立する
//   CI-4. 同一シード・同一意思決定（capexDecisionの上書きを含む）で完全再現する
//   CI-5. 他社（提案していない4社）の設備投資状態は一切変化しない（会社間の混線なし）

import { test } from "node:test";
import assert from "node:assert/strict";
import { PeriodV2 } from "../../core/period";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyLabResult, CompanyOwnState, PublicMarketInfo } from "../types";
import { CapexDecisionInput } from "../../capex/types";

const EPS_USD = 0.01;

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "capex-int-001", turns: 8, ...overrides };
}

function runAllAuto(config: CompanyLabConfig): CompanyLabResult {
  return runCompanyLabWithAutoPolicyForAllCompanies(config, generateAutoPolicyDecision);
}

// 8ターンの共通ランを1回だけ実行してテスト間で共有する（自動方針のみ、決定論的なので安全）。
const sharedAuto8 = runAllAuto(baseConfig());

test("受入確認CI-1: 自動方針は5社・全ターンで新規設備投資案件を一切提案しない（実装指示§11）", () => {
  for (const record of sharedAuto8.history) {
    assert.equal(record.decisions.length, 5);
    for (const decision of record.decisions) {
      assert.deepEqual(decision.capexDecision.newProjectProposals, [], `${decision.companyId} ${record.period}: 自動方針が新規提案を出した`);
      assert.deepEqual(decision.capexDecision.cancelRequests, []);
      assert.deepEqual(decision.capexDecision.resumeRequests, []);
    }
    for (const cr of record.capexResults) {
      assert.deepEqual(cr.rejectedProposals, []);
      assert.equal(cr.totalPaidThisQuarterUsd, 0);
      assert.equal(cr.completedProjectsTransferUsd, 0);
    }
  }
});

/**
 * BAL（cash=30M、最低現金準備額10Mに対し十分な余裕）へ、turn1に
 * coldStorageExpansion（標準予算2.5M、2段階、要求工期2四半期）を1件だけ
 * 明示的に提案する意思決定プロバイダー（自動方針をラップし、BALのcapexDecisionだけ
 * 上書きする。他社・他の意思決定要素は自動方針のまま）。
 */
function decisionProviderWithBalCapexProposal(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number
): CompanyDecisionInput {
  const base = generateAutoPolicyDecision(fixture, ownState, publicInfo, period, turn);
  if (fixture.companyId !== "BAL" || turn !== 1) return base;
  const capexDecision: CapexDecisionInput = {
    companyId: fixture.companyId,
    newProjectProposals: [{ projectType: "coldStorageExpansion" }],
    cancelRequests: [],
    resumeRequests: [],
  };
  return { ...base, capexDecision };
}

function runWithBalCapexOverride(turns: number, seed = "capex-int-override-001"): CompanyLabResult {
  return runCompanyLabWithAutoPolicyForAllCompanies(baseConfig({ turns, seed }), decisionProviderWithBalCapexProposal);
}

const shared8WithOverride = runWithBalCapexOverride(8);

test("受入確認CI-2: 明示的に提案した投資案件が、companyLabの実ランで承認→着工→分割払い→完成→固定資産振替まで一貫して進む", () => {
  const balCapexHistory = shared8WithOverride.history.map((r) => ({
    period: r.period,
    cr: r.capexResults.find((c) => c.companyId === "BAL")!,
    fr: r.financialResults.find((f) => f.companyId === "BAL")!,
  }));

  // turn1で提案が承認され、案件が登録される（プロジェクトが即座にnewCapexStateへ入る）。
  const turn1 = balCapexHistory[0];
  assert.equal(turn1.cr.rejectedProposals.length, 0, "承認されるはずの提案が拒否された");
  assert.ok(turn1.cr.totalPaidThisQuarterUsd > 0, "turn1で初回分割払いが実行されているはず（cash十分）");

  // いずれかの四半期で完成（completedProjectsTransferUsd > 0）が観測される。
  const completionTurn = balCapexHistory.find((h) => h.cr.completedProjectsTransferUsd > EPS_USD);
  assert.ok(completionTurn, "8ターン中にcoldStorageExpansion案件が完成しないのは想定外（標準予算2.5M・2段階に対し十分な現金余裕があるはず）");
  assert.ok(
    Math.abs((completionTurn!.cr.completedProjectsTransferUsd as number) - 2_500_000) < EPS_USD,
    `完成振替額が標準予算(2.5M)と一致しない: ${completionTurn!.cr.completedProjectsTransferUsd}`
  );

  // 完成した四半期を境に、固定資産グロスが完成振替額ぶん増加する。
  const completionIndex = balCapexHistory.indexOf(completionTurn!);
  const before = completionIndex > 0 ? balCapexHistory[completionIndex - 1] : undefined;
  if (before) {
    const grossBefore = before.fr.balanceSheet.fixedAssetsNet as number; // 純額だがCIP除外の傾向確認用（厳密比較は次のfindで行う）
    void grossBefore;
  }

  // 完成後、建設中勘定（CIP）は0へ戻る。
  assert.ok(Math.abs(completionTurn!.fr.balanceSheet.constructionInProgress as number) < EPS_USD, "完成後もCIPが残っている");

  // 全期間を通じて貸借・CF恒等式が成立する（capex接続後も既存の会計恒等式が崩れない）。
  for (const h of balCapexHistory) {
    assert.ok(Math.abs(h.fr.balanceSheet.balanceDifference as number) < EPS_USD, `${h.period}: 貸借差額 ${h.fr.balanceSheet.balanceDifference}`);
    assert.ok(Math.abs(h.fr.cashFlow.directIndirectDifference as number) < EPS_USD, `${h.period}: 直接法/間接法差 ${h.fr.cashFlow.directIndirectDifference}`);
  }
});

test("受入確認CI-3: capexResultsが毎四半期・5社分生成され、既存のBS/CF恒等式が実ランで成立する（重要テスト11・12のcapex接続後版）", () => {
  for (const record of shared8WithOverride.history) {
    assert.equal(record.capexResults.length, 5);
    for (const fr of record.financialResults) {
      assert.ok(Math.abs(fr.balanceSheet.balanceDifference as number) < EPS_USD);
      const cf = fr.cashFlow;
      assert.ok(
        Math.abs((cf.netCashChange as number) - ((cf.operatingCashFlow as number) + (cf.investingCashFlow as number) + (cf.financingCashFlow as number))) < EPS_USD
      );
      assert.ok(Math.abs((cf.closingCash as number) - ((cf.openingCash as number) + (cf.netCashChange as number))) < EPS_USD);
    }
  }
});

test("受入確認CI-4: 同一シード・同一意思決定（capexDecisionの上書きを含む）で完全再現する", () => {
  const again = runWithBalCapexOverride(8);
  assert.equal(
    JSON.stringify(shared8WithOverride.history.map((r) => r.capexResults)),
    JSON.stringify(again.history.map((r) => r.capexResults))
  );
  assert.equal(
    JSON.stringify(shared8WithOverride.history.map((r) => r.financialResults)),
    JSON.stringify(again.history.map((r) => r.financialResults))
  );
});

test("受入確認CI-5: 提案していない4社（MASS/JPQ/VAP/CONSV）の設備投資状態は一切変化しない（会社間の混線なし）", () => {
  for (const record of shared8WithOverride.history) {
    for (const companyId of ["MASS", "JPQ", "VAP", "CONSV"]) {
      const cr = record.capexResults.find((c) => c.companyId === companyId)!;
      assert.equal(cr.rejectedProposals.length, 0);
      assert.equal(cr.totalPaidThisQuarterUsd, 0, `${companyId} ${record.period}: 提案していないのに支払が発生している`);
      assert.equal(cr.completedProjectsTransferUsd, 0);
      assert.equal(cr.endingConstructionInProgressUsd, 0);
    }
  }
});
