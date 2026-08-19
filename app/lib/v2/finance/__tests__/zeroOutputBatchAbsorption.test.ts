// ShrimpX V2 — 会計整合性: 産出ゼロバッチの労務費が消失しない（DS3 BAL BS不一致のroot cause回帰）
//
// 【背景】DS3のBALで、Turn9以降 balanceDifference が -1.5M〜-4.6M USD で発生していた。
// 直接法CFOと間接法CFOの差が balanceDifference と厳密に一致しており、
// 「現金は支払われているのに、損益にも資産にも現れない製造費」が原因であることを特定した。
//
// 【root cause】finance/quarterClose.ts の原価配賦ループは、"actual" 労務モードにおいて
// 常用労務費を数量シェアではなく「そのバッチへ実際に配属された人数×単価」で決める。
// ところが在庫への振替は adjustedTons > 0 のバッチでしか行われないため、
// 「ワーカーを配属したが1トンも産出できなかった工場（原料不足・資金不足等）」の労務費は
//   ・在庫（完成品原価）へも入らない
//   ・idleLaborCost（＝どのバッチにも配属されなかった人員の給与）にも入らない
//   ・discardLoss（変動費単価×廃棄数量。originalTons=0では単価が0）にも入らない
// という三重の隙間に落ちて消えていた。給与は現金で支払われているため、
// 資産 < 負債+資本 となり貸借が崩れる。
//
// 会社・シナリオに依存しないEngine共通のedge caseであり、
// 「一部の工場だけが産出ゼロ」という状況が起きれば必ず発生する。
//
// 本テストは、その状況を最小構成で再現し、修正前なら貸借が崩れ、
// 修正後は貸借差額0かつ未吸収製造費として正しく期間費用になることを固定する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { Product } from "../../market/types";
import { FINANCE_PARAMETERS_V1 } from "../parameters";
import { CompanyQuarterBusinessActuals, ProductionBatchActual, closeFinancialQuarter } from "../quarterClose";
import { CompanyFinanceState, usd } from "../types";

const P1 = period(2015, 1);
const PROCESSING_RATES: Readonly<Record<Product, number>> = { hoso: 350, pd: 520, vap: 780 };
const SALARY = FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter;

function makeState(): CompanyFinanceState {
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
    distributableEarnings: usd(0),
    finishedGoodsCostLedger: [],
  };
}

/**
 * 2工場のうち片方だけが産出ゼロ（原料が届かず1トンも作れなかった）という状況。
 * 産出ゼロ側にも常用ワーカーが配属されており、給与は当然発生している。
 */
function makeActuals(zeroOutputRegularHeadcount: number): CompanyQuarterBusinessActuals {
  const producing: ProductionBatchActual = {
    batchId: "B-PRODUCING",
    factoryId: "F1",
    product: "hoso",
    originalTons: 100,
    adjustedTons: 100,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 300_000,
    rawMaterialCostBySourceUsd: { domestic: 300_000, imported: 0, aquaculture: 0 },
    lotId: "LOT1",
    downgradeRatio: 0,
    assignedRegularHeadcount: 60,
    assignedTemporaryHeadcount: 10,
    appliedOvertimeRate: 0.1,
  };
  // 原料が1トンも入らなかった工場。人は配属されているが産出は0。
  const idleFactory: ProductionBatchActual = {
    batchId: "B-ZERO-OUTPUT",
    factoryId: "F2",
    product: "hoso",
    originalTons: 0,
    adjustedTons: 0,
    discardTons: 0,
    reworkTons: 0,
    downgradeTons: 0,
    rawMaterialCostUsd: 0,
    rawMaterialCostBySourceUsd: { domestic: 0, imported: 0, aquaculture: 0 },
    lotId: undefined,
    downgradeRatio: 0,
    assignedRegularHeadcount: zeroOutputRegularHeadcount,
    assignedTemporaryHeadcount: 0,
    appliedOvertimeRate: 0,
  };
  return {
    companyId: "TEST",
    period: P1,
    fulfillmentUsage: [{ contractId: "C1", lotId: "LOT1", product: "hoso", quantityTons: 50 }],
    contractTerms: [{ contractId: "C1", market: "US", product: "hoso", unitPriceUsdPerKg: 5.0 }],
    batches: [producing, idleFactory],
    regularHeadcount: 60 + zeroOutputRegularHeadcount,
    temporaryHeadcount: 10,
    appliedOvertimeRate: 0.1,
    activeFactoryCount: 2,
    salesForceHeadcount: 5,
    procurementHeadcount: 5,
    domesticPurchasesUsd: 300_000,
    importOrdersUsd: 0,
    aquacultureHarvestUsd: 0,
    rawMaterialInventoryBeginUsd: 500_000,
    rawMaterialInventoryEndUsd: 500_000,
    lotConsumption: [{ lotId: "LOT1", quantityTons: 50 }],
    finishedGoodsRemainingByLot: [{ lotId: "LOT1", remainingQuantityTons: 50, expired: false }],
  };
}

