// ShrimpX V2 — AI Management Meeting: Turn Change Briefing（AMM-M2.7）
//
// 【背景・目的（実装指示§0）】新しいTurnに入った際、プレイヤーが何も質問していなくても
// 「前四半期から何が変わったか」をAI Management Meetingが自動で短く説明できるように
// する。ただし、AI役員が自動で長い会議を始める設計にはしない。基本UX:
// Turn開始 → deterministic TurnChangeBriefing生成 → AIが3〜5点だけ短く説明 →
// プレイヤーが気になる論点を質問 → 通常のAI Meetingへ移行。
//
// 【原則（実装指示§1）】Turn ChangeはClaudeに計算させない。Game/Analysis factsから
// server-side deterministicに差分計算する。Claudeの役割は重要性の解釈・優先順位付け・
// 経営的な短い説明のみ。
//
// 【二重ロジック禁止】本モジュールはP&L variance（pnlSemantics.computePnlVariance/
// computeVolumePriceFacts）・bottleneck判定（operationalSemantics.
// computeBottleneckHierarchy）・backlog due-date semantics（既存
// CompanyQuarterSummary.outstandingQuantity/overdueQuantity。これはM2.1が問題視した
// computeBacklogByMarketProductの誤命名フィールドとは別の、runner.ts側で正しく
// status==="overdue"を集計している既存フィールド）を、すべて既存モジュールの関数・
// 既存フィールドの単純な転記・差分としてのみ利用する。新しい会計計算・新しい生産計算・
// 新しいbacklog判定基準は一切追加しない。
//
// 【入力の出所】fromTurn/toTurnは、既存AI Meeting handlers.tsが既に使っている
// reportingPeriodSnapshot（=currentTurn-1の確定実績）・priorPeriodSnapshot
// （=currentTurn-2の確定実績）と同じ2つの確定四半期スナップショットを使う
// （P&L varianceが既にこの2四半期ペアで計算されているのと同じペア）。
//
// 【既知の簡略化（remaining risksへ明記）】
// - capacity pools（common/hoso/pd/vap/freezing）の「過去turnの実効能力」は、
//   engineの永続履歴に工場別実効能力のスナップショットが存在しないため取得できない。
//   本モジュールは現在値のみを提供し、CAPEX完了イベント（completedPeriod一致）の
//   有無をcapacityIncreasedThisTurnとして代わりに提供する（能力増分を独自に
//   再計算・推定することはしない）。
// - salesForceHeadcountは、確定四半期ごとの実際の人員数スナップショットが
//   engine履歴に存在しないため、現在値のみを提供する（previous=null）。

import { CompanyQuarterSummary } from "../types";
import { ProductionAllocationEntry, WorkerAssignment } from "../../production/types";
import { BalanceSheet, ProfitAndLossStatement } from "../../finance/types";
import { CapitalProject } from "../../capex/types";
import { PeriodV2 } from "../../core/period";
import { unwrapUnit } from "../../core/units";
import { computePnlVariance, computeVolumePriceFacts, PnlVariance, VolumePriceFacts } from "./pnlSemantics";
import { BottleneckCategory, computeBottleneckHierarchy } from "./operationalSemantics";
import { CapacityPools } from "./capacitySemantics";
import { ExecutiveBriefingPacket } from "./briefing";

export const TURN_CHANGE_BRIEFING_VERSION = "v1";

// ---------------------------------------------------------------------
// 1. 共通の差分表現
// ---------------------------------------------------------------------

export interface MetricDelta {
  readonly current: number;
  readonly previous: number;
  readonly delta: number;
  readonly deltaPercent: number | null;
}

function metricDelta(current: number, previous: number): MetricDelta {
  return {
    current,
    previous,
    delta: current - previous,
    deltaPercent: Math.abs(previous) > 1e-9 ? (current - previous) / Math.abs(previous) : null,
  };
}

/** 過去turnのスナップショットが存在しない指標用（捏造しない。previous=nullのまま）。 */
export interface OptionalMetricDelta {
  readonly current: number | null;
  readonly previous: number | null;
  readonly delta: number | null;
  readonly deltaPercent: number | null;
}

function currentOnlyMetric(current: number | null): OptionalMetricDelta {
  return { current, previous: null, delta: null, deltaPercent: null };
}

function optionalMetricDelta(current: number | null, previous: number | null): OptionalMetricDelta {
  if (current === null || previous === null) return { current, previous, delta: null, deltaPercent: null };
  return metricDelta(current, previous);
}

// ---------------------------------------------------------------------
// 2. 入力（既存2四半期スナップショット。新しい状態読み込み経路は作らない）
// ---------------------------------------------------------------------

export interface TurnChangeQuarterSnapshot {
  readonly pnl: ProfitAndLossStatement;
  readonly balanceSheet: BalanceSheet;
  readonly periodLabel: string;
  readonly period: PeriodV2;
  readonly fulfilledQuantityTons: number;
  readonly summary: CompanyQuarterSummary;
  readonly workerAssignments: readonly WorkerAssignment[];
  readonly productionEntries: readonly ProductionAllocationEntry[];
  /** 既存FinancingQuarterResult.borrowingCapacityの転記のみ。turn1等で無ければnull。 */
  readonly borrowingHeadroomUsd: number | null;
}

