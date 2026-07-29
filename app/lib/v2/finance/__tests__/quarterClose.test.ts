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
import { INITIAL_PERIOD_V2, period } from "../../core/period";
import { Product } from "../../market/types";
import { FINANCE_PARAMETERS_V1 } from "../parameters";
import { computeExistingAssetDepreciationUsd } from "../depreciation";
import {
  CompanyQuarterBusinessActuals,
  ProductionBatchActual,
  closeFinancialQuarter,
  resolveLaborAllocationMode,
  headcountBudgetTolerance,
} from "../quarterClose";
import { CapexAdjustment, CompanyFinanceState, FinanceValidationError, fixedUnitCostPerTon, totalUnitCostPerTon, usd } from "../types";

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
  // 【Phase 8B-2C】既存資産2区分（建物35%/機械65%）を、それぞれの推定残存
  // 耐用年数（80四半期/32四半期）で定額償却した合計（旧・取得原価一律2.5%/四半期
  // から変更。デフォルトのfixedAssetsGross=40Mに対する新方式の値）。
  const existingAssetDepreciationUsd = computeExistingAssetDepreciationUsd(40_000_000, INITIAL_PERIOD_V2, P1, FINANCE_PARAMETERS_V1).totalUsd;
  assert.equal(
    cm.fixedManufacturingCost as number,
    100 * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter +
      FINANCE_PARAMETERS_V1.manufacturing.factoryFixedCostUsdPerQuarter +
      FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityFixedUsdPerQuarter +
      existingAssetDepreciationUsd
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

test("受入確認F-15: 商品別直接固定費は常用労務費（productive分）の実配属人数比配賦＋共通工場・設備固定費の加工度ウェイト付き数量配賦の合計となり、市場別直接固定費は引き続き常に0。commonFixedCost = totalFixedCost − Σ商品別直接固定費", () => {
  const { result } = close();
  const cm = result.contributionMargin;
  // このシナリオ（makeActuals既定値）は商品がhoso単独・legacyモード（assignedRegularHeadcount等は
  // 未指定）のため、常用労務費（legacyモードではidleLaborCost=0なので全額productive）と共通工場・
  // 設備固定費（factoryFixedCost+utilityFixedCost+depreciationCost）の両方が100%hosoへ配賦され、
  // 既存のfixedManufacturingCost（regularLaborCost+factoryFixedCost+utilityFixedCost+depreciation）
  // と厳密に一致する。
  assert.equal(cm.byProduct.length, 1);
  assert.equal(cm.byProduct[0].key, "hoso");
  assert.ok(
    Math.abs((cm.byProduct[0].directFixedCost as number) - (cm.fixedManufacturingCost as number)) < EPS,
    `hoso直接固定費 ${cm.byProduct[0].directFixedCost} ≠ fixedManufacturingCost ${cm.fixedManufacturingCost}`
  );
  // 市場別の直接固定費配賦は本変更のスコープ外（未実装）のため常に0のまま。
  for (const mk of cm.byMarket) assert.equal(mk.directFixedCost as number, 0);
  const totalDirect = cm.byProduct.reduce((s, p) => s + (p.directFixedCost as number), 0);
  assert.ok(Math.abs((cm.commonFixedCost as number) - ((cm.totalFixedCost as number) - totalDirect)) < EPS);
  // 単一商品・legacyモード（idleLaborCost=0）シナリオでは、commonFixedCostは
  // 営業・調達人件費＋一般管理固定費のみとなる。
  assert.ok(
    Math.abs((cm.commonFixedCost as number) - ((cm.fixedPersonnelCost as number) + (cm.fixedSellingAdminCost as number))) < EPS
  );
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

// --- 【商品別実労務配分の橋渡し（feature/v2-labor-cost-allocation-bridge, 1コミット目）】 ---
// resolveLaborAllocationModeのvalidation・後方互換の単体テスト。この時点ではまだ
// computeProductionCosting自体の配賦式は変更していないため、実労務データを渡しても
// 計算結果（labor関連の按分値）が従来と同一であることも合わせて確認する。

test("労務橋渡しV-1: assignedRegularHeadcount等3項目が全バッチで揃っていれば'actual'、全バッチで無ければ'legacy'を返す", () => {
  const withData = makeBatch({ assignedRegularHeadcount: 600, assignedTemporaryHeadcount: 0, appliedOvertimeRate: 0.09 });
  const withoutData = makeBatch();
  assert.equal(resolveLaborAllocationMode([withData]), "actual");
  assert.equal(resolveLaborAllocationMode([withoutData]), "legacy");
  assert.equal(resolveLaborAllocationMode([]), "legacy");
});

test("労務橋渡しV-2: 3項目のうち一部だけ指定されたバッチがあるとFinanceValidationError", () => {
  const partial = makeBatch({ assignedRegularHeadcount: 600 }); // temporaryHeadcount/appliedOvertimeRateは省略
  assert.throws(() => resolveLaborAllocationMode([partial]), FinanceValidationError);
});

test("労務橋渡しV-3: 一部のバッチのみ3項目が揃い、他のバッチは3項目とも無い場合もFinanceValidationError", () => {
  const complete = makeBatch({ batchId: "B1", assignedRegularHeadcount: 600, assignedTemporaryHeadcount: 0, appliedOvertimeRate: 0.09 });
  const missing = makeBatch({ batchId: "B2", product: "vap" });
  assert.throws(() => resolveLaborAllocationMode([complete, missing]), FinanceValidationError);
});

test("労務橋渡しV-3b: 3項目とも有限値・非負値でなければFinanceValidationError（NaN・Infinity・負値を個別に拒否する）", () => {
  const nanRegular = makeBatch({ assignedRegularHeadcount: NaN, assignedTemporaryHeadcount: 0, appliedOvertimeRate: 0.09 });
  assert.throws(() => resolveLaborAllocationMode([nanRegular]), FinanceValidationError);

  const infiniteTemporary = makeBatch({ assignedRegularHeadcount: 600, assignedTemporaryHeadcount: Infinity, appliedOvertimeRate: 0.09 });
  assert.throws(() => resolveLaborAllocationMode([infiniteTemporary]), FinanceValidationError);

  const negativeOvertimeRate = makeBatch({ assignedRegularHeadcount: 600, assignedTemporaryHeadcount: 0, appliedOvertimeRate: -0.01 });
  assert.throws(() => resolveLaborAllocationMode([negativeOvertimeRate]), FinanceValidationError);

  const negativeRegular = makeBatch({ assignedRegularHeadcount: -1, assignedTemporaryHeadcount: 0, appliedOvertimeRate: 0.09 });
  assert.throws(() => resolveLaborAllocationMode([negativeRegular]), FinanceValidationError);
});

test("労務橋渡しV-3c: 残業率（appliedOvertimeRate）自体の上限値は財務層では検証しない（生産層で既にクリップ済みという設計を踏襲し、有限・非負であれば大きな値もそのまま受理する）", () => {
  // production/loadMetrics.ts等の生産層で残業率の上限クリップは既に適用済みという設計
  // （ProductionBatchActual.appliedOvertimeRateのJSDoc「上限クリップは生産層で適用済み」）
  // のため、財務層(resolveLaborAllocationMode/assertFiniteNonNegative)はここでは上限を
  // 設けない。有限・非負である限り、たとえ非現実的に大きい値でもエラーにはならないことを
  // 明示的に固定する（財務層が誤って独自の上限を持ち込んでいないことの確認）。
  const largeRate = makeBatch({ assignedRegularHeadcount: 600, assignedTemporaryHeadcount: 0, appliedOvertimeRate: 5.0 });
  assert.doesNotThrow(() => resolveLaborAllocationMode([largeRate]));
});

test("労務橋渡しV-4: 実労務データ（assignedRegularHeadcount等）を渡しても、このコミット時点ではcloseFinancialQuarterの計算結果は従来と完全に同一（配賦式はまだ未変更）", () => {
  const legacyResult = close(makeState(), makeActuals());
  const withLaborData = close(
    makeState(),
    makeActuals({ batches: [makeBatch({ assignedRegularHeadcount: 100, assignedTemporaryHeadcount: 10, appliedOvertimeRate: 0.1 })] })
  );
  assert.equal(
    withLaborData.result.manufacturingCost.overtimeCost as number,
    legacyResult.result.manufacturingCost.overtimeCost as number
  );
  assert.deepEqual(
    withLaborData.result.balanceSheet.finishedGoodsInventory,
    legacyResult.result.balanceSheet.finishedGoodsInventory
  );
});

// =====================================================================
// feature/v2-labor-cost-allocation-bridge, 2コミット目:
// 残業費総額の人数ベース算定＋商品別実労務配分（本配賦式の変更）
// =====================================================================

const SALARY = FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter; // 1000
const TEMP_RATE = FINANCE_PARAMETERS_V1.labor.temporaryWorkerCostUsdPerQuarter; // 800
const OT_PREMIUM = FINANCE_PARAMETERS_V1.labor.overtimePremiumFactor; // 1.5

test("労務配分V2-1: 数量×人数が逆転するシナリオ（HOSO:200人/1000t/0%、VAP:800人/300t/30%）で、残業費総額はΣ(配属人数×残業率)基準となり、生産量加重平均残業率(≈0.069)は使われない", () => {
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 1000,
    adjustedTons: 1000,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 200,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 300,
    adjustedTons: 300,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 800,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0.3,
  });
  const quantityWeightedAvgRate = (1000 * 0 + 300 * 0.3) / (1000 + 300); // 旧式が使っていた生産量加重平均（≈0.0692）

  const { result } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [hosoBatch, vapBatch],
      regularHeadcount: 1000,
      temporaryHeadcount: 0,
      appliedOvertimeRate: quantityWeightedAvgRate,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT-HOSO", remainingQuantityTons: 1000, expired: false },
        { lotId: "LOT-VAP", remainingQuantityTons: 300, expired: false },
      ],
    })
  );

  const expectedNewOvertimeCost = 800 * 0.3 * SALARY * OT_PREMIUM; // = 360,000
  assert.ok(
    Math.abs((result.manufacturingCost.overtimeCost as number) - expectedNewOvertimeCost) < EPS,
    `残業費総額 ${result.manufacturingCost.overtimeCost} ≠ 期待値 ${expectedNewOvertimeCost}`
  );

  const oldStyleOvertimeCost = 1000 * SALARY * quantityWeightedAvgRate * OT_PREMIUM; // ≈103,846（旧式・生産量加重平均ベース）
  assert.ok(
    Math.abs((result.manufacturingCost.overtimeCost as number) - oldStyleOvertimeCost) > 100_000,
    "新方式（人数ベース）は旧方式（生産量加重平均ベース）と大きく異なるはず"
  );
});