test("ZOB-1: 産出ゼロ工場へ配属された常用労務費が消えず、未吸収製造費として当期費用になる", () => {
  const ZERO_OUTPUT_HEADCOUNT = 40;
  const out = closeFinancialQuarter(makeState(), makeActuals(ZERO_OUTPUT_HEADCOUNT), FINANCE_PARAMETERS_V1, PROCESSING_RATES);
  const unabsorbed = out.result.profitAndLoss.costOfSales.unabsorbedFixedManufacturingCost as unknown as number;
  assert.equal(
    unabsorbed,
    ZERO_OUTPUT_HEADCOUNT * SALARY,
    "産出ゼロ工場へ配属されていた人数ぶんの給与が、そのまま未吸収製造費として認識されるはず"
  );
});

test("ZOB-2: 産出ゼロ工場があっても貸借が一致する（root cause回帰）", () => {
  const out = closeFinancialQuarter(makeState(), makeActuals(40), FINANCE_PARAMETERS_V1, PROCESSING_RATES);
  const bs = out.result.balanceSheet;
  assert.ok(
    Math.abs(bs.balanceDifference as unknown as number) < 0.01,
    `貸借差額が0でない: ${bs.balanceDifference as unknown as number}`
  );
  assert.ok(
    Math.abs(out.result.cashFlow.directIndirectDifference as unknown as number) < 0.01,
    "直接法CFOと間接法CFOが一致するはず（不一致は必ず貸借差額として現れる）"
  );
});

test("ZOB-3: 産出ゼロ工場の労務費はidleLaborCostとは別物であり、二重計上しない", () => {
  const out = closeFinancialQuarter(makeState(), makeActuals(40), FINANCE_PARAMETERS_V1, PROCESSING_RATES);
  const cos = out.result.profitAndLoss.costOfSales;
  const mc = out.result.manufacturingCost;
  // 全員どこかのバッチへ配属されているため、未配属＝idleLaborCostは0。
  assert.equal(cos.idleLaborCost as unknown as number, 0, "未配属人員はいないのでidleLaborCostは0");
  assert.equal(
    (mc.productiveRegularLaborCost as unknown as number) + (cos.idleLaborCost as unknown as number),
    mc.regularLaborCost as unknown as number,
    "常用労務費の総額は productive + idle に厳密に分解される"
  );
  // 産出ゼロぶんは productiveRegularLaborCost に含まれたまま、未吸収製造費として費用化される。
  assert.equal(cos.unabsorbedFixedManufacturingCost as unknown as number, 40 * SALARY);
});

test("ZOB-4: 産出ゼロ工場が無い通常ケースでは未吸収製造費0のまま（既存挙動を変えない）", () => {
  const actuals = makeActuals(0);
  // 産出ゼロバッチ自体を取り除いた、完全な通常ケース。
  const normal: CompanyQuarterBusinessActuals = {
    ...actuals,
    batches: [actuals.batches[0]],
    regularHeadcount: 60,
    activeFactoryCount: 1,
  };
  const out = closeFinancialQuarter(makeState(), normal, FINANCE_PARAMETERS_V1, PROCESSING_RATES);
  assert.equal(out.result.profitAndLoss.costOfSales.unabsorbedFixedManufacturingCost as unknown as number, 0);
  assert.ok(Math.abs(out.result.balanceSheet.balanceDifference as unknown as number) < 0.01);
});

test("ZOB-5: 会社全体が産出ゼロ（従来からの退化ケース）では、従来どおり固定製造費の全額が未吸収になる", () => {
  const actuals = makeActuals(0);
  const allZero: CompanyQuarterBusinessActuals = {
    ...actuals,
    batches: [
      { ...actuals.batches[1], assignedRegularHeadcount: 60, assignedTemporaryHeadcount: 10, appliedOvertimeRate: 0.1 },
    ],
    regularHeadcount: 60,
    fulfillmentUsage: [],
    contractTerms: [],
    lotConsumption: [],
    finishedGoodsRemainingByLot: [],
    activeFactoryCount: 1,
  };
  const out = closeFinancialQuarter(makeState(), allZero, FINANCE_PARAMETERS_V1, PROCESSING_RATES);
  const cos = out.result.profitAndLoss.costOfSales;
  const mc = out.result.manufacturingCost;
  // 固定製造費（常用労務＋工場固定費＋固定ユーティリティ＋減価償却）が全額未吸収。
  const expectedFixed =
    (mc.productiveRegularLaborCost as unknown as number) +
    (mc.factoryFixedCost as unknown as number) +
    (mc.utilityFixedCost as unknown as number) +
    (mc.depreciationCost as unknown as number);
  assert.equal(cos.unabsorbedFixedManufacturingCost as unknown as number > 0, true);
  assert.ok(
    Math.abs((cos.unabsorbedFixedManufacturingCost as unknown as number) - (expectedFixed + (mc.temporaryWorkerCost as unknown as number) + (mc.overtimeCost as unknown as number))) < 0.01,
    "全社産出ゼロでは固定製造費＋変動労務が全額未吸収になる（従来の挙動）"
  );
  assert.ok(Math.abs(out.result.balanceSheet.balanceDifference as unknown as number) < 0.01);
});
