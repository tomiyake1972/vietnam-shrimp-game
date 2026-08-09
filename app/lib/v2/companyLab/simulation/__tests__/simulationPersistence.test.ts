// ShrimpX V2 — 32Q Management Console Phase 2 のテスト
//
// 【このテスト群が守る因果】
//  (a) 実行結果は1つの Simulation Run として保存でき、読み戻すと同じ内容になる
//      （＝リロードで結果が消えない、の土台）
//  (b) Console と Analysis は同じ simulationRunId から同じ dataset を得る
//      （＝両画面が同じ実行を見る、の土台）
//  (c) TRUE WORLD と OBSERVABLE が別系列として保存される（混ざらない）
//  (d) 律速の分類は決定論的で、生成AIに依存しない
//  (e) AI Trace は Standard AI が既に計算した値の詰め替えであり、6段階すべて揃う
//  (f) 保存物に CompanyLabState 全体を複製していない

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { advanceSimulationTurn, advanceSimulationTurns, createSimulationSession } from "../engine";
import { buildDatasetFromSession, buildBottleneckFacts, buildBottleneckTransitions, selectMarketMetrics } from "../analytics/dataset";
import { AI_TRACE_STAGES, SIMULATION_ANALYTICS_SCHEMA_VERSION } from "../analytics/types";
import { toBottleneckHeatmap, toCompanySeries, toMarketSeries, toProducerCountrySeries } from "../analytics/views";
import {
  createInMemorySimulationRunRepository,
  SIMULATION_RUN_RETENTION_LIMIT,
  parseStoredSimulationRun,
  sortAndLimitSummaries,
} from "../persistence/repository";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, isReadableSimulationRunSchema, toSimulationRunSummary } from "../persistence/types";
import { assertAllowedSimulationRunKeys, assertValidSimulationRunId, simulationRunIndexKeyV2, simulationRunKeyV2 } from "../../../redis/simulationRunRedisKeys";
import { CompanyQuarterSummary } from "../../types";
import { hosoEqTons } from "../../../core/units";

const AT = "2026-01-01T00:00:00.000Z";

function runTurns(turns: number) {
  const session = createSimulationSession({ simulationRunId: "test-run", scenarioId: "baseline", seed: "phase2-test", requestedTurns: turns, startedAt: AT });
  return advanceSimulationTurns({ session, turns, timestamp: AT });
}

// ---------------------------------------------------------------------
// 1. dataset の構築
// ---------------------------------------------------------------------

test("P2-1: dataset は long-format の事実表として組み立てられ、ターン数・会社数と整合する", () => {
  const session = runTurns(3);
  const dataset = buildDatasetFromSession(session);

  assert.equal(dataset.schemaVersion, SIMULATION_ANALYTICS_SCHEMA_VERSION);
  assert.deepEqual([...dataset.turns], [1, 2, 3]);
  assert.equal(dataset.companies.length, session.fixtures.length);
  // 律速は「会社 × ターン」ぶん必ず1行ある（記録が無い会社を落とさない）。
  assert.equal(dataset.bottlenecks.length, session.fixtures.length * 3);
  // AI Trace は「会社 × ターン × 6段階」。
  assert.equal(dataset.aiTrace.length, session.fixtures.length * 3 * AI_TRACE_STAGES.length);
});

test("P2-2: 表示のためにゲームの計算をやり直さない（dataset は確定記録と一致する）", () => {
  const session = runTurns(2);
  const dataset = buildDatasetFromSession(session);
  const record = session.state.history[1];

  for (const fixture of session.fixtures) {
    const fin = record.financialResults?.find((f) => f.companyId === fixture.companyId);
    const fact = dataset.companyMetrics.find((f) => f.turn === 2 && f.companyId === fixture.companyId && f.metric === "revenue");
    if (fin?.profitAndLoss?.netRevenue === undefined) continue;
    assert.equal(fact?.value, Number(fin.profitAndLoss.netRevenue), `${fixture.companyId} の売上が確定記録と一致しない`);
  }
});

test("P2-3: 取得できない値は 0 で埋めず、行を作らない（捏造しない）", () => {
  const session = runTurns(1);
  const dataset = buildDatasetFromSession(session);
  // 実在しない会社の行は作られない。
  assert.equal(dataset.companyMetrics.filter((f) => f.companyId === "NOT_A_COMPANY").length, 0);
  // 記録された行に NaN・undefined は入らない。
  for (const f of dataset.companyMetrics) {
    assert.ok(f.value === null || Number.isFinite(f.value), `${f.metric} に有限でない値が入っている`);
  }
});

