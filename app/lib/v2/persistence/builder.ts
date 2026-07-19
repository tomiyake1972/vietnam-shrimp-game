// ShrimpX V2 — 永続化状態・シリアライズ契約 builder（Phase 5.6）
//
// PersistedGameStateV2の作成・更新・TurnOrchestratorInputへの再構築（hydration）
// を行う、決定論的な純粋関数群。Redis・API・UIには一切依存しない。
// runTurn（app/lib/v2/turn/）・buildNextTurnInput（app/lib/v2/turnState/）の
// 公開契約はいずれも変更しない。既存の状態遷移層（turnState）は「毎ターン
// TurnOrchestratorInputを組み立てる」責務のままであり、本モジュールは
// 「その一部（Period・contracts・lots）をどう永続化するか」だけを扱う、
// 一段外側の層として追加する。

import { PeriodV2 } from "../core/period";
import { SalesContract } from "../sales/types";
import { RawMaterialLot } from "../rawMaterials/types";
import { TurnOrchestratorInput, TurnOrchestratorResult } from "../turn/types";
import { CURRENT_PERSISTED_GAME_STATE_VERSION, ExternalTurnInput, PersistedGameStateV2 } from "./types";
import { PersistedStateTransitionError, PersistedStateValidationError } from "./errors";

function assertNonEmptyString(value: string, label: string): void {
  if (value.length === 0) {
    throw new PersistedStateValidationError(`空文字であってはなりません`, label);
  }
}

function assertValidIsoTimestamp(value: string, label: string): void {
  assertNonEmptyString(value, label);
  if (Number.isNaN(Date.parse(value))) {
    throw new PersistedStateValidationError(`ISO 8601形式の日時として解釈できません。受け取った値: ${JSON.stringify(value)}`, label);
  }
}

// ---------------------------------------------------------------------
// 1. 初期状態の作成
// ---------------------------------------------------------------------

export interface CreateInitialPersistedGameStateInput {
  readonly gameId: string;
  readonly scenarioId: string;
  readonly initialPeriod: PeriodV2;
  readonly seed: string;
  readonly initialContracts: readonly SalesContract[];
  readonly initialRawMaterialLots: readonly RawMaterialLot[];
  readonly createdAt: string;
}

/**
 * 新規ゲームの永続化状態を作成する（純粋関数、入力を変更しない）。
 * completedTurnCountは0、lastCompletedPeriod・lastTurnExecutionIdは未設定、
 * updatedAtはcreatedAtと同じ値にする。
 */
