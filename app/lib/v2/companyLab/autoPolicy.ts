// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2、Phase 6.3で経済尺度を是正） 暫定自動方針
//
// 【重要】ここで生成する意思決定は Phase 9 で実装予定のAI会社ロジックではない。
// 統合テスト環境が5社を自動で動かせるようにするための、交換可能な決定論的
// ルールベース決定生成器である（CompanyDecisionProvider型を満たす別実装へ
// いつでも差し替えられる設計。types.ts参照）。
//
// 自動方針は「公開情報」（前四半期の実際の市場結果 PublicMarketInfo.lastMarketResult）
// と「自社状態」（CompanyOwnState。自社の契約・原料在庫・完成品在庫・前期操業負荷指標
// のみ）だけを参照する。未来のシナリオ・他社の非公開計画は一切参照しない
// （関数シグネチャ上、そもそも受け取れない）。乱数は一切使わない（完全に決定論的）。
//
// 【Phase 6.3の主な変更（実装指示 §6・§7・§9）】
//   1. PD/VAPの受注判断: 市場プレミアム（前期公開情報）と会社×商品の
//      目標/最低受注プレミアム（premiumPolicy.ts）を比較し、最低受注水準未満では
//      販売提案を出さない。目標未満・最低以上では縮小受注。
//   2. 生産希望量を「販売希望＋約定残−完成品在庫」に連動させ、受注を止めた
//      商品は生産も止まる（供給過剰時に価格ではなく稼働率が低下する構造）。
//   3. 調達構成: 国内買付・輸入・自社養殖の目標構成比（アーキタイプ別）で
//      調達計画を立て、自社養殖だけで完全自給しない。原料在庫は次期生産必要量の
//      0.25〜1.0四半期分を目標とし、在庫の無制限な積み上げ・国内買付需要の
//      早期消滅（Phase 6.2診断の問題）を防ぐ。
//   4. 契約時予想原価（costExpectation）を販売計画へ添付し、成約契約に
//      スナップショットとして保持させる。
//   5. 調達処理能力の工場能力連動方式（factoryCommonProcessingCapacityTons）へ対応。

import { hosoEqTons, ratio, unwrapUnit } from "../core/units";
import { PeriodV2 } from "../core/period";
import { CountryId, DemandMarketId, MarketQuarterResult, Product } from "../market/types";
import { deriveMarketReferencePrices } from "../market/destinationPricing";
import { CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS } from "../market/destinationPricingParameters";
import { CompanySalesPlanEntry, PlanCostExpectation } from "../sales/types";
import { AquacultureStockingPlanEntry, DomesticPurchasePlanEntry, ImportOrderInput } from "../rawMaterials/types";
import { CompanyProductionPlanEntry, WorkerAssignment } from "../production/types";
import { unwrapUsd } from "../finance/types";
import { FinancingRequestInput } from "../financing/types";
import { CapexDecisionInput } from "../capex/types";
import { orderQuantityFactor } from "./premiumPolicy";
import { AUTO_FINANCING_POLICY_PARAMETERS_V1 } from "./parameters";
import { CompanyDecisionInput, CompanyFixture, CompanyOwnState, PublicMarketInfo } from "./types";

const EPSILON = 1e-6;

/**
 * 前期実績が未知（turn 1等）の場合に使う国内原料価格の想定値（USD/HOSO換算kg）。
 * 農家留保価格（2.25）と通常需給価格帯（2.4〜3.0）の間の暫定値（要校正）。
 */
const DEFAULT_EXPECTED_RAW_PRICE_USD_PER_KG = 2.5;

/** 養殖の期待収穫比率（池入れ量→収穫量の目安。生残率等を織り込んだ暫定値・要校正）。 */
const EXPECTED_AQUACULTURE_HARVEST_RATIO = 0.9;

/** 在庫補正の減衰係数（目標在庫との乖離のうち1四半期で埋めにいく比率）。 */
const INVENTORY_CORRECTION_DAMPING = 0.5;

/** 国内買付需要の下限（構成比ベース需要に対する比率。需要が一斉にゼロへ落ちるのを防ぐ）。 */
const MIN_DOMESTIC_PURCHASE_RATIO_OF_MIX = 0.2;

