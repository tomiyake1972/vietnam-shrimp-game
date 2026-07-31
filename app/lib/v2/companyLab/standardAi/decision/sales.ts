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

import { hosoEqTons } from "../../../core/units";
import { DemandMarketId, Product } from "../../../market/types";
import { CompanySalesPlanEntry, PlanCostExpectation } from "../../../sales/types";
import { SalesParameters, SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { allocateHeadcountAcrossMarkets, computeMarketSalesEffort, salesEffortWeightedQuantity } from "../../../sales/marketEffort";
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
  readonly desiredByProduct: ProductAmount;
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
  salesParams: SalesParameters = SALES_PARAMETERS_V1
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

  const potentialByProduct: ProductAmount = {
    hoso: capacityTotals.hoso * params.salesUtilizationTarget,
    pd: capacityTotals.pd * params.salesUtilizationTarget,
    vap: capacityTotals.vap * params.salesUtilizationTarget,
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

  const markets = pressures.marketPriceRanking as readonly DemandMarketId[];

  // --- 【SAI-2追加作業: 市場別営業配置・商品別営業工数】市場×商品の希望販売量を、
  // 従来と同じ「上位市場50%・残りを均等割り」の重みでまず商品別に按分する
  // （この按分ロジック自体は変更しない）。営業人員は行ごとではなく、この市場別
  // 希望量から導かれる「営業工数換算需要」に応じて市場単位で配分する。
  const desiredByMarketProduct = new Map<DemandMarketId, Record<Product, number>>();
  for (const market of markets) {
    desiredByMarketProduct.set(market, { hoso: 0, pd: 0, vap: 0 });
  }
  for (const product of ["hoso", "pd", "vap"] as const) {
    const totalDesired = plannedSalesQuantityByProduct[product];
    if (totalDesired <= EPSILON) continue;
    if (!orientationActive) {
      markets.forEach((market, idx) => {
        const weight = idx === 0 ? 0.5 : 0.5 / (markets.length - 1 || 1);
        const desiredQuantity = totalDesired * weight;
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
    const baseWeights = markets.map((_, idx) => (idx === 0 ? 0.5 : 0.5 / (markets.length - 1 || 1)));
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
  const headcountByMarket = allocateHeadcountAcrossMarkets(fixture.salesForceHeadcountTotal, effortDemandByMarket);

  // 配分された人数では当該市場の営業工数換算需要を賄いきれない場合、標準AIが
  // 自ら（エンジン側のsales/marketEffort.tsと全く同じ計算式で）市場内の全商品の
  // 希望数量を比例縮小する。これにより、AIが提出する意思決定の時点で既に
  // エンジン適用後と同じ制約を満たしており、「意思決定の説明」と「制約適用後の
  // 実際の結果」が食い違わない。
  const constrainedMarkets: { market: DemandMarketId; headcount: number; result: ReturnType<typeof computeMarketSalesEffort> }[] = [];
  const adjustedByMarketProduct = new Map<DemandMarketId, Record<Product, number>>();
  for (const market of marketsWithDemand) {
    const headcount = headcountByMarket.get(market) ?? 0;
    const result = computeMarketSalesEffort(headcount, desiredByMarketProduct.get(market)!, salesParams);
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
        keyValues: { salesForceHeadcountTotal: fixture.salesForceHeadcountTotal, constrainedMarketCount: constrainedMarkets.length },
        message: `実在する営業人員総数（${fixture.salesForceHeadcountTotal}人）では、全${marketsWithDemand.length}市場の希望販売量（商品別営業工数を加味）を賄いきれず、すべての市場で販売計画を縮小した。`,
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
  if (observation.salesBaseByMarketProduct) {
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
        },
        decisionSummary: `${top.market}×${top.product.toUpperCase()}等${advantaged.length}件で営業基盤の優位あり`,
        message: "蓄積した営業基盤（中立値超）を持つ市場×商品へ販売計画を提出した（成約競争力の第6項として反映される）。",
      });
    }
  }
  return { salesPlans: plans, desiredByProduct, salesWishByMarketProduct, diagnostics };
}