test("労務配分V2-2: 未配属（遊休）人員シナリオ（全社1000人のうち800人のみ配属・残業率10%）で、残業費は配属済み800人のみを基準に算定され、全社1000人は使われない", () => {
  const batch = makeBatch({
    assignedRegularHeadcount: 800,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0.1,
  });
  const { result } = close(makeState(), makeActuals({ batches: [batch], regularHeadcount: 1000 }));

  const expectedOvertimeCost = 800 * 0.1 * SALARY * OT_PREMIUM; // = 120,000（配属済み800人基準）
  const wrongIfUsingTotalHeadcount = 1000 * 0.1 * SALARY * OT_PREMIUM; // = 150,000（全社1000人を使った場合の誤り）
  assert.ok(Math.abs((result.manufacturingCost.overtimeCost as number) - expectedOvertimeCost) < EPS);
  assert.ok(Math.abs((result.manufacturingCost.overtimeCost as number) - wrongIfUsingTotalHeadcount) > EPS);

  // 一方、正社員給与そのものは遊休200人ぶんも含めた全社1000人ベースのまま（遊休人員にも給与は発生する）
  assert.equal(result.manufacturingCost.regularLaborCost as number, 1000 * SALARY);
});

test("労務配分V2-3: 遊休なし・全商品で残業率が同一の場合、新方式（人数ベース）と旧方式（会社全体平均×全社人数）の残業費総額は一致する", () => {
  const rate = 0.12;
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 600,
    adjustedTons: 600,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 400,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: rate,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 200,
    adjustedTons: 200,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 600,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: rate,
  });
  // 配属合計(400+600=1000) = 全社regularHeadcount(1000) → 遊休ゼロ
  const { result } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [hosoBatch, vapBatch],
      regularHeadcount: 1000,
      temporaryHeadcount: 0,
      appliedOvertimeRate: rate,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT-HOSO", remainingQuantityTons: 600, expired: false },
        { lotId: "LOT-VAP", remainingQuantityTons: 200, expired: false },
      ],
    })
  );
  const oldStyleOvertimeCost = 1000 * SALARY * rate * OT_PREMIUM;
  assert.ok(Math.abs((result.manufacturingCost.overtimeCost as number) - oldStyleOvertimeCost) < EPS);
});

test("労務配分V2-4: 全商品の適用残業率が0の場合、残業費総額は0となり、NaN・Infinityは発生しない", () => {
  const batch = makeBatch({
    assignedRegularHeadcount: 500,
    assignedTemporaryHeadcount: 50,
    appliedOvertimeRate: 0,
  });
  const { result } = close(makeState(), makeActuals({ batches: [batch], regularHeadcount: 500, temporaryHeadcount: 50 }));
  assert.equal(result.manufacturingCost.overtimeCost as number, 0);
  assert.ok(Number.isFinite(result.manufacturingCost.overtimeCost as number));
  assert.ok(Number.isFinite(result.balanceSheet.finishedGoodsInventory as number));
  assert.ok(Number.isFinite(result.profitAndLoss.netIncome as number));
});

test("労務配分V2-5: 残業費総額算定式の変更後も、BS貸借・CF直接法/間接法・利益剰余金ロールフォワードの恒等式が成立する（三表整合性）", () => {
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 1000,
    adjustedTons: 1000,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 300_000,
    rawMaterialCostBySourceUsd: { domestic: 300_000, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 200,
    assignedTemporaryHeadcount: 20,
    appliedOvertimeRate: 0,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 300,
    adjustedTons: 300,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 800,
    assignedTemporaryHeadcount: 80,
    appliedOvertimeRate: 0.3,
  });
  const state = makeState();
  const actuals = makeActuals({
    fulfillmentUsage: [{ contractId: "C1", lotId: "LOT-HOSO", product: "hoso", quantityTons: 100 }],
    contractTerms: [{ contractId: "C1", market: "US", product: "hoso", unitPriceUsdPerKg: 5.0 }],
    batches: [hosoBatch, vapBatch],
    regularHeadcount: 1000,
    temporaryHeadcount: 100,
    domesticPurchasesUsd: 300_000,
    rawMaterialInventoryEndUsd: 500_000,
    lotConsumption: [{ lotId: "LOT-HOSO", quantityTons: 100 }],
    finishedGoodsRemainingByLot: [
      { lotId: "LOT-HOSO", remainingQuantityTons: 900, expired: false },
      { lotId: "LOT-VAP", remainingQuantityTons: 300, expired: false },
    ],
  });
  const { result, nextState } = close(state, actuals);

  assert.ok(Math.abs(result.balanceSheet.balanceDifference as number) < EPS, `貸借差額: ${result.balanceSheet.balanceDifference}`);
  const cf = result.cashFlow;
  assert.ok(
    Math.abs((cf.netCashChange as number) - ((cf.operatingCashFlow as number) + (cf.investingCashFlow as number) + (cf.financingCashFlow as number))) <
      EPS
  );
  assert.ok(Math.abs((cf.closingCash as number) - ((cf.openingCash as number) + (cf.netCashChange as number))) < EPS);
  assert.ok(Math.abs(cf.directIndirectDifference as number) < EPS, `直接法と間接法の差: ${cf.directIndirectDifference}`);
  assert.ok(
    Math.abs((nextState.retainedEarnings as number) - ((state.retainedEarnings as number) + (result.profitAndLoss.netIncome as number))) < EPS
  );
});

test("労務配分V2-6: 商品別（正社員労務・臨時ワーカー・残業）配分の合計は会社全体の各費目総額と一致し、二重計上・計上漏れがない", () => {
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 500,
    adjustedTons: 500,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 200,
    assignedTemporaryHeadcount: 50,
    appliedOvertimeRate: 0.05,
  });
  const pdBatch = makeBatch({
    batchId: "B-PD",
    product: "pd",
    originalTons: 400,
    adjustedTons: 400,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-PD",
    downgradeRatio: 0,
    assignedRegularHeadcount: 300,
    assignedTemporaryHeadcount: 100,
    appliedOvertimeRate: 0.1,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 300,
    adjustedTons: 300,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 500,
    assignedTemporaryHeadcount: 150,
    appliedOvertimeRate: 0.2,
  });
  const { result, nextState } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [hosoBatch, pdBatch, vapBatch],
      regularHeadcount: 1200, // 配属合計1000 + 遊休200
      temporaryHeadcount: 300, // 配属合計300（遊休なし）
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT-HOSO", remainingQuantityTons: 500, expired: false },
        { lotId: "LOT-PD", remainingQuantityTons: 400, expired: false },
        { lotId: "LOT-VAP", remainingQuantityTons: 300, expired: false },
      ],
    })
  );

  // 会社全体の各費目総額（期待値）
  // 【feature/v2-idle-labor-cost】regularLaborCost(1,200,000)は会社全体の給与総額（遊休200人分を
  // 含む）のまま変わらないが、商品原価・完成品在庫へ吸収されるのは実配属1,000人分
  // （productiveRegularLaborCost = 1,000,000）だけであり、残り200人分（200,000）は
  // idleLaborCostとして分離される。
  const expectedRegularLaborCost = 1200 * SALARY; // 1,200,000（遊休200人ぶんも含む会社全体の給与総額）
  const expectedProductiveRegularLaborCost = 1000 * SALARY; // 1,000,000（実配属1,000人分のみ）
  const expectedIdleLaborCost = 200 * SALARY; // 200,000（遊休200人分）
  const expectedTemporaryWorkerCost = 300 * TEMP_RATE; // 240,000
  const expectedOvertimeCost = (200 * 0.05 + 300 * 0.1 + 500 * 0.2) * SALARY * OT_PREMIUM; // 140 × 1500 = 210,000

  assert.ok(Math.abs((result.manufacturingCost.regularLaborCost as number) - expectedRegularLaborCost) < EPS);
  assert.ok(
    Math.abs((result.manufacturingCost.productiveRegularLaborCost as number) - expectedProductiveRegularLaborCost) < EPS
  );
  assert.ok(Math.abs((result.manufacturingCost.idleLaborCost as number) - expectedIdleLaborCost) < EPS);
  assert.ok(
    Math.abs(
      ((result.manufacturingCost.productiveRegularLaborCost as number) + (result.manufacturingCost.idleLaborCost as number)) -
        (result.manufacturingCost.regularLaborCost as number)
    ) < EPS
  );
  assert.ok(Math.abs((result.manufacturingCost.temporaryWorkerCost as number) - expectedTemporaryWorkerCost) < EPS);
  assert.ok(Math.abs((result.manufacturingCost.overtimeCost as number) - expectedOvertimeCost) < EPS);

  // 商品別配分（台帳のunitCost×adjustedTons）を積み上げて、会社全体の「productive」費目総額と
  // 一致することを確認する（laborFixedPerTon×数量 = 実配属正社員労務費の商品別配分。遊休分は
  // 台帳・在庫には一切含まれない）。laborVariablePerTon×数量 = 臨時ワーカー費+残業費の商品別配分。
  let sumLaborFixed = 0;
  let sumLaborVariable = 0;
  for (const entry of nextState.finishedGoodsCostLedger) {
    sumLaborFixed += (entry.unitCost.laborFixedPerTon as number) * entry.remainingQuantity;
    sumLaborVariable += (entry.unitCost.laborVariablePerTon as number) * entry.remainingQuantity;
  }
  assert.ok(
    Math.abs(sumLaborFixed - expectedProductiveRegularLaborCost) < EPS,
    `Σ常用労務費配分 ${sumLaborFixed} ≠ ${expectedProductiveRegularLaborCost}`
  );
  assert.ok(
    Math.abs(sumLaborVariable - (expectedTemporaryWorkerCost + expectedOvertimeCost)) < EPS,
    `Σ変動労務費配分 ${sumLaborVariable} ≠ ${expectedTemporaryWorkerCost + expectedOvertimeCost}`
  );

  // costOfSales.idleLaborCostにも遊休労務費が独立項目として現れることを確認する
  // （販売数量に関わらず当期全額費用化。この四半期は消費・販売がないため全額idleのまま）。
  assert.ok(Math.abs((result.profitAndLoss.costOfSales.idleLaborCost as number) - expectedIdleLaborCost) < EPS);
});

