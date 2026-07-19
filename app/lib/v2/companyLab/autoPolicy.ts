// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 暫定自動方針
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

import { hosoEqTons, ratio, unwrapUnit } from "../core/units";
import { PeriodV2 } from "../core/period";
import { CountryId, DemandMarketId, Product } from "../market/types";
import { CompanySalesPlanEntry } from "../sales/types";
import { AquacultureStockingPlanEntry, DomesticPurchasePlanEntry, ImportOrderInput } from "../rawMaterials/types";
import { CompanyProductionPlanEntry, WorkerAssignment } from "../production/types";
import { CompanyDecisionInput, CompanyFixture, CompanyOwnState, PublicMarketInfo } from "./types";

const EPSILON = 1e-6;

interface ArchetypeProfile {
  /** 商品別の生産目標比率（工場の商品別能力に対する目標稼働比率、0〜1）。 */
  readonly productionTargetRatio: Readonly<Record<Product, number>>;
  /** 商品別の生産優先順位（小さいほど優先）。 */
  readonly productionPriority: Readonly<Record<Product, number>>;
  /** 販売価格調整（USD/HOSO換算kg。値引きは負）。商品別。 */
  readonly priceAdjustment: Readonly<Record<Product, number>>;
  /** 優先する需要市場（先頭ほど優先、希望量の配分比重を大きくする）。 */
  readonly preferredMarkets: readonly DemandMarketId[];
  /** 国内買付の提示価格調整（値引きは負、強気買付は正）。 */
  readonly domesticBidAdjustment: number;
  /** 輸入への依存度（0〜1。0なら輸入しない）。 */
  readonly importReliance: number;
  /** 養殖強度（0〜1）。高いほど収穫量期待値が増えるが疾病脆弱性も増す。 */
  readonly aquacultureIntensity: number;
  /** バイオセキュリティ水準（0〜1）。 */
  readonly bioSecurityLevel: number;
  /** 総合的な受注・調達の抑制係数（0〜1。1が標準、小さいほど保守的）。 */
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
    importReliance: 0.2,
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
    importReliance: 0.35,
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
    importReliance: 0.1,
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
    importReliance: 0.25,
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
    importReliance: 0.05,
    aquacultureIntensity: 0.4,
    bioSecurityLevel: 0.85,
    commitmentRestraint: 0.65,
    flexLaborReliance: 0.05,
  },
};

