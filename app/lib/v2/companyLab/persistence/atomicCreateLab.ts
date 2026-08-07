// ShrimpX V2 — 会社ラボの原子的作成（Phase 8C-2）
//
// Phase 8C-2指示§3.1・§8:
//   - 同じlabIdが既に存在する場合は上書きせず、明示的な重複エラーにする。
//   - Redis版は事前の存在確認だけでなく、Luaにより「存在確認→current作成→
//     labs一覧への追加」を単一の原子的処理として実行し、同時作成でも既存ラボを
//     上書きできない形にする（currentの作成とlabs一覧の追加が別々に失敗して
//     不整合を作らないため）。
//
// atomicCommit.tsと同じ設計（Luaスクリプト定数＋引数組み立て＋戻り値解析＋実行
// ヘルパーを1ファイルに集約し、テスト用フェイククライアントが同一のスクリプト
// 定数を照合できるようにする）を踏襲する。

import { CompanyLabRedisClient } from "../../redis/companyLabTypes";
import { CompanyLabRepositoryError } from "./errors";

export type AtomicCreateLabResult = { readonly status: "created" } | { readonly status: "alreadyExists" };

/**
 * KEYS[1] = current key（v2:companyLab:{labId}:current）
 * KEYS[2] = labs一覧key（v2:companyLab:labs。ZSET。scoreは挿入時のZCARD＝作成順）
 * ARGV[1] = labId
 * ARGV[2] = 保存するCompanyLabPersistedStateV1のJSON文字列
 *
 * currentが既に存在する場合は一切書き込まず'alreadyExists'を返す。
 * 存在しない場合のみ、current SETとlabs一覧へのZADDを同一スクリプト内
 * （＝Redisの単一原子処理）で行う。ZADDのNXフラグにより、labs一覧に
 * 同じlabIdが既にある場合でも重複登録・score上書きは起きない。
 */
export const COMPANY_LAB_CREATE_LAB_LUA_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {'alreadyExists', ''}
end
redis.call('SET', KEYS[1], ARGV[2])
local order = redis.call('ZCARD', KEYS[2])
redis.call('ZADD', KEYS[2], 'NX', order, ARGV[1])
return {'created', ''}
`.trim();

export function parseAtomicCreateLabResult(raw: unknown): AtomicCreateLabResult {
  if (!Array.isArray(raw) || raw.length < 1 || typeof raw[0] !== "string") {
    throw new CompanyLabRepositoryError(`ラボ作成スクリプトの戻り値の形式が不正です: ${JSON.stringify(raw)}`);
  }
  switch (raw[0]) {
    case "created":
      return { status: "created" };
    case "alreadyExists":
      return { status: "alreadyExists" };
    default:
      throw new CompanyLabRepositoryError(`ラボ作成スクリプトが未知のstatusを返しました: ${JSON.stringify(raw[0])}`);
  }
}

export interface AtomicCreateLabEvalParams {
  readonly currentKey: string;
  readonly labsListKey: string;
  readonly labId: string;
  readonly serializedState: string;
}

/** CompanyLabRedisClient.evalを1回呼び出すだけで、存在確認・current作成・labs一覧追加を原子的に完結させる。 */
export async function executeAtomicCreateLab(client: CompanyLabRedisClient, params: AtomicCreateLabEvalParams): Promise<AtomicCreateLabResult> {
  const raw = await client.eval(COMPANY_LAB_CREATE_LAB_LUA_SCRIPT, [params.currentKey, params.labsListKey], [params.labId, params.serializedState]);
  return parseAtomicCreateLabResult(raw);
}
