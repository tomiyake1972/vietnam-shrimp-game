// ShrimpX V2 — 永続化状態・シリアライズ契約 encode/decode（Phase 5.6）
//
// PersistedGameStateV2 ⇄ JSON文字列 の純粋な相互変換。JSONを使用する。
// encode結果は決定論的（同じ状態からは常に同じ文字列）。decode時には
// schema.tsのvalidatePersistedGameStateで必ずランタイム検証する
// （`as PersistedGameStateV2`だけで済ませない）。

import { unwrapUnit } from "../core/units";
import { RawMaterialLot } from "../rawMaterials/types";
import { SalesContract } from "../sales/types";
import { CompanyFactoryProductRampState, CompanyMarketTrustState, CompanyProductQualityState, QualityReliabilityState } from "../quality/types";
import { PersistedGameStateV2 } from "./types";
import { PersistedStateParseError } from "./errors";
import { validatePersistedGameState } from "./schema";

/**
 * SalesContractを、固定のキー順序を持つプレーンオブジェクト（DTO）へ変換する。
 * ブランド型（HosoEqTons・UsdPerHosoEqKg）はunwrapUnitでプレーンnumberへ戻す
 * （JSON上はもともとnumberであり、JSON.stringifyはブランド型をそのまま
 * numberとして出力できるが、キー順序を明示的に固定するために都度オブジェクト
 * リテラルを組み立てる）。
 */
function contractToDto(contract: SalesContract): Record<string, unknown> {
  const dto: Record<string, unknown> = {
    contractId: contract.contractId,
    companyId: contract.companyId,
    market: contract.market,
    product: contract.product,
    contractedPeriod: contract.contractedPeriod,
    dueDate: contract.dueDate,
    originalQuantity: unwrapUnit(contract.originalQuantity),
    outstandingQuantity: unwrapUnit(contract.outstandingQuantity),
    unitPrice: unwrapUnit(contract.unitPrice),
    status: contract.status,
  };
  // Phase 6.3（schemaVersion 2）: 契約時予想原価スナップショット（オプショナル、固定キー順序）。
  if (contract.costSnapshot !== undefined) {
    dto.costSnapshot = {
      expectedRawMaterialPriceUsdPerHosoEqKg: contract.costSnapshot.expectedRawMaterialPriceUsdPerHosoEqKg,
      expectedProcessingCostUsdPerHosoEqKg: contract.costSnapshot.expectedProcessingCostUsdPerHosoEqKg,
      minimumAcceptablePriceUsdPerHosoEqKg: contract.costSnapshot.minimumAcceptablePriceUsdPerHosoEqKg,
      expectedContributionMarginUsdPerHosoEqKg: contract.costSnapshot.expectedContributionMarginUsdPerHosoEqKg,
    };
  }
  return dto;
}

/** RawMaterialLotを、固定のキー順序を持つプレーンオブジェクト（DTO）へ変換する。 */
function lotToDto(lot: RawMaterialLot): Record<string, unknown> {
  const dto: Record<string, unknown> = {
    lotId: lot.lotId,
    companyId: lot.companyId,
    source: lot.source,
    originCountry: lot.originCountry,
    inboundPeriod: lot.inboundPeriod,
    originalQuantity: unwrapUnit(lot.originalQuantity),
    remainingQuantity: unwrapUnit(lot.remainingQuantity),
    unitCost: unwrapUnit(lot.unitCost),
    availableFromPeriod: lot.availableFromPeriod,
    status: lot.status,
  };
  if (lot.expiryPeriod !== undefined) dto.expiryPeriod = lot.expiryPeriod;
  if (lot.pendingAquacultureIntensity !== undefined) dto.pendingAquacultureIntensity = unwrapUnit(lot.pendingAquacultureIntensity);
  if (lot.pendingBioSecurityLevel !== undefined) dto.pendingBioSecurityLevel = unwrapUnit(lot.pendingBioSecurityLevel);
  if (lot.pendingPlannedStockingQuantity !== undefined) dto.pendingPlannedStockingQuantity = unwrapUnit(lot.pendingPlannedStockingQuantity);
  return dto;
}

/** CompanyProductQualityStateを固定のキー順序を持つDTOへ変換する（Phase 7A、schemaVersion 3）。 */
function qualityStateToDto(s: CompanyProductQualityState): Record<string, unknown> {
  return {
    companyId: s.companyId,
    product: s.product,
    qualityScore: unwrapUnit(s.qualityScore),
  };
}

/** CompanyMarketTrustStateを固定のキー順序を持つDTOへ変換する（Phase 7A、schemaVersion 3）。 */
function trustStateToDto(t: CompanyMarketTrustState): Record<string, unknown> {
  return {
    companyId: t.companyId,
    market: t.market,
    customerTrustScore: unwrapUnit(t.customerTrustScore),
    deliveryReliabilityScore: unwrapUnit(t.deliveryReliabilityScore),
  };
}