interface ArchetypeProfile {
  /** 商品別の生産目標比率（工場の商品別能力に対する目標稼働比率、0〜1）。 */
  readonly productionTargetRatio: Readonly<Record<Product, number>>;
  /** 商品別の生産優先順位（小さいほど優先）。 */
  readonly productionPriority: Readonly<Record<Product, number>>;
  /** 販売価格調整（基準価格に対する比率。値引きは負）。商品別。 */
  readonly priceAdjustment: Readonly<Record<Product, number>>;
  /** 優先する需要市場（先頭ほど優先、希望量の配分比重を大きくする）。 */
  readonly preferredMarkets: readonly DemandMarketId[];
  /** 国内買付の提示価格調整（基準価格に対する比率。値引きは負、強気買付は正）。 */
  readonly domesticBidAdjustment: number;
  /**
   * 【Phase 6.3（実装指示 §7）】原料調達の目標構成比（国内買付・輸入・自社養殖。
   * 合計はおおむね1.0）。自社養殖だけで完全自給せず、国内買付需要が数ターンで
   * 一斉にゼロにならないようにする。
   */
  readonly sourcingMix: { readonly domestic: number; readonly import: number; readonly aquaculture: number };
  /**
   * 【Phase 6.3（実装指示 §7）】期末原料在庫の目標（次期生産必要量に対する
   * 四半期数、0.25〜1.0）。在庫が無制限に積み上がらない自動方針の基準。
   */
  readonly rawInventoryTargetQuarters: number;
  /** 養殖強度（0〜1）。高いほど収穫量期待値が増えるが疾病脆弱性も増す。 */
  readonly aquacultureIntensity: number;
  /** バイオセキュリティ水準（0〜1）。 */
  readonly bioSecurityLevel: number;
  /** 総合的な受注・調達の抑制係数（0〜1程度。1が標準、小さいほど保守的）。 */
  readonly commitmentRestraint: number;
  /** 残業・臨時ワーカーへの依存度（0〜1）。 */
  readonly flexLaborReliance: number;
}

const ARCHETYPE_PROFILES: Readonly<Record<CompanyFixture["archetype"], ArchetypeProfile>> = {
  balanced: {
    productionTargetRatio: { hoso: 0.8, pd: 0.8, vap: 0.75 },
    productionPriority: { hoso: 1, pd: 2, vap: 3 },
    priceAdjustment: { hoso: 0, pd: 0, vap: 0 },
    preferredMarkets: ["CN", "US", "EU"],
    domesticBidAdjustment: 0,
    sourcingMix: { domestic: 0.6, import: 0.15, aquaculture: 0.25 },
    rawInventoryTargetQuarters: 0.5,
    aquacultureIntensity: 0.6,
    bioSecurityLevel: 0.6,
    commitmentRestraint: 1,
    flexLaborReliance: 0.3,
  },
  massMarket: {
    productionTargetRatio: { hoso: 0.95, pd: 0.6, vap: 0.4 },
    productionPriority: { hoso: 1, pd: 2, vap: 3 },
    priceAdjustment: { hoso: -0.15, pd: -0.1, vap: -0.05 },
    preferredMarkets: ["CN", "OTHER"],
    domesticBidAdjustment: 0.05,
    sourcingMix: { domestic: 0.75, import: 0.15, aquaculture: 0.1 },
    rawInventoryTargetQuarters: 0.35,
    aquacultureIntensity: 0.75,
    bioSecurityLevel: 0.45,
    commitmentRestraint: 1.1,
    flexLaborReliance: 0.6,
  },
  japanQuality: {
    productionTargetRatio: { hoso: 0.5, pd: 0.9, vap: 0.7 },
    productionPriority: { hoso: 3, pd: 1, vap: 2 },
    priceAdjustment: { hoso: 0.05, pd: 0.2, vap: 0.15 },
    preferredMarkets: ["JP", "EU"],
    domesticBidAdjustment: 0.1,
    sourcingMix: { domestic: 0.6, import: 0.1, aquaculture: 0.3 },
    rawInventoryTargetQuarters: 0.5,
    aquacultureIntensity: 0.45,
    bioSecurityLevel: 0.8,
    commitmentRestraint: 0.95,
    flexLaborReliance: 0.2,
  },
  vapSpecialist: {
    productionTargetRatio: { hoso: 0.4, pd: 0.6, vap: 0.9 },
    productionPriority: { hoso: 3, pd: 2, vap: 1 },
    priceAdjustment: { hoso: 0, pd: 0.05, vap: 0.1 },
    preferredMarkets: ["US", "EU"],
    domesticBidAdjustment: 0.05,
    sourcingMix: { domestic: 0.5, import: 0.25, aquaculture: 0.25 },
    rawInventoryTargetQuarters: 0.5,
    aquacultureIntensity: 0.55,
    bioSecurityLevel: 0.65,
    commitmentRestraint: 1,
    flexLaborReliance: 0.4,
  },
  conservative: {
    productionTargetRatio: { hoso: 0.55, pd: 0.5, vap: 0.45 },
    productionPriority: { hoso: 1, pd: 2, vap: 3 },
    priceAdjustment: { hoso: 0, pd: 0, vap: 0 },
    preferredMarkets: ["CN", "EU"],
    domesticBidAdjustment: -0.05,
    sourcingMix: { domestic: 0.7, import: 0.1, aquaculture: 0.2 },
    rawInventoryTargetQuarters: 0.3,
    aquacultureIntensity: 0.4,
    bioSecurityLevel: 0.85,
    commitmentRestraint: 0.65,
    flexLaborReliance: 0.05,
  },
};

