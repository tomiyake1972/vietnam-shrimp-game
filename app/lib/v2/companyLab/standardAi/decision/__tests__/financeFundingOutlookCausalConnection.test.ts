// ShrimpX V2 — SAI-6 Phase 1A-2: 資金調達→原料調達の因果接続を結果レベルで検証する。
//
// 【背景】Phase 1A-2の因果接続監査（scripts/sai6Phase1A2CausalConnectionAudit.ts）で、
// 実際の破綻前後の窓（4 seed×5社、80四半期）のうち78/80四半期で「承認額＝借入余力」
// （銀行の与信上限が常に完全に使い切られている）ことが確認された。つまり、AIの
// 希望借入額をどれだけ是正しても、承認額・実行額はほぼ変わらない
// （遮断点B。詳細はdocs/v2/reports/sai6_phase1a2_*.md参照）。
//
// 本ファイルは、その"遮断点B"という結論を作り話にしないため、次の2つを両方とも
// 結果レベルで検証する:
//   1. 借入余力が「希望額を上回っている」条件では、承認額が増えれば当期の
//      原料調達の現金制約が実際に緩和されることを、pure functionレベルで確認する
//      （＝メカニズム自体は正しく機能する）。
//   2. 実際のゲームデータ（破綻直前の会社）では、借入余力が希望額を常に下回って
//      おり、是正の有無にかかわらず承認額が借入余力に張り付くことを、回帰
//      ピン留めテストとして残す（＝無理に成功させない診断テスト）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons } from "../../../../core/units";
import { period } from "../../../../core/period";
import { Product } from "../../../../market/types";
import { FINANCE_PARAMETERS_V1 } from "../../../../finance/parameters";
import { CompanyQuarterBusinessActuals } from "../../../../finance/quarterClose";
import { CompanyFinanceState, usd } from "../../../../finance/types";
import {
  computeProcurementConstraint,
  ProcurementConstraintInput,
  closeQuarterWithFinancing,
  CloseQuarterWithFinancingInput,
  planQuarterFinancing,
  QuarterFinancingPlanInput,
} from "../../../../financing/liquidityClose";
import { FINANCING_PARAMETERS_V1 } from "../../../../financing/parameters";
import { CollateralInput } from "../../../../financing/borrowingCapacity";
import { CompanyFinancingHistory, CompanyFinancingState, FinancingRequestInput } from "../../../../financing/types";
import { runAutoplayCase } from "../../../standardAi/autoplay/runCase";
import { ALL_COMPANY_IDS } from "../../../standardAi/report/decomposeHarness";
import {
  STANDARD_BASELINE_CANDIDATES,
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
} from "../../../standardAi/report/standardBaseline";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

// ---------------------------------------------------------------------
// 1. メカニズム自体は接続していることの確認（pure function、runner.tsが
//    computeProcurementConstraintへ渡す入力の型そのものを直接使う）。
// ---------------------------------------------------------------------
test("Phase1A-2-機構: 借入余力が希望額を上回る条件では、承認額の増加が当期の原料調達制約を緩和する（決定順序は問題にならない）", () => {
  const base: ProcurementConstraintInput = {
    companyId: "BAL" as ProcurementConstraintInput["companyId"],
    period: "2016Q1" as ProcurementConstraintInput["period"],
    originalDomesticPurchaseQuantityTons: 5000,
    expectedDomesticPriceUsdPerKg: 2.5,
    prevCashUsd: 1_000_000, // 現金は少なく設定し、承認額の差が調達量へそのまま効くようにする
    approvedNormalLoanDrawUsd: 0,
    severeArrearsOrInsolvent: false,
  };

  const withoutExtraLoan = computeProcurementConstraint(base, FINANCING_PARAMETERS_V1);
  const withExtraLoan = computeProcurementConstraint({ ...base, approvedNormalLoanDrawUsd: 8_000_000 }, FINANCING_PARAMETERS_V1);
  const withEvenMoreLoan = computeProcurementConstraint({ ...base, approvedNormalLoanDrawUsd: 20_000_000 }, FINANCING_PARAMETERS_V1);

  assert.ok(
    withExtraLoan.constrainedDomesticPurchaseQuantityTons > withoutExtraLoan.constrainedDomesticPurchaseQuantityTons,
    "承認額が増えれば、同じ四半期の実行可能な国内買付数量も増えなければならない（＝finance→procurementの接続自体は同一四半期内で機能する）"
  );
  assert.ok(withExtraLoan.scaleRatio > withoutExtraLoan.scaleRatio, "承認額が増えれば、調達スケール比も改善しなければならない");
  assert.ok(
    withEvenMoreLoan.constrainedDomesticPurchaseQuantityTons <= base.originalDomesticPurchaseQuantityTons + 1e-6,
    "承認額をさらに増やしても、実行数量は希望数量を超えてはならない（scaleRatioは1で頭打ち）"
  );
  assert.equal(withEvenMoreLoan.scaleRatio, 1, "希望額を十分に上回る承認額があれば、制約は完全に解消される（scaleRatio=1）");

  // 【意思決定順序への反論】computeProcurementConstraintはrunner.ts側で
  // 「銀行の与信判断（planQuarterFinancing、当期のturnResultより前に確定）」の
  // 直後・同一ループ内で呼ばれ、その承認額をそのまま引数として受け取る
  // （runner.ts:857-869）。したがって、standardAi/policy.tsのAI意思決定生成順序
  // （sales→production→procurement→labor→finance→capex）とは独立に、
  // 「finance承認→procurement実行制約」という順序はrunner.ts側で既に
  // 保証されている。順序変更（procurementをfinanceより後にする等）は不要である。
});

