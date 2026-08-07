import { randomUUID } from "crypto";
import { redis, parseStored } from "./redis";
import { CompanyId } from "./gameData";
import { AppEnvironment } from "./env";
import { CompanyDecision, CompanyState, GameSession, GameSnapshot, SnapshotSummary, TurnResult } from "./gameTypes";
import {
  companyStateKey,
  decisionsKey,
  formatPeriod,
  gameKey,
  resultsKey,
  snapshotKey,
  snapshotsListKey,
} from "./redisKeys";
import { normalizeDecision } from "./decision";
import { normalizeGameSession } from "./gameSession";
import { normalizeTurnResult } from "./turnResult";

const COMPANY_IDS: CompanyId[] = ["A", "B", "C", "D", "E"];
export const MAX_SNAPSHOTS_PER_GAME = 20;
const LABEL_MAX_LENGTH = 100;

// ラベルは常にプレーンテキストとして扱い、画面側もReactの通常のテキスト描画
// （dangerouslySetInnerHTMLを使わない）に任せることでHTMLとして解釈されないようにする。
// 保存側でも制御文字を除去し長さを制限しておく。
export function sanitizeSnapshotLabel(input: unknown): string {
  if (typeof input !== "string") return "";
  let result = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) result += ch;
  }
  return result.trim().slice(0, LABEL_MAX_LENGTH);
}

function decisionMapKey(period: string, companyId: CompanyId): string {
  return `${period}:${companyId}`;
}

function parseDecisionMapKey(key: string): { period: string; companyId: CompanyId } {
  const idx = key.lastIndexOf(":");
  return { period: key.slice(0, idx), companyId: key.slice(idx + 1) as CompanyId };
}

// 対象ゲームが現在（history + 当四半期）持ちうる意思決定・結果キーを列挙する。
// スナップショット作成・復元時の差分計算（復元後に不要になったキーの削除）に使う。
export function relevantPeriods(session: GameSession): string[] {
  const periods = new Set<string>(session.history);
  periods.add(formatPeriod(session.currentYear, session.currentQuarter));
  return Array.from(periods);
}

async function captureCurrentGameData(gameCode: string, session: GameSession) {
  const companies = {} as Record<CompanyId, CompanyState>;
  for (const id of COMPANY_IDS) {
    const raw = await redis.get(companyStateKey(gameCode, id));
    const state = parseStored<CompanyState>(raw);
    if (state) companies[id] = state;
  }

  const decisions: Record<string, CompanyDecision> = {};
  const results: Record<string, TurnResult> = {};
  for (const period of relevantPeriods(session)) {
    const resultRaw = await redis.get(resultsKey(gameCode, period));
    const resultParsed = parseStored<TurnResult>(resultRaw);
    if (resultParsed) results[period] = normalizeTurnResult(resultParsed);
    for (const id of COMPANY_IDS) {
      const raw = await redis.get(decisionsKey(gameCode, period, id));
      const stored = parseStored<CompanyDecision>(raw);
      if (stored) decisions[decisionMapKey(period, id)] = normalizeDecision(stored);
    }
  }

  return { companies, decisions, results };
}

// スナップショット作成前後で元ゲームのデータは一切変更しない（読み取りのみ）。
export async function createGameSnapshot(gameCode: string, session: GameSession, label: string): Promise<GameSnapshot> {
  const { companies, decisions, results } = await captureCurrentGameData(gameCode, session);
  const snapshot: GameSnapshot = {
    id: randomUUID(),
    gameCode,
    createdAt: new Date().toISOString(),
    label: sanitizeSnapshotLabel(label),
    session,
    companies,
    decisions,
    results,
  };
  await redis.set(snapshotKey(gameCode, snapshot.id), JSON.stringify(snapshot));
  await redis.lpush(snapshotsListKey(gameCode), snapshot.id);

  // 上限（MAX_SNAPSHOTS_PER_GAME件）を超えたら、古いものから自動的に削除する。
  // lpushで先頭に追加しているため、リストの末尾ほど古い。
  const ids = await redis.lrange(snapshotsListKey(gameCode), 0, -1);
  if (ids.length > MAX_SNAPSHOTS_PER_GAME) {
    const toRemove = ids.slice(MAX_SNAPSHOTS_PER_GAME);
    for (const oldId of toRemove) {
      await redis.del(snapshotKey(gameCode, oldId));
      await redis.lrem(snapshotsListKey(gameCode), 0, oldId);
    }
  }

  return snapshot;
}

