// ShrimpX V2 — AI Management Meeting: Claude API Capacity / Schema Stability ベンチマーク
//
// 三宅さんの追加指示（Claude API Capacity / Schema Stability）§15対応。
// 過去のAI Explanation機能で実際に発生した「maxTokens不足 → stop_reason=max_tokens →
// schema_mismatch → retry」という既知の障害パターンが、AI Management Meetingの
// MVPスキーマ（responses<=3件・各短文、proposals<=3件、factsUsed<=6件等）でも
// 起こり得ないかを、以下2種類の方法で確認する。
//
//   A. worst-case近似（mock）: 実Anthropic APIは呼ばず、許容される最大サイズの
//      構造化応答（responses3件＋proposals3件＋factsUsed6件＋standardAiReferences3件、
//      各テキストを目安文字数の上限付近まで埋めたもの）を組み立て、
//        - JSON直列化した文字数から出力トークン数を概算し、AI_MEETING_MAX_OUTPUT_TOKENS
//          に対して十分な余裕があるかを確認する。
//        - generateMeetingResponse()へ、この巨大ペイロードをtool_use応答として返す
//          フェイククライアントを注入し、実際にZod検証を1回で通過する（リトライなしで
//          成功する）ことを確認する。
//      6パターン（short question / long player question / primary+secondary /
//      CEO summaryあり / proposal 3件 / 10 message history）それぞれを模した
//      入力サイズでuserMessage（入力側）のトークン概算も行う。
//   B. 実APIでの少数回smoke test（開発者が手動実行する場合のみ。CIでは呼ばない）:
//      ANTHROPIC_API_KEY環境変数が設定されている場合のみ、実際に2回だけ
//      generateMeetingResponseを呼び、model/inputTokens/outputTokens/stopReason/
//      latencyMs/retryCount/schemaValidationResultを実測してログへ出す。
//      未設定の場合はこのセクションをスキップする（CI・通常のnpm testからは
//      このスクリプト自体を呼ばないため、実APIを誤って叩くことはない）。
//
// 使い方: npx tsx scripts/aiMeetingCapacityBenchmark.ts
//   （ANTHROPIC_API_KEYを設定していれば、実APIでのsmoke testも追加実行される）

import * as fs from "fs";
import * as path from "path";
import { generateMeetingResponse, getMeetingModelConfig } from "../app/lib/v2/companyLab/aiManagementMeeting/claudeClient";
import { AnthropicMessageResponse, AnthropicMessagesClient } from "../app/lib/v2/companyLab/aiExplanation/claudeClient";
import { buildMeetingUserMessage } from "../app/lib/v2/companyLab/aiManagementMeeting/prompt";
import { buildRecentHistoryForPrompt } from "../app/lib/v2/companyLab/aiManagementMeeting/conversation";
import { routePlayerMessage } from "../app/lib/v2/companyLab/aiManagementMeeting/router";
import { AiMeetingMessage, AiMeetingStructuredResponse } from "../app/lib/v2/companyLab/aiManagementMeeting/types";

const CHARS_PER_TOKEN_ESTIMATE = 2.8; // aiExplanation/claudeClient.tsのestimateContextInputTokensと同じ経験則。

function estimateTokens(s: string): number {
  return Math.round(s.length / CHARS_PER_TOKEN_ESTIMATE);
}

function repeatToLength(base: string, targetChars: number): string {
  let out = "";
  while (out.length < targetChars) out += base;
  return out.slice(0, targetChars);
}

