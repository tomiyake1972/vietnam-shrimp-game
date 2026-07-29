// ShrimpX V2 — Phase SAI-1.5: 調整しやすい構造（§10）— 設定値の一覧化
//
// 【方針】圧力値・閾値をここへ重複記載しない。実際にAI本体・エンジンが使っている
// 設定オブジェクト（STANDARD_AI_PARAMETERS_V1・FINANCING_PARAMETERS_V1・
// FINANCE_PARAMETERS_V1）をそのままimportし、その場で読み取って一覧化するだけ。
// 値そのものの二重管理は発生しない（このファイルを変更しても実際の挙動は
// 一切変わらない＝表示専用であることが構造的に保証される）。

import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { FINANCING_PARAMETERS_V1 } from "../../../financing/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../../finance/parameters";

export interface ConfigSettingRow {
  readonly file: string;
  readonly field: string;
  readonly unit: string;
  readonly currentValue: string;
}

export function buildConfigSettingRows(): ConfigSettingRow[] {
  const rows: ConfigSettingRow[] = [];
  const p = STANDARD_AI_PARAMETERS_V1;
  const F = "app/lib/v2/companyLab/standardAi/parameters.ts（STANDARD_AI_PARAMETERS_V1）";
  const push = (field: string, unit: string, value: unknown) => rows.push({ file: F, field, unit, currentValue: String(value) });

  push("finishedGoodsTargetQuarters", "四半期", p.finishedGoodsTargetQuarters);
  push("rawMaterialTargetQuarters", "四半期", p.rawMaterialTargetQuarters);
  push("inventoryCorrectionDamping", "Ratio0to1", p.inventoryCorrectionDamping);
  push("excessInventoryRatioForDiscount", "Ratio(倍)", p.excessInventoryRatioForDiscount);
  push("maxDiscountRatioForExcessStock", "Ratio0to1", p.maxDiscountRatioForExcessStock);
  push("highUtilizationRatioForNoDiscount", "Ratio0to1", p.highUtilizationRatioForNoDiscount);
  push("sustainedShortageQuarterThreshold", "四半期", p.sustainedShortageQuarterThreshold);
  push("sustainedExcessQuarterThreshold", "四半期", p.sustainedExcessQuarterThreshold);
  push("maxOvertimeRateForTransientShortage", "Ratio0to1", p.maxOvertimeRateForTransientShortage);
  push("maxTemporaryRatioForTransientShortage", "Ratio0to1", p.maxTemporaryRatioForTransientShortage);
  push("regularHeadcountAdjustmentDamping", "Ratio0to1", p.regularHeadcountAdjustmentDamping);
  push("cashBufferQuarters", "四半期", p.cashBufferQuarters);
  push("voluntaryPrepaymentMultiple", "倍", p.voluntaryPrepaymentMultiple);
  push("minimumCashBufferFloorUsd", "Usd", p.minimumCashBufferFloorUsd);
  push("desiredTermQuarters", "四半期", p.desiredTermQuarters);
  push("defaultExpectedRawPriceUsdPerKg", "UsdPerHosoEqKg", p.defaultExpectedRawPriceUsdPerKg);
  push("typicalTemporaryHeadcountRatio", "Ratio0to1", p.typicalTemporaryHeadcountRatio);
  push("typicalUtilizationForCashEstimate", "Ratio0to1", p.typicalUtilizationForCashEstimate);
  push("capexSustainedUtilizationThreshold", "Ratio0to1", p.capexSustainedUtilizationThreshold);
  push("capexCurrentShortfallRatioThreshold", "Ratio(倍)", p.capexCurrentShortfallRatioThreshold);
  push("capexCashSafetyMultiple", "倍", p.capexCashSafetyMultiple);
  push("capexMaxLoanToSizeRatio", "倍", p.capexMaxLoanToSizeRatio);
  push("expectedAquacultureHarvestRatio", "Ratio0to1", p.expectedAquacultureHarvestRatio);
  push("aquacultureIntensity", "Ratio0to1", p.aquacultureIntensity);
  push("bioSecurityLevel", "Ratio0to1", p.bioSecurityLevel);
  push("importMixRatio", "Ratio0to1", p.importMixRatio);
  push("minDomesticPurchaseRatioOfBase", "Ratio0to1", p.minDomesticPurchaseRatioOfBase);
  push("maxAquacultureShareOfRequirement", "Ratio0to1", p.maxAquacultureShareOfRequirement);
  push("cashConstrainedProcurementDampingAtSeverePressure", "Ratio0to1", p.cashConstrainedProcurementDampingAtSeverePressure);
  push("severeCashPressureThreshold", "Ratio0to1", p.severeCashPressureThreshold);

  const G = "app/lib/v2/financing/parameters.ts（FINANCING_PARAMETERS_V1、ゲームルール側）";
  rows.push({ file: G, field: "liquidity.severeArrearsRatioThreshold", unit: "Ratio0to1", currentValue: String(FINANCING_PARAMETERS_V1.liquidity.severeArrearsRatioThreshold) });
  rows.push({
    file: G,
    field: "liquidity.paymentDefaultConsecutiveQuartersThreshold",
    unit: "四半期",
    currentValue: String(FINANCING_PARAMETERS_V1.liquidity.paymentDefaultConsecutiveQuartersThreshold),
  });
  rows.push({ file: G, field: "covenant.minEquityRatio", unit: "Ratio0to1", currentValue: String(FINANCING_PARAMETERS_V1.covenant.minEquityRatio) });
  rows.push({ file: G, field: "covenant.maxDebtToAssetsRatio", unit: "Ratio0to1", currentValue: String(FINANCING_PARAMETERS_V1.covenant.maxDebtToAssetsRatio) });
  rows.push({ file: G, field: "covenant.minInterestCoverageRatio", unit: "倍", currentValue: String(FINANCING_PARAMETERS_V1.covenant.minInterestCoverageRatio) });

  const H = "app/lib/v2/finance/parameters.ts（FINANCE_PARAMETERS_V1、ゲームルール側・固定費）";
  rows.push({ file: H, field: "labor.regularWorkerSalaryUsdPerQuarter", unit: "Usd/人/四半期", currentValue: String(FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter) });
  rows.push({ file: H, field: "sellingGeneralAdmin.salesForceSalaryUsdPerQuarter", unit: "Usd/人/四半期", currentValue: String(FINANCE_PARAMETERS_V1.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter) });
  rows.push({ file: H, field: "sellingGeneralAdmin.procurementSalaryUsdPerQuarter", unit: "Usd/人/四半期", currentValue: String(FINANCE_PARAMETERS_V1.sellingGeneralAdmin.procurementSalaryUsdPerQuarter) });
  rows.push({ file: H, field: "manufacturing.factoryFixedCostUsdPerQuarter", unit: "Usd/工場/四半期", currentValue: String(FINANCE_PARAMETERS_V1.manufacturing.factoryFixedCostUsdPerQuarter) });
  rows.push({ file: H, field: "sellingGeneralAdmin.adminFixedUsdPerQuarter", unit: "Usd/社/四半期", currentValue: String(FINANCE_PARAMETERS_V1.sellingGeneralAdmin.adminFixedUsdPerQuarter) });

  rows.push({
    file: "app/lib/v2/companyLab/autoPolicy.ts（ARCHETYPE_PROFILES、比較対象＝標準AIでは不使用。モジュール非公開のためこの表からは直接読み取れず、コード閲覧で確認）",
    field: "sourcingMix（会社別、archetype差別化の例。標準AIはimportMixRatio等を全社一律で使うため、この会社間差は標準AIでは再現しない）",
    unit: "Ratio0to1（domestic/import/aquaculture）",
    currentValue: "参照: autoPolicy.ts内 ARCHETYPE_PROFILES（BAL 0.60/0.15/0.25、MASS 0.75/0.15/0.10、JPQ 0.60/0.10/0.30、VAP 0.50/0.25/0.25、CONSV 0.70/0.10/0.20）",
  });

  return rows;
}

