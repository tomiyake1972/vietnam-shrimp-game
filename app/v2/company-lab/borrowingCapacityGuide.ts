// ShrimpX V2 — UI-CLARITY-1 A-1: 借入を申請する前に「いくらまで借りられそうか」を示す
//
// 【直す問題】財務画面には「銀行審査で減額・否認されることがあります」とだけ書いてあり、
// 前四半期の審査結果（申請額・実行額・理由）は表示されていた。しかし
//   ・いくらが上限なのか
//   ・何がその上限を決めているのか
// は、申請する時点でどこにも出ていなかった。engineが記録する理由文は
// 「binding: earningsBased」のような内部の識別子を含み、プレイヤーには読めない。
//
// 【新しい審査を作らない】ここは表示専用である。上限の算出は
// financing/borrowingCapacity.ts computeBorrowingCapacity だけが行い、
// このファイルはその結果（前四半期末時点の記録）を日本語に直して並べるだけ。
// 今期の審査をここで予測・再計算することはしない。

import type { FinancingQuarterResult } from "../../lib/v2/financing/types";

/**
 * 借入余力の上限を決めている要因（engineの bindingConstraint）の日本語訳。
 * 値は financing/borrowingCapacity.ts が設定する文字列と1対1で対応する。
 */
export const BORROWING_CONSTRAINT_LABELS: Readonly<Record<string, string>> = {
  collateralBased: "担保の評価額（売掛金・在庫などに掛け目を適用した額）",
  earningsBased: "稼ぐ力（EBITDAの倍数）",
  creditTierEquityCap: "信用区分ごとの自己資本倍率の上限",
  existingLoanBalance: "すでに借りている残高",
  insolvent: "債務超過のため新規の通常融資を停止",
  severeArrears: "重大な延滞があるため新規の通常融資を停止",
  creditTierE: "信用区分がEのため新規の通常融資を停止",
};

/** 未知の識別子は推測で訳さず、そのまま出して「不明」と添える。 */
export function borrowingConstraintLabel(bindingConstraint: string): string {
  return BORROWING_CONSTRAINT_LABELS[bindingConstraint] ?? `${bindingConstraint}（この版では説明が用意されていません）`;
}

export interface BorrowingCapacityGuide {
  /** 前四半期末時点で、これ以上借りられるとされた額。 */
  readonly availableAdditionalCapacityUsd: number;
  /** その上限を決めていた要因（日本語）。 */
  readonly bindingConstraintLabel: string;
  /** 信用区分（A〜E）。 */
  readonly creditTier: string;
  /** 新規の通常融資が止まっているか。 */
  readonly underwritingFrozen: boolean;
  /** 財務制限条項に違反していたか。 */
  readonly covenantBreach: boolean;
  /** 既存借入残高。 */
  readonly existingLoanBalanceUsd: number;
}

/**
 * 前四半期の確定記録から、申請前に見せる借入余力の目安を組み立てる。
 *
 * 記録が無いRun（Turn1・古いスナップショット）では null を返す。
 * 残高の差などから逆算して、それらしい数字を作ることはしない。
 */
export function buildBorrowingCapacityGuide(
  financingResult: FinancingQuarterResult | null | undefined
): BorrowingCapacityGuide | null {
  if (!financingResult) return null;
  const capacity = financingResult.borrowingCapacity;
  return {
    availableAdditionalCapacityUsd: capacity.availableAdditionalCapacityUsd,
    bindingConstraintLabel: borrowingConstraintLabel(capacity.bindingConstraint),
    creditTier: financingResult.creditScore.tier,
    underwritingFrozen: capacity.underwritingFrozen,
    covenantBreach: financingResult.covenant.anyBreach,
    existingLoanBalanceUsd: capacity.existingLoanBalanceUsd,
  };
}
