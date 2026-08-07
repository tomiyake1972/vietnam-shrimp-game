// ShrimpX V2 — 会社ラボ専用永続化モデル ランタイム検証（Phase 8C-1）
//
// decode時に「as CompanyLabPersistedStateV1」だけで済ませず、必ずランタイムで
// 検証する。app/lib/v2/persistence/schema.tsと同じ設計方針（手書きの検証プリミティブ、
// ブランド型はcore/units.tsのスマートコンストラクタを必ず経由して復元、PeriodV2は
// core/period.tsのparsePeriodを経由）を踏襲するが、会社ラボの型・レイヤーには
// 依存しないよう本モジュールとして独立させる（persistence/schema.tsの非公開ヘルパーは
// 再利用せず、同じ設計思想で会社ラボ専用に書き直す）。
//
// 【検証範囲についての明示的な設計判断】
//   会社ラボのCompanyLabRuntimeSnapshot・CompanyQuarterRecordは、Phase1〜8Bの
//   10以上のドメインモジュール（market/scenario/sales/rawMaterials/production/
//   quality/finance/financing/capex/turn）の型を再帰的に埋め込んでおり、
//   その全リーフフィールドを既存のfinance/capex用コード同様に1つずつ手書きで
//   検証し直すと、本Phaseの主目的（保存モデル・Repository・原子コミット基盤）に
//   不釣り合いな量のコードになる。そのため、本モジュールでは:
//     - 明示的に要求されている拒否ケース（非オブジェクト・不正なschema version・
//       必須フィールド欠落・revisionの不正・不正なperiod・不正な日時文字列・
//       historyを含む不正なランタイムスナップショット・処理前/処理後スナップショット
//       欠落・turnId欠落・turn不正・labId不一致・履歴エントリとcurrentの矛盾）は
//       すべて実際に検証する。
//     - ラウンドトリップテスト（§8-2）で明示的に列挙されている中核エンティティ
//       （契約バックログ・原料ロット・完成品ロット・売掛金/買掛金・借入金/未払利息・
//       設備投資案件・品質/信頼状態）は、finance/financing/capex/persistence/schema.ts
//       と同水準の実質的な検証（型・範囲・状態別整合性）を行う。
//     - シナリオ定義（ScenarioDefinition、静的な巨大ネスト構造）・CompanyQuarterRecord
//       内部の各種結果オブジェクト（marketResult・salesRecord・financialResults等、
//       いずれもエンジンの純粋計算が生成する、信頼できる生成元を持つデータ）は、
//       オブジェクト/配列としての形状と主要キーの存在確認にとどめ、リーフの
//       ブランド型再構成までは行わない（既存の信頼できるエンジン出力をラウンド
//       トリップさせるだけであり、ユーザー入力境界ほどの厳格さは本Phaseでは
         // 必要ないと判断。詳細はPhase 8C-1完了報告§Eの設計判断として明記する）。

import { PeriodV2, parsePeriod } from "../../core/period";
import { HosoEqTons, Ratio, hosoEqTons, ratio, score0to100, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { COUNTRY_IDS, CountryId, DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../market/types";
import { CompanyId, ContractStatus, SalesContract } from "../../sales/types";
import { RawMaterialLot, RawMaterialLotStatus, RawMaterialSource } from "../../rawMaterials/types";
import { FinishedGoodsLot, FinishedGoodsLotStatus, ProductionBatchRawMaterialConsumption } from "../../production/types";
import {
  CompanyFactoryProductRampState,
  CompanyMarketTrustState,
  CompanyProductQualityState,
  QualityReliabilityState,
} from "../../quality/types";
import { CompanyFinanceState, FinishedGoodsCostLedgerEntry, FinishedGoodsUnitCostBreakdown, PayableRecord, PayableSource, ReceivableRecord } from "../../finance/types";
import {
  CompanyFinancingHistory,
  CompanyFinancingState,
  FinancialHealthTier,
  LoanPortfolio,
  LoanRecord,
  LoanStatus,
  LoanType,
  RepaymentMethod,
} from "../../financing/types";
import {
  CAPITAL_PROJECT_STATUSES,
  CAPITAL_PROJECT_TYPES,
  CapitalProject,
  CapitalProjectPortfolio,
  CapitalProjectStatus,
  CapitalProjectType,
  CompanyCapexState,
} from "../../capex/types";
import { ScenarioMode, ScenarioState } from "../../scenario/types";
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyQuarterRecord, Sai5FeatureFlags } from "../types";
import type { WorkforceState } from "../workforce";
import type { SalesForceHiringState } from "../salesForceHiring";
import type { ConsumerMarketCarryState, ConsumerMarketCarryStateTable } from "../../market/consumerInventory";
import type { SalesBaseState } from "../salesBase";
import type { MarketEvolutionState, SupplyPressureDefinition } from "../marketEvolution";
import {
  CompanyLabDraftEnvelope,
  CompanyLabPersistedCurrentState,
  CompanyLabPersistedStateMetadata,
  CompanyLabPersistedStateV1,
  CompanyLabProductionRuntimeSnapshot,
  CompanyLabQuarterHistoryEntry,
  CompanyLabRuntimeSnapshot,
  CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
} from "./types";
import { CompanyLabPersistedStateValidationError, UnsupportedCompanyLabPersistedStateVersionError } from "./errors";

const EPSILON = 1e-6;

// ---------------------------------------------------------------------
// 0. 汎用ヘルパー（app/lib/v2/persistence/schema.tsと同じ設計思想の独立実装）
// ---------------------------------------------------------------------

function fail(path: string, message: string): never {
  throw new CompanyLabPersistedStateValidationError(message, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, "オブジェクトである必要があります");
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "配列である必要があります");
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "文字列である必要があります");
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const s = requireString(value, path);
  if (s.length === 0) fail(path, "空文字であってはなりません");
  return s;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    fail(path, "有限数である必要があります（NaN・Infinity・非number不可）");
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  const n = requireFiniteNumber(value, path);
  if (!Number.isInteger(n) || n < 0) fail(path, "0以上の整数である必要があります");
  return n;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "真偽値である必要があります");
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const s = requireString(value, path);
  if (!(allowed as readonly string[]).includes(s)) {
    fail(path, `次のいずれかである必要があります: ${allowed.join(", ")}（受け取った値: ${JSON.stringify(s)}）`);
  }
  return s as T;
}

function requirePeriod(value: unknown, path: string): PeriodV2 {
  const s = requireString(value, path);
  try {
    return parsePeriod(s);
  } catch {
    return fail(path, `PeriodV2として不正です（"YYYYQn"形式である必要があります）。受け取った値: ${JSON.stringify(s)}`);
  }
}

function requireOptionalPeriod(value: unknown, path: string): PeriodV2 | undefined {
  return value === undefined ? undefined : requirePeriod(value, path);
}

function requireIsoTimestamp(value: unknown, path: string): string {
  const s = requireNonEmptyString(value, path);
  if (Number.isNaN(Date.parse(s))) {
    fail(path, `ISO 8601形式の日時として解釈できません。受け取った値: ${JSON.stringify(s)}`);
  }
  return s;
}

function wrapUnitConstructor<T>(ctor: (n: number) => T, value: unknown, path: string): T {
  const n = requireFiniteNumber(value, path);
  try {
    return ctor(n);
  } catch (e) {
    return fail(path, e instanceof Error ? e.message : "単位の値として不正です");
  }
}

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
const CONTRACT_STATUSES: readonly ContractStatus[] = ["open", "partiallyFulfilled", "fulfilled", "overdue", "cancelled"];
const LOT_STATUSES: readonly RawMaterialLotStatus[] = ["available", "inTransitImport", "growingAquaculture", "consumed", "expired"];
const LOT_SOURCES: readonly RawMaterialSource[] = ["domestic", "import", "aquaculture"];
const FG_LOT_STATUSES: readonly FinishedGoodsLotStatus[] = ["available", "allocated", "expired"];
const PAYABLE_SOURCES: readonly PayableSource[] = ["importRawMaterial"];
const LOAN_TYPES: readonly LoanType[] = ["workingCapital", "termLoan", "emergency"];
const REPAYMENT_METHODS: readonly RepaymentMethod[] = ["bulletAtMaturity", "equalPrincipal"];
const LOAN_STATUSES: readonly LoanStatus[] = ["current", "delinquent", "closed"];
const FINANCIAL_HEALTH_TIERS: readonly FinancialHealthTier[] = [
  "healthy",
  "watch",
  "stressed",
  "covenantBreach",
  "paymentArrears",
  "insolvent",
  "paymentDefault",
];
const SCENARIO_MODES: readonly ScenarioMode[] = ["canonical", "variation"];
/** 【監査指摘E】config.sai5.supplyPressureDefinition の復元に使う許容値。 */
const SUPPLY_PRESSURE_DEFINITIONS: readonly SupplyPressureDefinition[] = [
  "raw_target_demand",
  "addressable_demand",
  "neutral_baseline",
  "completed_supply",
];
const COMPANY_ARCHETYPES: readonly string[] = ["balanced", "massMarket", "japanQuality", "vapSpecialist", "conservative"];

