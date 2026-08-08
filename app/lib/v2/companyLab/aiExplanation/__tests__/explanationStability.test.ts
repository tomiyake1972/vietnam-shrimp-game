// ShrimpX V2 — Explanation層の安定性・診断可能性の回帰テスト
//
// 【背景】Test15/BAL/turn4 で経営説明の生成が失敗した。Vercelランタイムログで
// 確定した原因は次の3点で、いずれもExplanation層に閉じている。
//   A. max_tokens=2000 に張り付いて後方fieldが欠落（stopReason=max_tokens）
//   B. timeout=25,000ms に対し正常時latencyが約19秒で余裕が薄く、25,003msで失敗
//   C. Claudeが recommendations を array ではなく string で返した
//
// このテストは「一度成功した」ではなく、次を継続的に守るためのもの。
//   ・Turn1〜6相当の実contextで、出力量が上限に対して十分な余裕を持つこと
//   ・timeoutが正常時latencyに対して十分な余裕を持つこと
//   ・Explanation失敗がStandard AIの意思決定を一切変えないこと
//   ・失敗理由がUIとログの双方で判別できること

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../standardAi/policy";
import { buildExplanationContext } from "../buildExplanationContext";
import {
  AnthropicMessagesClient,
  EXPLANATION_CLAUDE_TIMEOUT_MS,
  estimateContextInputTokens,
  generateManagementReport,
  getExplanationModelConfig,
} from "../claudeClient";
import { CompanyDecisionInput, CompanyLabState } from "../../types";

/**
 * 実ログ（Test15/BAL/turn4）から見積もった「全6フィールドを書き切るのに必要な出力量」の
 * 上限側の値。attempt1が2,000で打ち切られ、attempt2が1,747で完走していたことから、
 * 必要量は概ね1,700〜2,300の範囲にある。監視はこの上限側で行う。
 */
const OBSERVED_MAX_NEEDED_OUTPUT_TOKENS = 2300;

/** 実ログで観測された正常時のlatency上限（attempt1=19,686ms）。 */
const OBSERVED_NORMAL_LATENCY_MS = 19_686;

/** Turn1〜6相当のExplanationContextを、実シミュレーションから組み立てる。 */
function buildContextsForTurns(turns: number, companyId = "BAL") {
  const { state: init, fixtures } = initializeCompanyLab({
    scenarioId: "baseline",
    mode: "canonical",
    seed: "explanation-stability-001",
    turns: turns + 2,
  });
  let state: CompanyLabState = init;
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const out: { readonly turn: number; readonly context: ReturnType<typeof buildExplanationContext>; readonly decision: CompanyDecisionInput }[] = [];

  for (let turn = 1; turn <= turns; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const own = buildCompanyOwnState(state, fixture);
    const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, own, publicInfo, state.currentPeriod, turn);
    out.push({
      turn,
      context: buildExplanationContext({
        labId: "stability-lab",
        companyId,
        turn,
        period: state.currentPeriod,
        scenarioId: "baseline",
        fixture,
        ownState: own,
        publicInfo,
        diagnostics: { decision, entries: diagnostics.entries },
      } as Parameters<typeof buildExplanationContext>[0]),
      decision,
    });

    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      decisions[f.companyId] = generateStandardAiDecisionWithDiagnostics(
        f,
        buildCompanyOwnState(state, f),
        publicInfo,
        state.currentPeriod,
        turn
      ).decision;
    }
    state = advanceCompanyLabQuarter(state, fixtures, decisions);
  }
  return out;
}

test("【回帰7】Turn1〜6相当のcontextで、必要出力量がmax_tokensに対して十分な余裕を持つ", () => {
  const config = getExplanationModelConfig();
  // 実測された必要量に対して、上限の70%以下に収まっていること
  // （旧設定2000では 2300/2000 = 115% で上限を超えており、実際に打ち切られていた）。
  const usageRatio = OBSERVED_MAX_NEEDED_OUTPUT_TOKENS / config.maxTokens;
  assert.ok(
    usageRatio <= 0.7,
    `必要出力量(${OBSERVED_MAX_NEEDED_OUTPUT_TOKENS}) が maxTokens(${config.maxTokens}) の70%以下であること（実際: ${(usageRatio * 100).toFixed(0)}%）`
  );

  // 入力側もモデルのcontext上限に対して余裕があること（Haiku 4.5は200k）。
  const contexts = buildContextsForTurns(6);
  assert.equal(contexts.length, 6);
  for (const { turn, context } of contexts) {
    const estimated = estimateContextInputTokens(context);
    assert.ok(estimated > 0, `turn${turn}: 推定input tokenが算出できること`);
    assert.ok(
      estimated < 50_000,
      `turn${turn}: 推定input token(${estimated}) がモデル上限に対して十分小さいこと（context length起因の失敗を早期検知する）`
    );
  }
});

