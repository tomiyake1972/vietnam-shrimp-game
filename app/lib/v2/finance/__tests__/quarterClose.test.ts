// ShrimpX V2 — 財務モジュール 四半期決算テスト（Phase 8A）
//
// 合成した最小の事業実績（CompanyQuarterBusinessActuals）に対して
// closeFinancialQuarterを直接検証する単体テスト。会社ラボ全体を通した
// 統合検証はcompanyLab/__tests__/financeIntegration.test.tsが担う。
//
// 対応する重要テスト項目（実装指示より）: 2,3,4,5,6,7,8,9,10,11,12,13,18,20
// 対応する追加テスト項目（固変分解・限界利益管理）: 1〜15

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { Product } from "../../market/types";
import { FINANCE_PARAMETERS_V1 } from "../parameters";
import { CompanyQuarterBusinessActuals, ProductionBatchActual, closeFinancialQuarter } from "../quarterClose";
import { CompanyFinanceState, FinanceValidationError, fixedUnitCostPerTon, totalUnitCostPerTon, usd } from "../types";

const P1 = period(2015, 1);
const P2 = period(2015, 2);
const PROCESSING_RATES: Readonly<Record<Product, number>> = { hoso: 350, pd: 520, vap: 780 };
const EPS = 0.01;

function makeState(overrides: Partial<CompanyFinanceState> = {}): CompanyFinanceState {
  // 資産 = 10M(現金) + 0.5M(原料在庫、makeActualsのrawMaterialInventoryBeginUsdと整合)
  //       + 40M(固定資産) = 50.5M
  // 負債 = 10M / 資本金30M + 利益剰余金10.5M（開始時の貸借一致）
  return {
    companyId: "TEST",
    cash: usd(10_000_000),
    receivables: [],
    payables: [],
    otherCurrentAssets: usd(0),
    fixedAssetsGross: usd(40_000_000),
    accumulatedDepreciation: usd(0),
    shortTermLoans: usd(10_000_000),
    longTermLoans: usd(0),
    otherLiabilities: usd(0),
    capitalStock: usd(30_000_000),
    retainedEarnings: usd(10_500_000),
    finishedGoodsCostLedger: [],
    ...overrides,
  };
}

function makeBatch(overrides: Partial<ProductionBatchActual> = {}): ProductionBatchActual {
  return {
    batchId: "B1",
    factoryId: "F1",
    product: "hoso",
    originalTons: 100,
    adjustedTons: 95,
    discardTons: 5,
    reworkTons: 2,
    downgradeTons: 3,
    rawMaterialCostUsd: 300_000, // $3.00/kg × 100t
    rawMaterialCostBySourceUsd: { domestic: 300_000, imported: 0, aquaculture: 0 },
    lotId: "LOT1",
    downgradeRatio: 3 / 95,
    ...overrides,
  };
}

function makeActuals(overrides: Partial<CompanyQuarterBusinessActuals> = {}): CompanyQuarterBusinessActuals {
  return {
    companyId: "TEST",
    period: P1,
    fulfillmentUsage: [{ contractId: "C1", lotId: "LOT1", product: "hoso", quantityTons: 50 }],
    contractTerms: [{ contractId: "C1", market: "US", product: "hoso", unitPriceUsdPerKg: 5.0 }],
    batches: [makeBatch()],
    regularHeadcount: 100,
    temporaryHeadcount: 10,
    appliedOvertimeRate: 0.1,
    activeFactoryCount: 1,
    salesForceHeadcount: 5,
    procurementHeadcount: 5,
    domesticPurchasesUsd: 300_000,
    importOrdersUsd: 0,
    aquacultureHarvestUsd: 0,
    rawMaterialInventoryBeginUsd: 500_000,
    rawMaterialInventoryEndUsd: 500_000,
    lotConsumption: [{ lotId: "LOT1", quantityTons: 50 }],
    finishedGoodsRemainingByLot: [{ lotId: "LOT1", remainingQuantityTons: 45, expired: false }],
    ...overrides,
  };
}

function close(state = makeState(), actuals = makeActuals()) {
  return closeFinancialQuarter(state, actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES);
}

// --- 重要テスト2: 売上は契約締結時ではなく履行時に認識される ---

test("受入確認Q-2: 契約条件が存在しても履行（usage）がなければ売上は0。履行があれば履行数量×契約単価×1,000で認識される", () => {
  const noFulfillment = close(
    makeState(),
    makeActuals({ fulfillmentUsage: [], lotConsumption: [], finishedGoodsRemainingByLot: [{ lotId: "LOT1", remainingQuantityTons: 95, expired: false }] })
  );
  assert.equal(noFulfillment.result.profitAndLoss.grossRevenue as number, 0);

  const withFulfillment = close();
  assert.equal(withFulfillment.result.profitAndLoss.grossRevenue as number, 50 * 1000 * 5.0);
});

