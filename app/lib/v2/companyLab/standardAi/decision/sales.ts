// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 販売ドメイン
//
// 【基本方針（実装指示 §販売）】
//   - 既存の未履行契約の履行を最優先する（生産計画側でbacklogを加味するため、
//     ここでは販売希望量が「新規に売り込みたい量」であることに注意）。
//   - 現在庫＋当期生産計画で賄える範囲を超えて売り込まない（過大な新規約束をしない）。
//   - 完成品在庫が過剰な商品はより積極的に販売する（値引き・数量増）。
//   - 供給余力が薄い（前期稼働率が高水準）ときは値引きを避ける。
//   - PD/VAPは市場プレミアムが最低受注水準未満なら販売提案を出さない
//     （premiumPolicy.tsの既存ロジックをそのまま使う。会社×商品の経済性が
//     違えば結果も自然に変わるが、判断ロジック自体は全社共通）。
//   - 市場ごとの優先順位は、会社固有の「好みの市場」ではなく、前期実績の
//     参照価格が高い市場を優先する（pressures.tsのmarketPriceRanking、
//     公開情報だけで完結する規則）。

import { hosoEqTons, unwrapUnit } from "../../../core/units";
import { DemandMarketId, Product } from "../../../market/types";
import { CompanySalesPlanEntry, PlanCostExpectation } from "../../../sales/types";
import { SalesParameters, SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { allocateHeadcountAcrossMarkets, computeMarketSalesEffort, salesEffortWeightedQuantity } from "../../../sales/marketEffort";
import { computeMarketSalesCapacities } from "../../../sales/salesCapacityModel";
import { minimumAcceptablePremium, orderQuantityFactor } from "../../premiumPolicy";
import { CompanyFixture } from "../../types";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation, zeroProductAmount } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";

const EPSILON = 1e-6;

function ratioAdjustmentToUsd(ratioAdjustment: number, referencePrice: number | undefined): number {
  if (referencePrice === undefined || referencePrice <= EPSILON) return 0;
  const clamped = Math.max(-0.3, Math.min(0.3, ratioAdjustment));
  return clamped * referencePrice;
}

/**
 * 【SAI-4変更】旧`BASE_UTILIZATION_TARGET = 0.8`のハードコード定数を
 * `params.salesUtilizationTarget`へ置き換えただけで、既定値・計算式は変更していない
 * （STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget = 0.8のため、パラメータ未指定・
 * 未バイアス時は従来と完全に同じ挙動）。5社異質モデルの差し込み口。
 */
/**
 * 【Batch 002】市場×商品別の観測需要と採算性から、市場間の按分重みを求める。
 *
 * 【なぜ必要か】従来の按分は「前期参照価格が首位の市場へ50%、残り4市場へ均等」で、
 * 市場規模を一切見ていなかった。単価が高く規模の小さい日本市場に営業力の半分が
 * 機械的に集中する（JP19問題）のは、この規則の直接の帰結である。
 *
 * 【スコアの定義（§11）】
 *   marketOpportunityScore = 観測上の獲得可能需要 × 期待貢献利益
 *     獲得可能需要 = observedDemand × maximumSupplierShare
 *     期待貢献利益 = 参照売価 − 想定加工費（1トンあたり、負なら機会なしとして0）
 *
 * maximumSupplierShare は sales/parameters.ts の共有パラメータをそのまま参照する
 * （AI側に 0.35 をhard-codeしない）。
 *
 * 【hard capを置いていない】特定市場の人数上限・単一市場シェア上限のような
 * 恣意的な上限は設けない。観測需要が大きい市場の重みが自然に大きくなるだけであり、
 * 市場規模が変われば重みも連続的に変わる。
 *
 * 観測需要が公開されていない場合（旧スナップショット等）は undefined を返し、
 * 呼び出し側は従来の重みへフォールバックする（挙動を壊さない）。
 */
/**
 * 【説明可能性のための内訳（2026-08-08追加）】重みそのものは変えず、
 * 重みを構成した決定論的な計算値をそのまま外へ出すための器。
 * 「なぜ日本に3人で中国に13人なのか」を実数で辿れるようにするためのものであり、
 * この値から重みを再計算したり、生成AIに理由を考えさせたりはしない。
 */
export interface MarketOpportunityComponent {
  readonly market: DemandMarketId;
  readonly product: Product;
  /** 観測需要（原則2四半期前の実績。hidden true demandではない）。 */
  readonly observedDemand: number;
  /** 獲得可能需要 = observedDemand × maximumSupplierShare。 */
  readonly attainableDemand: number;
  /** 参照売価（未観測ならnull。推測で埋めない）。 */
  readonly referencePriceUsdPerHosoEqKg: number | null;
  /** 期待貢献 = 参照売価 − 加工コスト（参照売価が未観測なら1として規模のみで按分）。 */
  readonly expectedContributionUsdPerHosoEqKg: number;
  /** 正規化前の機会スコア = attainableDemand × expectedContribution。 */
  readonly opportunityScore: number;
  /** 正規化後の按分重み（この商品の全市場合計が1）。 */
  readonly normalizedWeight: number;
}

/**
 * 【Phase 6】1つの市場×商品の観測上の機会（唯一の計算箇所）。
 *
 * 按分重み（buildMarketOpportunityWeights）と Commercial Ambition の両方が
 * **この関数だけ**を使う。同じ「獲得可能需要」「期待貢献」を2箇所で別々に
 * 計算しないための共有点である。
 */
