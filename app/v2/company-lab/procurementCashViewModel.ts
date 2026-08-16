// ShrimpX V2 — Procurement Planning: 調達資金（Pre-Financing Procurement Capacity）
//
// 【この層がやること】既存のpure function（standardAi/decision/workingCapital.ts の
// assessWorkingCapitalNeed、financing/liquidityClose.ts の computeProcurementConstraint）
// をそのまま呼び出し、結果を並べて返すだけ。新しい資金計算式は一切作らない。
//
// 【「追加借入承認前の保守ケース」であること（最重要）】
//   approvedNormalLoanDrawUsd は常に0を使う（PRE_FINANCING_APPROVED_LOAN_DRAW_USD）。
//   これは「新規借入の承認をまだ考慮しない、現在確定している流動性だけを前提とした
//   調達制約」を意味する。四半期処理が実際に使う承認額（plan.underwriting.approvedAmountUsd）
//   は当期の資金調達希望・銀行審査結果に依存し、この画面の時点ではまだ決まっていない。
//
//   本VMが返す preFinancingConstrainedDomesticQuantityTons は
//   **最終的な買付確定量ではない**。実際の成立量は、
//     - 他社との競争配分（allocateDomesticPurchase）
//     - 銀行審査の承認額（追加借入が承認されれば制約は緩む）
//     - 市場供給量
//     - 価格競争力
//     - 四半期処理そのもの
//   を経て初めて決まる。VM名・フィールド名にも "preFinancing" を必ず含め、
//   Actual Purchase Quantity や Cash Projection と混同されない設計にしている。
//
// 【Cash Projection禁止】Projected Ending Cash・Forecast Cash Balance・
// Expected Ending Liquidity に相当するフィールドは一切持たない。表示できるのは
// 「当期の調達計画に対する資金の流れ（cash-out見積り・流動性制約・funding gap）」
// までであり、期末残高の予測はFinance画面でプレイヤー自身が判断する。
//
// 【severeArrearsOrInsolventの求め方】四半期処理（companyLab/runner.ts）が実際に
// 使う与信ゲート（plan.borrowingCapacity.underwritingFrozen）は
// computeCreditScore/computeBorrowingCapacity の再実行を要し、当期の意思決定画面
// からは重すぎる（かつ「銀行審査は四半期処理まで確定しない」という既存の情報境界を
// 越える）。同じrunner.tsが設備投資承認ゲート（capexApprovalGateByCompanyId.
// severelyDistressed）向けに使っているのと同一の簡易判定
// （前期末に確定した財務健全性が重大延滞・支払不能だったか）をそのまま流用する。
//
// 【関数を2段に分けている理由】buildProcurementCashFromObservation は
// StandardAiObservation（既存のstandardAi層が既に使っている観測値）だけを入力に
// 取る純粋関数で、standardAi/decision/workingCapital.ts の既存テストと同じ
// 「合成observationを直接組み立てて渡す」パターンでテストできる。
// buildProcurementCashViewModel は CompanyFixture/CompanyOwnState/PublicMarketInfo から
// buildStandardAiObservation を呼んでobservationを作るだけの薄い実運用エントリーポイント。

