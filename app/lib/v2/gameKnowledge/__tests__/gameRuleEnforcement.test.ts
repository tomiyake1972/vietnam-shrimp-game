// ShrimpX V2 — Deterministic Rule Resolution / Enforcement のテスト（Phase M2.8.1・実装指示§12）
//
// AMM-GKE-1〜14。実Anthropic APIは呼ばない。
// 実APIで観測された6つの誤答が、**server側で構造的に起きなくなっている**ことを固定する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRuleAnswerRepairNote,
  extractRecentProductQuantity,
  findKnowledgeUsageViolation,
  findRuleAnswerViolations,
  getGameKnowledgeForQuestion,
  resolveGameRuleAnswers,
  ResolvedGameRuleAnswer,
} from "../index";
import { buildMeetingKnowledgeInjection } from "../../companyLab/aiManagementMeeting/knowledgeInjection";
import { AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, buildMeetingUserMessage } from "../../companyLab/aiManagementMeeting/prompt";
import { SALES_PARAMETERS_V1 } from "../../sales/parameters";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../../rawMaterials/parameters";
import { companySalesOrganizationCapacity } from "../../sales/salesCapacityModel";

const ROLES = ["Commercial Director", "COO", "CFO", "CEO"];

function resolverOf(answers: readonly ResolvedGameRuleAnswer[], id: string): ResolvedGameRuleAnswer {
  const found = answers.find((a) => a.resolverId === id);
  assert.ok(found, `resolver ${id} が返っていない`);
  return found!;
}

// ---------------------------------------------------------------------
// RC-1: role filteringで知識が0件になる事故（実APIの誤答#1の直接原因）
// ---------------------------------------------------------------------

test("AMM-GKE-1: ゲームルール質問は、どのroleが受けても知識が0件にならない", () => {
  const questions = [
    "営業1人当たり何トン売れますか？",
    "営業60人ならどれくらい売れますか？",
    "PD 1,000tを作るのに何人のworkerが必要ですか？",
    "輸入原料はいつ使えるようになりますか？",
    "売掛金はいつ回収されますか？",
    "工場の生産能力の上限はどれくらいですか？",
  ];
  for (const question of questions) {
    for (const role of ROLES) {
      const injection = buildMeetingKnowledgeInjection({ playerMessage: question, primarySpeaker: role });
      assert.ok(injection.injectedIds.length > 0, `[${role}] "${question}" で知識が0件になった`);
    }
  }
});

test("AMM-GKE-2: 同じ質問なら、roleが違っても同じ知識集合が引ける（roleは順位付けのみ）", () => {
  const question = "営業1人当たり何トン売れますか？";
  const sets = ROLES.map((role) => [...buildMeetingKnowledgeInjection({ playerMessage: question, primarySpeaker: role }).injectedIds].sort().join(","));
  assert.equal(new Set(sets).size, 1, `roleによって知識集合が変わった: ${sets.join(" | ")}`);
});

test("AMM-GKE-3: キーワードが一致しないentryは、role加点だけで浮上しない", () => {
  const result = getGameKnowledgeForQuestion({ question: "売掛金はいつ回収されますか？", role: "CFO" });
  assert.ok(result.entries.length > 0);
  assert.ok(
    result.entries.some((e) => e.id === "FINANCE.AR_SETTLEMENT"),
    "AR質問でAR_SETTLEMENTが引けていない"
  );
  // CFOのdomain（FINANCE/CAPEX）に属するというだけの無関係entryが混ざっていないこと。
  for (const entry of result.entries) {
    const hit = entry.keywords.some((k) => "売掛金はいつ回収されますか？".toLowerCase().includes(k.toLowerCase()));
    assert.ok(hit, `キーワード一致の無いentryが混入した: ${entry.id}`);
  }
});

// ---------------------------------------------------------------------
// §4 営業能力のenforcement
// ---------------------------------------------------------------------