export function observableOpportunityCell(
  observation: StandardAiObservation,
  market: DemandMarketId,
  product: Product,
  salesParams: SalesParameters
): {
  readonly observedDemand: number;
  readonly attainableDemand: number;
  readonly referencePrice: number | undefined;
  readonly contributionPerKg: number;
  readonly score: number;
  /** 参照売価が観測でき、かつ期待貢献が正であること（＝採算の取れる機会）。 */
  readonly isProfitable: boolean;
} {
  const entry = observation.markets.find((m) => m.market === market);
  const observedDemand = entry?.observedDemandByProduct?.[product] ?? 0;
  // 1社が1つの市場×商品で取れる上限（sales/allocation.ts の個社成約上限と同じ規則）。
  const attainableDemand = observedDemand * salesParams.maximumSupplierShare;
  const referencePrice = entry?.referencePriceByProduct?.[product];
  const processingCost = observation.productEconomics.expectedProcessingCostUsdPerHosoEqKg[product];
  // 参照売価が未観測（turn1等）のときは採算差が付けられないため、
  // 規模のみで按分する（価格を推測して捏造しない）。
  const contributionPerKg = referencePrice === undefined ? 1 : referencePrice - processingCost;
  const score = observedDemand <= EPSILON || contributionPerKg <= 0 ? 0 : attainableDemand * contributionPerKg;
  return {
    observedDemand,
    attainableDemand,
    referencePrice,
    contributionPerKg,
    score,
    isProfitable: referencePrice !== undefined && contributionPerKg > 0 && observedDemand > EPSILON,
  };
}

/**
 * 【Phase 6】会社が観測できる商業機会の合計。
 *
 * **未来の TRUE WORLD を使わない** — 参照するのは observation.markets
 * （原則2四半期遅行の公開実績）だけである。
 */
export interface ObservableCommercialOpportunity {
  readonly observableDemandTons: number;
  readonly attainableDemandTons: number;
  /** うち期待貢献が正の分だけ。採算が取れない需要を「機会」と数えない。 */
  readonly attainableProfitableTons: number;
  /** 採算つき機会の加重平均期待貢献（USD/HOSO換算kg）。機会が無ければ0。 */
  readonly weightedContributionUsdPerKg: number;
  /** 参照売価が1つも観測できていない（turn1等）。採算を断定しない。 */
  readonly priceObservationMissing: boolean;
}

export function computeObservableCommercialOpportunity(
  observation: StandardAiObservation,
  salesParams: SalesParameters = SALES_PARAMETERS_V1
): ObservableCommercialOpportunity {
  let observableDemandTons = 0;
  let attainableDemandTons = 0;
  let attainableProfitableTons = 0;
  let contributionWeighted = 0;
  let anyPriceObserved = false;

  for (const entry of observation.markets) {
    for (const product of ["hoso", "pd", "vap"] as const) {
      const cell = observableOpportunityCell(observation, entry.market, product, salesParams);
      if (cell.observedDemand <= EPSILON) continue;
      observableDemandTons += cell.observedDemand;
      attainableDemandTons += cell.attainableDemand;
      if (cell.referencePrice !== undefined) anyPriceObserved = true;
      if (cell.isProfitable) {
        attainableProfitableTons += cell.attainableDemand;
        contributionWeighted += cell.attainableDemand * cell.contributionPerKg;
      }
    }
  }

  return {
    observableDemandTons,
    attainableDemandTons,
    attainableProfitableTons,
    weightedContributionUsdPerKg: attainableProfitableTons > EPSILON ? contributionWeighted / attainableProfitableTons : 0,
    priceObservationMissing: !anyPriceObserved,
  };
}

/**
 * 【Phase SAI-GROW-2・実装指示§3・§4】会社の志向で重み付けした観測機会。
 *
 * 【AとBとCを混同しない】
 *   A 市場で観測できる採算需要（＝ここで数える対象）
 *   B 会社が現実的に取り得るshare（＝AI側の控えめ係数。**ここでは使わない**）
 *   C 現在AIが提出する量（＝ここでは使わない。使うと循環する）
 *
 * engineのmaximumSupplierShareだけは制度上の上限なので掛ける（Aの定義の一部）。
 * 重みは既存のorientation倍率（sales.tsの按分と同じclamp範囲）をそのまま再利用し、
 * 新しい市場・商品のhardcodeは作らない。
 */
export function computeOrientationWeightedOpportunity(
  observation: StandardAiObservation,
  salesParams: SalesParameters,
  marketOrientation: Readonly<Partial<Record<DemandMarketId, number>>>,
  productOrientation: Readonly<Partial<Record<Product, number>>>
): { readonly weightedAttainableProfitableTons: number; readonly orientationActive: boolean } {
  const marketActive = Object.values(marketOrientation).some((v) => v !== undefined && v !== 1);
  const productActive = Object.values(productOrientation).some((v) => v !== undefined && v !== 1);
  const orientationActive = marketActive || productActive;
  let weighted = 0;
  for (const entry of observation.markets) {
    for (const product of ["hoso", "pd", "vap"] as const) {
      const cell = observableOpportunityCell(observation, entry.market, product, salesParams);
      if (!cell.isProfitable) continue;
      const combined = (marketOrientation[entry.market] ?? 1) * (productOrientation[product] ?? 1);
      // 総合補正の許容範囲は既存の按分側と同一（0.70〜1.35）。
      const clamped = Math.max(0.7, Math.min(1.35, combined));
      weighted += cell.attainableDemand * (orientationActive ? clamped : 1);
    }
  }
  return { weightedAttainableProfitableTons: weighted, orientationActive };
}

