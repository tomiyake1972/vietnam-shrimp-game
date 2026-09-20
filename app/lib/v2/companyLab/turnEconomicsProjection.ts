// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1: Turn別経済前提の共通 projection
//
// 【目的】Engine（会社ラボの四半期処理）と、将来これを読む側（Standard AI 等）が
// **同じ費用単価・同じ指数・同じ建設費**を見るための、唯一の読み取り専用の窓口。
//
// 【新しい計算を作らない】ここが計算するのは
//   ・指数の解決 … scenario/costIndex.ts（唯一のSSoT）へ委譲
//   ・実効費用単価 … finance/parameters.ts:financeParametersForTurn へ委譲
//   ・必要工事費 … capex/projectLifecycle.ts:resolveProjectBudget へ委譲
//   ・基準販売価格 … market/destinationPricing.ts の既存射影をそのまま転記
// だけであり、独自の費用式・独自の価格式は一切持たない。
//
// 【将来値を捏造しない】将来Turnの原料価格・販売価格は市場清算の結果であり、
// 一般に事前計算できない。取得できない場合は isEstimate:false と欠損値
// （undefined）を返し、確定値であるかのように見せない。
//
// 【今回の範囲】Engine API までを実装する。Standard AI の意思決定への接続は
// 行わない（#05 の別タスク）。Export / Databook / AI Pack への配線も行わない。

import { CapexParameters, CAPEX_PARAMETERS_V1 } from "../capex/parameters";
import { CapitalProjectType, CAPITAL_PROJECT_TYPES } from "../capex/types";
import { LEGACY_CONSTRUCTION_COST_POLICY, resolveProjectBudget, type ConstructionCostPolicyInput } from "../capex/projectLifecycle";
import { FINANCE_PARAMETERS_V1, FinanceParameters, financeParametersForTurn } from "../finance/parameters";
import { deriveMarketReferencePrices } from "../market/destinationPricing";
import { CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS, DestinationMarketPriceCoefficientTable } from "../market/destinationPricingParameters";
import { DemandMarketId, MarketQuarterResult, Product } from "../market/types";
import { UsdPerHosoEqKg } from "../core/units";
import {
  resolveAllOperatingCostIndices,
  resolveConstructionCostIndex,
  resolveConstructionCostPolicy,
  resolveRawPriceCaptureIndex,
} from "../scenario/costIndex";
import { ConstructionCostPolicyId, OperatingCostIndexKey, ScenarioDefinition } from "../scenario/types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** 将来値・当期値のいずれについても「確定値でないもの」を明示するための包み。 */
export interface ProjectedValue<T> {
  /** 取得できた場合のみ設定される。取得できない場合は undefined（捏造しない）。 */
  readonly value?: T;
  /** true = 推定・実測が得られた。false = このTurnでは取得できない（欠損）。 */
  readonly isEstimate: boolean;
}

/** 商品別の実効変動費（限界利益の推定に必要な値。指数適用後）。 */
export interface ProductUnitEconomics {
  readonly factoryUtilityVariableUsdPerTon: number;
  readonly sellingLogisticsUsdPerTon: number;
  readonly reworkCostUsdPerTon: number;
}

export interface TurnEconomicsProjection {
  readonly turn: number;
  /** finance / operatingCostInflation / rawMarketPricing / 建設費方式の合成版数。 */
  readonly parametersVersion: string;
  /** 指数適用後の実効 FinanceParameters（Engineが実際に使う値と同一）。 */
  readonly financeParameters: FinanceParameters;
  /** 全キーぶんの費用指数（未宣言シナリオでは全て 1.00）。 */
  readonly operatingCostIndices: Readonly<Record<OperatingCostIndexKey, number>>;
  /** ベトナム国内原料市場の価格捕捉指数（未宣言時 1.00）。 */
  readonly rawPriceCaptureIndex: number;
  readonly constructionCostPolicy: ConstructionCostPolicyId;
  readonly constructionCostIndex: number;
  /**
   * 案件種別ごとの必要工事費。
   * legacy policy では standardBudgetUsd と同値、indexed policy では
   * standardBudgetUsd × constructionCostIndex。Engineの承認額計算と同じ関数
   * （resolveProjectBudget）を通しているため、値が乖離することはない。
   */
  readonly indexedRequiredProjectCostByType: Readonly<Record<CapitalProjectType, number>>;
  /** 当Turnの市場×商品の基準販売価格（marketResult が渡された場合のみ）。 */
  readonly currentBasePriceByMarketProduct: ProjectedValue<
    Readonly<Record<DemandMarketId, Readonly<Record<Product, UsdPerHosoEqKg>>>>
  >;
  /** 当Turnのベトナム国内原料価格（marketResult が渡された場合のみ）。将来値は返さない。 */
  readonly currentRawMaterialPrice: ProjectedValue<UsdPerHosoEqKg>;
  readonly unitEconomics: Readonly<Record<Product, ProductUnitEconomics>>;
}

