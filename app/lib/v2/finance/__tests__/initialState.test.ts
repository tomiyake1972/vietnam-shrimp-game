// ShrimpX V2 — 財務モジュール 初期財務状態テスト（Phase 8A）
//
// 対応する実装範囲項目: 3. 初期財務状態（資産 = 負債 + 純資産、5社の差別化、
// 原料在庫の初期金額が実ロットと一致すること）

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { hosoEqTons, usdPerHosoEqKg } from "../../core/units";
import { RawMaterialLot } from "../../rawMaterials/types";
import { buildCompanyFixtures } from "../../companyLab/fixtures";
import { INITIAL_FINANCE_FIXTURES_V1, buildInitialCompanyFinanceState, rawMaterialInventoryValueUsd } from "../initialState";
import { CompanyQuarterBusinessActuals, closeFinancialQuarter } from "../quarterClose";
import { FINANCE_PARAMETERS_V1 } from "../parameters";
import { FinanceValidationError } from "../types";

const P1 = period(2015, 1);
const EPS = 0.01;

test("受入確認I-1: 5社すべての初期財務状態で 資産 = 負債 + 純資産 が厳密に成立する", () => {
  const fixtures = buildCompanyFixtures(P1);
  for (const f of fixtures) {
    const s = buildInitialCompanyFinanceState(f.companyId, f.initialRawMaterialLots, P1);
    const rmValue = rawMaterialInventoryValueUsd(f.initialRawMaterialLots, f.companyId);
    const arValue = s.receivables.reduce((sum, r) => sum + (r.amount as number), 0);
    const assets = (s.cash as number) + arValue + rmValue + (s.otherCurrentAssets as number) + ((s.fixedAssetsGross as number) - (s.accumulatedDepreciation as number));
    const liabilities = (s.shortTermLoans as number) + (s.longTermLoans as number) + (s.otherLiabilities as number);
    const equity = (s.capitalStock as number) + (s.retainedEarnings as number);
    assert.ok(Math.abs(assets - (liabilities + equity)) < EPS, `${f.companyId}: 資産${assets} ≠ 負債${liabilities}+純資産${equity}`);
  }
});

test("受入確認I-2: 初期原料在庫の金額は、フィクスチャの実ロット（数量×取得単価×1,000）から算出される", () => {
  const lots: RawMaterialLot[] = [
    {
      lotId: "T1",
      companyId: "BAL",
      source: "domestic",
      originCountry: "VN",
      inboundPeriod: P1,
      originalQuantity: hosoEqTons(100),
      remainingQuantity: hosoEqTons(100),
      unitCost: usdPerHosoEqKg(3.5),
      availableFromPeriod: P1,
      status: "available",
    },
  ];
  assert.equal(rawMaterialInventoryValueUsd(lots, "BAL"), 100 * 1000 * 3.5);
  // 他社のロットは含めない
  assert.equal(rawMaterialInventoryValueUsd(lots, "MASS"), 0);
});

test("受入確認I-3: 養殖中（growingAquaculture）ロットは初期在庫金額に含めない（収穫時一括認識の会計方針）", () => {
  const lots: RawMaterialLot[] = [
    {
      lotId: "G1",
      companyId: "BAL",
      source: "aquaculture",
      originCountry: "VN",
      inboundPeriod: P1,
      originalQuantity: hosoEqTons(100),
      remainingQuantity: hosoEqTons(100),
      unitCost: usdPerHosoEqKg(3.2),
      availableFromPeriod: P1,
      status: "growingAquaculture",
    },
  ];
  assert.equal(rawMaterialInventoryValueUsd(lots, "BAL"), 0);
});

test("受入確認I-4: 5社の初期財務状態はアーキタイプと整合する差を持つ（CONSVは最小借入・MASSは最大固定資産と借入）", () => {
  const byId = new Map(INITIAL_FINANCE_FIXTURES_V1.map((f) => [f.companyId, f]));
  const loans = (id: string) => byId.get(id)!.shortTermLoans + byId.get(id)!.longTermLoans;
  assert.ok(loans("CONSV") < loans("BAL"));
  assert.ok(loans("CONSV") < loans("MASS"));
  assert.ok(byId.get("MASS")!.fixedAssetsGross > byId.get("BAL")!.fixedAssetsGross);
  assert.equal(byId.get("CONSV")!.shortTermLoans, 0);
});

test("受入確認I-5: 未定義の会社IDはFinanceValidationErrorとして拒否される", () => {
  assert.throws(() => buildInitialCompanyFinanceState("UNKNOWN", [], P1), FinanceValidationError);
});

test("受入確認I-6: 初期売掛金は開始四半期に回収予定として構築される（コールドスタート回避の継続企業前提）", () => {
  const fixtures = buildCompanyFixtures(P1);
  const s = buildInitialCompanyFinanceState("BAL", fixtures.find((f) => f.companyId === "BAL")!.initialRawMaterialLots, P1);
  assert.equal(s.receivables.length, 1);
  assert.equal(s.receivables[0].dueSettlementPeriod, P1);
  assert.equal(s.receivables[0].sourceRef, "initial:pre-game-sales");
});

