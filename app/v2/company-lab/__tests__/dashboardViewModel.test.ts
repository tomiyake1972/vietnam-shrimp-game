// ShrimpX V2 — 品質・信頼・納期ダッシュボード（Phase 7B） 表示用データ層テスト
//
// 対応する重要テスト項目（実装指示より）:
//   1. 表示用データがPhase 7Aの保存結果と一致し、再計算していない
//   2. HOSO/PD/VAPの商品別表示が正しい
//   3. 市場別の顧客信頼・納期信頼性が正しい
//   4. 格落ち・再加工・廃棄が別項目として表示される
//   5. 重大品質事故あり／なしの表示が正しい
//   6. 生産ゼロ時に誤った事故警告を出さない
//   11. 5社比較で会社と数値の対応がずれない
//   12. 8ターン／32ターンの履歴件数と表示対象が正しい
//   13. 同一シード・同一条件で表示結果が再現する
//   14. NaN、Infinity、未定義を画面に表示しない（undefinedは許容、NaN/Infinityは禁止）

import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../../lib/v2/core/units";
import { DEMAND_MARKET_IDS } from "../../../lib/v2/market/types";
import { generateAutoPolicyDecision } from "../../../lib/v2/companyLab/autoPolicy";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../../../lib/v2/companyLab/runner";
import { CompanyLabConfig } from "../../../lib/v2/companyLab/types";
import {
  buildCompanyComparisonRows,
  buildCompetitivenessExplanationRows,
  buildMarketTrustRows,
  buildProductQualityRows,
  buildSummaryCardViewModel,
  buildTrendGroups,
  findCompanySummary,
  PRODUCTS,
} from "../dashboardViewModel";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed: "dash-view-test-1", turns: 12, ...overrides };
}

function runAllAuto(config: CompanyLabConfig) {
  return runCompanyLabWithAutoPolicyForAllCompanies(config, generateAutoPolicyDecision);
}

function assertFiniteOrUndefined(value: unknown, label: string): void {
  if (value === undefined) return;
  assert.ok(typeof value === "number" && Number.isFinite(value), `${label} はundefinedか有限数である必要があります。受け取った値: ${value}`);
}

// --- 1・4: 表示用データはPhase 7Aの保存結果と一致し、再計算していない。格落ち/再加工/廃棄は別項目。 ---

test("受入確認V-1: buildProductQualityRowsのqualityScore/operationalRiskはCompanyQuarterSummaryの値とビット単位で一致する（再計算していない）", () => {
  const result = runAllAuto(baseConfig());
  const record = result.history[result.history.length - 1];
  for (const s of record.companySummaries) {
    const rows = buildProductQualityRows(record, s.companyId);
    for (const row of rows) {
      const expectedQuality = s.qualityScoreByProduct[row.product];
      if (expectedQuality === undefined) {
        assert.equal(row.qualityScore, undefined);
      } else {
        assert.equal(row.qualityScore, unwrapUnit(expectedQuality));
      }
      assert.equal(row.operationalRisk, s.operationalRiskByProduct[row.product]);
    }
  }
});

test("受入確認V-2: buildMarketTrustRowsのcustomerTrustScore/deliveryReliabilityScoreはCompanyQuarterSummaryの値とビット単位で一致する", () => {
  const result = runAllAuto(baseConfig());
  const record = result.history[result.history.length - 1];
  for (const s of record.companySummaries) {
    const rows = buildMarketTrustRows(record, s.companyId, DEMAND_MARKET_IDS);
    for (const row of rows) {
      const expectedTrust = s.customerTrustByMarket[row.market];
      const expectedReliability = s.deliveryReliabilityByMarket[row.market];
      assert.equal(row.customerTrustScore, expectedTrust !== undefined ? unwrapUnit(expectedTrust) : undefined);
      assert.equal(row.deliveryReliabilityScore, expectedReliability !== undefined ? unwrapUnit(expectedReliability) : undefined);
    }
  }
});

test("受入確認V-3: buildCompetitivenessExplanationRowsのcompetitivenessWeight/allocatedQuantityはsalesRecord.allocationsの値とビット単位で一致する", () => {
  const result = runAllAuto(baseConfig());
  const record = result.history[result.history.length - 1];
  for (const s of record.companySummaries) {
    const rows = buildCompetitivenessExplanationRows(record, s.companyId);
    for (const row of rows) {
      const allocation = record.salesRecord.allocations.find((a) => a.market === row.market && a.product === row.product);
      const entry = allocation?.companies.find((c) => c.companyId === s.companyId);
      assert.ok(entry, "対応するCompanyAllocationEntryが見つかる");
      assert.equal(row.competitivenessWeight, entry!.competitivenessWeight);
      assert.equal(row.allocatedQuantity, unwrapUnit(entry!.allocatedQuantity));
      // 内訳5項目の合計は必ずcompetitivenessWeightと一致する（sales/allocation.tsの保証）。
      const sum = row.priceContribution + row.coverageContribution + row.relationshipContribution + row.qualityContribution + row.deliveryReliabilityContribution;
      assert.equal(sum, row.competitivenessWeight);
    }
  }
});