function availableRawMaterialQuantity(ownState: CompanyOwnState): number {
  return ownState.rawMaterialLots.filter((l) => l.status === "available").reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

/** 輸送中の輸入・養殖中など、将来利用可能になる予定の原料パイプライン量。 */
function pipelineRawMaterialQuantity(ownState: CompanyOwnState): number {
  return ownState.rawMaterialLots
    .filter((l) => l.status === "inTransitImport" || l.status === "growingAquaculture")
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

function outstandingContractQuantity(ownState: CompanyOwnState): number {
  return ownState.contracts
    .filter((c) => c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue")
    .reduce((sum, c) => sum + unwrapUnit(c.outstandingQuantity), 0);
}

function outstandingContractQuantityByProduct(ownState: CompanyOwnState): Record<Product, number> {
  const result: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const c of ownState.contracts) {
    if (c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue") {
      result[c.product] += unwrapUnit(c.outstandingQuantity);
    }
  }
  return result;
}

function finishedGoodsByProduct(ownState: CompanyOwnState): Record<Product, number> {
  const result: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const l of ownState.finishedGoodsLots) {
    if (l.status === "available") result[l.product] += unwrapUnit(l.remainingQuantity);
  }
  return result;
}

/** 会社の工場商品別能力の合計。 */
function totalProductCapacity(fixture: CompanyFixture): Record<Product, number> {
  const result: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const f of fixture.factories) {
    result.hoso += unwrapUnit(f.hosoCapacity);
    result.pd += unwrapUnit(f.pdCapacity);
    result.vap += unwrapUnit(f.vapCapacity);
  }
  return result;
}

/** 会社の工場共通原料処理能力の合計（調達処理能力の工場能力連動方式に使う）。 */
function totalCommonProcessingCapacity(fixture: CompanyFixture): number {
  return fixture.factories.reduce((sum, f) => sum + unwrapUnit(f.commonProcessingCapacity), 0);
}

/**
 * priceAdjustment系のarchetype係数は「基準価格に対する比率」（例: -0.15 = 基準価格の15%値引き）
 * として扱う。絶対USD額の固定調整にすると、シナリオによっては基準価格自体が
 * 大きく変動（暴落）した際に、許容価格帯（Phase4/Phase5のmin/maxAskPriceRatioOfBase・
 * min/maxBidPriceRatioOfMarket）を外れて例外になる（固定USD調整は価格が下がるほど
 * 相対的に効きすぎるため）。比率で持てば、基準価格が動いても常に妥当な相対調整に
 * 収まる。referencePriceが未知（ターン1で前期実績が無い等）の場合は調整0（基準価格
 * どおり）とする。
 */