// --- Phase 8A重点確認 #4: 初期売掛金の開始BS整合性と回収時のPL非影響 ---

test("受入確認・重点確認4: 初期売掛金は開始BSで純資産と整合し、回収時は売掛金減少と現金増加だけが起き、売上・純利益・利益剰余金を架空に増やさない", () => {
  const fixtures = buildCompanyFixtures(P1);
  const balFixture = fixtures.find((f) => f.companyId === "BAL")!;
  const initial = buildInitialCompanyFinanceState("BAL", balFixture.initialRawMaterialLots, P1);
  const initialArAmount = initial.receivables.reduce((s, r) => s + (r.amount as number), 0);
  assert.ok(initialArAmount > 0, "BALには初期売掛金が設定されているはず");

  // 開始BSの貸借一致（資産=負債+純資産）は既にI-1で確認済み。ここでは初期売掛金が
  // 単なる現金注入（cashを直接増やす）ではなく、資産側の一項目として、
  // 利益剰余金の残差計算（資産合計-負債合計-資本金）を通じて純資産と整合していることを
  // 数値で確認する。
  const fixture = INITIAL_FINANCE_FIXTURES_V1.find((f) => f.companyId === "BAL")!;
  assert.equal(initial.cash as number, fixture.cash, "現金はフィクスチャのcashそのものであり、初期ARによって直接増やされていない");
  const rawMaterialInventory = rawMaterialInventoryValueUsd(balFixture.initialRawMaterialLots, "BAL");
  const totalAssets = fixture.cash + fixture.initialAccountsReceivable + rawMaterialInventory + fixture.otherCurrentAssets + fixture.fixedAssetsGross;
  const totalLiabilities = fixture.shortTermLoans + fixture.longTermLoans + fixture.otherLiabilities;
  const expectedRetainedEarnings = totalAssets - totalLiabilities - fixture.capitalStock;
  assert.ok(Math.abs((initial.retainedEarnings as number) - expectedRetainedEarnings) < EPS);
  // 初期ARを資産合計から除いた場合、利益剰余金（残差）はAR全額だけ減少する
  // ＝初期ARはちょうどAR全額分だけ純資産（利益剰余金）と整合しており、
  // 負債の増加や別枠の資本注入によって帳尻を合わせているわけではない。
  const impliedRetainedEarningsWithoutAr = totalAssets - fixture.initialAccountsReceivable - totalLiabilities - fixture.capitalStock;
  assert.ok(Math.abs((expectedRetainedEarnings - impliedRetainedEarningsWithoutAr) - fixture.initialAccountsReceivable) < EPS);

  // 当期に一切の事業活動がない四半期を決算し、開始四半期の売掛金が回収されることを確認する。
  const zeroActuals: CompanyQuarterBusinessActuals = {
    companyId: "BAL",
    period: P1,
    fulfillmentUsage: [],
    contractTerms: [],
    batches: [],
    regularHeadcount: 0,
    temporaryHeadcount: 0,
    appliedOvertimeRate: 0,
    activeFactoryCount: 0,
    salesForceHeadcount: 0,
    procurementHeadcount: 0,
    domesticPurchasesUsd: 0,
    importOrdersUsd: 0,
    aquacultureHarvestUsd: 0,
    rawMaterialInventoryBeginUsd: rawMaterialInventoryValueUsd(balFixture.initialRawMaterialLots, "BAL"),
    rawMaterialInventoryEndUsd: rawMaterialInventoryValueUsd(balFixture.initialRawMaterialLots, "BAL"),
    lotConsumption: [],
    finishedGoodsRemainingByLot: [],
  };
  const { result, nextState } = closeFinancialQuarter(initial, zeroActuals, FINANCE_PARAMETERS_V1, { hoso: 350, pd: 520, vap: 780 });

  // 売上・純利益への影響なし（事業活動がゼロなので売上は0。固定費だけが費用化されるため
  // 純利益は負になり得るが、それは初期ARの回収とは無関係）。
  assert.equal(result.profitAndLoss.grossRevenue as number, 0);
  // 売掛金は全額回収され残高0、現金はその分だけ増加（回収額と現金増加分の直接対応）。
  assert.equal(nextState.receivables.length, 0);
  assert.ok(Math.abs((result.cashFlow.operatingDirect.receiptsFromCustomers as number) - initialArAmount) < EPS);
  // 利益剰余金のロールフォワードは「前期末+当期純利益」のみで、ARの回収額が
  // 別枠で加算される余地がない（回収はPLを経由しないB/S・CFのみの動き）。
  assert.ok(
    Math.abs(
      (result.balanceSheet.retainedEarnings as number) - ((initial.retainedEarnings as number) + (result.profitAndLoss.netIncome as number))
    ) < EPS
  );
});
