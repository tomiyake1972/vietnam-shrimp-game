// ShrimpX V2 — Analysis Navigation / Quick Add のテスト
//
// 【このテスト群が守る因果】
//  (a) 各分析は独立したURLを持ち、Analysis Home はその索引である
//  (b) Analysis 画面は current run を書き換えない（別タブのrunが入れ替わらない）
//  (c) 限界利益・固定費は財務モジュールの正式な値と一致する（独自式・推測配賦をしない）
//  (d) 営業配置は「市場別合計＋未配置＝当期に配分可能だった総人数」で突き合う
//  (e) 途中でSTOPした実行は、足りないターンをゼロや架空値で埋めない

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { advanceSimulationTurns, createSimulationSession } from "../engine";
import { buildDatasetFromSession } from "../analytics/dataset";
import { reconcileSalesAllocation, toContributionRatioSeriesByProduct, toFixedCostSeriesByCompany, toSalesAllocationSeries } from "../analytics/views";
import { FIXED_COST_COMPONENT_KEYS } from "../analytics/types";

const AT = "2026-01-01T00:00:00.000Z";
const ANALYSIS_DIR = path.join(process.cwd(), "app/v2/management/analysis");

function runTurns(turns: number) {
  const session = createSimulationSession({ simulationRunId: "nav-test", scenarioId: "baseline", seed: "phase3-test", requestedTurns: turns, startedAt: AT });
  return advanceSimulationTurns({ session, turns, timestamp: AT });
}

function readAll(dir: string): { readonly file: string; readonly text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAll(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push({ file: full, text: fs.readFileSync(full, "utf8") });
  }
  return out;
}

// ---------------------------------------------------------------------
// 1. route 構造（1分析＝1URL）
// ---------------------------------------------------------------------

const REQUIRED_ROUTES = ["prices", "contribution", "fixed-cost", "sales-headcount", "sales-allocation", "overview", "market", "bottleneck", "ai-trace"];

test("P3-1: 今回の分析項目はそれぞれ独立した route を持つ", () => {
  for (const route of REQUIRED_ROUTES) {
    const page = path.join(ANALYSIS_DIR, route, "page.tsx");
    assert.ok(fs.existsSync(page), `${route} の独立ページが存在しない（${page}）`);
  }
  // Analysis Home 自体も存在する。
  assert.ok(fs.existsSync(path.join(ANALYSIS_DIR, "page.tsx")));
});