// ---------------------------------------------------------------------
// 2. 実際のゲームデータでの回帰ピン留め（診断テスト。改善を無理に主張しない）。
// ---------------------------------------------------------------------
test("Phase1A-2-実データ: 破綻直前の窓では、承認額が常に借入余力に張り付き、資金見通し是正の有無で実行額はほぼ変わらない（診断のためのピン留め）", () => {
  const off = runAutoplayCase({ scenarioId: "baseline", seed: "sai5-ab-001", quarters: 24, companyIds: ALL_COMPANY_IDS, candidate });
  const on = runAutoplayCase({
    scenarioId: "baseline",
    seed: "sai5-ab-001",
    quarters: 24,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    fundingOutlookEnabled: true,
  });

  // sai5-ab-001/BALは因果監査で「A類型（仮説どおり）」と当初分類されたケース。
  // ここで承認額と借入余力の関係を直接確認する。
  const turns = [21, 22, 23, 24];
  let boundCount = 0;
  let drawDeltaTotalUsd = 0;
  for (const turn of turns) {
    const offRec = off.history.find((h) => h.turn === turn);
    const onRec = on.history.find((h) => h.turn === turn);
    const offFin = offRec?.financingResults.find((f) => f.companyId === "BAL");
    const onFin = onRec?.financingResults.find((f) => f.companyId === "BAL");
    assert.ok(offFin && onFin, `turn ${turn} のfinancingResultsが取得できる必要がある`);
    const offBound = Math.abs(offFin!.underwriting.approvedAmountUsd - offFin!.borrowingCapacity.availableAdditionalCapacityUsd) < 1000;
    const onBound = Math.abs(onFin!.underwriting.approvedAmountUsd - onFin!.borrowingCapacity.availableAdditionalCapacityUsd) < 1000;
    if (offBound && onBound) boundCount += 1;
    drawDeltaTotalUsd += onFin!.loanDrawUsd - offFin!.loanDrawUsd;
  }

  // 【診断のためのピン留め】現状のこのケースでは、4四半期すべてで承認額が
  // 借入余力に完全一致する（＝銀行の与信上限が常に律速）。このテストは
  // 「改善している」ことを主張するテストではなく、「この制約構造が今も
  // 存在する」ことを固定して検知するための回帰ピン留めである。将来、
  // Phase 1B（借入余力超過時の計画縮小）やcapex/初期資本構成側の変更で
  // この前提が崩れたら、このテストが失敗して気づけるようにする。
  assert.equal(boundCount, turns.length, "破綻直前の窓では、承認額が借入余力に常に一致する（capacity-bound）という現状の制約構造をピン留めする");
  assert.ok(
    Math.abs(drawDeltaTotalUsd) < 100_000,
    `資金見通し是正だけでは、この4四半期の合計借入実行額はほとんど変化しない（現状の差: ${drawDeltaTotalUsd.toFixed(0)} USD）。原因は借入余力そのものの不足であり、希望額の算定式ではない。`
  );
});

