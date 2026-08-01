// ShrimpX V2 — Phase SAI-3A: 判断記録の組み立て（buildAutoplayCaseLogs等）のテスト
//
// 三宅さんの指示§10（テスト要件）のうち、ログ組み立てそのものに関わる項目を
// カバーする:
//  - 5社×8Qぶんのログ件数が正しいこと
//  - 事前希望案（wish）と最終意思決定（final）がログ上で区別できること
//  - 調整ログのbefore/after/deltaが内部整合的であること
//  - 営業工数制約による数量変化がトレースできること
//  - 最終意思決定ログがrunnerへ実際に渡された値と一致すること
//  - 四半期結果ログが実際の財務・販売・在庫結果と一致すること
//  - paymentDefault発生後もログが欠落しないこと

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutoplayCase } from "../runCase";
import { buildAutoplayCaseLogs } from "../buildLog";
import { ALL_COMPANY_IDS } from "../../report/decomposeHarness";
import { STANDARD_BASELINE_CANDIDATES, SELECTED_STANDARD_BASELINE_CANDIDATE_ID } from "../../report/standardBaseline";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
const EPSILON = 1e-6;

function run(seed: string, quarters: number, companyIds: readonly string[] = ALL_COMPANY_IDS) {
  const caseResult = runAutoplayCase({ scenarioId: "baseline", seed, quarters, companyIds, candidate });
  return { caseResult, log: buildAutoplayCaseLogs(caseResult) };
}

test("buildAutoplayCaseLogs: 5社×8Qぶんのログ件数が正しい（quarterStartStates/decisionLogs/quarterResultsが40件、caseSummaryRowsが5件）", () => {
  const { log } = run("sai3a-test-counts-001", 8);
  assert.equal(log.quarterStartStates.length, 40);
  assert.equal(log.decisionLogs.length, 40);
  assert.equal(log.quarterResults.length, 40);
  assert.equal(log.caseSummaryRows.length, 5);
});

test("buildAutoplayCaseLogs: 事前希望案（salesQuantityTraceのdesiredQuantityBeforeEffortConstraint）と最終計画数量（finalPlannedQuantity）は区別され、営業工数制約が効いた市場では希望>最終になる", () => {
  const { log } = run("sai3a-test-counts-001", 8);
  assert.ok(log.salesQuantityTrace.length > 0, "salesQuantityTraceが空");
  const constrained = log.salesQuantityTrace.filter((t) => t.desiredQuantityBeforeEffortConstraint > t.finalPlannedQuantity + EPSILON);
  assert.ok(constrained.length > 0, "営業工数制約により希望>最終となったエントリが1件も見つからない（標準候補は営業人員不足を想定しているはず）");
  for (const t of log.salesQuantityTrace) {
    assert.ok(t.finalPlannedQuantity <= t.desiredQuantityBeforeEffortConstraint + EPSILON, `最終計画数量が希望数量を上回っている: ${JSON.stringify(t)}`);
  }
});

test("buildAutoplayCaseLogs: adjustmentTraceのbefore/after/deltaは、いずれも定義されている場合delta===after-before（内部整合的）", () => {
  const { log } = run("sai3a-test-counts-001", 8);
  const withAllThree = log.adjustmentTrace.filter((e) => e.before !== undefined && e.after !== undefined && e.delta !== undefined);
  assert.ok(withAllThree.length > 0, "before/after/deltaがすべて揃ったエントリが1件も無い");
  for (const e of withAllThree) {
    assert.ok(Math.abs(e.delta! - (e.after! - e.before!)) < 1e-4, `delta不整合: ${JSON.stringify(e)}`);
  }
});