import { PeriodV2 } from "../../lib/v2/core/period";
import { CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../../lib/v2/companyLab/types";
import { buildStandardAiObservation } from "../../lib/v2/companyLab/standardAi/observation";
import { StandardAiObservation } from "../../lib/v2/companyLab/standardAi/types";
import {
  assessWorkingCapitalNeed,
  FALLBACK_EXPECTED_DOMESTIC_PRICE_USD_PER_KG,
} from "../../lib/v2/companyLab/standardAi/decision/workingCapital";
import { estimateTargetMinimumCashUsd, STANDARD_AI_PARAMETERS_V1 } from "../../lib/v2/companyLab/standardAi/parameters";
import { computeProcurementConstraint } from "../../lib/v2/financing/liquidityClose";
import { FINANCING_PARAMETERS_V1 } from "../../lib/v2/financing/parameters";
import { FinancialHealthTier } from "../../lib/v2/financing/types";

/** 「追加借入承認前」の保守ケースとして常に0を使う（Step 3のご指示どおり固定）。 */
export const PRE_FINANCING_APPROVED_LOAN_DRAW_USD = 0;

export interface ProcurementCashViewModel {
  // --- 1〜5: 計画・見積りコスト ---
  readonly domesticDesiredQuantityTons: number;
  readonly importOrderedQuantityTons: number;
  /** assessWorkingCapitalNeed.plannedDomesticRawProcurementCostUsd（数量×1000×期待国内価格）。 */
  readonly estimatedDomesticProcurementCostUsd: number;
  /** assessWorkingCapitalNeed.plannedImportRawProcurementCostUsd（当期発注ぶん。買掛経由のため当期の現金支出ではない）。 */
  readonly estimatedImportProcurementCostUsd: number;
  readonly totalPlannedRawProcurementCostUsd: number;

  // --- 6〜9: Pre-Financing 流動性制約（追加借入承認前） ---
  /** assessWorkingCapitalNeed.cashUsableForDomesticProcurementUsd（現金×国内買付充当比率）。 */
  readonly currentLiquidityAvailableForDomesticProcurementUsd: number;
  /** assessWorkingCapitalNeed.domesticProcurementFundingGapUsd。 */
  readonly domesticProcurementFundingGapUsd: number;
  /**
   * computeProcurementConstraint.constrainedDomesticPurchaseQuantityTons
   * （approvedNormalLoanDrawUsd=0のときの縮小後数量）。
   * **最終買付確定量ではない**（上部コメント参照）。
   */
  readonly preFinancingConstrainedDomesticQuantityTons: number;
  /** computeProcurementConstraint.scaleRatio（0〜1。1なら制約なし）。 */
  readonly preFinancingScaleRatio: number;

  // --- 10〜11: 輸入ブロック・理由 ---
  /** computeProcurementConstraint.importOrdersBlocked（重大延滞・支払不能により輸入発注も抑制）。 */
  readonly importOrdersBlocked: boolean;
  /** computeProcurementConstraint.reason（エンジンが生成した理由文をそのまま転記）。 */
  readonly reason: string;

  /** この結果がどの前提で計算されたかを明示する（UIが誤って確定値として表示しないための情報）。 */
  readonly assumptions: {
    readonly approvedNormalLoanDrawUsd: number;
    readonly label: "Pre-Financing Procurement Capacity";
    readonly note: "追加資金調達前・追加借入承認前の保守ケース。最終確定量ではない。";
  };
}

function safeNonNegative(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

const SEVERE_FINANCIAL_HEALTH_TIERS: ReadonlySet<FinancialHealthTier> = new Set(["paymentDefault", "insolvent"]);

export interface BuildProcurementCashFromObservationInput {
  readonly observation: StandardAiObservation;
  readonly fixture: CompanyFixture;
  readonly period: PeriodV2;
  /** ownState.financingState.history.lastFinancialHealth（前期末確定値。turn1等はundefined）。 */
  readonly lastFinancialHealth: FinancialHealthTier | undefined;
  /** draft.domesticPurchase.desiredQuantity（HOSO換算MT）。draftそのままの値。 */
  readonly domesticDesiredQuantityTons: number;
  /** draft.importOrders[].orderedQuantity の合計（HOSO換算MT）。 */
  readonly importOrderedQuantityTons: number;
}

/**
 * 調達資金（Pre-Financing Procurement Capacity）のview-modelを、既に構築済みの
 * StandardAiObservationから組み立てる純粋関数。assessWorkingCapitalNeed /
 * computeProcurementConstraint を呼ぶだけで、新しい資金計算式は追加しない。
 * approvedNormalLoanDrawUsdは常に0（追加借入承認前）。
 */
export function buildProcurementCashFromObservation(input: BuildProcurementCashFromObservationInput): ProcurementCashViewModel {
  const domesticDesiredQuantityTons = safeNonNegative(input.domesticDesiredQuantityTons);
  const importOrderedQuantityTons = safeNonNegative(input.importOrderedQuantityTons);

  const expectedDomesticPriceUsdPerKg = input.observation.vietnamDomesticPriorPrice ?? FALLBACK_EXPECTED_DOMESTIC_PRICE_USD_PER_KG;

  const minimumCashBufferUsd = estimateTargetMinimumCashUsd(input.fixture, expectedDomesticPriceUsdPerKg, STANDARD_AI_PARAMETERS_V1);

  const workingCapital = assessWorkingCapitalNeed(
    input.observation,
    { domesticDesiredQuantityTons, importOrderedQuantityTons },
    minimumCashBufferUsd
  );

  // 重大延滞・支払不能の簡易判定（companyLab/runner.ts の capexApprovalGateByCompanyId.
  // severelyDistressed と同一式。上部コメント参照）。
  const severeArrearsOrInsolvent = input.lastFinancialHealth !== undefined && SEVERE_FINANCIAL_HEALTH_TIERS.has(input.lastFinancialHealth);

  const constraint = computeProcurementConstraint(
    {
      companyId: input.fixture.companyId,
      period: input.period,
      originalDomesticPurchaseQuantityTons: domesticDesiredQuantityTons,
      expectedDomesticPriceUsdPerKg,
      prevCashUsd: input.observation.cashUsd,
      approvedNormalLoanDrawUsd: PRE_FINANCING_APPROVED_LOAN_DRAW_USD,
      severeArrearsOrInsolvent,
    },
    FINANCING_PARAMETERS_V1
  );

  return {
    domesticDesiredQuantityTons,
    importOrderedQuantityTons,
    estimatedDomesticProcurementCostUsd: workingCapital.plannedDomesticRawProcurementCostUsd,
    estimatedImportProcurementCostUsd: workingCapital.plannedImportRawProcurementCostUsd,
    totalPlannedRawProcurementCostUsd: workingCapital.plannedRawProcurementCostUsd,
    currentLiquidityAvailableForDomesticProcurementUsd: workingCapital.cashUsableForDomesticProcurementUsd,
    domesticProcurementFundingGapUsd: workingCapital.domesticProcurementFundingGapUsd,
    preFinancingConstrainedDomesticQuantityTons: constraint.constrainedDomesticPurchaseQuantityTons,
    preFinancingScaleRatio: constraint.scaleRatio,
    importOrdersBlocked: constraint.importOrdersBlocked,
    reason: constraint.reason,
    assumptions: {
      approvedNormalLoanDrawUsd: PRE_FINANCING_APPROVED_LOAN_DRAW_USD,
      label: "Pre-Financing Procurement Capacity",
      note: "追加資金調達前・追加借入承認前の保守ケース。最終確定量ではない。",
    },
  };
}

export interface BuildProcurementCashInput {
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly publicInfo: PublicMarketInfo;
  readonly period: PeriodV2;
  readonly turn: number;
  readonly domesticDesiredQuantityTons: number;
  readonly importOrderedQuantityTons: number;
}

/**
 * 実運用エントリーポイント。CompanyFixture/CompanyOwnState/PublicMarketInfoから
 * buildStandardAiObservation でobservationを組み立て、buildProcurementCashFromObservation
 * へそのまま渡すだけの薄いラッパー。
 */
export function buildProcurementCashViewModel(input: BuildProcurementCashInput): ProcurementCashViewModel {
  const observation = buildStandardAiObservation(input.fixture, input.ownState, input.publicInfo, input.period, input.turn);
  return buildProcurementCashFromObservation({
    observation,
    fixture: input.fixture,
    period: input.period,
    lastFinancialHealth: input.ownState.financingState.history.lastFinancialHealth,
    domesticDesiredQuantityTons: input.domesticDesiredQuantityTons,
    importOrderedQuantityTons: input.importOrderedQuantityTons,
  });
}
