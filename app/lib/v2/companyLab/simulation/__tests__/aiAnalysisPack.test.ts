// ShrimpX V2 — AI Analysis Pack のテスト
//
// 【このテスト群が守る因果】
//  (a) Pack だけを見れば「この8年間で何が起きたか」を Turn 単位で追える
//  (b) TRUE WORLD と OBSERVABLE が絶対に混ざらない
//  (c) 未来ターンの情報が過去ターンへ混入しない
//  (d) 決定（decision）と結果（execution / financialResult）が分離されている
//  (e) 保存済み Simulation Run / Analysis 画面と数値が完全に一致する
//  (f) 秘密情報が一切含まれない
//  (g) 途中停止した実行はゼロ埋めされない

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurns, createSimulationSession } from "../engine";
import { buildDatasetFromSession } from "../analytics/dataset";
import { reconcileSalesAllocation } from "../analytics/views";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRun } from "../persistence/types";
import { AI_ANALYSIS_PACK_SCHEMA_VERSION } from "../aiPack/types";
import { buildAiAnalysisPackContext } from "../aiPack/context";
import { buildMajorChanges, majorChangesToCsv, MAJOR_CHANGE_THRESHOLDS } from "../aiPack/changeLog";
import { buildRunSummaryMarkdown } from "../aiPack/summary";
import { buildDataDictionaryMarkdown } from "../aiPack/dataDictionary";
import { packFileName } from "../aiPack/pack";
import { STANDARD_AI_PROPOSABLE_CAPEX_TYPES } from "../../standardAi/decision/capex";
import { CAPITAL_PROJECT_TYPES } from "../../../capex/types";

const AT = "2026-01-01T00:00:00.000Z";

function buildStored(turns: number, options?: { readonly stopAfter?: number }): StoredSimulationRun {
  let session = createSimulationSession({ simulationRunId: "pack-test", scenarioId: "baseline", seed: "pack-test", requestedTurns: turns, startedAt: AT });
  let count = 0;
  session = advanceSimulationTurns({
    session,
    turns,
    timestamp: AT,
    shouldStop: options?.stopAfter === undefined ? undefined : () => ++count > (options.stopAfter as number),
  });
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset: buildDatasetFromSession(session),
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    savedAt: AT,
  };
}

function buildContext(stored: StoredSimulationRun) {
  return buildAiAnalysisPackContext({ stored, exportedAt: AT, sourceBranch: "test-branch", sourceCommit: "test-commit" });
}

// ---------------------------------------------------------------------
// 1. スキーマとメタデータ
// ---------------------------------------------------------------------

test("PACK-1: schemaVersion と run メタデータが揃っている（分からない値は捏造しない）", () => {
  const context = buildContext(buildStored(3));
  assert.equal(context.schemaVersion, AI_ANALYSIS_PACK_SCHEMA_VERSION);
  for (const key of [
    "simulationRunId",
    "scenarioId",
    "scenarioVersion",
    "seed",
    "gameParameterVersion",
    "standardAiVersion",
    "strategyProfileVersion",
    "startingTurn",
    "completedTurns",
    "requestedTurns",
    "startedAt",
    "stopReason",
    "exportedAt",
    "sourceBranch",
    "sourceCommit",
  ] as const) {
    assert.ok(context.run[key] !== undefined, `${key} が欠けている`);
  }
  // 未指定なら UNKNOWN（空文字やダミー値を作らない）。
  const withoutSource = buildAiAnalysisPackContext({ stored: buildStored(1), exportedAt: AT });
  assert.equal(withoutSource.run.sourceBranch, "UNKNOWN");
  assert.equal(withoutSource.run.sourceCommit, "UNKNOWN");
});