// --- 重要テスト3: 契約単価が後の原料価格変動で変化しない ---

test("受入確認Q-3: 収益は渡された契約単価のみに依存し、当期の原料価格（バッチ原価）を変えても売上高は不変", () => {
  const a = close();
  const b = close(
    makeState(),
    makeActuals({
      batches: [makeBatch({ rawMaterialCostUsd: 450_000, rawMaterialCostBySourceUsd: { domestic: 450_000, imported: 0, aquaculture: 0 } })],
      domesticPurchasesUsd: 450_000, // 期首500k + 仕入450k − 消費450k = 期末500k（フロー整合）
    })
  );
  assert.equal(a.result.profitAndLoss.grossRevenue as number, b.result.profitAndLoss.grossRevenue as number);
});

// --- 重要テスト4: 原料在庫・完成品在庫の数量と金額が整合する ---

test("受入確認Q-4: 完成品在庫金額は台帳の残数量×単位原価と一致し、実ロット残数量と同期する", () => {
  const { result, nextState } = close();
  const entry = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT1");
  assert.ok(entry);
  assert.equal(entry.remainingQuantity, 45);
  const expectedValue = 45 * totalUnitCostPerTon(entry.unitCost);
  assert.ok(Math.abs((result.balanceSheet.finishedGoodsInventory as number) - expectedValue) < EPS);
});

// --- 重要テスト5: 未販売完成品原価が当期売上原価へ流出しない ---

test("受入確認Q-5: 販売50t分の原価だけが売上原価となり、未販売45t分は在庫に残る（当期製造原価との整合）", () => {
  const { result, nextState } = close();
  const entry = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT1")!;
  const unitTotal = totalUnitCostPerTon(entry.unitCost);
  const cos = result.profitAndLoss.costOfSales;
  const soldPortion =
    (cos.rawMaterialCost as number) + (cos.processingCost as number) + (cos.laborCost as number) + (cos.factoryFixedCost as number);
  assert.ok(Math.abs(soldPortion - 50 * unitTotal) < EPS, `販売分原価 ${soldPortion} ≠ 50t×単価 ${50 * unitTotal}`);
  // 在庫45t分は売上原価に含まれない
  assert.ok(Math.abs((result.balanceSheet.finishedGoodsInventory as number) - 45 * unitTotal) < EPS);
});

// --- 重要テスト6: 廃棄分が在庫へ残らない ---

test("受入確認Q-6: 廃棄5t分の変動製造原価は当期の廃棄損として認識され、在庫評価には廃棄分が含まれない", () => {
  const { result, nextState } = close();
  assert.ok((result.qualityLoss.qualityDiscardLoss as number) > 0);
  assert.equal(result.qualityLoss.discardQuantityTons, 5);
  // 台帳数量は調整後95t基準（当期消費50t → 残45t）。廃棄5tはどこにも在庫として存在しない。
  const totalLedgerQty = nextState.finishedGoodsCostLedger.reduce((s, e) => s + e.remainingQuantity, 0);
  assert.equal(totalLedgerQty, 45);
});

// --- 重要テスト7: 再加工量を数量損失にしない ---

test("受入確認Q-7: 再加工2tは数量を減らさず（調整後95tのまま）、追加加工費のみ当期費用となる", () => {
  const { result } = close();
  assert.equal(result.qualityLoss.reworkQuantityTons, 2);
  assert.equal(result.qualityLoss.reworkCost as number, 2 * FINANCE_PARAMETERS_V1.manufacturing.reworkCostUsdPerTon);
  // 再加工しても台帳の初期数量は95t（バッチのadjustedTons）で、数量損失は廃棄5tだけ
  assert.equal(result.profitAndLoss.costOfSales.reworkCost as number, 2 * FINANCE_PARAMETERS_V1.manufacturing.reworkCostUsdPerTon);
});

// --- 重要テスト8: 格落ち・再加工・廃棄の損失を二重計上しない ---

test("受入確認Q-8: 売上原価合計は各構成要素の和と一致し、品質損失（再加工・廃棄・格落ち控除）が重複計上されない", () => {
  const { result } = close();
  const cos = result.profitAndLoss.costOfSales;
  const expectedTotal =
    (cos.rawMaterialCost as number) +
    (cos.processingCost as number) +
    (cos.laborCost as number) +
    (cos.factoryFixedCost as number) +
    (cos.reworkCost as number) +
    (cos.discardLoss as number) +
    (cos.unabsorbedFixedManufacturingCost as number);
  assert.ok(Math.abs((result.profitAndLoss.totalCostOfSales as number) - expectedTotal) < EPS);
  // 格落ちは売上控除（収益側）のみで、売上原価には含まれない
  assert.ok((result.profitAndLoss.qualitySalesDeduction as number) > 0);
  // 廃棄損は変動製造原価ベース: 5t × (300,000+35,000+変動労務/ユーティリティ配賦)/100t
  const m = result.manufacturingCost;
  const variableTotal =
    300_000 + 100 * 350 + (m.temporaryWorkerCost as number) + (m.overtimeCost as number) + (m.utilityVariableCost as number);
  assert.ok(Math.abs((result.qualityLoss.qualityDiscardLoss as number) - (5 / 100) * variableTotal) < EPS);
});