test("受入確認V-4: 格落ち・再加工・廃棄は別項目であり、原始生産量 = 販売可能生産量 + 廃棄量（格落ち/再加工は数量を減らさない）", () => {
  const result = runAllAuto(baseConfig());
  for (const record of result.history) {
    for (const s of record.companySummaries) {
      const rows = buildProductQualityRows(record, s.companyId);
      for (const row of rows) {
        if (!row.hasProduction) continue;
        const reconciled = row.saleableProductionQuantity + row.discardQuantity;
        assert.ok(Math.abs(reconciled - row.originalProductionQuantity) < 0.5, `${s.companyId}/${row.product}: original(${row.originalProductionQuantity}) != saleable(${row.saleableProductionQuantity})+discard(${row.discardQuantity})`);
        // 格落ち・再加工は独立した記録用フィールドであり、原始/販売可能生産量の計算には登場しない。
        assert.ok(row.downgradeQuantity >= 0);
        assert.ok(row.reworkQuantity >= 0);
      }
    }
  }
});

// --- 2: HOSO/PD/VAPの商品別表示 ---

test("受入確認V-5: buildProductQualityRowsは常にHOSO/PD/VAPの3行を、この順序で返す", () => {
  const result = runAllAuto(baseConfig());
  const record = result.history[0];
  const rows = buildProductQualityRows(record, record.companySummaries[0].companyId);
  assert.deepEqual(rows.map((r) => r.product), [...PRODUCTS]);
  assert.deepEqual([...PRODUCTS], ["hoso", "pd", "vap"]);
});

// --- 5: 重大品質事故あり／なしの表示が正しい ---

test("受入確認V-6: 重大品質事故が発生した会社×商品では、hasMajorIncident=trueかつmajorIncidentCount>=1になる（seed dash-view-test-1, turn5, BAL/pdで実際に発生することを事前確認済み）", () => {
  const result = runAllAuto(baseConfig({ turns: 5 }));
  const record = result.history[result.history.length - 1];
  assert.equal(record.turn, 5);
  const rows = buildProductQualityRows(record, "BAL");
  const pdRow = rows.find((r) => r.product === "pd")!;
  assert.equal(pdRow.hasMajorIncident, true);
  assert.ok(pdRow.majorIncidentCount >= 1);

  // 事故が起きていない他社×商品ではhasMajorIncident=falseになる（誤検出しない）。
  const otherRows = buildProductQualityRows(record, "CONSV");
  for (const r of otherRows) {
    if (!r.hasProduction) continue;
    // CONSVはこのターン事故が起きていないことをqualityAdjustmentsから直接確認する。
    const anyIncident = record.qualityAdjustments.some((a) => a.companyId === "CONSV" && a.product === r.product && a.outcome.majorIncident.occurred);
    assert.equal(r.hasMajorIncident, anyIncident);
  }
});

// --- 6: 生産ゼロ時に誤った事故警告を出さない ---

/**
 * 【2026-08-08・Test16】旧版は「turn1でMASSのvap/pd生産が0であること」を前提にしていた。
 * これはMASSの旧初期capacity（VAP 2,000 / PD 6,000）にたまたま依存した条件であり、
 * Test16の能力再設計で成立しなくなった。
 *
 * このテストが本当に守りたいのは
 *   「生産量が0の商品では、誤って品質事故を検出しない
 *     （hasProduction=false / hasMajorIncident=false / saleableRecoveryRatio=undefined）」
 * であって、どの会社のどの商品が0になるかではない。
 *
 * そこで特定の会社・商品を固定するのをやめ、**その四半期に実際に生産量が0だった
 * 全ての会社×商品**について不変条件を検証する形へ変更した。
 * Standard AIやcapacityを歪めて無理に0を作ることはしない（指示2）。
 */
