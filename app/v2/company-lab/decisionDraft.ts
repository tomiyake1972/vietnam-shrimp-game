// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 意思決定編集用ドラフト型・変換
//
// 画面の入力欄はプレーンなnumber/stringしか扱えないため、branded number型
// （HosoEqTons・Ratio等）を直接編集させることはできない。本ファイルは
// 「編集可能なプレーン値の一覧（全市場×全商品などの網羅グリッド）」への変換と、
// 送信直前の CompanyDecisionInput（branded types）への再変換だけを行う、
// 計算ロジックを一切持たない型変換層である（generateAutoPolicyDecision・
// advanceCompanyLabQuarterの計算結果・入力契約はここでは一切変更しない）。

import { hosoEqTons, ratio, unwrapUnit } from "../../lib/v2/core/units";
import { PeriodV2 } from "../../lib/v2/core/period";
import { COUNTRY_IDS, CountryId, DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../lib/v2/market/types";
import { CompanyDecisionInput, CompanyFixture } from "../../lib/v2/companyLab";
import { WorkerSkillEntry } from "../../lib/v2/production/types";

export const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function safeNonNegative(n: number): number {
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function safeInRange01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------
// ドラフト型（プレーン値・網羅グリッド）
// ---------------------------------------------------------------------

export interface SalesPlanDraftRow {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly desiredQuantity: number;
  readonly priceAdjustmentUsdPerHosoEqKg: number;
  readonly salesForceHeadcount: number;
}

export interface DomesticPurchaseDraft {
  readonly desiredQuantity: number;
  readonly priceAdjustmentUsdPerHosoEqKg: number;
  readonly procurementHeadcount: number;
}

export interface ImportOrderDraftRow {
  readonly originCountry: CountryId;
  readonly orderedQuantity: number;
  readonly leadTimeTurns: number | undefined;
}

export interface AquacultureStockingDraft {
  readonly plannedStockingQuantity: number;
  readonly aquacultureIntensity: number;
  readonly bioSecurityLevel: number;
}

export interface ProductionPlanDraftRow {
  readonly factoryId: string;
  readonly product: Product;
  readonly desiredQuantity: number;
  readonly priority: number;
}

export interface WorkerAssignmentDraftRow {
  readonly factoryId: string;
  readonly regularHeadcount: number;
  readonly temporaryHeadcount: number;
  readonly overtimeRate: number;
  readonly skills: readonly WorkerSkillEntry[];
  readonly attendanceRate: number;
}

export interface CompanyDecisionDraft {
  readonly companyId: string;
  readonly salesPlans: readonly SalesPlanDraftRow[];
  readonly domesticPurchase: DomesticPurchaseDraft;
  readonly importOrders: readonly ImportOrderDraftRow[];
  readonly aquacultureStockingPlans: readonly AquacultureStockingDraft[];
  readonly productionPlans: readonly ProductionPlanDraftRow[];
  readonly workerAssignments: readonly WorkerAssignmentDraftRow[];
}

// ---------------------------------------------------------------------
// generateAutoPolicyDecision の結果 → 網羅グリッドドラフトへの変換
// ---------------------------------------------------------------------

/**
 * 自動方針の出力（CompanyDecisionInput）を、全市場×全商品・全工場×全商品などの
 * 網羅グリッドを持つ編集用ドラフトへ変換する。自動方針が生成しなかった組合せは
 * 数量0の行として補い、プレイヤーが新しい市場・商品組合せへも入力できるようにする。
 */
export function buildInitialDraft(fixture: CompanyFixture, autoDecision: CompanyDecisionInput): CompanyDecisionDraft {
  const salesPlans: SalesPlanDraftRow[] = DEMAND_MARKET_IDS.flatMap((market) =>
    PRODUCTS.map((product) => {
      const found = autoDecision.salesPlans.find((p) => p.market === market && p.product === product);
      return {
        market,
        product,
        desiredQuantity: found ? unwrapUnit(found.desiredQuantity) : 0,
        priceAdjustmentUsdPerHosoEqKg: found ? found.priceAdjustmentUsdPerHosoEqKg : 0,
        salesForceHeadcount: found ? found.salesForceHeadcount : 0,
      };
    })
  );

  const domesticPurchase: DomesticPurchaseDraft = {
    desiredQuantity: unwrapUnit(autoDecision.domesticPurchasePlan.desiredQuantity),
    priceAdjustmentUsdPerHosoEqKg: autoDecision.domesticPurchasePlan.priceAdjustmentUsdPerHosoEqKg,
    procurementHeadcount: autoDecision.domesticPurchasePlan.procurementHeadcount,
  };

  const importOrders: ImportOrderDraftRow[] = COUNTRY_IDS.map((originCountry) => {
    const found = autoDecision.importOrders.find((o) => o.originCountry === originCountry);
    return {
      originCountry,
      orderedQuantity: found ? unwrapUnit(found.orderedQuantity) : 0,
      leadTimeTurns: found?.leadTimeTurns,
    };
  });

  const firstAquaculture = autoDecision.aquacultureStockingPlans[0];
  const aquacultureStockingPlans: AquacultureStockingDraft[] =
    unwrapUnit(fixture.aquacultureCapacity) > 0
      ? [
          {
            plannedStockingQuantity: firstAquaculture ? unwrapUnit(firstAquaculture.plannedStockingQuantity) : 0,
            aquacultureIntensity: firstAquaculture ? unwrapUnit(firstAquaculture.aquacultureIntensity) : 0,
            bioSecurityLevel: firstAquaculture ? unwrapUnit(firstAquaculture.bioSecurityLevel) : 0,
          },
        ]
      : [];

  const productionPlans: ProductionPlanDraftRow[] = fixture.factories.flatMap((f) =>
    PRODUCTS.map((product) => {
      const found = autoDecision.productionPlans.find((p) => p.factoryId === f.factoryId && p.product === product);
      return {
        factoryId: f.factoryId,
        product,
        desiredQuantity: found ? unwrapUnit(found.desiredQuantity) : 0,
        priority: found ? found.priority : PRODUCTS.indexOf(product) + 1,
      };
    })
  );

  const workerAssignments: WorkerAssignmentDraftRow[] = fixture.workerBaseline.map((base) => {
    const found = autoDecision.workerAssignments.find((w) => w.factoryId === base.factoryId);
    return {
      factoryId: base.factoryId,
      regularHeadcount: found ? found.regularHeadcount : base.regularHeadcount,
      temporaryHeadcount: found ? found.temporaryHeadcount : 0,
      overtimeRate: found ? unwrapUnit(found.overtimeRate) : 0,
      skills: base.skills,
      attendanceRate: unwrapUnit(base.attendanceRate),
    };
  });

  return {
    companyId: fixture.companyId,
    salesPlans,
    domesticPurchase,
    importOrders,
    aquacultureStockingPlans,
    productionPlans,
    workerAssignments,
  };
}

// ---------------------------------------------------------------------
// ドラフト（プレーン値） → CompanyDecisionInput（branded types）
// ---------------------------------------------------------------------

/**
 * 編集用ドラフトを advanceCompanyLabQuarter へそのまま渡せる CompanyDecisionInput へ変換する。
 * 数量0以下の行は送信対象から除外する（自動方針のbuildSalesPlans等と同じ扱い）。
 * NaN・負値は安全側（0）へ丸め、hosoEqTons()/ratio() のスマートコンストラクタを
 * 必ず経由させることでブランド型の境界検証を通す。
 */
export function buildDecisionInputFromDraft(draft: CompanyDecisionDraft, fixture: CompanyFixture, period: PeriodV2): CompanyDecisionInput {
  const companyId = draft.companyId;

  const salesPlans = draft.salesPlans
    .filter((p) => safeNonNegative(p.desiredQuantity) > 0)
    .map((p) => ({
      companyId,
      market: p.market,
      product: p.product,
      desiredQuantity: hosoEqTons(safeNonNegative(p.desiredQuantity)),
      priceAdjustmentUsdPerHosoEqKg: Number.isFinite(p.priceAdjustmentUsdPerHosoEqKg) ? p.priceAdjustmentUsdPerHosoEqKg : 0,
      salesForceHeadcount: Math.round(safeNonNegative(p.salesForceHeadcount)),
    }));

  const domesticPurchasePlan = {
    companyId,
    desiredQuantity: hosoEqTons(safeNonNegative(draft.domesticPurchase.desiredQuantity)),
    priceAdjustmentUsdPerHosoEqKg: Number.isFinite(draft.domesticPurchase.priceAdjustmentUsdPerHosoEqKg)
      ? draft.domesticPurchase.priceAdjustmentUsdPerHosoEqKg
      : 0,
    procurementHeadcount: Math.round(safeNonNegative(draft.domesticPurchase.procurementHeadcount)),
  };

  const importOrders = draft.importOrders
    .filter((o) => safeNonNegative(o.orderedQuantity) > 0)
    .map((o) => ({
      companyId,
      originCountry: o.originCountry,
      orderedQuantity: hosoEqTons(safeNonNegative(o.orderedQuantity)),
      orderedPeriod: period,
      leadTimeTurns: o.leadTimeTurns !== undefined && Number.isFinite(o.leadTimeTurns) ? Math.max(1, Math.round(o.leadTimeTurns)) : undefined,
    }));

  const aquacultureStockingPlans = draft.aquacultureStockingPlans.map((a) => ({
    companyId,
    aquacultureCapacity: fixture.aquacultureCapacity,
    plannedStockingQuantity: hosoEqTons(safeNonNegative(a.plannedStockingQuantity)),
    aquacultureIntensity: ratio(safeInRange01(a.aquacultureIntensity)),
    bioSecurityLevel: ratio(safeInRange01(a.bioSecurityLevel)),
    stockingPeriod: period,
  }));

  const productionPlans = draft.productionPlans
    .filter((p) => safeNonNegative(p.desiredQuantity) > 0)
    .map((p) => ({
      companyId,
      factoryId: p.factoryId,
      product: p.product,
      desiredQuantity: hosoEqTons(safeNonNegative(p.desiredQuantity)),
      priority: Number.isFinite(p.priority) ? p.priority : 1,
    }));

  const workerAssignments = draft.workerAssignments.map((w) => ({
    factoryId: w.factoryId,
    companyId,
    regularHeadcount: Math.round(safeNonNegative(w.regularHeadcount)),
    temporaryHeadcount: Math.round(safeNonNegative(w.temporaryHeadcount)),
    skills: w.skills,
    overtimeRate: ratio(safeInRange01(w.overtimeRate)),
    attendanceRate: ratio(safeInRange01(w.attendanceRate)),
  }));

  return {
    companyId,
    salesPlans,
    domesticPurchasePlan,
    importOrders,
    aquacultureStockingPlans,
    productionPlans,
    workerAssignments,
  };
}