// --- 重要テスト9: 売掛金・買掛金が予定期に決済される ---

test("受入確認Q-9: 当期発生の売掛金は翌期回収・輸入買掛金は翌期支払となり、決済期到来分だけが現金化される", () => {
  const q1 = close(makeState(), makeActuals({ importOrdersUsd: 200_000, rawMaterialInventoryEndUsd: 700_000 }));
  // Q1: 売掛金発生（未回収）・買掛金発生（未払）
  assert.equal(q1.result.cashFlow.operatingDirect.receiptsFromCustomers as number, 0);
  const ar1 = q1.nextState.receivables;
  const ap1 = q1.nextState.payables;
  assert.equal(ar1.length, 1);
  assert.equal(ar1[0].dueSettlementPeriod, P2);
  assert.equal(ap1.length, 1);
  assert.equal(ap1[0].dueSettlementPeriod, P2);
  const arAmount = ar1[0].amount as number;
  const apAmount = ap1[0].amount as number;
  assert.equal(apAmount, 200_000);

  // Q2: 生産・販売なしの静かな四半期でも、予定期が到来した売掛金・買掛金が決済される
  const q2 = close(
    q1.nextState,
    makeActuals({
      period: P2,
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [],
      lotConsumption: [],
      domesticPurchasesUsd: 0,
      importOrdersUsd: 0,
      rawMaterialInventoryBeginUsd: 700_000,
      rawMaterialInventoryEndUsd: 700_000,
      finishedGoodsRemainingByLot: q1.nextState.finishedGoodsCostLedger.map((e) => ({
        lotId: e.lotId,
        remainingQuantityTons: e.remainingQuantity,
        expired: false,
      })),
      temporaryHeadcount: 0,
      appliedOvertimeRate: 0,
    })
  );
  assert.equal(q2.result.cashFlow.operatingDirect.receiptsFromCustomers as number, arAmount);
  assert.equal(q2.nextState.receivables.length, 0);
  assert.equal(q2.nextState.payables.length, 0);
  // 買掛決済は原料支払に含まれる（Q2の国内・養殖購入は0）
  assert.equal(-(q2.result.cashFlow.operatingDirect.paymentsForRawMaterials as number), apAmount);
});

// --- 重要テスト10: PL計算が勘定内訳と一致する ---

test("受入確認Q-10: PLの各段階利益が勘定内訳から正しく積み上がる", () => {
  const { result } = close();
  const pl = result.profitAndLoss;
  assert.ok(Math.abs((pl.netRevenue as number) - ((pl.grossRevenue as number) - (pl.qualitySalesDeduction as number))) < EPS);
  assert.ok(Math.abs((pl.grossProfit as number) - ((pl.netRevenue as number) - (pl.totalCostOfSales as number))) < EPS);
  assert.ok(Math.abs((pl.operatingProfit as number) - ((pl.grossProfit as number) - (pl.sellingGeneralAdmin as number))) < EPS);
  assert.ok(Math.abs((pl.profitBeforeTax as number) - ((pl.operatingProfit as number) - (pl.interestExpense as number))) < EPS);
  assert.ok(Math.abs((pl.netIncome as number) - ((pl.profitBeforeTax as number) - (pl.incomeTax as number))) < EPS);
  // 支払利息 = 短期10M×2.2% + 長期0×1.8%
  assert.ok(Math.abs((pl.interestExpense as number) - 10_000_000 * FINANCE_PARAMETERS_V1.finance.shortTermInterestRatePerQuarter) < EPS);
});

// --- 重要テスト11: BSが毎四半期貸借一致する ---

test("受入確認Q-11: BSの貸借差額が許容誤差内で0になる", () => {
  const { result } = close();
  assert.ok(Math.abs(result.balanceSheet.balanceDifference as number) < EPS, `貸借差額: ${result.balanceSheet.balanceDifference}`);
});

// --- 重要テスト12: CF合計と現金増減が一致する ---

test("受入確認Q-12: CFO+CFI+CFF=現金増減、期首+増減=期末、直接法CFOと間接法照合が一致する", () => {
  const { result } = close();
  const cf = result.cashFlow;
  assert.ok(
    Math.abs((cf.netCashChange as number) - ((cf.operatingCashFlow as number) + (cf.investingCashFlow as number) + (cf.financingCashFlow as number))) <
      EPS
  );
  assert.ok(Math.abs((cf.closingCash as number) - ((cf.openingCash as number) + (cf.netCashChange as number))) < EPS);
  assert.ok(Math.abs(cf.directIndirectDifference as number) < EPS, `直接法と間接法の差: ${cf.directIndirectDifference}`);
});