function buildMarketOpportunityWeights(
  observation: StandardAiObservation,
  markets: readonly DemandMarketId[],
  salesParams: SalesParameters,
  componentsOut?: MarketOpportunityComponent[]
): Record<Product, number[]> | undefined {
  const hasObservedDemand = observation.markets.some((m) => m.observedDemandByProduct !== undefined);
  if (!hasObservedDemand) return undefined;

  const result = { hoso: [] as number[], pd: [] as number[], vap: [] as number[] };

  for (const product of ["hoso", "pd", "vap"] as const) {
    const detail = markets.map((market) => {
      // 【Phase 6】獲得可能需要・期待貢献・機会スコアの計算は
      // observableOpportunityCell へ一本化した（Commercial Ambition と同一の式）。
      const cell = observableOpportunityCell(observation, market, product, salesParams);
      return {
        market,
        observedDemand: cell.observedDemand,
        obtainable: cell.attainableDemand,
        referencePrice: cell.referencePrice,
        contributionPerKg: cell.contributionPerKg,
        score: cell.score,
      };
    });
    const scores = detail.map((d) => d.score);
    const total = scores.reduce((sum, v) => sum + v, 0);
    // 全市場のスコアが0（＝どこも採算が合わない／需要が観測できない）の場合は
    // 均等配分にフォールバックする（販売をゼロにする判断はここではしない）。
    result[product] = total > EPSILON ? scores.map((v) => v / total) : markets.map(() => 1 / markets.length);
    if (componentsOut) {
      detail.forEach((d, i) => {
        componentsOut.push({
          market: d.market,
          product,
          observedDemand: d.observedDemand,
          attainableDemand: d.obtainable,
          referencePriceUsdPerHosoEqKg: d.referencePrice ?? null,
          expectedContributionUsdPerHosoEqKg: d.contributionPerKg,
          opportunityScore: d.score,
          normalizedWeight: result[product][i],
        });
      });
    }
  }
  return result;
}

function orderFactorsByProduct(fixture: CompanyFixture, observation: StandardAiObservation, params: StandardAiParameters): ProductAmount {
  // 【SAI-4変更】PD/VAPの受注量係数に、valueAddedOrderFactorBoost（既定0）を加算する。
  // HOSOには適用しない（HOSOはpremiumPolicy.tsの対象外＝常に1のため、そもそも
  // 「加算して優先させる」対象にならない）。加算後は[0, 1.1]にクランプし、
  // 捏造的な値（例えば負の受注量係数）を作らない。
  const clampOrderFactor = (v: number) => Math.max(0, Math.min(1.1, v));
  return {
    hoso: 1,
    pd: clampOrderFactor(orderQuantityFactor(fixture.productEconomics.premiumEconomics.pd, observation.marketPremiumByProduct.pd) + params.valueAddedOrderFactorBoost),
    vap: clampOrderFactor(orderQuantityFactor(fixture.productEconomics.premiumEconomics.vap, observation.marketPremiumByProduct.vap) + params.valueAddedOrderFactorBoost),
  };
}

function buildCostExpectation(fixture: CompanyFixture, product: Product, observation: StandardAiObservation, params: StandardAiParameters): PlanCostExpectation {
  const expectedRawPrice = observation.vietnamDomesticPriorPrice ?? params.defaultExpectedRawPriceUsdPerKg;
  const expectedProcessingCost = fixture.productEconomics.expectedProcessingCostUsdPerHosoEqKg[product];

  let minimumAcceptablePrice: number;
  if (product === "hoso" || observation.lastHosoPriceVn === undefined) {
    minimumAcceptablePrice = expectedRawPrice + expectedProcessingCost;
  } else {
    const econ = fixture.productEconomics.premiumEconomics[product];
    minimumAcceptablePrice = observation.lastHosoPriceVn + minimumAcceptablePremium(econ);
  }

  return {
    expectedRawMaterialPriceUsdPerHosoEqKg: Math.round(expectedRawPrice * 10000) / 10000,
    expectedProcessingCostUsdPerHosoEqKg: Math.round(expectedProcessingCost * 10000) / 10000,
    minimumAcceptablePriceUsdPerHosoEqKg: Math.round(minimumAcceptablePrice * 10000) / 10000,
  };
}

/** 商品別の価格調整比率（基準価格に対する比率）。fg過剰なら値引き、供給余力が薄ければ値引きしない。 */
function priceAdjustmentRatioByProduct(
  observation: StandardAiObservation,
  pressures: PressureScores,
  params: StandardAiParameters
): ProductAmount {
  const result = zeroProductAmount();
  for (const product of ["hoso", "pd", "vap"] as const) {
    const excessRatio = pressures.finishedGoodsExcessRatioByProduct[product];
    if (excessRatio <= params.excessInventoryRatioForDiscount) continue;
    if (pressures.equipmentUtilizationLastQuarter >= params.highUtilizationRatioForNoDiscount) continue; // 供給余力が薄い＝値引きしない
    const overshoot = Math.min(1, (excessRatio - params.excessInventoryRatioForDiscount) / params.excessInventoryRatioForDiscount);
    result[product] = -params.maxDiscountRatioForExcessStock * overshoot;
  }
  return result;
}

/** 会社×市場×商品ぶんの、営業工数制約を適用する「前」の希望販売数量（SAI-3A
 *  自動運転・判断ログ基盤向け）。営業工数制約適用後（=最終的なCompanySalesPlanEntry.
 *  desiredQuantity）と対にすることで、「事前希望案 → 営業工数調整後」の差分を
 *  再計算なしで追跡できる。既存の計算経路（本ファイル内で既に算出済みの
 *  desiredByMarketProduct）をそのまま公開するだけで、新しい計算は一切行わない。 */
export interface SalesWishEntry {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly desiredQuantityBeforeEffortConstraint: number;
}

