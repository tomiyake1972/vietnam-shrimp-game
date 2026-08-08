// ShrimpX V2 — 相談役AI  A. LIVE GAME STATE / B. STANDARD AI STATE の組み立て
//
// 【設計方針（実装指示§10・§11・§38）】
//   ・既存のExplanationContext（buildExplanationContext）をそのまま内包する。
//     Standard AIが実際に使った観測（自社状態・公開市場情報・decision・diagnostics）は
//     すべてここに含まれており、別系統で組み直さない。
//   ・そこに無いもの（財務三表・履歴・他社サマリー）だけを、既存のrepository・
//     viewModelが既に返している値から転記して足す。新しい計算は一切しない。
//   ・「毎回すべてを巨大promptへ入れない」（§10末尾）ため、質問の分類（questionRouting）に
//     応じて各層をnullにできる構造にしてある。
//
// 【情報境界（実装指示§45）】Owner Modeでは他社サマリー・ゲーム内部の値を参照してよいが、
// secret（APIキー・環境変数・DB認証情報・stack trace）は一切扱わない。この層は
// ゲームの状態しか触らないため、構造的にsecretへ到達できない。

import { CompanyQuarterSummary } from "../../types";
import { ExplanationContext } from "../../aiExplanation/buildExplanationContext";
import { StandardAiQuarterDiagnostics } from "../../standardAi/policy";
import { StandardAiChatContext, buildStandardAiChatContext } from "../../aiExplanation/chat/chatContext";

/** 財務三表の要約（既に算出・永続化済みの値の転記のみ。再計算しない）。 */
export interface AdvisorFinancialSnapshot {
  readonly period: string;
  readonly revenueUsd: number;
  readonly costOfSalesUsd: number;
  readonly grossProfitUsd: number;
  readonly sellingGeneralAdminUsd: number;
  readonly operatingIncomeUsd: number;
  readonly netIncomeUsd: number;
  readonly totalAssetsUsd: number;
  readonly totalLiabilitiesUsd: number;
  readonly totalEquityUsd: number;
  readonly cashUsd: number;
  readonly operatingCashFlowUsd: number;
  readonly investingCashFlowUsd: number;
  readonly financingCashFlowUsd: number;
  /** 現金がマイナス（資金不足）だったか。勝手に隠さず明示する。 */
  readonly cashShortfall: boolean;
  readonly negativeEquity: boolean;
}

/** 他社の要約（Owner Modeのみ）。公開四半期記録に既に含まれている値の抜粋。 */
export interface AdvisorCompetitorSummary {
  readonly companyId: string;
  readonly newContractedQuantityTons: number;
  readonly newContractedAveragePriceUsd: number;
  readonly fulfilledQuantityTons: number;
  readonly outstandingQuantityTons: number;
  readonly overdueQuantityTons: number;
  readonly domesticPurchaseQuantityTons: number;
  readonly rawMaterialInventoryTons: number;
  readonly finishedGoodsInventoryTons: number;
  readonly equipmentUtilizationRate: number;
  readonly laborUtilizationRate: number;
  readonly rawMaterialShortfallTons: number;
  readonly equipmentShortfallTons: number;
  readonly laborShortfallTons: number;
}

/** 履歴の1行（既存のrecentHistoryの転記）。 */
export interface AdvisorHistoryRow {
  readonly turn: number;
  readonly period: string;
  readonly summary: string;
}

export interface AdvisorLiveGameState {
  /** Standard AIが実際に観測した範囲（＝既存ExplanationContext）。 */
  readonly observed: ExplanationContext;
  /** 財務三表。含めない場合はnull。 */
  readonly financials: {
    readonly current: AdvisorFinancialSnapshot | null;
    readonly previous: AdvisorFinancialSnapshot | null;
  } | null;
  /** 直近の履歴要約。含めない場合はnull。 */
  readonly recentHistory: readonly AdvisorHistoryRow[] | null;
  /**
   * 他社サマリー（Owner Modeのみ・含めない場合はnull）。
   * 【情報境界の明示】これはプレイヤー画面には出ていない情報である。相談役AIは
   * これを使ってよいが、出所を GAME_INTERNAL_TRUE として区別しなければならない。
   */
  readonly competitors: readonly AdvisorCompetitorSummary[] | null;
  /** competitorsが「前四半期の確定記録」であることの明示（当期の他社計画ではない）。 */
  readonly competitorsNote: string;
}

export interface AdvisorStandardAiState {
  /** Standard AIの提案・診断・ボトルネック判定（Q&A機能と同一のcontextを再利用）。 */
  readonly chatContext: StandardAiChatContext;
  /**
   * 相談役AIがStandard AIをどう扱うべきかの宣言。
   * 「Standard AIは決定論的な参考モデルであり、相談役AIは独立に評価してよい」
   * （実装指示§30）を、promptだけでなくcontextにも明示する。
   */
  readonly evaluationPolicy: string;
}

const STANDARD_AI_EVALUATION_POLICY =
  "Standard AIは決定論的な参考モデルです。相談役AIはStandard AIに従う必要はなく、独立に評価・批判してよい。" +
  "ただし、diagnosticEntriesに存在しない理由を『Standard AIの理由』として述べてはいけない。" +
  "自分の見解はStandard AIの見解と明確に区別すること。";

