// ShrimpX V2 — Independent Player Flow: PlayerRepository の実Redis実装
//
// 既存のcreateRedisSimulationRunRepository（simulation/persistence/redisRepository.ts）
// と同じ依存注入パターン（{client, appEnv}）を踏襲する。会社ラボ専用Redisクライアント
// （createDefaultCompanyLabRedisClient）をそのまま再利用し、新しい接続コードは
// 追加しない。

import { randomBytes } from "crypto";
import { CompanyLabRedisClient } from "../redis/companyLabTypes";
import { AppEnvV2 } from "../core/version";
import { assertAllowedPlayerKeys, hashJoinSecret, playerJoinKeyV2, playerSeatClaimLockKeyV2, playerSeatKeyV2, playerSessionKeyV2 } from "../redis/playerRedisKeys";
import { CompanyId } from "../sales/types";
import { PlayerAuthError, PlayerSeatRecord, PlayerSessionRecord } from "./types";
import { PlayerRepository } from "./repository";

export interface PlayerRepositoryDependencies {
  readonly client: CompanyLabRedisClient;
  readonly appEnv: AppEnvV2;
}

function generateJoinSecret(): string {
  return randomBytes(32).toString("base64url");
}

function generateSessionId(): string {
  return randomBytes(24).toString("base64url");
}

async function readJson<T>(client: CompanyLabRedisClient, key: string): Promise<T | null> {
  const raw = await client.get(key);
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" ? (JSON.parse(raw) as T) : (raw as T);
}

