// ShrimpX V2 — AI Management Meeting: ExecutiveBriefingPacket 組み立て（AMM-M0/M1）
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

import { ExplanationContext } from "../aiExplanation/buildExplanationContext";
import { ExecutiveRole } from "./types";

/** previousQuarterFinancials/previousQuarterMarketは既存のPlayerScreenViewModel型（app/v2層）
 * にあるため、ここでは呼び出し側が必要な数値だけを抜き出した最小限の型として受け取る
 * （lib/v2からapp/v2のUI層型へ依存しないようにするため）。 */
export interface PreviousQuarterDelta {
  readonly cashUsd: number | null;
  readonly netRevenueUsd: number | null;
  readonly operatingProfitUsd: number | null;
}

/** プレイヤーの現在draft（未提出の編集中案）の要約。app/v2層のCompanyDecisionDraftから
 * 呼び出し側が数値だけを抜き出す（同上の理由でlib/v2からUI層型へ依存しない）。 */
export interface PlayerDraftSummary {
  readonly hasDraft: boolean;
  readonly totalDesiredSalesQuantityTons: number;
  readonly capexProposalCount: number;
  readonly financingRequestedUsd: number;
}

export interface BriefingBuildInput {
  readonly context: ExplanationContext;
  readonly previousQuarter: PreviousQuarterDelta | null;
  readonly playerDraft: PlayerDraftSummary | null;
}

const TOP_N_BACKLOG = 5;
const TOP_N_FACTORY = 5;
const TOP_N_REASON_CODES = 8;

export interface BriefingCommonFacts {
  readonly companyId: string;
  readonly turn: number;
  readonly year: number;
  readonly quarter: number;
  readonly cashUsd: number;
  readonly bindingCapacityTons: number;
  readonly bindingConstraintLabel: string;
  readonly overdueBacklogTopN: readonly { readonly market: string; readonly product: string; readonly outstandingTons: number; readonly nearestDueDateLabel: string }[];
  readonly playerDraft: PlayerDraftSummary | null;
  readonly standardAiReasonCodesTopN: readonly { readonly code: string; readonly domain: string; readonly severity: string; readonly targetFactoryId?: string }[];
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
  readonly previousQuarter: PreviousQuarterDelta | null;
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
}

export interface CommercialBriefing {
  readonly backlogByMarketProduct: readonly { readonly market: string; readonly product: string; readonly outstandingTons: number; readonly contractCount: number }[];
  readonly customerTrustByMarket: Readonly<Partial<Record<string, number>>>;
  readonly deliveryReliabilityByMarket: Readonly<Partial<Record<string, number>>>;
  readonly salesForceHeadcountTotal: number;
  readonly salesForceCoverageScore: number;
  readonly hasPriorMarketData: boolean;
  readonly lifecycleTrendCount: number;
  readonly supplyPressureCount: number;
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

export function buildExecutiveBriefingPacket(input: BriefingBuildInput): ExecutiveBriefingPacket {
  const { context, previousQuarter, playerDraft } = input;
  const ownState = context.ownState;
  const diagEntries = context.standardAi.diagnosticEntries;

  const overdueBacklogTopN = [...ownState.contractBacklog]
    .sort((a, b) => b.outstandingTons - a.outstandingTons)
    .slice(0, TOP_N_BACKLOG)
    .map((b) => ({ market: b.market, product: b.product, outstandingTons: b.outstandingTons, nearestDueDateLabel: b.nearestDueDateLabel }));

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
    overdueBacklogTopN,
    playerDraft,
    standardAiReasonCodesTopN: reasonCodesTopN,
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
    previousQuarter,
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
  };

  const commercial: CommercialBriefing = {
    backlogByMarketProduct: ownState.contractBacklog.map((b) => ({
      market: b.market,
      product: b.product,
      outstandingTons: b.outstandingTons,
      contractCount: b.contractCount,
    })),
    customerTrustByMarket: ownState.customerTrustByMarket,
    deliveryReliabilityByMarket: ownState.deliveryReliabilityByMarket,
    salesForceHeadcountTotal: ownState.salesForce.headcountTotal,
    salesForceCoverageScore: ownState.salesForce.coverageScore,
    hasPriorMarketData: context.marketInfo.hasPriorMarketData,
    lifecycleTrendCount: context.marketInfo.lifecycleTrends?.length ?? 0,
    supplyPressureCount: context.marketInfo.supplyPressure?.length ?? 0,
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
