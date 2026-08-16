// ShrimpX V2 — AI Management Meeting M1.1: 実Claude API Smoke Test
//
// ChatGPT #05からの指示（AI Management Meeting M1.1 — Real API Smoke Test / Sales
// Schema Final Check）§1・§2・§5対応。ANTHROPIC_API_KEYが利用可能な開発環境でのみ、
// 開発者が手動でこのスクリプトを実行する（CIには一切組み込まない。npm test/tscから
// このスクリプト自体を呼ぶことはない）。
//
// 8つの最低ケース（CFO質問・COO質問・Commercial質問・CEO/strategy質問・
// CEO summary要求・primary+secondaryが必要な投資質問・structured proposalを返す質問・
// 比較的長いPlayer message）を、claude-haiku-4-5-20251001へ実際に送信し、各callで
// model/inputTokens/outputTokens/latencyMs/stopReason/retryCount/schema validation
// success-failure/primarySpeaker/secondary speaker/proposal countを記録する。
// 本文内容も開発用ログへ出す（API keyそのものは一切ログへ出さない）。
//
// ANTHROPIC_API_KEY未設定の場合は、実行せずREAL_API_SMOKE_NOT_RUNと明記した
// レポートのみを生成する（§5対応）。
//
// 使い方: ANTHROPIC_API_KEY=sk-... npx tsx scripts/aiMeetingRealApiSmokeTest.ts

import * as fs from "fs";
import * as path from "path";
import { generateMeetingResponse, getMeetingModelConfig } from "../app/lib/v2/companyLab/aiManagementMeeting/claudeClient";
import { buildMeetingUserMessage } from "../app/lib/v2/companyLab/aiManagementMeeting/prompt";
import { buildRecentHistoryForPrompt } from "../app/lib/v2/companyLab/aiManagementMeeting/conversation";
import { routePlayerMessage } from "../app/lib/v2/companyLab/aiManagementMeeting/router";
import { AiMeetingMessage } from "../app/lib/v2/companyLab/aiManagementMeeting/types";

/** 実際のExecutiveBriefingPacketに近い、代表的な内容のダミーbriefing（実APIの応答品質を見るための現実的な入力）。 */
function sampleBriefing() {
  return {
    common: {
      companyId: "BAL",
      turn: 6,
      year: 2016,
      quarter: 2,
      cashUsd: 1_250_000,
      bindingCapacityTons: 5200,
      bindingConstraintLabel: "共通前処理",
      overdueBacklogTopN: [
        { market: "JP", product: "pd", outstandingTons: 180, nearestDueDateLabel: "2016Q1（超過中）" },
        { market: "US", product: "hoso", outstandingTons: 40, nearestDueDateLabel: "2016Q3" },
      ],
      playerDraft: { hasDraft: true, totalDesiredSalesQuantityTons: 4200, capexProposalCount: 0, financingRequestedUsd: 0 },
      standardAiReasonCodesTopN: [
        { code: "CAPEX_DEFERRED", domain: "capex", severity: "high", targetFactoryId: "F1" },
        { code: "PD_MECH_LOW_UTILIZATION", domain: "capex", severity: "medium", targetFactoryId: "F1" },
      ],
    },
    cfo: {
      totalAssetsUsd: 6_000_000,
      totalLiabilitiesUsd: 2_500_000,
      totalEquityUsd: 3_500_000,
      shortTermLoansUsd: 400_000,
      longTermLoansUsd: 900_000,
      activeLoanCount: 3,
      payablesUsd: 300_000,
      receivablesUsd: 550_000,
      previousQuarter: { cashUsd: 1_100_000, netRevenueUsd: 2_800_000, operatingProfitUsd: 210_000 },
    },
    coo: {
      factoryCapacityTopN: [{ factoryId: "F1", nominalTotalTons: 8000, effectiveTotalTons: 6700 }],
      nominalTotalTons: 8000,
      effectiveTotalTons: 6700,
      rawMaterialTotalTons: 950,
      totalRegularHeadcount: 240,
      qualityScoreByProduct: { hoso: 82, pd: 78, vap: 88 },
    },
    commercial: {
      backlogByMarketProduct: [
        { market: "JP", product: "pd", outstandingTons: 180, contractCount: 5 },
        { market: "US", product: "hoso", outstandingTons: 40, contractCount: 1 },
      ],
      customerTrustByMarket: { JP: 72, US: 65 },
      deliveryReliabilityByMarket: { JP: 90, US: 93 },
      salesForceHeadcountTotal: 22,
      salesForceCoverageScore: 0.68,
      hasPriorMarketData: true,
      lifecycleTrendCount: 3,
      supplyPressureCount: 2,
    },
    ceo: {
      topSeverityReasonCodesTopN: [{ code: "CAPEX_DEFERRED", severity: "high" }],
      domainsInvolved: ["capex", "sales"],
    },
  };
}

interface SmokeCase {
  readonly label: string;
  readonly playerMessage: string;
  readonly historyCount: number;
}

