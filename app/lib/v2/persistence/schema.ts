// ShrimpX V2 — 永続化状態・シリアライズ契約 ランタイム検証（Phase 5.6）
//
// decode時に「as PersistedGameStateV2」だけで済ませず、必ずランタイムで
// 検証する。ブランド型（HosoEqTons・UsdPerHosoEqKg・Ratio）の復元は、既存の
// スマートコンストラクタ（core/units.tsのhosoEqTons()等）を必ず経由し、
// 単なる型キャストでは復元しない（実装指示§6）。PeriodV2の復元も既存の
// parsePeriod()を経由する。

import { PeriodV2, parsePeriod } from "../core/period";
import { HosoEqTons, Ratio, hosoEqTons, ratio, score0to100, unwrapUnit, usdPerHosoEqKg } from "../core/units";
import { COUNTRY_IDS, CountryId, DEMAND_MARKET_IDS, DemandMarketId, Product } from "../market/types";
import { ContractStatus, SalesContract } from "../sales/types";
import { RawMaterialLot, RawMaterialLotStatus, RawMaterialSource } from "../rawMaterials/types";
import { CompanyFactoryProductRampState, CompanyMarketTrustState, CompanyProductQualityState, QualityReliabilityState } from "../quality/types";
import {
  CompanyFinanceState,
  FinishedGoodsCostLedgerEntry,
  FinishedGoodsUnitCostBreakdown,
  PayableRecord,
  PayableSource,
  ReceivableRecord,
  Usd,
  usd,
} from "../finance/types";
import {
  CompanyFinancingHistory,
  CompanyFinancingState,
  FinancialHealthTier,
  LoanPortfolio,
  LoanRecord,
  LoanStatus,
  LoanType,
  RepaymentMethod,
} from "../financing/types";
import {
  CAPITAL_PROJECT_STATUSES,
  CAPITAL_PROJECT_TYPES,
  CapitalProject,
  CapitalProjectPortfolio,
  CapitalProjectStatus,
  CapitalProjectType,
  CompanyCapexState,
  FutureCapacityEffectPlaceholder,
  PaymentScheduleStage,
} from "../capex/types";
import {
  CURRENT_PERSISTED_GAME_STATE_VERSION,
  PersistedGameStateExecution,
  PersistedGameStateMetadata,
  PersistedGameStateV2,
} from "./types";
import { PersistedStateValidationError, UnsupportedPersistedStateVersionError } from "./errors";

const EPSILON = 1e-6;

const CONTRACT_STATUSES: readonly ContractStatus[] = ["open", "partiallyFulfilled", "fulfilled", "overdue", "cancelled"];
const LOT_STATUSES: readonly RawMaterialLotStatus[] = ["available", "inTransitImport", "growingAquaculture", "consumed", "expired"];
const LOT_SOURCES: readonly RawMaterialSource[] = ["domestic", "import", "aquaculture"];
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function fail(path: string, message: string): never {
  throw new PersistedStateValidationError(message, path);
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
    return fail(path, `PeriodV2として不正です（"YYYYQn"形式・quarterは1〜4である必要があります）。受け取った値: ${JSON.stringify(s)}`);
  }
}

function requireOptionalPeriod(value: unknown, path: string): PeriodV2 | undefined {
  return value === undefined ? undefined : requirePeriod(value, path);
}

function wrapUnitConstructor<T>(ctor: (n: number) => T, value: unknown, path: string): T {
  const n = requireFiniteNumber(value, path);
  try {
    return ctor(n);
  } catch (e) {
    return fail(path, e instanceof Error ? e.message : "単位の値として不正です");
  }
}

function requireIsoTimestamp(value: unknown, path: string): string {
  const s = requireNonEmptyString(value, path);
  if (Number.isNaN(Date.parse(s))) {
    fail(path, `ISO 8601形式の日時として解釈できません。受け取った値: ${JSON.stringify(s)}`);
  }
  return s;
}

// ---------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------

function validateContract(raw: unknown, path: string): SalesContract {
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
    fail(`${path}.outstandingQuantity`, "originalQuantityを不合理に超えています（outstandingQuantity <= originalQuantityである必要があります）");
  }
  const unitPrice = wrapUnitConstructor(usdPerHosoEqKg, obj.unitPrice, `${path}.unitPrice`);
  const status = requireEnum(obj.status, CONTRACT_STATUSES, `${path}.status`);

  // 【Phase 6.3（schemaVersion 2で追加）】契約時予想原価スナップショット（オプショナル）。
  // schemaVersion 1のデータには存在しない（存在しなくても妥当）。
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

  return {
    contractId,
    companyId,
    market,
    product,
    contractedPeriod,
    dueDate,
    originalQuantity,
    outstandingQuantity,
    unitPrice,
    status,
    ...(costSnapshot !== undefined ? { costSnapshot } : {}),
  };
}

// ---------------------------------------------------------------------
// Raw material lot
// ---------------------------------------------------------------------