export interface SalesPlanResult {
  readonly salesPlans: readonly CompanySalesPlanEntry[];
  /**
   * 【要注意・意味の明確化（SAI-6.2）】工場能力×稼働率目標×受注量係数だけで
   * 決まる、営業人員制約を一度も経由していない「理論上の販売希望量」。
   * 市場・価格・実在する営業人員のいずれにも依存しない。
   *
   * 【生産計画への入力として使ってはならない】この値は診断専用の参考値
   * （「営業人員が仮に無制限だった場合の理論上限」）であり、生産計画・原料調達
   * 計画の入力には使わないこと。過去のTest14 Turn1調査
   * （docs/standard_ai/TEST14_TURN1_STANDARD_AI_REDESIGN_ANALYSIS.md §6）で、
   * この値を生産計画へ直結する配線ミスが、販売可能量の約2〜2.7倍という
   * 過剰生産・過剰原料調達を引き起こしていたことが判明している。生産計画の
   * 入力には`realisticSalesByProduct`（下記）を使うこと。
   */
  readonly desiredByProduct: ProductAmount;
  /**
   * 【SAI-6.2新設】営業人員配分・市場別工数制約を反映した後の、現実的に販売可能な
   * 商品別合計数量（＝`salesPlans`の商品別合計。新しい計算は行わず、既に確定した
   * `salesPlans`を単純合計するだけ）。生産計画（将来のCurrent Period Delivery
   * Demand層・SAI-6.3以降）が参照すべきはこちらであり、`desiredByProduct`ではない。
   */
  readonly realisticSalesByProduct: ProductAmount;
  /** 【SAI-3A】営業工数制約適用前の、会社×市場×商品ぶんの希望販売数量一覧。 */
  readonly salesWishByMarketProduct: readonly SalesWishEntry[];
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

export function buildStandardAiSalesPlans(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1,
  /**
   * 【SAI-2追加作業: 市場別営業配置・商品別営業工数】営業工数換算能力の計算
   * （sales/marketEffort.ts）に使うパラメータ。エンジン本体(sales/runner.ts)が
   * 使う定数と必ず同じ値を参照する必要があるため、既定値もSALES_PARAMETERS_V1で
   * エンジン側と揃えている（標準AIの意思決定根拠と、エンジン適用後の実際の結果が
   * 食い違わないようにするため）。
   */
  salesParams: SalesParameters = SALES_PARAMETERS_V1,
  /**
   * 【Phase 6】Commercial Ambition による希望販売量の倍率（1以上）。
   * 未指定なら1＝従来どおり「自社能力 × salesUtilizationTarget」だけで決まる。
   * **これは「売りたい量」の倍率であり、生産量・契約量を直接増やすものではない**
   * （営業工数・生産能力・納品規律の制約は下流でそのまま効く）。
   */
  commercialAmbitionMultiplier?: number,
  /**
   * 【Phase 6C】Commercial Commitment（今期どこまで市場へ取りに行くか）。
   * vision/commercialCommitment.ts が決めた提出目標量（HOSO換算トン）。
   *
   * **これは「売りたい量」ではなく「今期の提出量の上限」である**。
   * Commercial Ambition をそのまま市場へ提出すると、成約率を無視した過剰提出
   * （Phase 6B で実測: 提出24,420t に対し成約14,425t、在庫3倍、利益−61%）に
   * なるため、志と提出を分離する。
   *
   * 未指定（undefined）なら上限を掛けない＝従来どおりの挙動。
   */
  submissionTargetTons?: number | null
): SalesPlanResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const capacityTotals = observation.totalCapacityByProduct;
  const orderFactors = orderFactorsByProduct(fixture, observation, params);
  const priceAdjustments = priceAdjustmentRatioByProduct(observation, pressures, params);

  // 【SAI-5A】市場・商品志向。倍率が1件も設定されていない（既定の空オブジェクト）
  // 場合はorientationActive=falseとなり、以降の志向関連コードパスを完全に
  // スキップする（乗算・再正規化による浮動小数点の揺れも発生させず、従来と
  // ビット単位で同一の結果を保証する）。
  const marketOrientation = params.marketOrientationMultipliers;
  const productOrientation = params.productOrientationMultipliers;
  // 「1.0（中立）以外の倍率が1件でもあるか」で判定する。BAL（全倍率1.0の
  // 明示的な中立プロファイル）も、倍率未設定（既定の空オブジェクト）と同様に
  // 完全な既存コードパスを通す（×1.0の乗算や再正規化の除算による浮動小数点の
  // 揺れも発生させない＝中立志向の会社の判断は志向機能の有効/無効に依らず
  // ビット単位で同一）。
  const marketOrientationActive = Object.values(marketOrientation).some((v) => v !== undefined && v !== 1);
  const productOrientationActive = Object.values(productOrientation).some((v) => v !== undefined && v !== 1);
  const orientationActive = marketOrientationActive || productOrientationActive;
  const clampProductMult = (v: number) => Math.max(0.85, Math.min(1.2, v));
  const clampCombinedMult = (v: number) => Math.max(0.7, Math.min(1.35, v));

  // 【Phase 6】従来はここが「自社の名目能力 × 0.8」だけであり、市場需要も Vision も
  // 一切参照していなかった。実測ではこの式が5社・全32Qで誤差ゼロで成立し、
  // 能力→販売希望→営業人数→成約→生産→稼働率→増設可否→能力 という閉じた循環を
  // 作っていた（docs/standard_ai/SHRIMPX_VISION_DRIVEN_COMMERCIAL_GROWTH.md §監査）。
  //
  // Commercial Ambition（vision/commercialAmbition.ts）は、この供給側アンカーを
  // **床**として保ったまま、志と観測可能な採算つき市場機会を理由に倍率を掛ける。
  // 倍率は常に 1 以上であり、未指定なら 1（＝従来と完全に同一の挙動）。
  // 商品構成は変えない（どの商品を伸ばすかはここで発明しない）。
  const ambitionMultiplier = Math.max(1, commercialAmbitionMultiplier ?? 1);
  const potentialByProduct: ProductAmount = {
    hoso: capacityTotals.hoso * params.salesUtilizationTarget * ambitionMultiplier,
    pd: capacityTotals.pd * params.salesUtilizationTarget * ambitionMultiplier,
    vap: capacityTotals.vap * params.salesUtilizationTarget * ambitionMultiplier,
  };
  if (productOrientationActive) {
    // 商品志向: 商品別の目標販売数量へ倍率（0.85〜1.20にclamp）を乗じる。
    // 上限1.20×既定稼働率0.8=0.96のため、能力を超える希望量は構造上作られない。
    for (const product of ["hoso", "pd", "vap"] as const) {
      const mult = productOrientation[product];
      if (mult !== undefined && mult !== 1) {
        potentialByProduct[product] = potentialByProduct[product] * clampProductMult(mult);
      }
    }
  }

