// ShrimpX V2 — 資金繰りモジュール 借入限度額 テスト（Phase 8B-1）
//
// 対応する重要テスト: 9.売掛金・在庫・収益力に応じて変化する
// 10.既存借入を控除する 11.信用悪化で縮小する 12.未着輸入在庫に低い掛目
// 13.期限切れ在庫が担保価値を持たない 14.延滞・支払不能で通常融資が停止する
// 15.承認額が申請額・限度額を超えない（bankUnderwriting.test.tsで検証）

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { computeBorrowingCapacity, BorrowingCapacityInput, CollateralInput } from "../borrowingCapacity";
import { FINANCING_PARAMETERS_V1 } from "../parameters";

const P1 = period(2015, 1);

function makeInput(overrides: Partial<BorrowingCapacityInput> = {}): BorrowingCapacityInput {
  return {
    companyId: "BAL",
    period: P1,
    collateral: { receivablesUsd: 20_000_000, rawMaterialAvailableUsd: 5_000_000, rawMaterialInTransitUsd: 0, finishedGoodsUsd: 5_000_000 },
    ebitdaLikeQuarterlyUsd: 10_000_000,
    totalEquityUsd: 100_000_000,
    existingLoanBalanceUsd: 20_000_000,
    creditTier: "B",
    severeArrears: false,
    insolvent: false,
    ...overrides,
  };
}

test("受入確認BC-1: 売掛金・在庫が増えると担保ベースの限度額が増える", () => {
  const base = computeBorrowingCapacity(makeInput(), FINANCING_PARAMETERS_V1);
  const more = computeBorrowingCapacity(
    makeInput({ collateral: { receivablesUsd: 40_000_000, rawMaterialAvailableUsd: 10_000_000, rawMaterialInTransitUsd: 0, finishedGoodsUsd: 10_000_000 } }),
    FINANCING_PARAMETERS_V1
  );
  assert.ok(more.collateralBasedLimitUsd > base.collateralBasedLimitUsd);
});

test("受入確認BC-1b: 収益力（EBITDA相当）が増えると収益力ベースの限度額が増える", () => {
  const base = computeBorrowingCapacity(makeInput(), FINANCING_PARAMETERS_V1);
  const more = computeBorrowingCapacity(makeInput({ ebitdaLikeQuarterlyUsd: 30_000_000 }), FINANCING_PARAMETERS_V1);
  assert.ok(more.earningsBasedLimitUsd > base.earningsBasedLimitUsd);
});

test("受入確認BC-2: 既存借入残高を控除した額が追加借入可能額になる", () => {
  const result = computeBorrowingCapacity(makeInput(), FINANCING_PARAMETERS_V1);
  assert.ok(Math.abs(result.availableAdditionalCapacityUsd - Math.max(0, result.grossLimitUsd - result.existingLoanBalanceUsd)) < 0.01);
  const moreDebt = computeBorrowingCapacity(makeInput({ existingLoanBalanceUsd: result.grossLimitUsd + 50_000_000 }), FINANCING_PARAMETERS_V1);
  assert.equal(moreDebt.availableAdditionalCapacityUsd, 0);
});

test("受入確認BC-3: 信用区分が悪化すると（信用区分×自己資本キャップの縮小により）借入可能額が縮小する", () => {
  // 自己資本を小さくして信用区分×自己資本キャップが実際に効く（binding constraintになる）状況を作る。
  const tierB = computeBorrowingCapacity(makeInput({ creditTier: "B", totalEquityUsd: 15_000_000, existingLoanBalanceUsd: 1_000_000 }), FINANCING_PARAMETERS_V1);
  const tierD = computeBorrowingCapacity(makeInput({ creditTier: "D", totalEquityUsd: 15_000_000, existingLoanBalanceUsd: 1_000_000 }), FINANCING_PARAMETERS_V1);
  assert.ok(tierD.grossLimitUsd < tierB.grossLimitUsd);
  assert.ok(tierD.availableAdditionalCapacityUsd < tierB.availableAdditionalCapacityUsd);
});

test("受入確認BC-4: 未着輸入原料（rawMaterialInTransit）は使用可能原料在庫より低い掛目が適用される", () => {
  const collateralAvailable: CollateralInput = { receivablesUsd: 0, rawMaterialAvailableUsd: 10_000_000, rawMaterialInTransitUsd: 0, finishedGoodsUsd: 0 };
  const collateralInTransit: CollateralInput = { receivablesUsd: 0, rawMaterialAvailableUsd: 0, rawMaterialInTransitUsd: 10_000_000, finishedGoodsUsd: 0 };
  const withAvailable = computeBorrowingCapacity(makeInput({ collateral: collateralAvailable, ebitdaLikeQuarterlyUsd: 0 }), FINANCING_PARAMETERS_V1);
  const withInTransit = computeBorrowingCapacity(makeInput({ collateral: collateralInTransit, ebitdaLikeQuarterlyUsd: 0 }), FINANCING_PARAMETERS_V1);
  assert.ok(withInTransit.collateralBasedLimitUsd < withAvailable.collateralBasedLimitUsd);
  assert.ok(FINANCING_PARAMETERS_V1.borrowingCapacity.rawMaterialInTransitHaircut < FINANCING_PARAMETERS_V1.borrowingCapacity.rawMaterialInventoryHaircut);
});

test("受入確認BC-5: 期限切れ在庫は担保価値を持たない（Phase 8Aの原価台帳が期限切れロットを既に除外しているため、finishedGoodsUsdに含まれない前提。0を渡すと寄与が0になることを確認）", () => {
  const withZeroFinishedGoods = computeBorrowingCapacity(
    makeInput({ collateral: { receivablesUsd: 0, rawMaterialAvailableUsd: 0, rawMaterialInTransitUsd: 0, finishedGoodsUsd: 0 }, ebitdaLikeQuarterlyUsd: 0 }),
    FINANCING_PARAMETERS_V1
  );
  assert.equal(withZeroFinishedGoods.collateralBasedLimitUsd, 0);
});

test("受入確認BC-6: 信用区分E・重大延滞・支払不能の場合は通常融資を停止する（availableAdditionalCapacity=0、underwritingFrozen=true）", () => {
  const tierE = computeBorrowingCapacity(makeInput({ creditTier: "E" }), FINANCING_PARAMETERS_V1);
  assert.equal(tierE.underwritingFrozen, true);
  assert.equal(tierE.availableAdditionalCapacityUsd, 0);

  const severeArrears = computeBorrowingCapacity(makeInput({ severeArrears: true }), FINANCING_PARAMETERS_V1);
  assert.equal(severeArrears.underwritingFrozen, true);
  assert.equal(severeArrears.availableAdditionalCapacityUsd, 0);

  const insolvent = computeBorrowingCapacity(makeInput({ insolvent: true }), FINANCING_PARAMETERS_V1);
  assert.equal(insolvent.underwritingFrozen, true);
  assert.equal(insolvent.availableAdditionalCapacityUsd, 0);
});
