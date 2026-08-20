// ShrimpX V2 — Independent Player Flow: ドメイン型
//
// 【新しいGame Engineを作らない】ここで定義するのはPlayer Seat（会社ごとの参加・
// join credential・提出状況）とPlayer Session（Cookieが指すサーバー側レコード）だけ。
// ゲームの意思決定・状態遷移そのものは既存のCompanyDecisionInput・SimulationRun・
// resumePayloadをそのまま使う（新しいDecision contractは作らない）。

import { CompanyId } from "../sales/types";

/** join URLの発行記録（GMが「参加リンクを発行/再発行」した1回ぶん）。 */
export interface PlayerJoinCredentialPointer {
  readonly runId: string;
  readonly companyId: CompanyId;
  /** このjoin credentialが発行された時刻。監査用（判断には使わない）。 */
  readonly issuedAt: string;
}

/**
 * 会社ごとの参加状況（Seat）。既存Run本体（StoredSimulationRun）とは別Redis
 * namespaceに保存する（指示: 「Player Seat / Session metadataは既存Run本体とは
 * 別Redis namespaceを第一候補とする」）。
 *
 * 【lazy-create】旧Run（このSeatレコードがまだ存在しないRun）に対してGMが初めて
 * 参加linkを発行した瞬間に作成する。既存Run migrationは不要。
 */
export interface PlayerSeatRecord {
  readonly runId: string;
  readonly companyId: CompanyId;
  /** 現在有効なjoin credentialのhash（sha256hex）。未発行・全て失効済みならnull。 */
  readonly currentJoinSecretHash: string | null;
  readonly joinIssuedAt: string | null;
  readonly joinRevokedAt: string | null;
  /** このSeatを現在保持しているPlayer Sessionのid。未claimならnull。 */
  readonly claimedSessionId: string | null;
  readonly claimedAt: string | null;
  /** Player Submitが成立した直近のTurn番号（GM Console の提出状況表示・Advance Turn gatingに使う）。未提出ならnull。 */
  readonly lastSubmittedTurn: number | null;
  readonly lastSubmittedAt: string | null;
}

/**
 * Cookieが指すサーバー側セッション。Cookie自体はsessionIdだけを（署名つきで）
 * 保持し、runId/companyIdは必ずこのレコードから解決する（query parameterの
 * companyを信頼しない、という指示のためのSSoT）。
 */
export interface PlayerSessionRecord {
  readonly sessionId: string;
  readonly runId: string;
  readonly companyId: CompanyId;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly lastSeenAt: string | null;
}

export class PlayerAuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | "JOIN_NOT_FOUND"
      | "JOIN_ALREADY_CLAIMED"
      | "JOIN_REVOKED"
      | "SESSION_NOT_FOUND"
      | "SESSION_REVOKED"
      | "SESSION_COMPANY_MISMATCH"
      | "NO_SESSION_COOKIE"
  ) {
    super(message);
    this.name = "PlayerAuthError";
  }
}

export class PlayerSubmitError extends Error {
  constructor(
    message: string,
    readonly code: "RUN_NOT_FOUND" | "RUN_FINISHED" | "NOT_PLAYER_CONTROLLED" | "STALE_TURN" | "DUPLICATE_SUBMIT" | "INVALID_DECISION"
  ) {
    super(message);
    this.name = "PlayerSubmitError";
  }
}
