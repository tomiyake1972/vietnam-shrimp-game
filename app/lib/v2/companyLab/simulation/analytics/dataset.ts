// ShrimpX V2 — 32Q Management Console Phase 2: analytics dataset の構築
//
// 【再計算しない】すべて確定済みの CompanyQuarterRecord から値を取り出すだけ。
// 需要・価格・成約・稼働率のいずれについても、analytics 用の独自計算は行わない。
//
// 【値を捏造しない】記録に存在しない項目は null のままにする。

import { CompanyFixture, CompanyQuarterRecord } from "../../types";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../../market/types";
import { unwrapUnit } from "../../../core/units";
import { COMPANY_COLORS } from "../series";
import {
  BottleneckFact,
  BottleneckKind,
  CompanyMetricFact,
  CompanyMetricKey,
  HiringTraceFact,
  InvestmentTraceFact,
  MarketMetricFact,
  ProducerCountryFact,
  SalesTraceFact,
  SIMULATION_ANALYTICS_SCHEMA_VERSION,
  SimulationAnalyticsDataset,
  ContributionFact,
  FixedCostFact,
  FixedCostComponentKey,
  FixedCostDetailKey,
  SalesAllocationFact,
} from "./types";
import { AiTraceFact } from "./types";
import { SimulationAiTurnTrace, buildAiTraceFacts } from "./aiTrace";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function num(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function tons(v: unknown): number | null {
  return num(unwrapUnit(v as never));
}

// ---------------------------------------------------------------------
// 1. 会社指標
// ---------------------------------------------------------------------

/**
 * 会社×ターンの指標行を作る。
 * salesHeadcount は四半期記録に含まれないため、呼び出し側が持っている
 * 「ターンごとの営業人員数」を渡せる場合のみ値が入る（無ければ null のまま）。
 */
export function buildCompanyMetricFacts(
  history: readonly CompanyQuarterRecord[],
  companyIds: readonly string[],
  salesHeadcountByTurn?: ReadonlyMap<string, number>,
  capacityByTurn?: ReadonlyMap<string, { readonly hoso: number; readonly pd: number; readonly vap: number; readonly commonProcessing: number }>
): readonly CompanyMetricFact[] {
  const facts: CompanyMetricFact[] = [];
  for (const record of history) {
    for (const companyId of companyIds) {
      const summary = record.companySummaries.find((s) => s.companyId === companyId);
      const fin = record.financialResults?.find((f) => f.companyId === companyId);
      const financing = record.financingResults?.find((f) => f.companyId === companyId);
      const load = record.companyLoadMetrics.find((m) => m.companyId === companyId);
      const capacity = capacityByTurn?.get(`${record.turn}:${companyId}`);

      const values: Readonly<Record<CompanyMetricKey, number | null>> = {
        revenue: num(fin?.profitAndLoss?.netRevenue),
        operatingProfit: num(fin?.profitAndLoss?.operatingProfit),
        netIncome: num(fin?.profitAndLoss?.netIncome),
        cash: num(fin?.balanceSheet?.cash),
        debt:
          financing === undefined
            ? null
            : (financing.endingShortTermLoansUsd ?? 0) + (financing.endingLongTermLoansUsd ?? 0),
        hosoProduced: tons(summary?.hosoProduced),
        pdProduced: tons(summary?.pdProduced),
        vapProduced: tons(summary?.vapProduced),
        newContractedQuantity: tons(summary?.newContractedQuantity),
        fulfilledQuantity: tons(summary?.fulfilledQuantity),
        outstandingQuantity: tons(summary?.outstandingQuantity),
        domesticPurchaseQuantity: tons(summary?.domesticPurchaseQuantity),
        rawMaterialInventory: tons(summary?.rawMaterialInventory),
        finishedGoodsInventory: tons(summary?.finishedGoodsInventory),
        equipmentUtilizationRate: num(unwrapUnit(load?.equipmentUtilizationRate as never)),
        laborUtilizationRate: num(unwrapUnit(load?.laborUtilizationRate as never)),
        overtimeRate: num(unwrapUnit(load?.overtimeRate as never)),
        rawMaterialShortfall: tons(summary?.rawMaterialShortfall),
        equipmentShortfall: tons(summary?.equipmentShortfall),
        laborShortfall: tons(summary?.laborShortfall),
        salesHeadcount: salesHeadcountByTurn?.get(`${record.turn}:${companyId}`) ?? null,
        hosoCapacity: capacity?.hoso ?? null,
        pdCapacity: capacity?.pd ?? null,
        vapCapacity: capacity?.vap ?? null,
        commonCapacity: capacity?.commonProcessing ?? null,
      };

      for (const metric of Object.keys(values) as CompanyMetricKey[]) {
        // 【値が無い事実は行にしない】32Q×5社×指標数ぶんの `value: null` を保存すると
        // 保存量の相当部分が空行になる。行が無いことと value が null であることは
        // 意味が同じ（記録が無い）なので、読み出し側は `?? null` で受ける。
        if (values[metric] === null) continue;
        facts.push({ turn: record.turn, companyId, metric, value: values[metric] });
      }
    }
  }
  return facts;
}

// ---------------------------------------------------------------------
// 2. 市場指標（TRUE WORLD と OBSERVABLE を必ず分ける）
// ---------------------------------------------------------------------

/**
 * TRUE WORLD の市場需要・価格・成約量。
 *
 * demandQuantity は salesRecord.allocations[].targetDemand をそのまま使う
 * （「その四半期にベトナム産が獲得対象にできた需要」＝配分計算が実際に使った値）。
 * price は同じ配分結果の basePrice をそのまま使う（analytics 独自の価格計算はしない）。
 */
export function buildTrueWorldMarketFacts(history: readonly CompanyQuarterRecord[]): readonly MarketMetricFact[] {
  const facts: MarketMetricFact[] = [];
  for (const record of history) {
    for (const allocation of record.salesRecord.allocations) {
      const contracted = allocation.companies.reduce((sum, c) => sum + (tons(c.allocatedQuantity) ?? 0), 0);
      const base = { turn: record.turn, market: allocation.market, product: allocation.product, visibility: "trueWorld" as const, sourceTurn: record.turn };
      facts.push({ ...base, metric: "demandQuantity", value: tons(allocation.targetDemand) });
      facts.push({ ...base, metric: "price", value: num(unwrapUnit(allocation.basePrice as never)) });
      facts.push({ ...base, metric: "contractedQuantity", value: contracted });
      facts.push({ ...base, metric: "externalOptionQuantity", value: tons(allocation.externalOptionQuantity) });
    }
  }
  return facts;
}

/**
 * OBSERVABLE の市場需要（2四半期遅行の公開情報）。
 *
 * 【再計算しない】observedMarketDemand は既に会社ラボが構築して
 * PublicMarketInfo として公開している値である。ここではその「そのターンに
 * 公開されていた値」を、シミュレーション実行時に記録したものを受け取る。
 */
export interface ObservedDemandSnapshot {
  readonly turn: number;
  readonly sourceTurn: number | null;
  readonly entries: readonly {
    readonly market: DemandMarketId;
    readonly observedDemandByProduct: Readonly<Record<Product, number>>;
  }[];
}

export function buildObservableMarketFacts(snapshots: readonly ObservedDemandSnapshot[]): readonly MarketMetricFact[] {
  const facts: MarketMetricFact[] = [];
  for (const snapshot of snapshots) {
    for (const entry of snapshot.entries) {
      for (const product of PRODUCTS) {
        facts.push({
          turn: snapshot.turn,
          market: entry.market,
          product,
          metric: "demandQuantity",
          value: num(entry.observedDemandByProduct[product]),
          visibility: "observable",
          sourceTurn: snapshot.sourceTurn,
        });
      }
    }
  }
  return facts;
}

// ---------------------------------------------------------------------
// 3. GLOBAL PRODUCER DATA（産地国。消費市場シェアではない）
// ---------------------------------------------------------------------

export function buildProducerCountryFacts(history: readonly CompanyQuarterRecord[]): readonly ProducerCountryFact[] {
  const facts: ProducerCountryFact[] = [];
  for (const record of history) {
    const countries = record.marketInput.countries;
    const prices = record.marketResult.hosoPrices;
    for (const country of Object.keys(countries)) {
      const supply = countries[country as keyof typeof countries];
      const price = prices[country as keyof typeof prices];
      facts.push({ turn: record.turn, country, metric: "production", value: tons(supply?.production) });
      facts.push({ turn: record.turn, country, metric: "exportableSupply", value: tons(price?.exportableSupply) });
      facts.push({ turn: record.turn, country, metric: "allocatedDemand", value: tons(price?.allocatedDemand) });
      facts.push({ turn: record.turn, country, metric: "utilizationRatio", value: num(price?.utilizationRatio) });
      facts.push({ turn: record.turn, country, metric: "hosoFobPrice", value: num(unwrapUnit(price?.price as never)) });
    }
  }
  return facts;
}

// ---------------------------------------------------------------------
// 4. 律速（決定論的な大小比較のみ。生成AI分類はしない）
// ---------------------------------------------------------------------

export function buildBottleneckFacts(history: readonly CompanyQuarterRecord[], companyIds: readonly string[]): readonly BottleneckFact[] {
  const facts: BottleneckFact[] = [];
  for (const record of history) {
    for (const companyId of companyIds) {
      const summary = record.companySummaries.find((s) => s.companyId === companyId);
      const raw = summary ? (tons(summary.rawMaterialShortfall) ?? 0) : 0;
      const equipment = summary ? (tons(summary.equipmentShortfall) ?? 0) : 0;
      const labor = summary ? (tons(summary.laborShortfall) ?? 0) : 0;
      const total = raw + equipment + labor;
      const max = Math.max(raw, equipment, labor);
      // 同点の場合は 原料 → 設備 → 労働 の順で決める（判定を実行ごとにぶらさない）。
      const primary: BottleneckKind = max <= 0 ? "none" : max === raw ? "rawMaterial" : max === equipment ? "equipment" : "labor";
      facts.push({
        turn: record.turn,
        companyId,
        primary,
        rawMaterialShortfall: raw,
        equipmentShortfall: equipment,
        laborShortfall: labor,
        primaryShare: total > 0 ? max / total : null,
      });
    }
  }
  return facts;
}

/** 律速が切り替わった地点（heatmap の下に並べる遷移ビュー用）。 */
export interface BottleneckTransition {
  readonly companyId: string;
  readonly turn: number;
  readonly from: BottleneckKind;
  readonly to: BottleneckKind;
}

export function buildBottleneckTransitions(facts: readonly BottleneckFact[]): readonly BottleneckTransition[] {
  const byCompany = new Map<string, BottleneckFact[]>();
  for (const f of facts) {
    const list = byCompany.get(f.companyId) ?? [];
    list.push(f);
    byCompany.set(f.companyId, list);
  }
  const transitions: BottleneckTransition[] = [];
  for (const [companyId, list] of byCompany) {
    const sorted = [...list].sort((a, b) => a.turn - b.turn);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].primary !== sorted[i - 1].primary) {
        transitions.push({ companyId, turn: sorted[i].turn, from: sorted[i - 1].primary, to: sorted[i].primary });
      }
    }
  }
  return transitions.sort((a, b) => a.turn - b.turn || a.companyId.localeCompare(b.companyId));
}

