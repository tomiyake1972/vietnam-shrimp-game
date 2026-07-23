// ShrimpX V2 — 財務モジュール エントリポイント（Phase 8A）
//
// UI・Redis・API・生成AIから完全に独立した純粋関数群。会社ラボ
// （app/lib/v2/companyLab/runner.ts）が本モジュールをアダプターとして呼び出す。
// 既存の市場価格・契約・原料・生産・品質・信頼・納期ロジックを唯一の事業実績
// データとして使用し、財務側で販売量・生産量・廃棄量・価格を再計算しない。

export * from "./types";
export { FINANCE_PARAMETERS_V1 } from "./parameters";
export type { FinanceParameters } from "./parameters";
export { KG_PER_HOSO_EQ_TON, amountFromTonsAndUnitPrice, amountFromPlainTonsAndUsdPerKg, usdToMillions, sumUsd } from "./money";
export { INITIAL_FINANCE_FIXTURES_V1, buildInitialCompanyFinanceState, rawMaterialInventoryValueUsd } from "./initialState";
export type { InitialFinanceFixture } from "./initialState";
export { closeFinancialQuarter } from "./quarterClose";
export type {
  CompanyQuarterBusinessActuals,
  ContractTermActual,
  FulfillmentUsageActual,
  ProductionBatchActual,
  QuarterCloseOutput,
} from "./quarterClose";
export { buildCompanyQuarterBusinessActuals } from "./companyLabAdapter";
export type { CompanyActualsSource } from "./companyLabAdapter";
export { computeExistingAssetDepreciationUsd } from "./depreciation";
export type { ExistingAssetDepreciation } from "./depreciation";