test("AMM-GKE-4: 営業60人の確定解答が、engineの曲線と一致する（h=60）", () => {
  const model = SALES_PARAMETERS_V1.salesCapacityModel;
  assert.ok(model, "salesCapacityModelが未設定");
  assert.equal(model!.kind, "companyWide", "この検証は Company Sales Organization Model v1（kind=companyWide）が有効であることを前提にしている");
  const expected = Math.round(companySalesOrganizationCapacity(60, model!));
  const answers = resolveGameRuleAnswers({ question: "営業60人ならどれくらい売れますか？" });
  const at60 = resolverOf(answers, "SALES_CAPACITY_AT_HEADCOUNT");
  assert.equal(Number(at60.canonicalFacts.salesEffortCapacityTonsPerQuarter), expected);
  assert.ok(at60.result.includes(String(expected)), `resultに確定値${expected}が含まれていない: ${at60.result}`);
});

test("AMM-GKE-5: 「営業1人当たり何トン」には、固定値が存在しないことを確定解答として返す", () => {
  const answers = resolveGameRuleAnswers({ question: "営業1人当たり何トン売れますか？" });
  const perPerson = resolverOf(answers, "SALES_CAPACITY_PER_PERSON");
  assert.equal(perPerson.canonicalFacts.fixedTonsPerSalespersonExists, "NO");
  assert.equal(perPerson.unit, "N/A");
  assert.ok(perPerson.caveats.some((c) => c.includes("実績")), "実績を能力として使わない旨のcaveatが無い");
  // 「1人当たり」の"1人"を人数指定と誤読して「営業1人の能力は◯トン」を併記しないこと
  // （併記すると、存在しないper-person固定能力を追認してしまう）。
  assert.equal(answers.filter((a) => a.resolverId === "SALES_CAPACITY_AT_HEADCOUNT").length, 0);
});

// ---------------------------------------------------------------------
// §5 Worker必要人数のenforcement
// ---------------------------------------------------------------------

test("AMM-GKE-6: HOSO/PD/VAP 1,000tの必要Worker数が、labor parameterと一致する", () => {
  const labor = PRODUCTION_PARAMETERS_V1.labor;
  for (const product of ["hoso", "pd", "vap"] as const) {
    const expected = Math.ceil(1000 / (labor.regularEfficiencyPerHeadTons / labor.laborIntensityCoefficient[product]));
    const answers = resolveGameRuleAnswers({ question: `${product.toUpperCase()} 1,000tの生産に何人のworkerが必要ですか？` });
    const worker = resolverOf(answers, "WORKER_REQUIREMENT");
    assert.equal(worker.canonicalFacts.product, product);
    assert.equal(Number(worker.canonicalFacts.baseRegularHeadcount), expected, `${product} の必要人数が一致しない`);
    assert.ok(worker.result.includes(String(expected)));
  }
});

test("AMM-GKE-7: 省略形の追問「VAP 1,000tなら？」も、直前の会話からWorker質問として解決される", () => {
  const recent = ["PD 1,000tの生産には何人のworkerが必要ですか？", "PDの場合は約200人です。"];
  const context = extractRecentProductQuantity(recent);
  assert.equal(context.previousTons, 1000);
  const answers = resolveGameRuleAnswers({
    question: "VAP 1,000tなら？",
    previousProduct: context.previousProduct,
    previousTons: context.previousTons,
    previousAsksWorker: context.previousAsksWorker,
  });
  const worker = resolverOf(answers, "WORKER_REQUIREMENT");
  assert.equal(worker.canonicalFacts.product, "vap");
  assert.equal(Number(worker.canonicalFacts.quantityTons), 1000);
});

// ---------------------------------------------------------------------
// §6 Timing resolver
// ---------------------------------------------------------------------