export interface TurnChangeBriefingInput {
  readonly runId: string;
  readonly companyId: string;
  readonly fromTurn: number;
  readonly toTurn: number;
  /** currentPeriod（toTurn）の実績（P&L varianceの"current"と同じスナップショット）。 */
  readonly current: TurnChangeQuarterSnapshot;
  /** previousPeriod（fromTurn）の実績。 */
  readonly previous: TurnChangeQuarterSnapshot;
  /** 現在のライブcapex一覧（既存ownState.capexState.portfolio.projects。新しい状態は追加しない）。 */
  readonly capexProjects: readonly CapitalProject[];
  /** 現在のライブcapacity pools（既存ownState.factoryCapacityから、capacitySemantics.buildCapacityPoolsと同じ単純合算）。 */
  readonly currentCapacityPools: CapacityPools;
  /** 現在のライブ営業人員数（既存ownState.salesForce.headcountTotal。過去turnのスナップショットは無いためcurrent-onlyで使う）。 */
  readonly currentSalesForceHeadcount: number;
}

// ---------------------------------------------------------------------
// 3. Financial changes（実装指示§3・§4）
// ---------------------------------------------------------------------

export interface FinancialChanges {
  readonly revenue: MetricDelta;
  readonly grossProfit: MetricDelta;
  readonly operatingProfit: MetricDelta;
  /** operatingProfit / revenue（revenueが0近傍の場合はcurrent/previousともnull扱いにはせず0とする単純比率。新しい会計指標ではない）。 */
  readonly operatingMargin: MetricDelta;
  readonly netIncome: MetricDelta;
  readonly cash: MetricDelta;
  readonly accountsReceivable: MetricDelta;
  /** 負債合計（買掛金等を含む、balanceSheet.totalLiabilitiesの転記）。interestBearingDebtとは別概念（M2.4の区別を維持）。 */
  readonly totalDebt: MetricDelta;
  /** 有利子負債（shortTermLoans+longTermLoansの単純合算。totalDebtより狭い概念）。 */
  readonly interestBearingDebt: MetricDelta;
  readonly borrowingHeadroom: OptionalMetricDelta;
  /** pnlSemantics.computePnlVarianceの転記（二重計算しない）。 */
  readonly pnlVariance: PnlVariance;
}

function buildFinancialChanges(input: TurnChangeBriefingInput): FinancialChanges {
  const { current, previous } = input;
  const num = (v: unknown): number => v as unknown as number;
  const cRevenue = num(current.pnl.netRevenue);
  const pRevenue = num(previous.pnl.netRevenue);
  const cOp = num(current.pnl.operatingProfit);
  const pOp = num(previous.pnl.operatingProfit);
  const cBs = current.balanceSheet;
  const pBs = previous.balanceSheet;
  const cInterestBearing = num(cBs.shortTermLoans) + num(cBs.longTermLoans);
  const pInterestBearing = num(pBs.shortTermLoans) + num(pBs.longTermLoans);

  return {
    revenue: metricDelta(cRevenue, pRevenue),
    grossProfit: metricDelta(num(current.pnl.grossProfit), num(previous.pnl.grossProfit)),
    operatingProfit: metricDelta(cOp, pOp),
    operatingMargin: metricDelta(Math.abs(cRevenue) > 1e-9 ? cOp / cRevenue : 0, Math.abs(pRevenue) > 1e-9 ? pOp / pRevenue : 0),
    netIncome: metricDelta(num(current.pnl.netIncome), num(previous.pnl.netIncome)),
    cash: metricDelta(num(cBs.cash), num(pBs.cash)),
    accountsReceivable: metricDelta(num(cBs.accountsReceivable), num(pBs.accountsReceivable)),
    totalDebt: metricDelta(num(cBs.totalLiabilities), num(pBs.totalLiabilities)),
    interestBearingDebt: metricDelta(cInterestBearing, pInterestBearing),
    borrowingHeadroom: optionalMetricDelta(current.borrowingHeadroomUsd, previous.borrowingHeadroomUsd),
    pnlVariance: computePnlVariance(current.pnl, previous.pnl, current.periodLabel, previous.periodLabel),
  };
}

// ---------------------------------------------------------------------
// 4. Commercial changes（実装指示§5・§13・§14）
// ---------------------------------------------------------------------

export interface TrustByMarketChangeSummary {
  readonly averageDelta: number;
  readonly improvedMarketCount: number;
  readonly worsenedMarketCount: number;
}

export interface ProductMixEntry {
  readonly product: string;
  readonly current: number;
  readonly previous: number;
  readonly delta: number;
}

