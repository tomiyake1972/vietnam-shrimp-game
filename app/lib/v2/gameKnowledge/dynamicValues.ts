// ShrimpX V2 — Shared Game Knowledge Registry: 動的値の解決（実装指示§5）
//
// 【数値をKnowledge文へhardcodeしない】変わり得る値（労務係数・営業能力曲線・
// AR/APサイト・輸入リードタイム等）は、Knowledgeの説明文へ直接書かず
// `{{key}}` として残し、実行時に **現在のparameter** から解決する。
// これにより、parameterを変えたときにKnowledgeが自動的に追随し、
// 「Manualには3.0と書いてあるが実装は2.5」という乖離が構造的に起こらない。
//
// 【捏造しない】解決できないキーは値を作らず、明示的に「取得できませんでした」と書く。

import { SALES_PARAMETERS_V1, SalesParameters } from "../sales/parameters";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "../production/parameters";
import { FINANCE_PARAMETERS_V1, FinanceParameters } from "../finance/parameters";
import { RAW_MATERIALS_PARAMETERS_V1, RawMaterialsParameters } from "../rawMaterials/parameters";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "../companyLab/standardAi/parameters";
import { companySalesOrganizationCapacity, SALES_CAPACITY_MODEL_PER_MARKET } from "../sales/salesCapacityModel";

export interface GameKnowledgeParameterSources {
  readonly sales: SalesParameters;
  readonly production: ProductionParameters;
  readonly finance: FinanceParameters;
  readonly rawMaterials: RawMaterialsParameters;
  readonly standardAi: StandardAiParameters;
}

export const DEFAULT_GAME_KNOWLEDGE_PARAMETERS: GameKnowledgeParameterSources = {
  sales: SALES_PARAMETERS_V1,
  production: PRODUCTION_PARAMETERS_V1,
  finance: FINANCE_PARAMETERS_V1,
  rawMaterials: RAW_MATERIALS_PARAMETERS_V1,
  standardAi: STANDARD_AI_PARAMETERS_V1,
};

const UNRESOLVED = "(値を取得できませんでした)";

function fmt(value: number | undefined | null, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNRESOLVED;
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function quarters(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return UNRESOLVED;
  return value === 0 ? "0四半期（当四半期中）" : `${value}四半期`;
}

/**
 * 現在のparameterから、Knowledge説明文で使えるプレースホルダの値表を作る。
 * すべて文字列（Excelではなくプロンプトへ差し込むため、単位込みの短い表現でよい）。
 */
export function buildDynamicValueMap(sources: GameKnowledgeParameterSources = DEFAULT_GAME_KNOWLEDGE_PARAMETERS): Readonly<Record<string, string>> {
  const { sales, production, finance, rawMaterials, standardAi } = sources;
  const model = sales.salesCapacityModel ?? SALES_CAPACITY_MODEL_PER_MARKET;
  const labor = production.labor;

  const capacityAt = (h: number): string =>
    model.kind === "perMarket" ? UNRESOLVED : fmt(Math.round(companySalesOrganizationCapacity(h, model)), 0);

  return {
    // --- 営業能力（実装指示§6） ---
    salesCapacityModelKind: model.kind,
    salesCompanyBaselineCapacityTons: fmt(model.companyBaselineCapacityTons, 0),
    salesCompanyCapacityMaxIncrementTons: fmt(model.companyCapacityMaxIncrementTons, 0),
    salesCompanyCapacitySaturationHeadcount: fmt(model.companyCapacitySaturationHeadcount, 0),
    salesCapacityAt30: capacityAt(30),
    salesCapacityAt60: capacityAt(60),
    salesCapacityAt100: capacityAt(100),
    salesEffortCoefficientHoso: fmt(sales.salesEffortCoefficients.hoso),
    salesEffortCoefficientPd: fmt(sales.salesEffortCoefficients.pd),
    salesEffortCoefficientVap: fmt(sales.salesEffortCoefficients.vap),
    salesCoverageBaselineAtZeroHeadcount: fmt(sales.salesForce.baselineCoverageAtZeroHeadcount),
    salesCoverageSaturationHeadcount: fmt(sales.salesForce.coverageSaturationHeadcount, 0),
    salesFragmentationPenaltyPerExtraMarket: fmt(model.fragmentationPenaltyPerExtraMarket),

    // --- 労務（実装指示§9） ---
    regularEfficiencyPerHeadTons: fmt(labor.regularEfficiencyPerHeadTons),
    temporaryEfficiencyPerHeadTons: fmt(labor.temporaryEfficiencyPerHeadTons),
    overtimeRateCap: fmt(labor.overtimeRateCap),
    overtimeEfficiencyFactor: fmt(labor.overtimeEfficiencyFactor),
    hosoLaborCoefficient: fmt(labor.laborIntensityCoefficient.hoso),
    pdLaborCoefficient: fmt(labor.laborIntensityCoefficient.pd),
    vapLaborCoefficient: fmt(labor.laborIntensityCoefficient.vap),
    hosoEffectiveTonsPerRegularHead: fmt(labor.regularEfficiencyPerHeadTons / labor.laborIntensityCoefficient.hoso),
    pdEffectiveTonsPerRegularHead: fmt(labor.regularEfficiencyPerHeadTons / labor.laborIntensityCoefficient.pd),
    vapEffectiveTonsPerRegularHead: fmt(labor.regularEfficiencyPerHeadTons / labor.laborIntensityCoefficient.vap),

    // --- Finance / working capital（実装指示§11・§12） ---
    arCollectionQuarters: quarters(finance.workingCapital.arCollectionQuarters),
    apImportPaymentQuarters: quarters(finance.workingCapital.apImportPaymentQuarters),
    apDomesticPaymentQuarters: quarters(finance.workingCapital.apDomesticPaymentQuarters),
    shortTermInterestRatePerQuarter: fmt(finance.finance.shortTermInterestRatePerQuarter, 4),
    longTermInterestRatePerQuarter: fmt(finance.finance.longTermInterestRatePerQuarter, 4),
    incomeTaxRate: fmt(finance.finance.incomeTaxRate),

    // --- 原料調達（実装指示§13） ---
    importStandardLeadTimeTurns: fmt(rawMaterials.imports.standardLeadTimeTurns, 0),
    aquacultureHarvestLagTurns: "1",
    aquacultureUnitCostUsdPerHosoEqKg: fmt(rawMaterials.aquaculture.aquacultureUnitCostUsdPerHosoEqKg),

    // --- Standard AI 配当（実装指示§22） ---
    dividendBasePayoutRatio: fmt(standardAi.dividendBasePayoutRatio),
    dividendBasePayoutPercent: fmt(standardAi.dividendBasePayoutRatio * 100, 1),
  };
}

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

/**
 * 説明文中の `{{key}}` を現在の値で置換する。
 * entryが宣言していないキー・値表に無いキーは、値を捏造せず UNRESOLVED を入れる。
 */
export function resolveText(
  text: string,
  valueMap: Readonly<Record<string, string>>,
  declaredKeys?: readonly string[]
): { readonly text: string; readonly used: Readonly<Record<string, string>> } {
  const used: Record<string, string> = {};
  const resolved = text.replace(PLACEHOLDER, (_match, key: string) => {
    const declared = declaredKeys === undefined || declaredKeys.includes(key);
    const value = declared ? valueMap[key] : undefined;
    const out = value ?? UNRESOLVED;
    used[key] = out;
    return out;
  });
  return { text: resolved, used };
}

export const UNRESOLVED_DYNAMIC_VALUE = UNRESOLVED;
