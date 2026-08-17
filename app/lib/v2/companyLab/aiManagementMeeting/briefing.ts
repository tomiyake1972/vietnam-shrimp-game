// ShrimpX V2 — AI Management Meeting: ExecutiveBriefingPacket 組み立て（AMM-M0/M1・M2.1）
//
// 【新しい状態読み込み経路を作らない】既存のaiExplanation/buildExplanationContext.ts
// （プレイヤー画面が既に見ている範囲だけをALLOWLISTしたContext）をそのまま入力として
// 再利用し、そこから各Executive役割向けの「厚いsubset」を切り出すだけの純粋関数群。
// 生の状態（fixture/ownState等）を再度読みに行ったり、新しい能力算出ロジックを
// 増設したりしない。
//
// 【トークン予算の規律（三宅さんの追加指示§11）】32Qの生履歴は一切含めない。
// 現在turnの値＋直近1四半期比較（previousQuarterFinancials/previousQuarterMarket。
// これがPlayerScreenViewModelが実際に保持する「trend」の範囲であり、それ以上の
// 3-4Q trendを構築するための追加の履歴読み込み経路は現時点で存在しないため、
// 新設しない。この制約はdocs/v2/ai_management_meeting_mvp.mdに明記する）と、
// 上位N件（backlog/factory/reason codes）に圧縮する。診断JSON全体やStandard AIの
// 意思決定の冗長な再送はしない。
//
// 【derived object・非永続】この関数群はいずれもpersistent stateを新設しない。
// 呼び出しのたびにExplanationContextから再構築する。
//
// 【M2.1・Backlog Semantics / Fact Grounding訂正】初版のcommon.overdueBacklogTopNは、
// 名前に反してoverdue（納期超過）かどうかを一切判定していなかった
// （computeBacklogByMarketProductの単純な合計をそのまま「overdue」と誤命名していた）。
// backlogSemantics.tsのcomputeBacklogSemantics（既存SalesContract.dueDate・
// outstandingQuantityだけから導出、新しい観測は追加しない）を使い、Healthy Forward /
// Due This Turn / Overdueを明示的に分離した値だけを渡す。あわせて、supplyPressure/
// lifecycleTrendの生カウントだけを渡す設計（Claudeが自由に意味解釈してしまう余地が
// あった）をやめ、既存の分類ラベル（classifySupplyPressure等）にhumanMeaningを
// 付与した形へ変更した。

import { ExplanationContext } from "../aiExplanation/buildExplanationContext";
import { computeBacklogSemantics } from "./backlogSemantics";
import { computeFinanceSemantics, FinanceSemantics } from "./financeSemantics";
import {
  buildBalanceSheetPacket,
  buildCashFlowPacket,
  buildPnlPacket,
  computePnlVariance,
  computeVolumePriceFacts,
  FinancialStatementsPacket,
  PnlVariance,
  VolumePriceFacts,
} from "./pnlSemantics";
import { SalesContract } from "../../sales/types";
import { BalanceSheet, CashFlowStatement, PayableRecord, ProfitAndLossStatement, ReceivableRecord } from "../../finance/types";
import { LoanRecord } from "../../financing/types";
import { CapitalProject } from "../../capex/types";
import { LifecycleTrendLabel, SupplyPressureLabel } from "../aiMarketInfoSummary";
import { ExecutiveRole } from "./types";

/** ExecutiveBriefingPacket・promptの整合性を識別するバージョン（実装指示§20）。prompt.tsのAI_MEETING_PROMPT_VERSIONと対にして管理する。 */
export const EXECUTIVE_BRIEFING_VERSION = "v4";

/**
 * 【M2.2追加・実装指示§19】誤解しやすい重要ルールについての、短い固定context
 * （company状態に依存しない定数）。毎回コンパクトなまま全roleへ渡す
 * （token増大を最小限にするため、company別に変わる長文説明にはしない）。
 */
