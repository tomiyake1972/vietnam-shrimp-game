// ShrimpX V2 — 資金繰りモジュール 借入限度額（Phase 8B-1）
//
// 借入限度額は固定額ではなく、担保価値（適格資産×掛目）・直近収益力・
// 信用区分×自己資本の3系統から算出する。既存借入を控除した「追加借入可能額」
// を返す。信用区分E・重大延滞・支払不能の場合は通常融資を停止する
// （underwritingFrozen=true、availableAdditionalCapacity=0）。
//
// 【在庫の掛目差】原料在庫は「使用可能（available）」と「輸送中の輸入未着品
// （inTransitImport）」を呼び出し側（companyLab/liquidityClose.ts）が実ロット
// データから分けて渡す（finance/BalanceSheetは両者を合算した単一の
// rawMaterialInventoryしか持たないため。finance/initialState.tsの
// rawMaterialInventoryValueUsdコメント参照）。完成品在庫はPhase 8Aの
// 原価台帳が期限切れロットを既に除外済みのため、追加の除外処理は不要
// （期限切れ・使用不能在庫は構造的にfinishedGoodsInventoryへ現れない）。

import { PeriodV2 } from "../core/period";
import { CompanyId } from "../sales/types";
import { FinancingParameters } from "./parameters";
import { BorrowingCapacityConstraint, BorrowingCapacityResult, CreditTier } from "./types";

export interface CollateralInput {
  readonly receivablesUsd: number;
  readonly rawMaterialAvailableUsd: number;
  readonly rawMaterialInTransitUsd: number;
  readonly finishedGoodsUsd: number;
}

export interface BorrowingCapacityInput {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly collateral: CollateralInput;
  /** 直近四半期のEBITDA相当（営業利益＋減価償却）。マイナスも許容する。 */
  readonly ebitdaLikeQuarterlyUsd: number;
  readonly totalEquityUsd: number;
  readonly existingLoanBalanceUsd: number;
  readonly creditTier: CreditTier;
  /** 重大延滞（financialHealth.paymentDefault等）が既に成立している。 */
  readonly severeArrears: boolean;
  /** 純資産がマイナス（債務超過）。 */
  readonly insolvent: boolean;
}

export function computeBorrowingCapacity(input: BorrowingCapacityInput, params: FinancingParameters): BorrowingCapacityResult {
  const bc = params.borrowingCapacity;
  const collateralBasedLimitUsd =
    input.collateral.receivablesUsd * bc.receivablesHaircut +
    input.collateral.rawMaterialAvailableUsd * bc.rawMaterialInventoryHaircut +
    input.collateral.rawMaterialInTransitUsd * bc.rawMaterialInTransitHaircut +
    input.collateral.finishedGoodsUsd * bc.finishedGoodsInventoryHaircut;

  const earningsBasedLimitUsd = Math.max(0, input.ebitdaLikeQuarterlyUsd) * bc.earningsMultiple;

  const creditTierCapUsd = Math.max(0, input.totalEquityUsd) * bc.creditTierEquityMultiple[input.creditTier];

  const assetOrEarningsLimit = Math.max(collateralBasedLimitUsd, earningsBasedLimitUsd);
  const grossLimitUsd = Math.min(assetOrEarningsLimit, creditTierCapUsd);

  const underwritingFrozen = input.creditTier === "E" || input.severeArrears || input.insolvent;
  const availableAdditionalCapacityUsd = underwritingFrozen ? 0 : Math.max(0, grossLimitUsd - input.existingLoanBalanceUsd);

  const constraints: BorrowingCapacityConstraint[] = [
    { name: "collateralBased", limitUsd: collateralBasedLimitUsd },
    { name: "earningsBased", limitUsd: earningsBasedLimitUsd },
    { name: "creditTierEquityCap", limitUsd: creditTierCapUsd },
    { name: "existingLoanBalance", limitUsd: input.existingLoanBalanceUsd },
  ];

  let bindingConstraint: string;
  if (underwritingFrozen) {
    bindingConstraint = input.insolvent ? "insolvent" : input.severeArrears ? "severeArrears" : "creditTierE";
  } else if (creditTierCapUsd <= assetOrEarningsLimit + params.epsilonUsd) {
    bindingConstraint = "creditTierEquityCap";
  } else {
    bindingConstraint = collateralBasedLimitUsd >= earningsBasedLimitUsd ? "collateralBased" : "earningsBased";
  }

  return {
    companyId: input.companyId,
    period: input.period,
    collateralBasedLimitUsd,
    earningsBasedLimitUsd,
    creditTierCapUsd,
    grossLimitUsd,
    existingLoanBalanceUsd: input.existingLoanBalanceUsd,
    availableAdditionalCapacityUsd,
    underwritingFrozen,
    constraints,
    bindingConstraint,
  };
}