// ---------------------------------------------------------------------
// 5. 販売・採用・投資トレース
// ---------------------------------------------------------------------

/** ターンごとの「営業工数制約前の希望量」（Standard AI 診断が既に持っている値）。 */
export interface SalesWishSnapshot {
  readonly turn: number;
  readonly companyId: string;
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly desiredQuantityBeforeEffortConstraint: number;
}

export function buildSalesTraceFacts(
  history: readonly CompanyQuarterRecord[],
  companyIds: readonly string[],
  wishes: readonly SalesWishSnapshot[]
): readonly SalesTraceFact[] {
  const wishIndex = new Map<string, number>();
  for (const w of wishes) wishIndex.set(`${w.turn}:${w.companyId}:${w.market}:${w.product}`, w.desiredQuantityBeforeEffortConstraint);

  const facts: SalesTraceFact[] = [];
  for (const record of history) {
    for (const companyId of companyIds) {
      const decision = record.decisions.find((d) => d.companyId === companyId);
      for (const market of DEMAND_MARKET_IDS) {
        for (const product of PRODUCTS) {
          const plan = decision?.salesPlans.find((p) => p.market === market && p.product === product);
          const allocation = record.salesRecord.allocations.find((a) => a.market === market && a.product === product);
          const contracted = allocation?.companies.find((c) => c.companyId === companyId);
          const wished = wishIndex.get(`${record.turn}:${companyId}:${market}:${product}`) ?? null;
          const planned = plan ? tons(plan.desiredQuantity) : null;
          const won = contracted ? tons(contracted.allocatedQuantity) : null;
          // 3値すべてが空か0の組み合わせは行を作らない（「その市場×商品では何もしなかった」
          // ことは行の不在で表せる。空行で保存量と表を膨らませない）。
          if ((wished ?? 0) === 0 && (planned ?? 0) === 0 && (won ?? 0) === 0) continue;
          facts.push({ turn: record.turn, companyId, market, product, wishedQuantity: wished, plannedQuantity: planned, contractedQuantity: won });
        }
      }
    }
  }
  return facts;
}