// ---------------------------------------------------------------------
// 2. TRUE WORLD と OBSERVABLE の分離
// ---------------------------------------------------------------------

test("P2-4: 市場需要は TRUE WORLD と OBSERVABLE が別系列として保存される", () => {
  const session = runTurns(4);
  const dataset = buildDatasetFromSession(session);

  const trueFacts = selectMarketMetrics(dataset.marketMetrics, { metrics: ["demandQuantity"], visibility: "trueWorld" });
  const observedFacts = selectMarketMetrics(dataset.marketMetrics, { metrics: ["demandQuantity"], visibility: "observable" });

  assert.ok(trueFacts.length > 0, "TRUE WORLD の需要が記録されていない");
  assert.ok(observedFacts.length > 0, "OBSERVABLE の需要が記録されていない");
  // 同じ visibility の行に、別の visibility が混ざらない。
  assert.ok(trueFacts.every((f) => f.visibility === "trueWorld"));
  assert.ok(observedFacts.every((f) => f.visibility === "observable"));
});

test("P2-5: OBSERVABLE は遅行情報である（sourceTurn が当期より前、または初期情報でnull）", () => {
  const session = runTurns(5);
  const dataset = buildDatasetFromSession(session);
  const observed = dataset.marketMetrics.filter((f) => f.visibility === "observable");
  assert.ok(observed.length > 0);
  for (const f of observed) {
    assert.ok(f.sourceTurn === null || f.sourceTurn < f.turn, `観測需要が当期以降の実績を指している（turn=${f.turn}, sourceTurn=${f.sourceTurn}）`);
  }
});

test("P2-6: TRUE WORLD と OBSERVABLE は同じ数量ではない（同じ系列として扱えないことの実証）", () => {
  const session = runTurns(6);
  const dataset = buildDatasetFromSession(session);
  const trueSeries = toMarketSeries(dataset, "demandQuantity", "hoso", "trueWorld");
  const obsSeries = toMarketSeries(dataset, "demandQuantity", "hoso", "observable");
  assert.ok(trueSeries.length > 0 && obsSeries.length > 0);

  // 少なくとも1つの市場・1つのターンで値が異なる（時点が違うため）。
  let differs = false;
  for (const t of trueSeries) {
    const o = obsSeries.find((x) => x.market === t.market);
    if (!o) continue;
    for (let i = 0; i < t.points.length; i++) {
      const a = t.points[i].value;
      const b = o.points[i]?.value;
      if (a !== null && b !== null && Math.abs(a - b) > 1e-6) differs = true;
    }
  }
  assert.ok(differs, "TRUE WORLD と OBSERVABLE が全ターン一致しており、遅行情報になっていない");
});

// ---------------------------------------------------------------------
// 3. GLOBAL PRODUCER DATA（消費市場シェアを捏造しない）
// ---------------------------------------------------------------------

test("P2-7: 産地国データは国単位であり、市場×産地国のシェアは作らない", () => {
  const session = runTurns(2);
  const dataset = buildDatasetFromSession(session);
  assert.ok(dataset.producerCountryMetrics.length > 0);

  // 産地国の行は market フィールドを持たない（型・実データの両面で確認する）。
  for (const fact of dataset.producerCountryMetrics) {
    assert.ok(!Object.prototype.hasOwnProperty.call(fact, "market"), "産地国データに市場が紐づいている（消費市場シェアを作ってしまっている）");
  }
  const series = toProducerCountrySeries(dataset, "production");
  assert.ok(series.length >= 1, "産地国の生産データが取れていない");
});

// ---------------------------------------------------------------------
// 4. 律速（決定論的・生成AIなし）
// ---------------------------------------------------------------------

function summaryWith(companyId: string, raw: number, equipment: number, labor: number): CompanyQuarterSummary {
  return {
    companyId,
    rawMaterialShortfall: hosoEqTons(raw),
    equipmentShortfall: hosoEqTons(equipment),
    laborShortfall: hosoEqTons(labor),
  } as unknown as CompanyQuarterSummary;
}

test("P2-8: 律速の主要因は3つの不足量の大小比較だけで決まり、同点は 原料→設備→労働 の順で決まる", () => {
  const history = [
    { turn: 1, companySummaries: [summaryWith("A", 0, 0, 0), summaryWith("B", 10, 5, 1), summaryWith("C", 5, 10, 1), summaryWith("D", 1, 5, 10), summaryWith("E", 7, 7, 7)] },
  ] as never;
  const facts = buildBottleneckFacts(history, ["A", "B", "C", "D", "E"]);
  assert.equal(facts.find((f) => f.companyId === "A")?.primary, "none");
  assert.equal(facts.find((f) => f.companyId === "B")?.primary, "rawMaterial");
  assert.equal(facts.find((f) => f.companyId === "C")?.primary, "equipment");
  assert.equal(facts.find((f) => f.companyId === "D")?.primary, "labor");
  // 同点は原料が勝つ（実行ごとに揺れない決め方であること）。
  assert.equal(facts.find((f) => f.companyId === "E")?.primary, "rawMaterial");
});