  // 【SAI-5F】ライフサイクル成長への前傾と、供給圧力リトリート（いずれも
  // 志向パラメータが非ゼロ かつ 該当する公開情報が観測できる場合のみ動く。
  // 既定パラメータ（growthTrendResponsiveness=0等）では完全に不活性）。
  if (params.growthTrendResponsiveness > 0 && observation.lifecycleTrendByMarket) {
    for (const product of ["pd", "vap"] as const) {
      const markets = Object.values(observation.lifecycleTrendByMarket);
      if (markets.length === 0) continue;
      const avgTrend = markets.reduce((s, m) => s + m[product], 0) / markets.length;
      if (avgTrend <= 0) continue;
      const boost = Math.min(
        params.lifecycleGrowthSalesBoostCap,
        avgTrend * params.lifecycleGrowthSalesBoostScale * params.growthTrendResponsiveness
      );
      if (boost <= EPSILON) continue;
      // 能力の98%を超えない範囲でのみ前傾する（hard constraintの尊重）。
      potentialByProduct[product] = Math.min(capacityTotals[product] * 0.98, potentialByProduct[product] * (1 + boost));
      diagnostics.push({
        code: "LIFECYCLE_GROWTH_PURSUED",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { avgLifecycleTrendPerQuarter: avgTrend, appliedBoostRatio: boost },
        message: `${product.toUpperCase()}の公開ライフサイクルトレンドが成長局面のため、販売目標を小幅（最大+5%）に前傾した。`,
      });
    }
  }
  if (params.oversupplyRetreatSensitivity > 0 && observation.productSupplyPressureByProduct) {
    for (const product of ["pd", "vap"] as const) {
      const pressure = observation.productSupplyPressureByProduct[product];
      if (pressure === undefined || pressure <= params.supplyPressureRetreatThreshold) continue;
      const retreatFactor = Math.max(
        params.supplyPressureRetreatFloor,
        1 - (pressure - params.supplyPressureRetreatThreshold) * params.oversupplyRetreatSensitivity
      );
      potentialByProduct[product] = potentialByProduct[product] * retreatFactor;
      diagnostics.push({
        code: "SUPPLY_PRESSURE_RETREAT",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { supplyPressureEwma: pressure, retreatFactor },
        message: `${product.toUpperCase()}の公開供給圧力が高止まりしているため、販売目標を小幅に抑制した（下限-15%）。`,
      });
    }
  }

  if (productOrientationActive) {
    diagnostics.push({
      code: "PRODUCT_ORIENTATION_APPLIED",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: {
        hosoMultiplier: productOrientation.hoso ?? 1,
        pdMultiplier: productOrientation.pd ?? 1,
        vapMultiplier: productOrientation.vap ?? 1,
      },
      message: "商品志向倍率を商品別の目標販売数量へ適用した（能力・安全ガードは上書きしない魅力度補正）。",
    });
  }

  // 【重要】desiredByProduct（生産計画側が参照するベースライン販売目標）には
  // 在庫過剰による上乗せ（excessBoost）を含めない。含めてしまうと、production.tsの
  // 「販売希望＋約定残−完成品在庫」という抑制式が、同じ上乗せ分だけ相殺されてしまい、
  // 在庫が過剰なのに生産が一向に減らない、という循環（実際にSAI-1開発中の32ターン
  // 検証で確認された不具合）が生じる。在庫の積極的な売り切り（plannedSalesQuantityByProduct）は
  // 販売計画（実際の市場提示数量）だけに反映し、生産計画側には伝播させない
  // （既存在庫から売るのであって、新たに生産させるためのシグナルではない）。
  const desiredByProduct: ProductAmount = zeroProductAmount();
  const plannedSalesQuantityByProduct: ProductAmount = zeroProductAmount();
  for (const product of ["hoso", "pd", "vap"] as const) {
    const excessRatio = pressures.finishedGoodsExcessRatioByProduct[product];
    const excessBoost = excessRatio > params.excessInventoryRatioForDiscount ? Math.min(0.5, excessRatio - 1) : 0;
    desiredByProduct[product] = Math.max(0, potentialByProduct[product] * orderFactors[product]);
    plannedSalesQuantityByProduct[product] = Math.max(0, desiredByProduct[product] * (1 + excessBoost));
    if (orderFactors[product] <= EPSILON && product !== "hoso") {
      diagnostics.push({
        code: "LOW_ORDER_BOOK_PREMIUM_FLOOR",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { marketPremium: observation.marketPremiumByProduct[product] ?? -1 },
        message: `${product.toUpperCase()}の市場プレミアムが最低受注水準未満のため、当期は新規販売提案を停止する。`,
      });
    } else if (excessBoost > EPSILON) {
      diagnostics.push({
        code: "PRICE_REDUCTION_FOR_EXCESS_STOCK",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { excessRatio, priceAdjustmentRatio: priceAdjustments[product] },
        message: `${product.toUpperCase()}の完成品在庫が目標水準を超えたため、値引きと販売数量の上乗せで在庫を圧縮する。`,
      });
    }
  }