test("受入確認V-7: 生産量が0の商品では誤った品質事故検出をしない（hasProduction=false・事故0・回収率undefined）", () => {
  const result = runAllAuto(baseConfig({ turns: 1 }));
  const record = result.history[0];

  let zeroProductionRowCount = 0;
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const) {
    const summary = findCompanySummary(record, companyId);
    if (!summary) continue;
    const producedByProduct = {
      hoso: unwrapUnit(summary.hosoProduced),
      pd: unwrapUnit(summary.pdProduced),
      vap: unwrapUnit(summary.vapProduced),
    } as const;
    const rows = buildProductQualityRows(record, companyId);
    for (const row of rows) {
      if (producedByProduct[row.product] !== 0) continue;
      zeroProductionRowCount += 1;
      assert.equal(row.hasProduction, false, `${companyId}/${row.product}: 生産0ならhasProduction=false`);
      assert.equal(row.hasMajorIncident, false, `${companyId}/${row.product}: 生産0なら事故なし`);
      assert.equal(row.majorIncidentCount, 0, `${companyId}/${row.product}: 生産0なら事故件数0`);
      assert.equal(row.saleableRecoveryRatio, undefined, `${companyId}/${row.product}: 生産0なら回収率はundefined`);
      assert.equal(row.originalProductionQuantity, 0, `${companyId}/${row.product}: 生産0なら元数量0`);
      assert.equal(row.discardQuantity, 0, `${companyId}/${row.product}: 生産0なら廃棄0`);
    }
  }

  // 検証対象が1件も無いと、このテストは何も確かめないまま通ってしまう。
  // turn1で生産0の商品が存在しなくなった場合は、能力設計が変わった合図なので気づけるようにする。
  assert.ok(
    zeroProductionRowCount > 0,
    "turn1に生産量0の会社×商品が1件も無い。このテストが検証対象を失っている（能力設計の変更を確認すること）"
  );
});

// --- 11: 5社比較で会社と数値の対応がずれない ---

test("受入確認V-8: buildCompanyComparisonRowsは5社それぞれの行を持ち、companyIdごとの値がCompanyQuarterSummaryと対応する（ずれない）", () => {
  const result = runAllAuto(baseConfig());
  const record = result.history[result.history.length - 1];
  const rows = buildCompanyComparisonRows(record, result.companies, "all", "all");
  assert.equal(rows.length, 5);
  for (const row of rows) {
    const summary = findCompanySummary(record, row.companyId)!;
    assert.equal(row.newContractedQuantity, unwrapUnit(summary.newContractedQuantity));
    assert.equal(row.onTimeDeliveryRate, summary.onTimeDeliveryRate);
  }
  // 会社IDの重複・欠落がないこと。
  const ids = new Set(rows.map((r) => r.companyId));
  assert.equal(ids.size, 5);
});

test("受入確認V-9: 商品フィルタ・市場フィルタを切り替えても、行数・会社の対応関係は変わらない", () => {
  const result = runAllAuto(baseConfig());
  const record = result.history[result.history.length - 1];
  const allRows = buildCompanyComparisonRows(record, result.companies, "all", "all");
  const hosoRows = buildCompanyComparisonRows(record, result.companies, "hoso", "US");
  assert.equal(allRows.length, hosoRows.length);
  assert.deepEqual(
    allRows.map((r) => r.companyId),
    hosoRows.map((r) => r.companyId)
  );
});

// --- 12: 8ターン／32ターンの履歴件数と表示対象が正しい ---

test("受入確認V-10: buildTrendGroupsは指定したturnsWindow分（実行済みターン数が下回る場合はその件数）だけの点を返す", () => {
  const result8 = runAllAuto(baseConfig({ turns: 8 }));
  const groups8 = buildTrendGroups(result8.history, "BAL", 8, DEMAND_MARKET_IDS);
  for (const g of groups8) {
    for (const s of g.series) {
      assert.equal(s.points.length, 8);
    }
  }

  // 実行済みターン数(8)がturnsWindow(32)を下回る場合は、実行済み分だけを返す（欠損分を捏造しない）。
  const groups32ButOnly8Run = buildTrendGroups(result8.history, "BAL", 32, DEMAND_MARKET_IDS);
  for (const g of groups32ButOnly8Run) {
    for (const s of g.series) {
      assert.equal(s.points.length, 8);
    }
  }
});

test("受入確認V-11: 32ターン実行時、buildTrendGroups(...,8,...)は直近8ターンだけを返す", () => {
  const result32 = runAllAuto(baseConfig({ turns: 32 }));
  assert.equal(result32.history.length, 32);
  const groups8 = buildTrendGroups(result32.history, "BAL", 8, DEMAND_MARKET_IDS);
  for (const g of groups8) {
    for (const s of g.series) {
      assert.equal(s.points.length, 8);
      assert.deepEqual(
        s.points.map((p) => p.turn),
        [25, 26, 27, 28, 29, 30, 31, 32]
      );
    }
  }
});