export const RULE_SEMANTICS: Readonly<Record<string, string>> = {
  backlog: "受注残（未履行の契約数量）。納期を問わない合計であり、それ自体はoverdue（納期超過）を意味しない。",
  overdue: "受注残のうち、納期（due turn）が既に過ぎている数量のみ。overdueTonsが0またはbriefingに無ければ、backlogを遅延として説明してはいけない。",
  healthyForwardBacklog: "納期が未到来の受注残。将来需要の可視化として通常の健全な状態であり、delivery failureではない。",
  receivables: "売掛金。ShrimpXでは発生四半期からarCollectionQuarters（現在1四半期）後に、市場や商品によらず一律で現金化される。Customer Trustが回収タイミングへ影響するルールは存在しない。",
  customerTrust: "品質・納期実績を反映するスコア。売掛金の回収タイミングには影響しない（そのようなgame mechanicは存在しない）。",
  // 【M2.3追加・実装指示§16】P&L/Cash Flow/Balance Sheetの混同を防ぐための会計用語定義。
  operatingProfit: "発生主義会計のP&L指標（収益・費用の認識ベース）。売掛金の現金回収タイミングで説明してはいけない。",
  accountsReceivable: "Balance Sheet上の資産（未回収の顧客残高）。回収タイミングはCash（BS/CF）に影響するが、それ自体だけではOperating Profitに影響しない。",
  operatingCashFlow: "営業活動による現金の動き。Operating Profit（発生主義の利益）とは別概念であり同一視してはいけない。",
  interestExpense: "Operating Profitの下（Operating Profitには含まれない）。Net Incomeの計算にのみ含まれる。",
};

/** previousQuarterFinancials/previousQuarterMarketは既存のPlayerScreenViewModel型（app/v2層）
 * にあるため、ここでは呼び出し側が必要な数値だけを抜き出した最小限の型として受け取る
 * （lib/v2からapp/v2のUI層型へ依存しないようにするため）。 */
export interface PreviousQuarterDelta {
  readonly cashUsd: number | null;
  readonly netRevenueUsd: number | null;
  readonly operatingProfitUsd: number | null;
  /** 【M2.1追加】この数値がどのturn/四半期のものかを明示するラベル（例: "2015年Q1"）。turn1等でnullの場合は前四半期データ自体が存在しない。 */
  readonly periodLabel: string | null;
}

/** プレイヤーの現在draft（未提出の編集中案）の要約。app/v2層のCompanyDecisionDraftから
 * 呼び出し側が数値だけを抜き出す（同上の理由でlib/v2からUI層型へ依存しない）。 */
export interface PlayerDraftSummary {
  readonly hasDraft: boolean;
  readonly totalDesiredSalesQuantityTons: number;
  readonly capexProposalCount: number;
  readonly financingRequestedUsd: number;
}

/** 【M2.2追加】前四半期に計算済みの実際のBorrowingCapacityResult（既存financing/liquidityClose.tsの結果をそのまま転記するだけ。ここで再計算しない）。 */
export interface BorrowingHeadroomFact {
  readonly availableAdditionalCapacityUsd: number;
  readonly asOfLabel: string;
}

/** 【M2.2追加】既存Standard AI diagnostics.crisis（crisisState.ts）をそのまま転記するだけ。新しいcrisis判定ロジックは作らない。 */
export interface CrisisFact {
  readonly state: "NORMAL" | "LIQUIDITY_STRESS" | "SEVERE_DISTRESS";
  readonly summary: string;
}

export interface BriefingBuildInput {
  readonly context: ExplanationContext;
  readonly previousQuarter: PreviousQuarterDelta | null;
  readonly playerDraft: PlayerDraftSummary | null;
  /** 【M2.1追加】Healthy Forward / Due This Turn / Overdueを分離するための生contracts（新しい観測ではなく、既存ownState.contractsをそのまま渡すだけ）。 */
  readonly contracts: readonly SalesContract[];
  /** 【M2.2追加】CFO Finance Briefing監査（実装指示§4・§5）対応の生finance state（既存ownState.financeState/financingState/capexStateをそのまま渡すだけ）。 */
  readonly receivables: readonly ReceivableRecord[];
  readonly payables: readonly PayableRecord[];
  readonly loans: readonly LoanRecord[];
  readonly capexProjects: readonly CapitalProject[];
  readonly borrowingHeadroom: BorrowingHeadroomFact | null;
  readonly crisis: CrisisFact | null;
  /**
   * 【M2.3追加・実装指示§3-§10】P&L/Cash Flow/Balance Sheet分離・variance分析に必要な
   * 直近2四半期ぶんの実績（既存CompanyFinancialQuarterResult・CompanyQuarterSummaryを
   * そのまま渡すだけ。新しい会計計算は一切しない）。reportingPeriodは「プレイヤーが
   * 今聞いている直近の確定四半期」、priorPeriodはそのvariance比較対象（1つ前の四半期）。
   * いずれもturn1・turn2等で実績が無い場合はnull（捏造しない）。
   */
  readonly financialHistory: {
    readonly reportingPeriod: {
      readonly pnl: ProfitAndLossStatement;
      readonly cashFlow: CashFlowStatement;
      readonly balanceSheet: BalanceSheet;
      readonly periodLabel: string;
      readonly fulfilledQuantityTons: number;
    } | null;
    readonly priorPeriod: {
      readonly pnl: ProfitAndLossStatement;
      readonly periodLabel: string;
      readonly fulfilledQuantityTons: number;
    } | null;
  };
}