export function buildHiringTraceFacts(
  history: readonly CompanyQuarterRecord[],
  companyIds: readonly string[],
  salesHeadcountByTurn?: ReadonlyMap<string, number>
): readonly HiringTraceFact[] {
  const facts: HiringTraceFact[] = [];
  for (const record of history) {
    for (const companyId of companyIds) {
      const decision = record.decisions.find((d) => d.companyId === companyId);
      const load = record.companyLoadMetrics.find((m) => m.companyId === companyId);
      const temporary = (decision?.workerAssignments ?? []).reduce((sum, a) => sum + (num(a.temporaryHeadcount) ?? 0), 0);
      facts.push({
        turn: record.turn,
        companyId,
        salesForceHireCount: decision?.salesForceHireCount ?? 0,
        salesForceLayoffCount: decision?.salesForceLayoffCount ?? 0,
        endingSalesHeadcount: salesHeadcountByTurn?.get(`${record.turn}:${companyId}`) ?? null,
        totalTemporaryWorkers: temporary,
        averageOvertimeRate: num(unwrapUnit(load?.overtimeRate as never)),
      });
    }
  }
  return facts;
}

export function buildInvestmentTraceFacts(history: readonly CompanyQuarterRecord[], companyIds: readonly string[]): readonly InvestmentTraceFact[] {
  const facts: InvestmentTraceFact[] = [];
  for (const record of history) {
    for (const companyId of companyIds) {
      const capex = record.capexResults?.find((c) => c.companyId === companyId);
      if (!capex) continue;
      for (const event of capex.events) {
        facts.push({
          turn: record.turn,
          companyId,
          projectId: event.projectId,
          projectType: event.projectType,
          status: `${event.statusBefore} → ${event.statusAfter}`,
          budgetUsd: event.paymentSucceededUsd,
          note: event.reasons.length > 0 ? event.reasons.join(" / ") : null,
        });
      }
      for (const rejected of capex.rejectedProposals) {
        facts.push({
          turn: record.turn,
          companyId,
          projectId: "(提案却下)",
          projectType: rejected.projectType,
          status: "rejected",
          budgetUsd: rejected.requestedBudgetUsd,
          note: rejected.reasons.length > 0 ? rejected.reasons.join(" / ") : null,
        });
      }
    }
  }
  return facts;
}

