// ShrimpX V2 — Shared Game Knowledge Registry のテスト（Phase M2.8・実装指示§39）
//
// AMM-GK-1〜24。実Anthropic APIは呼ばない。Registryの内容が **実engineの
// parameter/関数と一致していること** を、engine側の値と突き合わせて固定する
// （Registryの中に別の値を書いてしまう事故を防ぐ）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GAME_KNOWLEDGE_ENTRIES,
  GAME_KNOWLEDGE_IDS,
  GAME_KNOWLEDGE_REGISTRY_VERSION,
  buildDynamicValueMap,
  classifyQuestionIntent,
  estimateSalesCapacity,
  estimateWorkerRequirement,
  getGameKnowledgeByDomain,
  getGameKnowledgeById,
  getGameKnowledgeForQuestion,
  UNRESOLVED_DYNAMIC_VALUE,
} from "../index";
import { SALES_PARAMETERS_V1 } from "../../sales/parameters";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../../rawMaterials/parameters";
import { STANDARD_AI_PARAMETERS_V1 } from "../../companyLab/standardAi/parameters";
import { companySalesOrganizationCapacity } from "../../sales/salesCapacityModel";
import { buildMeetingKnowledgeInjection, toKnowledgeRole } from "../../companyLab/aiManagementMeeting/knowledgeInjection";

function textOf(id: string): string {
  const entry = getGameKnowledgeById(id);
  assert.ok(entry, `${id} が Registry に無い`);
  return `${entry!.title}\n${entry!.summary}\n${entry!.explanation}\n${(entry!.semanticWarnings ?? []).join("\n")}`;
}

// ---------------------------------------------------------------------
// SALES（今回の最重要）
// ---------------------------------------------------------------------

test("AMM-GK-1: 実績÷人数を固定の営業生産性として扱わないことがRegistryで明示されている", () => {
  const entry = getGameKnowledgeById("SALES.SALESPERSON_CAPACITY");
  assert.ok(entry);
  const warnings = (entry!.semanticWarnings ?? []).join(" ");
  assert.match(warnings, /実績/, "実績値を能力として扱わない旨の警告が無い");
  assert.match(warnings, /固定の tons\/person パラメータは存在しない/);
  // 固定生産性パラメータがengine側にも存在しないことを構造的に確認する。
  assert.ok(
    !Object.keys(SALES_PARAMETERS_V1.salesForce).some((k) => /perPerson|perSalesperson|tonsPerHead/i.test(k)),
    "engine側に営業1人当たり固定能力のparameterが増えている（Registryの記述を見直すこと）"
  );
});

test("AMM-GK-2: 営業能力ルールが実engineの曲線・係数と一致している（Registryが独自の数値を持たない）", () => {
  const values = buildDynamicValueMap();
  const model = SALES_PARAMETERS_V1.salesCapacityModel;
  assert.ok(model, "production defaultの営業能力モデルが未設定");
  assert.equal(values.salesCompanyBaselineCapacityTons, String(model!.companyBaselineCapacityTons));
  assert.equal(values.salesCompanyCapacityMaxIncrementTons, String(model!.companyCapacityMaxIncrementTons));
  assert.equal(values.salesCompanyCapacitySaturationHeadcount, String(model!.companyCapacitySaturationHeadcount));
  assert.equal(values.salesCapacityAt60, String(Math.round(companySalesOrganizationCapacity(60, model!))));
  assert.equal(Number(values.salesEffortCoefficientVap), SALES_PARAMETERS_V1.salesEffortCoefficients.vap);
  // 説明文に固定数値がhardcodeされていない（実装指示§5）。
  const raw = GAME_KNOWLEDGE_ENTRIES.find((e) => e.id === "SALES.SALESPERSON_CAPACITY");
  assert.match(raw!.explanation, /\{\{salesCompanyCapacitySaturationHeadcount\}\}/);
  assert.ok(!raw!.explanation.includes("95,000"), "数値が説明文へhardcodeされている");
});