const TOP_N_FACTORY = 5;
const TOP_N_REASON_CODES = 8;

/** common.backlog・commercial.backlog双方が共有する、Healthy Forward/Due/Overdueの要約。 */
export interface BacklogSummaryFacts {
  readonly totalTons: number;
  readonly healthyForwardTons: number;
  readonly dueThisTurnTons: number;
  readonly overdueTons: number;
}

export interface BriefingCommonFacts {
  readonly companyId: string;
  readonly turn: number;
  readonly year: number;
  readonly quarter: number;
  readonly cashUsd: number;
  readonly bindingCapacityTons: number;
  readonly bindingConstraintLabel: string;
  readonly backlog: BacklogSummaryFacts;
  readonly playerDraft: PlayerDraftSummary | null;
  readonly standardAiReasonCodesTopN: readonly { readonly code: string; readonly domain: string; readonly severity: string; readonly targetFactoryId?: string }[];
  /** 【M2.2追加】briefing/prompt versionの識別子（実装指示§20）。 */
  readonly briefingVersion: string;
  /** 【M2.2追加】誤解しやすい重要ルールの短い固定定義（実装指示§19）。 */
  readonly ruleSemantics: Readonly<Record<string, string>>;
  /** 【M2.2追加】既存Standard AI crisis判定の転記のみ（新しい危機判定は作らない）。 */
  readonly crisis: CrisisFact | null;
}

export interface CfoBriefing {
  readonly totalAssetsUsd: number;
  readonly totalLiabilitiesUsd: number;
  readonly totalEquityUsd: number;
  readonly shortTermLoansUsd: number;
  readonly longTermLoansUsd: number;
  readonly activeLoanCount: number;
  readonly payablesUsd: number;
  readonly receivablesUsd: number;
  /** 【M2.2追加・実装指示§5「AR balanceとcash collection scheduleを分離」】既存ReceivableRecord.dueSettlementPeriodのみから導出。 */
  readonly receivablesScheduleByPeriod: readonly { readonly periodLabel: string; readonly amountUsd: number; readonly turnsFromNow: number }[];
  readonly payablesScheduleByPeriod: readonly { readonly periodLabel: string; readonly amountUsd: number; readonly turnsFromNow: number }[];
  /** 【M2.2追加】融資の返済延滞（既存LoanRecord.arrearsPrincipalUsd/arrearsInterestUsd）。売掛金にはarrearsフィールドが存在しないため0のみで表現される。 */
  readonly loanArrearsPrincipalUsd: number;
  readonly loanArrearsInterestUsd: number;
  /** 【M2.2追加】承認済み未払CAPEXコミット残高（既存CapitalProject.approvedBudgetUsd - cumulativePaidUsdの合計）。 */
  readonly activeCapexRemainingCommitmentUsd: number;
  /** 【M2.2追加】前四半期に計算済みの実際の追加借入余力（既存BorrowingCapacityResult.availableAdditionalCapacityUsdの転記）。turn1等でnull。 */
  readonly borrowingHeadroom: BorrowingHeadroomFact | null;
  readonly crisis: CrisisFact | null;
  readonly previousQuarter: PreviousQuarterDelta | null;
  /**
   * 【M2.3追加・実装指示§3】P&L/Cash Flow/Balance Sheetを明示的に分離したセクション。
   * turn1等、直近確定四半期の実績が存在しない場合はnull（捏造しない）。
   */
  readonly financialStatements: FinancialStatementsPacket | null;
  /** 【M2.3追加・実装指示§9】直近確定四半期とその1つ前の四半期とのP&L差分。両方の実績が揃わない場合はnull。 */
  readonly pnlVariance: PnlVariance | null;
  /** 【M2.3追加・実装指示§12】既存fulfilledQuantity・netRevenueの単純な除算による数量・実現単価の前期比較。 */
  readonly volumePriceFacts: VolumePriceFacts | null;
}