function ratioAdjustmentToUsd(ratioAdjustment: number, referencePrice: number | undefined): number {
  if (referencePrice === undefined || referencePrice <= EPSILON) return 0;
  // Phase4/Phase5のmin/maxAskPriceRatioOfBase・min/maxBidPriceRatioOfMarketは[0.5, 2.0]。
  // 前期価格を参照する都合上の1四半期分のラグを考慮し、安全側に[-0.3, +0.3]へ収める。
  const clampedRatio = Math.max(-0.3, Math.min(0.3, ratioAdjustment));
  return clampedRatio * referencePrice;
}

/**
 * 【Phase 8P-0A】前期公開情報から、商品×仕向市場ごとの参照価格（USD/HOSO換算kg）を
 * 取り出す。未知（turn1等でlastMarketResultが無い場合）ならundefined。
 * market/destinationPricing.ts の価格分解・係数適用をそのまま呼び出すだけで、
 * 新しい価格形成ロジックはここには実装しない。CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
 * （現行運用中の係数セット）をそのまま使う。将来、会社ごとに異なる係数を試したい
 * 場合の拡張点として、直接importせず関数化してある。
 */
function referencePricesByMarketProduct(
  lastMarketResult: MarketQuarterResult | undefined
): Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>> | undefined {
  if (!lastMarketResult) return undefined;
  const breakdown = deriveMarketReferencePrices(lastMarketResult, CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS);
  const result = {} as Record<DemandMarketId, Record<Product, number>>;
  for (const market of Object.keys(breakdown) as DemandMarketId[]) {
    result[market] = {
      hoso: unwrapUnit(breakdown[market].hoso),
      pd: unwrapUnit(breakdown[market].pd),
      vap: unwrapUnit(breakdown[market].vap),
    };
  }
  return result;
}

/** 前期公開情報から商品別の市場プレミアム（VN、USD/HOSO換算kg）を取り出す。未知ならundefined。 */
function marketPremiumsFromPublicInfo(publicInfo: PublicMarketInfo): Record<"pd" | "vap", number | undefined> {
  const last = publicInfo.lastMarketResult;
  return {
    pd: last ? unwrapUnit(last.pdPremium.byCountry.VN.premium) : undefined,
    vap: last ? unwrapUnit(last.vapPremium.byCountry.VN.premium) : undefined,
  };
}

/** 商品別の受注量係数（PD/VAPは最低受注プレミアム判断、HOSOは基準商品として常に1）。 */
function orderFactorsByProduct(fixture: CompanyFixture, publicInfo: PublicMarketInfo): Record<Product, number> {
  const premiums = marketPremiumsFromPublicInfo(publicInfo);
  return {
    hoso: 1,
    pd: orderQuantityFactor(fixture.productEconomics.premiumEconomics.pd, premiums.pd),
    vap: orderQuantityFactor(fixture.productEconomics.premiumEconomics.vap, premiums.vap),
  };
}

/** 販売計画へ添付する契約時予想原価（実装指示 §9）。 */
function buildCostExpectation(
  fixture: CompanyFixture,
  product: Product,
  publicInfo: PublicMarketInfo
): PlanCostExpectation {
  const expectedRawPrice =
    publicInfo.vietnamDomesticPriorPrice > EPSILON ? publicInfo.vietnamDomesticPriorPrice : DEFAULT_EXPECTED_RAW_PRICE_USD_PER_KG;
  const expectedProcessingCost = fixture.productEconomics.expectedProcessingCostUsdPerHosoEqKg[product];

  // 最低受注価格: HOSO基準価格（前期実績）+ 最低受注プレミアム（PD/VAP）。
  // HOSO自体は基準商品のため、予想原料価格＋予想加工費を下限の目安とする。
  const lastHoso = publicInfo.lastMarketResult ? unwrapUnit(publicInfo.lastMarketResult.hosoPrices.VN.price) : undefined;
  let minimumAcceptablePrice: number;
  if (product === "hoso" || lastHoso === undefined) {
    minimumAcceptablePrice = expectedRawPrice + expectedProcessingCost;
  } else {
    const econ = fixture.productEconomics.premiumEconomics[product];
    const minPremium =
      econ.avoidableVariableProcessingCostUsdPerHosoEqKg +
      econ.incrementalSellingAndLogisticsCostUsdPerHosoEqKg +
      econ.minimumContributionMarginUsdPerHosoEqKg;
    minimumAcceptablePrice = lastHoso + minPremium;
  }

  return {
    expectedRawMaterialPriceUsdPerHosoEqKg: Math.round(expectedRawPrice * 10000) / 10000,
    expectedProcessingCostUsdPerHosoEqKg: Math.round(expectedProcessingCost * 10000) / 10000,
    minimumAcceptablePriceUsdPerHosoEqKg: Math.round(minimumAcceptablePrice * 10000) / 10000,
  };
}