function validateLot(raw: unknown, path: string): RawMaterialLot {
  const obj = requireObject(raw, path);

  const lotId = requireNonEmptyString(obj.lotId, `${path}.lotId`);
  const companyId = requireNonEmptyString(obj.companyId, `${path}.companyId`);
  const source: RawMaterialSource = requireEnum(obj.source, LOT_SOURCES, `${path}.source`);
  const originCountry: CountryId = requireEnum(obj.originCountry, COUNTRY_IDS, `${path}.originCountry`);
  const inboundPeriod = requirePeriod(obj.inboundPeriod, `${path}.inboundPeriod`);
  const originalQuantity = wrapUnitConstructor(hosoEqTons, obj.originalQuantity, `${path}.originalQuantity`);
  const remainingQuantity = wrapUnitConstructor(hosoEqTons, obj.remainingQuantity, `${path}.remainingQuantity`);
  if (unwrapUnit(remainingQuantity) > unwrapUnit(originalQuantity) + EPSILON) {
    fail(`${path}.remainingQuantity`, "originalQuantityを超えてはなりません（remainingQuantity <= originalQuantityである必要があります）");
  }
  const unitCost = wrapUnitConstructor(usdPerHosoEqKg, obj.unitCost, `${path}.unitCost`);
  const availableFromPeriod = requirePeriod(obj.availableFromPeriod, `${path}.availableFromPeriod`);
  const expiryPeriod = requireOptionalPeriod(obj.expiryPeriod, `${path}.expiryPeriod`);
  const status: RawMaterialLotStatus = requireEnum(obj.status, LOT_STATUSES, `${path}.status`);

  // status固有フィールドとの整合性チェック（実装指示§5「輸入中、養殖中、
  // available等のstatusと必要フィールドの整合性が取れていること」）。
  if (status === "inTransitImport" && source !== "import") {
    fail(`${path}.source`, 'status="inTransitImport"のロットはsource="import"である必要があります');
  }

  const hasPendingAquacultureFields =
    obj.pendingAquacultureIntensity !== undefined || obj.pendingBioSecurityLevel !== undefined || obj.pendingPlannedStockingQuantity !== undefined;

  if (status === "growingAquaculture") {
    if (source !== "aquaculture") {
      fail(`${path}.source`, 'status="growingAquaculture"のロットはsource="aquaculture"である必要があります');
    }
    if (obj.pendingAquacultureIntensity === undefined || obj.pendingBioSecurityLevel === undefined || obj.pendingPlannedStockingQuantity === undefined) {
      fail(
        path,
        'status="growingAquaculture"のロットは pendingAquacultureIntensity・pendingBioSecurityLevel・pendingPlannedStockingQuantity をすべて保持している必要があります'
      );
    }
  } else if (hasPendingAquacultureFields) {
    fail(path, `status="${status}"のロットに養殖の池入れ保留フィールド（pendingAquacultureIntensity等）が含まれています（growingAquaculture以外では保持しません）`);
  }

  const pendingAquacultureIntensity: Ratio | undefined =
    obj.pendingAquacultureIntensity === undefined ? undefined : wrapUnitConstructor(ratio, obj.pendingAquacultureIntensity, `${path}.pendingAquacultureIntensity`);
  const pendingBioSecurityLevel: Ratio | undefined =
    obj.pendingBioSecurityLevel === undefined ? undefined : wrapUnitConstructor(ratio, obj.pendingBioSecurityLevel, `${path}.pendingBioSecurityLevel`);
  const pendingPlannedStockingQuantity: HosoEqTons | undefined =
    obj.pendingPlannedStockingQuantity === undefined
      ? undefined
      : wrapUnitConstructor(hosoEqTons, obj.pendingPlannedStockingQuantity, `${path}.pendingPlannedStockingQuantity`);

  // 実行時のロット生成コード（inventory.ts・imports.ts等）は、pending系・
  // expiryPeriodフィールドを「値がない場合はキー自体を持たせない」流儀で
  // 構築している。decode側でも同じ流儀に合わせ、undefinedの場合はキー自体を
  // 持たせない（JSONは「キー有りでundefined」を表現できないため、往復後の
  // オブジェクト形状を実行時の典型的な形へ揃えるための措置）。
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

// ---------------------------------------------------------------------
// Quality / trust / reliability（Phase 7A、schemaVersion 3で追加）
// ---------------------------------------------------------------------

/**
 * schemaVersion 1/2のデータ（qualityReliabilityキー自体が存在しない）を読む
 * 際に補う安全な初期値。空配列一式＝「品質・信頼・納期信頼性・増産履歴に
 * ついて何も蓄積されていない」状態であり、不正な値ではない
 * （types.tsのバージョン履歴コメント参照）。
 */
const EMPTY_QUALITY_RELIABILITY_STATE: QualityReliabilityState = {
  qualityByCompanyProduct: [],
  trustByCompanyMarket: [],
  rampHistory: [],
};

function validateCompanyProductQualityState(raw: unknown, path: string): CompanyProductQualityState {
  const obj = requireObject(raw, path);
  const companyId = requireNonEmptyString(obj.companyId, `${path}.companyId`);
  const product: Product = requireEnum(obj.product, PRODUCTS, `${path}.product`);
  const qualityScore = wrapUnitConstructor(score0to100, obj.qualityScore, `${path}.qualityScore`);
  return { companyId, product, qualityScore };
}

function validateCompanyMarketTrustState(raw: unknown, path: string): CompanyMarketTrustState {
  const obj = requireObject(raw, path);
  const companyId = requireNonEmptyString(obj.companyId, `${path}.companyId`);
  const market: DemandMarketId = requireEnum(obj.market, DEMAND_MARKET_IDS, `${path}.market`);
  const customerTrustScore = wrapUnitConstructor(score0to100, obj.customerTrustScore, `${path}.customerTrustScore`);
  const deliveryReliabilityScore = wrapUnitConstructor(score0to100, obj.deliveryReliabilityScore, `${path}.deliveryReliabilityScore`);
  return { companyId, market, customerTrustScore, deliveryReliabilityScore };
}

function validateCompanyFactoryProductRampState(raw: unknown, path: string): CompanyFactoryProductRampState {
  const obj = requireObject(raw, path);
  const companyId = requireNonEmptyString(obj.companyId, `${path}.companyId`);
  const factoryId = requireNonEmptyString(obj.factoryId, `${path}.factoryId`);
  const product: Product = requireEnum(obj.product, PRODUCTS, `${path}.product`);
  const lastQuarterProductionQuantity = wrapUnitConstructor(hosoEqTons, obj.lastQuarterProductionQuantity, `${path}.lastQuarterProductionQuantity`);
  if (unwrapUnit(lastQuarterProductionQuantity) < 0) {
    fail(`${path}.lastQuarterProductionQuantity`, "0以上である必要があります");
  }
  return { companyId, factoryId, product, lastQuarterProductionQuantity };
}

/**
 * qualityReliabilityを検証する。obj.qualityReliability自体が存在しない場合
 * （schemaVersion 1/2データ）はEMPTY_QUALITY_RELIABILITY_STATEを返す
 * （安全な初期値を補う。types.tsのバージョン履歴コメント参照）。存在する場合は
 * 内容を完全に検証し、不正なスコア・比率・数量（NaN・Infinity・範囲外）は
 * すべて拒否する。
 */
function validateQualityReliability(raw: unknown, path: string): QualityReliabilityState {
  if (raw === undefined) return EMPTY_QUALITY_RELIABILITY_STATE;
  const obj = requireObject(raw, path);

  const qualityRaw = requireArray(obj.qualityByCompanyProduct, `${path}.qualityByCompanyProduct`);
  const qualityByCompanyProduct = qualityRaw.map((q, i) => validateCompanyProductQualityState(q, `${path}.qualityByCompanyProduct[${i}]`));

  const trustRaw = requireArray(obj.trustByCompanyMarket, `${path}.trustByCompanyMarket`);
  const trustByCompanyMarket = trustRaw.map((t, i) => validateCompanyMarketTrustState(t, `${path}.trustByCompanyMarket[${i}]`));

  const rampRaw = requireArray(obj.rampHistory, `${path}.rampHistory`);
  const rampHistory = rampRaw.map((r, i) => validateCompanyFactoryProductRampState(r, `${path}.rampHistory[${i}]`));

  return { qualityByCompanyProduct, trustByCompanyMarket, rampHistory };
}

// ---------------------------------------------------------------------
// 財務状態（Phase 8A、schemaVersion 4）
// ---------------------------------------------------------------------

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

/** USD金額（負数許容: 現金・利益剰余金）。NaN/Infinityはfinanceのusd()が拒否する。 */
function requireUsd(value: unknown, path: string): Usd {
  const n = requireFiniteNumber(value, path);
  try {
    return usd(n);
  } catch (e) {
    return fail(path, e instanceof Error ? e.message : "USD金額として不正です");
  }
}

/** 負数を許容しないUSD残高（在庫金額・売掛/買掛・借入金・資本金等）。 */
function requireNonNegativeUsd(value: unknown, path: string): Usd {
  const v = requireUsd(value, path);
  if ((v as number) < 0) fail(path, "負数を許容しない残高です（0以上である必要があります）");
  return v;
}

function requireNonNegativeFinite(value: unknown, path: string): number {
  const n = requireFiniteNumber(value, path);
  if (n < 0) fail(path, "0以上である必要があります");
  return n;
}

function validateReceivable(raw: unknown, path: string): ReceivableRecord {
  const obj = requireObject(raw, path);
  return {
    id: requireNonEmptyString(obj.id, `${path}.id`),
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    market: requireEnum(obj.market, DEMAND_MARKET_IDS, `${path}.market`),
    amount: requireNonNegativeUsd(obj.amount, `${path}.amount`),
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
    amount: requireNonNegativeUsd(obj.amount, `${path}.amount`),
    originPeriod: requirePeriod(obj.originPeriod, `${path}.originPeriod`),
    dueSettlementPeriod: requirePeriod(obj.dueSettlementPeriod, `${path}.dueSettlementPeriod`),
    sourceRef: requireString(obj.sourceRef, `${path}.sourceRef`),
  };
}

function validateUnitCostBreakdown(raw: unknown, path: string): FinishedGoodsUnitCostBreakdown {
  const obj = requireObject(raw, path);
  return {
    rawMaterialPerTon: requireNonNegativeFinite(obj.rawMaterialPerTon, `${path}.rawMaterialPerTon`),
    processingPerTon: requireNonNegativeFinite(obj.processingPerTon, `${path}.processingPerTon`),
    laborVariablePerTon: requireNonNegativeFinite(obj.laborVariablePerTon, `${path}.laborVariablePerTon`),
    utilityVariablePerTon: requireNonNegativeFinite(obj.utilityVariablePerTon, `${path}.utilityVariablePerTon`),
    laborFixedPerTon: requireNonNegativeFinite(obj.laborFixedPerTon, `${path}.laborFixedPerTon`),
    factoryFixedPerTon: requireNonNegativeFinite(obj.factoryFixedPerTon, `${path}.factoryFixedPerTon`),
    utilityFixedPerTon: requireNonNegativeFinite(obj.utilityFixedPerTon, `${path}.utilityFixedPerTon`),
    depreciationPerTon: requireNonNegativeFinite(obj.depreciationPerTon, `${path}.depreciationPerTon`),
  };
}

function validateLedgerEntry(raw: unknown, path: string): FinishedGoodsCostLedgerEntry {
  const obj = requireObject(raw, path);
  const downgradeRatio = requireNonNegativeFinite(obj.downgradeRatio, `${path}.downgradeRatio`);
  if (downgradeRatio > 1) fail(`${path}.downgradeRatio`, "0〜1である必要があります");
  return {
    lotId: requireNonEmptyString(obj.lotId, `${path}.lotId`),
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    product: requireEnum(obj.product, PRODUCTS, `${path}.product`),
    remainingQuantity: requireNonNegativeFinite(obj.remainingQuantity, `${path}.remainingQuantity`),
    unitCost: validateUnitCostBreakdown(obj.unitCost, `${path}.unitCost`),
    downgradeRatio,
    producedPeriod: requirePeriod(obj.producedPeriod, `${path}.producedPeriod`),
  };
}

function validateCompanyFinanceState(raw: unknown, path: string): CompanyFinanceState {
  const obj = requireObject(raw, path);
  const fixedAssetsGross = requireNonNegativeUsd(obj.fixedAssetsGross, `${path}.fixedAssetsGross`);
  const accumulatedDepreciation = requireNonNegativeUsd(obj.accumulatedDepreciation, `${path}.accumulatedDepreciation`);
  if ((accumulatedDepreciation as number) > (fixedAssetsGross as number) + EPSILON) {
    fail(`${path}.accumulatedDepreciation`, "固定資産の取得原価総額を超えてはなりません");
  }
  const receivablesRaw = requireArray(obj.receivables, `${path}.receivables`);
  const payablesRaw = requireArray(obj.payables, `${path}.payables`);
  const ledgerRaw = requireArray(obj.finishedGoodsCostLedger, `${path}.finishedGoodsCostLedger`);
  return {
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    cash: requireUsd(obj.cash, `${path}.cash`), // 現金は負数許容（明示的な資金不足状態）
    receivables: receivablesRaw.map((r, i) => validateReceivable(r, `${path}.receivables[${i}]`)),
    payables: payablesRaw.map((p, i) => validatePayable(p, `${path}.payables[${i}]`)),
    otherCurrentAssets: requireNonNegativeUsd(obj.otherCurrentAssets, `${path}.otherCurrentAssets`),
    fixedAssetsGross,
    accumulatedDepreciation,
    shortTermLoans: requireNonNegativeUsd(obj.shortTermLoans, `${path}.shortTermLoans`),
    longTermLoans: requireNonNegativeUsd(obj.longTermLoans, `${path}.longTermLoans`),
    otherLiabilities: requireNonNegativeUsd(obj.otherLiabilities, `${path}.otherLiabilities`),
    capitalStock: requireNonNegativeUsd(obj.capitalStock, `${path}.capitalStock`),
    retainedEarnings: requireUsd(obj.retainedEarnings, `${path}.retainedEarnings`), // 負数許容
    finishedGoodsCostLedger: ledgerRaw.map((e, i) => validateLedgerEntry(e, `${path}.finishedGoodsCostLedger[${i}]`)),
  };
}

/**
 * financeStatesを検証する。obj.financeStates自体が存在しない場合
 * （schemaVersion 1/2/3データ）は空配列＝財務状態未初期化を返す
 * （安全な初期値を補う。types.tsのバージョン履歴コメント参照）。
 */
function validateFinanceStates(raw: unknown, path: string): readonly CompanyFinanceState[] {
  if (raw === undefined) return [];
  const arr = requireArray(raw, path);
  return arr.map((f, i) => validateCompanyFinanceState(f, `${path}[${i}]`));
}

// ---------------------------------------------------------------------
// 資金繰り状態（Phase 8B-1、schemaVersion 5）
// ---------------------------------------------------------------------

/** 0以上の有限数（USD残高・年率等）。負数・NaN・Infinityはすべて拒否する。 */
function requireNonNegativeFiniteUsd(value: unknown, path: string): number {
  const n = requireFiniteNumber(value, path);
  if (n < 0) fail(path, "0以上である必要があります（負の残高・負の利率・負の返済額は不正です）");
  return n;
}

function validateLoanRecord(raw: unknown, path: string): LoanRecord {
  const obj = requireObject(raw, path);

  const originalPrincipalUsd = requireNonNegativeFiniteUsd(obj.originalPrincipalUsd, `${path}.originalPrincipalUsd`);
  const currentPrincipalUsd = requireNonNegativeFiniteUsd(obj.currentPrincipalUsd, `${path}.currentPrincipalUsd`);
  if (currentPrincipalUsd > originalPrincipalUsd + EPSILON) {
    fail(`${path}.currentPrincipalUsd`, "originalPrincipalUsdを超えてはなりません（currentPrincipalUsd <= originalPrincipalUsdである必要があります）");
  }
  const originationPeriod = requirePeriod(obj.originationPeriod, `${path}.originationPeriod`);
  const maturityPeriod = requirePeriod(obj.maturityPeriod, `${path}.maturityPeriod`);
  if (maturityPeriod < originationPeriod) {
    fail(`${path}.maturityPeriod`, "originationPeriod以降である必要があります");
  }
  const equalPrincipalInstallmentUsd = requireNonNegativeFiniteUsd(obj.equalPrincipalInstallmentUsd, `${path}.equalPrincipalInstallmentUsd`);
  const refinancedFromLoanId =
    obj.refinancedFromLoanId === undefined ? undefined : requireNonEmptyString(obj.refinancedFromLoanId, `${path}.refinancedFromLoanId`);

  return {
    loanId: requireNonEmptyString(obj.loanId, `${path}.loanId`),
    companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`),
    loanType: requireEnum(obj.loanType, LOAN_TYPES, `${path}.loanType`),
    originalPrincipalUsd,
    currentPrincipalUsd,
    originationPeriod,
    maturityPeriod,
    // 年率・信用スプレッドは負数を許容しない（0は許容: 免除等の将来拡張余地は残すが、負の金利は不正）。
    annualInterestRate: requireNonNegativeFiniteUsd(obj.annualInterestRate, `${path}.annualInterestRate`),
    creditSpreadAnnual: requireNonNegativeFiniteUsd(obj.creditSpreadAnnual, `${path}.creditSpreadAnnual`),
    repaymentMethod: requireEnum(obj.repaymentMethod, REPAYMENT_METHODS, `${path}.repaymentMethod`),
    equalPrincipalInstallmentUsd,
    arrearsPrincipalUsd: requireNonNegativeFiniteUsd(obj.arrearsPrincipalUsd, `${path}.arrearsPrincipalUsd`),
    arrearsInterestUsd: requireNonNegativeFiniteUsd(obj.arrearsInterestUsd, `${path}.arrearsInterestUsd`),
    status: requireEnum(obj.status, LOAN_STATUSES, `${path}.status`),
    isEmergency: requireBoolean(obj.isEmergency, `${path}.isEmergency`),
    ...(refinancedFromLoanId !== undefined ? { refinancedFromLoanId } : {}),
  };
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "真偽値である必要があります");
  return value;
}

function validateLoanPortfolio(raw: unknown, companyId: string, path: string): LoanPortfolio {
  const obj = requireObject(raw, path);
  const loansRaw = requireArray(obj.loans, `${path}.loans`);
  const loans = loansRaw.map((l, i) => validateLoanRecord(l, `${path}.loans[${i}]`));
  for (const loan of loans) {
    if (loan.companyId !== companyId) {
      fail(`${path}.loans`, `融資ポートフォリオの会社ID(${loan.companyId})が所属会社(${companyId})と一致しません`);
    }
  }
  return { companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`), loans };
}