export interface CommercialChanges {
  readonly newOrders: MetricDelta;
  readonly deliveredVolume: MetricDelta;
  readonly totalBacklog: MetricDelta;
  /**
   * 【実装指示§13】healthy forward増加とoverdue増加を完全に区別する。確定四半期の
   * 事後スナップショット（outstandingQuantity/overdueQuantity）を使うため、
   * dueThisTurnはこの時点で既に履行済/overdue繰越済であり0として扱う（捏造しない）。
   */
  readonly healthyForwardBacklog: MetricDelta;
  readonly dueThisTurnBacklog: MetricDelta;
  readonly overdueBacklog: MetricDelta;
  readonly salesForceHeadcount: OptionalMetricDelta;
  readonly trustByMarket: TrustByMarketChangeSummary;
  readonly averageRealizedPriceUsdPerTon: OptionalMetricDelta;
  readonly productMix: readonly ProductMixEntry[];
  /** pnlSemantics.computeVolumePriceFactsの転記（二重計算しない）。 */
  readonly volumePriceFacts: VolumePriceFacts;
}

function buildCommercialChanges(input: TurnChangeBriefingInput): CommercialChanges {
  const { current, previous } = input;
  const cs = current.summary;
  const ps = previous.summary;
  const cOutstanding = unwrapUnit(cs.outstandingQuantity);
  const pOutstanding = unwrapUnit(ps.outstandingQuantity);
  const cOverdue = unwrapUnit(cs.overdueQuantity);
  const pOverdue = unwrapUnit(ps.overdueQuantity);

  const volumePriceFacts = computeVolumePriceFacts(
    current.fulfilledQuantityTons,
    current.pnl.netRevenue as unknown as number,
    previous.fulfilledQuantityTons,
    previous.pnl.netRevenue as unknown as number,
    current.periodLabel,
    previous.periodLabel
  );

  const trustMarkets = new Set<string>([...Object.keys(cs.customerTrustByMarket), ...Object.keys(ps.customerTrustByMarket)]);
  let trustDeltaSum = 0;
  let trustDeltaCount = 0;
  let improved = 0;
  let worsened = 0;
  for (const market of trustMarkets) {
    const cVal = (cs.customerTrustByMarket as Record<string, number | undefined>)[market];
    const pVal = (ps.customerTrustByMarket as Record<string, number | undefined>)[market];
    if (cVal === undefined || pVal === undefined) continue;
    const d = cVal - pVal;
    trustDeltaSum += d;
    trustDeltaCount += 1;
    if (d > 1e-9) improved += 1;
    else if (d < -1e-9) worsened += 1;
  }

  const productMix: ProductMixEntry[] = (["hoso", "pd", "vap"] as const).map((product) => {
    const currentVal = unwrapUnit(product === "hoso" ? cs.hosoProduced : product === "pd" ? cs.pdProduced : cs.vapProduced);
    const previousVal = unwrapUnit(product === "hoso" ? ps.hosoProduced : product === "pd" ? ps.pdProduced : ps.vapProduced);
    return { product, current: currentVal, previous: previousVal, delta: currentVal - previousVal };
  });

  return {
    newOrders: metricDelta(unwrapUnit(cs.newContractedQuantity), unwrapUnit(ps.newContractedQuantity)),
    deliveredVolume: metricDelta(unwrapUnit(cs.fulfilledQuantity), unwrapUnit(ps.fulfilledQuantity)),
    totalBacklog: metricDelta(cOutstanding, pOutstanding),
    healthyForwardBacklog: metricDelta(cOutstanding - cOverdue, pOutstanding - pOverdue),
    dueThisTurnBacklog: metricDelta(0, 0),
    overdueBacklog: metricDelta(cOverdue, pOverdue),
    salesForceHeadcount: currentOnlyMetric(input.currentSalesForceHeadcount),
    trustByMarket: {
      averageDelta: trustDeltaCount > 0 ? trustDeltaSum / trustDeltaCount : 0,
      improvedMarketCount: improved,
      worsenedMarketCount: worsened,
    },
    averageRealizedPriceUsdPerTon: optionalMetricDelta(volumePriceFacts.currentAverageRealizedPriceUsdPerTon, volumePriceFacts.priorAverageRealizedPriceUsdPerTon),
    productMix,
    volumePriceFacts,
  };
}

// ---------------------------------------------------------------------
// 5. Operational changes（実装指示§6・§12）
// ---------------------------------------------------------------------

export interface QualityScoreChangeEntry {
  readonly product: string;
  readonly current: number | null;
  readonly previous: number | null;
  readonly delta: number | null;
}

export interface BottleneckChangeFact {
  readonly previous: BottleneckCategory;
  readonly current: BottleneckCategory;
  readonly changed: boolean;
}

export interface OperationalChanges {
  readonly productionVolume: MetricDelta;
  readonly rawMaterialInventory: MetricDelta;
  readonly finishedGoodsInventory: MetricDelta;
  readonly rawMaterialShortageTons: MetricDelta;
  readonly equipmentShortageTons: MetricDelta;
  readonly laborShortageTons: MetricDelta;
  readonly equipmentUtilization: MetricDelta;
  readonly laborUtilization: MetricDelta;
  readonly overtimeRate: MetricDelta;
  readonly regularWorkers: MetricDelta;
  readonly temporaryWorkers: MetricDelta;
  readonly qualityScoreByProduct: readonly QualityScoreChangeEntry[];
  readonly bottleneckChange: BottleneckChangeFact;
}