test("AMM-GKE-8: 輸入・国内・養殖・ARのタイミングが、engine parameterと一致する", () => {
  const importLead = RAW_MATERIALS_PARAMETERS_V1.imports.standardLeadTimeTurns;
  const wc = FINANCE_PARAMETERS_V1.workingCapital;

  const imp = resolverOf(resolveGameRuleAnswers({ question: "輸入原料はいつ使えるようになりますか？" }), "TIMING_IMPORT");
  assert.equal(Number(imp.canonicalFacts.standardLeadTimeTurns), importLead);
  assert.ok(imp.result.includes(`N+${importLead}`));
  assert.ok(imp.result.includes("発注した四半期には使えない"));

  const dom = resolverOf(resolveGameRuleAnswers({ question: "国内買付の原料はいつ使えますか？" }), "TIMING_DOMESTIC");
  assert.equal(Number(dom.canonicalFacts.apDomesticPaymentQuarters), wc.apDomesticPaymentQuarters);

  const aqua = resolverOf(resolveGameRuleAnswers({ question: "養殖の池入れはいつ収穫できますか？" }), "TIMING_AQUACULTURE");
  assert.ok(aqua.result.includes("N+1"));

  const ar = resolverOf(resolveGameRuleAnswers({ question: "売掛金はいつ回収されますか？" }), "TIMING_AR");
  assert.equal(Number(ar.canonicalFacts.arCollectionQuarters), wc.arCollectionQuarters);
  assert.ok(ar.result.includes(`N+${wc.arCollectionQuarters}`));
});

test("AMM-GKE-9: タイミングを問わない質問ではtiming resolverが発火しない（無関係な注入をしない）", () => {
  const answers = resolveGameRuleAnswers({ question: "当社の今期の売上はいくらですか？" });
  assert.equal(answers.filter((a) => a.resolverId.startsWith("TIMING_")).length, 0);
});

// ---------------------------------------------------------------------
// §7 意味整合validator
// ---------------------------------------------------------------------

test("AMM-GKE-10: 「52t/人」のような営業1人当たり固定能力の断定を違反として検出する", () => {
  const resolved = resolveGameRuleAnswers({ question: "営業1人当たり何トン売れますか？" });
  const violations = findRuleAnswerViolations(["前期実績3,100tを営業60人で割ると、営業1人当たり52トンが販売能力です。"], resolved);
  assert.ok(violations.some((v) => v.code === "SALES_PER_PERSON_FIXED_CAPACITY"), JSON.stringify(violations));
  // 正しい回答は違反にしない。
  const ok = findRuleAnswerViolations(
    ["ShrimpXには営業1人当たりの固定能力パラメータは存在しません。営業能力は会社全体の飽和曲線で決まります。"],
    resolved
  );
  assert.equal(ok.filter((v) => v.code === "SALES_PER_PERSON_FIXED_CAPACITY").length, 0);
});

test("AMM-GKE-11: AR・輸入タイミングの自己矛盾を違反として検出する", () => {
  const arResolved = resolveGameRuleAnswers({ question: "売掛金はいつ回収されますか？" });
  const arViolations = findRuleAnswerViolations(["売掛金は当四半期中に回収されます。"], arResolved);
  assert.ok(arViolations.some((v) => v.code === "AR_TIMING_CONTRADICTION"));
  const arOk = findRuleAnswerViolations(["売掛金の回収は翌四半期（Turn N+1）です。"], arResolved);
  assert.equal(arOk.filter((v) => v.code === "AR_TIMING_CONTRADICTION").length, 0);

  const impResolved = resolveGameRuleAnswers({ question: "輸入原料はいつ使えますか？" });
  const impViolations = findRuleAnswerViolations(["輸入原料は発注した同じ四半期に使えます。"], impResolved);
  assert.ok(impViolations.some((v) => v.code === "IMPORT_TIMING_CONTRADICTION"));
});

test("AMM-GKE-12: 確定したWorker人数・営業能力が回答に含まれない場合を違反として検出する", () => {
  const workerResolved = resolveGameRuleAnswers({ question: "PD 1,000tの生産に何人のworkerが必要ですか？" });
  const bad = findRuleAnswerViolations(["PD 1,000tには1,000人強のworkerが必要です。"], workerResolved);
  assert.ok(bad.some((v) => v.code === "WORKER_HEADCOUNT_CANONICAL_MISSING"), JSON.stringify(bad));

  const base = Number(resolverOf(workerResolved, "WORKER_REQUIREMENT").canonicalFacts.baseRegularHeadcount);
  const good = findRuleAnswerViolations([`PD 1,000tの生産に必要な常用Workerは約${base}人です。`], workerResolved);
  assert.equal(good.filter((v) => v.code === "WORKER_HEADCOUNT_CANONICAL_MISSING").length, 0);

  const salesResolved = resolveGameRuleAnswers({ question: "営業60人ならどれくらい売れますか？" });
  const salesBad = findRuleAnswerViolations(["営業60人ならおよそ3,100t程度でしょう。"], salesResolved);
  assert.ok(salesBad.some((v) => v.code === "SALES_CAPACITY_CANONICAL_MISSING"));
});