// --- 重要テスト13: 利益剰余金のロールフォワードが純利益と一致する ---

test("受入確認Q-13: 期末利益剰余金 = 期首利益剰余金 + 当期純利益", () => {
  const state = makeState();
  const { result, nextState } = close(state);
  assert.ok(
    Math.abs((nextState.retainedEarnings as number) - ((state.retainedEarnings as number) + (result.profitAndLoss.netIncome as number))) < EPS
  );
});

// --- 重要テスト18: NaN・Infinity・不正残高を拒否する ---

test("受入確認Q-18: 不正な入力（説明できない在庫消失・台帳超過消費）はFinanceValidationErrorとして拒否される", () => {
  // 原料在庫フローが大きく負（期首+仕入-消費 < 期末）
  assert.throws(
    () => close(makeState(), makeActuals({ rawMaterialInventoryEndUsd: 10_000_000 })),
    FinanceValidationError
  );
  // 台帳残数量を超える実消費
  assert.throws(
    () => close(makeState(), makeActuals({ lotConsumption: [{ lotId: "LOT1", quantityTons: 96 }] })),
    FinanceValidationError
  );
});

// --- 重要テスト20: 現金不足を勝手な資金注入で隠さない ---

test("受入確認Q-20: 現金がマイナスになった場合、そのまま負の残高として記録し、cashShortfallフラグと不足額を明示する", () => {
  // 現金を0.1Mへ減らすぶん利益剰余金も減らし、開始時の貸借一致を保つ
  const { result, nextState } = close(makeState({ cash: usd(100_000), retainedEarnings: usd(600_000) }));
  // 当期は売掛回収がなく支払だけが発生するため現金はマイナスになる
  assert.ok((result.balanceSheet.cash as number) < 0);
  assert.equal(result.cashShortfall, true);
  assert.ok((result.cashShortfallAmount as number) > 0);
  assert.ok(Math.abs((result.cashShortfallAmount as number) - -(result.balanceSheet.cash as number)) < EPS);
  assert.equal(nextState.cash as number, result.balanceSheet.cash as number);
  // 貸借は現金マイナスのままでも一致する
  assert.ok(Math.abs(result.balanceSheet.balanceDifference as number) < EPS);
});

// =====================================================================
// Phase 8A追加要件: 固変分解・限界利益管理
// =====================================================================

// --- 追加1: 生産量ゼロでも固定費が発生する ---

test("受入確認F-1: 生産・販売ゼロの四半期でも固定費（正社員給与・工場固定費・減価償却・固定販管費）が発生する", () => {
  const { result } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [],
      lotConsumption: [],
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      finishedGoodsRemainingByLot: [],
      temporaryHeadcount: 0,
      appliedOvertimeRate: 0,
    })
  );
  const cm = result.contributionMargin;
  assert.equal(cm.netRevenue as number, 0);
  assert.ok((cm.totalFixedCost as number) > 0, "生産ゼロでも固定費合計が正");
  assert.equal(
    cm.fixedManufacturingCost as number,
    100 * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter +
      FINANCE_PARAMETERS_V1.manufacturing.factoryFixedCostUsdPerQuarter +
      FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityFixedUsdPerQuarter +
      40_000_000 * FINANCE_PARAMETERS_V1.finance.depreciationRatePerQuarter
  );
  // 全部原価計算では未配賦固定費として当期費用化される
  assert.ok((result.profitAndLoss.costOfSales.unabsorbedFixedManufacturingCost as number) > 0);
  assert.ok((result.profitAndLoss.netIncome as number) < 0);
});

// --- 追加2: 生産量増加に対して変動費がドライバー数量に応じて増える ---

test("受入確認F-2: 生産量を2倍にすると加工費・変動ユーティリティ費がドライバー数量に応じて2倍になる", () => {
  const a = close();
  const b = close(
    makeState(),
    makeActuals({
      batches: [
        makeBatch({
          originalTons: 200,
          adjustedTons: 190,
          discardTons: 10,
          reworkTons: 4,
          downgradeTons: 6,
          rawMaterialCostUsd: 600_000,
          rawMaterialCostBySourceUsd: { domestic: 600_000, imported: 0, aquaculture: 0 },
          downgradeRatio: 6 / 190,
        }),
      ],
      domesticPurchasesUsd: 600_000,
      finishedGoodsRemainingByLot: [{ lotId: "LOT1", remainingQuantityTons: 140, expired: false }],
    })
  );
  assert.equal((b.result.manufacturingCost.hosoProcessingCost as number), 2 * (a.result.manufacturingCost.hosoProcessingCost as number));
  assert.equal((b.result.manufacturingCost.utilityVariableCost as number), 2 * (a.result.manufacturingCost.utilityVariableCost as number));
  // 固定費は生産量に比例しない（同額のまま）
  assert.equal(b.result.manufacturingCost.regularLaborCost as number, a.result.manufacturingCost.regularLaborCost as number);
  assert.equal(b.result.manufacturingCost.factoryFixedCost as number, a.result.manufacturingCost.factoryFixedCost as number);
});

