// ShrimpX V2 — 会社ラボ 四半期確定の原子コミット（Phase 8C-1）
//
// 本Phaseの最重要部分。「history → current → index → draft削除をアプリケーション側で
// 順番に実行する」方式（途中失敗すると部分更新状態になり得る、原子コミットでは
// ない）を禁止し、Redis側のLuaスクリプト（EVAL）1回で、条件確認と複数キー更新を
// 単一の原子的処理として実行する。
//
// 【設計】
//   decideAtomicQuarterCommit() … 条件確認ロジックを純粋関数として1箇所に定義する。
//     - createInMemoryCompanyLabStateRepository()（repository.ts）は、この関数を
//       同期的に（awaitを一切挟まずに）呼び出すことで、JS単一スレッドの特性を
//       利用して原子性を再現する。
//     - Redis実装（redisRepository.ts）は、この関数と完全に同じ条件分岐・同じ
//       優先順位で書かれたLuaスクリプト（COMPANY_LAB_QUARTER_COMMIT_LUA_SCRIPT）を
//       Redis EVALで1回実行することで、Redis自体（Luaスクリプトはシングルスレッドで
       // 実行される）の原子性を利用する。
//   Luaスクリプトは、ローカルに一時起動した実際のRedisサーバー（redis-server）に
//   対してredis-cli --evalで実行し、下記の全分岐（currentNotFound・committed・
//   alreadyCommitted・historyConflict・revisionConflict・draftNotFound・
//   draftTurnMismatch・draftNotSubmitted・lockConflict・lock一致時のcommitted）を
//   実際に発火させて検証済み（cjsonでのJSON null判定・ZADDによる冪等な履歴index
//   追加を含む）。ただし@upstash/redis経由の実クライアント接続（HTTPベースの
//   REST API）そのものに対する接続確認は、実際のUpstash認証情報が本環境に
//   存在しないため行っていない（Phase 8C-1完了報告§E参照）。

import { CompanyLabRedisClient } from "../../redis/companyLabTypes";
import { CompanyLabRepositoryError } from "./errors";

// ---------------------------------------------------------------------
// 1. 結果型・入力型
// ---------------------------------------------------------------------

export type AtomicQuarterCommitResult =
  | { readonly status: "committed"; readonly revision: number }
  | { readonly status: "alreadyCommitted"; readonly revision: number }
  | { readonly status: "revisionConflict"; readonly actualRevision: number }
  | { readonly status: "historyConflict"; readonly existingTurnId: string }
  | { readonly status: "currentNotFound" }
  | { readonly status: "draftNotFound" }
  | { readonly status: "draftNotSubmitted" }
  | { readonly status: "draftTurnMismatch"; readonly actualTurnId: string }
  | { readonly status: "lockConflict" };

/** decideAtomicQuarterCommitへ渡す、ストレージから読み取った現況（生JSONではなく、判定に必要な値だけを事前抽出したもの）。 */
export interface AtomicCommitReadView {
  readonly currentExists: boolean;
  /** currentExists===falseの場合はnull。 */
  readonly currentRevision: number | null;
  /** 対象turnの履歴エントリが既に存在する場合はそのturnId、存在しなければnull。 */
  readonly existingHistoryTurnId: string | null;
  readonly draftExists: boolean;
  /** draftExists===falseの場合はnull。 */
  readonly draftTurnId: string | null;
  readonly draftSubmitted: boolean;
  /** ロックキーが存在しなければnull。 */
  readonly lockToken: string | null;
}

export interface AtomicCommitDecisionInput {
  readonly turnId: string;
  readonly expectedRevision: number;
  readonly expectedLockToken?: string;
  readonly newRevision: number;
}

