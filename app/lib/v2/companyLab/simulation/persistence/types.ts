// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run の永続化モデル
//
// 【何を保存し、何を保存しないか】
// 保存するのは次の2つだけである。
//   (1) SimulationRun メタデータ（再現に必要な条件一式）
//   (2) 確定済み実績から導いた analytics dataset（long-format の事実表）
//
// **CompanyLabState をそのまま保存しない。**
// 会社ラボ本体（persistence/types.ts の CompanyLabRuntimeSnapshot）が
// 「history を絶対にスナップショットへ含めない」という設計で保存量の二次関数的
// 増大を防いでいるのと同じ理由で、Simulation Run 側も 32Q ぶんの
// scenarioState / contracts / rawMaterialLots / capexState 等を複製しない。
// Management Console と Analysis が必要とするのは確定済みの**実績値**であり、
// 途中状態の完全な復元ではない（続きから再開する機能は本Phaseの対象外）。
//
// 【既存 turn history を利用する】
// dataset は CompanyQuarterRecord（＝会社ラボが既に持っている確定履歴）から
// 取り出した値だけで構成される。analytics 用に新しい記録を engine へ足したのは、
// Standard AI が既に計算していた診断値と、そのターンに公開されていた観測需要
// （どちらも記録に残らず消えてしまう値）に限る。

import { SimulationAnalyticsDataset } from "../analytics/types";
import { PackCompanyTurnCapture, SimulationRun } from "../types";
import { PackWorldTurn } from "../aiPack/types";

/**
 * 保存スキーマ版。
 *
 * 【取り違え注意】以下とは別物である。
 *   - CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION（会社ラボ本体の保存スキーマ）
 *   - SCHEMA_VERSION_V2 / CURRENT_PERSISTED_GAME_STATE_VERSION（本番ゲーム）
 *
 * バージョン履歴:
 *   v1 … Phase 2A 初版。
 *   v2 … AI Analysis Pack 用の per-turn capture（packCapture）を追加。
 *        **追加的変更のみでマイグレーション不要**（会社ラボ本体と同じ方針）。
 *        v1 のデータには packCapture が無いため undefined として復元し、
 *        Pack 生成側は該当セクションを NOT_RECORDED として扱う（推測で埋めない）。
 */
export const CURRENT_SIMULATION_RUN_PERSISTED_VERSION = 2;

/** 保存される Simulation Run 1本ぶん。 */
export interface StoredSimulationRun {
  readonly schemaVersion: number;
  readonly run: SimulationRun;
  readonly dataset: SimulationAnalyticsDataset;
  /**
   * 【schemaVersion 2】AI Analysis Pack 用の per-turn capture。
   * 確定履歴に残らない導出値（期首・期末状態、工場スペース、投資案件、
   * TRUE/OBSERVABLE を分けた世界記録）だけを持つ。
   * v1 の保存データには存在しないため optional。
   */
  readonly packCapture?: SimulationPackCapture;
  /** metadata（ゲーム判断には使わない）。 */
  readonly savedAt: string;
}

/** 実行中に拾った、Pack 用の追加記録。 */
export interface SimulationPackCapture {
  readonly companyTurns: readonly PackCompanyTurnCapture[];
  readonly worldTurns: readonly PackWorldTurn[];
}

/**
 * 一覧表示用の要約。
 * Run selector は dataset 本体を読まずにこれだけで描ける
 * （32Q ぶんの事実表を一覧のたびに全件読まないため）。
 */
export interface SimulationRunSummary {
  readonly simulationRunId: string;
  readonly scenarioId: string;
  readonly seed: string;
  readonly requestedTurns: number;
  readonly completedTurns: number;
  readonly stopReason: SimulationRun["stopReason"];
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly savedAt: string;
  readonly gameParameterVersion: string;
  readonly standardAiVersion: string;
  /** 【Phase 8・Game Setup】Setup画面で任意入力されたRun名。未入力ならundefined。 */
  readonly runName?: string;
  /**
   * 【Phase 8・Run History】保存時点でPLAYERとして操作されていた会社。
   * この項目を持たない旧形式のsummary（localStorageキャッシュ等）との後方互換のためoptional。
   * 未設定は「記録なし」であり、必ずしも「PLAYER無し」を意味しない
   * （読み手は `?? []` で扱い、空配列と未設定を区別する必要が無い表示にする）。
   */
  readonly playerCompanyIds?: readonly string[];
}

export function toSimulationRunSummary(stored: StoredSimulationRun): SimulationRunSummary {
  return {
    simulationRunId: stored.run.simulationRunId,
    scenarioId: stored.run.scenarioId,
    seed: stored.run.seed,
    requestedTurns: stored.run.requestedTurns,
    completedTurns: stored.run.completedTurns,
    stopReason: stored.run.stopReason,
    startedAt: stored.run.startedAt,
    completedAt: stored.run.completedAt,
    savedAt: stored.savedAt,
    gameParameterVersion: stored.run.gameParameterVersion,
    standardAiVersion: stored.run.standardAiVersion,
    runName: stored.run.runName,
    playerCompanyIds: Object.entries(stored.run.companyControlModes ?? {})
      .filter(([, mode]) => mode === "PLAYER")
      .map(([companyId]) => companyId),
  };
}

/**
 * 保存済みデータの受け入れ判定。
 * **現行より新しい版だけを拒否する**（会社ラボ本体の
 * validateCompanyLabPersistedState と同じ方針。追加的変更は読み込めるようにする）。
 */
export function isReadableSimulationRunSchema(schemaVersion: unknown): boolean {
  return typeof schemaVersion === "number" && Number.isInteger(schemaVersion) && schemaVersion >= 1 && schemaVersion <= CURRENT_SIMULATION_RUN_PERSISTED_VERSION;
}