function validateCompanyFinancingHistory(raw: unknown, path: string): CompanyFinancingHistory {
  const obj = requireObject(raw, path);
  const lastFinancialHealth =
    obj.lastFinancialHealth === undefined ? undefined : requireEnum(obj.lastFinancialHealth, FINANCIAL_HEALTH_TIERS, `${path}.lastFinancialHealth`);
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
  const companyId = requireNonEmptyString(obj.companyId, `${path}.companyId`);
  return {
    companyId,
    loanPortfolio: validateLoanPortfolio(obj.loanPortfolio, companyId, `${path}.loanPortfolio`),
    accruedInterestPayableUsd: requireNonNegativeFiniteUsd(obj.accruedInterestPayableUsd, `${path}.accruedInterestPayableUsd`),
    history: validateCompanyFinancingHistory(obj.history, `${path}.history`),
  };
}

/**
 * financingStatesを検証する。obj.financingStates自体が存在しない場合
 * （schemaVersion 1〜4データ）は空配列＝資金繰り状態未初期化を返す
 * （安全な初期値を補う。types.tsのバージョン履歴コメント参照）。
 */
function validateFinancingStates(raw: unknown, path: string): readonly CompanyFinancingState[] {
  if (raw === undefined) return [];
  const arr = requireArray(raw, path);
  return arr.map((f, i) => validateCompanyFinancingState(f, `${path}[${i}]`));
}

