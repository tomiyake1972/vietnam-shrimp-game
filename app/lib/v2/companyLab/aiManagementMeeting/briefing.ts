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
import { SalesContract } from "../../sales/types";
import { LifecycleTrendLabel, SupplyPressureLabel } from "../aiMarketInfoSummary";
import { ExecutiveRole } from "./types";

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

export interface BriefingBuildInput {
  readonly context: ExplanationContext;
  readonly previousQuarter: PreviousQuarterDelta | null;
  readonly playerDraft: PlayerDraftSummary | null;
  /** 【M2.1追加】Healthy Forward / Due This Turn / Overdueを分離するための生contracts（新しい観測ではなく、既存ownState.contractsをそのまま渡すだけ）。 */
  readonly contracts: readonly SalesContract[];
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
  const { context, previousQuarter, playerDraft, contracts } = input;
  const ownState = context.ownState;
  const diagEntries = context.standardAi.diagnosticEntries;

  const backlogSemantics = computeBacklogSemantics(contracts, context.identity.companyId, context.identity.year, context.identity.quarter);
  const backlogSummary: BacklogSummaryFacts = {
    totalTons: backlogSemantics.totalTons,
    healthyForwardTons: backlogSemantics.healthyForwardTons,
    dueThisTurnTons: backlogSemantics.dueThisTurnTons,
    overdueTons: backlogSemantics.overdueTons,
  };

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