export const CONFIG_LOCATIONS_SUMMARY = [
  "シナリオ設定: app/lib/v2/scenario/definitions/*.ts（イベント定義）、companyLab呼び出し側はCompanyLabConfig.scenarioId/mode/seedで選択。",
  "会社初期条件: app/lib/v2/companyLab/fixtures.ts（工場能力・Worker基準・養殖能力・営業/調達人員・初期原料ロット・商品経済性）、app/lib/v2/finance/initialState.ts（現金・売掛金・借入金・資本金）、app/lib/v2/companyLab/initialContracts.ts（初期未履行契約）。",
  "ゲームルール・経済パラメータ: app/lib/v2/finance/parameters.ts（固定費・給与単価）、app/lib/v2/financing/parameters.ts（与信・covenant・延滞・緊急融資閾値）、app/lib/v2/market/destinationPricingParameters.ts（市場別価格係数）。",
  "AI圧力計算・閾値・判断優先順位: app/lib/v2/companyLab/standardAi/pressures.ts（計算式）、app/lib/v2/companyLab/standardAi/parameters.ts（STANDARD_AI_PARAMETERS_V1、全閾値の単一箇所）。",
  "AI状況判断ポリシー（ドメイン別ロジック）: app/lib/v2/companyLab/standardAi/decision/{sales,production,procurement,labor,finance,capex}.ts。",
];
