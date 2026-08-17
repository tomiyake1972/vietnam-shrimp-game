// ShrimpX V2 — AI Management Meeting M1.1: 実Claude API Smoke Test
//
// ChatGPT #05からの指示（AI Management Meeting M1.1 — Real API Smoke Test / Sales
// Schema Final Check）§1・§2・§5対応。ANTHROPIC_API_KEYが利用可能な開発環境でのみ、
// 開発者が手動でこのスクリプトを実行する（CIには一切組み込まない。npm test/tscから
// このスクリプト自体を呼ぶことはない）。
//
// 8つの最低ケース（CFO質問・COO質問・Commercial質問・CEO/strategy質問・
// CEO summary要求・primary+secondaryが必要な投資質問・structured proposalを返す質問・
// 比較的長いPlayer message）に加え、M2.1で追加したTest26 BAL Turn1の実再現ケース
// （「前回の営業結果を教えて」）を、claude-haiku-4-5-20251001へ実際に送信し、各callで
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

/**
 * 実際のExecutiveBriefingPacketに近い、代表的な内容のダミーbriefing（実APIの応答品質を
 * 見るための現実的な入力）。【M2.1訂正】backlogはhealthy forward/due this turn/overdueを
 * 分離した形（backlogSemantics.ts・briefing.ts参照）へ、supplyPressureは生countではなく
 * label+humanMeaningへ更新した。
 */
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
      backlog: { totalTons: 220, healthyForwardTons: 220, dueThisTurnTons: 0, overdueTons: 0 },
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
      receivablesScheduleByPeriod: [{ periodLabel: "2016年Q3", amountUsd: 550_000, turnsFromNow: 1 }],
      payablesScheduleByPeriod: [{ periodLabel: "2016年Q3", amountUsd: 300_000, turnsFromNow: 1 }],
      loanArrearsPrincipalUsd: 0,
      loanArrearsInterestUsd: 0,
      activeCapexRemainingCommitmentUsd: 0,
      borrowingHeadroom: { availableAdditionalCapacityUsd: 1_200_000, asOfLabel: "2016年Q1" },
      crisis: { state: "NORMAL", summary: "資金繰りは平常。" },
      previousQuarter: { cashUsd: 1_100_000, netRevenueUsd: 2_800_000, operatingProfitUsd: 210_000, periodLabel: "2016年Q1" },
    },
    coo: {
      factoryCapacityTopN: [{ factoryId: "F1", nominalTotalTons: 8000, effectiveTotalTons: 6700 }],
      nominalTotalTons: 8000,
      effectiveTotalTons: 6700,
      rawMaterialTotalTons: 950,
      totalRegularHeadcount: 240,
      qualityScoreByProduct: { hoso: 82, pd: 78, vap: 88 },
      backlogByProduct: [
        { product: "pd", totalTons: 180, overdueTons: 0 },
        { product: "hoso", totalTons: 40, overdueTons: 0 },
      ],
    },
    commercial: {
      backlog: { totalTons: 220, healthyForwardTons: 220, dueThisTurnTons: 0, overdueTons: 0 },
      backlogByMarket: [
        { market: "JP", totalTons: 180, overdueTons: 0 },
        { market: "US", totalTons: 40, overdueTons: 0 },
      ],
      backlogByProduct: [
        { product: "pd", totalTons: 180, overdueTons: 0 },
        { product: "hoso", totalTons: 40, overdueTons: 0 },
      ],
      backlogByMarketProduct: [
        { market: "JP", product: "pd", totalTons: 180, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 180, earliestDueLabel: "2016年Q3" },
        { market: "US", product: "hoso", totalTons: 40, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 40, earliestDueLabel: "2016年Q4" },
      ],
      customerTrustByMarket: { JP: 72, US: 65 },
      deliveryReliabilityByMarket: { JP: 90, US: 93 },
      salesForceHeadcountTotal: 22,
      salesForceCoverageScore: 0.68,
      lastQuarterNetRevenueUsd: 2_800_000,
      lastQuarterLabel: "2016年Q1",
      hasPriorMarketData: true,
      supplyPressureFacts: [
        { product: "pd", value: 0.02, label: "balanced", humanMeaning: "市場全体の需給はおおむね均衡" },
        { product: "vap", value: 0.15, label: "oversupply", humanMeaning: "市場全体で供給が需要を上回る方向（価格・受注獲得はしやすいが、過剰在庫リスクに注意）" },
      ],
      lifecycleTrendSummary: { growingCount: 2, shrinkingCount: 1, flatCount: 12, humanMeaning: "growing=構成比拡大傾向、shrinking=構成比縮小傾向、flat=ほぼ横ばい" },
    },
    ceo: {
      topSeverityReasonCodesTopN: [{ code: "CAPEX_DEFERRED", severity: "high" }],
      domainsInvolved: ["capex", "sales"],
    },
  };
}