// ---------------------------------------------------------------------
// 1. 契約・原料ロット・完成品ロット（ラウンドトリップ§8-2の中核エンティティ）
// ---------------------------------------------------------------------

function validateSalesContract(raw: unknown, path: string): SalesContract {
  const obj = requireObject(raw, path);
  const contractId = requireNonEmptyString(obj.contractId, `${path}.contractId`);
  const companyId = requireNonEmptyString(obj.companyId, `${path}.companyId`);
  const market: DemandMarketId = requireEnum(obj.market, DEMAND_MARKET_IDS, `${path}.market`);
  const product: Product = requireEnum(obj.product, PRODUCTS, `${path}.product`);
  const contractedPeriod = requirePeriod(obj.contractedPeriod, `${path}.contractedPeriod`);
  const dueDate = requirePeriod(obj.dueDate, `${path}.dueDate`);
  const originalQuantity = wrapUnitConstructor(hosoEqTons, obj.originalQuantity, `${path}.originalQuantity`);
  const outstandingQuantity = wrapUnitConstructor(hosoEqTons, obj.outstandingQuantity, `${path}.outstandingQuantity`);
  if (unwrapUnit(outstandingQuantity) > unwrapUnit(originalQuantity) + EPSILON) {
    fail(`${path}.outstandingQuantity`, "originalQuantityを超えてはなりません");
  }
  const unitPrice = wrapUnitConstructor(usdPerHosoEqKg, obj.unitPrice, `${path}.unitPrice`);
  const status = requireEnum(obj.status, CONTRACT_STATUSES, `${path}.status`);
  let costSnapshot: SalesContract["costSnapshot"];
  if (obj.costSnapshot !== undefined) {
    const cs = requireObject(obj.costSnapshot, `${path}.costSnapshot`);
    costSnapshot = {
      expectedRawMaterialPriceUsdPerHosoEqKg: requireFiniteNumber(cs.expectedRawMaterialPriceUsdPerHosoEqKg, `${path}.costSnapshot.expectedRawMaterialPriceUsdPerHosoEqKg`),
      expectedProcessingCostUsdPerHosoEqKg: requireFiniteNumber(cs.expectedProcessingCostUsdPerHosoEqKg, `${path}.costSnapshot.expectedProcessingCostUsdPerHosoEqKg`),
      minimumAcceptablePriceUsdPerHosoEqKg: requireFiniteNumber(cs.minimumAcceptablePriceUsdPerHosoEqKg, `${path}.costSnapshot.minimumAcceptablePriceUsdPerHosoEqKg`),
      expectedContributionMarginUsdPerHosoEqKg: requireFiniteNumber(cs.expectedContributionMarginUsdPerHosoEqKg, `${path}.costSnapshot.expectedContributionMarginUsdPerHosoEqKg`),
    };
  }
  return { contractId, companyId, market, product, contractedPeriod, dueDate, originalQuantity, outstandingQuantity, unitPrice, status, ...(costSnapshot !== undefined ? { costSnapshot } : {}) };
}

function validateRawMaterialLot(raw: unknown, path: string): RawMaterialLot {
  const obj = requireObject(raw, path);
  const lotId = requireNonEmptyString(obj.lotId, `${path}.lotId`);
  const companyId = requireNonEmptyString(obj.companyId, `${path}.companyId`);
  const source: RawMaterialSource = requireEnum(obj.source, LOT_SOURCES, `${path}.source`);
  const originCountry: CountryId = requireEnum(obj.originCountry, COUNTRY_IDS, `${path}.originCountry`);
  const inboundPeriod = requirePeriod(obj.inboundPeriod, `${path}.inboundPeriod`);
  const originalQuantity = wrapUnitConstructor(hosoEqTons, obj.originalQuantity, `${path}.originalQuantity`);
  const remainingQuantity = wrapUnitConstructor(hosoEqTons, obj.remainingQuantity, `${path}.remainingQuantity`);
  if (unwrapUnit(remainingQuantity) > unwrapUnit(originalQuantity) + EPSILON) {
    fail(`${path}.remainingQuantity`, "originalQuantityを超えてはなりません");
  }
  const unitCost = wrapUnitConstructor(usdPerHosoEqKg, obj.unitCost, `${path}.unitCost`);
  const availableFromPeriod = requirePeriod(obj.availableFromPeriod, `${path}.availableFromPeriod`);
  const expiryPeriod = requireOptionalPeriod(obj.expiryPeriod, `${path}.expiryPeriod`);
  const status: RawMaterialLotStatus = requireEnum(obj.status, LOT_STATUSES, `${path}.status`);
  const pendingAquacultureIntensity: Ratio | undefined =
    obj.pendingAquacultureIntensity === undefined ? undefined : wrapUnitConstructor(ratio, obj.pendingAquacultureIntensity, `${path}.pendingAquacultureIntensity`);
  const pendingBioSecurityLevel: Ratio | undefined =
    obj.pendingBioSecurityLevel === undefined ? undefined : wrapUnitConstructor(ratio, obj.pendingBioSecurityLevel, `${path}.pendingBioSecurityLevel`);
  const pendingPlannedStockingQuantity: HosoEqTons | undefined =
    obj.pendingPlannedStockingQuantity === undefined ? undefined : wrapUnitConstructor(hosoEqTons, obj.pendingPlannedStockingQuantity, `${path}.pendingPlannedStockingQuantity`);
  return {
    lotId,
    companyId,
    source,
    originCountry,
    inboundPeriod,
    originalQuantity,
    remainingQuantity,
    unitCost,
    availableFromPeriod,
    ...(expiryPeriod !== undefined ? { expiryPeriod } : {}),
    status,
    ...(pendingAquacultureIntensity !== undefined ? { pendingAquacultureIntensity } : {}),
    ...(pendingBioSecurityLevel !== undefined ? { pendingBioSecurityLevel } : {}),
    ...(pendingPlannedStockingQuantity !== undefined ? { pendingPlannedStockingQuantity } : {}),
  };
}

function validateProductionBatchRawMaterialConsumption(raw: unknown, path: string): ProductionBatchRawMaterialConsumption {
  const obj = requireObject(raw, path);
  return {
    lotId: requireNonEmptyString(obj.lotId, `${path}.lotId`),
    quantity: wrapUnitConstructor(hosoEqTons, obj.quantity, `${path}.quantity`),
    unitCost: wrapUnitConstructor(usdPerHosoEqKg, obj.unitCost, `${path}.unitCost`),
    originCountry: requireEnum(obj.originCountry, COUNTRY_IDS, `${path}.originCountry`),
  };
}

function validateFinishedGoodsLot(raw: unknown, path: string): FinishedGoodsLot {
  const obj = requireObject(raw, path);
  const lotId = requireNonEmptyString(obj.lotId, `${path}.lotId`);
  const companyId = requireNonEmptyString(obj.companyId, `${path}.companyId`);
  const factoryId = requireNonEmptyString(obj.factoryId, `${path}.factoryId`);
  const product: Product = requireEnum(obj.product, PRODUCTS, `${path}.product`);
  const producedPeriod = requirePeriod(obj.producedPeriod, `${path}.producedPeriod`);
  const originalQuantity = wrapUnitConstructor(hosoEqTons, obj.originalQuantity, `${path}.originalQuantity`);
  const remainingQuantity = wrapUnitConstructor(hosoEqTons, obj.remainingQuantity, `${path}.remainingQuantity`);
  if (unwrapUnit(remainingQuantity) > unwrapUnit(originalQuantity) + EPSILON) {
    fail(`${path}.remainingQuantity`, "originalQuantityを超えてはなりません");
  }
  const sourceRaw = requireArray(obj.sourceRawMaterialLots, `${path}.sourceRawMaterialLots`);
  const sourceRawMaterialLots = sourceRaw.map((s, i) => validateProductionBatchRawMaterialConsumption(s, `${path}.sourceRawMaterialLots[${i}]`));
  const countriesRaw = requireArray(obj.rawMaterialOriginCountries, `${path}.rawMaterialOriginCountries`);
  const rawMaterialOriginCountries = countriesRaw.map((c, i) => requireEnum(c, COUNTRY_IDS, `${path}.rawMaterialOriginCountries[${i}]`));
  const rawMaterialUnitCost = wrapUnitConstructor(usdPerHosoEqKg, obj.rawMaterialUnitCost, `${path}.rawMaterialUnitCost`);
  const baseProcessingCost = requireFiniteNumber(obj.baseProcessingCost, `${path}.baseProcessingCost`);
  const availableFromPeriod = requirePeriod(obj.availableFromPeriod, `${path}.availableFromPeriod`);
  const expiryPeriod = requireOptionalPeriod(obj.expiryPeriod, `${path}.expiryPeriod`);
  const status = requireEnum(obj.status, FG_LOT_STATUSES, `${path}.status`);
  // qualityInfoは【Phase 7A】のオプショナル値オブジェクト。存在する場合のみ、主要
  // フィールドの型・範囲を検証する（本Phaseの検証範囲方針により、majorIncidentId等の
  // 参照文字列までは深追いしない）。
  let qualityInfo: FinishedGoodsLot["qualityInfo"];
  if (obj.qualityInfo !== undefined) {
    const qi = requireObject(obj.qualityInfo, `${path}.qualityInfo`);
    qualityInfo = {
      qualityScore: wrapUnitConstructor(score0to100, qi.qualityScore, `${path}.qualityInfo.qualityScore`),
      downgradeRatio: wrapUnitConstructor(ratio, qi.downgradeRatio, `${path}.qualityInfo.downgradeRatio`),
      ...(qi.majorIncidentId !== undefined ? { majorIncidentId: requireString(qi.majorIncidentId, `${path}.qualityInfo.majorIncidentId`) } : {}),
      ...(qi.majorIncidentSeverity !== undefined ? { majorIncidentSeverity: requireFiniteNumber(qi.majorIncidentSeverity, `${path}.qualityInfo.majorIncidentSeverity`) } : {}),
      producedPeriod: requirePeriod(qi.producedPeriod, `${path}.qualityInfo.producedPeriod`),
    };
  }
  return {
    lotId,
    companyId,
    factoryId,
    product,
    producedPeriod,
    originalQuantity,
    remainingQuantity,
    sourceRawMaterialLots,
    rawMaterialOriginCountries,
    rawMaterialUnitCost,
    baseProcessingCost: baseProcessingCost as FinishedGoodsLot["baseProcessingCost"],
    availableFromPeriod,
    ...(expiryPeriod !== undefined ? { expiryPeriod } : {}),
    status,
    ...(qualityInfo !== undefined ? { qualityInfo } : {}),
  };
}

