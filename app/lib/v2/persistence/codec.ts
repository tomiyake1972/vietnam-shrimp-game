// ShrimpX V2 — 永続化状態・シリアライズ契約 encode/decode（Phase 5.6）
//
// PersistedGameStateV2 ⇄ JSON文字列 の純粋な相互変換。JSONを使用する。
// encode結果は決定論的（同じ状態からは常に同じ文字列）。decode時には
// schema.tsのvalidatePersistedGameStateで必ずランタイム検証する
// （`as PersistedGameStateV2`だけで済ませない）。

import { unwrapUnit } from "../core/units";
import { RawMaterialLot } from "../rawMaterials/types";
import { SalesContract } from "../sales/types";
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
  return {
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