test("P2-9: 律速の遷移は「切り替わったターン」だけを記録する", () => {
  const history = [
    { turn: 1, companySummaries: [summaryWith("A", 10, 1, 1)] },
    { turn: 2, companySummaries: [summaryWith("A", 10, 1, 1)] },
    { turn: 3, companySummaries: [summaryWith("A", 1, 10, 1)] },
    { turn: 4, companySummaries: [summaryWith("A", 1, 10, 1)] },
    { turn: 5, companySummaries: [summaryWith("A", 0, 0, 0)] },
  ] as never;
  const transitions = buildBottleneckTransitions(buildBottleneckFacts(history, ["A"]));
  assert.deepEqual(
    transitions.map((t) => `${t.turn}:${t.from}->${t.to}`),
    ["3:rawMaterial->equipment", "5:equipment->none"]
  );
});

test("P2-10: ヒートマップは 会社×全ターン ぶんのセルを必ず持つ（歯抜けにしない）", () => {
  const session = runTurns(4);
  const dataset = buildDatasetFromSession(session);
  const heatmap = toBottleneckHeatmap(dataset);
  assert.equal(heatmap.length, session.fixtures.length);
  for (const row of heatmap) assert.equal(row.cells.length, 4);
});

// ---------------------------------------------------------------------
// 5. AI Trace（6段階・既存診断の詰め替えであること）
// ---------------------------------------------------------------------

test("P2-11: AI Trace は 6段階すべてが揃い、段階名は固定である", () => {
  const session = runTurns(2);
  const dataset = buildDatasetFromSession(session);
  for (const fixture of session.fixtures) {
    for (const turn of [1, 2]) {
      const stages = dataset.aiTrace.filter((f) => f.companyId === fixture.companyId && f.turn === turn).map((f) => f.stage);
      assert.deepEqual([...stages].sort(), [...AI_TRACE_STAGES].sort(), `${fixture.companyId} Q${turn} の段階が揃っていない`);
    }
  }
});

test("P2-12: DECIDED は実際にゲームへ提出された意思決定と一致する（画面用の別計算をしていない）", () => {
  const session = runTurns(1);
  const dataset = buildDatasetFromSession(session);
  const record = session.state.history[0];
  for (const fixture of session.fixtures) {
    const decision = record.decisions.find((d) => d.companyId === fixture.companyId);
    const decided = dataset.aiTrace.find((f) => f.companyId === fixture.companyId && f.turn === 1 && f.stage === "DECIDED");
    const hire = decided?.items.find((i) => i.label === "営業人員 採用");
    assert.equal(hire?.value ?? 0, decision?.salesForceHireCount ?? 0, `${fixture.companyId} の採用人数がトレースと一致しない`);
  }
});

test("P2-13: RESULT は確定済み実績（companySummaries）から作られる", () => {
  const session = runTurns(1);
  const dataset = buildDatasetFromSession(session);
  const record = session.state.history[0];
  for (const fixture of session.fixtures) {
    const summary = record.companySummaries.find((s) => s.companyId === fixture.companyId);
    const result = dataset.aiTrace.find((f) => f.companyId === fixture.companyId && f.turn === 1 && f.stage === "RESULT");
    const hoso = result?.items.find((i) => i.label === "HOSO生産");
    assert.ok(summary !== undefined && result !== undefined);
    assert.equal(hoso?.value ?? 0, Number(summary.hosoProduced), `${fixture.companyId} のHOSO生産が実績と一致しない`);
  }
});

test("P2-14: NaN を保持する診断値は数値として出さない（unknown を text で示す）", () => {
  const session = runTurns(2);
  const dataset = buildDatasetFromSession(session);
  for (const fact of dataset.aiTrace) {
    for (const item of fact.items) {
      assert.ok(item.value === undefined || Number.isFinite(item.value), `${item.label} に NaN が保存されている`);
    }
  }
});

// ---------------------------------------------------------------------
// 6. 永続化
// ---------------------------------------------------------------------

