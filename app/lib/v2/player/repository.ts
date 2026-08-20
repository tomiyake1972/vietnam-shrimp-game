// ShrimpX V2 — Independent Player Flow: PlayerRepository契約 + in-memory実装
//
// 【設計方針】既存のSimulationRunRepository（app/lib/v2/companyLab/simulation/
// persistence/repository.ts）と同じDIパターンを踏襲する: 契約（interface）＋
// createInMemoryPlayerRepository（テスト・E2E in-memory fallback用）をここに、
// 実Redis実装（createRedisPlayerRepository）は同じフォルダのredisRepository.tsに置く。
//
// 【新しいGame Engineを作らない】ここはjoin credential・Seat・Sessionという
// 「誰がどの会社を操作してよいか」の認可状態だけを持つ。ゲームの意思決定・状態は
// 一切保持しない（既存StoredSimulationRun/resumePayloadのまま）。

import { randomBytes } from "crypto";
import { CompanyId } from "../sales/types";
import { PlayerAuthError, PlayerSeatRecord, PlayerSessionRecord } from "./types";
import { hashJoinSecret } from "../redis/playerRedisKeys";

export interface PlayerRepository {
  /**
   * 参加linkを発行（または再発行）する。Seatがまだ無ければlazy-createする。
   * 再発行の場合、旧join credentialは即座に失効し、既存の参加（claim）も失効させる
   * （指示: 「GMによる再発行時は旧credentialを失効させる」）。
   * 戻り値のjoinSecretは平文で1回だけ返す（呼び出し側がURLへ埋め込む）。Redisには
   * 平文を一切保存しない。
   */
  issueJoinCredential(runId: string, companyId: CompanyId, now: string): Promise<{ readonly seat: PlayerSeatRecord; readonly joinSecret: string }>;

  /** join credential・参加中セッションの両方を失効させる（GMの「取り消し」操作）。 */
  revokeSeat(runId: string, companyId: CompanyId, now: string): Promise<PlayerSeatRecord | null>;

  loadSeat(runId: string, companyId: CompanyId): Promise<PlayerSeatRecord | null>;

  /** GM Console表示用に複数会社ぶんまとめて読む（存在しないSeatはnullで埋めず配列から省く）。 */
  listSeatsForRun(runId: string, companyIds: readonly CompanyId[]): Promise<readonly PlayerSeatRecord[]>;

  /**
   * join secretを1回だけclaimする（PlayerAuthError: JOIN_NOT_FOUND / JOIN_REVOKED /
   * JOIN_ALREADY_CLAIMEDのいずれかを投げうる）。成功したら新しいPlayerSessionを作る。
   */
  claimJoinSecret(joinSecret: string, now: string): Promise<{ readonly session: PlayerSessionRecord; readonly seat: PlayerSeatRecord }>;

  loadSession(sessionId: string): Promise<PlayerSessionRecord | null>;
  touchSession(sessionId: string, now: string): Promise<void>;
  revokeSession(sessionId: string, now: string): Promise<void>;

  /** Player Submitが成立したときにSeatへ記録する（GM Console の提出状況・Advance Turn gatingが読む）。 */
  recordSubmission(runId: string, companyId: CompanyId, turn: number, now: string): Promise<PlayerSeatRecord>;
}

function generateJoinSecret(): string {
  return randomBytes(32).toString("base64url");
}

function generateSessionId(): string {
  return randomBytes(24).toString("base64url");
}

