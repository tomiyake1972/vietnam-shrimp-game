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
import type { CompanyWorkforceState } from "../../lib/v2/companyLab/workforce";
import { LoanType, RepaymentMethod } from "../../lib/v2/financing/types";
import { CapitalProjectType } from "../../lib/v2/capex/types";
import { PlanCostExpectation } from "../../lib/v2/sales/types";
import { Score0to100 } from "../../lib/v2/core/units";
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
  /**
   * 契約時予想原価（Phase 6.3）。自動方針が算出した値を編集不可のまま引き継ぎ、
   * プレイヤーが編集した販売計画から生成される契約にもスナップショットが残るようにする。
   */
  readonly costExpectation?: PlanCostExpectation;
  /**
   * 【Phase 7A】品質・顧客信頼・納期信頼性（前四半期末までの自社state由来）。
   * 自動方針が算出した値を編集不可のまま引き継ぐ（本ドラフト層は計算ロジックを
   * 持たないため、costExpectationと同じ扱いとする。本格的なUI表示はPhase 7B）。
   */
  readonly qualityReputation?: Score0to100;
  readonly customerRelationship?: Score0to100;
  readonly deliveryReliability?: Score0to100;
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
  /**
   * 当期エンジンへ渡す常用ワーカーの**総人数**（＝変更後人数）。
   * 【Phase 8D-4】プレイヤーが直接編集するのは regularHeadcountChange（増減差分）であり、
   * この値は「前期末の総人数 ＋ 増減差分」として画面側が同時に更新する。
   * エンジンの入力契約（WorkerAssignment.regularHeadcount＝絶対人数）は変更しないため、
   * buildDecisionInputFromDraft は従来どおりこの値をそのまま使う。
   */
  readonly regularHeadcount: number;
  /**
   * 【Phase 8D-4】前期末時点の常用ワーカー総人数（会社状態から引き継いだ出発点）。
   * 省略可能なのは、Phase 8D以前に保存された下書きにこのフィールドが無いため
   * （読み込み側は `?? regularHeadcount` として扱う。0で埋めない）。
   */
  readonly regularHeadcountBefore?: number;
  /** 【Phase 8D-4】当期の増減差分（増員は正、減員は負）。省略時は0として扱う。 */
  readonly regularHeadcountChange?: number;
  readonly temporaryHeadcount: number;
  readonly overtimeRate: number;
  readonly skills: readonly WorkerSkillEntry[];
  readonly attendanceRate: number;
}

/**
 * 【Phase 8B-1】資金調達希望のドラフト（プレーン値）。本ファイルは計算ロジックを
 * 持たない型変換層のままであり、財務画面・借入UIの実装はPhase 8B-1の対象外だが、
 * CompanyDecisionInput.financingRequestが必須フィールドになったため、既存の
 * 網羅ドラフト往復（buildInitialDraft/buildDecisionInputFromDraft）の対象へ
 * 機械的に追加する（自動方針の希望をそのまま編集不可で引き継ぐ扱いで十分）。
 */
export interface FinancingRequestDraft {
  readonly desiredAmountUsd: number;
  readonly desiredLoanType: LoanType;
  readonly desiredTermQuarters: number;
  readonly desiredRepaymentMethod: RepaymentMethod;
  readonly desiredPrepaymentUsd: number;
  readonly emergencyAcceptable: boolean;
}

/**
 * 【Phase 8B-2A】設備投資に関する意思決定のドラフト。プレイヤー入力UI（Phase
 * 8B-2Aの対象外）は無いが、CompanyDecisionInput.capexDecisionが必須フィールドに
 * なったため、既存の網羅ドラフト往復（buildInitialDraft/buildDecisionInputFromDraft）
 * の対象へ機械的に追加する。フィールドはいずれもブランド型を持たないため
 * （projectType・USD額・案件ID文字列はいずれもプレーン値）、hosoEqTons()等の
 * スマートコンストラクタ変換は不要で、そのまま往復する。
 */
export interface CapexProjectProposalDraftRow {
  readonly projectType: CapitalProjectType;
  readonly requestedBudgetUsd?: number;
  readonly priority?: number;
}

export interface CapexProjectReferenceDraftRow {
  readonly projectId: string;
}

