// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 意思決定編集用ドラフト型・変換
//
// 画面の入力欄はプレーンなnumber/stringしか扱えないため、branded number型
// （HosoEqTons・Ratio等）を直接編集させることはできない。本ファイルは
// 「編集可能なプレーン値の一覧（全市場×全商品などの網羅グリッド）」への変換と、
// 送信直前の CompanyDecisionInput（branded types）への再変換だけを行う、
// 計算ロジックを一切持たない型変換層である（generateAutoPolicyDecision・
// advanceCompanyLabQuarterの計算結果・入力契約はここでは一切変更しない）。

import { hosoEqTons, ratio, unwrapUnit } from "../../lib/v2/core/units";
import { FINANCE_PARAMETERS_V1 } from "../../lib/v2/finance/parameters";
import { PeriodV2 } from "../../lib/v2/core/period";
import { COUNTRY_IDS, CountryId, DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../lib/v2/market/types";
import { CompanyDecisionInput, CompanyFixture } from "../../lib/v2/companyLab";
import type { CompanyWorkforceState } from "../../lib/v2/companyLab/workforce";
import { LoanType, RepaymentMethod } from "../../lib/v2/financing/types";
import { CapitalProjectType } from "../../lib/v2/capex/types";
import { PlanCostExpectation } from "../../lib/v2/sales/types";
import { Score0to100 } from "../../lib/v2/core/units";
import { Factory, WorkerSkillEntry } from "../../lib/v2/production/types";
import { isValidVapProductDevelopmentSpendTier, VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD } from "../../lib/v2/companyLab/productDevelopmentState";

export const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** 【Test15新設】VAP商品開発費の4段階選択肢を画面側へ再輸出する（唯一の情報源はproductDevelopmentState.ts）。 */
export const VAP_PRODUCT_DEVELOPMENT_SPEND_TIER_OPTIONS_USD = VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD;

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
  /** 【Test15新設・複数工場CAPEX Targeting修正で全案件種別へ拡張】この提案の対象Factory。pdMechanizationは必須、他は省略可（省略時は主工場）。 */
  readonly targetFactoryId?: string;
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
   * 【営業人員の追加採用・forward-port】当期の営業人員の新規採用人数（0以上の
   * 整数）。今期採用した人数は今期の配分には使えず、四半期確定時に採用が成立し、
   * 次の四半期の開始時点から配分可能人数へ加算される
   * （app/lib/v2/companyLab/salesForceHiring.ts参照）。
   * 新しい四半期のドラフトは常に0から始まる（前四半期の採用決定を引き継がない。
   * 「今回の採用予定」は毎回新しい意思決定であるため）。
   * 省略可能なのは、この機能導入前に保存された下書きにこのフィールドが無いため
   * （読み込み側は `?? 0` として扱う。0で埋めない）。
   */
  readonly salesForceHireCount?: number;
  /**
   * 【営業人員の減員・forward-port続き】当期の営業人員の減員人数（0以上の
   * 整数）。減員対象者は今期は配置・給与の対象のままで、四半期確定時に減員が
   * 成立し、次の四半期の開始時点から配分可能人数が減る
   * （app/lib/v2/companyLab/salesForceHiring.ts参照）。減員を決定した当期に
   * 1人あたり四半期給与2四半期分の退職金が一度だけ発生する
   * （app/lib/v2/finance/quarterClose.ts参照）。
   * salesForceHireCountと同一四半期に両方>0を入力することはできない
   * （提出時にrunner.ts側で検証・エラー化される。画面側でも提出ボタンを
   * 無効化する）。
   * 新しい四半期のドラフトは常に0から始まる。省略可能なのは、この機能導入前に
   * 保存された下書きにこのフィールドが無いため（読み込み側は `?? 0` として扱う）。
   */
  readonly salesForceLayoffCount?: number;
  /**
   * 【Test15新設】今四半期のVAP商品開発費（$0/$100,000/$250,000/$500,000の4段階のみ）。
   * 未設定（自動方針が値を生成しなかった場合）は0として扱う。
   */
  readonly vapProductDevelopmentSpendUsd: number;
  /**
   * 【DIV-1新設】今四半期の配当希望額（自由入力・0可）。未指定・省略時は0
   * （配当なし）として扱う。省略可能なのは、この機能導入前に保存された
   * 下書きにこのフィールドが無いため（読み込み側は `?? 0` として扱う）。
   */
  readonly dividendAmountUsd?: number;
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

/**
 * 【SAI-2追加作業: 市場別営業配置・商品別営業工数】以前は行（市場×商品）ごとの
 * salesForceHeadcountを単純合計していたが、同一市場のHOSO/PD/VAPが同じ営業人員数を
 * 共有する新しい前提（sales/salesForce.tsのvalidateSalesForceHeadcountBudget）の
 * もとでは、市場単位で重複排除してから合計しないと二重・三重カウントになる
 * （例：CN市場のHOSO/PD/VAP全行に8人と入力するのは正しい入力であり24人ではない）。
 */
export function summarizeSalesForceAllocation(
  salesPlans: readonly { readonly market: DemandMarketId; readonly salesForceHeadcount: number }[],
  availableTotal: number
): SalesForceAllocationSummary {
  const headcountByMarket = new Map<DemandMarketId, number>();
  for (const p of salesPlans) {
    if (Number.isFinite(p.salesForceHeadcount)) headcountByMarket.set(p.market, p.salesForceHeadcount);
  }
  const assignedTotal = Array.from(headcountByMarket.values()).reduce((sum, h) => sum + h, 0);
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
// 【営業人員の追加採用・減員・forward-port（減員・退職金は続き作業）】表示用の単純な
// 合算・退職金見積り。判定ロジック（採用・減員の同時入力禁止）は持つが、
// バジェット検証等の受理判定そのものはrunner.ts側（唯一の正）と重複させない。
//
// 「今回の採用予定」「今回の減員予定」（draft.salesForceHireCount /
// salesForceLayoffCount）は今期の配分可能人数へは加算・減算しない（当期の
// 配分可能人数は常に現在の営業人員そのもの）。次期の営業人員見込みだけが、
// 現在の営業人員＋今回の採用予定−今回の減員予定（0未満はしない）になる。
// ---------------------------------------------------------------------

export interface SalesForceHiringPreview {
  /** 現在の営業人員（＝当期に配分可能な人数）。 */
  readonly currentHeadcount: number;
  /** 今回の採用予定（ドラフトの入力値。0未満・NaN・Infinityは0として扱う）。 */
  readonly plannedHireCount: number;
  /**
   * 今回の減員予定（ドラフトの入力値。0未満・NaN・Infinityは0として扱う）。
   * 現在の営業人員を超える入力は、実際に減員される人数（effectiveLayoffCount）
   * では現在の営業人員に頭打ちされるが、この値自体（入力そのまま）は
   * 画面上の入力欄表示に使う。
   */
  readonly plannedLayoffCount: number;
  /** 実際に減員される人数（現在の営業人員で頭打ち。退職金の対象人数と一致）。 */
  readonly effectiveLayoffCount: number;
  /** 次期の営業人員見込み＝現在の営業人員＋今回の採用予定−実際の減員人数（0以上）。 */
  readonly nextQuarterHeadcount: number;
  /** 今回の減員により当期に一度だけ発生する退職金（1人あたり四半期給与2四半期分）。 */
  readonly severanceCostUsd: number;
  /** 採用予定・減員予定の両方が>0（同一四半期の同時入力、禁止事項）。 */
  readonly hasMutualExclusionConflict: boolean;
}

const SALES_FORCE_SEVERANCE_QUARTERS = 2;

export function summarizeSalesForceHiring(
  currentHeadcount: number,
  plannedHireCountRaw: number,
  plannedLayoffCountRaw: number = 0
): SalesForceHiringPreview {
  const safeCurrentHeadcount = Number.isFinite(currentHeadcount) && currentHeadcount > 0 ? Math.round(currentHeadcount) : 0;
  const plannedHireCount = Number.isFinite(plannedHireCountRaw) && plannedHireCountRaw > 0 ? Math.round(plannedHireCountRaw) : 0;
  const plannedLayoffCount = Number.isFinite(plannedLayoffCountRaw) && plannedLayoffCountRaw > 0 ? Math.round(plannedLayoffCountRaw) : 0;
  const effectiveLayoffCount = Math.min(plannedLayoffCount, safeCurrentHeadcount);
  const severanceCostUsd = effectiveLayoffCount * SALES_FORCE_SEVERANCE_QUARTERS * FINANCE_PARAMETERS_V1.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter;
  return {
    currentHeadcount: safeCurrentHeadcount,
    plannedHireCount,
    plannedLayoffCount,
    effectiveLayoffCount,
    nextQuarterHeadcount: Math.max(0, safeCurrentHeadcount + plannedHireCount - effectiveLayoffCount),
    severanceCostUsd,
    hasMutualExclusionConflict: plannedHireCount > 0 && plannedLayoffCount > 0,
  };
}

/**
 * 【SAI-2追加作業: 市場別営業配置・商品別営業工数】指定した市場の営業人員数を
 * 変更し、同じ市場の全商品行（HOSO/PD/VAP）へ同一の値を同期する。同一市場内で
 * 商品ごとに異なる営業人員数を持つことはできない、という新しい前提
 * （sales/salesForce.tsのvalidateSalesForceHeadcountBudget）をUI入力の時点で
 * 常に満たすようにするための操作。他の市場・他のドラフト項目には一切触れない。
 */
export function syncMarketSalesForceHeadcount(draft: CompanyDecisionDraft, market: DemandMarketId, headcount: number): CompanyDecisionDraft {
  return {
    ...draft,
    salesPlans: draft.salesPlans.map((row) => (row.market === market ? { ...row, salesForceHeadcount: headcount } : row)),
  };
}

// ---------------------------------------------------------------------
// 【Procurement Planning・Step 5】国内買付・輸入・養殖の各draft field を書き換える
// 単一責務のヘルパー。DecisionEditor.tsxの旧入力欄と、Procurement Planning
// component群（新）の両方から同じ関数を呼ぶことで、「どちらのUIから入力しても
// 同じdraft・同じdecisionInputが生成される」ことを構造的に保証する
// （app/v2/company-lab/__tests__/procurementDraftParity.test.ts 参照）。
// 計算ロジックは持たない（他のドラフト変換ヘルパーと同じ方針）。
// ---------------------------------------------------------------------

/** 国内原料買付ドラフトの部分更新（他のドラフト項目には一切触れない）。 */
export function updateDomesticPurchaseDraft(draft: CompanyDecisionDraft, patch: Partial<DomesticPurchaseDraft>): CompanyDecisionDraft {
  return { ...draft, domesticPurchase: { ...draft.domesticPurchase, ...patch } };
}

/** 指定した原産国の輸入発注ドラフト行の部分更新（他の原産国・他のドラフト項目には触れない）。 */
export function updateImportOrderDraft(
  draft: CompanyDecisionDraft,
  originCountry: CountryId,
  patch: Partial<ImportOrderDraftRow>
): CompanyDecisionDraft {
  return {
    ...draft,
    importOrders: draft.importOrders.map((row) => (row.originCountry === originCountry ? { ...row, ...patch } : row)),
  };
}

/**
 * 養殖池入れドラフトの部分更新。現行仕様（fixture.aquacultureCapacity>0の会社のみ
 * 1件だけ持つ）に合わせ、常に先頭（唯一）の行を更新する。行が存在しない会社
 * （養殖能力0）に対しては何もしない（draftをそのまま返す）。
 */
export function updateAquacultureStockingDraft(draft: CompanyDecisionDraft, patch: Partial<AquacultureStockingDraft>): CompanyDecisionDraft {
  if (draft.aquacultureStockingPlans.length === 0) return draft;
  return {
    ...draft,
    aquacultureStockingPlans: [{ ...draft.aquacultureStockingPlans[0], ...patch }],
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
  workforceState?: CompanyWorkforceState,
  /**
   * 【Test15・develop/v2統合（Required fix 2）】当四半期時点の実効Factory[]
   * （CompanyOwnState.effectiveFactories。稼働開始済みの新設Factoryを含む）。
   * 渡された場合、生産計画・ワーカー配置の入力行はこの一覧を基準に生成される
   * （fixture.factoriesという静的な初期一覧だけでは、稼働開始した新設Factoryへ
   * 入力する手段が無かった、という統合前の欠落を解消する）。省略された場合は
   * 従来どおりfixture.factoriesを使う（後方互換・既存テスト向け）。
   */
  effectiveFactories?: readonly Factory[]
): CompanyDecisionDraft {
  const inputFactories = effectiveFactories ?? fixture.factories;
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

  const productionPlans: ProductionPlanDraftRow[] = inputFactories.flatMap((f) =>
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

  const workerAssignments: WorkerAssignmentDraftRow[] = inputFactories.map((f) => {
    const base = fixture.workerBaseline.find((b) => b.factoryId === f.factoryId);
    const found = autoDecision.workerAssignments.find((w) => w.factoryId === f.factoryId);
    // 【Phase 8D-4】出発点は「会社状態として保持されている前期末の総人数」。
    // これが無い場合にかぎり、従来どおり自動方針／fixtureの基準人数へフォールバックする。
    const persisted = workforceState?.factories.find((wf) => wf.factoryId === f.factoryId)?.regularHeadcount;
    // 【Test15・develop/v2統合（Required fix 2・【Test15暫定値・要校正】】稼働開始
    // したばかりの新設Factoryにはfixture.workerBaselineの対応行が存在しない
    // （新設Factoryは作成時点のfixtureには含まれないため）。この場合、実装指示
    // 「新設Factoryはゼロ人・ゼロ生産から始まる。総ワーカー・営業人員・需要を
    // 自動的に積み増さない」に従い、常用人数0・臨時人数0・残業率0から出発する
    // （persistedがあれば新設Factoryでも前期末実績を優先する。一度でも配置された
    // 実績があれば、その実績を尊重するのは既存工場と同じ扱い）。
    //
    // 技能水準（skillLevel）は、当初は「未経験＝0」としていたが、この製品コード
    // ベースにはワーカーの技能を四半期を追うごとに向上させる仕組み（訓練・OJT等）
    // が一切存在しない（production/labor.tsのskillLevelFor参照。fixture作成時の
    // 値のまま変化しない）。skillLevel=0だとその工場は稼働開始後も未来永劫
    // 生産量ゼロのまま（technicallyワーカー・生産計画を入力できても実際には
    // 何も生産できない）になってしまい、「稼働開始後は既存工場と同じカテゴリの
    // 意思決定を入力でき、実際に生産できる」という要件を満たせない。
    // そのため、新設Factoryの初期技能水準は「標準的な即戦力人材を採用した」
    // という想定で、全品目一律0.7（中程度の習熟度）を暫定的に使う（校正待ち。
    // 既存工場のfixture値0.75〜0.85よりやや低い水準）。稼働可能率は他工場と
    // 同じ既定値0.95を暫定的に使う（校正待ち。companyLab/fixtures.ts
    // workerBaseline()の既定値と同じ）。
    const NEW_FACTORY_DEFAULT_SKILL_LEVEL = 0.7;
    const defaultSkillsForNewFactory: readonly WorkerSkillEntry[] = PRODUCTS.map((product) => ({
      product,
      skillLevel: ratio(NEW_FACTORY_DEFAULT_SKILL_LEVEL),
    }));
    const regularHeadcountBefore = persisted ?? (found ? found.regularHeadcount : base ? base.regularHeadcount : 0);
    return {
      factoryId: f.factoryId,
      regularHeadcount: regularHeadcountBefore,
      regularHeadcountBefore,
      regularHeadcountChange: 0,
      temporaryHeadcount: found ? found.temporaryHeadcount : 0,
      overtimeRate: found ? unwrapUnit(found.overtimeRate) : 0,
      skills: base ? base.skills : defaultSkillsForNewFactory,
      attendanceRate: base ? unwrapUnit(base.attendanceRate) : 0.95,
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
      ...(p.targetFactoryId !== undefined ? { targetFactoryId: p.targetFactoryId } : {}),
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
    // 【営業人員の追加採用・減員・forward-port（続き）】新しい四半期のドラフトは
    // 常に採用予定・減員予定0人から始まる（前四半期の決定を引き継がない。
    // 「今回の採用・減員予定」は毎回新しい意思決定であるため）。
    salesForceHireCount: 0,
    salesForceLayoffCount: 0,
    vapProductDevelopmentSpendUsd: autoDecision.vapProductDevelopmentSpendUsd ?? 0,
    // 【DIV-1新設】新しい四半期のドラフトは常に配当希望額0から始まる
    // （前四半期の配当決定を引き継がない。「今回の配当」は毎回新しい意思決定であるため）。
    dividendAmountUsd: 0,
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
      ...(p.targetFactoryId !== undefined ? { targetFactoryId: p.targetFactoryId } : {}),
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
    // 【営業人員の追加採用・減員・forward-port（続き）】負値・NaN・Infinityは0へ
    // 丸める（採用・減員人数は常に0以上の整数）。同一四半期の同時入力禁止の
    // 検証はここでは行わない（このドラフト→入力変換層は計算・検証ロジックを
    // 持たない方針のため。runner.ts advanceCompanyLabQuarterが唯一の検証箇所）。
    salesForceHireCount: Math.round(safeNonNegative(draft.salesForceHireCount ?? 0)),
    salesForceLayoffCount: Math.round(safeNonNegative(draft.salesForceLayoffCount ?? 0)),
    vapProductDevelopmentSpendUsd: isValidVapProductDevelopmentSpendTier(draft.vapProductDevelopmentSpendUsd) ? draft.vapProductDevelopmentSpendUsd : 0,
    // 【DIV-1新設】配当希望額は自由入力・0可。負値・NaN・Infinityは0へ丸める
    // （マイナスの配当という構造的誤用はここでは起こり得ない設計にする。
    // maxDividendを超える金額は resolveDividendDecision 側で全額拒否される）。
    dividendDecision: { dividendAmountUsd: safeNonNegative(draft.dividendAmountUsd ?? 0) },
  };
}