/** CompanyFactoryProductRampStateを固定のキー順序を持つDTOへ変換する（Phase 7A、schemaVersion 3）。 */
function rampStateToDto(r: CompanyFactoryProductRampState): Record<string, unknown> {
  return {
    companyId: r.companyId,
    factoryId: r.factoryId,
    product: r.product,
    lastQuarterProductionQuantity: unwrapUnit(r.lastQuarterProductionQuantity),
  };
}

/** QualityReliabilityStateを固定のキー順序を持つDTOへ変換する（Phase 7A、schemaVersion 3）。 */
function qualityReliabilityToDto(q: QualityReliabilityState): Record<string, unknown> {
  return {
    qualityByCompanyProduct: q.qualityByCompanyProduct.map(qualityStateToDto),
    trustByCompanyMarket: q.trustByCompanyMarket.map(trustStateToDto),
    rampHistory: q.rampHistory.map(rampStateToDto),
  };
}

/**
 * PersistedGameStateV2を、トップレベル・ネストしたオブジェクトいずれも
 * 固定のキー順序を持つDTOへ変換する。契約・ロットの配列順序は一切
 * 並べ替えない（ゲームロジック上の状態としてそのまま維持する）。
 */
function toCanonicalDto(state: PersistedGameStateV2): Record<string, unknown> {
  return {
    schemaVersion: state.schemaVersion,
    gameId: state.gameId,
    scenarioId: state.scenarioId,
    currentPeriod: state.currentPeriod,
    seed: state.seed,
    contracts: state.contracts.map(contractToDto),
    rawMaterialLots: state.rawMaterialLots.map(lotToDto),
    qualityReliability: qualityReliabilityToDto(state.qualityReliability),
    execution: {
      completedTurnCount: state.execution.completedTurnCount,
      ...(state.execution.lastCompletedPeriod !== undefined ? { lastCompletedPeriod: state.execution.lastCompletedPeriod } : {}),
      ...(state.execution.lastTurnExecutionId !== undefined ? { lastTurnExecutionId: state.execution.lastTurnExecutionId } : {}),
    },
    metadata: {
      createdAt: state.metadata.createdAt,
      updatedAt: state.metadata.updatedAt,
    },
  };
}

/**
 * PersistedGameStateV2をJSON文字列へ変換する（純粋関数、入力を変更しない）。
 * 固定のキー順序を持つDTOを都度組み立ててからJSON.stringifyするため、同じ
 * 内容の状態からは常に同じ文字列が生成される（オブジェクトのプロパティ
 * 挿入順序に依存しない）。配列（contracts・rawMaterialLots）の要素順序は
 * 一切変更しない。
 */
export function encodePersistedGameState(state: PersistedGameStateV2): string {
  return JSON.stringify(toCanonicalDto(state));
}

/**
 * JSON文字列をPersistedGameStateV2へ変換する（純粋関数）。JSON.parseに
 * 失敗した場合はPersistedStateParseErrorを投げる。parseに成功した後は、
 * schema.tsのvalidatePersistedGameStateで必ずランタイム検証する
 * （不正な内容はPersistedStateValidationError・
 * UnsupportedPersistedStateVersionErrorとして明示的に拒否される）。
 */
export function decodePersistedGameState(serialized: string): PersistedGameStateV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (e) {
    throw new PersistedStateParseError(`JSONとして解析できません: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validatePersistedGameState(parsed);
}

/**
 * KVストアから読み出した「保存済みの値」をPersistedGameStateV2へ変換する
 * （Phase 5.7・app/lib/v2/redis/のRepositoryが利用する）。
 *
 * 一部のRedisクライアント（例: @upstash/redisはJSON文字列を自動でdeserialize
 * して返すことがある）は、`get()`の戻り値がJSON文字列そのものではなく、
 * 既にパース済みのプレーンオブジェクトになる場合がある。本関数はその両方の
 * 形（文字列 / 既にパース済みの値）を受け付け、いずれの経路でも
 * validatePersistedGameStateによるランタイム検証を必ず通す
 * （文字列の場合はdecodePersistedGameStateと同じ経路、既にパース済みの場合も
 * 検証を省略しない）。呼び出し側（Repository）がJSON.parse/JSON.stringifyを
 * 直接書かずに済むようにするための、この1箇所への集約でもある。
 */
export function decodePersistedGameStateFromStored(raw: unknown): PersistedGameStateV2 {
  if (typeof raw === "string") {
    return decodePersistedGameState(raw);
  }
  return validatePersistedGameState(raw);
}