test("AMM-GK-3: 営業能力の質問でSALES知識が引ける", () => {
  const result = getGameKnowledgeForQuestion({ question: "営業一人当たりの販売能力は？" });
  assert.ok(result.entries.some((e) => e.id === "SALES.SALESPERSON_CAPACITY"), `引けていない: ${result.entries.map((e) => e.id).join(",")}`);
  const en = getGameKnowledgeForQuestion({ question: "What is the sales capacity per salesperson?" });
  assert.ok(en.entries.some((e) => e.id === "SALES.SALESPERSON_CAPACITY"), "英語の質問で引けていない");
  // 60人の目安はdeterministic helperで計算でき、商品構成で幅が出ることを示す。
  const estimate = estimateSalesCapacity(60);
  assert.equal(estimate.effortCapacityTons, companySalesOrganizationCapacity(60, SALES_PARAMETERS_V1.salesCapacityModel!));
  assert.ok((estimate.sellableTonsByProduct.hoso ?? 0) > (estimate.sellableTonsByProduct.vap ?? 0), "商品別の差が出ていない");
  assert.ok(estimate.caveats.length >= 3, "caveatが足りない");
});

// ---------------------------------------------------------------------
// LABOR
// ---------------------------------------------------------------------

test("AMM-GK-4: Worker必要量が実engineのlabor formulaと一致する", () => {
  const values = buildDynamicValueMap();
  assert.equal(values.regularEfficiencyPerHeadTons, String(PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons));
  assert.equal(Number(values.overtimeRateCap), PRODUCTION_PARAMETERS_V1.labor.overtimeRateCap);
  const estimate = estimateWorkerRequirement(1000, "pd");
  const expectedEfficiency = PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons / PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient.pd;
  assert.equal(estimate.effectiveTonsPerHead, expectedEfficiency);
  assert.equal(estimate.baseRegularHeadcount, Math.ceil(1000 / expectedEfficiency));
  assert.ok(estimate.withMaxOvertimeHeadcount < estimate.baseRegularHeadcount, "残業を使っても必要人数が減っていない");
  assert.ok(estimate.caveats.some((c) => c.includes("設備能力")), "設備能力の但し書きが無い");
});

test("AMM-GK-5: HOSO/PD/VAPの労務負荷差がRegistryとengineで一致する", () => {
  const values = buildDynamicValueMap();
  const coefficients = PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient;
  assert.equal(Number(values.hosoLaborCoefficient), coefficients.hoso);
  assert.equal(Number(values.pdLaborCoefficient), coefficients.pd);
  assert.equal(Number(values.vapLaborCoefficient), coefficients.vap);
  // 同じ数量ならVAPが最も人手を要する。
  const hoso = estimateWorkerRequirement(1000, "hoso").baseRegularHeadcount;
  const pd = estimateWorkerRequirement(1000, "pd").baseRegularHeadcount;
  const vap = estimateWorkerRequirement(1000, "vap").baseRegularHeadcount;
  assert.ok(hoso < pd && pd < vap, `労務負荷の順序が違う: hoso=${hoso} pd=${pd} vap=${vap}`);
});

// ---------------------------------------------------------------------
// FINANCE: AR / AP
// ---------------------------------------------------------------------

test("AMM-GK-6: ARの回収サイトが正式ルール（finance parameters）どおり", () => {
  const entry = getGameKnowledgeById("FINANCE.AR_SETTLEMENT");
  assert.ok(entry);
  assert.equal(entry!.ruleType, "TIMING");
  const expected = FINANCE_PARAMETERS_V1.workingCapital.arCollectionQuarters;
  assert.equal(expected, 1, "AR回収サイトが1四半期から変わっている（Registryの記述を見直すこと）");
  assert.match(entry!.explanation, /1四半期/);
  assert.ok(!entry!.explanation.includes(UNRESOLVED_DYNAMIC_VALUE), "動的値が解決できていない");
});

test("AMM-GK-7: TrustがARの回収時期を変えないことが明示されている", () => {
  const text = textOf("FINANCE.AR_SETTLEMENT");
  assert.match(text, /Trust/);
  assert.match(text, /存在しない/);
  // Quality/Trust側からも同じ否定が読める。
  assert.match(textOf("QUALITY_TRUST.SEMANTICS"), /売掛金の回収時期|回収時期・支払条件を変える仕組みはShrimpXに存在しない/);
});

