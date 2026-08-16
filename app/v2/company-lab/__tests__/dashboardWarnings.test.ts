// ShrimpX V2 — 品質・信頼・納期ダッシュボード（Phase 7B） 警告判定テスト
//
// 対応する重要テスト項目（実装指示より）:
//   6. 生産ゼロ時に誤った事故警告を出さない
//   7. 急増産または高リスク時に警告が表示される
//   8. 正常操業時に過剰な警告を出さない
//
// buildWarningsが実際に読み取るのはrecord.companySummariesとrecord.qualityAdjustments
// だけ（dashboardWarnings.ts参照）なので、テスト用の最小限のCompanyQuarterRecord
// フィクスチャ（この2フィールドのみ実データ）を組み立てる。CompanyQuarterRecordの
// 他フィールド（marketResult等）はbuildWarningsが一切読まないため、テストの
// 焦点を明確にするためあえて省略する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, score0to100 } from "../../../lib/v2/core/units";
import { period } from "../../../lib/v2/core/period";
import { CompanyQuarterRecord, CompanyQuarterSummary } from "../../../lib/v2/companyLab/types";
import { BatchQualityAdjustment, OperationalRiskFactors, QualityOutcome } from "../../../lib/v2/quality/types";
import { generateAutoPolicyDecision } from "../../../lib/v2/companyLab/autoPolicy";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../../../lib/v2/companyLab/runner";
import { buildWarnings, topWarning, WARNING_THRESHOLDS } from "../dashboardWarnings";

const P1 = period(2015, 1);
const COMPANY_ID = "BAL";

function makeSummary(overrides: Partial<CompanyQuarterSummary> = {}): CompanyQuarterSummary {
  return {
    companyId: COMPANY_ID,
    period: P1,
    newContractedQuantity: hosoEqTons(0),
    newContractedAveragePrice: 0,
    fulfilledQuantity: hosoEqTons(0),
    outstandingQuantity: hosoEqTons(0),
    overdueQuantity: hosoEqTons(0),
    domesticPurchaseQuantity: hosoEqTons(0),
    domesticPurchasePrice: 0,
    importInTransitQuantity: hosoEqTons(0),
    importArrivedQuantity: hosoEqTons(0),
    aquacultureGrowingQuantity: hosoEqTons(0),
    aquacultureHarvestedQuantity: hosoEqTons(0),
    rawMaterialInventory: hosoEqTons(0),
    hosoProduced: hosoEqTons(0),
    pdProduced: hosoEqTons(0),
    vapProduced: hosoEqTons(0),
    finishedGoodsInventory: hosoEqTons(0),
    rawMaterialShortfall: hosoEqTons(0),
    equipmentShortfall: hosoEqTons(0),
    laborShortfall: hosoEqTons(0),
    equipmentUtilizationRate: ratio(0.5),
    laborUtilizationRate: ratio(0.5),
    overtimeRate: ratio(0),
    temporaryWorkerShare: ratio(0),
    qualityScoreByProduct: {},
    operationalRiskByProduct: {},
    downgradeQuantity: hosoEqTons(0),
    reworkQuantity: hosoEqTons(0),
    discardQuantity: hosoEqTons(0),
    majorIncidentCount: 0,
    customerTrustByMarket: { US: score0to100(60), JP: score0to100(60) },
    deliveryReliabilityByMarket: { US: score0to100(60), JP: score0to100(60) },
    rampWarnings: [],
    reasonCodes: [],
    ...overrides,
  };
}