function validateProductionRuntimeSnapshot(raw: unknown, path: string): CompanyLabProductionRuntimeSnapshot {
  const obj = requireObject(raw, path);
  // 【重要】"history"というキーが存在すること自体を明示的に拒否する
  // （historyを含む不正なランタイムスナップショットの拒否。types.ts冒頭コメント参照）。
  if (Object.prototype.hasOwnProperty.call(obj, "history")) {
    fail(`${path}.history`, "ランタイムスナップショットのproductionStateにhistoryを含めることは許可されていません（四半期履歴の再帰的複製を防ぐため、意図的に除外されるフィールドです）");
  }
  const currentPeriod = requirePeriod(obj.currentPeriod, `${path}.currentPeriod`);
  const lotsRaw = requireArray(obj.finishedGoodsLots, `${path}.finishedGoodsLots`);
  const finishedGoodsLots = lotsRaw.map((l, i) => validateFinishedGoodsLot(l, `${path}.finishedGoodsLots[${i}]`));
  return { currentPeriod, finishedGoodsLots };
}

// ---------------------------------------------------------------------
// 2. 品質・信頼状態
// ---------------------------------------------------------------------

function validateCompanyProductQualityState(raw: unknown, path: string): CompanyProductQualityState {
  const obj = requireObject(raw, path);
  return {
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    product: requireEnum(obj.product, PRODUCTS, `${path}.product`),
    qualityScore: wrapUnitConstructor(score0to100, obj.qualityScore, `${path}.qualityScore`),
  };
}

function validateCompanyMarketTrustState(raw: unknown, path: string): CompanyMarketTrustState {
  const obj = requireObject(raw, path);
  return {
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    market: requireEnum(obj.market, DEMAND_MARKET_IDS, `${path}.market`),
    customerTrustScore: wrapUnitConstructor(score0to100, obj.customerTrustScore, `${path}.customerTrustScore`),
    deliveryReliabilityScore: wrapUnitConstructor(score0to100, obj.deliveryReliabilityScore, `${path}.deliveryReliabilityScore`),
  };
}

function validateCompanyFactoryProductRampState(raw: unknown, path: string): CompanyFactoryProductRampState {
  const obj = requireObject(raw, path);
  return {
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    factoryId: requireNonEmptyString(obj.factoryId, `${path}.factoryId`),
    product: requireEnum(obj.product, PRODUCTS, `${path}.product`),
    lastQuarterProductionQuantity: wrapUnitConstructor(hosoEqTons, obj.lastQuarterProductionQuantity, `${path}.lastQuarterProductionQuantity`),
  };
}

function validateQualityReliabilityState(raw: unknown, path: string): QualityReliabilityState {
  const obj = requireObject(raw, path);
  const qualityRaw = requireArray(obj.qualityByCompanyProduct, `${path}.qualityByCompanyProduct`);
  const trustRaw = requireArray(obj.trustByCompanyMarket, `${path}.trustByCompanyMarket`);
  const rampRaw = requireArray(obj.rampHistory, `${path}.rampHistory`);
  return {
    qualityByCompanyProduct: qualityRaw.map((q, i) => validateCompanyProductQualityState(q, `${path}.qualityByCompanyProduct[${i}]`)),
    trustByCompanyMarket: trustRaw.map((t, i) => validateCompanyMarketTrustState(t, `${path}.trustByCompanyMarket[${i}]`)),
    rampHistory: rampRaw.map((r, i) => validateCompanyFactoryProductRampState(r, `${path}.rampHistory[${i}]`)),
  };
}

// ---------------------------------------------------------------------
// 3. 財務状態
// ---------------------------------------------------------------------

function requireUsdLike(value: unknown, path: string): number {
  return requireFiniteNumber(value, path);
}

function requireNonNegativeUsdLike(value: unknown, path: string): number {
  const n = requireUsdLike(value, path);
  if (n < 0) fail(path, "0以上である必要があります");
  return n;
}

function validateReceivable(raw: unknown, path: string): ReceivableRecord {
  const obj = requireObject(raw, path);
  return {
    id: requireNonEmptyString(obj.id, `${path}.id`),
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    market: requireEnum(obj.market, DEMAND_MARKET_IDS, `${path}.market`),
    amount: requireNonNegativeUsdLike(obj.amount, `${path}.amount`) as ReceivableRecord["amount"],
    originPeriod: requirePeriod(obj.originPeriod, `${path}.originPeriod`),
    dueSettlementPeriod: requirePeriod(obj.dueSettlementPeriod, `${path}.dueSettlementPeriod`),
    sourceRef: requireString(obj.sourceRef, `${path}.sourceRef`),
  };
}

function validatePayable(raw: unknown, path: string): PayableRecord {
  const obj = requireObject(raw, path);
  return {
    id: requireNonEmptyString(obj.id, `${path}.id`),
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    source: requireEnum(obj.source, PAYABLE_SOURCES, `${path}.source`),
    amount: requireNonNegativeUsdLike(obj.amount, `${path}.amount`) as PayableRecord["amount"],
    originPeriod: requirePeriod(obj.originPeriod, `${path}.originPeriod`),
    dueSettlementPeriod: requirePeriod(obj.dueSettlementPeriod, `${path}.dueSettlementPeriod`),
    sourceRef: requireString(obj.sourceRef, `${path}.sourceRef`),
  };
}

function validateUnitCostBreakdown(raw: unknown, path: string): FinishedGoodsUnitCostBreakdown {
  const obj = requireObject(raw, path);
  return {
    rawMaterialPerTon: requireNonNegativeUsdLike(obj.rawMaterialPerTon, `${path}.rawMaterialPerTon`),
    processingPerTon: requireNonNegativeUsdLike(obj.processingPerTon, `${path}.processingPerTon`),
    laborVariablePerTon: requireNonNegativeUsdLike(obj.laborVariablePerTon, `${path}.laborVariablePerTon`),
    utilityVariablePerTon: requireNonNegativeUsdLike(obj.utilityVariablePerTon, `${path}.utilityVariablePerTon`),
    laborFixedPerTon: requireNonNegativeUsdLike(obj.laborFixedPerTon, `${path}.laborFixedPerTon`),
    factoryFixedPerTon: requireNonNegativeUsdLike(obj.factoryFixedPerTon, `${path}.factoryFixedPerTon`),
    utilityFixedPerTon: requireNonNegativeUsdLike(obj.utilityFixedPerTon, `${path}.utilityFixedPerTon`),
    depreciationPerTon: requireNonNegativeUsdLike(obj.depreciationPerTon, `${path}.depreciationPerTon`),
  };
}

function validateLedgerEntry(raw: unknown, path: string): FinishedGoodsCostLedgerEntry {
  const obj = requireObject(raw, path);
  const downgradeRatio = requireNonNegativeUsdLike(obj.downgradeRatio, `${path}.downgradeRatio`);
  if (downgradeRatio > 1 + EPSILON) fail(`${path}.downgradeRatio`, "0〜1である必要があります");
  return {
    lotId: requireNonEmptyString(obj.lotId, `${path}.lotId`),
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    product: requireEnum(obj.product, PRODUCTS, `${path}.product`),
    remainingQuantity: requireNonNegativeUsdLike(obj.remainingQuantity, `${path}.remainingQuantity`),
    unitCost: validateUnitCostBreakdown(obj.unitCost, `${path}.unitCost`),
    downgradeRatio,
    producedPeriod: requirePeriod(obj.producedPeriod, `${path}.producedPeriod`),
  };
}