test("PACK-2: world.turns の件数 = completedTurns、5社すべてが同じターン数を持つ", () => {
  const stored = buildStored(5);
  const context = buildContext(stored);
  assert.equal(context.run.completedTurns, 5);
  assert.equal(context.world.turns.length, 5);
  assert.equal(Object.keys(context.companies).length, 5);
  for (const company of Object.values(context.companies)) {
    assert.equal(company.turns.length, 5, `${company.companyId} のターン数が一致しない`);
    assert.deepEqual(company.turns.map((t) => t.turn), [1, 2, 3, 4, 5]);
  }
});

// ---------------------------------------------------------------------
// 2. TRUE WORLD と OBSERVABLE の分離
// ---------------------------------------------------------------------

test("PACK-3: TRUE WORLD と OBSERVABLE は別のオブジェクトに分かれている", () => {
  const context = buildContext(buildStored(5));
  for (const world of context.world.turns) {
    assert.ok(Array.isArray(world.trueWorld.marketProducts));
    assert.ok(Array.isArray(world.standardAiObservable.marketProducts));
    // TRUE 側に観測フィールドが混ざらない／その逆も。
    for (const mp of world.trueWorld.marketProducts) {
      assert.ok(!Object.prototype.hasOwnProperty.call(mp, "observableDemandTons"), "TRUE WORLD に観測値が混ざっている");
    }
    for (const mp of world.standardAiObservable.marketProducts) {
      assert.ok(!Object.prototype.hasOwnProperty.call(mp, "trueDemandTons"), "OBSERVABLE に真値が混ざっている");
    }
  }
});

test("PACK-4: OBSERVABLE の sourceTurn は当期より前（未来の情報が過去へ混入しない）", () => {
  const context = buildContext(buildStored(6));
  for (const world of context.world.turns) {
    for (const mp of world.standardAiObservable.marketProducts) {
      assert.ok(mp.sourceTurn === null || mp.sourceTurn < world.turn, `Q${world.turn} の観測値が当期以降を指している`);
    }
  }
});

test("PACK-5: 消費市場×産地国のシェアは作らない（NOT_AVAILABLE として明示する）", () => {
  const context = buildContext(buildStored(2));
  const note = context.dataAvailability.find((n) => n.field.includes("marketCountrySupplyShare"));
  assert.ok(note !== undefined, "market×産地国シェアの不在が明示されていない");
  assert.equal(note.availability, "NOT_AVAILABLE");
  // 産地国データは国単位であり、市場が紐づいていない。
  for (const world of context.world.turns) {
    for (const c of world.trueWorld.producerCountries) {
      assert.ok(!Object.prototype.hasOwnProperty.call(c, "market"), "産地国データに市場が紐づいている");
    }
  }
});

// ---------------------------------------------------------------------
// 3. 因果の分離（decision と result）
// ---------------------------------------------------------------------

test("PACK-6: 各ターンが Beginning → Observed → Diagnosis → Wanted → Constraints → Decision → Execution → Financial → Ending を持つ", () => {
  const context = buildContext(buildStored(2));
  for (const company of Object.values(context.companies)) {
    for (const turn of company.turns) {
      for (const section of ["beginningState", "observed", "diagnosis", "wanted", "constraints", "decision", "execution", "financialResult", "endingState"] as const) {
        assert.ok(turn[section] !== undefined, `${company.companyId} Q${turn.turn} に ${section} が無い`);
      }
    }
  }
});

test("PACK-7: 期首状態と期末状態は同じ形で、期末が次ターンの期首と連続する", () => {
  const context = buildContext(buildStored(4));
  for (const company of Object.values(context.companies)) {
    for (let i = 1; i < company.turns.length; i++) {
      const prevEnd = company.turns[i - 1].endingState;
      const currBegin = company.turns[i].beginningState;
      assert.deepEqual(Object.keys(prevEnd).sort(), Object.keys(currBegin).sort(), "期首と期末の形が違う");
      assert.equal(currBegin.cashUsd, prevEnd.cashUsd, `${company.companyId} Q${company.turns[i].turn}: 期首現金が前期末と連続していない`);
      assert.equal(currBegin.salesHeadcount, prevEnd.salesHeadcount, "期首営業人員が前期末と連続していない");
    }
  }
});