export function createRedisPlayerRepository(deps: PlayerRepositoryDependencies): PlayerRepository {
  const { client, appEnv } = deps;

  async function writeSeat(seat: PlayerSeatRecord): Promise<void> {
    const key = playerSeatKeyV2(appEnv, seat.runId, seat.companyId);
    assertAllowedPlayerKeys([key], appEnv);
    await client.set(key, JSON.stringify(seat));
  }

  async function loadSeat(runId: string, companyId: CompanyId): Promise<PlayerSeatRecord | null> {
    const key = playerSeatKeyV2(appEnv, runId, companyId);
    return readJson<PlayerSeatRecord>(client, key);
  }

  async function writeSession(session: PlayerSessionRecord): Promise<void> {
    const key = playerSessionKeyV2(appEnv, session.sessionId);
    assertAllowedPlayerKeys([key], appEnv);
    await client.set(key, JSON.stringify(session));
  }

  async function loadSession(sessionId: string): Promise<PlayerSessionRecord | null> {
    const key = playerSessionKeyV2(appEnv, sessionId);
    return readJson<PlayerSessionRecord>(client, key);
  }

  async function revokeExistingClaimIfAny(seat: PlayerSeatRecord | null, now: string): Promise<void> {
    if (!seat?.claimedSessionId) return;
    const session = await loadSession(seat.claimedSessionId);
    if (session && !session.revokedAt) await writeSession({ ...session, revokedAt: now });
  }

  async function issueJoinCredential(runId: string, companyId: CompanyId, now: string) {
    const existing = await loadSeat(runId, companyId);
    const claimLockKey = playerSeatClaimLockKeyV2(appEnv, runId, companyId);
    assertAllowedPlayerKeys([claimLockKey], appEnv);

    // 旧credential失効・旧claim失効（指示: 「GMによる再発行時は旧credentialを失効させる」）。
    if (existing?.currentJoinSecretHash) {
      const oldJoinKey = playerJoinKeyV2(appEnv, existing.currentJoinSecretHash);
      assertAllowedPlayerKeys([oldJoinKey], appEnv);
      await client.del(oldJoinKey);
    }
    await revokeExistingClaimIfAny(existing, now);
    await client.del(claimLockKey);

    const joinSecret = generateJoinSecret();
    const hash = hashJoinSecret(joinSecret);
    const joinKey = playerJoinKeyV2(appEnv, hash);
    assertAllowedPlayerKeys([joinKey], appEnv);
    await client.set(joinKey, JSON.stringify({ runId, companyId, issuedAt: now }));

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
    await writeSeat(seat);
    return { seat, joinSecret };
  }

  async function revokeSeat(runId: string, companyId: CompanyId, now: string) {
    const existing = await loadSeat(runId, companyId);
    if (!existing) return null;
    const claimLockKey = playerSeatClaimLockKeyV2(appEnv, runId, companyId);
    assertAllowedPlayerKeys([claimLockKey], appEnv);

    if (existing.currentJoinSecretHash) {
      const oldJoinKey = playerJoinKeyV2(appEnv, existing.currentJoinSecretHash);
      assertAllowedPlayerKeys([oldJoinKey], appEnv);
      await client.del(oldJoinKey);
    }
    await revokeExistingClaimIfAny(existing, now);
    await client.del(claimLockKey);

    const seat: PlayerSeatRecord = { ...existing, currentJoinSecretHash: null, joinRevokedAt: now, claimedSessionId: null, claimedAt: null };
    await writeSeat(seat);
    return seat;
  }

  async function listSeatsForRun(runId: string, companyIds: readonly CompanyId[]) {
    const seats = await Promise.all(companyIds.map((companyId) => loadSeat(runId, companyId)));
    return seats.filter((s): s is PlayerSeatRecord => s !== null);
  }

  async function claimJoinSecret(joinSecret: string, now: string) {
    const hash = hashJoinSecret(joinSecret);
    const joinKey = playerJoinKeyV2(appEnv, hash);
    const pointer = await readJson<{ runId: string; companyId: CompanyId; issuedAt: string }>(client, joinKey);
    if (!pointer) throw new PlayerAuthError("この参加リンクは無効です（存在しないか、既に失効しています）。", "JOIN_NOT_FOUND");

    const seat = await loadSeat(pointer.runId, pointer.companyId);
    if (!seat || seat.currentJoinSecretHash !== hash) {
      throw new PlayerAuthError("この参加リンクは失効しています（GMが新しいリンクを発行した可能性があります）。", "JOIN_REVOKED");
    }

    const claimLockKey = playerSeatClaimLockKeyV2(appEnv, pointer.runId, pointer.companyId);
    assertAllowedPlayerKeys([claimLockKey], appEnv);
    const sessionId = generateSessionId();
    // SET NXで排他制御する（同時に2人が同じjoin URLを開いても片方だけがclaimできる）。
    const acquired = await client.set(claimLockKey, sessionId, { nx: true });
    if (acquired === null) {
      throw new PlayerAuthError("この会社の参加枠は既に使用されています。GMに新しい参加リンクの発行を依頼してください。", "JOIN_ALREADY_CLAIMED");
    }

    const session: PlayerSessionRecord = { sessionId, runId: pointer.runId, companyId: pointer.companyId, createdAt: now, revokedAt: null, lastSeenAt: now };
    await writeSession(session);
    const updatedSeat: PlayerSeatRecord = { ...seat, claimedSessionId: sessionId, claimedAt: now };
    await writeSeat(updatedSeat);
    return { session, seat: updatedSeat };
  }

  async function touchSession(sessionId: string, now: string) {
    const session = await loadSession(sessionId);
    if (session) await writeSession({ ...session, lastSeenAt: now });
  }

  async function revokeSession(sessionId: string, now: string) {
    const session = await loadSession(sessionId);
    if (!session) return;
    await writeSession({ ...session, revokedAt: now });
    const seat = await loadSeat(session.runId, session.companyId);
    if (seat && seat.claimedSessionId === sessionId) {
      const claimLockKey = playerSeatClaimLockKeyV2(appEnv, session.runId, session.companyId);
      assertAllowedPlayerKeys([claimLockKey], appEnv);
      await client.del(claimLockKey);
      await writeSeat({ ...seat, claimedSessionId: null, claimedAt: null });
    }
  }

  async function recordSubmission(runId: string, companyId: CompanyId, turn: number, now: string) {
    const existing = await loadSeat(runId, companyId);
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
    await writeSeat(seat);
    return seat;
  }

  return { issueJoinCredential, revokeSeat, loadSeat, listSeatsForRun, claimJoinSecret, loadSession, touchSession, revokeSession, recordSubmission };
}