export function createInitialPersistedGameState(input: CreateInitialPersistedGameStateInput): PersistedGameStateV2 {
  assertNonEmptyString(input.gameId, "gameId");
  assertNonEmptyString(input.scenarioId, "scenarioId");
  assertNonEmptyString(input.seed, "seed");
  assertValidIsoTimestamp(input.createdAt, "createdAt");

  return {
    schemaVersion: CURRENT_PERSISTED_GAME_STATE_VERSION,
    gameId: input.gameId,
    scenarioId: input.scenarioId,
    currentPeriod: input.initialPeriod,
    seed: input.seed,
    contracts: [...input.initialContracts],
    rawMaterialLots: [...input.initialRawMaterialLots],
    execution: {
      completedTurnCount: 0,
    },
    metadata: {
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  };
}

// ---------------------------------------------------------------------
// 2. ターン完了後の状態更新
// ---------------------------------------------------------------------

/**
 * 1ターン分のrunTurn結果を、永続化状態へ反映した新しいPersistedGameStateV2を
 * 返す（純粋関数、previousState・turnResultのいずれも変更しない）。
 *
 * 実行識別子と冪等性境界（実装指示§9。Redis上のCAS・分散ロック・transaction
 * は将来課題、docs参照）:
 *   - turnExecutionIdは空文字不可。
 *   - turnExecutionIdがprevious State.execution.lastTurnExecutionIdと同一の
 *     場合、「同じターンの結果を2回適用しようとしている」とみなし
 *     PersistedStateTransitionErrorを投げる（同一実行の再適用を拒否する）。
 *   - turnResult.period が previousState.currentPeriod と一致しない場合も、
 *     実行対象periodの不一致としてPersistedStateTransitionErrorを投げる
 *     （異なるexecutionIdであっても、period不一致は許容しない）。
 */
export function applyTurnResultToPersistedState(
  previousState: PersistedGameStateV2,
  turnResult: TurnOrchestratorResult,
  turnExecutionId: string,
  updatedAt: string
): PersistedGameStateV2 {
  if (turnExecutionId.length === 0) {
    throw new PersistedStateTransitionError("turnExecutionIdは空文字であってはなりません。");
  }
  if (previousState.execution.lastTurnExecutionId === turnExecutionId) {
    throw new PersistedStateTransitionError(
      `turnExecutionId "${turnExecutionId}" は直前に適用済みです（同一ターンの結果を再適用しようとしています）。`
    );
  }
  if (turnResult.period !== previousState.currentPeriod) {
    throw new PersistedStateTransitionError(
      `turnResult.period ("${turnResult.period}") が previousState.currentPeriod ("${previousState.currentPeriod}") と一致しません。previousStateから作られたTurnOrchestratorInputをrunTurnへ渡して得られたturnResultを渡してください。`
    );
  }
  assertValidIsoTimestamp(updatedAt, "updatedAt");
  if (Date.parse(previousState.metadata.createdAt) > Date.parse(updatedAt)) {
    throw new PersistedStateValidationError("createdAtより前であってはなりません（updatedAt >= createdAtである必要があります）。", "updatedAt");
  }

  return {
    ...previousState,
    currentPeriod: turnResult.pendingState.nextPeriod,
    contracts: turnResult.pendingState.contracts,
    rawMaterialLots: turnResult.pendingState.lots,
    execution: {
      completedTurnCount: previousState.execution.completedTurnCount + 1,
      lastCompletedPeriod: turnResult.period,
      lastTurnExecutionId: turnExecutionId,
    },
    metadata: {
      createdAt: previousState.metadata.createdAt,
      updatedAt,
    },
  };
}

// ---------------------------------------------------------------------
// 3. TurnOrchestratorInputの再構築（hydration）
// ---------------------------------------------------------------------

/**
 * 永続化状態（currentPeriod・seed・contracts・rawMaterialLots）と、毎ターン
 * 外部から与えられる入力（ExternalTurnInput: marketInput・scenarioVariables・
 * 各種提出計画・parameters）から、そのままrunTurnへ渡せるTurnOrchestratorInput
 * を組み立てる（純粋関数、persistedState・externalTurnInputのいずれも
 * 変更しない）。
 *
 * ExternalTurnInput型自体がcurrentPeriod・seed・existingContracts・
 * existingLotsを持たないため、呼び出し側がこれらを誤って上書きすることは
 * 型レベルでそもそもできない（実装指示§10「externalTurnInput側から
 * currentPeriod、seed、contracts、lotsを上書きできない構造にする」）。
 * debug情報や前回のTurnOrchestratorResultも混入しない
 * （ExternalTurnInputにそもそも該当フィールドが存在しない）。
 */
export function hydrateTurnInputFromPersistedState(
  persistedState: PersistedGameStateV2,
  externalTurnInput: ExternalTurnInput
): TurnOrchestratorInput {
  return {
    currentPeriod: persistedState.currentPeriod,
    marketInput: externalTurnInput.marketInput,
    scenarioVariables: externalTurnInput.scenarioVariables,
    salesPlans: externalTurnInput.salesPlans,
    domesticPurchaseIntentSource: externalTurnInput.domesticPurchaseIntentSource,
    importOrders: externalTurnInput.importOrders,
    aquacultureStockingPlans: externalTurnInput.aquacultureStockingPlans,
    existingContracts: persistedState.contracts,
    existingLots: persistedState.rawMaterialLots,
    seed: persistedState.seed,
    parameters: externalTurnInput.parameters,
  };
}
