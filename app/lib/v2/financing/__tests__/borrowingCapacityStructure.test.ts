// ShrimpX V2 — 借入余力の構造をcharacterizeするテスト（資金繰り診断）
//
// 【背景】「通常審査を通った借入が一度も実行されない」という観測の直接原因を
// 特定した結果、コードの欠陥ではなく
//   追加借入可能額 = max(0, grossLimit − 既存借入残高)
//   grossLimit    = min( max(担保ベース上限, 収益ベース上限), 信用区分×自己資本上限 )
// という構造と、標準初期条件が持つ既存債務(57,000,000)が担保ベース上限(約37,000,000)を
// 上回っていることの組み合わせであることが判明した。
//
// 【このテストの役割】現行の挙動を固定する（characterization）。
// **挙動を変更するものではない。** パラメータ調整を行う場合、
// ここに書かれた数値がどう動くべきかを先に決めてから変更すること。

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeBorrowingCapacity } from "../borrowingCapacity";
import { underwriteLoanApplication } from "../bankUnderwriting";
import { FINANCING_PARAMETERS_V1 } from "../parameters";
import { CreditScoreResult, FinancingRequestInput, CovenantCheckResult } from "../types";
import { PeriodV2, period as makePeriod } from "../../core/period";

const PERIOD: PeriodV2 = makePeriod(2026, 1);
const P = FINANCING_PARAMETERS_V1;

function capacity(opts: {
  receivables: number;
  rawAvail?: number;
  fg?: number;
  ebitdaQ?: number;
  equity: number;
  debt: number;
  tier?: "A" | "B" | "C" | "D" | "E";
  severeArrears?: boolean;
  insolvent?: boolean;
}) {
  return computeBorrowingCapacity(
    {
      companyId: "BAL",
      period: PERIOD,
      collateral: {
        receivablesUsd: opts.receivables,
        rawMaterialAvailableUsd: opts.rawAvail ?? 0,
        rawMaterialInTransitUsd: 0,
        finishedGoodsUsd: opts.fg ?? 0,
      },
      ebitdaLikeQuarterlyUsd: opts.ebitdaQ ?? 0,
      totalEquityUsd: opts.equity,
      existingLoanBalanceUsd: opts.debt,
      creditTier: opts.tier ?? "B",
      severeArrears: opts.severeArrears ?? false,
      insolvent: opts.insolvent ?? false,
    },
    P
  );
}

const CREDIT_B: CreditScoreResult = { companyId: "BAL", period: PERIOD, score0to100: 75, tier: "B", breakdown: [], reasons: [] };
const NO_COVENANT_BREACH: CovenantCheckResult = {
  companyId: "BAL",
  period: PERIOD,
  equityRatio: 0.5,
  debtToAssetsRatio: 0.4,
  interestCoverageRatio: 5,
  equityRatioBreach: false,
  debtToAssetsBreach: false,
  interestCoverageBreach: false,
  anyBreach: false,
  reasons: [],
} as unknown as CovenantCheckResult;

const REQUEST: FinancingRequestInput = {
  desiredAmountUsd: 10_000_000,
  desiredLoanType: "workingCapital",
  desiredTermQuarters: 4,
  desiredRepaymentMethod: "bulletAtMaturity",
  desiredPrepaymentUsd: 0,
  emergencyAcceptable: true,
};

test("FINDIAG-1: 既存債務が担保ベース上限を下回る健全企業には、通常融資が実際に承認される（承認経路は生きている）", () => {
  // 標準初期条件と同じ担保構成のまま、既存債務だけを半分にした健全企業。
  const cap = capacity({ receivables: 45_600_000, rawAvail: 12_000_000, fg: 1_500_000, equity: 100_000_000, debt: 28_500_000 });
  assert.equal(cap.underwritingFrozen, false);
  assert.ok(cap.availableAdditionalCapacityUsd > 0, `追加借入可能額が正であること。実測 ${cap.availableAdditionalCapacityUsd}`);

  const decision = underwriteLoanApplication("BAL", PERIOD, REQUEST, CREDIT_B, cap, NO_COVENANT_BREACH, false, P, "0");
  assert.ok(decision.approvedAmountUsd > 0, "通常融資が承認されること");
  assert.equal(decision.approvedAmountUsd, Math.min(REQUEST.desiredAmountUsd, cap.availableAdditionalCapacityUsd));
  assert.ok(decision.approvedLoanId !== undefined, "承認時は貸付IDが発行されること");
  assert.ok(decision.maturityPeriod !== undefined, "承認時は満期が設定されること");
});