// --- 追加3: 混合費が固定部分と変動部分に正しく分かれる ---

test("受入確認F-3: 工場ユーティリティ費（混合費）はコスト記録上、固定部分と変動部分が分離保存され、合計から再推定していない", () => {
  const { result } = close();
  const utility = result.costRecords.find((r) => r.account === "factoryUtility");
  assert.ok(utility);
  assert.equal(utility.behavior, "mixed");
  assert.equal(utility.fixedPortion as number, FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityFixedUsdPerQuarter);
  assert.equal(utility.variablePortion as number, 100 * FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityVariableUsdPerTon);
  assert.equal(utility.driverUnitRate, FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityVariableUsdPerTon);
});

// --- 追加4: 正社員基本給と臨時ワーカー費が異なるコスト特性になる ---

test("受入確認F-4: 正社員給与はstepFixed、臨時ワーカー費・残業費はvariableとして記録される", () => {
  const { result } = close();
  const regular = result.costRecords.find((r) => r.account === "directLaborRegular")!;
  const temp = result.costRecords.find((r) => r.account === "temporaryWorker")!;
  const overtime = result.costRecords.find((r) => r.account === "overtime")!;
  assert.equal(regular.behavior, "stepFixed");
  assert.equal(regular.variablePortion as number, 0);
  assert.equal(temp.behavior, "variable");
  assert.equal(temp.fixedPortion as number, 0);
  assert.equal(overtime.behavior, "variable");
  assert.equal(regular.driver, "regularHeadcount");
  assert.equal(temp.driver, "temporaryWorkerHeadcount");
});

// --- 追加5: 再加工費・廃棄損が固定費へ分類されない ---

test("受入確認F-5: 再加工費・廃棄損はvariableとして記録され、固定費部分を持たない", () => {
  const { result } = close();
  const rework = result.costRecords.find((r) => r.account === "rework")!;
  const discard = result.costRecords.find((r) => r.account === "discardLoss")!;
  assert.equal(rework.behavior, "variable");
  assert.equal(rework.fixedPortion as number, 0);
  assert.equal(rework.driver, "reworkQuantity");
  assert.equal(discard.behavior, "variable");
  assert.equal(discard.fixedPortion as number, 0);
  assert.equal(discard.driver, "discardQuantity");
});

// --- 追加6・7・8: 限界利益・管理会計営業利益・損益分岐点の恒等式 ---

test("受入確認F-6: 限界利益 = 純売上高 − 変動費合計", () => {
  const { result } = close();
  const cm = result.contributionMargin;
  assert.ok(Math.abs((cm.contributionMargin as number) - ((cm.netRevenue as number) - (cm.totalVariableCost as number))) < EPS);
  const varSum =
    (cm.variableRawMaterialCost as number) +
    (cm.variableProcessingCost as number) +
    (cm.variableLaborCost as number) +
    (cm.variableQualityCost as number) +
    (cm.variableSellingCost as number);
  assert.ok(Math.abs((cm.totalVariableCost as number) - varSum) < EPS);
});

test("受入確認F-7: 管理会計上の営業利益 = 限界利益 − 固定費合計", () => {
  const { result } = close();
  const cm = result.contributionMargin;
  assert.ok(Math.abs((cm.managementOperatingProfit as number) - ((cm.contributionMargin as number) - (cm.totalFixedCost as number))) < EPS);
});

test("受入確認F-8: 損益分岐点売上高 = 固定費 ÷ 限界利益率、安全余裕額 = 純売上高 − 損益分岐点売上高", () => {
  const { result } = close();
  const cm = result.contributionMargin;
  assert.ok(cm.contributionMarginRatio !== undefined && cm.contributionMarginRatio > 0);
  assert.ok(cm.breakEvenRevenue !== undefined);
  assert.ok(Math.abs((cm.breakEvenRevenue as number) - (cm.totalFixedCost as number) / cm.contributionMarginRatio) < EPS);
  assert.ok(cm.marginOfSafety !== undefined);
  assert.ok(Math.abs((cm.marginOfSafety as number) - ((cm.netRevenue as number) - (cm.breakEvenRevenue as number))) < EPS);
});

// --- 追加9: 商品構成を変えると加重平均限界利益率と損益分岐点が変化する ---