test("労務配分V2-7: 実配属人数の合計が0（全バッチで常用/臨時とも未配属）の場合、臨時ワーカー費は数量シェアへフォールバックするが、正社員労務費は0商品原価へも配分されず全額idleLaborCostとなる（NaN・Infinityは発生しない）", () => {
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 600,
    adjustedTons: 600,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 0,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 400,
    adjustedTons: 400,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 0,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const { result, nextState } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [hosoBatch, vapBatch],
      regularHeadcount: 500,
      temporaryHeadcount: 100,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT-HOSO", remainingQuantityTons: 600, expired: false },
        { lotId: "LOT-VAP", remainingQuantityTons: 400, expired: false },
      ],
    })
  );
  assert.equal(result.manufacturingCost.overtimeCost as number, 0);
  for (const entry of nextState.finishedGoodsCostLedger) {
    assert.ok(Number.isFinite(entry.unitCost.laborFixedPerTon as number), "laborFixedPerTonがNaN/Infinityではない");
    assert.ok(Number.isFinite(entry.unitCost.laborVariablePerTon as number), "laborVariablePerTonがNaN/Infinityではない");
  }
  // 【feature/v2-idle-labor-cost】実配属人数の合計が0の場合、常用労務費はもはや数量シェアへ
  // フォールバックしない（フォールバックしてしまうと、誰も配属されていないのに完成品在庫へ
  // 正社員給与が入ってしまう）。会社全体の正社員給与500,000は全額idleLaborCostとなり、
  // 台帳(laborFixedPerTon)へは一切入らない。
  const hosoEntry = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-HOSO")!;
  const vapEntry = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-VAP")!;
  assert.equal(hosoEntry.unitCost.laborFixedPerTon as number, 0);
  assert.equal(vapEntry.unitCost.laborFixedPerTon as number, 0);
  assert.ok(Math.abs((result.manufacturingCost.idleLaborCost as number) - 500 * SALARY) < EPS);
  assert.ok(Math.abs((result.manufacturingCost.productiveRegularLaborCost as number) - 0) < EPS);
});

test("労務配分V2-8: 労働集約度が商品ごとに異なる場合（HOSO基準・PD≈3倍・VAP≈7倍の配属人数原単位）、労務単価(laborFixedPerTon)はVAP>PD>HOSOとなる（総原価の順位は主張しない）", () => {
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 1000,
    adjustedTons: 1000,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 100, // 0.1人/t
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const pdBatch = makeBatch({
    batchId: "B-PD",
    product: "pd",
    originalTons: 400,
    adjustedTons: 400,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-PD",
    downgradeRatio: 0,
    assignedRegularHeadcount: 120, // 0.3人/t = HOSOの3倍の原単位
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 200,
    adjustedTons: 200,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 140, // 0.7人/t = HOSOの7倍の原単位
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const { nextState } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [hosoBatch, pdBatch, vapBatch],
      regularHeadcount: 360, // 100+120+140、遊休なし
      temporaryHeadcount: 0,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT-HOSO", remainingQuantityTons: 1000, expired: false },
        { lotId: "LOT-PD", remainingQuantityTons: 400, expired: false },
        { lotId: "LOT-VAP", remainingQuantityTons: 200, expired: false },
      ],
    })
  );
  const hoso = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-HOSO")!.unitCost.laborFixedPerTon as number;
  const pd = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-PD")!.unitCost.laborFixedPerTon as number;
  const vap = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-VAP")!.unitCost.laborFixedPerTon as number;

  assert.ok(vap > pd && pd > hoso, `労務単価の順序が想定と異なる: hoso=${hoso}, pd=${pd}, vap=${vap}`);
  assert.ok(Math.abs(pd / hoso - 3) < 0.01, `PD/HOSO比 ${pd / hoso} ≠ 3`);
  assert.ok(Math.abs(vap / hoso - 7) < 0.01, `VAP/HOSO比 ${vap / hoso} ≠ 7`);
  // 総原価（rawMaterialPerTon等を含むtotalUnitCostPerTon）の順位はここでは主張しない。
});

test("労務配分V2-9: 商品別の実労務単位原価がFinishedGoodsCostLedgerEntry.unitCostへ正しく入り、販売分はCOGSへ・未販売分は同じ単価のまま期末完成品在庫へ、それぞれ新方式どおりに流れる", () => {
  // HOSO: 0.1人/t（1000t生産に100人配属、臨時0、残業0%）
  // VAP : 0.7人/t（500t生産に350人配属、臨時100人全員配属、残業率20%）→ HOSOの7倍の労働集約度
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 1000,
    adjustedTons: 1000,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 100,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 500,
    adjustedTons: 500,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 350,
    assignedTemporaryHeadcount: 100,
    appliedOvertimeRate: 0.2,
  });

  const { result, nextState } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [
        { contractId: "C-HOSO", lotId: "LOT-HOSO", product: "hoso", quantityTons: 600 },
        { contractId: "C-VAP", lotId: "LOT-VAP", product: "vap", quantityTons: 300 },
      ],
      contractTerms: [
        { contractId: "C-HOSO", market: "US", product: "hoso", unitPriceUsdPerKg: 5.0 },
        { contractId: "C-VAP", market: "US", product: "vap", unitPriceUsdPerKg: 8.0 },
      ],
      batches: [hosoBatch, vapBatch],
      regularHeadcount: 450, // 100+350、遊休なし
      temporaryHeadcount: 100, // 配属合計と一致、遊休なし
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [
        { lotId: "LOT-HOSO", quantityTons: 600 },
        { lotId: "LOT-VAP", quantityTons: 300 },
      ],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT-HOSO", remainingQuantityTons: 400, expired: false },
        { lotId: "LOT-VAP", remainingQuantityTons: 200, expired: false },
      ],
    })
  );

  // --- 1. 新方式どおりの期待単位原価（労務部分）を手計算し、台帳(unitCost)と一致することを確認 ---
  // regularLaborCost_total = 450×1000 = 450,000。配属人数シェア: HOSO 100/450, VAP 350/450。
  const expectedRegularLaborHoso = 450_000 * (100 / 450); // = 100,000
  const expectedRegularLaborVap = 450_000 * (350 / 450); // = 350,000
  // temporaryWorkerCost_total = 100×800 = 80,000。配属人数シェア: HOSO 0/100, VAP 100/100。
  const expectedTempVap = 80_000; // HOSOは0
  // overtimeWeight: HOSO=100×0=0, VAP=350×0.2=70 → overtimeCost_total=70×1000×1.5=105,000。
  const expectedOvertimeVap = 70 * SALARY * OT_PREMIUM; // = 105,000

  const expectedLaborFixedHoso = expectedRegularLaborHoso / 1000; // 100
  const expectedLaborFixedVap = expectedRegularLaborVap / 500; // 700
  const expectedLaborVariableHoso = 0;
  const expectedLaborVariableVap = (expectedTempVap + expectedOvertimeVap) / 500; // (80,000+105,000)/500 = 370

  const hosoEntry = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-HOSO")!;
  const vapEntry = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-VAP")!;
  assert.ok(Math.abs((hosoEntry.unitCost.laborFixedPerTon as number) - expectedLaborFixedHoso) < EPS);
  assert.ok(Math.abs((hosoEntry.unitCost.laborVariablePerTon as number) - expectedLaborVariableHoso) < EPS);
  assert.ok(Math.abs((vapEntry.unitCost.laborFixedPerTon as number) - expectedLaborFixedVap) < EPS);
  assert.ok(Math.abs((vapEntry.unitCost.laborVariablePerTon as number) - expectedLaborVariableVap) < EPS);

  // --- 2. 販売分（HOSO 600t、VAP 300t）のCOGSが、期待単位原価×販売数量と一致することを確認 ---
  // costOfSales.laborCostは全社合算値（販売分の変動労務＋固定労務の配賦）。
  const expectedSoldLaborHoso = (expectedLaborFixedHoso + expectedLaborVariableHoso) * 600; // 60,000
  const expectedSoldLaborVap = (expectedLaborFixedVap + expectedLaborVariableVap) * 300; // 321,000
  const expectedSoldLaborTotal = expectedSoldLaborHoso + expectedSoldLaborVap; // 381,000
  assert.ok(
    Math.abs((result.profitAndLoss.costOfSales.laborCost as number) - expectedSoldLaborTotal) < EPS,
    `COGS労務費 ${result.profitAndLoss.costOfSales.laborCost} ≠ 期待値 ${expectedSoldLaborTotal}`
  );

  // --- 3. 未販売分（HOSO 400t、VAP 200t）が、同じ単位原価のまま期末完成品在庫に残ることを確認 ---
  assert.equal(hosoEntry.remainingQuantity, 400);
  assert.equal(vapEntry.remainingQuantity, 200);
  const expectedEndingLaborHoso = (expectedLaborFixedHoso + expectedLaborVariableHoso) * 400; // 40,000
  const expectedEndingLaborVap = (expectedLaborFixedVap + expectedLaborVariableVap) * 200; // 214,000
  const expectedEndingLaborTotal = expectedEndingLaborHoso + expectedEndingLaborVap; // 254,000
  // 会社全体の完成品在庫金額（result.balanceSheet.finishedGoodsInventory）は原料費等も含むため、
  // 台帳から労務相当分だけを取り出して照合する。
  const actualEndingLaborTotal =
    (hosoEntry.unitCost.laborFixedPerTon as number) * hosoEntry.remainingQuantity +
    (hosoEntry.unitCost.laborVariablePerTon as number) * hosoEntry.remainingQuantity +
    (vapEntry.unitCost.laborFixedPerTon as number) * vapEntry.remainingQuantity +
    (vapEntry.unitCost.laborVariablePerTon as number) * vapEntry.remainingQuantity;
  assert.ok(Math.abs(actualEndingLaborTotal - expectedEndingLaborTotal) < EPS);

  // --- 4. 売上原価(labor)＋期末在庫(labor) = 当期発生労務費合計（二重計上・計上漏れがない） ---
  const totalLaborIncurred =
    (result.manufacturingCost.regularLaborCost as number) +
    (result.manufacturingCost.temporaryWorkerCost as number) +
    (result.manufacturingCost.overtimeCost as number);
  assert.ok(
    Math.abs((expectedSoldLaborTotal + expectedEndingLaborTotal) - totalLaborIncurred) < EPS,
    `COGS労務費+期末在庫労務費 ${expectedSoldLaborTotal + expectedEndingLaborTotal} ≠ 当期発生労務費合計 ${totalLaborIncurred}`
  );

  // --- 5. PL/BS/CFの整合性が維持されている ---
  assert.ok(Math.abs(result.balanceSheet.balanceDifference as number) < EPS, `貸借差額: ${result.balanceSheet.balanceDifference}`);
  const cf = result.cashFlow;
  assert.ok(
    Math.abs((cf.netCashChange as number) - ((cf.operatingCashFlow as number) + (cf.investingCashFlow as number) + (cf.financingCashFlow as number))) <
      EPS
  );
  assert.ok(Math.abs(cf.directIndirectDifference as number) < EPS, `直接法と間接法の差: ${cf.directIndirectDifference}`);
});