/** 許容最大サイズに近い構造化応答（primary+secondary+CEO summary、proposal3件）。 */
function worstCaseResponse(): AiMeetingStructuredResponse {
  const primaryText = repeatToLength("現在の現金残高と借入余力は十分にありますが、来期のCAPEX計画次第では圧迫される可能性があります。", 220);
  const secondaryText = repeatToLength("工場の稼働率は既に高水準で、追加投資の判断は慎重に行うべきです。", 160);
  const ceoText = repeatToLength("財務と生産、両部門の意見を踏まえると、優先順位を明確にした上で段階的に投資するのが良いでしょう。", 180);
  const rationale = repeatToLength("既存の稼働率・現金残高の実績値に基づく判断です。", 100);
  return {
    primarySpeaker: "CFO",
    responses: [
      {
        speaker: "CFO",
        text: primaryText,
        stance: "CAUTION",
        proposalIds: ["p1", "p2", "p3"],
        factsUsed: ["cash.current", "capacity.PD.utilization", "backlog.overdue.PD", "loans.active", "receivables.total", "payables.total"],
        standardAiReferences: [
          { reasonCode: "CAPEX_DEFERRED", targetFactoryId: "F1", targetProduct: "pd", stance: "SUPPORT", note: repeatToLength("既存提案を支持", 50) },
          { reasonCode: "PD_MECH_PROPOSED", targetFactoryId: "F1", targetProduct: "pd", stance: "MODIFY", note: repeatToLength("規模を縮小して支持", 50) },
          { reasonCode: "SALES_PLAN_SUBMITTED", stance: "SUPPORT", note: repeatToLength("問題なし", 50) },
        ],
      },
      {
        speaker: "COO",
        text: secondaryText,
        stance: "OPPOSE",
        proposalIds: ["p1"],
        factsUsed: ["capacity.PD.utilization", "labor.headcount"],
        standardAiReferences: [{ reasonCode: "CAPEX_DEFERRED", stance: "OPPOSE", note: repeatToLength("時期尚早", 50) }],
      },
      {
        speaker: "CEO",
        text: ceoText,
        stance: "ALTERNATIVE",
        proposalIds: [],
        factsUsed: ["cash.current"],
        standardAiReferences: [],
      },
    ],
    requiresCeoSummary: true,
    proposals: [
      { id: "p1", domain: "CAPEX", rationale, projectType: "pdMechanization", targetFactoryId: "F1", requestedBudgetUsd: 500_000 },
      { id: "p2", domain: "SALES", scope: "MARKET_PRODUCT", rationale, market: "JP", product: "pd", desiredQuantityTons: 100, priceAdjustmentUsdPerHosoEqKg: -0.05 },
      { id: "p3", domain: "FINANCE", rationale, desiredAmountUsd: 300_000, desiredTermQuarters: 8 },
    ],
    meetingIntent: "DEFER_CAPEX",
    potentialStrategicChange: true,
    potentialStrategicChangeNote: repeatToLength("積極拡大から慎重路線への転換を示唆", 80),
    playerCorrectionStatus: "CONFIRMED",
    playerCorrectionNote: repeatToLength("受注残はfuture dueでありoverdueではないという指摘を確認", 80),
  };
}

function toolUseResponse(input: unknown): AnthropicMessageResponse {
  return { content: [{ type: "tool_use", input }], usage: { input_tokens: 1200, output_tokens: 900 }, stop_reason: "tool_use" };
}

function worstCaseHistory(count: number): AiMeetingMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    speaker: i % 2 === 0 ? "PLAYER" : "CFO",
    text: repeatToLength(`会話履歴のメッセージ${i}。`, 120),
    turn: 3,
    proposalIds: [],
    factsUsed: [],
  }));
}