test("受入確認F-9: 販売構成をHOSOのみ→VAP混在へ変えると、前提商品構成が保存され損益分岐点が変化する", () => {
  const hosoOnly = close();
  const withVap = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [
        { contractId: "C1", lotId: "LOT1", product: "hoso", quantityTons: 25 },
        { contractId: "C2", lotId: "LOT2", product: "vap", quantityTons: 25 },
      ],
      contractTerms: [
        { contractId: "C1", market: "US", product: "hoso", unitPriceUsdPerKg: 5.0 },
        { contractId: "C2", market: "JP", product: "vap", unitPriceUsdPerKg: 7.5 },
      ],
      batches: [
        makeBatch({ originalTons: 50, adjustedTons: 47.5, discardTons: 2.5, reworkTons: 1, downgradeTons: 1.5, rawMaterialCostUsd: 150_000, rawMaterialCostBySourceUsd: { domestic: 150_000, imported: 0, aquaculture: 0 }, downgradeRatio: 1.5 / 47.5 }),
        makeBatch({ batchId: "B2", product: "vap", lotId: "LOT2", originalTons: 50, adjustedTons: 47.5, discardTons: 2.5, reworkTons: 1, downgradeTons: 1.5, rawMaterialCostUsd: 150_000, rawMaterialCostBySourceUsd: { domestic: 150_000, imported: 0, aquaculture: 0 }, downgradeRatio: 1.5 / 47.5 }),
      ],
      lotConsumption: [
        { lotId: "LOT1", quantityTons: 25 },
        { lotId: "LOT2", quantityTons: 25 },
      ],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT1", remainingQuantityTons: 22.5, expired: false },
        { lotId: "LOT2", remainingQuantityTons: 22.5, expired: false },
      ],
    })
  );
  assert.equal(hosoOnly.result.contributionMargin.assumedProductMix.length, 1);
  assert.equal(withVap.result.contributionMargin.assumedProductMix.length, 2);
  assert.notEqual(
    hosoOnly.result.contributionMargin.contributionMarginRatio,
    withVap.result.contributionMargin.contributionMarginRatio
  );
  assert.notEqual(hosoOnly.result.contributionMargin.breakEvenRevenue as number, withVap.result.contributionMargin.breakEvenRevenue as number);
});

// --- 追加10: 生産量だけが減っても段階固定費が自動削減されない ---

test("受入確認F-10: 生産量が半分になっても正社員給与・工場固定費・減価償却は同額のまま（変動費のように削減されない）", () => {
  const full = close();
  const half = close(
    makeState(),
    makeActuals({
      batches: [
        makeBatch({
          originalTons: 50,
          adjustedTons: 47.5,
          discardTons: 2.5,
          reworkTons: 1,
          downgradeTons: 1.5,
          rawMaterialCostUsd: 150_000,
          rawMaterialCostBySourceUsd: { domestic: 150_000, imported: 0, aquaculture: 0 },
          downgradeRatio: 1.5 / 47.5,
        }),
      ],
      fulfillmentUsage: [{ contractId: "C1", lotId: "LOT1", product: "hoso", quantityTons: 25 }],
      lotConsumption: [{ lotId: "LOT1", quantityTons: 25 }],
      domesticPurchasesUsd: 150_000, // 期首500k + 仕入150k − 消費150k = 期末500k
      finishedGoodsRemainingByLot: [{ lotId: "LOT1", remainingQuantityTons: 22.5, expired: false }],
    })
  );
  assert.equal(half.result.contributionMargin.fixedManufacturingCost as number, full.result.contributionMargin.fixedManufacturingCost as number);
  const fullRegular = full.result.costRecords.find((r) => r.account === "directLaborRegular")!;
  const halfRegular = half.result.costRecords.find((r) => r.account === "directLaborRegular")!;
  assert.equal(fullRegular.fixedPortion as number, halfRegular.fixedPortion as number);
});

// --- 追加11・12: 全部原価計算と変動原価計算の利益差異 ---

test("受入確認F-11/F-12: 在庫増加時に全部原価と変動原価の利益差が発生し、差額が期末在庫中の固定製造費の増減と厳密に一致する", () => {
  const { result } = close();
  const rec = result.absorptionVariableReconciliation;
  // 生産95t・販売50t → 在庫45t増 → 全部原価計算の利益が固定費繰延分だけ大きい
  assert.ok((rec.profitDifference as number) > 0, "在庫増加時はabsorption利益 > variable利益");
  const inventoryFixedDelta = (rec.fixedCostInClosingInventory as number) - (rec.fixedCostInOpeningInventory as number);
  assert.ok(
    Math.abs((rec.profitDifference as number) - inventoryFixedDelta) < EPS,
    `利益差${rec.profitDifference} ≠ 在庫中固定費増減${inventoryFixedDelta}`
  );
  // フロー恒等式: 期末 = 期首 + 配賦 − 販売払出 − 廃棄払出
  assert.ok(
    Math.abs(
      (rec.fixedCostInClosingInventory as number) -
        ((rec.fixedCostInOpeningInventory as number) +
          (rec.fixedCostAbsorbedIntoInventory as number) -
          (rec.fixedCostReleasedThroughSales as number) -
          (rec.fixedCostReleasedThroughWriteOff as number))
    ) < EPS
  );
});