const COMPETITORS_NOTE =
  "他社サマリーは前四半期の確定記録（公開清算後の実績）である。当期の他社の意思決定・計画ではない。" +
  "当期に他社が何をするかは、この時点では誰にも観測できない（推測で語らないこと）。";

/** 財務結果（既存の型）から、相談役AI向けの要約を作る。値の転記のみ。 */
export function toFinancialSnapshot(result: FinancialResultLike | null | undefined): AdvisorFinancialSnapshot | null {
  if (!result) return null;
  const pl = result.profitAndLoss;
  const bs = result.balanceSheet;
  const cf = result.cashFlow;
  return {
    period: String(result.period),
    revenueUsd: Number(pl.revenue),
    costOfSalesUsd: Number(pl.costOfSales),
    grossProfitUsd: Number(pl.grossProfit),
    sellingGeneralAdminUsd: Number(pl.sellingGeneralAdministrativeExpenses),
    operatingIncomeUsd: Number(pl.operatingIncome),
    netIncomeUsd: Number(pl.netIncome),
    totalAssetsUsd: Number(bs.totalAssets),
    totalLiabilitiesUsd: Number(bs.totalLiabilities),
    totalEquityUsd: Number(bs.totalEquity),
    cashUsd: Number(bs.cash),
    operatingCashFlowUsd: Number(cf.operatingCashFlow),
    investingCashFlowUsd: Number(cf.investingCashFlow),
    financingCashFlowUsd: Number(cf.financingCashFlow),
    cashShortfall: Boolean(result.cashShortfall),
    negativeEquity: Boolean(result.negativeEquity),
  };
}

/**
 * 既存のCompanyFinancialQuarterResultの、この層が使う部分だけの構造的な型。
 * financeモジュールのbrand付き数値をそのまま受け取れるよう、numberではなくunknown寄りにせず
 * 「Number()で数値化できるもの」として受ける（brandはNumber()で外れる）。
 */
export interface FinancialResultLike {
  readonly period: unknown;
  readonly profitAndLoss: {
    readonly revenue: number;
    readonly costOfSales: number;
    readonly grossProfit: number;
    readonly sellingGeneralAdministrativeExpenses: number;
    readonly operatingIncome: number;
    readonly netIncome: number;
  };
  readonly balanceSheet: {
    readonly totalAssets: number;
    readonly totalLiabilities: number;
    readonly totalEquity: number;
    readonly cash: number;
  };
  readonly cashFlow: {
    readonly operatingCashFlow: number;
    readonly investingCashFlow: number;
    readonly financingCashFlow: number;
  };
  readonly cashShortfall?: boolean;
  readonly negativeEquity?: boolean;
}

/** 公開四半期記録のcompanySummariesから、他社ぶんだけを抜き出す。 */
export function toCompetitorSummaries(
  summaries: readonly CompanyQuarterSummary[],
  playerCompanyId: string
): readonly AdvisorCompetitorSummary[] {
  return summaries
    .filter((s) => s.companyId !== playerCompanyId)
    .map((s) => ({
      companyId: s.companyId,
      newContractedQuantityTons: Number(s.newContractedQuantity),
      newContractedAveragePriceUsd: Number(s.newContractedAveragePrice),
      fulfilledQuantityTons: Number(s.fulfilledQuantity),
      outstandingQuantityTons: Number(s.outstandingQuantity),
      overdueQuantityTons: Number(s.overdueQuantity),
      domesticPurchaseQuantityTons: Number(s.domesticPurchaseQuantity),
      rawMaterialInventoryTons: Number(s.rawMaterialInventory),
      finishedGoodsInventoryTons: Number(s.finishedGoodsInventory),
      equipmentUtilizationRate: Number(s.equipmentUtilizationRate),
      laborUtilizationRate: Number(s.laborUtilizationRate),
      rawMaterialShortfallTons: Number(s.rawMaterialShortfall),
      equipmentShortfallTons: Number(s.equipmentShortfall),
      laborShortfallTons: Number(s.laborShortfall),
    }));
}

export interface BuildLiveGameStateInput {
  readonly observed: ExplanationContext;
  readonly currentFinancials: FinancialResultLike | null;
  readonly previousFinancials: FinancialResultLike | null;
  readonly recentHistory: readonly AdvisorHistoryRow[];
  readonly competitorSummaries: readonly CompanyQuarterSummary[] | null;
  readonly playerCompanyId: string;
  readonly include: {
    readonly financials: boolean;
    readonly history: boolean;
    readonly competitors: boolean;
  };
}

export function buildAdvisorLiveGameState(input: BuildLiveGameStateInput): AdvisorLiveGameState {
  return {
    observed: input.observed,
    financials: input.include.financials
      ? { current: toFinancialSnapshot(input.currentFinancials), previous: toFinancialSnapshot(input.previousFinancials) }
      : null,
    recentHistory: input.include.history ? input.recentHistory : null,
    competitors:
      input.include.competitors && input.competitorSummaries !== null
        ? toCompetitorSummaries(input.competitorSummaries, input.playerCompanyId)
        : null,
    competitorsNote: COMPETITORS_NOTE,
  };
}

export function buildAdvisorStandardAiState(
  observed: ExplanationContext,
  diagnostics: StandardAiQuarterDiagnostics
): AdvisorStandardAiState {
  return {
    chatContext: buildStandardAiChatContext(observed, diagnostics),
    evaluationPolicy: STANDARD_AI_EVALUATION_POLICY,
  };
}