// ---------------------------------------------------------------------
// 5b. 限界利益・固定費・営業配置
// ---------------------------------------------------------------------

/**
 * 会社×商品の限界利益。
 * **独自式を作らない** — finance が既に出した contributionMargin.byProduct を写すだけ。
 * 記録が無い会社・四半期は行を作らない（推測配賦をしない）。
 */
export function buildContributionFacts(history: readonly CompanyQuarterRecord[], companyIds: readonly string[]): readonly ContributionFact[] {
  const facts: ContributionFact[] = [];
  for (const record of history) {
    for (const companyId of companyIds) {
      const report = record.financialResults?.find((f) => f.companyId === companyId)?.contributionMargin;
      if (!report) continue;
      for (const product of PRODUCTS) {
        const entry = report.byProduct.find((e) => e.key === product);
        if (!entry) continue;
        facts.push({
          turn: record.turn,
          companyId,
          product,
          netRevenue: num(entry.netRevenue),
          variableCost: num(entry.variableCost),
          contributionMargin: num(entry.contributionMargin),
          // engine は純売上高0のとき undefined を返す。0で埋めない。
          contributionMarginRatio: entry.contributionMarginRatio === undefined ? null : num(entry.contributionMarginRatio),
          directFixedCost: num(entry.directFixedCost),
        });
      }
    }
  }
  return facts;
}

