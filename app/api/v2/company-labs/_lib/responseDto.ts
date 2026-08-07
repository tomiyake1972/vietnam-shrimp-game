// ShrimpX V2 — 会社ラボ API 応答DTO（Phase 8C-3A §6.2・§6.6）
//
// CompanyLabPersistedStateV1.currentState.runtime は、処理が進むほど大きくなる
// （実測: turn32時点で約1.04MB、履歴エントリは1件あたり最大約2.26MB。Phase 8C-2
// storageMeasurement.test.ts参照）。通常の一覧・状態取得応答へ無条件で含めると、
// クライアント（将来のUI含む）が扱いきれないサイズになりうるため、ここで要約
// （revision・turn・完了状態等の軽量な値だけ）へ変換する。フル内部snapshotが必要な
// 診断用途は、別の専用route（history/[turn]）で明示的に分離する（§6.2・§6.6）。

import { CompanyLabDraftEnvelope, CompanyLabPersistedStateV1, CompanyLabQuarterHistoryEntry } from "../../../../lib/v2/companyLab/persistence/types";

export interface CompanyLabSummaryDto {
  readonly labId: string;
  readonly scenarioId: string;
  readonly mode: string;
  readonly totalTurns: number;
  /** 【Phase 8C-3B】このラボでプレイヤーが操作する会社（作成時に確定、以後不変）。 */
  readonly playerCompanyId: string;
  readonly currentTurn: number;
  readonly revision: number;
  readonly lastProcessedTurnId: string | null;
  readonly isComplete: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toLabSummaryDto(stored: CompanyLabPersistedStateV1): CompanyLabSummaryDto {
  return {
    labId: stored.labId,
    scenarioId: stored.config.scenarioId,
    mode: stored.config.mode,
    totalTurns: stored.config.turns,
    playerCompanyId: stored.playerCompanyId,
    currentTurn: stored.currentState.runtime.scenarioState.currentTurn,
    revision: stored.currentState.revision,
    lastProcessedTurnId: stored.currentState.lastProcessedTurnId ?? null,
    isComplete: stored.currentState.runtime.isComplete,
    createdAt: stored.metadata.createdAt,
    updatedAt: stored.metadata.updatedAt,
  };
}

export interface CompanyLabDraftSummaryDto {
  readonly turnId: string;
  readonly period: string;
  readonly revision: number;
  readonly draft: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submittedAt: string | null;
}

/**
 * draft本体（draft.draft）自体は網羅グリッドで通常数十KB程度に収まる想定であり、
 * 巨大内部snapshotとは性質が異なるため、そのまま含める（クライアントが編集画面へ
 * 復元するために必要な実データのため）。
 */
export function toDraftSummaryDto(envelope: CompanyLabDraftEnvelope): CompanyLabDraftSummaryDto {
  return {
    turnId: envelope.turnId,
    period: String(envelope.period),
    revision: envelope.revision,
    draft: envelope.draft,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
    submittedAt: envelope.submittedAt,
  };
}

export interface CompanyLabStateDto extends CompanyLabSummaryDto {
  readonly draft: CompanyLabDraftSummaryDto | null;
}

export function toLabStateDto(stored: CompanyLabPersistedStateV1, draft: CompanyLabDraftEnvelope | null): CompanyLabStateDto {
  return { ...toLabSummaryDto(stored), draft: draft ? toDraftSummaryDto(draft) : null };
}

export interface CompanyLabHistoryEntrySummaryDto {
  readonly turn: number;
  readonly turnId: string;
  readonly period: string;
  readonly processedAt: string;
  readonly engineVersion: string;
}

/** 履歴一覧（ページング）応答用の要約。preProcessingStateSnapshot/postProcessingStateSnapshot/recordは含めない（§6.6）。 */
export function toHistoryEntrySummaryDto(entry: CompanyLabQuarterHistoryEntry): CompanyLabHistoryEntrySummaryDto {
  return {
    turn: entry.turn,
    turnId: entry.turnId,
    period: String(entry.period),
    processedAt: entry.processedAt,
    engineVersion: entry.engineVersion,
  };
}