test("P3-2: カタログの「実装済み」項目は、すべて実在する route を指す", async () => {
  const { ANALYSIS_CATEGORIES, QUICK_NAVIGATION } = await import("../../../../../v2/management/analysis/catalog");
  const paths = new Set<string>();
  for (const category of ANALYSIS_CATEGORIES) {
    for (const item of category.items) {
      if (item.implemented) paths.add(item.path);
      else assert.equal(item.path, "", "未実装項目にリンク先が入っている（中身があるように見えてしまう）");
    }
  }
  for (const q of QUICK_NAVIGATION) paths.add(q.path);

  for (const p of paths) {
    const route = p.replace("/v2/management/analysis", "").replace(/^\//, "");
    const page = route === "" ? path.join(ANALYSIS_DIR, "page.tsx") : path.join(ANALYSIS_DIR, route, "page.tsx");
    assert.ok(fs.existsSync(page), `カタログの ${p} に対応するページが無い`);
  }
});

test("P3-3: Quick Navigation は指示された5項目を含む", async () => {
  const { QUICK_NAVIGATION } = await import("../../../../../v2/management/analysis/catalog");
  assert.deepEqual(
    QUICK_NAVIGATION.map((q) => q.label),
    ["商品別価格", "商品別限界利益", "固定費", "営業人数", "営業配置"]
  );
});

// ---------------------------------------------------------------------
// 2. Analysis Home は索引であって dashboard ではない
// ---------------------------------------------------------------------

test("P3-4: Analysis Home はチャートを1つも描かない（索引に徹する）", () => {
  const home = fs.readFileSync(path.join(ANALYSIS_DIR, "AnalysisHome.tsx"), "utf8");
  for (const chart of ["SeriesChart", "StackedAreaChart", "OverviewTab", "MarketTab", "BottleneckTab", "AiTraceTab"]) {
    assert.ok(!home.includes(chart), `Analysis Home が ${chart} を描いている（索引ではなく dashboard になっている）`);
  }
});

test("P3-5: Analysis Home のカテゴリは既定で閉じている（defaultOpen を使っていない）", () => {
  const home = fs.readFileSync(path.join(ANALYSIS_DIR, "AnalysisHome.tsx"), "utf8");
  assert.ok(!home.includes("defaultOpen"), "Analysis Home に defaultOpen が指定されている（初期状態で開いてしまう）");
});

test("P3-6: 折りたたみ部品は閉じている間 children をマウントしない", () => {
  const collapsible = fs.readFileSync(path.join(process.cwd(), "app/v2/management/components/Collapsible.tsx"), "utf8");
  assert.ok(collapsible.includes("defaultOpen = false"), "既定が閉じていない");
  assert.ok(/open \? <div/.test(collapsible), "閉じている間も children を描画している（先読みが起きる）");
});

// ---------------------------------------------------------------------
// 3. Simulation Run の分離（別タブが互いを壊さない）
// ---------------------------------------------------------------------

test("P3-7: Analysis 配下は current run（active run）を書き換えない", () => {
  for (const { file, text } of readAll(ANALYSIS_DIR)) {
    assert.ok(
      !text.includes("setActiveSimulationRunId"),
      `${path.basename(file)} が active run を書き換えている（別タブの run が入れ替わってしまう）`
    );
  }
});

test("P3-8: Analysis 配下は simulation engine を import しない（再simulationしない）", () => {
  for (const { file, text } of readAll(ANALYSIS_DIR)) {
    for (const line of text.split("\n").filter((l) => /^\s*import\s/.test(l))) {
      for (const forbidden of ["simulation/engine", "companyLab/runner", "standardAi/policy"]) {
        assert.ok(!line.includes(forbidden), `${path.basename(file)} が ${forbidden} を import している`);
      }
    }
  }
});

test("P3-9: 分析リンクは runId を引き継ぎ、選択状態も query に載る", async () => {
  const { analysisHref } = await import("../../../../../v2/management/analysis/lib/useAnalysisRun");
  assert.equal(analysisHref("/v2/management/analysis/prices", "run-1"), "/v2/management/analysis/prices?run=run-1");
  assert.equal(analysisHref("/v2/management/analysis/prices", "run-1", { market: "JP" }), "/v2/management/analysis/prices?run=run-1&market=JP");
  // run が無い場合でもリンク自体は壊れない。
  assert.equal(analysisHref("/v2/management/analysis/prices", null), "/v2/management/analysis/prices");
});

test("P3-10: 各分析画面は通常のリンク（next/link）でナビゲートし、button だけの遷移にしない", () => {
  const shell = fs.readFileSync(path.join(ANALYSIS_DIR, "components/AnalysisPageShell.tsx"), "utf8");
  assert.ok(shell.includes('from "next/link"'), "共通ナビがリンクを使っていない（新しいタブで開けない）");
  const home = fs.readFileSync(path.join(ANALYSIS_DIR, "AnalysisHome.tsx"), "utf8");
  assert.ok(home.includes('from "next/link"'));
  assert.ok(home.includes('target="_blank"'), "「新しいタブで開く」導線が無い");
});

// ---------------------------------------------------------------------
// 4. 限界利益（独自式を作らない）
// ---------------------------------------------------------------------

test("P3-11: 限界利益は財務モジュールの contributionMargin.byProduct と一致する", () => {
  const session = runTurns(4);
  const dataset = buildDatasetFromSession(session);
  let checked = 0;
  for (const record of session.state.history) {
    for (const fin of record.financialResults ?? []) {
      for (const entry of fin.contributionMargin.byProduct) {
        if (!["hoso", "pd", "vap"].includes(entry.key)) continue;
        const fact = dataset.contribution.find((f) => f.turn === record.turn && f.companyId === fin.companyId && f.product === entry.key);
        assert.ok(fact !== undefined, `${fin.companyId} Q${record.turn} ${entry.key} の限界利益が dataset に無い`);
        assert.equal(fact.contributionMargin, Number(entry.contributionMargin));
        assert.equal(fact.netRevenue, Number(entry.netRevenue));
        assert.equal(fact.variableCost, Number(entry.variableCost));
        checked++;
      }
    }
  }
  assert.ok(checked > 0, "限界利益の検証対象が1件も無い");
});

test("P3-12: 純売上高0の四半期は限界利益率を0で埋めず null にする", () => {
  const session = runTurns(4);
  const dataset = buildDatasetFromSession(session);
  for (const record of session.state.history) {
    for (const fin of record.financialResults ?? []) {
      for (const entry of fin.contributionMargin.byProduct) {
        if (!["hoso", "pd", "vap"].includes(entry.key)) continue;
        const fact = dataset.contribution.find((f) => f.turn === record.turn && f.companyId === fin.companyId && f.product === entry.key);
        if (entry.contributionMarginRatio === undefined) {
          assert.equal(fact?.contributionMarginRatio, null, "比率が定義されない四半期に値を作っている");
        }
      }
    }
  }
});

test("P3-13: 限界利益率の系列は3商品ぶん・全ターンぶん揃う（歯抜けにしない）", () => {
  const session = runTurns(3);
  const dataset = buildDatasetFromSession(session);
  const series = toContributionRatioSeriesByProduct(dataset, dataset.companies[0].companyId);
  assert.equal(series.length, 3);
  for (const s of series) assert.equal(s.points.length, 3);
});

// ---------------------------------------------------------------------
// 5. 固定費（勝手な費用分類をしない）
// ---------------------------------------------------------------------

test("P3-14: 固定費は財務モジュールの正式な区分・値と一致する", () => {
  const session = runTurns(3);
  const dataset = buildDatasetFromSession(session);
  for (const record of session.state.history) {
    for (const fin of record.financialResults ?? []) {
      const report = fin.contributionMargin;
      const get = (component: string) => dataset.fixedCosts.find((f) => f.turn === record.turn && f.companyId === fin.companyId && f.component === component)?.value;
      assert.equal(get("fixedManufacturingCost"), Number(report.fixedManufacturingCost));
      assert.equal(get("fixedPersonnelCost"), Number(report.fixedPersonnelCost));
      assert.equal(get("fixedSellingAdminCost"), Number(report.fixedSellingAdminCost));
      assert.equal(get("totalFixedCost"), Number(report.totalFixedCost));
    }
  }
});

test("P3-15: 固定費の3区分の合計は合計値と一致する（分類を勝手に足し引きしていない）", () => {
  const session = runTurns(3);
  const dataset = buildDatasetFromSession(session);
  for (const company of dataset.companies) {
    for (const turn of dataset.turns) {
      const pick = (c: string) => dataset.fixedCosts.find((f) => f.turn === turn && f.companyId === company.companyId && f.component === c)?.value ?? null;
      const total = pick("totalFixedCost");
      if (total === null) continue;
      const sum = FIXED_COST_COMPONENT_KEYS.reduce((s, k) => s + (pick(k) ?? 0), 0);
      assert.ok(Math.abs(sum - total) < 1e-6, `${company.companyId} Q${turn}: 3区分の合計(${sum})が合計(${total})と一致しない`);
    }
  }
});

test("P3-16: 固定費の系列は5社ぶん取れる", () => {
  const session = runTurns(2);
  const dataset = buildDatasetFromSession(session);
  const series = toFixedCostSeriesByCompany(dataset, "totalFixedCost");
  assert.equal(series.length, dataset.companies.length);
  assert.ok(series.every((s) => s.points.length === 2));
});

// ---------------------------------------------------------------------
// 6. 営業人数・営業配置
// ---------------------------------------------------------------------

test("P3-17: 営業人員は市場ごとに1回だけ数える（同一市場内の商品で重複加算しない）", () => {
  const session = runTurns(2);
  const dataset = buildDatasetFromSession(session);
  const record = session.state.history[0];
  for (const company of dataset.companies) {
    const decision = record.decisions.find((d) => d.companyId === company.companyId);
    if (!decision) continue;
    const byMarket = new Map<string, number>();
    for (const plan of decision.salesPlans) byMarket.set(plan.market, plan.salesForceHeadcount);
    for (const [market, headcount] of byMarket) {
      const fact = dataset.salesAllocation.find((f) => f.turn === 1 && f.companyId === company.companyId && f.market === market);
      assert.equal(fact?.headcount, headcount, `${company.companyId} の ${market} 配置が意思決定と一致しない`);
    }
  }
});

test("P3-18: 市場別配置の合計＋未配置＝当期に配分可能だった総人員数（補正せずに突き合う）", () => {
  const session = runTurns(6);
  const dataset = buildDatasetFromSession(session);
  const rows = reconcileSalesAllocation(dataset);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(row.matches, `${row.companyId} Q${row.turn}: 配置${row.allocated} + 未配置${row.unallocated} ≠ 総人数${row.total}`);
  }
});