test("PACK-8: wanted（希望）と decision（提出）が別項目として保たれている", () => {
  const context = buildContext(buildStored(3));
  let compared = 0;
  for (const company of Object.values(context.companies)) {
    for (const turn of company.turns) {
      for (const wish of turn.wanted.desiredSalesByMarketProduct) {
        const plan = turn.decision.salesPlanByMarketProduct.find((p) => p.market === wish.market && p.product === wish.product);
        assert.ok(plan !== undefined, "希望に対応する提出値が無い");
        compared++;
      }
    }
  }
  assert.ok(compared > 0, "希望と提出の比較対象が1件も無い");
});

// ---------------------------------------------------------------------
// 4. 既存記録との一致（別途再計算していないこと）
// ---------------------------------------------------------------------

test("PACK-9: 財務値は保存済み Simulation Run の dataset と完全一致する", () => {
  const stored = buildStored(4);
  const context = buildContext(stored);
  for (const company of Object.values(context.companies)) {
    for (const turn of company.turns) {
      for (const [field, metric] of [
        ["netRevenueUsd", "revenue"],
        ["operatingProfitUsd", "operatingProfit"],
        ["netIncomeUsd", "netIncome"],
      ] as const) {
        const expected = stored.dataset.companyMetrics.find((f) => f.turn === turn.turn && f.companyId === company.companyId && f.metric === metric)?.value ?? null;
        assert.equal(turn.financialResult[field], expected, `${company.companyId} Q${turn.turn} の ${metric} が dataset と一致しない`);
      }
    }
  }
});

test("PACK-10: 営業人員・市場別配置が analytics の突き合わせ結果と一致する", () => {
  const stored = buildStored(4);
  const context = buildContext(stored);
  const rows = reconcileSalesAllocation(stored.dataset);
  for (const row of rows) {
    const turn = context.companies[row.companyId].turns.find((t) => t.turn === row.turn);
    assert.ok(turn !== undefined);
    const allocated = turn.decision.salesAllocationByMarket.filter((a) => a.market !== "UNALLOCATED").reduce((s, a) => s + a.headcount, 0);
    assert.equal(allocated, row.allocated, `${row.companyId} Q${row.turn} の配置合計が一致しない`);
    assert.ok(row.matches, "配置＋未配置＝総人数が成立していない");
  }
});

test("PACK-11: 工場能力・工場スペースが実行時の状態と一致する", () => {
  const stored = buildStored(3);
  const context = buildContext(stored);
  for (const capture of stored.packCapture!.companyTurns) {
    const turn = context.companies[capture.companyId].turns.find((t) => t.turn === capture.turn);
    assert.ok(turn !== undefined);
    assert.deepEqual(turn.endingState.capacityTonsByProduct, capture.endingState.capacityTonsByProduct);
    assert.equal(turn.endingState.factorySpaceRemainingUnits, capture.endingState.factorySpaceRemainingUnits);
    assert.equal(turn.endingState.factoryCount, capture.endingState.factoryCount);
  }
});

test("PACK-12: 商品別採算は財務モジュールの限界利益と一致する（推測配賦していない）", () => {
  const stored = buildStored(3);
  const context = buildContext(stored);
  for (const company of Object.values(context.companies)) {
    for (const turn of company.turns) {
      for (const p of turn.financialResult.productEconomics) {
        const expected = stored.dataset.contribution.find((c) => c.turn === turn.turn && c.companyId === company.companyId && c.product === p.product);
        if (!expected) continue;
        assert.equal(p.contributionUsd, expected.contributionMargin);
        assert.equal(p.contributionMarginRatio, expected.contributionMarginRatio);
      }
    }
  }
});

test("PACK-13: AI Trace と同じ記録を参照している（別途 Standard AI を再実行していない）", () => {
  const stored = buildStored(2);
  const context = buildContext(stored);
  for (const company of Object.values(context.companies)) {
    for (const turn of company.turns) {
      const observedFact = stored.dataset.aiTrace.find((f) => f.turn === turn.turn && f.companyId === company.companyId && f.stage === "OBSERVED");
      assert.deepEqual(turn.observed.items, observedFact?.items ?? []);
    }
  }
});