function makeRisk(overrides: Partial<OperationalRiskFactors> = {}): OperationalRiskFactors {
  return {
    utilizationStress: 0.2,
    overtimeStress: 0,
    temporaryWorkerStress: 0,
    complexityStress: 0.1,
    rawMaterialAgeStress: 0.1,
    productionRampStress: 0,
    operationalRisk: 0.1,
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<QualityOutcome> = {}): QualityOutcome {
  return {
    nonConformanceRatio: 0.02,
    downgradeRatio: 0.01,
    reworkRatio: 0.005,
    discardRatio: 0.005,
    saleableRecoveryRatio: ratio(0.995),
    observedQualityScore: score0to100(70),
    majorIncident: { occurred: false, severity: 0, probability: 0.002, seed: "test-seed" },
    ...overrides,
  };
}

function makeAdjustment(overrides: Partial<BatchQualityAdjustment> = {}): BatchQualityAdjustment {
  return {
    batchId: "batch-1",
    companyId: COMPANY_ID,
    factoryId: "BAL-F1",
    product: "hoso",
    period: P1,
    risk: makeRisk(),
    qualityEquipmentRiskMultiplier: 1,
    effectiveOperationalRisk: 0.1,
    outcome: makeOutcome(),
    originalFinishedGoodsQuantity: hosoEqTons(1000),
    adjustedFinishedGoodsQuantity: hosoEqTons(995),
    downgradeQuantity: hosoEqTons(10),
    reworkQuantity: hosoEqTons(5),
    discardQuantity: hosoEqTons(5),
    ...overrides,
  };
}

function makeRecord(summary: CompanyQuarterSummary, adjustments: readonly BatchQualityAdjustment[]): CompanyQuarterRecord {
  return {
    companySummaries: [summary],
    qualityAdjustments: adjustments,
  } as unknown as CompanyQuarterRecord;
}

// --- 8: 正常操業時に過剰な警告を出さない ---

test("受入確認W-1: 正常操業（稼働率50%・残業なし・臨時ワーカーなし・低リスク・廃棄比率0.5%・信頼スコア60点）では警告が一切出ない", () => {
  const summary = makeSummary();
  const adjustment = makeAdjustment();
  const record = makeRecord(summary, [adjustment]);
  const warnings = buildWarnings(record, COMPANY_ID);
  assert.deepEqual(warnings, []);
  assert.equal(topWarning(warnings), undefined);
});

// --- 6: 生産ゼロ時に誤った事故警告を出さない ---

test("受入確認W-2: 生産量0(qualityAdjustmentsが空)の場合、廃棄比率はNaNにならず警告自体を出さない（誤検出なし）", () => {
  const summary = makeSummary({ majorIncidentCount: 0, discardQuantity: hosoEqTons(0) });
  const record = makeRecord(summary, []); // 生産量0のバッチはbatchAdjustment.tsの構造上adjustmentsに一切現れない
  const warnings = buildWarnings(record, COMPANY_ID);
  assert.deepEqual(warnings, []);
});

// --- 7: 急増産または高リスク時に警告が表示される ---

test("受入確認W-3: rampWarnings(productionRampStress=0.9)がある場合、急増産の警告（重大、閾値0.8以上）が出る", () => {
  const summary = makeSummary({ rampWarnings: [{ factoryId: "BAL-F1", product: "vap", productionRampStress: 0.9 }] });
  const record = makeRecord(summary, [makeAdjustment()]);
  const warnings = buildWarnings(record, COMPANY_ID);
  const rampWarning = warnings.find((w) => w.key.startsWith("ramp-"));
  assert.ok(rampWarning, "急増産の警告が出るはず");
  assert.equal(rampWarning!.severity, "重大");
});

test("受入確認W-4: 設備稼働率97%以上では「重大」、92%以上97%未満では「警戒」、85%以上92%未満では「注意」の高い設備稼働率警告が出る", () => {
  const critical = buildWarnings(makeRecord(makeSummary({ equipmentUtilizationRate: ratio(0.98) }), [makeAdjustment()]), COMPANY_ID);
  const alert = buildWarnings(makeRecord(makeSummary({ equipmentUtilizationRate: ratio(0.93) }), [makeAdjustment()]), COMPANY_ID);
  const warn = buildWarnings(makeRecord(makeSummary({ equipmentUtilizationRate: ratio(0.87) }), [makeAdjustment()]), COMPANY_ID);

  assert.equal(critical.find((w) => w.key === "equipment-utilization")?.severity, "重大");
  assert.equal(alert.find((w) => w.key === "equipment-utilization")?.severity, "警戒");
  assert.equal(warn.find((w) => w.key === "equipment-utilization")?.severity, "注意");
});

test("受入確認W-5: 重大品質事故が発生していれば、廃棄比率等に関わらず常に「重大」の品質事故警告が出る", () => {
  const summary = makeSummary({ majorIncidentCount: 1 });
  const record = makeRecord(summary, [makeAdjustment()]);
  const warnings = buildWarnings(record, COMPANY_ID);
  const incidentWarning = warnings.find((w) => w.key === "major-incident");
  assert.ok(incidentWarning);
  assert.equal(incidentWarning!.severity, "重大");
});

test("受入確認W-6: 廃棄比率が閾値(20%)以上のとき「重大」の廃棄増加警告が出る", () => {
  const adjustment = makeAdjustment({
    originalFinishedGoodsQuantity: hosoEqTons(1000),
    adjustedFinishedGoodsQuantity: hosoEqTons(750),
    discardQuantity: hosoEqTons(250),
  });
  const summary = makeSummary({ discardQuantity: hosoEqTons(250) });
  const record = makeRecord(summary, [adjustment]);
  const warnings = buildWarnings(record, COMPANY_ID);
  const discardWarning = warnings.find((w) => w.key === "discard");
  assert.ok(discardWarning);
  assert.equal(discardWarning!.severity, "重大");
});

test("受入確認W-7: 顧客信頼・納期信頼性が閾値(WARNING_THRESHOLDS.customerTrustScore.critical)以下の市場があれば信頼低下警告が出る", () => {
  const summary = makeSummary({
    customerTrustByMarket: { US: score0to100(5), JP: score0to100(70) },
    deliveryReliabilityByMarket: { US: score0to100(70), JP: score0to100(70) },
  });
  const record = makeRecord(summary, [makeAdjustment()]);
  const warnings = buildWarnings(record, COMPANY_ID);
  const trustWarning = warnings.find((w) => w.key === "customer-trust");
  assert.ok(trustWarning);
  assert.equal(trustWarning!.severity, "重大");
  assert.ok(5 <= WARNING_THRESHOLDS.customerTrustScore.critical);
});

test("受入確認W-8: 警告は重大→警戒→注意の順にソートされる", () => {
  const summary = makeSummary({
    equipmentUtilizationRate: ratio(0.87), // 注意
    overtimeRate: ratio(0.25), // 警戒
    majorIncidentCount: 1, // 重大
  });
  const record = makeRecord(summary, [makeAdjustment()]);
  const warnings = buildWarnings(record, COMPANY_ID);
  const severities = warnings.map((w) => w.severity);
  const order = ["重大", "警戒", "注意"];
  let lastIdx = -1;
  for (const s of severities) {
    const idx = order.indexOf(s);
    assert.ok(idx >= lastIdx, "重大→警戒→注意の順であるはず");
    lastIdx = idx;
  }
  assert.equal(topWarning(warnings)?.severity, "重大");
});

// --- 8（実エンジン回帰）: 通常のcanonical実行では、警告が「ほぼ全ターンで常時発生」するような
//     過剰検出（校正ミス）が再発しないことを実際のエンジン出力で確認する（回帰テスト）。
//     商品構成の複雑化(complexityStress)がfixtureの設計上ほぼ常に1.0に張り付くことが分かり、
//     当初の閾値では1,600件中1,580件（98.75%）で常時警告が出ていた問題を修正した経緯があるため、
//     この種の「ほぼ全件で警告」に戻っていないことを固定的に検証する。

test("受入確認W-9（回帰）: baseline-v0.1 canonical 8ターン×5社で、単一の警告種別が『ほぼ全ターンで常時発生』することはない（校正ミスの再発防止）", () => {
  const result = runCompanyLabWithAutoPolicyForAllCompanies(
    { scenarioId: "baseline-v0.1", mode: "canonical", seed: "warning-regression-001", turns: 8 },
    generateAutoPolicyDecision
  );
  const labelCounts = new Map<string, number>();
  let totalCompanyTurns = 0;
  for (const record of result.history) {
    for (const s of record.companySummaries) {
      totalCompanyTurns += 1;
      const warnings = buildWarnings(record, s.companyId);
      const seenLabels = new Set(warnings.map((w) => w.label));
      for (const label of seenLabels) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
    }
  }
  for (const [label, count] of labelCounts.entries()) {
    const rate = count / totalCompanyTurns;
    assert.ok(rate < 0.9, `警告種別「${label}」が${(rate * 100).toFixed(1)}%のcompany-turnsで発生しており、過剰検出の疑いがある`);
  }
});
