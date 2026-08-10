// ShrimpX V2 — Phase 6C: 会社の商業実績 carry state（提出 → 成約 の転換率を観測するため）
//
// 【なぜ「状態」として持つのか】
// Standard AI は「20,000t 提出して 14,000t しか成約しなかった」という自社の実績を
// 次の四半期の判断へ持ち込む必要がある（#05 Phase 6C §7）。ところが意思決定関数は
// 純粋関数であり、四半期をまたぐ記憶を持たない。
//
// 【provider のクロージャに持たせなかった理由】
// createStandardAiProvider の内部に記憶を置くと、Console（1プロセスで32Q連続実行）
// では学習するのに、API（1四半期ごとに永続化状態から復元して実行）では学習しない、
// という**経路によって挙動が変わる**状態になる。プレイヤーが遊ぶ本番経路と、
// 我々が校正に使う経路が食い違うのは許容できない。
// したがって salesBaseState・marketEvolutionState・pdMechanizationState と同じ
// 「ターンをまたいで持ち越す会社状態」として実装する。
//
// 【中身は自社の意思決定履歴だけ】
// 記録するのは「自分が市場へ提出した販売計画」である。他社の計画も、市場の真の需要も
// 含まない（未来 TRUE WORLD の禁止）。成約側は既存の契約台帳（contracts）から
// 突き合わせるため、ここには保存しない（同じ事実を二重に持たない）。

import { PeriodV2 } from "../core/period";
import { unwrapUnit } from "../core/units";
import { DemandMarketId, Product } from "../market/types";
import { CompanyId } from "../sales/types";
import type { CompanyDecisionInput } from "./types";

/** 保持する四半期数。転換率の観測窓（4Q）＋余裕2Q。 */
export const COMMERCIAL_HISTORY_RETAINED_QUARTERS = 6;

/** 1四半期ぶんの、自社が市場へ提出した販売計画。 */
export interface CommercialSubmissionRecord {
  readonly turn: number;
  readonly period: PeriodV2;
  /** 会社合計の提出量（HOSO換算トン）。 */
  readonly submittedTotalTons: number;
  /** 市場×商品別の提出量（市場別の転換率を出せるようにする）。 */
  readonly submittedByMarketProduct: readonly {
    readonly market: DemandMarketId;
    readonly product: Product;
    readonly tons: number;
  }[];
}

export interface CompanyCommercialHistory {
  readonly companyId: CompanyId;
  readonly submissions: readonly CommercialSubmissionRecord[];
}

export interface CommercialHistoryState {
  readonly companies: readonly CompanyCommercialHistory[];
}

export const EMPTY_COMMERCIAL_HISTORY: readonly CommercialSubmissionRecord[] = [];

export function buildInitialCommercialHistoryState(companyIds: readonly CompanyId[]): CommercialHistoryState {
  return { companies: companyIds.map((companyId) => ({ companyId, submissions: [] })) };
}

/** 1社ぶんの履歴を取り出す（未知の会社・旧スナップショットでは空配列）。 */
export function commercialHistoryForCompany(
  state: CommercialHistoryState | undefined,
  companyId: CompanyId
): readonly CommercialSubmissionRecord[] {
  if (!state) return EMPTY_COMMERCIAL_HISTORY;
  return state.companies.find((c) => c.companyId === companyId)?.submissions ?? EMPTY_COMMERCIAL_HISTORY;
}

/**
 * 当期に確定した意思決定から、次期へ持ち越す履歴を作る。
 *
 * runner.ts の advanceCompanyLabQuarter が四半期処理の成功時に1回だけ呼ぶ
 * （既存のturnId冪等性guardと同じ経路に乗るため、二重追記は起こらない）。
 */
export function deriveNextCommercialHistoryState(
  previous: CommercialHistoryState | undefined,
  decisions: readonly CompanyDecisionInput[],
  period: PeriodV2,
  turn: number,
  retainedQuarters: number = COMMERCIAL_HISTORY_RETAINED_QUARTERS
): CommercialHistoryState {
  const byCompany = new Map<CompanyId, CommercialSubmissionRecord[]>();
  for (const company of previous?.companies ?? []) {
    byCompany.set(company.companyId, [...company.submissions]);
  }

  for (const decision of decisions) {
    const submittedByMarketProduct = decision.salesPlans.map((plan) => ({
      market: plan.market,
      product: plan.product,
      tons: unwrapUnit(plan.desiredQuantity),
    }));
    const record: CommercialSubmissionRecord = {
      turn,
      period,
      submittedTotalTons: submittedByMarketProduct.reduce((sum, cell) => sum + cell.tons, 0),
      submittedByMarketProduct,
    };
    const existing = byCompany.get(decision.companyId) ?? [];
    // 同一ターンの再処理では上書きする（冪等）。
    const withoutSameTurn = existing.filter((r) => r.turn !== turn);
    byCompany.set(decision.companyId, [...withoutSameTurn, record].slice(-Math.max(1, retainedQuarters)));
  }

  return {
    companies: [...byCompany.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([companyId, submissions]) => ({ companyId, submissions })),
  };
}