/**
 * 固定費。正式な3区分＋合計と、`ManufacturingCostBreakdown` に実在する内訳項目のみ。
 * 費用分類を新しく作らない。
 */
export function buildFixedCostFacts(history: readonly CompanyQuarterRecord[], companyIds: readonly string[]): readonly FixedCostFact[] {
  const facts: FixedCostFact[] = [];
  for (const record of history) {
    for (const companyId of companyIds) {
      const fin = record.financialResults?.find((f) => f.companyId === companyId);
      if (!fin) continue;
      const report = fin.contributionMargin;
      const push = (component: FixedCostComponentKey | FixedCostDetailKey, value: number | null) => {
        if (value === null) return;
        facts.push({ turn: record.turn, companyId, component, value });
      };
      if (report) {
        push("fixedManufacturingCost", num(report.fixedManufacturingCost));
        push("fixedPersonnelCost", num(report.fixedPersonnelCost));
        push("fixedSellingAdminCost", num(report.fixedSellingAdminCost));
        push("totalFixedCost", num(report.totalFixedCost));
      }
      const mc = fin.manufacturingCost;
      if (mc) {
        push("factoryFixedCost", num(mc.factoryFixedCost));
        push("utilityFixedCost", num(mc.utilityFixedCost));
        push("depreciationCost", num(mc.depreciationCost));
        push("regularLaborCost", num(mc.regularLaborCost));
      }
    }
  }
  return facts;
}

/**
 * 会社×市場の営業人員配置。
 * 同一市場内の全商品は同じ人数を共有する規約（sales/salesForce.ts が検証済み）なので
 * 市場ごとに1回だけ数える。合計が総人数に満たない分は "UNALLOCATED" として明示する
 * （UI で辻褄を合わせる補正はしない）。
 */
export function buildSalesAllocationFacts(
  history: readonly CompanyQuarterRecord[],
  companyIds: readonly string[],
  salesHeadcountByTurn?: ReadonlyMap<string, number>
): readonly SalesAllocationFact[] {
  const facts: SalesAllocationFact[] = [];
  for (const record of history) {
    for (const companyId of companyIds) {
      const decision = record.decisions.find((d) => d.companyId === companyId);
      if (!decision) continue;
      const byMarket = new Map<DemandMarketId, number>();
      for (const plan of decision.salesPlans) byMarket.set(plan.market, plan.salesForceHeadcount);
      let allocated = 0;
      for (const market of DEMAND_MARKET_IDS) {
        const headcount = byMarket.get(market) ?? 0;
        allocated += headcount;
        facts.push({ turn: record.turn, companyId, market, headcount });
      }
      // 総人数はこの四半期に配分可能だった人数（前期末までに確定した人数）。
      const total = salesHeadcountByTurn?.get(`${record.turn}:${companyId}`);
      if (total !== undefined) {
        facts.push({ turn: record.turn, companyId, market: "UNALLOCATED", headcount: Math.max(0, total - allocated) });
      }
    }
  }
  return facts;
}

// ---------------------------------------------------------------------
// 6. dataset 全体
// ---------------------------------------------------------------------

export interface BuildDatasetInput {
  readonly history: readonly CompanyQuarterRecord[];
  readonly fixtures: readonly CompanyFixture[];
  /** シミュレーション実行中に記録した Standard AI の思考（既に計算済みの値の詰め替え）。 */
  readonly aiTurnTraces: readonly SimulationAiTurnTrace[];
  /** 各ターンで実際に公開されていた観測需要。 */
  readonly observedDemand: readonly ObservedDemandSnapshot[];
  /** `${turn}:${companyId}` → 当期に配分可能だった営業人員数。 */
  readonly salesHeadcountByTurn?: ReadonlyMap<string, number>;
  /** `${turn}:${companyId}` → 期末実効能力。 */
  readonly capacityByTurn?: ReadonlyMap<string, { readonly hoso: number; readonly pd: number; readonly vap: number; readonly commonProcessing: number }>;
}