function buildOperationalChanges(input: TurnChangeBriefingInput): OperationalChanges {
  const { current, previous } = input;
  const cs = current.summary;
  const ps = previous.summary;

  const cProduced = unwrapUnit(cs.hosoProduced) + unwrapUnit(cs.pdProduced) + unwrapUnit(cs.vapProduced);
  const pProduced = unwrapUnit(ps.hosoProduced) + unwrapUnit(ps.pdProduced) + unwrapUnit(ps.vapProduced);

  const cRawShortage = unwrapUnit(cs.rawMaterialShortfall);
  const cEquipShortage = unwrapUnit(cs.equipmentShortfall);
  const cLaborShortage = unwrapUnit(cs.laborShortfall);
  const pRawShortage = unwrapUnit(ps.rawMaterialShortfall);
  const pEquipShortage = unwrapUnit(ps.equipmentShortfall);
  const pLaborShortage = unwrapUnit(ps.laborShortfall);

  const currentBottleneck = computeBottleneckHierarchy(cRawShortage, cEquipShortage, cLaborShortage).primary;
  const previousBottleneck = computeBottleneckHierarchy(pRawShortage, pEquipShortage, pLaborShortage).primary;

  const products = new Set<string>([...Object.keys(cs.qualityScoreByProduct), ...Object.keys(ps.qualityScoreByProduct)]);
  const qualityScoreByProduct: QualityScoreChangeEntry[] = Array.from(products).map((product) => {
    const c = (cs.qualityScoreByProduct as Record<string, number | undefined>)[product] ?? null;
    const p = (ps.qualityScoreByProduct as Record<string, number | undefined>)[product] ?? null;
    return { product, current: c, previous: p, delta: c !== null && p !== null ? c - p : null };
  });

  const cRegular = current.workerAssignments.reduce((sum, w) => sum + w.regularHeadcount, 0);
  const pRegular = previous.workerAssignments.reduce((sum, w) => sum + w.regularHeadcount, 0);
  const cTemporary = current.workerAssignments.reduce((sum, w) => sum + w.temporaryHeadcount, 0);
  const pTemporary = previous.workerAssignments.reduce((sum, w) => sum + w.temporaryHeadcount, 0);

  return {
    productionVolume: metricDelta(cProduced, pProduced),
    rawMaterialInventory: metricDelta(unwrapUnit(cs.rawMaterialInventory), unwrapUnit(ps.rawMaterialInventory)),
    finishedGoodsInventory: metricDelta(unwrapUnit(cs.finishedGoodsInventory), unwrapUnit(ps.finishedGoodsInventory)),
    rawMaterialShortageTons: metricDelta(cRawShortage, pRawShortage),
    equipmentShortageTons: metricDelta(cEquipShortage, pEquipShortage),
    laborShortageTons: metricDelta(cLaborShortage, pLaborShortage),
    equipmentUtilization: metricDelta(unwrapUnit(cs.equipmentUtilizationRate), unwrapUnit(ps.equipmentUtilizationRate)),
    laborUtilization: metricDelta(unwrapUnit(cs.laborUtilizationRate), unwrapUnit(ps.laborUtilizationRate)),
    overtimeRate: metricDelta(unwrapUnit(cs.overtimeRate), unwrapUnit(ps.overtimeRate)),
    regularWorkers: metricDelta(cRegular, pRegular),
    temporaryWorkers: metricDelta(cTemporary, pTemporary),
    qualityScoreByProduct,
    bottleneckChange: { previous: previousBottleneck, current: currentBottleneck, changed: previousBottleneck !== currentBottleneck },
  };
}

// ---------------------------------------------------------------------
// 6. Capacity changes（実装指示§7）
// ---------------------------------------------------------------------

export interface CapacityPoolFact {
  readonly pool: "common" | "hoso" | "pd" | "vap" | "freezing";
  readonly currentTons: number;
}

export interface CapexActivityEntry {
  readonly projectId: string;
  readonly projectType: string;
  readonly status: string;
}

export interface CapexActivityFacts {
  readonly ongoing: readonly CapexActivityEntry[];
  readonly completedThisTurn: readonly CapexActivityEntry[];
  readonly newlyStartedThisTurn: readonly CapexActivityEntry[];
}

export interface CapacityChanges {
  /** 過去turnの工場別実効能力スナップショットがengine履歴に存在しないため、現在値のみ（捏造しない）。 */
  readonly pools: readonly CapacityPoolFact[];
  /** reportingPeriod(toTurn)中にcompletedPeriodが一致するCAPEXが1件でもあればtrue。 */
  readonly capacityIncreasedThisTurn: boolean;
  readonly capex: CapexActivityFacts;
}

const ONGOING_STATUSES: ReadonlySet<string> = new Set(["approved", "underConstruction", "suspended"]);

