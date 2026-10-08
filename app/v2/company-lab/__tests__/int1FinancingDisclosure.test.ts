// ShrimpX V2 — INT-1 §2B: 借入結果・緊急融資のPLAYER画面への接続
//
// 【修正前の事実】申請額と実行額の分離表示・緊急融資の表示は FinancingTab.tsx に
// 既に存在したが、それを含む FinancialResultsSection は company-lab/play/[labId]
// （GM/開発者用テストプレイ画面）だけが描画していた。
// Management Console内PLAYER と Independent Player のワークスペースへは
// lastQuarterFinancialResult（PL/BS/CF）しか渡しておらず、FinancingQuarterResult は未配線だった。
//
// 【このテストが固定する契約】
//   既存の確定済み FinancingQuarterResult を両PLAYER経路へ渡し、そのまま表示する。
//   申請額・実行額・減額/否認額・理由・緊急融資（有無/実行額/適用金利）が揃っている。
//   記録が無い場合は「未取得」と表示し、借入残高の差から推測しない。
//   金融ルール（審査・金利・上限）は変更しない。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab, advanceCompanyLabQuarter, generateAutoPolicyDecision } from "../../../lib/v2/companyLab";
import { extractCompanyFinancingResult } from "../play/_lib/financialViewSelectors";
import type { CompanyLabState } from "../../../lib/v2/companyLab/types";

const ROOT = path.resolve(__dirname, "../../../..");

function runTurns(turns: number) {
  const { state: initial, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "int1-financing", turns: turns + 2 });
  let state: CompanyLabState = initial;
  for (let i = 0; i < turns; i += 1) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions = Object.fromEntries(
      fixtures.map((f) => [f.companyId, generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)])
    );
    state = advanceCompanyLabQuarter(state, fixtures, decisions);
  }
  return { state, fixtures };
}

test("INT1-FIN-1: 確定記録に申請額・実行額・減額額・理由・金利がそろっている", () => {
  const { state } = runTurns(3);
  const lastRecord = state.history[state.history.length - 1];
  const result = extractCompanyFinancingResult(lastRecord, "BAL");
  assert.ok(result, "前四半期の資金繰り結果が取得できない");
  const uw = result.underwriting;
  for (const key of ["requestedAmountUsd", "approvedAmountUsd", "deniedAmountUsd", "appliedAnnualRate"] as const) {
    assert.equal(typeof uw[key], "number", `${key} が数値でない`);
    assert.ok(Number.isFinite(uw[key]), `${key} が有限数でない`);
  }
  assert.ok(Array.isArray(uw.reasons), "reasons が配列でない");
  // 申請額と実行額は別フィールドである（同一視していない）。
  assert.ok(
    Math.abs(uw.requestedAmountUsd - uw.approvedAmountUsd - uw.deniedAmountUsd) < 1,
    `申請 = 実行 + 減額 の関係が崩れている（${uw.requestedAmountUsd} / ${uw.approvedAmountUsd} / ${uw.deniedAmountUsd}）`
  );
  // 緊急融資は記録があるときだけ存在する optional（無い場合に捏造しない）。
  if (result.emergencyLoan !== undefined) {
    for (const key of ["requestedUsd", "approvedUsd", "annualRate", "capUsd"] as const) {
      assert.ok(Number.isFinite(result.emergencyLoan[key]), `emergencyLoan.${key} が有限数でない`);
    }
    assert.equal(typeof result.emergencyLoan.reason, "string");
  }
});

test("INT1-FIN-2: 両PLAYER経路へ配線されている（Console内PLAYER / Independent Player）", () => {
  const studio = fs.readFileSync(path.join(ROOT, "app/v2/company-lab/components/decisionStudio/DecisionStudio.tsx"), "utf8");
  const finance = fs.readFileSync(path.join(ROOT, "app/v2/company-lab/components/decisionStudio/FinancePlanningScreen.tsx"), "utf8");
  const consolePlayer = fs.readFileSync(path.join(ROOT, "app/v2/management/player/PlayerWorkspace.tsx"), "utf8");
  const independent = fs.readFileSync(path.join(ROOT, "app/v2/play/workspace/page.tsx"), "utf8");
  const context = fs.readFileSync(path.join(ROOT, "app/lib/v2/player/decisionContext.ts"), "utf8");

  assert.ok(consolePlayer.includes("extractCompanyFinancingResult"), "Console内PLAYERが資金繰り結果を抽出していない");
  assert.ok(consolePlayer.includes("lastQuarterFinancingResult={lastQuarterFinancingResult}"), "Console内PLAYERがDecisionStudioへ渡していない");
  assert.ok(context.includes("extractCompanyFinancingResult"), "Independent Player の context が抽出していない");
  assert.ok(independent.includes("context.lastQuarterFinancingResult"), "Independent Player が渡していない");
  assert.ok(studio.includes("lastQuarterFinancingResult={lastQuarterFinancingResult}"), "DecisionStudio が FinancePlanningScreen へ渡していない");
  assert.ok(finance.includes("LastQuarterFinancingResultPanel"), "FINANCE画面がパネルを描画していない");
});

test("INT1-FIN-3: 記録が無い場合は「未取得」と表示し、残高差から推測しない（実装の静的確認）", () => {
  const raw = fs.readFileSync(path.join(ROOT, "app/v2/company-lab/components/LastQuarterFinancingResultPanel.tsx"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(code.includes("未取得"), "未取得の表示が無い");
  // 借入残高・BSから逆算していないこと。
  for (const forbidden of ["balanceSheet", "shortTermLoans", "longTermLoans", "endingShortTermLoansUsd", "endingLongTermLoansUsd"]) {
    assert.ok(!code.includes(forbidden), `残高から推測している疑い: ${forbidden}`);
  }
  // 金融ルールを再実装していないこと。
  for (const forbidden of ["borrowingCapacity", "creditScore", "covenant"]) {
    assert.ok(!code.includes(forbidden), `審査ロジックに触れている疑い: ${forbidden}`);
  }
});