export function createInMemoryPlayerRepository(): PlayerRepository {
  const seats = new Map<string, PlayerSeatRecord>(); // key: `${runId}:${companyId}`
  const joinIndex = new Map<string, { runId: string; companyId: CompanyId }>(); // key: hashed joinSecret
  const claimLocks = new Set<string>(); // key: `${runId}:${companyId}`
  const sessions = new Map<string, PlayerSessionRecord>();

  function seatKey(runId: string, companyId: string): string {
    return `${runId}:${companyId}`;
  }

  async function issueJoinCredential(runId: string, companyId: CompanyId, now: string) {
    const key = seatKey(runId, companyId);
    const existing = seats.get(key) ?? null;
    // 旧credential失効・旧claim失効。
    claimLocks.delete(key);
    if (existing?.currentJoinSecretHash) joinIndex.delete(existing.currentJoinSecretHash);
    if (existing?.claimedSessionId) {
      const oldSession = sessions.get(existing.claimedSessionId);
      if (oldSession) sessions.set(existing.claimedSessionId, { ...oldSession, revokedAt: now });
    }

    const joinSecret = generateJoinSecret();
    const hash = hashJoinSecret(joinSecret);
    joinIndex.set(hash, { runId, companyId });

    const seat: PlayerSeatRecord = {
      runId,
      companyId,
      currentJoinSecretHash: hash,
      joinIssuedAt: now,
      joinRevokedAt: null,
      claimedSessionId: null,
      claimedAt: null,
      lastSubmittedTurn: existing?.lastSubmittedTurn ?? null,
      lastSubmittedAt: existing?.lastSubmittedAt ?? null,
    };
    seats.set(key, seat);
    return { seat, joinSecret };
  }

  async function revokeSeat(runId: string, companyId: CompanyId, now: string) {
    const key = seatKey(runId, companyId);
    const existing = seats.get(key) ?? null;
    if (!existing) return null;
    claimLocks.delete(key);
    if (existing.currentJoinSecretHash) joinIndex.delete(existing.currentJoinSecretHash);
    if (existing.claimedSessionId) {
      const oldSession = sessions.get(existing.claimedSessionId);
      if (oldSession) sessions.set(existing.claimedSessionId, { ...oldSession, revokedAt: now });
    }
    const seat: PlayerSeatRecord = {
      ...existing,
      currentJoinSecretHash: null,
      joinRevokedAt: now,
      claimedSessionId: null,
      claimedAt: null,
    };
    seats.set(key, seat);
    return seat;
  }

  async function loadSeat(runId: string, companyId: CompanyId) {
    return seats.get(seatKey(runId, companyId)) ?? null;
  }

  async function listSeatsForRun(runId: string, companyIds: readonly CompanyId[]) {
    const out: PlayerSeatRecord[] = [];
    for (const companyId of companyIds) {
      const s = seats.get(seatKey(runId, companyId));
      if (s) out.push(s);
    }
    return out;
  }

  async function claimJoinSecret(joinSecret: string, now: string) {
    const hash = hashJoinSecret(joinSecret);
    const pointer = joinIndex.get(hash);
    if (!pointer) throw new PlayerAuthError("この参加リンクは無効です（存在しないか、既に失効しています）。", "JOIN_NOT_FOUND");
    const key = seatKey(pointer.runId, pointer.companyId);
    const seat = seats.get(key);
    if (!seat || seat.currentJoinSecretHash !== hash) {
      throw new PlayerAuthError("この参加リンクは失効しています（GMが新しいリンクを発行した可能性があります）。", "JOIN_REVOKED");
    }
    if (claimLocks.has(key)) {
      throw new PlayerAuthError("この会社の参加枠は既に使用されています。GMに新しい参加リンクの発行を依頼してください。", "JOIN_ALREADY_CLAIMED");
    }
    claimLocks.add(key);

    const sessionId = generateSessionId();
    const session: PlayerSessionRecord = { sessionId, runId: pointer.runId, companyId: pointer.companyId, createdAt: now, revokedAt: null, lastSeenAt: now };
    sessions.set(sessionId, session);
    const updatedSeat: PlayerSeatRecord = { ...seat, claimedSessionId: sessionId, claimedAt: now };
    seats.set(key, updatedSeat);
    return { session, seat: updatedSeat };
  }

  async function loadSession(sessionId: string) {
    return sessions.get(sessionId) ?? null;
  }

  async function touchSession(sessionId: string, now: string) {
    const s = sessions.get(sessionId);
    if (s) sessions.set(sessionId, { ...s, lastSeenAt: now });
  }

  async function revokeSession(sessionId: string, now: string) {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.set(sessionId, { ...s, revokedAt: now });
    const key = seatKey(s.runId, s.companyId);
    const seat = seats.get(key);
    if (seat && seat.claimedSessionId === sessionId) {
      claimLocks.delete(key);
      seats.set(key, { ...seat, claimedSessionId: null, claimedAt: null });
    }
  }

  async function recordSubmission(runId: string, companyId: CompanyId, turn: number, now: string) {
    const key = seatKey(runId, companyId);
    const existing = seats.get(key);
    const seat: PlayerSeatRecord = existing
      ? { ...existing, lastSubmittedTurn: turn, lastSubmittedAt: now }
      : {
          runId,
          companyId,
          currentJoinSecretHash: null,
          joinIssuedAt: null,
          joinRevokedAt: null,
          claimedSessionId: null,
          claimedAt: null,
          lastSubmittedTurn: turn,
          lastSubmittedAt: now,
        };
    seats.set(key, seat);
    return seat;
  }

  return {
    issueJoinCredential,
    revokeSeat,
    loadSeat,
    listSeatsForRun,
    claimJoinSecret,
    loadSession,
    touchSession,
    revokeSession,
    recordSubmission,
  };
}