function buildCapacityChanges(input: TurnChangeBriefingInput): CapacityChanges {
  const pool = input.currentCapacityPools;
  const pools: CapacityPoolFact[] = [
    { pool: "common", currentTons: pool.commonProcessingTons },
    { pool: "hoso", currentTons: pool.hosoTons },
    { pool: "pd", currentTons: pool.pdTons },
    { pool: "vap", currentTons: pool.vapTons },
    { pool: "freezing", currentTons: pool.freezingPackagingTons },
  ];

  const reportingPeriod = input.current.period;
  const ongoing = input.capexProjects.filter((p) => ONGOING_STATUSES.has(p.status));
  const completedThisTurn = input.capexProjects.filter((p) => p.status === "completed" && p.completedPeriod === reportingPeriod);
  const newlyStartedThisTurn = input.capexProjects.filter((p) => p.constructionStartedPeriod === reportingPeriod);

  const toEntry = (p: CapitalProject): CapexActivityEntry => ({ projectId: p.projectId, projectType: p.projectType, status: p.status });

  return {
    pools,
    capacityIncreasedThisTurn: completedThisTurn.length > 0,
    capex: {
      ongoing: ongoing.map(toEntry),
      completedThisTurn: completedThisTurn.map(toEntry),
      newlyStartedThisTurn: newlyStartedThisTurn.map(toEntry),
    },
  };
}

// ---------------------------------------------------------------------
// 7. Change candidates / significance（実装指示§8・§9・§10・§11・§12）
// ---------------------------------------------------------------------

export type ChangeDomain = "FINANCE" | "COMMERCIAL" | "OPERATIONS" | "CAPACITY" | "RISK" | "OPPORTUNITY";
export type ChangeDirection = "IMPROVED" | "WORSENED" | "NEUTRAL";

/**
 * 【実装指示§10・§11】重要性はserver-sideで機械的に決める。新しい巨大score engineは
 * 作らない。単純な優先度3段階（HIGH=構造的シグナル・sign reversal・new overdue・
 * bottleneck変化・CAPEX完了、MEDIUM=閾値超えのdelta、LOW=その他の非ゼロdelta）＋
 * 絶対deltaでの同点判定のみ。
 */
export interface ChangeCandidate {
  readonly id: string;
  readonly domain: ChangeDomain;
  readonly direction: ChangeDirection;
  readonly significanceScore: number;
  /** server-sideで確定した短い事実要約（数値を含む）。Claudeはこれを解釈するだけで、再計算しない。 */
  readonly factSummary: string;
  readonly factsUsed: readonly string[];
}

const HIGH = 3;
const MEDIUM = 2;
const LOW = 1;

/** 閾値は既存診断が無い場合の単純な固定値のみ（実装指示§11「独自parameter乱造禁止」に配慮し、最小限のみ定義）。 */
const MARGIN_DETERIORATION_THRESHOLD = 0.03; // 3 percentage points
const CASH_STRESS_DELTA_PERCENT_THRESHOLD = -0.15; // -15%
const PRICE_SHOCK_DELTA_PERCENT_THRESHOLD = 0.08; // ±8%