/**
 * 【Phase 7A】ownState.qualityScoreByProduct/customerTrustByMarket/
 * deliveryReliabilityByMarketは、いずれも「前四半期末までの状態」
 * （companyLab/runner.tsのbuildCompanyOwnStateが、当期の意思決定を作る前の
 * stateから組み立てる）。今期の品質結果を今期の成約へ遡及適用しない、という
 * 実装指示をこの経路で自然に満たす。値が未接続（初期化直後等）の場合は
 * undefinedとなり、sales/allocation.tsのcomputeCompetitivenessWeightが
 * 中立値（neutralScore）にフォールバックする。
 */
function buildSalesPlans(
  fixture: CompanyFixture,
  profile: ArchetypeProfile,
  totalDesiredByProduct: Readonly<Record<Product, number>>,
  publicInfo: PublicMarketInfo,
  ownState: CompanyOwnState
): readonly CompanySalesPlanEntry[] {
  const plans: CompanySalesPlanEntry[] = [];
  const markets = profile.preferredMarkets;
  const headcountPerMarket = Math.max(1, Math.floor(fixture.salesForceHeadcountTotal / markets.length));
  const lastMarketResult = publicInfo.lastMarketResult;
  // 【Phase 8P-0A】商品×市場ごとの参照価格（前期実績、1四半期分のラグは既存設計を踏襲）。
  // これにより、市場係数導入後も各社の価格戦略（archetypeのpriceAdjustment比率）が
  // 「商品×市場参照価格に対して同じ相対的価格ポジションを取る」（実装指示 §17）。
  const referencePricesByMarket = referencePricesByMarketProduct(lastMarketResult);
  for (const product of ["hoso", "pd", "vap"] as const) {
    const totalDesired = totalDesiredByProduct[product];
    if (totalDesired <= EPSILON) continue;
    const costExpectation = buildCostExpectation(fixture, product, publicInfo);
    markets.forEach((market, idx) => {
      const weight = idx === 0 ? 0.5 : 0.5 / (markets.length - 1 || 1);
      const desiredQuantity = totalDesired * weight;
      if (desiredQuantity <= EPSILON) return;
      const referencePrice = referencePricesByMarket ? referencePricesByMarket[market][product] : undefined;
      plans.push({
        companyId: fixture.companyId,
        market,
        product,
        desiredQuantity: hosoEqTons(Math.round(desiredQuantity * 100) / 100),
        priceAdjustmentUsdPerHosoEqKg: ratioAdjustmentToUsd(profile.priceAdjustment[product], referencePrice),
        salesForceHeadcount: headcountPerMarket,
        costExpectation,
        qualityReputation: ownState.qualityScoreByProduct[product],
        customerRelationship: ownState.customerTrustByMarket[market],
        deliveryReliability: ownState.deliveryReliabilityByMarket[market],
      });
    });
  }
  return plans;
}

/**
 * 生産希望量（実装指示 §9）: 販売希望＋約定残−完成品在庫。受注を止めた商品
 * （販売希望0）は既存の約定残の履行に必要な分だけ生産し、それも無ければ生産0
 * → 稼働率が低下する（供給過剰時に価格ではなく稼働率で調整する構造）。
 */