function availableRawMaterialQuantity(ownState: CompanyOwnState): number {
  return ownState.rawMaterialLots.filter((l) => l.status === "available").reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

function outstandingContractQuantity(ownState: CompanyOwnState): number {
  return ownState.contracts
    .filter((c) => c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue")
    .reduce((sum, c) => sum + unwrapUnit(c.outstandingQuantity), 0);
}

function buildProductionPlans(fixture: CompanyFixture, profile: ArchetypeProfile): readonly CompanyProductionPlanEntry[] {
  const plans: CompanyProductionPlanEntry[] = [];
  for (const f of fixture.factories) {
    const capacityByProduct: Readonly<Record<Product, number>> = {
      hoso: unwrapUnit(f.hosoCapacity),
      pd: unwrapUnit(f.pdCapacity),
      vap: unwrapUnit(f.vapCapacity),
    };
    for (const product of ["hoso", "pd", "vap"] as const) {
      const capacity = capacityByProduct[product];
      if (capacity <= EPSILON) continue;
      const desired = capacity * profile.productionTargetRatio[product] * profile.commitmentRestraint;
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

function buildSalesPlans(
  fixture: CompanyFixture,
  profile: ArchetypeProfile,
  totalDesiredByProduct: Readonly<Record<Product, number>>,
  publicInfo: PublicMarketInfo
): readonly CompanySalesPlanEntry[] {
  const plans: CompanySalesPlanEntry[] = [];
  const markets = profile.preferredMarkets;
  const headcountPerMarket = Math.max(1, Math.floor(fixture.salesForceHeadcountTotal / markets.length));
  const lastMarketResult = publicInfo.lastMarketResult;
  const referencePriceByProduct: Readonly<Record<Product, number | undefined>> = {
    hoso: lastMarketResult ? unwrapUnit(lastMarketResult.hosoPrices.VN.price) : undefined,
    pd: lastMarketResult ? unwrapUnit(lastMarketResult.hosoPrices.VN.price) + unwrapUnit(lastMarketResult.pdPremium.byCountry.VN.premium) : undefined,
    vap: lastMarketResult ? unwrapUnit(lastMarketResult.hosoPrices.VN.price) + unwrapUnit(lastMarketResult.vapPremium.byCountry.VN.premium) : undefined,
  };
  for (const product of ["hoso", "pd", "vap"] as const) {
    const totalDesired = totalDesiredByProduct[product];
    if (totalDesired <= EPSILON) continue;
    markets.forEach((market, idx) => {
      const weight = idx === 0 ? 0.5 : 0.5 / (markets.length - 1 || 1);
      const desiredQuantity = totalDesired * weight;
      if (desiredQuantity <= EPSILON) return;
      plans.push({
        companyId: fixture.companyId,
        market,
        product,
        desiredQuantity: hosoEqTons(Math.round(desiredQuantity * 100) / 100),
        priceAdjustmentUsdPerHosoEqKg: ratioAdjustmentToUsd(profile.priceAdjustment[product], referencePriceByProduct[product]),
        salesForceHeadcount: headcountPerMarket,
      });
    });
  }
  return plans;
}

function buildDomesticPurchasePlan(
  fixture: CompanyFixture,
  profile: ArchetypeProfile,
  requiredRawMaterial: number,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo
): DomesticPurchasePlanEntry {
  const available = availableRawMaterialQuantity(ownState);
  const gap = Math.max(0, requiredRawMaterial * profile.commitmentRestraint - available);
  const referencePrice = publicInfo.vietnamDomesticPriorPrice > EPSILON ? publicInfo.vietnamDomesticPriorPrice : undefined;
  return {
    companyId: fixture.companyId,
    desiredQuantity: hosoEqTons(Math.round(gap * 100) / 100),
    priceAdjustmentUsdPerHosoEqKg: ratioAdjustmentToUsd(profile.domesticBidAdjustment, referencePrice),
    procurementHeadcount: fixture.procurementHeadcountTotal,
  };
}

function buildImportOrders(fixture: CompanyFixture, profile: ArchetypeProfile, requiredRawMaterial: number, period: PeriodV2, ownState: CompanyOwnState): readonly ImportOrderInput[] {
  if (profile.importReliance <= EPSILON) return [];
  const available = availableRawMaterialQuantity(ownState);
  const gap = Math.max(0, requiredRawMaterial - available);
  const quantity = gap * profile.importReliance;
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

function buildAquacultureStockingPlans(fixture: CompanyFixture, profile: ArchetypeProfile, period: PeriodV2): readonly AquacultureStockingPlanEntry[] {
  const capacity = unwrapUnit(fixture.aquacultureCapacity);
  if (capacity <= EPSILON) return [];
  return [
    {
      companyId: fixture.companyId,
      aquacultureCapacity: fixture.aquacultureCapacity,
      plannedStockingQuantity: hosoEqTons(Math.round(capacity * 0.85 * 100) / 100),
      aquacultureIntensity: ratio(profile.aquacultureIntensity),
      bioSecurityLevel: ratio(profile.bioSecurityLevel),
      stockingPeriod: period,
    },
  ];
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

  const productionPlans = buildProductionPlans(fixture, profile);
  const totalDesiredByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const p of productionPlans) {
    totalDesiredByProduct[p.product] += unwrapUnit(p.desiredQuantity);
  }
  const totalQuarterlyProductionScale = totalDesiredByProduct.hoso + totalDesiredByProduct.pd + totalDesiredByProduct.vap;

  // 保守的会社は「既存の未履行契約が多いほど新規販売希望量を絞る」ことで過剰契約を避ける
  // （財務三表が未実装のため、この抑制ロジックで保守的方針を表現する）。しきい値は
  // 会社自身の四半期生産規模（totalQuarterlyProductionScale）の2倍分の未履行契約を
  // 「過大」とみなす、規模非依存の相対しきい値とする（固定絶対量にすると会社規模や
  // フィクスチャのスケール変更のたびに調整が必要になるため）。
  const backlogThreshold = Math.max(EPSILON, totalQuarterlyProductionScale * 2);
  const outstanding = outstandingContractQuantity(ownState);
  const restraintFromBacklog = fixture.archetype === "conservative" && outstanding > 0 ? Math.max(0.4, 1 - outstanding / backlogThreshold) : 1;
  const salesTotalDesiredByProduct: Record<Product, number> = {
    hoso: totalDesiredByProduct.hoso * restraintFromBacklog,
    pd: totalDesiredByProduct.pd * restraintFromBacklog,
    vap: totalDesiredByProduct.vap * restraintFromBacklog,
  };

  const salesPlans = buildSalesPlans(fixture, profile, salesTotalDesiredByProduct, publicInfo);
  const requiredRawMaterial = productionPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0) * 1.1; // saleableRecoveryRatioの逆数目安（要校正、暫定+10%バッファ）
  const domesticPurchasePlan = buildDomesticPurchasePlan(fixture, profile, requiredRawMaterial, ownState, publicInfo);
  const importOrders = buildImportOrders(fixture, profile, requiredRawMaterial, period, ownState);
  const aquacultureStockingPlans = buildAquacultureStockingPlans(fixture, profile, period);
  const workerAssignments = buildWorkerAssignments(fixture, profile);

  return {
    companyId: fixture.companyId,
    salesPlans,
    domesticPurchasePlan,
    importOrders,
    aquacultureStockingPlans,
    productionPlans,
    workerAssignments,
  };
}