  // 【Phase 6C】Commercial Commitment による提出量の上限。
  // 商品構成は変えず（どの商品を削るかをここで発明しない）、全商品を同一比率で縮小する。
  // 完成品在庫の売り切り上乗せ（excessBoost）も含めた「実際に市場へ出す量」に対して掛ける
  // （在庫があるからといって提出を減らすのではなく、提出の総量だけを規律する。#05 §12）。
  const submittedBeforeCommitment =
    plannedSalesQuantityByProduct.hoso + plannedSalesQuantityByProduct.pd + plannedSalesQuantityByProduct.vap;
  if (
    submissionTargetTons !== undefined &&
    submissionTargetTons !== null &&
    submissionTargetTons >= 0 &&
    submittedBeforeCommitment > submissionTargetTons + EPSILON
  ) {
    const commitmentScale = submissionTargetTons / submittedBeforeCommitment;
    for (const product of ["hoso", "pd", "vap"] as const) {
      plannedSalesQuantityByProduct[product] = plannedSalesQuantityByProduct[product] * commitmentScale;
    }
    diagnostics.push({
      code: "COMMERCIAL_COMMITMENT_SET",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: {
        submittedBeforeCommitment,
        submissionTargetTons,
        commitmentScale,
      },
      message:
        `今期市場へ取りに行く量（Commercial Commitment）を${Math.round(submissionTargetTons)}トンとし、` +
        `供給側アンカーから出た提出案${Math.round(submittedBeforeCommitment)}トンを比率${commitmentScale.toFixed(3)}で縮小した` +
        `（志＝売りたい量とは別に、今期の提出量を規律する）。`,
    });
  }

  const markets = pressures.marketPriceRanking as readonly DemandMarketId[];