function validateCompanyFinanceState(raw: unknown, path: string): CompanyFinanceState {
  const obj = requireObject(raw, path);
  const fixedAssetsGross = requireNonNegativeUsdLike(obj.fixedAssetsGross, `${path}.fixedAssetsGross`);
  const accumulatedDepreciation = requireNonNegativeUsdLike(obj.accumulatedDepreciation, `${path}.accumulatedDepreciation`);
  if (accumulatedDepreciation > fixedAssetsGross + EPSILON) {
    fail(`${path}.accumulatedDepreciation`, "固定資産の取得原価総額を超えてはなりません");
  }
  const receivablesRaw = requireArray(obj.receivables, `${path}.receivables`);
  const payablesRaw = requireArray(obj.payables, `${path}.payables`);
  const ledgerRaw = requireArray(obj.finishedGoodsCostLedger, `${path}.finishedGoodsCostLedger`);
  return {
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    cash: requireUsdLike(obj.cash, `${path}.cash`) as CompanyFinanceState["cash"],
    receivables: receivablesRaw.map((r, i) => validateReceivable(r, `${path}.receivables[${i}]`)),
    payables: payablesRaw.map((p, i) => validatePayable(p, `${path}.payables[${i}]`)),
    otherCurrentAssets: requireNonNegativeUsdLike(obj.otherCurrentAssets, `${path}.otherCurrentAssets`) as CompanyFinanceState["otherCurrentAssets"],
    fixedAssetsGross: fixedAssetsGross as CompanyFinanceState["fixedAssetsGross"],
    accumulatedDepreciation: accumulatedDepreciation as CompanyFinanceState["accumulatedDepreciation"],
    shortTermLoans: requireNonNegativeUsdLike(obj.shortTermLoans, `${path}.shortTermLoans`) as CompanyFinanceState["shortTermLoans"],
    longTermLoans: requireNonNegativeUsdLike(obj.longTermLoans, `${path}.longTermLoans`) as CompanyFinanceState["longTermLoans"],
    otherLiabilities: requireNonNegativeUsdLike(obj.otherLiabilities, `${path}.otherLiabilities`) as CompanyFinanceState["otherLiabilities"],
    capitalStock: requireNonNegativeUsdLike(obj.capitalStock, `${path}.capitalStock`) as CompanyFinanceState["capitalStock"],
    retainedEarnings: requireUsdLike(obj.retainedEarnings, `${path}.retainedEarnings`) as CompanyFinanceState["retainedEarnings"],
    finishedGoodsCostLedger: ledgerRaw.map((e, i) => validateLedgerEntry(e, `${path}.finishedGoodsCostLedger[${i}]`)),
  };
}

// ---------------------------------------------------------------------
// 4. 資金繰り状態
// ---------------------------------------------------------------------

function validateLoanRecord(raw: unknown, path: string): LoanRecord {
  const obj = requireObject(raw, path);
  const originalPrincipalUsd = requireNonNegativeUsdLike(obj.originalPrincipalUsd, `${path}.originalPrincipalUsd`);
  const currentPrincipalUsd = requireNonNegativeUsdLike(obj.currentPrincipalUsd, `${path}.currentPrincipalUsd`);
  if (currentPrincipalUsd > originalPrincipalUsd + EPSILON) {
    fail(`${path}.currentPrincipalUsd`, "originalPrincipalUsdを超えてはなりません");
  }
  const originationPeriod = requirePeriod(obj.originationPeriod, `${path}.originationPeriod`);
  const maturityPeriod = requirePeriod(obj.maturityPeriod, `${path}.maturityPeriod`);
  const refinancedFromLoanId = obj.refinancedFromLoanId === undefined ? undefined : requireNonEmptyString(obj.refinancedFromLoanId, `${path}.refinancedFromLoanId`);
  return {
    loanId: requireNonEmptyString(obj.loanId, `${path}.loanId`),
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    loanType: requireEnum(obj.loanType, LOAN_TYPES, `${path}.loanType`),
    originalPrincipalUsd,
    currentPrincipalUsd,
    originationPeriod,
    maturityPeriod,
    annualInterestRate: requireNonNegativeUsdLike(obj.annualInterestRate, `${path}.annualInterestRate`),
    creditSpreadAnnual: requireNonNegativeUsdLike(obj.creditSpreadAnnual, `${path}.creditSpreadAnnual`),
    repaymentMethod: requireEnum(obj.repaymentMethod, REPAYMENT_METHODS, `${path}.repaymentMethod`),
    equalPrincipalInstallmentUsd: requireNonNegativeUsdLike(obj.equalPrincipalInstallmentUsd, `${path}.equalPrincipalInstallmentUsd`),
    arrearsPrincipalUsd: requireNonNegativeUsdLike(obj.arrearsPrincipalUsd, `${path}.arrearsPrincipalUsd`),
    arrearsInterestUsd: requireNonNegativeUsdLike(obj.arrearsInterestUsd, `${path}.arrearsInterestUsd`),
    status: requireEnum(obj.status, LOAN_STATUSES, `${path}.status`),
    isEmergency: requireBoolean(obj.isEmergency, `${path}.isEmergency`),
    ...(refinancedFromLoanId !== undefined ? { refinancedFromLoanId } : {}),
  };
}

function validateLoanPortfolio(raw: unknown, path: string): LoanPortfolio {
  const obj = requireObject(raw, path);
  const loansRaw = requireArray(obj.loans, `${path}.loans`);
  return {
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    loans: loansRaw.map((l, i) => validateLoanRecord(l, `${path}.loans[${i}]`)),
  };
}

function validateCompanyFinancingHistory(raw: unknown, path: string): CompanyFinancingHistory {
  const obj = requireObject(raw, path);
  const lastFinancialHealth = obj.lastFinancialHealth === undefined ? undefined : requireEnum(obj.lastFinancialHealth, FINANCIAL_HEALTH_TIERS, `${path}.lastFinancialHealth`);
  return {
    consecutiveArrearsQuarters: requireNonNegativeInteger(obj.consecutiveArrearsQuarters, `${path}.consecutiveArrearsQuarters`),
    consecutiveCovenantBreachQuarters: requireNonNegativeInteger(obj.consecutiveCovenantBreachQuarters, `${path}.consecutiveCovenantBreachQuarters`),
    totalOnTimeRepaymentEventsCount: requireNonNegativeInteger(obj.totalOnTimeRepaymentEventsCount, `${path}.totalOnTimeRepaymentEventsCount`),
    totalArrearsEventsCount: requireNonNegativeInteger(obj.totalArrearsEventsCount, `${path}.totalArrearsEventsCount`),
    totalEmergencyLoanDrawsCount: requireNonNegativeInteger(obj.totalEmergencyLoanDrawsCount, `${path}.totalEmergencyLoanDrawsCount`),
    ...(lastFinancialHealth !== undefined ? { lastFinancialHealth } : {}),
  };
}

function validateCompanyFinancingState(raw: unknown, path: string): CompanyFinancingState {
  const obj = requireObject(raw, path);
  return {
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    loanPortfolio: validateLoanPortfolio(obj.loanPortfolio, `${path}.loanPortfolio`),
    accruedInterestPayableUsd: requireNonNegativeUsdLike(obj.accruedInterestPayableUsd, `${path}.accruedInterestPayableUsd`),
    history: validateCompanyFinancingHistory(obj.history, `${path}.history`),
  };
}

// ---------------------------------------------------------------------
// 5. 設備投資状態
// ---------------------------------------------------------------------