// =====================================================================
// feature/v2-idle-labor-cost:
// 未配属正社員給与（遊休労務費）を製品原価・完成品在庫から分離し、
// 発生四半期の売上原価区分・独立項目（idleLaborCost）として即時費用化する。
// =====================================================================

test("遊休労務費I-1(A): 一部未配属シナリオ（会社全体6,000人・実配属合計3,196.01人・単価$1,000）で、productiveRegularLaborCost/idleLaborCostが期待どおりに算定され、商品別吸収額も実配属人数×単価と一致する", () => {
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 1000,
    adjustedTons: 1000,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 1196.01,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 2000,
    adjustedTons: 2000,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 2000,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const { result, nextState } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [hosoBatch, vapBatch],
      regularHeadcount: 6000,
      temporaryHeadcount: 0,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT-HOSO", remainingQuantityTons: 1000, expired: false },
        { lotId: "LOT-VAP", remainingQuantityTons: 2000, expired: false },
      ],
    })
  );

  const expectedProductive = 3196.01 * SALARY; // 3,196,010
  const expectedIdle = (6000 - 3196.01) * SALARY; // 2,803,990
  assert.ok(Math.abs((result.manufacturingCost.productiveRegularLaborCost as number) - expectedProductive) < EPS);
  assert.ok(Math.abs((result.manufacturingCost.idleLaborCost as number) - expectedIdle) < EPS);
  assert.ok(
    Math.abs(
      ((result.manufacturingCost.productiveRegularLaborCost as number) + (result.manufacturingCost.idleLaborCost as number)) -
        (result.manufacturingCost.regularLaborCost as number)
    ) < EPS
  );
  assert.ok(Math.abs((result.manufacturingCost.regularLaborCost as number) - 6_000_000) < EPS);

  // 商品別吸収額 = 実配属人数×単価
  const hosoEntry = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-HOSO")!;
  const vapEntry = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-VAP")!;
  assert.ok(Math.abs((hosoEntry.unitCost.laborFixedPerTon as number) * 1000 - 1196.01 * SALARY) < EPS);
  assert.ok(Math.abs((vapEntry.unitCost.laborFixedPerTon as number) * 2000 - 2000 * SALARY) < EPS);

  // PLのidleLaborCostにも同額が独立項目として現れる
  assert.ok(Math.abs((result.profitAndLoss.costOfSales.idleLaborCost as number) - expectedIdle) < EPS);
});

test("遊休労務費I-2(B): 全員配属シナリオ（実配属合計=会社全体人数）では、idleLaborCostは0となり、常用労務費の商品原価吸収総額は本機能導入前と変わらない（=会社全体給与総額のまま）", () => {
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 300,
    adjustedTons: 300,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 300,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 700,
    adjustedTons: 700,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 700,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const { result, nextState } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [hosoBatch, vapBatch],
      regularHeadcount: 1000, // 300+700 = 1000、遊休なし
      temporaryHeadcount: 0,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT-HOSO", remainingQuantityTons: 300, expired: false },
        { lotId: "LOT-VAP", remainingQuantityTons: 700, expired: false },
      ],
    })
  );
  assert.equal(result.manufacturingCost.idleLaborCost as number, 0);
  assert.ok(Math.abs((result.manufacturingCost.productiveRegularLaborCost as number) - 1_000_000) < EPS);
  let sumLaborFixed = 0;
  for (const entry of nextState.finishedGoodsCostLedger) {
    sumLaborFixed += (entry.unitCost.laborFixedPerTon as number) * entry.remainingQuantity;
  }
  assert.ok(Math.abs(sumLaborFixed - (result.manufacturingCost.regularLaborCost as number)) < EPS);
  assert.equal(result.profitAndLoss.costOfSales.idleLaborCost as number, 0);
});

test("遊休労務費I-3(D): 実配属正社員数合計が会社全体人数を上回る（過剰配属）とFinanceValidationError。微小な浮動小数点誤差は許容する", () => {
  const overAssigned = makeBatch({ assignedRegularHeadcount: 700, assignedTemporaryHeadcount: 0, appliedOvertimeRate: 0 });
  assert.throws(
    () => close(makeState(), makeActuals({ batches: [overAssigned], regularHeadcount: 500 })),
    FinanceValidationError
  );

  // 許容差(HEADCOUNT_EPSILON)以内の超過は許容される
  const barelyOver = makeBatch({ assignedRegularHeadcount: 500.0000001, assignedTemporaryHeadcount: 0, appliedOvertimeRate: 0 });
  assert.doesNotThrow(() => close(makeState(), makeActuals({ batches: [barelyOver], regularHeadcount: 500 })));

  // 許容差を明確に超える超過は拒否される
  const slightlyOver = makeBatch({ assignedRegularHeadcount: 500.01, assignedTemporaryHeadcount: 0, appliedOvertimeRate: 0 });
  assert.throws(
    () => close(makeState(), makeActuals({ batches: [slightlyOver], regularHeadcount: 500 })),
    FinanceValidationError
  );
});

// ---------------------------------------------------------------------
// 【SAI-2最終化追加作業: 32Q完走修正】headcountBudgetTolerance
//
// 背景: production/labor.tsのallocateWorkersToPlansは、商品×工場別の
// assignedRegularHeadcountを各行独立にMath.round(x*1e6)/1e6で丸める。
// 丸め後の値を再合計するquarterClose.ts側では、バッチ数（行数）に比例して
// 丸め誤差が蓄積しうるため、固定許容差(旧HEADCOUNT_EPSILON=1e-6)だと
// バッチ数が2以上の会社で誤検知（実質的な不整合ではないのにFinanceValidationError）
// が発生していた（実測: 候補3・営業人員80人・32Qで12seed中5seedが発生）。
// ---------------------------------------------------------------------

test("headcountBudgetTolerance-1: バッチ数（rowCount）に比例して許容差が増える（丸め誤差の理論上限どおり）", () => {
  const t0 = headcountBudgetTolerance(0, 1000);
  const t1 = headcountBudgetTolerance(1, 1000);
  const t3 = headcountBudgetTolerance(3, 1000);
  const t10 = headcountBudgetTolerance(10, 1000);
  assert.ok(t0 < t1, "rowCount=0はrowCount=1より許容差が小さいはず");
  assert.ok(t1 < t3, "rowCount=1はrowCount=3より許容差が小さいはず");
  assert.ok(t3 < t10, "rowCount=3はrowCount=10より許容差が小さいはず");
  // 丸め単位1e-6・行ごとに最大1e-6/2の理論上限 + 規模に応じた微小な相対誤差、という設計どおりの桁感であること
  assert.ok(t3 > 1e-6, "3行分の丸め誤差蓄積は旧固定許容差1e-6を上回りうる設計であるべき（今回の修正の主目的）");
  assert.ok(t3 < 1e-4, "許容差が過大化していない（実質的な不整合の検出力を保っている）こと");
});

test("headcountBudgetTolerance-2: 会社規模（budget）に応じて許容差がわずかに増える（相対誤差成分）", () => {
  const small = headcountBudgetTolerance(3, 100);
  const large = headcountBudgetTolerance(3, 10000);
  assert.ok(large > small, "budgetが大きいほど許容差も（相対誤差分だけ）わずかに増えるはず");
  // 相対誤差成分は「丸め誤差の隠蔽」が目的ではないため、規模が変わっても支配的にならない
  assert.ok(large - small < 1e-4);
});

