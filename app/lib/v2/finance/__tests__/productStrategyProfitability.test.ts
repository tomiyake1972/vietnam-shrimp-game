// ShrimpX V2 — 商品戦略別 収益性比較レポート テスト（feature/v2-product-strategy-economics）

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { Product } from "../../market/types";
import { FINANCE_PARAMETERS_V1 } from "../parameters";
import { CompanyQuarterBusinessActuals, ProductionBatchActual, closeFinancialQuarter } from "../quarterClose";
import { CompanyFinanceState, usd } from "../types";
import type { Factory, WorkerAllocationEntry } from "../../production/types";
import type { CompanySalesPlanEntry } from "../../sales/types";
import type { CapexProjectQuarterEvent } from "../../capex/types";
import { computeProductStrategyProfitabilityReport } from "../productStrategyProfitability";
import { hosoEqTons, ratio } from "../../core/units";

const P1 = period(2015, 1);
const EPS = 1e-6;

const PROCESSING_RATES: Readonly<Record<Product, number>> = { hoso: 350, pd: 520, vap: 1200 };

function makeState(overrides: Partial<CompanyFinanceState> = {}): CompanyFinanceState {
  return {
    companyId: "TEST",
    cash: usd(10_000_000),
    receivables: [],
    payables: [],
    otherCurrentAssets: usd(200_000),
    fixedAssetsGross: usd(40_000_000),
    accumulatedDepreciation: usd(0),
    shortTermLoans: usd(10_000_000),
    longTermLoans: usd(5_000_000),
    otherLiabilities: usd(300_000),
    capitalStock: usd(30_000_000),
    retainedEarnings: usd(4_700_000),
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
    adjustedTons: 100,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 300_000,
    rawMaterialCostBySourceUsd: { domestic: 300_000, imported: 0, aquaculture: 0 },
    lotId: "LOT-HOSO",
    downgradeRatio: 0,
    ...overrides,
  };
}

function makeActuals(overrides: Partial<CompanyQuarterBusinessActuals> = {}): CompanyQuarterBusinessActuals {
  return {
    companyId: "TEST",
    period: P1,
    // 100t生産のうち60tのみ当期販売し、40tは期末在庫として残す
    // （§7在庫回転テストで期末完成品在庫が非ゼロになるようにするため）。
    fulfillmentUsage: [{ contractId: "C1", lotId: "LOT-HOSO", product: "hoso", quantityTons: 60 }],
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
    lotConsumption: [{ lotId: "LOT-HOSO", quantityTons: 60 }],
    finishedGoodsRemainingByLot: [{ lotId: "LOT-HOSO", remainingQuantityTons: 40, expired: false }],
    ...overrides,
  };
}