test("FINDIAG-2: 【ゼロ承認の直接原因】健全でも既存債務が担保ベース上限を上回ると追加借入可能額が0になる", () => {
  // 標準初期条件の実データそのもの（turn1・tier B・健全・純資産1億USD）。
  const cap = capacity({ receivables: 45_600_000, rawAvail: 12_000_000, fg: 1_500_000, equity: 100_327_709, debt: 57_000_000 });

  assert.equal(cap.underwritingFrozen, false, "凍結ではない（債務超過でも重大延滞でも区分Eでもない）");
  assert.equal(cap.bindingConstraint, "collateralBased");
  assert.ok(cap.collateralBasedLimitUsd < 57_000_000, `担保ベース上限が既存債務を下回る。実測 ${cap.collateralBasedLimitUsd}`);
  assert.equal(cap.availableAdditionalCapacityUsd, 0, "追加借入可能額は0");

  const decision = underwriteLoanApplication("BAL", PERIOD, REQUEST, CREDIT_B, cap, NO_COVENANT_BREACH, false, P, "0");
  assert.equal(decision.approvedAmountUsd, 0, "健全企業でも承認額は0になる");
  assert.equal(decision.deniedAmountUsd, REQUEST.desiredAmountUsd);
});

test("FINDIAG-3: 信用区分×自己資本の枠は上限としてしか働かず、余力を増やす方向には決して寄与しない", () => {
  // 自己資本を10倍にしても、担保・収益が変わらなければ grossLimit は1ドルも増えない。
  const small = capacity({ receivables: 45_600_000, rawAvail: 12_000_000, fg: 1_500_000, equity: 100_000_000, debt: 0, tier: "A" });
  const huge = capacity({ receivables: 45_600_000, rawAvail: 12_000_000, fg: 1_500_000, equity: 1_000_000_000, debt: 0, tier: "A" });

  assert.ok(small.creditTierCapUsd > small.collateralBasedLimitUsd, "前提: 区分×資本の枠のほうが担保上限より大きい");
  assert.equal(
    huge.grossLimitUsd,
    small.grossLimitUsd,
    "自己資本を10倍にしても grossLimit は不変（min(max(担保,収益), 区分×資本) の構造による）"
  );
});

test("FINDIAG-4: 収益ベース上限は「四半期」EBITDAに倍率を掛けたものである（年換算ではない）", () => {
  const quarterlyEbitda = 4_000_000;
  const cap = capacity({ receivables: 0, equity: 100_000_000, debt: 0, ebitdaQ: quarterlyEbitda });
  assert.equal(
    cap.earningsBasedLimitUsd,
    quarterlyEbitda * P.borrowingCapacity.earningsMultiple,
    "収益ベース上限 = 四半期EBITDA × earningsMultiple。年換算していない"
  );
  // 参考: earningsMultiple=2.0 は年間EBITDA換算では0.5倍にあたる（一般的な2〜3倍より保守的）。
  assert.equal(P.borrowingCapacity.earningsMultiple, 2.0);
});

test("FINDIAG-5: 債務超過・重大延滞・信用区分Eのときだけ審査が凍結される", () => {
  const healthy = capacity({ receivables: 45_600_000, equity: 100_000_000, debt: 0 });
  assert.equal(healthy.underwritingFrozen, false);

  assert.equal(capacity({ receivables: 45_600_000, equity: -1, debt: 0, insolvent: true }).underwritingFrozen, true);
  assert.equal(capacity({ receivables: 45_600_000, equity: 100_000_000, debt: 0, severeArrears: true }).underwritingFrozen, true);
  assert.equal(capacity({ receivables: 45_600_000, equity: 100_000_000, debt: 0, tier: "E" }).underwritingFrozen, true);

  const frozen = capacity({ receivables: 45_600_000, equity: 100_000_000, debt: 0, tier: "E" });
  assert.equal(frozen.availableAdditionalCapacityUsd, 0);
  const decision = underwriteLoanApplication("BAL", PERIOD, REQUEST, CREDIT_B, frozen, NO_COVENANT_BREACH, false, P, "0");
  assert.equal(decision.approvedAmountUsd, 0);
});

test("FINDIAG-6: 承認額が借入余力枠を決して超えない", () => {
  for (const debt of [0, 10_000_000, 30_000_000, 57_000_000, 100_000_000]) {
    const cap = capacity({ receivables: 45_600_000, rawAvail: 12_000_000, fg: 1_500_000, equity: 100_000_000, debt });
    for (const desired of [1_000_000, 10_000_000, 100_000_000]) {
      const decision = underwriteLoanApplication(
        "BAL",
        PERIOD,
        { ...REQUEST, desiredAmountUsd: desired },
        CREDIT_B,
        cap,
        NO_COVENANT_BREACH,
        false,
        P,
        "0"
      );
      assert.ok(
        decision.approvedAmountUsd <= cap.availableAdditionalCapacityUsd + 1e-6,
        `承認額が余力枠を超えている（債務${debt}・希望${desired}）`
      );
      assert.ok(decision.approvedAmountUsd <= desired + 1e-6, "承認額が申請額を超えない");
    }
  }
});