function makeZeroCostBatch(overrides: Partial<ProductionBatchActual> & { batchId: string; product: Product; lotId: string }): ProductionBatchActual {
  // FC-1等と同じパターン（原料コスト・在庫消費をゼロにし、労務許容差の検証だけに
  // 焦点を絞る）。3バッチを同時に使う際、makeBatch既定値のrawMaterialCostUsd/lotId
  // をそのまま3行分重ねると原料在庫フローの整合チェックに抵触してしまうため。
  return makeBatch({
    originalTons: 100,
    adjustedTons: 100,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    downgradeRatio: 0,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
    ...overrides,
  });
}

function makeZeroCostActuals(overrides: Partial<CompanyQuarterBusinessActuals> = {}): CompanyQuarterBusinessActuals {
  return makeActuals({
    fulfillmentUsage: [],
    contractTerms: [],
    domesticPurchasesUsd: 0,
    rawMaterialInventoryEndUsd: 500_000,
    lotConsumption: [],
    ...overrides,
  });
}

test("境界値: 商品数3行（HOSO/PD/VAP）で、各行が独立に丸め単位ギリギリまで上振れした合計は許容される（実測の32Q再現ケース）", () => {
  // production/labor.tsのMath.round(x*1e6)/1e6により、各行は最大0.5e-6まで上方へ丸められうる。
  // 3行合計で候補3の営業人員80人規模（会社全体では正社員数千人規模）を模した実測ケースを再現する。
  const regularHeadcount = 2380;
  // 3商品ぶんの「丸め後」の値。丸め前の真の合計はregularHeadcountと一致する想定だが、
  // 各行が独立に丸め単位の半分ずつ上振れした結果、合計が理論上の最大値に近い形で超過する
  // （実際に観測された超過量 約1.0000003e-6 と同オーダー）。
  const third = regularHeadcount / 3;
  const batches = [
    makeZeroCostBatch({ batchId: "B1", product: "hoso", lotId: "LOT-HOSO", assignedRegularHeadcount: Math.round(third * 1e6) / 1e6 + 4e-7 }),
    makeZeroCostBatch({ batchId: "B2", product: "pd", lotId: "LOT-PD", assignedRegularHeadcount: Math.round(third * 1e6) / 1e6 + 4e-7 }),
    makeZeroCostBatch({ batchId: "B3", product: "vap", lotId: "LOT-VAP", assignedRegularHeadcount: Math.round(third * 1e6) / 1e6 + 3e-7 }),
  ];
  assert.doesNotThrow(
    () =>
      close(
        makeState(),
        makeZeroCostActuals({
          batches,
          regularHeadcount,
          finishedGoodsRemainingByLot: [
            { lotId: "LOT-HOSO", remainingQuantityTons: 100, expired: false },
            { lotId: "LOT-PD", remainingQuantityTons: 100, expired: false },
            { lotId: "LOT-VAP", remainingQuantityTons: 100, expired: false },
          ],
        })
      ),
    "3行ぶんの丸め誤差の蓄積（1e-6強）は、実質的な不整合ではないため許容されるべき"
  );
});

test("明らかな不整合: 丸め誤差では説明できない規模の超過は、行数が多くても引き続き検出される", () => {
  // 3行あっても、1人単位で明らかに超過しているケース（丸め誤差の範囲を大きく超える）は
  // 引き続き「過剰配属」としてFinanceValidationErrorで検出されなければならない
  // （3項目の指定漏れ等、別の理由での例外と混同しないようメッセージ内容も確認する）。
  const batches = [
    makeZeroCostBatch({ batchId: "B1", product: "hoso", lotId: "LOT-HOSO", assignedRegularHeadcount: 500 }),
    makeZeroCostBatch({ batchId: "B2", product: "pd", lotId: "LOT-PD", assignedRegularHeadcount: 500 }),
    makeZeroCostBatch({ batchId: "B3", product: "vap", lotId: "LOT-VAP", assignedRegularHeadcount: 500 }),
  ];
  assert.throws(
    () =>
      close(
        makeState(),
        makeZeroCostActuals({
          batches,
          regularHeadcount: 1000, // 合計1500 > 1000
          finishedGoodsRemainingByLot: [
            { lotId: "LOT-HOSO", remainingQuantityTons: 100, expired: false },
            { lotId: "LOT-PD", remainingQuantityTons: 100, expired: false },
            { lotId: "LOT-VAP", remainingQuantityTons: 100, expired: false },
          ],
        })
      ),
    (err: unknown) => err instanceof FinanceValidationError && /過剰配属/.test((err as Error).message)
  );
});

test("遊休労務費I-4(E): 労働集約度の異なる2商品で、商品別正社員労務費は実配属人数基準、臨時ワーカー費・残業費は従来どおり実配属先へ、unitCostにも未販売の完成品在庫にも遊休労務費は一切含まれない", () => {
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 1000,
    adjustedTons: 1000,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 100,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 500,
    adjustedTons: 500,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 350,
    assignedTemporaryHeadcount: 100,
    appliedOvertimeRate: 0.2,
  });
  const { result, nextState } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [
        { contractId: "C-HOSO", lotId: "LOT-HOSO", product: "hoso", quantityTons: 600 },
        { contractId: "C-VAP", lotId: "LOT-VAP", product: "vap", quantityTons: 300 },
      ],
      contractTerms: [
        { contractId: "C-HOSO", market: "US", product: "hoso", unitPriceUsdPerKg: 5.0 },
        { contractId: "C-VAP", market: "US", product: "vap", unitPriceUsdPerKg: 8.0 },
      ],
      batches: [hosoBatch, vapBatch],
      regularHeadcount: 900, // 配属合計450 + 遊休450
      temporaryHeadcount: 100,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [
        { lotId: "LOT-HOSO", quantityTons: 600 },
        { lotId: "LOT-VAP", quantityTons: 300 },
      ],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT-HOSO", remainingQuantityTons: 400, expired: false },
        { lotId: "LOT-VAP", remainingQuantityTons: 200, expired: false },
      ],
    })
  );

  const hosoEntry = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-HOSO")!;
  const vapEntry = nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-VAP")!;

  // 商品別正社員労務費 = 実配属人数×単価（遊休分は一切含まれない）
  assert.ok(Math.abs((hosoEntry.unitCost.laborFixedPerTon as number) - (100 * SALARY) / 1000) < EPS);
  assert.ok(Math.abs((vapEntry.unitCost.laborFixedPerTon as number) - (350 * SALARY) / 500) < EPS);

  // 臨時ワーカー費・残業費は従来どおり実配属先(VAPのみ)へ計上される
  const expectedVapVariable = (100 * FINANCE_PARAMETERS_V1.labor.temporaryWorkerCostUsdPerQuarter + 350 * 0.2 * SALARY * OT_PREMIUM) / 500;
  assert.ok(Math.abs((vapEntry.unitCost.laborVariablePerTon as number) - expectedVapVariable) < EPS);
  assert.equal(hosoEntry.unitCost.laborVariablePerTon as number, 0);

  // 未販売の完成品在庫（HOSO400t・VAP200t）にも、同じunitCostのまま遊休労務費は含まれない
  assert.equal(hosoEntry.remainingQuantity, 400);
  assert.equal(vapEntry.remainingQuantity, 200);
  const idleLaborCost = result.manufacturingCost.idleLaborCost as number;
  assert.ok(idleLaborCost > 0, "遊休労務費が正であることを前提とする検証");
  // 在庫金額（労務相当分）には遊休労務費が全く混ざっていないことを、
  // 台帳の労務単価×在庫数量の合計が「productiveRegularLaborCostの未販売持分」とだけ
  // 一致することで確認する（idleLaborCostぶんは在庫のどこにも現れない）。
  const endingLaborFixed =
    (hosoEntry.unitCost.laborFixedPerTon as number) * hosoEntry.remainingQuantity +
    (vapEntry.unitCost.laborFixedPerTon as number) * vapEntry.remainingQuantity;
  assert.ok(endingLaborFixed < (result.manufacturingCost.productiveRegularLaborCost as number) + EPS);
});