test("buildAutoplayCaseLogs: 営業工数制約（category=sales_effort_capacity）の調整エントリが記録され、before/afterが揃っている場合はafter<=beforeが成り立つ", () => {
  // 【注記】エンジン側の実測調整（record.salesRecord.salesEffortAdjustments由来、
  // code=SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY）は、標準AI自身が事前に
  // desiredByMarketProduct段階で営業工数制約を織り込んで縮小提出するため、
  // 5社同時実行では「エンジン側が実測でさらに縮小する」場面が発生しない
  // シードが多い（=標準AIの自己調整だけで足りている）。そのため、ここでは
  // 複数seedを試し、「category=sales_effort_capacityの調整が最低1件は記録される
  // こと」と「before/afterが揃っているエントリはafter<=beforeであること」を
  // 確認する（標準AI側の診断エントリ=SALES_REDUCED_FOR_SUPPLY_LIMIT等は、
  // 市場ごとのbefore/after数量を構造化して持たないため、before/after自体が
  // undefinedのままなのは想定どおりであり、市場別のwish→final数量は
  // salesQuantityTrace側で別途正確にトレースできる：前のテストで確認済み）。
  const seeds = ["sai3a-test-counts-001", "sai3a-002", "sai3a-test-effort-2", "sai3a-test-effort-3", "sai3a-test-effort-4"];
  let found = false;
  for (const seed of seeds) {
    const { log } = run(seed, 8);
    const effortEntries = log.adjustmentTrace.filter((e) => e.category === "sales_effort_capacity");
    if (effortEntries.length === 0) continue;
    found = true;
    for (const e of effortEntries) {
      if (e.before !== undefined && e.after !== undefined) {
        assert.ok(e.after! <= e.before! + EPSILON, `営業工数制約の調整でafter>beforeは想定外: ${JSON.stringify(e)}`);
      }
    }
  }
  assert.ok(found, "営業工数制約カテゴリの調整エントリが、試したどのseedでも1件も見つからなかった");
});

test("buildAutoplayCaseLogs: 最終意思決定ログ（final）は、procurementConstraintが無ければwishと一致し、有ればprocurementConstraintの値と一致する", () => {
  const { caseResult, log } = run("sai3a-test-counts-001", 8);
  for (const decision of log.decisionLogs) {
    const record = caseResult.history.find((h) => h.turn === decision.turn)!;
    const financing = record.financingResults.find((f) => f.companyId === decision.companyId);
    const constraint = financing?.procurementConstraint;
    if (!constraint) {
      assert.equal(decision.final.domesticPurchaseFinalQuantity, decision.wish.domesticPurchaseDesiredQuantity);
      assert.equal(decision.final.importOrdersFinalQuantity, decision.wish.importOrdersDesiredQuantity);
      assert.equal(decision.final.importOrdersBlocked, false);
    } else {
      assert.equal(decision.final.domesticPurchaseFinalQuantity, constraint.constrainedDomesticPurchaseQuantityTons);
      assert.equal(decision.final.importOrdersBlocked, constraint.importOrdersBlocked);
      const expectedImport = constraint.importOrdersBlocked ? 0 : decision.wish.importOrdersDesiredQuantity;
      assert.equal(decision.final.importOrdersFinalQuantity, expectedImport);
    }
  }
});

test("buildAutoplayCaseLogs: 四半期結果ログ（QuarterResultLog）は、実際のfinancialResults/financingResults/companySummariesの値と一致する", () => {
  const { caseResult, log } = run("sai3a-test-counts-001", 8);
  for (const r of log.quarterResults) {
    const record = caseResult.history.find((h) => h.turn === r.turn)!;
    const fin = record.financialResults.find((f) => f.companyId === r.companyId)!;
    const financing = record.financingResults.find((f) => f.companyId === r.companyId)!;
    const summary = record.companySummaries.find((s) => s.companyId === r.companyId)!;
    assert.equal(r.netRevenueUsd, fin.profitAndLoss.netRevenue as unknown as number);
    assert.equal(r.closingCashUsd, fin.balanceSheet.cash as unknown as number);
    assert.equal(r.paymentDefault, financing.financialHealth.paymentDefault);
    assert.equal(r.underwritingFrozen, financing.borrowingCapacity.underwritingFrozen);
    assert.equal(r.discardQuantityHosoEqTons, summary.discardQuantity as unknown as number);
  }
});