function buildProductionPlans(
  fixture: CompanyFixture,
  profile: ArchetypeProfile,
  salesDesiredByProduct: Readonly<Record<Product, number>>,
  ownState: CompanyOwnState
): readonly CompanyProductionPlanEntry[] {
  const backlog = outstandingContractQuantityByProduct(ownState);
  const fg = finishedGoodsByProduct(ownState);
  const capacityTotals = totalProductCapacity(fixture);

  const neededByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const product of ["hoso", "pd", "vap"] as const) {
    neededByProduct[product] = Math.max(0, salesDesiredByProduct[product] + backlog[product] - fg[product]);
  }

  const plans: CompanyProductionPlanEntry[] = [];
  for (const f of fixture.factories) {
    const capacityByProduct: Readonly<Record<Product, number>> = {
      hoso: unwrapUnit(f.hosoCapacity),
      pd: unwrapUnit(f.pdCapacity),
      vap: unwrapUnit(f.vapCapacity),
    };
    for (const product of ["hoso", "pd", "vap"] as const) {
      const capacity = capacityByProduct[product];
      if (capacity <= EPSILON || neededByProduct[product] <= EPSILON) continue;
      // 複数工場の場合は商品別能力に比例して按分し、工場の商品別能力でキャップする。
      const share = capacityTotals[product] > EPSILON ? capacity / capacityTotals[product] : 0;
      const desired = Math.min(capacity, neededByProduct[product] * share);
      if (desired <= EPSILON) continue;
      plans.push({
        companyId: fixture.companyId,
        factoryId: f.factoryId,
        product,
        desiredQuantity: hosoEqTons(Math.round(desired * 100) / 100),
        priority: profile.productionPriority[product],
      });
    }
  }
  return plans;
}

function buildWorkerAssignments(fixture: CompanyFixture, profile: ArchetypeProfile): readonly WorkerAssignment[] {
  return fixture.workerBaseline.map((base) => ({
    factoryId: base.factoryId,
    companyId: base.companyId,
    regularHeadcount: base.regularHeadcount,
    temporaryHeadcount: Math.round(base.regularHeadcount * profile.flexLaborReliance * 0.3),
    skills: base.skills,
    overtimeRate: ratio(Math.min(0.3, profile.flexLaborReliance * 0.3)),
    attendanceRate: base.attendanceRate,
  }));
}

/**
 * 国内買付計画（実装指示 §7）: 構成比ベースの基礎需要＋在庫補正。
 *   基礎需要 = sourcingMix.domestic × 必要原料量
 *   在庫補正 = 減衰係数 × (目標在庫 − 現在庫 − パイプライン超過分)
 * 需要の下限（基礎需要×0.2）を設け、在庫が一時的に積み上がっても国内買付が
 * 一斉にゼロへ落ちない（買付先との関係維持という実務的理由の簡易表現）。
 */
function buildDomesticPurchasePlan(
  fixture: CompanyFixture,
  profile: ArchetypeProfile,
  requiredRawMaterial: number,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo
): DomesticPurchasePlanEntry {
  const mixBase = profile.sourcingMix.domestic * requiredRawMaterial;
  const targetInventory = profile.rawInventoryTargetQuarters * requiredRawMaterial;
  const available = availableRawMaterialQuantity(ownState);
  const pipeline = pipelineRawMaterialQuantity(ownState);
  // パイプラインは半分だけ在庫相当としてカウント（到着ラグ・収穫不確実性の簡易表現）。
  const inventoryPosition = available + pipeline * 0.5;
  const correction = INVENTORY_CORRECTION_DAMPING * (targetInventory - inventoryPosition);
  const floor = MIN_DOMESTIC_PURCHASE_RATIO_OF_MIX * mixBase;
  const cap = mixBase * 2 + targetInventory; // 極端なスパイク防止（暫定値）
  const desired = Math.min(cap, Math.max(floor, mixBase + correction));
  const referencePrice = publicInfo.vietnamDomesticPriorPrice > EPSILON ? publicInfo.vietnamDomesticPriorPrice : undefined;
  return {
    companyId: fixture.companyId,
    desiredQuantity: hosoEqTons(Math.round(Math.max(0, desired) * 100) / 100),
    priceAdjustmentUsdPerHosoEqKg: ratioAdjustmentToUsd(profile.domesticBidAdjustment, referencePrice),
    procurementHeadcount: fixture.procurementHeadcountTotal,
    // 【Phase 6.3（実装指示 §6）】調達処理能力の工場能力連動方式。
    factoryCommonProcessingCapacityTons: totalCommonProcessingCapacity(fixture),
  };
}