test("遊休労務費I-5(F): 遊休労務費は発生四半期に全額費用化され、翌四半期以降に在庫を販売しても再度COGSへ計上されない", () => {
  // Q1: 会社全体1,000人のうち700人のみ配属（300人遊休）。1,000t生産し、当期は販売なし。
  const q1Batch = makeBatch({
    batchId: "B-HOSO-Q1",
    product: "hoso",
    originalTons: 1000,
    adjustedTons: 1000,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-Q1",
    downgradeRatio: 0,
    assignedRegularHeadcount: 700,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const q1 = close(
    makeState(),
    makeActuals({
      period: P1,
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [q1Batch],
      regularHeadcount: 1000,
      temporaryHeadcount: 0,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [],
      finishedGoodsRemainingByLot: [{ lotId: "LOT-Q1", remainingQuantityTons: 1000, expired: false }],
    })
  );
  const expectedIdleQ1 = 300 * SALARY; // 300,000
  assert.ok(Math.abs((q1.result.profitAndLoss.costOfSales.idleLaborCost as number) - expectedIdleQ1) < EPS);
  const q1LaborFixedPerTon = q1.nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-Q1")!.unitCost.laborFixedPerTon as number;
  assert.ok(Math.abs(q1LaborFixedPerTon - (700 * SALARY) / 1000) < EPS);

  // Q2: 生産なし（従業員データも供給しない=legacyモード）。Q1の在庫のうち400tを販売。
  const q2 = close(
    q1.nextState,
    makeActuals({
      period: P2,
      fulfillmentUsage: [{ contractId: "C-Q2", lotId: "LOT-Q1", product: "hoso", quantityTons: 400 }],
      contractTerms: [{ contractId: "C-Q2", market: "US", product: "hoso", unitPriceUsdPerKg: 5.0 }],
      batches: [],
      regularHeadcount: 0,
      temporaryHeadcount: 0,
      appliedOvertimeRate: 0,
      activeFactoryCount: 0,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryBeginUsd: 500_000,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [{ lotId: "LOT-Q1", quantityTons: 400 }],
      finishedGoodsRemainingByLot: [{ lotId: "LOT-Q1", remainingQuantityTons: 600, expired: false }],
    })
  );
  // Q2はQ1の遊休人員データを引き継がない（新たな遊休労務費は発生しない）
  assert.equal(q2.result.profitAndLoss.costOfSales.idleLaborCost as number, 0);
  // Q2のCOGS労務費は、Q1で台帳に記録された単価(productive分のみ)×販売数量とだけ一致し、
  // Q1のidleLaborCost(300,000)がここへ再計上されることはない。
  const expectedQ2LaborCogs = q1LaborFixedPerTon * 400;
  assert.ok(Math.abs((q2.result.profitAndLoss.costOfSales.laborCost as number) - expectedQ2LaborCogs) < EPS);
});

test("遊休労務費I-6(G): 遊休労務費導入後も、BS貸借一致・CF直接法/間接法一致・利益剰余金ロールフォワード・正社員給与現金支出総額の不変・二重計上/計上漏れ無しが成立する", () => {
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 1000,
    adjustedTons: 1000,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 200,
    assignedTemporaryHeadcount: 20,
    appliedOvertimeRate: 0,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 300,
    adjustedTons: 300,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 300_000,
    rawMaterialCostBySourceUsd: { domestic: 300_000, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 500,
    assignedTemporaryHeadcount: 80,
    appliedOvertimeRate: 0.3,
  });
  const state = makeState();
  const actuals = makeActuals({
    fulfillmentUsage: [{ contractId: "C1", lotId: "LOT-HOSO", product: "hoso", quantityTons: 100 }],
    contractTerms: [{ contractId: "C1", market: "US", product: "hoso", unitPriceUsdPerKg: 5.0 }],
    batches: [hosoBatch, vapBatch],
    regularHeadcount: 1000, // 配属合計700 + 遊休300
    temporaryHeadcount: 100,
    domesticPurchasesUsd: 300_000,
    rawMaterialInventoryEndUsd: 500_000,
    lotConsumption: [{ lotId: "LOT-HOSO", quantityTons: 100 }],
    finishedGoodsRemainingByLot: [
      { lotId: "LOT-HOSO", remainingQuantityTons: 900, expired: false },
      { lotId: "LOT-VAP", remainingQuantityTons: 300, expired: false },
    ],
  });
  const { result, nextState } = close(state, actuals);

  // BS貸借一致
  assert.ok(Math.abs(result.balanceSheet.balanceDifference as number) < EPS, `貸借差額: ${result.balanceSheet.balanceDifference}`);
  // CF直接法/間接法一致
  const cf = result.cashFlow;
  assert.ok(
    Math.abs((cf.netCashChange as number) - ((cf.operatingCashFlow as number) + (cf.investingCashFlow as number) + (cf.financingCashFlow as number))) <
      EPS
  );
  assert.ok(Math.abs(cf.directIndirectDifference as number) < EPS, `直接法と間接法の差: ${cf.directIndirectDifference}`);
  // 利益剰余金ロールフォワード
  assert.ok(
    Math.abs((nextState.retainedEarnings as number) - ((state.retainedEarnings as number) + (result.profitAndLoss.netIncome as number))) < EPS
  );
  // 正社員給与の現金支出総額は不変（会社全体regularHeadcount×単価。遊休分も全額現金支給される）
  assert.ok(Math.abs((result.manufacturingCost.regularLaborCost as number) - 1000 * SALARY) < EPS);

  // 二重計上・計上漏れ無し: Σ商品別吸収額(productive) + idleLaborCost = regularLaborCost総額
  let sumLaborFixed = 0;
  for (const entry of nextState.finishedGoodsCostLedger) {
    sumLaborFixed += (entry.unitCost.laborFixedPerTon as number) * entry.remainingQuantity;
  }
  // 販売済み100t分もCOGS側で吸収されているため、Σ(在庫+COGS)で全量を捕捉する
  const soldLaborFixed = 100 * ((nextState.finishedGoodsCostLedger.find((e) => e.lotId === "LOT-HOSO")?.unitCost.laborFixedPerTon as number) ?? 0);
  assert.ok(
    Math.abs(
      sumLaborFixed + soldLaborFixed + (result.manufacturingCost.idleLaborCost as number) - (result.manufacturingCost.regularLaborCost as number)
    ) < EPS
  );
});

test("遊休労務費I-7(H): actualモードでは遊休労務費を算定し、legacyモードでは常に0（従来どおり全額を商品原価へ配賦）となる", () => {
  const actualBatch = makeBatch({ assignedRegularHeadcount: 60, assignedTemporaryHeadcount: 0, appliedOvertimeRate: 0 });
  const actualResult = close(makeState(), makeActuals({ batches: [actualBatch], regularHeadcount: 100 }));
  assert.ok((actualResult.result.manufacturingCost.idleLaborCost as number) > 0, "actualモードでは遊休労務費が算定される");
  assert.ok(Math.abs((actualResult.result.manufacturingCost.idleLaborCost as number) - 40 * SALARY) < EPS);

  const legacyBatch = makeBatch({}); // assignedRegularHeadcount等を指定しない
  const legacyResult = close(makeState(), makeActuals({ batches: [legacyBatch], regularHeadcount: 100 }));
  assert.equal(legacyResult.result.manufacturingCost.idleLaborCost as number, 0, "legacyモードではidleLaborCostは常に0");
  assert.ok(Math.abs((legacyResult.result.manufacturingCost.productiveRegularLaborCost as number) - 100 * SALARY) < EPS);
});

// ---------------------------------------------------------------------
// Phase 8B-2B: 設備投資の操業・会計接続（capexAssetsDepreciationUsd・capexMaintenanceCostUsd）
// ---------------------------------------------------------------------
//
// capex/capexClose.tsを経由せず、closeFinancialQuarterへCapexAdjustmentを直接
// 手組みして渡すことで、finance/側の接続（既存レガシー定率法への加算・
// 売上原価区分への独立項目としての計上・在庫への非混入・現金支出・三表整合）
// だけを切り分けて検証する（capex/portfolio自体の状態遷移・支払処理は
// capex/__tests__/capexClose.test.tsが別途担う）。

function makeCapexAdjustment(overrides: Partial<CapexAdjustment> = {}): CapexAdjustment {
  return {
    capexPaymentCashUsd: 0,
    completedProjectsTransferUsd: 0,
    endingConstructionInProgressUsd: 0,
    nonDepreciatingCapexGrossAtPeriodStartUsd: 0,
    capexAssetsDepreciationUsd: 0,
    capexAssetsBuildingDepreciationUsd: 0,
    capexAssetsMachineryDepreciationUsd: 0,
    capexMaintenanceCostUsd: 0,
    ...overrides,
  };
}

test("capex操作-1: 新規completed資産の減価償却費は、既存資産2区分の減価償却結果へ単純加算される（両者は明確に区別された別計算式）", () => {
  const state = makeState({ fixedAssetsGross: usd(40_000_000), accumulatedDepreciation: usd(0) });
  const actuals = makeActuals();
  const existingOnly = closeFinancialQuarter(state, actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES);
  const existingAssetDepreciation = existingOnly.result.manufacturingCost.depreciationCost as number;
  const expectedExistingAssetDepreciation = computeExistingAssetDepreciationUsd(40_000_000, INITIAL_PERIOD_V2, actuals.period, FINANCE_PARAMETERS_V1).totalUsd;
  assert.ok(Math.abs(existingAssetDepreciation - expectedExistingAssetDepreciation) < EPS);

  const capex = makeCapexAdjustment({ capexAssetsDepreciationUsd: 200_000 });
  const withCapex = closeFinancialQuarter(state, actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES, undefined, capex);
  const combinedDepreciation = withCapex.result.manufacturingCost.depreciationCost as number;
  assert.ok(
    Math.abs(combinedDepreciation - (existingAssetDepreciation + 200_000)) < EPS,
    `合算後 ${combinedDepreciation} が 既存資産${existingAssetDepreciation}+capex200000 と一致しない`
  );
});

test("capex操作-2: 固定保守費（capexMaintenanceCost）は生産量に関わらず売上原価区分の独立項目として計上され、totalCostOfSalesへ一度だけ含まれる", () => {
  const state = makeState();
  const zeroProductionActuals = makeActuals({ batches: [], fulfillmentUsage: [], lotConsumption: [], finishedGoodsRemainingByLot: [] });
  const capex = makeCapexAdjustment({ capexMaintenanceCostUsd: 75_000 });
  const withCapex = closeFinancialQuarter(state, zeroProductionActuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES, undefined, capex);
  assert.ok(Math.abs((withCapex.result.profitAndLoss.costOfSales.capexMaintenanceCost as number) - 75_000) < EPS);

  const withoutCapex = closeFinancialQuarter(state, zeroProductionActuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES);
  const totalCostOfSalesDelta =
    (withCapex.result.profitAndLoss.totalCostOfSales as number) - (withoutCapex.result.profitAndLoss.totalCostOfSales as number);
  assert.ok(Math.abs(totalCostOfSalesDelta - 75_000) < EPS, "totalCostOfSalesの差がcapexMaintenanceCostちょうど1回ぶんではない（二重計上または欠落の疑い）");
});

test("capex操作-3: 固定保守費は完成品原価・単位原価台帳・完成品在庫へ一切含まれない（idleLaborCostと同じ非混入パターン）", () => {
  const state = makeState();
  const actuals = makeActuals(); // makeBatch()による通常生産（HOSO、45t在庫残）
  const withoutCapex = closeFinancialQuarter(state, actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES);
  const capex = makeCapexAdjustment({ capexMaintenanceCostUsd: 500_000 }); // 意図的に大きい額
  const withCapex = closeFinancialQuarter(state, actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES, undefined, capex);

  // 完成品在庫評価額（BS finishedGoodsInventory）は、固定保守費の有無で一切変化しないはず
  // （減価償却と異なり、capexMaintenanceCostは単位原価計算に一切関与しないため）。
  assert.ok(
    Math.abs((withCapex.result.balanceSheet.finishedGoodsInventory as number) - (withoutCapex.result.balanceSheet.finishedGoodsInventory as number)) < EPS
  );
  // 台帳の各ロットのunitCost内訳にも変化がないことを直接確認する。
  for (const entry of withCapex.nextState.finishedGoodsCostLedger) {
    const before = withoutCapex.nextState.finishedGoodsCostLedger.find((e) => e.lotId === entry.lotId)!;
    assert.deepEqual(entry.unitCost, before.unitCost, `ロット${entry.lotId}のunitCostがcapexMaintenanceCostの影響を受けている`);
  }
});

test("capex操作-4: 固定保守費は現金支出（営業CF）へ反映され、翌四半期へ再計上されない（当期一回のみ）", () => {
  const state = makeState();
  const actuals = makeActuals();
  const withoutCapex = closeFinancialQuarter(state, actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES);
  const capex = makeCapexAdjustment({ capexMaintenanceCostUsd: 60_000 });
  const withCapex = closeFinancialQuarter(state, actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES, undefined, capex);
  const cfoDelta =
    (withoutCapex.result.cashFlow.operatingCashFlow as number) - (withCapex.result.cashFlow.operatingCashFlow as number);
  assert.ok(Math.abs(cfoDelta - 60_000) < EPS, "固定保守費ぶん営業CFが減少していない");
  // 直接法・間接法の差は許容誤差内で0（idleLaborCost同様、非資産計上の現金費用は特別な間接法調整項目を要さない）。
  assert.ok(Math.abs(withCapex.result.cashFlow.directIndirectDifference as number) < EPS);
});

test("capex操作-5: 新規capex減価償却・固定保守費を含めても、BS貸借一致・CF直接法間接法一致・利益剰余金ロールフォワードが崩れない（三表整合）", () => {
  const state = makeState();
  const actuals = makeActuals();
  // CIPは「ending値」接続方式のため、この単発テストでは期首CIP=0という前提のもと
  // 内部整合的な値（期末CIP = 当期支払 − 当期完成振替）を選ぶ必要がある
  // （期首CIPを持たないこの単体テストの都合であり、capex/capexClose.ts自体は
  // 実際のportfolio状態から常に整合した値を算出する）。
  const capex = makeCapexAdjustment({
    capexPaymentCashUsd: 1_000_000,
    completedProjectsTransferUsd: 0,
    endingConstructionInProgressUsd: 1_000_000,
    nonDepreciatingCapexGrossAtPeriodStartUsd: 2_000_000,
    capexAssetsDepreciationUsd: 50_000,
    capexMaintenanceCostUsd: 30_000,
  });
  const { result, nextState } = closeFinancialQuarter(state, actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES, undefined, capex);
  assert.ok(Math.abs(result.balanceSheet.balanceDifference as number) < EPS, `貸借差額: ${result.balanceSheet.balanceDifference}`);
  assert.ok(Math.abs(result.cashFlow.directIndirectDifference as number) < EPS, `直接法/間接法差: ${result.cashFlow.directIndirectDifference}`);
  assert.ok(
    Math.abs((nextState.retainedEarnings as number) - ((state.retainedEarnings as number) + (result.profitAndLoss.netIncome as number))) < EPS
  );
  // 累計減価償却は取得原価（fixedAssetsGross）を超えない。
  assert.ok((nextState.accumulatedDepreciation as number) <= (nextState.fixedAssetsGross as number) + EPS);
});

test("capex省略時（undefined）はcapexAssetsDepreciationUsd/capexMaintenanceCostUsdの影響が一切なく、Phase 8A/8B-1と完全に同一の結果になる（後方互換）", () => {
  const state = makeState();
  const actuals = makeActuals();
  const withoutCapexArg = closeFinancialQuarter(state, actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES);
  const withZeroCapex = closeFinancialQuarter(state, actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES, undefined, makeCapexAdjustment());
  assert.deepEqual(withZeroCapex.result, withoutCapexArg.result);
  assert.deepEqual(withZeroCapex.nextState, withoutCapexArg.nextState);
});

// =====================================================================
// 商品別固定費配賦・労務費区分（management-accounting-only、財務会計とは完全並行）
// =====================================================================

function withManagementAccountingCoefficients(coeffs: Readonly<Record<Product, number>>): typeof FINANCE_PARAMETERS_V1 {
  return {
    ...FINANCE_PARAMETERS_V1,
    managementAccounting: { fixedCostAllocationCoefficientByProduct: coeffs },
  };
}

test("商品別固定費配賦FC-1: 3商品（実配属人数200/300/500、生産量500/400/300t、遊休200人）で、常用労務費配分は実配属人数比、共通工場・設備固定費配分は加工度ウェイト付き数量比（HOSO1.0/PD1.5/VAP2.4）となり、遊休労務費はどの商品にも配賦されない。当期に販売実績がない（fulfillmentUsage=[]）が生産はあった商品の直接固定費も欠落しない", () => {
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 500,
    adjustedTons: 500,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 200,
    assignedTemporaryHeadcount: 50,
    appliedOvertimeRate: 0.05,
  });
  const pdBatch = makeBatch({
    batchId: "B-PD",
    product: "pd",
    originalTons: 400,
    adjustedTons: 400,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-PD",
    downgradeRatio: 0,
    assignedRegularHeadcount: 300,
    assignedTemporaryHeadcount: 100,
    appliedOvertimeRate: 0.1,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 300,
    adjustedTons: 300,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 500,
    assignedTemporaryHeadcount: 150,
    appliedOvertimeRate: 0.2,
  });
  const { result } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [hosoBatch, pdBatch, vapBatch],
      regularHeadcount: 1200, // 配属合計1000 + 遊休200
      temporaryHeadcount: 300,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT-HOSO", remainingQuantityTons: 500, expired: false },
        { lotId: "LOT-PD", remainingQuantityTons: 400, expired: false },
        { lotId: "LOT-VAP", remainingQuantityTons: 300, expired: false },
      ],
    })
  );
  const cm = result.contributionMargin;
  // fulfillmentUsageが空でも、生産のあった3商品すべてがbyProductへ現れる
  // （生産のみ・未販売の商品の直接固定費が欠落しないことの確認）。
  assert.equal(cm.byProduct.length, 3);

  const productiveRegularLaborCost = result.manufacturingCost.productiveRegularLaborCost as number;
  assert.ok(Math.abs(productiveRegularLaborCost - 1000 * SALARY) < EPS); // 実配属合計1,000人分のみ
  const idleLaborCost = result.manufacturingCost.idleLaborCost as number;
  assert.ok(Math.abs(idleLaborCost - 200 * SALARY) < EPS); // 遊休200人分

  const commonFixedManufacturingCost =
    (result.manufacturingCost.factoryFixedCost as number) +
    (result.manufacturingCost.utilityFixedCost as number) +
    (result.manufacturingCost.depreciationCost as number);

  const weighted = { hoso: 500 * 1.0, pd: 400 * 1.5, vap: 300 * 2.4 };
  const totalWeighted = weighted.hoso + weighted.pd + weighted.vap;
  const laborShare = { hoso: 200 / 1000, pd: 300 / 1000, vap: 500 / 1000 };
  const expected: Record<string, number> = {
    hoso: productiveRegularLaborCost * laborShare.hoso + commonFixedManufacturingCost * (weighted.hoso / totalWeighted),
    pd: productiveRegularLaborCost * laborShare.pd + commonFixedManufacturingCost * (weighted.pd / totalWeighted),
    vap: productiveRegularLaborCost * laborShare.vap + commonFixedManufacturingCost * (weighted.vap / totalWeighted),
  };
  for (const p of cm.byProduct) {
    assert.ok(
      Math.abs((p.directFixedCost as number) - expected[p.key]) < EPS,
      `${p.key}: 直接固定費 ${p.directFixedCost} ≠ 期待値 ${expected[p.key]}`
    );
  }

  // 遊休労務費は商品原価配賦の対象外＝合計に含まれない。
  const totalDirect = cm.byProduct.reduce((s, p) => s + (p.directFixedCost as number), 0);
  assert.ok(Math.abs(totalDirect - (productiveRegularLaborCost + commonFixedManufacturingCost)) < EPS);
  assert.ok(Math.abs((cm.commonFixedCost as number) - ((cm.totalFixedCost as number) - totalDirect)) < EPS);
  assert.ok(
    Math.abs(
      (cm.commonFixedCost as number) - (idleLaborCost + (cm.fixedPersonnelCost as number) + (cm.fixedSellingAdminCost as number))
    ) < EPS,
    "commonFixedCostは遊休労務費＋営業調達人件費＋一般管理固定費と一致するはず"
  );
});