export async function listGameSnapshots(gameCode: string): Promise<SnapshotSummary[]> {
  const ids = await redis.lrange(snapshotsListKey(gameCode), 0, -1);
  const snapshots = await Promise.all(
    ids.map(async (id) => parseStored<GameSnapshot>(await redis.get(snapshotKey(gameCode, id))))
  );
  return snapshots
    .filter((s): s is GameSnapshot => s !== null)
    .map((s) => ({
      id: s.id,
      label: s.label,
      createdAt: s.createdAt,
      year: s.session.currentYear,
      quarter: s.session.currentQuarter,
      phase: s.session.currentPhase,
    }));
}

export async function getGameSnapshot(gameCode: string, snapshotId: string): Promise<GameSnapshot | null> {
  const raw = await redis.get(snapshotKey(gameCode, snapshotId));
  return parseStored<GameSnapshot>(raw);
}

export async function deleteGameSnapshot(gameCode: string, snapshotId: string): Promise<void> {
  await redis.del(snapshotKey(gameCode, snapshotId));
  await redis.lrem(snapshotsListKey(gameCode), 0, snapshotId);
}

export async function deleteAllGameSnapshots(gameCode: string): Promise<void> {
  const ids = await redis.lrange(snapshotsListKey(gameCode), 0, -1);
  for (const id of ids) {
    await redis.del(snapshotKey(gameCode, id));
  }
  await redis.del(snapshotsListKey(gameCode));
}

export interface RestoreSafetyOverrides {
  createdAt: string;
  isTestGame: boolean;
  environment: AppEnvironment;
}

// スナップショットの内容でゲームを復元する。gameCode・createdAt・isTestGame・environmentは
// スナップショットに埋め込まれた値を信用せず、呼び出し元が渡す現在のゲームの値
// （overrides）で上書きする。これにより、復元操作によってテストゲームが本番ゲーム扱いに
// なったり、ゲームコードが差し替わったりすることを防ぐ。
//
// 復元対象（スナップショット）に存在しない、現在の意思決定・結果キーは
// extraDecisionKeys / extraResultKeys として渡されたものを削除する
// （呼び出し元が復元前セッションとの差分を計算して渡す）。
export async function restoreGameSnapshot(
  gameCode: string,
  snapshot: GameSnapshot,
  overrides: RestoreSafetyOverrides,
  extraKeysToDelete: string[]
): Promise<GameSession> {
  // スナップショット内のsessionは旧形式（schemaVersion/engineVersionなし）の可能性があるため、
  // 展開前に必ずnormalizeGameSessionを通して欠損フィールドを補う。
  const baseSession = normalizeGameSession(snapshot.session);
  const restoredSession: GameSession = {
    ...baseSession,
    gameCode,
    createdAt: overrides.createdAt,
    isTestGame: overrides.isTestGame,
    environment: overrides.environment,
    updatedAt: new Date().toISOString(),
  };
  await redis.set(gameKey(gameCode), JSON.stringify(restoredSession));

  for (const id of COMPANY_IDS) {
    const state = snapshot.companies[id];
    if (state) await redis.set(companyStateKey(gameCode, id), JSON.stringify(state));
  }

  // snapshot.decisions / snapshot.results も旧スナップショット由来の場合、
  // 欠損フィールド（submissionCount等、schemaVersion/engineVersion等）を持つ可能性があるため、
  // Redisへ書き戻す前に必ず正規化を通す。
  for (const [mapKey, decision] of Object.entries(snapshot.decisions)) {
    const { period, companyId } = parseDecisionMapKey(mapKey);
    const normalizedDecision = normalizeDecision(decision);
    await redis.set(decisionsKey(gameCode, period, companyId), JSON.stringify(normalizedDecision));
  }

  for (const [period, result] of Object.entries(snapshot.results)) {
    const normalizedResult = normalizeTurnResult(result);
    await redis.set(resultsKey(gameCode, period), JSON.stringify(normalizedResult));
  }

  for (const key of extraKeysToDelete) {
    await redis.del(key);
  }

  return restoredSession;
}

// 復元前セッションを基準に、現在存在しうる意思決定・結果キーのうち、
// 復元先スナップショットに含まれないものを洗い出す（復元後に削除するため）。
export function computeExtraKeysAfterRestore(
  gameCode: string,
  beforeSession: GameSession,
  snapshot: GameSnapshot
): string[] {
  const extra: string[] = [];
  for (const period of relevantPeriods(beforeSession)) {
    for (const id of COMPANY_IDS) {
      if (!(decisionMapKey(period, id) in snapshot.decisions)) {
        extra.push(decisionsKey(gameCode, period, id));
      }
    }
    if (!(period in snapshot.results)) {
      extra.push(resultsKey(gameCode, period));
    }
  }
  return extra;
}