/** 輸入計画（実装指示 §7）: 構成比ベースの定常フロー（リードタイム2ターンの到着遅れ前提）。 */
function buildImportOrders(
  fixture: CompanyFixture,
  profile: ArchetypeProfile,
  requiredRawMaterial: number,
  period: PeriodV2
): readonly ImportOrderInput[] {
  const quantity = profile.sourcingMix.import * requiredRawMaterial;
  if (quantity <= EPSILON) return [];
  const originCountry: CountryId = fixture.archetype === "japanQuality" ? "IN" : "ID";
  return [
    {
      companyId: fixture.companyId,
      originCountry,
      orderedQuantity: hosoEqTons(Math.round(quantity * 100) / 100),
      orderedPeriod: period,
    },
  ];
}

/**
 * 養殖池入れ計画（実装指示 §7）: 構成比ベースの目標収穫量から逆算した池入れ量。
 * 旧実装（能力×0.85の固定池入れ）は自社養殖だけで数ターン後に完全自給できて
 * しまい、国内買付需要が消滅する原因だった（Phase 6.2診断）。
 */
function buildAquacultureStockingPlans(
  fixture: CompanyFixture,
  profile: ArchetypeProfile,
  requiredRawMaterial: number,
  period: PeriodV2
): readonly AquacultureStockingPlanEntry[] {
  const capacity = unwrapUnit(fixture.aquacultureCapacity);
  if (capacity <= EPSILON) return [];
  const targetHarvest = profile.sourcingMix.aquaculture * requiredRawMaterial;
  const stocking = Math.min(capacity, targetHarvest / EXPECTED_AQUACULTURE_HARVEST_RATIO);
  if (stocking <= EPSILON) return [];
  return [
    {
      companyId: fixture.companyId,
      aquacultureCapacity: fixture.aquacultureCapacity,
      plannedStockingQuantity: hosoEqTons(Math.round(stocking * 100) / 100),
      aquacultureIntensity: ratio(profile.aquacultureIntensity),
      bioSecurityLevel: ratio(profile.bioSecurityLevel),
      stockingPeriod: period,
    },
  ];
}

/**
 * 【Phase 8B-1（実装指示 §5.6）】5社自動方針への「単純な資金調達方針」。
 *   - 現金が最低目標（targetMinimumCashUsd）を下回れば、その差額を通常融資として申請する。
 *   - 現金が十分（voluntaryPrepaymentThresholdCashUsd超）で既存借入があれば、
 *     超過分を任意期限前返済として申請する（applyWaterfallAcrossPortfolioが
 *     高金利融資から優先的に返済するため、ここでは「返済したい総額」だけを渡せばよい）。
 *   - 通常融資が利用可能なら緊急融資を選ばないという方針だが、通常融資が不足した
 *     場合の最後の手段としては受け入れる（emergencyAcceptable=true固定）。
 *   - 当期開始時点の情報（ownState.financeState・ownState.financingState、いずれも
 *     前期末までの状態）だけを参照する。当期の市場・生産実績は一切参照しない
 *     （関数シグネチャ上、そもそも受け取れない）。
 */
function buildFinancingRequest(ownState: CompanyOwnState): FinancingRequestInput {
  const params = AUTO_FINANCING_POLICY_PARAMETERS_V1;
  const cashUsd = unwrapUsd(ownState.financeState.cash);
  const existingLoanBalanceUsd = ownState.financingState.loanPortfolio.loans.reduce((s, l) => s + l.currentPrincipalUsd, 0);

  const desiredAmountUsd = cashUsd < params.targetMinimumCashUsd ? params.targetMinimumCashUsd - cashUsd : 0;
  const desiredPrepaymentUsd =
    cashUsd > params.voluntaryPrepaymentThresholdCashUsd && existingLoanBalanceUsd > 0
      ? Math.min(cashUsd - params.voluntaryPrepaymentThresholdCashUsd, existingLoanBalanceUsd)
      : 0;

  return {
    desiredAmountUsd,
    desiredLoanType: "workingCapital",
    desiredTermQuarters: params.desiredTermQuarters,
    desiredRepaymentMethod: "bulletAtMaturity",
    desiredPrepaymentUsd,
    emergencyAcceptable: params.emergencyAcceptable,
  };
}