/**
 * 四半期確定コミットを許可してよいかどうかを判定する純粋関数。§5-1・§5-4の
 * 条件確認・冪等性ルールをそのまま実装する。判定の優先順位（重要・厳守）:
 *   1. currentが存在するか
 *   2. 対象turnの履歴が既に存在するか
 *      - 存在し、turnIdが一致 → 冪等な再試行（alreadyCommitted、書き込みなし）
 *      - 存在し、turnIdが不一致 → 競合（historyConflict、書き込みなし）
 *   3. （2で履歴がまだ存在しない場合のみ）revisionが一致するか
 *      ※ 順序が重要: 冪等な再試行時はcurrent.revisionが既にexpectedRevision+1へ
 *      進んでいるため、2を先に判定しないと再試行のたびにrevisionConflictを
 *      誤って返してしまう。
 *   4. draftが存在するか・turnIdが一致するか・正式提出済みか
 *   5. （expectedLockTokenが指定されている場合のみ）ロックトークンが一致するか
 * 全て通過した場合のみ"committed"を返す。
 */
export function decideAtomicQuarterCommit(view: AtomicCommitReadView, input: AtomicCommitDecisionInput): AtomicQuarterCommitResult {
  if (!view.currentExists) {
    return { status: "currentNotFound" };
  }
  if (view.existingHistoryTurnId !== null) {
    if (view.existingHistoryTurnId === input.turnId) {
      return { status: "alreadyCommitted", revision: view.currentRevision as number };
    }
    return { status: "historyConflict", existingTurnId: view.existingHistoryTurnId };
  }
  if (view.currentRevision !== input.expectedRevision) {
    return { status: "revisionConflict", actualRevision: view.currentRevision as number };
  }
  if (!view.draftExists) {
    return { status: "draftNotFound" };
  }
  if (view.draftTurnId !== input.turnId) {
    return { status: "draftTurnMismatch", actualTurnId: view.draftTurnId as string };
  }
  if (!view.draftSubmitted) {
    return { status: "draftNotSubmitted" };
  }
  if (input.expectedLockToken !== undefined && view.lockToken !== input.expectedLockToken) {
    return { status: "lockConflict" };
  }
  return { status: "committed", revision: input.newRevision };
}

// ---------------------------------------------------------------------
// 2. Redis EVAL用 Luaスクリプト
// ---------------------------------------------------------------------

/**
 * decideAtomicQuarterCommit()と同一の条件・同一の優先順位で書かれたLuaスクリプト。
 * Redis EVALは単一のLuaスクリプト実行がシングルスレッドで完結することを保証する
 * （＝スクリプト内で行うGET/SET/ZADD/DELの一連の操作は、他のクライアントからの
 * 割り込みを一切許さない）。これにより、「読み取り→TypeScript側で比較→複数回SET」
 * という擬似CAS（禁止されている方式）ではなく、真にRedis側の単一原子処理として
 * revision確認と複数キー更新を実現する。
 *
 * KEYS[1] = current key
 * KEYS[2] = history:{turn} key
 * KEYS[3] = history:index key（Sorted Set。turn番号をmember兼scoreとして冪等にZADDする）
 * KEYS[4] = draft key
 * KEYS[5] = lock key（expectedLockTokenを指定しない場合は参照しない）
 * ARGV[1] = turnId
 * ARGV[2] = turn（文字列化した整数）
 * ARGV[3] = expectedRevision（文字列化した整数）
 * ARGV[4] = 次のcurrent状態（JSON文字列。committed時にKEYS[1]へSETする値）
 * ARGV[5] = 履歴エントリ（JSON文字列。committed時にKEYS[2]へSETする値）
 * ARGV[6] = expectedLockToken（空文字列 "" の場合はロック確認をスキップする）
 * ARGV[7] = newRevision（文字列化した整数。committed/alreadyCommitted以外では未使用）
 *
 * 戻り値: {status: string, extra: string} の2要素配列（redis-cli --evalによる
 * 実際のRedisサーバーでの検証結果はPhase 8C-1完了報告§Bを参照）。
 */
export const COMPANY_LAB_QUARTER_COMMIT_LUA_SCRIPT = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  return {'currentNotFound', ''}
end
local current = cjson.decode(currentRaw)

local historyRaw = redis.call('GET', KEYS[2])
if historyRaw then
  local existing = cjson.decode(historyRaw)
  if existing.turnId == ARGV[1] then
    return {'alreadyCommitted', tostring(current.currentState.revision)}
  else
    return {'historyConflict', existing.turnId}
  end