test("P3-19: 未配置は engine が許す正常な状態として別項目で表す（負にしない）", () => {
  const session = runTurns(4);
  const dataset = buildDatasetFromSession(session);
  const unallocated = dataset.salesAllocation.filter((f) => f.market === "UNALLOCATED");
  assert.ok(unallocated.length > 0, "未配置の行が作られていない");
  for (const f of unallocated) assert.ok(f.headcount >= 0, "未配置が負になっている");
});

test("P3-20: 営業配置の系列には未配置を含む全区分が入る", () => {
  const session = runTurns(2);
  const dataset = buildDatasetFromSession(session);
  const series = toSalesAllocationSeries(dataset, dataset.companies[0].companyId);
  assert.ok(series.some((s) => s.market === "UNALLOCATED"), "未配置の系列が無い");
  assert.ok(series.length >= 2);
});

test("P3-21: 営業人員数は当期に配分可能だった人数である（採用は次期反映）", () => {
  const session = runTurns(3);
  const dataset = buildDatasetFromSession(session);
  // 記録した値が、各ターンの配置合計を下回らないこと（下回ると配置が総人数を超えることになる）。
  for (const row of reconcileSalesAllocation(dataset)) {
    assert.ok(row.total !== null && row.total >= row.allocated, `${row.companyId} Q${row.turn}: 総人数(${row.total})が配置(${row.allocated})を下回っている`);
  }
});

// ---------------------------------------------------------------------
// 7. 途中停止した実行
// ---------------------------------------------------------------------

test("P3-22: 途中でSTOPした実行は、足りないターンをゼロや架空値で埋めない", () => {
  let session = createSimulationSession({ simulationRunId: "stop-nav", scenarioId: "baseline", seed: "phase3-test", requestedTurns: 32, startedAt: AT });
  let count = 0;
  session = advanceSimulationTurns({ session, turns: 32, timestamp: AT, shouldStop: () => ++count > 5 });
  assert.equal(session.run.stopReason, "stopped_by_user");

  const dataset = buildDatasetFromSession(session);
  assert.deepEqual([...dataset.turns], [1, 2, 3, 4, 5]);
  // 新設の事実表も5ターンぶんしか持たない。
  for (const facts of [dataset.contribution, dataset.fixedCosts, dataset.salesAllocation]) {
    assert.ok(facts.length > 0);
    assert.ok(facts.every((f) => f.turn <= 5), "STOP 後のターンに行が作られている");
  }
  // 系列の長さも完了ターン数に一致する（32へ引き伸ばさない）。
  assert.equal(toSalesAllocationSeries(dataset, dataset.companies[0].companyId)[0].points.length, 5);
});