test("【回帰8b】timeoutが正常時latencyに対して十分な余裕を持つ", () => {
  // 旧設定25,000msでは 19,686ms に対し余裕が5,314msしかなく、実際に25,003msで失敗した。
  // 正常時latencyの2倍以上を確保していることを条件にする。
  assert.ok(
    EXPLANATION_CLAUDE_TIMEOUT_MS >= OBSERVED_NORMAL_LATENCY_MS * 2,
    `timeout(${EXPLANATION_CLAUDE_TIMEOUT_MS}ms) が実測正常latency(${OBSERVED_NORMAL_LATENCY_MS}ms)の2倍以上であること`
  );
  // クライアント側のタイムアウト（PlayerScreenClient.tsx: 60秒）の内側に収まること。
  const clientSource = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "..", "v2", "company-lab", "play", "[labId]", "PlayerScreenClient.tsx"),
    "utf8"
  );
  const match = clientSource.match(/AI_EXPLANATION_CLIENT_TIMEOUT_MS\s*=\s*([\d_]+)/);
  assert.ok(match, "クライアント側タイムアウト定数が見つかること");
  const clientTimeoutMs = Number(match![1].replace(/_/g, ""));
  assert.ok(
    EXPLANATION_CLAUDE_TIMEOUT_MS < clientTimeoutMs,
    `サーバー側timeout(${EXPLANATION_CLAUDE_TIMEOUT_MS}ms)がクライアント側(${clientTimeoutMs}ms)より短いこと`
  );
});

test("【回帰6】Explanation生成が失敗しても、Standard AIの意思決定オブジェクトは一切変化しない", async () => {
  const [{ context, decision }] = buildContextsForTurns(1);
  const before = JSON.stringify(decision);
  const contextBefore = JSON.stringify(context);

  // 失敗する3経路（timeout相当・schema不一致・tool_use欠落）をすべて通す。
  const failingClients: readonly AnthropicMessagesClient[] = [
    { messages: { create: async () => { throw new Error("Request timed out."); } } },
    {
      messages: {
        create: async () => ({
          content: [{ type: "tool_use", input: { headline: "h" } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    },
    { messages: { create: async () => ({ content: [{ type: "text", text: "ただの文章" }], usage: {} }) } },
  ];

  for (const client of failingClients) {
    const result = await generateManagementReport(context, client, "hash-immutability");
    assert.equal(result.ok, false, "この経路は失敗すること（テストの前提）");
    assert.equal(JSON.stringify(decision), before, "Standard AIの意思決定が変化していないこと");
    assert.equal(JSON.stringify(context), contextBefore, "入力contextも変化していないこと（副作用が無いこと）");
  }
});

test("【回帰9】UIが失敗理由（errorCategory）を表示し、内部情報は表示しない", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "..", "v2", "company-lab", "play", "[labId]", "PlayerScreenClient.tsx"),
    "utf8"
  );
  // 失敗表示にerrorCategoryが出ること。
  assert.ok(source.includes("ai-explanation-error-category"), "失敗理由の表示要素があること");
  assert.ok(source.includes("aiExplanationErrorLabel"), "errorCategoryを日本語ラベルへ変換していること");
  // 失敗stateがerrorCategoryを保持していること（従来は捨てていた）。
  assert.ok(
    /kind:\s*"failure";\s*readonly errorCategory\?: string/.test(source),
    "failure stateがerrorCategoryを保持する型になっていること"
  );
  // timeout/network と schema を利用者が区別できること。
  assert.ok(source.includes("network_error:"), "network_errorのラベルがあること");
  assert.ok(source.includes("schema_mismatch:"), "schema_mismatchのラベルがあること");
  // 内部情報を表示しないこと。
  for (const f of ["ANTHROPIC_API_KEY", "stack", "detail"]) {
    assert.ok(!new RegExp(`aiExplanationState\\.${f}`).test(source), `UIが ${f} を表示しないこと`);
  }
});

test("Standard AIの数値提案はExplanationの成否と独立に生成される（別経路であることの確認）", () => {
  const contexts = buildContextsForTurns(2);
  for (const { turn, decision } of contexts) {
    assert.ok(decision.salesPlans.length > 0, `turn${turn}: Explanationを一切呼ばずとも販売計画が生成されていること`);
    assert.ok(decision.productionPlans.length >= 0);
    assert.ok(decision.workerAssignments.length > 0, `turn${turn}: ワーカー配置が生成されていること`);
  }
});