export interface CapexDecisionDraft {
  readonly newProjectProposals: readonly CapexProjectProposalDraftRow[];
  readonly cancelRequests: readonly CapexProjectReferenceDraftRow[];
  readonly resumeRequests: readonly CapexProjectReferenceDraftRow[];
}

export interface CompanyDecisionDraft {
  readonly companyId: string;
  readonly salesPlans: readonly SalesPlanDraftRow[];
  readonly domesticPurchase: DomesticPurchaseDraft;
  readonly importOrders: readonly ImportOrderDraftRow[];
  readonly aquacultureStockingPlans: readonly AquacultureStockingDraft[];
  readonly productionPlans: readonly ProductionPlanDraftRow[];
  readonly workerAssignments: readonly WorkerAssignmentDraftRow[];
  readonly financingRequest: FinancingRequestDraft;
  readonly capexDecision: CapexDecisionDraft;
  /**
   * 【Phase 8G §2】当期の営業人員の新規採用人数（0以上の整数）。今期採用した
   * 人数は今期の配分には使えず、四半期確定時に採用が成立し、次の四半期の
   * 開始時点から配分可能人数へ加算される（salesForceHiring.ts参照）。
   * 新しい四半期のドラフトは常に0から始まる（前四半期の採用決定を引き継がない。
   * 「今回の採用予定」は毎回新しい意思決定であるため）。
   * 省略可能なのは、Phase 8G以前に保存された下書きにこのフィールドが無いため
   * （読み込み側は `?? 0` として扱う。0で埋めない）。
   */
  readonly salesForceHireCount?: number;
}

// ---------------------------------------------------------------------
// 【Phase 8G】営業人員配分の集計（表示・提出前チェックの両方で共有する単一ソース）
//
// validateSalesForceHeadcountBudget（app/lib/v2/sales/salesForce.ts）と同じ
// 「全社合計」の考え方をそのままUI側で先読みするだけで、判定ロジックを二重実装
// しない（合計超過ならエンジン側が投げるのと同じ理由でエラーになる、という
// 事実を画面が「先に」伝えるだけ）。
// ---------------------------------------------------------------------

export interface SalesForceAllocationSummary {
  readonly assignedTotal: number;
  readonly availableTotal: number;
  /** 超過していない場合の残り人数（0以上）。超過時は0。 */
  readonly remaining: number;
  /** 超過している場合の超過人数（0より大きい）。超過していなければ0。 */
  readonly overBy: number;
  readonly isOverAllocated: boolean;
}

export function summarizeSalesForceAllocation(
  salesPlans: readonly { readonly salesForceHeadcount: number }[],
  availableTotal: number
): SalesForceAllocationSummary {
  const assignedTotal = salesPlans.reduce((sum, p) => sum + (Number.isFinite(p.salesForceHeadcount) ? p.salesForceHeadcount : 0), 0);
  const isOverAllocated = assignedTotal > availableTotal;
  return {
    assignedTotal,
    availableTotal,
    remaining: isOverAllocated ? 0 : availableTotal - assignedTotal,
    overBy: isOverAllocated ? assignedTotal - availableTotal : 0,
    isOverAllocated,
  };
}

/** 「営業配分をすべて0に戻す」操作。他のドラフト項目には一切触れない。 */
export function resetAllSalesForceHeadcountToZero(draft: CompanyDecisionDraft): CompanyDecisionDraft {
  return { ...draft, salesPlans: draft.salesPlans.map((row) => ({ ...row, salesForceHeadcount: 0 })) };
}

// ---------------------------------------------------------------------
// 【Phase 8G §2】営業人員の追加採用（表示用の単純な合算。判定ロジックは持たない）
//
// 「今回の採用予定」（draft.salesForceHireCount）は今期の配分可能人数へは
// 加算しない（当期の配分可能人数は常に現在の営業人員そのもの）。次期の
// 営業人員見込みだけが、現在の営業人員＋今回の採用予定の単純な合算になる。
// ---------------------------------------------------------------------

export interface SalesForceHiringPreview {
  /** 現在の営業人員（＝当期に配分可能な人数）。 */
  readonly currentHeadcount: number;
  /** 今回の採用予定（ドラフトの入力値。0未満・NaN・Infinityは0として扱う）。 */
  readonly plannedHireCount: number;
  /** 次期の営業人員見込み＝現在の営業人員＋今回の採用予定。 */
  readonly nextQuarterHeadcount: number;
}