const SMOKE_CASES: readonly SmokeCase[] = [
  { label: "1. CFO質問", playerMessage: "今期、この投資をして資金繰りは大丈夫？", historyCount: 0 },
  { label: "2. COO質問", playerMessage: "PDラインだけ増やせば足りる？", historyCount: 0 },
  { label: "3. Commercial質問", playerMessage: "日本向け販売をもっと増やしたい。どう思う？", historyCount: 0 },
  { label: "4. CEO/strategy質問", playerMessage: "もっと攻めたい。", historyCount: 0 },
  { label: "5. CEO summary要求", playerMessage: "CFOとCOOとCommercialそれぞれの意見を踏まえて、結論として何をやるべき？", historyCount: 3 },
  { label: "6. primary+secondaryが必要な投資質問", playerMessage: "PDラインの増設投資をしたいが、現金は足りているか、工場の稼働率的にも意味があるか教えて。", historyCount: 0 },
  {
    label: "7. structured proposalを返す質問",
    playerMessage: "具体的にどんな投資・販売の提案があるか、numberを含めて提案してほしい。",
    historyCount: 2,
  },
  {
    label: "8. 比較的長いPlayer message",
    playerMessage:
      "今期の状況を踏まえて、来期以降の方針について相談したい。日本向けのPD商品のbacklogが超過気味で気になっている一方、" +
      "現金残高は前四半期より改善している。工場の稼働率も高めだと思うが、追加投資をすべきか、それとも営業体制を強化して" +
      "既存の生産能力の中で売り方を変えるべきか、財務・生産・営業それぞれの立場から総合的に助言してほしい。",
    historyCount: 0,
  },
];

function dummyHistory(count: number): AiMeetingMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `hist-${i}`,
    speaker: i % 2 === 0 ? "PLAYER" : "CFO",
    text: i % 2 === 0 ? "以前の質問の一例です。" : "以前の回答の一例です。現金は問題ありません。",
    turn: 6,
    proposalIds: [],
    factsUsed: [],
  }));
}

interface CaseResult {
  readonly label: string;
  readonly playerMessagePreview: string;
  readonly ok: boolean;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
  readonly stopReason: string | null;
  readonly retryCount: number;
  readonly schemaValidationResult: string;
  readonly primarySpeaker: string | null;
  readonly secondarySpeaker: string | null;
  readonly responseCount: number;
  readonly proposalCount: number;
  readonly errorCategory?: string;
}