export function buildSimulationAnalyticsDataset(input: BuildDatasetInput): SimulationAnalyticsDataset {
  const companyIds = input.fixtures.map((f) => f.companyId);
  const bottlenecks = buildBottleneckFacts(input.history, companyIds);
  const wishes: SalesWishSnapshot[] = input.aiTurnTraces.flatMap((t) =>
    t.salesWish.map((w) => ({ turn: t.turn, companyId: t.companyId, market: w.market, product: w.product, desiredQuantityBeforeEffortConstraint: w.desiredQuantityBeforeEffortConstraint }))
  );
  const aiTrace: readonly AiTraceFact[] = buildAiTraceFacts(input.aiTurnTraces, input.history);

  return {
    schemaVersion: SIMULATION_ANALYTICS_SCHEMA_VERSION,
    turns: input.history.map((r) => r.turn),
    companies: input.fixtures.map((f) => ({ companyId: f.companyId, displayName: f.displayName, color: COMPANY_COLORS[f.companyId] ?? "#64748b" })),
    companyMetrics: buildCompanyMetricFacts(input.history, companyIds, input.salesHeadcountByTurn, input.capacityByTurn),
    marketMetrics: [...buildTrueWorldMarketFacts(input.history), ...buildObservableMarketFacts(input.observedDemand)],
    producerCountryMetrics: buildProducerCountryFacts(input.history),
    bottlenecks,
    aiTrace,
    salesTrace: buildSalesTraceFacts(input.history, companyIds, wishes),
    hiringTrace: buildHiringTraceFacts(input.history, companyIds, input.salesHeadcountByTurn),
    investmentTrace: buildInvestmentTraceFacts(input.history, companyIds),
    contribution: buildContributionFacts(input.history, companyIds),
    fixedCosts: buildFixedCostFacts(input.history, companyIds),
    salesAllocation: buildSalesAllocationFacts(input.history, companyIds, input.salesHeadcountByTurn),
  };
}

/**
 * 実行中／実行済みセッションから dataset を作る。
 * Console・Analysis・将来の xlsx exporter はいずれもこの1つの関数を通る
 * （画面ごとに別の集計器を作らない）。
 *
 * 【Save/Resume 長期永続化・鮮度整合】session.priorAnalyticsDataset が設定されている
 * 場合（＝resumePayload.state.history を rolling window へ間引いた状態から復元した
 * セッション）、window内の履歴だけから作った dataset を単独で返さない。resume時点で
 * 既に保存されていた完全な dataset と mergeAnalyticsDatasets でマージすることで、
 * reload以前のturnぶんのAnalysis事実（Console・Analysis・AI Pack・Databookが読む
 * 唯一の情報源）を欠落させない。
 */
export function buildDatasetFromSession(session: {
  readonly state: { readonly history: readonly CompanyQuarterRecord[] };
  readonly fixtures: readonly CompanyFixture[];
  readonly aiTurnTraces: readonly SimulationAiTurnTrace[];
  readonly observedDemand: readonly ObservedDemandSnapshot[];
  readonly salesHeadcountByTurn: readonly { readonly turn: number; readonly companyId: string; readonly headcount: number }[];
  readonly capacityByTurn: readonly { readonly turn: number; readonly companyId: string; readonly hoso: number; readonly pd: number; readonly vap: number; readonly commonProcessing: number }[];
  readonly priorAnalyticsDataset?: SimulationAnalyticsDataset;
}): SimulationAnalyticsDataset {
  const headcount = new Map<string, number>();
  for (const h of session.salesHeadcountByTurn) headcount.set(`${h.turn}:${h.companyId}`, h.headcount);
  const capacity = new Map<string, { hoso: number; pd: number; vap: number; commonProcessing: number }>();
  for (const c of session.capacityByTurn) {
    capacity.set(`${c.turn}:${c.companyId}`, { hoso: c.hoso, pd: c.pd, vap: c.vap, commonProcessing: c.commonProcessing });
  }
  const fresh = buildSimulationAnalyticsDataset({
    history: session.state.history,
    fixtures: session.fixtures,
    aiTurnTraces: session.aiTurnTraces,
    observedDemand: session.observedDemand,
    salesHeadcountByTurn: headcount,
    capacityByTurn: capacity,
  });
  return session.priorAnalyticsDataset ? mergeAnalyticsDatasets(session.priorAnalyticsDataset, fresh) : fresh;
}