function validateCapitalProject(raw: unknown, path: string): CapitalProject {
  const obj = requireObject(raw, path);
  const projectType: CapitalProjectType = requireEnum(obj.projectType, CAPITAL_PROJECT_TYPES, `${path}.projectType`);
  const approvedBudgetUsd = requireFiniteNumber(obj.approvedBudgetUsd, `${path}.approvedBudgetUsd`);
  const scheduleRaw = requireArray(obj.paymentSchedule, `${path}.paymentSchedule`);
  const paymentSchedule = scheduleRaw.map((s, i) => {
    const so = requireObject(s, `${path}.paymentSchedule[${i}]`);
    return {
      stageIndex: requireNonNegativeInteger(so.stageIndex, `${path}.paymentSchedule[${i}].stageIndex`),
      plannedRatio: requireFiniteNumber(so.plannedRatio, `${path}.paymentSchedule[${i}].plannedRatio`),
    };
  });
  const status: CapitalProjectStatus = requireEnum(obj.status, CAPITAL_PROJECT_STATUSES, `${path}.status`);
  const proposedPeriod = requirePeriod(obj.proposedPeriod, `${path}.proposedPeriod`);
  const approvedPeriod = requirePeriod(obj.approvedPeriod, `${path}.approvedPeriod`);
  const constructionStartedPeriod = requireOptionalPeriod(obj.constructionStartedPeriod, `${path}.constructionStartedPeriod`);
  const completedPeriod = requireOptionalPeriod(obj.completedPeriod, `${path}.completedPeriod`);
  const cancelledPeriod = requireOptionalPeriod(obj.cancelledPeriod, `${path}.cancelledPeriod`);
  const capitalizedAmountUsd = obj.capitalizedAmountUsd === undefined ? undefined : requireFiniteNumber(obj.capitalizedAmountUsd, `${path}.capitalizedAmountUsd`);
  const priority = requireFiniteNumber(obj.priority, `${path}.priority`);
  let futureCapacityEffect: CapitalProject["futureCapacityEffect"];
  if (obj.futureCapacityEffect !== undefined) {
    const fc = requireObject(obj.futureCapacityEffect, `${path}.futureCapacityEffect`);
    futureCapacityEffect = {
      ...(fc.targetProduct !== undefined ? { targetProduct: requireString(fc.targetProduct, `${path}.futureCapacityEffect.targetProduct`) as never } : {}),
      ...(fc.capacityIncreaseTonsPerQuarter !== undefined ? { capacityIncreaseTonsPerQuarter: requireFiniteNumber(fc.capacityIncreaseTonsPerQuarter, `${path}.futureCapacityEffect.capacityIncreaseTonsPerQuarter`) } : {}),
      ...(fc.readinessQuartersAfterCompletion !== undefined ? { readinessQuartersAfterCompletion: requireNonNegativeInteger(fc.readinessQuartersAfterCompletion, `${path}.futureCapacityEffect.readinessQuartersAfterCompletion`) } : {}),
    };
  }
  const reasonsRaw = requireArray(obj.lastDiagnosticReasons, `${path}.lastDiagnosticReasons`);
  const lastDiagnosticReasons = reasonsRaw.map((r, i) => requireString(r, `${path}.lastDiagnosticReasons[${i}]`));
  return {
    projectId: requireNonEmptyString(obj.projectId, `${path}.projectId`),
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    projectType,
    approvedBudgetUsd,
    paymentSchedule,
    completedPaymentStagesCount: requireNonNegativeInteger(obj.completedPaymentStagesCount, `${path}.completedPaymentStagesCount`),
    cumulativePaidUsd: requireNonNegativeUsdLike(obj.cumulativePaidUsd, `${path}.cumulativePaidUsd`),
    elapsedConstructionQuartersWithPayment: requireNonNegativeInteger(obj.elapsedConstructionQuartersWithPayment, `${path}.elapsedConstructionQuartersWithPayment`),
    requiredConstructionQuarters: requireNonNegativeInteger(obj.requiredConstructionQuarters, `${path}.requiredConstructionQuarters`),
    status,
    proposedPeriod,
    approvedPeriod,
    ...(constructionStartedPeriod !== undefined ? { constructionStartedPeriod } : {}),
    ...(completedPeriod !== undefined ? { completedPeriod } : {}),
    ...(cancelledPeriod !== undefined ? { cancelledPeriod } : {}),
    ...(capitalizedAmountUsd !== undefined ? { capitalizedAmountUsd } : {}),
    priority,
    ...(futureCapacityEffect !== undefined ? { futureCapacityEffect } : {}),
    lastDiagnosticReasons,
  };
}

function validateCapitalProjectPortfolio(raw: unknown, path: string): CapitalProjectPortfolio {
  const obj = requireObject(raw, path);
  const projectsRaw = requireArray(obj.projects, `${path}.projects`);
  return {
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    projects: projectsRaw.map((p, i) => validateCapitalProject(p, `${path}.projects[${i}]`)),
  };
}

function validateCompanyCapexState(raw: unknown, path: string): CompanyCapexState {
  const obj = requireObject(raw, path);
  return {
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    portfolio: validateCapitalProjectPortfolio(obj.portfolio, `${path}.portfolio`),
    nextProjectSequence: requireNonNegativeInteger(obj.nextProjectSequence, `${path}.nextProjectSequence`),
  };
}

// ---------------------------------------------------------------------
// 6. シナリオ状態（definition自体は静的な巨大構造のため形状確認のみ。§検証範囲コメント参照）
// ---------------------------------------------------------------------

function validateScenarioState(raw: unknown, path: string): ScenarioState {
  const obj = requireObject(raw, path);
  const definition = requireObject(obj.definition, `${path}.definition`);
  const mode = requireEnum(obj.mode, SCENARIO_MODES, `${path}.mode`);
  const randomSeed = requireNonEmptyString(obj.randomSeed, `${path}.randomSeed`);
  const currentTurn = requireNonNegativeInteger(obj.currentTurn, `${path}.currentTurn`);
  const resolvedEventsRaw = requireArray(obj.resolvedEvents, `${path}.resolvedEvents`);
  resolvedEventsRaw.forEach((e, i) => requireObject(e, `${path}.resolvedEvents[${i}]`));
  const turnHistoryRaw = requireArray(obj.turnHistory, `${path}.turnHistory`);
  turnHistoryRaw.forEach((t, i) => requireObject(t, `${path}.turnHistory[${i}]`));
  return {
    definition: definition as unknown as ScenarioState["definition"],
    mode,
    randomSeed,
    currentTurn,
    resolvedEvents: resolvedEventsRaw as unknown as ScenarioState["resolvedEvents"],
    turnHistory: turnHistoryRaw as unknown as ScenarioState["turnHistory"],
  };
}

// ---------------------------------------------------------------------
// 7. CompanyLabRuntimeSnapshot トップレベル
// ---------------------------------------------------------------------

/**
 * ランタイムスナップショットを検証する。トップレベルに"history"キーが存在する
 * こと自体を明示的に拒否する（要求されている拒否ケース「historyを含む不正な
 * ランタイムスナップショット」）。
 */
export function validateCompanyLabRuntimeSnapshot(raw: unknown, path: string): CompanyLabRuntimeSnapshot {
  const obj = requireObject(raw, path);
  if (Object.prototype.hasOwnProperty.call(obj, "history")) {
    fail(`${path}.history`, "ランタイムスナップショットにhistoryを含めることは許可されていません（四半期履歴の再帰的複製を防ぐため、意図的に除外されるフィールドです）");
  }
  const currentPeriod = requirePeriod(obj.currentPeriod, `${path}.currentPeriod`);
  const scenarioState = validateScenarioState(obj.scenarioState, `${path}.scenarioState`);
  const contractsRaw = requireArray(obj.contracts, `${path}.contracts`);
  const contracts = contractsRaw.map((c, i) => validateSalesContract(c, `${path}.contracts[${i}]`));
  const lotsRaw = requireArray(obj.rawMaterialLots, `${path}.rawMaterialLots`);
  const rawMaterialLots = lotsRaw.map((l, i) => validateRawMaterialLot(l, `${path}.rawMaterialLots[${i}]`));
  const productionState = validateProductionRuntimeSnapshot(obj.productionState, `${path}.productionState`);
  const lastQuarterActualProduction = requireObject(obj.lastQuarterActualProduction, `${path}.lastQuarterActualProduction`);
  const qualityState = validateQualityReliabilityState(obj.qualityState, `${path}.qualityState`);
  const financeStateObj = requireObject(obj.financeState, `${path}.financeState`);
  const financeCompaniesRaw = requireArray(financeStateObj.companies, `${path}.financeState.companies`);
  const financeState = { companies: financeCompaniesRaw.map((c, i) => validateCompanyFinanceState(c, `${path}.financeState.companies[${i}]`)) };
  const financingStateObj = requireObject(obj.financingState, `${path}.financingState`);
  const financingCompaniesRaw = requireArray(financingStateObj.companies, `${path}.financingState.companies`);
  const financingState = { companies: financingCompaniesRaw.map((c, i) => validateCompanyFinancingState(c, `${path}.financingState.companies[${i}]`)) };
  const capexStateObj = requireObject(obj.capexState, `${path}.capexState`);
  const capexCompaniesRaw = requireArray(capexStateObj.companies, `${path}.capexState.companies`);
  const capexState = { companies: capexCompaniesRaw.map((c, i) => validateCompanyCapexState(c, `${path}.capexState.companies[${i}]`)) };
  const workforceState = validateWorkforceState(obj.workforceState, `${path}.workforceState`);
  const consumerMarketState = validateConsumerMarketState(obj.consumerMarketState, `${path}.consumerMarketState`);
  // 【SAI-5D・schemaVersion 4】optionalな営業基盤ストック。キー欠落（v1〜v3の
  // 既存データ）はundefined（機能無効）として復元する。
  const salesBaseState = validateSalesBaseState(obj.salesBaseState, `${path}.salesBaseState`);
  const marketEvolutionState = validateMarketEvolutionState(obj.marketEvolutionState, `${path}.marketEvolutionState`);
  // 【営業人員の追加採用・forward-port・schemaVersion 5】キー欠落（v1〜v4の
  // 既存データ）は空（{ companies: [] }）として復元する。
  const salesForceHiringState = validateSalesForceHiringState(obj.salesForceHiringState, `${path}.salesForceHiringState`);
  const isComplete = requireBoolean(obj.isComplete, `${path}.isComplete`);

  return {
    currentPeriod,
    scenarioState,
    contracts,
    rawMaterialLots,
    productionState,
    lastQuarterActualProduction: lastQuarterActualProduction as unknown as CompanyLabRuntimeSnapshot["lastQuarterActualProduction"],
    qualityState,
    financeState,
    financingState,
    capexState,
    workforceState,
    consumerMarketState,
    ...(salesBaseState ? { salesBaseState } : {}),
    ...(marketEvolutionState ? { marketEvolutionState } : {}),
    salesForceHiringState,
    isComplete,
  };
}

