// ShrimpX V2 — 2026-08-03 Phase C: Market × Product Opportunity 診断モジュール
//
// 【目的】市場×商品ごとの販売機会を、単一の「魅力度」に潰さず、需要規模・営業制約・
// 採算性を別々の軸として保持したまま分解する。「市場価格が高い」ことと「営業人員を
// 増やす価値が高い」ことを同義にしない（三宅さんの指示）。診断専用（read-only）で、
// 本番の販売・生産・人員配置の意思決定は一切変更しない。
//
// 【重要な構造的限界（捏造しない）】現行のStandardAiObservation/PublicMarketInfoの
// 情報境界には、市場（CN/US/EU/JP/OTHER）ごとの絶対需要量（target demand）が
// 一切存在しない（types.tsのMarketObservationEntryのコメント「PublicMarketInfoには
// 市場別の需要数量そのものは含まれない」を参照）。前期実績の参照価格・構成比トレンド
// （相対値）はあるが、トン数としての絶対需要はゲームエンジンのどの公開情報にも
// 露出していない（vietnamDomesticの供給/需要トン数のような「既存だが未転記だった
// 値」ではなく、そもそも市場エンジンの出力自体に存在しない）。したがって
// targetDemandTons・supplierShareCeilingTons（=targetDemand×シェア上限）は
// 恒常的にnull（unknown）として返す。これはPhase A的な「配線ギャップ」ではなく、
// 真の観測構造上の限界であり、#04（ゲームルール確認事項）として報告する
// （停止条件「実需要データが観測構造上取得不能」に該当するが、他の9項目は
// 計算可能であるため、この1項目のみnullとして進める判断とした）。
//
// 【既存ロジックの再利用（新しい需要・競争力ロジックは作らない）】
//   - sales/allocation.ts computeCompetitivenessBreakdown（実際の成約配分が使う
//     価格競争力・非価格競争力の合成式そのもの）を、当期の現実の提示ではなく
//     「参照価格のまま提示した場合」の仮想入力で呼び出し、price-related /
//     CTS-related（coverage・relationship・quality・deliveryReliability・
//     salesBase）の内訳をそのまま転用する。
//   - sales/salesForce.ts processingCapacity（既存の営業人員飽和カーブ）。
//   - sales/parameters.ts SALES_PARAMETERS_V1.maximumSupplierShare（既存の
//     最大供給者シェア比率）。トン数の上限は計算できないが、比率自体は既知。
//   - 呼び出し元が既に計算済みのcurrent sales plans（decision/sales.tsの出力）を
//     そのまま受け取る。営業配分ロジックを複製・再実行しない。
//   - Phase B（forwardUnitEconomics.ts）のUnit Economicsエントリをそのまま
//     参照する（採算判断ロジックを複製しない）。