export interface CooBriefing {
  readonly factoryCapacityTopN: readonly {
    readonly factoryId: string;
    readonly nominalTotalTons: number;
    readonly effectiveTotalTons: number;
  }[];
  readonly nominalTotalTons: number;
  readonly effectiveTotalTons: number;
  readonly rawMaterialTotalTons: number;
  readonly totalRegularHeadcount: number;
  readonly qualityScoreByProduct: Readonly<Partial<Record<string, number>>>;
  /** 【M2.1追加】商品別のbacklog内訳（overdue分離済み）。生産計画の参考情報。 */
  readonly backlogByProduct: readonly { readonly product: string; readonly totalTons: number; readonly overdueTons: number }[];
}

export interface SupplyPressureFact {
  readonly product: string;
  readonly value: number;
  readonly label: SupplyPressureLabel;
  readonly humanMeaning: string;
}

export interface LifecycleTrendSummary {
  readonly growingCount: number;
  readonly shrinkingCount: number;
  readonly flatCount: number;
  readonly humanMeaning: string;
}

export interface CommercialBriefing {
  readonly backlog: BacklogSummaryFacts;
  readonly backlogByMarket: readonly { readonly market: string; readonly totalTons: number; readonly overdueTons: number }[];
  readonly backlogByProduct: readonly { readonly product: string; readonly totalTons: number; readonly overdueTons: number }[];
  readonly backlogByMarketProduct: readonly {
    readonly market: string;
    readonly product: string;
    readonly totalTons: number;
    readonly overdueTons: number;
    readonly dueThisTurnTons: number;
    readonly healthyForwardTons: number;
    readonly earliestDueLabel: string;
  }[];
  readonly customerTrustByMarket: Readonly<Partial<Record<string, number>>>;
  readonly deliveryReliabilityByMarket: Readonly<Partial<Record<string, number>>>;
  readonly salesForceHeadcountTotal: number;
  readonly salesForceCoverageScore: number;
  /** 【M2.1追加】直近の実績売上（previousQuarterと同じ値だが、Commercial自身が「いつの売上か」を誤ラベルしないよう、periodLabelとセットでここにも持たせる）。 */
  readonly lastQuarterNetRevenueUsd: number | null;
  readonly lastQuarterLabel: string | null;
  readonly hasPriorMarketData: boolean;
  /** 【M2.1訂正】単なる件数(count)ではなく、各商品の供給圧力ラベル＋意味説明を渡す（生key解釈をClaudeへ委ねない）。 */
  readonly supplyPressureFacts: readonly SupplyPressureFact[];
  readonly lifecycleTrendSummary: LifecycleTrendSummary | null;
}

export interface CeoBriefing {
  readonly topSeverityReasonCodesTopN: readonly { readonly code: string; readonly severity: string }[];
  readonly domainsInvolved: readonly string[];
}

export interface ExecutiveBriefingPacket {
  readonly common: BriefingCommonFacts;
  readonly cfo: CfoBriefing;
  readonly coo: CooBriefing;
  readonly commercial: CommercialBriefing;
  readonly ceo: CeoBriefing;
}

function severityRank(s: string): number {
  if (s === "critical" || s === "high") return 3;
  if (s === "medium" || s === "warning") return 2;
  return 1;
}

const SUPPLY_PRESSURE_MEANING: Readonly<Record<SupplyPressureLabel, string>> = {
  oversupply: "市場全体で供給が需要を上回る方向（価格・受注獲得はしやすいが、過剰在庫リスクに注意）",
  undersupply: "市場全体で供給が需要に対して不足気味（受注は取りやすいが、供給側の制約に注意）",
  balanced: "市場全体の需給はおおむね均衡",
};

const LIFECYCLE_TREND_MEANING: Readonly<Record<LifecycleTrendLabel, string>> = {
  growing: "この市場×商品の構成比が拡大傾向",
  shrinking: "この市場×商品の構成比が縮小傾向",
  flat: "この市場×商品の構成比はほぼ横ばい",
};