/**
 * 【営業人員の追加採用・forward-port・schemaVersion 5】営業人員総数の検証。
 *
 * 【後方互換】キー自体が存在しない schemaVersion:1〜4 のデータでは空を返す
 * （workforceStateと同じ「キーの有無で判定し、無ければ安全な既定値を補う」方式。
 * バージョン番号で分岐しないため、マイグレーション処理は不要）。
 * 空で返した場合、実際の人数は runner.ts側（buildCompanyOwnState・
 * advanceCompanyLabQuarter）が会社単位でfixture.salesForceHeadcountTotalへ
 * フォールバックする（推測値は作らない）。
 */
function validateSalesForceHiringState(raw: unknown, path: string): SalesForceHiringState {
  if (raw === undefined || raw === null) return { companies: [] };
  const obj = requireObject(raw, path);
  const companiesRaw = requireArray(obj.companies, `${path}.companies`);
  return {
    companies: companiesRaw.map((c, i) => {
      const companyPath = `${path}.companies[${i}]`;
      const companyObj = requireObject(c, companyPath);
      return {
        companyId: requireNonEmptyString(companyObj.companyId, `${companyPath}.companyId`),
        headcount: requireNonNegativeInteger(companyObj.headcount, `${companyPath}.headcount`),
      };
    }),
  };
}

/**
 * 【Phase 8D-4・schemaVersion 2】Worker総人数の検証。
 *
 * 【後方互換】キー自体が存在しない schemaVersion:1 のデータでは空を返す
 * （app/lib/v2/persistence/schema.ts の validateFinanceStates 等で確立済みの
 * 「キーの有無で判定し、無ければ安全な既定値を補う」方式をそのまま踏襲する。
 * バージョン番号で分岐しないため、マイグレーション処理は不要）。
 * 空で返した場合、実際の人数は restoreCompanyLabStateFromRuntimeSnapshot が
 * 確定履歴の decisions[].workerAssignments から復元する（推測値は作らない）。
 */
function validateWorkforceState(raw: unknown, path: string): WorkforceState {
  if (raw === undefined || raw === null) return { companies: [] };
  const obj = requireObject(raw, path);
  const companiesRaw = requireArray(obj.companies, `${path}.companies`);
  return {
    companies: companiesRaw.map((c, i) => {
      const companyPath = `${path}.companies[${i}]`;
      const companyObj = requireObject(c, companyPath);
      const companyId = requireNonEmptyString(companyObj.companyId, `${companyPath}.companyId`);
      const factoriesRaw = requireArray(companyObj.factories, `${companyPath}.factories`);
      return {
        companyId,
        factories: factoriesRaw.map((f, j) => {
          const factoryPath = `${companyPath}.factories[${j}]`;
          const factoryObj = requireObject(f, factoryPath);
          return {
            factoryId: requireNonEmptyString(factoryObj.factoryId, `${factoryPath}.factoryId`),
            regularHeadcount: requireNonNegativeInteger(factoryObj.regularHeadcount, `${factoryPath}.regularHeadcount`),
          };
        }),
      };
    }),
  };
}

/**
 * 【Phase 8F-1・schemaVersion 3】市場別・消費国在庫carry stateの検証。
 *
 * 【後方互換】キー自体が存在しない schemaVersion:1〜2 のデータでは、全市場を
 * 「未初期化」を表すゼロ値のcarry state（market/consumerInventory.ts の
 * isConsumerMarketStateEmptyがtrueと判定する組み合わせ）で埋めて返す。
 * 実際の初期化は restoreCompanyLabStateFromRuntimeSnapshot が、確定履歴の
 * 直近四半期のdemandMarkets入力から決定論的に再構築する（workforceStateと
 * 同じ「キーの有無で判定し、無ければ安全な既定値を補う」方式。マイグレーション
 * 処理は不要）。
 */
function validateConsumerMarketState(raw: unknown, path: string): ConsumerMarketCarryStateTable {
  if (raw === undefined || raw === null) return emptyConsumerMarketState();
  const obj = requireObject(raw, path);
  const result = {} as Record<DemandMarketId, ConsumerMarketCarryState>;
  for (const market of DEMAND_MARKET_IDS) {
    const marketPath = `${path}.${market}`;
    const marketObj = requireObject(obj[market], marketPath);
    const marketId = requireEnum(marketObj.market, DEMAND_MARKET_IDS, `${marketPath}.market`);
    const openingInventoryTons = wrapUnitConstructor(hosoEqTons, marketObj.openingInventoryTons, `${marketPath}.openingInventoryTons`);
    const priorConsumptionTons = wrapUnitConstructor(hosoEqTons, marketObj.priorConsumptionTons, `${marketPath}.priorConsumptionTons`);
    const priceHistoryRaw = requireArray(marketObj.priceHistoryUsdPerHosoEqKg, `${marketPath}.priceHistoryUsdPerHosoEqKg`);
    const priceHistoryUsdPerHosoEqKg = priceHistoryRaw.map((p, i) => requireFiniteNumber(p, `${marketPath}.priceHistoryUsdPerHosoEqKg[${i}]`));
    result[market] = { market: marketId, openingInventoryTons, priorConsumptionTons, priceHistoryUsdPerHosoEqKg };
  }
  return result;
}

function emptyConsumerMarketState(): ConsumerMarketCarryStateTable {
  const result = {} as Record<DemandMarketId, ConsumerMarketCarryState>;
  for (const market of DEMAND_MARKET_IDS) {
    result[market] = { market, openingInventoryTons: hosoEqTons(0), priorConsumptionTons: hosoEqTons(0), priceHistoryUsdPerHosoEqKg: [] };
  }
  return result;
}

/**
 * 【SAI-5D・schemaVersion 4】営業基盤ストックの検証。キー欠落（v1〜v3の既存
 * データ）・nullはundefined（機能無効）を返す。存在する場合はエントリごとに
 * 会社ID・市場・商品・スコア（Score0to100スマートコンストラクタ経由）を検証する。
 */
function validateSalesBaseState(raw: unknown, path: string): SalesBaseState | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = requireObject(raw, path);
  const entriesRaw = requireArray(obj.entries, `${path}.entries`);
  const entries = entriesRaw.map((e, i) => {
    const entryPath = `${path}.entries[${i}]`;
    const entryObj = requireObject(e, entryPath);
    return {
      companyId: requireNonEmptyString(entryObj.companyId, `${entryPath}.companyId`),
      market: requireEnum(entryObj.market, DEMAND_MARKET_IDS, `${entryPath}.market`),
      product: requireEnum(entryObj.product, PRODUCTS_FOR_SALES_BASE, `${entryPath}.product`),
      score: wrapUnitConstructor(score0to100, entryObj.score, `${entryPath}.score`),
    };
  });
  return { entries };
}

const PRODUCTS_FOR_SALES_BASE = ["hoso", "pd", "vap"] as const;

/**
 * 【SAI-5E・schemaVersion 4】市場進化carry stateの検証。キー欠落・nullは
 * undefined（機能無効）を返す。
 */