test("buildAutoplayCaseLogs: marketAllocationTrace（SAI-3B-2で追加）は会社をまたいで重複せず、turn×市場×商品ごとに5社ぶんのエントリを持つ", () => {
  const { caseResult, log } = run("sai3a-test-counts-001", 8);
  assert.ok(log.marketAllocationTrace.length > 0, "marketAllocationTraceが空");

  // 会社横断データが会社の外側ループで5倍に重複していないことを確認する:
  // 同一turnの市場×商品の組み合わせ数 × 5社 と、実際のエントリ件数が一致するはず。
  const turn1Entries = log.marketAllocationTrace.filter((e) => e.turn === 1);
  const marketProductPairs = new Set(turn1Entries.map((e) => `${e.market}::${e.product}`));
  const record1 = caseResult.history.find((h) => h.turn === 1)!;
  assert.equal(marketProductPairs.size, record1.salesRecord.allocations.length, "turn=1の市場×商品の組み合わせ数がrecord.salesRecord.allocationsと一致しない");
  for (const alloc of record1.salesRecord.allocations) {
    const matching = turn1Entries.filter((e) => e.market === alloc.market && e.product === alloc.product);
    assert.equal(matching.length, alloc.companies.length, `市場"${alloc.market}"×商品"${alloc.product}"のエントリ数が会社数と一致しない`);
  }

  // 自社のallocatedQuantity/askPrice/coverageScore/competitivenessWeightが
  // 元のrecord.salesRecord.allocationsの値と一致すること。
  for (const alloc of record1.salesRecord.allocations) {
    for (const c of alloc.companies) {
      const entry = turn1Entries.find((e) => e.market === alloc.market && e.product === alloc.product && e.companyId === c.companyId);
      assert.ok(entry, `対応するmarketAllocationTraceエントリが見つからない: ${alloc.market}/${alloc.product}/${c.companyId}`);
      assert.equal(entry!.allocatedQuantityHosoEqTons, c.allocatedQuantity as unknown as number);
      assert.equal(entry!.coverageScore, c.coverageScore);
      assert.equal(entry!.competitivenessWeight, c.competitivenessWeight);
    }
  }
});

test("buildAutoplayCaseLogs: 四半期結果ログのsalesQuantityByProductは、productionQuantityByProductとは異なるデータ源（市場配分の実際の獲得数量）から計算される", () => {
  const { caseResult, log } = run("sai3a-test-counts-001", 8);
  for (const r of log.quarterResults) {
    const record = caseResult.history.find((h) => h.turn === r.turn)!;
    // salesQuantityByProductの商品別合計は、その会社が当turnに市場配分で
    // 実際に得た数量の合計（=marketAllocationTraceの同一companyId分のallocatedQuantity合計）と一致するはず。
    const expectedByProduct: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
    for (const alloc of record.salesRecord.allocations) {
      const mine = alloc.companies.find((c) => c.companyId === r.companyId);
      if (!mine) continue;
      expectedByProduct[alloc.product] += mine.allocatedQuantity as unknown as number;
    }
    for (const product of ["hoso", "pd", "vap"]) {
      assert.ok(
        Math.abs((r.salesQuantityByProduct[product] ?? 0) - expectedByProduct[product]) < EPSILON,
        `salesQuantityByProduct.${product}が市場配分の実際の獲得数量と一致しない（turn=${r.turn}, companyId=${r.companyId}）`
      );
    }
  }
});

test("buildAutoplayCaseLogs: paymentDefaultが発生した後の四半期でも、ログが欠落しない（8Qぶん全turnのログが揃う）", () => {
  // "baseline"シナリオの標準候補は、moderate pressure設計によりデフォルトが
  // 発生しうることが既存テスト（standardBaseline.test.ts）で確認済み。
  // 実際にdefaultが発生したケースをいくつか試し、発生後もログ件数が
  // 欠けないことを確認する（発生しなかった場合はそのシードでは検証できないため
  // skipし、少なくとも1件は発生確認できるシードで検証する）。
  // 【Test15追記】商品別労働集約度係数（HOSO:PD:VAP=1.0:1.2:3.0）の導入により
  // 会社の財務トラジェクトリが変化し、従来のseedリスト（sai3a-002等）では
  // 8四半期以内にpaymentDefaultへ至らなくなった。同じ検証意図（defaultが
  // 発生した後もログが欠落しないこと）を保つため、新しい経済パラメータの下で
  // BAL単独・8四半期・baselineシナリオでpaymentDefaultが確認できるseedを
  // 総当たりで探し直した（test15-bal-scan-181, test15-bal-scan-754）。
  const seeds = [
    "sai3a-002",
    ...Array.from({ length: 8 }, (_, i) => `sai3a-test-default-${i}`),
    "test15-bal-scan-181",
    "test15-bal-scan-754",
  ];
  let verifiedAtLeastOne = false;
  for (const seed of seeds) {
    const { log } = run(seed, 8, ["BAL"]);
    const defaultedTurn = log.quarterResults.find((r) => r.paymentDefault)?.turn;
    if (defaultedTurn === undefined) continue;
    verifiedAtLeastOne = true;
    assert.equal(log.quarterResults.length, 8, `paymentDefault発生後もログが8Qぶん揃っているべき（seed=${seed}）`);
    assert.equal(log.quarterStartStates.length, 8);
    assert.equal(log.decisionLogs.length, 8);
  }
  assert.ok(verifiedAtLeastOne, "検証対象のseedでpaymentDefaultが1件も発生しなかった（standardBaselineの想定と異なる可能性）");
});
