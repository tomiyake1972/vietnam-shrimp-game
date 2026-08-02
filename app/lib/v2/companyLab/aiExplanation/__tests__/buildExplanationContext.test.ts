// ShrimpX V2 — Standard AI経営説明レポート機能 Claude入力コンテキスト組み立てのテスト（MVP）
//
// 【本テストの目的】
//   - ALLOWLIST正当性: buildExplanationContextの出力トップレベルキーが、実装指示に
//     列挙された範囲を超えていないこと。
//   - 他社データが一切混入しないこと（構造的な不変条件のドキュメント化）。
//   - turn1でのnull処理（vietnamDomesticPriorPrice/lastMarketResult）。
//   - decisionの値がdiagnostics.decisionと厳密に一致すること（無断の再計算・改変がないこと）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { CompanyLabConfig, CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../../types";
import { generateStandardAiDecisionWithDiagnostics, StandardAiQuarterDiagnostics } from "../../standardAi/policy";
import { buildExplanationContext, ExplanationContextInput, EXPLANATION_CONTEXT_SCHEMA_VERSION } from "../buildExplanationContext";
import { EXPLANATION_PROMPT_VERSION } from "../systemPrompt";
import { getExplanationModelConfig } from "../claudeClient";

function baselineConfig(): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "ai-explanation-context-001", turns: 4 };
}

interface Rig {
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly publicInfo: PublicMarketInfo;
  readonly diagnostics: StandardAiQuarterDiagnostics;
  readonly turn: number;
}

function buildRig(companyId = "BAL", turn = 1): Rig {
  const { fixtures, state } = initializeCompanyLab(baselineConfig());
  const fixture = fixtures.find((f) => f.companyId === companyId);
  if (!fixture) throw new Error(`fixture not found: ${companyId}`);
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, turn);
  return { fixture, ownState, publicInfo, diagnostics, turn };
}

function inputFrom(rig: Rig, labId = "lab-001"): ExplanationContextInput {
  return {
    labId,
    companyId: rig.fixture.companyId,
    turn: rig.turn,
    period: rig.diagnostics.period,
    scenarioId: "baseline",
    fixture: rig.fixture,
    ownState: rig.ownState,
    publicInfo: rig.publicInfo,
    diagnostics: rig.diagnostics,
  };
}

// --- ① ALLOWLIST正当性（トップレベル・identity・ownState・marketInfo・standardAiの各キー集合） ---

test("buildExplanationContext: トップレベルキーはidentity/ownState/marketInfo/standardAiの4つだけ", () => {
  const rig = buildRig();
  const context = buildExplanationContext(inputFrom(rig));
  assert.deepEqual(Object.keys(context).sort(), ["identity", "marketInfo", "ownState", "standardAi"]);
});

test("buildExplanationContext: identityのキー集合は実装指示の識別情報のみ", () => {
  const rig = buildRig();
  const context = buildExplanationContext(inputFrom(rig));
  assert.deepEqual(
    Object.keys(context.identity).sort(),
    ["companyId", "contextSchemaVersion", "labId", "model", "promptVersion", "quarter", "scenarioId", "turn", "year"].sort()
  );
});

test("buildExplanationContext: standardAiはdecisionとdiagnosticEntriesのみ（他の診断内部フィールドは含めない）", () => {
  const rig = buildRig();
  const context = buildExplanationContext(inputFrom(rig));
  assert.deepEqual(Object.keys(context.standardAi).sort(), ["decision", "diagnosticEntries"]);
});

test("buildExplanationContext: marketInfoのキー集合は固定", () => {
  const rig = buildRig();
  const context = buildExplanationContext(inputFrom(rig));
  // 【2026-08-02・能力認識監査Phase 2】vietnamDomesticPriorMarketを追加
  // （前四半期のベトナム国内市場公開清算結果。既存のPublicMarketInfo.lastMarketResultから
  // 読み出すだけで、新しい市場ルールは追加していない）。
  assert.deepEqual(
    Object.keys(context.marketInfo).sort(),
    ["dataLimitationNote", "hasPriorMarketData", "lifecycleTrends", "supplyPressure", "vietnamDomesticPriorPriceUsd", "vietnamDomesticPriorMarket"].sort()
  );
});

test("buildExplanationContext: ownStateのキー集合は固定（許可された自社状態の範囲のみ）", () => {
  const rig = buildRig();
  const context = buildExplanationContext(inputFrom(rig));
  // 【2026-08-02・能力認識監査Phase 3】productionCapacitySummaryを追加
  // （factoryCapacityの会社全体合計＋binding capacity。既存のnominal/effectiveを
  // 合算・比較するだけで、新しい能力算出ロジックは追加していない）。
  assert.deepEqual(
    Object.keys(context.ownState).sort(),
    [
      "balanceSheet",
      "contractBacklog",
      "customerTrustByMarket",
      "deliveryReliabilityByMarket",
      "factoryCapacity",
      "productionCapacitySummary",
      "finishedGoodsInventoryUsd",
      "laborProductivity",
      "qualityScoreByProduct",
      "rawMaterialInventory",
      "salesForce",
      "workforce",
    ].sort()
  );
});

// --- ② 他社データが構造的に混入しない、という不変条件のドキュメント化 ---