test("FINDIAG-7: 借入余力は既存債務に対して単調非増加である（債務が増えるほど余力は減る）", () => {
  let prev = Number.POSITIVE_INFINITY;
  for (const debt of [0, 20_000_000, 40_000_000, 60_000_000, 80_000_000, 95_000_000]) {
    const cap = capacity({ receivables: 45_600_000, rawAvail: 12_000_000, fg: 1_500_000, equity: 100_000_000, debt });
    assert.ok(cap.availableAdditionalCapacityUsd <= prev + 1e-6, `既存債務${debt}で余力が増えている`);
    prev = cap.availableAdditionalCapacityUsd;
  }
  assert.equal(prev, 0, "債務95,000,000では余力0");
});

// ---------------------------------------------------------------------
// 【診断報告の是正・2026-08-03】三宅さんの数値整合性指摘への回答として追加。
// 前回報告の候補比較表がturn3で0を出力していた（三宅さんの手計算では約45.7Mが正しい）
// 原因は、候補計算スクリプト側の手入力EBITDA値が実際の引受用EBITDAと異なっていたこと
// （computeBorrowingCapacity本体にバグはない）。以下はそれをcharacterizeし、
// 今後この整合性が壊れないことを保証するテスト。
// ---------------------------------------------------------------------

test("FINDIAG-8: 【是正確認】四半期EBITDA×multiplierという式に忠実である限り、multiplierを引き上げれば収益ベース上限は線形に伸びる（三宅さんの手計算99,403,344の再現）", () => {
  // turn3実測相当: 引受用EBITDA(前期営業利益+前期減価償却)=12,425,418、既存債務=53,700,000、担保上限=44,707,642。
  const ebitdaQ = 12_425_418;
  const debt = 53_700_000;
  const capBase = capacity({ receivables: 53_093_502, rawAvail: 19_465_090, fg: 8_912_823, equity: 109_030_429, debt, ebitdaQ, tier: "B" });
  assert.equal(capBase.earningsBasedLimitUsd, ebitdaQ * 2.0, "現行multiplier=2.0での収益ベース上限");

  const paramsAt8 = { ...P, borrowingCapacity: { ...P.borrowingCapacity, earningsMultiple: 8.0 } };
  const capAt8 = computeBorrowingCapacity(
    {
      companyId: "BAL",
      period: PERIOD,
      collateral: { receivablesUsd: 53_093_502, rawMaterialAvailableUsd: 19_465_090, rawMaterialInTransitUsd: 0, finishedGoodsUsd: 8_912_823 },
      ebitdaLikeQuarterlyUsd: ebitdaQ,
      totalEquityUsd: 109_030_429,
      existingLoanBalanceUsd: debt,
      creditTier: "B",
      severeArrears: false,
      insolvent: false,
    },
    paramsAt8
  );
  assert.equal(capAt8.earningsBasedLimitUsd, ebitdaQ * 8.0);
  assert.equal(capAt8.earningsBasedLimitUsd, 99_403_344, "三宅さんの手計算(99.403M)と一致する");
  assert.equal(capAt8.grossLimitUsd, Math.min(Math.max(capAt8.collateralBasedLimitUsd, capAt8.earningsBasedLimitUsd), capAt8.creditTierCapUsd));
  assert.equal(capAt8.availableAdditionalCapacityUsd, capAt8.grossLimitUsd - debt);
  assert.ok(capAt8.availableAdditionalCapacityUsd > 45_000_000, `追加借入可能額が約45.7M付近であること。実測 ${capAt8.availableAdditionalCapacityUsd}`);
});

test("FINDIAG-9: 【是正確認】existingLoanBalanceUsdは前期末残高そのものであり、当期の元金返済後B/S残高とは別の時点の値である（参照時点の混在の再発防止）", () => {
  // turn4末残高52,050,000がturn5の引受にそのままexistingLoanBalanceとして使われ、
  // turn5当期中に25,650,000の返済が起きても、引受時点の値自体は返済の影響を受けない
  // （返済は引受確定後に発生するため）。
  const priorQuarterEndBalance = 52_050_000;
  const cap = capacity({ receivables: 44_324_321, equity: 111_511_931, debt: priorQuarterEndBalance, tier: "A" });
  assert.equal(cap.existingLoanBalanceUsd, priorQuarterEndBalance, "existingLoanBalanceUsdは渡した前期末残高そのまま。当期の返済状況を一切反映しない");

  const postRepaymentBalance = 27_280_739; // turn5当期末（返済後）の実測残高。引受には無関係。
  assert.notEqual(
    cap.existingLoanBalanceUsd,
    postRepaymentBalance,
    "引受時のexistingLoanBalanceと当期返済後B/S残高は別時点の値であり、一致しなくて正しい"
  );
});