// ---------------------------------------------------------------------
// 5. 設備投資（新工場を建てなかった理由を追えること）
// ---------------------------------------------------------------------

test("PACK-14: Standard AI が提案しうる投資種別が、コード上の定数として記録される", () => {
  const context = buildContext(buildStored(2));
  assert.deepEqual([...context.standardAiProposableCapexTypes], [...STANDARD_AI_PROPOSABLE_CAPEX_TYPES]);
  assert.deepEqual([...context.gameCapexTypes], [...CAPITAL_PROJECT_TYPES]);
  // 【2026-08-09・Vision駆動の戦略成長で変更】新工場建設は Standard AI の提案対象に
  // なった（decision/newFactory.ts の戦略評価を経る）。以前はゲームには存在するが
  // Standard AI からは構造的に一度も提案されない種別であり、この差自体が Pack の
  // 監査対象だった。定数が実態と一致していることをここで固定する。
  assert.ok(context.gameCapexTypes.includes("newFactoryConstruction"));
  assert.ok(context.standardAiProposableCapexTypes.includes("newFactoryConstruction"));
});

test("PACK-15: 新工場を建てなかった理由を追うための項目が揃っている", () => {
  const context = buildContext(buildStored(6));
  for (const company of Object.values(context.companies)) {
    const last = company.turns[company.turns.length - 1];
    // 工場スペース・能力・現金・借入・律速・投資理由コードのすべてが参照できる。
    assert.ok(last.endingState.factorySpaceRemainingUnits !== null, "工場スペース残が無い");
    assert.ok(last.endingState.capacityTonsByProduct.hoso !== null, "HOSO能力が無い");
    assert.ok(last.endingState.cashUsd !== null, "現金が無い");
    assert.ok(last.endingState.debtUsd !== null, "借入残高が無い");
    assert.ok(last.diagnosis.commercialBottleneck !== null, "律速の記録が無い");
    assert.ok(Array.isArray(last.capitalProjects), "設備投資案件の一覧が無い");
  }
  // 投資判断の理由コードが記録されている（CAPEX_で始まるものが1件以上）。
  const capexCodes = Object.values(context.companies).flatMap((c) => c.turns.flatMap((t) => t.diagnosis.reasonCodes.map((r) => r.code))).filter((c) => c.startsWith("CAPEX"));
  assert.ok(capexCodes.length > 0, "設備投資判断の理由コードが1件も記録されていない");
});

// ---------------------------------------------------------------------
// 6. Major Change Log
// ---------------------------------------------------------------------

test("PACK-16: 変化ログは決定論的で、同じ入力なら同じ出力になる", () => {
  const stored = buildStored(6);
  const a = buildContext(stored).majorChanges;
  const b = buildContext(stored).majorChanges;
  assert.deepEqual(a, b);
  assert.ok(a.length > 0, "変化ログが1件も作られていない");
});

test("PACK-17: 律速の切り替わりは閾値なしで必ず記録される", () => {
  const stored = buildStored(8);
  const context = buildContext(stored);
  const transitions = context.majorChanges.filter((c) => c.metric === "PRIMARY_BOTTLENECK");
  // dataset 側の遷移件数と一致する（別基準で数えていない）。
  let expected = 0;
  for (const company of Object.values(context.companies)) {
    for (let i = 1; i < company.turns.length; i++) {
      if (company.turns[i].diagnosis.commercialBottleneck !== company.turns[i - 1].diagnosis.commercialBottleneck) expected++;
    }
  }
  assert.equal(transitions.length, expected);
});

