// ShrimpX V2 — 会社ラボ専用Redisアダプター 共通型（Phase 8C-1）
//
// 既存のV2RedisClient（redis/types.ts）はget/set/exists/delのみを公開しており、
// 四半期確定の原子コミットに必要なevalを持たない。app/lib/redis.ts（V1/V2共有の
// facade）自体もevalを公開していない。本Phaseの実装指示「既存のRedisクライアント
// 型がevalを公開していない場合は、会社ラボRepository用の依存インターフェースに
// 必要最小限のeval能力を定義して構わない」に従い、会社ラボ専用の狭いインターフェース
// をここへ新設する（既存のapp/lib/redis.ts・redis/types.tsは一切変更しない）。

export interface CompanyLabRedisClient {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  exists(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
  /**
   * Redis EVAL（Luaスクリプト実行）。@upstash/redisのRedis#evalと同じ引数形状
   * （script, keys, args）に合わせる。四半期確定の原子コミット（atomicCommit.ts）
   * だけがこれを呼ぶ。
   */
  eval<TArgs extends unknown[], TData = unknown>(script: string, keys: string[], args: TArgs): Promise<TData>;
  /** ZADD（履歴indexへturn番号を冪等に追加するために使う。atomicCommitのLuaスクリプト内でのみ使用、
   * TypeScript側から直接呼ぶことはないが、読み出し側（loadHistoryIndex）がZRANGE相当を必要とするため
   * 公開しておく）。 */
  zrange(key: string, start: number, end: number): Promise<unknown[]>;
}