/**
 * 【M2.1追加】Test26 BAL Turn1の実再現ケース用briefing。overdue=0の健全なforward
 * backlog（US/EU/JP/OTHER HOSO、合計3,063.42t、すべて未到来納期）を持つturn1状態。
 * 前四半期データが存在しない（turn1のため）ことも忠実に再現する。
 */
function test26Turn1Briefing() {
  return {
    common: {
      companyId: "BAL",
      turn: 1,
      year: 2015,
      quarter: 1,
      cashUsd: 38_200_000,
      bindingCapacityTons: 6000,
      bindingConstraintLabel: "商品別実効能力",
      backlog: { totalTons: 3063.42, healthyForwardTons: 3063.42, dueThisTurnTons: 0, overdueTons: 0 },
      playerDraft: null,
      standardAiReasonCodesTopN: [],
    },
    // 【M2.2追加・実装指示§17】Test26 BAL Turn1相当（Cash≈38.2M/Debt≈50.6M/AR≈66.4M）。
    cfo: {
      totalAssetsUsd: 120_000_000,
      totalLiabilitiesUsd: 50_600_000,
      totalEquityUsd: 69_400_000,
      shortTermLoansUsd: 10_600_000,
      longTermLoansUsd: 40_000_000,
      activeLoanCount: 2,
      payablesUsd: 0,
      receivablesUsd: 66_400_000,
      // AR残高は「即時使える現金」ではなく、実際の回収予定四半期（1四半期後）を明示する。
      receivablesScheduleByPeriod: [{ periodLabel: "2015年Q2", amountUsd: 66_400_000, turnsFromNow: 1 }],
      payablesScheduleByPeriod: [],
      loanArrearsPrincipalUsd: 0,
      loanArrearsInterestUsd: 0,
      activeCapexRemainingCommitmentUsd: 0,
      borrowingHeadroom: null,
      crisis: { state: "NORMAL", summary: "資金繰りは平常。" },
      previousQuarter: null,
    },
    coo: {
      factoryCapacityTopN: [{ factoryId: "F1", nominalTotalTons: 8000, effectiveTotalTons: 6700 }],
      nominalTotalTons: 8000,
      effectiveTotalTons: 6700,
      rawMaterialTotalTons: 500,
      totalRegularHeadcount: 200,
      qualityScoreByProduct: { hoso: 75, pd: 70, vap: 80 },
      backlogByProduct: [{ product: "hoso", totalTons: 3063.42, overdueTons: 0 }],
    },
    commercial: {
      backlog: { totalTons: 3063.42, healthyForwardTons: 3063.42, dueThisTurnTons: 0, overdueTons: 0 },
      backlogByMarket: [
        { market: "US", totalTons: 1367.43, overdueTons: 0 },
        { market: "EU", totalTons: 588.3, overdueTons: 0 },
        { market: "JP", totalTons: 336.51, overdueTons: 0 },
        { market: "OTHER", totalTons: 771.18, overdueTons: 0 },
      ],
      backlogByProduct: [{ product: "hoso", totalTons: 3063.42, overdueTons: 0 }],
      backlogByMarketProduct: [
        { market: "US", product: "hoso", totalTons: 1367.43, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 1367.43, earliestDueLabel: "2015年Q2" },
        { market: "EU", product: "hoso", totalTons: 588.3, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 588.3, earliestDueLabel: "2015年Q2" },
        { market: "JP", product: "hoso", totalTons: 336.51, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 336.51, earliestDueLabel: "2015年Q2" },
        { market: "OTHER", product: "hoso", totalTons: 771.18, overdueTons: 0, dueThisTurnTons: 0, healthyForwardTons: 771.18, earliestDueLabel: "2015年Q2" },
      ],
      customerTrustByMarket: { US: 50, EU: 50, JP: 50, OTHER: 50 },
      deliveryReliabilityByMarket: { US: 50, EU: 50, JP: 50, OTHER: 50 },
      salesForceHeadcountTotal: 15,
      salesForceCoverageScore: 0.5,
      lastQuarterNetRevenueUsd: null,
      lastQuarterLabel: null,
      hasPriorMarketData: false,
      supplyPressureFacts: [],
      lifecycleTrendSummary: null,
    },
    ceo: { topSeverityReasonCodesTopN: [], domainsInvolved: [] },
  };
}