test("PACK-18: 微小な金額変化は変化ログに載らない（生の値は timeline に残る）", () => {
  // 閾値そのものの意味を固定する（Data Dictionary の記載と一致させる）。
  assert.equal(MAJOR_CHANGE_THRESHOLDS.headcountAbsolute, 1);
  assert.equal(MAJOR_CHANGE_THRESHOLDS.capacityTons, 100);
  assert.equal(MAJOR_CHANGE_THRESHOLDS.moneyRelative, 0.1);
  assert.equal(MAJOR_CHANGE_THRESHOLDS.moneyAbsoluteUsd, 100_000);

  const companies = {
    A: {
      companyId: "A",
      turns: [
        { turn: 1, endingState: { cashUsd: 1_000_000, salesHeadcount: 10, debtUsd: 0, capacityTonsByProduct: { hoso: 1000, pd: 0, vap: 0 }, factoryCount: 1 }, decision: { salesAllocationByMarket: [] }, diagnosis: { commercialBottleneck: "none" }, execution: { capexEvents: [] } },
        // 現金が 1,000 USD だけ動く（相対も絶対も閾値未満）。
        { turn: 2, endingState: { cashUsd: 1_001_000, salesHeadcount: 10, debtUsd: 0, capacityTonsByProduct: { hoso: 1000, pd: 0, vap: 0 }, factoryCount: 1 }, decision: { salesAllocationByMarket: [] }, diagnosis: { commercialBottleneck: "none" }, execution: { capexEvents: [] } },
      ],
    },
  } as never;
  const changes = buildMajorChanges({ turns: [1, 2] } as never, [], companies);
  assert.equal(changes.filter((c) => c.metric === "CASH").length, 0, "閾値未満の現金変化が記録されている");
});

test("PACK-19: 変化ログの CSV は列が固定で、値のエスケープが壊れない", () => {
  const csv = majorChangesToCsv([
    { turn: 3, scope: "BAL", metric: "SALES_HEADCOUNT", from: "60", to: "78", changeType: "INCREASE" },
    { turn: 4, scope: "WORLD", metric: "NOTE", from: 'a,b"c', to: "x\ny", changeType: "EVENT" },
  ]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "turn,scope,metric,from,to,changeType");
  assert.equal(lines[1], "3,BAL,SALES_HEADCOUNT,60,78,INCREASE");
  assert.ok(csv.includes('"a,b""c"'), "カンマ・引用符のエスケープが壊れている");
});

// ---------------------------------------------------------------------
// 7. Markdown / ファイル名 / 秘密情報
// ---------------------------------------------------------------------

test("PACK-20: Run Summary は評価を書かず、事実と読み方の説明だけを含む", () => {
  const context = buildContext(buildStored(4));
  const md = buildRunSummaryMarkdown(context);
  assert.ok(md.includes("# ShrimpX Simulation Run — AI Analysis Pack"));
  assert.ok(md.includes("## How to read this package"));
  assert.ok(md.includes("## Run Identity"));
  assert.ok(md.includes("## Beginning vs Ending"));
  assert.ok(md.includes("## Major Investments"));
  assert.ok(md.includes("## Bottleneck Transitions"));
  assert.ok(md.includes("## Important Data Availability Notes"));
  assert.ok(md.includes("## Files in this Pack"));
  assert.ok(md.includes("## Suggested Questions"));
  // 評価語を自動生成していない。
  for (const word in { 誤った: 1, 失敗した: 1, 優れた: 1, "should have": 1 }) {
    assert.ok(!md.includes(word), `Summary に評価語「${word}」が含まれている`);
  }
});

test("PACK-21: Data Dictionary は層・単位・閾値・availability を記載する", () => {
  const context = buildContext(buildStored(2));
  const md = buildDataDictionaryMarkdown(context);
  for (const needed of ["TRUE_WORLD", "OBSERVABLE", "AI_INTERNAL", "DECISION", "RESULT", "## Units", "## Fields", "Major Change Log thresholds", "NOT_AVAILABLE"]) {
    assert.ok(md.includes(needed), `Data Dictionary に ${needed} が無い`);
  }
});