function fmtUsd(v: number): string {
  return `$${(v / 1_000_000).toFixed(1)}M`;
}
function fmtTons(v: number): string {
  return `${v.toFixed(1)}t`;
}
function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function buildChangeCandidates(
  financial: FinancialChanges,
  commercial: CommercialChanges,
  operational: OperationalChanges,
  capacity: CapacityChanges
): readonly ChangeCandidate[] {
  const candidates: ChangeCandidate[] = [];

  // --- FINANCE ---
  const opSignReversal = financial.operatingProfit.previous >= 0 && financial.operatingProfit.current < 0;
  const opSignImprovement = financial.operatingProfit.previous < 0 && financial.operatingProfit.current >= 0;
  if (opSignReversal || opSignImprovement) {
    candidates.push({
      id: "finance.operatingProfit.signReversal",
      domain: "FINANCE",
      direction: opSignReversal ? "WORSENED" : "IMPROVED",
      significanceScore: HIGH,
      factSummary: `Operating Profit: ${fmtUsd(financial.operatingProfit.previous)} -> ${fmtUsd(financial.operatingProfit.current)}`,
      factsUsed: ["financialChanges.operatingProfit.current", "financialChanges.operatingProfit.previous"],
    });
  } else if (Math.abs(financial.operatingProfit.delta) > 1e-6) {
    candidates.push({
      id: "finance.operatingProfit.delta",
      domain: "FINANCE",
      direction: financial.operatingProfit.delta > 0 ? "IMPROVED" : "WORSENED",
      significanceScore: financial.operatingMargin.deltaPercent !== null && Math.abs(financial.operatingMargin.delta) > MARGIN_DETERIORATION_THRESHOLD ? MEDIUM : LOW,
      factSummary: `Operating Profit: ${fmtUsd(financial.operatingProfit.previous)} -> ${fmtUsd(financial.operatingProfit.current)}`,
      factsUsed: ["financialChanges.operatingProfit.current", "financialChanges.operatingProfit.previous"],
    });
  }

  if (Math.abs(financial.operatingMargin.delta) > MARGIN_DETERIORATION_THRESHOLD) {
    candidates.push({
      id: "finance.operatingMargin.threshold",
      domain: "FINANCE",
      direction: financial.operatingMargin.delta < 0 ? "WORSENED" : "IMPROVED",
      significanceScore: MEDIUM,
      factSummary: `Operating Margin: ${fmtPct(financial.operatingMargin.previous)} -> ${fmtPct(financial.operatingMargin.current)}`,
      factsUsed: ["financialChanges.operatingMargin.current", "financialChanges.operatingMargin.previous"],
    });
  }

  if (Math.abs(financial.revenue.delta) > 1e-6) {
    candidates.push({
      id: "finance.revenue.delta",
      domain: "FINANCE",
      direction: financial.revenue.delta > 0 ? "IMPROVED" : "WORSENED",
      significanceScore: LOW,
      factSummary: `Revenue: ${fmtUsd(financial.revenue.previous)} -> ${fmtUsd(financial.revenue.current)}`,
      factsUsed: ["financialChanges.revenue.current", "financialChanges.revenue.previous"],
    });
  }

  if (financial.cash.deltaPercent !== null && financial.cash.deltaPercent < CASH_STRESS_DELTA_PERCENT_THRESHOLD) {
    candidates.push({
      id: "finance.cash.stress",
      domain: "RISK",
      direction: "WORSENED",
      significanceScore: HIGH,
      factSummary: `Cash: ${fmtUsd(financial.cash.previous)} -> ${fmtUsd(financial.cash.current)} (${fmtPct(financial.cash.deltaPercent)})`,
      factsUsed: ["financialChanges.cash.current", "financialChanges.cash.previous"],
    });
  } else if (Math.abs(financial.cash.delta) > 1e-6) {
    candidates.push({
      id: "finance.cash.delta",
      domain: "FINANCE",
      direction: financial.cash.delta > 0 ? "IMPROVED" : "WORSENED",
      significanceScore: LOW,
      factSummary: `Cash: ${fmtUsd(financial.cash.previous)} -> ${fmtUsd(financial.cash.current)}`,
      factsUsed: ["financialChanges.cash.current", "financialChanges.cash.previous"],
    });
  }

  if (Math.abs(financial.interestBearingDebt.delta) > 1e-6) {
    candidates.push({
      id: "finance.interestBearingDebt.delta",
      domain: financial.interestBearingDebt.delta < 0 ? "OPPORTUNITY" : "FINANCE",
      direction: financial.interestBearingDebt.delta < 0 ? "IMPROVED" : "WORSENED",
      significanceScore: LOW,
      factSummary: `Interest-bearing debt: ${fmtUsd(financial.interestBearingDebt.previous)} -> ${fmtUsd(financial.interestBearingDebt.current)}`,
      factsUsed: ["financialChanges.interestBearingDebt.current", "financialChanges.interestBearingDebt.previous"],
    });
  }

  // --- COMMERCIAL ---
  const newOverdue = commercial.overdueBacklog.previous <= 1e-6 && commercial.overdueBacklog.current > 1e-6;
  if (newOverdue) {
    candidates.push({
      id: "commercial.overdue.new",
      domain: "RISK",
      direction: "WORSENED",
      significanceScore: HIGH,
      factSummary: `Overdue backlog: ${fmtTons(commercial.overdueBacklog.previous)} -> ${fmtTons(commercial.overdueBacklog.current)} (newly overdue)`,
      factsUsed: ["commercialChanges.overdueBacklog.current", "commercialChanges.overdueBacklog.previous"],
    });
  } else if (Math.abs(commercial.overdueBacklog.delta) > 1e-6) {
    candidates.push({
      id: "commercial.overdue.delta",
      domain: commercial.overdueBacklog.delta > 0 ? "RISK" : "OPPORTUNITY",
      direction: commercial.overdueBacklog.delta > 0 ? "WORSENED" : "IMPROVED",
      significanceScore: MEDIUM,
      factSummary: `Overdue backlog: ${fmtTons(commercial.overdueBacklog.previous)} -> ${fmtTons(commercial.overdueBacklog.current)}`,
      factsUsed: ["commercialChanges.overdueBacklog.current", "commercialChanges.overdueBacklog.previous"],
    });
  }

  if (Math.abs(commercial.healthyForwardBacklog.delta) > 1e-6) {
    candidates.push({
      id: "commercial.healthyForwardBacklog.delta",
      domain: "OPPORTUNITY",
      direction: commercial.healthyForwardBacklog.delta > 0 ? "IMPROVED" : "NEUTRAL",
      significanceScore: LOW,
      factSummary: `Healthy forward backlog (not overdue): ${fmtTons(commercial.healthyForwardBacklog.previous)} -> ${fmtTons(commercial.healthyForwardBacklog.current)}`,
      factsUsed: ["commercialChanges.healthyForwardBacklog.current", "commercialChanges.healthyForwardBacklog.previous"],
    });
  }

  if (commercial.averageRealizedPriceUsdPerTon.deltaPercent !== null && Math.abs(commercial.averageRealizedPriceUsdPerTon.deltaPercent) > PRICE_SHOCK_DELTA_PERCENT_THRESHOLD) {
    candidates.push({
      id: "commercial.price.shock",
      domain: commercial.averageRealizedPriceUsdPerTon.deltaPercent! < 0 ? "RISK" : "OPPORTUNITY",
      direction: commercial.averageRealizedPriceUsdPerTon.deltaPercent! < 0 ? "WORSENED" : "IMPROVED",
      significanceScore: MEDIUM,
      factSummary: `Average realized price moved ${fmtPct(commercial.averageRealizedPriceUsdPerTon.deltaPercent!)}`,
      factsUsed: ["commercialChanges.averageRealizedPriceUsdPerTon.current", "commercialChanges.averageRealizedPriceUsdPerTon.previous"],
    });
  }

  if (Math.abs(commercial.deliveredVolume.delta) > 1e-6 && Math.abs(financial.revenue.delta) > 1e-6) {
    const volumeUp = commercial.deliveredVolume.delta > 0;
    const revenueDown = financial.revenue.delta < 0;
    if (volumeUp && revenueDown) {
      candidates.push({
        id: "commercial.volumeUpRevenueDown",
        domain: "RISK",
        direction: "WORSENED",
        significanceScore: MEDIUM,
        factSummary: `Delivered volume up (${fmtTons(commercial.deliveredVolume.delta)}) but revenue down (${fmtUsd(financial.revenue.delta)})`,
        factsUsed: [
          "commercialChanges.deliveredVolume.current",
          "commercialChanges.deliveredVolume.previous",
          "financialChanges.revenue.current",
          "financialChanges.revenue.previous",
        ],
      });
    }
  }

  if (commercial.trustByMarket.worsenedMarketCount > commercial.trustByMarket.improvedMarketCount && Math.abs(commercial.trustByMarket.averageDelta) > 1e-6) {
    candidates.push({
      id: "commercial.trust.worsened",
      domain: "RISK",
      direction: "WORSENED",
      significanceScore: LOW,
      factSummary: `Customer trust worsened in ${commercial.trustByMarket.worsenedMarketCount} market(s)`,
      factsUsed: ["commercialChanges.trustByMarket"],
    });
  } else if (commercial.trustByMarket.improvedMarketCount > commercial.trustByMarket.worsenedMarketCount && Math.abs(commercial.trustByMarket.averageDelta) > 1e-6) {
    candidates.push({
      id: "commercial.trust.improved",
      domain: "OPPORTUNITY",
      direction: "IMPROVED",
      significanceScore: LOW,
      factSummary: `Customer trust improved in ${commercial.trustByMarket.improvedMarketCount} market(s)`,
      factsUsed: ["commercialChanges.trustByMarket"],
    });
  }

  // --- OPERATIONS ---
  if (operational.bottleneckChange.changed) {
    candidates.push({
      id: "operations.bottleneck.changed",
      domain: "OPERATIONS",
      direction: "NEUTRAL",
      significanceScore: HIGH,
      factSummary: `Primary bottleneck: ${operational.bottleneckChange.previous} -> ${operational.bottleneckChange.current}`,
      factsUsed: ["operationalChanges.bottleneckChange.previous", "operationalChanges.bottleneckChange.current"],
    });
  }

  if (Math.abs(operational.equipmentUtilization.delta) > 1e-6 || Math.abs(operational.laborUtilization.delta) > 1e-6) {
    candidates.push({
      id: "operations.utilization.delta",
      domain: "OPERATIONS",
      direction: "NEUTRAL",
      significanceScore: LOW,
      factSummary:
        `Equipment utilization: ${fmtPct(operational.equipmentUtilization.previous)} -> ${fmtPct(operational.equipmentUtilization.current)}; ` +
        `Labor utilization: ${fmtPct(operational.laborUtilization.previous)} -> ${fmtPct(operational.laborUtilization.current)}`,
      factsUsed: ["operationalChanges.equipmentUtilization", "operationalChanges.laborUtilization"],
    });
  }

  if (Math.abs(operational.rawMaterialShortageTons.delta) > 1e-6) {
    candidates.push({
      id: "operations.rawMaterialShortage.delta",
      domain: operational.rawMaterialShortageTons.delta > 0 ? "RISK" : "OPPORTUNITY",
      direction: operational.rawMaterialShortageTons.delta > 0 ? "WORSENED" : "IMPROVED",
      significanceScore: MEDIUM,
      factSummary: `Raw material shortage: ${fmtTons(operational.rawMaterialShortageTons.previous)} -> ${fmtTons(operational.rawMaterialShortageTons.current)}`,
      factsUsed: ["operationalChanges.rawMaterialShortageTons.current", "operationalChanges.rawMaterialShortageTons.previous"],
    });
  }

  // --- CAPACITY ---
  if (capacity.capacityIncreasedThisTurn) {
    candidates.push({
      id: "capacity.capex.completed",
      domain: "OPPORTUNITY",
      direction: "IMPROVED",
      significanceScore: HIGH,
      factSummary: `CAPEX completed this turn: ${capacity.capex.completedThisTurn.map((p) => p.projectType).join(", ")}`,
      factsUsed: ["capacityChanges.capex.completedThisTurn"],
    });
  }
  if (capacity.capex.newlyStartedThisTurn.length > 0) {
    candidates.push({
      id: "capacity.capex.started",
      domain: "OPPORTUNITY",
      direction: "NEUTRAL",
      significanceScore: LOW,
      factSummary: `New CAPEX started this turn: ${capacity.capex.newlyStartedThisTurn.map((p) => p.projectType).join(", ")}`,
      factsUsed: ["capacityChanges.capex.newlyStartedThisTurn"],
    });
  }

  return candidates;
}