test("商品別固定費配賦FC-2: legacyモード（実配属人数データなし）の2商品（生産量300t/700t）では、常用労務費・共通工場固定費とも品質調整後数量（adjustedTons）シェアで配賦される（従来どおりのフォールバック）", () => {
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 300,
    adjustedTons: 300,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
  });
  const pdBatch = makeBatch({
    batchId: "B-PD",
    product: "pd",
    originalTons: 700,
    adjustedTons: 700,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-PD",
    downgradeRatio: 0,
  });
  const { result } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [hosoBatch, pdBatch],
      regularHeadcount: 100,
      temporaryHeadcount: 20,
      appliedOvertimeRate: 0.1,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT-HOSO", remainingQuantityTons: 300, expired: false },
        { lotId: "LOT-PD", remainingQuantityTons: 700, expired: false },
      ],
    })
  );
  assert.equal(resolveLaborAllocationMode([hosoBatch, pdBatch]), "legacy");
  const cm = result.contributionMargin;
  const productiveRegularLaborCost = result.manufacturingCost.productiveRegularLaborCost as number; // legacyはidle無し
  assert.ok(Math.abs(productiveRegularLaborCost - 100 * SALARY) < EPS);
  const commonFixedManufacturingCost =
    (result.manufacturingCost.factoryFixedCost as number) +
    (result.manufacturingCost.utilityFixedCost as number) +
    (result.manufacturingCost.depreciationCost as number);
  const weighted = { hoso: 300 * 1.0, pd: 700 * 1.5 };
  const totalWeighted = weighted.hoso + weighted.pd;
  const expected: Record<string, number> = {
    hoso: productiveRegularLaborCost * (300 / 1000) + commonFixedManufacturingCost * (weighted.hoso / totalWeighted),
    pd: productiveRegularLaborCost * (700 / 1000) + commonFixedManufacturingCost * (weighted.pd / totalWeighted),
  };
  for (const p of cm.byProduct) {
    assert.ok(Math.abs((p.directFixedCost as number) - expected[p.key]) < EPS, `${p.key}: ${p.directFixedCost} ≠ ${expected[p.key]}`);
  }
});

