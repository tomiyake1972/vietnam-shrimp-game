// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） エントリポイント

export * from "./types";
export { buildCompanyFixtures, COMPANY_LAB_COMPANY_IDS } from "./fixtures";
export { generateAutoPolicyDecision } from "./autoPolicy";
export * from "./reasonCodes";
export { COMPANY_LAB_RAW_MATERIALS_PARAMETERS } from "./parameters";
export {
  initializeCompanyLab,
  advanceCompanyLabQuarter,
  buildCompanyOwnState,
  buildPublicMarketInfo,
  runCompanyLabWithAutoPolicyForAllCompanies,
  findScenarioDefinitionForCompanyLab,
} from "./runner";
export type { CompanyLabInitResult } from "./runner";