const MAX_SIGNIFICANT_CHANGES = 8;

// ---------------------------------------------------------------------
// 8. TurnChangeBriefing 本体
// ---------------------------------------------------------------------

export interface TurnChangeBriefing {
  readonly runId: string;
  readonly companyId: string;
  readonly fromTurn: number;
  readonly toTurn: number;
  readonly fromPeriodLabel: string;
  readonly toPeriodLabel: string;
  readonly financialChanges: FinancialChanges;
  readonly commercialChanges: CommercialChanges;
  readonly operationalChanges: OperationalChanges;
  readonly capacityChanges: CapacityChanges;
  readonly riskChanges: readonly ChangeCandidate[];
  readonly opportunityChanges: readonly ChangeCandidate[];
  /** 実装指示§10。全候補からTop N（最大8件）へ絞った、Claudeへ渡す候補集合。 */
  readonly significantChanges: readonly ChangeCandidate[];
  readonly turnChangeBriefingVersion: string;
}

export function buildTurnChangeBriefing(input: TurnChangeBriefingInput): TurnChangeBriefing {
  const financialChanges = buildFinancialChanges(input);
  const commercialChanges = buildCommercialChanges(input);
  const operationalChanges = buildOperationalChanges(input);
  const capacityChanges = buildCapacityChanges(input);

  const allCandidates = buildChangeCandidates(financialChanges, commercialChanges, operationalChanges, capacityChanges);
  const riskChanges = allCandidates.filter((c) => c.domain === "RISK");
  const opportunityChanges = allCandidates.filter((c) => c.domain === "OPPORTUNITY");

  const significantChanges = [...allCandidates]
    .sort((a, b) => b.significanceScore - a.significanceScore)
    .slice(0, MAX_SIGNIFICANT_CHANGES);

  return {
    runId: input.runId,
    companyId: input.companyId,
    fromTurn: input.fromTurn,
    toTurn: input.toTurn,
    fromPeriodLabel: input.previous.periodLabel,
    toPeriodLabel: input.current.periodLabel,
    financialChanges,
    commercialChanges,
    operationalChanges,
    capacityChanges,
    riskChanges,
    opportunityChanges,
    significantChanges,
    turnChangeBriefingVersion: TURN_CHANGE_BRIEFING_VERSION,
  };
}