  // --- 【Batch 002】市場×商品の希望販売量の按分重み ---
  // 従来は「前期参照価格が首位の市場に50%、残り4市場へ均等（各12.5%）」という、
  // 市場規模を一切見ない規則だった。単価が高く規模の小さい日本市場へ営業力の
  // 半分が機械的に集中する（Test15のJP19問題）直接原因である。
  //
  // Batch 002で市場×商品別の観測需要（2四半期前の実績）が公開されたため、
  // 市場規模と採算性の両方を反映した機会スコアで按分する。
  // 観測需要が無い場合（旧スナップショット等）は従来の重みへフォールバックする。
  const opportunityComponents: MarketOpportunityComponent[] = [];
  const opportunityWeights = buildMarketOpportunityWeights(observation, markets, salesParams, opportunityComponents);
  const legacyWeights = markets.map((_, idx) => (idx === 0 ? 0.5 : 0.5 / (markets.length - 1 || 1)));
  if (opportunityWeights) {
    diagnostics.push({
      code: "MARKET_ALLOCATION_BY_OBSERVED_OPPORTUNITY",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: {
        observationLagQuarters: observation.marketDemandObservationLagQuarters ?? -1,
        sourceQuarter: observation.marketDemandSourceQuarter ?? -1,
        ...Object.fromEntries(markets.map((m, i) => [`weight_${m}`, opportunityWeights.hoso[i]])),
      },
      message:
        "市場別の販売目標を、観測需要（原則2四半期前の実績）と採算性から求めた機会スコアで按分した（価格順位だけの按分は使わない）。",
    });
    // 【説明可能性（2026-08-08）】重みの内訳を市場ごとに1件ずつ残す。
    // 「なぜ日本に3人、中国に13人なのか」へ実数で答えるための決定論的な計算値であり、
    // 生成AI側が理由を creating しないための一次情報である。
    // HOSO換算の代表値としてhosoの内訳を出す（商品別の全量を出すと診断が膨らむため）。
    for (const comp of opportunityComponents.filter((c) => c.product === "hoso")) {
      diagnostics.push({
        code: "MARKET_OPPORTUNITY_COMPONENTS",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          observedDemand: comp.observedDemand,
          attainableDemand: comp.attainableDemand,
          maximumSupplierShare: salesParams.maximumSupplierShare,
          referencePriceUsdPerHosoEqKg: comp.referencePriceUsdPerHosoEqKg ?? -1,
          expectedContributionUsdPerHosoEqKg: comp.expectedContributionUsdPerHosoEqKg,
          opportunityScore: comp.opportunityScore,
          normalizedWeight: comp.normalizedWeight,
        },
        message:
          `${comp.market}市場: 観測需要${Math.round(comp.observedDemand)}t × 取得可能シェア` +
          `${(salesParams.maximumSupplierShare * 100).toFixed(0)}% = 獲得可能需要${Math.round(comp.attainableDemand)}t、` +
          `期待貢献${comp.expectedContributionUsdPerHosoEqKg.toFixed(2)}USD/kg。` +
          `機会スコアから按分重み${(comp.normalizedWeight * 100).toFixed(1)}%と算出した。`,
      });
    }
  }

  const desiredByMarketProduct = new Map<DemandMarketId, Record<Product, number>>();
  for (const market of markets) {
    desiredByMarketProduct.set(market, { hoso: 0, pd: 0, vap: 0 });
  }
  for (const product of ["hoso", "pd", "vap"] as const) {
    const totalDesired = plannedSalesQuantityByProduct[product];
    if (totalDesired <= EPSILON) continue;
    const productBaseWeights = opportunityWeights ? opportunityWeights[product] : legacyWeights;
    if (!orientationActive) {
      markets.forEach((market, idx) => {
        const desiredQuantity = totalDesired * productBaseWeights[idx];
        if (desiredQuantity <= EPSILON) return;
        desiredByMarketProduct.get(market)![product] = desiredQuantity;
      });
      continue;
    }
    // 【SAI-5A】市場志向: 既存の按分重み（前期価格ランキング首位50%・残り均等）に
    // 総合補正 clamp(市場倍率×商品倍率, 0.70, 1.35) を乗じ、商品ごとに再正規化する
    // （＝販売目標総量は変えず、市場・商品間で再配分する。実装指示§3）。
    //   - 按分の基礎は従来どおり市況（価格ランキング）であり、得意市場の市況が
    //     大幅に悪化して首位が交代すれば、志向倍率(≤1.25)より首位重み(50%)の
    //     移動が支配的になる＝他市場へ自然に移れる。
    //   - 需要ゼロ・プレミアム下限割れで基礎重み0の行は0のまま（志向だけを理由に
    //     販売を強制しない）。
    const baseWeights = productBaseWeights;
    const adjustedWeights = markets.map((market, idx) => {
      const combined = clampCombinedMult((marketOrientation[market] ?? 1) * (productOrientation[product] ?? 1));
      return baseWeights[idx] * combined;
    });
    const adjustedSum = adjustedWeights.reduce((s, w) => s + w, 0);
    const effectiveWeights = adjustedSum > EPSILON ? adjustedWeights.map((w) => w / adjustedSum) : baseWeights;
    markets.forEach((market, idx) => {
      const desiredQuantity = totalDesired * effectiveWeights[idx];
      if (desiredQuantity <= EPSILON) return;
      desiredByMarketProduct.get(market)![product] = desiredQuantity;
    });
  }
  if (marketOrientationActive) {
    diagnostics.push({
      code: "MARKET_ORIENTATION_APPLIED",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: {
        cnMultiplier: marketOrientation.CN ?? 1,
        usMultiplier: marketOrientation.US ?? 1,
        euMultiplier: marketOrientation.EU ?? 1,
        jpMultiplier: marketOrientation.JP ?? 1,
        otherMultiplier: marketOrientation.OTHER ?? 1,
      },
      message: "市場志向倍率を市場別の按分重みへ適用し、販売目標総量を保存したまま市場間で再配分した。",
    });
  }

  const marketsWithDemand = markets.filter((market) => {
    const byProduct = desiredByMarketProduct.get(market)!;
    return byProduct.hoso > EPSILON || byProduct.pd > EPSILON || byProduct.vap > EPSILON;
  });

  // 【SAI-3A】営業工数制約を適用する前の、会社×市場×商品ぶんの希望販売数量を
  // 診断・判断ログ向けにそのまま保存する（marketsWithDemandに含まれない市場は
  // 希望量が実質ゼロのため記録しない。既存の按分ロジック・数値は一切変更しない）。
  const salesWishByMarketProduct: SalesWishEntry[] = [];
  for (const market of marketsWithDemand) {
    const byProduct = desiredByMarketProduct.get(market)!;
    for (const product of ["hoso", "pd", "vap"] as const) {
      const desiredQuantityBeforeEffortConstraint = byProduct[product];
      if (desiredQuantityBeforeEffortConstraint <= EPSILON) continue;
      salesWishByMarketProduct.push({ market, product, desiredQuantityBeforeEffortConstraint });
    }
  }

  // 営業工数換算需要（HOSO+1.2×PD+3.0×VAP）に比例して、実在する営業人員を
  // 市場単位で配分する（行単位の均等割りではない。同じ市場のHOSO/PD/VAPは
  // この同一の人数を共有する）。
  const effortDemandByMarket = new Map<DemandMarketId, number>(
    marketsWithDemand.map((market) => [market, salesEffortWeightedQuantity(desiredByMarketProduct.get(market)!, salesParams)])
  );
  // 【SAI-6.2】fixture.salesForceHeadcountTotal（静的な基準値）ではなく、
  // observation.salesForceHeadcountTotal（observation.tsでownState.salesForceHiringState.headcount
  // へ既に読み替え済みの動的な現在人数）を参照する。turn1ではfixture値と同一のため
  // 既存挙動は変わらない（設計レポート§14参照）。
  const headcountByMarket = allocateHeadcountAcrossMarkets(observation.salesForceHeadcountTotal, effortDemandByMarket);

  // 配分された人数では当該市場の営業工数換算需要を賄いきれない場合、標準AIが
  // 自ら（エンジン側のsales/marketEffort.tsと全く同じ計算式で）市場内の全商品の
  // 希望数量を比例縮小する。これにより、AIが提出する意思決定の時点で既に
  // エンジン適用後と同じ制約を満たしており、「意思決定の説明」と「制約適用後の
  // 実際の結果」が食い違わない。
  const constrainedMarkets: { market: DemandMarketId; headcount: number; result: ReturnType<typeof computeMarketSalesEffort> }[] = [];
  const adjustedByMarketProduct = new Map<DemandMarketId, Record<Product, number>>();
  // 【Phase 6B・SSoT】市場ごとの営業能力は sales/salesCapacityModel.ts で1箇所だけ求める。
  // エンジン側（marketEffort.ts の applyMarketSalesEffortCapacity）と同じ関数を通すため、
  // AI の説明とエンジン適用後の結果が食い違わない。
  const capacityByMarket = computeMarketSalesCapacities(
    observation.salesForceHeadcountTotal,
    effortDemandByMarket,
    headcountByMarket,
    salesParams
  );
  for (const market of marketsWithDemand) {
    const headcount = headcountByMarket.get(market) ?? 0;
    const result = computeMarketSalesEffort(
      headcount,
      desiredByMarketProduct.get(market)!,
      salesParams,
      salesParams.salesCapacityModel && salesParams.salesCapacityModel.kind !== "perMarket" ? capacityByMarket.get(market) : undefined
    );
    adjustedByMarketProduct.set(market, result.adjustedQuantityByProduct as Record<Product, number>);
    if (result.isConstrained) {
      constrainedMarkets.push({ market, headcount, result });
    }
  }

  if (constrainedMarkets.length > 0) {
    // すべての需要のある市場が制約に達した場合は、市場間の配分ではなく実在する
    // 営業人員総数そのものが不足している可能性が高い。
    if (constrainedMarkets.length === marketsWithDemand.length) {
      diagnostics.push({
        code: "SALES_HEADCOUNT_INSUFFICIENT_TOTAL",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "warning",
        keyValues: { salesForceHeadcountTotal: observation.salesForceHeadcountTotal, constrainedMarketCount: constrainedMarkets.length },
        message: `実在する営業人員総数（${observation.salesForceHeadcountTotal}人）では、全${marketsWithDemand.length}市場の希望販売量（商品別営業工数を加味）を賄いきれず、すべての市場で販売計画を縮小した。`,
      });
    }
    for (const { market, headcount, result } of constrainedMarkets) {
      const byProduct = desiredByMarketProduct.get(market)!;
      const vapEffort = salesParams.salesEffortCoefficients.vap * byProduct.vap;
      const nonVapEffort = result.desiredEffortWeightedQuantity - vapEffort;
      if (byProduct.vap > EPSILON && vapEffort > nonVapEffort) {
        diagnostics.push({
          code: "VAP_MIX_INCREASES_SALES_EFFORT_NEED",
          domain: "sales",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: {
            vapDesiredQuantity: byProduct.vap,
            vapEffortCoefficient: salesParams.salesEffortCoefficients.vap,
            headcount,
            capacityHosoEqTons: result.capacityHosoEqTons,
          },
          message: `市場 "${market}": VAP比率の上昇により必要営業工数が増加し（VAP係数${salesParams.salesEffortCoefficients.vap}）、配置営業人員${headcount}人の処理能力を上回ったため、当該市場の販売計画を縮小した。`,
        });
      }
      diagnostics.push({
        code: "SALES_REDUCED_FOR_SUPPLY_LIMIT",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { scaleFactor: result.scaleFactor, capacityHosoEqTons: result.capacityHosoEqTons, headcount },
        message: `市場 "${market}": 営業人員${headcount}人による処理能力（${result.capacityHosoEqTons.toFixed(1)}トン相当）の不足により、当該市場の販売計画を${(result.scaleFactor * 100).toFixed(0)}%へ縮小した。`,
      });
    }
  }

  const plans: CompanySalesPlanEntry[] = [];
  for (const market of marketsWithDemand) {
    const headcount = headcountByMarket.get(market) ?? 0;
    const adjusted = adjustedByMarketProduct.get(market)!;
    for (const product of ["hoso", "pd", "vap"] as const) {
      const desiredQuantity = adjusted[product];
      if (desiredQuantity <= EPSILON) continue;
      const costExpectation = buildCostExpectation(fixture, product, observation, params);
      plans.push({
        companyId: fixture.companyId,
        market,
        product,
        desiredQuantity: hosoEqTons(Math.round(desiredQuantity * 100) / 100),
        priceAdjustmentUsdPerHosoEqKg: ratioAdjustmentToUsd(
          priceAdjustments[product],
          observation.markets.find((m) => m.market === market)?.referencePriceByProduct?.[product]
        ),
        salesForceHeadcount: headcount,
        costExpectation,
        qualityReputation: observation.qualityScoreByProduct[product],
        customerRelationship: observation.customerTrustByMarket[market],
        deliveryReliability: observation.deliveryReliabilityByMarket[market],
        // 【SAI-5D】前四半期末までの自社営業基盤（無効時undefined→エンジン側は
        // 中立値50として扱い、かつウェイト既定0のため結果へ影響しない）。
        salesBaseScore: observation.salesBaseByMarketProduct?.[market]?.[product],
      });
    }
  }

  // 【SAI-5D】営業基盤の優位が実際に計画へ反映されたことを診断へ記録する
  // （中立値+5点を超える基盤を持つ市場×商品へ計画を出した場合のみ、1件に集約）。
  //
  // 【監査指摘G・修正】以前は「基盤スコアが55超」だけで発火していたため、
  // 機能OFF・ウェイト中立（salesBase=0）で営業基盤が成約に一切影響しない状況でも
  // 「優位が反映された」と記録され、診断が事実と食い違っていた。
  // エンジンが当期に実際に使うウェイト（salesBaseCompetitivenessWeight）が
  // 正のときだけ発火させる。
  const salesBaseWeightInEffect = observation.salesBaseCompetitivenessWeight ?? 0;
  if (observation.salesBaseByMarketProduct && salesBaseWeightInEffect > 0) {
    const advantaged = plans.filter((p) => {
      const s = observation.salesBaseByMarketProduct?.[p.market]?.[p.product];
      return s !== undefined && (s as unknown as number) > 55;
    });
    if (advantaged.length > 0) {
      const top = advantaged.reduce((a, b) =>
        ((observation.salesBaseByMarketProduct?.[a.market]?.[a.product] as unknown as number) ?? 0) >=
        ((observation.salesBaseByMarketProduct?.[b.market]?.[b.product] as unknown as number) ?? 0)
          ? a
          : b
      );
      diagnostics.push({
        code: "SALES_BASE_ADVANTAGE",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          advantagedPlanCount: advantaged.length,
          topSalesBaseScore: (observation.salesBaseByMarketProduct?.[top.market]?.[top.product] as unknown as number) ?? 0,
          salesBaseCompetitivenessWeight: salesBaseWeightInEffect,
        },
        decisionSummary: `${top.market}×${top.product.toUpperCase()}等${advantaged.length}件で営業基盤の優位あり`,
        message: `蓄積した営業基盤（中立値超）を持つ市場×商品へ販売計画を提出した。営業基盤は当期の成約競争力にウェイト${salesBaseWeightInEffect}で加算される（allocation.tsの第6項）。`,
      });
    }
  }
  // 【SAI-6.2新設】realisticSalesByProduct = 確定したsalesPlans（営業人員配分・
  // 市場工数制約適用後）の商品別合計。新しい計算は行わず、既存のplansをそのまま
  // 合計するだけ（desiredByProductとは異なる値であることをここで明示する）。
  const realisticSalesByProduct: ProductAmount = zeroProductAmount();
  for (const p of plans) {
    realisticSalesByProduct[p.product] += unwrapUnit(p.desiredQuantity);
  }

  return { salesPlans: plans, desiredByProduct, realisticSalesByProduct, salesWishByMarketProduct, diagnostics };
}