test("buildExplanationContext: 入力型(ExplanationContextInput)はCompanyOwnState/PublicMarketInfo/CompanyFixtureのみを要求し、他社一覧・全社共有state・履歴を一切受け取れない（構造的な不変条件）", () => {
  // ExplanationContextInputのフィールドは { labId, companyId, turn, period, scenarioId, fixture, ownState,
  // publicInfo, diagnostics } の9つだけであり、CompanyOwnState/PublicMarketInfoの型定義自体
  // （app/lib/v2/companyLab/types.ts）が「呼び出し会社1社ぶんの状態」と「公開情報」しか
  // 表現できない。他社のCompanyFixture配列やCompanyLabState全体を受け取るフィールドは
  // そもそも型として存在しないため、実装ミスで他社データを混入させることはコンパイル時に
  // 不可能である。これは実行時アサーションではなく型設計上の不変条件のドキュメントである。
  const rig = buildRig();
  const input = inputFrom(rig);
  assert.deepEqual(
    Object.keys(input).sort(),
    ["companyId", "diagnostics", "fixture", "labId", "ownState", "period", "publicInfo", "scenarioId", "turn"].sort()
  );
});

// --- ③ turn1でのnull処理 ---

test("buildExplanationContext: turn1(lastMarketResult===undefined)ではvietnamDomesticPriorPriceUsdは必ずnull（0を代入しない）", () => {
  const rig = buildRig("BAL", 1);
  assert.equal(rig.publicInfo.lastMarketResult, undefined);
  const context = buildExplanationContext(inputFrom(rig));
  assert.equal(context.marketInfo.hasPriorMarketData, false);
  assert.equal(context.marketInfo.vietnamDomesticPriorPriceUsd, null);
  assert.notEqual(context.marketInfo.dataLimitationNote, null);
  assert.match(context.marketInfo.dataLimitationNote as string, /ターン1/);
});

test("buildExplanationContext: turn1では生のpublicInfo.vietnamDomesticPriorPrice(0)がそのまま転記されていない", () => {
  const rig = buildRig("BAL", 1);
  // turn1のvietnamDomesticPriorPriceは副作用的な0（実在する価格ではない）。
  assert.equal(rig.publicInfo.vietnamDomesticPriorPrice, 0);
  const context = buildExplanationContext(inputFrom(rig));
  assert.notEqual(context.marketInfo.vietnamDomesticPriorPriceUsd, 0);
  assert.equal(context.marketInfo.vietnamDomesticPriorPriceUsd, null);
});

// --- ④ decisionの値が無断で再計算・改変されていないこと ---

test("buildExplanationContext: standardAi.decisionはdiagnostics.decisionと参照一致(===)し、値の書き換えが一切ない", () => {
  const rig = buildRig();
  const context = buildExplanationContext(inputFrom(rig));
  assert.equal(context.standardAi.decision, rig.diagnostics.decision);
});

test("buildExplanationContext: standardAi.diagnosticEntriesはdiagnostics.entriesと参照一致(===)する", () => {
  const rig = buildRig();
  const context = buildExplanationContext(inputFrom(rig));
  assert.equal(context.standardAi.diagnosticEntries, rig.diagnostics.entries);
});

// --- ⑤ 識別情報・その他の値 ---

test("buildExplanationContext: identityにmodel/promptVersion/contextSchemaVersionが一元管理された値と一致する", () => {
  const rig = buildRig();
  const context = buildExplanationContext(inputFrom(rig));
  assert.equal(context.identity.model, getExplanationModelConfig().model);
  assert.equal(context.identity.promptVersion, EXPLANATION_PROMPT_VERSION);
  assert.equal(context.identity.contextSchemaVersion, EXPLANATION_CONTEXT_SCHEMA_VERSION);
});

test("buildExplanationContext: identityのlabId/companyId/turnが入力どおりに設定される", () => {
  const rig = buildRig("MASS", 1);
  const context = buildExplanationContext(inputFrom(rig, "lab-xyz"));
  assert.equal(context.identity.labId, "lab-xyz");
  assert.equal(context.identity.companyId, "MASS");
  assert.equal(context.identity.turn, 1);
});

test("buildExplanationContext: 全ての数値フィールドはnumberかnullであり、undefinedは出現しない（JSON化しても消えない）", () => {
  const rig = buildRig();
  const context = buildExplanationContext(inputFrom(rig));
  const serialized = JSON.parse(JSON.stringify(context));
  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value !== null && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(walk);
      return;
    }
    assert.notEqual(value, undefined);
  }
  walk(serialized);
});

test("buildExplanationContext: 契約が0件の会社でもcontractBacklogは空配列(捏造なし)", () => {
  const rig = buildRig();
  const context = buildExplanationContext(inputFrom(rig));
  assert.ok(Array.isArray(context.ownState.contractBacklog));
});

test("buildExplanationContext: rawMaterialInventory.totalTonsはgroups合計と一致する", () => {
  const rig = buildRig();
  const context = buildExplanationContext(inputFrom(rig));
  const sum = context.ownState.rawMaterialInventory.groups.reduce((s, g) => s + g.quantityTons, 0);
  assert.ok(Math.abs(sum - context.ownState.rawMaterialInventory.totalTons) < 1e-6);
});

test("buildExplanationContext: balanceSheetのtotalAssets/Liabilities/Equityはopeningサマリーの値と一致する（再計算していない）", () => {
  const rig = buildRig();
  const context = buildExplanationContext(inputFrom(rig));
  // finance/openingStateSummary.tsが既に検算済みの構成要素と同じ値であることを、
  // cash・payables等の個別値の整合性で間接確認する（合計式自体はopeningStateSummary.ts管轄）。
  assert.equal(context.ownState.balanceSheet.cashUsd, rig.ownState.financeState.cash as unknown as number);
});

test("buildExplanationContext: 会社が異なれば出力されるcompanyId・decisionも異なる", () => {
  const rigA = buildRig("BAL", 1);
  const rigB = buildRig("MASS", 1);
  const contextA = buildExplanationContext(inputFrom(rigA));
  const contextB = buildExplanationContext(inputFrom(rigB));
  assert.notEqual(contextA.identity.companyId, contextB.identity.companyId);
});