test("商品別固定費配賦FC-3: 当期に生産が全くない（batches=[]）場合、byProductは空配列となり、commonFixedCostはtotalFixedCostと一致する（ゼロ除算・NaN・Infinityは発生しない）", () => {
  const { result } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [],
      regularHeadcount: 50,
      temporaryHeadcount: 0,
      appliedOvertimeRate: 0,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [],
      finishedGoodsRemainingByLot: [],
    })
  );
  const cm = result.contributionMargin;
  assert.equal(cm.byProduct.length, 0);
  assert.ok(Number.isFinite(cm.commonFixedCost as number));
  assert.ok(Math.abs((cm.commonFixedCost as number) - (cm.totalFixedCost as number)) < EPS);
});

test("商品別固定費配賦FC-4: 実配属正社員数が商品によってはゼロ（HOSO=1000人・VAP=0人、臨時ワーカーのみで稼働）でも、VAPは常用労務費の直接配賦は0のまま共通工場・設備固定費は加工度ウェイト付き数量比で配賦される（NaN・Infinityは発生しない）", () => {
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 600,
    adjustedTons: 600,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 1000,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 200,
    adjustedTons: 200,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 0,
    assignedTemporaryHeadcount: 80,
    appliedOvertimeRate: 0,
  });
  const { result } = close(
    makeState(),
    makeActuals({
      fulfillmentUsage: [],
      contractTerms: [],
      batches: [hosoBatch, vapBatch],
      regularHeadcount: 1000,
      temporaryHeadcount: 80,
      appliedOvertimeRate: 0,
      domesticPurchasesUsd: 0,
      rawMaterialInventoryEndUsd: 500_000,
      lotConsumption: [],
      finishedGoodsRemainingByLot: [
        { lotId: "LOT-HOSO", remainingQuantityTons: 600, expired: false },
        { lotId: "LOT-VAP", remainingQuantityTons: 200, expired: false },
      ],
    })
  );
  const cm = result.contributionMargin;
  const vap = cm.byProduct.find((p) => p.key === "vap")!;
  const hoso = cm.byProduct.find((p) => p.key === "hoso")!;
  assert.ok(Number.isFinite(vap.directFixedCost as number));
  const commonFixedManufacturingCost =
    (result.manufacturingCost.factoryFixedCost as number) +
    (result.manufacturingCost.utilityFixedCost as number) +
    (result.manufacturingCost.depreciationCost as number);
  const weighted = { hoso: 600 * 1.0, vap: 200 * 2.4 };
  const totalWeighted = weighted.hoso + weighted.vap;
  const expectedVap = commonFixedManufacturingCost * (weighted.vap / totalWeighted); // 常用労務費配分は0
  const productiveRegularLaborCost = result.manufacturingCost.productiveRegularLaborCost as number;
  const expectedHoso = productiveRegularLaborCost * 1.0 + commonFixedManufacturingCost * (weighted.hoso / totalWeighted);
  assert.ok(Math.abs((vap.directFixedCost as number) - expectedVap) < EPS, `VAP: ${vap.directFixedCost} ≠ ${expectedVap}`);
  assert.ok(Math.abs((hoso.directFixedCost as number) - expectedHoso) < EPS, `HOSO: ${hoso.directFixedCost} ≠ ${expectedHoso}`);
});

test("商品別固定費配賦FC-5（受入条件・最重要）: managementAccounting.fixedCostAllocationCoefficientByProductを変えても、財務会計側の結果（PL/BS/CF/製造原価内訳/品質損失/コスト記録/利益差異調整/次期財務状態）は同一入力（同一state・同一actuals）に対して完全に不変。変わるのはContributionMarginReport.byProduct/commonFixedCostだけである", () => {
  const state = makeState();
  const hosoBatch = makeBatch({
    batchId: "B-HOSO",
    product: "hoso",
    originalTons: 500,
    adjustedTons: 500,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    assignedRegularHeadcount: 200,
    assignedTemporaryHeadcount: 50,
    appliedOvertimeRate: 0.05,
  });
  const pdBatch = makeBatch({
    batchId: "B-PD",
    product: "pd",
    originalTons: 400,
    adjustedTons: 400,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-PD",
    downgradeRatio: 0,
    assignedRegularHeadcount: 300,
    assignedTemporaryHeadcount: 100,
    appliedOvertimeRate: 0.1,
  });
  const vapBatch = makeBatch({
    batchId: "B-VAP",
    product: "vap",
    originalTons: 300,
    adjustedTons: 300,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: "LOT-VAP",
    downgradeRatio: 0,
    assignedRegularHeadcount: 500,
    assignedTemporaryHeadcount: 150,
    appliedOvertimeRate: 0.2,
  });
  const actuals = makeActuals({
    fulfillmentUsage: [],
    contractTerms: [],
    batches: [hosoBatch, pdBatch, vapBatch],
    regularHeadcount: 1200,
    temporaryHeadcount: 300,
    domesticPurchasesUsd: 0,
    rawMaterialInventoryEndUsd: 500_000,
    lotConsumption: [],
    finishedGoodsRemainingByLot: [
      { lotId: "LOT-HOSO", remainingQuantityTons: 500, expired: false },
      { lotId: "LOT-PD", remainingQuantityTons: 400, expired: false },
      { lotId: "LOT-VAP", remainingQuantityTons: 300, expired: false },
    ],
  });

  const baseline = closeFinancialQuarter(state, actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES);
  const withDifferentCoefficients = closeFinancialQuarter(
    state,
    actuals,
    withManagementAccountingCoefficients({ hoso: 1.0, pd: 1.0, vap: 1.0 }), // 一律1.0（従来の単純数量配賦相当）へ変更
    PROCESSING_RATES
  );

  // 財務会計側は完全に不変（唯一の受入条件）。
  assert.deepEqual(withDifferentCoefficients.result.profitAndLoss, baseline.result.profitAndLoss);
  assert.deepEqual(withDifferentCoefficients.result.balanceSheet, baseline.result.balanceSheet);
  assert.deepEqual(withDifferentCoefficients.result.cashFlow, baseline.result.cashFlow);
  assert.deepEqual(withDifferentCoefficients.result.manufacturingCost, baseline.result.manufacturingCost);
  assert.deepEqual(withDifferentCoefficients.result.qualityLoss, baseline.result.qualityLoss);
  assert.deepEqual(withDifferentCoefficients.result.costRecords, baseline.result.costRecords);
  assert.deepEqual(withDifferentCoefficients.result.absorptionVariableReconciliation, baseline.result.absorptionVariableReconciliation);
  assert.deepEqual(withDifferentCoefficients.nextState, baseline.nextState);

  // ContributionMarginReportのうち、商品別配賦に依存しない集計値も不変。
  const cmA = baseline.result.contributionMargin;
  const cmB = withDifferentCoefficients.result.contributionMargin;
  assert.equal(cmA.totalFixedCost as number, cmB.totalFixedCost as number);
  assert.equal(cmA.contributionMargin as number, cmB.contributionMargin as number);
  assert.equal(cmA.managementOperatingProfit as number, cmB.managementOperatingProfit as number);

  // 係数を変えると、商品別直接固定費の配賦だけは実際に変わる（=係数が一元管理された
  // パラメータから読まれており、コード中にハードコードされていないことの確認）。
  const pdA = cmA.byProduct.find((p) => p.key === "pd")!.directFixedCost as number;
  const pdB = cmB.byProduct.find((p) => p.key === "pd")!.directFixedCost as number;
  assert.notEqual(pdA, pdB);
  const vapA = cmA.byProduct.find((p) => p.key === "vap")!.directFixedCost as number;
  const vapB = cmB.byProduct.find((p) => p.key === "vap")!.directFixedCost as number;
  assert.notEqual(vapA, vapB);

  // それでも商品別直接固定費の合計＋commonFixedCost = totalFixedCostという恒等式はどちらでも成立する。
  const totalDirectA = cmA.byProduct.reduce((s, p) => s + (p.directFixedCost as number), 0);
  const totalDirectB = cmB.byProduct.reduce((s, p) => s + (p.directFixedCost as number), 0);
  assert.ok(Math.abs((cmA.commonFixedCost as number) - ((cmA.totalFixedCost as number) - totalDirectA)) < EPS);
  assert.ok(Math.abs((cmB.commonFixedCost as number) - ((cmB.totalFixedCost as number) - totalDirectB)) < EPS);
});