// ---------------------------------------------------------------------
// 設備投資状態（Phase 8B-2A、schemaVersion 6）
// ---------------------------------------------------------------------

// 【Phase 8B-2B】"commonProcessing"（共通前処理能力）・"freezingPackaging"
// （冷凍・包装能力）を追加。旧"common"（Phase 8B-2Aでは常にcapacityIncreaseTons
// PerQuarter=0とペアの無効値としてのみ存在し、companyLab→Redis/API実配線が
// 対象外だった当時、実際にどの保存データへも書き込まれたことがない）は、
// 万一の後方互換のためdecode側では引き続き許容し続ける（新規書き込みはもう
// 発生しない。書き込み側はtargetProductを省略するか新値のみを使う）。
// 【Phase 8D-5→Phase 8D監査M-2修正】"coldStorage"（冷凍・冷蔵保管能力＝ストック）を
// 追加。capex/types.tsのFutureCapacityEffectPlaceholder.targetProductにはPhase 8D-5で
// 既に追加済みだったが、無印/v2側のこの許容リストへの追加が漏れていた
// （companyLab側の永続化はtargetProductを列挙値ではなく自由文字列として検証しており
// この種の列挙漏れが構造的に起きない。無印/v2側だけがこの列挙リスト方式のため、
// この漏れは無印/v2経路にのみ存在した）。
const FUTURE_CAPACITY_TARGET_PRODUCTS: readonly string[] = [
  "hoso",
  "pd",
  "vap",
  "common",
  "commonProcessing",
  "freezingPackaging",
  "coldStorage",
];

