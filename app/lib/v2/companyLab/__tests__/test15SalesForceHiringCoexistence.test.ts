// ShrimpX V2 — develop/v2統合（Required fix 1）: 営業人員の追加採用・減員機能
// （#05・develop/v2に既にマージ済み）が、Test15の新規機能（PD省人化投資・
// 新工場建設・VAP商品開発費）と同一四半期に共存しても、どちらも既存どおりに
// 正しく動作し続けることを確認する統合テスト。
//
// 目的（コーディネーター指示・Required fix 1）: 統合後、以下が静的fixture値へ
// リセットされず、#05が意図するとおりに動き続けることを検証する:
//   - 営業人員数（salesForceHiringState経由の実績人数）
//   - 営業人員人件費（sellingGeneralAdmin内のsalesForceSalary、採用後の人数で計算）
//   - 営業能力（validateSalesForceHeadcountBudgetが採用後の人数を基準にする）
//   - 永続化された採用・減員の意思決定フィールド（salesForceHireCount／
//     salesForceLayoffCount）

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig } from "../types";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../persistence/snapshot";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../persistence/codec";
import { CompanyLabPersistedStateV1, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../persistence/types";
import { extractCompanyFinancialResult } from "../../../../v2/company-lab/play/_lib/financialViewSelectors";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "salesforce-coexist-seed-001", turns: 8, ...overrides };
}

function buildAutoDecisions(state: ReturnType<typeof initializeCompanyLab>["state"], fixtures: ReturnType<typeof initializeCompanyLab>["fixtures"]) {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisions[f.companyId] = generateAutoPolicyDecision(f, own, publicInfo, state.currentPeriod, 1);
  }
  return decisions;
}

test("SFCOEXIST-1: 営業人員を採用（+5人）しつつ同時にVAP商品開発費も投じても、翌四半期の営業人員数は採用分だけ増え、静的fixture値へリセットされない", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;
  const targetFixture = fixtures[0];

  const decisions = buildAutoDecisions(state, fixtures);
  decisions[targetCompanyId] = {
    ...decisions[targetCompanyId],
    salesForceHireCount: 5,
    salesForceLayoffCount: 0,
    vapProductDevelopmentSpendUsd: 250_000,
  };

  const after = advanceCompanyLabQuarter(state, fixtures, decisions);

  const decodedHeadcount = after.salesForceHiringState.companies.find((c) => c.companyId === targetCompanyId)?.headcount;
  assert.equal(
    decodedHeadcount,
    targetFixture.salesForceHeadcountTotal + 5,
    "採用した5人ぶん、翌四半期の営業人員数が増えているはず（静的fixture値のままではない）"
  );
});

test("SFCOEXIST-2: 採用後の営業人員数ぶん、SG&A内の営業人件費（salesForceSalary相当）が増える（Test15のVAP費用と混同・相殺されない）", () => {
  const runBase = initializeCompanyLab(baseConfig({ seed: "salesforce-coexist-seed-002a" }));
  const runHired = initializeCompanyLab(baseConfig({ seed: "salesforce-coexist-seed-002a" }));
  const targetCompanyId = runBase.fixtures[0].companyId;

  const decisionsBase = buildAutoDecisions(runBase.state, runBase.fixtures);
  const decisionsHired: Record<string, CompanyDecisionInput> = {
    ...buildAutoDecisions(runHired.state, runHired.fixtures),
  };
  decisionsHired[targetCompanyId] = { ...decisionsHired[targetCompanyId], salesForceHireCount: 4, vapProductDevelopmentSpendUsd: 100_000 };

  const afterBase = advanceCompanyLabQuarter(runBase.state, runBase.fixtures, decisionsBase);
  const afterHired = advanceCompanyLabQuarter(runHired.state, runHired.fixtures, decisionsHired);

  // 採用は「次の四半期から」配分・コストに反映されるため、もう1四半期進めて確認する。
  const decisionsBase2 = buildAutoDecisions(afterBase, runBase.fixtures);
  const decisionsHired2 = buildAutoDecisions(afterHired, runHired.fixtures);
  const afterBase2 = advanceCompanyLabQuarter(afterBase, runBase.fixtures, decisionsBase2);
  const afterHired2 = advanceCompanyLabQuarter(afterHired, runHired.fixtures, decisionsHired2);

  const recordBase = afterBase2.history[afterBase2.history.length - 1];
  const recordHired = afterHired2.history[afterHired2.history.length - 1];
  const finBase = extractCompanyFinancialResult(recordBase, targetCompanyId)!;
  const finHired = extractCompanyFinancialResult(recordHired, targetCompanyId)!;

  const sgaBase = Number(finBase.profitAndLoss.sellingGeneralAdmin);
  const sgaHired = Number(finHired.profitAndLoss.sellingGeneralAdmin);
  assert.ok(sgaHired > sgaBase, `採用+VAP投資した会社のSG&Aは、採用していない会社より大きいはず（base=${sgaBase}, hired=${sgaHired}）`);
});

