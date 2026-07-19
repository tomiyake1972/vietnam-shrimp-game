// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） エントリポイント

export * from "./types";
export { buildCompanyFixtures, COMPANY_LAB_COMPANY_IDS } from "./fixtures";
export { generateAutoPolicyDecision } from "./autoPolicy";
export * from "./reasonCodes";
export { EXTERNAL_PROCESSOR_DEMAND_ASSUMPTIONS_V1, REFERENCE_WORLD_CONSUMPTION_TONS } from "./parameters";
export { calculateExternalProcessorIntent } from "./externalDemand";
export { targetPremium, minimumAcceptablePremium, orderQuantityFactor, REDUCED_ORDER_FLOOR_FACTOR } from "./premiumPolicy";
export type { ExternalProcessorDemandAssumptions, ExternalProcessorDemandInput } from "./externalDemand";
export {
  initializeCompanyLab,
  advanceCompanyLabQuarter,
  buildCompanyOwnState,
  buildPublicMarketInfo,
  runCompanyLabWithAutoPolicyForAllCompanies,
  findScenarioDefinitionForCompanyLab,
} from "./runner";
export type { CompanyLabInitResult } from "./runner";