function validateFutureCapacityEffectPlaceholder(raw: unknown, path: string): FutureCapacityEffectPlaceholder {
  const obj = requireObject(raw, path);
  const targetProduct =
    obj.targetProduct === undefined ? undefined : requireEnum(obj.targetProduct, FUTURE_CAPACITY_TARGET_PRODUCTS, `${path}.targetProduct`);
  const capacityIncreaseTonsPerQuarter =
    obj.capacityIncreaseTonsPerQuarter === undefined ? undefined : requireNonNegativeFiniteUsd(obj.capacityIncreaseTonsPerQuarter, `${path}.capacityIncreaseTonsPerQuarter`);
  const readinessQuartersAfterCompletion =
    obj.readinessQuartersAfterCompletion === undefined ? undefined : requireNonNegativeInteger(obj.readinessQuartersAfterCompletion, `${path}.readinessQuartersAfterCompletion`);
  return {
    ...(targetProduct !== undefined ? { targetProduct: targetProduct as FutureCapacityEffectPlaceholder["targetProduct"] } : {}),
    ...(capacityIncreaseTonsPerQuarter !== undefined ? { capacityIncreaseTonsPerQuarter } : {}),
    ...(readinessQuartersAfterCompletion !== undefined ? { readinessQuartersAfterCompletion } : {}),
  };
}