function makeFactory(overrides: Partial<Factory> = {}): Factory {
  return {
    factoryId: "F1",
    companyId: "TEST",
    status: "active",
    commonProcessingCapacity: hosoEqTons(5000),
    hosoCapacity: hosoEqTons(3000),
    pdCapacity: hosoEqTons(1500),
    vapCapacity: hosoEqTons(500),
    freezingPackagingCapacity: hosoEqTons(5000),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// 単純ケース（商品1つ・単純な数値）で各指標の計算式を検証する
// ---------------------------------------------------------------------

function closeSimple() {
  const state = makeState();
  const actuals = makeActuals();
  return closeFinancialQuarter(state, actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES);
}

test("§1 トンあたり限界利益: HOSOのcontributionMarginUsd÷tonsSoldと一致する", () => {
  const { result, nextState } = closeSimple();
  const workerAllocations: WorkerAllocationEntry[] = [
    { factoryId: "F1", companyId: "TEST", product: "hoso", assignedRegularHeadcount: 80, assignedTemporaryHeadcount: 10, appliedOvertimeRate: ratio(0.1), laborCapacity: hosoEqTons(100) },
  ];
  const salesPlanEntries: CompanySalesPlanEntry[] = [
    { companyId: "TEST", market: "US", product: "hoso", desiredQuantity: hosoEqTons(100), priceAdjustmentUsdPerHosoEqKg: 0, salesForceHeadcount: 5 },
  ];
  const report = computeProductStrategyProfitabilityReport({
    companyId: "TEST",
    period: P1,
    actuals: makeActuals(),
    financialResult: result,
    financeParameters: FINANCE_PARAMETERS_V1,
    prevFinanceState: makeState(),
    nextFinanceState: nextState,
    workerAllocations,
    salesPlanEntries,
    factories: [makeFactory()],
    capexEvents: [],
  });

  const hoso = report.byProduct.find((p) => p.product === "hoso")!;
  const cmDim = result.contributionMargin.byProduct.find((d) => d.key === "hoso")!;
  assert.equal(hoso.tonsSold, 60);
  assert.ok(Math.abs(hoso.contributionMarginUsd - (cmDim.contributionMargin as number)) < EPS);
  assert.ok(Math.abs((hoso.contributionMarginPerTonUsd as number) - hoso.contributionMarginUsd / 60) < EPS);

  // §2 ワーカーあたり限界利益: 90人（常用80+臨時10）で割る
  assert.equal(hoso.workerHeadcount, 90);
  assert.ok(Math.abs((hoso.contributionMarginPerWorkerUsd as number) - hoso.contributionMarginUsd / 90) < EPS);

  // §3 営業人員あたり限界利益
  assert.equal(hoso.salesForceHeadcount, 5);
  assert.ok(Math.abs((hoso.contributionMarginPerSalespersonUsd as number) - hoso.contributionMarginUsd / 5) < EPS);

  // §4 設備能力単位あたり利益: capacityはactive工場のhosoCapacity合計=3000、
  // operatingProfitAttributable = contributionMargin - directFixedCost
  assert.equal(hoso.capacityUnitsHosoEqTons, 3000);
  const expectedOpProfit = hoso.contributionMarginUsd - (cmDim.directFixedCost as number);
  assert.ok(Math.abs(hoso.operatingProfitAttributableUsd - expectedOpProfit) < EPS);
  assert.ok(Math.abs((hoso.profitPerCapacityUnitUsd as number) - expectedOpProfit / 3000) < EPS);

  // 生産のなかった商品（pd/vap）は tonsSold=0・workerHeadcount=0等 → 比率はundefined
  const pd = report.byProduct.find((p) => p.product === "pd")!;
  assert.equal(pd.tonsSold, 0);
  assert.equal(pd.contributionMarginPerTonUsd, undefined);
  assert.equal(pd.contributionMarginPerWorkerUsd, undefined);
  assert.equal(pd.contributionMarginPerSalespersonUsd, undefined);
});

test("§5 ROIC: NOPAT = operatingProfit×(1-税率)、investedCapital = 自己資本+短期借入+長期借入", () => {
  const { result, nextState } = closeSimple();
  const report = computeProductStrategyProfitabilityReport({
    companyId: "TEST",
    period: P1,
    actuals: makeActuals(),
    financialResult: result,
    financeParameters: FINANCE_PARAMETERS_V1,
    prevFinanceState: makeState(),
    nextFinanceState: nextState,
    workerAllocations: [],
    salesPlanEntries: [],
    factories: [makeFactory()],
    capexEvents: [],
  });

  const operatingProfit = result.profitAndLoss.operatingProfit as number;
  const expectedNopat = operatingProfit * (1 - FINANCE_PARAMETERS_V1.finance.incomeTaxRate);
  assert.ok(Math.abs(report.nopatUsd - expectedNopat) < EPS);

  const bs = result.balanceSheet;
  const expectedInvestedCapital = (bs.totalEquity as number) + (bs.shortTermLoans as number) + (bs.longTermLoans as number);
  assert.ok(Math.abs(report.investedCapitalUsd - expectedInvestedCapital) < EPS);
  assert.ok(Math.abs((report.roic as number) - expectedNopat / expectedInvestedCapital) < EPS);
});

test("§6 必要運転資本: (AR+原料在庫+完成品在庫+その他流動資産) − (AP+その他負債)、現金・有利子負債は除く", () => {
  const { result, nextState } = closeSimple();
  const report = computeProductStrategyProfitabilityReport({
    companyId: "TEST",
    period: P1,
    actuals: makeActuals(),
    financialResult: result,
    financeParameters: FINANCE_PARAMETERS_V1,
    prevFinanceState: makeState(),
    nextFinanceState: nextState,
    workerAllocations: [],
    salesPlanEntries: [],
    factories: [makeFactory()],
    capexEvents: [],
  });
  const bs = result.balanceSheet;
  const expected =
    (bs.accountsReceivable as number) +
    (bs.rawMaterialInventory as number) +
    (bs.finishedGoodsInventory as number) +
    (bs.otherCurrentAssets as number) -
    ((bs.accountsPayable as number) + (bs.otherLiabilities as number));
  assert.ok(Math.abs(report.requiredWorkingCapitalUsd - expected) < EPS);
});

test("§7 在庫回転: 原料費÷平均原料在庫、総売上原価÷平均完成品在庫（会社レベル）", () => {
  const { result, nextState } = closeSimple();
  const actuals = makeActuals();
  const prevState = makeState();
  const report = computeProductStrategyProfitabilityReport({
    companyId: "TEST",
    period: P1,
    actuals,
    financialResult: result,
    financeParameters: FINANCE_PARAMETERS_V1,
    prevFinanceState: prevState,
    nextFinanceState: nextState,
    workerAllocations: [],
    salesPlanEntries: [],
    factories: [makeFactory()],
    capexEvents: [],
  });
  const avgRaw = (actuals.rawMaterialInventoryBeginUsd + (result.balanceSheet.rawMaterialInventory as number)) / 2;
  const expectedRawTurnover = (result.profitAndLoss.costOfSales.rawMaterialCost as number) / avgRaw;
  assert.ok(Math.abs((report.rawMaterialInventoryTurnover as number) - expectedRawTurnover) < EPS);

  // 期首（prevState）は完成品在庫ゼロ、期末（nextState）はLOT-HOSOの残数量分だけ計上される
  const beginFg = prevState.finishedGoodsCostLedger.reduce((s) => s, 0); // 0
  const endFg = nextState.finishedGoodsCostLedger.reduce((s, e) => {
    const u = e.unitCost;
    return (
      s +
      e.remainingQuantity *
        (u.rawMaterialPerTon + u.processingPerTon + u.laborVariablePerTon + u.utilityVariablePerTon + u.laborFixedPerTon + u.factoryFixedPerTon + u.utilityFixedPerTon + u.depreciationPerTon)
    );
  }, 0);
  const avgFg = (beginFg + endFg) / 2;
  const expectedFgTurnover = (result.profitAndLoss.totalCostOfSales as number) / avgFg;
  assert.ok(Math.abs((report.finishedGoodsInventoryTurnover as number) - expectedFgTurnover) < EPS);
});

test("§8 戦略固有投資控除後利益: PD機械化・品質保証投資は当期支払額を抽出、調達スケール・VAP商品開発は追跡不能のためnull", () => {
  const { result, nextState } = closeSimple();
  const capexEvents: CapexProjectQuarterEvent[] = [
    { projectId: "P-PD-1", projectType: "pdMechanization", statusBefore: "underConstruction", statusAfter: "underConstruction", paymentAttempted: true, paymentSucceededUsd: 150_000, reasons: [] },
    { projectId: "P-QA-1", projectType: "qualityControlEquipment", statusBefore: "underConstruction", statusAfter: "underConstruction", paymentAttempted: true, paymentSucceededUsd: 80_000, reasons: [] },
    // 生産能力とは無関係の他タイプ案件は集計対象外であることを確認する
    { projectId: "P-HOSO-1", projectType: "hosoLineExpansion", statusBefore: "underConstruction", statusAfter: "underConstruction", paymentAttempted: true, paymentSucceededUsd: 999_999, reasons: [] },
  ];
  const report = computeProductStrategyProfitabilityReport({
    companyId: "TEST",
    period: P1,
    actuals: makeActuals(),
    financialResult: result,
    financeParameters: FINANCE_PARAMETERS_V1,
    prevFinanceState: makeState(),
    nextFinanceState: nextState,
    workerAllocations: [],
    salesPlanEntries: [],
    factories: [makeFactory()],
    capexEvents,
  });
  const d = report.strategyInvestmentDeduction;
  assert.equal(d.pdMechanizationSpendUsd, 150_000);
  assert.equal(d.qualityAssuranceInvestmentSpendUsd, 80_000);
  assert.equal(d.trackedStrategyInvestmentSpendUsd, 230_000);
  assert.equal(d.procurementRelationshipSpendUsd, null);
  assert.equal(d.vapProductDevelopmentSpendUsd, null);
  assert.equal(d.isComplete, false);
  const expectedProfit = (result.profitAndLoss.operatingProfit as number) - 230_000;
  assert.ok(Math.abs(d.operatingProfitAfterTrackedStrategyInvestmentUsd - expectedProfit) < EPS);
});

test("戦略固有投資イベントが0件でも、未追跡分はnullのまま(0円で捏造しない)、追跡分の控除額は0", () => {
  const { result, nextState } = closeSimple();
  const report = computeProductStrategyProfitabilityReport({
    companyId: "TEST",
    period: P1,
    actuals: makeActuals(),
    financialResult: result,
    financeParameters: FINANCE_PARAMETERS_V1,
    prevFinanceState: makeState(),
    nextFinanceState: nextState,
    workerAllocations: [],
    salesPlanEntries: [],
    factories: [makeFactory()],
    capexEvents: [],
  });
  const d = report.strategyInvestmentDeduction;
  assert.equal(d.pdMechanizationSpendUsd, 0);
  assert.equal(d.qualityAssuranceInvestmentSpendUsd, 0);
  assert.equal(d.procurementRelationshipSpendUsd, null);
  assert.equal(d.vapProductDevelopmentSpendUsd, null);
});

// ---------------------------------------------------------------------
// VAP高マージン・非高収益デモンストレーション（実装指示の核心要件）
//
// 【シナリオ】HOSO・PD・VAPの3商品を同時生産・販売する。VAPは契約単価が
// 最も高く（$9.5/kg）、trong per-ton限界利益が3商品中最大になる。しかし
// VAP生産は加工費が高く（processing rate 1200 vs hoso 350）・労働集約的
// （多くのワーカーを要する）・営業人員も多く要し・当四半期に品質保証投資
// （capex qualityControlEquipment）を集中的に投じているとする。この結果、
// per-worker・per-salesperson・per-capacity-unitの各指標ではHOSO/PDの方が
// VAPを上回り、単純な「トンあたり限界利益が高い商品が常に最良」という
// 誤解を、既存のContributionMarginReport.byProductだけでは検出できないことを
// 示す（実装指示の核心デモンストレーション）。
// ---------------------------------------------------------------------

test("VAPはトンあたり限界利益が最大でも、ワーカー・営業人員・設備能力あたりの利益ではHOSO/PDに劣後しうる", () => {
  const batches: ProductionBatchActual[] = [
    makeBatch({
      batchId: "B-HOSO",
      product: "hoso",
      originalTons: 1000,
      adjustedTons: 950,
      discardTons: 50,
      rawMaterialCostUsd: 3_000_000, // $3.0/kg×1000t
      rawMaterialCostBySourceUsd: { domestic: 3_000_000, imported: 0, aquaculture: 0 },
      lotId: "LOT-HOSO",
      downgradeRatio: 0,
    }),
    makeBatch({
      batchId: "B-PD",
      product: "pd",
      originalTons: 600,
      adjustedTons: 570,
      discardTons: 30,
      rawMaterialCostUsd: 1_800_000, // $3.0/kg×600t
      rawMaterialCostBySourceUsd: { domestic: 1_800_000, imported: 0, aquaculture: 0 },
      lotId: "LOT-PD",
      downgradeRatio: 0,
    }),
    makeBatch({
      batchId: "B-VAP",
      product: "vap",
      originalTons: 300,
      adjustedTons: 285,
      discardTons: 15,
      rawMaterialCostUsd: 900_000, // $3.0/kg×300t
      rawMaterialCostBySourceUsd: { domestic: 900_000, imported: 0, aquaculture: 0 },
      lotId: "LOT-VAP",
      downgradeRatio: 0,
    }),
  ];
  const actuals = makeActuals({
    fulfillmentUsage: [
      { contractId: "C-HOSO", lotId: "LOT-HOSO", product: "hoso", quantityTons: 950 },
      { contractId: "C-PD", lotId: "LOT-PD", product: "pd", quantityTons: 570 },
      { contractId: "C-VAP", lotId: "LOT-VAP", product: "vap", quantityTons: 285 },
    ],
    contractTerms: [
      { contractId: "C-HOSO", market: "US", product: "hoso", unitPriceUsdPerKg: 5.0 },
      { contractId: "C-PD", market: "US", product: "pd", unitPriceUsdPerKg: 6.5 },
      { contractId: "C-VAP", market: "US", product: "vap", unitPriceUsdPerKg: 9.5 },
    ],
    batches,
    regularHeadcount: 600,
    temporaryHeadcount: 60,
    activeFactoryCount: 1,
    salesForceHeadcount: 40,
    // 原料在庫フロー整合: 期首500,000 + 仕入X - 消費(3,000,000+1,800,000+900,000) = 期末500,000
    // なので仕入X = 5,700,000（原料在庫は期を通じて変化しない設定）。
    domesticPurchasesUsd: 5_700_000,
    lotConsumption: [
      { lotId: "LOT-HOSO", quantityTons: 950 },
      { lotId: "LOT-PD", quantityTons: 570 },
      { lotId: "LOT-VAP", quantityTons: 285 },
    ],
    finishedGoodsRemainingByLot: [
      { lotId: "LOT-HOSO", remainingQuantityTons: 0, expired: false },
      { lotId: "LOT-PD", remainingQuantityTons: 0, expired: false },
      { lotId: "LOT-VAP", remainingQuantityTons: 0, expired: false },
    ],
  });
  const { result, nextState } = closeFinancialQuarter(makeState(), actuals, FINANCE_PARAMETERS_V1, PROCESSING_RATES);

  // VAPのトンあたり限界利益が3商品中最大であることを、まず確認する
  // （加工費が高くても、契約単価のプレミアムがそれを上回る前提のシナリオ）。
  const cmHoso = result.contributionMargin.byProduct.find((d) => d.key === "hoso")!;
  const cmPd = result.contributionMargin.byProduct.find((d) => d.key === "pd")!;
  const cmVap = result.contributionMargin.byProduct.find((d) => d.key === "vap")!;
  const perTonHoso = (cmHoso.contributionMargin as number) / 950;
  const perTonPd = (cmPd.contributionMargin as number) / 570;
  const perTonVap = (cmVap.contributionMargin as number) / 285;
  assert.ok(perTonVap > perTonPd, `VAP per-ton(${perTonVap}) should exceed PD per-ton(${perTonPd})`);
  assert.ok(perTonVap > perTonHoso, `VAP per-ton(${perTonVap}) should exceed HOSO per-ton(${perTonHoso})`);

  // VAPは労働集約的（多くのワーカー）・営業人員も多く要し・設備能力あたりの
  // 専用ラインも小さい、という戦略特性を反映した実配属データを与える。
  const workerAllocations: WorkerAllocationEntry[] = [
    { factoryId: "F1", companyId: "TEST", product: "hoso", assignedRegularHeadcount: 200, assignedTemporaryHeadcount: 20, appliedOvertimeRate: ratio(0.1), laborCapacity: hosoEqTons(950) },
    { factoryId: "F1", companyId: "TEST", product: "pd", assignedRegularHeadcount: 150, assignedTemporaryHeadcount: 15, appliedOvertimeRate: ratio(0.1), laborCapacity: hosoEqTons(570) },
    { factoryId: "F1", companyId: "TEST", product: "vap", assignedRegularHeadcount: 250, assignedTemporaryHeadcount: 25, appliedOvertimeRate: ratio(0.1), laborCapacity: hosoEqTons(285) },
  ];
  const salesPlanEntries: CompanySalesPlanEntry[] = [
    { companyId: "TEST", market: "US", product: "hoso", desiredQuantity: hosoEqTons(950), priceAdjustmentUsdPerHosoEqKg: 0, salesForceHeadcount: 8 },
    { companyId: "TEST", market: "US", product: "pd", desiredQuantity: hosoEqTons(570), priceAdjustmentUsdPerHosoEqKg: 0, salesForceHeadcount: 8 },
    { companyId: "TEST", market: "US", product: "vap", desiredQuantity: hosoEqTons(285), priceAdjustmentUsdPerHosoEqKg: 0, salesForceHeadcount: 24 },
  ];
  // VAP専用ラインは高価な専用設備を要するため、稼働率が低くても大きめの
  // 設備能力（capacityUnitsHosoEqTons）を確保している、という戦略特性を反映する
  // （少量生産に対して相対的に大きな設備投資能力を持つ＝設備能力あたり利益が
  // 見劣りする、というVAP差別化戦略の典型的な経済特性）。
  const factories: Factory[] = [
    makeFactory({ hosoCapacity: hosoEqTons(3000), pdCapacity: hosoEqTons(1500), vapCapacity: hosoEqTons(2500) }),
  ];
  // VAP差別化戦略は当四半期、品質保証投資（qualityControlEquipment）へ集中投資している。
  const capexEvents: CapexProjectQuarterEvent[] = [
    { projectId: "P-QA-1", projectType: "qualityControlEquipment", statusBefore: "underConstruction", statusAfter: "underConstruction", paymentAttempted: true, paymentSucceededUsd: 500_000, reasons: [] },
  ];

  const report = computeProductStrategyProfitabilityReport({
    companyId: "TEST",
    period: P1,
    actuals,
    financialResult: result,
    financeParameters: FINANCE_PARAMETERS_V1,
    prevFinanceState: makeState(),
    nextFinanceState: nextState,
    workerAllocations,
    salesPlanEntries,
    factories,
    capexEvents,
  });

  const hoso = report.byProduct.find((p) => p.product === "hoso")!;
  const pd = report.byProduct.find((p) => p.product === "pd")!;
  const vap = report.byProduct.find((p) => p.product === "vap")!;

  // トンあたり限界利益ではVAPが最大（前提の確認）
  assert.ok((vap.contributionMarginPerTonUsd as number) > (hoso.contributionMarginPerTonUsd as number));
  assert.ok((vap.contributionMarginPerTonUsd as number) > (pd.contributionMarginPerTonUsd as number));

  // しかし、労働集約度・営業人員の割り当て・設備能力あたりで見ると、
  // VAPはHOSO・PDに劣後する（=「トンあたり限界利益が高い」ことが
  // 「投入資源あたりの収益性が高い」ことを自動的には意味しない、という
  // 実装指示の核心デモンストレーション）。
  assert.ok(
    (vap.contributionMarginPerWorkerUsd as number) < (hoso.contributionMarginPerWorkerUsd as number),
    `VAP per-worker CM(${vap.contributionMarginPerWorkerUsd}) should be lower than HOSO(${hoso.contributionMarginPerWorkerUsd})`
  );
  assert.ok(
    (vap.contributionMarginPerSalespersonUsd as number) < (hoso.contributionMarginPerSalespersonUsd as number),
    `VAP per-salesperson CM(${vap.contributionMarginPerSalespersonUsd}) should be lower than HOSO(${hoso.contributionMarginPerSalespersonUsd})`
  );
  assert.ok(
    (vap.profitPerCapacityUnitUsd as number) < (pd.profitPerCapacityUnitUsd as number),
    `VAP profit/capacity(${vap.profitPerCapacityUnitUsd}) should be lower than PD(${pd.profitPerCapacityUnitUsd})`
  );

  // §8: VAP差別化戦略の品質保証投資($500,000)を営業利益から控除すると、
  // 「見かけ上のトンあたりマージン優位」が全社利益ベースではさらに目減りする
  // ことを確認する（過大評価を防ぐ最終チェック）。
  const d = report.strategyInvestmentDeduction;
  assert.equal(d.qualityAssuranceInvestmentSpendUsd, 500_000);
  assert.ok(d.operatingProfitAfterTrackedStrategyInvestmentUsd < (result.profitAndLoss.operatingProfit as number));
});