export interface BuildTurnEconomicsProjectionInput {
  readonly definition: ScenarioDefinition;
  readonly turn: number;
  /** 省略時は FINANCE_PARAMETERS_V1（＝Engineが使う既定の基準単価）。 */
  readonly baseFinanceParameters?: FinanceParameters;
  /** 省略時は CAPEX_PARAMETERS_V1。 */
  readonly capexParameters?: CapexParameters;
  /**
   * 当Turnの市場清算結果。渡された場合だけ基準販売価格・原料価格を載せる。
   * 渡さない（＝まだ清算していない・将来Turnである）場合は isEstimate:false の
   * 欠損値になる。将来値を推測して埋めることはしない。
   */
  readonly marketResult?: MarketQuarterResult;
  readonly destinationMarketPriceCoefficients?: DestinationMarketPriceCoefficientTable;
}

/**
 * Turn別の経済前提を1つの読み取り専用構造へまとめる。
 * 純関数であり、state を持たず、乱数・時刻に依存しない（決定論）。
 */
export function buildTurnEconomicsProjection(input: BuildTurnEconomicsProjectionInput): TurnEconomicsProjection {
  const { definition, turn } = input;
  const baseFinance = input.baseFinanceParameters ?? FINANCE_PARAMETERS_V1;
  const capexParams = input.capexParameters ?? CAPEX_PARAMETERS_V1;

  const operatingCostIndices = resolveAllOperatingCostIndices(definition, turn);
  const financeParameters = financeParametersForTurn(baseFinance, operatingCostIndices);
  const rawPriceCaptureIndex = resolveRawPriceCaptureIndex(definition, turn);
  const constructionCostPolicy = resolveConstructionCostPolicy(definition);
  const constructionCostIndex = resolveConstructionCostIndex(definition, turn);

  const costPolicy: ConstructionCostPolicyInput =
    constructionCostPolicy === "legacy-requested-cost"
      ? LEGACY_CONSTRUCTION_COST_POLICY
      : { policy: constructionCostPolicy, constructionCostIndex };

  const indexedRequiredProjectCostByType = {} as Record<CapitalProjectType, number>;
  for (const projectType of CAPITAL_PROJECT_TYPES) {
    const template = capexParams.templatesByType[projectType];
    // Engineの承認額計算と同じ関数を通す（式を二重実装しない）。
    indexedRequiredProjectCostByType[projectType] = resolveProjectBudget(template, undefined, costPolicy).indexedRequiredProjectCostUsd;
  }

  const currentBasePriceByMarketProduct: TurnEconomicsProjection["currentBasePriceByMarketProduct"] =
    input.marketResult !== undefined
      ? {
          value: deriveMarketReferencePrices(
            input.marketResult,
            input.destinationMarketPriceCoefficients ?? CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
          ),
          isEstimate: true,
        }
      : { isEstimate: false };

  const currentRawMaterialPrice: ProjectedValue<UsdPerHosoEqKg> =
    input.marketResult !== undefined
      ? { value: input.marketResult.vietnamDomestic.price, isEstimate: true }
      : { isEstimate: false };

  const unitEconomics = {} as Record<Product, ProductUnitEconomics>;
  for (const product of PRODUCTS) {
    unitEconomics[product] = {
      factoryUtilityVariableUsdPerTon: financeParameters.manufacturing.factoryUtilityVariableUsdPerTon,
      sellingLogisticsUsdPerTon: financeParameters.sellingGeneralAdmin.sellingLogisticsUsdPerTon,
      reworkCostUsdPerTon: financeParameters.manufacturing.reworkCostUsdPerTon,
    };
  }

  return {
    turn,
    parametersVersion: buildParametersVersion(definition, financeParameters, constructionCostPolicy),
    financeParameters,
    operatingCostIndices,
    rawPriceCaptureIndex,
    constructionCostPolicy,
    constructionCostIndex,
    indexedRequiredProjectCostByType,
    currentBasePriceByMarketProduct,
    currentRawMaterialPrice,
    unitEconomics,
  };
}

function buildParametersVersion(
  definition: ScenarioDefinition,
  financeParameters: FinanceParameters,
  constructionCostPolicy: ConstructionCostPolicyId
): string {
  const parts = [
    `finance=${financeParameters.parametersVersion}`,
    `operatingCostInflation=${definition.operatingCostInflation?.settingsId ?? "none"}`,
    `rawMarketPricing=${definition.rawMarketPricing?.settingsId ?? "none"}`,
    `constructionCostPolicy=${constructionCostPolicy}`,
  ];
  return parts.join(" / ");
}
