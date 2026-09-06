// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1: Engine内部の診断値
//
// 【範囲】今回は Export / Databook / AI Analysis Pack / Audit Workbook /
// manifest / lab_index へは一切配線しない（#07 の Run Identity と競合させない）。
// Engine 内部およびテストから純関数として取得できる形までに限定する。
//
// 【永続stateを増やさない】この構造は保存されない。すべて、その場で
// (a) シナリオ定義（Turn別指数）と (b) 既に計算済みの市場結果 から導出できる値であり、
// 新しい情報を state へ持ち込んでいない。既存Scenarioの保存結果は完全に不変。

import { CapexParameters, CAPEX_PARAMETERS_V1 } from "../capex/parameters";
import { CapitalProjectType } from "../capex/types";
import { LEGACY_CONSTRUCTION_COST_POLICY, resolveProjectBudget, type ConstructionCostPolicyInput } from "../capex/projectLifecycle";
import { FINANCE_PARAMETERS_V1, FinanceParameters } from "../finance/parameters";
import { MarketQuarterResult } from "../market/types";
import { unwrapUnit } from "../core/units";
import { ConstructionCostPolicyId, OperatingCostIndexKey, ScenarioDefinition } from "../scenario/types";
import { buildTurnEconomicsProjection } from "./turnEconomicsProjection";

/** ベトナム国内原料市場の当Turn診断（市場結果からの読み取りのみ。再計算しない）。 */
export interface RawMarketDiagnostics {
  readonly rawPriceUsdPerHosoEqKg: number;
  readonly buyingCeilingUsdPerHosoEqKg: number;
  readonly farmerReservationPriceUsdPerHosoEqKg: number;
  /**
   * 当Turnに適用された需給乗数 m。
   * 捕捉指数が中立(1.00)のときは market 側が診断キーを載せない規約のため、
   * price / buyingCeiling から復元する（ceiling が0のときは undefined）。
   */
  readonly rawPriceMultiplier: number | undefined;
  readonly rawPriceCaptureIndex: number;
  /** HOSO FOB − 原料価格（加工会社のスプレッド）。 */
  readonly processingSpreadUsdPerHosoEqKg: number;
  readonly hosoFobPriceUsdPerHosoEqKg: number;
  readonly quantityRationed: boolean;
  /** 数量調整時の取引比率。中立時は market 側が載せないため undefined。 */
  readonly tradeRatio: number | undefined;
  readonly reservationPriceApplied: boolean;
}

/** 建設費の当Turn診断（案件種別ごと）。 */
export interface ConstructionCostDiagnostics {
  readonly policy: ConstructionCostPolicyId;
  readonly constructionCostIndex: number;
  readonly standardBudgetUsd: number;
  readonly indexedRequiredProjectCostUsd: number;
  /** 申請額（提出された場合のみ）。支払意思上限であり工事原価ではない。 */
  readonly requestedBudgetUsd: number | undefined;
  /** 承認額。申請額不足で拒否される場合は undefined。 */
  readonly approvedBudgetUsd: number | undefined;
  readonly insufficientRequest: boolean;
}

export interface CostFoundationDiagnostics {
  readonly turn: number;
  readonly parametersVersion: string;
  readonly operatingCostIndices: Readonly<Record<OperatingCostIndexKey, number>>;
  /** 指数適用後の実効費用単価（Engineが実際に使う値と同一）。 */
  readonly effectiveFinanceParameters: FinanceParameters;
  readonly rawMarket: RawMarketDiagnostics | undefined;
}

/**
 * 当Turnの費用・原料市場の診断値を組み立てる。
 * marketResult を渡さない場合、原料市場の診断は undefined（捏造しない）。
 */
export function buildCostFoundationDiagnostics(
  definition: ScenarioDefinition,
  turn: number,
  marketResult?: MarketQuarterResult,
  baseFinanceParameters: FinanceParameters = FINANCE_PARAMETERS_V1
): CostFoundationDiagnostics {
  const projection = buildTurnEconomicsProjection({ definition, turn, baseFinanceParameters, marketResult });
  return {
    turn,
    parametersVersion: projection.parametersVersion,
    operatingCostIndices: projection.operatingCostIndices,
    effectiveFinanceParameters: projection.financeParameters,
    rawMarket: marketResult === undefined ? undefined : buildRawMarketDiagnostics(marketResult, projection.rawPriceCaptureIndex),
  };
}

function buildRawMarketDiagnostics(marketResult: MarketQuarterResult, rawPriceCaptureIndex: number): RawMarketDiagnostics {
  const d = marketResult.vietnamDomestic;
  const rawPrice = unwrapUnit(d.price);
  const ceiling = unwrapUnit(d.buyingCeiling);
  const hosoFob = unwrapUnit(marketResult.hosoPrices.VN.price);
  return {
    rawPriceUsdPerHosoEqKg: rawPrice,
    buyingCeilingUsdPerHosoEqKg: ceiling,
    farmerReservationPriceUsdPerHosoEqKg: unwrapUnit(d.farmerReservationPrice),
    // 中立時は market 側が priceMultiplier を載せないため price/ceiling から復元する。
    rawPriceMultiplier: d.priceMultiplier ?? (ceiling > 0 ? rawPrice / ceiling : undefined),
    rawPriceCaptureIndex: d.rawPriceCaptureIndex ?? rawPriceCaptureIndex,
    processingSpreadUsdPerHosoEqKg: hosoFob - rawPrice,
    hosoFobPriceUsdPerHosoEqKg: hosoFob,
    quantityRationed: d.quantityRationed,
    tradeRatio: d.tradeRatio,
    reservationPriceApplied: d.reservationPriceApplied,
  };
}

/**
 * 建設費の当Turn診断。Engineの承認額計算と同じ resolveProjectBudget を通すため、
 * 診断値と実際の承認額が乖離することはない。
 */
export function buildConstructionCostDiagnostics(
  projectType: CapitalProjectType,
  requestedBudgetUsd: number | undefined,
  costPolicy: ConstructionCostPolicyInput = LEGACY_CONSTRUCTION_COST_POLICY,
  capexParameters: CapexParameters = CAPEX_PARAMETERS_V1
): ConstructionCostDiagnostics {
  const template = capexParameters.templatesByType[projectType];
  const resolved = resolveProjectBudget(template, requestedBudgetUsd, costPolicy);
  return {
    policy: resolved.policy,
    constructionCostIndex: resolved.constructionCostIndex,
    standardBudgetUsd: resolved.standardBudgetUsd,
    indexedRequiredProjectCostUsd: resolved.indexedRequiredProjectCostUsd,
    requestedBudgetUsd: resolved.requestedBudgetUsd,
    approvedBudgetUsd: resolved.approvedBudgetUsd,
    insufficientRequest: resolved.insufficientRequest,
  };
}