/**
 * 【Save/Resume 長期永続化・鮮度整合】prior（resume以前に保存済みだった完全な dataset）と
 * next（現在のライブ session.state.history――rolling windowで間引かれている場合がある――
 * から作った dataset）を、ターン単位でマージする。
 *
 * 各 fact 配列は必ず `turn` を持つ long-format の行集合であるため（analytics/types.ts参照）、
 * next が持つターンは next を優先し（最新の再計算を信頼する）、next に無い古いターンだけ
 * prior から引き継ぐ。ゲーム計算はしない（既存の事実を選んで並べるだけ）。
 */
export function mergeAnalyticsDatasets(prior: SimulationAnalyticsDataset, next: SimulationAnalyticsDataset): SimulationAnalyticsDataset {
  const nextTurns = new Set(next.turns);
  const turns = [...new Set([...prior.turns, ...next.turns])].sort((a, b) => a - b);
  function merge<T extends { readonly turn: number }>(priorFacts: readonly T[], nextFacts: readonly T[]): readonly T[] {
    return [...priorFacts.filter((f) => !nextTurns.has(f.turn)), ...nextFacts];
  }
  return {
    schemaVersion: next.schemaVersion,
    turns,
    companies: next.companies,
    companyMetrics: merge(prior.companyMetrics, next.companyMetrics),
    marketMetrics: merge(prior.marketMetrics, next.marketMetrics),
    producerCountryMetrics: merge(prior.producerCountryMetrics, next.producerCountryMetrics),
    bottlenecks: merge(prior.bottlenecks, next.bottlenecks),
    aiTrace: merge(prior.aiTrace, next.aiTrace),
    salesTrace: merge(prior.salesTrace, next.salesTrace),
    hiringTrace: merge(prior.hiringTrace, next.hiringTrace),
    investmentTrace: merge(prior.investmentTrace, next.investmentTrace),
    contribution: merge(prior.contribution, next.contribution),
    fixedCosts: merge(prior.fixedCosts, next.fixedCosts),
    salesAllocation: merge(prior.salesAllocation, next.salesAllocation),
  };
}

// ---------------------------------------------------------------------
// 7. 選択子（画面・将来の exporter が共通で使う絞り込み）
// ---------------------------------------------------------------------

export interface AnalyticsSelector {
  readonly companyIds?: readonly string[];
  readonly turns?: readonly number[];
  readonly markets?: readonly DemandMarketId[];
  readonly products?: readonly Product[];
  readonly metrics?: readonly string[];
  readonly visibility?: "trueWorld" | "observable";
}

export function selectCompanyMetrics(facts: readonly CompanyMetricFact[], selector: AnalyticsSelector): readonly CompanyMetricFact[] {
  return facts.filter(
    (f) =>
      (selector.companyIds === undefined || selector.companyIds.includes(f.companyId)) &&
      (selector.turns === undefined || selector.turns.includes(f.turn)) &&
      (selector.metrics === undefined || selector.metrics.includes(f.metric))
  );
}

export function selectMarketMetrics(facts: readonly MarketMetricFact[], selector: AnalyticsSelector): readonly MarketMetricFact[] {
  return facts.filter(
    (f) =>
      (selector.turns === undefined || selector.turns.includes(f.turn)) &&
      (selector.markets === undefined || selector.markets.includes(f.market)) &&
      (selector.products === undefined || selector.products.includes(f.product)) &&
      (selector.metrics === undefined || selector.metrics.includes(f.metric)) &&
      (selector.visibility === undefined || selector.visibility === f.visibility)
  );
}
