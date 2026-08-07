// ShrimpX V2 — 会社ラボ専用Redisキー生成（Phase 8C-1）
//
// 既存のredisKeys.ts（無印/v2本番ゲーム専用: "v2:games"・"v2:game:<code>"）とは
// 独立した、会社ラボ専用の名前空間を生成する。Phase 8C-0完了報告§7で確定した
// キー構成をそのまま実装する。
//
//   v2:companyLab:labs                    （production）
//   staging:v2:companyLab:labs            （staging）
//   v2:companyLab:{labId}:current
//   v2:companyLab:{labId}:draft
//   v2:companyLab:{labId}:history:{turn}
//   v2:companyLab:{labId}:history:index
//   v2:companyLab:{labId}:lock
//
// 生成したキーは必ずcompanyLabRedisKeyGuard.tsのassertAllowedCompanyLabKeysを
// 通してからRedisへ書き込むこと。

import { AppEnvV2 } from "../core/version";

function requireNonEmptyLabId(labId: string): void {
  if (typeof labId !== "string" || labId.length === 0) {
    throw new Error("labId は空でない文字列である必要があります。");
  }
}

function requireValidTurn(turn: number): void {
  if (!Number.isInteger(turn) || turn < 1) {
    throw new Error(`turn は1以上の整数である必要があります。受け取った値: ${JSON.stringify(turn)}`);
  }
}

function prefixFor(appEnv: AppEnvV2): string {
  return appEnv === "production" ? "v2:companyLab:" : "staging:v2:companyLab:";
}

/** 会社ラボ一覧キー。production: "v2:companyLab:labs" / staging: "staging:v2:companyLab:labs"。 */
export function companyLabListKeyV2(appEnv: AppEnvV2): string {
  return `${prefixFor(appEnv)}labs`;
}

/** 会社ラボ「現在状態」キー（config・fixtures・currentState・metadata。draftは含まない）。 */
export function companyLabCurrentStateKeyV2(appEnv: AppEnvV2, labId: string): string {
  requireNonEmptyLabId(labId);
  return `${prefixFor(appEnv)}${labId}:current`;
}

/** 会社ラボ「ドラフト」キー。 */
export function companyLabDraftKeyV2(appEnv: AppEnvV2, labId: string): string {
  requireNonEmptyLabId(labId);
  return `${prefixFor(appEnv)}${labId}:draft`;
}

/** 四半期ごとの確定履歴キー（1四半期＝1キー。全履歴を1つの巨大な値に埋め込まない理由はPhase 8C-0完了報告§7参照）。 */
export function companyLabHistoryEntryKeyV2(appEnv: AppEnvV2, labId: string, turn: number): string {
  requireNonEmptyLabId(labId);
  requireValidTurn(turn);
  return `${prefixFor(appEnv)}${labId}:history:${turn}`;
}

/** 確定履歴indexキー（ZADDで格納するturn番号のソート済み集合）。 */
export function companyLabHistoryIndexKeyV2(appEnv: AppEnvV2, labId: string): string {
  requireNonEmptyLabId(labId);
  return `${prefixFor(appEnv)}${labId}:history:index`;
}

/** 四半期処理の排他ロックキー（実際の取得/解放フローは8C-2対象。本Phaseはキー生成のみ）。 */
export function companyLabLockKeyV2(appEnv: AppEnvV2, labId: string): string {
  requireNonEmptyLabId(labId);
  return `${prefixFor(appEnv)}${labId}:lock`;
}

/**
 * 読み取り専用エクスポートAPI（/api/v2/exports/**）の監査ログキー（追記専用リスト）。
 * ゲーム状態キー（current/draft/history/lock）とは完全に別のキーであり、
 * エクスポートAPIはこのキーへのLPUSH+LTRIM（件数上限つき追記）以外の書き込みを
 * 一切行わない（companyLabExportAuditLog.ts参照）。
 */
export function companyLabExportLogKeyV2(appEnv: AppEnvV2, labId: string): string {
  requireNonEmptyLabId(labId);
  return `${prefixFor(appEnv)}${labId}:exportLog`;
}

/** 指定labIdに属する全キー（存在確認・原子コミットの引数組み立て等で使う）。 */
export function companyLabAllKeysForLabV2(appEnv: AppEnvV2, labId: string): readonly string[] {
  return [
    companyLabCurrentStateKeyV2(appEnv, labId),
    companyLabDraftKeyV2(appEnv, labId),
    companyLabHistoryIndexKeyV2(appEnv, labId),
    companyLabLockKeyV2(appEnv, labId),
  ];
}