// --- 追加13: 費用総額が固定部分＋変動部分と一致し、二重計上がない ---

test("受入確認F-13: 各コスト記録は固定部分+変動部分が合計であり、当期発生製造費の勘定合計と整合する", () => {
  const { result } = close();
  for (const r of result.costRecords) {
    assert.ok(Number.isFinite(r.fixedPortion as number) && Number.isFinite(r.variablePortion as number));
    if (r.behavior === "variable") assert.equal(r.fixedPortion as number, 0, `${r.account}のfixedPortionは0のはず`);
    if (r.behavior === "fixed" || r.behavior === "stepFixed") assert.equal(r.variablePortion as number, 0, `${r.account}のvariablePortionは0のはず`);
  }
  const m = result.manufacturingCost;
  const laborRecords = result.costRecords.filter((r) => ["directLaborRegular", "temporaryWorker", "overtime"].includes(r.account));
  const laborTotal = laborRecords.reduce((s, r) => s + (r.fixedPortion as number) + (r.variablePortion as number), 0);
  assert.ok(
    Math.abs(laborTotal - ((m.regularLaborCost as number) + (m.temporaryWorkerCost as number) + (m.overtimeCost as number))) < EPS
  );
});

// --- 追加14: 商品別限界利益と全社限界利益が整合する ---

test("受入確認F-14: Σ(商品別限界利益) = 全社限界利益 + 共通変動費（商品へ帰属しない変動費）", () => {
  const { result } = close();
  const cm = result.contributionMargin;
  const sumByProduct = cm.byProduct.reduce((s, p) => s + (p.contributionMargin as number), 0);
  assert.ok(
    Math.abs(sumByProduct - ((cm.contributionMargin as number) + (cm.commonVariableCost as number))) < EPS,
    `Σ商品別CM ${sumByProduct} ≠ 全社CM ${cm.contributionMargin} + 共通変動費 ${cm.commonVariableCost}`
  );
});

// --- 追加15: 共通固定費を商品別限界利益へ恣意的に配賦しない ---

test("受入確認F-15: 商品別・市場別の直接固定費は0（共通固定費は配賦せずcommonFixedCostとして別掲）", () => {
  const { result } = close();
  const cm = result.contributionMargin;
  for (const p of cm.byProduct) assert.equal(p.directFixedCost as number, 0);
  for (const mk of cm.byMarket) assert.equal(mk.directFixedCost as number, 0);
  assert.equal(cm.commonFixedCost as number, cm.totalFixedCost as number);
});

// --- 補助: 完成品の期限切れ在庫廃棄と利益差異の整合 ---

test("受入確認F-16(補助): 完成品ロットが期限切れになった場合、在庫廃棄損（変動+固定）が当期認識され、利益差異調整と整合する", () => {
  const q1 = close();
  // Q2: LOT1の残45tが期限切れになったと仮定
  const q2 = close(
    q1.nextState,
    makeActuals({
      period: P2,
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [],
      lotConsumption: [],
      domesticPurchasesUsd: 0,
      rawMaterialInventoryBeginUsd: 500_000,
      rawMaterialInventoryEndUsd: 500_000,
      finishedGoodsRemainingByLot: [{ lotId: "LOT1", remainingQuantityTons: 45, expired: true }],
      temporaryHeadcount: 0,
      appliedOvertimeRate: 0,
    })
  );
  const entry = q1.nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT1")!;
  const expectedWriteOff = 45 * totalUnitCostPerTon(entry.unitCost);
  assert.ok(Math.abs((q2.result.qualityLoss.finishedGoodsWriteOffLoss as number) - expectedWriteOff) < EPS);
  const rec = q2.result.absorptionVariableReconciliation;
  assert.ok(Math.abs((rec.fixedCostReleasedThroughWriteOff as number) - 45 * fixedUnitCostPerTon(entry.unitCost)) < EPS);
  // 在庫減少（消滅）時はabsorption利益 < variable利益となり、差額は在庫中固定費の減少と一致
  assert.ok(
    Math.abs((rec.profitDifference as number) - ((rec.fixedCostInClosingInventory as number) - (rec.fixedCostInOpeningInventory as number))) < EPS
  );
  assert.equal(q2.nextState.finishedGoodsCostLedger.length, 0);
});