import { DemandMarketId, Product } from "../../../market/types";
import { CompanySalesPlanEntry } from "../../../sales/types";
import { computeCompetitivenessBreakdown } from "../../../sales/allocation";
import { processingCapacity, salesCoverageScore } from "../../../sales/salesForce";
import { SalesParameters, SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../../core/units";
import { StandardAiObservation } from "../types";
import { StandardAiProfitabilityClass, StandardAiUnitEconomicsResult } from "./forwardUnitEconomics";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

export interface StandardAiMarketOpportunityEntry {
  readonly companyId: string;
  readonly market: DemandMarketId;
  readonly product: Product;

  /** 前期実績の参照売価（USD/HOSO換算kg）。観測に無ければnull。 */
  readonly referenceSellingPriceUsdPerKg: number | null;

  /**
   * 対象需要（トン）。恒常的にnull（ファイル冒頭コメント参照。現行の観測構造には
   * 市場別の絶対需要量が一切存在しないため、憶測で埋めない）。
   */
  readonly targetDemandTons: null;
  /** 最大供給者シェア比率（既存パラメータ、既知）。 */
  readonly supplierShareCeilingRatio: number;
  /** シェア上限のトン数換算（targetDemandTons×ratio）。targetDemandTonsがnullのため恒常的にnull。 */
  readonly supplierShareCeilingTons: null;

  /**
   * CTS（顧客関係・品質・納期信頼性・営業基盤）関連の需要効果。
   * sales/allocation.tsの合成競争力式のうち、価格以外の各contributionの合計
   * （0〜coverage+relationship+quality+deliveryReliability+salesBaseの各重み合計）。
   * 「参照価格のまま提示した」場合の仮想値であり、実際の当期提示価格とは無関係
   * （＝価格効果と完全に分離するための意図的な仮定）。
   */
  readonly ctsRelatedDemandEffect: number;
  /**
   * 価格関連の需要効果（priceContribution）。参照価格どおりに提示した場合は
   * 中立（deviation=0 → priceScore=1）を基準とする。参照価格が未観測（null）の
   * 場合はnull。
   */
  readonly priceRelatedDemandEffect: number | null;

  /** この市場に現在配置されている営業人員数（現行の意思決定より。0人なら現在提案なし）。 */
  readonly salesForceHeadcountInMarket: number;
  /** その人員数から導かれる、市場共有の営業工数換算処理能力（HOSO換算トン）。 */
  readonly salesForceEffortCapacityHosoEqTons: number;
  /** 現在の意思決定における、この市場×商品の現実的販売量（トン）。計画が無ければ0。 */
  readonly currentRealisticSalesTons: number;

  /**
   * 【需要非依存の容量ベース機会】この市場の営業工数枠を全てこの商品1品に
   * 使った場合の理論上限（capacity/effortCoefficient）から、現在の現実的販売量を
   * 引いた残差。真の需要に基づく「未開拓機会」ではない（targetDemandが未観測の
   * ため）。あくまで「今の営業人員規模の範囲内で、商品ミックスを変えれば
   * まだ何トン積めるか」という容量制約だけを反映した参考値であることを
   * 明示する。
   */
  readonly unservedOpportunityWithinCurrentCapacityTons: number;

  readonly profitabilityClass: StandardAiProfitabilityClass | null;
  readonly contributionMarginUsdPerKg: number | null;
  readonly contributionMarginUsdPerIncrementalTon: number | null;

  /**
   * 【Phase F-6】この商品1トンを売るために消費する営業工数（effort係数、
   * sales/parameters.ts SALES_PARAMETERS_V1.salesEffortCoefficients。HOSO=1.0/
   * PD=1.2/VAP=3.0）。既存パラメータをそのまま転記しただけであり、新しい
   * 係数は作っていない。
   */
  readonly salesEffortConsumptionCoefficient: number;
  /**
   * 【Phase F-6・新規診断指標】希少な営業工数1単位あたりの貢献利益
   * （= contributionMarginUsdPerIncrementalTon / salesEffortConsumptionCoefficient）。
   * 「どの市場×商品に、限られた営業工数の次の1単位を投じるべきか」を比較する
   * ための診断専用の相対指標であり、生産・販売配分の目的関数へはまだ接続していない
   * （Phase D Shadow Allocationのcontribution-oriented判定式とは独立な、
   * 表示・比較専用の値）。CM<=0の場合は0（無意味な負の「優先度」を示さない）。
   */
  readonly contributionPerSalesEffortUnitUsd: number | null;

  readonly dataQuality: {
    readonly targetDemandUnobservableReason: string;
  };
}

export interface StandardAiMarketOpportunityResult {
  readonly companyId: string;
  readonly entries: readonly StandardAiMarketOpportunityEntry[];
}

const TARGET_DEMAND_UNOBSERVABLE_REASON =
  "現行のStandardAiObservation/PublicMarketInfoには、市場（CN/US/EU/JP/OTHER）別の絶対需要量が" +
  "一切露出していない（前期実績の参照価格・構成比トレンドという相対値のみ）。市場エンジンの出力自体に" +
  "この情報が存在しないため、Standard AI側の配線修正では解決できない（#04確認事項）。";

function findPlan(plans: readonly CompanySalesPlanEntry[], market: DemandMarketId, product: Product): CompanySalesPlanEntry | undefined {
  return plans.find((p) => p.market === market && p.product === product);
}

export function buildStandardAiMarketOpportunity(
  observation: StandardAiObservation,
  unitEconomics: StandardAiUnitEconomicsResult,
  currentSalesPlans: readonly CompanySalesPlanEntry[],
  salesParams: SalesParameters = SALES_PARAMETERS_V1
): StandardAiMarketOpportunityResult {
  const entries: StandardAiMarketOpportunityEntry[] = [];

  for (const marketEntry of observation.markets) {
    const market = marketEntry.market;
    // 【現在の市場内営業人員】同一市場内の全商品行は同じsalesForceHeadcountを
    // 共有する（既存のsales/marketEffort.tsの前提と同一）。当該市場に計画行が
    // 1つも無ければ0人（現在は提案していない）とみなす。
    const anyPlanInMarket = currentSalesPlans.find((p) => p.market === market);
    const headcountInMarket = anyPlanInMarket?.salesForceHeadcount ?? 0;
    const capacityHosoEqTons = unwrapUnit(processingCapacity(headcountInMarket, salesParams));

    for (const product of PRODUCTS) {
      const referencePrice = marketEntry.referencePriceByProduct?.[product] ?? null;
      const plan = findPlan(currentSalesPlans, market, product);
      const currentRealisticSalesTons = plan ? unwrapUnit(plan.desiredQuantity) : 0;

      let ctsRelatedDemandEffect = 0;
      let priceRelatedDemandEffect: number | null = null;
      if (referencePrice !== null) {
        const syntheticEntry: CompanySalesPlanEntry = {
          companyId: observation.companyId,
          market,
          product,
          desiredQuantity: hosoEqTons(0),
          priceAdjustmentUsdPerHosoEqKg: 0,
          salesForceHeadcount: headcountInMarket,
          customerRelationship: observation.customerTrustByMarket[market],
          qualityReputation: observation.qualityScoreByProduct[product],
          deliveryReliability: observation.deliveryReliabilityByMarket[market],
          salesBaseScore: observation.salesBaseByMarketProduct?.[market]?.[product],
        };
        // 【参照価格どおりに提示した場合を基準とする】askPrice=basePrice=referencePrice
        // （deviation=0）とし、価格効果は完全に中立（priceScore=1）から出発する。
        // 実際の当期提示価格（値引き等）とは独立に、需要効果を価格要因と
        // CTS要因へ分離するための意図的な仮想入力。
        const breakdown = computeCompetitivenessBreakdown(
          syntheticEntry,
          usdPerHosoEqKg(referencePrice),
          usdPerHosoEqKg(referencePrice),
          salesCoverageScore(headcountInMarket, salesParams),
          salesParams
        );
        priceRelatedDemandEffect = breakdown.priceContribution;
        ctsRelatedDemandEffect =
          breakdown.coverageContribution +
          breakdown.relationshipContribution +
          breakdown.qualityContribution +
          breakdown.deliveryReliabilityContribution +
          breakdown.salesBaseContribution;
      }

      const singleProductCeilingTons = capacityHosoEqTons / salesParams.salesEffortCoefficients[product];
      const unservedOpportunityWithinCurrentCapacityTons = Math.max(0, singleProductCeilingTons - currentRealisticSalesTons);

      const ueEntry = unitEconomics.entries.find((e) => e.market === market && e.product === product);
      const effortCoefficient = salesParams.salesEffortCoefficients[product];
      const cmPerIncrementalTon = ueEntry?.contributionMarginUsdPerKg != null ? ueEntry.contributionMarginUsdPerKg * 1000 : null;
      const contributionPerSalesEffortUnitUsd =
        cmPerIncrementalTon != null && cmPerIncrementalTon > 0 ? cmPerIncrementalTon / effortCoefficient : cmPerIncrementalTon != null ? 0 : null;

      entries.push({
        companyId: observation.companyId,
        market,
        product,
        referenceSellingPriceUsdPerKg: referencePrice,
        targetDemandTons: null,
        supplierShareCeilingRatio: salesParams.maximumSupplierShare,
        supplierShareCeilingTons: null,
        ctsRelatedDemandEffect,
        priceRelatedDemandEffect,
        salesForceHeadcountInMarket: headcountInMarket,
        salesForceEffortCapacityHosoEqTons: capacityHosoEqTons,
        currentRealisticSalesTons,
        unservedOpportunityWithinCurrentCapacityTons,
        profitabilityClass: ueEntry?.profitabilityClass ?? null,
        contributionMarginUsdPerKg: ueEntry?.contributionMarginUsdPerKg ?? null,
        contributionMarginUsdPerIncrementalTon: cmPerIncrementalTon,
        salesEffortConsumptionCoefficient: effortCoefficient,
        contributionPerSalesEffortUnitUsd,
        dataQuality: { targetDemandUnobservableReason: TARGET_DEMAND_UNOBSERVABLE_REASON },
      });
    }
  }

  return { companyId: observation.companyId, entries };
}
