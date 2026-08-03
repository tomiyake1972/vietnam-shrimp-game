// ShrimpX V2 — 2026-08-03 Phase D: Shadow Sales Allocation Engine（診断専用）
//
// 【目的】本番Standard AIの営業人員配分（decision/sales.tsの「前期参照価格最高位の
// 市場へ50%」ヒューリスティック）はまだ一切変更しない。その代わりに、同じ営業容量
// 関数・同じ商品別effort coefficientを使い、「追加1人の営業人員をどこへ置くと
// 最も有効な追加販売機会が生まれるか」を1人ずつ貪欲法（greedy）で評価する、
// 完全に独立した診断エンジンを提供する。大規模最適化（LP等）ではなく、
// 決定論的な逐次貪欲割当てである。
//
// 【体積指向(volume-oriented)と採算指向(contribution-oriented)を最初から1本化しない】
// 各ステップで「次の1人をどの市場に置くか」を、
//   - volume shadow: その市場で実現できる追加現実的販売量（トン）が最大になる市場
//   - contribution shadow: その市場で実現できる追加貢献利益（USD）が最大になる市場
// という2つの別々の目的関数で独立に計算し、両方を保持する（最初からContribution
// Margin最大化の1本に絞らない。三宅さんの指示）。
//
// 【需要ceilingの扱い（捏造しない）】市場別の絶対需要量はPhase C同様に観測構造上
// 存在しない。したがって本エンジンは、市場別の需要上限ではなく、
// 「会社全体の商品別・理論上限販売量」（decision/sales.tsが既に計算している
// desiredByProduct = 工場能力×稼働率目標×受注量係数だけで決まる、営業人員制約を
// 経由していない理論上限。同ファイルのコメントで明示的に「診断専用の参考値」と
// 位置づけられている値）を、会社全体で守るべき唯一のceilingとして採用する。
// 市場別の需要配分は行わない（それこそが本番AIの「前期価格最高位に50%」という
// 批判対象のヒューリスティックであり、shadow engineがそれを土台にしてしまうと
// 同じ偏りを継承してしまうため）。
//
// 【既存ロジックの再利用（新しい容量・需要ロジックは作らない）】
//   - sales/salesForce.ts processingCapacity（既存の営業人員飽和カーブ、変更なし）
//   - sales/parameters.ts salesEffortCoefficients（HOSO1.0/PD1.2/VAP3.0、変更なし）
//   - decision/sales.ts SalesPlanResult.desiredByProduct（既存の会社全体理論上限。
//     呼び出し元が既に計算済みの値をそのまま受け取る。再計算しない）
//   - Phase B forwardUnitEconomics（貢献利益。採算判断ロジックを複製しない）
//   - Phase C の「現在」配分は、呼び出し元が渡すcurrentSalesPlansから導出する
//     （営業配分ロジックそのものを再実行しない）。