// ---------------------------------------------------------------------
// 3.【三宅さんのご指摘・作業5】最小統合ケースで、借入増加が「同一四半期」
//    だけでなく「翌四半期」の調達・生産へ届くかどうかを確認する。
//
//    確認すること:
//    (a) 当期の承認額（借入実行額）が増えれば、当期末現金（closingCash）が
//        同額だけ増える（会計恒等式レベルの当然の帰結。すでにFI-1で確認済み
//        だが、ここでは「金額の差」そのものを確認する）。
//    (b) その当期末現金は、翌四半期の期首現金（プロダクションのrunner.tsが
//        computeProcurementConstraintへ渡すprevCashUsd）へそのまま繰り越さ
//        れる（結合テスト: 実際のオートプレイ実行で closingCash(t) と
//        openingCash(t+1) が一致することを確認する。これは「遮断していない」
//        ことの直接的な証拠であり、runner.ts側の状態更新ロジックを検証する）。
//    (c) 繰り越された現金が多いほど、翌四半期のcomputeProcurementConstraint
//        のscaleRatioが改善する（pure functionレベルで再確認、PC-3と同じ式）。
//
//    (a)+(b)+(c) を合成すると、「当期の承認額増加 → 当期末現金増加 →
//    翌四半期の期首現金増加 → 翌四半期の調達制約緩和」という次四半期への
//    因果の連結が、少なくとも会計上の繰越メカニズムそのものについては
//    遮断されていないことが分かる。
//    【重要な限定】この結合は「同じ会社が翌四半期にその現金を国内買付以外の
//    用途（人件費・SGA・元利払い等）に一切使わない」という条件つきの
//    pure functionの合成にすぎず、実際のゲームでは翌四半期中に他の支出が
//    先に発生し得るため、「効果の一部が翌四半期の他の支出に吸収される」
//    可能性は本テストの範囲外である（吸収されても、繰り越し自体が消える
//    わけではなく、繰越額の大小関係が保たれることは(b)(c)で確認できる）。
// ---------------------------------------------------------------------

const CC_P1 = period(2020, 1);
const CC_PROCESSING_RATES: Readonly<Record<Product, number>> = { hoso: 350, pd: 520, vap: 780 };

function ccMakeFinanceState(cashUsd: number): CompanyFinanceState {
  const capitalStock = 30_000_000;
  const totalAssets = cashUsd + 40_000_000;
  const retainedEarnings = totalAssets - capitalStock;
  return {
    companyId: "TEST",
    cash: usd(cashUsd),
    receivables: [],
    payables: [],
    otherCurrentAssets: usd(0),
    fixedAssetsGross: usd(40_000_000),
    accumulatedDepreciation: usd(0),
    shortTermLoans: usd(0),
    longTermLoans: usd(0),
    otherLiabilities: usd(0),
    capitalStock: usd(capitalStock),
    retainedEarnings: usd(retainedEarnings),
    finishedGoodsCostLedger: [],
  };
}

function ccZeroActuals(): CompanyQuarterBusinessActuals {
  return {
    companyId: "TEST",
    period: CC_P1,
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
    rawMaterialInventoryBeginUsd: 0,
    rawMaterialInventoryEndUsd: 0,
    lotConsumption: [],
    finishedGoodsRemainingByLot: [],
  };
}

function ccMakeFinancingState(): CompanyFinancingState {
  const history: CompanyFinancingHistory = {
    consecutiveArrearsQuarters: 0,
    consecutiveCovenantBreachQuarters: 0,
    totalOnTimeRepaymentEventsCount: 4,
    totalArrearsEventsCount: 0,
    totalEmergencyLoanDrawsCount: 0,
  };
  return { companyId: "TEST", loanPortfolio: { companyId: "TEST", loans: [] }, accruedInterestPayableUsd: 0, history };
}

function ccMakeCollateral(): CollateralInput {
  return { receivablesUsd: 5_000_000, rawMaterialAvailableUsd: 2_000_000, rawMaterialInTransitUsd: 0, finishedGoodsUsd: 2_000_000 };
}

function ccMakeRequest(desiredAmountUsd: number): FinancingRequestInput {
  return {
    desiredAmountUsd,
    desiredLoanType: "workingCapital",
    desiredTermQuarters: 4,
    desiredRepaymentMethod: "bulletAtMaturity",
    desiredPrepaymentUsd: 0,
    emergencyAcceptable: false,
  };
}

function ccCloseQuarter(financeState: CompanyFinanceState, desiredAmountUsd: number) {
  const financingState = ccMakeFinancingState();
  const collateral = ccMakeCollateral();
  const request = ccMakeRequest(desiredAmountUsd);
  const planInput: QuarterFinancingPlanInput = {
    companyId: "TEST",
    period: CC_P1,
    prevFinanceState: financeState,
    prevFinancingState: financingState,
    collateral,
    financingRequest: request,
  };
  const plan = planQuarterFinancing(planInput, FINANCE_PARAMETERS_V1, FINANCING_PARAMETERS_V1);
  const input: CloseQuarterWithFinancingInput = {
    companyId: "TEST",
    period: CC_P1,
    prevFinanceState: financeState,
    prevFinancingState: financingState,
    actuals: ccZeroActuals(),
    plan,
    financingRequest: request,
    collateralForEmergency: collateral,
  };
  return closeQuarterWithFinancing(input, FINANCE_PARAMETERS_V1, FINANCING_PARAMETERS_V1, CC_PROCESSING_RATES);
}