test("AMM-GK-8: APルールがengineどおりで、ARと対称でないことが明示されている", () => {
  const wc = FINANCE_PARAMETERS_V1.workingCapital;
  assert.equal(wc.apDomesticPaymentQuarters, 0, "国内APサイトが変わっている");
  assert.equal(wc.apImportPaymentQuarters, 1, "輸入APサイトが変わっている");
  const text = textOf("FINANCE.AP_SETTLEMENT");
  assert.match(text, /0四半期（当四半期中）/);
  assert.match(text, /非対称|対称ではない/);
});

// ---------------------------------------------------------------------
// PROCUREMENT timing
// ---------------------------------------------------------------------

test("AMM-GK-9: 国内買付は当四半期の生産に使えることがengineどおり記述されている", () => {
  const text = textOf("PROCUREMENT.DOMESTIC_TIMING");
  assert.match(text, /そのまま使える/);
  assert.match(text, /リードタイムなし/);
});

test("AMM-GK-10: 輸入のリードタイムがengine parameterどおり", () => {
  const expected = RAW_MATERIALS_PARAMETERS_V1.imports.standardLeadTimeTurns;
  assert.equal(expected, 2, "輸入標準リードタイムが変わっている（Registryの記述を見直すこと）");
  const entry = getGameKnowledgeById("PROCUREMENT.IMPORT_TIMING");
  assert.ok(entry);
  assert.match(entry!.explanation, new RegExp(`${expected}\\s*ターン後`));
  assert.match(entry!.explanation, /到着前の輸送中在庫は生産に使えない/);
});

test("AMM-GK-11: 養殖は池入れの翌四半期に収穫され、収穫量が不確実であることが記述されている", () => {
  const text = textOf("PROCUREMENT.AQUACULTURE_TIMING");
  assert.match(text, /翌四半期|N\+1/);
  assert.match(text, /不確実|変動/);
});

test("AMM-GK-11b: 調達用語（予定・輸送中・使用可能）が分離されている", () => {
  const text = textOf("PROCUREMENT.TERMINOLOGY");
  for (const term of ["planned procurement", "in transit", "available", "ending inventory"]) {
    assert.ok(text.includes(term), `${term} が定義されていない`);
  }
  assert.match(text, /生産に使えない/);
});

// ---------------------------------------------------------------------
// CONTRACT / CAPACITY
// ---------------------------------------------------------------------

test("AMM-GK-12: backlogの意味論（backlog != overdue）が保持されている", () => {
  const text = textOf("CONTRACT.BACKLOG_SEMANTICS");
  for (const term of ["BACKLOG", "DUE_THIS_TURN", "FUTURE_DUE", "OVERDUE"]) assert.ok(text.includes(term), `${term} が無い`);
  assert.match(text, /必ずしも悪ではない/);
  const warnings = (getGameKnowledgeById("CONTRACT.BACKLOG_SEMANTICS")!.semanticWarnings ?? []).join(" ");
  assert.match(warnings, /納期遅延/);
});

test("AMM-GK-13: capacity poolの意味論（ライン合計 != 共通能力）が保持されている", () => {
  const entry = getGameKnowledgeById("CAPACITY.POOL_SEMANTICS");
  assert.ok(entry);
  const warnings = (entry!.semanticWarnings ?? []).join(" ");
  assert.match(warnings, /product-line capacity/);
  assert.match(warnings, /common capacity/);
  assert.match(entry!.explanation, /凍結・包装/);
  assert.match(entry!.explanation, /保管能力/);
});

test("AMM-GK-14: 設備稼働率と労働稼働率が別指標として定義されている", () => {
  const entry = getGameKnowledgeById("LABOR.UTILIZATION_SEMANTICS");
  assert.ok(entry);
  assert.match(entry!.explanation, /設備稼働率/);
  assert.match(entry!.explanation, /労働稼働率/);
  assert.match((entry!.semanticWarnings ?? []).join(" "), /1つの「稼働率」へまとめて語らない/);
});

// ---------------------------------------------------------------------
// CAPEX / DIVIDEND
// ---------------------------------------------------------------------

