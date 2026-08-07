// ShrimpX V2 — 会社ラボ 四半期処理ロック（Phase 8C-2）
//
// Phase 8C-2指示§6.4:
//   - ロック取得はSET NX PX相当（トークン文字列を値として保存、TTL付き）。
//   - 解放は「自分のtokenと一致するロックだけを削除する」Lua（GET→比較→DEL）で行い、
//     他の処理が取得したロックを誤って削除しない。
//   - 原子コミット時のトークン検証自体はatomicCommit.tsのLuaスクリプト
//     （expectedLockToken）が担う。処理中にTTLが切れて別処理がロックを取得した
//     場合、古い処理のコミットはlockConflictで拒否される。TTLが切れて誰も
//     取得していない場合も、ロックキー不存在によりlockConflictとなる
//     （「自分がロックを保持していると証明できない処理はコミットできない」という
//     安全側の設計。8C-1のLua実装をそのまま利用する）。
//
// 複雑なロック自動延長機構は本Phaseでは実装しない（指示§13対象外）。TTLは
// 呼び出し側が処理時間に対して十分な余裕を持つ値を指定する（Application Serviceの
// 既定値はcompanyLabQuarterFlowService.ts参照）。

import { CompanyLabRedisClient } from "../../redis/companyLabTypes";
import { CompanyLabRepositoryError } from "./errors";

/**
 * KEYS[1] = lock key
 * ARGV[1] = 解放を要求する処理自身のトークン
 *
 * 保存されているロック値がARGV[1]と完全一致する場合のみDELし1を返す。
 * ロックが存在しない・他のトークンが保存されている場合は何もせず0を返す
 * （他処理のロックを誤って削除しないための標準的なcompare-and-deleteパターン）。
 */
export const COMPANY_LAB_RELEASE_LOCK_LUA_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`.trim();

/**
 * ロック取得（SET NX PX）。取得できればtrue、既に他の処理が有効なロックを
 * 保持していればfalse。値にはトークン文字列そのものを保存する
 * （atomicCommit.tsのLuaがlockRaw ~= ARGV[6]の生文字列比較を行うため、
 * JSONエンベロープにはしない）。
 */
export async function acquireProcessingLockOnRedis(
  client: CompanyLabRedisClient,
  lockKey: string,
  token: string,
  ttlMilliseconds: number
): Promise<boolean> {
  const result = await client.set(lockKey, token, { nx: true, pxMilliseconds: ttlMilliseconds });
  // @upstash/redisのSET NXは、書き込めた場合"OK"、既存キーにより書き込めなかった場合nullを返す。
  return result !== null && result !== undefined && result !== false;
}

/** ロック解放（自トークン一致時のみ）。解放できた場合true、ロック不存在・他トークンの場合false。 */
export async function releaseProcessingLockOnRedis(client: CompanyLabRedisClient, lockKey: string, token: string): Promise<boolean> {
  const raw = await client.eval(COMPANY_LAB_RELEASE_LOCK_LUA_SCRIPT, [lockKey], [token]);
  if (raw !== 0 && raw !== 1 && raw !== "0" && raw !== "1") {
    throw new CompanyLabRepositoryError(`ロック解放スクリプトの戻り値の形式が不正です: ${JSON.stringify(raw)}`);
  }
  return raw === 1 || raw === "1";
}