async function runMockWorstCase(lines: string[]): Promise<void> {
  const config = getMeetingModelConfig();
  lines.push(`## A. worst-case近似（mock、実APIは呼ばない）`);
  lines.push("");
  lines.push(`使用モデル: ${config.model} / maxTokens: ${config.maxTokens}`);
  lines.push("");

  const response = worstCaseResponse();
  const outputJson = JSON.stringify(response);
  const outputTokenEstimate = estimateTokens(outputJson);
  lines.push(`- worst-case構造化応答（responses3件＋proposals3件＋factsUsed6件＋standardAiReferences3件）のJSON長: ${outputJson.length}文字`);
  lines.push(`- 出力トークン概算（${CHARS_PER_TOKEN_ESTIMATE}文字/トークン経験則）: ${outputTokenEstimate}トークン`);
  lines.push(`- maxTokens(${config.maxTokens})に対する余裕: ${config.maxTokens - outputTokenEstimate}トークン（${(((config.maxTokens - outputTokenEstimate) / config.maxTokens) * 100).toFixed(0)}%）`);
  lines.push("");

  // 6パターンの入力側（userMessage）サイズも見積もる。
  const scenarios: { readonly label: string; readonly playerMessage: string; readonly historyCount: number }[] = [
    { label: "short question", playerMessage: "現金は足りてる？", historyCount: 0 },
    { label: "long player question", playerMessage: repeatToLength("今期の投資判断について、財務・生産・市場の観点から総合的に助言してほしい。", 600), historyCount: 0 },
    { label: "primary + secondary", playerMessage: "工場稼働率と現金の両方が気になる。", historyCount: 2 },
    { label: "CEO summaryあり（対立あり）", playerMessage: "CFOとCOOの意見が違うが、全体としてどうすべき？", historyCount: 4 },
    { label: "proposal 3件", playerMessage: "投資・販売・融資、それぞれ提案してほしい。", historyCount: 2 },
    { label: "10 message history", playerMessage: "続けて相談したい。", historyCount: 10 },
  ];

  lines.push("| シナリオ | 履歴件数(truncation後) | userMessage概算トークン |");
  lines.push("|---|---|---|");
  for (const scenario of scenarios) {
    const history = worstCaseHistory(scenario.historyCount);
    const { recent, compactSummary } = buildRecentHistoryForPrompt(history);
    const routing = routePlayerMessage(scenario.playerMessage);
    const userMessage = buildMeetingUserMessage({
      briefing: { note: "worst-case benchmark用のダミーbriefing（実際のPacketと同程度のサイズを想定）" },
      standardAiDecisionSummary: { topReasonCodes: ["CAPEX_DEFERRED", "PD_MECH_PROPOSED", "SALES_PLAN_SUBMITTED"] },
      recentHistory: recent.map((m) => ({ speaker: m.speaker, text: m.text })),
      compactSummary,
      playerMessage: scenario.playerMessage,
      routingHint: routing,
      meetingIntentHint: null,
      confirmedCorrections: [],
    repairNote: null,
    });
    lines.push(`| ${scenario.label} | ${recent.length} | ${estimateTokens(userMessage)} |`);

    // 実際にgenerateMeetingResponseへ通し、1回のattemptでschema_mismatch/truncationなく成功することを確認する。
    let calls = 0;
    const client: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          calls += 1;
          return toolUseResponse(response);
        },
      },
    };
    const result = await generateMeetingResponse(userMessage, client, { labId: "bench", companyId: "BENCH", turn: 3 });
    if (!result.ok || calls !== 1 || result.diagnostics.schemaValidationResult !== "ok") {
      throw new Error(`worst-case scenario "${scenario.label}" が1回のattemptで成功しませんでした（calls=${calls}, ok=${result.ok}）`);
    }
  }
  lines.push("");
  lines.push("全6シナリオとも、worst-case応答をmockから受け取った場合にattempt1回（リトライなし）でZod検証を通過することを確認した（truncation/schema mismatch observed: no）。");
  lines.push("");
}

async function runRealApiSmokeTestIfAvailable(lines: string[]): Promise<void> {
  lines.push(`## B. 実APIでのsmoke test（開発者が手動実行する場合のみ。CIでは呼ばない）`);
  lines.push("");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    lines.push("ANTHROPIC_API_KEY未設定のため、実APIでのsmoke testはスキップした。");
    lines.push("");
    return;
  }

  const config = getMeetingModelConfig();
  const userMessage = buildMeetingUserMessage({
    briefing: { common: { cashUsd: 500_000, bindingCapacityTons: 4000 } },
    standardAiDecisionSummary: { topReasonCodes: ["CAPEX_DEFERRED"] },
    recentHistory: [],
    compactSummary: null,
    playerMessage: "現金は足りてる？新工場を建てる余裕はある？",
    routingHint: { primary: "CFO", secondary: null },
    meetingIntentHint: null,
    confirmedCorrections: [],
    repairNote: null,
  });

  for (let i = 1; i <= 2; i++) {
    const result = await generateMeetingResponse(userMessage, undefined, { labId: "bench", companyId: "SMOKE", turn: 1 });
    lines.push(
      `- smoke test #${i}: ok=${result.ok} model=${config.model} inputTokens=${result.diagnostics.inputTokens ?? "(不明)"} ` +
        `outputTokens=${result.diagnostics.outputTokens ?? "(不明)"} stopReason=${result.diagnostics.stopReason ?? "(なし)"} ` +
        `latencyMs=${result.diagnostics.latencyMs} retryCount=${result.diagnostics.retryCount} schemaValidationResult=${result.diagnostics.schemaValidationResult}`
    );
  }
  lines.push("");
}

async function main() {
  const lines: string[] = [];
  lines.push("# AI Management Meeting — Claude API Capacity / Schema Stability ベンチマーク");
  lines.push("");
  lines.push("過去のAI Explanation機能での既知障害（maxTokens不足によるtruncation起因のschema_mismatch）");
  lines.push("が、AI Management MeetingのMVPスキーマで再発しないことを確認する。");
  lines.push("");

  await runMockWorstCase(lines);
  await runRealApiSmokeTestIfAvailable(lines);

  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "ai_meeting_capacity_benchmark.md");
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