async function runCase(scenario: SmokeCase): Promise<CaseResult> {
  const briefing = sampleBriefing();
  const history = dummyHistory(scenario.historyCount);
  const { recent, compactSummary } = buildRecentHistoryForPrompt(history);
  const routing = routePlayerMessage(scenario.playerMessage);
  const userMessage = buildMeetingUserMessage({
    briefing,
    standardAiDecisionSummary: { topReasonCodes: briefing.common.standardAiReasonCodesTopN.map((r) => r.code) },
    recentHistory: recent.map((m) => ({ speaker: m.speaker, text: m.text })),
    compactSummary,
    playerMessage: scenario.playerMessage,
    routingHint: routing,
    meetingIntentHint: null,
  });

  const result = await generateMeetingResponse(userMessage, undefined, { labId: "smoke", companyId: "BAL", turn: 6 });

  if (!result.ok) {
    return {
      label: scenario.label,
      playerMessagePreview: scenario.playerMessage.slice(0, 40),
      ok: false,
      model: result.diagnostics.model,
      inputTokens: result.diagnostics.inputTokens,
      outputTokens: result.diagnostics.outputTokens,
      latencyMs: result.diagnostics.latencyMs,
      stopReason: result.diagnostics.stopReason,
      retryCount: result.diagnostics.retryCount,
      schemaValidationResult: result.diagnostics.schemaValidationResult,
      primarySpeaker: null,
      secondarySpeaker: null,
      responseCount: 0,
      proposalCount: 0,
      errorCategory: result.errorCategory,
    };
  }

  const response = result.response;
  console.log(`\n=== ${scenario.label} ===`);
  console.log(`player: ${scenario.playerMessage}`);
  for (const r of response.responses) {
    console.log(`  [${r.speaker}${r.stance ? `/${r.stance}` : ""}] ${r.text}`);
    if (r.factsUsed.length > 0) console.log(`    factsUsed: ${r.factsUsed.join(", ")}`);
  }
  if (response.proposals.length > 0) {
    console.log(`  proposals: ${response.proposals.map((p) => `${p.domain}(${p.id})`).join(", ")}`);
  }

  const secondary = response.responses.find((r) => r.speaker !== response.primarySpeaker && r.speaker !== "CEO") ?? null;

  return {
    label: scenario.label,
    playerMessagePreview: scenario.playerMessage.slice(0, 40),
    ok: true,
    model: result.diagnostics.model,
    inputTokens: result.diagnostics.inputTokens,
    outputTokens: result.diagnostics.outputTokens,
    latencyMs: result.diagnostics.latencyMs,
    stopReason: result.diagnostics.stopReason,
    retryCount: result.diagnostics.retryCount,
    schemaValidationResult: result.diagnostics.schemaValidationResult,
    primarySpeaker: response.primarySpeaker,
    secondarySpeaker: secondary?.speaker ?? null,
    responseCount: response.responses.length,
    proposalCount: response.proposals.length,
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function main() {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "ai_meeting_real_api_smoke_test.md");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    const lines = [
      "# AI Management Meeting — 実Claude API Smoke Test",
      "",
      "## REAL_API_SMOKE_NOT_RUN",
      "",
      "ANTHROPIC_API_KEYが本セッションの環境に設定されていないため、実APIでのsmoke testは実施していない。",
      "",
      "## 実施手順（開発者がAPI keyを利用できる環境で手動実行する場合）",
      "",
      "```",
      "ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/aiMeetingRealApiSmokeTest.ts",
      "```",
      "",
      "- CIには一切組み込まない（このスクリプトは`npm test`からは呼ばれない）。",
      "- 8つの最低ケース（CFO質問・COO質問・Commercial質問・CEO/strategy質問・CEO summary要求・",
      "  primary+secondaryが必要な投資質問・structured proposalを返す質問・比較的長いPlayer message）を",
      "  順に実行し、各callのmodel/inputTokens/outputTokens/latencyMs/stopReason/retryCount/",
      "  schemaValidationResult/primarySpeaker/secondarySpeaker/proposalCountを本ファイルへ出力する。",
      "- 実行後は、本文内容（開発用ログにのみ出力。API keyはログへ出さない）を人手で確認し、",
      "  役員らしさ・役割の混在有無・数値の捏造有無・Standard AIへの反論可否・回答の簡潔さ・",
      "  factsUsedの妥当性・日本語の自然さを評価する（本スクリプトは自動評価しない）。",
      "",
    ];
    fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
    console.log("REAL_API_SMOKE_NOT_RUN");
    console.log(`Wrote ${outPath}`);
    return;
  }

  const config = getMeetingModelConfig();
  const results: CaseResult[] = [];
  for (const scenario of SMOKE_CASES) {
    const result = await runCase(scenario);
    results.push(result);
  }

  const lines: string[] = [];
  lines.push("# AI Management Meeting — 実Claude API Smoke Test");
  lines.push("");
  lines.push(`実行日時: ${new Date().toISOString()} / モデル: ${config.model} / 実行件数: ${results.length}`);
  lines.push("");
  lines.push("## 各callの計測結果");
  lines.push("");
  lines.push("| ケース | ok | inputTokens | outputTokens | latencyMs | stopReason | retryCount | schemaResult | primary | secondary | responses | proposals |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      `| ${r.label} | ${r.ok} | ${r.inputTokens ?? "-"} | ${r.outputTokens ?? "-"} | ${r.latencyMs} | ${r.stopReason ?? "-"} | ${r.retryCount} | ${r.schemaValidationResult} | ${r.primarySpeaker ?? "-"} | ${r.secondarySpeaker ?? "-"} | ${r.responseCount} | ${r.proposalCount} |`
    );
  }
  lines.push("");

  const okResults = results.filter((r) => r.ok);
  const successRate = results.length > 0 ? (okResults.length / results.length) * 100 : 0;
  const inputTokenValues = okResults.map((r) => r.inputTokens ?? 0).filter((v) => v > 0);
  const outputTokenValues = okResults.map((r) => r.outputTokens ?? 0).filter((v) => v > 0);
  const latencyValues = results.map((r) => r.latencyMs);
  const truncated = results.some((r) => r.schemaValidationResult === "max_tokens_truncation");
  const totalRetries = results.reduce((sum, r) => sum + r.retryCount, 0);

  lines.push("## サマリ");
  lines.push("");
  lines.push(`- schema success rate: ${successRate.toFixed(1)}% (${okResults.length}/${results.length})`);
  lines.push(`- retry合計: ${totalRetries}`);
  lines.push(`- truncation observed: ${truncated ? "yes" : "no"}`);
  lines.push(`- inputTokens: avg=${Math.round(mean(inputTokenValues))} max=${inputTokenValues.length > 0 ? Math.max(...inputTokenValues) : "-"}`);
  lines.push(`- outputTokens: avg=${Math.round(mean(outputTokenValues))} max=${outputTokenValues.length > 0 ? Math.max(...outputTokenValues) : "-"}`);
  lines.push(`- latencyMs: avg=${Math.round(mean(latencyValues))} max=${latencyValues.length > 0 ? Math.max(...latencyValues) : "-"}`);
  lines.push("");
  lines.push("本文内容（役員らしさ・役割混在有無・数値捏造有無・反論可否・簡潔さ・factsUsed妥当性・日本語の自然さ）は、");
  lines.push("このMarkdownには含めない（開発用コンソールログにのみ出力。API keyや機微な経営数値の永続化を避けるため）。");
  lines.push("実行した開発者が、コンソール出力を目視で確認して評価すること。");
  lines.push("");

  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