test("AMM-GK-15: CAPEXに建設リードタイムがあり、決定した四半期に能力が増えないことが明示されている", () => {
  const entry = getGameKnowledgeById("CAPEX.PROJECT_SEMANTICS");
  assert.ok(entry);
  assert.equal(entry!.ruleType, "TIMING");
  assert.match((entry!.semanticWarnings ?? []).join(" "), /投資を決定した四半期に能力が増えると説明してはいけない/);
  assert.match(entry!.explanation, /完成/);
});

test("AMM-GK-16: DIV-4の配当ルールが現行実装と一致する", () => {
  const entry = getGameKnowledgeById("FINANCE.DIVIDEND_POLICY");
  assert.ok(entry);
  const text = entry!.explanation;
  assert.match(text, /Q4/);
  assert.match(text, /healthy/);
  assert.match(text, /Crisis State が NORMAL/);
  assert.match(text, /新規CAPEX提案が0件/);
  assert.match(text, /当期純利益 > 0/);
  assert.match(text, /分配可能利益 > 0/);
  // 配当性向は現在のStandard AI parameterと一致する（Registryが別の値を持たない）。
  assert.ok(text.includes(String(STANDARD_AI_PARAMETERS_V1.dividendBasePayoutRatio)), "配当性向がparameterと一致しない");
  assert.match(text, /フロー/);
  assert.match(text, /ストックは上限としてのみ働く/);
});

test("AMM-GK-17: Playerの配当自由とStandard AIの年1回ポリシーが分離されている", () => {
  const entry = getGameKnowledgeById("FINANCE.DIVIDEND_POLICY");
  assert.match(entry!.explanation, /Playerは毎Turn自由に配当額を入力できる/);
  assert.match((entry!.semanticWarnings ?? []).join(" "), /Playerも年1回しか配当できない/);
});

// ---------------------------------------------------------------------
// Retrieval / role / limits / provenance
// ---------------------------------------------------------------------

test("AMM-GK-18: Registryに無いルールは何も返さない（一般常識で埋めない）", () => {
  const result = getGameKnowledgeForQuestion({ question: "従業員の有給休暇の付与日数は何日ですか？" });
  assert.equal(result.entries.length, 0, `無関係な知識が返っている: ${result.entries.map((e) => e.id).join(",")}`);
  assert.equal(getGameKnowledgeById("NOT_A_REAL_ID"), null);
});

test("AMM-GK-19: 注入した知識のidが返り、注入していないidは記録されない", () => {
  const injection = buildMeetingKnowledgeInjection({ playerMessage: "売掛金はいつ入りますか？", primarySpeaker: "CFO" });
  assert.ok(injection.injectedIds.includes("FINANCE.AR_SETTLEMENT"), `AR知識が注入されていない: ${injection.injectedIds.join(",")}`);
  // knowledgeUsedIds は injectedIds でフィルタされる方針であることを、そのフィルタ式で確認する。
  const claudeClaimed = ["FINANCE.AR_SETTLEMENT", "MADE.UP.RULE"];
  const recorded = claudeClaimed.filter((id) => injection.injectedIds.includes(id));
  assert.deepEqual(recorded, ["FINANCE.AR_SETTLEMENT"]);
});

test("AMM-GK-20: role relevance filtering が効く", () => {
  // CFOへは営業能力の詳細を渡さない（SALESはCFOのappliesToRolesに無い）。
  const cfo = getGameKnowledgeForQuestion({ question: "営業一人当たりの販売能力は？", role: "CFO" });
  assert.ok(!cfo.entries.some((e) => e.domain === "SALES"), "CFOへSALES知識が漏れている");
  const commercial = getGameKnowledgeForQuestion({ question: "営業一人当たりの販売能力は？", role: "COMMERCIAL" });
  assert.ok(commercial.entries.some((e) => e.id === "SALES.SALESPERSON_CAPACITY"), "Commercialへ営業知識が届いていない");
  // CFOには財務知識が届く。
  const arForCfo = getGameKnowledgeForQuestion({ question: "売掛金はいつ入る？", role: "CFO" });
  assert.ok(arForCfo.entries.some((e) => e.id === "FINANCE.AR_SETTLEMENT"));
  assert.equal(toKnowledgeRole("Commercial Director"), "COMMERCIAL");
  assert.equal(toKnowledgeRole(null), "CEO");
});