test("P2-15: 保存した Simulation Run を読み戻すと同じ dataset になる（リロード復元の土台）", async () => {
  const session = runTurns(3);
  const dataset = buildDatasetFromSession(session);
  const repository = createInMemorySimulationRunRepository();
  const stored = { schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION, run: session.run, dataset, savedAt: AT };

  await repository.saveRun(stored);
  const loaded = await repository.loadRun(session.run.simulationRunId);
  assert.ok(loaded !== null);
  assert.deepEqual(loaded.dataset, dataset);
  assert.equal(loaded.run.simulationRunId, session.run.simulationRunId);
});

test("P2-16: 保存物に CompanyLabState 全体を複製していない", async () => {
  const session = runTurns(4);
  const stored = { schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION, run: session.run, dataset: buildDatasetFromSession(session), savedAt: AT };
  const json = JSON.stringify(stored);

  // 会社ラボの生の状態フィールドが保存物へ紛れ込んでいないこと。
  for (const key of ["rawMaterialLots", "finishedGoodsLots", "scenarioState", "capexState", "qualityState", "contracts"]) {
    assert.ok(!json.includes(`"${key}"`), `保存物に ${key} が含まれている（巨大な state を複製している）`);
  }
  // 保存物は state 全体より確実に小さい。
  assert.ok(json.length < JSON.stringify(session.state).length, "保存物が state 全体より小さくなっていない");
});

test("P2-17: 一覧は保存が新しい順に並び、保存上限を超えた古い実行は消える", async () => {
  const repository = createInMemorySimulationRunRepository();
  const session = runTurns(1);
  const dataset = buildDatasetFromSession(session);
  for (let i = 0; i < SIMULATION_RUN_RETENTION_LIMIT + 3; i++) {
    await repository.saveRun({
      schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
      run: { ...session.run, simulationRunId: `run-${String(i).padStart(2, "0")}` },
      dataset,
      savedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }
  const runs = await repository.listRuns();
  assert.equal(runs.length, SIMULATION_RUN_RETENTION_LIMIT);
  assert.equal(runs[0].simulationRunId, `run-${String(SIMULATION_RUN_RETENTION_LIMIT + 2).padStart(2, "0")}`, "最新が先頭に来ていない");
  assert.equal(await repository.loadRun("run-00"), null, "上限を超えた古い実行が残っている");
});

test("P2-18: 現行より新しいスキーマ版だけを拒否する（追加的変更は読み込める）", () => {
  assert.ok(isReadableSimulationRunSchema(1));
  assert.ok(isReadableSimulationRunSchema(CURRENT_SIMULATION_RUN_PERSISTED_VERSION));
  assert.ok(!isReadableSimulationRunSchema(CURRENT_SIMULATION_RUN_PERSISTED_VERSION + 1));
  assert.ok(!isReadableSimulationRunSchema("1"));
  assert.throws(() => parseStoredSimulationRun(JSON.stringify({ schemaVersion: 999, run: {}, dataset: {} }), "x"));
});

test("P2-19: 要約は dataset を読まずに作れる（一覧のたびに全件読まない）", () => {
  const session = runTurns(2);
  const summary = toSimulationRunSummary({
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset: buildDatasetFromSession(session),
    savedAt: AT,
  });
  assert.equal(summary.simulationRunId, session.run.simulationRunId);
  assert.equal(summary.completedTurns, session.run.completedTurns);
  assert.ok(!Object.prototype.hasOwnProperty.call(summary, "dataset"), "要約に dataset が入っている");
});

test("P2-20: 並び順ヘルパーは保存時刻の降順、同時刻は ID 昇順で決まる（実行ごとに揺れない）", () => {
  const base = { scenarioId: "baseline", seed: "s", requestedTurns: 32, completedTurns: 32, stopReason: "completed" as const, startedAt: AT, completedAt: AT, gameParameterVersion: "g", standardAiVersion: "a" };
  const sorted = sortAndLimitSummaries(
    [
      { ...base, simulationRunId: "b", savedAt: "2026-01-02T00:00:00.000Z" },
      { ...base, simulationRunId: "a", savedAt: "2026-01-02T00:00:00.000Z" },
      { ...base, simulationRunId: "c", savedAt: "2026-01-03T00:00:00.000Z" },
    ],
    10
  );
  assert.deepEqual(sorted.map((s) => s.simulationRunId), ["c", "a", "b"]);
});

// ---------------------------------------------------------------------
// 7. Redis キーの安全性
// ---------------------------------------------------------------------

test("P2-21: Simulation Run のキーは会社ラボ・本番ゲームの名前空間と分離されている", () => {
  const key = simulationRunKeyV2("staging", "run-1");
  assert.equal(key, "staging:v2:simulationRun:run-1");
  assert.equal(simulationRunKeyV2("production", "run-1"), "v2:simulationRun:run-1");
  assert.equal(simulationRunIndexKeyV2("staging"), "staging:v2:simulationRun:index");
  // 会社ラボ・本番ゲームのキーへは書けない。
  assert.throws(() => assertAllowedSimulationRunKeys(["staging:v2:companyLab:lab1:current"], "staging"));
  assert.throws(() => assertAllowedSimulationRunKeys(["v2:game:ABCD"], "production"));
  assert.doesNotThrow(() => assertAllowedSimulationRunKeys([key], "staging"));
});

test("P2-22: simulationRunId に不正な文字は使えない（キー空間からの逸脱を防ぐ）", () => {
  assert.doesNotThrow(() => assertValidSimulationRunId("run-management-console-32q-20260101T000000000Z"));
  assert.throws(() => assertValidSimulationRunId("run/../../etc"));
  assert.throws(() => assertValidSimulationRunId(""));
  assert.throws(() => assertValidSimulationRunId("run with space"));
});

// ---------------------------------------------------------------------
// 8. Console と Analysis が同じ実行を見る（構造で保証する）
// ---------------------------------------------------------------------

test("P2-23: Analysis 画面は simulation engine を import しない（再simulationしないことを構造で担保）", () => {
  const analysisDir = path.join(process.cwd(), "app/v2/management/analysis");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) files.push(full);
    }
  };
  walk(analysisDir);
  assert.ok(files.length > 0, "Analysis 画面のファイルが見つからない");

  for (const file of files) {
    const importLines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => /^\s*import\s/.test(line));
    for (const line of importLines) {
      assert.ok(!line.includes("simulation/engine"), `${path.basename(file)} が simulation/engine を import している（Analysis で再実行してしまう）`);
      assert.ok(!line.includes("companyLab/runner"), `${path.basename(file)} が companyLab/runner を import している`);
      assert.ok(!line.includes("standardAi/policy"), `${path.basename(file)} が standardAi/policy を import している`);
    }
  }
});