// --- 13: 同一シード・同一条件で表示結果が再現する ---

test("受入確認V-12: 同一シード・同一条件では、summaryCard/productRows/marketRows/comparisonRows/trendGroupsがすべて完全に再現する", () => {
  const resultA = runAllAuto(baseConfig());
  const resultB = runAllAuto(baseConfig());
  const recordA = resultA.history[resultA.history.length - 1];
  const recordB = resultB.history[resultB.history.length - 1];

  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    assert.deepEqual(buildSummaryCardViewModel(recordA, companyId), buildSummaryCardViewModel(recordB, companyId));
    assert.deepEqual(buildProductQualityRows(recordA, companyId), buildProductQualityRows(recordB, companyId));
    assert.deepEqual(buildMarketTrustRows(recordA, companyId, DEMAND_MARKET_IDS), buildMarketTrustRows(recordB, companyId, DEMAND_MARKET_IDS));
  }
  assert.deepEqual(buildCompanyComparisonRows(recordA, resultA.companies, "all", "all"), buildCompanyComparisonRows(recordB, resultB.companies, "all", "all"));
  assert.deepEqual(buildTrendGroups(resultA.history, "BAL", 8, DEMAND_MARKET_IDS), buildTrendGroups(resultB.history, "BAL", 8, DEMAND_MARKET_IDS));
});

// --- 14: NaN、Infinity、未定義を画面に表示しない ---

test("受入確認V-13: 32ターン×5社の全表示用データにNaN/Infinityが一切含まれない（undefinedは許容）", () => {
  const result = runAllAuto(baseConfig({ turns: 32 }));
  for (const record of result.history) {
    for (const s of record.companySummaries) {
      const summary = buildSummaryCardViewModel(record, s.companyId)!;
      assertFiniteOrUndefined(summary.totalProductionQuantity, "totalProductionQuantity");
      assertFiniteOrUndefined(summary.saleableFinishedGoodsQuantity, "saleableFinishedGoodsQuantity");
      assertFiniteOrUndefined(summary.onTimeDeliveryRate, "onTimeDeliveryRate");

      for (const row of buildProductQualityRows(record, s.companyId)) {
        assertFiniteOrUndefined(row.qualityScore, "qualityScore");
        assertFiniteOrUndefined(row.operationalRisk, "operationalRisk");
        assertFiniteOrUndefined(row.saleableRecoveryRatio, "saleableRecoveryRatio");
        assertFiniteOrUndefined(row.originalProductionQuantity, "originalProductionQuantity");
        assertFiniteOrUndefined(row.saleableProductionQuantity, "saleableProductionQuantity");
      }

      for (const row of buildMarketTrustRows(record, s.companyId, DEMAND_MARKET_IDS)) {
        assertFiniteOrUndefined(row.customerTrustScore, "customerTrustScore");
        assertFiniteOrUndefined(row.deliveryReliabilityScore, "deliveryReliabilityScore");
        assertFiniteOrUndefined(row.onTimeDeliveryRateThisPeriod, "onTimeDeliveryRateThisPeriod");
      }

      for (const row of buildCompetitivenessExplanationRows(record, s.companyId)) {
        assertFiniteOrUndefined(row.competitivenessWeight, "competitivenessWeight");
        assertFiniteOrUndefined(row.allocatedQuantity, "allocatedQuantity");
        assertFiniteOrUndefined(row.priceDeviationRatio, "priceDeviationRatio");
      }
    }

    for (const row of buildCompanyComparisonRows(record, result.companies, "all", "all")) {
      assertFiniteOrUndefined(row.qualityScore, "comparison.qualityScore");
      assertFiniteOrUndefined(row.operationalRisk, "comparison.operationalRisk");
      assertFiniteOrUndefined(row.onTimeDeliveryRate, "comparison.onTimeDeliveryRate");
      assertFiniteOrUndefined(row.customerTrustScore, "comparison.customerTrustScore");
      assertFiniteOrUndefined(row.deliveryReliabilityScore, "comparison.deliveryReliabilityScore");
    }
  }

  for (const g of buildTrendGroups(result.history, "BAL", 32, DEMAND_MARKET_IDS)) {
    for (const series of g.series) {
      for (const p of series.points) {
        assertFiniteOrUndefined(p.value, `trend.${series.key}`);
      }
    }
  }
});