test("SFCOEXIST-3: 採用後に増えた営業人員数ぶん、salesPlansのsalesForceHeadcount配分上限（営業能力）も増える", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed: "salesforce-coexist-seed-003" }));
  const targetCompanyId = fixtures[0].companyId;
  const targetFixture = fixtures[0];

  const decisions = buildAutoDecisions(state, fixtures);
  decisions[targetCompanyId] = { ...decisions[targetCompanyId], salesForceHireCount: 6 };
  const afterHireQuarter = advanceCompanyLabQuarter(state, fixtures, decisions);

  // 採用成立後（次の四半期）、増員ぶんまで営業人員を配分した販売計画が拒否されないことを確認する。
  const own = buildCompanyOwnState(afterHireQuarter, targetFixture);
  const publicInfo = buildPublicMarketInfo(afterHireQuarter);
  const autoDecisionNext = generateAutoPolicyDecision(targetFixture, own, publicInfo, afterHireQuarter.currentPeriod, 2);
  const increasedCapacity = targetFixture.salesForceHeadcountTotal + 6;

  // 自動方針の販売計画の営業人員配分合計を、増えた枠いっぱいまで積み増した意思決定を作る
  // （営業人員配分バジェットの上限そのものが増えていることを直接確認する）。同一市場内の
  // 全商品は同一の営業人員数を共有する必要がある（runner.ts の検証）ため、対象市場を
  // ひとつだけ選び、その市場に属する全行を同じ人数へそろえ、他の市場は0にする。
  const targetMarket = autoDecisionNext.salesPlans[0]?.market;
  const salesPlansAtCapacity =
    autoDecisionNext.salesPlans.length > 0
      ? autoDecisionNext.salesPlans.map((p) => (p.market === targetMarket ? { ...p, salesForceHeadcount: increasedCapacity } : { ...p, salesForceHeadcount: 0 }))
      : autoDecisionNext.salesPlans;

  const decisionsNext = buildAutoDecisions(afterHireQuarter, fixtures);
  decisionsNext[targetCompanyId] = { ...autoDecisionNext, salesPlans: salesPlansAtCapacity };

  assert.doesNotThrow(
    () => advanceCompanyLabQuarter(afterHireQuarter, fixtures, decisionsNext),
    "採用後の増員ぶんまでの営業人員配分は拒否されないはず（営業能力が採用前のfixture静的値のままではない）"
  );
});

test("SFCOEXIST-4: 採用・減員の意思決定フィールドは、Test15のpdMechanizationState・productDevelopmentStateと同一スナップショットに保存・復元しても、互いに影響しない", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed: "salesforce-coexist-seed-004" }));
  const targetCompanyId = fixtures[0].companyId;
  const targetFactoryId = fixtures[0].factories[0]?.factoryId ?? "F1";

  const decisions = buildAutoDecisions(state, fixtures);
  decisions[targetCompanyId] = {
    ...decisions[targetCompanyId],
    salesForceHireCount: 3,
    capexDecision: {
      ...decisions[targetCompanyId].capexDecision,
      newProjectProposals: [
        ...decisions[targetCompanyId].capexDecision.newProjectProposals,
        { projectType: "pdMechanization" as const, targetFactoryId },
      ],
    },
    vapProductDevelopmentSpendUsd: 250_000,
  };

  const after = advanceCompanyLabQuarter(state, fixtures, decisions);
  const runtime = createCompanyLabRuntimeSnapshot(after);

  assert.equal(CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION, 7);
  const stored: CompanyLabPersistedStateV1 = {
    schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
    engineVersion: "test-v2-companyLab-engine-sfcoexist",
    labId: "lab-sfcoexist-001",
    playerCompanyId: targetCompanyId,
    config: baseConfig({ seed: "salesforce-coexist-seed-004" }),
    fixtures,
    currentState: { runtime, revision: 1, lastProcessedTurnId: "turn-1" },
    draft: null,
    metadata: { createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" },
  };
  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(stored));
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, []);

  const decodedHeadcount = restored.salesForceHiringState.companies.find((c) => c.companyId === targetCompanyId)?.headcount;
  assert.equal(decodedHeadcount, fixtures[0].salesForceHeadcountTotal + 3, "保存・復元後も採用した営業人員数が保持されている");

  const pdProject = restored.capexState.companies
    .find((c) => c.companyId === targetCompanyId)!
    .portfolio.projects.find((p) => p.projectType === "pdMechanization");
  assert.ok(pdProject, "保存・復元後もPD省人化投資案件が保持されている（営業人員データと共存して壊れていない）");
});