test("PACK-22: ファイル名は simulationRunId から決まり、危険な文字を含まない", () => {
  assert.equal(packFileName("run-abc-123"), "ShrimpX_Run_run-abc-123_AI_Analysis_Pack.zip");
  const dangerous = packFileName("run/../../etc passwd");
  assert.ok(!dangerous.includes("/"));
  assert.ok(!dangerous.includes(" "));
});

test("PACK-23: Pack のどのテキストにも秘密情報が含まれない", () => {
  const stored = buildStored(4);
  const context = buildContext(stored);
  const text = [JSON.stringify(context), buildRunSummaryMarkdown(context), buildDataDictionaryMarkdown(context), majorChangesToCsv(context.majorChanges)].join("\n");
  for (const secret of ["STAGING_ADMIN_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN", "ANTHROPIC_API_KEY", "Authorization", "Bearer ", "shrimpx_company_lab_ui_session", "upstash"]) {
    assert.ok(!text.includes(secret), `Pack に「${secret}」が含まれている`);
  }
});

// ---------------------------------------------------------------------
// 8. 途中停止・再現性・run の分離
// ---------------------------------------------------------------------

test("PACK-24: 途中でSTOPした実行は完了ターンぶんだけを含む（未実行ターンをゼロ埋めしない）", () => {
  const stored = buildStored(32, { stopAfter: 6 });
  const context = buildContext(stored);
  assert.equal(context.run.stopReason, "stopped_by_user");
  assert.equal(context.run.completedTurns, 6);
  assert.equal(context.world.turns.length, 6);
  for (const company of Object.values(context.companies)) {
    assert.equal(company.turns.length, 6);
    assert.ok(company.turns.every((t) => t.turn <= 6));
  }
});

test("PACK-25: 同じ保存済み実行から再exportすると、exportedAt 以外は同一になる", () => {
  const stored = buildStored(5);
  const a = buildAiAnalysisPackContext({ stored, exportedAt: "2026-01-01T00:00:00.000Z" });
  const b = buildAiAnalysisPackContext({ stored, exportedAt: "2026-06-30T12:34:56.000Z" });
  const strip = (c: ReturnType<typeof buildAiAnalysisPackContext>) => JSON.stringify({ ...c, run: { ...c.run, exportedAt: "" } });
  assert.equal(strip(a), strip(b));
});

test("PACK-26: 指定した Simulation Run のデータだけが入る（他 run が混ざらない）", () => {
  const first = buildStored(3);
  const second = buildStored(4);
  const context = buildContext(first);
  assert.equal(context.run.simulationRunId, first.run.simulationRunId);
  assert.equal(context.world.turns.length, 3);
  // 2本目の完了ターン数（4）が混ざっていない。
  assert.notEqual(context.world.turns.length, second.dataset.turns.length);
});

test("PACK-27: schemaVersion 1 の古い保存データでも壊れず、不在を NOT_RECORDED として明示する", () => {
  const stored = buildStored(3);
  const legacy: StoredSimulationRun = { schemaVersion: 1, run: stored.run, dataset: stored.dataset, savedAt: AT };
  const context = buildContext(legacy);
  assert.equal(context.world.turns.length, 0, "capture が無いのに world が作られている");
  const note = context.dataAvailability.find((n) => n.field.includes("beginningState"));
  assert.equal(note?.availability, "NOT_RECORDED");
  // 会社ターンは作られ、期首・期末は null で埋まる（0 を作らない）。
  const company = Object.values(context.companies)[0];
  assert.equal(company.turns.length, 3);
  assert.equal(company.turns[0].beginningState.cashUsd, null);
});

test("PACK-28: 生成AIを呼ばない（Pack 生成モジュールが AI SDK を import しない）", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.join(process.cwd(), "app/lib/v2/companyLab/simulation/aiPack");
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    for (const forbidden of ["@anthropic-ai/sdk", "openai", "fetch("]) {
      assert.ok(!text.includes(forbidden), `${file} が ${forbidden} を使っている（Pack 生成は決定論的でなければならない）`);
    }
  }
});