test("AMM-GKE-13: GAME_RULE質問で該当知識を注入したのにknowledgeUsedIdsが空なら違反にする（§10）", () => {
  const violation = findKnowledgeUsageViolation({
    questionIntent: "GAME_RULE",
    injectedIds: ["SALES.SALESPERSON_CAPACITY"],
    knowledgeUsedIds: [],
  });
  assert.ok(violation);
  assert.equal(violation!.code, "KNOWLEDGE_NOT_USED");
  assert.ok(buildRuleAnswerRepairNote([violation!]).includes("KNOWLEDGE_NOT_USED"));

  // 参照している場合・知識が無い場合・ルール質問でない場合は違反にしない。
  assert.equal(findKnowledgeUsageViolation({ questionIntent: "GAME_RULE", injectedIds: ["X"], knowledgeUsedIds: ["X"] }), null);
  assert.equal(findKnowledgeUsageViolation({ questionIntent: "GAME_RULE", injectedIds: [], knowledgeUsedIds: [] }), null);
  assert.equal(findKnowledgeUsageViolation({ questionIntent: "STRATEGY", injectedIds: ["X"], knowledgeUsedIds: [] }), null);
  // MIXEDはマーカーが無い質問の既定値でもあるため、対象外（通常の相談でrepairを誘発させない）。
  assert.equal(findKnowledgeUsageViolation({ questionIntent: "MIXED", injectedIds: ["X"], knowledgeUsedIds: [] }), null);
});

// ---------------------------------------------------------------------
// §3・§9 プロンプトへの配線
// ---------------------------------------------------------------------

test("AMM-GKE-14: 確定解答がuserメッセージに載り、systemプロンプトが改変を禁止している", () => {
  const injection = buildMeetingKnowledgeInjection({ playerMessage: "営業60人ならどれくらい売れますか？", primarySpeaker: "CFO" });
  assert.ok(injection.resolvedGameRules.length > 0, "resolvedGameRulesが空");
  // resolverの根拠idは必ず注入知識に含まれる（§10の検証を成立させるため）。
  for (const id of injection.resolvedGameRules.flatMap((r) => r.knowledgeIds)) {
    assert.ok(injection.injectedIds.includes(id), `${id} がgameKnowledgeへ載っていない`);
  }

  const payload = JSON.parse(
    buildMeetingUserMessage({
      briefing: {},
      standardAiDecisionSummary: null,
      recentHistory: [],
      compactSummary: null,
      playerMessage: "営業60人ならどれくらい売れますか？",
      routingHint: { primary: "CFO", secondary: null },
      meetingIntentHint: null,
      confirmedCorrections: [],
      repairNote: null,
      runAdvisoryMemory: { preferences: [], strategicIntents: [], constraints: [] },
      gameKnowledge: injection.gameKnowledge,
      gameKnowledgeEstimates: injection.gameKnowledgeEstimates,
      resolvedGameRules: injection.resolvedGameRules,
      questionIntent: injection.questionIntent,
    } as never)
  );
  assert.ok(Array.isArray(payload.resolvedGameRules) && payload.resolvedGameRules.length > 0);

  const prompt = AI_MANAGEMENT_MEETING_SYSTEM_PROMPT;
  assert.ok(prompt.includes("resolvedGameRules"), "systemプロンプトがresolvedGameRulesに言及していない");
  assert.ok(prompt.includes("変更・再計算"), "resultの改変禁止が明示されていない");
  assert.ok(prompt.includes("独自にルールを逆算"), "実績からのルール逆算禁止が明示されていない");
});