function validatePaymentScheduleStage(raw: unknown, expectedIndex: number, path: string): PaymentScheduleStage {
  const obj = requireObject(raw, path);
  const stageIndex = requireNonNegativeInteger(obj.stageIndex, `${path}.stageIndex`);
  if (stageIndex !== expectedIndex) {
    fail(`${path}.stageIndex`, `配列上の位置(${expectedIndex})と一致しません（受け取った値: ${stageIndex}）`);
  }
  const plannedRatio = requireFiniteNumber(obj.plannedRatio, `${path}.plannedRatio`);
  if (plannedRatio <= 0 || plannedRatio > 1 + EPSILON) {
    fail(`${path}.plannedRatio`, "0より大きく1以下である必要があります");
  }
  return { stageIndex, plannedRatio };
}

function validateCapitalProject(raw: unknown, companyId: string, path: string): CapitalProject {
  const obj = requireObject(raw, path);

  const projectId = requireNonEmptyString(obj.projectId, `${path}.projectId`);
  const projectCompanyId = requireNonEmptyString(obj.companyId, `${path}.companyId`);
  if (projectCompanyId !== companyId) {
    fail(`${path}.companyId`, `投資案件の会社ID(${projectCompanyId})が所属会社(${companyId})と一致しません`);
  }
  const projectType: CapitalProjectType = requireEnum(obj.projectType, CAPITAL_PROJECT_TYPES, `${path}.projectType`);
  const approvedBudgetUsd = requireFiniteNumber(obj.approvedBudgetUsd, `${path}.approvedBudgetUsd`);
  if (approvedBudgetUsd <= 0) fail(`${path}.approvedBudgetUsd`, "0より大きい必要があります");

  const scheduleRaw = requireArray(obj.paymentSchedule, `${path}.paymentSchedule`);
  const paymentSchedule = scheduleRaw.map((s, i) => validatePaymentScheduleStage(s, i, `${path}.paymentSchedule[${i}]`));
  if (paymentSchedule.length === 0) fail(`${path}.paymentSchedule`, "1件以上である必要があります");
  const ratioSum = paymentSchedule.reduce((s, st) => s + st.plannedRatio, 0);
  if (Math.abs(ratioSum - 1) > 1e-4) {
    fail(`${path}.paymentSchedule`, `予定支払比率の合計が1.0ではありません（${ratioSum}）`);
  }

  const completedPaymentStagesCount = requireNonNegativeInteger(obj.completedPaymentStagesCount, `${path}.completedPaymentStagesCount`);
  if (completedPaymentStagesCount > paymentSchedule.length) {
    fail(`${path}.completedPaymentStagesCount`, "paymentSchedule.lengthを超えてはなりません");
  }
  const cumulativePaidUsd = requireNonNegativeFiniteUsd(obj.cumulativePaidUsd, `${path}.cumulativePaidUsd`);
  if (cumulativePaidUsd > approvedBudgetUsd + EPSILON) {
    fail(`${path}.cumulativePaidUsd`, "approvedBudgetUsdを超えてはなりません");
  }
  const elapsedConstructionQuartersWithPayment = requireNonNegativeInteger(
    obj.elapsedConstructionQuartersWithPayment,
    `${path}.elapsedConstructionQuartersWithPayment`
  );
  const requiredConstructionQuarters = requireNonNegativeInteger(obj.requiredConstructionQuarters, `${path}.requiredConstructionQuarters`);
  if (requiredConstructionQuarters <= 0) fail(`${path}.requiredConstructionQuarters`, "1以上の整数である必要があります");

  const status: CapitalProjectStatus = requireEnum(obj.status, CAPITAL_PROJECT_STATUSES, `${path}.status`);
  const proposedPeriod = requirePeriod(obj.proposedPeriod, `${path}.proposedPeriod`);
  const approvedPeriod = requirePeriod(obj.approvedPeriod, `${path}.approvedPeriod`);
  if (approvedPeriod < proposedPeriod) fail(`${path}.approvedPeriod`, "proposedPeriod以降である必要があります");
  const constructionStartedPeriod = requireOptionalPeriod(obj.constructionStartedPeriod, `${path}.constructionStartedPeriod`);
  if (constructionStartedPeriod !== undefined && constructionStartedPeriod < approvedPeriod) {
    fail(`${path}.constructionStartedPeriod`, "approvedPeriod以降である必要があります");
  }
  const completedPeriod = requireOptionalPeriod(obj.completedPeriod, `${path}.completedPeriod`);
  const cancelledPeriod = requireOptionalPeriod(obj.cancelledPeriod, `${path}.cancelledPeriod`);
  const capitalizedAmountUsd =
    obj.capitalizedAmountUsd === undefined ? undefined : requireNonNegativeFiniteUsd(obj.capitalizedAmountUsd, `${path}.capitalizedAmountUsd`);
  const priority = requireFiniteNumber(obj.priority, `${path}.priority`);
  const futureCapacityEffect =
    obj.futureCapacityEffect === undefined ? undefined : validateFutureCapacityEffectPlaceholder(obj.futureCapacityEffect, `${path}.futureCapacityEffect`);
  const reasonsRaw = requireArray(obj.lastDiagnosticReasons, `${path}.lastDiagnosticReasons`);
  const lastDiagnosticReasons = reasonsRaw.map((r, i) => requireString(r, `${path}.lastDiagnosticReasons[${i}]`));

  // status別の整合性チェック（実装指示§10・§25。statusと関連フィールドの矛盾を拒否する）。
  if (status === "completed") {
    if (completedPeriod === undefined) fail(path, 'status="completed"の案件はcompletedPeriodを保持している必要があります');
    if (capitalizedAmountUsd === undefined) fail(path, 'status="completed"の案件はcapitalizedAmountUsdを保持している必要があります');
    if (Math.abs(capitalizedAmountUsd - cumulativePaidUsd) > EPSILON) {
      fail(`${path}.capitalizedAmountUsd`, "cumulativePaidUsdと一致する必要があります");
    }
    if (completedPaymentStagesCount !== paymentSchedule.length) {
      fail(`${path}.completedPaymentStagesCount`, 'status="completed"の案件は全分割払いが完了している必要があります');
    }
  } else if (completedPeriod !== undefined || capitalizedAmountUsd !== undefined) {
    fail(path, `status="${status}"の案件にcompletedPeriod・capitalizedAmountUsdが含まれています（completed以外では保持しません）`);
  }
  if (status === "cancelled") {
    if (cancelledPeriod === undefined) fail(path, 'status="cancelled"の案件はcancelledPeriodを保持している必要があります');
    if (cumulativePaidUsd > EPSILON) fail(path, 'status="cancelled"の案件は支払実績が無い（cumulativePaidUsd=0）はずです');
  } else if (cancelledPeriod !== undefined) {
    fail(path, `status="${status}"の案件にcancelledPeriodが含まれています（cancelled以外では保持しません）`);
  }
  if (status === "approved" && (completedPaymentStagesCount !== 0 || cumulativePaidUsd > EPSILON)) {
    fail(path, 'status="approved"（未着工）の案件に支払実績が含まれています');
  }

  return {
    projectId,
    companyId: projectCompanyId,
    projectType,
    approvedBudgetUsd,
    paymentSchedule,
    completedPaymentStagesCount,
    cumulativePaidUsd,
    elapsedConstructionQuartersWithPayment,
    requiredConstructionQuarters,
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

function validateCapitalProjectPortfolio(raw: unknown, companyId: string, path: string): CapitalProjectPortfolio {
  const obj = requireObject(raw, path);
  const projectsRaw = requireArray(obj.projects, `${path}.projects`);
  const projects = projectsRaw.map((p, i) => validateCapitalProject(p, companyId, `${path}.projects[${i}]`));
  const seenIds = new Set<string>();
  for (const p of projects) {
    if (seenIds.has(p.projectId)) fail(`${path}.projects`, `投資案件ID(${p.projectId})が重複しています`);
    seenIds.add(p.projectId);
  }
  return { companyId: requireNonEmptyString(obj.companyId, `${path}.companyId`), projects };
}

function validateCompanyCapexState(raw: unknown, path: string): CompanyCapexState {
  const obj = requireObject(raw, path);
  const companyId = requireNonEmptyString(obj.companyId, `${path}.companyId`);
  const nextProjectSequence = requireFiniteNumber(obj.nextProjectSequence, `${path}.nextProjectSequence`);
  if (!Number.isInteger(nextProjectSequence) || nextProjectSequence < 1) {
    fail(`${path}.nextProjectSequence`, "1以上の整数である必要があります");
  }
  return {
    companyId,
    portfolio: validateCapitalProjectPortfolio(obj.portfolio, companyId, `${path}.portfolio`),
    nextProjectSequence,
  };
}

/**
 * capexStatesを検証する。obj.capexStates自体が存在しない場合
 * （schemaVersion 1〜5データ）は空配列＝設備投資状態未初期化を返す
 * （安全な初期値を補う。types.tsのバージョン履歴コメント参照）。
 */
function validateCapexStates(raw: unknown, path: string): readonly CompanyCapexState[] {
  if (raw === undefined) return [];
  const arr = requireArray(raw, path);
  return arr.map((c, i) => validateCompanyCapexState(c, `${path}[${i}]`));
}

// ---------------------------------------------------------------------
// Execution / Metadata
// ---------------------------------------------------------------------

function validateExecution(raw: unknown, currentPeriod: PeriodV2, path: string): PersistedGameStateExecution {
  const obj = requireObject(raw, path);
  const completedTurnCount = requireNonNegativeInteger(obj.completedTurnCount, `${path}.completedTurnCount`);

  const lastCompletedPeriod = requireOptionalPeriod(obj.lastCompletedPeriod, `${path}.lastCompletedPeriod`);
  if (lastCompletedPeriod !== undefined && !(lastCompletedPeriod < currentPeriod)) {
    fail(`${path}.lastCompletedPeriod`, "currentPeriodより前である必要があります");
  }

  const lastTurnExecutionId =
    obj.lastTurnExecutionId === undefined ? undefined : requireNonEmptyString(obj.lastTurnExecutionId, `${path}.lastTurnExecutionId`);

  return {
    completedTurnCount,
    ...(lastCompletedPeriod !== undefined ? { lastCompletedPeriod } : {}),
    ...(lastTurnExecutionId !== undefined ? { lastTurnExecutionId } : {}),
  };
}

function validateMetadata(raw: unknown, path: string): PersistedGameStateMetadata {
  const obj = requireObject(raw, path);
  const createdAt = requireIsoTimestamp(obj.createdAt, `${path}.createdAt`);
  const updatedAt = requireIsoTimestamp(obj.updatedAt, `${path}.updatedAt`);
  if (Date.parse(createdAt) > Date.parse(updatedAt)) {
    fail(`${path}.updatedAt`, "createdAtより前であってはなりません（updatedAt >= createdAtである必要があります）");
  }
  return { createdAt, updatedAt };
}

// ---------------------------------------------------------------------
// トップレベル
// ---------------------------------------------------------------------

/**
 * 任意のJSON値（JSON.parseの戻り値）を、ランタイム検証しながら
 * PersistedGameStateV2へ変換する。`as PersistedGameStateV2`のような型アサー
 * ションのみでは済ませない（実装指示§4・§6）。ブランド型・PeriodV2の復元は
 * 既存のスマートコンストラクタ（core/units.ts・core/period.ts）を必ず経由する。
 *
 * schemaVersionの扱い（実装指示§3）:
 *   - 欠落・非整数・1未満 → PersistedStateValidationError（内容の不正）
 *   - 現行実装より新しい（例: 2以上、現行が1の場合） → UnsupportedPersistedStateVersionError
 *   - 対応済みバージョンだが他のフィールドが壊れている → PersistedStateValidationError
 * 本Phaseではバージョン1のみが存在し、マイグレーション自体は未実装だが、
 * 将来「schemaVersionに応じて異なるフィールド構成を読む」分岐をこの関数へ
 * 追加できる構造にしてある（詳細はdocs/v2アーキテクチャ文書参照）。
 */
export function validatePersistedGameState(raw: unknown): PersistedGameStateV2 {
  const obj = requireObject(raw, "$");

  if (obj.schemaVersion === undefined) {
    fail("$.schemaVersion", "schemaVersionが存在しません");
  }
  const rawVersion = obj.schemaVersion;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 1) {
    fail("$.schemaVersion", `不正なschemaVersionです（1以上の整数である必要があります）。受け取った値: ${JSON.stringify(rawVersion)}`);
  }
  if (rawVersion > CURRENT_PERSISTED_GAME_STATE_VERSION) {
    throw new UnsupportedPersistedStateVersionError(rawVersion, CURRENT_PERSISTED_GAME_STATE_VERSION);
  }
  const schemaVersion = rawVersion;

  const gameId = requireNonEmptyString(obj.gameId, "$.gameId");
  const scenarioId = requireNonEmptyString(obj.scenarioId, "$.scenarioId");
  const currentPeriod = requirePeriod(obj.currentPeriod, "$.currentPeriod");
  const seed = requireNonEmptyString(obj.seed, "$.seed");

  const contractsRaw = requireArray(obj.contracts, "$.contracts");
  const contracts = contractsRaw.map((c, i) => validateContract(c, `$.contracts[${i}]`));

  const lotsRaw = requireArray(obj.rawMaterialLots, "$.rawMaterialLots");
  const rawMaterialLots = lotsRaw.map((l, i) => validateLot(l, `$.rawMaterialLots[${i}]`));

  // Phase 7A（schemaVersion 3）。v1/v2データ（キー自体が存在しない）は
  // 安全な初期値で補う（宣言されたschemaVersionの値に関わらず、キーの有無で
  // 判定する。§バージョン履歴コメント参照）。
  const qualityReliability = validateQualityReliability(obj.qualityReliability, "$.qualityReliability");

  // Phase 8A（schemaVersion 4）。v1/v2/v3データ（キー自体が存在しない）は
  // 空配列＝財務状態未初期化を補う（キーの有無で判定する）。
  const financeStates = validateFinanceStates(obj.financeStates, "$.financeStates");

  // Phase 8B-1（schemaVersion 5）。v1〜v4データ（キー自体が存在しない）は
  // 空配列＝資金繰り状態未初期化を補う（キーの有無で判定する）。
  const financingStates = validateFinancingStates(obj.financingStates, "$.financingStates");

  // Phase 8B-2A（schemaVersion 6）。v1〜v5データ（キー自体が存在しない）は
  // 空配列＝設備投資状態未初期化を補う（キーの有無で判定する）。
  const capexStates = validateCapexStates(obj.capexStates, "$.capexStates");

  const execution = validateExecution(obj.execution, currentPeriod, "$.execution");
  const metadata = validateMetadata(obj.metadata, "$.metadata");

  return {
    schemaVersion,
    gameId,
    scenarioId,
    currentPeriod,
    seed,
    contracts,
    rawMaterialLots,
    qualityReliability,
    financeStates,
    financingStates,
    capexStates,
    execution,
    metadata,
  };
}