export function summarizeSalesForceHiring(currentHeadcount: number, plannedHireCountRaw: number): SalesForceHiringPreview {
  const safeCurrentHeadcount = Number.isFinite(currentHeadcount) && currentHeadcount > 0 ? Math.round(currentHeadcount) : 0;
  const plannedHireCount = Number.isFinite(plannedHireCountRaw) && plannedHireCountRaw > 0 ? Math.round(plannedHireCountRaw) : 0;
  return {
    currentHeadcount: safeCurrentHeadcount,
    plannedHireCount,
    nextQuarterHeadcount: safeCurrentHeadcount + plannedHireCount,
  };
}

// ---------------------------------------------------------------------
// generateAutoPolicyDecision の結果 → 網羅グリッドドラフトへの変換
// ---------------------------------------------------------------------

/**
 * 自動方針の出力（CompanyDecisionInput）を、全市場×全商品・全工場×全商品などの
 * 網羅グリッドを持つ編集用ドラフトへ変換する。自動方針が生成しなかった組合せは
 * 数量0の行として補い、プレイヤーが新しい市場・商品組合せへも入力できるようにする。
 */
export function buildInitialDraft(
  fixture: CompanyFixture,
  autoDecision: CompanyDecisionInput,
  /**
   * 【Phase 8D-4】前期末までのWorker総人数（会社状態）。渡された場合、ワーカー行の
   * 出発点はこの総人数になり、増減差分は0から始まる。
   * 省略された場合は従来どおり自動方針／fixtureの基準人数を出発点とする
   * （Phase 8D以前の呼び出し元・既存テストとの後方互換）。
   */
  workforceState?: CompanyWorkforceState
): CompanyDecisionDraft {
  const salesPlans: SalesPlanDraftRow[] = DEMAND_MARKET_IDS.flatMap((market) =>
    PRODUCTS.map((product) => {
      const found = autoDecision.salesPlans.find((p) => p.market === market && p.product === product);
      // 自動方針が同一商品の別市場向けに算出したcostExpectationがあれば、
      // 数量0の網羅行にも引き継ぐ（プレイヤーが新市場へ数量を入れた場合にも
      // 契約時予想原価スナップショットが残るようにする）。
      const sameProduct = autoDecision.salesPlans.find((p) => p.product === product);
      const sameMarket = autoDecision.salesPlans.find((p) => p.market === market);
      return {
        market,
        product,
        desiredQuantity: found ? unwrapUnit(found.desiredQuantity) : 0,
        priceAdjustmentUsdPerHosoEqKg: found ? found.priceAdjustmentUsdPerHosoEqKg : 0,
        salesForceHeadcount: found ? found.salesForceHeadcount : 0,
        costExpectation: found?.costExpectation ?? sameProduct?.costExpectation,
        qualityReputation: found?.qualityReputation ?? sameProduct?.qualityReputation,
        customerRelationship: found?.customerRelationship ?? sameMarket?.customerRelationship,
        deliveryReliability: found?.deliveryReliability ?? sameMarket?.deliveryReliability,
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
    // 【Phase 8D-4】出発点は「会社状態として保持されている前期末の総人数」。
    // これが無い場合にかぎり、従来どおり自動方針／fixtureの基準人数へフォールバックする。
    const persisted = workforceState?.factories.find((f) => f.factoryId === base.factoryId)?.regularHeadcount;
    const regularHeadcountBefore = persisted ?? (found ? found.regularHeadcount : base.regularHeadcount);
    return {
      factoryId: base.factoryId,
      regularHeadcount: regularHeadcountBefore,
      regularHeadcountBefore,
      regularHeadcountChange: 0,
      temporaryHeadcount: found ? found.temporaryHeadcount : 0,
      overtimeRate: found ? unwrapUnit(found.overtimeRate) : 0,
      skills: base.skills,
      attendanceRate: unwrapUnit(base.attendanceRate),
    };
  });

  const financingRequest: FinancingRequestDraft = {
    desiredAmountUsd: autoDecision.financingRequest.desiredAmountUsd,
    desiredLoanType: autoDecision.financingRequest.desiredLoanType,
    desiredTermQuarters: autoDecision.financingRequest.desiredTermQuarters,
    desiredRepaymentMethod: autoDecision.financingRequest.desiredRepaymentMethod,
    desiredPrepaymentUsd: autoDecision.financingRequest.desiredPrepaymentUsd,
    emergencyAcceptable: autoDecision.financingRequest.emergencyAcceptable,
  };

  const capexDecision: CapexDecisionDraft = {
    newProjectProposals: autoDecision.capexDecision.newProjectProposals.map((p) => ({
      projectType: p.projectType,
      ...(p.requestedBudgetUsd !== undefined ? { requestedBudgetUsd: p.requestedBudgetUsd } : {}),
      ...(p.priority !== undefined ? { priority: p.priority } : {}),
    })),
    cancelRequests: autoDecision.capexDecision.cancelRequests.map((c) => ({ projectId: c.projectId })),
    resumeRequests: autoDecision.capexDecision.resumeRequests.map((r) => ({ projectId: r.projectId })),
  };

  return {
    companyId: fixture.companyId,
    salesPlans,
    domesticPurchase,
    importOrders,
    aquacultureStockingPlans,
    productionPlans,
    workerAssignments,
    financingRequest,
    capexDecision,
    // 【Phase 8G §2】新しい四半期のドラフトは常に採用予定0人から始まる
    // （前四半期の採用決定を引き継がない）。
    salesForceHireCount: 0,
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
      ...(p.costExpectation !== undefined ? { costExpectation: p.costExpectation } : {}),
      ...(p.qualityReputation !== undefined ? { qualityReputation: p.qualityReputation } : {}),
      ...(p.customerRelationship !== undefined ? { customerRelationship: p.customerRelationship } : {}),
      ...(p.deliveryReliability !== undefined ? { deliveryReliability: p.deliveryReliability } : {}),
    }));

  const domesticPurchasePlan = {
    companyId,
    desiredQuantity: hosoEqTons(safeNonNegative(draft.domesticPurchase.desiredQuantity)),
    priceAdjustmentUsdPerHosoEqKg: Number.isFinite(draft.domesticPurchase.priceAdjustmentUsdPerHosoEqKg)
      ? draft.domesticPurchase.priceAdjustmentUsdPerHosoEqKg
      : 0,
    procurementHeadcount: Math.round(safeNonNegative(draft.domesticPurchase.procurementHeadcount)),
    // Phase 6.3: 調達処理能力の工場能力連動方式（fixtureから決定論的に導出。編集対象外）。
    factoryCommonProcessingCapacityTons: fixture.factories.reduce((sum, f) => sum + unwrapUnit(f.commonProcessingCapacity), 0),
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

  const financingRequest = {
    desiredAmountUsd: safeNonNegative(draft.financingRequest.desiredAmountUsd),
    desiredLoanType: draft.financingRequest.desiredLoanType,
    desiredTermQuarters: Math.max(1, Math.round(safeNonNegative(draft.financingRequest.desiredTermQuarters))),
    desiredRepaymentMethod: draft.financingRequest.desiredRepaymentMethod,
    desiredPrepaymentUsd: safeNonNegative(draft.financingRequest.desiredPrepaymentUsd),
    emergencyAcceptable: draft.financingRequest.emergencyAcceptable,
  };

  const capexDecision = {
    companyId,
    newProjectProposals: draft.capexDecision.newProjectProposals.map((p) => ({
      projectType: p.projectType,
      ...(p.requestedBudgetUsd !== undefined && Number.isFinite(p.requestedBudgetUsd) ? { requestedBudgetUsd: p.requestedBudgetUsd } : {}),
      ...(p.priority !== undefined && Number.isFinite(p.priority) ? { priority: p.priority } : {}),
    })),
    cancelRequests: draft.capexDecision.cancelRequests.map((c) => ({ projectId: c.projectId })),
    resumeRequests: draft.capexDecision.resumeRequests.map((r) => ({ projectId: r.projectId })),
  };

  return {
    companyId,
    salesPlans,
    domesticPurchasePlan,
    importOrders,
    aquacultureStockingPlans,
    productionPlans,
    workerAssignments,
    financingRequest,
    capexDecision,
    // 【Phase 8G §2】負値・NaN・Infinityは0へ丸める（採用人数は常に0以上の整数）。
    salesForceHireCount: Math.round(safeNonNegative(draft.salesForceHireCount ?? 0)),
  };
}