import { DemandMarketId, Product } from "../../../market/types";
import { CompanySalesPlanEntry } from "../../../sales/types";
import { processingCapacity } from "../../../sales/salesForce";
import { SalesParameters, SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { unwrapUnit } from "../../../core/units";
import { ProductAmount, StandardAiObservation } from "../types";
import { StandardAiUnitEconomicsResult } from "./forwardUnitEconomics";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
const EPSILON = 1e-6;

export type ShadowAllocationObjective = "volume" | "contribution";

/** 1ステップ（営業人員1人を、どの市場のどの商品ミックスへ充てたか）の記録。 */
export interface ShadowAllocationStep {
  readonly headcountIndex: number; // 1始まり（この人が何人目か）
  readonly market: DemandMarketId;
  /** この1人の追加によって生まれた追加営業工数換算容量（HOSO換算トン）。 */
  readonly marginalEffortCapacityTons: number;
  /** この追加容量をどの商品へ充てたか（volume=effort係数最小の商品、contribution=CM/effort最大の商品）。 */
  readonly assignedProduct: Product | null;
  /** 追加によって実現する現実的販売量（物理トン）。assignedProductがnullなら0。 */
  readonly marginalSalesTons: number;
  /** 追加によって実現する貢献利益（USD）。CMが未観測（null）ならnull。 */
  readonly marginalContributionUsd: number | null;
  /** このステップ後の、会社全体の商品別「残りceiling」（desiredByProductからの残余）。 */
  readonly remainingCeilingByProduct: ProductAmount;
}

export interface ShadowMarketSummary {
  readonly market: DemandMarketId;
  readonly currentHeadcount: number;
  readonly shadowHeadcount: number;
  readonly currentRealisticSalesTons: number;
  readonly shadowRealisticSalesTons: number;
  readonly shadowContributionUsd: number | null;
  /** 【飽和効果】この市場の次の1人が生む追加容量（トン）。人数が増えるほど小さくなる。 */
  readonly marginalEffortCapacityForNextHeadcountTons: number;
  /** この市場でこれ以上人員を増やしても意味が無くなった理由（ceiling到達／需要データ不明のため未評価等）。 */
  readonly bindingConstraintReason:
    | "PRODUCT_CEILING_EXHAUSTED" // 会社全体の商品別理論上限desiredByProductに到達
    | "NO_PROFITABLE_PRODUCT" // 参照価格・CMが未観測、またはCM<=0の商品しか残っていない（contribution shadowのみ）
    | "HEADCOUNT_BUDGET_EXHAUSTED" // 会社全体の総営業人員数を使い切った
    | "NOT_BINDING"; // まだ制約に達していない（総人員が少なく割り切れていない等）
}

export interface ShadowSalesAllocationResult {
  readonly companyId: string;
  readonly objective: ShadowAllocationObjective;
  readonly totalHeadcount: number;
  readonly steps: readonly ShadowAllocationStep[];
  readonly marketSummaries: readonly ShadowMarketSummary[];
  /** ステップが最後まで総人員を使い切れなかった場合、残った未配置人数（=もう置く先が無い）。 */
  readonly unassignedHeadcount: number;
}

interface MarketCandidateInfo {
  readonly market: DemandMarketId;
  readonly referencePriceByProduct: Readonly<Partial<Record<Product, number>>>;
}

function contributionMarginLookup(unitEconomics: StandardAiUnitEconomicsResult, market: DemandMarketId, product: Product): number | null {
  const entry = unitEconomics.entries.find((e) => e.market === market && e.product === product);
  return entry?.contributionMarginUsdPerKg ?? null;
}

/**
 * 追加効果容量(marginalEffortCapacityTons)を、指定した目的関数(objective)に基づき
 * 最良の1商品へ充てる。ceilingが尽きている・参照価格が未観測の商品は選ばない。
 * volumeはeffort係数が最小（=物理トン最大化）の商品、contributionはCM/effort係数が
 * 最大（かつCM>0）の商品を選ぶ（負の貢献利益の機会は選ばない）。
 */
function pickBestProductForMarket(
  objective: ShadowAllocationObjective,
  market: MarketCandidateInfo,
  remainingCeiling: ProductAmount,
  unitEconomics: StandardAiUnitEconomicsResult,
  salesParams: SalesParameters
): { product: Product; valuePerEffortUnit: number } | null {
  let best: { product: Product; valuePerEffortUnit: number } | null = null;
  for (const product of PRODUCTS) {
    if (remainingCeiling[product] <= EPSILON) continue;
    if (market.referencePriceByProduct[product] === undefined) continue; // 未観測市場×商品は評価しない
    const effortCoef = salesParams.salesEffortCoefficients[product];
    if (objective === "volume") {
      const value = 1 / effortCoef; // 単位effortあたりの物理トン
      if (best === null || value > best.valuePerEffortUnit) best = { product, valuePerEffortUnit: value };
    } else {
      const cm = contributionMarginLookup(unitEconomics, market.market, product);
      if (cm === null || cm <= 0) continue; // 負の貢献利益の機会は選ばない
      const value = (cm * 1000) / effortCoef; // 単位effortあたりのUSD
      if (best === null || value > best.valuePerEffortUnit) best = { product, valuePerEffortUnit: value };
    }
  }
  return best;
}

export function buildShadowSalesAllocation(
  observation: StandardAiObservation,
  unitEconomics: StandardAiUnitEconomicsResult,
  desiredByProduct: ProductAmount,
  currentSalesPlans: readonly CompanySalesPlanEntry[],
  objective: ShadowAllocationObjective,
  salesParams: SalesParameters = SALES_PARAMETERS_V1
): ShadowSalesAllocationResult {
  const totalHeadcount = observation.salesForceHeadcountTotal;
  const markets: MarketCandidateInfo[] = observation.markets.map((m) => ({
    market: m.market,
    referencePriceByProduct: m.referencePriceByProduct ?? {},
  }));

  const headcountByMarket = new Map<DemandMarketId, number>(markets.map((m) => [m.market, 0]));
  const remainingCeiling: ProductAmount = { ...desiredByProduct };
  const steps: ShadowAllocationStep[] = [];
  const salesTonsByMarket = new Map<DemandMarketId, number>(markets.map((m) => [m.market, 0]));
  const contributionUsdByMarket = new Map<DemandMarketId, number>(markets.map((m) => [m.market, 0]));

  let assigned = 0;
  while (assigned < totalHeadcount) {
    // 各市場について「次の1人」を置いた場合の追加効果容量と、それを最良商品へ
    // 充てた場合の価値（volume=トン、contribution=USD）を評価する。
    let bestMarket: DemandMarketId | null = null;
    let bestValue = -Infinity;
    let bestMarginalCapacity = 0;
    let bestProduct: Product | null = null;
    let bestTons = 0;
    let bestUsd: number | null = null;

    for (const m of markets) {
      const h = headcountByMarket.get(m.market) ?? 0;
      const capacityNow = unwrapUnit(processingCapacity(h, salesParams));
      const capacityNext = unwrapUnit(processingCapacity(h + 1, salesParams));
      const marginalCapacity = capacityNext - capacityNow;
      if (marginalCapacity <= EPSILON) continue;
      const pick = pickBestProductForMarket(objective, m, remainingCeiling, unitEconomics, salesParams);
      if (pick === null) continue;
      const effortCoef = salesParams.salesEffortCoefficients[pick.product];
      const tonsIfAssigned = Math.min(marginalCapacity / effortCoef, remainingCeiling[pick.product]);
      if (tonsIfAssigned <= EPSILON) continue;
      const cm = contributionMarginLookup(unitEconomics, m.market, pick.product);
      const usdIfAssigned = cm === null ? null : cm * 1000 * tonsIfAssigned;
      const value = objective === "volume" ? tonsIfAssigned : usdIfAssigned ?? -Infinity;
      if (value > bestValue + EPSILON || (Math.abs(value - bestValue) <= EPSILON && (bestMarket === null || m.market < bestMarket))) {
        bestValue = value;
        bestMarket = m.market;
        bestMarginalCapacity = marginalCapacity;
        bestProduct = pick.product;
        bestTons = tonsIfAssigned;
        bestUsd = usdIfAssigned;
      }
    }

    if (bestMarket === null) break; // どの市場にもこれ以上置く価値のある先が無い（ceiling到達等）

    const h = headcountByMarket.get(bestMarket) ?? 0;
    headcountByMarket.set(bestMarket, h + 1);
    assigned += 1;
    if (bestProduct !== null) {
      remainingCeiling[bestProduct] = Math.max(0, remainingCeiling[bestProduct] - bestTons);
      salesTonsByMarket.set(bestMarket, (salesTonsByMarket.get(bestMarket) ?? 0) + bestTons);
      if (bestUsd !== null) contributionUsdByMarket.set(bestMarket, (contributionUsdByMarket.get(bestMarket) ?? 0) + bestUsd);
    }
    steps.push({
      headcountIndex: assigned,
      market: bestMarket,
      marginalEffortCapacityTons: bestMarginalCapacity,
      assignedProduct: bestProduct,
      marginalSalesTons: bestTons,
      marginalContributionUsd: bestUsd,
      remainingCeilingByProduct: { ...remainingCeiling },
    });
  }

  const unassignedHeadcount = totalHeadcount - assigned;

  const currentHeadcountByMarket = new Map<DemandMarketId, number>();
  const currentSalesTonsByMarket = new Map<DemandMarketId, number>();
  for (const p of currentSalesPlans) {
    currentHeadcountByMarket.set(p.market, p.salesForceHeadcount);
    currentSalesTonsByMarket.set(p.market, (currentSalesTonsByMarket.get(p.market) ?? 0) + unwrapUnit(p.desiredQuantity));
  }

  const marketSummaries: ShadowMarketSummary[] = markets.map((m) => {
    const shadowHeadcount = headcountByMarket.get(m.market) ?? 0;
    const marginalNext =
      unwrapUnit(processingCapacity(shadowHeadcount + 1, salesParams)) - unwrapUnit(processingCapacity(shadowHeadcount, salesParams));
    const anyCeilingLeft = PRODUCTS.some((p) => remainingCeiling[p] > EPSILON);
    let bindingConstraintReason: ShadowMarketSummary["bindingConstraintReason"] = "NOT_BINDING";
    if (unassignedHeadcount === 0 && assigned === totalHeadcount && !anyCeilingLeft) {
      bindingConstraintReason = "PRODUCT_CEILING_EXHAUSTED";
    } else if (unassignedHeadcount > 0) {
      bindingConstraintReason = anyCeilingLeft ? "NO_PROFITABLE_PRODUCT" : "PRODUCT_CEILING_EXHAUSTED";
    } else if (assigned === totalHeadcount) {
      bindingConstraintReason = "HEADCOUNT_BUDGET_EXHAUSTED";
    }
    return {
      market: m.market,
      currentHeadcount: currentHeadcountByMarket.get(m.market) ?? 0,
      shadowHeadcount,
      currentRealisticSalesTons: currentSalesTonsByMarket.get(m.market) ?? 0,
      shadowRealisticSalesTons: salesTonsByMarket.get(m.market) ?? 0,
      shadowContributionUsd: contributionUsdByMarket.has(m.market) ? contributionUsdByMarket.get(m.market)! : null,
      marginalEffortCapacityForNextHeadcountTons: marginalNext,
      bindingConstraintReason,
    };
  });

  return {
    companyId: observation.companyId,
    objective,
    totalHeadcount,
    steps,
    marketSummaries,
    unassignedHeadcount,
  };
}

/** volume-oriented shadowとcontribution-oriented shadowを両方計算し、比較しやすい形で返す。 */
export interface ShadowSalesAllocationComparison {
  readonly volumeOriented: ShadowSalesAllocationResult;
  readonly contributionOriented: ShadowSalesAllocationResult;
}

export function buildShadowSalesAllocationComparison(
  observation: StandardAiObservation,
  unitEconomics: StandardAiUnitEconomicsResult,
  desiredByProduct: ProductAmount,
  currentSalesPlans: readonly CompanySalesPlanEntry[],
  salesParams: SalesParameters = SALES_PARAMETERS_V1
): ShadowSalesAllocationComparison {
  return {
    volumeOriented: buildShadowSalesAllocation(observation, unitEconomics, desiredByProduct, currentSalesPlans, "volume", salesParams),
    contributionOriented: buildShadowSalesAllocation(observation, unitEconomics, desiredByProduct, currentSalesPlans, "contribution", salesParams),
  };
}
