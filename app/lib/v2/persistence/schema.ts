// ShrimpX V2 — 永続化状態・シリアライズ契約 ランタイム検証（Phase 5.6）
//
// decode時に「as PersistedGameStateV2」だけで済ませず、必ずランタイムで
// 検証する。ブランド型（HosoEqTons・UsdPerHosoEqKg・Ratio）の復元は、既存の
// スマートコンストラクタ（core/units.tsのhosoEqTons()等）を必ず経由し、
// 単なる型キャストでは復元しない（実装指示§6）。PeriodV2の復元も既存の
// parsePeriod()を経由する。

import { PeriodV2, parsePeriod } from "../core/period";
import { HosoEqTons, Ratio, hosoEqTons, ratio, unwrapUnit, usdPerHosoEqKg } from "../core/units";
import { COUNTRY_IDS, CountryId, DEMAND_MARKET_IDS, DemandMarketId, Product } from "../market/types";
import { ContractStatus, SalesContract } from "../sales/types";
import { RawMaterialLot, RawMaterialLotStatus, RawMaterialSource } from "../rawMaterials/types";
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

  const execution = validateExecution(obj.execution, currentPeriod, "$.execution");
  const metadata = validateMetadata(obj.metadata, "$.metadata");

  return { schemaVersion, gameId, scenarioId, currentPeriod, seed, contracts, rawMaterialLots, execution, metadata };
}