function validateMarketEvolutionState(raw: unknown, path: string): MarketEvolutionState | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = requireObject(raw, path);
  const validateEntry = (entryRaw: unknown, entryPath: string) => {
    const e = requireObject(entryRaw, entryPath);
    const supplyRatioBaselineEwma =
      e.supplyRatioBaselineEwma === undefined ? undefined : requireFiniteNumber(e.supplyRatioBaselineEwma, `${entryPath}.supplyRatioBaselineEwma`);
    return {
      supplyPressureEwma: requireFiniteNumber(e.supplyPressureEwma, `${entryPath}.supplyPressureEwma`),
      premiumRatioMultiplier: requireFiniteNumber(e.premiumRatioMultiplier, `${entryPath}.premiumRatioMultiplier`),
      affordabilitySignalEwma: requireFiniteNumber(e.affordabilitySignalEwma, `${entryPath}.affordabilitySignalEwma`),
      ...(supplyRatioBaselineEwma === undefined ? {} : { supplyRatioBaselineEwma }),
    };
  };
  // 【監査指摘F】直近2四半期の適用構成比。ライフサイクル無効・旧スナップショットでは
  // キー自体が存在しない（undefinedのまま＝従来の履歴フォールバックが働く）。
  const recentAppliedMixesRaw = obj.recentAppliedMixes === undefined ? undefined : requireArray(obj.recentAppliedMixes, `${path}.recentAppliedMixes`);
  const recentAppliedMixes = recentAppliedMixesRaw?.map((mixRaw, i) => {
    const mixPath = `${path}.recentAppliedMixes[${i}]`;
    const mixObj = requireObject(mixRaw, mixPath);
    const out = {} as Record<DemandMarketId, Record<Product, number>>;
    for (const market of DEMAND_MARKET_IDS) {
      const row = requireObject(mixObj[market], `${mixPath}.${market}`);
      out[market] = {
        hoso: requireFiniteNumber(row.hoso, `${mixPath}.${market}.hoso`),
        pd: requireFiniteNumber(row.pd, `${mixPath}.${market}.pd`),
        vap: requireFiniteNumber(row.vap, `${mixPath}.${market}.vap`),
      };
    }
    return out;
  });
  return {
    pd: validateEntry(obj.pd, `${path}.pd`),
    vap: validateEntry(obj.vap, `${path}.vap`),
    ...(recentAppliedMixes === undefined ? {} : { recentAppliedMixes }),
  };
}

// ---------------------------------------------------------------------
// 8. CompanyFixture・CompanyLabConfig（軽量検証。静的フィクスチャデータ）
// ---------------------------------------------------------------------

function validateCompanyFixture(raw: unknown, path: string): CompanyFixture {
  const obj = requireObject(raw, path);
  const companyId = requireNonEmptyString(obj.companyId, `${path}.companyId`);
  const displayName = requireNonEmptyString(obj.displayName, `${path}.displayName`);
  const archetype = requireEnum(obj.archetype, COMPANY_ARCHETYPES, `${path}.archetype`);
  const description = requireString(obj.description, `${path}.description`);
  const country = requireEnum(obj.country, COUNTRY_IDS, `${path}.country`);
  const factoriesRaw = requireArray(obj.factories, `${path}.factories`);
  factoriesRaw.forEach((f, i) => requireObject(f, `${path}.factories[${i}]`));
  const workerBaselineRaw = requireArray(obj.workerBaseline, `${path}.workerBaseline`);
  workerBaselineRaw.forEach((w, i) => requireObject(w, `${path}.workerBaseline[${i}]`));
  const aquacultureCapacity = wrapUnitConstructor(hosoEqTons, obj.aquacultureCapacity, `${path}.aquacultureCapacity`);
  const salesForceHeadcountTotal = requireNonNegativeInteger(obj.salesForceHeadcountTotal, `${path}.salesForceHeadcountTotal`);
  const procurementHeadcountTotal = requireNonNegativeInteger(obj.procurementHeadcountTotal, `${path}.procurementHeadcountTotal`);
  const initialLotsRaw = requireArray(obj.initialRawMaterialLots, `${path}.initialRawMaterialLots`);
  const initialRawMaterialLots = initialLotsRaw.map((l, i) => validateRawMaterialLot(l, `${path}.initialRawMaterialLots[${i}]`));
  const productEconomics = requireObject(obj.productEconomics, `${path}.productEconomics`);
  return {
    companyId,
    displayName,
    archetype: archetype as CompanyFixture["archetype"],
    description,
    country,
    factories: factoriesRaw as unknown as CompanyFixture["factories"],
    workerBaseline: workerBaselineRaw as unknown as CompanyFixture["workerBaseline"],
    aquacultureCapacity,
    salesForceHeadcountTotal,
    procurementHeadcountTotal,
    initialRawMaterialLots,
    productEconomics: productEconomics as unknown as CompanyFixture["productEconomics"],
  };
}

/**
 * 【監査指摘E・修正】CompanyLabConfig.sai5（SAI-5機能フラグ）の復元。
 *
 * 以前は validateCompanyLabConfig が scenarioId/mode/seed/turns の4つだけを
 * 再構築しており、保存時に存在した sai5 を**黙って捨てていた**。その結果、
 * SAI-5有効のセッションを保存して読み直すと機能が全てOFFに戻り、営業基盤・
 * 市場進化のcarry stateだけが残るという不整合が起きていた。
 *
 * 未指定（旧スキーマの保存データ）は undefined を返し、従来どおり全機能OFFの
 * 挙動になる（後方互換。マイグレーションは不要）。
 */
function validateSai5FeatureFlags(raw: unknown, path: string): Sai5FeatureFlags | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = requireObject(raw, path);
  const optionalBoolean = (value: unknown, p: string): boolean | undefined => (value === undefined ? undefined : requireBoolean(value, p));
  const productLifecycle = optionalBoolean(obj.productLifecycle, `${path}.productLifecycle`);
  const salesBaseAccumulation = optionalBoolean(obj.salesBaseAccumulation, `${path}.salesBaseAccumulation`);
  const supplyPremiumFeedback = optionalBoolean(obj.supplyPremiumFeedback, `${path}.supplyPremiumFeedback`);
  const supplyPressureDefinition =
    obj.supplyPressureDefinition === undefined
      ? undefined
      : requireEnum(obj.supplyPressureDefinition, SUPPLY_PRESSURE_DEFINITIONS, `${path}.supplyPressureDefinition`);
  return {
    ...(productLifecycle === undefined ? {} : { productLifecycle }),
    ...(salesBaseAccumulation === undefined ? {} : { salesBaseAccumulation }),
    ...(supplyPremiumFeedback === undefined ? {} : { supplyPremiumFeedback }),
    ...(supplyPressureDefinition === undefined ? {} : { supplyPressureDefinition }),
  };
}

function validateCompanyLabConfig(raw: unknown, path: string): CompanyLabConfig {
  const obj = requireObject(raw, path);
  const sai5 = validateSai5FeatureFlags(obj.sai5, `${path}.sai5`);
  return {
    scenarioId: requireNonEmptyString(obj.scenarioId, `${path}.scenarioId`),
    mode: requireEnum(obj.mode, SCENARIO_MODES, `${path}.mode`),
    seed: requireNonEmptyString(obj.seed, `${path}.seed`),
    turns: (() => {
      const n = requireNonNegativeInteger(obj.turns, `${path}.turns`);
      if (n < 1) fail(`${path}.turns`, "1以上の整数である必要があります");
      return n;
    })(),
    ...(sai5 === undefined ? {} : { sai5 }),
  };
}

// ---------------------------------------------------------------------
// 9. CompanyDecisionInput・CompanyQuarterRecord（軽量検証。§検証範囲コメント参照）
// ---------------------------------------------------------------------

function validateCompanyDecisionInput(raw: unknown, path: string): CompanyDecisionInput {
  const obj = requireObject(raw, path);
  requireNonEmptyString(obj.companyId, `${path}.companyId`);
  requireArray(obj.salesPlans, `${path}.salesPlans`);
  requireObject(obj.domesticPurchasePlan, `${path}.domesticPurchasePlan`);
  requireArray(obj.importOrders, `${path}.importOrders`);
  requireArray(obj.aquacultureStockingPlans, `${path}.aquacultureStockingPlans`);
  requireArray(obj.productionPlans, `${path}.productionPlans`);
  requireArray(obj.workerAssignments, `${path}.workerAssignments`);
  requireObject(obj.financingRequest, `${path}.financingRequest`);
  requireObject(obj.capexDecision, `${path}.capexDecision`);
  return obj as unknown as CompanyDecisionInput;
}

const COMPANY_QUARTER_RECORD_REQUIRED_KEYS: readonly string[] = [
  "decisions",
  "marketInput",
  "marketResult",
  "salesRecord",
  "rawMaterialRequirements",
  "domesticAllocation",
  "productionAllocation",
  "batches",
  "newFinishedGoodsLots",
  "fulfillmentPlan",
  "companyLoadMetrics",
  "factoryLoadMetrics",
  "companySummaries",
  "globalReasonCodes",
  "turnDebug",
  "qualityAdjustments",
  "qualityStateAfter",
  "deliveryObservations",
  "financialResults",
  "financingResults",
  "capexResults",
];

/**
 * CompanyQuarterRecordを検証する。エンジン（advanceCompanyLabQuarter）が
 * 生成する信頼できる出力を単に往復させるだけの用途のため、turn・periodと
 * 主要キーの存在・形状（配列/オブジェクト）だけを確認し、各キー内部の
 * リーフフィールドまでは再帰検証しない（§検証範囲コメント参照）。
 */