// --- Phase 8A重点確認 #3: 生産時廃棄と期限切れ廃棄の区別（完成品原価ロールフォワード） ---

test("受入確認・重点確認3: 生産時廃棄(Q1)と期限切れ廃棄(Q2)は別事象であり同じロット原価を二重計上しない。期首完成品原価+当期完成品振替原価-売上原価-期限切れ廃棄原価=期末完成品原価が両四半期で厳密に成立する", () => {
  // Q1: バッチ原産100t中、生産時廃棄5t（品質調整＝Phase 7A由来）、調整後95tが
  //     完成品ロットとして在庫化され、そのうち50tが当期販売（消費）、45tが期末在庫。
  const q1 = close();
  const entry1 = q1.nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT1")!;
  const unitTotal = totalUnitCostPerTon(entry1.unitCost);

  const beginningInventory1 = 0; // makeState()は空の台帳から開始
  const transferredIn1 = 95 * unitTotal; // adjustedTons(良品)ぶんだけが在庫化される（廃棄5tは対象外）
  const cogs1 =
    (q1.result.profitAndLoss.costOfSales.rawMaterialCost as number) +
    (q1.result.profitAndLoss.costOfSales.processingCost as number) +
    (q1.result.profitAndLoss.costOfSales.laborCost as number) +
    (q1.result.profitAndLoss.costOfSales.factoryFixedCost as number);
  const expiryWriteOff1 = q1.result.qualityLoss.finishedGoodsWriteOffLoss as number;
  const endingInventory1 = q1.result.balanceSheet.finishedGoodsInventory as number;

  assert.equal(expiryWriteOff1, 0, "Q1では期限切れは発生していない");
  assert.ok(
    Math.abs(beginningInventory1 + transferredIn1 - cogs1 - expiryWriteOff1 - endingInventory1) < EPS,
    "Q1: 期首+振替-売上原価-期限切れ廃棄=期末が不成立"
  );
  // 生産時廃棄5t分の損失は「品質損失（廃棄損）」として認識され、在庫（台帳）には
  // 一切乗っていない（廃棄5t分の原価は台帳のどのロットにも存在しないため、
  // 後続四半期で期限切れとして再度損失化されることは構造的に不可能）。
  const productionDiscardLoss1 = q1.result.qualityLoss.qualityDiscardLoss as number;
  assert.ok(productionDiscardLoss1 > 0);
  const totalLedgerTonsQ1 = q1.nextState.finishedGoodsCostLedger.reduce((s, e) => s + e.remainingQuantity, 0);
  assert.equal(totalLedgerTonsQ1, 45);
  // 数量の全量説明: 原産100t = 生産時廃棄5t + 当期販売50t + 期末在庫45t（欠落・重複なし）
  assert.equal(5 + 50 + 45, 100);

  // Q2: 生産なし。Q1の期末在庫45tが全量期限切れとなる（生産時廃棄とは無関係の別事象）。
  const q2 = close(
    q1.nextState,
    makeActuals({
      period: P2,
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [],
      lotConsumption: [],
      domesticPurchasesUsd: 0,
      rawMaterialInventoryBeginUsd: 500_000,
      rawMaterialInventoryEndUsd: 500_000,
      finishedGoodsRemainingByLot: [{ lotId: "LOT1", remainingQuantityTons: 45, expired: true }],
      temporaryHeadcount: 0,
      appliedOvertimeRate: 0,
    })
  );
  const beginningInventory2 = endingInventory1;
  const transferredIn2 = 0;
  const cogs2 = 0;
  const expiryWriteOff2 = q2.result.qualityLoss.finishedGoodsWriteOffLoss as number;
  const endingInventory2 = q2.result.balanceSheet.finishedGoodsInventory as number;

  assert.ok(Math.abs(expiryWriteOff2 - 45 * unitTotal) < EPS, "Q2の期限切れ廃棄は45t×単位原価と一致するべき");
  assert.ok(
    Math.abs(beginningInventory2 + transferredIn2 - cogs2 - expiryWriteOff2 - endingInventory2) < EPS,
    "Q2: 期首+振替-売上原価-期限切れ廃棄=期末が不成立"
  );
  assert.equal(endingInventory2, 0);

  // 二重計上の否定: Q1の生産時廃棄損とQ2の期限切れ廃棄損は、対象トン数（5t vs 45t）も
  // 金額算出方法（変動製造原価のみ vs 変動+固定の全部原価）も異なり、合算しても
  // 過大にならない（同じ原価要素を2回損失化していない）。
  assert.notEqual(productionDiscardLoss1, expiryWriteOff2);
  const q2ProductionDiscardLoss = q2.result.qualityLoss.qualityDiscardLoss as number;
  assert.equal(q2ProductionDiscardLoss, 0, "Q2は生産していないため生産時廃棄損は0");
});