test("AMM-GK-21: Top N の上限が効き、超過分がtruncatedCountとして分かる", () => {
  const broad = getGameKnowledgeForQuestion({ question: "営業 生産 原料 売掛金 買掛金 配当 受注残 能力 投資 品質 Standard AI のルールを教えて", topN: 3 });
  assert.equal(broad.entries.length, 3);
  assert.ok(broad.truncatedCount > 0, "truncatedCountが立っていない");
  const defaultTopN = getGameKnowledgeForQuestion({ question: "営業 生産 原料 売掛金 買掛金 配当 受注残 能力 投資 品質 Standard AI のルールを教えて" });
  assert.ok(defaultTopN.entries.length <= 6, "既定のTop Nを超えて注入されている");
});

test("AMM-GK-22: 数値はparameterから解決され、説明文へhardcodeされていない", () => {
  // すべてのentryについて、宣言していないプレースホルダが残っていないこと。
  for (const entry of GAME_KNOWLEDGE_ENTRIES) {
    const resolved = getGameKnowledgeById(entry.id);
    assert.ok(resolved);
    assert.ok(!resolved!.explanation.includes("{{"), `${entry.id} に未解決のプレースホルダが残っている`);
    assert.ok(!resolved!.explanation.includes(UNRESOLVED_DYNAMIC_VALUE), `${entry.id} に解決できない動的値がある`);
  }
  // parameterを変えれば説明文も追随する（stale manual valueを持たない）。
  const modified = getGameKnowledgeForQuestion({
    question: "VAPの労務負荷は？",
    parameters: {
      sales: SALES_PARAMETERS_V1,
      production: { ...PRODUCTION_PARAMETERS_V1, labor: { ...PRODUCTION_PARAMETERS_V1.labor, laborIntensityCoefficient: { hoso: 1, pd: 1.2, vap: 9.9 } } },
      finance: FINANCE_PARAMETERS_V1,
      rawMaterials: RAW_MATERIALS_PARAMETERS_V1,
      standardAi: STANDARD_AI_PARAMETERS_V1,
    },
  });
  const laborEntry = modified.entries.find((e) => e.id === "LABOR.WORKER_PRODUCTIVITY");
  assert.ok(laborEntry, "労務知識が引けていない");
  assert.match(laborEntry!.explanation, /9\.90/, "現在のparameterへ追随していない");
});

test("AMM-GK-23: Run Memory はゲームルールを上書きしない（Truth Hierarchyがpromptで明示されている）", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const prompt = fs.readFileSync(path.join(process.cwd(), "app/lib/v2/companyLab/aiManagementMeeting/prompt.ts"), "utf8");
  const hierarchyStart = prompt.indexOf("【情報の優先順位（Truth Hierarchy・重要）】");
  assert.ok(hierarchyStart > 0, "Truth Hierarchy節が無い");
  const hierarchy = prompt.slice(hierarchyStart, hierarchyStart + 1200);
  const knowledgeRank = hierarchy.indexOf("gameKnowledgeのformal game rule");
  const memoryRank = hierarchy.indexOf("Run Advisory Memory");
  assert.ok(knowledgeRank > 0 && memoryRank > 0, "Knowledge/Memoryが優先順位へ現れていない");
  assert.ok(knowledgeRank < memoryRank, "Run Advisory Memory がゲームルールより上位に置かれている");
  // 一般的business knowledgeは最下位のまま。
  assert.ok(hierarchy.indexOf("一般的なbusiness knowledge") > memoryRank);
});

test("AMM-GK-24: CURRENT PLAYTEST（simulation-runs）経路と company-labs 経路の両方がRegistryを使う", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const session = fs.readFileSync(path.join(process.cwd(), "app/lib/v2/companyLab/aiManagementMeeting/session.ts"), "utf8");
  const handlers = fs.readFileSync(
    path.join(process.cwd(), "app/api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-meeting/messages/_lib/handlers.ts"),
    "utf8"
  );
  for (const [name, source] of [["session.ts (simulation-runs / CURRENT PLAYTEST)", session], ["handlers.ts (company-labs)", handlers]] as const) {
    assert.match(source, /buildMeetingKnowledgeInjection/, `${name} がGame Knowledgeを注入していない`);
    assert.match(source, /gameKnowledge: knowledgeInjection\.gameKnowledge/, `${name} がpromptへ渡していない`);
    assert.match(source, /knowledgeUsedIds/, `${name} がknowledgeUsedIdsを返していない`);
  }
});

