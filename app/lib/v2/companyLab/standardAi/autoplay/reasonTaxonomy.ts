// ShrimpX V2 — Phase SAI-3A: 判断記録基盤 — reason codeの集計可能カテゴリ分類
//
// 【方針】新しいreason codeは作らない。既存の2つのregistry
// （standardAi/reasonCodes.ts の StandardAiReasonCode、companyLab/types.ts の
// CompanyReasonCode）のコード文字列をそのまま`code`として使い、本ファイルは
// 「集計・グラフ化しやすいAdjustmentCategoryへの分類表」だけを追加する。
// コード自体を増やしたり、意味を変えたりしない。

import { AdjustmentCategory } from "./schema";

/** standardAi/reasonCodes.ts の StandardAiReasonCode → AdjustmentCategory。 */
export const STANDARD_AI_REASON_CATEGORY: Readonly<Record<string, AdjustmentCategory>> = {
  CONTRACT_FULFILLMENT_PRIORITY: "market_demand_or_contract",
  FINISHED_GOODS_EXCESS: "inventory",
  CAPACITY_CONSTRAINT: "production_capacity",
  RAW_MATERIAL_SHORTAGE: "raw_material",
  PROCUREMENT_INCREASED_FOR_SHORTAGE: "raw_material",
  PROCUREMENT_REDUCED_FOR_EXCESS: "inventory",
  PROCUREMENT_CASH_CONSTRAINED: "cash_constraint",
  PRICE_REDUCTION_FOR_EXCESS_STOCK: "inventory",
  SALES_REDUCED_FOR_SUPPLY_LIMIT: "sales_effort_capacity",
  LOW_ORDER_BOOK_PREMIUM_FLOOR: "market_demand_or_contract",
  SALES_HEADCOUNT_INSUFFICIENT_TOTAL: "sales_effort_capacity",
  VAP_MIX_INCREASES_SALES_EFFORT_NEED: "sales_effort_capacity",
  WORKER_CAPACITY_SHORTAGE: "labor",
  OVERTIME_TEMP_FOR_TRANSIENT_SHORTAGE: "labor",
  HIRING_FOR_SUSTAINED_SHORTAGE: "labor",
  HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS: "labor",
  CASH_BUFFER_SHORTAGE: "cash_constraint",
  WORKING_CAPITAL_ASSESSED: "cash_constraint",
  DEBT_REPAYMENT_SURPLUS: "cash_constraint",
  CAPEX_DEFERRED: "other",
  CAPEX_PROPOSED: "other",
  // 【SAI-5】市場・商品志向／ライフサイクル／営業基盤／供給圧力
  MARKET_ORIENTATION_APPLIED: "market_demand_or_contract",
  PRODUCT_ORIENTATION_APPLIED: "market_demand_or_contract",
  LIFECYCLE_GROWTH_PURSUED: "market_demand_or_contract",
  SALES_BASE_ADVANTAGE: "market_demand_or_contract",
  SUPPLY_PRESSURE_RETREAT: "market_demand_or_contract",
  CAPEX_DEFERRED_OVERSUPPLY: "other",
  CAPEX_RESUME_PROPOSED: "other",
  VAP_GROWTH_ENTRY: "market_demand_or_contract",
  VAP_OVERSUPPLY_RETREAT: "market_demand_or_contract",
  PD_CAPACITY_MAINTAINED: "production_capacity",
};

/** companyLab/types.ts の CompanyReasonCode → AdjustmentCategory。 */
export const COMPANY_REASON_CATEGORY: Readonly<Record<string, AdjustmentCategory>> = {
  LOW_PRICE_WON_SHARE: "market_demand_or_contract",
  SALES_FORCE_SHORTAGE: "sales_effort_capacity",
  DOMESTIC_COMPETITION_INTENSE: "market_demand_or_contract",
  RAW_MATERIAL_SHORTAGE: "raw_material",
  IMPORT_IN_TRANSIT: "raw_material",
  EQUIPMENT_CAPACITY_SHORTAGE: "production_capacity",
  LABOR_SHORTAGE: "labor",
  OVERTIME_CAP_REACHED: "labor",
  VAP_SUPPLY_INCREASE_LOWERS_PREMIUM: "market_demand_or_contract",
  PD_SUPPLY_INCREASE_LOWERS_PREMIUM: "market_demand_or_contract",
  OVER_CONTRACTED_OVERDUE: "market_demand_or_contract",
  DISEASE_HARVEST_LOSS: "raw_material",
  AQUACULTURE_HARVEST_ON_TRACK: "raw_material",
  SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY: "sales_effort_capacity",
};

/** 追加で使う、財務/信用サイドの調整カテゴリ（procurementConstraint・
 *  underwritingFrozenはFinancingQuarterResultから直接読み取るため既存コード
 *  registryを経由しない。カテゴリ名だけここで固定する）。 */
export const CASH_CONSTRAINT_CATEGORY: AdjustmentCategory = "cash_constraint";
export const BORROWING_CAPACITY_CATEGORY: AdjustmentCategory = "borrowing_capacity";
export const UNDERWRITING_CATEGORY: AdjustmentCategory = "underwriting";

export function categorizeStandardAiReasonCode(code: string): AdjustmentCategory {
  return STANDARD_AI_REASON_CATEGORY[code] ?? "other";
}

export function categorizeCompanyReasonCode(code: string): AdjustmentCategory {
  return COMPANY_REASON_CATEGORY[code] ?? "other";
}