end

if tostring(current.currentState.revision) ~= ARGV[3] then
  return {'revisionConflict', tostring(current.currentState.revision)}
end

local draftRaw = redis.call('GET', KEYS[4])
if not draftRaw then
  return {'draftNotFound', ''}
end
local draft = cjson.decode(draftRaw)
if draft.turnId ~= ARGV[1] then
  return {'draftTurnMismatch', draft.turnId}
end
if draft.submittedAt == cjson.null or draft.submittedAt == nil or draft.submittedAt == false then
  return {'draftNotSubmitted', ''}
end

if ARGV[6] ~= '' then
  local lockRaw = redis.call('GET', KEYS[5])
  if not lockRaw or lockRaw ~= ARGV[6] then
    return {'lockConflict', ''}
  end
end

redis.call('SET', KEYS[1], ARGV[4])
redis.call('SET', KEYS[2], ARGV[5])
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[2])
redis.call('DEL', KEYS[4])

return {'committed', ARGV[7]}
`.trim();

export interface AtomicCommitEvalParams {
  readonly currentKey: string;
  readonly historyEntryKey: string;
  readonly historyIndexKey: string;
  readonly draftKey: string;
  readonly lockKey: string;
  readonly turnId: string;
  readonly turn: number;
  readonly expectedRevision: number;
  readonly newRevision: number;
  readonly nextStoredStateJson: string;
  readonly historyEntryJson: string;
  readonly expectedLockToken?: string;
}

export function buildAtomicCommitEvalArgs(params: AtomicCommitEvalParams): { readonly keys: string[]; readonly args: string[] } {
  return {
    keys: [params.currentKey, params.historyEntryKey, params.historyIndexKey, params.draftKey, params.lockKey],
    args: [
      params.turnId,
      String(params.turn),
      String(params.expectedRevision),
      params.nextStoredStateJson,
      params.historyEntryJson,
      params.expectedLockToken ?? "",
      String(params.newRevision),
    ],
  };
}

export function parseAtomicCommitEvalResult(raw: unknown): AtomicQuarterCommitResult {
  if (!Array.isArray(raw) || raw.length < 2 || typeof raw[0] !== "string") {
    throw new CompanyLabRepositoryError(`原子コミットスクリプトの戻り値の形式が不正です: ${JSON.stringify(raw)}`);
  }
  const status = raw[0] as string;
  const extra = String(raw[1] ?? "");
  switch (status) {
    case "committed":
      return { status: "committed", revision: Number(extra) };
    case "alreadyCommitted":
      return { status: "alreadyCommitted", revision: Number(extra) };
    case "revisionConflict":
      return { status: "revisionConflict", actualRevision: Number(extra) };
    case "historyConflict":
      return { status: "historyConflict", existingTurnId: extra };
    case "currentNotFound":
      return { status: "currentNotFound" };
    case "draftNotFound":
      return { status: "draftNotFound" };
    case "draftNotSubmitted":
      return { status: "draftNotSubmitted" };
    case "draftTurnMismatch":
      return { status: "draftTurnMismatch", actualTurnId: extra };
    case "lockConflict":
      return { status: "lockConflict" };
    default:
      throw new CompanyLabRepositoryError(`原子コミットスクリプトが未知のstatusを返しました: ${JSON.stringify(status)}`);
  }
}

/**
 * Redisバックエンド向けの実行ヘルパー。CompanyLabRedisClient.evalを1回呼び出すだけで、
 * §5-2の全更新（history新規保存・current更新・index追加・draft削除）を単一の
 * 原子処理として完結させる。
 */
export async function executeAtomicQuarterCommit(client: CompanyLabRedisClient, params: AtomicCommitEvalParams): Promise<AtomicQuarterCommitResult> {
  const { keys, args } = buildAtomicCommitEvalArgs(params);
  const raw = await client.eval(COMPANY_LAB_QUARTER_COMMIT_LUA_SCRIPT, keys, args);
  return parseAtomicCommitEvalResult(raw);
}