test("Phase1A-2-次四半期接続(a): 当期の承認額（借入実行額）の差は、当期末現金（closingCash/nextFinanceState.cash）の差にそのまま反映される（pure function）", () => {
  const startCash = 500_000; // 現金は乏しく設定し、借入余力が希望額の差を吸収しきらないようにする
  const lowRequestOutput = ccCloseQuarter(ccMakeFinanceState(startCash), 1_000_000);
  const highRequestOutput = ccCloseQuarter(ccMakeFinanceState(startCash), 5_000_000);

  const lowDraw = lowRequestOutput.financingQuarterResult.loanDrawUsd;
  const highDraw = highRequestOutput.financingQuarterResult.loanDrawUsd;
  assert.ok(highDraw > lowDraw, "希望額が大きいほど、担保・信用枠で許す範囲では承認額（実行額）も大きくなる必要がある");

  const lowClosingCash = lowRequestOutput.nextFinanceState.cash as number;
  const highClosingCash = highRequestOutput.nextFinanceState.cash as number;
  assert.ok(
    Math.abs(highClosingCash - lowClosingCash - (highDraw - lowDraw)) < 1,
    "実行額の差は（事業活動をゼロに固定しているため）当期末現金の差へそのまま反映されなければならない"
  );
});

test("Phase1A-2-次四半期接続(b): 実際のオートプレイ実行で、当期末現金（financialResults[t].cashFlow.closingCash）は翌四半期の期首現金（quarterStartCaptures[t+1].ownState.financeState.cash、procurementConstraintのprevCashUsdの元）へ厳密に繰り越される", () => {
  const result = runAutoplayCase({ scenarioId: "baseline", seed: "sai5-ab-001", quarters: 24, companyIds: ALL_COMPANY_IDS, candidate });

  let checked = 0;
  let maxDiffUsd = 0;
  for (const companyId of ALL_COMPANY_IDS) {
    for (const h of result.history) {
      const fin = h.financialResults.find((f) => f.companyId === companyId);
      const nextCapture = result.quarterStartCaptures.find((c) => c.turn === h.turn + 1 && c.companyId === companyId);
      if (!fin || !nextCapture) continue;
      const closingCashUsd = fin.cashFlow.closingCash as number;
      const nextOpeningCashUsd = nextCapture.ownState.financeState.cash as number;
      maxDiffUsd = Math.max(maxDiffUsd, Math.abs(closingCashUsd - nextOpeningCashUsd));
      checked += 1;
    }
  }

  assert.ok(checked > 50, `十分な四半期数が確認できていること（実際: ${checked}件）`);
  assert.ok(
    maxDiffUsd < 1,
    `当期末現金と翌四半期期首現金の差は0でなければならない（実際の最大差: ${maxDiffUsd.toFixed(6)} USD）。` +
      `差が生じている場合、それは資金の繰り越しが遮断されている直接の証拠であり、その遮断点を別途特定する必要がある。`
  );
});

test("Phase1A-2-次四半期接続(c): 翌四半期に繰り越された期首現金が多いほど、翌四半期のcomputeProcurementConstraintのscaleRatioは改善する（(a)(b)と合成すると、当期の承認額増加が翌四半期の調達制約緩和へ因果的に到達することが分かる）", () => {
  const nextPeriodBase: ProcurementConstraintInput = {
    companyId: "TEST" as ProcurementConstraintInput["companyId"],
    period: "2020Q2" as ProcurementConstraintInput["period"],
    originalDomesticPurchaseQuantityTons: 1000,
    expectedDomesticPriceUsdPerKg: 3.0,
    prevCashUsd: 500_000, // 翌四半期の期首現金＝前四半期末の繰越現金（低いケースを想定）
    approvedNormalLoanDrawUsd: 0,
    severeArrearsOrInsolvent: false,
  };
  const withLowCarriedCash = computeProcurementConstraint(nextPeriodBase, FINANCING_PARAMETERS_V1);
  const withHighCarriedCash = computeProcurementConstraint(
    { ...nextPeriodBase, prevCashUsd: 500_000 + 4_000_000 }, // (a)テストと同じ4,000,000 USDの承認額差が繰り越された想定
    FINANCING_PARAMETERS_V1
  );

  assert.ok(
    withHighCarriedCash.scaleRatio > withLowCarriedCash.scaleRatio,
    "翌四半期に繰り越された現金が多いほど、翌四半期の調達制約（scaleRatio）は緩和されなければならない"
  );
  assert.ok(withHighCarriedCash.constrainedDomesticPurchaseQuantityTons > withLowCarriedCash.constrainedDomesticPurchaseQuantityTons);
});

void hosoEqTons;