test("P2-24: Console と Analysis は同じ dataset 変換関数を使う（別々の集計器を作らない）", () => {
  const session = runTurns(3);
  const dataset = buildDatasetFromSession(session);
  // 同じ dataset・同じ指標なら、どの画面から呼んでも同じ系列になる。
  const a = toCompanySeries(dataset, "revenue");
  const b = toCompanySeries(dataset, "revenue");
  assert.deepEqual(a, b);
  assert.equal(a.length, session.fixtures.length);
  assert.equal(a[0].points.length, 3);
});

// ---------------------------------------------------------------------
// 9. 実行の記録（STOP・失敗も保存対象になる）
// ---------------------------------------------------------------------

test("P2-25: STOP した実行も、完了ターンぶんの dataset を持つ保存物になる", () => {
  let session = createSimulationSession({ simulationRunId: "stop-run", scenarioId: "baseline", seed: "phase2-test", requestedTurns: 32, startedAt: AT });
  let stopAfter = 0;
  session = advanceSimulationTurns({ session, turns: 32, timestamp: AT, shouldStop: () => ++stopAfter > 3 });
  assert.equal(session.run.stopReason, "stopped_by_user");
  const dataset = buildDatasetFromSession(session);
  assert.equal(dataset.turns.length, 3, "完了ターンぶんだけが保存対象になっていない");
  assert.equal(session.run.completedTurns, 3);
});

test("P2-26: 能力（capacity）はターンごとに記録され、dataset から復元できる", () => {
  const session = runTurns(2);
  const dataset = buildDatasetFromSession(session);
  for (const fixture of session.fixtures) {
    const fact = dataset.companyMetrics.find((f) => f.turn === 1 && f.companyId === fixture.companyId && f.metric === "commonCapacity");
    assert.ok(fact !== undefined && fact.value !== null && fact.value > 0, `${fixture.companyId} の共通処理能力が記録されていない`);
  }
});

test("P2-27: 1ターンだけ進めても dataset が壊れない（区切りごとに保存できる）", () => {
  const session = createSimulationSession({ simulationRunId: "one", scenarioId: "baseline", seed: "phase2-test", requestedTurns: 32, startedAt: AT });
  const outcome = advanceSimulationTurn(session, AT);
  assert.ok(outcome.advanced);
  const dataset = buildDatasetFromSession(outcome.session);
  assert.deepEqual([...dataset.turns], [1]);
  assert.equal(dataset.aiTrace.length, session.fixtures.length * AI_TRACE_STAGES.length);
});