// ---------------------------------------------------------------------
// Registryそのものの健全性
// ---------------------------------------------------------------------

test("AMM-GK-25: Registryの各entryがschemaを満たし、idが一意でsourceReferenceを持つ", () => {
  assert.ok(GAME_KNOWLEDGE_ENTRIES.length >= 15);
  assert.equal(new Set(GAME_KNOWLEDGE_IDS).size, GAME_KNOWLEDGE_IDS.length, "idが重複している");
  for (const entry of GAME_KNOWLEDGE_ENTRIES) {
    assert.match(entry.id, /^[A-Z_]+\.[A-Z_]+$/, `id命名が規約外: ${entry.id}`);
    assert.ok(entry.id.startsWith(entry.domain), `${entry.id} のidがdomainで始まっていない`);
    assert.ok(entry.sourceReference.length > 0, `${entry.id} にsourceReferenceが無い`);
    assert.ok(entry.appliesToRoles.length > 0, `${entry.id} にappliesToRolesが無い`);
    assert.ok(entry.keywords.length >= 3, `${entry.id} のkeywordsが少ない`);
    assert.ok(entry.version.length > 0);
  }
  assert.equal(GAME_KNOWLEDGE_REGISTRY_VERSION.knowledgeVersion, "gk-v1");
  assert.equal(GAME_KNOWLEDGE_REGISTRY_VERSION.manualVersion, "NOT_TRACKED", "追跡できないManual版を捏造していないこと");
  assert.match(GAME_KNOWLEDGE_REGISTRY_VERSION.parameterVersion, /sales=/);
});

test("AMM-GK-26: 質問意図の分類が決定論的に動く", () => {
  assert.equal(classifyQuestionIntent("売掛金はいつ入りますか？"), "GAME_RULE");
  assert.equal(classifyQuestionIntent("当社の今期の現金はいくらですか？"), "CURRENT_STATE");
  assert.equal(classifyQuestionIntent("当社は今期どのくらい売れる見込みですか？"), "MIXED");
  assert.equal(classifyQuestionIntent("来期はVAPを増やすべきでしょうか"), "STRATEGY");
  // 同じ質問は常に同じ結果（再現性）。
  const a = getGameKnowledgeForQuestion({ question: "輸入した原料はいつ使えますか？" });
  const b = getGameKnowledgeForQuestion({ question: "輸入した原料はいつ使えますか？" });
  assert.deepEqual(a.entries.map((e) => e.id), b.entries.map((e) => e.id));
  assert.ok(a.entries.some((e) => e.id === "PROCUREMENT.IMPORT_TIMING"));
});

test("AMM-GK-27: domain単位の取得ができる（他Agentからの再利用API）", () => {
  const finance = getGameKnowledgeByDomain("FINANCE");
  assert.ok(finance.length >= 3);
  assert.ok(finance.every((e) => e.domain === "FINANCE"));
  assert.ok(finance.every((e) => !e.explanation.includes("{{")), "domain取得でも動的値が解決されている必要がある");
});

test("AMM-GK-28: token予算 — 注入する知識がcompactである", () => {
  const injection = buildMeetingKnowledgeInjection({ playerMessage: "営業一人当たりの販売能力は？", primarySpeaker: "Commercial Director" });
  const serialized = JSON.stringify(injection.gameKnowledge);
  assert.ok(injection.gameKnowledge.length <= 6, "Top Nを超えている");
  assert.ok(serialized.length < 12_000, `注入サイズが大きすぎる: ${serialized.length} chars`);
  // 目安計算も同梱される（Claudeに暗算させない）。
  const withNumber = buildMeetingKnowledgeInjection({ playerMessage: "営業60人なら何トン売れますか？", primarySpeaker: "Commercial Director" });
  assert.ok(withNumber.gameKnowledgeEstimates !== null, "60人の目安が計算されていない");
});