function validateCompanyQuarterRecord(raw: unknown, path: string): CompanyQuarterRecord {
  const obj = requireObject(raw, path);
  const turn = requireNonNegativeInteger(obj.turn, `${path}.turn`);
  const period = requirePeriod(obj.period, `${path}.period`);
  requireArray(obj.decisions, `${path}.decisions`);
  for (const key of COMPANY_QUARTER_RECORD_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      fail(path, `CompanyQuarterRecordに必須フィールド "${key}" が存在しません`);
    }
  }
  return { ...obj, turn, period } as unknown as CompanyQuarterRecord;
}

// ---------------------------------------------------------------------
// 10. 四半期確定履歴エントリ
// ---------------------------------------------------------------------

export function validateCompanyLabQuarterHistoryEntry(raw: unknown, path: string): CompanyLabQuarterHistoryEntry {
  const obj = requireObject(raw, path);
  const turnId = requireNonEmptyString(obj.turnId, `${path}.turnId`);
  const turn = requireNonNegativeInteger(obj.turn, `${path}.turn`);
  if (turn < 1) fail(`${path}.turn`, "1以上の整数である必要があります");
  const period = requirePeriod(obj.period, `${path}.period`);
  const engineVersion = requireNonEmptyString(obj.engineVersion, `${path}.engineVersion`);
  const schemaVersion = requireNonNegativeInteger(obj.schemaVersion, `${path}.schemaVersion`);

  if (obj.preProcessingStateSnapshot === undefined) {
    fail(`${path}.preProcessingStateSnapshot`, "処理前スナップショットが存在しません（履歴エントリには処理前・処理後の両方が必須です）");
  }
  if (obj.postProcessingStateSnapshot === undefined) {
    fail(`${path}.postProcessingStateSnapshot`, "処理後スナップショットが存在しません（履歴エントリには処理前・処理後の両方が必須です）");
  }
  const preProcessingStateSnapshot = validateCompanyLabRuntimeSnapshot(obj.preProcessingStateSnapshot, `${path}.preProcessingStateSnapshot`);
  const postProcessingStateSnapshot = validateCompanyLabRuntimeSnapshot(obj.postProcessingStateSnapshot, `${path}.postProcessingStateSnapshot`);

  const playerSubmission = validateCompanyDecisionInput(obj.playerSubmission, `${path}.playerSubmission`);
  const aiProposal = obj.aiProposal === undefined ? undefined : validateCompanyDecisionInput(obj.aiProposal, `${path}.aiProposal`);
  let diffFromAiProposal: CompanyLabQuarterHistoryEntry["diffFromAiProposal"];
  if (obj.diffFromAiProposal !== undefined) {
    const d = requireObject(obj.diffFromAiProposal, `${path}.diffFromAiProposal`);
    diffFromAiProposal = {
      hasDifferences: requireBoolean(d.hasDifferences, `${path}.diffFromAiProposal.hasDifferences`),
      changedFieldPaths: requireArray(d.changedFieldPaths, `${path}.diffFromAiProposal.changedFieldPaths`).map((s, i) => requireString(s, `${path}.diffFromAiProposal.changedFieldPaths[${i}]`)),
    };
  }
  const otherRaw = requireArray(obj.otherCompaniesDecisions, `${path}.otherCompaniesDecisions`);
  const otherCompaniesDecisions = otherRaw.map((d, i) => validateCompanyDecisionInput(d, `${path}.otherCompaniesDecisions[${i}]`));
  const record = validateCompanyQuarterRecord(obj.record, `${path}.record`);
  if (record.turn !== turn) {
    fail(`${path}.record.turn`, `履歴エントリのturn(${turn})とrecord.turn(${record.turn})が一致しません`);
  }
  const processedAt = requireIsoTimestamp(obj.processedAt, `${path}.processedAt`);

  return {
    turnId,
    turn,
    period,
    engineVersion,
    schemaVersion,
    preProcessingStateSnapshot,
    postProcessingStateSnapshot,
    playerSubmission,
    ...(aiProposal !== undefined ? { aiProposal } : {}),
    ...(diffFromAiProposal !== undefined ? { diffFromAiProposal } : {}),
    otherCompaniesDecisions,
    record,
    processedAt,
  };
}

// ---------------------------------------------------------------------
// 11. ドラフトエンベロープ
// ---------------------------------------------------------------------

export function validateCompanyLabDraftEnvelope(raw: unknown, path: string): CompanyLabDraftEnvelope {
  const obj = requireObject(raw, path);
  const labId = requireNonEmptyString(obj.labId, `${path}.labId`);
  const period = requirePeriod(obj.period, `${path}.period`);
  const turnId = requireNonEmptyString(obj.turnId, `${path}.turnId`);
  const revision = requireNonNegativeInteger(obj.revision, `${path}.revision`);
  if (!Object.prototype.hasOwnProperty.call(obj, "draft")) {
    fail(`${path}.draft`, "ドラフト本体が存在しません");
  }
  const createdAt = requireIsoTimestamp(obj.createdAt, `${path}.createdAt`);
  const updatedAt = requireIsoTimestamp(obj.updatedAt, `${path}.updatedAt`);
  let submittedAt: string | null;
  if (obj.submittedAt === null) {
    submittedAt = null;
  } else {
    submittedAt = requireIsoTimestamp(obj.submittedAt, `${path}.submittedAt`);
  }
  return { labId, period, turnId, revision, draft: obj.draft, createdAt, updatedAt, submittedAt };
}

// ---------------------------------------------------------------------
// 12. 現在状態・トップレベル
// ---------------------------------------------------------------------

function validateCompanyLabPersistedCurrentState(raw: unknown, path: string): CompanyLabPersistedCurrentState {
  const obj = requireObject(raw, path);
  const runtime = validateCompanyLabRuntimeSnapshot(obj.runtime, `${path}.runtime`);
  const lastProcessedTurnId = obj.lastProcessedTurnId === undefined ? undefined : requireNonEmptyString(obj.lastProcessedTurnId, `${path}.lastProcessedTurnId`);
  const revision = requireNonNegativeInteger(obj.revision, `${path}.revision`);
  return { runtime, ...(lastProcessedTurnId !== undefined ? { lastProcessedTurnId } : {}), revision };
}

function validateCompanyLabPersistedStateMetadata(raw: unknown, path: string): CompanyLabPersistedStateMetadata {
  const obj = requireObject(raw, path);
  const createdAt = requireIsoTimestamp(obj.createdAt, `${path}.createdAt`);
  const updatedAt = requireIsoTimestamp(obj.updatedAt, `${path}.updatedAt`);
  return { createdAt, updatedAt };
}

/**
 * 任意のJSON値をランタイム検証しながらCompanyLabPersistedStateV1へ変換する。
 * `as CompanyLabPersistedStateV1`のような型アサーションのみでは済ませない。
 */
export function validateCompanyLabPersistedState(raw: unknown): CompanyLabPersistedStateV1 {
  const obj = requireObject(raw, "$");

  if (obj.schemaVersion === undefined) fail("$.schemaVersion", "schemaVersionが存在しません");
  const rawVersion = obj.schemaVersion;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 1) {
    fail("$.schemaVersion", `不正なschemaVersionです（1以上の整数である必要があります）。受け取った値: ${JSON.stringify(rawVersion)}`);
  }
  if (rawVersion > CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION) {
    throw new UnsupportedCompanyLabPersistedStateVersionError(rawVersion, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION);
  }
  const schemaVersion = rawVersion;

  const engineVersion = requireNonEmptyString(obj.engineVersion, "$.engineVersion");
  const labId = requireNonEmptyString(obj.labId, "$.labId");
  const config = validateCompanyLabConfig(obj.config, "$.config");
  const fixturesRaw = requireArray(obj.fixtures, "$.fixtures");
  const fixtures = fixturesRaw.map((f, i) => validateCompanyFixture(f, `$.fixtures[${i}]`));
  // 【Phase 8C-3B】playerCompanyIdは必須（8C-3Bで廃止したBAL固定/先頭会社
  // fallbackの再発を防ぐ）。「fixturesに実在する会社であること」の保証は
  // Application Service層のcreateLab（呼び出し契約違反を防ぐ層）が担う
  // （このスキーマ検証層は、テスト用の最小限fixtures（空配列等）でも
  // 汎用的に使えるよう、構造検証のみに留める）。
  const playerCompanyId = requireNonEmptyString(obj.playerCompanyId, "$.playerCompanyId") as CompanyId;
  const currentState = validateCompanyLabPersistedCurrentState(obj.currentState, "$.currentState");
  const draft = obj.draft === null || obj.draft === undefined ? null : validateCompanyLabDraftEnvelope(obj.draft, "$.draft");
  if (draft !== null && draft.labId !== labId) {
    fail("$.draft.labId", `ドラフトのlabId(${draft.labId})が保存対象ラボ(${labId})と一致しません`);
  }
  const metadata = validateCompanyLabPersistedStateMetadata(obj.metadata, "$.metadata");

  return { schemaVersion, engineVersion, labId, config, fixtures, playerCompanyId, currentState, draft, metadata };
}
