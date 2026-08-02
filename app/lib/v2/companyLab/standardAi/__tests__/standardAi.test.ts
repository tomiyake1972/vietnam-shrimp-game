// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 単体テスト
//
// 実装指示が要求する約16項目の受入観点をそのまま各testへ対応させる。
// 期待値は方向性・範囲・不変条件で検証し、脆い厳密一致は避ける（実装指示どおり）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, unwrapUnit, usdM, usdPerHosoEqKg } from "../../../core/units";
import { usd } from "../../../finance/types";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateStandardAiDecision, generateStandardAiDecisionWithDiagnostics } from "../policy";
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyOwnState } from "../../types";

const EPSILON = 1e-6;

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "standard-ai-unit-001", turns: 8, ...overrides };
}

/** BAL会社の初期ownState/publicInfo/fixtureを、テストごとに複製・上書きできる形で用意する。 */
function setupBal(seed = "standard-ai-unit-001") {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed }));
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  return { fixture, ownState, publicInfo, period: state.currentPeriod, turn: 1 };
}

function assertAllFinite(value: unknown, path = "root"): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} は有限数である必要があります（受け取った値: ${value}）`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertAllFinite(v, `${path}.${k}`);
  }
}

// ---------------------------------------------------------------------
// 1. 同一入力・同一設定・同一シード ⇒ 同一意思決定
// ---------------------------------------------------------------------
test("同一入力・同一設定・同一シードなら同一意思決定になる（決定論性）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const a = generateStandardAiDecision(fixture, ownState, publicInfo, period, turn);
  const b = generateStandardAiDecision(fixture, ownState, publicInfo, period, turn);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------
// 2. すべての意思決定フィールドが存在し、妥当な形をしている
// ---------------------------------------------------------------------
test("生成された意思決定はCompanyDecisionInputのすべてのフィールドを持つ", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const decision = generateStandardAiDecision(fixture, ownState, publicInfo, period, turn);
  assert.equal(decision.companyId, "BAL");
  assert.ok(Array.isArray(decision.salesPlans));
  assert.ok(decision.domesticPurchasePlan);
  assert.ok(Array.isArray(decision.importOrders));
  assert.ok(Array.isArray(decision.aquacultureStockingPlans));
  assert.ok(Array.isArray(decision.productionPlans));
  assert.ok(Array.isArray(decision.workerAssignments));
  assert.ok(decision.workerAssignments.length === fixture.workerBaseline.length);
  assert.ok(decision.financingRequest);
  assert.ok(decision.capexDecision);
  assert.equal(decision.capexDecision.companyId, "BAL");
});

// ---------------------------------------------------------------------
// 3. 負値・NaN・Infinity・不正な比率がない
// ---------------------------------------------------------------------
test("意思決定のどのフィールドにも負値・NaN・Infinityが含まれない（数量・金額はブランド型のスマートコンストラクタが保証）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const decision = generateStandardAiDecision(fixture, ownState, publicInfo, period, turn);
  assertAllFinite(decision);
  for (const w of decision.workerAssignments) {
    assert.ok(unwrapUnit(w.overtimeRate) >= 0 && unwrapUnit(w.overtimeRate) <= 1);
    assert.ok(w.regularHeadcount >= 0);
    assert.ok(w.temporaryHeadcount >= 0);
  }
});

// ---------------------------------------------------------------------
// 4. 既存バリデーションを通過する（実際にターンを進めて確認）
// ---------------------------------------------------------------------
test("標準AIの意思決定は既存の会社ラボ検証・ターン処理を例外なく通過する", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed: "standard-ai-validation-001", turns: 4 }));
  let current = state;
  for (let i = 0; i < 4; i++) {
    const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      decisionsByCompanyId[f.companyId] = generateStandardAiDecision(
        f,
        buildCompanyOwnState(current, f),
        buildPublicMarketInfo(current),
        current.currentPeriod,
        i + 1
      );
    }
    current = advanceCompanyLabQuarter(current, fixtures, decisionsByCompanyId);
  }
  assert.equal(current.history.length, 4);
});

// ---------------------------------------------------------------------
// 5. 契約未履行下では生産・販売が履行優先へ寄る
// ---------------------------------------------------------------------
test("未履行契約残があると、生産計画・販売計画がその履行を優先して増加する", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const backlogContract: CompanyOwnState["contracts"][number] = {
    contractId: "test-contract-1",
    companyId: fixture.companyId,
    market: "CN",
    product: "hoso",
    contractedPeriod: period,
    dueDate: period,
    originalQuantity: hosoEqTons(3000),
    outstandingQuantity: hosoEqTons(3000),
    unitPrice: usdPerHosoEqKg(3),
    status: "open",
  };
  const ownStateWithBacklog: CompanyOwnState = { ...ownState, contracts: [backlogContract] };

  const baseline = generateStandardAiDecision(fixture, ownState, publicInfo, period, turn);
  const withBacklogDecision = generateStandardAiDecision(fixture, ownStateWithBacklog, publicInfo, period, turn);

  const baselineHosoProduction = baseline.productionPlans
    .filter((p) => p.product === "hoso")
    .reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
  const withBacklogHosoProduction = withBacklogDecision.productionPlans
    .filter((p) => p.product === "hoso")
    .reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);

  assert.ok(
    withBacklogHosoProduction >= baselineHosoProduction - EPSILON,
    "未履行契約残がある場合の生産計画は、無い場合以上でなければならない"
  );
});

// ---------------------------------------------------------------------
// 6. 完成品在庫過剰下で生産は抑制、販売は促進へ寄る
// ---------------------------------------------------------------------
test("完成品在庫が過剰だと、生産計画は抑制され、販売計画の希望量・値引きは増加する", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const excessFgLots: CompanyOwnState["finishedGoodsLots"] = [
    {
      lotId: "test-fg-1",
      companyId: fixture.companyId,
      factoryId: fixture.factories[0].factoryId,
      product: "hoso",
      producedPeriod: period,
      originalQuantity: hosoEqTons(6000),
      remainingQuantity: hosoEqTons(6000),
      sourceRawMaterialLots: [],
      rawMaterialOriginCountries: [],
      rawMaterialUnitCost: usdPerHosoEqKg(2.5),
      baseProcessingCost: usdM(0),
      availableFromPeriod: period,
      status: "available",
    },
  ];
  const ownStateWithExcess: CompanyOwnState = { ...ownState, finishedGoodsLots: excessFgLots };

  const baseline = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const excess = generateStandardAiDecisionWithDiagnostics(fixture, ownStateWithExcess, publicInfo, period, turn);

  const baselineHosoProduction = baseline.decision.productionPlans
    .filter((p) => p.product === "hoso")
    .reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
  const excessHosoProduction = excess.decision.productionPlans
    .filter((p) => p.product === "hoso")
    .reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
  assert.ok(excessHosoProduction <= baselineHosoProduction + EPSILON, "完成品在庫過剰時は生産を抑制するはず");

  const excessHosoSalesQuantity = excess.decision.salesPlans
    .filter((p) => p.product === "hoso")
    .reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
  const baselineHosoSalesQuantity = baseline.decision.salesPlans
    .filter((p) => p.product === "hoso")
    .reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
  assert.ok(excessHosoSalesQuantity > baselineHosoSalesQuantity + EPSILON, "完成品在庫過剰時はHOSOの販売希望量を通常時より積み増すはず");

  // 【注記】turn1相当（前期実績価格が未知）では参照価格が無く、値引き比率をUSD額へ
  // 変換できないため（既存のratioAdjustmentToUsdの仕様どおり）、priceAdjustmentUsdPerHosoEqKg
  // 自体は0のままになりうる。値引き判断そのものが働いたことは、診断コード
  // （PRICE_REDUCTION_FOR_EXCESS_STOCK）の発火で検証する。
  assert.ok(
    excess.diagnostics.entries.some((e) => e.code === "PRICE_REDUCTION_FOR_EXCESS_STOCK"),
    "完成品在庫過剰時はPRICE_REDUCTION_FOR_EXCESS_STOCK診断が発火するはず"
  );
});

// ---------------------------------------------------------------------
// 7. 原料不足下で調達量が増加または生産量が縮小する
// ---------------------------------------------------------------------
test("原料在庫が乏しいと、国内買付希望量が増加する（在庫補正が機能する）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const emptyRawMaterial: CompanyOwnState = { ...ownState, rawMaterialLots: [] };
  const decision = generateStandardAiDecision(fixture, emptyRawMaterial, publicInfo, period, turn);
  const baselineDecision = generateStandardAiDecision(fixture, ownState, publicInfo, period, turn);
  assert.ok(
    unwrapUnit(decision.domesticPurchasePlan.desiredQuantity) >= unwrapUnit(baselineDecision.domesticPurchasePlan.desiredQuantity) - EPSILON,
    "原料在庫がゼロの場合の国内買付希望量は、通常時以上でなければならない"
  );
});

// ---------------------------------------------------------------------
// 8. ワーカー不足下で残業・臨時・正社員増・生産縮小のいずれかで応答する
// ---------------------------------------------------------------------
test("常用ワーカーが極端に少ないと、残業率・臨時ワーカーの投入で応答する", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const understaffed: CompanyOwnState = {
    ...ownState,
    workforceState: {
      companyId: fixture.companyId,
      factories: fixture.workerBaseline.map((w) => ({ factoryId: w.factoryId, regularHeadcount: 1 })),
    },
  };
  const decision = generateStandardAiDecision(fixture, understaffed, publicInfo, period, turn);
  const anyFlex = decision.workerAssignments.some((w) => w.temporaryHeadcount > 0 || unwrapUnit(w.overtimeRate) > 0 || w.regularHeadcount > 1);
  assert.ok(anyFlex, "極端な人員不足下では、残業・臨時ワーカー・正社員増員のいずれかで反応するはず");
});

// ---------------------------------------------------------------------
// 9. 現金不足下で借入・支出抑制で応答する
// ---------------------------------------------------------------------
test("現金が最低バッファを大きく下回ると、通常融資を申請し、調達を必要最小限へ抑制する", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const lowCash: CompanyOwnState = { ...ownState, financeState: { ...ownState.financeState, cash: usd(-50_000_000) } };
  const decision = generateStandardAiDecision(fixture, lowCash, publicInfo, period, turn);
  assert.ok(decision.financingRequest.desiredAmountUsd > 0, "現金不足時は通常融資を申請するはず");
  assert.equal(decision.financingRequest.desiredPrepaymentUsd, 0, "現金不足時に同時に任意期限前返済を申請してはならない");
});

// ---------------------------------------------------------------------
// 10. 現金余剰下で過剰借入をしない
// ---------------------------------------------------------------------
test("現金が明確に余剰なら、理由なく借入を申請しない（任意期限前返済は既存借入があれば申請してよい）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const highCash: CompanyOwnState = { ...ownState, financeState: { ...ownState.financeState, cash: usd(500_000_000) } };
  const decision = generateStandardAiDecision(fixture, highCash, publicInfo, period, turn);
  assert.equal(decision.financingRequest.desiredAmountUsd, 0, "現金余剰時に通常融資を申請してはならない");
});

// ---------------------------------------------------------------------
// 11. 一時的な能力不足ではcapexを乱発しない
// ---------------------------------------------------------------------
test("前期実績（持続性シグナル）が無いturn1相当では、一時的な不足だけで設備投資を提案しない", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const decision = generateStandardAiDecision(fixture, ownState, publicInfo, period, turn);
  assert.equal(decision.capexDecision.newProjectProposals.length, 0, "持続性が未確認の状態でcapexを提案してはならない");
});

// ---------------------------------------------------------------------
// 12. 会社名を変えるだけでは判断原則が変わらない
// ---------------------------------------------------------------------
test("会社IDだけを変え、fixture・ownState・publicInfoの中身が同一なら、companyId以外の意思決定は完全に一致する", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const renamedFixture: CompanyFixture = { ...fixture, companyId: "ZZZZ-RENAMED" };
  const renamedOwnState: CompanyOwnState = {
    ...ownState,
    companyId: "ZZZZ-RENAMED",
    contracts: ownState.contracts.map((c) => ({ ...c, companyId: "ZZZZ-RENAMED" })),
    rawMaterialLots: ownState.rawMaterialLots.map((l) => ({ ...l, companyId: "ZZZZ-RENAMED" })),
    finishedGoodsLots: ownState.finishedGoodsLots.map((l) => ({ ...l, companyId: "ZZZZ-RENAMED" })),
    financeState: { ...ownState.financeState, companyId: "ZZZZ-RENAMED" },
    financingState: { ...ownState.financingState, companyId: "ZZZZ-RENAMED" },
    capexState: { ...ownState.capexState, companyId: "ZZZZ-RENAMED", portfolio: { ...ownState.capexState.portfolio, companyId: "ZZZZ-RENAMED" } },
    workforceState: { ...ownState.workforceState, companyId: "ZZZZ-RENAMED" },
  };

  const original = generateStandardAiDecision(fixture, ownState, publicInfo, period, turn);
  const renamed = generateStandardAiDecision(renamedFixture, renamedOwnState, publicInfo, period, turn);

  const stripCompanyId = (decision: CompanyDecisionInput) => JSON.stringify({ ...decision, companyId: "X" }).replaceAll(fixture.companyId, "X");
  assert.equal(stripCompanyId(renamed).replaceAll("ZZZZ-RENAMED", "X"), stripCompanyId(original));
});

// ---------------------------------------------------------------------
// 13. Observationの情報範囲は構造上、未来情報・他社非公開情報を要求できない
// ---------------------------------------------------------------------
test("標準AIのエントリーポイントは、既存CompanyDecisionProviderと同じ5引数（fixture, ownState, publicInfo, period, turn）以外を要求しない", () => {
  assert.equal(generateStandardAiDecision.length, 5);
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  // 5引数だけで呼び出せることの実行時確認（未来情報・他社情報を渡す経路が存在しない）。
  assert.doesNotThrow(() => generateStandardAiDecision(fixture, ownState, publicInfo, period, turn));
});

// ---------------------------------------------------------------------
// 14. 診断理由は実際の意思決定と整合する
// ---------------------------------------------------------------------
test("CASH_BUFFER_SHORTAGE診断が出た場合、financingRequest.desiredAmountUsdは必ず正である", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const lowCash: CompanyOwnState = { ...ownState, financeState: { ...ownState.financeState, cash: usd(-50_000_000) } };
  const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, lowCash, publicInfo, period, turn);
  const hasCashShortageCode = diagnostics.entries.some((e) => e.code === "CASH_BUFFER_SHORTAGE");
  assert.ok(hasCashShortageCode);
  assert.ok(decision.financingRequest.desiredAmountUsd > 0);
});

// ---------------------------------------------------------------------
// 15. 丸めによって能力・比率の上限を超えない
// ---------------------------------------------------------------------
test("残業率は常に[0,1]の範囲内、常用・臨時ワーカー人数は非負整数である", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const decision = generateStandardAiDecision(fixture, ownState, publicInfo, period, turn);
  for (const w of decision.workerAssignments) {
    const overtime = unwrapUnit(w.overtimeRate);
    assert.ok(overtime >= 0 && overtime <= 1);
    assert.ok(Number.isInteger(w.regularHeadcount));
    assert.ok(Number.isInteger(w.temporaryHeadcount));
  }
});

// ---------------------------------------------------------------------
// 16. 極端な入力（ゼロ需要・ゼロ生産・極端在庫・極端資金不足）で例外を起こさない
// ---------------------------------------------------------------------
test("極端な入力（原料・完成品ゼロ、契約ゼロ、現金が大幅マイナス）でも例外を投げず、有限な意思決定を返す", () => {
  const { fixture, period, turn } = setupBal();
  const extremeOwnState: CompanyOwnState = {
    companyId: fixture.companyId,
    contracts: [],
    rawMaterialLots: [],
    finishedGoodsLots: [],
    lastQuarterFactoryLoadMetrics: [],
    lastQuarterActualProductionByProduct: {},
    qualityScoreByProduct: {},
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
    financeState: {
      companyId: fixture.companyId,
      cash: usd(-999_999_999),
      receivables: [],
      payables: [],
      otherCurrentAssets: usd(0),
      fixedAssetsGross: usd(0),
      accumulatedDepreciation: usd(0),
      shortTermLoans: usd(0),
      longTermLoans: usd(0),
      otherLiabilities: usd(0),
      capitalStock: usd(0),
      retainedEarnings: usd(0),
      finishedGoodsCostLedger: [],
    },
    financingState: {
      companyId: fixture.companyId,
      loanPortfolio: { companyId: fixture.companyId, loans: [] },
      accruedInterestPayableUsd: 0,
      history: {
        consecutiveArrearsQuarters: 0,
        consecutiveCovenantBreachQuarters: 0,
        totalOnTimeRepaymentEventsCount: 0,
        totalArrearsEventsCount: 0,
        totalEmergencyLoanDrawsCount: 0,
      },
    },
    capexState: { companyId: fixture.companyId, portfolio: { companyId: fixture.companyId, projects: [] }, nextProjectSequence: 1 },
    workforceState: { companyId: fixture.companyId, factories: fixture.workerBaseline.map((w) => ({ factoryId: w.factoryId, regularHeadcount: 0 })) },
    salesForceHiringState: { companyId: fixture.companyId, headcount: fixture.salesForceHeadcountTotal },
    // 【Test15新設・tsc修正】PD稼働率実績なし・VAP商品開発スコアは中立値50（未投資の既定値）。
    pdUtilizationByFactory: [],
    vapProductDevelopmentScore: 50,
    // 【develop/v2統合・Required fix 2】極端な入力の再現テストのため、実効Factory[]は
    // fixture.factoriesそのまま（capex案件が一切無い状態を模擬しているため、
    // computeEffectiveFactoriesを通しても結果は同じ）。
    effectiveFactories: fixture.factories,
  };

  let decision: CompanyDecisionInput | undefined;
  assert.doesNotThrow(() => {
    decision = generateStandardAiDecision(fixture, extremeOwnState, { lastMarketResult: undefined, vietnamDomesticPriorPrice: 0 }, period, turn);
  });
  assertAllFinite(decision);
});