export function buildExecutiveBriefingPacket(input: BriefingBuildInput): ExecutiveBriefingPacket {
  const { context, previousQuarter, playerDraft, contracts, receivables, payables, loans, capexProjects, borrowingHeadroom, crisis, financialHistory } = input;
  const ownState = context.ownState;
  const diagEntries = context.standardAi.diagnosticEntries;

  const { reportingPeriod, priorPeriod } = financialHistory;
  const financialStatements: FinancialStatementsPacket | null = reportingPeriod
    ? {
        pnl: buildPnlPacket(reportingPeriod.pnl, reportingPeriod.periodLabel),
        cashFlow: buildCashFlowPacket(reportingPeriod.cashFlow, reportingPeriod.periodLabel),
        balanceSheet: buildBalanceSheetPacket(reportingPeriod.balanceSheet, reportingPeriod.periodLabel),
      }
    : null;
  const pnlVariance: PnlVariance | null =
    reportingPeriod && priorPeriod ? computePnlVariance(reportingPeriod.pnl, priorPeriod.pnl, reportingPeriod.periodLabel, priorPeriod.periodLabel) : null;
  const volumePriceFacts: VolumePriceFacts | null =
    reportingPeriod && priorPeriod
      ? computeVolumePriceFacts(
          reportingPeriod.fulfilledQuantityTons,
          reportingPeriod.pnl.netRevenue as unknown as number,
          priorPeriod.fulfilledQuantityTons,
          priorPeriod.pnl.netRevenue as unknown as number,
          reportingPeriod.periodLabel,
          priorPeriod.periodLabel
        )
      : null;

  const backlogSemantics = computeBacklogSemantics(contracts, context.identity.companyId, context.identity.year, context.identity.quarter);
  const backlogSummary: BacklogSummaryFacts = {
    totalTons: backlogSemantics.totalTons,
    healthyForwardTons: backlogSemantics.healthyForwardTons,
    dueThisTurnTons: backlogSemantics.dueThisTurnTons,
    overdueTons: backlogSemantics.overdueTons,
  };

  const financeSemantics: FinanceSemantics = computeFinanceSemantics(
    receivables,
    payables,
    loans,
    capexProjects,
    context.identity.companyId,
    context.identity.year,
    context.identity.quarter
  );

  const reasonCodesTopN = [...diagEntries]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, TOP_N_REASON_CODES)
    .map((e) => ({ code: e.code, domain: e.domain, severity: e.severity, targetFactoryId: e.targetFactoryId }));

  const common: BriefingCommonFacts = {
    companyId: context.identity.companyId,
    turn: context.identity.turn,
    year: context.identity.year,
    quarter: context.identity.quarter,
    cashUsd: ownState.balanceSheet.cashUsd,
    bindingCapacityTons: ownState.productionCapacitySummary.bindingTotalTons,
    bindingConstraintLabel: ownState.productionCapacitySummary.bindingConstraintLabel,
    backlog: backlogSummary,
    playerDraft,
    standardAiReasonCodesTopN: reasonCodesTopN,
    briefingVersion: EXECUTIVE_BRIEFING_VERSION,
    ruleSemantics: RULE_SEMANTICS,
    crisis,
  };

  const cfo: CfoBriefing = {
    totalAssetsUsd: ownState.balanceSheet.totalAssetsUsd,
    totalLiabilitiesUsd: ownState.balanceSheet.totalLiabilitiesUsd,
    totalEquityUsd: ownState.balanceSheet.totalEquityUsd,
    shortTermLoansUsd: ownState.balanceSheet.shortTermLoansUsd,
    longTermLoansUsd: ownState.balanceSheet.longTermLoansUsd,
    activeLoanCount: ownState.balanceSheet.activeLoanCount,
    payablesUsd: ownState.balanceSheet.payablesUsd,
    receivablesUsd: ownState.balanceSheet.receivablesUsd,
    receivablesScheduleByPeriod: financeSemantics.receivablesScheduleByPeriod,
    payablesScheduleByPeriod: financeSemantics.payablesScheduleByPeriod,
    loanArrearsPrincipalUsd: financeSemantics.loanArrearsPrincipalUsd,
    loanArrearsInterestUsd: financeSemantics.loanArrearsInterestUsd,
    activeCapexRemainingCommitmentUsd: financeSemantics.activeCapexRemainingCommitmentUsd,
    borrowingHeadroom,
    crisis,
    previousQuarter,
    financialStatements,
    pnlVariance,
    volumePriceFacts,
  };

  const coo: CooBriefing = {
    factoryCapacityTopN: [...ownState.factoryCapacity]
      .sort((a, b) => (b.effective.hoso + b.effective.pd + b.effective.vap) - (a.effective.hoso + a.effective.pd + a.effective.vap))
      .slice(0, TOP_N_FACTORY)
      .map((c) => ({
        factoryId: c.factoryId,
        nominalTotalTons: (c.nominal.hoso ?? 0) + (c.nominal.pd ?? 0) + (c.nominal.vap ?? 0),
        effectiveTotalTons: (c.effective.hoso ?? 0) + (c.effective.pd ?? 0) + (c.effective.vap ?? 0),
      })),
    nominalTotalTons: ownState.productionCapacitySummary.nominalTotalTons,
    effectiveTotalTons: ownState.productionCapacitySummary.effectiveTotalTons,
    rawMaterialTotalTons: ownState.rawMaterialInventory.totalTons,
    totalRegularHeadcount: ownState.workforce.totalRegularHeadcount,
    qualityScoreByProduct: ownState.qualityScoreByProduct,
    backlogByProduct: backlogSemantics.byProduct,
  };

  const supplyPressureFacts: SupplyPressureFact[] = (context.marketInfo.supplyPressure ?? []).map((row) => ({
    product: row.product,
    value: row.value,
    label: row.label,
    humanMeaning: SUPPLY_PRESSURE_MEANING[row.label],
  }));

  const lifecycleTrends = context.marketInfo.lifecycleTrends ?? [];
  const lifecycleTrendSummary: LifecycleTrendSummary | null =
    lifecycleTrends.length > 0
      ? {
          growingCount: lifecycleTrends.filter((t) => t.label === "growing").length,
          shrinkingCount: lifecycleTrends.filter((t) => t.label === "shrinking").length,
          flatCount: lifecycleTrends.filter((t) => t.label === "flat").length,
          humanMeaning: `growing=${LIFECYCLE_TREND_MEANING.growing}、shrinking=${LIFECYCLE_TREND_MEANING.shrinking}、flat=${LIFECYCLE_TREND_MEANING.flat}`,
        }
      : null;

  const commercial: CommercialBriefing = {
    backlog: backlogSummary,
    backlogByMarket: backlogSemantics.byMarket,
    backlogByProduct: backlogSemantics.byProduct,
    backlogByMarketProduct: backlogSemantics.byMarketProduct,
    customerTrustByMarket: ownState.customerTrustByMarket,
    deliveryReliabilityByMarket: ownState.deliveryReliabilityByMarket,
    salesForceHeadcountTotal: ownState.salesForce.headcountTotal,
    salesForceCoverageScore: ownState.salesForce.coverageScore,
    lastQuarterNetRevenueUsd: previousQuarter?.netRevenueUsd ?? null,
    lastQuarterLabel: previousQuarter?.periodLabel ?? null,
    hasPriorMarketData: context.marketInfo.hasPriorMarketData,
    supplyPressureFacts,
    lifecycleTrendSummary,
  };

  const ceo: CeoBriefing = {
    topSeverityReasonCodesTopN: reasonCodesTopN.slice(0, 4).map((r) => ({ code: r.code, severity: r.severity })),
    domainsInvolved: Array.from(new Set(diagEntries.map((e) => e.domain))),
  };

  return { common, cfo, coo, commercial, ceo };
}

/**
 * Claudeへ渡すJSON文字列を、役割ごとに必要なsubsetだけへ絞って組み立てる
 * （commonは常に含める。CEOはcommon＋ceoのみの軽量版でよい）。
 */
export function selectBriefingForRoles(packet: ExecutiveBriefingPacket, roles: readonly ExecutiveRole[]): Record<string, unknown> {
  const result: Record<string, unknown> = { common: packet.common };
  for (const role of roles) {
    if (role === "CFO") result.cfo = packet.cfo;
    if (role === "COO") result.coo = packet.coo;
    if (role === "COMMERCIAL") result.commercial = packet.commercial;
    if (role === "CEO") result.ceo = packet.ceo;
  }
  return result;
}