/**
 * 【Phase 8B-2A（実装指示§11）】5社自動方針は新規設備投資案件を一切提案しない
 * （常に空。統合テスト・意思決定編集からの明示的な上書きのみが提案を行う）。
 * 特定会社IDへのハードコードではなく、「自動方針は常にこれを返す」という
 * 会社ID非依存の一様な規則である。
 */
function buildCapexDecision(companyId: CompanyOwnState["companyId"]): CapexDecisionInput {
  return {
    companyId,
    newProjectProposals: [],
    cancelRequests: [],
    resumeRequests: [],
  };
}

/**
 * 交換可能な決定論的ルールベース自動方針（CompanyDecisionProvider型）。
 * 公開情報（publicInfo）と自社状態（ownState）だけを使い、未来のシナリオ・他社の
 * 非公開計画は一切参照しない（関数シグネチャ上、受け取ることもできない）。
 */
export function generateAutoPolicyDecision(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  _turn: number
): CompanyDecisionInput {
  void _turn; // 将来ターン依存のルールを追加する余地を残すためシグネチャに保持するが、現状は未使用。
  const profile = ARCHETYPE_PROFILES[fixture.archetype];
  const capacityTotals = totalProductCapacity(fixture);

  // --- 1. 商品別の潜在販売希望量（能力×目標比率×抑制係数） ---
  const potentialByProduct: Record<Product, number> = {
    hoso: capacityTotals.hoso * profile.productionTargetRatio.hoso * profile.commitmentRestraint,
    pd: capacityTotals.pd * profile.productionTargetRatio.pd * profile.commitmentRestraint,
    vap: capacityTotals.vap * profile.productionTargetRatio.vap * profile.commitmentRestraint,
  };

  // --- 2. PD/VAPの受注判断（実装指示 §9）: 最低受注プレミアム未満では販売提案を出さない ---
  const orderFactors = orderFactorsByProduct(fixture, publicInfo);

  // --- 3. 保守的会社の約定残による抑制（Phase 6.2から継続） ---
  const totalQuarterlyProductionScale = potentialByProduct.hoso + potentialByProduct.pd + potentialByProduct.vap;
  const backlogThreshold = Math.max(EPSILON, totalQuarterlyProductionScale * 2);
  const outstanding = outstandingContractQuantity(ownState);
  const restraintFromBacklog = fixture.archetype === "conservative" && outstanding > 0 ? Math.max(0.4, 1 - outstanding / backlogThreshold) : 1;

  const salesDesiredByProduct: Record<Product, number> = {
    hoso: potentialByProduct.hoso * orderFactors.hoso * restraintFromBacklog,
    pd: potentialByProduct.pd * orderFactors.pd * restraintFromBacklog,
    vap: potentialByProduct.vap * orderFactors.vap * restraintFromBacklog,
  };

  // --- 4. 販売計画（契約時予想原価つき）と生産計画（販売＋約定残−完成品在庫連動） ---
  const salesPlans = buildSalesPlans(fixture, profile, salesDesiredByProduct, publicInfo, ownState);
  const productionPlans = buildProductionPlans(fixture, profile, salesDesiredByProduct, ownState);

  // --- 5. 必要原料量（saleableRecoveryRatio=1.00基準。正常な加工はHOSO換算量を減らさない） ---
  const requiredRawMaterial = productionPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);

  // --- 6. 調達（国内買付・輸入・養殖の構成比ベース） ---
  const domesticPurchasePlan = buildDomesticPurchasePlan(fixture, profile, requiredRawMaterial, ownState, publicInfo);
  const importOrders = buildImportOrders(fixture, profile, requiredRawMaterial, period);
  const aquacultureStockingPlans = buildAquacultureStockingPlans(fixture, profile, requiredRawMaterial, period);
  const workerAssignments = buildWorkerAssignments(fixture, profile);
  const financingRequest = buildFinancingRequest(ownState);
  const capexDecision = buildCapexDecision(fixture.companyId);

  return {
    companyId: fixture.companyId,
    salesPlans,
    domesticPurchasePlan,
    importOrders,
    aquacultureStockingPlans,
    productionPlans,
    workerAssignments,
    financingRequest,
    capexDecision,
  };
}