// ---------------------------------------------------------------------
// 9. Initial Brief（実装指示§25）— turn1（確定四半期が無い）・turn2（前々turnが
//    無くdeltaを計算できない）用のフォールバック。AI Meeting用のExecutiveBriefingPacket
//    は「意思決定前の現在ownState」から組み立てられており、turn1では初期fixture状態、
//    turn2では「turn1の確定結果そのもの」を表すため、新しい状態読み込みは不要（既に
//    handlers.ts側で構築済みのExecutiveBriefingPacketから必要なfieldを転記するだけ）。
// ---------------------------------------------------------------------

export interface InitialBriefFacts {
  readonly companyId: string;
  readonly turn: number;
  readonly cashUsd: number;
  readonly bindingCapacityTons: number;
  readonly bindingConstraintLabel: string;
  readonly backlogTotalTons: number;
  readonly backlogOverdueTons: number;
  readonly rawMaterialTotalTons: number;
  readonly standardAiReasonCodesTopN: readonly { readonly code: string; readonly domain: string; readonly severity: string }[];
}

export function buildInitialBriefFacts(packet: ExecutiveBriefingPacket): InitialBriefFacts {
  return {
    companyId: packet.common.companyId,
    turn: packet.common.turn,
    cashUsd: packet.common.cashUsd,
    bindingCapacityTons: packet.common.bindingCapacityTons,
    bindingConstraintLabel: packet.common.bindingConstraintLabel,
    backlogTotalTons: packet.common.backlog.totalTons,
    backlogOverdueTons: packet.common.backlog.overdueTons,
    rawMaterialTotalTons: packet.coo.rawMaterialTotalTons,
    standardAiReasonCodesTopN: packet.common.standardAiReasonCodesTopN.map((r) => ({ code: r.code, domain: r.domain, severity: r.severity })),
  };
}