interface SmokeCase {
  readonly label: string;
  readonly playerMessage: string;
  readonly historyCount: number;
  /** 【M2.1追加】trueの場合、通常のsampleBriefing()ではなくtest26Turn1Briefing()を使う。 */
  readonly useTest26Briefing?: boolean;
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
  {
    // 【M2.1追加・§9対応】Test26 BAL Turn1で実際に誤回答（healthy forward backlogを
    // 「納期遅延」「Trustを蝕んでいる」と誤説明、3,063tを「3,600t超」と誤って述べ、
    // supplyPressureCount=2から「市場は供給に余裕」と自由解釈）が発生した、実際の
    // プレイヤー発言そのものでの再現テスト。期待する回答の方向性は、売上実績・受注実績・
    // forward backlog・overdue=0・次期納期への準備を区別し、「納期遅延」「Trustを
    // 蝕んでいる」を根拠なしに言わないこと。
    label: "9A. Test26 BAL Turn1再現（backlog grounding）",
    playerMessage: "前回の営業結果を教えて",
    historyCount: 0,
    useTest26Briefing: true,
  },
  {
    // 【M2.2追加・実装指示§17・§22B対応】CFOのfinance grounding（false overdue・
    // unsupported Trust→AR delayを含まないこと）を確認する。
    label: "9B. Test26 BAL Turn1再現（investment affordability）",
    playerMessage: "財務的にはどうでしょう。各種投資をする余裕はあるでしょうか。",
    historyCount: 0,
    useTest26Briefing: true,
  },
  {
    // 【M2.2追加・実装指示§22C対応】AR残高($66.4M)を「2Qに入金される＝今すぐ使える」と
    // 誤認させようとするプレイヤー発言。CFOはreceivablesScheduleByPeriod（実際の回収予定）
    // に基づき、現金そのものではないことを区別できるかを確認する。
    label: "9C. Test26 BAL Turn1再現（AR = 使える現金か）",
    playerMessage: "CFOさん、売掛債権は2Qに入金されるから使えるお金ではないの？",
    historyCount: 0,
    useTest26Briefing: true,
  },
  {
    // 【M2.2追加・実装指示§22D対応】プレイヤーによる明示的な訂正。playerCorrectionStatus=
    // CONFIRMEDとなるべきケース（BriefingPacket上overdueTons=0で裏付けられる）。
    label: "9D. Test26 BAL Turn1再現（player correction）",
    playerMessage: "受注残は納期遅延ではないです。",
    historyCount: 0,
    useTest26Briefing: true,
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
  const briefing = scenario.useTest26Briefing ? test26Turn1Briefing() : sampleBriefing();
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
    confirmedCorrections: [],
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
      "  primary+secondaryが必要な投資質問・structured proposalを返す質問・比較的長いPlayer message）に加え、",
      "  Test26 BAL Turn1の実再現ケース（「前回の営業結果を教えて」、overdue=0のhealthy forward",
      "  backlogのみを持つturn1状態、M2.2でinvestment affordability/AR認識/player correctionの3ケースを追加）を",
      "  含む計12ケースを順に実行し、各callのmodel/inputTokens/outputTokens/latencyMs/stopReason/retryCount/",
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
